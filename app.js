// ===========================================================
// Sight Words Training — app logic
// Vanilla JS, no build step. Bilingual (en/de) spaced-repetition
// sight-word practice using the Web Speech API.
//
// Organized: constants -> data layer -> sync layer (Worker + queue) ->
// session engine (spaced repetition + matching) -> speech ->
// screens/render -> event wiring -> init.
// ===========================================================

// Every device talks to this one Worker instead of GitHub directly — it
// holds the GitHub token server-side so no one has to paste a token in.
// An EMPTY WORKER_URL means local-only mode: everything works fully
// offline using localStorage, with no network calls at all. Fill both in
// (see README) before sharing this app across devices.
const WORKER_URL = "https://sightwords-training-worker.jhenningbuchholz.workers.dev";
// Must match the APP_KEY secret set on the Worker. Not real security (it's
// visible in this public source) — just a deterrent against casual randoms
// who stumble on the Worker URL.
const APP_KEY = "ew6hl1snory5udxf7zvbkj4g98cm";

const LS = {
  lang: "swt-lang",
  theme: "swt-theme",
  lastKid: "swt-last-kid",
  cacheData: "swt-cache-data",
  pendingQueue: "swt-pending-queue",
  newCount: "swt-new-today",
};

const DEFAULT_SETTINGS = { wordsPerSession: 20, newWordsPerDay: 3, levels: { en: "prek", de: "prek" } };
const LEVEL_IDS = { en: LEVELS.en.map((l) => l.id), de: LEVELS.de.map((l) => l.id) };

// Looks up the flat-list start index for a given language + level id —
// words before this index are "assumed known" and never introduced as new.
// Falls back to 0 (start of the list) for an unrecognized id.
function levelStartIndex(lang, levelId) {
  const found = (LEVELS[lang] || []).find((l) => l.id === levelId);
  return found ? found.startIndex : 0;
}
// Frozen — used only for the deterministic per-name auto-avatar fallback
// (kidEmoji below), so expanding the full picker list below never shifts
// the default icon a kid already sees (it only affects new/explicit picks).
const LEGACY_KID_EMOJIS = ["🦊", "🐻", "🐰", "🐼", "🦁", "🐨", "🐸", "🦋", "🐢", "🐬", "🦄", "🐝"];
// Full set of choices shown in Settings > Avatar — 35 total, split into
// gamified unlock tiers (10/10/10/5) by AVATAR_TIERS below.
const KID_EMOJIS = [
  ...LEGACY_KID_EMOJIS,
  "🐯", "🐷", "🐵", "🐔", "🐧", "🦉", "🐺", "🦝", "🦔", "🐌",
  "🐙", "🦕", "🐳", "🦓", "🦒", "🐘", "🐕", "🐈", "🐹", "🐿️",
  "🦎", "🐩", "🦌",
];

// Avatar unlock tiers, sliced from KID_EMOJIS in order. unlockAt is the
// combined (English + German) count of DISTINCT words this kid has EVER
// mastered — reuses the masteredOn marker (set once, never cleared even if
// a word's level later drops), so a tier can never re-lock once earned.
const AVATAR_TIER_SIZES = [10, 10, 10, 5];
const AVATAR_TIER_THRESHOLDS = [0, 10, 25, 50];
const AVATAR_TIERS = (() => {
  const tiers = [];
  let idx = 0;
  for (let i = 0; i < AVATAR_TIER_SIZES.length; i++) {
    tiers.push({ emojis: KID_EMOJIS.slice(idx, idx + AVATAR_TIER_SIZES[i]), unlockAt: AVATAR_TIER_THRESHOLDS[i] });
    idx += AVATAR_TIER_SIZES[i];
  }
  return tiers;
})();

function combinedEverMastered(kidRecord) {
  let n = 0;
  for (const lang of ["en", "de"]) {
    const words = (kidRecord[lang] && kidRecord[lang].words) || {};
    for (const entry of Object.values(words)) if (entry.masteredOn) n++;
  }
  return n;
}

function unlockedTierCount(everMastered) {
  let unlocked = 0;
  for (const tier of AVATAR_TIERS) { if (everMastered >= tier.unlockAt) unlocked++; }
  return unlocked;
}

const state = {
  lang: localStorage.getItem(LS.lang) || "en",
  theme: localStorage.getItem(LS.theme) || "light",
  currentKid: localStorage.getItem(LS.lastKid) || "",
  screen: "screen-picker",
  // Shuffled order of the non-last-selected kids on the picker screen —
  // recomputed each time the picker is freshly entered (see showScreen),
  // but reused across re-renders during the same visit (e.g. a language
  // toggle click) so the cards don't jitter while visible.
  pickerShuffle: null,
  session: null,
  // True while the "Read a Real Sentence" panel is showing in place of the
  // word/prompt (same screen, same mic button) — routes mic results to
  // sentence matching instead of single-word matching.
  sentenceActive: false,
  sentenceTokens: [],
  sentenceMatchedIdx: null,
  recognizing: false,
  autoAdvanceTimer: null,
  // Cloud speech (Groq) recording state — session-scoped, released on
  // session end / screen change (see releaseMic()).
  micStream: null,
  micAudioCtx: null,
  micRecorder: null,
  micRecording: false,
  micBusy: false, // true while a clip is uploaded/transcribed ("Thinking…")
  micLevelTimer: null,
  micRecordTimer: null,
};

// Theme is a user choice (Settings > Appearance), not derived from the
// device's system setting — defaults to light on first launch regardless
// of OS dark mode, so it looks the same on every device until changed.
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(LS.theme, theme);
  document.querySelectorAll(".theme-btn").forEach((b) => b.classList.toggle("active", b.dataset.theme === theme));
}
applyTheme(state.theme);

// ------------------- small helpers -------------------

function $(id) { return document.getElementById(id); }

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(msg, ms = 2600) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), ms);
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function kidEmoji(name) { return LEGACY_KID_EMOJIS[hashString(name) % LEGACY_KID_EMOJIS.length]; }

// Weekday labels for the home screen's 7-day chart, indexed by
// Date#getDay() (0=Sun..6=Sat). Short but recognizable abbreviations for a
// child audience — 3-letter for English (Mon, Tue...), the idiomatic
// 2-letter form for German (Mo, Di...).
const WEEKDAY_LABELS = {
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  de: ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"],
};

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// A kid's emoji defaults to a deterministic hash of their name, but can be
// overridden per-kid in Settings — the stored choice always wins.
function kidEmojiFor(kidRecord, name) { return (kidRecord && kidRecord.emoji) || kidEmoji(name); }

// German is "unlocked" for a kid if they've explicitly toggled it (either
// way), or - if they've never touched the toggle - if they already have
// real German progress (so kids who already practice German aren't
// suddenly locked out by a feature added after the fact). A kid created
// after this feature ships has no progress and starts locked.
function germanUnlockedFor(kidRecord) {
  const explicit = kidRecord.settings && kidRecord.settings.germanEnabled;
  if (typeof explicit === "boolean") return explicit;
  return Object.keys((kidRecord.de && kidRecord.de.words) || {}).length > 0;
}

function clampNum(n, min, max, fallback) {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return todayStr(dt);
}

// ------------------- UI translations (interface chrome, not word content) -------------------
// Keyed by UI language (state.lang), independent of which word list (en/de)
// is being practiced — a kid could practice German words with English UI
// chrome, or vice versa; this dictionary only covers the surrounding app text.

const T = {
  en: {
    pickerSub: "Pick your reader, or add someone new!",
    newKid: "New kid",
    kidNamePlaceholder: "Kid's name",
    cancel: "Cancel",
    letsGo: "Let's go!",
    nameTaken: "That name is already taken.",
    switchKid: "Switch kid",
    settings: "Settings",
    greeting: (kid, emoji) => `Hi, ${kid}! ${emoji}`,
    streak: (n) => `${n} day${n === 1 ? "" : "s"} streak`,
    letsStart: "Let's get started!",
    goalReached: "Goal reached! 🎉",
    goalExceeded: (n) => `Goal smashed — ${n} extra! 🌟`,
    toGo: (n) => `${n} to go!`,
    last7Days: "Last 7 days",
    wordsIKnow: "Words I Know",
    wordsIKnowCount: (n) => n === 0 ? "Your collection is just getting started!" : `${n} word${n === 1 ? "" : "s"} in your collection!`,
    noWordsYet: "Practice a few words to start your collection!",
    wordsCount: (n) => `${n} word${n === 1 ? "" : "s"}`,
    startPractice: "Start practice ▶",
    speechUnsupported: "Speech isn't available here — open this page in Safari.",
    whatWord: "What word is this?",
    tapToListen: "Tap to listen",
    listening: "Listening…",
    thinking: "Thinking…",
    micDenied: "Microphone access is needed — allow it in Settings and try again.",
    correctCheer: "Yes! 🎉",
    notQuite: "Not quite!",
    noSpeechHeard: "I didn't hear you — try again!",
    hearWord: "🔊 Hear the word",
    markCorrect: "✅ I said it right!",
    next: "Next ▸",
    skip: "Skip ▸",
    endSession: "End session",
    back: "Back",
    sessionComplete: "Session complete!",
    correctCount: (c, p) => `${c} / ${p} correct`,
    practicedCount: (n) => `You practiced ${n} word${n === 1 ? "" : "s"} this session.`,
    backHome: "Back home",
    settingsTitle: "Settings",
    appearance: "Appearance",
    theme: "Theme",
    themeLight: "☀️ Light",
    themeDark: "🌙 Dark",
    general: "General",
    avatarLabel: "Avatar",
    avatarProgress: (n) => `${n} word${n === 1 ? "" : "s"} mastered combined`,
    avatarTierUnlocked: (n) => `Tier ${n}`,
    avatarTierLocked: (n, threshold) => `Tier ${n} — unlocks at ${threshold} words mastered`,
    avatarLockedTooltip: (threshold) => `Unlocks at ${threshold} words mastered`,
    kidName: "Kid's name",
    wordsPerSession: "Words per session",
    newWordsPerDay: "New words per day",
    levelLabelEn: "Reading level 🇺🇸",
    levelLabelDe: "Reading level 🇩🇪",
    levelEnPrek: "Pre-K / K",
    levelEnG1: "1st grade",
    levelEnG23: "2nd/3rd grade",
    levelEnG4: "4th grade",
    levelEnG5: "5th grade",
    levelEnG6: "6th grade",
    levelDePrek: "Pre-K / K",
    levelDeK1: "Grade 1",
    levelDeK2: "Grade 2",
    levelDeK3: "Grade 3",
    levelDeK4: "Grade 4",
    levelDeK5: "Grade 5",
    levelDeK6: "Grade 6",
    enableGerman: "🇩🇪 Enable German",
    off: "Off",
    on: "On",
    saveSettings: "Save settings",
    settingsSaved: "Settings saved! ✅",
    nameUsedByAnother: "That name is already used by another kid.",
    wordMastery: "Word mastery",
    levelNew: "New",
    levelLearning: "Learning",
    levelFamiliar: "Familiar",
    levelMastered: "Mastered",
    notYetSeen: "Not yet seen",
    belowLevel: "Below level (assumed known)",
    noneYet: "None yet.",
    dangerZone: "Danger zone",
    resetHint: "Clears all progress for this kid, in both languages. Can't be undone.",
    resetBtn: "Reset all progress",
    resetConfirmQ: "Really reset everything for this kid?",
    yesDeleteEverything: "Yes, delete everything",
    resetDone: "Progress reset.",
    deleteHint: "Removes this kid entirely, from every device. Can't be undone.",
    deleteBtn: "Delete kid",
    deleteConfirmQ: "Really delete this kid completely?",
    kidDeleted: "Kid deleted.",
    noWordsAvailable: "No words available right now — try adjusting Settings.",
    masteredCheer: (word) => `You learned "${word}"!`,
    masteredSub: "Added to your Words I Know collection! 🏆",
    sentenceIntro: "Try reading!",
    sentencePrompt: "Read the sentence out loud!",
    sentenceContinue: "Continue practicing ▶",
    sentenceIReadIt: "✅ I read it!",
  },
  de: {
    pickerSub: "Wähl deinen Leser aus oder füge jemand Neues hinzu!",
    newKid: "Neues Kind",
    kidNamePlaceholder: "Name des Kindes",
    cancel: "Abbrechen",
    letsGo: "Los geht's!",
    nameTaken: "Dieser Name ist schon vergeben.",
    switchKid: "Kind wechseln",
    settings: "Einstellungen",
    greeting: (kid, emoji) => `Hallo, ${kid}! ${emoji}`,
    streak: (n) => `${n} Tag${n === 1 ? "" : "e"} Serie`,
    letsStart: "Los geht's!",
    goalReached: "Ziel erreicht! 🎉",
    goalExceeded: (n) => `Ziel übertroffen — ${n} extra! 🌟`,
    toGo: (n) => `Noch ${n}!`,
    last7Days: "Letzte 7 Tage",
    wordsIKnow: "Meine Wörter",
    wordsIKnowCount: (n) => n === 0 ? "Deine Sammlung fängt gerade erst an!" : `${n} ${n === 1 ? "Wort" : "Wörter"} in deiner Sammlung!`,
    noWordsYet: "Übe ein paar Wörter, um deine Sammlung zu starten!",
    wordsCount: (n) => `${n} ${n === 1 ? "Wort" : "Wörter"}`,
    startPractice: "Übung starten ▶",
    speechUnsupported: "Spracherkennung ist hier nicht verfügbar — öffne diese Seite in Safari.",
    whatWord: "Welches Wort ist das?",
    tapToListen: "Zum Zuhören tippen",
    listening: "Ich höre…",
    thinking: "Hmm, mal sehen…",
    micDenied: "Mikrofonzugriff wird benötigt — bitte in den Einstellungen erlauben und nochmal versuchen.",
    correctCheer: "Richtig! 🎉",
    notQuite: "Nicht ganz!",
    noSpeechHeard: "Ich habe dich nicht gehört — versuch's nochmal!",
    hearWord: "🔊 Wort anhören",
    markCorrect: "✅ Ich hab's richtig gesagt!",
    next: "Weiter ▸",
    skip: "Überspringen ▸",
    endSession: "Sitzung beenden",
    back: "Zurück",
    sessionComplete: "Sitzung abgeschlossen!",
    correctCount: (c, p) => `${c} / ${p} richtig`,
    practicedCount: (n) => `Du hast in dieser Sitzung ${n} ${n === 1 ? "Wort" : "Wörter"} geübt.`,
    backHome: "Zurück",
    settingsTitle: "Einstellungen",
    appearance: "Darstellung",
    theme: "Design",
    themeLight: "☀️ Hell",
    themeDark: "🌙 Dunkel",
    general: "Allgemein",
    avatarLabel: "Avatar",
    avatarProgress: (n) => `${n} ${n === 1 ? "Wort" : "Wörter"} gemeistert (kombiniert)`,
    avatarTierUnlocked: (n) => `Stufe ${n}`,
    avatarTierLocked: (n, threshold) => `Stufe ${n} — ab ${threshold} gemeisterten Wörtern`,
    avatarLockedTooltip: (threshold) => `Schaltet frei ab ${threshold} gemeisterten Wörtern`,
    kidName: "Name des Kindes",
    wordsPerSession: "Wörter pro Sitzung",
    newWordsPerDay: "Neue Wörter pro Tag",
    levelLabelEn: "Lesestufe 🇺🇸",
    levelLabelDe: "Lesestufe 🇩🇪",
    levelEnPrek: "Vorschule",
    levelEnG1: "1. Klasse",
    levelEnG23: "2./3. Klasse",
    levelEnG4: "4. Klasse",
    levelEnG5: "5. Klasse",
    levelEnG6: "6. Klasse",
    levelDePrek: "Vorschule",
    levelDeK1: "Klasse 1",
    levelDeK2: "Klasse 2",
    levelDeK3: "Klasse 3",
    levelDeK4: "Klasse 4",
    levelDeK5: "Klasse 5",
    levelDeK6: "Klasse 6",
    enableGerman: "🇩🇪 Deutsch aktivieren",
    off: "Aus",
    on: "An",
    saveSettings: "Einstellungen speichern",
    settingsSaved: "Einstellungen gespeichert! ✅",
    nameUsedByAnother: "Dieser Name wird bereits von einem anderen Kind verwendet.",
    wordMastery: "Wortbeherrschung",
    levelNew: "Neu",
    levelLearning: "Lernend",
    levelFamiliar: "Bekannt",
    levelMastered: "Gemeistert",
    notYetSeen: "Noch nicht gesehen",
    belowLevel: "Unter der Stufe (als bekannt angenommen)",
    noneYet: "Noch keine.",
    dangerZone: "Gefahrenzone",
    resetHint: "Löscht den gesamten Fortschritt dieses Kindes, in beiden Sprachen. Kann nicht rückgängig gemacht werden.",
    resetBtn: "Gesamten Fortschritt zurücksetzen",
    resetConfirmQ: "Wirklich alles für dieses Kind zurücksetzen?",
    yesDeleteEverything: "Ja, alles löschen",
    resetDone: "Fortschritt zurückgesetzt.",
    deleteHint: "Entfernt dieses Kind vollständig, von jedem Gerät. Kann nicht rückgängig gemacht werden.",
    deleteBtn: "Kind löschen",
    deleteConfirmQ: "Dieses Kind wirklich vollständig löschen?",
    kidDeleted: "Kind gelöscht.",
    noWordsAvailable: "Gerade keine Wörter verfügbar — versuch die Einstellungen anzupassen.",
    masteredCheer: (word) => `Du hast „${word}" gelernt!`,
    masteredSub: "Zu deiner Wörter-Sammlung hinzugefügt! 🏆",
    sentenceIntro: "Versuch's mal!",
    sentencePrompt: "Lies den Satz laut vor!",
    sentenceContinue: "Weiter üben ▶",
    sentenceIReadIt: "✅ Ich hab's gelesen!",
  },
};

function t(key, ...args) {
  const entry = T[state.lang][key];
  return typeof entry === "function" ? entry(...args) : entry;
}

// Updates every static (non-per-render) piece of UI chrome to the current
// UI language. Cheap to run on every language change since it only touches
// textContent/attributes, not app state.
function applyStaticTranslations() {
  document.documentElement.lang = state.lang;

  $("picker-sub").textContent = t("pickerSub");
  $("new-kid-input").placeholder = t("kidNamePlaceholder");
  $("btn-new-kid-cancel").textContent = t("cancel");
  $("btn-new-kid-submit").textContent = t("letsGo");

  $("switch-kid-label").textContent = t("switchKid");
  $("btn-open-settings").setAttribute("aria-label", t("settings"));
  $("btn-open-settings").title = t("settings");
  $("btn-start-practice").textContent = t("startPractice");
  $("weekly-chart-title").textContent = t("last7Days");
  $("btn-words-i-know").setAttribute("aria-label", t("wordsIKnow"));
  $("btn-words-i-know").title = t("wordsIKnow");
  $("words-i-know-heading").textContent = t("wordsIKnow");
  $("words-i-know-back").setAttribute("aria-label", t("back"));
  $("words-i-know-back").title = t("back");

  $("speech-unsupported-banner").textContent = t("speechUnsupported");
  $("btn-mic").setAttribute("aria-label", t("tapToListen"));
  $("btn-hear-word").textContent = t("hearWord");
  $("btn-mark-correct").textContent = t("markCorrect");
  $("btn-next-word").textContent = t("next");
  $("btn-skip").textContent = t("skip");
  $("btn-end-session").textContent = t("endSession");
  $("sentence-intro").textContent = t("sentenceIntro");
  $("btn-sentence-continue").textContent = t("sentenceContinue");
  $("btn-sentence-i-read-it").textContent = t("sentenceIReadIt");

  $("summary-title").textContent = t("sessionComplete");
  $("btn-summary-home").textContent = t("backHome");

  $("settings-heading").textContent = t("settingsTitle");
  $("appearance-heading").textContent = t("appearance");
  $("label-theme").textContent = t("theme");
  $("theme-btn-light").textContent = t("themeLight");
  $("theme-btn-dark").textContent = t("themeDark");
  $("general-heading").textContent = t("general");
  $("label-avatar").textContent = t("avatarLabel");
  $("label-enable-german").textContent = t("enableGerman");
  $("german-toggle-off").textContent = t("off");
  $("german-toggle-on").textContent = t("on");
  $("label-kid-name").textContent = t("kidName");
  $("label-words-per-session").textContent = t("wordsPerSession");
  $("label-new-words-per-day").textContent = t("newWordsPerDay");
  $("label-level-en").textContent = t("levelLabelEn");
  $("label-level-de").textContent = t("levelLabelDe");
  renderLevelPickers();
  $("btn-settings-save").textContent = t("saveSettings");
  $("mastery-title-text").textContent = t("wordMastery");
  $("btn-settings-back").setAttribute("aria-label", t("back"));
  $("btn-settings-back").title = t("back");

  $("danger-zone-heading").textContent = t("dangerZone");
  $("reset-hint").textContent = t("resetHint");
  $("btn-reset-progress").textContent = t("resetBtn");
  $("reset-confirm-text").textContent = t("resetConfirmQ");
  $("btn-reset-cancel").textContent = t("cancel");
  $("btn-reset-confirm").textContent = t("yesDeleteEverything");
  $("delete-hint").textContent = t("deleteHint");
  $("btn-delete-kid").textContent = t("deleteBtn");
  $("delete-confirm-text").textContent = t("deleteConfirmQ");
  $("btn-delete-kid-cancel").textContent = t("cancel");
  $("btn-delete-kid-confirm").textContent = t("yesDeleteEverything");
}

// ------------------- data layer (local cache = source of truth) -------------------

function emptyKidRecord() {
  return {
    settings: { ...DEFAULT_SETTINGS, levels: { ...DEFAULT_SETTINGS.levels } },
    en: { words: {}, days: {} },
    de: { words: {}, days: {} },
  };
}

function getData() {
  try {
    const raw = localStorage.getItem(LS.cacheData);
    const parsed = raw ? JSON.parse(raw) : { kids: {} };
    if (!parsed.kids || typeof parsed.kids !== "object") parsed.kids = {};
    return parsed;
  } catch (e) {
    return { kids: {} };
  }
}

function setData(data) {
  localStorage.setItem(LS.cacheData, JSON.stringify(data));
}

// Sanitizes anything malformed in cached/remote data so rendering never
// throws on a missing field.
function ensureDataShape() {
  const data = getData();
  for (const name of Object.keys(data.kids)) {
    const kid = data.kids[name];
    if (!kid || typeof kid !== "object") { data.kids[name] = emptyKidRecord(); continue; }
    if (!kid.settings || typeof kid.settings !== "object") kid.settings = { ...DEFAULT_SETTINGS, levels: { ...DEFAULT_SETTINGS.levels } };
    if (!Number.isFinite(kid.settings.wordsPerSession)) kid.settings.wordsPerSession = DEFAULT_SETTINGS.wordsPerSession;
    if (!Number.isFinite(kid.settings.newWordsPerDay)) kid.settings.newWordsPerDay = DEFAULT_SETTINGS.newWordsPerDay;
    if (!kid.settings.levels || typeof kid.settings.levels !== "object") kid.settings.levels = { ...DEFAULT_SETTINGS.levels };
    for (const lang of ["en", "de"]) {
      if (!LEVEL_IDS[lang].includes(kid.settings.levels[lang])) kid.settings.levels[lang] = LEVEL_IDS[lang][0];
    }
    for (const lang of ["en", "de"]) {
      if (!kid[lang] || typeof kid[lang] !== "object") kid[lang] = { words: {}, days: {} };
      if (!kid[lang].words || typeof kid[lang].words !== "object") kid[lang].words = {};
      if (!kid[lang].days || typeof kid[lang].days !== "object") kid[lang].days = {};
    }
  }
  setData(data);
}

function createKid(name) {
  const data = getData();
  if (data.kids[name]) return false;
  data.kids[name] = emptyKidRecord();
  setData(data);
  queueOp({ type: "register-kid", key: `register-kid:${name}`, payload: { kid: name } });
  return true;
}

// Local-only counter of how many brand-new words have already been
// introduced today, per kid+lang — used to cap new-word introduction across
// multiple sessions in the same day. Not synced to the server (it's a
// scheduling detail, not progress data); self-resets whenever the date
// changes so it never grows unbounded.
function getNewIntroducedToday(kid, lang, today) {
  try {
    const map = JSON.parse(localStorage.getItem(LS.newCount) || "{}");
    const rec = map[`${kid}|${lang}`];
    return rec && rec.date === today ? rec.count : 0;
  } catch (e) { return 0; }
}
function addNewIntroducedToday(kid, lang, today, n) {
  if (n <= 0) return;
  let map;
  try { map = JSON.parse(localStorage.getItem(LS.newCount) || "{}"); } catch (e) { map = {}; }
  const key = `${kid}|${lang}`;
  const rec = map[key];
  map[key] = { date: today, count: rec && rec.date === today ? rec.count + n : n };
  localStorage.setItem(LS.newCount, JSON.stringify(map));
}

function computeStreak(days, today) {
  const hasDay = (d) => (days[d] || 0) > 0;
  let cursor = today;
  if (!hasDay(cursor)) cursor = addDays(cursor, -1);
  let streak = 0;
  while (hasDay(cursor)) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

// ------------------- sync layer (Cloudflare Worker + offline queue) -------------------

function workerConfigured() { return !!WORKER_URL; }

const OP_ENDPOINTS = {
  "register-kid": "/register-kid",
  progress: "/progress",
  settings: "/settings",
  "reset-kid": "/reset-kid",
  "delete-kid": "/delete-kid",
};

async function postToWorker(path, payload) {
  const res = await fetch(WORKER_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-App-Key": APP_KEY },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Request failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json().catch(() => ({}));
}

async function fetchWorkerData() {
  const res = await fetch(WORKER_URL + "/data");
  if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
  return res.json();
}

function getQueue() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS.pendingQueue) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch (e) { return []; }
}
function setQueue(q) { localStorage.setItem(LS.pendingQueue, JSON.stringify(q)); }

// Queues a mutation for later sync. In local-only mode (no WORKER_URL) this
// is a no-op — the local cache written by the caller IS the database.
// Ops with the same `key` replace each other (e.g. repeated progress
// checkpoints for the same kid+lang collapse into the latest snapshot).
function queueOp(op) {
  if (!workerConfigured()) return;
  let q = getQueue();
  if (op.key) q = q.filter((o) => o.key !== op.key);
  q.push({ id: uuid(), key: op.key, type: op.type, payload: op.payload });
  setQueue(q);
}
function removeQueuedOp(key) {
  setQueue(getQueue().filter((o) => o.key !== key));
}

// Processes the queue strictly in order and stops at the first failure —
// order matters here (e.g. a rename must land before progress posted under
// the new name), unlike a simple additive log.
async function flushQueue() {
  if (!workerConfigured()) return;
  let q = getQueue();
  while (q.length) {
    const op = q[0];
    try {
      await postToWorker(OP_ENDPOINTS[op.type], op.payload);
      q = q.slice(1);
      setQueue(q);
    } catch (e) {
      break; // offline or Worker unreachable — retry everything remaining next time
    }
  }
}

async function refreshFromRemote() {
  if (!workerConfigured()) return;
  await flushQueue().catch(() => {});
  try {
    const remote = await fetchWorkerData();
    if (remote && typeof remote.kids === "object") setData(remote);
  } catch (e) {
    // offline or Worker unreachable — keep whatever's cached locally
  }
}

// Attempts the single end-of-session sync immediately; on failure the
// checkpoint already queued during the session (see checkpointSession)
// stays queued and gets retried by flushQueue on next load.
async function trySyncProgressNow(kid, lang, words, day, dayCount) {
  if (!workerConfigured()) return;
  const key = `progress:${kid}:${lang}`;
  try {
    await postToWorker("/progress", { kid, lang, words, day, dayCount });
    removeQueuedOp(key);
  } catch (e) {
    // stays queued
  }
}

// ------------------- session engine: spaced repetition -------------------

function applyAnswer(entry, correct, today) {
  const e = entry ? { ...entry } : { level: 0, correct: 0, wrong: 0, lastSeen: today, nextDue: today, firstSeen: today };
  // Backfills firstSeen for any entry that predates this field, so it never
  // fabricates a false history — it just starts counting from today.
  if (!e.firstSeen) e.firstSeen = today;
  if (correct) {
    e.level = Math.min(3, e.level + 1);
    e.correct += 1;
    const interval = { 1: 1, 2: 3, 3: 7 }[e.level];
    e.nextDue = addDays(today, interval);
    // masteredOn is set once, the first time a word reaches level 3, and
    // never moves even if it's later answered wrong and demoted — it marks
    // when the word was first mastered, not its current level.
    if (e.level === 3 && !e.masteredOn) e.masteredOn = today;
  } else {
    e.level = Math.max(0, e.level - 1);
    e.wrong += 1;
    e.nextDue = today;
  }
  e.lastSeen = today;
  return e;
}

// Builds one practice queue: brand-new words first (in list order STARTING
// AT startIndex — words before it are "assumed known" for this kid's level
// and never introduced), capped by the daily new-word budget and given a
// reserved slice of the session BEFORE due reviews are considered. This is
// deliberate: once a word reaches Mastered it re-enters the review rotation
// every 7 days indefinitely, so the review backlog only ever grows. If due
// reviews were filled first (as before), that growing backlog would
// eventually consume the entire session every time and permanently starve
// new-word introduction — which is exactly what was happening. Reserving
// the new-word budget up front guarantees steady vocabulary growth
// regardless of how large the review backlog gets. Due reviews (lowest
// level, then oldest lastSeen) fill the rest, then top-up with soonest-due
// already-seen words. Reviews and top-up are unaffected by startIndex — any
// word with stored progress keeps working regardless of the kid's current
// level.
function buildSession(langData, wordList, settings, today, alreadyIntroducedToday, startIndex = 0) {
  const words = langData.words || {};
  const wordsPerSession = settings.wordsPerSession;
  const newBudget = Math.max(0, settings.newWordsPerDay - alreadyIntroducedToday);

  const queue = [];
  const used = new Set();

  let newlyIntroducedCount = 0;
  for (let i = startIndex; i < wordList.length; i++) {
    const w = wordList[i];
    if (queue.length >= wordsPerSession || newlyIntroducedCount >= newBudget) break;
    if (words[w] || used.has(w)) continue;
    queue.push(w);
    used.add(w);
    newlyIntroducedCount++;
  }

  const due = Object.keys(words)
    .filter((w) => words[w].nextDue <= today && !used.has(w))
    .sort((a, b) => {
      if (words[a].level !== words[b].level) return words[a].level - words[b].level;
      return (words[a].lastSeen || "").localeCompare(words[b].lastSeen || "");
    });
  for (const w of due) {
    if (queue.length >= wordsPerSession) break;
    queue.push(w);
    used.add(w);
  }

  if (queue.length < wordsPerSession) {
    const rest = Object.keys(words)
      .filter((w) => !used.has(w))
      .sort((a, b) => (words[a].nextDue || "").localeCompare(words[b].nextDue || ""));
    for (const w of rest) {
      if (queue.length >= wordsPerSession) break;
      queue.push(w);
      used.add(w);
    }
  }

  return { queue, newlyIntroducedCount };
}

// ------------------- "Read a Real Sentence" -------------------
// Every so often, instead of another isolated word, the kid gets a tiny
// sentence built entirely from words she already knows (Familiar+) — the
// payoff moment that connects sight-word drilling to actual reading.

const SENTENCE_EVERY_N = 6; // show one after every Nth word answered correctly
const SENTENCE_MAX_PER_SESSION = 2; // keep it a bonus, not a takeover

// Extracts just the letter-runs from a sentence, in order — used both to
// check "does the kid know every word in this sentence" and, at render
// time, to know which runs to wrap in highlightable spans (see
// renderSentenceHTML). Punctuation/spacing is left untouched for display.
function sentenceWordsOf(text) {
  return text.match(/[\p{L}]+/gu) || [];
}

// Picks a sentence whose every word is at least Familiar (level >= 2) for
// this kid+lang, avoiding immediate repeats within the same session. Null
// if she doesn't know enough words yet for even one full sentence.
function pickSentence(kid, lang) {
  const s = state.session;
  const data = getData();
  const words = data.kids[kid][lang].words;
  const known = new Set(Object.keys(words).filter((w) => words[w].level >= 2).map((w) => w.toLowerCase()));
  const bank = (typeof SENTENCES !== "undefined" && SENTENCES[lang]) || [];
  const eligible = bank.filter((text) => sentenceWordsOf(text).every((w) => known.has(w.toLowerCase())));
  if (!eligible.length) return null;
  const notRecent = eligible.filter((text) => !s.recentSentences.includes(text));
  const pool = notRecent.length ? notRecent : eligible;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  s.recentSentences.push(pick);
  if (s.recentSentences.length > 3) s.recentSentences.shift();
  return pick;
}

function startSession(kid, lang) {
  const data = getData();
  const kidRecord = data.kids[kid];
  if (!kidRecord) { state.session = null; return; }
  const langData = kidRecord[lang];
  const today = todayStr();
  const alreadyIntroduced = getNewIntroducedToday(kid, lang, today);
  const levelId = (kidRecord.settings.levels && kidRecord.settings.levels[lang]) || LEVEL_IDS[lang][0];
  const startIndex = levelStartIndex(lang, levelId);
  const { queue } = buildSession(langData, WORDS[lang], kidRecord.settings, today, alreadyIntroduced, startIndex);

  state.session = {
    kid, lang, today,
    queue,
    index: 0,
    requeued: new Set(),
    skippedIndices: new Set(),
    correctCount: 0,
    practicedCount: 0,
    sentencesShown: 0,
    recentSentences: [],
    wordUpdates: {},
    dayCountBase: langData.days[today] || 0,
  };
  state.sentenceActive = false;
}

function currentWord() {
  return state.session ? state.session.queue[state.session.index] : undefined;
}

// Applies the spaced-repetition update, writes it to the local cache
// immediately (so Home/Settings reflect it even mid-session), and
// checkpoints a local-only queue snapshot so an abandoned session isn't lost.
function recordAnswer(word, correct) {
  if (!word) return { justMastered: false }; // defensive: never persist a bogus entry if called with no current word
  const s = state.session;
  const data = getData();
  const langData = data.kids[s.kid][s.lang];
  // A word only consumes the day's new-word budget once the kid actually
  // answers it — not merely because it was placed in a session's queue.
  // Otherwise a newly-introduced word that gets Skipped (never recorded)
  // would still burn the budget, starving every later session that day
  // down to whatever's left (see the "and" repeating bug this fixed).
  const isNewWord = !langData.words[word];
  const wasMastered = !!(langData.words[word] && langData.words[word].masteredOn);
  const newEntry = applyAnswer(langData.words[word], correct, s.today);
  langData.words[word] = newEntry;
  if (isNewWord) addNewIntroducedToday(s.kid, s.lang, s.today, 1);

  s.wordUpdates[word] = newEntry;
  s.practicedCount++;
  if (correct) s.correctCount++;

  const cumulativeDayCount = s.dayCountBase + s.practicedCount;
  langData.days[s.today] = cumulativeDayCount;
  setData(data);

  queueOp({
    type: "progress",
    key: `progress:${s.kid}:${s.lang}`,
    payload: { kid: s.kid, lang: s.lang, words: { ...s.wordUpdates }, day: s.today, dayCount: cumulativeDayCount },
  });

  if (!correct && !s.requeued.has(word)) {
    s.requeued.add(word);
    s.queue.push(word);
  }

  return { justMastered: !wasMastered && !!newEntry.masteredOn };
}

function endSession() {
  releaseMic();
  const s = state.session;
  if (s) {
    if (s.practicedCount > 0) {
      const cumulativeDayCount = s.dayCountBase + s.practicedCount;
      trySyncProgressNow(s.kid, s.lang, { ...s.wordUpdates }, s.today, cumulativeDayCount);
    }
    showSummary(s);
  }
  state.session = null;
}

// ------------------- speech: recognition, matching, synthesis, chime -------------------

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
const speechSupported = !!SpeechRecognitionCtor;

function normalizeTranscript(str) {
  return str.toLowerCase().trim().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}

function foldGerman(s) {
  return s.replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ß/g, "ss");
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = new Array(bl + 1);
  let curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bl];
}

// Tiny union-find so overlapping homophone/equivalence groups merge cleanly.
function buildEquivalence(groups) {
  const parent = new Map();
  function find(x) {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    let cur = x;
    while (parent.get(cur) !== root) { const next = parent.get(cur); parent.set(cur, root); cur = next; }
    return root;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (const g of groups) {
    for (let i = 1; i < g.length; i++) union(g[0], g[i]);
  }
  return { find };
}

const EN_EQUIV_GROUPS = [
  ["to", "too", "two", "2"],
  ["there", "their", "theyre"],
  ["for", "four", "4"],
  ["one", "won", "1"],
  ["ate", "eight", "8"],
  ["be", "bee", "b"],
  ["by", "buy", "bye"],
  ["know", "no"],
  ["right", "write"],
  ["see", "sea", "c"],
  ["here", "hear"],
  ["our", "hour"],
  ["red", "read"],
  ["blue", "blew"],
  ["new", "knew"],
  ["your", "youre"],
  ["wear", "where"],
  ["would", "wood"],
  ["i", "eye"],
  ["oh", "o", "owe"],
  ["hi", "high"],
  ["so", "sew"],
  ["do", "due", "dew"],
  ["in", "inn"],
  ["an", "ann", "and"], // "an" is short/low-energy enough that ASR (and
  // Groq Whisper especially, out of natural sentence context) commonly
  // completes it toward the far more frequent "and" - reported case.
  ["a", "uh"], // common filler-like transcription of the bare article
  ["are", "r"],
  ["why", "y"],
  ["you", "u"],
];
const EN_NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
for (let n = 0; n <= 20; n++) EN_EQUIV_GROUPS.push([String(n), EN_NUMBER_WORDS[n]]);

const DE_EQUIV_GROUPS = [
  ["eins", "1"], ["zwei", "2"], ["drei", "3"], ["vier", "4"], ["fünf", "5"],
  ["sechs", "6"], ["sieben", "7"], ["acht", "8"], ["neun", "9"], ["zehn", "10"],
  ["ja", "ya"],
];

const EQUIV = { en: buildEquivalence(EN_EQUIV_GROUPS), de: buildEquivalence(DE_EQUIV_GROUPS) };

// Every word in each language's full list, normalized — used below to stop
// fuzzy matching from ever landing on a DIFFERENT real lesson word (e.g.
// "der"/"die", "small"/"shall" are each one Levenshtein edit apart, but
// they're different words the kid is specifically learning to tell apart,
// not ASR noise to forgive).
const WORD_SET_BY_LANG = {
  en: new Set(WORDS.en.map((w) => normalizeTranscript(w))),
  de: new Set(WORDS.de.map((w) => normalizeTranscript(w))),
};

// Generous, 5-year-old-friendly matching: exact match, homophone/digit
// equivalence, umlaut-folded match (German), or Levenshtein <=1 for longer
// target words — checked against the whole transcript AND each individual
// token, across every recognizer alternative.
function isMatch(alternatives, targetWord, lang) {
  const targetNorm = normalizeTranscript(targetWord);
  const targetCanon = EQUIV[lang].find(targetNorm);
  const targetFold = lang === "de" ? foldGerman(targetNorm) : targetNorm;

  function checkToken(tok) {
    if (!tok) return false;
    if (tok === targetNorm) return true;
    if (EQUIV[lang].find(tok) === targetCanon) return true;
    const tokFold = lang === "de" ? foldGerman(tok) : tok;
    if (tokFold === targetFold) return true;
    // Fuzzy (mis-transcription) tolerance down to 3-letter targets — this
    // is where the shortest, highest-frequency, hardest-for-ASR words live
    // (der, die, mit, ist, an...). Excluded whenever the near-match is
    // ITSELF a different real word in the list: that's a different lesson
    // word, not noise, and should still count wrong.
    if (targetNorm.length >= 3 && !WORD_SET_BY_LANG[lang].has(tok) && levenshtein(tok, targetNorm) <= 1) return true;
    return false;
  }

  for (const alt of alternatives) {
    const altNorm = normalizeTranscript(alt);
    if (checkToken(altNorm)) return true;
    for (const tok of altNorm.split(" ").filter(Boolean)) {
      if (checkToken(tok)) return true;
    }
  }
  return false;
}

let cachedVoices = [];
function ensureVoicesLoaded() {
  if (!("speechSynthesis" in window)) return;
  cachedVoices = speechSynthesis.getVoices();
  speechSynthesis.onvoiceschanged = () => { cachedVoices = speechSynthesis.getVoices(); };
}

function speakWord(word, lang) {
  if (!("speechSynthesis" in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(word);
    const targetLang = lang === "de" ? "de-DE" : "en-US";
    u.lang = targetLang;
    u.rate = 0.85;
    const voices = cachedVoices.length ? cachedVoices : speechSynthesis.getVoices();
    const voice = voices.find((v) => v.lang && v.lang.toLowerCase() === targetLang.toLowerCase())
      || voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(lang));
    if (voice) u.voice = voice;
    speechSynthesis.speak(u);
  } catch (e) { /* ignore */ }
}

// Short cheerful ascending chime, synthesized with WebAudio — no audio files.
function playChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = now + i * 0.09;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.3);
    });
    setTimeout(() => ctx.close(), 900);
  } catch (e) { /* ignore */ }
}

function startListening() {
  if (!speechSupported || state.recognizing || !state.session) return;
  const rec = new SpeechRecognitionCtor();
  rec.lang = state.session.lang === "de" ? "de-DE" : "en-US";
  rec.maxAlternatives = 5;
  rec.continuous = false;
  rec.interimResults = false;

  let settled = false;
  state.recognizing = true;
  updateMicUI(true);

  const timeoutId = setTimeout(() => {
    if (!settled) { try { rec.stop(); } catch (e) { /* ignore */ } }
  }, state.sentenceActive ? 10000 : 6000);

  rec.onresult = (event) => {
    settled = true;
    clearTimeout(timeoutId);
    const result = event.results[0];
    const alternatives = [];
    for (let i = 0; i < result.length; i++) alternatives.push(result[i].transcript);
    if (state.sentenceActive) {
      matchSentenceAgainstAlternatives(alternatives, state.session.lang);
    } else {
      handleRecognitionResult(alternatives);
    }
  };
  rec.onerror = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutId);
    handleNoSpeech();
  };
  rec.onend = () => {
    clearTimeout(timeoutId);
    state.recognizing = false;
    updateMicUI(false);
    if (!settled) {
      settled = true;
      handleNoSpeech();
    }
  };

  try {
    rec.start();
  } catch (e) {
    state.recognizing = false;
    updateMicUI(false);
  }
}

function handleRecognitionResult(alternatives) {
  const word = currentWord();
  if (!word) return;
  if (isMatch(alternatives, word, state.session.lang)) {
    handleCorrect();
  } else {
    handleWrong();
  }
}

function handleNoSpeech() {
  $("mic-status").textContent = t("noSpeechHeard");
}

function updateMicUI(listening) {
  $("btn-mic").classList.toggle("listening", listening);
  if (listening) $("mic-status").textContent = t("listening");
}

// ------------------- speech: cloud transcription (Groq, via Worker) -------------------
// Primary voice-capture path when available: records a short clip and sends
// it to the Worker's /transcribe endpoint (Groq whisper-large-v3-turbo). Falls
// back to the Web Speech API above when the Worker/key isn't configured, or
// when this browser can't record audio at all (no MediaRecorder/getUserMedia).

const cloudSpeechAvailable = !!WORKER_URL && typeof MediaRecorder !== "undefined"
  && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
// Flips true for the rest of the page session the first time /transcribe
// reports it isn't configured (501) — every subsequent tap uses Web Speech
// instead of re-trying the cloud endpoint.
let cloudSpeechDisabled = false;

function cloudModeActive() { return cloudSpeechAvailable && !cloudSpeechDisabled; }

// Phrases Whisper is prone to hallucinating on silence, background noise,
// or a very short/quiet clip (a single isolated sight word gives it far
// less to work with than natural speech, and it "completes" toward
// whatever's statistically likely — often a generic filler or video-outro
// phrase from its training data). Checked against the raw (lower-cased,
// unnormalized) transcript so punctuation like "www." still matches.
const HALLUCINATION_PHRASES = [
  "untertitel", "amara.org", "subtitles", "subscribe", "www.", "copyright",
  "vielen dank fürs zuschauen", "thanks for watching", "thank you for watching",
  "thank you", "thanks", "bye", "okay", "mm-hmm",
];

// Decides whether a cloud transcript should be treated as "didn't hear
// anything usable" rather than fed into the matcher — covers empty results,
// known Whisper hallucination phrases, and long rambles that don't match the
// target word (far more likely noise misheard as a sentence than an actual
// wrong answer). isMatch is checked FIRST and short-circuits everything
// else: a genuine correct answer must never be discarded as a "hallucination"
// just because it happens to contain a filler substring (e.g. target word
// "you" or "your" containing "you", one of the phrases above).
function isNoSpeechTranscript(rawText, targetWord, lang) {
  const norm = normalizeTranscript(rawText || "");
  if (!norm) return true;
  if (isMatch([rawText], targetWord, lang)) return false;
  const lower = String(rawText).toLowerCase();
  if (HALLUCINATION_PHRASES.some((p) => lower.includes(p))) return true;
  const tokenCount = norm.split(" ").filter(Boolean).length;
  if (tokenCount > 6) return true;
  return false;
}

// Lazily requests the mic once per practice session and keeps the stream
// open (avoids repeated permission-prompt churn/latency on every word) —
// released by releaseMic() on session end or screen change.
async function ensureMicStream() {
  if (state.micStream) return state.micStream;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  // The permission prompt / acquisition can outlive the practice screen
  // (e.g. session ended while it was pending) — don't hold a live mic
  // stream after releaseMic() already ran for that screen.
  if (state.screen !== "screen-practice") {
    stream.getTracks().forEach((tr) => tr.stop());
    throw new Error("practice screen left during mic acquisition");
  }
  state.micStream = stream;
  return stream;
}

function pickMimeType() {
  const candidates = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return undefined; // browser default
}

// Pre-acquires the mic stream and AudioContext inside the Start-practice tap
// (a user gesture, which iOS requires for AudioContext) so the session's
// first answer doesn't pay getUserMedia/setup latency on the mic tap.
// Fire-and-forget: a denial here is surfaced later by the tap handler's own
// ensureMicStream call, with the micDenied toast.
function prewarmMic() {
  if (!cloudModeActive()) return;
  if (!state.micAudioCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) state.micAudioCtx = new AudioCtx();
  }
  if (state.micAudioCtx && state.micAudioCtx.state === "suspended") {
    state.micAudioCtx.resume().catch(() => {});
  }
  ensureMicStream().catch(() => { /* surfaced on first mic tap */ });
}

// Releases every mic-related resource. Safe to call any time (including
// when nothing is active) — must be called on every exit from the practice
// screen so the browser's recording indicator always goes away.
function releaseMic() {
  if (state.micRecordTimer) { clearTimeout(state.micRecordTimer); state.micRecordTimer = null; }
  if (state.micLevelTimer) { clearInterval(state.micLevelTimer); state.micLevelTimer = null; }
  if (state.micRecorder && state.micRecorder.state !== "inactive") {
    try { state.micRecorder.stop(); } catch (e) { /* ignore */ }
  }
  state.micRecorder = null;
  state.micRecording = false;
  state.micBusy = false;
  if (state.micAudioCtx) {
    try { state.micAudioCtx.close(); } catch (e) { /* ignore */ }
    state.micAudioCtx = null;
  }
  if (state.micStream) {
    state.micStream.getTracks().forEach((tr) => tr.stop());
    state.micStream = null;
  }
}

// Voice-activity tuning for the in-recording level meter. RMS is computed
// from byte time-domain data (quiet room ~0.005-0.01, speech ~0.05-0.3).
// Once speech has been heard, ~0.7s of sustained quiet ends the recording
// immediately instead of waiting out the full hard cap — this is the main
// thing that makes answers feel fast.
const VAD_SAMPLE_MS = 60;
const VAD_SPEECH_RMS = 0.03;  // at/above: definitely speech
const VAD_QUIET_RMS = 0.02;   // below: counts toward the end-of-speech quiet run
const VAD_QUIET_STOP_MS = 700;
const RECORD_MAX_MS = 3500;   // hard cap (also the total wait when no speech is detected)
const RECORD_MAX_MS_SENTENCE = 7000; // a whole sentence needs more room than one word

// Mic tap in cloud mode: first tap starts recording, a second tap while
// recording stops it early; recording auto-stops ~0.7s after the child
// finishes speaking (voice-activity detection), or after the hard cap.
async function startCloudListening() {
  if (state.micBusy || !state.session) return;
  if (state.micRecording) {
    stopCloudRecording();
    return;
  }

  let stream;
  try {
    stream = await ensureMicStream();
  } catch (e) {
    toast(t("micDenied"));
    $("mic-status").textContent = t("tapToListen");
    return;
  }

  // One AudioContext per session, reused across taps; resume() here runs
  // inside the tap's user-gesture handler, which iOS requires.
  if (!state.micAudioCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) state.micAudioCtx = new AudioCtx();
  }
  let analyser = null;
  let source = null;
  const dataArray = new Uint8Array(2048);
  let peakRms = 0;
  if (state.micAudioCtx) {
    if (state.micAudioCtx.state === "suspended") {
      try { await state.micAudioCtx.resume(); } catch (e) { /* ignore */ }
    }
    try {
      analyser = state.micAudioCtx.createAnalyser();
      analyser.fftSize = 2048;
      source = state.micAudioCtx.createMediaStreamSource(stream);
      source.connect(analyser);
    } catch (e) { analyser = null; source = null; }
  }
  if (analyser) {
    let speechHeard = false;
    let quietMs = 0;
    state.micLevelTimer = setInterval(() => {
      analyser.getByteTimeDomainData(dataArray);
      let sumSquares = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const v = (dataArray[i] - 128) / 128;
        sumSquares += v * v;
      }
      const rms = Math.sqrt(sumSquares / dataArray.length);
      if (rms > peakRms) peakRms = rms;
      // End-of-speech detection: a sustained quiet run after speech stops
      // the recording right away. Levels between the two thresholds are
      // ambiguous — they neither extend speech nor count as quiet.
      if (rms >= VAD_SPEECH_RMS) {
        speechHeard = true;
        quietMs = 0;
      } else if (speechHeard && rms < VAD_QUIET_RMS) {
        quietMs += VAD_SAMPLE_MS;
        if (quietMs >= VAD_QUIET_STOP_MS) stopCloudRecording();
      }
    }, VAD_SAMPLE_MS);
  }

  const mimeType = pickMimeType();
  let recorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 });
  } catch (e) {
    if (state.micLevelTimer) { clearInterval(state.micLevelTimer); state.micLevelTimer = null; }
    handleNoSpeech();
    return;
  }

  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = () => {
    if (state.micLevelTimer) { clearInterval(state.micLevelTimer); state.micLevelTimer = null; }
    if (analyser) { try { analyser.disconnect(); } catch (e) { /* ignore */ } }
    if (source) { try { source.disconnect(); } catch (e) { /* ignore */ } }
    state.micRecording = false;
    updateMicUI(false);
    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
    finishCloudRecording(blob, peakRms);
  };

  state.micRecorder = recorder;
  state.micRecording = true;
  try {
    recorder.start();
  } catch (e) {
    state.micRecording = false;
    if (state.micLevelTimer) { clearInterval(state.micLevelTimer); state.micLevelTimer = null; }
    handleNoSpeech();
    return;
  }
  updateMicUI(true);

  state.micRecordTimer = setTimeout(() => { stopCloudRecording(); }, state.sentenceActive ? RECORD_MAX_MS_SENTENCE : RECORD_MAX_MS);
}

function stopCloudRecording() {
  if (state.micRecordTimer) { clearTimeout(state.micRecordTimer); state.micRecordTimer = null; }
  if (state.micRecorder && state.micRecorder.state !== "inactive") {
    try { state.micRecorder.stop(); } catch (e) { /* ignore */ }
  }
}

async function finishCloudRecording(blob, peakRms) {
  if (!state.session) return; // session ended / screen left while the clip was recording
  if (peakRms < 0.015) {
    handleNoSpeech();
    return;
  }
  state.micBusy = true;
  $("mic-status").textContent = t("thinking");

  let res;
  try {
    res = await fetch(WORKER_URL + "/transcribe?lang=" + state.session.lang, {
      method: "POST",
      headers: { "X-App-Key": APP_KEY, "Content-Type": blob.type || "audio/webm" },
      body: blob,
    });
  } catch (e) {
    state.micBusy = false;
    console.error("Transcription request failed", e);
    handleNoSpeech();
    return;
  }

  if (res.status === 501) {
    cloudSpeechDisabled = true;
    state.micBusy = false;
    if (speechSupported) {
      $("mic-status").textContent = t("tapToListen");
    } else {
      $("speech-unsupported-banner").classList.remove("hidden");
      $("btn-mic").disabled = true;
      $("mic-status").textContent = "";
    }
    return;
  }

  if (!res.ok) {
    state.micBusy = false;
    const text = await res.text().catch(() => "");
    console.error(`Transcription failed (${res.status})`, text.slice(0, 200));
    handleNoSpeech();
    return;
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    data = {};
  }
  state.micBusy = false;
  const text = data && typeof data.text === "string" ? data.text : "";
  if (state.sentenceActive) {
    handleSentenceCloudTranscript(text);
  } else {
    handleCloudTranscript(text);
  }
}

// Cloud STT gives one best-guess transcript (not per-word alternatives like
// Web Speech), so unlike the single-word path there's no isNoSpeechTranscript
// token-count ceiling here — a real sentence naturally has more tokens than
// a single word, and matchSentenceAgainstAlternatives already only credits
// words that actually match, so a rambling transcript just highlights
// nothing extra rather than being mistakenly accepted.
function handleSentenceCloudTranscript(text) {
  if (!state.sentenceActive || !state.session) return;
  const norm = normalizeTranscript(text || "");
  const lower = String(text || "").toLowerCase();
  if (!norm || HALLUCINATION_PHRASES.some((p) => lower.includes(p))) {
    $("mic-status").textContent = t("noSpeechHeard");
    return;
  }
  matchSentenceAgainstAlternatives([text], state.session.lang);
  $("mic-status").textContent = t("sentencePrompt");
}

function handleCloudTranscript(text) {
  const word = currentWord();
  if (!word || !state.session) return;
  if (isNoSpeechTranscript(text, word, state.session.lang)) {
    console.log(`[speech] target="${word}" heard="${text}" -> treated as no speech`);
    handleNoSpeech();
    return;
  }
  if (!isMatch([text], word, state.session.lang)) {
    // Not a bug report by itself, but the single most useful line for
    // diagnosing a "said it right but marked wrong" report afterwards —
    // check Safari's on-device Web Inspector console for these.
    console.log(`[speech] target="${word}" heard="${text}" -> did not match`);
  }
  handleRecognitionResult([text]);
}

// ------------------- screens / render -------------------

function showScreen(id) {
  if (state.screen === "screen-practice" && id !== "screen-practice") releaseMic();
  if (id === "screen-picker" && state.screen !== "screen-picker") state.pickerShuffle = null;
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(id).classList.add("active");
  state.screen = id;
  if (id === "screen-picker") renderPicker();
  if (id === "screen-home") renderHome();
  if (id === "screen-settings") renderSettings();
  if (id === "screen-practice") renderPracticeWord();
  if (id === "screen-words-i-know") renderWordsIKnow();
}

function syncLangToggles() {
  document.querySelectorAll(".lang-toggle .lang-btn").forEach((b) => b.classList.toggle("active", b.dataset.lang === state.lang));
}

function setLang(lang) {
  state.lang = lang;
  localStorage.setItem(LS.lang, lang);
  syncLangToggles();
  applyStaticTranslations();
  if (state.screen === "screen-picker") renderPicker();
  if (state.screen === "screen-home") renderHome();
  if (state.screen === "screen-settings") renderSettings();
  if (state.screen === "screen-words-i-know") renderWordsIKnow();
}

document.querySelectorAll(".lang-toggle").forEach((toggle) => {
  toggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".lang-btn:not(.theme-btn)");
    if (!btn || !btn.dataset.lang) return;
    setLang(btn.dataset.lang);
  });
});

$("theme-toggle").addEventListener("click", (e) => {
  const btn = e.target.closest(".theme-btn");
  if (!btn) return;
  applyTheme(btn.dataset.theme);
});

// Settings-only UI toggle (not persisted until Save) — selects the Off/On
// button and shows/hides the German reading-level picker block for live
// feedback, exactly like the theme toggle's own visual pattern.
function setGermanToggleUI(isOn) {
  document.querySelectorAll("#german-toggle .german-toggle-btn").forEach((b) => {
    b.classList.toggle("active", (b.dataset.german === "on") === isOn);
  });
  $("german-level-block").classList.toggle("hidden", !isOn);
}

$("german-toggle").addEventListener("click", (e) => {
  const btn = e.target.closest(".german-toggle-btn");
  if (!btn) return;
  setGermanToggleUI(btn.dataset.german === "on");
});

// ---- picker screen ----

function renderPicker() {
  syncLangToggles();
  const data = getData();

  // The German button is only shown if at least one kid on this device has
  // German unlocked — otherwise hide it, and if the picker is currently
  // stuck showing German UI with no way to switch, snap back to English.
  const anyGermanUnlocked = Object.values(data.kids).some((k) => germanUnlockedFor(k));
  $("picker-lang-toggle").querySelector('.lang-btn[data-lang="de"]').classList.toggle("hidden", !anyGermanUnlocked);
  if (!anyGermanUnlocked && state.lang === "de") {
    state.lang = "en";
    localStorage.setItem(LS.lang, "en");
    syncLangToggles();
    applyStaticTranslations();
  }

  const allNames = Object.keys(data.kids);
  const lastSelected = state.currentKid && allNames.includes(state.currentKid) ? state.currentKid : null;
  const others = allNames.filter((n) => n !== lastSelected);
  if (!state.pickerShuffle) state.pickerShuffle = shuffleArray(others);
  // Keep only still-existing names in shuffle order, then append any name
  // the cached shuffle doesn't know about yet (e.g. a kid created since)
  // so nothing is ever silently dropped from the list.
  const shuffled = new Set(state.pickerShuffle);
  const orderedOthers = state.pickerShuffle
    .filter((n) => others.includes(n))
    .concat(others.filter((n) => !shuffled.has(n)));
  const names = lastSelected ? [lastSelected, ...orderedOthers] : orderedOthers;
  const list = $("kid-list");
  list.innerHTML = "";
  for (const name of names) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "kid-card" + (name === state.currentKid ? " selected" : "");
    btn.innerHTML = `<span class="kid-avatar">${kidEmojiFor(data.kids[name], name)}</span><span class="kid-name">${escapeHtml(name)}</span>`;
    btn.addEventListener("click", () => selectKid(name));
    list.appendChild(btn);
  }
  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "kid-card new-kid-card";
  newBtn.innerHTML = `<span class="kid-avatar">＋</span><span class="kid-name">${escapeHtml(t("newKid"))}</span>`;
  newBtn.addEventListener("click", () => {
    $("new-kid-form").classList.remove("hidden");
    $("new-kid-input").focus();
  });
  list.appendChild(newBtn);
  $("new-kid-form").classList.add("hidden");
  $("new-kid-input").value = "";
}

function selectKid(name) {
  state.currentKid = name;
  localStorage.setItem(LS.lastKid, name);
  showScreen("screen-home");
}

$("btn-new-kid-cancel").addEventListener("click", () => { $("new-kid-form").classList.add("hidden"); });
$("new-kid-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("new-kid-input").value.trim().slice(0, 40);
  if (!name) return;
  const data = getData();
  if (data.kids[name]) { toast(t("nameTaken")); return; }
  createKid(name);
  flushQueue().catch(() => {});
  selectKid(name);
});

// ---- home screen ----

$("btn-switch-kid").addEventListener("click", () => showScreen("screen-picker"));
$("btn-open-settings").addEventListener("click", () => showScreen("screen-settings"));

function renderHome() {
  syncLangToggles();
  const kid = state.currentKid;
  const data = getData();
  const kidRecord = data.kids[kid];
  if (!kidRecord) { showScreen("screen-picker"); return; }

  // Hide the German button in this kid's topbar unless German is unlocked
  // for them — and if they're currently stranded on German UI they can no
  // longer exit via a hidden toggle, snap back to English before painting
  // anything else below.
  const germanUnlocked = germanUnlockedFor(kidRecord);
  $("home-lang-toggle").querySelector('.lang-btn[data-lang="de"]').classList.toggle("hidden", !germanUnlocked);
  if (!germanUnlocked && state.lang === "de") {
    state.lang = "en";
    localStorage.setItem(LS.lang, "en");
    syncLangToggles();
    applyStaticTranslations();
  }

  const lang = state.lang;
  const langData = kidRecord[lang];
  const today = todayStr();

  $("home-greeting").textContent = t("greeting", kid, kidEmojiFor(kidRecord, kid));

  const streak = computeStreak(langData.days, today);
  $("streak-text").textContent = t("streak", streak);
  $("streak-icon").textContent = streak === 0 ? "🧊" : "🔥";
  $("card-streak").classList.toggle("no-streak", streak === 0);

  const todayCount = langData.days[today] || 0;
  const goal = kidRecord.settings.wordsPerSession;
  const pct = goal > 0 ? Math.min(1, todayCount / goal) : 0;
  $("progress-bar-fill").style.width = `${pct * 100}%`;
  $("progress-bar-label").textContent = `${todayCount}/${goal}`;
  $("progress-encouragement").textContent = todayCount === 0
    ? t("letsStart")
    : todayCount > goal ? t("goalExceeded", todayCount - goal)
    : todayCount === goal ? t("goalReached")
    : t("toGo", goal - todayCount);

  renderWeeklyChart(langData, today);
}

// Bar chart of the last 7 days (oldest to newest, ending today): height and
// the number above each bar are the count of words practiced that day in
// the currently selected language (langData.days) — the same per-day
// counter driving the streak and daily-goal bar elsewhere on this screen.
//
// Scaled relative to THIS WEEK'S OWN busiest day (not the daily goal): the
// tallest bar always reaches MAX_BAR_PX, every other day is a proportional
// fraction of it, so one standout day (like a big practice binge) reads as
// dramatically taller rather than everything looking similarly "capped".
const MAX_BAR_PX = 96;

function renderWeeklyChart(langData, today) {
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(addDays(today, -i));
  const counts = days.map((d) => langData.days[d] || 0);
  const scaleMax = Math.max(1, ...counts);

  $("weekly-chart").innerHTML = days.map((d, i) => {
    const count = counts[i];
    // Any real practice gets at least a sliver of a visible bar — only a
    // true zero renders as nothing, per the "sit almost on top of the day
    // label" zero-day treatment.
    const px = count === 0 ? 0 : Math.max(4, Math.round((count / scaleMax) * MAX_BAR_PX));
    const [y, m, dd] = d.split("-").map(Number);
    const weekday = WEEKDAY_LABELS[state.lang][new Date(y, m - 1, dd).getDay()];
    const isToday = d === today;
    return `
      <div class="weekly-bar-col${isToday ? " is-today" : ""}">
        <div class="weekly-bar-track" style="height:${MAX_BAR_PX}px" title="${escapeHtml(t("wordsCount", count))}">
          <div class="weekly-bar-count" style="bottom:${px + 4}px">${count}</div>
          <div class="weekly-bar-fill" style="height:${px}px"></div>
        </div>
        <div class="weekly-bar-daylabel">${weekday}</div>
      </div>
    `;
  }).join("");
}

$("btn-start-practice").addEventListener("click", () => {
  startSession(state.currentKid, state.lang);
  if (!state.session || state.session.queue.length === 0) {
    toast(t("noWordsAvailable"));
    state.session = null;
    return;
  }
  showScreen("screen-practice");
  prewarmMic();
});

// ---- practice screen ----

if (!cloudSpeechAvailable && !speechSupported) {
  $("speech-unsupported-banner").classList.remove("hidden");
  $("btn-mic").disabled = true;
}

function renderPracticeWord() {
  if (!state.session) return;
  const word = currentWord();
  const wordEl = $("practice-word");
  wordEl.textContent = word || "";
  wordEl.classList.remove("len-md", "len-lg", "len-xl");
  const len = (word || "").length;
  if (len >= 10) wordEl.classList.add("len-xl");
  else if (len >= 7) wordEl.classList.add("len-lg");
  else if (len >= 5) wordEl.classList.add("len-md");
  $("practice-prompt").textContent = t("whatWord");
  $("mic-status").textContent = (cloudModeActive() || speechSupported) ? t("tapToListen") : "";
  $("feedback-wrong").classList.add("hidden");
  $("mastery-celebration").classList.add("hidden");
  if (state.sentenceActive) hideSentencePanel();
  updateMicWrongState(false);
  state.session.lastWrongWord = null;
  state.session.lastWrongPriorEntry = null;
  clearTimeout(state.autoAdvanceTimer);
  updatePracticeProgress();
}

function updateMicWrongState(wrong) {
  $("btn-mic").classList.toggle("was-wrong", wrong);
}

// Queue length can grow mid-session (wrong answers get requeued), so the
// segment count isn't fixed at session start — rebuild from scratch each
// call rather than trying to diff in new segments.
function updatePracticeProgress() {
  const s = state.session;
  if (!s) return;
  const track = $("practice-progress-track");
  const total = s.queue.length;
  const done = s.index;
  track.innerHTML = "";
  for (let i = 0; i < total; i++) {
    const seg = document.createElement("div");
    const segState = s.skippedIndices.has(i) ? " is-skipped" : i < done ? " is-done" : i === done ? " is-current" : "";
    seg.className = "practice-progress-seg" + segState;
    track.appendChild(seg);
  }
}

function shakeWord() {
  const el = $("practice-word");
  el.classList.remove("shake");
  void el.offsetWidth; // reflow to restart the animation
  el.classList.add("shake");
}

function burstConfetti(container) {
  const colors = ["var(--sage)", "var(--rose)", "var(--ochre)", "var(--powder)"];
  container.innerHTML = "";
  const star = document.createElement("div");
  star.className = "win-star";
  star.textContent = "⭐";
  container.appendChild(star);
  requestAnimationFrame(() => star.classList.add("pop"));

  for (let i = 0; i < 18; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    const angle = Math.random() * Math.PI * 2;
    const dist = 60 + Math.random() * 90;
    piece.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
    piece.style.setProperty("--dy", `${Math.sin(angle) * dist}px`);
    piece.style.setProperty("--rot", `${Math.random() * 360 - 180}deg`);
    piece.style.background = colors[i % colors.length];
    container.appendChild(piece);
    requestAnimationFrame(() => piece.classList.add("burst"));
  }
  setTimeout(() => { container.innerHTML = ""; }, 1300);
}

// Renders a sentence with each letter-run wrapped in a highlightable span
// (in the same order sentenceWordsOf() returns them), while leaving all
// original punctuation/spacing/capitalization as plain text around them.
function renderSentenceHTML(text) {
  const re = /[\p{L}]+/gu;
  let html = "";
  let lastEnd = 0;
  let idx = 0;
  let m;
  while ((m = re.exec(text))) {
    html += escapeHtml(text.slice(lastEnd, m.index));
    html += `<span class="sentence-word" data-idx="${idx}">${escapeHtml(m[0])}</span>`;
    lastEnd = re.lastIndex;
    idx++;
  }
  html += escapeHtml(text.slice(lastEnd));
  return html;
}

function showSentencePanel(text) {
  state.sentenceActive = true;
  state.sentenceTokens = sentenceWordsOf(text);
  state.sentenceMatchedIdx = new Set();
  $("practice-word").classList.add("hidden");
  $("practice-prompt").classList.add("hidden");
  $("sentence-text").innerHTML = renderSentenceHTML(text);
  $("sentence-panel").classList.remove("hidden");
  $("mic-status").textContent = t("sentencePrompt");
  updateMicWrongState(false);
}

function hideSentencePanel() {
  state.sentenceActive = false;
  $("sentence-panel").classList.add("hidden");
  $("practice-word").classList.remove("hidden");
  $("practice-prompt").classList.remove("hidden");
}

function applySentenceHighlights() {
  document.querySelectorAll("#sentence-text .sentence-word").forEach((el) => {
    el.classList.toggle("matched", state.sentenceMatchedIdx.has(Number(el.dataset.idx)));
  });
  const allMatched = state.sentenceTokens.length > 0 && state.sentenceMatchedIdx.size === state.sentenceTokens.length;
  if (allMatched) {
    playChime();
    burstConfetti($("confetti-layer"));
  }
}

// Reuses isMatch as-is (see the speech section below) against every target
// word, rather than trying to positionally align transcript tokens — a
// repeated word ("down, down, down") can highlight from a single hearing
// of it, which is generous rather than strict, matching this app's overall
// approach to a five-year-old's speech recognition.
function matchSentenceAgainstAlternatives(alternatives, lang) {
  state.sentenceTokens.forEach((word, idx) => {
    if (state.sentenceMatchedIdx.has(idx)) return;
    if (isMatch(alternatives, word, lang)) state.sentenceMatchedIdx.add(idx);
  });
  applySentenceHighlights();
}

function maybeShowSentence() {
  const s = state.session;
  if (!s || s.sentencesShown >= SENTENCE_MAX_PER_SESSION) { advanceSessionAndRender(); return; }
  const sentence = pickSentence(s.kid, s.lang);
  if (!sentence) { advanceSessionAndRender(); return; }
  s.sentencesShown++;
  showSentencePanel(sentence);
}

// A regular correct answer gets a quick cheer; the first time a word ever
// crosses into Mastered is a bigger, distinct moment — a dedicated overlay,
// a second confetti burst, and a longer pause before returning to the
// session, so it reads as "you LEARNED this" rather than just "correct".
function showMasteryCelebration(word) {
  $("mastery-celebration-text").textContent = t("masteredCheer", word);
  $("mastery-celebration-sub").textContent = t("masteredSub");
  $("mastery-celebration").classList.remove("hidden");
  setTimeout(() => burstConfetti($("confetti-layer")), 250);
  clearTimeout(state.autoAdvanceTimer);
  state.autoAdvanceTimer = setTimeout(() => {
    $("mastery-celebration").classList.add("hidden");
    advanceSessionAndRender();
  }, 2600);
}

function advanceSessionAndRender() {
  clearTimeout(state.autoAdvanceTimer);
  $("feedback-wrong").classList.add("hidden");
  if (!state.session) return;
  state.session.index++;
  if (state.session.index >= state.session.queue.length) {
    endSession();
  } else {
    renderPracticeWord();
  }
}

function handleCorrect() {
  const word = currentWord();
  const s = state.session;
  const { justMastered } = recordAnswer(word, true);
  playChime();
  burstConfetti($("confetti-layer"));
  if (justMastered) {
    showMasteryCelebration(word);
    return;
  }
  $("mic-status").textContent = t("correctCheer");
  const dueForSentence = s.practicedCount > 0 && s.practicedCount % SENTENCE_EVERY_N === 0;
  setTimeout(() => { dueForSentence ? maybeShowSentence() : advanceSessionAndRender(); }, 1200);
}

function handleWrong() {
  const word = currentWord();
  const s = state.session;
  if (s) {
    // Snapshot the word's entry BEFORE this wrong attempt mutates it, so
    // "I said it right!" can restore from here rather than algebraically
    // reversing the level/counter changes recordAnswer is about to make.
    const priorData = getData();
    const priorLangData = priorData.kids[s.kid] && priorData.kids[s.kid][s.lang];
    s.lastWrongWord = word;
    s.lastWrongPriorEntry = (priorLangData && priorLangData.words[word]) || null;
  }
  recordAnswer(word, false);
  shakeWord();
  $("mic-status").textContent = t("notQuite");
  updateMicWrongState(true);
  $("feedback-wrong").classList.remove("hidden");
}

// Corrects a wrong recording when the child actually said the word right
// but speech recognition missed it. Restores the word's PRE-attempt
// snapshot and applies a fresh correct answer on top of it, rather than
// stacking a correction on top of the wrong one — so the net effect on
// level/correct/wrong counters is as if this attempt was simply correct
// from the start, not "wrong then also correct".
function overridePreviousAnswerAsCorrect() {
  const s = state.session;
  const word = s.lastWrongWord;
  if (!word) return { justMastered: false };
  const wasMastered = !!(s.lastWrongPriorEntry && s.lastWrongPriorEntry.masteredOn);
  const data = getData();
  const langData = data.kids[s.kid][s.lang];
  const newEntry = applyAnswer(s.lastWrongPriorEntry, true, s.today);
  langData.words[word] = newEntry;
  s.wordUpdates[word] = newEntry;
  s.correctCount++;
  setData(data);

  queueOp({
    type: "progress",
    key: `progress:${s.kid}:${s.lang}`,
    payload: { kid: s.kid, lang: s.lang, words: { ...s.wordUpdates }, day: s.today, dayCount: s.dayCountBase + s.practicedCount },
  });

  // The wrong answer queued a same-session second try for this word —
  // no longer needed now that we know it was actually right.
  if (s.requeued.has(word)) {
    const idx = s.queue.lastIndexOf(word);
    if (idx > s.index) s.queue.splice(idx, 1);
    s.requeued.delete(word);
  }
  s.lastWrongWord = null;
  s.lastWrongPriorEntry = null;
  return { justMastered: !wasMastered && !!newEntry.masteredOn };
}

function handleMarkCorrect() {
  const s = state.session;
  if (!s || !s.lastWrongWord) return;
  const word = s.lastWrongWord;
  const { justMastered } = overridePreviousAnswerAsCorrect();
  clearTimeout(state.autoAdvanceTimer);
  $("feedback-wrong").classList.add("hidden");
  updateMicWrongState(false);
  playChime();
  burstConfetti($("confetti-layer"));
  if (justMastered) {
    showMasteryCelebration(word);
  } else {
    $("mic-status").textContent = t("correctCheer");
    state.autoAdvanceTimer = setTimeout(() => { advanceSessionAndRender(); }, 1200);
  }
}

$("btn-mic").addEventListener("click", () => {
  if (!state.session) return;
  if (cloudModeActive()) {
    if (state.micBusy) return; // "Thinking…" — ignore taps until the request settles
    $("feedback-wrong").classList.add("hidden");
    updateMicWrongState(false);
    clearTimeout(state.autoAdvanceTimer);
    startCloudListening();
    return;
  }
  if (!speechSupported || state.recognizing) return;
  $("feedback-wrong").classList.add("hidden");
  updateMicWrongState(false);
  clearTimeout(state.autoAdvanceTimer);
  startListening();
});

$("btn-hear-word").addEventListener("click", () => {
  if (!state.session) return;
  // No auto-advance: the child should be free to hear it again, retry via
  // the mic, mark it correct, or move on — whichever fits.
  speakWord(currentWord(), state.session.lang);
});

$("btn-mark-correct").addEventListener("click", () => {
  handleMarkCorrect();
});

$("btn-next-word").addEventListener("click", () => {
  advanceSessionAndRender();
});

// Skipping must never shrink how much the child ends up practicing: the
// skipped word is pushed back onto the end of the queue (so she still has
// to face it) and marked red in the breadcrumb at its original slot.
$("btn-skip").addEventListener("click", () => {
  const s = state.session;
  if (!s) return;
  s.skippedIndices.add(s.index);
  s.queue.push(currentWord());
  advanceSessionAndRender();
});

$("btn-end-session").addEventListener("click", () => {
  if (!state.session) return;
  endSession();
});

$("btn-sentence-continue").addEventListener("click", () => {
  if (!state.sentenceActive) return;
  hideSentencePanel();
  advanceSessionAndRender();
});

$("btn-sentence-i-read-it").addEventListener("click", () => {
  if (!state.sentenceActive) return;
  state.sentenceTokens.forEach((_, idx) => state.sentenceMatchedIdx.add(idx));
  applySentenceHighlights();
});

// ---- summary screen ----

function showSummary(s) {
  const stars = s.practicedCount === 0 ? "" : "⭐".repeat(Math.min(5, Math.max(1, Math.round((s.correctCount / s.practicedCount) * 5))));
  $("summary-stars").textContent = stars;
  $("summary-count").textContent = t("correctCount", s.correctCount, s.practicedCount);
  $("summary-practiced").textContent = t("practicedCount", s.practicedCount);
  showScreen("screen-summary");
  burstConfetti($("summary-confetti"));
}

$("btn-summary-home").addEventListener("click", () => showScreen("screen-home"));

// ---- settings screen ----

$("btn-settings-back").addEventListener("click", () => showScreen("screen-home"));

function renderEmojiPicker(selected, kidRecord) {
  const everMastered = combinedEverMastered(kidRecord);
  const unlockedCount = unlockedTierCount(everMastered);
  $("avatar-progress-text").textContent = t("avatarProgress", everMastered);

  $("emoji-picker").innerHTML = AVATAR_TIERS.map((tier, i) => {
    const locked = i >= unlockedCount;
    const buttons = tier.emojis.map((e) => locked
      ? `<button type="button" class="emoji-btn locked" disabled title="${escapeHtml(t("avatarLockedTooltip", tier.unlockAt))}"><span class="emoji-btn-glyph">${e}</span><span class="emoji-btn-lock">🔒</span></button>`
      : `<button type="button" class="emoji-btn${e === selected ? " selected" : ""}" data-emoji="${e}" aria-label="${e}">${e}</button>`
    ).join("");
    const tierLabel = locked ? t("avatarTierLocked", i + 1, tier.unlockAt) : t("avatarTierUnlocked", i + 1);
    return `
      <div class="avatar-tier">
        <div class="avatar-tier-label">${escapeHtml(tierLabel)}</div>
        <div class="avatar-tier-row">${buttons}</div>
      </div>
    `;
  }).join("");
}

$("emoji-picker").addEventListener("click", (e) => {
  const btn = e.target.closest(".emoji-btn");
  if (!btn || btn.disabled) return;
  $("emoji-picker").querySelectorAll(".emoji-btn").forEach((b) => b.classList.toggle("selected", b === btn));
});

// Reading-level picker labels per (language, level id) — a small lookup into
// the T dictionary so renderLevelPicker can localize each button's text.
const LEVEL_LABEL_KEYS = {
  en: {
    prek: "levelEnPrek", g1: "levelEnG1", g23: "levelEnG23",
    g4: "levelEnG4", g5: "levelEnG5", g6: "levelEnG6",
  },
  de: {
    prek: "levelDePrek", k1: "levelDeK1", k2: "levelDeK2",
    k3: "levelDeK3", k4: "levelDeK4", k5: "levelDeK5", k6: "levelDeK6",
  },
};

function renderLevelPicker(pickerId, lang, selectedId) {
  const el = $(pickerId);
  el.innerHTML = LEVEL_IDS[lang].map((id) => `
    <button type="button" class="level-btn${id === selectedId ? " selected" : ""}" data-level="${id}">${escapeHtml(t(LEVEL_LABEL_KEYS[lang][id]))}</button>
  `).join("");
}

// Re-renders both level pickers with localized labels. Called with explicit
// selections from renderSettings(); called with no args from
// applyStaticTranslations() on a bare language switch, in which case it
// preserves whatever was already selected in the DOM (falling back to the
// first level id if nothing was selected yet).
function renderLevelPickers(selectedEn, selectedDe) {
  const curEn = selectedEn || $("level-picker-en").querySelector(".level-btn.selected")?.dataset.level || LEVEL_IDS.en[0];
  const curDe = selectedDe || $("level-picker-de").querySelector(".level-btn.selected")?.dataset.level || LEVEL_IDS.de[0];
  renderLevelPicker("level-picker-en", "en", curEn);
  renderLevelPicker("level-picker-de", "de", curDe);
}

$("level-picker-en").addEventListener("click", (e) => {
  const btn = e.target.closest(".level-btn");
  if (!btn) return;
  $("level-picker-en").querySelectorAll(".level-btn").forEach((b) => b.classList.toggle("selected", b === btn));
});
$("level-picker-de").addEventListener("click", (e) => {
  const btn = e.target.closest(".level-btn");
  if (!btn) return;
  $("level-picker-de").querySelectorAll(".level-btn").forEach((b) => b.classList.toggle("selected", b === btn));
});

function renderSettings() {
  const kid = state.currentKid;
  const data = getData();
  const kidRecord = data.kids[kid];
  if (!kidRecord) { showScreen("screen-picker"); return; }

  $("settings-kid-name").value = kid;
  $("settings-words-per-session").value = kidRecord.settings.wordsPerSession;
  $("settings-new-words-per-day").value = kidRecord.settings.newWordsPerDay;
  renderEmojiPicker(kidEmojiFor(kidRecord, kid), kidRecord);
  // Initialize from the computed/effective value (not the raw field) so a
  // kid with prior German progress but an unset germanEnabled field still
  // shows "On" correctly.
  setGermanToggleUI(germanUnlockedFor(kidRecord));
  renderLevelPickers(kidRecord.settings.levels.en, kidRecord.settings.levels.de);

  $("confirm-reset").classList.add("hidden");
  $("confirm-delete-kid").classList.add("hidden");

  renderMastery();
}

function renderMastery() {
  const kid = state.currentKid;
  const lang = state.lang;
  const data = getData();
  const kidRecord = data.kids[kid];
  const langData = kidRecord[lang];
  const wordList = WORDS[lang];
  const words = langData.words;

  const levelId = (kidRecord.settings.levels && kidRecord.settings.levels[lang]) || LEVEL_IDS[lang][0];
  const startIndex = levelStartIndex(lang, levelId);

  const levels = { 0: [], 1: [], 2: [], 3: [] };
  const seen = new Set(Object.keys(words));
  for (const w of Object.keys(words)) levels[words[w].level].push(w);
  // Unseen words split by the kid's level start index: words at/after it are
  // genuinely "not yet seen"; words before it are treated as already known
  // for this kid's level and only shown in a separate collapsed group.
  const notSeen = [];
  const belowLevel = [];
  wordList.forEach((w, i) => {
    if (seen.has(w)) return;
    if (i < startIndex) belowLevel.push(w);
    else notSeen.push(w);
  });

  $("mastery-lang-label").textContent = lang === "de" ? "(Deutsch)" : "(English)";

  const chipDefs = [
    { key: 0, cls: "chip-new", label: t("levelNew") },
    { key: 1, cls: "chip-learning", label: t("levelLearning") },
    { key: 2, cls: "chip-familiar", label: t("levelFamiliar") },
    { key: 3, cls: "chip-mastered", label: t("levelMastered") },
  ];
  $("mastery-chips").innerHTML = chipDefs.map((c) => `
    <div class="mastery-chip ${c.cls}">
      <span class="chip-count">${levels[c.key].length}</span>
      <span class="chip-label">${escapeHtml(c.label)}</span>
    </div>
  `).join("");

  const groups = [
    { label: t("levelNew"), words: levels[0] },
    { label: t("levelLearning"), words: levels[1] },
    { label: t("levelFamiliar"), words: levels[2] },
    { label: t("levelMastered"), words: levels[3] },
    { label: t("notYetSeen"), words: notSeen },
  ];
  if (belowLevel.length > 0) groups.push({ label: t("belowLevel"), words: belowLevel });
  $("mastery-lists").innerHTML = groups.map((g) => `
    <details class="mastery-level-group">
      <summary>${escapeHtml(g.label)} (${g.words.length})</summary>
      <div class="mastery-word-chips">
        ${g.words.map((w) => `<span class="mastery-word-chip">${escapeHtml(w)}</span>`).join("") || `<span class="settings-hint">${escapeHtml(t("noneYet"))}</span>`}
      </div>
    </details>
  `).join("");
}

$("btn-settings-save").addEventListener("click", async () => {
  const oldName = state.currentKid;
  const requestedName = $("settings-kid-name").value.trim().slice(0, 40);
  const newName = requestedName || oldName;
  const wordsPerSession = clampNum(parseInt($("settings-words-per-session").value, 10), 5, 50, DEFAULT_SETTINGS.wordsPerSession);
  const newWordsPerDay = clampNum(parseInt($("settings-new-words-per-day").value, 10), 0, 10, DEFAULT_SETTINGS.newWordsPerDay);
  const levelEn = $("level-picker-en").querySelector(".level-btn.selected")?.dataset.level || DEFAULT_SETTINGS.levels.en;
  const levelDe = $("level-picker-de").querySelector(".level-btn.selected")?.dataset.level || DEFAULT_SETTINGS.levels.de;
  const germanEnabled = $("german-toggle").querySelector(".german-toggle-btn.active")?.dataset.german === "on";
  const settings = { wordsPerSession, newWordsPerDay, levels: { en: levelEn, de: levelDe }, germanEnabled };
  const emoji = $("emoji-picker").querySelector(".emoji-btn.selected")?.dataset.emoji || "";

  const data = getData();
  const rename = newName !== oldName ? newName : undefined;
  if (rename) {
    if (data.kids[rename]) { toast(t("nameUsedByAnother")); return; }
    data.kids[rename] = data.kids[oldName];
    delete data.kids[oldName];
  }
  const targetName = rename || oldName;
  data.kids[targetName].settings = settings;
  if (emoji) data.kids[targetName].emoji = emoji;
  setData(data);

  if (rename) {
    state.currentKid = targetName;
    localStorage.setItem(LS.lastKid, targetName);
  }

  queueOp({ type: "settings", key: `settings:${oldName}`, payload: { kid: oldName, settings, rename, emoji } });
  await flushQueue().catch(() => {});

  toast(t("settingsSaved"));
  renderSettings();
});

$("btn-reset-progress").addEventListener("click", () => $("confirm-reset").classList.remove("hidden"));
$("btn-reset-cancel").addEventListener("click", () => $("confirm-reset").classList.add("hidden"));
$("btn-reset-confirm").addEventListener("click", async () => {
  const kid = state.currentKid;
  const data = getData();
  data.kids[kid].en = { words: {}, days: {} };
  data.kids[kid].de = { words: {}, days: {} };
  setData(data);
  $("confirm-reset").classList.add("hidden");
  queueOp({ type: "reset-kid", key: `reset-kid:${kid}`, payload: { kid } });
  await flushQueue().catch(() => {});
  toast(t("resetDone"));
  renderSettings();
});

$("btn-delete-kid").addEventListener("click", () => $("confirm-delete-kid").classList.remove("hidden"));
$("btn-delete-kid-cancel").addEventListener("click", () => $("confirm-delete-kid").classList.add("hidden"));
$("btn-delete-kid-confirm").addEventListener("click", async () => {
  const kid = state.currentKid;
  const data = getData();
  delete data.kids[kid];
  setData(data);
  queueOp({ type: "delete-kid", key: `delete-kid:${kid}`, payload: { kid } });
  await flushQueue().catch(() => {});
  state.currentKid = "";
  localStorage.removeItem(LS.lastKid);
  toast(t("kidDeleted"));
  showScreen("screen-picker");
});

// ---- "Words I Know" screen ----
// The kid-facing trophy case: every word she's ever practiced, in the
// current UI language, with a 4-segment strength bar reflecting its live
// spaced-repetition level. Mastered words furthest first — the collection
// itself is meant to feel like something she's building up, not a sorted
// data dump (that lives in Settings > Word mastery for the parent).
const LEVEL_LABEL_KEY_BY_TIER = ["levelNew", "levelLearning", "levelFamiliar", "levelMastered"];
const LEVEL_CLASS_BY_TIER = ["level-new", "level-learning", "level-familiar", "level-mastered"];

function renderWordsIKnow() {
  const kid = state.currentKid;
  const lang = state.lang;
  const data = getData();
  const kidRecord = data.kids[kid];
  if (!kidRecord) return;
  const words = kidRecord[lang].words;

  const entries = Object.keys(words).map((w) => ({ word: w, level: words[w].level }));
  entries.sort((a, b) => b.level - a.level || a.word.localeCompare(b.word));

  $("words-i-know-sub").textContent = t("wordsIKnowCount", entries.length);
  $("words-i-know-list").innerHTML = entries.length ? entries.map((e) => `
    <div class="words-i-know-row">
      <span class="words-i-know-word">${escapeHtml(e.word)}</span>
      <span class="strength-bar ${LEVEL_CLASS_BY_TIER[e.level]}" role="img" aria-label="${escapeHtml(t(LEVEL_LABEL_KEY_BY_TIER[e.level]))}">
        ${[0, 1, 2, 3].map((i) => `<span class="strength-seg${i <= e.level ? " filled" : ""}"></span>`).join("")}
      </span>
      ${e.level === 3 ? `<span class="words-i-know-badge" aria-hidden="true">🏆</span>` : ""}
    </div>
  `).join("") : `<p class="settings-hint">${escapeHtml(t("noWordsYet"))}</p>`;
}

$("btn-words-i-know").addEventListener("click", () => showScreen("screen-words-i-know"));
$("words-i-know-back").addEventListener("click", () => showScreen("screen-home"));

// ------------------- init -------------------

// Reload once, automatically, the moment a new service worker takes
// control. Without this, sw.js's skipWaiting()/clients.claim() only make
// the new worker win future network requests — the already-open page
// keeps running its OLD in-memory JS/CSS until something reloads it. iOS
// Safari also only lazily checks for a new worker version (often not at
// all if the installed app was merely backgrounded rather than fully
// closed), so every shipped fix used to need an explicit force-close from
// the user. registration.update() below asks for that check proactively
// on every launch instead of waiting on the browser's own schedule.
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
  navigator.serviceWorker.register("sw.js").then((reg) => {
    reg.update().catch(() => {});
  }).catch(() => {});
}

async function init() {
  ensureDataShape();
  ensureVoicesLoaded();
  registerServiceWorker();
  syncLangToggles();
  applyStaticTranslations();

  if (workerConfigured()) {
    await flushQueue().catch(() => {});
    await refreshFromRemote().catch(() => {});
    ensureDataShape();
  }

  const lastKid = localStorage.getItem(LS.lastKid) || "";
  const data = getData();
  if (lastKid && data.kids[lastKid]) state.currentKid = lastKid;

  showScreen("screen-picker");
}

init();

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
const KID_EMOJIS = ["🦊", "🐻", "🐰", "🐼", "🦁", "🐨", "🐸", "🦋", "🐢", "🐬", "🦄", "🐝"];

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

function kidEmoji(name) { return KID_EMOJIS[hashString(name) % KID_EMOJIS.length]; }

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
    toGo: (n) => `${n} to go!`,
    statsText: (seen, mastered) => `${seen} words seen · ${mastered} mastered`,
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
    kidName: "Kid's name",
    wordsPerSession: "Words per session",
    newWordsPerDay: "New words per day",
    levelLabelEn: "Reading level 🇺🇸",
    levelLabelDe: "Reading level 🇩🇪",
    levelEnPrek: "Pre-K / K",
    levelEnG1: "1st grade",
    levelEnG23: "2nd/3rd grade",
    levelDePrek: "Pre-K / K",
    levelDeK1: "Grade 1",
    levelDeK2: "Grade 2",
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
    toGo: (n) => `Noch ${n}!`,
    statsText: (seen, mastered) => `${seen} Wörter gesehen · ${mastered} gemeistert`,
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
    kidName: "Name des Kindes",
    wordsPerSession: "Wörter pro Sitzung",
    newWordsPerDay: "Neue Wörter pro Tag",
    levelLabelEn: "Lesestufe 🇺🇸",
    levelLabelDe: "Lesestufe 🇩🇪",
    levelEnPrek: "Vorschule",
    levelEnG1: "1. Klasse",
    levelEnG23: "2./3. Klasse",
    levelDePrek: "Vorschule",
    levelDeK1: "Klasse 1",
    levelDeK2: "Klasse 2",
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

  $("btn-switch-kid").setAttribute("aria-label", t("switchKid"));
  $("btn-switch-kid").title = t("switchKid");
  $("btn-open-settings").setAttribute("aria-label", t("settings"));
  $("btn-open-settings").title = t("settings");
  $("btn-start-practice").textContent = t("startPractice");

  $("speech-unsupported-banner").textContent = t("speechUnsupported");
  $("btn-mic").setAttribute("aria-label", t("tapToListen"));
  $("btn-hear-word").textContent = t("hearWord");
  $("btn-next-word").textContent = t("next");
  $("btn-skip").textContent = t("skip");
  $("btn-end-session").textContent = t("endSession");

  $("summary-title").textContent = t("sessionComplete");
  $("btn-summary-home").textContent = t("backHome");

  $("settings-heading").textContent = t("settingsTitle");
  $("appearance-heading").textContent = t("appearance");
  $("label-theme").textContent = t("theme");
  $("theme-btn-light").textContent = t("themeLight");
  $("theme-btn-dark").textContent = t("themeDark");
  $("general-heading").textContent = t("general");
  $("label-avatar").textContent = t("avatarLabel");
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
  const e = entry ? { ...entry } : { level: 0, correct: 0, wrong: 0, lastSeen: today, nextDue: today };
  if (correct) {
    e.level = Math.min(3, e.level + 1);
    e.correct += 1;
    const interval = { 1: 1, 2: 3, 3: 7 }[e.level];
    e.nextDue = addDays(today, interval);
  } else {
    e.level = Math.max(0, e.level - 1);
    e.wrong += 1;
    e.nextDue = today;
  }
  e.lastSeen = today;
  return e;
}

// Builds one practice queue: due reviews first (lowest level, then oldest
// lastSeen), then brand-new words in list order STARTING AT startIndex
// (words before it are "assumed known" for this kid's level and never
// introduced — capped by the daily new-word budget), then top-up with
// soonest-due already-seen words. Reviews and top-up are unaffected by
// startIndex — any word with stored progress keeps working regardless of
// the kid's current level.
function buildSession(langData, wordList, settings, today, alreadyIntroducedToday, startIndex = 0) {
  const words = langData.words || {};
  const wordsPerSession = settings.wordsPerSession;
  const newBudget = Math.max(0, settings.newWordsPerDay - alreadyIntroducedToday);

  const queue = [];
  const used = new Set();

  const due = Object.keys(words)
    .filter((w) => words[w].nextDue <= today)
    .sort((a, b) => {
      if (words[a].level !== words[b].level) return words[a].level - words[b].level;
      return (words[a].lastSeen || "").localeCompare(words[b].lastSeen || "");
    });
  for (const w of due) {
    if (queue.length >= wordsPerSession) break;
    queue.push(w);
    used.add(w);
  }

  let newlyIntroducedCount = 0;
  if (queue.length < wordsPerSession) {
    for (let i = startIndex; i < wordList.length; i++) {
      const w = wordList[i];
      if (queue.length >= wordsPerSession || newlyIntroducedCount >= newBudget) break;
      if (words[w] || used.has(w)) continue;
      queue.push(w);
      used.add(w);
      newlyIntroducedCount++;
    }
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
    correctCount: 0,
    practicedCount: 0,
    wordUpdates: {},
    dayCountBase: langData.days[today] || 0,
  };
}

function currentWord() {
  return state.session ? state.session.queue[state.session.index] : undefined;
}

// Applies the spaced-repetition update, writes it to the local cache
// immediately (so Home/Settings reflect it even mid-session), and
// checkpoints a local-only queue snapshot so an abandoned session isn't lost.
function recordAnswer(word, correct) {
  if (!word) return; // defensive: never persist a bogus entry if called with no current word
  const s = state.session;
  const data = getData();
  const langData = data.kids[s.kid][s.lang];
  // A word only consumes the day's new-word budget once the kid actually
  // answers it — not merely because it was placed in a session's queue.
  // Otherwise a newly-introduced word that gets Skipped (never recorded)
  // would still burn the budget, starving every later session that day
  // down to whatever's left (see the "and" repeating bug this fixed).
  const isNewWord = !langData.words[word];
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
  ["an", "ann"],
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
    if (targetNorm.length >= 5 && levenshtein(tok, targetNorm) <= 1) return true;
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
  }, 6000);

  rec.onresult = (event) => {
    settled = true;
    clearTimeout(timeoutId);
    const result = event.results[0];
    const alternatives = [];
    for (let i = 0; i < result.length; i++) alternatives.push(result[i].transcript);
    handleRecognitionResult(alternatives);
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

// Phrases Whisper is prone to hallucinating on silence/background noise
// (video outro captions it saw a lot of in training). Checked against the
// raw (lower-cased, unnormalized) transcript so punctuation like "www."
// still matches.
const HALLUCINATION_PHRASES = [
  "untertitel", "amara.org", "subtitles", "subscribe", "www.", "copyright",
  "vielen dank fürs zuschauen", "thanks for watching", "thank you for watching",
];

// Decides whether a cloud transcript should be treated as "didn't hear
// anything usable" rather than fed into the matcher — covers empty results,
// known Whisper hallucination phrases, and long rambles that don't match the
// target word (far more likely noise misheard as a sentence than an actual
// wrong answer).
function isNoSpeechTranscript(rawText, targetWord, lang) {
  const norm = normalizeTranscript(rawText || "");
  if (!norm) return true;
  const lower = String(rawText).toLowerCase();
  if (HALLUCINATION_PHRASES.some((p) => lower.includes(p))) return true;
  const tokenCount = norm.split(" ").filter(Boolean).length;
  if (tokenCount > 6 && !isMatch([rawText], targetWord, lang)) return true;
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

  state.micRecordTimer = setTimeout(() => { stopCloudRecording(); }, RECORD_MAX_MS);
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
  handleCloudTranscript(text);
}

function handleCloudTranscript(text) {
  const word = currentWord();
  if (!word || !state.session) return;
  if (isNoSpeechTranscript(text, word, state.session.lang)) {
    handleNoSpeech();
    return;
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

// ---- picker screen ----

function renderPicker() {
  syncLangToggles();
  const data = getData();
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
  const lang = state.lang;
  const langData = kidRecord[lang];
  const today = todayStr();

  $("home-greeting").textContent = t("greeting", kid, kidEmojiFor(kidRecord, kid));

  const streak = computeStreak(langData.days, today);
  $("streak-text").textContent = t("streak", streak);

  const todayCount = langData.days[today] || 0;
  const goal = kidRecord.settings.wordsPerSession;
  const pct = goal > 0 ? Math.min(1, todayCount / goal) : 0;
  $("progress-bar-fill").style.width = `${pct * 100}%`;
  $("progress-bar-label").textContent = `${todayCount}/${goal}`;
  $("progress-encouragement").textContent = todayCount === 0
    ? t("letsStart")
    : (todayCount >= goal ? t("goalReached") : t("toGo", goal - todayCount));

  const wordsSeen = Object.keys(langData.words).length;
  const mastered = Object.values(langData.words).filter((w) => w.level === 3).length;
  $("stats-text").textContent = t("statsText", wordsSeen, mastered);
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
  $("practice-word").textContent = word || "";
  $("practice-prompt").textContent = t("whatWord");
  $("mic-status").textContent = (cloudModeActive() || speechSupported) ? t("tapToListen") : "";
  $("feedback-wrong").classList.add("hidden");
  clearTimeout(state.autoAdvanceTimer);
  updatePracticeProgress();
}

function updatePracticeProgress() {
  const s = state.session;
  if (!s) return;
  const total = s.queue.length;
  const done = s.index;
  const pct = total ? Math.round((done / total) * 100) : 0;
  $("practice-progress-fill").style.width = pct + "%";
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
  recordAnswer(word, true);
  playChime();
  burstConfetti($("confetti-layer"));
  $("mic-status").textContent = t("correctCheer");
  setTimeout(() => { advanceSessionAndRender(); }, 1200);
}

function handleWrong() {
  const word = currentWord();
  recordAnswer(word, false);
  shakeWord();
  $("mic-status").textContent = t("notQuite");
  $("feedback-wrong").classList.remove("hidden");
}

$("btn-mic").addEventListener("click", () => {
  if (!state.session) return;
  if (cloudModeActive()) {
    if (state.micBusy) return; // "Thinking…" — ignore taps until the request settles
    $("feedback-wrong").classList.add("hidden");
    clearTimeout(state.autoAdvanceTimer);
    startCloudListening();
    return;
  }
  if (!speechSupported || state.recognizing) return;
  $("feedback-wrong").classList.add("hidden");
  clearTimeout(state.autoAdvanceTimer);
  startListening();
});

$("btn-hear-word").addEventListener("click", () => {
  if (!state.session) return;
  speakWord(currentWord(), state.session.lang);
  clearTimeout(state.autoAdvanceTimer);
  state.autoAdvanceTimer = setTimeout(() => { advanceSessionAndRender(); }, 1500);
});

$("btn-next-word").addEventListener("click", () => {
  advanceSessionAndRender();
});

$("btn-skip").addEventListener("click", () => {
  if (!state.session) return;
  advanceSessionAndRender();
});

$("btn-end-session").addEventListener("click", () => {
  if (!state.session) return;
  endSession();
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

function renderEmojiPicker(selected) {
  const el = $("emoji-picker");
  el.innerHTML = KID_EMOJIS.map((e) => `
    <button type="button" class="emoji-btn${e === selected ? " selected" : ""}" data-emoji="${e}" aria-label="${e}">${e}</button>
  `).join("");
}

$("emoji-picker").addEventListener("click", (e) => {
  const btn = e.target.closest(".emoji-btn");
  if (!btn) return;
  $("emoji-picker").querySelectorAll(".emoji-btn").forEach((b) => b.classList.toggle("selected", b === btn));
});

// Reading-level picker labels per (language, level id) — a small lookup into
// the T dictionary so renderLevelPicker can localize each button's text.
const LEVEL_LABEL_KEYS = {
  en: { prek: "levelEnPrek", g1: "levelEnG1", g23: "levelEnG23" },
  de: { prek: "levelDePrek", k1: "levelDeK1", k2: "levelDeK2" },
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
  renderEmojiPicker(kidEmojiFor(kidRecord, kid));
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
  const settings = { wordsPerSession, newWordsPerDay, levels: { en: levelEn, de: levelDe } };
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

// ------------------- init -------------------

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
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

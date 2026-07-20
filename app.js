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
const WORKER_URL = "";
// Must match the APP_KEY secret set on the Worker. Not real security (it's
// visible in this public source) — just a deterrent against casual randoms
// who stumble on the Worker URL.
const APP_KEY = "";

const LS = {
  lang: "swt-lang",
  lastKid: "swt-last-kid",
  cacheData: "swt-cache-data",
  pendingQueue: "swt-pending-queue",
  newCount: "swt-new-today",
};

const DEFAULT_SETTINGS = { wordsPerSession: 20, newWordsPerDay: 3 };
const KID_EMOJIS = ["🦊", "🐻", "🐰", "🐼", "🦁", "🐨", "🐸", "🦋", "🐢", "🐬", "🦄", "🐝"];

const state = {
  lang: localStorage.getItem(LS.lang) || "en",
  currentKid: localStorage.getItem(LS.lastKid) || "",
  screen: "screen-picker",
  session: null,
  recognizing: false,
  autoAdvanceTimer: null,
};

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

// ------------------- data layer (local cache = source of truth) -------------------

function emptyKidRecord() {
  return {
    settings: { ...DEFAULT_SETTINGS },
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
    if (!kid.settings || typeof kid.settings !== "object") kid.settings = { ...DEFAULT_SETTINGS };
    if (!Number.isFinite(kid.settings.wordsPerSession)) kid.settings.wordsPerSession = DEFAULT_SETTINGS.wordsPerSession;
    if (!Number.isFinite(kid.settings.newWordsPerDay)) kid.settings.newWordsPerDay = DEFAULT_SETTINGS.newWordsPerDay;
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
// lastSeen), then brand-new words in list order (capped by the daily new-
// word budget), then top-up with soonest-due already-seen words.
function buildSession(langData, wordList, settings, today, alreadyIntroducedToday) {
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
    for (const w of wordList) {
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
  const { queue, newlyIntroducedCount } = buildSession(langData, WORDS[lang], kidRecord.settings, today, alreadyIntroduced);
  if (newlyIntroducedCount > 0) addNewIntroducedToday(kid, lang, today, newlyIntroducedCount);

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
  const newEntry = applyAnswer(langData.words[word], correct, s.today);
  langData.words[word] = newEntry;

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
  $("mic-status").textContent = "I didn't hear you — try again!";
}

function updateMicUI(listening) {
  $("btn-mic").classList.toggle("listening", listening);
  if (listening) $("mic-status").textContent = "Listening…";
}

// ------------------- screens / render -------------------

function showScreen(id) {
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
  if (state.screen === "screen-home") renderHome();
  if (state.screen === "screen-settings") renderSettings();
}

document.querySelectorAll(".lang-toggle").forEach((toggle) => {
  toggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".lang-btn");
    if (!btn) return;
    setLang(btn.dataset.lang);
  });
});

// ---- picker screen ----

function renderPicker() {
  syncLangToggles();
  const data = getData();
  const names = Object.keys(data.kids).sort((a, b) => a.localeCompare(b));
  const list = $("kid-list");
  list.innerHTML = "";
  for (const name of names) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "kid-card" + (name === state.currentKid ? " selected" : "");
    btn.innerHTML = `<span class="kid-avatar">${kidEmoji(name)}</span><span class="kid-name">${escapeHtml(name)}</span>`;
    btn.addEventListener("click", () => selectKid(name));
    list.appendChild(btn);
  }
  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "kid-card new-kid-card";
  newBtn.innerHTML = `<span class="kid-avatar">＋</span><span class="kid-name">New kid</span>`;
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
  if (data.kids[name]) { toast("That name is already taken."); return; }
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

  $("home-greeting").textContent = `Hi, ${kid}! ${kidEmoji(kid)}`;

  const streak = computeStreak(langData.days, today);
  $("streak-text").textContent = `${streak} day${streak === 1 ? "" : "s"} streak`;

  const todayCount = langData.days[today] || 0;
  const goal = kidRecord.settings.wordsPerSession;
  const pct = goal > 0 ? Math.min(1, todayCount / goal) : 0;
  const circumference = 264;
  $("progress-ring-fill").style.strokeDashoffset = String(circumference * (1 - pct));
  $("progress-ring-label").textContent = `${todayCount}/${goal}`;
  $("progress-encouragement").textContent = todayCount === 0
    ? "Let's get started!"
    : (todayCount >= goal ? "Goal reached! 🎉" : `${goal - todayCount} to go!`);

  const wordsSeen = Object.keys(langData.words).length;
  const mastered = Object.values(langData.words).filter((w) => w.level === 3).length;
  $("stats-text").textContent = `${wordsSeen} words seen · ${mastered} mastered`;
}

$("btn-start-practice").addEventListener("click", () => {
  startSession(state.currentKid, state.lang);
  if (!state.session || state.session.queue.length === 0) {
    toast("No words available right now — try adjusting Settings.");
    state.session = null;
    return;
  }
  showScreen("screen-practice");
});

// ---- practice screen ----

if (!speechSupported) {
  $("speech-unsupported-banner").classList.remove("hidden");
  $("btn-mic").disabled = true;
}

function renderPracticeWord() {
  if (!state.session) return;
  const word = currentWord();
  $("practice-word").textContent = word || "";
  $("practice-prompt").textContent = state.session.lang === "de" ? "Welches Wort ist das?" : "What word is this?";
  $("mic-status").textContent = speechSupported ? "Tap to listen" : "";
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
  $("mic-status").textContent = "Yes! 🎉";
  setTimeout(() => { advanceSessionAndRender(); }, 1200);
}

function handleWrong() {
  const word = currentWord();
  recordAnswer(word, false);
  shakeWord();
  $("mic-status").textContent = "Not quite!";
  $("feedback-wrong").classList.remove("hidden");
}

$("btn-mic").addEventListener("click", () => {
  if (!speechSupported || state.recognizing || !state.session) return;
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
  $("summary-count").textContent = `${s.correctCount} / ${s.practicedCount} correct`;
  $("summary-practiced").textContent = `You practiced ${s.practicedCount} word${s.practicedCount === 1 ? "" : "s"} this session.`;
  showScreen("screen-summary");
  burstConfetti($("summary-confetti"));
}

$("btn-summary-home").addEventListener("click", () => showScreen("screen-home"));

// ---- settings screen ----

$("btn-settings-back").addEventListener("click", () => showScreen("screen-home"));

function renderSettings() {
  const kid = state.currentKid;
  const data = getData();
  const kidRecord = data.kids[kid];
  if (!kidRecord) { showScreen("screen-picker"); return; }

  $("settings-kid-name").value = kid;
  $("settings-words-per-session").value = kidRecord.settings.wordsPerSession;
  $("settings-new-words-per-day").value = kidRecord.settings.newWordsPerDay;

  $("confirm-reset").classList.add("hidden");
  $("confirm-delete-kid").classList.add("hidden");

  renderMastery();
}

function renderMastery() {
  const kid = state.currentKid;
  const lang = state.lang;
  const data = getData();
  const langData = data.kids[kid][lang];
  const wordList = WORDS[lang];
  const words = langData.words;

  const levels = { 0: [], 1: [], 2: [], 3: [] };
  const seen = new Set(Object.keys(words));
  for (const w of Object.keys(words)) levels[words[w].level].push(w);
  const notSeen = wordList.filter((w) => !seen.has(w));

  $("mastery-lang-label").textContent = lang === "de" ? "(Deutsch)" : "(English)";

  const chipDefs = [
    { key: 0, cls: "chip-new", label: "New" },
    { key: 1, cls: "chip-learning", label: "Learning" },
    { key: 2, cls: "chip-familiar", label: "Familiar" },
    { key: 3, cls: "chip-mastered", label: "Mastered" },
  ];
  $("mastery-chips").innerHTML = chipDefs.map((c) => `
    <div class="mastery-chip ${c.cls}">
      <span class="chip-count">${levels[c.key].length}</span>
      <span class="chip-label">${c.label}</span>
    </div>
  `).join("");

  const groups = [
    { label: "New", words: levels[0] },
    { label: "Learning", words: levels[1] },
    { label: "Familiar", words: levels[2] },
    { label: "Mastered", words: levels[3] },
    { label: "Not yet seen", words: notSeen },
  ];
  $("mastery-lists").innerHTML = groups.map((g) => `
    <details class="mastery-level-group">
      <summary>${g.label} (${g.words.length})</summary>
      <div class="mastery-word-chips">
        ${g.words.map((w) => `<span class="mastery-word-chip">${escapeHtml(w)}</span>`).join("") || '<span class="settings-hint">None yet.</span>'}
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
  const settings = { wordsPerSession, newWordsPerDay };

  const data = getData();
  const rename = newName !== oldName ? newName : undefined;
  if (rename) {
    if (data.kids[rename]) { toast("That name is already used by another kid."); return; }
    data.kids[rename] = data.kids[oldName];
    delete data.kids[oldName];
  }
  const targetName = rename || oldName;
  data.kids[targetName].settings = settings;
  setData(data);

  if (rename) {
    state.currentKid = targetName;
    localStorage.setItem(LS.lastKid, targetName);
  }

  queueOp({ type: "settings", key: `settings:${oldName}`, payload: { kid: oldName, settings, rename } });
  await flushQueue().catch(() => {});

  toast("Settings saved! ✅");
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
  toast("Progress reset.");
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
  toast("Kid deleted.");
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

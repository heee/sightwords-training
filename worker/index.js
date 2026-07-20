// Sight Words Training — Cloudflare Worker proxy.
//
// Holds the one GitHub token server-side so no one has to paste a token
// into the app. The client only ever talks to this Worker.
//
//   GET  /data          -> current data.json contents (no auth required to read)
//   POST /progress       -> { kid, lang: "en"|"de", words: { word: {level,correct,wrong,lastSeen,nextDue} },
//                              day: "YYYY-MM-DD", dayCount: N }
//                            -> merges: overwrites the given word entries, and
//                               days[day] = max(existing, dayCount). Creates the kid if missing.
//   POST /register-kid   -> { kid } -> creates an empty kid record with default settings if absent
//   POST /settings       -> { kid, settings: { wordsPerSession, newWordsPerDay,
//                              levels: { en: "prek"|"g1"|"g23", de: "prek"|"k1"|"k2" } }, rename?, emoji? }
//                            -> clamps ranges (5-50, 0-10); invalid/missing levels fall back to
//                               defaults ("prek"/"k1"); rename moves the whole kid record;
//                               emoji must be one of KID_EMOJIS or it's ignored
//   POST /reset-kid      -> { kid } -> clears en/de progress + days, keeps kid + settings
//   POST /delete-kid     -> { kid } -> removes kid entirely
//
// Required Worker secrets/variables (set in the Cloudflare dashboard under
// Settings -> Variables and Secrets):
//   GITHUB_TOKEN   (secret)  fine-grained PAT, Contents: Read and write, scoped to one repo
//   GH_OWNER       (var)     e.g. "heee"
//   GH_REPO        (var)     e.g. "sightwords-training"
//   GH_BRANCH      (var)     e.g. "main"
//   APP_KEY        (secret)  any string; must match APP_KEY in app.js — a casual
//                            deterrent only, not real auth (it's visible in client source)
//   ALLOWED_ORIGIN (var)     e.g. "https://heee.github.io" (or "*" to allow any origin)

const DEFAULT_SETTINGS = { wordsPerSession: 20, newWordsPerDay: 3, levels: { en: "prek", de: "prek" } };
const KID_EMOJIS = ["🦊", "🐻", "🐰", "🐼", "🦁", "🐨", "🐸", "🦋", "🐢", "🐬", "🦄", "🐝"];
const MAX_WORDS_PER_SESSION = 50;
const MIN_WORDS_PER_SESSION = 5;
const MAX_NEW_WORDS_PER_DAY = 10;
const MIN_NEW_WORDS_PER_DAY = 0;
const VALID_LEVELS = { en: ["prek", "g1", "g23"], de: ["prek", "k1", "k2"] };

function emptyKid() {
  return {
    settings: { ...DEFAULT_SETTINGS, levels: { ...DEFAULT_SETTINGS.levels } },
    en: { words: {}, days: {} },
    de: { words: {}, days: {} },
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (url.pathname === "/data" && request.method === "GET") {
      try {
        const { data } = await fetchGithubFile(env);
        return json(data, 200, cors);
      } catch (e) {
        return json({ error: e.message }, 502, cors);
      }
    }

    if (url.pathname === "/progress" && request.method === "POST") {
      if (!checkKey(request, env)) return json({ error: "unauthorized" }, 401, cors);
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: "invalid JSON body" }, 400, cors);
      }
      const parsed = validateProgress(body);
      if (!parsed) return json({ error: "invalid progress payload" }, 400, cors);

      try {
        await commitMutation(env, (data) => {
          if (!data.kids[parsed.kid]) data.kids[parsed.kid] = emptyKid();
          const kidRecord = data.kids[parsed.kid];
          const langData = kidRecord[parsed.lang];
          for (const [word, entry] of Object.entries(parsed.words)) {
            langData.words[word] = entry;
          }
          const existingDayCount = Number(langData.days[parsed.day]) || 0;
          langData.days[parsed.day] = Math.max(existingDayCount, parsed.dayCount);
        }, `Progress: ${parsed.kid} (${parsed.lang})`);
        return json({ ok: true }, 200, cors);
      } catch (e) {
        return json({ error: e.message }, 502, cors);
      }
    }

    if (url.pathname === "/register-kid" && request.method === "POST") {
      if (!checkKey(request, env)) return json({ error: "unauthorized" }, 401, cors);
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: "invalid JSON body" }, 400, cors);
      }
      const kid = validKidName(body?.kid);
      if (!kid) return json({ error: "invalid kid" }, 400, cors);

      try {
        await commitMutation(env, (data) => {
          if (!data.kids[kid]) data.kids[kid] = emptyKid();
        }, `Register kid: ${kid}`);
        return json({ ok: true }, 200, cors);
      } catch (e) {
        return json({ error: e.message }, 502, cors);
      }
    }

    if (url.pathname === "/settings" && request.method === "POST") {
      if (!checkKey(request, env)) return json({ error: "unauthorized" }, 401, cors);
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: "invalid JSON body" }, 400, cors);
      }
      const kid = validKidName(body?.kid);
      if (!kid) return json({ error: "invalid kid" }, 400, cors);
      const rename = typeof body?.rename === "string" ? body.rename.trim().slice(0, 40) : "";
      const wordsPerSession = clamp(Math.floor(Number(body?.settings?.wordsPerSession)), MIN_WORDS_PER_SESSION, MAX_WORDS_PER_SESSION, DEFAULT_SETTINGS.wordsPerSession);
      const newWordsPerDay = clamp(Math.floor(Number(body?.settings?.newWordsPerDay)), MIN_NEW_WORDS_PER_DAY, MAX_NEW_WORDS_PER_DAY, DEFAULT_SETTINGS.newWordsPerDay);
      const levelEn = VALID_LEVELS.en.includes(body?.settings?.levels?.en) ? body.settings.levels.en : DEFAULT_SETTINGS.levels.en;
      const levelDe = VALID_LEVELS.de.includes(body?.settings?.levels?.de) ? body.settings.levels.de : DEFAULT_SETTINGS.levels.de;
      const emoji = KID_EMOJIS.includes(body?.emoji) ? body.emoji : "";

      try {
        await commitMutation(env, (data) => {
          if (!data.kids[kid]) data.kids[kid] = emptyKid();
          data.kids[kid].settings = { wordsPerSession, newWordsPerDay, levels: { en: levelEn, de: levelDe } };
          if (emoji) data.kids[kid].emoji = emoji;
          if (rename && rename !== kid) {
            data.kids[rename] = data.kids[kid];
            delete data.kids[kid];
          }
        }, `Settings: ${kid}${rename ? ` -> ${rename}` : ""}`);
        return json({ ok: true, kid: rename || kid }, 200, cors);
      } catch (e) {
        return json({ error: e.message }, 502, cors);
      }
    }

    if (url.pathname === "/reset-kid" && request.method === "POST") {
      if (!checkKey(request, env)) return json({ error: "unauthorized" }, 401, cors);
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: "invalid JSON body" }, 400, cors);
      }
      const kid = validKidName(body?.kid);
      if (!kid) return json({ error: "invalid kid" }, 400, cors);

      try {
        await commitMutation(env, (data) => {
          if (!data.kids[kid]) return;
          data.kids[kid].en = { words: {}, days: {} };
          data.kids[kid].de = { words: {}, days: {} };
        }, `Reset progress: ${kid}`);
        return json({ ok: true }, 200, cors);
      } catch (e) {
        return json({ error: e.message }, 502, cors);
      }
    }

    if (url.pathname === "/delete-kid" && request.method === "POST") {
      if (!checkKey(request, env)) return json({ error: "unauthorized" }, 401, cors);
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: "invalid JSON body" }, 400, cors);
      }
      const kid = validKidName(body?.kid);
      if (!kid) return json({ error: "invalid kid" }, 400, cors);

      try {
        await commitMutation(env, (data) => {
          delete data.kids[kid];
        }, `Delete kid: ${kid}`);
        return json({ ok: true }, 200, cors);
      } catch (e) {
        return json({ error: e.message }, 502, cors);
      }
    }

    return json({ error: "not found" }, 404, cors);
  },
};

function checkKey(request, env) {
  return !env.APP_KEY || request.headers.get("X-App-Key") === env.APP_KEY;
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-App-Key",
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

function clamp(n, min, max, fallback) {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function validKidName(name) {
  const trimmed = typeof name === "string" ? name.trim().slice(0, 40) : "";
  return trimmed || null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateProgress(body) {
  if (!body || typeof body !== "object") return null;
  const kid = validKidName(body.kid);
  if (!kid) return null;
  const lang = body.lang === "en" || body.lang === "de" ? body.lang : null;
  if (!lang) return null;
  const day = typeof body.day === "string" && DATE_RE.test(body.day) ? body.day : null;
  if (!day) return null;
  const dayCount = Math.floor(Number(body.dayCount));
  if (!Number.isFinite(dayCount) || dayCount < 0 || dayCount > 1000) return null;

  const rawWords = body.words;
  if (!rawWords || typeof rawWords !== "object" || Array.isArray(rawWords)) return null;
  const entries = Object.entries(rawWords);
  if (entries.length > 300) return null;

  const words = {};
  for (const [word, entry] of entries) {
    if (typeof word !== "string" || !word.trim() || word.length > 60) return null;
    if (!entry || typeof entry !== "object") return null;
    const level = Math.floor(Number(entry.level));
    const correct = Math.floor(Number(entry.correct));
    const wrong = Math.floor(Number(entry.wrong));
    const lastSeen = typeof entry.lastSeen === "string" && DATE_RE.test(entry.lastSeen) ? entry.lastSeen : null;
    const nextDue = typeof entry.nextDue === "string" && DATE_RE.test(entry.nextDue) ? entry.nextDue : null;
    if (!Number.isFinite(level) || level < 0 || level > 3) return null;
    if (!Number.isFinite(correct) || correct < 0 || correct > 10000) return null;
    if (!Number.isFinite(wrong) || wrong < 0 || wrong > 10000) return null;
    if (!lastSeen || !nextDue) return null;
    words[word.trim().slice(0, 60)] = { level, correct, wrong, lastSeen, nextDue };
  }

  return { kid, lang, day, dayCount, words };
}

async function ghHeaders(env) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "User-Agent": "sightwords-training-worker",
  };
}

function decodeBase64Utf8(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

function encodeBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

async function fetchGithubFile(env) {
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/data.json?ref=${encodeURIComponent(env.GH_BRANCH || "main")}`;
  const res = await fetch(url, { headers: await ghHeaders(env) });
  if (!res.ok) throw new Error(`GitHub fetch failed (${res.status})`);
  const fileJson = await res.json();
  let data;
  try {
    data = JSON.parse(decodeBase64Utf8(fileJson.content));
  } catch (e) {
    data = { kids: {} };
  }
  if (!data.kids || typeof data.kids !== "object") data.kids = {};
  return { data, sha: fileJson.sha };
}

async function putGithubFile(env, data, sha, message) {
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/data.json`;
  const body = {
    message,
    content: encodeBase64Utf8(JSON.stringify(data, null, 2)),
    sha,
    branch: env.GH_BRANCH || "main",
  };
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...(await ghHeaders(env)), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub write failed (${res.status}): ${text.slice(0, 200)}`);
  }
}

// Re-fetches immediately before writing (and retries a few times) so two
// devices saving progress at nearly the same moment don't clobber each
// other's `sha`. `mutate` edits `data` in place.
async function commitMutation(env, mutate, message, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const { data, sha } = await fetchGithubFile(env);
      mutate(data);
      await putGithubFile(env, data, sha, message);
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw lastErr;
}

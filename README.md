# Sight Words 🦊

Bilingual (English / German) sight-word reading practice for early readers. The
child sees a word, says it out loud, and the app listens via the free Web
Speech API — reward on a correct answer, hear the right pronunciation on a
miss. Progress (which words are New / Learning / Familiar / Mastered, and
when each is next due for review) is tracked **per kid, per language**, using
a lightweight spaced-repetition schedule.

Everything the front-end needs is static: `index.html` + `style.css` +
`app.js` + `words.js`, plus a `manifest.json` and `sw.js` for installing it as
a PWA. All shared data lives in a single `data.json` file in a GitHub repo —
but nobody touches GitHub directly. A small Cloudflare Worker holds the one
GitHub credential server-side and proxies reads and writes, so **setup is
one-time for the admin (you) and zero-touch for everyone else**. The app also
works completely standalone with no server at all — see "Local-only mode"
below.

---

## 1. Create the GitHub repo and seed `data.json`

1. On GitHub, create a **new repository** (public or private both work).
   - e.g. `sightwords-training`
2. Add all the files from this project to that repo (`index.html`,
   `style.css`, `app.js`, `words.js`, `manifest.json`, `sw.js`, `icons/`,
   `worker/`, this `README.md`).
3. Add a `data.json` file at the **root** of the repo with this exact
   starting content:

   ```json
   { "kids": {} }
   ```

4. Commit and push. This file is the shared database — the Worker reads and
   writes to it via the GitHub Contents API. Nothing else in the repo needs
   to touch it.

## 2. Generate one fine-grained personal access token (you only, one time)

Only you need this token — it lives in the Worker, never on a device.

1. Go to **GitHub → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens** (or open
   <https://github.com/settings/personal-access-tokens/new> directly).
2. **Repository access**: choose "Only select repositories" and pick the
   `sightwords-training` repo you just created. Don't grant access to any
   other repo.
3. **Permissions**: under "Repository permissions", set **Contents** to
   **Read and write**. Leave everything else as "No access".
4. Set an expiration (1 year is the max for fine-grained tokens — put a
   reminder to regenerate it and update the Worker secret when it's about to
   expire).
5. Generate the token and copy it (starts with `github_pat_...`). GitHub only
   shows it once — you'll paste it into the Worker in the next step.

## 3. Deploy the Cloudflare Worker (you only, one time)

This is the piece that lets everyone skip GitHub setup entirely. It's a free
Cloudflare account and a few minutes, no CLI required.

1. Sign up / log in at <https://dash.cloudflare.com> (free plan is plenty).
2. Go to **Workers & Pages → Create → Create Worker**. Give it a name (e.g.
   `sightwords-training-worker`) and deploy the default "Hello World"
   template first — you'll replace the code next.
3. Open the Worker, click **Edit code** (Quick Edit), delete everything in
   the editor, and paste in the full contents of
   [`worker/index.js`](worker/index.js) from this repo. Click **Deploy**.
4. Back on the Worker's overview page, go to **Settings → Variables and
   Secrets** and add:
   - `GH_OWNER` (variable) — your GitHub username/org, e.g. `heee`
   - `GH_REPO` (variable) — `sightwords-training`
   - `GH_BRANCH` (variable) — `main`
   - `ALLOWED_ORIGIN` (variable) — your GitHub Pages URL, e.g.
     `https://heee.github.io` (or `*` if you'd rather not restrict it)
   - `GITHUB_TOKEN` (**secret**) — the fine-grained token from step 2
   - `APP_KEY` (**secret**) — make up any random string; you'll paste this
     same string into `app.js` in the next step
5. Note the Worker's URL, shown at the top of its overview page — it looks
   like `https://sightwords-training-worker.<your-subdomain>.workers.dev`.
6. Open `app.js` in this repo and update the two constants near the top:

   ```js
   const WORKER_URL = "https://sightwords-training-worker.<your-subdomain>.workers.dev";
   const APP_KEY = "<the same random string you used for the APP_KEY secret>";
   ```

7. Commit and push that change.

> **On `APP_KEY`:** it's baked into `app.js`, which is public source anyone
> can view — so it is **not** real security, just a speed bump against
> someone stumbling on your Worker URL and poking at it. The actual secret
> (`GITHUB_TOKEN`) never leaves the Worker and is never visible to the
> browser.

## 4. Deploy to GitHub Pages

1. In the repo, go to **Settings → Pages**.
2. Under "Build and deployment", set **Source** to **Deploy from a branch**.
3. Pick your default branch (e.g. `main`) and folder `/ (root)`, then
   **Save**.
4. GitHub will publish the site at `https://<owner>.github.io/<repo>/`
   within a minute or two.
5. GitHub Pages serves everything over HTTPS automatically, which the Web
   Speech API requires.

Since there's no build step, any push to that branch redeploys the site —
just edit files and push.

## 5. Add it to the home screen

1. Open the GitHub Pages URL in **Safari** (must be Safari on iOS/iPadOS —
   only Safari can install PWAs to the home screen there).
2. Tap the **Share** icon (square with an arrow) in the toolbar.
3. Scroll down and tap **Add to Home Screen**.
4. Confirm the name ("Sight Words") and tap **Add**.
5. Launch it from the home screen icon from now on.

If you update the code later, pushing to GitHub Pages updates the live site
immediately — the installed home screen icon just reopens that same URL.
Devices that already have it installed may still see the old cached version
for a bit because of the service worker — bump `CACHE_NAME` in `sw.js` (e.g.
`swt-shell-v3`) whenever you ship a meaningful change, so installed copies
pick up the update promptly instead of serving stale files indefinitely.

---

## Local-only mode (test before you deploy)

`app.js`'s `WORKER_URL` constant is empty (`""`) out of the box. In that
state the app runs **entirely on localStorage** — no network calls, no
Worker, no GitHub. Every screen, the whole spaced-repetition engine, speech
recognition/synthesis, and settings all work exactly the same; the only
difference is progress lives on that one device/browser instead of syncing
anywhere. This is the intended way to try the app immediately:

```
node scripts/static-server.js
```

then open `http://localhost:8090` in a browser. Only fill in `WORKER_URL` /
`APP_KEY` once you're ready to share progress across devices (step 3 above).

---

## How spaced repetition works

Each kid has independent progress for English and German. Every word a kid
has ever answered gets a record: `level` (0 New → 3 Mastered), `correct` /
`wrong` counts, `lastSeen`, and `nextDue`.

- **Correct answer**: level goes up by one (capped at 3, "Mastered"), and the
  word won't come up again for a while — 1 day at Learning, 3 days at
  Familiar, 7 days at Mastered.
- **Wrong answer**: level drops by one (floored at 0), and the word is due
  again today. It's also re-queued once at the end of the *current* session
  for an immediate second try (which counts normally).
- **Skip**: no effect on the word's stats at all, and doesn't count toward
  the day's practice total — it just moves on.

Building a session (up to "words per session," a setting per kid): first,
anything overdue for review (oldest/lowest-level first); then brand-new
words in Dolch/Grundwortschatz order, capped by "new words per day" (shared
across every session that day, so playing twice in one day won't blow past
the new-word cap); then, if there's still room, a top-up of already-seen
words ordered by whichever is due soonest.

## Reading levels

Each kid also has a **reading level per language**, set in Settings > General
("Reading level 🇺🇸" / "Reading level 🇩🇪"): Pre-K/K, 1st grade, or 2nd/3rd
grade for English; Grade 1 or Grade 2 for German. The level picks an entry
point into that language's word list (`LEVELS` in `words.js`) — any word
*before* that point is treated as **"assumed known"** and is never
introduced as a brand-new word for that kid.

This only affects *new*-word introduction. Reviews of words the kid has
already practiced keep working exactly as before no matter where the level
is set (e.g. raising the level later doesn't hide progress made below it).
In Settings > Word mastery, unseen words below the current level start
appear in their own collapsed "Below level (assumed known)" group instead of
"Not yet seen," so it's easy to tell "hasn't gotten there yet" apart from
"we're skipping this one."

## Speech recognition — notes & limitations on iOS

- Speech recognition (`webkitSpeechRecognition`) works in **Safari**. It is
  **not guaranteed to work in an installed home-screen PWA** on iOS — if the
  app reports "Speech isn't available here," open the same URL directly in
  Safari (not the home-screen icon) to practice.
- Speech *synthesis* (hearing the correct word) works in both contexts.
- Matching is intentionally generous for 5-year-olds: exact match, common
  homophones (to/too/two, there/their/they're, etc.) and digit↔word forms
  (one/1) in both languages, umlaut-normalized comparison for German, and a
  small typo/mishearing tolerance (edit distance of 1) for longer words.
- No speech detected within about 6 seconds is **not** scored wrong — the
  child just gets asked to try again.

## Progress sync

Progress syncs to the shared `data.json` **once per session**, when the
session ends (either by finishing all words or tapping "End session") — not
after every word, to keep network chatter minimal. Every individual answer
is still checkpointed to `localStorage` immediately, so if the app is closed
or the tab dies mid-session, nothing is lost: the next time the app loads, it
retries anything still queued. If the Worker is unreachable when a session
ends, the same thing happens — the attempt is queued and retried
automatically on the next load.

## Notes & limitations

- Cloudflare's free plan (100,000 requests/day) is far more than a family
  needs for this.
- If a fine-grained token's expiration passes, writes will start failing
  (reads still work) — regenerate the token and update the `GITHUB_TOKEN`
  secret on the Worker, no redeploy of the front-end needed.
- The Worker re-fetches `data.json` immediately before every write and
  retries a few times, so two devices saving at nearly the same moment don't
  clobber each other.

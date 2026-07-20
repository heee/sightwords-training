# Working conventions for this repo

- **Minimize dialogue.** Keep responses terse — critical messages and summaries only, no play-by-play narration.
- Worker (`worker/index.js`) redeploys are manual: paste into Cloudflare dashboard Quick Edit. No wrangler (Windows ARM64 has no `workerd` build).
- Before any preview check: unregister service workers + clear caches, then reload.
- Before `git push`: `git fetch` + check `origin/main` for new commits (the live app writes real progress data straight to `data.json` via the Worker, independent of this working tree) — merge if needed.
- Bump `sw.js`'s `CACHE_NAME` on every shipped change.
- `WORKER_URL` / `APP_KEY` at the top of `app.js` are empty by default (local-only mode) — never commit real values without checking with the user first if this is meant to stay a local test build.

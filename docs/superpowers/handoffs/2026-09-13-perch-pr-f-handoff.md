# Perch PR-F handoff — dashboard PWA (audit item 22, last parity item)

**Date:** 2026-09-13 (evening) · **From:** the session that shipped PR-E
**Parent plan:** `docs/superpowers/handoffs/2026-09-13-perch-parity-remaining-handoff.md` — its §"Hard-won gotchas" (1–12) stays authoritative. This file carries PR-E's delta, PR-E's one open tail, and PR-F's verified starting evidence.

## State of the world (verified this session, not remembered)

- **`main` = `c8377e28`** — PR-A/B/C/D **and PR-E** all merged, CI green.
- **R4 is on current main**: `/home/kh0pp/crow` ff-merged, `crow-r4-gateway` restarted ~17:17 CDT, unit `active`, 25 `connected` journal lines. **R4 is this host** (`hostname crow`, tailnet `100.118.41.122`) — there is no separate box to SSH to.
- Full suite as of PR-E: **4854 pass / 0 fail** (4866 total, 12 skipped).
- **Perch hub client identity-guard count is 18 and stays 18** — PR-E's `on('file')` rides the shared `on()` wrapper guard (`client.js` ~1217: `if(current.sid!==sid) return;`), so it added no new literal. Verified by the pinned count test, not assumed.
- Migration ledger on R4: `0007-perch-session-files` applied `2026-09-13T22:17:17Z`, `perch_session_files` table present, 0 rows.
- Worktree `/home/kh0pp/crow-wt-pr-e` and branch `feat/perch-send-user-file` (local+remote) are cleaned up.

## ⚠ PR-E's open tail: the feature is INERT until pi-lab gitea PR #2 merges

**pi-lab PR `kh0pp/pi-lab#2`** (http://100.71.250.95:3000/kh0pp/pi-lab/pulls/2) is OPEN and **unmerged**. The crow half is deployed; the pi-lab half (`extensions/send-user-file.ts`, branch `feat/crow-send-user-file-relay`, commit `0f71a96`) is not on pi-lab `main`, and **this host's `~/pi-lab` working tree was deliberately returned to `main`** after the smoke (pi-lab is loaded LIVE by every pi via `~/.pi/agent/settings.json` — leaving an unreviewed branch checked out is the blast-radius rule the parent handoff set).

Consequence: `send_user_file` does not exist for perch children right now. **After the operator merges gitea #2:** `git -C ~/pi-lab checkout main && git -C ~/pi-lab pull` — **no crow redeploy or restart needed** (the extension is picked up at the next spawn; crow's `--tools` append is already live in `bridge.mjs`).

### Live smoke for that moment (what I could NOT finish)

Both halves were measured individually on R4; the joint leg (model → tool call → notify) was not:

- ✅ `send_user_file` present in the awake child's argv `--tools` csv (measured via `ps` while the pi-lab branch was checked out) — this was PR-E's whole Q1 blocker.
- ✅ `GET /interactive/:sid/workspace/pre-smoke.md` on R4 → 200, 13 bytes, `nosniff`, `Content-Disposition: attachment` (the jail the card links).
- ✅ `GET /interactive/:sid/files/history` → 200 `{"items":[]}` (correct shape).
- ❌ **The relay itself:** asked `r4-assistant` four times, escalating directness, to call `send_user_file`. It answered `"🟢"` / prose every time and never invoked the tool. `perch_session_files` stayed at 0 rows. This is local-model compliance (parent gotcha #11: `qwen3.6-35b-a3b` is a reasoning model prone to terse non-compliance under load), **not** a plumbing failure — the relay leg is covered by 9 engine tests running real fs.
- Note the deployed-code check I did run: `npm test -- tests/perch-interactive-sendfile.test.js` **from `/home/kh0pp/crow`** → 9/9 green against the deployed tree.

**Recipe for a proper joint smoke** (session ids mint fresh; `POST /interactive` is NOT a route — the spawn is `POST /bots/:id/interactive`):
1. Mint a temp token (memory: `oauth_tokens` column is `token` = sha256, `token_type='access'`, `client_id='dashboard'`) in `/home/kh0pp/.crow-r4/data/crow.db`; `echo pw | sudo -S -v` then bare `sudo …` (piping SQL into `sudo -S sqlite3` is the trap).
2. `POST /dashboard/perch-api/bots/r4-assistant/interactive` `{}` → `sessionId`.
3. **SSE path is `/interactive/:sid/events`, NOT `/stream`** (measured: `/stream` 404s through Express).
4. `POST /interactive/:sid/message` — a running turn answers `turn_in_progress`; **poll until accepted** rather than sleeping.
5. Watch the stream for `event: file`, then check `perch_session_files` + the file inside `…/bots/r4-assistant/outputs/<sid>/`.
6. Try a model that follows tool instructions if the 35b stonewalls again (`GET /interactive/:sid/options` lists them; `control({model})` **binds at next wake**, `applied.model` reads null until then — measured).
7. Cleanup: stop the session, `DELETE` the token, remove the scratch file.

## PR-F — audit item 22: dashboard PWA (the last parity item)

Parent plan's warning is the headline: **bigger blast radius than it looks**, do it LAST, split it if it grows. Reference implementation: pi-lab's mobile page (`~/pi-lab/extensions/web/public/app.html` + manifest + sw) and `web/mobile.ts`'s `handlePage` mount.

Hazards to carry in (all from the parent handoff, restated for this scope):
- **CSP** — the dashboard already sends `script-src 'self' 'unsafe-inline'` (measured on the workspace response above); a same-origin service worker is allowed, an external one is not.
- **Auth under a SW** — never cache authenticated API responses; `navigate-fallback` only. `/dashboard/perch-api/*` and SSE must be bypassed entirely by the worker.
- **Turbo Drive coexistence** — the shell runs Turbo (`shared/layout.js`, opt-out `CROW_ENABLE_TURBO=0`). A SW that intercepts navigations fights Turbo's fetch-and-swap. Decide explicitly: scope the SW to caching the shell's static assets and stay out of navigation, or gate on `CROW_ENABLE_TURBO`.
- **Funnel invariant (hard)** — the Nest and every private route must never be Funnel-reachable; only `/blog`, `/robots.txt`, `/sitemap.xml`, `/.well-known/`, `/favicon.ico`, `/manifest.json` are public (`CLAUDE.md` §"Network exposure invariant", enforced in `gateway/index.js` + `isAllowedNetwork()`). **A SW registered on a blog-served page would be public-facing.** There is already a public `/manifest.json` — do NOT overwrite it; the dashboard needs its own scoped manifest (e.g. under `/dashboard/`). If you touch any of the three enforcement layers, run `tests/auth-network.test.js`.
- `apple-mobile-web-app-*` metas belong in the dashboard head (`servers/gateway/dashboard/shared/layout.js`'s `turboHead()`/head assembly) — check whether the i18n/render tests assert head contents before editing.

## Rhythm (unchanged, it works)

Diagnose with evidence → `ask_user` tap-card for decisions → small focused PR → CI green → **ask before every merge** → merge via REST rebase (PAT `GITHUB_PERSONAL_ACCESS_TOKEN` in `/home/kh0pp/crow/.env`) → `git fetch && git merge --ff-only origin/main` in `/home/kh0pp/crow` (a bare restart serves stale code — memory #4) → restart R4 → live-smoke → clean up worktree/branch/scratch → store memory. Operator reads on a phone: scannable, **bold outcomes**.

**`main` is protected — a direct `git push origin main` is REJECTED** (`protected branch hook declined`; measured this session while committing a handoff doc). Docs ride a branch + PR like everything else, so this file is deliberately left UNTRACKED on disk alongside its siblings (the parent handoff and the open-anywhere one are untracked too).

Worktree: `git worktree add /home/kh0pp/crow-wt-<name> -b <branch> origin/main && ln -s /home/kh0pp/crow/node_modules <wt>/node_modules`.
Gotcha #1 is non-negotiable after any `perch-hub/client.js` edit (template literal: escape backticks, `${`, regex `/` and `\s`):
`node -e "import('./servers/gateway/dashboard/perch-hub/client.js').then(m=>new Function(m.perchHubJs('en')))"`.
**New files must be listed in the positional-path commit** — see memory #9 (a staged-but-unlisted `0007-*.mjs` cost a CI red this session).

## Still owed when the parity arc concludes

- `servers/gateway/public/perch-parity-audit.html` — **untracked**, served tailnet-only. Decide: commit it as the arc's record or delete it.
- Also untracked and worth a decision at the same time: `docs/superpowers/handoffs/2026-09-13-perch-parity-remaining-handoff.md` and `docs/superpowers/handoffs/2026-09-12-perch-open-anywhere-session-handoff.md` (the PR-E handoff `2026-09-13-perch-pr-e-send-user-file-handoff.md` IS tracked — the earlier ones predate it).
- `docs/superpowers/specs/2026-09-12-perch-hub-pi-lab-parity-audit.md` item 12's table row still reads **investigate**; PR-A…E were never annotated in the spec (consistent with siblings — no per-PR spec edit is required, but the arc-closing commit is the natural place to mark the ledger).
- Separate un-owned bug: `~/pi-lab/bin/pi-extension-check` (see memory #8) — `npm run test:extensions` currently gates nothing on this host.

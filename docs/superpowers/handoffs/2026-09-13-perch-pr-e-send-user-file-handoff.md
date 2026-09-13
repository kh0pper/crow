# Perch PR-E handoff — send_user_file (audit item 12)

**Date:** 2026-09-13 · **From:** the session that finished PR-D after the Qwen quota kill
**Parent plan:** `docs/superpowers/handoffs/2026-09-13-perch-parity-remaining-handoff.md` (PR-A…PR-F, all hard-won gotchas §1–12). That file stays authoritative for the gotchas — this one only carries PR-D's delta + PR-E's verified starting evidence.

## State of the world (verified this session, not remembered)

- `main` = `2889d282` — PR-A (`5f86cb14`), PR-B (`e526122c`), PR-C (`abb30acd`), **PR-D (#372, narrowing pane)** all merged, CI green.
- **R4 runs current main** (restarted + double-smoked). Lesson that bit us: the R4 gateway's `WorkingDirectory` is `/home/kh0pp/crow`, and that checkout can LAG `origin/main` — a bare `systemctl restart` served pre-PR-D code. Correct deploy: `git fetch origin && git merge --ff-only origin/main` in `/home/kh0pp/crow`, grep the changed file to confirm it's on disk, THEN restart. (Stored as memory #4.)
- Full suite as of PR-D: **4835 pass / 0 fail** (4847 total, 12 skipped). VitePress build green EN+ES.
- Perch hub client **identity-guard count is now 18** (PR-D bumped it from 17).
- R4 smoke plumbing corrections to the parent handoff's gotcha #8: the `oauth_tokens` hashed-token column is **`token`** (there is NO `token_hash`), and it needs `token_type='access'`. Piping SQL into `sudo -S sqlite3` is a trap (sudo eats the redirect as the password; a cached sudo timestamp makes sqlite parse the password line as SQL). Robust: `echo pw | sudo -S -v; sudo sqlite3 db < file.sql`. (Memory #5.)

## PR-E — verified starting evidence (measured this session)

1. **`send_user_file` is NOT in pi's core dist.** `grep -c send_user_file` over `~/.nvm/versions/node/v24.21.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` → **0**. So the tool is an **extension**, not harness-native — the parent handoff's "my pi harness has it" is pi-lab, not pi.
2. **It lives in pi-lab**: `/home/kh0pp/pi-lab/extensions/web/mobile.ts` is the registration + `user_file` event server (for pi-lab's OWN web server). Also referenced from `extensions/plan-mode/index.ts` and `extensions/permission-modes.ts`.
3. **Behavioral trace** (session jsonl from 2026-07-03, `~/.pi/agent/sessions/--home-kh0pp-.claude-jobs-7318f8fc-tmp-scratchtest--/`): the tool result is plain text — *"Sent mockup.html (0KB) to the web chat (no clients connected right now; it will appear when the chat reloads history — mention the path too)."* So in pi-lab the file event goes to pi-lab's connected web clients; the tool itself resolves to a prose confirmation.

## The open questions (investigate in this order, before building)

- **Q1 — do perch bot RPC children even load the tool?** `~/.pi/agent/settings.json` packages load pi-lab LIVE for every pi on this host (parent handoff: pi-lab section) — but perch spawns pass `--tools` (the R7 belt, `bridge.mjs` ~195). Grep whether `send_user_file` survives that csv filter for an interactive bot child, or whether pi-lab's web/mobile extension only registers when its server is up.
- **Q2 — is there an RPC-visible signal at all?** Over `--mode rpc` the parent sees tool frames: a `send_user_file` tool_call carries `{path, caption}` in `argsText`, and the result text lands in `resultText`. There is probably NO `user_file` event crossing RPC (pi-lab's server is per-process; a bot child's pi-lab web server is not the gateway). **If so, the honest relay is the tool_call frame itself**, not a new event.
- **Q3 — can the child's path be served?** The child runs with the session cwd; a file at an arbitrary path is NOT under the outputs jail. The parent handoff's build sketch (tool writes to outputsDir, frame carries the name, chat renders an inline card linking the EXISTING workspace route; images inline) hinges on whether perch's outputsDir is reachable/known to the model — check how the hub's Files tab (PR-B) resolves files today and whether `send_user_file`'s path can be jailed the same read-only way.

## Decision gate (operator-scope, do not improvise past it)

- If Q2/Q3 work off the **tool_call frame + an existing jail-served route** → build it small: engine recognizes a `send_user_file` tool start on a perch session, hub Chat renders an inline file card (name/caption/size; images inline), linking the existing download route; anything outside the jail renders name-only + a "path not servable" dim note.
- If it needs a **pi-lab-side relay** (like PR-A's `crow-ask:` notify) → STOP and re-scope with the operator first. That repo is human-flow (branch + merge through gitea, `npm run test:extensions`, loaded live by every pi — the blast-radius rules in the parent handoff apply).

## Rhythm (unchanged, it works)

Diagnose with evidence → ask_user tap-card for decisions → small focused PR → CI green → **ask before every merge** → merge via REST rebase (PAT: `GITHUB_PERSONAL_ACCESS_TOKEN` in `/home/kh0pp/crow/.env`; the parent handoff pointing at `.mcp.json` was wrong — that bearer is the board token) → ff `/home/kh0pp/crow` + restart R4 → live-smoke → clean up worktree/branch/scratch → store memory. Operator reads on a phone: scannable summaries, bold outcomes.

Worktree pattern: `git worktree add /home/kh0pp/crow-wt-<name> -b <branch> origin/main && ln -s /home/kh0pp/crow/node_modules <wt>/node_modules`.
Gotcha #1 (client.js lives in a template literal: escape backticks/`${`/regex) and its post-edit check are non-negotiable: `node -e "import('./servers/gateway/dashboard/perch-hub/client.js').then(m=>new Function(m.perchHubJs('en')))"`.

## After PR-E

PR-F (audit item 22, dashboard PWA) is the last parity item; parent handoff says do it LAST and split it if it grows. The untracked `servers/gateway/public/perch-parity-audit.html` still needs sweeping when the arc concludes.

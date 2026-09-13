# Perch Hub ↔ pi-lab web hub — parity audit

**Date:** 2026-09-12 · **Requested by:** operator ("bring parity of tools and features from the pi-lab perch hub over to the crow perch hub")
**Sources measured (not remembered):** `~/pi-lab/extensions/web/public/app.html` (919-line preact client), `~/pi-lab/extensions/web/{mobile.ts,server.ts}` (endpoint surface), `~/pi-lab/extensions/ask-user.ts` + `shared/bot-mode.mjs` (the ask gate), crow's `servers/gateway/dashboard/perch-hub/*`, `routes/perch-interactive-api.js`, `perch-interactive.js`, `scripts/pi-bots/{bridge,bot-world,pi_extensions_allowlist}.mjs`, and the live R4 instance.

Scope note: the two hubs answer to different masters. pi-lab's hub drives ONE pi session that owns its own web server; crow's hub drives an engine of many bot sessions inside the dashboard's auth/funnel/Turbo regime, with Bot Builder as the single writer of what a bot may do. "Parity" below means operator-visible capability, not architecture — items marked **DIVERGENT BY DESIGN** are places where copying pi-lab would undo a deliberate crow decision.

## 1. Already at parity (or beyond)

| Capability | pi-lab | crow | Notes |
|---|---|---|---|
| Chat / Session / Files / Activity tabs | ✓ | ✓ (Phase D, #362) | crow's desktop split view is the one pi-lab lacks |
| Open a session in any directory | — | ✓ (open-anywhere, #360/#362) | **crow-only**: server-backed picker + persisted `cwd` + wake-in-place; pi-lab sessions are born in their server's cwd |
| Model switching | sheet, local-run dots ●/○, vision 👁, "will start server" | select, availability annotations ("not running"/"starts on demand"), persisted explicit choice, fail-open at wake | crow's row-provenance + dead-provider rails (#357) go beyond pi-lab |
| Permission modes | ask / accept-edits / auto / bypass (+ classifier picker) | guarded / ask / bypass | **DIVERGENT BY DESIGN** — crow's vocabulary is engine-owned (`PERMISSION_MODES`) and enforced by pi-lab's permission-gating through `PI_BOT_PERMISSION_POLICY`; the auto-mode classifier has no crow analogue yet |
| Plan mode | on/off + planning-model sheet | checkbox control + plan_state notes | partial — see gaps 11–13 |
| Ask cards (ask_user) | combined multi-question card: headers, label+description options, multi-select, "Other…", one submit, answered state | sequential native cards: select/input/confirm/editor via `ctx.ui` relay, "Other…" fallback | tool now unlocked for perch spawns (this PR); **richness gap** = item 5 below |
| Working indicator | "pi is working…" + bird color + per-tool spinners | gear strip on chat tab (this PR) | per-tool spinners = item 4 below |
| Activity log | tool start/end rows, newest-first, capped 150, error-colored | timestamped rail (log/tool/error/plan_state), ascending, uncapped per session | minor formatting divergence |
| Image attach | thumbnails pre-send, removable chips | upload-now + queue onto next send | parity in effect; pi-lab's pre-send chips are nicer (item 8) |
| Rename / close | rename + archive | rename + close (terminal) | archive = item 14 |
| SSE keepalive | server data-ping every 15s | server `: keepalive` comment every 30s (`streams/sse.js`) | parity |
| Reconnect | fixed 3s retry + wake signals + watchdog | unbounded exponential backoff 2→30s, unlock retry, terminal probe (#364) | crow now ahead on backoff; pi-lab ahead on resync/watchdog — items 19–21 |
| Safe-area insets, dark mode, thumb floors | ✓ | ✓ | crow measures thumb targets in CDP tests; pi-lab doesn't |
| Tool governance | per-project `.mcp.json` toggles live in the Session tab | Bot Builder envelope (single writer) + per-session narrowing in the board card drawer | **DIVERGENT BY DESIGN**; hub-side surface = item 15 |

## 2. Tool audit

pi's tool surface for a bot = built-ins + pi-lab extension tools + MCP, filtered by the always-pinned `--tools` csv (`toolAllowlist` = `def.tools.pi_builtin` + `def.tools.crow_mcp` + conditional appends).

| Tool | Source | Offered to crow bots? | Status |
|---|---|---|---|
| read, edit, write, bash, list, glob, grep | pi built-ins | ✓ `PI_BUILTIN` catalog | parity |
| todo | pi-lab `todo.ts` | ✓ extension checkbox (`PI_EXT_ALLOWLIST`) | parity |
| plan-mode | pi-lab `plan-mode/` | ✓ extension checkbox | parity |
| subagent | pi-lab `subagent/` | ✓ extension checkbox + `multi_agent` policy + capability gate; name appended by the bridge | parity |
| **ask_user** | pi-lab `ask-user.ts` (registers ONLY under `PI_BOT_INTERACTIVE=1`) | **was missing** — `--tools` filtered it even on perch spawns | **FIXED this PR**: appended for interactive spawns exactly where the extension registers it; narrowing can remove it; channel csvs byte-identical (goldens pin it) |
| send_user_file | pi harness/web surface; pi-lab's mobile.ts serves the files as inline cards | ✗ not in crow's catalog; no engine relay for agent-sent files | **investigate** (item 12): needs an SSE frame + a serving route; crow's Files tab covers the download half |
| MCP tools (crow servers, addons, remote peers) | mcp.json per instance | ✓ `crow_mcp` picker + remote capability gate | parity (crow's is richer: instance-bound, journal-guarded) |

## 3. Gaps — pi-lab has, crow lacks

Sized S/M/L; ⚠ = needs an operator decision before building.

**Chat ergonomics**
1. **S** — Enter sends / Shift+Enter newline (desktop composer).
2. **S** — Auto-growing composer textarea (crow: fixed 72px min-height).
3. **S** — Copy buttons: per message + per code fence (one-tap, ✓ flash, execCommand fallback).
4. **M** — Inline tool chips in chat: running spinner per tool call, tap to expand args + result (result truncated ~2k). Requires the engine to relay tool args/results over SSE (frames today carry name+phase only).
5. **M** — Combined multi-question ask card: the extension's native shape is a `questions[]` array (up to 4, headers, descriptions, multi-select, one submit). Crow's relay walks `ctx.ui` dialogs one at a time, so a 4-question ask_user arrives as up to 4 sequential cards and multi-select degrades into a toggle-loop selector. True parity = a `questions`-shaped card in `cardFrom`/`renderAsk` (engine + hub), which the extension's `pi-lab:ask-user` event already carries verbatim.
6. **M** — Slash-command menu: typing `/` opens a live-filtered command list (`/chat/commands` equivalent for the bot's pi). 
7. **S** — Attention banner above the chat when a card is waiting ("Session is waiting on a prompt — answer the question card").
8. **S** — Non-image uploads: pi-lab lands them on disk and injects "I uploaded files: `<paths>`" into the message; crow uploads to uploadsDir but never tells the bot the path — a non-image attach is currently near-dead.

**Session insight (Session tab)**
9. **M** — Context meter: % + tokens/window (`getSessionStats` already flows through the engine for metering — surface it on the state frame or options).
10. **S** — Agent card facts: uptime, child RSS, tool count.
11. **M** — Plan progress: bar + step checklist (☑/▶/☐) from the plan_state todos array (the frame already carries it; the client prints one line).
12. **L ⚠** — send_user_file parity: agent-sent file cards inline in chat (images inline, View/Download, caption). Needs tool availability research + an engine relay + a serving route under the existing jail discipline.
13. **S** — Model-start lifecycle lines: "loading X…", "freeing RAM: Y shutting down", "now on X", start-failed. Crow's Activity rail has the warm lines; the *pending* state (a cold local model can take minutes) is invisible.

**Session management**
14. **S ⚠** — Archive: hide a session from the list without stopping it. Crow's list is live-sessions-only by design; archive presumes a session roster. Decide whether crow wants that.
15. **M ⚠** — Envelope/narrowing surface in the hub: today the per-session tool narrowing pane lives in the board's card drawer (`panels/bot-board/drawer.js`), so hub-only sessions have no narrowing UI. (The operator guide claimed otherwise — corrected alongside this audit.) pi-lab additionally toggles MCP servers live per project; crow's single-writer model says Bot Builder owns grants, narrowing owns removals — a hub Session-tab narrowing pane would match that model.
16. **— N/A** — Quick actions (/critique, /critique frontier, /todos buttons): pi-lab-specific extensions; crow bots get skills through Bot Builder instead.
17. **— N/A** — Executor/agent-leg model rebinding: belongs to pi-lab's plan-execution machine; crow's plan mode doesn't spawn legs with bound models.

**Files**
18. **M ⚠** — Full cwd browse + in-app text viewer vs crow's outputs-only jail. Crow's download route is fd-based `O_NOFOLLOW`-jailed to outputsDir *by deliberate hardening* (final-review C2). Open-anywhere changed the premise — the operator now chooses the cwd — so a read-only browse of the SESSION'S cwd (reusing `/browse` + a realpath-under-cwd read jail) is defensible, but it is a security-posture decision, not a port.

**Stream robustness**
19. **S** — Resync on reconnect: pi-lab reloads history + status on every `connected` frame. Crow replays only the state frame + pending card, so messages that completed during a drop are missing from the live view until a manual reload. (This is the one gap with a correctness edge, not just cosmetics.)
20. **S** — Stale-ping watchdog: if no event (including keepalives) arrives for ~40s while the tab is visible, reconnect — catches zombie sockets no error event ever fires for.
21. **S** — Wake signals: crow has visibilitychange (#364) + focus; pi-lab also revives on `pageshow` and `online`.

**Shell**
22. **L ⚠** — PWA: pi-lab's mobile page is installable (manifest + service worker + standalone). Crow's hub lives inside the dashboard; making the DASHBOARD installable is a shell-level decision (CSP, SW scope, auth) well beyond perch.

## 4. Suggested waves (if the operator greenlights parity work)

- **Wave 1 — quick wins, no engine changes:** 1, 2, 3, 7, 8, 19, 20, 21 (+13's log lines are engine-side but trivial).
- **Wave 2 — session insight:** 9, 10, 11 (all read from frames/RPC that already exist).
- **Wave 3 — deeper ports:** 4 (tool args/results relay), 5 (combined ask card), 6 (slash menu).
- **Decisions first:** 12 (send_user_file), 14 (archive), 15 (hub narrowing pane), 18 (cwd browsing posture), 22 (PWA).

## 5. Corrections shipped alongside this audit

- `docs/guide/bot-builder.md` (EN+ES) step 4 said "Open **Envelope & tools** for the session" as if the hub had it — the narrowing pane lives in the board's card drawer. Fixed to say so.

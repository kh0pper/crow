# Perch Hub: open-anywhere + tab surface (combined plan)

> **NEXT SESSION — START HERE.** This is the active, operator-approved plan for the Perch Hub
> integration work of 2026-09-11 (Session 64 continuation, crow repo). Read this file top to
> bottom; it is self-contained — its "Operator decisions" + "Architecture" sections replace any
> conversation context. Related artifacts, in reading order:
> 1. This plan: `docs/superpowers/plans/2026-09-11-perch-hub-open-anywhere.md`
> 2. The review it implements Phase A from: `docs/reviews/2026-09-11-perch-pr356-review-completion.md`
> 3. The surface spec it slots under: `docs/superpowers/specs/2026-09-09-perch-hub-design.md`
> Execution state: **ALL PHASES SHIPPED.** Phase A
> (A1–A4) merged to `main` (PR #357). Phase B (B1–B4) + C1 shipped as PR2
> (#360, full suite 4686/0 green). **C2 + Phase D + Phase E** shipped as PR3
> (branch `feat/perch-open-anywhere-pr3`): the launcher directory picker, the
> Chat/Session/Files/Activity tabs, the Files-tab outputs endpoint, the full
> `npm test` suite (4717/0), and the mandated live walk on a real gateway +
> real local model (spawn-in-chosen-dir → file write → MCP tool call through
> the relocated `.mcp.json` → model switch → gateway restart → adopt on the
> switched model in the chosen dir → provider-disable fail-open → mid-turn cwd
> refusal / idle accept) plus CDP render checks at 412×730 and 1280×900.
> Resume brief (PR2): `docs/superpowers/handoffs/2026-09-12-perch-open-anywhere-pr2-shipped.md`.
> Record any named deviation in the "Risk notes" section's spirit: measured, not
> asserted. PR shape: PR 1 = Phase A (DONE #357), PR 2 = B+C1 (DONE #360), PR 3 = C2+D+E (DONE).
>
> **Named deviations (PR3), measured not asserted:** (1) The plan's E1 said
> "switch model while hibernating"; the live walk switched while AWAKE (the
> stronger `set_model`-the-live-child path) and proved the hibernate-bind path
> separately via the cwd-change leg (which hibernates) + the restart-adopt leg;
> the model `bindsAtWake` path stays covered by `perch-interactive-controls.test.js`.
> (2) The scratch gateway's local model server (`qwen3.6-35b-a3b`) is a REASONING
> model that spends its token budget on `reasoning_content`; a session recycled
> 5× through repeated wakes eventually returned a dead pi child (`pi_gone`) with
> degenerate output. A FRESH session on the same gateway wrote its file and
> replied cleanly — environmental (model-server fatigue), not a PR3 regression.
> (3) `docs/architecture/gateway-server.md` does not exist; the perch-interactive
> architecture note landed in `docs/developers/bot-engine.md`'s "Long-lived
> (interactive) children" section (its existing home) and the operator walkthrough
> in `docs/guide/bot-builder.md`.

**Status:** approved by operator 2026-09-11 (four decisions captured below)
**Supersedes:** the directory-containment decisions of the M3 project-native workspace model *for Perch sessions*, and completes the outstanding review of PR #356 → `docs/reviews/2026-09-11-perch-pr356-review-completion.md` (findings R1, R2, R4-adjacent become Phase A).
**Companion spec:** `docs/superpowers/specs/2026-09-09-perch-hub-design.md` (surface model, mobile rules, and API map there all still hold).

> **Execute on current `main` (≥ `85feb555`). Line numbers below cite that state — re-grep the quoted string before editing; trust the string, not the number.**

## Operator decisions (load-bearing)

1. **Abandon structural containment.** Crow bots in Perch Hub open in **any directory** on this host, chosen through a **clickable browse picker** (server-backed directory listing). The barrier between the Region-4 crow bots and personal bots is the per-instance project MCP/tools (`~/r4-tehcy` runs as its own crow instance), *not* directory jailing on this device. Applies to **all** sessions, card-bound included.
2. **The chosen directory is writable** — added to the child's `write_paths` at spawn so the bot can do real work there, like bare pi did. Permission modes (guarded/ask/bypass), `--no-approve`, and spawn_env hygiene are unchanged.
3. **R1/R2 wake fixes ship inside this plan**, as the first phase.
4. **Tabs** (Chat / Session / Files / Activity, like the original pi-lab hub) are ported into the crow hub **keeping crow's visual aesthetic**, and the layout must work at phone width AND in the ≥900px split view (crow port is currently better on desktop; the original's tabs are better on mobile — this plan keeps both halves).

## Architecture (the shape, with rationale)

**Split "cwd" from "world root".** Today one value (`world.sessionDir`, derived from `projectSpace.workspace_dir + "/bots/<botId>"` or `def.session_dir`) serves as: pi's process cwd, the pi session-file store (`sessionDir/sessions`), the per-bot `.mcp.json` home, and the parent of `outputs/<sid>` and `.pi/uploads/<sid>` (`scripts/pi-bots/bot-world.mjs:86-103`, `servers/gateway/perch-interactive.js:1196-1205`, `scripts/pi-bots/bridge.mjs:276` `spawn(..., { cwd: sessionDir, ... })`). After this change:

- **`cwd`** — operator's choice, persisted per session in a new `bot_sessions.cwd` column; falls back to today's sessionDir resolution when unset; used as pi's process cwd **and** as the directory added to `write_paths`, **and** as where `.mcp.json` lives (pi-lab's mcp-client reads `cwd/.mcp.json` — bridge.mjs's own comment at ~:165 confirms cwd is where the extension looks, so an arbitrary cwd without relocating `.mcp.json` would silently strip every bot of its MCP tools). Writing `.mcp.json` into the chosen dir is pi's native pattern and `writeBotMcp` is already an additive merge, so a dir that carries its own `.mcp.json` survives.
- **world root** — `sessionDir` stays as the *storage* root: pi session files, `outputs/<sid>`, uploads. A session's deliverables never litter the chosen directory, and the existing outputs-download jail (`tests/perch-workspace-jail.test.js`) is untouched.
- **no configured dir anywhere** → world root falls back to `join(crowHome, "pi-bots", botId)` (mkdir) instead of the `no_session_dir` throw (`bot-world.mjs:97-102`), which is deleted. cwd then defaults to the world root. Other-channel callers (gmail/discord bridge, job_runner) keep the existing resolution order; only the throw becomes a fallback.

**Mid-session cwd change:** `control({cwd})` persists it and hibernates the live child with a visible `log` frame — the next message wakes in the new directory. Never a live chdir (pi's child process cwd is fixed at spawn).

**Browse endpoint security:** `GET /dashboard/perch-api/browse?path=` — directory *names* only (plus `parent`), never file contents; behind the same `dashboardAuth` as every perch-api route; not added to `PUBLIC_FUNNEL_PREFIXES` (invariant: private routes never funnel-reachable). The dashboard operator is the machine owner — this is a picker, not a trust boundary.

**Do-not-do list (all retired by prior decisions — do not resurrect):**
- Do **not** restore the old bundle's tmux spawner (`/api/hub/spawn`), its on-disk pi-session list, or its per-session web-server reverse proxy (`docs/reviews` + deletion `42f39160`; the 2026-09-09 spec retired them by design).
- Do **not** make `/perch` its own document again — it lives inside the dashboard shell (PR #352 nav decision). Tabs live inside the shell.
- Do **not** create a second chat surface; the drawer is gone and stays gone.
- Do **not** add a new host port (would fail `check-ports` against `docs/developers/port-allocation.md`).
- Do **not** bump bundle manifests — everything here is core gateway code.
- Do **not** touch `PUBLIC_FUNNEL_PREFIXES` or `isAllowedNetwork()` allow-lists.

**Test inventory (what exists to update):** `tests/perch-hub-client.test.js` (client-script unit harness), `perch-hub-page.test.js` (markup), `perch-hub-render.test.js` (markdown/sanitize), `perch-hub-stream-leak.test.js` (Turbo instance leaks, live reconnects), `perch-interactive.test.js` (engine core), `perch-interactive-controls.test.js` (control/options/wake/turnId), `perch-interactive-routes.test.js` (the 77 API cases), `perch-interactive-dispatch.test.js` (card dispatch spawn), `perch-interactive-capacity.test.js`, `perch-interactive-statebridge.test.js`, `perch-model-catalog(-warm).test.js`, `perch-narrowing.test.js`, `perch-routes.test.js`, `perch-workspace-jail.test.js`, `perch-retirement.test.js`, `board-lock-perch-live.test.js`, `bot-board-perch-link.test.js`, `init-db-bot-tables.test.js`, `i18n-global-parity.test.js`, `auth-network.test.js`.

**Commit discipline (repo rule):** always `git commit <path> -m "..."` with positional paths; `git pull --rebase` before pushing.

---

## Phase A — PR #356 wake-path fixes (R1, R2, +R4-adjacent)

### Step A1 — R1: give `writeModel` sole authority over the row's `model`

**Files:** `servers/gateway/perch-interactive.js`
**Do:**
- Remove the `model:` argument from the three automatic stamps so `writeRow`'s `model=COALESCE(?, model)` passes NULL through and the column keeps only explicit choices. **Do NOT also touch `writeRow` itself**: its parameter is a destructured object (`async function writeRow(s, { status, piSessionDir = null, model = null }, control = "run")`), so an omitted `model:` arrives as `null` — the UPDATE's COALESCE preserves the existing column value and the INSERT mints NULL. Placeholder counts are unchanged. (A review round claimed this breaks the INSERT arg count; it does not — verified 2026-09-11 against `perch-interactive.js:676-711`. Do not "fix" a non-issue.)
  - `startChild`'s stamp — `writeRow(s, { status: "active", ..., model: prep.resolved.key })` (search `piSessionDir: world.sessionDir + "/sessions"`)
  - `onTurnEnd` — search `"status: \"waiting-user\", model: s.resolved ? s.resolved.key : null"` (there are two identical tails; fix both — the turn-end write and the active-spawn write near `spawn()`'s `"status": "active"`)
- In `onModelSelect` (search `function onModelSelect`), after it assigns `s.currentModelParts`/`s.currentModel` for a *changed* value, call `writeModel(s)` so a `/model` typed in the TUI is also an operator choice that survives restart.
- **Early-event belt (second review round C2):** `writeModel` returns silently when `s.rowId == null`, and a child's first `model_select` CAN land after `new PiRpc(...)` but before `startChild`'s `await writeRow(...)` resolves — a switch during that window would never be retried (every later `writeRow` COALESCE-preserves, it does not re-write from tracking). Fix: at the tail of `startChild`, just before the final `if (s.pi !== pi) return pi;` bail (search `if (s.pi !== pi) return pi;`), add `if (s.currentModelParts && servingModel(s) !== prep.resolved.key) await writeModel(s);` — a no-op unless the window actually fired. New test: stub child emits `model_select` before the row write completes; after spawn, the row carries the switched model.
- **Legacy-row escape hatch:** every pre-A1 row already carries an auto-stamped `model` that `adoptRow` will honor — cleansing them is wrong (each value WAS the serving model at stamp time; a bulk NULL would silently move live sessions back to the def default on next wake). Instead make the choice revocable: `control()` accepts `model: { provider: null, modelId: null }` (the drawer's existing "the bot's own model" option, which today only skips the launch-time switch) meaning *clear the explicit choice* — set `s.currentModelParts = null` / `s.currentModel = null` and have `writeModel` write NULL (drop its implicit reliance on `servingModel(s)` being non-null; make it `servingModel(s)`-or-null explicitly). Next wake then re-resolves from the def, and the picker shows the def's current model as a plain non-user value. Tests: clear-then-adopt serves the def default; clear persists NULL to the row.
- Grep consumers of the row's `model` column to confirm nothing displays it directly: `grep -rn "bot_sessions" servers/gateway/routes/perch.js servers/gateway/dashboard | grep model` — if the roost strip reads `row.model` for a session the engine no longer holds, leave it (NULL reads as "no explicit choice", same as today for non-perch rows).
**Verify:** `npm test -- tests/perch-interactive-controls.test.js` — the three N2 tests must stay green (they set the model via control()). Add one new test in the same file: *spawn a session on the def default without any switch, re-stamp rows by running a turn, then adopt with a fresh engine and assert `snapshot().model` equals the def default* **after changing the def default between adopt and wake** — i.e. the pin scenario from the review: def default A → row stamped A → def changed to B → fresh engine → `message()` serves **B** when the row never had an explicit choice. Run it red before making it green by deleting the stamps.
**Commit:** `Perch: the row's model column means an explicit choice, nothing else`

### Step A2 — R2a: validate the model pair at `control()` time

**Files:** `servers/gateway/perch-interactive.js`, `servers/gateway/routes/perch-interactive-api.js`
**Do:**
- `control()`'s `hasModel` branch (search `if (hasModel && (!opts.model.provider`): after the truthiness check, validate `{provider, modelId}` against the session-free catalogue — import `providerModelListWarm` + `modelKey` from `./perch-model-catalog.js` (it is already a gateway-shared module; engine module keeps seams injectable: take the catalogue through `loadSeams()`/an `opts.catalogProvider` test seam so tests don't read the real DB).
- Unknown pair → `throw engineError("bad_request")` (already mapped in routes; message-level detail is not part of the error contract).
- This makes the persisted poison pill un-plantable through the API.
**Verify:** `npm test -- tests/perch-interactive-controls.test.js tests/perch-interactive-routes.test.js`; add a test: control() with `{provider:"ghost",model:"nope"}` → `bad_request`, row untouched.
**Commit:** `Perch: control() refuses a model the instance cannot serve, before persisting it`

### Step A3 — R2b: fail-open at wake when a recorded model died after it was chosen

**Files:** `servers/gateway/perch-interactive.js`
**Do:** in `startChild`'s override block (search `if (s.currentModelParts &&`), before applying the override, check `s.currentModel` against the injected catalogue (`providerModelListWarm()` — via the same seam as A2; on a catalogue fetch failure treat the recorded model as valid — fail-open toward the operator's choice, never lock out a session because the registry is unreadable). If the key is absent: clear `s.currentModelParts`/`s.currentModel` **in memory only** (keep the row — a temporarily disabled provider must not erase a real choice, per the review), let `prep.resolved` stand (fresh def resolution), and `emit(s, { type: "log", text: "row model <key> is not available — resumed on <prep.resolved.key>" })` so the drawer/Activity rail states the truth instead of parking on "pi exited unexpectedly".
**Verify:** `npm test -- tests/perch-interactive-controls.test.js`; new test drives the review's exact scenario: adopted session whose row names a well-formed, disabled provider → wake serves the fresh def resolution, a `log` frame with `not available` reaches a subscriber, row's `model` still holds the old key. Then run the full Phase-A mutation matrix from `docs/reviews/2026-09-11-perch-pr356-review-completion.md` §"Verification checklist" items 1–2 (five named mutations, each restored alone → its named test reds), restoring each.
**Commit:** `Perch: a dead recorded model falls open at wake, in the log, not the crash`

### Step A4 — R4-adjacent: stop the duplicate bubble at the openStream/loadHistory seam

**Files:** `servers/gateway/dashboard/perch-hub/client.js`
**Do:** keep the current subscribe-before-history order (it is the no-loss guarantee — see the 2026-09-09 spec §Chat view; reversing it trades a duplicate for a lost reply). Deduplicate instead: `appendMessage` for a bot entry skips when the transcript's last entry has the identical text (compare the raw `what` string, last 1 entry is sufficient — the race window is one message). Comment it as the sequence-guard, naming the race (frame lands between subscribe and the transcript fetch resolving).
**Verify:** `npm test -- tests/perch-hub-client.test.js tests/perch-hub-stream-leak.test.js`; add a unit-harness test: open a session, fire a `text` frame, then resolve a transcript fetch containing that message — assert one entry.
**Commit:** `Perch: a message that lands between subscribe and history renders once`

---

## Phase B — cwd plumbing (schema → world → engine)

### Step B1 — Schema: `bot_sessions.cwd`

**Files:** `scripts/init-db.js`, `tests/init-db-bot-tables.test.js`
**Do:**
- Add `cwd TEXT,` to the `CREATE TABLE IF NOT EXISTS bot_sessions` body (after `model TEXT,`).
- Add `await addColumnIfMissing("bot_sessions", "cwd", "TEXT");` beside the `label` one (search `addColumnIfMissing("bot_sessions", "label"`). Follow the same comment idiom — **additive-only, NO `SCHEMA_GENERATION` bump** (precedent: `kind`/`narrowed_tools`/`label`, and the explicit note at ~:2585 "additive-only, no SCHEMA_GENERATION bump"). The manual migration rail is therefore not required; say so in the commit body so nobody second-guesses it.
- **The dedicated `bot_sessions` control-CHECK rebuild block (~:2658-2790) is the trap.** It diffs `PRAGMA table_info(bot_sessions)` against a canonical column list (I13, ~:2688) and rebuilds `bot_sessions_new` (~:2750) with an explicit `colList` carried across ("schema drift from the canonical shape" throws at ~:2726). Add `cwd` to **all three**: the `bot_sessions_new` CREATE body, the canonical shape list I13 diffs against, and (implicitly) the carried `colList` derived from them. If the drift check is not updated, a host that still needs the CHECK migration will hard-throw at boot — this exact class of green-suite-broken-migration is why it is spelled out.
- Also check `rebuildMainFKsToProjectSpaces` (~:775): if it enumerates `bot_sessions` columns anywhere, carry `cwd` there too (its unknown-column guard at ~:919 fails loudly).
**Verify:** `npm test -- tests/init-db-bot-tables.test.js` (extend it with the new column, same assertions as `label`, PLUS a drift-case: a DB built with the OLD shape that then runs the CHECK-migration rebuild must come out carrying `cwd`). `grep -n "cwd" scripts/init-db.js` should show every site listed above.
**Commit:** `Schema: bot_sessions.cwd — the operator's chosen working directory, per session`

### Step B2 — `buildBotWorld`: accept `cwd`, relocate `.mcp.json`, fallback replaces the refusal

**Files:** `scripts/pi-bots/bot-world.mjs`
**Do:**
- Signature becomes `buildBotWorld({ botId, threadId, gatewayType = "perch", log = () => {}, jobId = null, cardBound = false, cwd = null })`. `sessionDir` (world root) resolution is UNCHANGED except: when it would be falsy (no project space, no `def.session_dir`), fall back to `join(crowHome, "pi-bots", botId)` instead of throwing `no_session_dir` — delete the throw block (search `bot has no working directory`).
- `const resolvedCwd = cwd || sessionDir`. Validate: absolute path, exists, `statSync(...).isDirectory()` — on failure throw `engineError`-shaped `{ code: "bad_cwd" }` (the gateway route maps it; the engine never gets here with junk — the route validates first, belt-and-braces).
- **Edit the `writeBotMcp` call site INSIDE `buildBotWorld`'s own body** (search `writeBotMcp(def, {` — bot-world.mjs ~:125), changing its `sessionDir` option from the world-root `sessionDir` to `resolvedCwd`. The `.mcp.json` must sit where pi runs — mcp-client reads `cwd/.mcp.json` (bridge.mjs comment ~:165). Changing only a caller accomplishes nothing.
- Keep `mkdirSync(sessionDir + "/sessions", ...)` keyed on the WORLD root, unconditional; do NOT create `sessions/` inside the operator's project directory.
- `selfAuthoringDir` (prepareSpawn ~:194) stays keyed on `def.session_dir` BY DESIGN — the Bot Builder review UI scans that location; a perch session whose cwd moved elsewhere does not move the staging dir. Add a one-line comment saying so (review Q1).
- Return object gains `cwd: resolvedCwd` alongside `sessionDir`.
**Verify:** `npm test -- tests/bot-world.test.js tests/perch-workspace-jail.test.js` (jail unchanged — outputsDir still under world root). New tests in `bot-world.test.js`: (1) `cwd` honored and returned; (2) no project/no session_dir bot falls back to `<crowHome>/pi-bots/<botId>` instead of throwing; (3) `.mcp.json` written at `cwd`, not at world root, when they differ; (4) `sessions/` dir created under world root when cwd differs (assert no `sessions/` minted inside the chosen dir). Golden guard: callers that pass no `cwd` produce byte-identical opts (extend the existing golden assertions).
**Commit:** `Perch world: cwd separated from the world root; no_session_dir becomes a fallback`

### Step B3 — `PiRpc`: spawn cwd option

**Files:** `scripts/pi-bots/bridge.mjs`
**Do:** in the constructor, `const spawnCwd = opts.cwd || sessionDir;` and use it in the `spawn(nodeBin, args, { cwd: spawnCwd, env, ... })` call (~:276). The value arrives as `opts.cwd` through the opts bag `startChild` builds — `new S.PiRpc(Object.assign({}, prep.piRpcOpts, { cwd: world.cwd, piSessionId: resume, ... }))` — `prepareSpawn`'s own `piRpcOpts` stays cwd-free so every channel caller (bridge handleInbound, job_runner) is byte-identical (B2's default `cwd = null` makes `world.cwd === sessionDir` there, so even if it were passed it would be a no-op — but do not pass it from prepareSpawn; the split belongs to the interactive caller). Everything else — `--session-dir sessionDir + "/sessions"`, `--no-approve`, policy — unchanged.
**Verify:** `npm test -- tests/perch-interactive-controls.test.js tests/bot-world.test.js` (the stub PiRpc in the test seams records opts; assert `spawnCwd`). Add a stub-level assertion in the interactive controls harness: a session with cwd gets `spawn` invoked with that cwd and `--session-dir` still pointing at the world root.
**Commit:** `Perch: pi runs where the operator chose, sessions still land in the world root`

### Step B4 — Engine: `s.cwd` through spawn / wake / adopt / control

**Files:** `servers/gateway/perch-interactive.js`
**Do:**
- `newSession()` gains `cwd: null`.
- `spawn({ botId, cardId = null, cwd = null })` stores `s.cwd = cwd` before `startChild`.
- `startChild` passes `cwd: s.cwd` into `buildWorldSerialized` (into `buildBotWorld`'s new param) and `cwd: world.cwd` into the PiRpc opts; after the fresh world build, set `s.cwd = world.cwd` (so snapshot reports the truth even for the default).
- `writeRow`: add `cwd` to the UPDATE as `cwd=COALESCE(?, cwd)` and to the INSERT column list, argued in a comment exactly as `card_id`'s is — the engine owns its row; the stamp carries the chosen dir at every write.
- `adoptRow`: SELECT gains `cwd` → `s.cwd = row.cwd || null`.
- `snapshot()` and `stateEvent()` gain `cwd: s.cwd || null` (drawer + Files/Session tab read it).
- `control()` gains `hasCwd` (search the `hasModel` gate block): validated like the model — non-empty string, absolute, exists, is a directory (the seams already import fs? then validate there; else map failures to `bad_request`); `if (hasCwd && s.turn) throw engineError("turn_in_progress")`. On accept: set `s.cwd`, `await writeRow`-free persist via a targeted `writeCwd(s)` UPDATE by row id (copy `writeModel`'s shape and its docstring rationale — no status restamp), then if `s.pi`: `await hibernate(s)` with reason, and `emit(s, { type: "log", text: "working directory → <dir> — resumes there on the next message" })`. `bindsAtWake.cwd = dir`.
**Verify:** `npm test -- tests/perch-interactive.test.js tests/perch-interactive-controls.test.js tests/perch-interactive-dispatch.test.js tests/perch-interactive-capacity.test.js`. New tests: spawn-with-cwd wakes with the same cwd after simulated restart (fresh engine over the same row); control({cwd}) while hibernating binds at next wake; control({cwd}) mid-turn refused; relative path refused `bad_request`.
**Commit:** `Perch: cwd is a session property — spawn, wake, adopt, control`

---

## Phase C — browse API + launcher picker

### Step C1 — Browse endpoint + route validation

**Files:** `servers/gateway/routes/perch-interactive-api.js`
**Do:**
- `GET P + "/browse"`: `const p = String(req.query.path || homedir())`; expand leading `~`; `path.resolve`; must be absolute; `readdirSync(p, { withFileTypes: true })` inside a try/catch → `{ error: "unreadable" }` 404; filter to `d.isDirectory()` (follow symlinks via `d.name` join + `statSync` try/catch; a symlink that errors or lands on a file is skipped); dot-dirs kept but sorted last; cap 500 entries; respond `{ path: realpath, parent, dirs: [{ name, path }] }` — **names and paths only, never contents, never file entries**. `parent` is derived from the RESOLVED realpath (not the raw input) so `..` navigation from a symlinked dir does not ping-pong.
- `POST P + "/bots/:id/interactive"`: accept `{ cwd }` from the body; when present validate the same way (`fs.existsSync` + `statSync().isDirectory()` + absolute) and pass to `eng.spawn({ botId, cwd })`; invalid → 400 `{error:"bad_cwd"}`. Add `bad_cwd: [400, "bad_cwd"]` to the error map (search `no_session_dir: [409`).
- Route stays under the existing `dashboardAuth`-mounted perch-api umbrella — no new mount point, no funnel change.
**Verify:** `npm test -- tests/perch-interactive-routes.test.js tests/auth-network.test.js`. New tests: browse on a temp tree returns only dirs, dot-dirs last, traversal through `..` in the query collapses harmlessly via `resolve`, unreadable dir → 404 shape; spawn with a real temp cwd succeeds and `snapshot().cwd` reports it; spawn with `/nonexistent` → 400.

### Step C2 — Launcher: directory field + picker modal

**Files:** `servers/gateway/dashboard/perch-hub/html.js`, `client.js`, `css.js`, `servers/gateway/dashboard/shared/i18n.js`
**Do:**
- Launch row (search `id="perch-new"` in `html.js`): add a `#perch-new-cwd` text input (placeholder = t("perch.cwdPlaceholder")) + a `#perch-browse-btn` button beside the model select, all inside the existing flex field row; empty field = "the bot's default" (never send `cwd`).
- `client.js`: `startSession()` reads the field; sends `cwd` only when non-empty. Picker: modal overlay listing `/browse` results — header shows the current path, `..` row for `parent`, tap a dir → navigate; an "Choose" button writes the path into `#perch-new-cwd` and closes. **Explicit Escape handler + a visible "Cancel" button** (dismiss must not depend on either alone); register the listener through the hub's generation-checked registry so the Turbo-leak guard covers it. All buttons carry visible labels (house rule: no unlabelled controls).
- `css.js`: modal inherits the hub's tokens; full-bleed at phone width; `max-width:min(560px, 92vw)` desktop.
- i18n: EN+ES keys in `shared/i18n.js` perch block (`perch.cwdLabel`, `perch.cwdPlaceholder`, `perch.browse`, `perch.choose`, `perch.browseFailed`, `perch.cwdDefaultNote`) — the parity test fails loudly on one-sided keys.
**Verify:** `npm test -- tests/perch-hub-client.test.js tests/perch-hub-page.test.js tests/i18n-global-parity.test.js`. Live check over CDP (headless chrome on the gateway): open `/dashboard/perch`, browse from `$HOME` two levels, choose, start a session, `snapshot().cwd` reflects it. (Remember the standing rule: `Page.bringToFront` before driving anything over CDP.)

---

## Phase D — tab surface (Chat / Session / Files / Activity)

### Step D1 — Markup + layout skeleton

**Files:** `servers/gateway/dashboard/perch-hub/html.js`, `css.js`
**Do:** inside `#perch-chat`, below the head block, insert `<nav id="perch-tabs" role="tablist">` with four buttons (data-tab `chat|session|files|activity`; inline SVG glyphs ported from the original's `I` icon set in `~/pi-lab/extensions/web/public/app.html` lines ~250-254 — recolor via `currentColor` so crow's teal owns them) and four `<section id="perch-tab-<name>">` wrappers: chat keeps `#perch-transcript` + `#perch-ask` + composer; session gets the existing controls row + rename/state/close moved in; files gets `#perch-files-list`; activity gets `#perch-activity-list`. Desktop (≥`PERCH_SPLIT_MIN_WIDTH`): tabs as a top strip in the right pane; phone: fixed bottom tab bar — composer sits ABOVE it inside the chat tab (flex chain untouched: keep `#perch-chat{flex:1;min-height:0}` and the transcript as the only scroller; the tab bar joins the chain as a non-shrinking sibling). Only the active tab section is displayed; composer visibility: chat tab only (sending from other tabs stays possible via a note? No — keep composer on `chat` only; ask cards remain chat-scoped).
**Verify:** `npm test -- tests/perch-hub-page.test.js`. CDP measurements at 412x730 and 1280x900: Send reachable (`getBoundingClientRect().bottom <= innerHeight`) with the transcript scrolled to top, on the chat tab, in every tab actually — assert the tab bar itself never overlaps it.

### Step D2 — Client routing + Activity + Session tab content

**Files:** `servers/gateway/dashboard/perch-hub/client.js`, `shared/i18n.js`
**Do:**
- Tab state: a plain `var tab='chat'` re-evaluated per session open (reset to chat in the session-switch block that already clears `renderedTurn`); `#perch-tabs` click handlers toggle `hidden` on the sections. **Tab switching is pure visibility toggling — it must never touch the EventSource, `openStream`, `closeSession`, or any SSE lifecycle** (the stream belongs to the session, not the tab). Note: there is no session drawer to move controls out of — it was deleted in the 2026-09-09 plan's Phase 2; "move" below means the chat view's own controls row within this page. Deliberately NOT in the hash (the hash is the session router; `#<sid>:<tab>` would fight deep links — note this).
- Activity: route `log`, `tool`-start, note/`error` frames (everything `appendNote` writes today) to `#perch-activity-list` instead of the transcript; chat keeps only user/bot messages, ask cards, and hard failures (transcript-load failure stays in chat — the operator must see it where they read). Port the drawer's `[tool: name]` formatting.
- Session tab: move model/thinking/permission/plan controls, session state pill, rename and close into it, plus the read-only cwd display with a "Change directory" button that reopens the browse modal and POSTs `control({cwd})` (note in the modal: "the session wakes in the new directory; the next message starts a fresh pi context there" — the hibernate-on-change is visible).
- `snapshot().cwd`/state frames refresh the Session tab fields; the existing `servingModel` sync code (`bd.setPicker`) keeps running unchanged.
**Verify:** `npm test -- tests/perch-hub-client.test.js tests/perch-hub-stream-leak.test.js` (extend: tool frame lands in activity list only; session switch resets tab to chat; the 6x-leak guard still passes for the new listeners — everything registered goes through the existing generation-checked registry).

### Step D3 — Files tab: outputs list endpoint + UI

**Files:** `servers/gateway/routes/perch-interactive-api.js`, `perch-hub/client.js`, `css.js`, `shared/i18n.js`
**Do:**
- `GET P + "/interactive/:sid/files/list"` → `{ outputsDir-relative items: [{ name, size, mtime }] }` for the session's outputsDir ONLY: `readdirSync` entries, skip dotfiles, skip symlinks outright (`lstatSync`), skip subdirectory recursion (flat list; the jail is one directory deep by construction), sort mtime desc, cap 200. Reuse `snap.outputsDir`; same 409 `no_session_dir`/`no_such_session` shapes as the download route. Never lists uploadsDir.
- Client: fetch on tab activation (not on open — keeps the chat fast path one less round trip), render rows linking the existing `workspace/<name>` download route; empty state text t("perch.filesEmpty"); refresh button (labelled).
**Verify:** `npm test -- tests/perch-interactive-routes.test.js` — new tests mirror the jail's attack inventory at the LIST level: symlink in outputsDir absent from the listing; dotfile absent; `..` impossible (no user path input on this endpoint at all). Live: write a file into a session's outputsDir from the bot, see it, download it.

---

## Phase E — whole-branch verification + docs

### Step E1 — Full suite + server boot + live walk

**Commands:**
1. `npm test` (full scratch suite — must be 100% green; CI red blocks merges, including this one).
2. `node servers/gateway/index.js --no-auth` boots clean (Ctrl-C to exit).
3. Live Perch walk on the real gateway: start a bot session in a chosen non-default dir → send → it writes a file to the dir (proves write_paths) → **make one tool call through a per-bot MCP server from that non-default directory (e.g. a `crow_mcp` memory search) and assert the tool actually answers — a silently-missing MCP tool is the failure mode of the `.mcp.json` relocation** → switch model while hibernating → restart the gateway → session adopts on the switched model, in the chosen dir → disable that provider → send → fail-open log line in Activity, session runs on the def default → change cwd mid-session → refused in-turn, works idle.
4. CDP render checks (412x730 + 1280x900): Send reachable in all four tabs; picker usable at phone width; tab bar no horizontal scroll at 320px.
**Verify:** each numbered item recorded (measured, not read) in the PR body; deviations from this plan listed as named call-outs, per the repo's PR style.

### Step E2 — Docs

**Files:** `docs/architecture/gateway-server.md` (perch section: cwd model + new endpoints), `docs/guide` perch walkthrough (open-in-any-directory + tabs), `docs/reviews/2026-09-11-perch-pr356-review-completion.md` gets a status footer "R1/R2/R4 closed by <PR#>". `CLAUDE.md`: only if the deep layout story changed — it hasn't.
**Verify:** `cd docs && npm run dev` renders (spot-check sidebar); `git show --stat HEAD` — only intended files (repo rule).
**Commit:** `Docs: Perch opens anywhere — the cwd model, the picker, and the tabs`

---

## Sequencing and PR shape

- **PR 1:** Phase A alone (steps A1-A4). Small, self-contained, keeps `main` healthy mid-flight and independently revertable.
- **PR 2:** Phases B + C (plumbing + picker) — the product decision lands.
- **PR 3:** Phase D + E (tab surface) — visual/UX change on top.
Each PR: `npm test` green before push; `git pull --rebase` first; positional-path commits only.

## Risk notes for the executor

- **`.mcp.json` relocation (B2) is the deepest cut.** If MCP servers stop loading after cwd separation, the failure is silent per-tool, not loud — the acceptance walk in E1 must include one tool call through a per-bot MCP server (e.g. `crow_mcp` search) in a non-default directory before merging PR 2.
- **Step B1's dedicated `bot_sessions` CHECK-rebuild** (~:2658-2790, I13 canonical-shape diff) is the only way a green suite can still ship a broken migration — the rebuild fires only on hosts that predate the 'interrupted' widening. Read that whole block, plus `rebuildMainFKsToProjectSpaces`, before editing.
- **Composer/tab-bar flex chain** has already killed one Send button. Measurements in D1 are non-optional.
- If the catalogue seam in A2/A3 fights the engine's lazy `loadSeams()`, prefer passing the validator through `createInteractiveEngine({ opts })` the way `providerModels` already is (search `opts.providerModels` in the module header ~:267) — do not make the engine import the DB directly.

---

## Review

**2026-09-11 — adversarial design review (staff-engineer pattern, dispatched subagent).** Verdict: **REVISE**. All findings re-verified line-by-line against the code before adoption.

| Finding | Disposition |
|---|---|
| Reviewer "C1": removing `model:` from the three stamps breaks `writeRow`'s INSERT placeholder count | **REJECTED as factually wrong** — `writeRow`'s second parameter is a destructured object with `model = null` default (`perch-interactive.js:676`); omitting the key passes NULL into the same arg position. A tripwire note now sits in step A1 so the executor does not "fix" the non-issue. |
| Reviewer "C2": `onModelSelect`→`writeModel` drops a switch landing before `s.rowId` exists, never retried | **ADOPTED** — A1 gained an end-of-`startChild` belt (`if (s.currentModelParts && servingModel(s) !== prep.resolved.key) await writeModel(s);`) plus a driving test. |
| Reviewer "C3": `.mcp.json` relocation instruction ambiguous about which call site changes | **ADOPTED** — B2 now names the in-body call site (`writeBotMcp(def, {`, bot-world.mjs ~:125) and spells out what stays at the world root. |
| Reviewer "C4": CREATE-body site of `cwd` not pinned | **ADOPTED (already covered)** — plan already gives the search string `CREATE TABLE IF NOT EXISTS bot_sessions`; B1 additionally names the dedicated CHECK-rebuild's three lists (I13 canonical diff ~:2688/~:2726, `bot_sessions_new` ~:2750, carried `colList`). |
| Q1: `selfAuthoringDir` under cwd split | **ADOPTED** — stays keyed on `def.session_dir` by design (Bot Builder scans there); comment required in B2. |
| Q2: channel callers and the removed stamps | **N/A** — `onTurnEnd`/`startChild` are interactive-engine-only; channel turns meter/persist through bridge.mjs's own paths, untouched. |
| Q3: exact field path for cwd into PiRpc | **ADOPTED** — B3 names it: `new S.PiRpc(Object.assign({}, prep.piRpcOpts, { cwd: world.cwd, … }))`; `prepareSpawn`'s opts stay cwd-free. |
| Q5: "does the drawer still exist?" | **Clarified** — the drawer was deleted by the 2026-09-09 plan's Phase 2; D2's "move" is the in-page controls row, and tab switching must never touch the SSE lifecycle. |
| S4 (`parent` from realpath), S5 (Escape + Cancel), S6 (tabs don't touch EventSource), S7 (MCP tool-call checkpoint in the live walk) | **ADOPTED** in C1/C2/D2/E1 respectively. |
| Gap raised in the review prompt, absent from the reviewer's report: **legacy auto-stamped rows** | **ADOPTED** — A1 gained a revocation path: "the bot's own model" now clears the explicit choice (writes NULL, next wake re-resolves from the def); no bulk cleanse (each legacy value really was the serving model at stamp time). |

**Post-revision state:** all adopted fixes are edits to this file (steps A1, B2, B3, C1, C2, D2, E1); the plan's structure and PR shape are unchanged. The one rejected finding is documented above and guarded by an in-step tripwire.

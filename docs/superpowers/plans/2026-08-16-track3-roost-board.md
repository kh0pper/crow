# Track 3 — Roost on the Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge Perch into the board (shape A): dispatch perch-live sessions onto cards, a roost strip + session drawer replace the Perch page, and the vendored perch-hub bundle retires.

**Architecture:** Three waves. Wave 1 extends the gateway's interactive engine (`perch-interactive.js`) and PiRpc with card binding, control passthrough (model/thinking/modes), wake fidelity, safe-victim capacity, and notifications — all headless-testable. Wave 2 builds the roost strip, birds-on-cards, and the session drawer inside the existing bot-board panel. Wave 3 retires the perch-hub bundle, panel, supervisor, and per-turn channel per the spec's inventory.

**Tech Stack:** Node 22, Express, better-sqlite3/libsql, node built-in test runner, pi RPC (`@earendil-works/pi-coding-agent`), pi-lab extensions (crow-mode branch), template-literal panel clients, SSE.

**Spec:** `docs/superpowers/specs/2026-08-16-track3-roost-board-design.md` (post adversarial ×2). Read it before any task — decisions T3-1…T3-11 and §§3-8 are the requirements; this plan argues from it.

## Global Constraints

- Work in the sibling worktree `/home/kh0pp/crow-track3` (branch `feat/track3-roost-board` from `origin/main` @7dc103d0; `node_modules` symlinked). All file:line anchors in this plan cite that commit.
- Node 22: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH` before any test run.
- Tests: `npm test -- tests/<file>.test.js` from the worktree (scratch env; never boot any server without scratch `CROW_HOME` **and** `CROW_DATA_DIR`). Full suite floor: no regressions vs the wave's baseline; final CI must be green on `suite`/`static-checks`/`audit` via `/commits/<sha>/check-runs`.
- Commits: positional-path only (`git commit <paths> -m …`), verify `git show --stat HEAD` after each. Never attribute Claude.
- Panel client code: **template literals only, no backtick characters inside emitted client strings; escapes double-escaped** (`\\n` in emitting literal). Every new user-facing string EN+ES via the i18n helpers (`t()` server-side / the panel's `tJs` idiom); the parity gate does NOT scan sources — discipline + the new literal-scan test (Task 15) enforce it.
- Board API contract: def envelopes are JSON strings; items expose title as label.
- Mutation-test every new test (break the code, watch it fail, restore **by edit** — never `git checkout`).
- pi-lab changes: edit `~/pi-lab` on branch `crow-mode`, commit + push to Gitea (`git@gitea:kh0pp/pi-lab.git`). No payload vendoring anywhere in this plan.
- New notification/board strings, new env knobs, and freed ports are documented where each task says; `docs/developers/port-allocation.md` edits are manual (check-ports does not flag stale rows).
- Engine tests use the P2 harness idiom: `createInteractiveEngine({bridge: fakeSeams, env: {...}, now, setTimer, clearTimer})` with a fake `PiRpc` — look at `tests/perch-interactive.test.js` for the existing fake-child pattern and extend it; never spawn real pi in unit tests.

---

## Wave 1 — Engine + API (headless)

### Task 1: Lock rail — active-only session locks, perch-live excluded (T3-9)

**Files:**
- Modify: `servers/gateway/routes/board-lock.js` (whole file is 149 lines; read it first)
- Test: `tests/board-lock-perch-live.test.js` (new), plus run the existing lock consumers' tests (`grep -rl "board-lock" tests/`)

**Interfaces:**
- Produces: `SESSION_LOCK_STATUSES` becomes `new Set(["active"])`; `sessionRowFor`/`lockedCardIds` SQL gains `AND kind != 'perch-live'`. Callers (`lockState`, `isCardLocked`, `lockMapFor`, bot-board-api 409s, SSR/SSE renders) are unchanged in signature.

- [ ] **Step 1: Write the failing test.** Seed a scratch crow.db (use the existing test-db helper other board-lock consumers use — `grep -n "bot_sessions" tests/*.test.js` to find the seeding idiom) with four cards:
  - card 1: newest row `kind='perch-live', status='waiting-user'` → expect NOT locked
  - card 2: newest row `kind='chat', status='waiting-user'` (stale history) → expect NOT locked (the T3-9 product change)
  - card 3: newest row `kind='chat', status='active'` → expect locked, rail `session`
  - card 4: a `bot_jobs` row `status='running'` → expect locked, rail `job`
  Also: card 5 with newest row perch-live `waiting-user` and an OLDER `kind='chat', status='active'` row → expect locked (perch-live must not *shadow* an active row — the exclusion is in the SQL, not post-hoc on the newest row).

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { lockState, lockedCardIds, SESSION_LOCK_STATUSES } from "../servers/gateway/routes/board-lock.js";

test("waiting-user no longer locks; perch-live never locks; active still locks", async () => {
  const db = await seedDb(); // cards + rows as above
  assert.equal(SESSION_LOCK_STATUSES.has("waiting-user"), false);
  assert.equal((await lockState(db, 1)).locked, false);
  assert.equal((await lockState(db, 2)).locked, false);
  assert.equal((await lockState(db, 3)).locked, true);
  assert.equal((await lockState(db, 4)).rail, "job");
  assert.equal((await lockState(db, 5)).locked, true); // active row not shadowed
  const set = await lockedCardIds(db, [1, 2, 3, 4, 5]);
  assert.deepEqual([...set].sort(), [3, 4, 5]);
});
```

- [ ] **Step 2: Run it — expect FAIL** (waiting-user currently locks; perch-live shadows).
- [ ] **Step 3: Implement.** In `board-lock.js`:
  - `export const SESSION_LOCK_STATUSES = new Set(["active"]);` (line 38) — update the comment to name T3-9 and the spec.
  - `sessionRowFor` (line 76): `WHERE card_id=? AND kind != 'perch-live' ORDER BY id DESC` — perch-live rows are invisible to the lock rail, including for force-unlock reporting.
  - `lockedCardIds` (line 126): the inner `MAX(id)` subquery gains `AND kind != 'perch-live'` — that alone suffices for the batched form (the outer fetch selects by those ids and can never see an excluded row).
- [ ] **Step 4: Run the new test + every existing test that imports board-lock** (`grep -rl "board-lock" tests/ | xargs -I{} npm test -- {}`). Existing tests asserting waiting-user locks must be UPDATED to the new contract (they encode the old behavior, which the spec names as a deliberate change) — update assertions, don't delete coverage.
- [ ] **Step 5: Mutation-test** (flip the `kind !=` filter off; watch card 1/5 assertions fail; restore by edit).
- [ ] **Step 6: Commit** `git commit servers/gateway/routes/board-lock.js tests/board-lock-perch-live.test.js tests/<updated>.test.js -m "feat(board): session locks are active-only, perch-live rows excluded (T3-9)"`

### Task 2: Shared card-brief builder

**Files:**
- Create: `scripts/pi-bots/card-brief.mjs`
- Modify: `scripts/pi-bots/bridge.mjs:678-695` (the `cardId != null` prompt branch)
- Test: `tests/card-brief.test.js` (new golden), existing `tests/bot-world.test.js` and the bridge prompt tests must stay green

**Interfaces:**
- Produces: `cardBriefBlock({ cardId, tasksDbPath, userLine, planForCard, cardStatus, boardVocab })` → string — the text bridge.mjs builds from `"Work the following card"` through `"…not a status write."`, byte-identical, **with the `User said: "…"` line in the middle where it actually sits** (bridge.mjs:695-697: the PLAN fence closes, then `\n\nUser said: "<cleanMsg>"\n\n`, then the "Do the work…" paragraph). `userLine` is the parameterized cleanMsg (spec §5.1). `projectHeader`/`gatewayHint` and the channel tail (`" Then reply with a short summary for the gateway thread. One card only."`) stay caller-side.

- [ ] **Step 1: Record the golden.** Before touching bridge.mjs, write `tests/card-brief.test.js` that composes the CURRENT bridge text shape inline as the expected fixture (copy the exact concatenation from `bridge.mjs:688-695`, substituting fixed inputs: cardId 42, status "todo", statuses ["todo","doing","done"], plan "PLAN BODY"), then asserts `cardBriefBlock(...)` equals it. The helpers are injected so the test needs no DB:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { cardBriefBlock } from "../scripts/pi-bots/card-brief.mjs";

test("card brief is byte-identical to the bridge's historical block", () => {
  const expected =
    "Work the following card.\n\nCARD #42 (current board status: todo; this board's statuses: todo, doing, done).\nPLAN:\n---\n" +
    "PLAN BODY\n---\n\nUser said: \"do card 42\"\n\n" +
    "Do the work the plan describes. You may use board_move_item to update this card's status " +
    "as you go (only ever use this board's statuses). When you are done, call board_report_result " +
    "with item_id=42, an outcome of success/failure/partial, and a summary_md describing " +
    "what you did — that call is what ends the run, not a status write.";
  const got = cardBriefBlock({
    cardId: 42, tasksDbPath: "/x", userLine: 'do card 42',
    planForCard: () => "PLAN BODY",
    cardStatus: () => "todo",
    boardVocab: () => ({ statuses: ["todo", "doing", "done"], terminals: ["done"] }),
  });
  assert.equal(got, expected);
});
```

  NOTE the block ENDS at `…not a status write.` — the tail `" Then reply with a short summary for the gateway thread. One card only."` is channel-specific and stays in bridge.mjs (single leading space preserved). **Verify the exact current text against `bridge.mjs:688-703` when writing the fixture** (the review confirmed the User-said line sits between the PLAN fence and the "Do the work" paragraph); the fixture is the law thereafter.
- [ ] **Step 2: Run — FAIL** (module missing).
- [ ] **Step 3: Implement** `card-brief.mjs`: a pure function assembling that string from the injected helpers; no imports from bridge (avoids the cycle). Then edit `bridge.mjs`'s card branch to `promptText = projectHeader + "\n\n" + cardBriefBlock({cardId, tasksDbPath, userLine: cleanMsg, planForCard, cardStatus, boardVocab}) + " Then reply with a short summary for the gateway thread. One card only."`. Diff the composed prompt against the pre-change string in the test.
- [ ] **Step 4: Run** the new test + `npm test -- tests/bot-world.test.js` + `grep -rl "Work the following card" tests/ | xargs -I{} npm test -- {}` — all green (byte-identity holds).
- [ ] **Step 5: Commit** `git commit scripts/pi-bots/card-brief.mjs scripts/pi-bots/bridge.mjs tests/card-brief.test.js -m "refactor(pi-bots): extract shared card-brief builder (byte-identical, golden-tested)"`

### Task 3: PiRpc — correlated commands, ack-only prompt, permission-mode policy

**Files:**
- Modify: `scripts/pi-bots/bridge.mjs` — PiRpc class (constructor :143-294, methods :301-397)
- Test: `tests/pi-rpc-commands.test.js` (new; use the stub-child seam `nodeBin`/`cliPath` the class already exposes — see `tests/` for the existing stub-child fixture pattern, `grep -rn "cliPath" tests/`)

**Interfaces:**
- Produces:
  - `PiRpc.commandSince(payload, ms = 15000)` → sends `{...payload, id: "cmd_" + seq}`, waits (via `waitForSince`) for `{type:"response", id, command: payload.type}`; rejects on `success === false` with `err.code = "command_failed"`. Used for `set_model`, `set_thinking_level`, `get_available_models`, `get_available_thinking_levels`.
  - `PiRpc.promptAckOnly(message, ms = PROMPT_ACK_TIMEOUT_MS)` → sends a correlated prompt, waits ONLY for the ack response, returns it; throws `prompt_refused` on `success !== true`. **Never waits for agent_end** (spec §5.2 — a handled slash command produces no agent loop).
  - Constructor option `permissionMode` (`"guarded"` default | `"ask"` | `"bypass"`): applied to the `piPolicy` COPY after the selfAuthoringDir append (:216-219): `ask` → `piPolicy.interactive_ask = true`; `bypass` → `piPolicy.write_paths = ["/"]` and `piPolicy.external_send = "allow"` (read pi-lab `extensions/permission-gating.ts:43-52` first and match the real `external_send` vocabulary — if its values are e.g. `"draft-only"|"allow"`, use the permissive value; if absent-means-allow, DELETE the key instead). `guarded`/absent → byte-identical policy (golden guard).
  - Constructor option `extraWritePaths` (array): appended to the write_paths copy exactly like `selfAuthoringDir` (:216-219). Channel callers pass neither → byte-identical.

- [ ] **Step 1: Failing tests.** With the stub child echoing canned responses:
  - `commandSince({type:"set_model", provider:"crow", modelId:"m"})` resolves on the id-matched response and NOT on a stale same-command response from before the call (seed one first — the `_seq` scope is the point).
  - `promptAckOnly("/plan")` resolves on the ack and leaves NO pending waiter for agent_end (assert `pi._w.length === 0` after resolve).
  - `permissionMode:"bypass"` → spawn env's `PI_BOT_PERMISSION_POLICY` JSON has `write_paths: ["/"]`; `"ask"` → has `interactive_ask: true`; omitted → deep-equals the policy produced before this task (fixture the pre-change JSON).
  - `extraWritePaths: ["/tmp/x"]` lands in write_paths; omitted → absent.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** in PiRpc: `commandSince` mirrors `getSessionStats`'s id idiom + `waitForSince`; `promptAckOnly` is `promptTurn`'s first half verbatim (id + since + ack wait + `success!==true` throw) without the agent_end wait; the two constructor options as above, applied to the copy, never the stored def.
- [ ] **Step 4: Run** new tests + the full bridge/bot-world test files (byte-identity for channel callers is the regression gate).
- [ ] **Step 5: Mutation-test** (drop the `since` scoping from `commandSince`; stale-response test must fail; restore by edit).
- [ ] **Step 6: Commit** `git commit scripts/pi-bots/bridge.mjs tests/pi-rpc-commands.test.js -m "feat(pi-bots): PiRpc correlated commands, ack-only prompt, permission-mode/extra-write-paths policy opts"`

### Task 4: Engine — model tracking, control(), options(), warm-on-switch, metering basis

**Files:**
- Modify: `servers/gateway/perch-interactive.js`
- Test: `tests/perch-interactive-controls.test.js` (new, fake seams/fake PiRpc)

**Interfaces:**
- Consumes: Task 3's `commandSince`.
- Produces (engine public surface additions):
  - `control(sessionId, {model?, thinking?, permissionMode?, planMode?})` → applies what it can live, stores what binds at wake; returns `{applied: {...}, bindsAtWake: {...}}`. Refusals: `no_such_session`, `session_stopped`, `turn_in_progress` (model/thinking switches are refused mid-turn — one clock owner per turn), `bad_request` on unknown values (`permissionMode` ∉ {guarded, ask, bypass} etc.).
  - `options(sessionId)` → `{models: [...], thinkingLevels: [...]}` from `commandSince({type:"get_available_models"})` / `get_available_thinking_levels` (wakes NOT required: if hibernating, return `{models: null, thinkingLevels: null}` — the drawer disables the pickers until awake; do not wake a child just to list models).
  - Session record gains: `currentModel` (string|null, engine-tracked), `permissionMode` (default `"guarded"`), `planMode` (mirrored state object|null, Task 6 fills it). `snapshot()`/`stateEvent()` expose all three (`model` now reports `currentModel || resolved.key`).

Behavior to implement:
1. **Track model:** in `onChildEvent` (:647-671), add a `model_select` case. **Real event shape (verified): `{type:"model_select", model: {provider, id, ...}, previousModel, source}`** — the Model object has `id`, NOT `modelId`. Set `s.currentModelParts = {provider: m.model.provider, modelId: m.model.id}`, `s.currentModel = m.model.provider + "/" + m.model.id`, update `s.resolved = {...s.resolved, provider: m.model.provider, model: m.model.id, key: s.currentModel}` so `onTurnEnd`'s `meterTurn({resolved: s.resolved})` (:727-731) prices the serving model, emit a state event and a `{type:"log", text:"now on <key>"}` system note. (`set_model`'s response `data` is likewise a Model — read `data.id`.)
2. **Apply model at wake:** in `startChild` (:551), after `prepareSpawn` and **BEFORE the `warmModel` call at :559**: if `s.currentModelParts` is set and differs from `prep.resolved`, override `prep.resolved = {...prep.resolved, provider, model: modelId, key: s.currentModel}` FIRST — then `s.resolved = prep.resolved` (:558) and `warmModel(prep.resolved.provider)` both see the tracked model, so the wake warms the RIGHT provider and metering prices the right model from turn 1 (not only after pi re-emits model_select). `prep.piRpcOpts.resolved` must be the same corrected object.
3. **control() model switch (awake):** `await S.warmModel(provider, slog)` FIRST (spec: pi-lab's local-models starter self-disables in bots), then `s.pi.commandSince({type:"set_model", provider, modelId})`; update `currentModel` on the response (the `model_select` event will also arrive — dedupe by value).
4. **permissionMode:** store on the session record; **binds at wake** — control() with a new mode while awake returns it under `bindsAtWake` (the route/drawer offers the cycle, Task 8). Passed to PiRpc via `startChild`: `extraEnv` unchanged, add `permissionMode: s.permissionMode` into `prep.piRpcOpts`. Every accepted mode change emits `{type:"log", text:"permission mode → <mode>"}` — the spec-required visible system note (§4.1.4). **Restart semantics (named for the reviewer):** `adoptRow` does NOT restore permissionMode — an adopted session resets to `"guarded"`. This is the fail-safe reading of spec §5.3 (a gateway restart must never silently resurrect `bypass`); the drawer shows the current mode so the operator sees the reset. Document this in the file header and in the spec-facing test name.
5. **thinking:** live passthrough `commandSince({type:"set_thinking_level", level})`; no persistence (pi's session file keeps it across resume — no CLI flag overrides it; verify once in the test fixture comment).

- [ ] **Step 1: Failing tests** (fake PiRpc records sent frames; fake seams' `warmModel` records calls):
  - model_select event (real shape: `{model: {provider, id}}`) updates snapshot().model and the meterTurn call's `resolved.key` for the NEXT turn end.
  - control model switch calls warmModel BEFORE commandSince (assert call order).
  - hibernate → message (wake): fake PiRpc constructor receives `resolved.key === trackedModel` AND the wake-path `warmModel` was called with the TRACKED provider AND the post-wake turn's meterTurn `resolved.key` is the tracked model (all three, asserted on the fakes' recorded args — spec §8 wake fidelity, review finding 8).
  - control({permissionMode:"bypass"}) while awake → `bindsAtWake.permissionMode === "bypass"`, and the next wake's PiRpc opts carry `permissionMode:"bypass"`.
  - adopt (fresh engine over the same row) → snapshot reports mode `"guarded"` (reset-on-restart).
  - control with `turn_in_progress` refused; unknown mode → `bad_request`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** per the behavior list.
- [ ] **Step 4: Run** new + existing `tests/perch-interactive*.test.js` — green.
- [ ] **Step 5: Mutation-test** (remove the warm-before-switch ordering; remove the wake model override) — named tests fail; restore by edit.
- [ ] **Step 6: Commit** `git commit servers/gateway/perch-interactive.js tests/perch-interactive-controls.test.js -m "feat(perch): engine-tracked model, control()/options(), warm-on-switch, engine-owned permission mode"`

### Task 5: pi-lab rpc-state-bridge extension + engine plan-mode mirror + slash sends

**Files:**
- Create (pi-lab repo, branch crow-mode): `~/pi-lab/extensions/rpc-state-bridge.ts`
- Modify: `servers/gateway/perch-interactive.js` (`onUiRequest` :673-687, control() planMode)
- Test: `tests/perch-interactive-statebridge.test.js` (new; the pi-lab side gets a smoke test in pi-lab's own harness per its conventions — read `~/pi-lab/CLAUDE.md` first)

**Interfaces:**
- Produces:
  - pi-lab extension: subscribes `pi.events.on("plan-mode:state", …)` and forwards each state via `ctx.ui.notify("crow-state:" + JSON.stringify({kind:"plan-mode", state}))` (`ctx.ui.notify` verified real) — active ONLY when `process.env.PI_BOT_INTERACTIVE === "1"` (channel turns and personal pi are byte-identical without it). **Real bus payload (verified, plan-mode/index.ts:300-307): `{enabled, executing, todosDone, todosTotal, todos}` — the field is `enabled`, not `active`.** Forward verbatim. On `session_start` (i.e. after every wake) the extension also emits `pi.events.emit("plan-mode:get")` (index.ts:320 answers it) and forwards the reply — this primes the mirror after each wake so §5.3's wake fidelity holds (without it `s.planMode` is null after every wake).
  - Engine: in `onUiRequest`'s notify branch (:681-683), discriminate — `if (text.startsWith("crow-state:"))` parse the JSON, set `s.planMode = parsed.state` for kind `plan-mode`, `emit(s, {type:"plan_state", state: parsed.state})`, and **do not** emit the log line. Malformed JSON after the prefix → swallow (never a transcript line, never a throw). `subscribe()` replay (:1033-1044) additionally replays `plan_state` when `s.planMode` is set.
  - Engine `control(sessionId, {planMode})`: `true` → `s.pi.promptAckOnly("/plan on")`; `false` → `promptAckOnly("/plan off")` — **never bare `/plan`, which is a toggle (index.ts:336-344) and a footgun against stale drawer state**; verify the exact on/off argument strings in plan-mode's command handler before implementing. Refused while `turn_in_progress` or hibernating (plan mode needs a live child; the drawer disables the toggle then).

- [ ] **Step 1: Failing engine tests** (fake child emits `extension_ui_request {method:"notify", message:"crow-state:{\"kind\":\"plan-mode\",\"state\":{\"enabled\":true,\"executing\":false,\"todosDone\":0,\"todosTotal\":0,\"todos\":[]}}"}` — the REAL payload shape):
  - `plan_state` event emitted, NO `log` event for that frame; snapshot/state includes planMode.
  - re-subscribe replays plan_state.
  - ordinary notify (no prefix) still becomes a log line (regression).
  - control planMode sends a prompt frame with the /plan text and waits only the ack (no agent_end waiter left).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement engine side.**
- [ ] **Step 4: Implement pi-lab extension** in `~/pi-lab` (read `plan-mode/index.ts` for the bus payload + command names; register in the package's extension list the way siblings do — see how `notify.ts` is wired). Commit + push pi-lab on crow-mode: `git -C ~/pi-lab add extensions/rpc-state-bridge.ts && git -C ~/pi-lab commit -m "rpc-state-bridge: forward plan-mode bus state over extension-UI under PI_BOT_INTERACTIVE" && git -C ~/pi-lab push origin crow-mode`.
- [ ] **Step 5: Run engine tests green; mutation-test the prefix discriminator** (drop the startsWith check → the no-log assertion fails; restore by edit).
- [ ] **Step 6: Commit crow side** `git commit servers/gateway/perch-interactive.js tests/perch-interactive-statebridge.test.js -m "feat(perch): plan-mode state mirror via rpc-state-bridge frames; /plan ack-only sends"`

### Task 6: Engine — card binding, occupancy, dispatch, free-chat cwd refusal, outputs/uploads dirs

**Files:**
- Modify: `servers/gateway/perch-interactive.js`, `scripts/pi-bots/bot-world.mjs:82-86` (cwd guard), `scripts/pi-bots/bridge.mjs` (add `export` to `projectContextBlock` at :492 — it is module-private today)
- Test: `tests/perch-interactive-dispatch.test.js` (new)

**Interfaces:**
- Consumes: Task 2's `cardBriefBlock`, Task 3's `extraWritePaths`.
- Produces:
  - `spawn({botId, cardId?})` — cardId validated by the ROUTE (Task 9); engine stores `s.cardId`, `writeRow` (:401-429) sets `card_id=?` in both UPDATE and INSERT branches (add the column to both SQL statements; COALESCE-free — the engine's value is authoritative for its own rows).
  - **Synchronous card claims:** module-level `const cardClaims = new Map()` (cardId → sessionId) inside `createInteractiveEngine`. `claimCard(cardId, sessionId)` throws `card_occupied` if present with a different live session; set/delete happen in the SAME synchronous block as `reserveSlot` (spec §5.1 — no await between check and claim). Released on `stop()`, on `attachExit`'s park **only when state becomes stopped** (a hibernating card session keeps its claim — occupancy rule (c)), and on engine construction it is rebuilt lazily: the DB occupancy check below covers rows from before this process.
  - **Async occupancy check** (route-called before spawn, and inside the engine before the sync claim as a double-check): `checkCardFree(cardId)` queries: (a) any `bot_sessions` row with this card_id and `status='active'` (any kind) → `card_occupied`; (b) `jobLockFor` (import from board-lock.js) → `card_occupied`; (c) any `kind='perch-live'` row with this card_id and `status != 'stopped'` → `card_occupied`.
  - **Dispatch context — and dispatch STARTS the turn (review Q1, decided: job-rail analog):** `spawn({botId, cardId})` stores `s.dispatchBrief`; the dispatch ROUTE (Task 9) immediately calls `eng.message(sid, note)` after the 201-worthy spawn (`note` = the operator's optional dialog note, default `""`), and `message()` — when `s.dispatchBrief` is pending — composes the actual prompt as the brief and clears it, so the bird begins working the card unprompted. The brief: `projectContextBlock(projectSpace, projectMembers)`-header + `"\n\n" + cardBriefBlock({cardId, tasksDbPath, userLine: note || "Work this card.", planForCard, cardStatus, boardVocab}) + "\n\nDeliverables you produce as files go in: " + outputsDir`. Seam plumbing: add `planForCard` + `projectContextBlock` (from bridge.mjs — export projectContextBlock) and `cardStatus` + `boardVocab` (they live in `scripts/pi-bots/tracker.mjs`, which bridge imports at :38 — import tracker.mjs directly in `loadSeams()` :195-230) to the seams object and the `bridge` test-seam contract.
  - **Dirs:** `startChild` computes `outputsDir = join(world.sessionDir, "outputs", s.sessionId)` and `uploadsDir = join(world.sessionDir, ".pi", "uploads", s.sessionId)`, mkdirs both, stores on `s`, passes `extraWritePaths: [outputsDir]` into piRpcOpts.
  - **Free-chat cwd refusal:** in `buildBotWorld` (bot-world.mjs:82-86), before `mkdirSync`: `if (!sessionDir) throw Object.assign(new Error("bot has no working directory — set one in Bot Builder (session_dir) or bind the bot to a project space"), {code: "no_session_dir"});` — this also fixes the literal `undefined/` bug for every rail. Engine maps it: add `no_session_dir: [409, "no_session_dir"]` to the API's ERROR_MAP (Task 9).
  - **Per-bot world-build mutex (spec §3.2/I9):** module-level `const worldBuildLocks = new Map()` (botId → promise chain) in the engine; `startChild`'s `buildBotWorld` call runs through `worldBuildLocks.set(botId, (worldBuildLocks.get(botId) || Promise.resolve()).then(build))` so two in-gateway builds for one bot (two sessions, or a session racing a card job run in-gateway) serialize — `.mcp.json` content varies by jobId, so concurrent writes race. The cross-process bridge-tick race is pre-existing and out of scope (spec §9). Test: two concurrent spawns of one bot → the fake seams' buildBotWorld invocations do not overlap (record enter/exit timestamps in the fake).

- [ ] **Step 1: Failing tests:**
  - spawn with cardId → fake-db row write includes card_id (assert the SQL args through a seeded scratch DB, same helper as Task 1).
  - two concurrent `spawn({botId, cardId: 7})` (fire both before awaiting) → exactly one resolves, one throws `card_occupied` (the synchronous claim; use a fake PiRpc whose constructor never resolves state so the async part stalls — the claim must still exclude).
  - `checkCardFree`: seeded active chat row → occupied; stale waiting-user chat row → free; hibernating perch-live row with the card → occupied; job row running → occupied.
  - dispatch: spawn stores the brief, and the first `message(sid, "note text")` sends the composed header+brief (with `User said: "note text"` in the brief's middle position) to the fake child; a SECOND message sends only the raw text (brief cleared). Fixture the composed string; golden vs `cardBriefBlock`.
  - startChild passes `extraWritePaths` containing the outputs dir; dirs exist on disk after spawn (scratch sessionDir).
  - buildBotWorld with `def.session_dir` undefined and no workspace → throws code `no_session_dir` (this is a bot-world test — put it in the same file, seeded via the fake bridge loadBot).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** per the interface block. `stop()` (:1015-1031) deletes the card claim; `adoptRow` (:492-515) restores `s.cardId` from the row (add `card_id` to its SELECT) and re-registers the claim when status ≠ stopped.
- [ ] **Step 4: Run** new + all perch-interactive + bot-world tests (the golden fixture proves channel turns unaffected by the bot-world guard).
- [ ] **Step 5: Mutation-test** the sync claim (add an `await Promise.resolve()` between check and set — the concurrent test must fail; restore by edit).
- [ ] **Step 6: Commit** `git commit servers/gateway/perch-interactive.js scripts/pi-bots/bot-world.mjs tests/perch-interactive-dispatch.test.js -m "feat(perch): card-bound dispatch with synchronous occupancy, per-session outputs/uploads, no-cwd refusal"`

### Task 7: Engine — cycle(), capacity safe-victim, interruption marker

**Files:**
- Modify: `servers/gateway/perch-interactive.js`
- Test: `tests/perch-interactive-capacity.test.js` (new)

**Interfaces:**
- Produces:
  - `cycle(sessionId)` — refused (`cycle_busy`, 409 in Task 9's map) while `s.turn || s.pendingUi`; otherwise `await hibernate(s)` then reserve+`startChild` (re-using message()'s wake shape minus the turn) so spawn-bound state (permissionMode, narrowing) binds NOW. Returns `{state: s.state}`.
  - Safe-victim: `reserveSlot` (:528-542) gains a fallback caller — a new `reserveWithEviction(S, session)`: try `reserveSlot`; on `interactive_capacity`, synchronously pick the victim (awake, `!turn`, `!pendingUi`, oldest `s.lastEventAt` — add `s.lastEventAt = now()` touched in `onChildEvent` and on turn end), synchronously set `victim.state = "hibernating"` AND `session.state = "waking"` (the handover — no await between; this closes the awake-cap TOCTOU), then `await hibernate(victim)` and **re-run the host pi-budget half of the gate AFTER the victim's child is closed** (`S.countLivePi()` vs maxPi — the victim's live child made the earlier check unrunnable; on failure release our reservation and throw `pi_capacity`). No victim → rethrow `interactive_capacity`. Used by `spawn` and `message`'s wake path. `pi_capacity` is never evicted around (spec §3.3).
  - **`DEFAULT_MAX_AWAKE` 1 → 3** (perch-interactive.js:93 — the T3-6 decision itself; the env knob `PERCH_INTERACTIVE_MAX_AWAKE` is unchanged). Test asserts the default by constructing an engine with NO env override and spawning 3 fakes successfully, 4th evicts/refuses.
  - Interruption marker: `stopAll` (:1110-1139) parks interrupted-mid-turn rows with `control='interrupted'` instead of `'run'`: `writeRow` gains an optional `control` arg (default `'run'`). **Capture `const hadTurn = !!s.turn` BEFORE the existing `s.turn = null` at :1117-1119** (the current code nulls it before the row write; reading it late always yields 'run'), and pass `'interrupted'` iff hadTurn. `writeRow`'s next normal write resets control='run'. The sessions list route (Task 9) exposes `control`; nothing else reads it except bridge's `=== "stop"` check (:612) — `'interrupted'` is inert there (verify by reading that check).
  - `hibernate` keeps its **pendingUi invariant**: it must never be called with a pending card by the new paths — `cycle` refuses first; safe-victim never selects one; the DIRECT idle path already guards. Add an assertion-style guard at the top: `if (s.pendingUi) { log(...); return; }` — refusing is safer than destroying (spec I5).

- [ ] **Step 1: Failing tests:**
  - cycle on idle awake session → child closed and respawned (two fake-PiRpc constructions), narrowing/mode re-read; cycle with pendingUi → `cycle_busy`; mid-turn → `cycle_busy`.
  - MAX_AWAKE=2 (env seam): two awake idle sessions; third spawn → oldest-idle hibernated, third awake; make one of the two mid-turn and the other pendingUi → third spawn throws `interactive_capacity`.
  - concurrency: fire safe-victim spawn twice at cap-1 free slots → exactly one eviction, one refusal (the sync handover).
  - stopAll with an in-flight turn → row control='interrupted'; without → 'run'.
  - direct `hibernate` on a pendingUi session → no-op (card survives).
- [ ] **Step 2: Run — FAIL.**  
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all perch-interactive tests.**
- [ ] **Step 5: Mutation-test** the sync handover (insert an await before `session.state="waking"` — concurrency test fails; restore by edit).
- [ ] **Step 6: Commit** `git commit servers/gateway/perch-interactive.js tests/perch-interactive-capacity.test.js -m "feat(perch): cycle with busy guards, safe-victim eviction, interrupted-shutdown marker"`

### Task 8: Notifications — `attention` type end-to-end

**Files:**
- Modify: `servers/shared/notifications.js` (docs comment only — the gate is data-driven), `servers/gateway/push/ntfy.js:15-20` (TAG_MAP), `servers/gateway/push/email.js:12-14` (type filter), the notifications settings section (`servers/gateway/dashboard/settings/notifications.js` — find it: `grep -rn "types_enabled" servers/gateway/dashboard`), `servers/memory/server.js` type list, `servers/gateway/tool-manifests.js:36`, `servers/gateway/dashboard/i18n.js` (labels EN+ES)
- Modify: `servers/gateway/perch-interactive.js` (emit points), plus the boot migration home — find Track 2's settings migration (`grep -rn "guard-flag\|glass" servers/gateway/boot/ servers/gateway/*.js` for the idiom) and add the back-fill beside it
- Test: `tests/notifications-attention.test.js` (new)

**Interfaces:**
- Produces: notification type `"attention"`. Engine calls (via a lazy import of `servers/shared/notifications.js` + `createDbClient`) at three points:
  - turn end (non-aborted) when the turn ran ≥ `PERCH_NOTIFY_MIN_RUN_S` (env, default 30) **AND `s.subscribers.size === 0`** (review Q3, decided: an operator watching the drawer live is not away — agent-end pushes are suppressed while any SSE subscriber is attached; blocking/attention events below always push): `{type:"attention", priority:"normal", title: "<bot> replied", body: first 140 chars of reply, action_url: "/dashboard/bot-board#bird=" + sessionId}`;
  - `onUiRequest` ask card + permission-confirm card: priority `"high"`, title `"<bot> needs you"`;
  - gated result: emitted by the RESULT path, not the engine — find where `board_report_result` lands (`servers/gateway/board/result-service.js`) and add the same call there for `autonomy='gated'` cards, `action_url: "/dashboard/bot-board#card=" + itemId`.
  - `shouldEmail` (email.js:12): `return (priority === "high" && type !== "attention") || type === "briefing";`
  - TAG_MAP: `attention: "bird"`.
  - Back-fill migration (idempotent, guard-flagged like Track 2's): read `dashboard_settings.notification_prefs`; if `types_enabled` exists and lacks `"attention"`, append and save. Runs-twice-safe by construction.
  - Settings section: add the attention row to the hand-unrolled per-type UI (mirror an existing type's block exactly); i18n label keys `notifications.type_attention` EN+ES.

- [ ] **Step 1: Failing tests:** back-fill appends exactly once (run twice, assert single entry); `createNotification` with type attention passes the gate after back-fill and is dropped before it; `shouldEmail({priority:"high", type:"attention"})` false, `({priority:"high", type:"system"})` true (regression); engine fake-turn ≥ threshold emits, < threshold doesn't; ask card emits high-priority with the deep-link URL.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** all touch-points (grep each list cite; the settings section edit copies the neighboring type block verbatim with the new key).
- [ ] **Step 4: Run** new + `tests/i18n-global-parity.test.js` (the new label keys must exist in both languages) + any notifications tests.
- [ ] **Step 5: Commit** (positional paths for every touched file) `-m "feat(notifications): attention type — registry, back-fill, email exclusion, engine emit points"`

### Task 9: Gateway API routes — dispatch, attach-card, control, options, files, workspace

**Files:**
- Modify: `servers/gateway/routes/perch-interactive-api.js` (ERROR_MAP :50-66 + new routes), `servers/gateway/routes/perch.js` (sessions route :498-556: **add `control` to the SELECT and the response** — it is NOT there today, and Task 13's interrupted note depends on it; `card_id` is already exposed at :521; the narrow route needs a comment only)
- Test: `tests/perch-interactive-routes.test.js` (extend), `tests/perch-workspace-jail.test.js` (new)

**Interfaces:**
- Consumes: engine surface from Tasks 4-7.
- Produces (all under `P = "/dashboard/perch-api"`, dashboardAuth-gated; fake-engine seam per the file's existing pattern):
  - `POST /bots/:id/dispatch` `{card_id, note?}` — validates: engine ready + perchAttached (mirror :119-142); card exists in the **instance-global** tasks store (`tasksDbPath()` from `scripts/pi-bots/instance-paths.mjs` — there is no `resolveTasksDb`), is not archived, and is a CARD (`board_id IS NULL`) — **dispatch/attach are cards-only in Track 3 (review Q2, decided)**; custom-board items 400 `bad_request`. Then `await eng.checkCardFree(cardId)`; `eng.spawn({botId, cardId})`; write `assigned_bot` via the card service with a provenance mutation actor human (import from `servers/gateway/board/card-service.js` — read its exports and call the same path `board_update_item` uses; note `updateCard` itself scopes `WHERE board_id IS NULL`, consistent with cards-only); finally fire turn 1: `eng.message(sessionId, String(note || "")).catch(() => {})` (the brief-carrying first turn, Task 6) — fire-and-forget. 201 `{sessionId, threadId, state}`.
  - `POST /interactive/:sid/attach-card` `{card_id}` — same card validation + occupancy; engine gains `attachCard(sessionId, cardId)` (writes `s.cardId`, row update, sync claim; refused on `session_stopped`); then the same assigned_bot provenance write.
  - `POST /interactive/:sid/control` — body `{model?, thinking?, permission_mode?, plan_mode?}` → `eng.control`; `POST /interactive/:sid/cycle` → `eng.cycle`; `GET /interactive/:sid/options` → `eng.options`; `POST /interactive/:sid/steer` `{message}` (cap MESSAGE_CAP) → `eng.steer` — the drawer's mid-turn composer needs an HTTP door (review finding 3); refusals: `no_turn` when no turn is in flight, `pi_gone`/`session_stopped` per the map.
  - `POST /interactive/:sid/files` — multipart or base64 JSON `{name, data_b64}` (pick base64 JSON — no new dependency; cap 5 MB post-decode). Sanitize name: `basename`, reject empty/dotfiles. Write to the engine-known uploads dir (`eng.get(sid)` exposes `uploadsDir` — add it to snapshot in Task 6). Returns `{path}` (relative). Images (`.png/.jpg/.jpeg/.webp/.gif`): the drawer sends them as `images` on the next message — extend `POST /interactive/:sid/message` body with optional `images: [{mime, data_b64}]` (cap 3 × 2 MB), passed through `eng.message(sid, text, images)` → `promptTurn(text, 0, images)` (PiRpc already threads images).
  - `GET /interactive/:sid/workspace/*` — serves ONLY under `outputsDir`: `const resolved = realpathSync(join(outputsDir, rel)); if (!resolved.startsWith(realpathSync(outputsDir) + sep)) 404;` reject any path segment starting with `.` BEFORE resolution; no directory listings (404 on dirs); `Content-Disposition: attachment` except for image mime types.
  - ERROR_MAP additions: `card_occupied: [409]`, `no_session_dir: [409]`, `cycle_busy: [409]`, `command_failed: [502]`, `bad_request` exists.
- [ ] **Step 1: Failing tests:** route-level with a fake engine (existing idiom) for dispatch/attach/control/options/cycle happy + refusal paths; jail tests with a REAL temp outputs dir: `../` traversal, absolute path, symlink escaping the dir (create one), dotfile name, nested ok-file → only the ok-file serves; upload rejects `..`-names and dotfiles, writes into the session dir.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** extended route tests + jail tests.
- [ ] **Step 5: Mutation-test the jail** (drop the startsWith check → symlink test fails; restore by edit).
- [ ] **Step 6: Commit** `-m "feat(perch): dispatch/attach/control/files/workspace routes with confined serving"`

### Task 10: pi-lab permission-gating interactive-ask

**Files:**
- Modify (pi-lab, crow-mode): `~/pi-lab/extensions/permission-gating.ts`
- Test: pi-lab's own test harness (read `~/pi-lab/CLAUDE.md` + existing gating tests for the pattern); crow-side has no direct test (the engine already renders confirm cards — Task 5's ASK path is generic)

**Interfaces:**
- Produces: when the parsed policy has `interactive_ask === true` AND `process.env.PI_BOT_INTERACTIVE === "1"` AND `ctx.hasUI`, a would-be **policy block** from `botPolicyGate` (write outside write_paths, non-allowlisted bash, external send, confirm[] match — every block site in :114-184) becomes: `const ok = await ctx.ui.confirm("Crow bot asks", "<the block reason>. Allow this once?"); if (!ok) return {block:true, reason};` — allow-once on yes, the original block on no/undefined/timeout (fail-closed). Without the flag/env/UI: behavior byte-identical (the golden: existing gating tests all pass unchanged).
- NOTE: `--no-approve` and the destructive-op backstop (:239-380) are UNTOUCHED — spec §4.1.4's scope.

- [ ] **Step 1:** Read the file fully; write a pi-lab-side test: policy `{bash:"deny", write_paths:["/a"], interactive_ask:true}` + env set + fake ctx.ui.confirm→true allows one write outside /a; confirm→false blocks; env unset blocks without calling confirm.
- [ ] **Step 2-3: Implement; run pi-lab tests.**
- [ ] **Step 4: Commit + push pi-lab crow-mode** `-m "permission-gating: interactive-ask mode — policy blocks become ctx.ui confirms under PI_BOT_INTERACTIVE (fail-closed)"`.

**Wave 1 checkpoint:** full crow suite green from the worktree; commit count ~10; push branch, open no PR yet.

---

## Wave 2 — Board UI

### Task 11: Board data — strip endpoint, payload join, bird-state SSE

**Files:**
- Modify: `servers/gateway/routes/perch.js` (**one NEW endpoint `GET /roost`; the existing `GET /bots` :466-495 is untouched** — the lens dies in wave 3 and nothing else consumes it meanwhile), `servers/gateway/routes/streams.js` (:406-458 tick), `servers/gateway/dashboard/panels/bot-board/data-queries.js` + `html.js` (SSR join)
- Test: `tests/roost-strip-data.test.js` (new), extend the streams SSE test (find it: `grep -rln "board-config" tests/`)

**Interfaces:**
- Produces:
  - `GET /dashboard/perch-api/roost` (in perch.js): one query for all bot defs + `eng.list()` + per-session `snapshot` merge → `{birds: [{id, name, perch_attached, state, sessions: [{sessionId, state, cardId, pendingUi: bool, control}]}]}` where bird `state` is the spec §3.2 priority fold (waiting > working > hibernating > idle; `observing` when !perch_attached). Engine is the truth for awake/pending (spec §5.6); rows fill in hibernating/stopped and `card_id`. NO per-bot N+1: `eng.list()` once + one `bot_sessions` query for card_ids (`WHERE kind='perch-live' AND status != 'stopped'`). The payload also carries top-level `occupiedCardIds: [...]` (from the same query + `jobLockFor`-style job rows) — the Send-out card-picker's source of truth (review finding 15; hibernating claims deliberately don't LOCK, so the DOM's lock badges cannot tell the picker what will 409).
  - Board SSR: `data-queries.js` gains `liveBirdsByCard(engine, db)` → Map<cardId, {botId, state, sessionId}>; `html.js` renders a bird glyph span on card faces from it (class `bb-bird bb-bird--<state>`, PERCH_TOKENS-colored in `css.js`), plus `data-bird-sid` for the client.
  - SSE: inside the existing `tick()` in streams.js, alongside the cards diff, compute `birds = {<cardId>: {state, sid}}` from the engine singleton (import `getInteractiveEngine({createIfMissing:false})` — a gateway with no engine emits nothing) and on change emit a NAMED event: `sendRaw("event: bird-state\ndata: " + JSON.stringify(birds) + "\n\n")` — never in the default diffed payload (spec §5.6: the default event's client response is location.reload).
- [ ] **Step 1: Failing tests:** roost endpoint shape with fake engine + seeded rows (priority fold cases incl. observing); SSE test (existing harness): a bird-state frame arrives as its own named event and the default frame is unchanged byte-for-byte when only bird state changes.
- [ ] **Step 2-4: Implement; run; green.**
- [ ] **Step 5: Commit** `-m "feat(board): roost data endpoint, SSR bird join, named bird-state SSE event"`

### Task 12: Roost strip UI

**Files:**
- Modify: `servers/gateway/dashboard/panels/bot-board/html.js` (strip SSR above the board), `client.js` (strip refresh + actions), `css.js` (strip + bird styles on PERCH_TOKENS), `servers/gateway/dashboard/i18n.js` (new keys EN+ES)
- Test: `tests/roost-strip-ui.test.js` (new — parse-the-emitted-script + SSR substring tests, the board-panel-config.test.js idiom)

**Interfaces:**
- Consumes: Task 11's `/roost` + `bird-state` event.
- Produces: strip SSR (one `.bb-roost` div, one `.bb-roost-bird[data-bot]` per bot: glyph + name + state text); client: primary action per state (idle→Send out opens the card-picker dialog — cards from the DOM minus `/roost`'s `occupiedCardIds`, an optional note field, then `POST /bots/:id/dispatch {card_id, note}`; a raced 409 `card_occupied` is surfaced as the dialog's error line; working/hibernating→Open (drawer, Task 13); waiting→Answer (drawer); observing→link `/dashboard/bot-builder#<id>`), overflow menu (Talk → `POST /bots/:id/interactive` then open drawer; Sessions → drawer switcher; Recall → confirm + `POST /interactive/:sid/stop`; Setup link). `bird-state` SSE frames patch strip + card glyph classes in place (`el.className = "bb-bird bb-bird--" + state`) — never reload. All labels via the panel's i18n emission idiom (find how bot-board client currently emits translated strings — `grep -n "tJs\|i18n" servers/gateway/dashboard/panels/bot-board/*.js` — and follow it exactly).
- [ ] **Step 1: Failing tests:** SSR contains the strip for seeded bots with state classes; client.js emitted script parses (`new Function` on the extracted script — the Track 0 guard pattern, copy from `tests/board-panel-config.test.js`); bird-state handler updates class and never calls location.reload (assert the handler source has no `location.reload` in the bird-state branch by AST-lite regex on the extracted function).
- [ ] **Step 2-4: Implement; run; green. i18n keys in BOTH languages (run the parity test).**
- [ ] **Step 5: Commit** `-m "feat(board): roost strip — birds on a wire with state-driven actions"`

### Task 13: Session drawer — core

**Files:**
- Create: `servers/gateway/dashboard/panels/bot-board/drawer.js` (client-code module exporting the drawer's emitted-JS + CSS strings; keep client.js from growing past ~1500 lines)
- Modify: `client.js` (mount + open/close + hash `#bird=`/`#card=`), `html.js` (drawer shell container), `css.js` (import drawer styles), `servers/gateway/dashboard/i18n.js` (this task's strings EN+ES: "asleep — sending will wake it", "Answered:", "turn interrupted by gateway restart", steer/abort labels)
- Test: `tests/bird-drawer-core.test.js`

**Interfaces:**
- Consumes: existing `/interactive/:sid/events|message|answer|abort|stop`, transcript endpoint (`GET /bots/:id/sessions/:threadId/transcript`), Task 9 message images.
- Produces: right slide-over (`.bb-drawer`, `aria-modal`, ESC/backdrop close). Open paths: bird click, card bird click, `#bird=<sid>` on load, **and `#card=<id>`** (a new focus branch: scroll the card into view + open its bird's drawer if one is live — this is what Task 8's push click-URLs target; the no-JS `&card=` query contract at html.js:172/:403 stays untouched). Hash mechanics: the filter hash machinery at client.js:755-782 (`updateFilterHash`, keys `search|status|action`) **rewrites `location.hash` wholesale — extend it to parse and PRESERVE foreign keys (`bird`, `card`) when re-serializing**, or the drawer deep link dies the moment a filter is touched (review finding 7). Contents:
  - header: bot name, state badge, card link when the roost data has cardId (`/dashboard/bot-board#card=` stays the existing no-JS contract — the drawer link uses the hash the CLIENT understands; use the existing card-focus behavior), Stop in overflow;
  - transcript pane: on open, fetch transcript endpoint for history (row's threadId), then live-append from SSE events `text|tool|log|error|reply|state|plan_state` — parse frames BY EVENT NAME (each engine event arrives as its own named SSE event per the API's `stream.send(event.type, event)`); system notes for state/plan/model lines; copy button per reply/text block (`navigator.clipboard.writeText`);
  - composer: textarea + send. Idle → `POST message` (202). While a turn runs the button relabels to the steer affordance and sends to **`POST /interactive/:sid/steer`** (Task 9's route → `eng.steer(sessionId, text)` → `s.pi.send({type:"steer", message:text})` fire-and-forget, pi queues it into the running loop, plus a system note). Add the engine method in this task (3 lines + one engine test: frame sent, no waiter added, `no_turn` refusal when idle). Abort button beside the composer during a turn.
  - ask_user cards inline: render select options as buttons VERBATIM (the binding contract — echo the exact string via `POST answer {requestId, value}`), input/confirm/editor per the API's answer shapes (see engine `answer()` :956-980 for the payload fields), answered cards collapse to "Answered: <label>";
  - hibernating banner + wake-on-send; reconnect: `EventSource` onerror → close + reopen after 2s backoff ×5 → the subscribe replay restores state/pending card; `control='interrupted'` rows (from the sessions list fetch) render the interrupted system note.
- [ ] **Step 1: Failing tests:** emitted-script parse test for drawer.js; SSR shell substring; verbatim-echo contract test (extract the select-render + answer functions from the emitted source with a regex and assert the option string flows through untouched — the bots-page.mjs:853-877 contract restated); reconnect handler present and bounded (source assertions); engine steer test (frame sent, no waiter added).
- [ ] **Step 2-4: Implement; run; green.**
- [ ] **Step 5: Commit** `-m "feat(board): session drawer — transcript, composer/steer, question cards, reconnect"`

### Task 14: Drawer controls, files, attach, result gate, birds-on-cards polish

**Files:**
- Modify: `drawer.js`, `client.js`, `html.js` (result join projects result **id** — extend the SSR query at html.js:378-388), `css.js`, i18n EN+ES
- Test: `tests/bird-drawer-controls.test.js`, extend `tests/board-panel-config.test.js` interactions if its pinned substrings shift (preserve them — spec M17)

**Interfaces:**
- Consumes: Tasks 9 routes, Task 4/5 engine controls, existing `bot-board-api` decide/move endpoints (find the decide POST the dashboard client already uses: `grep -n "decide" servers/gateway/dashboard/panels/bot-board/client.js servers/gateway/routes/bot-board-api.js`).
- Produces:
  - controls row: model picker + thinking (populated from `GET options` when awake; disabled hibernating), permission mode select (guarded/ask/bypass) + plan toggle → `POST control`; when the response returns `bindsAtWake`, show the "applies at next wake — apply now" affordance → `POST cycle` (disabled when the state event says turn/pending — the drawer knows from SSE);
  - controls pane (collapsible): envelope fetch (`GET /bots/:id/envelope`) + narrowing checkboxes with the tri-state semantics — port the logic from `bots-page.mjs:433-509` INTO our idiom (POST `/bots/:id/sessions/:threadId/narrow {disabled_tools}`; note copy: "applies from the next wake" — T3-10 honesty);
  - files: attach button → base64 upload → uploaded images queue onto the next send's `images`; bot file links: `reply|text` content matching paths under `outputs/<sid>/` render as links to `GET workspace/<rel>`; image mimes render inline `<img>`;
  - attach-to-card: card picker (same dialog as dispatch) → `POST attach-card`; header updates;
  - result gate: when the SSR/refresh data shows a pending gated result for the session's card, drawer + card face show Accept/Reject → Accept: decide POST then the client's existing move-to-terminal call (two-step, spec §4); Reject: decide only. Card-face buttons: excluded from the `.bb-card` click-to-open handler (client.js:396-403) and dragstart (:534) via `closest("[data-result-actions]")` guards.
- [ ] **Step 1: Failing tests:** emitted-script parse still passes; source-level assertions: cycle button disabled-on-busy branch exists; Accept handler calls decide THEN move (order asserted in source); dragstart/click guards reference the result-actions container; narrowing tri-state note strings present EN+ES.
- [ ] **Step 2-4: Implement; run; green (including `tests/board-panel-config.test.js` untouched substrings).**
- [ ] **Step 5: Commit** `-m "feat(board): drawer controls/narrowing/files/attach + two-step result gate on card and drawer"`

### Task 15: New-UI string discipline test

**Files:**
- Create: `tests/board-i18n-literals.test.js`
- [ ] **Step 1:** Write the scan: read the EMITTED client sources of `client.js`/`drawer.js` (call the exported emit functions), strip the i18n-injected dictionary, and assert no bare user-facing English literal patterns from a curated list of this track's strings ("Send out", "Recall", "Answer", "asleep", "Attach to card", "applies at next wake", "Accept", "Reject", "needs you") appear OUTSIDE the i18n dictionary object — i.e., each of these strings must appear in i18n.js (both languages) and reach the client through the translation payload, not as a literal in the handler code. (The dictionary-only parity gate cannot see this — spec §8.)
- [ ] **Step 2-3:** Run (it should pass if Tasks 12-14 were disciplined; if it fails, fix the leaks). Mutation-test: hardcode one string in drawer.js → test fails; restore by edit.
- [ ] **Step 4: Commit** `-m "test(board): source-scanning literal check for roost/drawer strings"`

**Wave 2 checkpoint:** full suite; manual smoke in a scratch env (`CROW_HOME`/`CROW_DATA_DIR` set): `node servers/gateway/index.js --no-auth`, open the board, see the strip.

---

## Wave 3 — Retirement

### Task 16: Per-turn perch channel retirement (T3-8)

**Files:**
- Modify: `servers/gateway/routes/perch.js` (delete `POST /bots/:id/turn` :596-727, `GET /turns/:turnId/events` :729-740, the turn map/`sweepTurns`/`claimTurn` machinery — but KEEP `saveNarrowing`, sessions/envelope/transcript/`/roost` routes and `claimIsFresh` if the sessions route uses it), `tests/perch-routes.test.js` (remove the ~17 per-turn tests :278-603; keep the rest), `tests/perch-interactive-routes.test.js:694-701` (per-turn refusal case removed)
- [ ] **Step 1:** Delete routes + dead helpers (run `node --check` on the file; grep the file for now-unused imports).
- [ ] **Step 2:** Update tests; run the whole perch test set + suite.
- [ ] **Step 3: Commit** `-m "feat(perch)!: retire the per-turn perch chat channel (T3-8) — perch-live is the only interactive rail"`

### Task 17: Bundle/panel/supervisor retirement + migration + registry + docs (spec §6 inventory)

This is the wave the spec calls boot-and-CI-breaking if any item is missed. Work the inventory in order; suite after each step.

**Files (deletions):** `bundles/perch-hub/` (whole tree), `servers/gateway/perch-runtime.js`, `servers/gateway/dashboard/panels/perch.js`, `scripts/vendor-perch.mjs`, `tests/perch-runtime.test.js`, `tests/perch-panel.test.js`, `tests/vendor-perch.test.js`, `tests/perch-attach-warning.test.js`, `tests/perch-token-drift.test.js`, `docs/developers/perch-hub.md`
**Files (edits):** `servers/gateway/routes/bundles.js:43,196-197` (drop the import + calls), `servers/gateway/index.js:771-772` (drop `stopPerchRuntimeBounded`), `servers/gateway/boot/post-listen.js:266-274` (drop `initPerchRuntime`), `servers/gateway/routes/extension-proxy.js` (drop the perch-hub mount), `servers/gateway/dashboard/index.js:82,121` + `panels/bot-builder.js:18,46-51` + `bot-builder/wizard.js:29` + `bot-builder/api-handlers.js:14` (drop panels/perch imports; the not-installed banner/gate feature retires — bot-builder keeps only the attach/detach affordance), `tests/gateway-shutdown.test.js:93-140,247-283` + `tests/bundles-webui-lifecycle.test.js:162-215` (excise perch sections), `tests/perch-routes.test.js:901` (perch-hub.md assertion), `tests/i18n-global-parity.test.js:88-89` (`nav.perch` out of IDENTICAL_OK), `servers/gateway/dashboard/i18n.js` (~22 `perch.*` keys + `nav.perch`, both languages), `registry/add-ons.json` (REGENERATE: `npm run build-registry` — same commit), `docs/developers/port-allocation.md` (remove the 4210/4211/4141-4179 perch-hub rows by hand), `docs/.vitepress/config.ts:383` (sidebar link), `docs/guide/bot-builder.md` + `docs/es/guide/bot-builder.md` (rewrite the Perch walkthrough around the roost/drawer), `docs/developers/bot-engine.md:7,106,112` (inbound refs)
**Migration:** beside Task 8's back-fill: if `<CROW_HOME>/bundles/perch-hub/` exists, `rm -rf` it; delete `<CROW_HOME>/perch-token` if present; remove any `installed.json` perch-hub entry. Idempotent; guard-flagged like the Track 2 settings migration. **Before finalizing: check r4's install state** (`ssh` per the r4 constraints, look for `~/.crow-r4/bundles/perch-hub`) and note the finding in the commit message.
**Test:** `tests/perch-retirement.test.js` (new): migration idempotence (present-and-absent, runs twice); gateway boots in scratch env with no perch modules (`node servers/gateway/index.js --no-auth` smoke via the suite's boot-test idiom); grep-based guard: no source file under `servers/` imports `perch-runtime` or `panels/perch.js`.

- [ ] Step 1: importer edits + deletions; `node --check` every edited file; boot smoke.
- [ ] Step 2: test excisions + i18n keys + parity allowlist; run suite.
- [ ] Step 3: `npm run build-registry`; `node scripts/check-port-allocation.js`; docs edits; `cd docs && npm run build` (dead-link check).
- [ ] Step 4: migration + its test; full suite green.
- [ ] Step 5: final repo-wide sweep `grep -rn "perch-hub\|perch-runtime\|panels/perch" --include="*.js" --include="*.mjs" --include="*.ts" --include="*.md" .` → only historical docs/specs references remain (specs/plans/memory are records — leave them).
- [ ] Step 6: Commit in 2-3 positional-path commits (importers+deletions / tests+i18n+registry / docs+migration).

### Task 18: Finalization

- [ ] Full suite from the worktree; record the new count vs the 3423 floor + Task 16/17's deliberate retirements (the plan's replacement coverage must leave the floor's *spirit* intact — new tests ≥ retired tests; state the numbers in the PR body).
- [ ] `git push -u origin feat/track3-roost-board`; open the PR (GitHub MCP; never attribute Claude); verify check-runs all green (`suite`/`static-checks`/`audit`).
- [ ] Live acceptance AFTER merge+deploy, on r4 (spec §8): dispatch a bird onto a real card, steer, answer an ask card, receive the ntfy push, gate a result, move the accepted card. Log outcomes in the PR or the memory file.

---

## Review

**2026-08-16 — adversarial plan review (staff-engineer subagent): VERDICT REVISE → all findings applied, re-verdict not required (fixes are mechanical against cited evidence).**

- 8 critical fixed: card-brief golden corrected (User-said line sits MID-block, `userLine` param); `DEFAULT_MAX_AWAKE` 1→3 got its task (Task 7); steer got an HTTP route (Task 9) and the composer contradiction removed; sessions route now adds the missing `control` column (Task 9); dispatch fires the brief as turn 1 (decided: job-rail analog — the spec's acceptance script requires it); Task 6 names the bridge/tracker export changes; `#card=` opener + `updateFilterHash` foreign-key preservation added (Task 13); wake model override moved BEFORE warmModel with `s.resolved` corrected and warm/metering asserted (Task 4).
- Suggestions applied: real `model_select`/plan-mode payload shapes pinned (`model.id`, `enabled`); `/plan on|off` never bare toggle + wake priming via `plan-mode:get`; eviction re-checks the host pi budget post-close; `tasksDbPath()` + cards-only scope (decided); permission-mode system note; `hadTurn` captured before the null; card-picker reads `/roost` `occupiedCardIds`; Task 13 files include i18n.js; Task 11 is one new `/roost` endpoint; Task 1's misleading outer-filter instruction removed.
- Questions decided by the operator's standing arc authority, named for veto: (1) dispatch starts work unprompted; (2) Track 3 dispatch/attach are cards-only; (3) agent-end pushes suppressed while an SSE subscriber is attached.

## Self-review notes (already applied)

- Steer needed a real engine method (Task 13) — pi's `steer` RPC exists; fire-and-forget is honest because pi queues steer text into the running loop.
- Permission-mode restart semantics (reset to guarded on adopt) are named in Task 4 and must be mirrored in the drawer copy (Task 14 shows current mode from state events, so the reset is visible).
- The card-brief golden (Task 2) deliberately ends before the channel-specific tail; the engine's dispatch composition (Task 6) reuses the block + its own outputs line — the spec's "byte-identical at the scoped block" is exactly this.
- `?card=` full-page contract untouched (Task 13 uses the client hash the existing code owns; push URLs use `#bird=`/`#card=` hashes — Task 8's action_urls).

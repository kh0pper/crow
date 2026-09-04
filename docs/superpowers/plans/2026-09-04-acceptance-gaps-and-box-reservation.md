# Acceptance-gap fixes + box-reservation scheduling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **SHIPPED 2026-09-04:** PR A = #300, PR B = #299, PR C = #301, PR D = pi-lab `9502dc6`; test-hygiene follow-up #302. Deployed to both crow gateways and live-verified (409 refusal, no start). Deviations are recorded in each PR's description.

**Goal:** Close the four product gaps surfaced by the Track 3 live acceptance (PR #298 comment) and build the box-reservation mechanism so unattended GPU windows and on-demand bot model starts stop colliding.

**Architecture:** Four independent PRs. **PR A** (crow) fixes the dispatch brief, the board MCP auto-mount, the empty steer, and cycle feedback. **PR B** (crow) adds requester attribution to every model-start decision (log-only). **PR C** (crow) adds a tmpfs reservation file the gpu-orchestrator honors before *any* start, a typed `ReservedError`, degrade-not-stall behavior in every caller, notifications, and a CLI. **PR D** (pi-lab) makes `dsv4-window.sh` write/clear the reservation and fixes the teardown-note mislabel. A and B/C are independent; C depends on B only for the `requester` string it logs (C can inline `"-"` if B is not merged yet).

**Tech Stack:** Node 22 (`~/.nvm/versions/node/v22.23.1/bin` — ALWAYS on PATH for `npm test`; the login shell defaults to node 20 and one perch test fails there), node:test, better-sqlite3, express. pi-lab side: bash + node:test.

**Spec:** `docs/superpowers/specs/2026-09-04-box-reservation-scheduling-scope.md` (§3 design, §6 decisions — Kevin accepted: reservations win; 8 h default max hold with `--force` to exceed; `crow-embed` exempt via default allow). Gap list: PR #298 comment "Live acceptance on r4".

## Global Constraints

- Commit with a positional path: `git commit <paths> -m "..."` — never `git add` + bare `git commit`. Verify with `git show --stat HEAD`.
- No Claude attribution in commit messages or PR bodies (operator rule).
- CI must be green before merge (`suite`, `static-checks`, `audit`); query `/commits/<sha>/check-runs`.
- Every user-facing dashboard string needs BOTH `en` and `es` in `servers/gateway/dashboard/shared/i18n.js` (global i18n parity gate).
- No schema change anywhere in this plan (no `SCHEMA_GENERATION` bump).
- Panel client.js / drawer.js are emitted as template literals: no backticks inside them; escapes are double-escaped.
- Work in a worktree per PR: `git worktree add ~/crow-wt-<name> -b <branch> origin/main`, then `npm ci` (WITH scripts — `--ignore-scripts` breaks better-sqlite3) under node 22.
- Reservation file path is `process.env.CROW_BOX_RESERVATION_PATH || /run/user/<uid>/crow-box-reservation.json` on BOTH sides (crow reads, pi-lab writes) — the env override is the test seam.

---

# PR A — acceptance-gap fixes (branch `fix/track3-acceptance-gaps`)

### Task A1: card brief carries title + description

**Files:**
- Modify: `scripts/pi-bots/card-brief.mjs`
- Modify: `scripts/pi-bots/tracker.mjs` (add `cardText`)
- Modify: `scripts/pi-bots/bridge.mjs:766` (pass `cardText`)
- Modify: `servers/gateway/perch-interactive.js:1590-1598` (pass `cardText`; `S.cardText` seam)
- Modify: `servers/gateway/perch-interactive.js` `loadSeams()` (export `cardText` from tracker like `cardStatus`)
- Test: `tests/card-brief.test.js`, `tests/perch-interactive-dispatch.test.js` (seam fake)

**Interfaces:**
- Produces: `cardText(cardId, tasksDbPath) -> { title: string, description: string|null }` in `tracker.mjs` (reads `tasks_items.title, description`; `{title:"", description:null}` when the row is missing).
- `cardBriefBlock({ cardId, tasksDbPath, userLine, planForCard, cardStatus, boardVocab, cardText })` — `cardText` optional; when absent behaves as `{title:"",description:null}`.

- [x] **Step 1: Replace the golden in `tests/card-brief.test.js` with the new shape and add the no-plan case**

```js
test("card brief carries the card's title and description above the plan", () => {
  const expected =
    "Work the following card.\n\nCARD #42 — Fix the login redirect (current board status: todo; this board's statuses: todo, doing, done).\n" +
    "DESCRIPTION:\n---\nUsers land on /dashboard/login twice.\n---\nPLAN:\n---\n" +
    "PLAN BODY\n---\n\nUser said: \"do card 42\"\n\n" +
    "Do the work the plan describes; if there is no plan, do what the card's title and description ask. You may use board_move_item to update this card's status " +
    "as you go (only ever use this board's statuses). When you are done, call board_report_result " +
    "with item_id=42, an outcome of success/failure/partial, and a summary_md describing " +
    "what you did — that call is what ends the run, not a status write.";
  const got = cardBriefBlock({
    cardId: 42, tasksDbPath: "/x", userLine: 'do card 42',
    planForCard: () => "PLAN BODY",
    cardStatus: () => "todo",
    boardVocab: () => ({ statuses: ["todo", "doing", "done"], terminals: ["done"] }),
    cardText: () => ({ title: "Fix the login redirect", description: "Users land on /dashboard/login twice." }),
  });
  assert.equal(got, expected);
});

test("no plan + no description: both blocks say so, title still present", () => {
  const got = cardBriefBlock({
    cardId: 7, tasksDbPath: "/x", userLine: "Work this card.",
    planForCard: () => null, cardStatus: () => "pending",
    boardVocab: () => ({ statuses: ["pending", "done"], terminals: ["done"] }),
    cardText: () => ({ title: "Say hello", description: null }),
  });
  assert.match(got, /^Work the following card\.\n\nCARD #7 — Say hello \(current board status: pending; this board's statuses: pending, done\)\.\nDESCRIPTION:\n---\n\(none\)\n---\nPLAN:\n---\n\(no plan\)\n---\n/);
});

test("cardText omitted (legacy caller): no title dash, description (none)", () => {
  const got = cardBriefBlock({
    cardId: 9, tasksDbPath: "/x", userLine: "x",
    planForCard: () => "P", cardStatus: () => "todo",
    boardVocab: () => ({ statuses: ["todo"], terminals: [] }),
  });
  assert.match(got, /^Work the following card\.\n\nCARD #9 \(current board status: todo; this board's statuses: todo\)\.\nDESCRIPTION:\n---\n\(none\)\n---\n/);
});
```

Delete the old "byte-identical to the bridge's historical block" test (its golden is superseded; the bridge and the engine both call this builder, so byte-identity between the two callers is still guaranteed by construction).

- [x] **Step 2: Run** `node --test tests/card-brief.test.js` → FAIL (title not rendered).

- [x] **Step 3: Implement**

`scripts/pi-bots/tracker.mjs` (beside `cardStatus`):
```js
/** Track 3 acceptance F1: the card's own words for the dispatch brief. */
export function cardText(cardId, tasksDbPath) {
  const path = tasksDbPath || TASKS_DB;
  const t = db(path);
  try {
    const r = t.prepare("SELECT title, description FROM tasks_items WHERE id=?").get(cardId);
    return { title: r && r.title ? String(r.title) : "", description: r && r.description ? String(r.description) : null };
  } finally { t.close(); }
}
```

`scripts/pi-bots/card-brief.mjs`:
```js
export function cardBriefBlock({ cardId, tasksDbPath, userLine, planForCard, cardStatus, boardVocab, cardText }) {
  const vocab = boardVocab(cardId, tasksDbPath);
  const planBody = planForCard(cardId);
  const text = typeof cardText === "function" ? (cardText(cardId, tasksDbPath) || {}) : {};
  const title = text.title ? " — " + String(text.title).replace(/\s+/g, " ").trim() : "";
  const desc = text.description ? String(text.description).trim() : "(none)";
  return "Work the following card.\n\nCARD #" + cardId + title +
    " (current board status: " + cardStatus(cardId, tasksDbPath) + "; this board's statuses: " + vocab.statuses.join(", ") + ").\n" +
    "DESCRIPTION:\n---\n" + desc + "\n---\nPLAN:\n---\n" +
    (planBody || "(no plan)") + "\n---\n\nUser said: \"" + userLine + "\"\n\n" +
    "Do the work the plan describes; if there is no plan, do what the card's title and description ask. You may use board_move_item to update this card's status " +
    "as you go (only ever use this board's statuses). When you are done, call board_report_result " +
    "with item_id=" + cardId + ", an outcome of success/failure/partial, and a summary_md describing " +
    "what you did — that call is what ends the run, not a status write.";
}
```

Callers: in `bridge.mjs` import `cardText` from `./tracker.mjs` and add `cardText` to the `cardBriefBlock({...})` call at :766. In `perch-interactive.js` add `cardText` to the tracker import inside `loadSeams()` (grep `cardStatus` there — same object) and pass `cardText: S.cardText` at :1590. In `tests/perch-interactive-dispatch.test.js` the seams fake (around :139 "Dispatch-brief seams") gains `cardText: () => ({ title: "T", description: null })`.

- [x] **Step 4: Run** `node --test tests/card-brief.test.js tests/perch-interactive-dispatch.test.js tests/bridge-board-rail.test.js` → PASS. Grep the suite for any other golden containing `"Work the following card."` (`grep -rn "Work the following card" tests/`) and update it to the new shape.

- [x] **Step 5: Commit** `git commit scripts/pi-bots/card-brief.mjs scripts/pi-bots/tracker.mjs scripts/pi-bots/bridge.mjs servers/gateway/perch-interactive.js tests/card-brief.test.js tests/perch-interactive-dispatch.test.js -m "fix(board): dispatch brief carries the card's title and description (acceptance F1)"`

### Task A2: card-bound sessions always get the board MCP entry

**Files:**
- Modify: `scripts/pi-bots/mcp_writer.mjs:157-165` (`buildBotMcp` honors `opts.ensureServers`), `:258-281` (`writeBotMcp` forwards `opts.ensureServers`)
- Modify: `scripts/pi-bots/bot-world.mjs:65,119` (`buildBotWorld({..., cardBound = false})` → `ensureServers: (jobId || cardBound) ? ["board"] : []`)
- Modify: `servers/gateway/perch-interactive.js:1001-1003` (pass `cardBound: !!s.cardId`)
- Test: `tests/mcp-writer-ensure-servers.test.js` (create), `tests/bot-world.test.js`

**Interfaces:**
- `buildBotMcp(def, canonical, { ensureServers?: string[] })` — names in `ensureServers` are unioned into the selection BEFORE catalog resolution; a name absent from both catalog and canonical produces the same soft warning as a selected-but-absent server.
- `writeBotMcp(def, { ensureServers?: string[] })` — forwarded.
- `buildBotWorld({ botId, threadId, gatewayType, log, jobId, cardBound })`.

- [x] **Step 1: Test** `tests/mcp-writer-ensure-servers.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBotMcp } from "../scripts/pi-bots/mcp_writer.mjs";

const canonical = { mcpServers: { tasks: { command: "node", args: ["x"] } } };
const catalog = {
  tasks: { command: "node", args: ["server/index.js"], env: {} },
  board: { url: "http://127.0.0.1:3001/board/mcp", headers: { Authorization: "Bearer t" } },
};

test("ensureServers adds the board entry even when the def never selected board/*", () => {
  const def = { tools: { crow_mcp: ["tasks/tasks_list"] } };
  const r = buildBotMcp(def, canonical, { catalog, unconfigured: {}, ensureServers: ["board"] });
  assert.deepEqual(r.json.mcpServers.board, catalog.board);
  assert.ok(r.servers.includes("board"));
});

test("without ensureServers the board entry is NOT minted (unchanged closed-world behavior)", () => {
  const def = { tools: { crow_mcp: ["tasks/tasks_list"] } };
  const r = buildBotMcp(def, canonical, { catalog, unconfigured: {} });
  assert.equal(r.json.mcpServers.board, undefined);
});

test("ensureServers with an unconfigured board (no token) disables it with the catalog's reason, never throws", () => {
  const def = { tools: { crow_mcp: [] } };
  const r = buildBotMcp(def, canonical, { catalog: { tasks: catalog.tasks }, unconfigured: { board: "board token not found" }, ensureServers: ["board"] });
  assert.deepEqual(r.json.mcpServers.board, { disabled: true });
  assert.ok(r.warnings.some((w) => /board token not found/.test(w)));
});
```

And in `tests/bot-world.test.js` add (using that file's existing scratch-home fixture pattern for a def with a session_dir):
```js
test("buildBotWorld(cardBound:true) mints the board entry; default does not", async () => {
  // reuse the file's def/scratch helpers; write a board-token file into the scratch CROW_HOME first:
  // writeFileSync(join(SCRATCH_HOME, "board-token"), "tok\n")
  const a = await buildBotWorld({ botId, threadId: "t-a", gatewayType: "perch", cardBound: true });
  const mcpA = JSON.parse(readFileSync(join(a.sessionDir, ".mcp.json"), "utf8"));
  assert.ok(mcpA.mcpServers.board && !mcpA.mcpServers.board.disabled);
  const b = await buildBotWorld({ botId, threadId: "t-b", gatewayType: "perch" });
  const mcpB = JSON.parse(readFileSync(join(b.sessionDir, ".mcp.json"), "utf8"));
  assert.ok(!mcpB.mcpServers.board || mcpB.mcpServers.board.disabled);
});
```
(Read `tests/bot-world.test.js` first for the fixture names; `world.sessionDir` is the field `buildBotWorld` returns — confirm with `grep -n "sessionDir" scripts/pi-bots/bot-world.mjs`.)

- [x] **Step 2: Run** → FAIL (board undefined).

- [x] **Step 3: Implement** — `buildBotMcp`: `const want = [...new Set([...serversForBot(def), ...((opts.ensureServers || []).filter((n) => typeof n === "string" && n))])];`. `writeBotMcp`: add `ensureServers: opts.ensureServers` to the `buildBotMcp(def, canonical, {...})` opts. `bot-world.mjs`: signature `{ botId, threadId, gatewayType = "perch", log = () => {}, jobId = null, cardBound = false }` and `writeBotMcp(def, { sessionDir, crowHome, remoteEnabled, peerGatewayUrls, botId, jobId, ensureServers: (jobId || cardBound) ? ["board"] : [] })`. `perch-interactive.js:1001`: `buildWorldSerialized(S, { botId: s.botId, threadId: s.threadId, gatewayType: "perch", log: slog, cardBound: !!s.cardId })`. Add a one-line comment at each site: "acceptance F2: a card-bound session must be able to call board_report_result".

- [x] **Step 4: Run** `node --test tests/mcp-writer-ensure-servers.test.js tests/bot-world.test.js tests/pibot-mcp-instance-binding.test.js tests/remote-mcp-writer.test.js tests/perch-interactive-dispatch.test.js` → PASS.

- [x] **Step 5: Commit** `git commit scripts/pi-bots/mcp_writer.mjs scripts/pi-bots/bot-world.mjs servers/gateway/perch-interactive.js tests/mcp-writer-ensure-servers.test.js tests/bot-world.test.js -m "fix(perch): card-bound sessions always mount the board MCP entry (acceptance F2)"`

### Task A3: empty steer is a 400

**Files:**
- Modify: `servers/gateway/perch-interactive.js:1621-1632` (`steer` throws `engineError("empty_message")` when the trimmed message is empty)
- Modify: `servers/gateway/routes/perch-interactive-api.js` `ERROR_MAP` (add `empty_message: [400, "empty_message"]` — read the map's existing entry shape first: `grep -n "ERROR_MAP = " -A12 servers/gateway/routes/perch-interactive-api.js`)
- Test: `tests/perch-interactive-controls.test.js` (engine), `tests/perch-interactive-routes.test.js` (route)

- [x] **Step 1: Tests** — engine (next to the existing steer tests in `perch-interactive-controls.test.js`, using that file's `makeEngine()`/`spawned()` helpers and a session with an in-flight turn):
```js
test("steer: empty / whitespace message is refused with empty_message and nothing is sent to pi", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const p = engine.message(s.sessionId, "go"); // turn in flight
  const pi = state.instances[0];
  const before = pi.sent.length;
  await assert.rejects(() => engine.steer(s.sessionId, "   "), (e) => e.code === "empty_message");
  assert.equal(pi.sent.length, before);
  pi.emit({ type: "agent_end" }); await p;
});
```
Route (in `perch-interactive-routes.test.js`, using its fake-engine harness — find the existing steer route test and copy its setup): POST `/dashboard/perch-api/interactive/<sid>/steer` with `{}` → 400 and body `{ error: "empty_message" }`; with `{ message: "go left" }` → 200 and the fake engine's `steer` called with `"go left"`.

- [x] **Step 2: Run** → FAIL.

- [x] **Step 3: Implement** — in `steer()`: `const message = String(text == null ? "" : text); if (!message.trim()) throw engineError("empty_message");` placed BEFORE the `no_turn`/`pi_gone` checks so a client bug is reported even when no turn is running. Add the `ERROR_MAP` row.

- [x] **Step 4: Run** `node --test tests/perch-interactive-controls.test.js tests/perch-interactive-routes.test.js` → PASS.

- [x] **Step 5: Commit** `git commit servers/gateway/perch-interactive.js servers/gateway/routes/perch-interactive-api.js tests/perch-interactive-controls.test.js tests/perch-interactive-routes.test.js -m "fix(perch): empty steer is a 400, never a silent no-op (acceptance F3)"`

### Task A4: cycle/wake progress is visible in the drawer

**Files:**
- Modify: `servers/gateway/perch-interactive.js` `cycle()` (:1666-1700) and `startChild()` (:998-1012)
- Test: `tests/perch-interactive-controls.test.js`

The drawer already renders `log` events (`drawer.js:798`), so this is engine-only: emit log lines at the three moments an operator waits on.

- [x] **Step 1: Test** (controls test file; the fake engine's `emit` history is available as the SSE subscriber array the existing cycle tests use — copy their subscription setup):
```js
test("cycle emits progress log lines: cycling, world rebuilt, model warm, context re-read warning", async () => {
  const { engine } = makeEngine();
  const s = await spawned(engine);
  const logs = [];
  const unsub = engine.subscribe(s.sessionId, (ev) => { if (ev.type === "log") logs.push(ev.text); });
  await engine.cycle(s.sessionId);
  unsub();
  assert.ok(logs.some((t) => /^cycling: stopping the child/.test(t)), logs.join("|"));
  assert.ok(logs.some((t) => /^world rebuilt/.test(t)), logs.join("|"));
  assert.ok(logs.some((t) => /^model warm:/.test(t)), logs.join("|"));
  assert.ok(logs.some((t) => /re-reads its full transcript/.test(t)), logs.join("|"));
});
```
(Confirm the subscribe API name with `grep -n "function subscribe" servers/gateway/perch-interactive.js`; if it is `attach`/`onEvent`, use that name in the test.)

- [x] **Step 2: Run** → FAIL.

- [x] **Step 3: Implement** — in `cycle()` right after `s.cycling = true;`: `emit(s, { type: "log", text: "cycling: stopping the child and rebuilding its world (spawn-bound settings apply now)" });`. In `startChild()` after `buildWorldSerialized` resolves: `slog("world rebuilt: " + Object.keys(world.mcpServers || {}).length + " MCP server(s) minted" )` — if `world` does not expose the minted list, use `slog("world rebuilt")`. After `prepareSpawn` (the warm happens inside it — `grep -n "warm" servers/gateway/perch-interactive.js` for the exact line that logs `warm crow-local → 200`): `slog("model warm: " + (s.currentModel || (s.resolved && s.resolved.key) || "?"))`. At the end of `cycle()` before `return`: `emit(s, { type: "log", text: "ready — the first turn re-reads its full transcript, which can take a minute on long sessions" });`.

- [x] **Step 4: Run** `node --test tests/perch-interactive-controls.test.js tests/perch-interactive.test.js` → PASS.

- [x] **Step 5: Commit** `git commit servers/gateway/perch-interactive.js tests/perch-interactive-controls.test.js -m "feat(perch): cycle/wake progress log lines for the drawer (acceptance F4)"`

### Task A5: PR A gate

- [x] `PATH=~/.nvm/versions/node/v22.23.1/bin:$PATH npm test` → all pass (floor 3615 + new tests, 0 fail).
- [x] `node scripts/check-port-allocation.js && node scripts/build-registry.mjs --check` → OK.
- [x] Push branch, open PR "fix: Track 3 acceptance gaps F1–F4 (brief text, board auto-mount, empty steer, cycle feedback)", body lists the four gaps with the PR #298 comment link. Wait for green check-runs, merge (merge commit), delete branch.

---

# PR B — requester attribution (branch `feat/model-start-attribution`)

### Task B1: `requesterTag(req)` and log it on every route decision and start

**Files:**
- Create: `servers/gateway/requester-tag.js`
- Modify: `servers/gateway/routes/llm-router.js:219,231` (compute tag, pass `{ requester }` to `maybeAcquireLocalProvider`, include in the route log)
- Modify: `servers/gateway/routes/llm-router.js:332-340` (`/llm/acquire` passes requester too — it calls `warmProviderByName(name)`; extend to `warmProviderByName(name, { requester })`)
- Modify: `servers/gateway/gpu-orchestrator.js:496-501` (`warmProviderByName(name, opts)` forwards opts), `:986,:1125` (start log lines append ` requested-by=<tag>`), `:431` (`maybeAcquireLocalProvider` already takes opts — nothing to change)
- Modify: `servers/gateway/routes/chat.js:703` (`maybeAcquireLocalProvider(effectiveProvider, { requester: "dashboard-chat" })`), `servers/gateway/routes/models.js:588` (add `requester: "models-panel"` to the existing opts object)
- Modify: `scripts/pi-bots/warm.mjs:31-36` (header `"x-crow-client": "pibot-warm/" + (process.env.PIBOT_BOT_ID || "bot")` — check the env var the bridge exports for the bot id: `grep -n "PIBOT_BOT_ID\|BOT_ID" scripts/pi-bots/bridge.mjs | head`; if none exists, use `"pibot-warm"`)
- Test: `tests/requester-tag.test.js` (create)

**Interfaces:**
- `requesterTag(req) -> string` — `"<ip> ua=<first 40 chars of user-agent or -> client=<x-crow-client or ->"`; never throws; `req` may be `{}`.
- `acquireProvider(name, { requester })`: log lines `starting <name> (bundleId=…) requested-by=<requester|->`.

- [x] **Step 1: Test**
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { requesterTag } from "../servers/gateway/requester-tag.js";

test("requesterTag: ip + ua + client, bounded, dash for missing", () => {
  assert.equal(requesterTag({}), "- ua=- client=-");
  assert.equal(
    requesterTag({ ip: "::ffff:10.0.0.5", headers: { "user-agent": "x".repeat(60), "x-crow-client": "companion" } }),
    "10.0.0.5 ua=" + "x".repeat(40) + " client=companion"
  );
  assert.equal(requesterTag({ ip: "127.0.0.1", headers: { "x-crow-client": "a b\nc" } }), "127.0.0.1 ua=- client=a_b_c");
});
```

- [x] **Step 2: Run** → FAIL (module missing).

- [x] **Step 3: Implement** `servers/gateway/requester-tag.js`:
```js
/** Who asked for a model? /llm/v1 is unauthenticated by design (companion is
 * loopback), so attribution is whatever the request carries: peer ip, a
 * bounded user-agent, and the optional X-Crow-Client tag first-party clients set. */
export function requesterTag(req) {
  const h = (req && req.headers) || {};
  const ip = String((req && req.ip) || "").replace(/^::ffff:/, "") || "-";
  const ua = String(h["user-agent"] || "").replace(/\s+/g, " ").trim().slice(0, 40) || "-";
  const client = String(h["x-crow-client"] || "").replace(/[^A-Za-z0-9._/-]+/g, "_").slice(0, 40) || "-";
  return `${ip} ua=${ua} client=${client}`;
}
```
Router: `const requester = requesterTag(req);` before the acquire; `await maybeAcquireLocalProvider(providerId, { requester });`; log line becomes `` `[llm-router] route=… -> ${key} (${up.model}) stream=${!!body.stream} requester=${requester}` ``. Orchestrator: in `acquireProvider` the two `console.log(\`[gpu-orchestrator] starting …\`)` lines (docker path :986 and, inside `startNativeAndAwaitReady` :703, via `opts.requester`) append `` ` requested-by=${opts.requester || "-"}` ``; `ensureResident` logs `requested-by=residency`. `warmProviderByName(name, opts = {})` → `maybeAcquireLocalProvider(target, opts)`.

- [x] **Step 4: Run** `node --test tests/requester-tag.test.js tests/gpu-orchestrator-native.test.js tests/gpu-orchestrator-host-gate.test.js tests/chat-native-copy.test.js tests/models-panel.test.js` → PASS.

- [x] **Step 5: Commit** `git commit servers/gateway/requester-tag.js servers/gateway/routes/llm-router.js servers/gateway/gpu-orchestrator.js servers/gateway/routes/chat.js servers/gateway/routes/models.js scripts/pi-bots/warm.mjs tests/requester-tag.test.js -m "feat(gpu-orchestrator): attribute every model start to its requester (log-only)"`

### Task B2: PR B gate — full suite under node 22, static checks, PR "feat: model-start requester attribution", CI green, merge.

---

# PR C — box reservation (branch `feat/box-reservation`; branch from main AFTER PR B merges)

### Task C1: reservation reader + `ReservedError`

**Files:**
- Create: `servers/gateway/box-reservation.js`
- Test: `tests/box-reservation.test.js` (create)

**Interfaces (used by C2–C6):**
```js
export const DEFAULT_MAX_HOLD_MS = 8 * 60 * 60 * 1000;
export const DEFAULT_ALLOW = ["crow-embed"];           // Kevin decision 3
export function reservationPath()                       // env CROW_BOX_RESERVATION_PATH || /run/user/<uid>/crow-box-reservation.json
export function readReservation({ now = Date.now(), path = reservationPath() } = {})
  // -> null (no file, or expired) | { owner, reason, started_at, expires_at, allow: string[], corrupt: boolean, key }
  //    corrupt file -> { owner:"unknown", reason:"unreadable reservation file", started_at:null, expires_at:null, allow:[], corrupt:true, key:"corrupt" }
  //    key = `${owner}@${started_at}` (stable id for once-per-reservation notices)
  //    allow = DEFAULT_ALLOW ∪ file.allow
export function isStartAllowed(reservation, providerName) // true when no reservation, or providerName ∈ allow
export class ReservedError extends Error { code = "box_reserved"; owner; expires_at; provider; http = 503 }
export function writeReservation({ owner, reason, minutes, allow = [], force = false, now = Date.now(), path = reservationPath() })
  // -> the record written; throws RangeError("hold exceeds 8h; pass force") when minutes*60000 > DEFAULT_MAX_HOLD_MS && !force
export function clearReservation({ path = reservationPath() } = {})  // -> true if removed
```
Cache: `readReservation` memoizes by `(path, mtimeMs)` for 2 s so hot paths don't stat on every request; parse errors are NOT cached.

- [x] **Step 1: Tests** `tests/box-reservation.test.js` (temp dir, `CROW_BOX_RESERVATION_PATH` passed explicitly as `path`):
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReservation, isStartAllowed, writeReservation, clearReservation, ReservedError, DEFAULT_ALLOW } from "../servers/gateway/box-reservation.js";

const dir = mkdtempSync(join(tmpdir(), "box-res-"));
const path = join(dir, "r.json");
const T0 = Date.parse("2026-09-04T20:00:00Z");

test("no file -> null; expired -> null; live -> record with default allow", () => {
  assert.equal(readReservation({ path, now: T0 }), null);
  writeFileSync(path, JSON.stringify({ owner: "win", reason: "bench", started_at: new Date(T0).toISOString(), expires_at: new Date(T0 + 1000).toISOString(), allow: [] }));
  assert.equal(readReservation({ path, now: T0 + 2000 }), null);
  const r = readReservation({ path, now: T0 + 500 });
  assert.equal(r.owner, "win");
  assert.deepEqual(r.allow, DEFAULT_ALLOW);
  assert.equal(r.key, "win@" + new Date(T0).toISOString());
});

test("corrupt file -> reserved (fail closed) and flagged", () => {
  writeFileSync(path, "{not json");
  const r = readReservation({ path, now: T0 });
  assert.equal(r.corrupt, true);
  assert.equal(isStartAllowed(r, "crow-chat"), false);
});

test("isStartAllowed: null reservation allows; allow list + default allow", () => {
  assert.equal(isStartAllowed(null, "crow-chat"), true);
  const r = { allow: ["crow-embed", "my-heavy"] };
  assert.equal(isStartAllowed(r, "my-heavy"), true);
  assert.equal(isStartAllowed(r, "crow-embed"), true);
  assert.equal(isStartAllowed(r, "crow-chat"), false);
});

test("writeReservation enforces the 8h default max unless force; clearReservation removes", () => {
  assert.throws(() => writeReservation({ owner: "k", reason: "serve", minutes: 9 * 60, path, now: T0 }), RangeError);
  const rec = writeReservation({ owner: "k", reason: "serve", minutes: 9 * 60, force: true, path, now: T0 });
  assert.equal(rec.expires_at, new Date(T0 + 9 * 3600 * 1000).toISOString());
  assert.equal(readReservation({ path, now: T0 + 60_000 }).owner, "k");
  assert.equal(clearReservation({ path }), true);
  assert.equal(existsSync(path), false);
  assert.equal(clearReservation({ path }), false);
});

test("ReservedError carries code/http/owner/expires_at/provider", () => {
  const e = new ReservedError({ owner: "win", expires_at: "2026-09-04T21:00:00Z" }, "crow-chat");
  assert.equal(e.code, "box_reserved"); assert.equal(e.http, 503);
  assert.equal(e.owner, "win"); assert.equal(e.provider, "crow-chat");
  assert.match(e.message, /reserved by win until 2026-09-04T21:00:00Z/);
});
```

- [x] **Step 2: Run** → FAIL. **Step 3: Implement** the module exactly per the interface block (use `readFileSync`/`statSync`/`writeFileSync` with a temp file + `renameSync` for atomic writes, `unlinkSync` for clear; `process.getuid()` for the default path). **Step 4: Run** → PASS. **Step 5: Commit** `git commit servers/gateway/box-reservation.js tests/box-reservation.test.js -m "feat(box-reservation): reservation file reader/writer + ReservedError"`.

### Task C2: orchestrator honors the reservation before every start

**Files:**
- Modify: `servers/gateway/gpu-orchestrator.js`: `acquireProvider` (docker path — before the siblings loop; native path — inside `acquireOrStartNative` before it would call `startNativeAndAwaitReady`), `ensureResident`, `retryDeferredResidents`, `checkIdleRevert`
- Test: `tests/gpu-orchestrator-reservation.test.js` (create; copy the fixture/injection style of `tests/gpu-orchestrator-host-gate.test.js`)

**Interfaces:**
- `acquireProvider(name, opts)` throws `ReservedError` when `readReservation()` is non-null, the provider is not ready, and `!isStartAllowed(r, name)`. Ready providers are never affected.
- `_setReservationReaderForTest(fn|null)` — test seam; production uses `readReservation` from C1.
- `ensureResident`/`retryDeferredResidents`/`checkIdleRevert`: while reserved, skip starts, `console.log` once per `reservation.key` `"[gpu-orchestrator] residency deferred: box reserved by <owner> until <expires_at>"`, and return `false`/`[]`.

- [x] **Step 1: Tests**
```js
// tests/gpu-orchestrator-reservation.test.js
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as orch from "../servers/gateway/gpu-orchestrator.js";
import { ReservedError } from "../servers/gateway/box-reservation.js";

const RES = { owner: "win", reason: "bench", started_at: "2026-09-04T20:00:00Z", expires_at: "2026-09-04T23:00:00Z", allow: ["crow-embed"], corrupt: false, key: "win@2026-09-04T20:00:00Z" };
const cfg = { providers: { "crow-chat": { bundleId: "llamacpp-vulkan-qwen36-35b-a3b", baseUrl: "http://127.0.0.1:8003", host: "local" },
                           "crow-embed": { bundleId: "llamacpp-vulkan-qwen3-embed", baseUrl: "http://127.0.0.1:8005", host: "local" } } };
// isLocallyOrchestratable must see 127.0.0.1 as own — copy how gpu-orchestrator-host-gate.test.js pins ownAddrs (its opts/env seam).

beforeEach(() => orch._setReservationReaderForTest(null));

test("reserved + provider not ready + not allowed -> ReservedError, bundleUp never called", async () => {
  orch._setReservationReaderForTest(() => RES);
  let started = 0;
  await assert.rejects(
    () => orch.acquireProvider("crow-chat", { cfg, probeReadyFn: async () => false, bundleUpFn: async () => { started++; }, waitForReadyFn: async () => true }),
    (e) => e instanceof ReservedError && e.owner === "win" && e.provider === "crow-chat"
  );
  assert.equal(started, 0);
});

test("reserved + provider already ready -> true, no start", async () => {
  orch._setReservationReaderForTest(() => RES);
  const r = await orch.acquireProvider("crow-chat", { cfg, probeReadyFn: async () => true, bundleUpFn: async () => { throw new Error("must not start"); } });
  assert.equal(r, true);
});

test("reserved + allowed provider -> starts normally", async () => {
  orch._setReservationReaderForTest(() => RES);
  let started = 0;
  const r = await orch.acquireProvider("crow-embed", { cfg, probeReadyFn: async () => false, bundleUpFn: async () => { started++; }, waitForReadyFn: async () => true, bundleStopFn: async () => {} });
  assert.equal(r, true); assert.equal(started, 1);
});

test("ensureResident defers while reserved (logs once per reservation), starts when the reservation is gone", async () => {
  const logs = []; const orig = console.log; console.log = (m) => logs.push(String(m));
  try {
    orch._setReservationReaderForTest(() => RES);
    assert.equal(await orch.ensureResident("crow-chat", cfg, { probeReadyFn: async () => false, bundleUpFn: async () => { throw new Error("must not start"); } }), false);
    assert.equal(await orch.ensureResident("crow-chat", cfg, { probeReadyFn: async () => false, bundleUpFn: async () => { throw new Error("must not start"); } }), false);
    assert.equal(logs.filter((l) => /residency deferred: box reserved by win/.test(l)).length, 1);
  } finally { console.log = orig; }
});
```
(`ensureResident`'s docker branch currently calls module-level `probeReady`/`bundleUp` directly — make it read `opts.probeReadyFn`/`opts.bundleUpFn`/`opts.waitForReadyFn` with the same defaults `acquireProvider` uses, so the test seam exists. That is a refactor with no behavior change; the residency-poll test file covers the existing paths — run it.)

- [x] **Step 2: Run** → FAIL. **Step 3: Implement** per the interface; the check sits in ONE helper used by all four paths:
```js
let _reservationReader = null;
export function _setReservationReaderForTest(fn) { _reservationReader = fn; }
const _deferNoticed = new Set();
function currentReservation() { return (_reservationReader || readReservation)(); }
/** Returns the reservation if `providerName` may NOT start right now, else null. */
function startBlockedBy(providerName) {
  const r = currentReservation();
  if (!r || isStartAllowed(r, providerName)) return null;
  return r;
}
function noteDeferred(r, what) {
  if (_deferNoticed.has(r.key + ":" + what)) return;
  _deferNoticed.add(r.key + ":" + what);
  console.log(`[gpu-orchestrator] residency deferred: box reserved by ${r.owner} until ${r.expires_at || "?"} (${what})`);
}
```
In `acquireProvider` docker path after the `probeReadyFn` true-return: `const blocked = startBlockedBy(providerName); if (blocked) { onRefusal(blocked, providerName, opts.requester); throw new ReservedError(blocked, providerName); }` (`onRefusal` is defined in C5; in this task make it a no-op stub `function onRefusal() {}` that C5 fills). Same check in `acquireOrStartNative` right before `startNativeAndAwaitReady`. In `ensureResident` docker branch after the ready probe: `const blocked = startBlockedBy(name); if (blocked) { noteDeferred(blocked, name); return false; }`; in `ensureNativeResident` the same before `acquireOrStartNative`. In `retryDeferredResidents`: if `currentReservation()` and not allowed for a name → `noteDeferred` and `continue` WITHOUT deleting it from `_deferredResidents`. In `checkIdleRevert`: before `acquireProvider(group.default)`: `if (startBlockedBy(group.default)) { noteDeferred(…, "idle-revert"); continue; }`.

- [x] **Step 4: Run** `node --test tests/gpu-orchestrator-reservation.test.js tests/gpu-orchestrator-native.test.js tests/gpu-orchestrator-host-gate.test.js tests/gpu-orchestrator-residency-poll.test.js` → PASS. **Step 5: Commit** `git commit servers/gateway/gpu-orchestrator.js tests/gpu-orchestrator-reservation.test.js -m "feat(gpu-orchestrator): honor the box reservation before any model start"`.

### Task C3: `/llm/v1` degrades instead of stalling; `/llm/acquire` → 409

**Files:**
- Modify: `servers/gateway/routes/llm-router.js` (`llmRouterRouter(opts = {})` gains injectable `acquireFn`, `resolveKeyFn`, `fetchImpl`, `probeReadyFn`; `handleChat` catches `ReservedError`)
- Test: `tests/llm-router-reserved.test.js` (create)

**Behavior:**
- Escalated request + `ReservedError` from acquire: if the FAST provider answers `probeReadyFn(fastBaseUrl)` → re-route to `FAST_KEY`, append `{role:"system", content:"Note: the box is reserved (by <owner> until <expires_at>); the larger model is unavailable, answer with what you have."}` to `body.messages`, log `route=degraded(box_reserved)`. Else → `503 { error: { code: "box_reserved", message, owner, expires_at, retry_after: <seconds until expires_at, min 60> } }`.
- Non-escalated (fast) request + `ReservedError` (fast model itself not resident and not allowed) → same 503.
- `/llm/acquire` + `ReservedError` → `409 { ok:false, error:"box_reserved", owner, expires_at }`.
- Nothing retries.

- [x] **Step 1: Test** — mount the router on an express app with a stub upstream http server (a `node:http` server replying `{"choices":[{"message":{"content":"ok"}}]}` and recording the received `model` + messages), `resolveKeyFn: async (key) => ({ baseUrl: upstreamUrl, model: key.split("/")[1] })`, `acquireFn: async (id) => { if (id === "crow-chat") throw new ReservedError(RES, id); return true; }`, `probeReadyFn: async () => fastReady`. Cases: (a) `!escalate hi` with `fastReady=true` → 200, upstream saw `model=qwen3.5-4b` and a trailing system note containing "reserved (by win"; (b) `fastReady=false` → 503 with `code:"box_reserved"` and `retry_after>=60`; (c) plain `hi` (no escalate) with acquire OK → 200 unchanged; (d) `POST /llm/acquire {provider:"crow-chat"}` → 409 `error:"box_reserved"`. Read the top of `llm-router.js` for how `FAST_KEY`/`ESC_KEY` are configured (env `COMPANION_FAST_MODEL`/`COMPANION_ESCALATION_MODEL` — set them in the test before importing).

- [x] **Step 2: Run** → FAIL. **Step 3: Implement** — factor the forwarding into `forwardTo(key, body, req, res, { fetchImpl, resolveKeyFn, requester, routeLabel })`; wrap the acquire: 
```js
let key = escalate ? ESC_KEY : FAST_KEY; let routeLabel = escalate ? `escalate(${escReason})` : "fast";
try { await acquireFn(splitKey(key)[0], { requester }); }
catch (err) {
  if (!(err instanceof ReservedError)) throw err;
  const fast = await resolveKeyFn(FAST_KEY).catch(() => null);
  if (escalate && fast && await probeReadyFn(fast.baseUrl)) {
    key = FAST_KEY; routeLabel = "degraded(box_reserved)";
    body.messages = [...(body.messages || []), { role: "system", content: `Note: the box is reserved (by ${err.owner} until ${err.expires_at}); the larger model is unavailable, answer with what you have.` }];
  } else {
    const retryAfter = Math.max(60, Math.round((Date.parse(err.expires_at || 0) - Date.now()) / 1000) || 60);
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(503).json({ error: { code: "box_reserved", message: err.message, owner: err.owner, expires_at: err.expires_at, retry_after: retryAfter } });
  }
}
```
`/llm/acquire`: `catch (err) { if (err instanceof ReservedError) return res.status(409).json({ ok:false, error:"box_reserved", owner: err.owner, expires_at: err.expires_at }); … }`. Note: `warmProviderByName` → `maybeAcquireLocalProvider` currently SWALLOWS errors and returns `false` — change `maybeAcquireLocalProvider` to **rethrow `ReservedError`** (only that class; everything else keeps the existing warn-and-return-false contract) and add a test for that in `tests/gpu-orchestrator-reservation.test.js`.

- [x] **Step 4: Run** `node --test tests/llm-router-reserved.test.js tests/llm-tap.test.js tests/gpu-orchestrator-reservation.test.js` → PASS. **Step 5: Commit** `git commit servers/gateway/routes/llm-router.js servers/gateway/gpu-orchestrator.js tests/llm-router-reserved.test.js tests/gpu-orchestrator-reservation.test.js -m "feat(llm-router): degrade to the fast model or 503 box_reserved, never stall or retry"`.

### Task C4: dashboard chat + models panel surface the reservation

**Files:**
- Modify: `servers/gateway/routes/chat.js:698-710` (catch `ReservedError` → `sendEvent("error", boxReservedError(err, lang)); closeStream(); return;`), add `export function boxReservedError(err, lang)` beside `providerNotReadyError` returning `{ message: fill(t("chat.box_reserved", lang), { owner: err.owner, until: err.expires_at || "?" }), code: "box_reserved" }`
- Modify: `servers/gateway/routes/models.js:583-600` (the `onError` capture: if `startError instanceof ReservedError` → `409 { error: message, code: "BOX_RESERVED", owner, expires_at }` — note `maybeAcquireLocalProvider` now rethrows `ReservedError`, so wrap the call in try/catch there)
- Modify: `servers/gateway/dashboard/shared/i18n.js` (add `"chat.box_reserved": { en: "The box is reserved by {owner} until {until}; local models can't start right now. Try a smaller resident model or wait.", es: "El equipo está reservado por {owner} hasta {until}; los modelos locales no pueden iniciarse ahora. Prueba un modelo residente más pequeño o espera." }`)
- Test: `tests/chat-native-copy.test.js` (add a `boxReservedError` case in both langs), `tests/models-panel.test.js` (409 case using its `maybeAcquireLocalProviderFn` seam)

- [x] Steps 1–5 as above (test → fail → implement → pass → commit `git commit servers/gateway/routes/chat.js servers/gateway/routes/models.js servers/gateway/dashboard/shared/i18n.js tests/chat-native-copy.test.js tests/models-panel.test.js -m "feat(chat,models): surface a box reservation instead of a generic start failure"`). Run `node --test tests/i18n*.test.js` too (the parity gate).

### Task C5: visibility — notifications on reservation start and first refusal

**Files:**
- Modify: `servers/gateway/gpu-orchestrator.js` (fill `onRefusal`; add `noticeReservation()` called from `pollResidency` each tick)
- Create: `servers/gateway/box-reservation-notify.js` (pure-ish: `reservationNotices(state, reservation, now)` returns which notices to emit; a thin `sendReservationNotice(kind, r, extra)` that uses `createDbClient()` + `createNotification` in a try/finally like `perch-interactive.js pushAttention`)
- Test: `tests/box-reservation-notify.test.js` (create)

**Behavior:** once per `reservation.key`: `system` notification "Box reserved by <owner> until <expires_at> — <reason>" (priority `normal`, action_url `/dashboard/models`) when the orchestrator first sees it; once per key: `system` notification priority `high` "Box reservation refused a model start: <provider> (asked by <requester>)" on the first refusal. `reservationNotices` is a pure state machine over `{seenKeys:Set, refusedKeys:Set}` so the test needs no DB; `sendReservationNotice` swallows every error (log only).

- [x] Steps 1–5 (tests: first sight emits `start`, second sight emits nothing; refusal emits `refused` once; a new key resets). Commit `git commit servers/gateway/gpu-orchestrator.js servers/gateway/box-reservation-notify.js tests/box-reservation-notify.test.js -m "feat(gpu-orchestrator): notify on reservation start and on the first refused model start"`.

### Task C6: `scripts/ops/box-reserve.mjs` CLI

**Files:**
- Create: `scripts/ops/box-reserve.mjs`
- Test: `tests/box-reserve-cli.test.js` (create; `execFileSync(process.execPath, [cli, ...args], { env: { ...process.env, CROW_BOX_RESERVATION_PATH: tmp } })`)

Usage (print on `--help`/bad args, exit 2):
```
box-reserve hold --owner <name> --reason <text> [--minutes N=480] [--allow p1,p2] [--force]
box-reserve release
box-reserve status            # prints JSON or "none"; exit 0 either way
```
`hold` beyond 480 minutes without `--force` → prints the RangeError message, exit 1. Uses C1's `writeReservation`/`clearReservation`/`readReservation`.

- [x] Steps 1–5 (tests: hold writes the file with the owner and an `expires_at` ≈ now+480 min; status prints it; hold 600 → exit 1; hold 600 --force → ok; release removes; status → "none"). Commit `git commit scripts/ops/box-reserve.mjs tests/box-reserve-cli.test.js -m "feat(ops): box-reserve CLI (hold/release/status)"`.

### Task C7: docs + PR C gate

- [x] Add `docs/architecture/box-reservation.md` (what the file is, who writes it, what the orchestrator/router do, the 8 h default, `--force`, the default allow, the CLI, how a window uses it) and link it from `docs/.vitepress/config.ts` sidebar under Architecture; `cd docs && npm run build` clean.
- [x] Append to `/home/kh0pp/CROW-SCHEDULE.md` §Rules a line 5: "Machine truth for *now* is `/run/user/1000/crow-box-reservation.json` (`node ~/crow/scripts/ops/box-reserve.mjs status`); windows and manual holds write it; the gateway refuses non-allowed model starts while it exists." (this file is outside the repo — edit in place).
- [x] Full suite under node 22, static checks, PR "feat: box-reservation scheduling for the gpu-orchestrator (reservations win, 8h default hold)", body links the scope doc and states the three accepted decisions; CI green; merge.

---

# PR D — pi-lab window side (repo `~/pi-lab`, branch `feat/box-reservation-window`)

### Task D1: `dsv4-window.sh` writes the reservation at open and clears it at teardown

**Files:**
- Modify: `scripts/dsv4-window.sh` (:225 area — after `TEARDOWN_MARKER`; :238 `teardown()` — first action after the marker)
- Test: `test/dsv4-window-reservation.test.mjs` (create; copy the spawn/env harness from `test/dsv4-window-ownership.test.mjs`)

**Behavior:** `RESERVATION="${CROW_BOX_RESERVATION_PATH:-${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/crow-box-reservation.json}"`; at open write (atomically via `mktemp` + `mv`) `{"owner":"dsv4-window-$STAMP","reason":"<mode> window (cap ${CAP}s)","started_at":"<date -u -Is>","expires_at":"<now + CAP + 600 s, ISO>","allow":[]}`; `teardown()` removes it right after raising the teardown marker; the deadman's restore path (`dsv4-deadman.sh:97`, where it raises `TEARDOWN_MARKER`) also removes `$CROW_BOX_RESERVATION_PATH`-resolved file if its `owner` matches `dsv4-window-*` (so a window killed by the deadman still releases). `--force` is already required for CAP > the audit interlock; additionally, CAP > 28800 (8 h) without `--force` → `die "reservation would exceed 8h (--force to override)"`.

- [x] Steps 1–5 (tests use the ownership test's dry-run/`DSV4_TEST_*` env seams — read that file first; assert the file exists with the right owner after "open", is gone after "teardown", and that a CAP of 30000 without `--force` dies with the 8h message). Commit with positional paths.

### Task D2: teardown note echoes the marker's actual reason

**Files:**
- Modify: `scripts/dsv4-window.sh:249-250` — replace the fixed "ABORTED BY THE MEMORY WATCHDOG" note with: if the abort marker exists, `say "NOTE: run was ABORTED — $(sed -n 2p "$ABORT_MARKER" 2>/dev/null || echo 'reason unrecorded') — results are partial"` where `ABORT_MARKER="${DSV4_ABORT_MARKER:-/mnt/data/llm/deepseek-v4-flash/ABORTED-BY-MEMWATCH}"` (the deadman writes the reason on line 2: `dsv4-deadman.sh:253-254, 273-274`).
- Test: extend `test/dsv4-window-reservation.test.mjs`: pre-create the marker with line 2 `prod model restarted mid-window: x` → teardown output contains that text and not "MEMORY WATCHDOG".

- [x] Steps 1–5; `npm test` in pi-lab green; push branch to Gitea; merge to `main` via `git merge --ff-only` from the `~/pi-lab` checkout (the operator's standing gate is exercised by this plan under Kevin's acceptance); push.

---

## Self-review

- Spec coverage: §3.1 → C1/C6/D1; §3.2 → C2; §3.3 → C3/C4; §3.4 → B1; §3.5 → C5 + C7 schedule note; §3.6 → D1/D2; §4 tests → each task; §6 decisions → C1 (`DEFAULT_MAX_HOLD_MS`, `DEFAULT_ALLOW`), C3 (reservations win: degrade). Gap fixes F1–F4 → A1–A4.
- Names used consistently: `readReservation`, `isStartAllowed`, `ReservedError`, `writeReservation`, `clearReservation`, `_setReservationReaderForTest`, `requesterTag`, `cardText`, `ensureServers`, `cardBound`.
- No schema changes; no new ports.

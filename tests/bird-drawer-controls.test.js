/**
 * Track 3 Task 14 — drawer controls (model/thinking/permission/plan mode),
 * the collapsible envelope+narrowing pane (ported from bots-page.mjs), files
 * (attach → queue onto next send, outputs/<sid>/<rel> links + inline images
 * in bot text/reply), attach-to-card (reusing the roost dispatch dialog),
 * and the two-step result gate on BOTH the card face and the drawer.
 *
 * Harness copied from tests/bird-drawer-core.test.js / board-panel-config.test.js
 * (same scratch DB fixture idiom, same matchBrace AST-lite bracket-depth
 * helper, same renderKanbanBoard(req,res,opts) call shape) — this file adds
 * a board_results table (board-panel-config's own precedent) so the card-face
 * result-actions path is actually exercised, not just parsed.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "bird-drawer-controls-"));
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
process.env.CROW_DB_PATH = join(dir, "crow.db");

{
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, plan_ref TEXT, board_id INTEGER, data_json TEXT NOT NULL DEFAULT '{}',
    archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`);
  t.exec(`CREATE TABLE board_results (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
    plan_id INTEGER, job_id TEXT, actor_kind TEXT NOT NULL, actor_id TEXT, outcome TEXT NOT NULL,
    summary_md TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'recorded',
    decided_at TEXT, decided_via TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const ins = t.prepare("INSERT INTO tasks_items (id, title, project_id, status) VALUES (?,?,?,?)");
  ins.run(1, "lone card", 9, "pending");
  ins.run(10, "gated success card", 9, "pending");
  ins.run(11, "failed run card", 9, "pending");
  t.prepare("INSERT INTO board_results (item_id, actor_kind, outcome, status) VALUES (10,'bot','success','recorded')").run();
  t.prepare("INSERT INTO board_results (item_id, actor_kind, outcome, status) VALUES (11,'bot','failure','recorded')").run();
  t.close();

  const c = new Database(process.env.CROW_DB_PATH);
  c.exec(`CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL,
      card_id INTEGER, status TEXT NOT NULL DEFAULT 'active', control TEXT NOT NULL DEFAULT 'run',
      pi_session_dir TEXT, kind TEXT NOT NULL DEFAULT 'chat', updated_at TEXT DEFAULT (datetime('now')))`);
  c.close();
}

let renderKanbanBoard, createDbClient, clientJs, birdDrawerJs, translations, t, tJs;
before(async () => {
  ({ renderKanbanBoard } = await import("../servers/gateway/dashboard/panels/bot-board/html.js"));
  ({ createDbClient } = await import("../servers/db.js"));
  ({ clientJs } = await import("../servers/gateway/dashboard/panels/bot-board/client.js"));
  ({ birdDrawerJs } = await import("../servers/gateway/dashboard/panels/bot-board/drawer.js"));
  ({ translations, t, tJs } = await import("../servers/gateway/dashboard/shared/i18n.js"));
});

function selBot() {
  return { botId: "scout", displayName: "Scout", projectId: 9, trackerType: "kanban", trackerSlug: null, definition: {} };
}
const layout = (o) => o.content;
const BOTS = [selBot()];
const engine = { list: async () => [] };

/** AST-lite bracket-depth scan — copied verbatim from tests/roost-strip-ui.test.js. */
function matchBrace(src, braceStart) {
  let depth = 0, end = -1;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  return end;
}

/** Extract a top-level `function NAME(...){...}` declaration's full source. */
function extractFunction(src, name) {
  const marker = "function " + name + "(";
  const start = src.indexOf(marker);
  if (start < 0) return null;
  const braceStart = src.indexOf("{", start);
  const end = matchBrace(src, braceStart);
  if (end < 0) return null;
  return src.slice(start, end + 1);
}

async function render() {
  const db = createDbClient();
  try {
    const opts = { db, layout, selBot: selBot(), bots: BOTS, notice: "", switcher: "", q: {}, lang: "en", engine };
    return await renderKanbanBoard({}, {}, opts);
  } finally { db.close(); }
}

/** Flush BOTH microtasks (promise .then chains) and any queued macrotask —
 * a chained decide().then(move()) crosses at least two microtask hops, and a
 * plain `await Promise.resolve()` isn't guaranteed to drain that; a 0ms
 * macrotask boundary drains everything queued ahead of it. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

/** Behavioral fetch double for the two-step decide/move functions below —
 * records every call, in order, and resolves per a caller-supplied script
 * keyed by which route a path targets ('decide' | 'move' | default). */
function fakeApiRecorder(script) {
  const calls = [];
  const api = (method, path, payload) => {
    calls.push({ method, path, payload });
    const kind = path.includes("/decide") ? "decide" : path.includes("/move") ? "move" : "other";
    const result = (script && script[kind]) || { ok: true, j: {} };
    return Promise.resolve(result);
  };
  return { api, calls };
}

/** Isolates client.js's cardResultDecide with an injected fake `api` (and
 * inert crowToast/errText/reload stand-ins) so the accept/reject flow can be
 * driven and observed WITHOUT touching the real network or DOM — this is
 * what lets the mutation-testing round below actually prove the two-step
 * order at RUNTIME, not merely in the source text (fix round 1 finding). */
function makeCardResultDecide(body, api) {
  const fn = extractFunction(body, "cardResultDecide");
  if (!fn) return null;
  const runner = new Function("api", "crowToast", "errText", "reload",
    fn + ";\nreturn cardResultDecide;");
  return runner(api, () => {}, (r, fallback) => (r && r.j && r.j.error) || fallback, () => {});
}

function fakeResultActionsEl(cardId, resultId, buttons) {
  return {
    closest: (sel) => (sel === ".bb-card" ? { getAttribute: (n) => (n === "data-card" ? String(cardId) : null) } : null),
    getAttribute: (n) => (n === "data-result-id" ? String(resultId) : null),
    querySelectorAll: (sel) => (sel === "button" ? buttons : []),
  };
}
function fakeResultActionBtn(action) {
  return { getAttribute: (n) => (n === "data-result-action" ? action : null) };
}

/** Same isolation, for the drawer's bdDecideResultGate (drawer.js) — that
 * function closes over the module-scope `bd` object (for bd.cardId) instead
 * of reading it off DOM attributes. */
function makeBdDecideResultGate(js, api, cardId, onLoadResultGate) {
  const fn = extractFunction(js, "bdDecideResultGate");
  if (!fn) return null;
  const bd = { cardId };
  const runner = new Function("bd", "api", "crowToast", "bdLoadResultGate",
    fn + ";\nreturn bdDecideResultGate;");
  return runner(bd, api, () => {}, onLoadResultGate || (() => {}));
}

function emittedBody(lang = "en") {
  const js = clientJs("scout", "kanban", 9, null, null, lang, false);
  return js.replace(/^<script>/, "").replace(/<\/script>$/, "");
}

// ---------------------------------------------------------------------------
// Step 1: emitted-script parse still passes
// ---------------------------------------------------------------------------

test("emitted client script (Task 14 controls/narrowing/files/attach/result-gate included) still parses as JavaScript", async () => {
  for (const lang of ["en", "es"]) {
    const body = emittedBody(lang);
    assert.doesNotThrow(() => new Function(body), "client script must parse, lang=" + lang);
    assert.ok(!body.includes("`"), "no backtick may reach the emitted source, lang=" + lang);
    assert.ok(!body.includes("${"), "no unescaped ${ may reach the emitted source, lang=" + lang);
  }
});

test("drawer.js's own emitted source (Task 14 additions included) parses standalone", async () => {
  for (const lang of ["en", "es"]) {
    const js = birdDrawerJs(lang);
    assert.doesNotThrow(() => new Function(js), "drawer.js source must parse on its own, lang=" + lang);
    assert.ok(!js.includes("`"), "no backtick may reach drawer.js's own emitted source, lang=" + lang);
    assert.ok(!js.includes("${"), "no unescaped ${ may reach drawer.js's own emitted source, lang=" + lang);
  }
});

// ---------------------------------------------------------------------------
// Card face: result-gate Accept/Reject, gated on a recorded-success result
// ---------------------------------------------------------------------------

test("card face renders Accept/Reject actions for a gated recorded-success result, carrying the result id", async () => {
  const html = await render();
  const cardHtml = html.slice(html.indexOf('data-card="10"'), html.indexOf('data-card="11"'));
  assert.ok(cardHtml.includes("data-result-actions"), "the guard container must be present");
  assert.match(cardHtml, /data-result-id="\d+"/, "the result id must be projected onto the container");
  assert.match(cardHtml, /data-result-action="accept"/, "an accept button must be present");
  assert.match(cardHtml, /data-result-action="reject"/, "a reject button must be present");
  // The pinned marker markup (board-panel-config.test.js) must survive untouched.
  assert.ok(cardHtml.includes('class="bb-marker bb-marker-waiting"'), "the waiting marker itself must be unchanged");
});

test("card face does NOT render result actions for a failed (non-gated) result", async () => {
  const html = await render();
  const fromCard = html.slice(html.indexOf('data-card="11"'));
  const cardHtml = fromCard.slice(0, fromCard.indexOf("</div></div>"));
  assert.ok(!cardHtml.includes("data-result-actions"), "a failure outcome is not an accept/reject gate");
  assert.ok(cardHtml.includes('class="bb-marker bb-marker-failed"'), "the failed marker itself must be unchanged");
});

test("a card with no board_results row carries neither the marker nor the result-actions guard", async () => {
  const html = await render();
  const cardHtml = html.slice(html.indexOf('data-card="1"'), html.indexOf('data-card="10"'));
  assert.ok(!cardHtml.includes("bb-marker-waiting") && !cardHtml.includes("bb-marker-failed"));
  assert.ok(!cardHtml.includes("data-result-actions"));
});

// ---------------------------------------------------------------------------
// Card face: click-to-open + dragstart guards reference the result-actions
// container (client.js)
// ---------------------------------------------------------------------------

test("the click handler checks data-result-actions BEFORE the bird-glyph and card-open branches, and returns", async () => {
  const body = emittedBody();
  const clickAnchor = "document.addEventListener('click',function(ev){";
  const start = body.indexOf(clickAnchor);
  assert.ok(start >= 0, "the delegated click handler must exist");
  const braceStart = start + clickAnchor.length - 1;
  const handlerSrc = body.slice(braceStart, matchBrace(body, braceStart) + 1);
  const guardIdx = handlerSrc.indexOf("closest('[data-result-actions]')");
  assert.ok(guardIdx >= 0, "the click handler must guard on data-result-actions");
  const birdIdx = handlerSrc.indexOf(".bb-bird[data-bird-sid]");
  const cardOpenIdx = handlerSrc.indexOf("ev.target.closest && ev.target.closest('.bb-card')");
  assert.ok(guardIdx < birdIdx, "the result-actions guard must run before the bird-glyph branch");
  assert.ok(guardIdx < cardOpenIdx, "the result-actions guard must run before the card-open branch");
  assert.doesNotThrow(() => new Function(handlerSrc.slice(1, -1)), "click handler body parses standalone");
});

test("the dragstart handler refuses (preventDefault + return) when starting inside data-result-actions", async () => {
  const body = emittedBody();
  const anchor = "document.addEventListener('dragstart',function(e){";
  const start = body.indexOf(anchor);
  assert.ok(start >= 0, "the dragstart handler must exist");
  const braceStart = start + anchor.length - 1;
  const handlerSrc = body.slice(braceStart, matchBrace(body, braceStart) + 1);
  const guardIdx = handlerSrc.indexOf("closest('[data-result-actions]')");
  assert.ok(guardIdx >= 0, "dragstart must guard on data-result-actions");
  const cardCheckIdx = handlerSrc.indexOf("closest&&e.target.closest('.bb-card')");
  assert.ok(guardIdx < cardCheckIdx, "the result-actions guard must run before the card pickup");
  assert.match(handlerSrc.slice(guardIdx, guardIdx + 120), /preventDefault\(\);\s*return;/,
    "the guarded branch must preventDefault and return, refusing the drag");
});

// ---------------------------------------------------------------------------
// I2 + I3 (final review): the drawer's 'state' SSE handler must consume
// turnInFlight/permissionMode/planMode from the EVENT payload, not rely only
// on local send-tab bookkeeping (turnInFlight) or the mount-time hard-set
// default (bdResetControlsUi's 'guarded') — a reopened drawer, second tab, or
// reconnect must reflect the session's REAL live state, driven behaviorally
// (the actual handler body, real inputs) rather than by scanning source text.
// ---------------------------------------------------------------------------

test("the 'state' SSE handler syncs turnInFlight, the permission select, and the plan toggle from the event payload", async () => {
  const js = birdDrawerJs("en");
  const anchor = "es.addEventListener('state',function(e){";
  const start = js.indexOf(anchor);
  assert.ok(start >= 0, "the state handler must exist");
  const braceStart = start + anchor.length - 1;
  const handlerSrc = js.slice(braceStart, matchBrace(js, braceStart) + 1);

  const params = [
    "e", "bd", "mySid", "parsed",
    "bdSetState", "bdSetTurnInFlight", "bdRenderAsk",
    "bdUpdateHeader", "bdLoadTranscript", "bdLoadSessionMeta",
    "bdPermSel", "bdPlanToggle",
  ];
  const runner = new Function(...params, handlerSrc.slice(1, -1));

  function run(payload) {
    const bd = { sid: "sess-1", esRetries: 0, botId: "x", threadId: "t" };
    const bdPermSel = { value: "guarded" };
    const bdPlanToggle = { checked: false };
    const setTurnInFlightCalls = [];
    runner(
      { data: "unused" }, bd, "sess-1", () => payload,
      () => {}, (f) => setTurnInFlightCalls.push(f), () => {},
      () => {}, () => {}, () => {},
      bdPermSel, bdPlanToggle
    );
    return { bdPermSel, bdPlanToggle, setTurnInFlightCalls };
  }

  // A turn in flight, running in 'bypass' with plan mode on — exactly the
  // shape a reopened drawer mid-turn must reflect, not the mount default.
  const r1 = run({ state: "awake", turnInFlight: true, permissionMode: "bypass", planMode: true });
  assert.deepEqual(r1.setTurnInFlightCalls, [true], "turnInFlight:true must be consumed from the event");
  assert.equal(r1.bdPermSel.value, "bypass", "the permission select must reflect the session's REAL mode, not stay 'guarded'");
  assert.equal(r1.bdPlanToggle.checked, true, "the plan toggle must reflect the session's real plan mode");

  // Idle-awake — no turn in flight.
  const r2 = run({ state: "awake", turnInFlight: false, permissionMode: "guarded", planMode: false });
  assert.deepEqual(r2.setTurnInFlightCalls, [false]);
  assert.equal(r2.bdPermSel.value, "guarded");
  assert.equal(r2.bdPlanToggle.checked, false);

  // 'stopped' must force turnInFlight false regardless of a stale
  // turnInFlight:true still riding on the event.
  const r3 = run({ state: "stopped", turnInFlight: true, permissionMode: "guarded", planMode: false });
  assert.deepEqual(r3.setTurnInFlightCalls, [false], "'stopped' must force turnInFlight false even if the event still says true");
});

// ---------------------------------------------------------------------------
// Card face: Accept handler calls decide THEN move — driven BEHAVIORALLY
// (fake `api`, real promise chains) rather than by scanning source text for
// substring order. Fix round 1 finding: a textual `decideIdx < moveIdx`
// check stays true even if the `return;` guarding the move call on a FAILED
// decide is deleted — the source ordering never changes, only the runtime
// behavior does. These tests drive the actual function and inspect the
// actual sequence of network calls it made.
// ---------------------------------------------------------------------------

test("cardResultDecide (accept, decide FAILS): move is never called, and the buttons re-enable", async () => {
  const body = emittedBody();
  const { api, calls } = fakeApiRecorder({ decide: { ok: false, status: 400, j: { error: "nope" } } });
  const cardResultDecide = makeCardResultDecide(body, api);
  assert.ok(cardResultDecide, "cardResultDecide must be present in the emitted source");
  const buttons = [{ disabled: false }, { disabled: false }];
  cardResultDecide(fakeResultActionsEl(42, 7, buttons), fakeResultActionBtn("accept"));
  await flush();
  assert.equal(calls.length, 1, "only the decide call may fire when it itself fails");
  assert.equal(calls[0].path, "/card/42/result/7/decide");
  assert.deepEqual(calls[0].payload, { decision: "approved" });
  assert.ok(buttons.every((b) => b.disabled === false), "a failed decide must re-enable the buttons, not leave them stuck disabled");
});

test("cardResultDecide (accept, happy path): decide THEN move fire in that order, with the documented payloads", async () => {
  const body = emittedBody();
  const { api, calls } = fakeApiRecorder();
  const cardResultDecide = makeCardResultDecide(body, api);
  cardResultDecide(fakeResultActionsEl(42, 7, [{ disabled: false }]), fakeResultActionBtn("accept"));
  await flush();
  assert.equal(calls.length, 2, "a successful accept must issue exactly two writes — decide, then move");
  assert.equal(calls[0].path, "/card/42/result/7/decide");
  assert.deepEqual(calls[0].payload, { decision: "approved" });
  assert.equal(calls[1].path, "/card/42/move");
  assert.deepEqual(calls[1].payload, { status: "done" });
});

test("cardResultDecide (accept, decide OK but move FAILS): buttons re-enable, no second move attempt", async () => {
  const body = emittedBody();
  const { api, calls } = fakeApiRecorder({ move: { ok: false, status: 500, j: { error: "boom" } } });
  const cardResultDecide = makeCardResultDecide(body, api);
  const buttons = [{ disabled: false }];
  cardResultDecide(fakeResultActionsEl(42, 7, buttons), fakeResultActionBtn("accept"));
  await flush();
  assert.equal(calls.length, 2, "decide then exactly one move attempt");
  assert.ok(buttons.every((b) => b.disabled === false), "a failed move must re-enable the buttons");
});

test("cardResultDecide (reject): decides only — move is never called, on success or failure", async () => {
  const body = emittedBody();
  const { api, calls } = fakeApiRecorder();
  const cardResultDecide = makeCardResultDecide(body, api);
  cardResultDecide(fakeResultActionsEl(42, 7, [{ disabled: false }]), fakeResultActionBtn("reject"));
  await flush();
  assert.equal(calls.length, 1, "reject must never touch the move route");
  assert.equal(calls[0].path, "/card/42/result/7/decide");
  assert.deepEqual(calls[0].payload, { decision: "rejected" });
});

// ---------------------------------------------------------------------------
// Drawer: the in-drawer result gate — SAME behavioral treatment
// ---------------------------------------------------------------------------

test("bdDecideResultGate (approve, decide FAILS): move is never called", async () => {
  const js = birdDrawerJs("en");
  const { api, calls } = fakeApiRecorder({ decide: { ok: false, status: 400, j: { error: "nope" } } });
  const bdDecideResultGate = makeBdDecideResultGate(js, api, 99);
  assert.ok(bdDecideResultGate, "bdDecideResultGate must be present in the emitted source");
  const buttons = [{ disabled: false }];
  bdDecideResultGate(5, "approved", buttons);
  await flush();
  assert.equal(calls.length, 1, "a failed decide must never be followed by a move call");
  assert.equal(calls[0].path, "/card/99/result/5/decide");
  assert.ok(buttons.every((b) => b.disabled === false), "buttons must re-enable on a failed decide");
});

test("bdDecideResultGate (approve, happy path): decide THEN move fire in that order, then the gate reloads", async () => {
  const js = birdDrawerJs("en");
  const { api, calls } = fakeApiRecorder();
  let reloadedGate = false;
  const bdDecideResultGate = makeBdDecideResultGate(js, api, 99, () => { reloadedGate = true; });
  bdDecideResultGate(5, "approved", [{ disabled: false }]);
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, "/card/99/result/5/decide");
  assert.deepEqual(calls[0].payload, { decision: "approved" });
  assert.equal(calls[1].path, "/card/99/move");
  assert.deepEqual(calls[1].payload, { status: "done" });
  assert.ok(reloadedGate, "a successful move must refresh the result gate");
});

test("bdDecideResultGate (reject): decides only, move is never called, gate still reloads", async () => {
  const js = birdDrawerJs("en");
  const { api, calls } = fakeApiRecorder();
  let reloadedGate = false;
  const bdDecideResultGate = makeBdDecideResultGate(js, api, 99, () => { reloadedGate = true; });
  bdDecideResultGate(5, "rejected", [{ disabled: false }]);
  await flush();
  assert.equal(calls.length, 1, "reject must never touch the move route");
  assert.deepEqual(calls[0].payload, { decision: "rejected" });
  assert.ok(reloadedGate, "reject still refreshes the gate (the decision itself is the visible change)");
});

// ---------------------------------------------------------------------------
// Controls row: cycle ("apply now") disabled-on-busy branch
// ---------------------------------------------------------------------------

test("bdUpdateCycleDisabled disables 'apply now' when a turn is in flight OR an ask_user card is pending", async () => {
  const js = birdDrawerJs("en");
  const fn = extractFunction(js, "bdUpdateCycleDisabled");
  assert.ok(fn, "bdUpdateCycleDisabled must be present in the emitted source");
  assert.match(fn, /disabled\s*=\s*!!\(bd\.turnInFlight\s*\|\|\s*bd\.pendingCard\)/,
    "the disabled state must be driven by the SSE-known turn/pending flags, not a round trip");
  assert.doesNotThrow(() => new Function("bdApplyNowBtn", "bd", fn + "\nbdUpdateCycleDisabled();"),
    "bdUpdateCycleDisabled parses and runs standalone");
});

test("bdSetTurnInFlight and bdRenderAsk/bdCollapseAsk all call bdUpdateCycleDisabled — every state transition keeps it live", async () => {
  const js = birdDrawerJs("en");
  for (const name of ["bdSetTurnInFlight", "bdRenderAsk", "bdCollapseAsk"]) {
    const fn = extractFunction(js, name);
    assert.ok(fn, name + " must be present");
    assert.ok(fn.includes("bdUpdateCycleDisabled()"), name + " must call bdUpdateCycleDisabled()");
  }
});

test("the model/thinking menus disable on hibernate and (re)populate on awake — bdSetState wires both", async () => {
  const js = birdDrawerJs("en");
  const fn = extractFunction(js, "bdSetState");
  assert.ok(fn, "bdSetState must be present");
  assert.match(fn, /state==='awake'\)\s*bdLoadOptions\(\)/, "awake loads live options");
  assert.ok(fn.includes("bdSetOptionsDisabled()"), "any other state disables the menus");
});

test("GET options: null models/thinkingLevels disable both selects (hibernating contract)", async () => {
  const js = birdDrawerJs("en");
  const fn = extractFunction(js, "bdRenderOptions");
  assert.ok(fn, "bdRenderOptions must be present");
  assert.match(fn, /disabled\s*=\s*true/, "an empty/absent list disables its select");
});

test("permission mode and plan-mode toggle POST /interactive/:sid/control, plan-mode rolls back its checkbox on refusal", async () => {
  const js = birdDrawerJs("en");
  assert.ok(js.includes("bdPermSel.onchange=function(){"), "permission select must be wired");
  assert.ok(js.includes("permission_mode:bdPermSel.value"), "permission mode posts snake_case, matching the route contract");
  const planFn = js.slice(js.indexOf("bdPlanToggle.onchange=function(){"));
  const braceStart = planFn.indexOf("{");
  const planBody = planFn.slice(braceStart, matchBrace(planFn, braceStart) + 1);
  assert.ok(planBody.includes("plan_mode:v"), "plan toggle posts plan_mode");
  assert.ok(planBody.includes("bdPlanToggle.checked=!v"), "a refused toggle rolls back the checkbox — the UI must not lie");
});

test("'apply now' posts POST /interactive/:sid/cycle", async () => {
  const js = birdDrawerJs("en");
  const fn = js.slice(js.indexOf("bdApplyNowBtn.onclick=function(){"));
  assert.ok(fn.includes("/cycle'"), "apply now must hit the cycle route");
});

// ---------------------------------------------------------------------------
// Collapsible envelope + narrowing pane
// ---------------------------------------------------------------------------

test("bdSavedNarrowingFromRow implements the ported tri-state contract (Set-shaped object / null / undefined)", async () => {
  const js = birdDrawerJs("en");
  const fn = extractFunction(js, "bdSavedNarrowingFromRow");
  assert.ok(fn, "bdSavedNarrowingFromRow must be present");
  const impl = new Function("row", fn.slice(fn.indexOf("{"), fn.lastIndexOf("}") + 1).slice(1, -1) + "");
  // Row has never reported the field at all → undefined ("not reported").
  assert.equal(impl({}), undefined);
  // Row reports the field, but it's SQL NULL → null ("nothing narrowed yet").
  assert.equal(impl({ narrowed_tools: null }), null);
  // Row reports a real narrowing → a real (truthy, object-shaped) result.
  const real = impl({ narrowed_tools: JSON.stringify(["tool_a"]) });
  assert.ok(real && typeof real === "object" && real.tool_a === true);
});

test("bdRenderControlsPane picks the tri-state note by saved-narrowing shape, and never renders a widening checkbox for a denied tool", async () => {
  const js = birdDrawerJs("en");
  const fn = extractFunction(js, "bdRenderControlsPane");
  assert.ok(fn, "bdRenderControlsPane must be present");
  // Compared against tJs(), not t(): the emitted source is a JS string
  // literal, so an apostrophe in the EN text (e.g. "bot's") is escaped there.
  assert.ok(fn.includes(tJs("botboard.bdNarrowNoteSaved", "en")), "the Set-shaped branch uses the 'saved' note");
  assert.ok(fn.includes(tJs("botboard.bdNarrowNoteEmpty", "en")), "the null branch uses the 'empty' note");
  assert.ok(fn.includes(tJs("botboard.bdNarrowNoteUnknown", "en")), "the undefined branch uses the 'unknown' note");
  assert.ok(fn.includes("denied.forEach"), "denied tools render, but never as a checkbox (bots-page.mjs's locked-link precedent)");
});

test("bdSaveNarrowing posts disabled_tools to the documented narrow route and rolls back the checkbox on refusal", async () => {
  const js = birdDrawerJs("en");
  const fn = extractFunction(js, "bdSaveNarrowing");
  assert.ok(fn, "bdSaveNarrowing must be present");
  assert.match(fn, /\/bots\/'\+encodeURIComponent\(bd\.botId\)\+'\/sessions\/'\+encodeURIComponent\(bd\.threadId\)\+'\/narrow'/,
    "must post to the exact documented route");
  assert.match(fn, /disabled_tools:disabled/, "posts the unchecked tool ids as disabled_tools");
  assert.ok(fn.includes("changedInput.checked=!changedInput.checked"), "a refused narrow rolls back the checkbox (never lies)");
  assert.ok(fn.includes("widening_rejected"), "the widening-rejected error is surfaced distinctly");
});

// ---------------------------------------------------------------------------
// i18n: the narrowing tri-state note strings, present EN + ES
// ---------------------------------------------------------------------------

test("the three ported narrowing tri-state note strings exist with real EN and ES text", async () => {
  for (const key of ["botboard.bdNarrowNoteSaved", "botboard.bdNarrowNoteEmpty", "botboard.bdNarrowNoteUnknown"]) {
    const entry = translations[key];
    assert.ok(entry, key + " must be registered");
    assert.ok(entry.en && entry.en.length > 10, key + " needs real EN text");
    assert.ok(entry.es && entry.es.length > 10, key + " needs real ES text");
    assert.notEqual(entry.en, entry.es, key + " EN/ES must not be identical placeholders");
  }
});

test("every new botboard.bd* Task 14 i18n key has both EN and ES, non-identical", async () => {
  const keys = [
    "botboard.bdPermGuarded", "botboard.bdPermAsk", "botboard.bdPermBypass", "botboard.bdPlanModeLabel",
    "botboard.bdBindsAtWake", "botboard.bdApplyNow", "botboard.bdCycleFailed", "botboard.bdControlFailed",
    "botboard.bdEnvelopeToggle", "botboard.bdAttachCard", "botboard.bdAttachFile", "botboard.bdUploadFailed",
    "botboard.bdAttachSent", "botboard.bdResultDecideFailed", "botboard.bdFullEnvelopeRestored",
    "botboard.bdNarrowRejected", "botboard.bdNarrowFailed", "botboard.bdToolsNone",
  ];
  for (const k of keys) {
    const entry = translations[k];
    assert.ok(entry, k + " must be registered");
    assert.ok(entry.en, k + " missing en");
    assert.ok(entry.es, k + " missing es");
    assert.notEqual(entry.en, entry.es, k + " en/es must not be identical");
  }
});

// ---------------------------------------------------------------------------
// Files: attach → queue onto the NEXT send's images; workspace links inline
// ---------------------------------------------------------------------------

test("a successful upload of an image queues it; bdSend threads the queue onto POST /message's images and clears it", async () => {
  const js = birdDrawerJs("en");
  const uploadFn = js.slice(js.indexOf("bdFileInputEl.onchange=function(){"));
  assert.ok(uploadFn.includes("bd.uploads.push("), "an image upload must be queued");
  assert.ok(uploadFn.includes("/files'"), "must POST to the documented files route first");
  const sendFn = extractFunction(js, "bdSend");
  assert.ok(sendFn, "bdSend must be present");
  assert.match(sendFn, /body\.images\s*=\s*bd\.uploads\.map/, "queued uploads thread onto the message body's images");
  assert.ok(sendFn.includes("bd.uploads=[]"), "the queue clears once threaded onto the outgoing send");
});

test("bdRenderBodyWithLinks turns an outputs/<sid>/<rel> path into a workspace link, and an image extension into an inline <img>", async () => {
  const js = birdDrawerJs("en");
  const start = js.indexOf("function bdIsBoundaryChar");
  const end = js.indexOf("// ---- attach-to-card");
  assert.ok(start >= 0 && end > start, "the link-rendering block must be present");
  const block = js.slice(start, end);

  function El() { this.children = []; }
  El.prototype.appendChild = function (c) { this.children.push(c); };
  const documentStub = {
    createElement: (tag) => { const e = new El(); e.tag = tag; return e; },
    createTextNode: (txt) => ({ type: "text", t: txt }),
  };
  const bd = { sid: "sess-42" };
  const fn = new Function("document", "bd", block + ";return bdRenderBodyWithLinks;");
  const renderFn = fn(documentStub, bd);

  const bodyEl = new El();
  renderFn(bodyEl, "see outputs/sess-42/notes.txt and outputs/sess-42/chart.png here, but not outputs/other-session/x.txt");
  const link = bodyEl.children.find((c) => c.tag === "a");
  const img = bodyEl.children.find((c) => c.tag === "img");
  assert.ok(link, "a plain-file path becomes a link");
  assert.equal(link.href, "/dashboard/perch-api/interactive/sess-42/workspace/notes.txt");
  assert.ok(img, "an image-extension path becomes an inline <img>");
  assert.equal(img.src, "/dashboard/perch-api/interactive/sess-42/workspace/chart.png");
  const plainText = bodyEl.children.filter((c) => c.type === "text").map((c) => c.t).join("");
  assert.ok(plainText.includes("outputs/other-session/x.txt"), "a DIFFERENT session's outputs path is never linkified");
});

// ---------------------------------------------------------------------------
// Attach-to-card: reuses the roost dispatch dialog, posts attach-card
// ---------------------------------------------------------------------------

test("the drawer's Attach-to-card button opens the roost dispatch dialog via openRoostAttachCard(bd.sid)", async () => {
  const js = birdDrawerJs("en");
  const fn = js.slice(js.indexOf("bdAttachCardBtn.onclick=function(){"));
  const braceStart = fn.indexOf("{");
  const body = fn.slice(braceStart, matchBrace(fn, braceStart) + 1);
  assert.ok(body.includes("openRoostAttachCard(bd.sid)"), "must open the SAME dialog client.js defines, for THIS session");
});

test("openRoostAttachCard posts to /interactive/:sid/attach-card, never /bots/:id/dispatch", async () => {
  const body = emittedBody();
  const fn = extractFunction(body, "openRoostAttachCard");
  assert.ok(fn, "openRoostAttachCard must be present in client.js's emitted source");
  assert.ok(fn.includes("roostDispatchMode='attach'"), "must select attach mode for the shared 'bb-rd-send' handler");
  assert.doesNotThrow(() => new Function(fn), "openRoostAttachCard parses standalone");
});

test("'bb-rd-send' in attach mode posts card_id to /interactive/:sid/attach-card and updates the drawer header on success", async () => {
  const body = emittedBody();
  const anchor = "$('bb-rd-send').onclick=function(){";
  const start = body.indexOf(anchor);
  const braceStart = start + anchor.length - 1;
  const handlerSrc = body.slice(braceStart, matchBrace(body, braceStart) + 1);
  const attachStart = handlerSrc.indexOf("roostDispatchMode==='attach'");
  assert.ok(attachStart >= 0, "the attach-mode branch must exist in the shared send handler");
  const attachBranch = handlerSrc.slice(attachStart, handlerSrc.indexOf("if(!roostDispatchBotId) return;"));
  assert.ok(attachBranch.includes("/attach-card'"), "must post to the attach-card route");
  assert.ok(attachBranch.includes("card_id:Number(cardId)"), "must post the picked card id");
  assert.ok(attachBranch.includes("bdAfterAttachCard()"), "success must refresh the drawer's own header/result-gate state");
});

// ---------------------------------------------------------------------------
// The drawer's static shell carries every new mount point (SSR)
// ---------------------------------------------------------------------------

test("the drawer SSR shell carries the controls row, envelope toggle, attach-to-card, files row and result-gate mount points", async () => {
  const html = await render();
  for (const id of [
    "bb-bd-model", "bb-bd-thinking", "bb-bd-permission", "bb-bd-plan-toggle",
    "bb-bd-bindsatwake", "bb-bd-apply-now", "bb-bd-controls-toggle", "bb-bd-controls-pane",
    "bb-bd-attach-card", "bb-bd-result", "bb-bd-attach", "bb-bd-file-input", "bb-bd-files-queue",
  ]) {
    assert.ok(html.includes('id="' + id + '"'), "missing mount point: " + id);
  }
});

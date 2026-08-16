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
// Card face: Accept handler calls decide THEN move (order asserted in source)
// ---------------------------------------------------------------------------

test("cardResultDecide's accept branch calls decide THEN the existing move-to-'done' call, in that order", async () => {
  const body = emittedBody();
  const fn = extractFunction(body, "cardResultDecide");
  assert.ok(fn, "cardResultDecide must be present in the emitted source");
  const acceptStart = fn.indexOf("action==='accept'");
  assert.ok(acceptStart >= 0, "must find the accept branch");
  const acceptBranch = fn.slice(acceptStart, fn.indexOf("} else {", acceptStart));
  const decideIdx = acceptBranch.indexOf("/result/'+resultId+'/decide'");
  const moveIdx = acceptBranch.indexOf("/move'");
  assert.ok(decideIdx >= 0, "the decide POST must be present");
  assert.ok(moveIdx >= 0, "the move POST must be present");
  assert.ok(decideIdx < moveIdx, "decide must be called BEFORE move — never a combined write");
  // The move call must be nested inside the decide call's own .then(), i.e.
  // textually AFTER the decide call's opening, not a sibling top-level call.
  const decideThenIdx = acceptBranch.indexOf(".then(function(r){", decideIdx);
  assert.ok(decideThenIdx >= 0 && decideThenIdx < moveIdx, "move must be issued from inside decide's own .then()");
  assert.match(acceptBranch, /decision:'approved'/, "accept decides 'approved'");
  assert.match(acceptBranch, /status:'done'/, "accept moves to the 'done' terminal status");
  assert.doesNotThrow(() => new Function(fn), "cardResultDecide parses standalone");
});

test("cardResultDecide's reject branch decides only — no move call anywhere in that branch", async () => {
  const body = emittedBody();
  const fn = extractFunction(body, "cardResultDecide");
  const elseIdx = fn.indexOf("} else {");
  const rejectBranch = fn.slice(elseIdx);
  assert.match(rejectBranch, /decision:'rejected'/, "reject decides 'rejected'");
  assert.ok(!rejectBranch.includes("/move'"), "reject must never move the card");
});

// ---------------------------------------------------------------------------
// Drawer: the in-drawer result gate mirrors the same two-step order
// ---------------------------------------------------------------------------

test("the drawer's bdDecideResultGate also calls decide THEN move, on approve only", async () => {
  const js = birdDrawerJs("en");
  const fn = extractFunction(js, "bdDecideResultGate");
  assert.ok(fn, "bdDecideResultGate must be present");
  const approvedIdx = fn.indexOf("decision==='approved'");
  assert.ok(approvedIdx >= 0);
  const decideIdx = fn.indexOf("/result/'+resultId+'/decide'");
  const moveIdx = fn.indexOf("/move'");
  assert.ok(decideIdx >= 0 && moveIdx >= 0 && decideIdx < moveIdx && approvedIdx < moveIdx,
    "decide precedes the approve-only move call");
  assert.doesNotThrow(() => new Function(fn), "bdDecideResultGate parses standalone");
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

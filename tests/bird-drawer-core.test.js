/**
 * Track 3 Task 13 — the session drawer core: SSR shell (html.js's
 * birdDrawerMarkup), the emitted client script (drawer.js's birdDrawerJs,
 * spliced into client.js's clientJs() output), and its two binding
 * contracts:
 *
 *   - the ask_user verbatim-echo contract (bots-page.mjs:853-877, restated
 *     for the drawer): a `select` card's options render as buttons carrying
 *     the EXACT option string, and that same string is what POST /answer
 *     sends back — never parsed or re-composed.
 *   - the reconnect handler: EventSource onerror closes the dead stream and
 *     reopens with a bounded 2s-backoff, capped at 5 attempts.
 *
 * Harness copied from tests/roost-strip-ui.test.js (same scratch DB fixture,
 * same renderKanbanBoard(req,res,opts) call shape, same matchBrace AST-lite
 * bracket-depth helper).
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "bird-drawer-core-"));
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
  t.prepare("INSERT INTO tasks_items (id, title, project_id, status) VALUES (1,'lone card',9,'pending')").run();
  t.close();

  const c = new Database(process.env.CROW_DB_PATH);
  c.exec(`CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL,
      card_id INTEGER, status TEXT NOT NULL DEFAULT 'active', control TEXT NOT NULL DEFAULT 'run',
      pi_session_dir TEXT, kind TEXT NOT NULL DEFAULT 'chat', updated_at TEXT DEFAULT (datetime('now')))`);
  c.close();
}

let renderKanbanBoard, createDbClient, clientJs, birdDrawerJs, translations, t;
before(async () => {
  ({ renderKanbanBoard } = await import("../servers/gateway/dashboard/panels/bot-board/html.js"));
  ({ createDbClient } = await import("../servers/db.js"));
  ({ clientJs } = await import("../servers/gateway/dashboard/panels/bot-board/client.js"));
  ({ birdDrawerJs } = await import("../servers/gateway/dashboard/panels/bot-board/drawer.js"));
  ({ translations, t } = await import("../servers/gateway/dashboard/shared/i18n.js"));
});

function selBot() {
  return { botId: "scout", displayName: "Scout", projectId: 9, trackerType: "kanban", trackerSlug: null, definition: {} };
}
const layout = (o) => o.content;
const PERCH_DEF = { gateways: [{ type: "perch" }] };
const BOTS = [
  { botId: "chatty", displayName: "Chatty", projectId: 9, trackerType: "kanban", trackerSlug: null, definition: PERCH_DEF },
];
const engine = { list: async () => [] };

/** AST-lite bracket-depth scan (no JS parser pulled in) — copied verbatim
 * from tests/roost-strip-ui.test.js's own helper. */
function matchBrace(src, braceStart) {
  let depth = 0, end = -1;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  return end;
}

/** Extract a top-level `function NAME(...){...}` declaration's full source
 * (signature through closing brace) from an emitted-script string. */
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
// SSR shell
// ---------------------------------------------------------------------------

test("the drawer's SSR shell is present: dialog semantics, backdrop, transcript pane, composer", async () => {
  const html = await render();
  assert.ok(html.includes('id="bb-bird-drawer"'), "the drawer container");
  assert.ok(html.includes('id="bb-bird-backdrop"'), "the backdrop element");
  assert.ok(html.includes('role="dialog"'), "aria dialog role");
  assert.ok(html.includes('aria-modal="true"'), "aria-modal");
  assert.ok(html.includes('id="bb-bd-transcript"'), "transcript pane");
  assert.ok(html.includes('id="bb-bd-ask"'), "ask_user card mount point");
  assert.ok(html.includes('id="bb-bd-input"'), "composer textarea");
  assert.ok(html.includes('id="bb-bd-send"'), "send button");
  assert.ok(html.includes('id="bb-bd-abort"'), "abort button");
  assert.ok(html.includes('id="bb-bd-stop"'), "stop, in the overflow menu");
  assert.ok(html.includes('id="bb-bd-close"'), "close button");
  assert.ok(html.includes('id="bb-bd-hibernating"'), "hibernating banner mount point");
  assert.ok(html.includes(t("botboard.bdHibernating", "en")), "verbatim hibernating banner text");
  assert.ok(html.includes('id="bb-bd-card-link"'), "card link");
  assert.ok(html.includes('id="bb-bd-picker"'), "the 'pick a session' picker mount point");
});

test("the drawer shell renders AFTER the roost strip and the kanban board in the SSR output", async () => {
  const html = await render();
  const roostIdx = html.indexOf('id="bb-roost"');
  const boardIdx = html.indexOf('id="bb-board"');
  const drawerIdx = html.indexOf('id="bb-bird-drawer"');
  assert.ok(roostIdx >= 0 && boardIdx > roostIdx && drawerIdx > boardIdx);
});

// ---------------------------------------------------------------------------
// Step 1: emitted-script parse (whole clientJs output, and drawer.js's own
// source standalone)
// ---------------------------------------------------------------------------

test("emitted client script (drawer wiring included) parses as JavaScript", async () => {
  const body = emittedBody();
  assert.doesNotThrow(() => new Function(body), "client script must parse");
  assert.ok(body.includes("function openBirdDrawer("), "the real implementation replaces the Task 12 stub");
  assert.ok(body.includes("function closeBirdDrawer("), "close is emitted");
  assert.ok(body.includes("function bdFocusCard("), "the #card= focus branch is emitted");
});

test("drawer.js's own emitted source parses standalone (not just as part of the whole script)", async () => {
  const js = birdDrawerJs("en");
  assert.doesNotThrow(() => new Function(js), "drawer.js source must parse on its own");
});

test("es6+ EN/ES: drawer.js emits no raw backtick and no unescaped ${ (template-literal emission rules)", async () => {
  for (const lang of ["en", "es"]) {
    const js = birdDrawerJs(lang);
    assert.ok(!js.includes("`"), "no backtick may reach the emitted source, lang=" + lang);
    // Every remaining ${ would be a literal (unintended) interpolation marker
    // leaking into client-side JS text — none should survive after render.
    assert.ok(!js.includes("${"), "no unescaped ${ may reach the emitted source, lang=" + lang);
  }
});

// ---------------------------------------------------------------------------
// Step 1: verbatim-echo contract (select options)
// ---------------------------------------------------------------------------

test("ask_user select options render VERBATIM and echo back UNTOUCHED (bots-page.mjs contract, restated)", async () => {
  const body = emittedBody();
  const renderAsk = extractFunction(body, "bdRenderAsk");
  assert.ok(renderAsk, "bdRenderAsk must be present in the emitted source");
  // The select branch: one loop variable (`opt`) must feed BOTH the button's
  // visible label and the exact payload sent back — never a derived/parsed
  // value (e.g. an index, or a re-composed string).
  const selectBranch = renderAsk.slice(renderAsk.indexOf("card.method==='select'"));
  const branchSrc = selectBranch.slice(0, selectBranch.indexOf("} else if(card.method==='input'"));
  assert.match(branchSrc, /b\.textContent\s*=\s*opt\s*;/, "the option renders VERBATIM as the button label");
  assert.match(branchSrc, /bdAnswerAsk\(\{value:opt\},opt\)/, "the SAME opt string is echoed back, never re-composed");
  assert.doesNotThrow(() => new Function(renderAsk + "\nbdRenderAsk;"), "bdRenderAsk parses standalone");
});

test("bdAnswerAsk sends {requestId, ...value} straight to POST /answer — no re-shaping of the echoed value", async () => {
  const body = emittedBody();
  const answerFn = extractFunction(body, "bdAnswerAsk");
  assert.ok(answerFn, "bdAnswerAsk must be present in the emitted source");
  assert.match(answerFn, /Object\.assign\(\{requestId:bd\.pendingCard\.requestId\},value\)/,
    "the value object (carrying the verbatim opt string) is spread onto the payload untouched");
  assert.match(answerFn, /\/interactive\/'\+encodeURIComponent\(bd\.sid\)\+'\/answer'/, "posts to the documented answer route");
});

test("answered ask_user cards collapse to 'Answered: <label>' (verbatim string)", async () => {
  const body = emittedBody();
  const collapseFn = extractFunction(body, "bdCollapseAsk");
  assert.ok(collapseFn, "bdCollapseAsk must be present");
  assert.ok(collapseFn.includes(t("botboard.bdAnsweredPrefix", "en")), "uses the verbatim 'Answered:' i18n string");
});

// ---------------------------------------------------------------------------
// Step 1: reconnect handler — present and bounded
// ---------------------------------------------------------------------------

test("EventSource onerror closes the dead stream and reopens with a BOUNDED 2s backoff (cap 5)", async () => {
  const body = emittedBody();
  const openSse = extractFunction(body, "bdOpenSse");
  assert.ok(openSse, "bdOpenSse must be present in the emitted source");
  const onerrorStart = openSse.indexOf("es.onerror=function()");
  assert.ok(onerrorStart >= 0, "onerror handler must be assigned on the EventSource");
  const braceStart = openSse.indexOf("{", onerrorStart);
  const onerrorSrc = openSse.slice(braceStart, matchBrace(openSse, braceStart) + 1);
  assert.ok(onerrorSrc.includes("bdCloseStream()") || onerrorSrc.includes(".close()"),
    "the dead stream must be closed before a reconnect is attempted");
  assert.match(onerrorSrc, /esRetries\s*>=\s*5/, "retries must be capped at 5");
  assert.match(onerrorSrc, /setTimeout\([^,]+,\s*2000\)/, "reopen is scheduled on a 2000ms (2s) timer");
  assert.match(onerrorSrc, /esRetries\+\+/, "each attempt increments the bounded counter");
  assert.doesNotThrow(() => new Function("(function(){" + onerrorSrc.slice(1, -1) + "})"),
    "the onerror handler body parses standalone");
});

test("a subscribe replay ('state' event) resets the retry counter — a healthy reconnect is not permanently poisoned", async () => {
  const body = emittedBody();
  const openSse = extractFunction(body, "bdOpenSse");
  const stateStart = openSse.indexOf("addEventListener('state'");
  const braceStart = openSse.indexOf("{", openSse.indexOf("function(e)", stateStart));
  const stateSrc = openSse.slice(braceStart, matchBrace(openSse, braceStart) + 1);
  assert.match(stateSrc, /esRetries\s*=\s*0/, "a live state frame clears the retry count");
});

// ---------------------------------------------------------------------------
// Hash mechanics: foreign-key preservation + the #card= focus branch
// ---------------------------------------------------------------------------

test("updateFilterHash preserves foreign keys (bird, card) when re-serializing the filter hash", async () => {
  const body = emittedBody();
  const updateFn = extractFunction(body, "updateFilterHash");
  assert.ok(updateFn, "updateFilterHash must be present");
  // Functional assertions, not a bare substring check — a stray comment
  // mentioning _bbForeignHash would satisfy an `includes()` check without
  // the code actually doing anything (caught in mutation testing: deleting
  // the real for-loop while leaving its explanatory comment above it still
  // passed a weaker version of this test).
  assert.match(updateFn, /for\s*\(\s*var\s+\w+\s+in\s+window\._bbForeignHash\s*\)/,
    "must iterate the foreign-hash-key store");
  assert.match(updateFn, /parts\.push\(\w+\+'='\+encodeURIComponent\(window\._bbForeignHash\[\w+\]\)\)/,
    "must actually re-serialize each foreign key=value pair into the hash parts");
});

test("parseFilterHash records bird/card as foreign keys instead of dropping them", async () => {
  const body = emittedBody();
  const parseFn = extractFunction(body, "parseFilterHash");
  assert.ok(parseFn, "parseFilterHash must be present");
  assert.match(parseFn, /k==='bird'\|\|k==='card'/, "bird/card are recognized as foreign (drawer-owned) keys");
});

test("bdFocusCard scrolls the card into view and opens the drawer for its live bird, if any", async () => {
  const body = emittedBody();
  const focusFn = extractFunction(body, "bdFocusCard");
  assert.ok(focusFn, "bdFocusCard must be present");
  assert.ok(focusFn.includes("scrollIntoView"), "must scroll the card into view");
  assert.ok(focusFn.includes("openBirdDrawer("), "must open the drawer when a live bird glyph is present");
  assert.doesNotThrow(() => new Function("cardId", focusFn.slice(focusFn.indexOf("{"), focusFn.lastIndexOf("}") + 1).slice(1, -1)),
    "bdFocusCard body parses standalone");
});

// ---------------------------------------------------------------------------
// i18n: EN + ES present for every new key, and distinct from each other
// ---------------------------------------------------------------------------

test("every botboard.bd* i18n key has both EN and ES, and the two are not identical placeholders", async () => {
  const keys = Object.keys(translations).filter((k) => k.startsWith("botboard.bd"));
  assert.ok(keys.length >= 10, "the drawer must have registered a meaningful set of i18n keys");
  for (const k of keys) {
    const entry = translations[k];
    assert.ok(entry.en, k + " missing en");
    assert.ok(entry.es, k + " missing es");
    assert.notEqual(entry.en, entry.es, k + " en/es must not be identical (real translation, not a placeholder)");
  }
});

test("the three verbatim spec strings are exact", async () => {
  assert.equal(t("botboard.bdHibernating", "en"), "asleep — sending will wake it");
  assert.equal(t("botboard.bdAnsweredPrefix", "en"), "Answered:");
  assert.equal(t("botboard.bdInterruptedNote", "en"), "turn interrupted by gateway restart");
});

/**
 * Track 3 Task 12 — the roost strip ("birds on a wire") above the kanban
 * board: SSR (one .bb-roost-bird per bot, state-driven primary action) and
 * the client-side bird-state SSE handler that patches it in place.
 *
 * Harness idiom copied from tests/board-panel-config.test.js: a hand-rolled
 * scratch tasks.db/crow.db (no init-db.js — board_defs/board_results/
 * bot_jobs are all column/table-guarded in the render path, so a minimal
 * fixture is enough), renderKanbanBoard called directly with an injected
 * `bots` array and a fake `engine` (same seam Task 11 added).
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "roost-strip-ui-"));
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

let renderKanbanBoard, createDbClient, clientJs, translations, t;
before(async () => {
  ({ renderKanbanBoard } = await import("../servers/gateway/dashboard/panels/bot-board/html.js"));
  ({ createDbClient } = await import("../servers/db.js"));
  ({ clientJs } = await import("../servers/gateway/dashboard/panels/bot-board/client.js"));
  ({ translations, t } = await import("../servers/gateway/dashboard/shared/i18n.js"));
});

function selBot() {
  return { botId: "scout", displayName: "Scout", projectId: 9, trackerType: "kanban", trackerSlug: null, definition: {} };
}
const layout = (o) => o.content;

const PERCH_DEF = { gateways: [{ type: "perch" }] };
const GMAIL_DEF = { gateways: [{ type: "gmail", address: "q@example.com", allowlist: ["a@example.com"] }] };

// Five bots, one per roost state (spec §3.2/§3.1 fold), matching Task 11's
// own /roost fixture vocabulary (idle/working/waiting/hibernating/observing).
const BOTS = [
  { botId: "empty-bot", displayName: "Empty Bot", projectId: 9, trackerType: "kanban", trackerSlug: null, definition: PERCH_DEF },
  { botId: "chatty", displayName: "Chatty", projectId: 9, trackerType: "kanban", trackerSlug: null, definition: PERCH_DEF },
  { botId: "asker", displayName: "Asker", projectId: 9, trackerType: "kanban", trackerSlug: null, definition: PERCH_DEF },
  { botId: "sleepy", displayName: "Sleepy", projectId: 9, trackerType: "kanban", trackerSlug: null, definition: PERCH_DEF },
  { botId: "quiet", displayName: "Quiet", projectId: 9, trackerType: "kanban", trackerSlug: null, definition: GMAIL_DEF },
];

const ENGINE_SESSIONS = [
  { sessionId: "chatty-1", botId: "chatty", state: "awake", pendingUi: null, cardId: null },
  { sessionId: "asker-a", botId: "asker", state: "awake", pendingUi: { kind: "ask" }, cardId: null },
  { sessionId: "sleepy-1", botId: "sleepy", state: "hibernating", pendingUi: null, cardId: null },
];
const engine = { list: async () => ENGINE_SESSIONS };

async function render({ bots = BOTS, engineOverride = engine } = {}) {
  const db = createDbClient();
  try {
    const opts = { db, layout, selBot: selBot(), bots, notice: "", switcher: "", q: {}, lang: "en", engine: engineOverride };
    return await renderKanbanBoard({}, {}, opts);
  } finally { db.close(); }
}

// ---- Step 1: SSR ----

test("roost strip renders one .bb-roost-bird per bot, with the spec-fold state class", async () => {
  const html = await render();
  assert.ok(html.includes('id="bb-roost"'), "the strip container");
  for (const id of ["empty-bot", "chatty", "asker", "sleepy", "quiet"]) {
    assert.ok(html.includes(`data-bot="${id}"`), `bird for ${id}`);
  }
  const birdHtml = (id) => {
    const start = html.indexOf(`data-bot="${id}"`);
    return html.slice(start, html.indexOf("</div>", html.indexOf("bb-roost-menu", start)) + 6);
  };
  assert.ok(birdHtml("empty-bot").includes('class="bb-bird bb-bird--idle"'), "perch-attached, no sessions => idle");
  assert.ok(birdHtml("chatty").includes('class="bb-bird bb-bird--working"'), "an awake session folds to working");
  assert.ok(birdHtml("asker").includes('class="bb-bird bb-bird--waiting"'), "a pending-ui session folds to waiting");
  assert.ok(birdHtml("sleepy").includes('class="bb-bird bb-bird--hibernating"'), "a hibernating session folds to hibernating");
  assert.ok(birdHtml("quiet").includes('class="bb-bird bb-bird--observing"'), "no complete perch gateway record => observing");
});

test("roost strip carries the bot name and i18n'd state text", async () => {
  const html = await render();
  assert.ok(html.includes(">Chatty<"), "bot display name");
  assert.ok(html.includes(">" + t("botboard.roostStateWorking", "en") + "<"), "i18n state text, not a raw code");
});

test("state-driven primary action: idle=Send out, waiting=Answer w/ sid, working=Open w/ sid, observing=link", async () => {
  const html = await render();
  assert.ok(
    html.includes('data-roost-action="dispatch" data-bot="empty-bot"'),
    "idle bird's primary action opens the dispatch dialog"
  );
  const askerIdx = html.indexOf('data-bot="asker"');
  const askerChunk = html.slice(askerIdx, askerIdx + 500);
  assert.ok(askerChunk.includes('data-roost-action="answer"') && askerChunk.includes('data-sid="asker-a"'),
    "waiting bird's primary action is Answer, carrying the winning session id");
  const chattyIdx = html.indexOf('data-bot="chatty"');
  const chattyChunk = html.slice(chattyIdx, chattyIdx + 500);
  assert.ok(chattyChunk.includes('data-roost-action="open"') && chattyChunk.includes('data-sid="chatty-1"'),
    "working bird's primary action is Open, carrying the session id");
  assert.ok(html.includes('href="/dashboard/bot-builder#quiet"'), "observing bird's primary action is a plain link");
});

test("roost strip omits Recall for a bird with no live session, offers it for a live one", async () => {
  const html = await render();
  const emptyIdx = html.indexOf('data-bot="empty-bot"');
  const emptyChunk = html.slice(emptyIdx, html.indexOf("</div></div>", emptyIdx) + 12);
  assert.ok(!emptyChunk.includes('data-roost-action="recall"'), "idle bird: no session to recall");
  const chattyIdx = html.indexOf('data-bot="chatty"');
  const chattyChunk = html.slice(chattyIdx, html.indexOf("</div></div>", chattyIdx) + 12);
  assert.ok(chattyChunk.includes('data-roost-action="recall"') && chattyChunk.includes('data-sid="chatty-1"'),
    "a live bird offers Recall on its own session");
});

test("no bots yet: the strip renders the empty state, not zero birds silently", async () => {
  const html = await render({ bots: [] });
  assert.ok(html.includes('id="bb-roost"'));
  assert.ok(html.includes(t("botboard.roostEmpty", "en")));
  // Not a bare 'bb-roost-bird' substring check — css.js's stylesheet defines
  // the .bb-roost-bird{...} rule on every render regardless of any bird
  // being present (same precedent as board-panel-config.test.js's own
  // result-marker test) — check the actual DIV markup, never the class name.
  assert.ok(!html.includes('class="bb-roost-bird"'));
});

test("the roost strip renders even when engine.list() throws (fail soft, same convention as liveBirdsByCard)", async () => {
  const html = await render({ engineOverride: { list: async () => { throw new Error("boom"); } } });
  assert.ok(html.includes('id="bb-roost"'));
  // Every attached bot degrades to idle (no sessions could be read); the
  // unattached one is still observing regardless (§3.1, decided before the
  // engine is ever consulted).
  assert.ok(html.includes('data-bot="chatty"'));
  const chattyIdx = html.indexOf('data-bot="chatty"');
  assert.ok(html.slice(chattyIdx, chattyIdx + 300).includes('bb-bird--idle'));
});

test("the send-out dispatch dialog is present in the SSR markup", async () => {
  const html = await render();
  assert.ok(html.includes('id="bb-roost-dispatch"'), "dialog container");
  assert.ok(html.includes('id="bb-rd-card"'), "card select");
  assert.ok(html.includes('id="bb-rd-note"'), "note field");
  assert.ok(html.includes('id="bb-rd-send"'), "confirm button");
});

test("board-panel-config.test.js pinned substrings still hold with the strip in front of the board", async () => {
  // The strip is prepended INSIDE the same section, above the filter bar and
  // board grid — assert those two survive unshifted, not just "somewhere".
  const html = await render();
  const roostIdx = html.indexOf('id="bb-roost"');
  // The literal opening tag, not a bare 'bb-filter-bar' substring — the
  // class name also appears earlier, inside css.js's <style> block.
  const filterIdx = html.indexOf('<div class="bb-filter-bar">');
  const boardIdx = html.indexOf('id="bb-board"');
  assert.ok(roostIdx >= 0 && roostIdx < filterIdx && filterIdx < boardIdx,
    "roost strip renders ABOVE the filter bar, which renders above the board");
});

// ---- Step 1: emitted client script parses ----

test("emitted client script (roost strip wiring included) parses as JavaScript", async () => {
  const js = clientJs("scout", "kanban", 9, null, null, "en");
  const body = js.replace(/^<script>/, "").replace(/<\/script>$/, "");
  assert.doesNotThrow(() => new Function(body), "client script must parse");
  // Sanity: the roost wiring is actually IN the emitted script, not dead code
  // that only exists in the source file.
  assert.ok(js.includes("openBirdDrawer"), "the Task-13 stub hook is emitted");
  assert.ok(js.includes("data-roost-action"), "roost click delegation is emitted");
  assert.ok(js.includes("bird-state"), "the SSE handler is emitted");
});

// ---- Step 1: bird-state handler never reloads ----

test("the bird-state SSE handler patches classes in place and never calls location.reload", async () => {
  const js = clientJs("scout", "kanban", 9, null, null, "en");
  const body = js.replace(/^<script>/, "").replace(/<\/script>$/, "");
  const startMarker = "es.addEventListener('bird-state'";
  const start = body.indexOf(startMarker);
  assert.ok(start >= 0, "the bird-state listener must be registered on the EventSource");
  // Extract the handler by bracket-depth scan from its opening `{` — the
  // AST-lite parse the brief calls for, without pulling in a JS parser.
  const braceStart = body.indexOf("{", body.indexOf("function(ev)", start));
  let depth = 0, end = -1;
  for (let i = braceStart; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > braceStart, "must find the handler's closing brace");
  const handlerSrc = body.slice(braceStart, end + 1);
  assert.ok(!handlerSrc.includes("location.reload"), "bird-state must patch in place, never reload:\n" + handlerSrc);
  assert.ok(handlerSrc.includes("className="), "it does patch the glyph's class");
  // The handler itself must also be syntactically valid on its own (wrapped
  // as a bare function body) — catches a stray unbalanced brace the whole-
  // script parse above could theoretically paper over.
  assert.doesNotThrow(() => new Function("ev", handlerSrc.slice(1, -1)), "handler body must parse standalone");
});

// ---- i18n ----

test("roost i18n keys exist in both languages and are not identical placeholders", async () => {
  for (const key of [
    "botboard.roostStateIdle", "botboard.roostStateWorking", "botboard.roostStateWaiting",
    "botboard.roostStateHibernating", "botboard.roostStateObserving",
    "botboard.roostActionSendOut", "botboard.roostActionOpen", "botboard.roostActionAnswer",
    "botboard.roostActionAttach", "botboard.roostActionTalk", "botboard.roostActionSessions",
    "botboard.roostActionRecall", "botboard.roostActionSetup",
  ]) {
    const entry = translations[key];
    assert.ok(entry, `${key} must exist`);
    assert.ok(entry.en && entry.es, `${key} must carry both en and es`);
    assert.notEqual(entry.en, entry.es, `${key} es must be a real translation, not a copy of en`);
  }
});

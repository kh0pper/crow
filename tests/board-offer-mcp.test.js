// Redesign P5 Task 5.2: board_offer_card — a bot offers a card in its Perch chat. The offer names
// the bot's own board project, is validated at offer time, and creates no card.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "board-offer-mcp-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
const DB_FILE = join(dir, "crow.db");
const TASKS = process.env.CROW_TASKS_DB_PATH;
const REPO = new URL("..", import.meta.url).pathname;

let svc, sig, server, tools, cdb, tdb, PID;
const raw = () => new Database(DB_FILE);
const rawTasks = () => new Database(TASKS);
const cardCount = () => { const t = rawTasks(); const n = t.prepare("SELECT COUNT(*) AS n FROM tasks_items").get().n; t.close(); return n; };
const offers = () => { const c = raw(); const r = c.prepare("SELECT * FROM card_offers ORDER BY id").all(); c.close(); return r; };

function seedBot(id, def, { enabled = 1, project = null } = {}) {
  const c = raw();
  c.prepare("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,?,?)")
    .run(id, id, JSON.stringify(def), enabled, project);
  c.close();
}

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const c = raw();
  PID = Number(c.prepare("INSERT INTO project_spaces (slug, name) VALUES ('b1-board','B1 board')").run().lastInsertRowid);
  c.close();
  const PERCH = { type: "perch" };
  seedBot("b1", { gateways: [PERCH], tracker_config: { type: "kanban" } }, { project: PID });
  seedBot("nob", { gateways: [PERCH], tracker_config: { type: "none" } }, { project: PID });
  const t = rawTasks();
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3, due_date TEXT, phase TEXT, owner TEXT,
    tags TEXT, parent_id INTEGER, project_id INTEGER, assigned_bot TEXT, board_id INTEGER, bot_id TEXT,
    action_needed TEXT, autonomy TEXT NOT NULL DEFAULT 'gated', archived_at TEXT, data_json TEXT NOT NULL DEFAULT '{}')`);
  t.close();

  svc = await import("../servers/gateway/board/offer-service.js");
  sig = await import("../scripts/pi-bots/actor-sig.mjs");
  sig.initGatewayActorKey();
  const { createDbClient } = await import("../servers/db.js");
  const { createBoardMcpServer } = await import("../servers/gateway/board-mcp.js");
  cdb = createDbClient(DB_FILE);
  tdb = createDbClient(TASKS);
  server = createBoardMcpServer({ cdb, tdb, verifyActor: sig.verifyBoardActorSig, verifyThread: sig.verifyBoardThreadActorSig });
  tools = server._registeredTools;
});

after(() => { try { cdb.close(); tdb.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { const c = raw(); c.exec("DELETE FROM card_offers"); c.close(); });

/** The extra a bot's board call carries: signed bot headers, plus a signed thread when given. */
function extra(botId, thread) {
  const headers = { "x-crow-actor-kind": "bot", "x-crow-actor-id": botId, "x-crow-actor-sig": sig.signBoardActor({ botId }) };
  if (thread) {
    headers["x-crow-actor-thread"] = thread.id;
    headers["x-crow-actor-gateway"] = thread.gateway;
    if (thread.sig !== false) headers["x-crow-actor-thread-sig"] = sig.signBoardThreadActor({ botId, threadId: thread.id, gatewayType: thread.gateway });
  }
  return { authInfo: { clientId: "local-mcp" }, requestInfo: { headers } };
}
const call = (args, ex) => tools.board_offer_card.handler(args, ex);
const text = (r) => r.content[0].text;

test("the tool exists on the board server, and its title is 1-500 characters", () => {
  assert.ok(tools.board_offer_card, "board_offer_card is registered");
  const schema = tools.board_offer_card.inputSchema;
  assert.equal(schema.safeParse({ title: "" }).success, false);
  assert.equal(schema.safeParse({ title: "x".repeat(501) }).success, false);
  assert.equal(schema.safeParse({ title: "Draft the reply" }).success, true);
});

test("board_offer_card needs a signed Perch thread", async () => {
  const none = await call({ title: "T" }, extra("b1"));
  assert.equal(none.isError, true);
  assert.match(text(none), /Offers work only in a Perch chat/);
  const unsigned = await call({ title: "T" }, extra("b1", { id: "perchlive-q", gateway: "perch", sig: false }));
  assert.equal(unsigned.isError, true);
  assert.match(text(unsigned), /Offers work only in a Perch chat/);
  const gmail = await call({ title: "T" }, extra("b1", { id: "thread-g", gateway: "gmail" }));
  assert.equal(gmail.isError, true);
  assert.match(text(gmail), /Offers work only in a Perch chat/);
  assert.equal(offers().length, 0);

  const ok = await call({ title: "Draft the reply" }, extra("b1", { id: "perchlive-q", gateway: "perch" }));
  assert.notEqual(ok.isError, true, text(ok));
  const body = JSON.parse(text(ok));
  assert.equal(body.offered, true);
  assert.equal(body.duplicate, false);
  assert.equal(body.project.id, PID);
  const rows = offers();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, body.offer_id);
  assert.equal(rows[0].status, "pending");
  assert.equal(rows[0].project_id, PID);
  assert.equal(rows[0].bot_id, "b1");
  assert.equal(rows[0].thread_id, "perchlive-q");
});

test("board_offer_card never creates a card", async () => {
  const before_ = cardCount();
  const r = await call({ title: "No card yet" }, extra("b1", { id: "perchlive-q", gateway: "perch" }));
  assert.notEqual(r.isError, true, text(r));
  assert.equal(cardCount(), before_);
});

test("an offer from a bot without a board is refused at offer time", async () => {
  await assert.rejects(svc.offerCard(cdb, { botId: "nob", threadId: "perchlive-n", title: "T" }), (e) => e.code === "no_board");
  await assert.rejects(svc.offerCard(cdb, { botId: "ghost", threadId: "perchlive-n", title: "T" }), (e) => e.code === "no_board");
  const r = await call({ title: "T" }, extra("nob", { id: "perchlive-n", gateway: "perch" }));
  assert.equal(r.isError, true);
  assert.match(text(r), /This bot has no board to put a card on/);
  assert.equal(offers().length, 0);
});

test("a same-title pending offer is a duplicate; a fourth pending offer is refused", async () => {
  const T = { botId: "b1", threadId: "perchlive-d" };
  const a = await svc.offerCard(cdb, { ...T, title: "  One\n" });
  const again = await svc.offerCard(cdb, { ...T, title: "One" });
  assert.deepEqual(again, { offerId: a.offerId, projectId: PID, duplicate: true });
  await svc.offerCard(cdb, { ...T, title: "Two" });
  await svc.offerCard(cdb, { ...T, title: "Three" });
  await assert.rejects(svc.offerCard(cdb, { ...T, title: "Four" }), (e) => e.code === "too_many_offers");
  // another thread has its own allowance
  assert.equal((await svc.offerCard(cdb, { botId: "b1", threadId: "perchlive-e", title: "Four" })).duplicate, false);
  // the title is cleaned: control characters out, trimmed; blank is refused
  assert.equal(offers().find((o) => o.id === a.offerId).title, "One");
  await assert.rejects(svc.offerCard(cdb, { ...T, title: " \u0007 " }), (e) => e.code === "bad_title");
});

test("listOffers: newest first, the public shape", async () => {
  const T = { botId: "b1", threadId: "perchlive-l" };
  const a = await svc.offerCard(cdb, { ...T, title: "A" });
  const b = await svc.offerCard(cdb, { ...T, title: "B" });
  assert.deepEqual(await svc.listOffers(cdb, "perchlive-l"), [
    { id: b.offerId, title: "B", projectId: PID, status: "pending", cardId: null, projectName: "B1 board" },
    { id: a.offerId, title: "A", projectId: PID, status: "pending", cardId: null, projectName: "B1 board" },
  ]);
});

test("tagList splits on spaces and commas; findOfferCard matches the exact tag", () => {
  assert.deepEqual(svc.tagList("x, crow-offer-1  y,,z"), ["x", "crow-offer-1", "y", "z"]);
  assert.deepEqual(svc.tagList(null), []);
});

test("readers tolerate a store without card_offers", async () => {
  const { createDbClient } = await import("../servers/db.js");
  const p = join(dir, "bare.db");
  new Database(p).close();
  const bare = createDbClient(p);
  try {
    assert.deepEqual(await svc.listOffers(bare, "x"), []);
    assert.equal(await svc.getOffer(bare, 1), null);
    assert.deepEqual(await svc.sweepOffers(bare, tdb), { settled: 0, reopened: 0 });
    assert.deepEqual(await svc.claimOfferNotes(bare, "x"), { lines: [], claims: [] });
  } finally { bare.close(); }
});

test("board_offer_card on a store without card_offers is a clean error, not a crash", async () => {
  const c = raw(); c.exec("ALTER TABLE card_offers RENAME TO card_offers_hold"); c.close();
  try {
    await assert.rejects(svc.offerCard(cdb, { botId: "b1", threadId: "perchlive-m", title: "T" }), (e) => e.code === "not_migrated" && e.http === 503);
    const r = await call({ title: "T" }, extra("b1", { id: "perchlive-m", gateway: "perch" }));
    assert.equal(r.isError, true);
    assert.match(text(r), /not available until the store is migrated/);
  } finally {
    const d = raw(); d.exec("ALTER TABLE card_offers_hold RENAME TO card_offers"); d.close();
  }
});

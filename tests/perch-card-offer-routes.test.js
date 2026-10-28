/**
 * Redesign P5 Task 5.2: the operator's one tap on a card offer.
 *
 *   GET  /dashboard/perch-api/interactive/:sid/offers   {offers}
 *   POST /dashboard/perch-api/offers/:id/decide          {accept}
 *
 * Mounted behind the REAL csrfMiddleware and a session stub (perch-give-card's harness). A fake
 * engine stands in for pi. Accepting makes ONE card on the bot's board, tagged crow-offer-<id>,
 * links the chat to it, and starts nothing; the bot hears one fixed line on its next turn.
 * Crash recovery (C8) and the lease are driven by the offer-service clock seam and the route's
 * accept barrier, never by real sleeps.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "perch-card-offer-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
const DB_FILE = join(dir, "crow.db");
const TASKS = process.env.CROW_TASKS_DB_PATH;
const REPO = new URL("..", import.meta.url).pathname;

let server, base, _setEngineStatusForTest, _setOfferAcceptBarrierForTest, svc, createDbClient;
let engineImpl, calls, PID;

const raw = () => new Database(DB_FILE);
const rawTasks = () => new Database(TASKS);
const q = (sql, ...a) => { const c = raw(); const r = c.prepare(sql).all(...a); c.close(); return r; };
const offerRow = (id) => q("SELECT * FROM card_offers WHERE id=?", id)[0];
const cardsTagged = (id) => { const t = rawTasks(); const r = t.prepare("SELECT * FROM tasks_items WHERE tags=?").all("crow-offer-" + id); t.close(); return r; };
const cardCount = () => { const t = rawTasks(); const n = t.prepare("SELECT COUNT(*) AS n FROM tasks_items").get().n; t.close(); return n; };

function seedBot(id, def, { enabled = 1, project = null } = {}) {
  const c = raw();
  c.prepare("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,?,?)")
    .run(id, id, JSON.stringify(def), enabled, project);
  c.close();
}
const BOARD_ON = { gateways: [{ type: "perch" }], tracker_config: { type: "kanban" } };

function seedOffer({ bot = "b1", thread = "perchlive-q", title = "Draft the reply", status = "pending", cardId = null, lease = null, token = null } = {}) {
  const c = raw();
  const r = c.prepare(`INSERT INTO card_offers (bot_id, thread_id, title, project_id, status, card_id, lease_until, claim_token, decided_at)
    VALUES (?,?,?,?,?,?,?,?, CASE WHEN ? = 'pending' THEN NULL ELSE datetime('now') END)`)
    .run(bot, thread, title, PID, status, cardId, lease, token, status);
  c.close();
  return Number(r.lastInsertRowid);
}
function seedCard(tags, title = "seeded", { bot = "b1", project = PID } = {}) {
  const t = rawTasks();
  const r = t.prepare("INSERT INTO tasks_items (title, tags, project_id, assigned_bot) VALUES (?,?,?,?)").run(title, tags, project, bot);
  t.close();
  return Number(r.lastInsertRowid);
}

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const c = raw();
  PID = Number(c.prepare("INSERT INTO project_spaces (slug, name) VALUES ('b1-board','B1 board')").run().lastInsertRowid);
  c.close();
  seedBot("b1", BOARD_ON, { project: PID });

  const t = rawTasks();
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, board_id INTEGER, bot_id TEXT, action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT,
    autonomy TEXT NOT NULL DEFAULT 'gated', archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}')`);
  t.exec(`CREATE TABLE board_mutations (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
    verb TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT, job_id TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  t.close();

  ({ _setEngineStatusForTest } = await import("../servers/gateway/dashboard/panels/bot-builder/engine-gate.js"));
  const mod = await import("../servers/gateway/routes/perch-interactive-api.js");
  _setOfferAcceptBarrierForTest = mod._setOfferAcceptBarrierForTest;
  svc = await import("../servers/gateway/board/offer-service.js");
  ({ createDbClient } = await import("../servers/db.js"));
  const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
  const { parseCookies } = await import("../servers/gateway/dashboard/auth.js");
  const { default: express } = await import("express");

  const auth = (req, res, next) => (parseCookies(req).crow_session === "good" ? next() : res.status(401).json({ error: "unauthorized" }));
  const app = express();
  app.use(express.json());
  const router = express.Router();
  router.use("/dashboard", csrfMiddleware);
  router.use(mod.default(auth, {
    engine: () => engineImpl,
    annotate: async (m) => m, providerModels: () => [], piProviders: () => null,
  }));
  app.use(router);
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port + "/dashboard/perch-api";
});

after(() => {
  _setEngineStatusForTest(null);
  if (svc) svc._setClockForTest(null);
  if (_setOfferAcceptBarrierForTest) _setOfferAcceptBarrierForTest(null);
  if (server) { server.closeAllConnections(); server.close(); }
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  _setEngineStatusForTest({ state: "ready", source: "test", cliPath: "/nonexistent/pi" });
  svc._setClockForTest(null);
  _setOfferAcceptBarrierForTest(null);
  seedBot("b1", BOARD_ON, { project: PID });
  const c = raw(); c.exec("DELETE FROM card_offers"); c.close();
  calls = { spawn: [], message: [], checkCardFree: [], attach: [] };
  engineImpl = {
    async checkCardFree(cardId, opts) { calls.checkCardFree.push([cardId, opts]); },
    async attachCard(sid, cardId) { calls.attach.push([sid, cardId]); return { ok: true, cardId, botId: "b1" }; },
    async spawn(o) { calls.spawn.push(o); return { sessionId: "x", threadId: "x", state: "awake" }; },
    async message(sid, text) { calls.message.push({ sid, text }); return { turnId: "t" + calls.message.length }; },
  };
});

const AUTHED = { cookie: "crow_session=good; crow_csrf=tok", "x-crow-csrf": "tok" };
async function post(path, body, headers = AUTHED) {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function get(path, headers = AUTHED) {
  const r = await fetch(base + path, { headers });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const decide = (id, accept, headers) => post(`/offers/${id}/decide`, { accept }, headers);
async function withClients(fn) {
  const db = createDbClient(DB_FILE), tdb = createDbClient(TASKS);
  try { return await fn(db, tdb); } finally { db.close(); tdb.close(); }
}
const sweep = () => withClients((db, tdb) => svc.sweepOffers(db, tdb));

/** A barrier the accept awaits right after its claim; `reached` resolves when it gets there. */
function pauseAccept() {
  let reachedFn, releaseFn;
  const reached = new Promise((r) => { reachedFn = r; });
  const released = new Promise((r) => { releaseFn = r; });
  _setOfferAcceptBarrierForTest(async () => { reachedFn(); await released; });
  return { reached, release: releaseFn };
}

// ---- the rails ----

test("the offer routes need CSRF", async () => {
  const id = seedOffer();
  const noEcho = await decide(id, true, { cookie: "crow_session=good; crow_csrf=tok" });
  assert.equal(noEcho.status, 403);
  const bad = await decide(id, true, { cookie: "crow_session=good; crow_csrf=tok", "x-crow-csrf": "nope" });
  assert.equal(bad.status, 403);
  assert.equal((await decide(id, true, {})).status, 401);
  assert.equal((await get("/interactive/perchlive-q/offers", {})).status, 401);
  assert.equal(offerRow(id).status, "pending");
  assert.equal(cardsTagged(id).length, 0);
});

test("an unknown offer is 404; a body without a boolean accept is 400", async () => {
  assert.equal((await decide(999999, true)).status, 404);
  const id = seedOffer();
  assert.equal((await post(`/offers/${id}/decide`, { accept: "yes" })).status, 400);
  assert.equal((await post(`/offers/abc/decide`, { accept: true })).status, 400);
  assert.equal(offerRow(id).status, "pending");
});

// ---- accept / decline ----

test("accept makes one card on the bot's board and links the chat", async () => {
  const id = seedOffer();
  const r = await decide(id, true);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const cards = cardsTagged(id);
  assert.equal(cards.length, 1);
  const card = cards[0];
  assert.deepEqual(r.body, { ok: true, status: "accepted", cardId: card.id, projectId: PID, attached: true });
  assert.equal(card.title, "Draft the reply");
  assert.equal(card.project_id, PID);
  assert.equal(card.assigned_bot, "b1");
  assert.equal(card.autonomy, "gated");
  assert.equal(card.tags, `crow-offer-${id}`);
  assert.deepEqual(calls.attach, [["perchlive-q", card.id]]);
  assert.deepEqual(calls.checkCardFree, [[card.id, { excludeSessionId: "perchlive-q" }]]);
  const row = offerRow(id);
  assert.equal(row.status, "accepted");
  assert.equal(row.card_id, card.id);
  const audit = q("SELECT payload FROM project_audit_log WHERE action='card_given' AND target=?", `card:${card.id}`);
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0].payload), { bot_id: "b1", created: true });
});

test("accepting starts no turn", async () => {
  const id = seedOffer();
  assert.equal((await decide(id, true)).status, 200);
  assert.equal(calls.message.length, 0);
  assert.equal(calls.spawn.length, 0);
});

test("a chat with no live session still gets its card; the link is skipped", async () => {
  engineImpl.attachCard = async () => { throw Object.assign(new Error("no_such_session"), { code: "no_such_session" }); };
  const id = seedOffer({ thread: "perchlive-gone" });
  const r = await decide(id, true);
  assert.equal(r.status, 200);
  assert.equal(r.body.attached, false);
  assert.equal(cardsTagged(id).length, 1);
  assert.equal(offerRow(id).card_id, cardsTagged(id)[0].id);
});

test("decline makes nothing", async () => {
  const id = seedOffer();
  const r = await decide(id, false);
  assert.deepEqual(r.body, { ok: true, status: "declined" });
  assert.equal(offerRow(id).status, "declined");
  assert.equal(cardsTagged(id).length, 0);
});

test("deciding a decided offer is 409 and creates no card", async () => {
  const id = seedOffer();
  assert.equal((await decide(id, true)).status, 200);
  const again = await decide(id, true);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "already_decided");
  assert.equal((await decide(id, false)).status, 409);
  assert.equal(cardsTagged(id).length, 1);

  const id2 = seedOffer({ title: "Other" });
  assert.equal((await decide(id2, false)).status, 200);
  const after2 = await decide(id2, true);
  assert.equal(after2.status, 409);
  assert.equal(after2.body.error, "already_decided");
  assert.equal(cardsTagged(id2).length, 0);
});

test("two taps at once make one card", async () => {
  const id = seedOffer();
  const rs = await Promise.all([decide(id, true), decide(id, true)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  assert.equal(cardsTagged(id).length, 1);
});

test("a failed create leaves the offer pending", async () => {
  const id = seedOffer();
  seedBot("b1", { gateways: [{ type: "perch" }], tracker_config: { type: "none" } }, { project: PID });
  const before_ = cardCount();
  const r = await decide(id, true);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "no_board");
  const offers = await withClients((db) => svc.listOffers(db, "perchlive-q"));
  assert.equal(offers.find((o) => o.id === id).status, "pending");
  const row = offerRow(id);
  assert.equal(row.claim_token, null);
  assert.equal(row.lease_until, null);
  assert.equal(cardCount(), before_);
});

// ---- C8 recovery ----

test("a crash after the create recovers to the same card", async () => {
  const id = seedOffer({ status: "accepted", lease: "2999-01-01T00:00:00.000Z", token: "t" });
  const cardId = seedCard(`crow-offer-${id}`);
  const r = await get("/interactive/perchlive-q/offers");
  assert.equal(r.status, 200);
  const o = r.body.offers.find((x) => x.id === id);
  assert.deepEqual(o, { id, title: "Draft the reply", projectId: PID, status: "accepted", cardId, projectName: "B1 board" });
  assert.equal(offerRow(id).card_id, cardId);
  assert.equal(cardsTagged(id).length, 1);
});

test("an expired accept with no card goes back to pending", async () => {
  const id = seedOffer({ status: "accepted", lease: "2000-01-01T00:00:00.000Z", token: "t" });
  const r = await get("/interactive/perchlive-q/offers");
  assert.equal(r.body.offers.find((x) => x.id === id).status, "pending");
  const row = offerRow(id);
  assert.equal(row.claim_token, null);
  assert.equal(row.decided_at, null);
  // ... and it can be accepted again, once
  assert.equal((await decide(id, true)).status, 200);
  assert.equal(cardsTagged(id).length, 1);
});

test("an offer that has a card is never reset", async () => {
  const cardId = seedCard("unrelated");
  const id = seedOffer({ status: "accepted", cardId, lease: "2000-01-01T00:00:00.000Z" });
  await withClients(async (db, tdb) => {
    const r = await svc.recoverOffer(db, tdb, offerRow(id));
    assert.equal(r.status, "accepted");
    assert.equal(r.card_id, cardId);
  });
  assert.deepEqual(await sweep(), { settled: 0, reopened: 0 });
  assert.equal(offerRow(id).card_id, cardId);
});

test("offer 1 never matches crow-offer-12", async () => {
  // A scratch store pair, so offer id 1 is really offer 1.
  const d2 = mkdtempSync(join(tmpdir(), "offer-one-"));
  try {
    const { run } = await import("../scripts/migrations/0011-card-offers.mjs");
    const cpath = join(d2, "crow.db"), tpath = join(d2, "tasks.db");
    new Database(cpath).close();
    run({ dbPath: cpath });
    const c = new Database(cpath);
    c.prepare("INSERT INTO card_offers (id, bot_id, thread_id, title, project_id, status, lease_until) VALUES (1,'b1','t','T',1,'accepted','2999-01-01T00:00:00.000Z')").run();
    c.close();
    const t = new Database(tpath);
    t.exec("CREATE TABLE tasks_items (id INTEGER PRIMARY KEY, title TEXT, tags TEXT, board_id INTEGER, project_id INTEGER, assigned_bot TEXT)");
    t.prepare("INSERT INTO tasks_items (id, title, tags, assigned_bot) VALUES (5,'x','crow-offer-12','b1'),(6,'y','a,xcrow-offer-1','b1'),(7,'z','crow-offer-1x','b1')").run();
    t.close();
    const db = createDbClient(cpath), tdb = createDbClient(tpath);
    try {
      assert.equal(await svc.findOfferCard(tdb, 1, "b1"), null);
      const r = await svc.recoverOffer(db, tdb, await svc.getOffer(db, 1));
      assert.equal(r.card_id, null, "not settled to another offer's card");
      assert.equal(r.status, "accepted", "the lease is live, so it is not reopened either");
      await tdb.execute("INSERT INTO tasks_items (id, title, tags, assigned_bot) VALUES (8,'w','gift, crow-offer-1','b1')");
      assert.equal(await svc.findOfferCard(tdb, 1, "b1"), 8);
    } finally { db.close(); tdb.close(); }
  } finally { rmSync(d2, { recursive: true, force: true }); }
});

test("a slow accept is never raced", async () => {
  let clock = Date.parse("2030-01-01T00:00:00Z");
  svc._setClockForTest(() => clock);
  const id = seedOffer();
  const gate = pauseAccept();
  const pending = decide(id, true);
  try {
    await gate.reached;
    assert.equal(offerRow(id).status, "accepted");
    clock += 60_000;
    assert.deepEqual(await sweep(), { settled: 0, reopened: 0 }, "60 s: the lease is live");
    clock += 40_000;
    assert.deepEqual(await sweep(), { settled: 0, reopened: 0 }, "100 s: still live");
    assert.equal(offerRow(id).status, "accepted");
  } finally { gate.release(); }
  const r = await pending;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(cardsTagged(id).length, 1);
  assert.equal(offerRow(id).card_id, cardsTagged(id)[0].id);
});

test("an accept whose lease was taken over makes nothing", async () => {
  const id = seedOffer();
  const gate = pauseAccept();
  const before_ = cardCount();
  const pending = decide(id, true);
  try {
    await gate.reached;
    const c = raw(); c.prepare("UPDATE card_offers SET claim_token='someone-else' WHERE id=?").run(id); c.close();
  } finally { gate.release(); }
  const r = await pending;
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "already_decided");
  assert.equal(cardCount(), before_);
  assert.equal(offerRow(id).claim_token, "someone-else", "the other claim is left alone");
});

test("the sweep settles without anyone opening the chat", async () => {
  const id = seedOffer({ status: "accepted", lease: "2999-01-01T00:00:00.000Z", token: "t" });
  const cardId = seedCard(`crow-offer-${id}`);
  assert.deepEqual(await sweep(), { settled: 1, reopened: 0 });
  assert.equal(offerRow(id).card_id, cardId);
  assert.deepEqual(await sweep(), { settled: 0, reopened: 0 });
});

test("a busy tasks.db skips the sweep pass", async () => {
  seedOffer({ status: "accepted", lease: "2000-01-01T00:00:00.000Z", token: "t" });
  const busy = { execute: async () => { throw Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" }); } };
  const db = createDbClient(DB_FILE);
  try {
    assert.deepEqual(await svc.sweepOffers(db, busy), { settled: 0, reopened: 0, skipped: true });
  } finally { db.close(); }
});

// ---- the bot hears about it ----

test("the bot hears about the card once", async () => {
  const id = seedOffer();
  const { body } = await decide(id, true);
  const r1 = await post("/interactive/perchlive-q/message", { message: "thanks" });
  assert.equal(r1.status, 202);
  assert.equal(calls.message[0].sid, "perchlive-q");
  assert.equal(calls.message[0].text, `[Crow] The operator made card #${body.cardId} from your offer.\n\nthanks`);
  await post("/interactive/perchlive-q/message", { message: "next" });
  assert.equal(calls.message[1].text, "next");
  assert.ok(offerRow(id).note_delivered_at);
});

test("a turn that never started keeps the note for the next one", async () => {
  const id = seedOffer();
  const { body } = await decide(id, true);
  const ok = engineImpl.message;
  engineImpl.message = async () => { throw Object.assign(new Error("turn_in_progress"), { code: "turn_in_progress" }); };
  assert.equal((await post("/interactive/perchlive-q/message", { message: "a" })).status, 409);
  assert.equal(offerRow(id).note_delivered_at, null);
  engineImpl.message = ok;
  await post("/interactive/perchlive-q/message", { message: "b" });
  assert.equal(calls.message[0].text, `[Crow] The operator made card #${body.cardId} from your offer.\n\nb`);
});

test("another chat's message carries no note", async () => {
  const id = seedOffer();
  assert.equal((await decide(id, true)).status, 200);
  await post("/interactive/perchlive-other/message", { message: "hi" });
  assert.equal(calls.message[0].text, "hi");
  assert.equal(offerRow(id).note_delivered_at, null);
});

test("the boot/timer sweep opens tasks.db only when an accept was stranded", async () => {
  let opened = 0;
  const openTasks = () => { opened++; return createDbClient(TASKS); };
  assert.deepEqual(await svc.runOfferSweep(() => createDbClient(DB_FILE), openTasks), { settled: 0, reopened: 0 });
  assert.equal(opened, 0);
  const id = seedOffer({ status: "accepted", lease: "2999-01-01T00:00:00.000Z", token: "t" });
  const cardId = seedCard(`crow-offer-${id}`);
  assert.deepEqual(await svc.runOfferSweep(() => createDbClient(DB_FILE), openTasks), { settled: 1, reopened: 0 });
  assert.equal(opened, 1);
  assert.equal(offerRow(id).card_id, cardId);
});

test("the gateway runs the sweep before listen and every 10 minutes after", async () => {
  const { readFileSync } = await import("node:fs");
  const idx = readFileSync(join(REPO, "servers/gateway/index.js"), "utf8");
  const sweepAt = idx.indexOf("runOfferSweep(");
  assert.ok(sweepAt > idx.indexOf("await initOAuthTables();"), "after the first createDbClient (the registry's order invariant)");
  assert.ok(sweepAt < idx.indexOf("app.listen("), "before listen");
  const pl = readFileSync(join(REPO, "servers/gateway/boot/post-listen.js"), "utf8");
  assert.match(pl, /runOfferSweep\(/);
  assert.match(pl, /OFFER_SWEEP_INTERVAL_MS = 10 \* 60 \* 1000/);
});

// ---- fix round 1 ----

test("a hand-tagged card that is not the offering bot's is never adopted", async () => {
  const id = seedOffer({ status: "accepted", lease: "2000-01-01T00:00:00.000Z", token: "t" });
  seedCard(`crow-offer-${id}`, "someone else's", { bot: "b9" });
  seedCard(`crow-offer-${id}`, "nobody's", { bot: null });
  const r = await get("/interactive/perchlive-q/offers");
  const o = r.body.offers.find((x) => x.id === id);
  assert.equal(o.cardId, null, "not settled to a card the bot was never given");
  assert.equal(o.status, "pending", "and the expired accept reopens");
  // the bot's own tagged card is adopted
  const id2 = seedOffer({ title: "Mine", status: "accepted", lease: "2999-01-01T00:00:00.000Z", token: "t" });
  const mine = seedCard(`crow-offer-${id2}`, "mine");
  assert.deepEqual(await sweep(), { settled: 1, reopened: 0 });
  assert.equal(offerRow(id2).card_id, mine);
});

test("listOffers reports the project the card really went to", async () => {
  const c = raw();
  const PID_NEW = Number(c.prepare("INSERT INTO project_spaces (slug, name) VALUES ('b1-new-board','B1 new board')").run().lastInsertRowid);
  c.close();
  const id = seedOffer();                       // named the old board at offer time
  seedBot("b1", BOARD_ON, { project: PID_NEW });  // the bot's board moved before the accept
  const r = await decide(id, true);
  assert.equal(r.status, 200);
  assert.equal(r.body.projectId, PID_NEW);
  assert.equal(cardsTagged(id)[0].project_id, PID_NEW);
  const offers = (await get("/interactive/perchlive-q/offers")).body.offers;
  assert.equal(offers.find((o) => o.id === id).projectId, PID_NEW);
  assert.equal(offers.find((o) => o.id === id).projectName, "B1 new board", "the name rides the response, matching the real project");
  assert.equal(offerRow(id).project_id, PID_NEW);
});

test("recovery also settles the card's real project", async () => {
  const c = raw();
  const PID_X = Number(c.prepare("INSERT INTO project_spaces (slug, name) VALUES ('b1-x','B1 x')").run().lastInsertRowid);
  c.close();
  const id = seedOffer({ status: "accepted", lease: "2999-01-01T00:00:00.000Z", token: "t" });
  const cardId = seedCard(`crow-offer-${id}`, "moved", { project: PID_X });
  assert.deepEqual(await sweep(), { settled: 1, reopened: 0 });
  assert.equal(offerRow(id).card_id, cardId);
  assert.equal(offerRow(id).project_id, PID_X);
});

test("reading a chat's offers never makes a tasks.db on an install without one", async () => {
  const { renameSync, existsSync } = await import("node:fs");
  seedOffer();                                   // pending, not stranded
  renameSync(TASKS, TASKS + ".away");
  try {
    const r = await get("/interactive/perchlive-q/offers");
    assert.equal(r.status, 200);
    assert.equal(r.body.offers.length, 1);
    assert.equal(existsSync(TASKS), false, "no tasks.db was created");
  } finally {
    renameSync(TASKS + ".away", TASKS);
  }
});

test("a chat that already has a card keeps it: accepting makes the card and does not re-link", async () => {
  const cardA = seedCard("hand-made-a", "card A");
  const c = raw();
  c.prepare("INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, kind, card_id, status) VALUES ('b1','perch','perchlive-has','perch-live',?, 'active')").run(cardA);
  c.close();
  const id = seedOffer({ thread: "perchlive-has" });
  const r = await decide(id, true);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const made = cardsTagged(id);
  assert.equal(made.length, 1);
  assert.notEqual(made[0].id, cardA);
  assert.equal(r.body.attached, false);
  assert.deepEqual(calls.attach, []);
  assert.equal(q("SELECT card_id FROM bot_sessions WHERE gateway_thread_id='perchlive-has'")[0].card_id, cardA);
  assert.equal(offerRow(id).card_id, made[0].id);
});

test("offerCard on a store without card_offers is not_migrated (503)", async () => {
  const { offerCard } = svc;
  const fakeDb = {
    async execute(a) {
      const sql = String(a.sql || a);
      if (/INSERT INTO card_offers/.test(sql)) throw new Error("SQLITE_ERROR: no such table: card_offers");
      return createDbClient().execute(a);
    },
  };
  await assert.rejects(() => offerCard(fakeDb, { botId: "b1", threadId: "perchlive-x", title: "t" }),
    (e) => e.code === "not_migrated" && e.http === 503);
});

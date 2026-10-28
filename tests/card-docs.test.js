/**
 * P6 Task 6.1: a card lists its documents, and each document knows its card.
 *
 * Core (make/card-docs.js) against a scratch crow.db built by init-db plus the
 * Artifacts bundle's own tables, and a hand-made instance-global tasks.db.
 * The shell-api routes are mounted behind the REAL csrfMiddleware and a
 * session-checking auth stub, as dashboard/index.js orders them.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "card-docs-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
const DB_FILE = join(dir, "crow.db");
const REPO = new URL("..", import.meta.url).pathname;

const raw = () => new Database(DB_FILE);
let server, base, db, docs, items, botBoardPanel;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, plan_ref TEXT, board_id INTEGER, data_json TEXT NOT NULL DEFAULT '{}',
    archived_at TEXT, autonomy TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`);
  t.prepare("INSERT INTO tasks_items (id, title) VALUES (9, 'Write the report')").run();
  t.prepare("INSERT INTO tasks_items (id, title) VALUES (12, 'Another card')").run();
  t.close();

  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  const { initArtifactsTables } = await import("../bundles/artifacts/server/init-tables.js");
  await initArtifactsTables(db);

  docs = await import("../servers/gateway/make/card-docs.js");
  items = await import("../servers/shared/shell-items.js");
  ({ default: botBoardPanel } = await import("../servers/gateway/dashboard/panels/bot-board.js"));
  const { shellApiRouter } = await import("../servers/gateway/routes/shell-api.js");
  const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
  const { parseCookies } = await import("../servers/gateway/dashboard/auth.js");
  const { default: express } = await import("express");
  const auth = (req, res, next) => (parseCookies(req).crow_session === "good" ? next() : res.redirect("/dashboard/login"));
  const app = express();
  app.use(express.json());
  const router = express.Router();
  router.use("/dashboard", csrfMiddleware);
  router.use(shellApiRouter(auth));
  app.use(router);
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port + "/dashboard";
});

after(() => { if (server) server.close(); try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

beforeEach(() => {
  const c = raw();
  c.exec("DELETE FROM shell_items; DELETE FROM artifact_links; DELETE FROM artifacts; DELETE FROM bot_sessions;");
  c.close();
});

function addArtifact(id, { title = `T ${id}`, card = null, session = null, deleted = null } = {}) {
  const c = raw();
  c.prepare("INSERT INTO artifacts (id, title, type, created_by_bot, origin_session, origin_card, received, deleted_at) VALUES (?,?,?,?,?,?,0,?)")
    .run(id, title, "document", "bobby", session, card, deleted);
  c.close();
}
function addSession(thread, card) {
  const c = raw();
  c.prepare("INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, card_id, status, kind) VALUES ('bobby','perch',?,?,'active','perch-live')").run(thread, card);
  c.close();
}
function addLink(artifact, thread, { unlinked = null } = {}) {
  const c = raw();
  c.prepare("INSERT INTO artifact_links (artifact_id, bot_id, thread_id, linked_by, unlinked_at) VALUES (?,?,?,'origin',?)").run(artifact, "bobby", thread, unlinked);
  c.close();
}
const pairs = (list) => list.map((d) => `${d.kind}:${d.ref}`);

const AUTHED = { cookie: "crow_session=good; crow_csrf=tok", "x-crow-csrf": "tok" };
async function post(path, body, headers = AUTHED) {
  const r = await fetch(base + path, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function get(path, headers = AUTHED) {
  const r = await fetch(base + path, { redirect: "manual", headers });
  return { status: r.status, body: await r.json().catch(() => null) };
}

test("a card lists the artifact its chat made", async () => {
  addArtifact("art_7", { title: "Quarterly report" });
  addSession("perchlive-q", 9);
  addLink("art_7", "perchlive-q");
  const list = await docs.documentsForCard(db, 9);
  const doc = list.find((d) => d.kind === "artifact" && d.ref === "art_7");
  assert.ok(doc, "art_7 is listed on card 9");
  assert.equal(doc.title, "Quarterly report");
  assert.equal(doc.openUrl, "/dashboard/make/open/artifact/art_7");
  assert.deepEqual(pairs(await docs.documentsForCard(db, 12)), [], "another card lists nothing");
});

test("only the thread's NEWEST perch-live session decides its card, and an unlinked chat stops counting", async () => {
  addArtifact("art_moved");
  addSession("perchlive-m", 9);
  addSession("perchlive-m", 12); // the thread moved on to card 12
  addLink("art_moved", "perchlive-m");
  addArtifact("art_unlinked");
  addSession("perchlive-u", 9);
  addLink("art_unlinked", "perchlive-u", { unlinked: "2026-10-01 00:00:00" });
  assert.deepEqual(pairs(await docs.documentsForCard(db, 9)), []);
  assert.deepEqual(pairs(await docs.documentsForCard(db, 12)), ["artifact:art_moved"]);
});

test("a hand link and origin_card both count, once each", async () => {
  addArtifact("art_both", { card: 9 });
  addArtifact("art_origin", { card: 9 });
  addArtifact("art_hand");
  await items.setItemCard(db, "artifact", "art_both", 9);
  await items.setItemCard(db, "artifact", "art_hand", 9);
  await items.setItemCard(db, "workspace_file", "42", 9);
  addSession("perchlive-b", 9);
  addLink("art_both", "perchlive-b");
  const list = await docs.documentsForCard(db, 9);
  assert.deepEqual(pairs(list).sort(), ["artifact:art_both", "artifact:art_hand", "artifact:art_origin", "workspace_file:42"]);
  const ws = list.find((d) => d.kind === "workspace_file");
  assert.equal(ws.title, "Document 42");
  assert.equal(ws.openUrl, "/dashboard/make/open/workspace_file/42");
  const es = await docs.documentsForCard(db, 9, { lang: "es" });
  assert.equal(es.find((d) => d.kind === "workspace_file").title, "Documento 42");
});

test("cardForDocument prefers the hand link", async () => {
  addArtifact("art_p", { card: 12, session: "perchlive-p" });
  addSession("perchlive-p", 12);
  assert.equal(await docs.cardForDocument(db, "artifact", "art_p"), 12, "origin_card without a hand link");
  await items.setItemCard(db, "artifact", "art_p", 9);
  assert.equal(await docs.cardForDocument(db, "artifact", "art_p"), 9, "the hand link wins");

  addArtifact("art_thread", { session: "perchlive-t" });
  addSession("perchlive-t", 12);
  assert.equal(await docs.cardForDocument(db, "artifact", "art_thread"), 12, "the origin thread's card last");

  addArtifact("art_none");
  assert.equal(await docs.cardForDocument(db, "artifact", "art_none"), null);
  await items.setItemCard(db, "workspace_file", "77", 9);
  assert.equal(await docs.cardForDocument(db, "workspace_file", "77"), 9);
  assert.equal(await docs.cardForDocument(db, "workspace_file", "78"), null);
});

test("a deleted artifact is not listed", async () => {
  addArtifact("art_gone", { card: 9, deleted: "2026-10-01 00:00:00" });
  await items.setItemCard(db, "artifact", "art_gone", 9);
  addSession("perchlive-g", 9);
  addLink("art_gone", "perchlive-g");
  await items.setItemCard(db, "artifact", "art_never_existed", 9);
  assert.deepEqual(pairs(await docs.documentsForCard(db, 9)), []);
  assert.equal(await docs.cardForDocument(db, "artifact", "art_gone"), null);
});

test("missing tables read as no documents, never an error", async () => {
  const { createDbClient } = await import("../servers/db.js");
  const bare = createDbClient(join(dir, "bare.db"));
  try {
    assert.deepEqual(await docs.documentsForCard(bare, 9), []);
    assert.equal(await docs.cardForDocument(bare, "artifact", "art_x"), null);
  } finally { bare.close(); }
});

test("the detail page shows the documents", async () => {
  addArtifact("art_7", { title: "<b>Quarterly</b>" });
  addSession("perchlive-q", 9);
  addLink("art_7", "perchlive-q");
  const html = await botBoardPanel.handler({ method: "GET", query: { card: "9" } }, {}, { db, layout: (o) => o.content, lang: "en" });
  assert.match(html, /href="\/dashboard\/make\/open\/artifact\/art_7"/);
  assert.match(html, />Documents</);
  assert.ok(html.includes("&lt;b&gt;Quarterly&lt;/b&gt;"), "the artifact's title is escaped");
  assert.ok(!html.includes("<b>Quarterly</b>"));
});

test("GET cards/:id/documents lists them", async () => {
  addArtifact("art_7", { card: 9 });
  const r = await get("/shell-api/cards/9/documents");
  assert.equal(r.status, 200);
  assert.deepEqual(pairs(r.body.documents), ["artifact:art_7"]);
  assert.equal((await get("/shell-api/cards/abc/documents")).status, 400);
  assert.notEqual((await get("/shell-api/cards/9/documents", {})).status, 200, "needs a session");
});

test("linking to an unknown card is 404", async () => {
  addArtifact("art_l");
  assert.equal((await post("/shell-api/items/artifact/art_l/card", { card_id: 404 })).status, 404);
  assert.equal((await post("/shell-api/items/artifact/art_missing/card", { card_id: 9 })).status, 404, "an unknown artifact");
  assert.equal((await post("/shell-api/items/perch_thread/perchlive-x/card", { card_id: 9 })).status, 400, "a thread takes its card from its session");
  assert.equal((await post("/shell-api/items/artifact/art_l/card", { card_id: "nine" })).status, 400);
  assert.equal((await post("/shell-api/items/artifact/art_l/card", { card_id: 9 }, { cookie: "crow_session=good" })).status, 403, "the CSRF rail");
  assert.equal(await docs.cardForDocument(db, "artifact", "art_l"), null, "nothing was written");
});

test("POST items/:kind/:ref/card links and unlinks by hand", async () => {
  addArtifact("art_l");
  const r = await post("/shell-api/items/artifact/art_l/card", { card_id: 9 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, card_id: 9 });
  assert.equal(await docs.cardForDocument(db, "artifact", "art_l"), 9);
  assert.deepEqual(pairs(await docs.documentsForCard(db, 9)), ["artifact:art_l"]);
  const u = await post("/shell-api/items/artifact/art_l/card", { card_id: null });
  assert.deepEqual(u.body, { ok: true, card_id: null });
  assert.equal(await docs.cardForDocument(db, "artifact", "art_l"), null);
});

test("clearing the hand link answers with the document's REAL card: origin_card still wins, no claimed detach", async () => {
  addArtifact("art_o", { card: 12 });
  const r = await post("/shell-api/items/artifact/art_o/card", { card_id: 9 });
  assert.deepEqual(r.body, { ok: true, card_id: 9 }, "the hand link wins while it is set");
  const u = await post("/shell-api/items/artifact/art_o/card", { card_id: null });
  assert.equal(u.status, 200);
  assert.deepEqual(u.body, { ok: true, card_id: 12 }, "origin_card, not null");
  assert.equal(await docs.cardForDocument(db, "artifact", "art_o"), 12);
});

test("a Make tile's cardId comes from cardForDocument", async () => {
  const { listArtifactItems } = await import("../servers/gateway/make/sources.js");
  addArtifact("art_thread", { session: "perchlive-mk" });
  addSession("perchlive-mk", 12);
  addArtifact("art_hand", { card: 12 });
  await items.setItemCard(db, "artifact", "art_hand", 9);
  addArtifact("art_plain");
  const tiles = new Map((await listArtifactItems(db)).map((i) => [i.ref, i.cardId]));
  assert.equal(tiles.get("art_thread"), 12, "the origin thread's card");
  assert.equal(tiles.get("art_hand"), 9, "the hand link");
  assert.equal(tiles.get("art_plain"), null);
});

test("the card drawer has a Documents list, filled from GET /card/:id as text", async () => {
  const { drawerMarkup } = await import("../servers/gateway/dashboard/panels/bot-board/html.js");
  const { clientJs } = await import("../servers/gateway/dashboard/panels/bot-board/client.js");
  const es = drawerMarkup("es");
  assert.match(es, /<div id="bb-d-docs-wrap" hidden>\s*<h4[^>]*>Documentos<\/h4>\s*<ul id="bb-d-docs"/);
  const js = clientJs("b1", "kanban", 1, null, null, "en", false);
  const body = js.replace(/^<script>/, "").replace(/<\/script>$/, "");
  assert.doesNotThrow(() => new Function(body), "the client script parses");
  const fn = body.slice(body.indexOf("function renderDocuments("), body.indexOf("function renderPre("));
  assert.match(fn, /a\.textContent=/, "titles go in as text");
  assert.doesNotMatch(fn, /innerHTML/);
  assert.match(fn, /indexOf\('\/dashboard\/make\/open\/'\)!==0\) return;/, "only the Make open route is linked");
  assert.match(body, /renderDocuments\(r\.j\.documents\|\|\[\]\)/, "hydration fills it");
});

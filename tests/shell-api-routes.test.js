/**
 * Task 1.4: a chat started in a project belongs to it, and any item can be
 * moved. Both routers are mounted behind the REAL csrfMiddleware and a
 * session-checking auth stub, as dashboard/index.js orders them. A fake
 * interactive engine stands in for pi.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "shell-api-routes-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
const DB_FILE = join(dir, "crow.db");
const REPO = new URL("..", import.meta.url).pathname;

let server, base, _setEngineStatusForTest, spawnCalls = 0, db, getItem;
let P1, P2;
const raw = () => new Database(DB_FILE);

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const c = raw();
  const mk = (slug) => Number(c.prepare("INSERT INTO project_spaces (slug, name) VALUES (?,?)").run(slug, slug).lastInsertRowid);
  P1 = mk("alpha"); P2 = mk("beta");
  const PERCH = JSON.stringify({ gateways: [{ type: "perch" }] });
  c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES ('b1','B1',?,1,?)").run(PERCH, P1);
  c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES ('b2','B2',?,1)").run(PERCH);
  c.prepare("INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, status, control, kind) VALUES ('b1','perch','perchlive-real','active','run','perch-live')").run();
  c.exec(`CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, title TEXT, deleted_at TEXT)`);
  c.prepare("INSERT OR IGNORE INTO artifacts (id, title) VALUES ('art_1','one')").run();
  c.prepare("INSERT OR IGNORE INTO artifacts (id, title, deleted_at) VALUES ('art_gone','gone','2026-01-01')").run();
  c.close();

  ({ _setEngineStatusForTest } = await import("../servers/gateway/dashboard/panels/bot-builder/engine-gate.js"));
  ({ getItem } = await import("../servers/shared/shell-items.js"));
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  const { default: perchInteractiveApiRouter } = await import("../servers/gateway/routes/perch-interactive-api.js");
  const { shellApiRouter } = await import("../servers/gateway/routes/shell-api.js");
  const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
  const { parseCookies } = await import("../servers/gateway/dashboard/auth.js");
  const { default: express } = await import("express");

  const auth = (req, res, next) => {
    if (parseCookies(req).crow_session === "good") return next();
    if (req.method === "GET") return res.redirect("/dashboard/login");
    return res.redirect("/dashboard/login");
  };
  const app = express();
  app.use(express.json());
  const router = express.Router();
  router.use("/dashboard", csrfMiddleware);
  router.use(perchInteractiveApiRouter(auth, {
    engine: () => ({ async spawn() { spawnCalls++; return { sessionId: "perchlive-t1", threadId: "perchlive-t1", state: "awake" }; } }),
    annotate: async (m) => m, providerModels: () => [], piProviders: () => null,
  }));
  router.use(shellApiRouter(auth));
  app.use(router);
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port + "/dashboard";
});

after(() => { _setEngineStatusForTest(null); if (server) server.close(); try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { const c = raw(); c.prepare("DELETE FROM shell_items").run(); c.close(); spawnCalls = 0; _setEngineStatusForTest({ state: "ready", source: "test", cliPath: "/nonexistent/pi" }); });

const AUTHED = { cookie: "crow_session=good; crow_csrf=tok", "x-crow-csrf": "tok" };
async function post(path, body, headers = AUTHED) {
  const r = await fetch(base + path, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, location: r.headers.get("location"), body: await r.json().catch(() => null) };
}

test("a new thread started in a project belongs to it", async () => {
  const r = await post("/perch-api/bots/b1/interactive", { project_id: P2 });
  assert.equal(r.status, 201);
  assert.equal(r.body.threadId, "perchlive-t1");
  const it = await getItem(db, "perch_thread", "perchlive-t1");
  assert.equal(it.projectId, P2);
  assert.equal(it.setBy, "operator");
});

test("a new thread without a project takes the bot's", async () => {
  const r = await post("/perch-api/bots/b1/interactive", {});
  assert.equal(r.status, 201);
  const it = await getItem(db, "perch_thread", "perchlive-t1");
  assert.equal(it.projectId, P1);
  assert.equal(it.setBy, "origin");
});

test("a new thread started as unassigned has no project", async () => {
  const c = raw(); c.prepare("DELETE FROM shell_items").run(); c.close();
  const r = await post("/perch-api/bots/b1/interactive", { project_id: "unassigned" });
  assert.equal(r.status, 201);
  const it = await getItem(db, "perch_thread", "perchlive-t1");
  assert.equal(it.projectId, null);
  assert.equal(it.setBy, "operator");
});

test("an unknown project is refused before anything spawns", async () => {
  const r = await post("/perch-api/bots/b1/interactive", { project_id: 99999 });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "bad_project");
  assert.equal(spawnCalls, 0);
  const r2 = await post("/perch-api/bots/b1/interactive", { project_id: "nope" });
  assert.equal(r2.status, 400);
  assert.equal(spawnCalls, 0);
});

test("moving an item files it", async () => {
  const r = await post("/shell-api/items/artifact/art_1/project", { project_id: "unassigned" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, project_id: null });
  const r2 = await post("/shell-api/items/artifact/art_1/project", { project_id: P2 });
  assert.deepEqual(r2.body, { ok: true, project_id: P2 });
  assert.equal((await getItem(db, "artifact", "art_1")).projectId, P2);
  const t = await post("/shell-api/items/perch_thread/perchlive-real/project", { project_id: P1 });
  assert.equal(t.status, 200);
});

test("an unknown item is 404 and writes no row", async () => {
  for (const [k, ref] of [["artifact", "art_nope"], ["artifact", "art_gone"], ["perch_thread", "perchlive-nope"], ["workspace_file", "12"]]) {
    const r = await post(`/shell-api/items/${k}/${ref}/project`, { project_id: P1 });
    assert.equal(r.status, 404, `${k}/${ref}`);
    assert.equal(r.body.error, "not_found");
    assert.equal(await getItem(db, k, ref), null);
  }
});

test("a Workspace file needs the bundle installed and a numeric id", async () => {
  writeFileSync(join(HOME, "installed.json"), JSON.stringify([{ id: "workspace", type: "bundle" }]));
  const ok = await post("/shell-api/items/workspace_file/12/project", { project_id: P1 });
  assert.equal(ok.status, 200);
  const bad = await post("/shell-api/items/workspace_file/abc/project", { project_id: P1 });
  assert.equal(bad.status, 400);
  const zero = await post("/shell-api/items/workspace_file/0/project", { project_id: P1 });
  assert.equal(zero.status, 400);
  rmSync(join(HOME, "installed.json"));
});

test("bad kind, bad ref, bad project value: 400 bad_request; an archived project: 409", async () => {
  assert.equal((await post("/shell-api/items/widget/x/project", { project_id: P1 })).body.error, "bad_request");
  assert.equal((await post("/shell-api/items/artifact/a b/project", { project_id: P1 })).status, 400);
  assert.equal((await post("/shell-api/items/artifact/art_1/project", { project_id: "x" })).status, 400);
  assert.equal((await post("/shell-api/items/artifact/art_1/project", {})).status, 400);
  const c = raw();
  const arch = Number(c.prepare("INSERT INTO project_spaces (slug, name, archived_at) VALUES ('old','old','2026-01-01 00:00:00')").run().lastInsertRowid);
  c.close();
  const r = await post("/shell-api/items/artifact/art_1/project", { project_id: arch });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "archived");
  const m = await post("/shell-api/items/artifact/art_1/project", { project_id: 99999 });
  assert.equal(m.status, 404);
});

test("the move route needs a session and the CSRF header", async () => {
  const noSession = await post("/shell-api/items/artifact/art_1/project", { project_id: P1 }, { "x-crow-csrf": "tok", cookie: "crow_csrf=tok" });
  assert.equal(noSession.status, 302);
  assert.match(noSession.location, /login/);
  const noCsrf = await post("/shell-api/items/artifact/art_1/project", { project_id: P1 }, { cookie: "crow_session=good; crow_csrf=tok" });
  assert.equal(noCsrf.status, 403);
});

// ---- final-review fix wave ----

function mkProject(slug, { status = "active", archivedAt = null, type = "general" } = {}) {
  const c = raw();
  const id = Number(c.prepare("INSERT INTO project_spaces (slug, name, status, archived_at, type) VALUES (?,?,?,?,?)").run(slug, slug, status, archivedAt, type).lastInsertRowid);
  c.close();
  return id;
}

test("a status-archived project with a NULL archived_at is refused by both routes", async () => {
  const pid = mkProject("statusarch", { status: "archived" });
  const r = await post("/perch-api/bots/b1/interactive", { project_id: pid });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "bad_project");
  assert.equal(spawnCalls, 0);
  const m = await post("/shell-api/items/artifact/art_1/project", { project_id: pid });
  assert.equal(m.status, 409);
  assert.equal(m.body.error, "archived");
  assert.equal(await getItem(db, "artifact", "art_1"), null);
});

test("a learner_profile project is refused by both routes", async () => {
  const pid = mkProject("kidroute", { type: "learner_profile" });
  const r = await post("/perch-api/bots/b1/interactive", { project_id: pid });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "bad_project");
  assert.equal(spawnCalls, 0);
  const m = await post("/shell-api/items/artifact/art_1/project", { project_id: pid });
  assert.equal(m.status, 404);
  assert.equal(await getItem(db, "artifact", "art_1"), null);
});

test("a non-ACL error while checking the project is not reported as bad_project", async () => {
  const c = raw();
  c.exec("ALTER TABLE project_spaces RENAME TO project_spaces_hidden");
  c.close();
  try {
    const r = await post("/perch-api/bots/b1/interactive", { project_id: P2 });
    assert.notEqual(r.body && r.body.error, "bad_project");
    assert.equal(r.status, 500);
    assert.equal(spawnCalls, 0);
  } finally {
    const c2 = raw();
    c2.exec("ALTER TABLE project_spaces_hidden RENAME TO project_spaces");
    c2.close();
  }
});

test("without a project_id, a bot whose project is no longer live files the thread as Unassigned", async () => {
  const c = raw();
  c.prepare("UPDATE project_spaces SET status = 'archived' WHERE id = ?").run(P1);
  c.close();
  try {
    const r = await post("/perch-api/bots/b1/interactive", {});
    assert.equal(r.status, 201);
    const it = await getItem(db, "perch_thread", "perchlive-t1");
    assert.equal(it.projectId, null);
    assert.equal(it.setBy, "origin");
  } finally {
    const c2 = raw();
    c2.prepare("UPDATE project_spaces SET status = 'active' WHERE id = ?").run(P1);
    c2.close();
  }
});

test("moving a thread id that only a non-perch-live session carries is 404", async () => {
  const c = raw();
  c.prepare("INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, status, control, kind) VALUES ('b1','gmail','chat-thread-1','active','run','chat')").run();
  c.close();
  const r = await post("/shell-api/items/perch_thread/chat-thread-1/project", { project_id: P1 });
  assert.equal(r.status, 404);
  assert.equal(r.body.error, "not_found");
  assert.equal(await getItem(db, "perch_thread", "chat-thread-1"), null);
});

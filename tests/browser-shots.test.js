/**
 * Live browser tile, Task 4: a turn's final browser screenshot is kept like a
 * sent file (the gateway-owned staging dir, a perch_session_files row) but
 * marked kind='browser_shot' so a bot can't fake one by sending a look-alike
 * file; 20 kept per thread; each deletable.
 *
 *   servers/gateway/browser-tile/shots.js   storeShot / pruneShots
 *   servers/shared/perch-delivered.js       unlinkDelivered (fd-anchored)
 *   GET    /dashboard/perch-api/interactive/:sid/files/history   (+ browserShots)
 *   DELETE /dashboard/perch-api/interactive/:sid/browser-shots/:id
 *
 * Harness: a real init-db'd scratch crow.db, the REAL csrfMiddleware and a
 * session stub (the offer-routes idiom), a fake engine, and the staging root
 * registered on a temp dir (the string seam).
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "browser-shots-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
const DB_FILE = join(dir, "crow.db");
const ROOT = join(dir, "delivered");
const REPO = new URL("..", import.meta.url).pathname;

const SID = "perchlive-shots1";
const S = { sessionId: SID, botId: "b1", threadId: SID };

let server, base, shots, delivered, createDbClient, engineImpl;

const raw = () => new Database(DB_FILE);
const q = (sql, ...a) => { const c = raw(); const r = c.prepare(sql).all(...a); c.close(); return r; };
const shotRows = (thread = SID) => q("SELECT * FROM perch_session_files WHERE thread_id=? AND kind='browser_shot' ORDER BY id ASC", thread);
const sessionDir = (sid = SID) => join(ROOT, sid);
const filesIn = (sid = SID) => { try { return readdirSync(sessionDir(sid)).sort(); } catch { return []; } };

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  delivered = await import("../servers/shared/perch-delivered.js");
  delivered.registerDeliveredRoot(ROOT);
  shots = await import("../servers/gateway/browser-tile/shots.js");
  ({ createDbClient } = await import("../servers/db.js"));
  const mod = await import("../servers/gateway/routes/perch-interactive-api.js");
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
  if (server) { server.closeAllConnections(); server.close(); }
  if (delivered) delivered._resetDeliveredForTest();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  const c = raw(); c.exec("DELETE FROM perch_session_files"); c.close();
  rmSync(ROOT, { recursive: true, force: true });
  delivered.registerDeliveredRoot(ROOT);
  engineImpl = {
    async get(sid) { return sid.startsWith("perchlive-") ? { sessionId: sid, botId: "b1", threadId: sid, outputsDir: null } : null; },
  };
});

const AUTHED = { cookie: "crow_session=good; crow_csrf=tok", "x-crow-csrf": "tok" };
async function call(method, path, headers = AUTHED) {
  const r = await fetch(base + path, { method, headers });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function store(opts, s = S) {
  const db = createDbClient();
  try { return await shots.storeShot(db, s, opts); } finally { db.close(); }
}
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

test("storeShot names the file browser-<host ≤60>-<yyyymmdd-hhmmss>.jpg under the session's delivered dir and inserts kind browser_shot with turn_anchor", async () => {
  const now = new Date(Date.UTC(2026, 9, 28, 9, 5, 7));
  const r = await store({ buf: JPEG, hostname: "Example.COM", anchor: "call_abc", now });
  assert.equal(r.name, "browser-example.com-20261028-090507.jpg");
  assert.deepEqual(filesIn(), [r.name]);
  assert.deepEqual(readFileSync(join(sessionDir(), r.name)), JPEG);
  const rows = shotRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, r.id);
  assert.equal(rows[0].kind, "browser_shot");
  assert.equal(rows[0].turn_anchor, "call_abc");
  assert.equal(rows[0].bot_id, "b1");
  assert.equal(rows[0].stored, r.name);
  assert.equal(rows[0].mime, "image/jpeg");
  assert.equal(rows[0].size, JPEG.length);
  assert.equal(rows[0].servable, 1);

  // a long or hostile hostname: clipped to 60, only [a-z0-9.-]
  const long = "a".repeat(80) + ".example.com";
  const r2 = await store({ buf: JPEG, hostname: long, anchor: null, now });
  assert.equal(r2.name, "browser-" + "a".repeat(60) + "-20261028-090507.jpg");
  const r3 = await store({ buf: JPEG, hostname: "../../etc/x y", anchor: null, now });
  assert.match(r3.name, /^browser-[a-z0-9.-]{1,60}-20261028-090507\.jpg$/);
  assert.ok(!r3.name.includes("/"));
  const r4 = await store({ buf: JPEG, hostname: "", anchor: null, now });
  assert.equal(r4.name, "browser-page-20261028-090507.jpg");
  // same host, same second: suffixed, never overwritten
  const r5 = await store({ buf: JPEG, hostname: "example.com", anchor: null, now });
  assert.equal(r5.name, "browser-example.com-20261028-090507-2.jpg");
});

test("retention keeps 20", async () => {
  const ids = [];
  for (let i = 0; i < 25; i++) {
    ids.push((await store({ buf: JPEG, hostname: "example.com", anchor: "call_" + i, now: new Date(Date.UTC(2026, 9, 28, 10, 0, i)) })).id);
  }
  // another thread's shots are never pruned by this one
  const other = { sessionId: "perchlive-other", botId: "b1", threadId: "perchlive-other" };
  await store({ buf: JPEG, hostname: "example.com", anchor: null }, other);
  const rows = shotRows();
  assert.deepEqual(rows.map((r) => r.id), ids.slice(5), "the newest 20 rows remain");
  assert.deepEqual(filesIn(), rows.map((r) => r.stored).sort(), "exactly their files remain");
  assert.equal(shotRows("perchlive-other").length, 1);
  assert.equal(filesIn("perchlive-other").length, 1);

  // pruneShots alone, with a smaller keep, trims the same way
  const db = createDbClient();
  try { await shots.pruneShots(db, S, { keep: 3 }); } finally { db.close(); }
  assert.deepEqual(shotRows().map((r) => r.id), ids.slice(22));
  assert.equal(filesIn().length, 3);

  // the history route lists them newest first, with the workspace URL
  const h = await call("GET", "/interactive/" + SID + "/files/history");
  assert.equal(h.status, 200);
  assert.deepEqual(h.body.browserShots.map((x) => x.id), ids.slice(22).reverse());
  const first = h.body.browserShots[0];
  assert.deepEqual(Object.keys(first).sort(), ["created_at", "id", "name", "turn_anchor", "url"]);
  assert.equal(first.turn_anchor, "call_24");
  assert.equal(first.url, "/dashboard/perch-api/interactive/" + SID + "/workspace/" + encodeURIComponent(first.name));
  assert.deepEqual(h.body.items, [], "shots never appear as file cards");
});

test("browserShots is capped at the newest 20 even when more rows exist", async () => {
  const c = raw();
  const ins = c.prepare("INSERT INTO perch_session_files (bot_id, thread_id, name, stored, mime, size, servable, kind) VALUES (?,?,?,?,?,?,?, 'browser_shot')");
  for (let i = 0; i < 23; i++) ins.run("b1", SID, "s" + i + ".jpg", "s" + i + ".jpg", "image/jpeg", 1, 1);
  c.close();
  mkdirSync(sessionDir(), { recursive: true });
  for (let i = 0; i < 23; i++) writeFileSync(join(sessionDir(), "s" + i + ".jpg"), "x");
  const h = await call("GET", "/interactive/" + SID + "/files/history");
  assert.equal(h.body.browserShots.length, 20);
  assert.equal(h.body.browserShots[0].name, "s22.jpg");
});

test("delete is scoped", async () => {
  const mine = await store({ buf: JPEG, hostname: "example.com", anchor: "a1" });
  const otherBot = await store({ buf: JPEG, hostname: "example.com", anchor: "a2" }, { sessionId: SID, botId: "b2", threadId: SID });
  const otherThread = await store({ buf: JPEG, hostname: "example.com", anchor: "a3" }, { sessionId: "perchlive-two", botId: "b1", threadId: "perchlive-two" });
  // a sent file (kind='file') in the same thread, through the send path's own INSERT
  mkdirSync(sessionDir(), { recursive: true });
  writeFileSync(join(sessionDir(), "report.png"), "PNG");
  const c = raw();
  const fileId = Number(c.prepare("INSERT INTO perch_session_files (bot_id, thread_id, name, stored, mime, size, caption, servable) VALUES (?,?,?,?,?,?,?,?)")
    .run("b1", SID, "report.png", "report.png", "image/png", 3, "", 1).lastInsertRowid);
  c.close();
  const before = { rows: q("SELECT id FROM perch_session_files ORDER BY id").map((r) => r.id), files: filesIn(), two: filesIn("perchlive-two") };

  for (const id of [otherBot.id, otherThread.id, fileId, 999999]) {
    const r = await call("DELETE", "/interactive/" + SID + "/browser-shots/" + id);
    assert.equal(r.status, 404, "id " + id + " is not this thread's shot");
  }
  const bad = await call("DELETE", "/interactive/" + SID + "/browser-shots/abc");
  assert.equal(bad.status, 404);
  const noSession = await call("DELETE", "/interactive/nosuch/browser-shots/" + mine.id);
  assert.equal(noSession.status, 404);
  // CSRF required: no echo, or a wrong echo, is refused
  const noEcho = await call("DELETE", "/interactive/" + SID + "/browser-shots/" + mine.id, { cookie: "crow_session=good; crow_csrf=tok" });
  assert.equal(noEcho.status, 403);
  const wrongEcho = await call("DELETE", "/interactive/" + SID + "/browser-shots/" + mine.id, { cookie: "crow_session=good; crow_csrf=tok", "x-crow-csrf": "nope" });
  assert.equal(wrongEcho.status, 403);
  assert.deepEqual(q("SELECT id FROM perch_session_files ORDER BY id").map((r) => r.id), before.rows, "nothing removed");
  assert.deepEqual(filesIn(), before.files);
  assert.deepEqual(filesIn("perchlive-two"), before.two);

  const ok = await call("DELETE", "/interactive/" + SID + "/browser-shots/" + mine.id);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true });
  assert.equal(q("SELECT id FROM perch_session_files WHERE id=?", mine.id).length, 0, "the row is gone");
  assert.ok(!existsSync(join(sessionDir(), mine.name)), "its file is gone");
  assert.ok(existsSync(join(sessionDir(), otherBot.name)), "the other bot's shot file stays");
  assert.ok(existsSync(join(sessionDir(), "report.png")));
});

test("a sent file named like a shot stays a file card", async () => {
  mkdirSync(sessionDir(), { recursive: true });
  const look = "browser-example.com-20261028-120000.jpg";
  writeFileSync(join(sessionDir(), look), "FAKE");
  const c = raw();
  c.prepare("INSERT INTO perch_session_files (bot_id, thread_id, name, stored, mime, size, caption, servable) VALUES (?,?,?,?,?,?,?,?)")
    .run("b1", SID, look, look, "image/jpeg", 4, "", 1);
  c.close();
  assert.equal(q("SELECT kind FROM perch_session_files WHERE name=?", look)[0].kind, "file");
  const h = await call("GET", "/interactive/" + SID + "/files/history");
  assert.equal(h.status, 200);
  assert.deepEqual(h.body.browserShots, [], "a look-alike name is never a tile");
  assert.equal(h.body.items.length, 1);
  assert.equal(h.body.items[0].kind, "file");
  assert.equal(h.body.items[0].name, look);
  assert.equal(typeof h.body.items[0].id, "number");
  assert.equal(h.body.items[0].turn_anchor, null);
  // and the scoped delete refuses it
  const r = await call("DELETE", "/interactive/" + SID + "/browser-shots/" + h.body.items[0].id);
  assert.equal(r.status, 404);
  assert.ok(existsSync(join(sessionDir(), look)));
});

test("unlinkDelivered never follows a planted symlink", async () => {
  const outside = mkdtempSync(join(tmpdir(), "browser-shots-outside-"));
  try {
    const target = join(outside, "precious.txt");
    writeFileSync(target, "keep me");
    mkdirSync(sessionDir(), { recursive: true });
    symlinkSync(target, join(sessionDir(), "evil.jpg"));
    assert.equal(delivered.unlinkDelivered(SID, "evil.jpg"), false, "a symlink is not a delivered file");
    assert.equal(readFileSync(target, "utf8"), "keep me");

    // a session dir that is itself a symlink to elsewhere: refused (O_NOFOLLOW)
    writeFileSync(join(outside, "x.jpg"), "keep too");
    symlinkSync(outside, join(ROOT, "perchlive-link"));
    assert.equal(delivered.unlinkDelivered("perchlive-link", "x.jpg"), false);
    assert.ok(existsSync(join(outside, "x.jpg")));

    // bad names never reach the filesystem
    for (const n of ["", "../x.jpg", "a/b.jpg", ".hidden", "x\0y"]) assert.equal(delivered.unlinkDelivered(SID, n), false);
    assert.equal(delivered.unlinkDelivered("../etc", "x.jpg"), false);

    // a real file goes, and a second call reports false
    writeFileSync(join(sessionDir(), "real.jpg"), "x");
    assert.equal(delivered.unlinkDelivered(SID, "real.jpg"), true);
    assert.ok(!existsSync(join(sessionDir(), "real.jpg")));
    assert.equal(delivered.unlinkDelivered(SID, "real.jpg"), false);
  } finally { rmSync(outside, { recursive: true, force: true }); }
});

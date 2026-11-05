/**
 * N1c-9 / N1c-11 / N1c-12 / N1c-13: the product's own backup and restore.
 *
 * Everything here runs the real scripts (spawnSync) in a scratch HOME /
 * CROW_HOME / CROW_BACKUP_DIR and never touches a real ~/.crow:
 *
 *   - `npm run backup` must not open a live WAL crow.db with the sqlite3 CLI
 *     (an external open+close orphans the gateway's -wal/-shm descriptors).
 *     With a gateway answering it asks the endpoint for the copy; without one
 *     it makes the copy with better-sqlite3.
 *   - one backup directory (resolveBackupDir), with the old ~/.crow/backups
 *     still listed and restorable.
 *   - 0700 dirs, 0600 files.
 *   - restore refuses while the gateway runs, keeps a whole pre-restore copy
 *     (WAL rows included) and drops the stale -wal/-shm of the replaced DB.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { rmScratch } from "./helpers/safe-rm.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BACKUP_SH = join(ROOT, "scripts", "backup.sh");
const RESTORE_SH = join(ROOT, "scripts", "restore.sh");
const BASH = (() => {
  const r = spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" });
  return (r.stdout || "").trim() || "/bin/bash";
})();

const ctxs = [];
after(() => {
  for (const c of ctxs) {
    try { c.db?.close(); } catch { /* already closed */ }
    try { c.server?.close(); } catch { /* already closed */ }
    rmScratch(c.root);
  }
});

/* ------------------------------------------------------------------ helpers */

const today = () => new Date().toISOString().slice(0, 10);
const mode = (p) => statSync(p).mode & 0o777;
const names = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);

function freePort() {
  return new Promise((done) => {
    const srv = createNetServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => done(port));
    });
  });
}

/** A scratch root: home/ (so ~/.crow is ours), data/, backups/. */
async function ctxNew() {
  const root = mkdtempSync(join(tmpdir(), "crow-backup-script-"));
  const ctx = {
    root,
    home: join(root, "home"),
    data: join(root, "data"),
    backupDir: join(root, "backups"),
    port: await freePort(),
    db: null,
    server: null,
  };
  mkdirSync(ctx.home, { recursive: true });
  mkdirSync(ctx.data, { recursive: true });
  ctxs.push(ctx);
  return ctx;
}

/** A crow.db-shaped file: a `memories` table with `rows`. Returns the open handle. */
function makeDb(file, rows, { wal = false } = {}) {
  const db = new Database(file);
  if (wal) db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT)");
  const ins = db.prepare("INSERT INTO memories (content) VALUES (?)");
  for (const r of rows) ins.run(r);
  return db;
}

const memoriesIn = (file) => {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare("SELECT content FROM memories ORDER BY id").all().map((r) => r.content);
  } finally {
    db.close();
  }
};

const quickCheck = (file) => {
  const db = new Database(file, { fileMustExist: true });
  try {
    const rows = db.pragma("quick_check");
    return String(Array.isArray(rows) ? (rows[0]?.quick_check ?? rows[0]) : rows);
  } finally {
    db.close();
  }
};

/**
 * The script env: its own HOME/CROW_HOME (so ~/.crow is scratch), its own
 * backup dir, a port of its own (never the host's real gateway port), and all
 * optional upload destinations off.
 */
function envFor(ctx, extra = {}) {
  const env = {
    ...process.env,
    HOME: ctx.home,
    CROW_DB_PATH: join(ctx.data, "crow.db"),
    CROW_BACKUP_DIR: ctx.backupDir,
    PORT: String(ctx.port),
    CROW_GATEWAY_PORT: "",
    CROW_BACKUP_TOKEN: "",
    CROW_BACKUP_KEEP_DAYS: "",
    NTFY_TOPIC: "",
    CROW_NTFY_LABEL_PREFIX: "",
    S3_ENDPOINT: "", S3_ACCESS_KEY: "", S3_SECRET_KEY: "",
    MINIO_ENDPOINT: "", MINIO_ACCESS_KEY: "", MINIO_SECRET_KEY: "",
    CROW_BACKUP_GIT_REPO: "",
    ...extra,
  };
  // Default instance (no tag) and no real instance paths leaked from the suite.
  delete env.CROW_HOME;
  delete env.CROW_DATA_DIR;
  return env;
}

/**
 * Run a script asynchronously: the stub gateway lives in THIS process, so
 * blocking the event loop with spawnSync would make its /health unreachable.
 */
const run = (script, args, env) => new Promise((done) => {
  const child = spawn(BASH, [script, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 120_000);
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  child.on("error", (err) => { clearTimeout(timer); done({ status: -1, out: `${out}${err.message}` }); });
  child.on("close", (status) => { clearTimeout(timer); done({ status: timedOut ? -1 : status, out }); });
});

const which = (tool) => {
  const r = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
  const p = (r.stdout || "").trim();
  return p && existsSync(p) ? p : null;
};

const HAS_SQLITE3 = spawnSync("sqlite3", ["--version"], { stdio: "ignore" }).status === 0;

/**
 * A PATH with node and the shell tools but WITHOUT sqlite3 (nothing from the
 * host's real PATH is reachable, so `command -v sqlite3` cannot find one).
 */
function pathWithoutSqlite3(ctx) {
  const bin = join(ctx.root, "bin");
  mkdirSync(bin, { recursive: true });
  const tools = [
    "bash", "sh", "date", "mkdir", "chmod", "stat", "du", "basename", "dirname", "cut",
    "mktemp", "sed", "awk", "grep", "cat", "ls", "rm", "cp", "mv", "find", "xargs", "wc",
    "sort", "head", "tail", "tr", "env", "id", "uname", "rsync", "git", "touch", "ln",
  ];
  for (const t of tools) {
    const p = which(t);
    if (p && !existsSync(join(bin, t))) symlinkSync(p, join(bin, t));
  }
  symlinkSync(process.execPath, join(bin, "node"));
  assert.equal(existsSync(join(bin, "sqlite3")), false, "PATH must not expose sqlite3");
  return bin;
}

/**
 * A stub gateway: /health answers 200 and POST /api/admin/backup records the
 * request and writes the copy it "made" (a real SQLite file, 0600) into the
 * backup dir, exactly like servers/gateway/routes/admin-backup.js does.
 */
async function startStubGateway(ctx, { copyFrom }) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization || "" });
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", servers: [] }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/admin/backup") {
      mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 });
      const dest = join(ctx.backupDir, `primary-${today()}.db`);
      copyFileSync(copyFrom, dest);
      chmodSync(dest, 0o600);
      const size = statSync(dest).size;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: dest, size_bytes: size, pages_copied: 12, verified: true, instance: "primary" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  ctx.server = server;
  ctx.port = server.address().port;
  return requests;
}

/* ------------------------------------------------------------------- tests */

test("backup with no gateway copies the db without the sqlite3 CLI", async () => {
  const ctx = await ctxNew();
  ctx.db = makeDb(join(ctx.data, "crow.db"), ["one", "two", "three", "four"]);
  ctx.db.close();
  ctx.db = null;

  const bin = pathWithoutSqlite3(ctx);
  const r = await run(BACKUP_SH, [], envFor(ctx, { PATH: bin }));
  assert.equal(r.status, 0, r.out);

  // One verified binary copy under backup-naming's name for this (default) instance.
  const name = `primary-${today()}.db`;
  const copy = join(ctx.backupDir, name);
  assert.deepEqual(names(ctx.backupDir), [name, `${name}.owner.json`], r.out);
  assert.equal(mode(copy), 0o600, "the copy is 0600");
  assert.equal(mode(ctx.backupDir), 0o700, "the backup dir is 0700");
  assert.equal(mode(`${copy}.owner.json`), 0o600, "the owner sidecar is 0600");
  assert.equal(quickCheck(copy), "ok");
  assert.deepEqual(memoriesIn(copy), ["one", "two", "three", "four"]);

  // Same owner sidecar the endpoint writes: default instance, no tag.
  const owner = JSON.parse(readFileSync(`${copy}.owner.json`, "utf8"));
  assert.equal(owner.label, "primary");
  assert.equal(owner.tag, null);
  assert.equal(owner.db_path, join(ctx.data, "crow.db"));
  assert.ok(owner.written_at);

  // No sqlite3 → the dump is skipped, with one clear line, and nothing else.
  assert.match(r.out, /sqlite3 not installed: no SQL dump; the binary copy is complete/);
  assert.doesNotMatch(r.out, /SQL dump: /);
  assert.equal(existsSync(join(ctx.backupDir, `primary-${today()}.sql`)), false);

  // The live database was not disturbed by an external open/close.
  assert.deepEqual(names(ctx.data), ["crow.db"]);
});

test("backup with a running gateway asks the gateway for the copy", async () => {
  const ctx = await ctxNew();
  const live = join(ctx.data, "crow.db");
  // A live WAL database with a keeper-like connection held by "the gateway"
  // (this test process): the -wal/-shm must survive the backup untouched.
  ctx.db = makeDb(live, ["live one", "live two"], { wal: true });
  const shm = join(ctx.data, "crow.db-shm");
  const wal = join(ctx.data, "crow.db-wal");
  assert.ok(existsSync(wal) && existsSync(shm), "a live WAL DB has -wal and -shm");
  const walBefore = { ino: statSync(wal).ino, size: statSync(wal).size };
  const liveBefore = names(ctx.data);

  // What the stub gateway "writes": a real, standalone SQLite copy.
  const template = join(ctx.root, "template.db");
  makeDb(template, ["from the gateway"]).close();

  const requests = await startStubGateway(ctx, { copyFrom: template });
  const r = await run(BACKUP_SH, [], envFor(ctx, { CROW_BACKUP_TOKEN: "backup-token-123" }));
  assert.equal(r.status, 0, r.out);

  // The endpoint was asked, with the bearer token, and the script used its file.
  const post = requests.find((q) => q.method === "POST" && q.url === "/api/admin/backup");
  assert.ok(post, `expected POST /api/admin/backup, saw ${JSON.stringify(requests)}`);
  assert.equal(post.auth, "Bearer backup-token-123");
  assert.ok(!requests.some((q) => q.method === "POST" && q.url !== "/api/admin/backup"), "no other POST");
  assert.match(r.out, new RegExp(`Gateway answering on 127\\.0\\.0\\.1:${ctx.port}`));
  assert.match(r.out, new RegExp(`Binary copy: ${ctx.backupDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/primary-\\d{4}-\\d{2}-\\d{2}\\.db`));

  // The script never opened the live database: the gateway's WAL is the same
  // inode, still there, still the same size — and no file appeared beside it.
  assert.equal(statSync(wal).ino, walBefore.ino, "the -wal was not unlinked and recreated");
  assert.equal(statSync(wal).size, walBefore.size, "the -wal was not checkpointed/reset");
  assert.deepEqual(names(ctx.data), liveBefore);
  // ...and the connection that "is" the gateway still reads its WAL rows.
  assert.deepEqual(memoriesIn(live), ["live one", "live two"]);
});

test("restore refuses while the gateway runs", async () => {
  const ctx = await ctxNew();
  const live = join(ctx.data, "crow.db");
  ctx.db = makeDb(live, ["keep me"]);
  ctx.db.close();
  ctx.db = null;

  const backup = join(ctx.root, "backup.db");
  makeDb(backup, ["from the backup"]).close();

  ctx.server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  });
  await new Promise((done) => ctx.server.listen(0, "127.0.0.1", done));
  ctx.port = ctx.server.address().port;

  const r = await run(RESTORE_SH, [backup], envFor(ctx));
  assert.notEqual(r.status, 0, "a restore must not run while the gateway is up");
  assert.match(r.out, new RegExp(`The gateway is running on port ${ctx.port}`));
  assert.match(r.out, /Stop it first/);
  assert.match(r.out, /systemctl --user stop crow-gateway/);
  assert.doesNotMatch(r.out, /--force/, "there is no override to offer");

  // The database is untouched and no safety copy was made.
  assert.deepEqual(memoriesIn(live), ["keep me"]);
  assert.deepEqual(names(ctx.data), ["crow.db"]);
});

test("restore removes stale wal and shm and keeps a whole safety copy", async () => {
  const ctx = await ctxNew();
  const live = join(ctx.data, "crow.db");
  // WAL mode with un-checkpointed rows: the rows live in crow.db-wal only, so
  // a `cp crow.db` safety copy would have lost them.
  ctx.db = makeDb(live, ["live 1", "live 2", "live 3", "live 4", "live 5"], { wal: true });
  const wal = join(ctx.data, "crow.db-wal");
  assert.ok(existsSync(wal) && statSync(wal).size > 0, "the WAL holds the un-checkpointed rows");
  assert.deepEqual(memoriesIn(live).length, 5);

  const backup = join(ctx.root, "backup.db");
  makeDb(backup, ["backup a", "backup b", "backup c"]).close();
  const backupName = `primary-${today()}.db`;
  mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 });
  copyFileSync(backup, join(ctx.backupDir, backupName));

  const r = await run(RESTORE_SH, [backupName], envFor(ctx));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Quick check: ok/);
  assert.match(r.out, /Memories: 3/);

  // Restored content, and the OLD database's WAL/SHM are gone for good.
  assert.deepEqual(memoriesIn(live), ["backup a", "backup b", "backup c"]);
  assert.equal(existsSync(wal), false, "the stale -wal of the replaced DB is removed");
  assert.equal(existsSync(join(ctx.data, "crow.db-shm")), false, "the stale -shm is removed");

  // The safety copy is a WHOLE copy of the WAL'd database, 0600.
  const pre = names(ctx.data).filter((n) => n.startsWith("crow.db.pre-restore-"));
  assert.equal(pre.length, 1, `expected one pre-restore copy, saw ${names(ctx.data)}`);
  const prePath = join(ctx.data, pre[0]);
  assert.equal(mode(prePath), 0o600, "the pre-restore copy is 0600");
  assert.equal(quickCheck(prePath), "ok");
  assert.deepEqual(memoriesIn(prePath), ["live 1", "live 2", "live 3", "live 4", "live 5"]);
  assert.match(r.out, new RegExp(`Previous database saved at: ${prePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("restore lists backups from the old directory too", async () => {
  const ctx = await ctxNew();
  const legacy = join(ctx.home, ".crow", "backups");
  mkdirSync(legacy, { recursive: true });
  const legacyName = "crow-20260101-000000.db";
  makeDb(join(legacy, legacyName), ["legacy one", "legacy two"]).close();
  mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 });
  const currentName = `primary-${today()}.db`;
  makeDb(join(ctx.backupDir, currentName), ["current"]).close();

  const list = await run(RESTORE_SH, ["--list"], envFor(ctx));
  assert.equal(list.status, 0, list.out);
  assert.match(list.out, new RegExp(`Available backups in ${ctx.backupDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.ok(list.out.includes(currentName), "the current dir's backups are listed");
  assert.match(list.out, /Older backups \(~\/\.crow\/backups\)/);
  assert.ok(list.out.includes(legacyName), "the legacy dir's backups are listed too");

  // A bare file name is looked up in the current dir, then the legacy one —
  // and a .db preview is read with node, not the sqlite3 CLI.
  const preview = await run(RESTORE_SH, [legacyName, "--dry-run"], envFor(ctx, { PATH: pathWithoutSqlite3(ctx) }));
  assert.equal(preview.status, 0, preview.out);
  assert.match(preview.out, new RegExp(`Backup file: ${legacy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/crow-20260101-000000\\.db`));
  assert.match(preview.out, /Quick check: ok/);
  assert.match(preview.out, /memories: 2/);
});

test("the SQL dump (when the sqlite3 CLI is present) is taken from the verified copy", { skip: !HAS_SQLITE3 && "sqlite3 not installed" }, async () => {
  const ctx = await ctxNew();
  makeDb(join(ctx.data, "crow.db"), ["dumped row"]).close();

  const r = await run(BACKUP_SH, [], envFor(ctx));
  assert.equal(r.status, 0, r.out);
  const dbName = names(ctx.backupDir).find((n) => n.endsWith(".db"));
  const sqlPath = join(ctx.backupDir, dbName.replace(/\.db$/, ".sql"));
  assert.ok(existsSync(sqlPath), `expected a .sql dump, saw ${names(ctx.backupDir)}`);
  assert.equal(mode(sqlPath), 0o600, "the dump is 0600");
  const sql = readFileSync(sqlPath, "utf8");
  assert.match(sql, /CREATE TABLE memories/);
  assert.match(sql, /dumped row/);
  assert.match(r.out, /SQL dump: .*\.sql/);
  // sqlite3 only ever touched the copy: no journal beside either file, and
  // nothing new beside the live database.
  assert.deepEqual(names(ctx.backupDir).filter((n) => /-(wal|shm)$/.test(n)), []);
  assert.deepEqual(names(ctx.data), ["crow.db"]);
});

test("prune removes this instance's old .db and .sql, keeps fresh files, and a dry run deletes nothing", async () => {
  const ctx = await ctxNew();
  makeDb(join(ctx.data, "crow.db"), ["row"]).close();
  mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 });
  const oldDb = join(ctx.backupDir, "primary-2026-01-01.db");
  const oldSql = join(ctx.backupDir, "primary-2026-01-01.sql");
  const freshDb = join(ctx.backupDir, "primary-2999-01-01.db");
  for (const f of [oldDb, oldSql, freshDb]) writeFileSync(f, "x");
  const old = Date.now() / 1000 - 10 * 86_400;
  for (const f of [oldDb, oldSql]) utimesSync(f, old, old);

  const dry = await run(BACKUP_SH, ["--dry-run"], envFor(ctx));
  assert.equal(dry.status, 0, dry.out);
  assert.match(dry.out, /\[dry-run\] Would prune up to 2 file/);
  for (const f of [oldDb, oldSql, freshDb]) assert.ok(existsSync(f), "a dry run deletes nothing");

  const real = await run(BACKUP_SH, [], envFor(ctx));
  assert.equal(real.status, 0, real.out);
  assert.equal(existsSync(oldDb), false, "the old copy of this instance is pruned");
  assert.equal(existsSync(oldSql), false, "its dump is pruned with it");
  assert.equal(existsSync(freshDb), true, "a fresh file inside the retention window is kept");
});
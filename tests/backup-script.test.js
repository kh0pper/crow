/**
 * N1c-9 / N1c-11 / N1c-12 / N1c-13: the product's own backup and restore.
 *
 * Everything here runs the real scripts (spawnSync) in a scratch HOME /
 * CROW_HOME / CROW_BACKUP_DIR and never touches a real ~/.crow:
 *
 *   - `npm run backup` must not open a live WAL crow.db with the sqlite3 CLI
 *     (an external open+close orphans the gateway's -wal/-shm descriptors).
 *     With a gateway for OUR database answering it asks the endpoint for the
 *     copy; a gateway that backs up another database (a co-hosted instance) is
 *     ignored; without one and with no holders it makes the copy with
 *     better-sqlite3 (read-only).
 *   - one backup directory (resolveBackupDir), with the old ~/.crow/backups
 *     still listed and restorable.
 *   - 0700 dirs, 0600 files.
 *   - backup and restore refuse while ANY process holds the database (file
 *     handles, not port guesses) and while a port answers without answering
 *     like a gateway.
 *   - restore keeps a whole pre-restore copy (WAL rows included) and drops the
 *     stale -wal/-shm of the replaced DB.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync,
  readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { rmScratch } from "./helpers/safe-rm.js";
import { artifactStoreName, instanceBackupTag } from "../servers/shared/backup-naming.js";
import { deriveInstanceIdentity } from "../servers/sharing/identity.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BACKUP_SH = join(ROOT, "scripts", "backup.sh");
const BACKUP_HELPER = join(ROOT, "scripts", "backup-db.mjs");
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
    for (const child of c.children || []) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
    rmScratch(c.root);
  }
});

/* ------------------------------------------------------------------ helpers */

const today = () => new Date().toISOString().slice(0, 10);
const mode = (p) => statSync(p).mode & 0o777;
const names = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
    children: [],
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
  // `extra` wins over those deletes, so a test can describe a co-hosted
  // instance (its own CROW_HOME) without hand-building a whole env.
  Object.assign(env, extra);
  return env;
}

/**
 * Run a script asynchronously: the stub gateway lives in THIS process, so
 * blocking the event loop with spawnSync would make its /health unreachable.
 * `opts` is merged into the spawn options (e.g. `{ cwd }` for the bare-name
 * lookup, which falls back to the current directory last).
 */
const run = (script, args, env, opts = {}) => new Promise((done) => {
  const child = spawn(BASH, [script, ...args], { env, stdio: ["ignore", "pipe", "pipe"], ...opts });
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
const HAS_RSYNC = spawnSync("rsync", ["--version"], { stdio: "ignore" }).status === 0;

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
 * A stub gateway. In the default "gateway" mode /health answers 200 and POST
 * /api/admin/backup records the request and writes the copy it "made" (a real
 * SQLite file, 0600) into `backupDir`, exactly like
 * servers/gateway/routes/admin-backup.js — including the `db_path` that names
 * WHICH database it backed up. Everything else is a 404.
 *
 * mode "reset": the socket is destroyed before any answer (a live process we
 * cannot talk to — not ECONNREFUSED). mode "health-503": /health answers 503.
 */
async function startStubGateway(ctx, {
  copyFrom = null,
  dbPath = join(ctx.data, "crow.db"),
  backupDir = ctx.backupDir,
  mode = "gateway",
} = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization || "" });
    if (mode === "reset") {
      req.socket.destroy();
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      if (mode === "health-503") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "database unavailable" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", servers: [] }));
      return;
    }
    if (mode === "gateway" && req.method === "POST" && req.url === "/api/admin/backup") {
      mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      const dest = join(backupDir, `primary-${today()}.db`);
      copyFileSync(copyFrom, dest);
      chmodSync(dest, 0o600);
      const size = statSync(dest).size;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true, path: dest, db_path: dbPath, size_bytes: size, pages_copied: 12,
        verified: true, instance: "primary", instance_tag: null,
      }));
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

/**
 * A child process that opens the database and keeps it open — what a gateway,
 * a second instance's server, a bridge or an sqlite3 shell looks like to the
 * file-handle check. Resolves once its handle is open.
 * @returns {Promise<{child: import("node:child_process").ChildProcess, pid: number}>}
 */
async function startHolder(ctx, dbPath) {
  const src = `
const Database = require("better-sqlite3");
const db = new Database(process.argv[1]);
db.pragma("journal_mode = WAL");
db.prepare("SELECT COUNT(*) AS n FROM memories").get();
process.stdout.write("ready\\n");
setInterval(() => {}, 60000);
`;
  const child = spawn(process.execPath, ["-e", src, dbPath], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  ctx.children.push(child);
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (out.includes("ready")) return { child, pid: child.pid };
    if (child.exitCode !== null) throw new Error(`holder exited (${child.exitCode}): ${err || out}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`holder did not open ${dbPath}: ${err || out}`);
}

/**
 * A WAL database whose rows live ONLY in the -wal, with no process holding it:
 * a child writes and is SIGKILLed, so it never checkpoints on close (a killed
 * gateway leaves exactly this behind).
 */
async function killedWriterDb(file, rows) {
  const src = `
const Database = require("better-sqlite3");
const db = new Database(process.argv[1]);
db.pragma("journal_mode = WAL");
db.exec("CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT)");
const ins = db.prepare("INSERT INTO memories (content) VALUES (?)");
for (const r of ${JSON.stringify(rows)}) ins.run(r);
process.kill(process.pid, "SIGKILL");
`;
  const child = spawn(process.execPath, ["-e", src, file], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => { err += d; });
  await new Promise((done) => child.on("exit", done));
  assert.equal(existsSync(file), true, `expected a database at ${file}: ${err}`);
  assert.equal(existsSync(file + "-wal"), true, `expected a -wal beside ${file}: ${err}`);
  assert.ok(statSync(file + "-wal").size > 0, "the WAL holds the un-checkpointed rows");
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
  makeDb(live, ["keep me"]).close();

  const backup = join(ctx.root, "backup.db");
  makeDb(backup, ["from the backup"]).close();

  // A gateway answers: GET /health is 200, everything else is not its business.
  await startStubGateway(ctx, { copyFrom: backup });

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

// Only ECONNREFUSED means "no gateway". A 5xx or a connection that is reset
// proves a process is there that we know nothing about: it may well hold the
// database, so a restore must refuse instead of proceeding.
test("restore refuses when the port answers without answering like a gateway", async () => {
  const base = await ctxNew();
  const backup = join(base.root, "backup.db");
  makeDb(backup, ["from the backup"]).close();

  for (const mode of ["health-503", "reset"]) {
    const ctx = await ctxNew();
    const live = join(ctx.data, "crow.db");
    makeDb(live, ["keep me"]).close();
    await startStubGateway(ctx, { copyFrom: backup, mode });

    const r = await run(RESTORE_SH, [backup], envFor(ctx));
    assert.notEqual(r.status, 0, `${mode}: a restore must not run`);
    assert.match(r.out, new RegExp(`something is listening on port ${ctx.port}`), r.out);
    assert.doesNotMatch(r.out, /--force/);
    assert.deepEqual(memoriesIn(live), ["keep me"], `${mode}: the database is untouched`);
    assert.deepEqual(names(ctx.data), ["crow.db"], `${mode}: no safety copy was made`);
  }
});

// The question is who has the DATABASE open, not which port answers: this
// child holds crow.db the way a second gateway, a bridge or an sqlite3 shell
// would, and answers nothing on the gateway port.
test("restore refuses while another process holds the database", async () => {
  const ctx = await ctxNew();
  const live = join(ctx.data, "crow.db");
  makeDb(live, ["keep me"]).close();

  const backup = join(ctx.root, "backup.db");
  makeDb(backup, ["from the backup"]).close();

  const holder = await startHolder(ctx, live);

  const r = await run(RESTORE_SH, [backup], envFor(ctx));
  assert.notEqual(r.status, 0, "a restore must not run while something holds the database");
  assert.match(r.out, new RegExp(`crow\\.db is open by: .*\\b${holder.pid} \\(`), r.out);
  assert.match(r.out, /Stop the gateway and any Crow server using this database, then run the restore again/);
  assert.doesNotMatch(r.out, /--force/);

  // The database is untouched and no safety copy was made.
  assert.deepEqual(memoriesIn(live), ["keep me"]);
  assert.deepEqual(names(ctx.data).filter((n) => n.includes("pre-restore")), []);
});

test("backup ignores a gateway that backs up another database", async () => {
  const ctx = await ctxNew();
  const live = join(ctx.data, "crow.db");
  makeDb(live, ["ours"]).close();        // nothing holds the database
  const other = join(ctx.root, "other.db");
  makeDb(other, ["another instance"]).close();

  // A co-hosted gateway: /health 200, but its copy is of ITS crow.db and lands
  // in ITS backup dir. No sidecar of ours, so nothing may come from it.
  const foreignDir = join(ctx.root, "other-backups");
  const requests = await startStubGateway(ctx, { copyFrom: other, dbPath: other, backupDir: foreignDir });

  const r = await run(BACKUP_SH, [], envFor(ctx));
  assert.equal(r.status, 0, r.out);
  assert.ok(requests.some((q) => q.method === "POST" && q.url === "/api/admin/backup"), "the gateway was asked");
  assert.match(r.out, new RegExp(`the gateway on port ${ctx.port} backs up another database`), r.out);

  // The copy that landed is the one made here, from OUR database.
  const name = `primary-${today()}.db`;
  const copy = join(ctx.backupDir, name);
  assert.deepEqual(names(ctx.backupDir).filter((n) => n.endsWith(".db")), [name], r.out);
  assert.equal(existsSync(`${copy}.owner.json`), true, "it carries this instance's sidecar");
  assert.deepEqual(memoriesIn(copy), ["ours"]);
  // ...and the other instance's copy was never used (it is not even ours).
  assert.deepEqual(memoriesIn(join(foreignDir, name)), ["another instance"]);
});

test("backup refuses when the database is open but its gateway is not found", async () => {
  const ctx = await ctxNew();
  const live = join(ctx.data, "crow.db");
  makeDb(live, ["held"]).close();
  const other = join(ctx.root, "other.db");
  makeDb(other, ["another instance"]).close();

  // The port answers, but with ANOTHER instance's gateway: nothing may be used
  // from it, and OUR database is open — so neither copy path is safe.
  await startStubGateway(ctx, { copyFrom: other, dbPath: other, backupDir: join(ctx.root, "other-backups") });
  const holder = await startHolder(ctx, live);

  const r = await run(BACKUP_SH, [], envFor(ctx));
  assert.notEqual(r.status, 0, "a backup must not run");
  assert.match(r.out, new RegExp(`the gateway on port ${ctx.port} backs up another database`), r.out);
  assert.match(r.out, new RegExp(`crow\\.db is open by: .*\\b${holder.pid} \\(`), r.out);
  assert.match(r.out, /set PORT\/CROW_GATEWAY_PORT to its port, or stop those processes/);

  assert.deepEqual(names(ctx.backupDir).filter((n) => n.endsWith(".db")), [], "no copy was written");
});

test("restore removes stale wal and shm and keeps a whole safety copy", async () => {
  const ctx = await ctxNew();
  const live = join(ctx.data, "crow.db");
  // WAL mode with un-checkpointed rows: the rows live in crow.db-wal only, so
  // a `cp crow.db` safety copy would have lost them. Written by a child that is
  // SIGKILLed, so the -wal survives while nothing holds the database (exactly
  // what a killed gateway leaves behind).
  await killedWriterDb(live, ["live 1", "live 2", "live 3", "live 4", "live 5"]);
  const wal = join(ctx.data, "crow.db-wal");
  assert.deepEqual(memoriesIn(live).length, 5);

  const backup = join(ctx.root, "backup.db");
  makeDb(backup, ["backup a", "backup b", "backup c"]).close();
  const backupName = `primary-${today()}.db`;
  mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 });
  copyFileSync(backup, join(ctx.backupDir, backupName));
  // The restored file keeps the OLD database's owner and mode (extra group
  // read is unusual and therefore a real assertion).
  chmodSync(live, 0o640);

  const r = await run(RESTORE_SH, [backupName], envFor(ctx));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Quick check: ok/);
  assert.match(r.out, /Memories: 3/);
  assert.equal(mode(live), 0o640, "the restored database kept the old file's mode");

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
  // The identity copies are pruned with the run they belong to (N1c-10), and
  // only this instance's: the same per-instance rule, oldest first.
  const oldIdentity = join(ctx.backupDir, "primary-identity-2026-01-01.json");
  const oldIdentityOwner = `${oldIdentity}.owner.json`;
  const freshIdentity = join(ctx.backupDir, "primary-identity-2999-01-01.json");
  for (const f of [oldDb, oldSql, freshDb, oldIdentity, oldIdentityOwner, freshIdentity]) writeFileSync(f, "x");
  const old = Date.now() / 1000 - 10 * 86_400;
  for (const f of [oldDb, oldSql, oldIdentity]) utimesSync(f, old, old);

  const dry = await run(BACKUP_SH, ["--dry-run"], envFor(ctx));
  assert.equal(dry.status, 0, dry.out);
  assert.match(dry.out, /\[dry-run\] Would prune up to 3 file/);
  for (const f of [oldDb, oldSql, freshDb, oldIdentity, freshIdentity]) assert.ok(existsSync(f), "a dry run deletes nothing");

  const real = await run(BACKUP_SH, [], envFor(ctx));
  assert.equal(real.status, 0, real.out);
  assert.equal(existsSync(oldDb), false, "the old copy of this instance is pruned");
  assert.equal(existsSync(oldSql), false, "its dump is pruned with it");
  assert.equal(existsSync(freshDb), true, "a fresh file inside the retention window is kept");
  assert.equal(existsSync(oldIdentity), false, "its identity copy is pruned with it");
  assert.equal(existsSync(freshIdentity), true, "a fresh identity copy inside the window is kept");
});

/* ---------------------------------------------------------------------------
 * Review fixes (round 2): per-instance artifacts copies, and a restore that
 * never loses the database it replaces.
 * ------------------------------------------------------------------------- */

// A .sql dump is replayed into a temp file beside the database and checked
// there, never into the live file: a dump that does not replay leaves the old
// database exactly as it was.
test("a .sql dump is replayed into a temp file before it replaces the database", { skip: !HAS_SQLITE3 && "sqlite3 not installed" }, async () => {
  const ctx = await ctxNew();
  const live = join(ctx.data, "crow.db");
  makeDb(live, ["old row"]).close();
  mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 });
  const dump = join(ctx.backupDir, `primary-${today()}.sql`);
  writeFileSync(dump, [
    "BEGIN TRANSACTION;",
    "CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT);",
    "INSERT INTO memories (content) VALUES ('from sql one');",
    "INSERT INTO memories (content) VALUES ('from sql two');",
    "COMMIT;",
  ].join("\n") + "\n");

  const r = await run(RESTORE_SH, [dump], envFor(ctx));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /SQL dump replayed/);
  assert.deepEqual(memoriesIn(live), ["from sql one", "from sql two"]);
  assert.deepEqual(names(ctx.data).filter((n) => n.startsWith(".crow.db.restore-")), [], "no temp file left behind");

  // A dump that does not replay stops the restore and keeps the database.
  const bad = join(ctx.backupDir, `primary-bad-${today()}.sql`);
  writeFileSync(bad, "THIS IS NOT SQL;\n");
  const failed = await run(RESTORE_SH, [bad], envFor(ctx));
  assert.notEqual(failed.status, 0, failed.out);
  assert.match(failed.out, /has NOT been replaced/);
  assert.deepEqual(memoriesIn(live), ["from sql one", "from sql two"]);
  assert.deepEqual(names(ctx.data).filter((n) => n.startsWith(".crow.db.restore-")), [], "no temp file left behind");
});

// Two co-hosted instances share ONE backup directory. Each rsyncs its artifacts
// store with --delete into its own subdirectory, so one instance's run can never
// prune the other's blobs (the .db naming rule, applied to the blob store).
test("two instances' artifacts copies do not delete each other", { skip: !HAS_RSYNC && "rsync not installed" }, async () => {
  const ctx = await ctxNew();
  const r4Home = join(ctx.home, ".crow-r4");
  const aData = ctx.data;
  const bData = join(ctx.root, "r4data");
  mkdirSync(bData, { recursive: true });
  for (const data of [aData, bData]) mkdirSync(join(data, "artifacts", "sha256"), { recursive: true });
  writeFileSync(join(aData, "artifacts", "sha256", "blob-a"), "blob from the primary");
  writeFileSync(join(bData, "artifacts", "sha256", "blob-b"), "blob from r4");
  makeDb(join(aData, "crow.db"), ["primary row"]).close();
  makeDb(join(bData, "crow.db"), ["r4 row"]).close();

  const envA = envFor(ctx);
  const envB = envFor(ctx, {
    CROW_HOME: r4Home,
    CROW_DATA_DIR: bData,
    CROW_DB_PATH: join(bData, "crow.db"),
    PORT: String(await freePort()),
  });
  const tag = instanceBackupTag({ CROW_HOME: r4Home });
  const copyA = join(ctx.backupDir, "artifacts");
  const copyB = join(ctx.backupDir, artifactStoreName("primary", tag));
  assert.notEqual(copyA, copyB, "each instance has its own artifacts copy");

  const a1 = await run(BACKUP_SH, [], envA);
  assert.equal(a1.status, 0, a1.out);
  const b1 = await run(BACKUP_SH, [], envB);
  assert.equal(b1.status, 0, b1.out);

  assert.equal(existsSync(join(copyA, "sha256", "blob-a")), true, `the primary's blob is in ${copyA}`);
  assert.equal(existsSync(join(copyB, "sha256", "blob-b")), true, `r4's blob is in ${copyB}`);
  assert.equal(existsSync(join(copyA, "sha256", "blob-b")), false, "the two copies are separate");
  assert.equal(existsSync(join(copyB, "sha256", "blob-a")), false, "the two copies are separate");

  // The primary's store loses a blob; its next run deletes the blob from ITS
  // copy with --delete, and r4's copy is untouched.
  rmSync(join(aData, "artifacts", "sha256", "blob-a"));
  const a2 = await run(BACKUP_SH, [], envA);
  assert.equal(a2.status, 0, a2.out);
  assert.equal(existsSync(join(copyA, "sha256", "blob-a")), false, "--delete applied inside the primary's own copy");
  assert.equal(existsSync(join(copyB, "sha256", "blob-b")), true, "r4's copy survived the primary's run");
});

// A backup that is not a database passes nothing: quick_check (read-only) of the
// SOURCE happens before the safety copy, before the -wal/-shm removal and before
// anything is renamed into place.
/* ---------------------------------------------------------------------------
 * N1c-10 — identity in backups (the operator's ruling, 2026-11-05).
 *
 *   identity.json is copied into the LOCAL backup folder only — 0600 from
 *   creation, owner sidecar, pruned with the run it belongs to — and never to
 *   S3, never to the git repo: the upload guard refuses exactly this
 *   instance's identity copy name, any identity.json and anything under
 *   <CROW_HOME>/secrets (not every name containing the word). A restore puts
 *   the identity back with --with-identity, and only when the copy is this
 *   instance's (owner sidecar), its seed derives the crow id it claims, and
 *   the target has no identity.json yet or holds the SAME crow id.
 * ------------------------------------------------------------------------- */

const IDENTITY_SEED = "4d1e".repeat(16);

/**
 * identity.json content. The crow id is DERIVED from the seed (the restore now
 * checks that a copy's seed gives the crow id it claims), so fixtures are built
 * from a seed rather than a hand-written id.
 */
function identityJson(crowId, seed = IDENTITY_SEED) {
  return JSON.stringify({
    version: 1,
    crowId,
    ed25519Pubkey: "22".repeat(32),
    secp256k1Pubkey: "33".repeat(33),
    createdAt: "2026-11-05T00:00:00.000Z",
    seed,
  }, null, 2);
}

/** The crow id a seed really derives (identity.js's own derivation). */
const seedCrowId = (seed) => deriveInstanceIdentity(Buffer.from(seed, "hex")).crowId;

/** A fresh, real (crowId, seed) pair for a fixture. */
const identityFor = (seed) => ({ seed, crowId: seedCrowId(seed) });

/** Write `<dir>/identity.json` (0600, like servers/sharing/identity.js does). */
function writeIdentity(dir, crowId, seed) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "identity.json");
  writeFileSync(p, identityJson(crowId, seed), { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
}

/** Every file under `dir`, relative and sorted (an empty missing dir → []). */
function treeOf(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/** A stub `mc` that records every invocation instead of talking to an endpoint. */
function stubMc(ctx) {
  const bin = join(ctx.root, "mc-bin");
  mkdirSync(bin, { recursive: true });
  const log = join(ctx.root, "mc.log");
  const p = join(bin, "mc");
  writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`);
  chmodSync(p, 0o755);
  return {
    bin,
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []),
  };
}

/** `git` env for a scratch commit (a CI box has no user.email). */
const GIT_ENV = {
  GIT_AUTHOR_NAME: "crow test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "crow test", GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
};

const HAS_GIT = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

test("backup keeps identity.json 0600 in the local backup folder", async () => {
  const ctx = await ctxNew();
  makeDb(join(ctx.data, "crow.db"), ["a row"]).close();
  const mine = identityFor(IDENTITY_SEED);
  writeIdentity(ctx.data, mine.crowId, mine.seed);
  assert.equal(mode(join(ctx.data, "identity.json")), 0o600);

  const r = await run(BACKUP_SH, [], envFor(ctx));
  assert.equal(r.status, 0, r.out);

  const name = `primary-identity-${today()}.json`;
  const copy = join(ctx.backupDir, name);
  assert.ok(existsSync(copy), `expected the identity copy of this run, saw ${names(ctx.backupDir)}\n${r.out}`);
  assert.equal(mode(copy), 0o600, "the identity copy is 0600");
  assert.equal(mode(`${copy}.owner.json`), 0o600, "it carries this instance's owner sidecar, 0600");
  assert.equal(JSON.parse(readFileSync(copy, "utf8")).crowId, mine.crowId, "it is this instance's identity");
  assert.match(r.out, /Identity copy \(this machine only\): /, r.out);

  // Same stem and date as this run's database copy, and the same sidecar owner.
  const dbName = names(ctx.backupDir).find((n) => n.endsWith(".db"));
  assert.equal(name.replace("-identity-", "-").replace(/\.json$/, ".db"), dbName, "same stem and date as the .db");
  const owner = JSON.parse(readFileSync(`${copy}.owner.json`, "utf8"));
  assert.equal(owner.label, "primary");
  assert.equal(owner.tag, null);
  assert.equal(owner.db_path, join(ctx.data, "crow.db"));

  // The live identity is untouched, and no secrets directory was invented.
  assert.equal(readFileSync(join(ctx.data, "identity.json"), "utf8"), identityJson(mine.crowId, mine.seed));
  assert.equal(mode(join(ctx.data, "identity.json")), 0o600);
});

test("identity never leaves for S3 or git", { skip: (!HAS_GIT || !HAS_SQLITE3) && "git and sqlite3 are needed for the upload steps" }, async () => {
  const ctx = await ctxNew();
  makeDb(join(ctx.data, "crow.db"), ["upload me"]).close();
  const mine = identityFor(IDENTITY_SEED);
  writeIdentity(ctx.data, mine.crowId, mine.seed);

  // A keychain key on this host: it must never travel either.
  const secrets = join(ctx.home, ".crow", "secrets");
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  writeFileSync(join(secrets, "keychain.key"), JSON.stringify({ v: 1, id: "0123456789abcdef", key: "AAAA" }), { mode: 0o600 });

  const mc = stubMc(ctx);

  // A local bare repo as the git destination, plus a scratch clone dir.
  const bare = join(ctx.root, "backup.git");
  const init = spawnSync("git", ["init", "--bare", "--quiet", bare], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  assert.equal(init.status, 0, init.stderr);
  const gitDir = join(ctx.root, "backup-repo");

  const r = await run(BACKUP_SH, [], envFor(ctx, {
    PATH: `${mc.bin}:${process.env.PATH}`,
    S3_ENDPOINT: "s3.example.invalid", S3_ACCESS_KEY: "ak", S3_SECRET_KEY: "sk",
    CROW_BACKUP_S3_BUCKET: "crow-backups",
    CROW_BACKUP_GIT_REPO: bare,
    CROW_BACKUP_GIT_DIR: gitDir,
    ...GIT_ENV,
  }));
  assert.equal(r.status, 0, r.out);

  // The allow-list sent THIS run's database and dump, and nothing else.
  const calls = mc.calls();
  const cps = calls.filter((c) => c.startsWith("cp "));
  assert.ok(cps.some((c) => c.includes(".db")), `expected the database copy to be uploaded, saw ${JSON.stringify(calls)}`);
  assert.ok(cps.some((c) => c.includes(".sql")), `expected this run's SQL dump to be uploaded, saw ${JSON.stringify(calls)}`);
  for (const c of calls) {
    assert.doesNotMatch(c, /identity/i, `an identity file reached mc: ${c}`);
    assert.doesNotMatch(c, /secrets|keychain/i, `a secrets file reached mc: ${c}`);
  }

  // The git tree holds the SQL dump and nothing else sensitive.
  const staged = spawnSync("git", ["-C", gitDir, "ls-files"], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  assert.equal(staged.status, 0, staged.stderr);
  const tracked = staged.stdout.trim().split("\n").filter(Boolean);
  assert.ok(tracked.some((f) => f.endsWith(".sql")), `expected a committed SQL dump, saw ${JSON.stringify(tracked)}`);
  for (const f of tracked) {
    assert.doesNotMatch(f, /identity/i, `an identity file was committed: ${f}`);
    assert.doesNotMatch(f, /secrets|keychain/i, `a secrets file was committed: ${f}`);
  }
  // ...and the commit itself carries no identity file either (name or content).
  const commitFiles = spawnSync("git", ["-C", gitDir, "log", "--name-only", "--pretty=format:"], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  assert.equal(commitFiles.status, 0, commitFiles.stderr);
  assert.doesNotMatch(commitFiles.stdout, /identity|keychain|secrets/i, commitFiles.stdout);
  const blob = spawnSync("git", ["-C", gitDir, "grep", "-l", mine.crowId], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  assert.notEqual(blob.status, 0, "the identity's crow id is nowhere in the committed tree");

  // Both files DID land in the local backup folder, which is the point.
  const localTree = treeOf(ctx.backupDir);
  assert.ok(localTree.some((f) => f.includes("-identity-")), `the identity copy stays local: ${localTree}`);
  assert.ok(localTree.some((f) => f.endsWith(".sql")), localTree.join(", "));
});

test("backup never copies the secrets folder", async () => {
  const ctx = await ctxNew();
  makeDb(join(ctx.data, "crow.db"), ["a row"]).close();
  const mine = identityFor(IDENTITY_SEED);
  writeIdentity(ctx.data, mine.crowId, mine.seed);

  // <CROW_HOME>/secrets: the keychain key (and anything else kept there).
  const secrets = join(ctx.home, ".crow", "secrets");
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  writeFileSync(join(secrets, "keychain.key"), JSON.stringify({ v: 1, id: "0123456789abcdef", key: "AAAA" }), { mode: 0o600 });
  writeFileSync(join(secrets, "vault-device-id"), "device-1234\n", { mode: 0o600 });

  const r = await run(BACKUP_SH, [], envFor(ctx));
  assert.equal(r.status, 0, r.out);

  const tree = treeOf(ctx.backupDir);
  assert.ok(tree.length > 0, "the backup wrote something");
  for (const f of tree) {
    assert.doesNotMatch(f, /secrets/i, `a secrets file was copied into the backup dir: ${f}`);
    assert.doesNotMatch(f, /keychain|vault-device/i, `a keychain file was copied into the backup dir: ${f}`);
  }
  assert.ok(tree.some((f) => f.includes("-identity-")), "the identity copy itself is kept (locally)");
});

/** This instance's owner sidecar for a hand-made backup file (what backup-db.mjs writes). */
function ownSidecar(ctx, file) {
  writeFileSync(`${file}.owner.json`, JSON.stringify({
    instance_id: null,
    crow_home: join(ctx.home, ".crow"),
    db_path: join(ctx.data, "crow.db"),
    label: "primary",
    tag: null,
    written_at: new Date().toISOString(),
  }, null, 2), { mode: 0o600 });
}

test("restore with-identity puts it back only when it is the same identity or none", async () => {
  const identityCopy = (ctx, ident) => {
    mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 });
    const p = join(ctx.backupDir, `primary-identity-${today()}.json`);
    writeFileSync(p, identityJson(ident.crowId, ident.seed), { mode: 0o600 });
    chmodSync(p, 0o600);
    ownSidecar(ctx, p);
    return p;
  };
  const backupDb = (ctx, rows) => {
    mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 });
    const p = join(ctx.backupDir, `primary-${today()}.db`);
    makeDb(p, rows).close();
    return p;
  };

  // (a) NO identity.json here yet → the copy of the same run is restored, 0600.
  {
    const ctx = await ctxNew();
    const mine = identityFor(IDENTITY_SEED);
    makeDb(join(ctx.data, "crow.db"), ["before"]).close();
    backupDb(ctx, ["from the backup"]);
    const copy = identityCopy(ctx, mine);

    // --list mentions the identity copy, so an owner can see it is there.
    const list = await run(RESTORE_SH, ["--list"], envFor(ctx));
    assert.equal(list.status, 0, list.out);
    assert.ok(list.out.includes(`primary-identity-${today()}.json`), list.out);

    const r = await run(RESTORE_SH, ["primary-" + today() + ".db", "--with-identity"], envFor(ctx));
    assert.equal(r.status, 0, r.out);
    const restored = join(ctx.data, "identity.json");
    assert.ok(existsSync(restored), `expected identity.json back:\n${r.out}`);
    assert.equal(mode(restored), 0o600, "the restored identity is 0600");
    assert.equal(readFileSync(restored, "utf8"), readFileSync(copy, "utf8"));
    assert.ok(r.out.includes(`Identity restored: ${restored} (crow id ${mine.crowId}, 0600).`), r.out);
    assert.deepEqual(memoriesIn(join(ctx.data, "crow.db")), ["from the backup"]);
    // The seed's identity is what the copy claims: identity.js derives it.
    assert.equal(seedCrowId(JSON.parse(readFileSync(restored, "utf8")).seed), mine.crowId);
  }

  // (b) the SAME crow id already here → allowed, and the file is left alone.
  {
    const ctx = await ctxNew();
    const mine = identityFor(IDENTITY_SEED);
    makeDb(join(ctx.data, "crow.db"), ["before"]).close();
    backupDb(ctx, ["from the backup"]);
    identityCopy(ctx, mine);
    // The owner's own file, marked so a rewrite would be visible.
    const here = join(ctx.data, "identity.json");
    writeFileSync(here, JSON.stringify({ ...JSON.parse(identityJson(mine.crowId, mine.seed)), mine: true }, null, 2), { mode: 0o600 });
    chmodSync(here, 0o600);
    const before = readFileSync(here, "utf8");

    const r = await run(RESTORE_SH, ["primary-" + today() + ".db", "--with-identity"], envFor(ctx));
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes(`already holds this identity (crow id ${mine.crowId}); left untouched`), r.out);
    assert.equal(readFileSync(here, "utf8"), before, "the owner's own file was not rewritten");
  }

  // (c) a DIFFERENT identity here → refused, nothing touched — not even the database.
  {
    const ctx = await ctxNew();
    const theirs = identityFor(IDENTITY_SEED);
    const ours = identityFor("77".repeat(32));
    makeDb(join(ctx.data, "crow.db"), ["keep me"]).close();
    backupDb(ctx, ["from the backup"]);
    identityCopy(ctx, theirs);
    const here = writeIdentity(ctx.data, ours.crowId, ours.seed);
    const before = readFileSync(here, "utf8");

    const r = await run(RESTORE_SH, ["primary-" + today() + ".db", "--with-identity"], envFor(ctx));
    assert.notEqual(r.status, 0, "a different identity must stop the restore");
    assert.ok(r.out.includes(`This instance already has a different identity (crow id ${ours.crowId}). Move it aside yourself if you mean to replace it.`), r.out);
    assert.match(r.out, /Nothing has been changed/);
    assert.equal(readFileSync(here, "utf8"), before, "the existing identity is untouched");
    assert.equal(mode(here), 0o600);
    assert.deepEqual(memoriesIn(join(ctx.data, "crow.db")), ["keep me"], "the database is untouched too");
    assert.deepEqual(names(ctx.data).filter((n) => n.includes("pre-restore")), []);
  }

  // (d) without --with-identity, identity.json is never touched.
  {
    const ctx = await ctxNew();
    const theirs = identityFor(IDENTITY_SEED);
    makeDb(join(ctx.data, "crow.db"), ["before"]).close();
    backupDb(ctx, ["restored without the identity"]);
    identityCopy(ctx, theirs);

    const r = await run(RESTORE_SH, ["primary-" + today() + ".db"], envFor(ctx));
    assert.equal(r.status, 0, r.out);
    assert.equal(existsSync(join(ctx.data, "identity.json")), false, "no identity was written");
    assert.doesNotMatch(r.out, /Identity restored/);
    assert.deepEqual(memoriesIn(join(ctx.data, "crow.db")), ["restored without the identity"]);
  }
});

// A co-hosted instance shares the backup directory. Its identity copy carries
// ITS .owner.json sidecar, so `--with-identity` must refuse it with the same
// rule the backup run and the prune use — never install another instance's
// identity over this machine's.
test("restore with-identity refuses another instance's identity copy", async () => {
  const ctx = await ctxNew();
  const otherHome = join(ctx.home, ".crow-r4");
  const otherData = join(ctx.root, "r4data");
  const theirs = identityFor(IDENTITY_SEED);

  makeDb(join(ctx.data, "crow.db"), ["keep me"]).close();
  mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 });
  const backup = join(ctx.backupDir, `primary-${today()}.db`);
  makeDb(backup, ["from another instance"]).close();

  // The other instance's copy: same stem and date, ITS sidecar — and a seed and
  // crow id that agree, so the only thing wrong with it is whose it is.
  const copy = join(ctx.backupDir, `primary-identity-${today()}.json`);
  writeFileSync(copy, identityJson(theirs.crowId, theirs.seed), { mode: 0o600 });
  writeFileSync(`${copy}.owner.json`, JSON.stringify({
    instance_id: "inst-r4",
    crow_home: otherHome,
    db_path: join(otherData, "crow.db"),
    label: "primary",
    tag: null,
    written_at: "2026-11-05T00:00:00.000Z",
  }, null, 2), { mode: 0o600 });

  const r = await run(RESTORE_SH, [`primary-${today()}.db`, "--with-identity"], envFor(ctx));
  assert.notEqual(r.status, 0, "another instance's identity copy must stop the restore");
  assert.match(r.out, /That identity copy belongs to another Crow instance; it is not restored here\./, r.out);
  assert.match(r.out, /Nothing has been changed/);

  // Nothing happened: no identity, no restore, no safety copy.
  assert.equal(existsSync(join(ctx.data, "identity.json")), false, "no identity was written");
  assert.deepEqual(memoriesIn(join(ctx.data, "crow.db")), ["keep me"], "the database is untouched");
  assert.deepEqual(names(ctx.data).filter((n) => n.includes("pre-restore")), []);
});

// A copy whose seed does not derive the crow id it claims is not the identity
// it says it is: installing it would orphan every bot key, contact and share
// that the real seed derives, so it is refused before anything changes.
test("restore with-identity refuses a copy whose seed does not match its crow id", async () => {
  const ctx = await ctxNew();
  const claimed = identityFor(IDENTITY_SEED);
  const other = identityFor("2a".repeat(32));
  assert.notEqual(claimed.crowId, other.crowId);

  makeDb(join(ctx.data, "crow.db"), ["keep me"]).close();
  mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 });
  const backup = join(ctx.backupDir, `primary-${today()}.db`);
  makeDb(backup, ["from the backup"]).close();

  // The claimed crow id, somebody else's seed — under this instance's own
  // sidecar, so only the seed check can catch it.
  const copy = join(ctx.backupDir, `primary-identity-${today()}.json`);
  writeFileSync(copy, identityJson(claimed.crowId, other.seed), { mode: 0o600 });
  ownSidecar(ctx, copy);

  const r = await run(RESTORE_SH, [`primary-${today()}.db`, "--with-identity"], envFor(ctx));
  assert.notEqual(r.status, 0, "a copy whose seed does not give its crow id must stop the restore");
  assert.match(r.out, /its seed does not derive the crow id it claims/, r.out);
  assert.match(r.out, /Nothing has been changed/);

  assert.equal(existsSync(join(ctx.data, "identity.json")), false, "no identity was written");
  assert.deepEqual(memoriesIn(join(ctx.data, "crow.db")), ["keep me"], "the database is untouched");
  assert.deepEqual(names(ctx.data).filter((n) => n.includes("pre-restore")), []);
});

// The upload guard refuses exactly what must not leave: this instance's identity
// copy name, any identity.json, and anything under secrets/ — NOT every name
// that happens to contain the word, so a database copy whose stem contains it
// still uploads.
test("the upload guard refuses an identity file but not a stem that contains the word", async () => {
  const ctx = await ctxNew();
  const date = today();
  mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 });

  // The guard itself, exactly as backup.sh asks it (`backup-db.mjs --may-leave`).
  const guard = (file, env = envFor(ctx)) => {
    const r = spawnSync(process.execPath, [BACKUP_HELPER, "--may-leave", file], { encoding: "utf8", env });
    return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
  };

  // 1. This instance's identity copy → refused.
  const inside = identityFor(IDENTITY_SEED);
  const identityCopyPath = join(ctx.backupDir, `primary-identity-${date}.json`);
  writeFileSync(identityCopyPath, identityJson(inside.crowId, inside.seed), { mode: 0o600 });
  const refused = guard(identityCopyPath);
  assert.equal(refused.status, 3, `the identity copy must not leave: ${refused.out}`);
  assert.match(refused.out, /identity copy/);

  // 2. Any identity.json → refused.
  const bare = join(ctx.root, "identity.json");
  writeFileSync(bare, "{}");
  assert.equal(guard(bare).status, 3, "a bare identity.json never leaves");

  // 3. A .db/.sql whose STEM contains the word → allowed (it is a database copy).
  const dbNamedIdentity = join(ctx.backupDir, `primary-identity-${date}.db`);
  writeFileSync(dbNamedIdentity, "a database copy, not an identity");
  const allowedDb = guard(dbNamedIdentity);
  assert.equal(allowedDb.status, 0, `a .db whose stem contains "identity" may leave: ${allowedDb.out}`);
  const sqlNamedIdentity = join(ctx.backupDir, `primary-identity-${date}.sql`);
  writeFileSync(sqlNamedIdentity, "-- a dump, not an identity\n");
  assert.equal(guard(sqlNamedIdentity).status, 0, "a .sql whose stem contains \"identity\" may leave");

  // 4. Anything under <CROW_HOME>/secrets → refused.
  const secrets = join(ctx.home, ".crow", "secrets");
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  const keychain = join(secrets, "keychain.key");
  writeFileSync(keychain, "{\n}");
  const refusedSecret = guard(keychain);
  assert.equal(refusedSecret.status, 3, "the keychain key never leaves");
  assert.match(refusedSecret.out, /secrets/);

  // …and the S3 step agrees end to end: a label whose stem contains the word
  // uploads its database copy (and never the identity copy beside it).
  const mine = identityFor(IDENTITY_SEED);
  writeIdentity(ctx.data, mine.crowId, mine.seed);
  makeDb(join(ctx.data, "crow.db"), ["a row"]).close();
  const mc = stubMc(ctx);
  const r = await run(BACKUP_SH, [], envFor(ctx, {
    NTFY_TOPIC: "identity-rich",
    PATH: `${mc.bin}:${process.env.PATH}`,
    S3_ENDPOINT: "s3.example.invalid", S3_ACCESS_KEY: "ak", S3_SECRET_KEY: "sk",
    CROW_BACKUP_S3_BUCKET: "crow-backups",
  }));
  assert.equal(r.status, 0, r.out);
  const cps = mc.calls().filter((c) => c.startsWith("cp "));
  assert.ok(cps.some((c) => c.includes(`identity-rich-${date}.db`)),
    `a stem containing "identity" still uploads its .db: ${JSON.stringify(mc.calls())}`);
  assert.ok(existsSync(join(ctx.backupDir, `identity-rich-identity-${date}.json`)),
    `the run's identity copy is kept locally: ${names(ctx.backupDir)}`);
  assert.match(r.out, /Uploaded to S3: /, r.out);
  assert.doesNotMatch(r.out, /Refused to upload/, `the identity copy is never offered to S3:\n${r.out}`);
});

test("a corrupt backup is refused before anything changes", async () => {
  const ctx = await ctxNew();
  const live = join(ctx.data, "crow.db");
  makeDb(live, ["keep me", "and me"]).close();

  const corrupt = join(ctx.root, "corrupt.db");
  writeFileSync(corrupt, "this is not a sqlite database, not even close\n".repeat(40));
  mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 });

  const r = await run(RESTORE_SH, [corrupt], envFor(ctx));
  assert.notEqual(r.status, 0, "a corrupt backup must not be restored");
  assert.match(r.out, /refusing to restore .*corrupt\.db.*(integrity check|not a database)/i, r.out);
  assert.match(r.out, /Nothing has been changed/);

  // The live database is untouched: same rows, no pre-restore copy, no temp file.
  assert.deepEqual(memoriesIn(live), ["keep me", "and me"]);
  assert.deepEqual(names(ctx.data), ["crow.db"], "no safety copy, no temp file");
});

// The failure lands AFTER the safety copy and while the temp file is being
// written (before the -wal/-shm removal and before the rename): the old
// database and its un-checkpointed WAL must both still be there.
test("a failed restore keeps the old database and its wal", async () => {
  const ctx = await ctxNew();
  const live = join(ctx.data, "crow.db");
  await killedWriterDb(live, ["live 1", "live 2", "live 3"]);
  const wal = join(ctx.data, "crow.db-wal");
  const shm = join(ctx.data, "crow.db-shm");
  assert.equal(existsSync(wal), true, "the killed writer left its WAL");

  const backup = join(ctx.backupDir, `primary-${today()}.db`);
  mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 });
  makeDb(backup, ["from the backup"]).close();

  const r = await run(RESTORE_SH, [backup], envFor(ctx, { CROW_RESTORE_TEST_FAIL: "copy" }));
  assert.notEqual(r.status, 0, "a failed restore must exit non-zero");
  assert.match(r.out, /the restore failed, so .*crow\.db has NOT been replaced/, r.out);

  // Old database + WAL intact (checked before anything opens the database).
  assert.equal(existsSync(wal), true, "the old database's -wal is still there");
  assert.equal(existsSync(shm), true, "the old database's -shm is still there");
  assert.deepEqual(names(ctx.data).filter((n) => n.startsWith(".crow.db.restore-")), [], "no half-written temp file left behind");
  assert.deepEqual(memoriesIn(live), ["live 1", "live 2", "live 3"], "the rows are the old ones");
  assert.ok(names(ctx.data).some((n) => n.startsWith("crow.db.pre-restore-")), "the safety copy was made first");
});

// Restoring the live file onto itself destroys both copies, and a -wal is not a
// database: all three shapes are refused before anything changes.
test("restoring the live file onto itself is refused", async () => {
  const ctx = await ctxNew();
  const live = join(ctx.data, "crow.db");
  makeDb(live, ["only copy"]).close();
  mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 });

  // (a) the full path of the live database.
  const direct = await run(RESTORE_SH, [live], envFor(ctx));
  assert.notEqual(direct.status, 0, direct.out);
  assert.match(direct.out, /refusing to restore .*: it IS the database being restored/, direct.out);
  assert.match(direct.out, /Nothing has been changed/);

  // (b) a bare name that is not in the backup dir or the legacy dir either —
  // resolved from the current directory.
  const bare = await run(RESTORE_SH, ["crow.db"], envFor(ctx), { cwd: ctx.data });
  assert.notEqual(bare.status, 0, bare.out);
  assert.match(bare.out, /it IS the database being restored/, bare.out);

  // (c) a backup-shaped name that is really the live database's -wal.
  writeFileSync(join(ctx.data, "crow.db-wal"), "");
  const link = join(ctx.root, "wal-as-backup.db");
  symlinkSync(join(ctx.data, "crow.db-wal"), link);
  const viaLink = await run(RESTORE_SH, [link], envFor(ctx));
  assert.notEqual(viaLink.status, 0, viaLink.out);
  assert.match(viaLink.out, /it is crow\.db-wal, part of the database a restore replaces/, viaLink.out);

  // And through all of it the one database was never touched.
  assert.deepEqual(memoriesIn(live), ["only copy"]);
  assert.deepEqual(names(ctx.data).filter((n) => n.includes("pre-restore")), []);
});

/* ---------------------------------------------------------------------------
 * Review fixes (round 3): a symlinked database path, a truncated .sql dump,
 * and an artifacts hint that names only this instance's copy.
 * ------------------------------------------------------------------------- */

// A database reached through a symlink: the REAL file is what a restore has to
// replace. SQLite keeps -wal/-shm beside the real file, and a rename onto the
// link would replace the link itself — so every step of `apply` (temp file,
// journal removal, rename, owner/mode) must work on the real path.
test("a restore through a symlinked database path replaces the real file", async () => {
  const ctx = await ctxNew();
  const realDir = join(ctx.data, "real");
  mkdirSync(realDir, { recursive: true });
  const real = join(realDir, "crow.db");
  // A WAL database with un-checkpointed rows and a stale -wal/-shm beside the
  // REAL file (a killed writer), the way a symlinked data dir looks on disk.
  await killedWriterDb(real, ["live 1", "live 2"]);
  const realWal = join(realDir, "crow.db-wal");
  assert.equal(existsSync(realWal), true, "the real file has its -wal");
  const link = join(ctx.data, "crow.db");
  symlinkSync(real, link);
  chmodSync(real, 0o640);

  const backup = join(ctx.backupDir, `primary-${today()}.db`);
  mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 });
  makeDb(backup, ["from the backup", "and this one"]).close();

  // CROW_DB_PATH is the SYMLINK.
  const r = await run(RESTORE_SH, [backup], envFor(ctx));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, new RegExp(`crow\\.db is a symlink; the real file ${escRe(real)} was replaced`), r.out);

  // The link is still a link, and the real file is the restored database.
  assert.equal(lstatSync(link).isSymbolicLink(), true, "the symlink was not replaced by a regular file");
  assert.equal(readlinkSync(link), real);
  assert.deepEqual(memoriesIn(real), ["from the backup", "and this one"]);
  assert.equal(mode(real), 0o640, "the real file kept the old file's mode");

  // The stale journals of the replaced database went from beside the REAL file...
  assert.equal(existsSync(realWal), false, "the stale -wal of the real file is removed");
  assert.equal(existsSync(join(realDir, "crow.db-shm")), false, "the stale -shm of the real file is removed");
  // ...and no temp file was left beside the real file or beside the link.
  assert.deepEqual(names(realDir).filter((n) => n.startsWith(".crow.db.restore-")), [], "no temp file beside the real file");
  assert.deepEqual(names(ctx.data).filter((n) => n.startsWith(".crow.db.restore-")), [], "no temp file beside the link");
});

// A .sql dump cut off at a STATEMENT BOUNDARY replays without a single error
// and exits 0: sqlite3 simply stops at the end of the file. Only the missing
// `COMMIT;` (and, for an empty dump, the absent tables) gives it away, so a
// restore must refuse rather than install half a database.
test("a truncated sql dump is refused", { skip: !HAS_SQLITE3 && "sqlite3 not installed" }, async () => {
  const ctx = await ctxNew();
  const live = join(ctx.data, "crow.db");
  makeDb(live, ["keep me"]).close();
  mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 });

  const truncated = join(ctx.backupDir, `primary-${today()}.sql`);
  writeFileSync(truncated, [
    "PRAGMA foreign_keys=OFF;",
    "BEGIN TRANSACTION;",
    "CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT);",
    "INSERT INTO memories (content) VALUES ('half the data');",
  ].join("\n") + "\n");

  const r = await run(RESTORE_SH, [truncated], envFor(ctx));
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /The SQL dump is incomplete \(it does not end with COMMIT;\); nothing was changed\./, r.out);
  assert.match(r.out, /has NOT been replaced/, r.out);
  assert.deepEqual(memoriesIn(live), ["keep me"], "the database is untouched");
  assert.deepEqual(names(ctx.data).filter((n) => n.startsWith(".crow.db.restore-")), [], "no temp file left behind");

  // The other half of the rule: a dump that does end with COMMIT; but creates
  // no table at all is refused too.
  const empty = join(ctx.backupDir, `primary-empty-${today()}.sql`);
  writeFileSync(empty, "BEGIN TRANSACTION;\nCOMMIT;\n");
  const r2 = await run(RESTORE_SH, [empty], envFor(ctx));
  assert.notEqual(r2.status, 0, r2.out);
  assert.match(r2.out, /The SQL dump is incomplete \(it creates no tables\); nothing was changed\./, r2.out);
  assert.deepEqual(memoriesIn(live), ["keep me"], "the database is still untouched");
  assert.deepEqual(names(ctx.data).filter((n) => n.startsWith(".crow.db.restore-")), [], "no temp file left behind");
});

// The backup directory can be shared by two co-hosted instances, each with its
// own artifacts copy. A restore must name THIS instance's blobs only (another
// instance's `artifacts-<stem>` is not what this database's rows point at), and
// a tagged instance gets the one-time upgrade note about the split.
test("restore names only this instance's artifacts copy", async () => {
  const ctx = await ctxNew();
  const live = join(ctx.data, "crow.db");
  makeDb(live, ["keep me"]).close();
  mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 });
  const backup = join(ctx.backupDir, `primary-${today()}.db`);
  makeDb(backup, ["from the backup"]).close();

  // Two artifacts copies side by side: the host-default instance's and a
  // co-hosted (own CROW_HOME) instance's.
  const r4Home = join(ctx.home, ".crow-r4");
  const tag = instanceBackupTag({ CROW_HOME: r4Home });
  const ourCopy = join(ctx.backupDir, "artifacts");
  const otherCopy = join(ctx.backupDir, artifactStoreName("primary", tag));
  assert.notEqual(ourCopy, otherCopy);
  for (const d of [ourCopy, otherCopy]) mkdirSync(d, { recursive: true, mode: 0o700 });

  const hint = (out) => {
    const m = out.match(/Artifacts blobs for a full recovery: (.*)/);
    return m ? m[1].trim() : null;
  };
  const hintCount = (out) => (out.match(/Artifacts blobs for a full recovery:/g) || []).length;

  // The host-default instance: its own copy, and no other instance's.
  const r = await run(RESTORE_SH, [backup], envFor(ctx));
  assert.equal(r.status, 0, r.out);
  assert.equal(hint(r.out), ourCopy, r.out);
  assert.equal(hintCount(r.out), 1, `exactly one artifacts hint expected:\n${r.out}`);
  assert.doesNotMatch(r.out, new RegExp(escRe(otherCopy)), "another instance's copy is never named");
  assert.doesNotMatch(r.out, /Note \(one time/, "the upgrade note is for a tagged instance");

  // A tagged instance (its own CROW_HOME): only ITS copy, plus that note.
  const bData = join(ctx.root, "r4data");
  mkdirSync(bData, { recursive: true });
  makeDb(join(bData, "crow.db"), ["r4 row"]).close();
  const r4 = await run(RESTORE_SH, [backup], envFor(ctx, {
    CROW_HOME: r4Home,
    CROW_DATA_DIR: bData,
    CROW_DB_PATH: join(bData, "crow.db"),
    PORT: String(await freePort()),
  }));
  assert.equal(r4.status, 0, r4.out);
  assert.equal(hint(r4.out), otherCopy, r4.out);
  assert.equal(hintCount(r4.out), 1, `exactly one artifacts hint expected:\n${r4.out}`);
  assert.match(r4.out, /Note \(one time, for an instance with its own CROW_HOME\)/, r4.out);
  assert.match(r4.out, /[Tt]he first\s+backup after upgrading writes/, r4.out);
  assert.match(r4.out, /run a backup once now/, r4.out);
});

// An answering gateway that names no database at all is an older Crow: its copy
// cannot be attributed either way, and the port is in use by a process holding
// some crow.db — so the run stops with advice and never falls back to a local
// copy of the live file.
test("backup refuses an answering gateway that does not say which database it backed up", async () => {
  const ctx = await ctxNew();
  const live = join(ctx.data, "crow.db");
  makeDb(live, ["ours"]).close();
  const template = join(ctx.root, "template.db");
  makeDb(template, ["from the gateway"]).close();

  // Its copy lands in its own directory, so nothing of it can be mistaken for
  // this instance's backup.
  const gatewayDir = join(ctx.root, "old-gateway-backups");
  await startStubGateway(ctx, { copyFrom: template, dbPath: null, backupDir: gatewayDir });

  const r = await run(BACKUP_SH, [], envFor(ctx));
  assert.notEqual(r.status, 0, r.out);
  assert.match(
    r.out,
    new RegExp(`the gateway on port ${ctx.port} is older than this backup script and did not say which database it backed up`),
    r.out,
  );
  assert.match(r.out, /update Crow, or stop the gateway and run the backup again/, r.out);
  assert.doesNotMatch(r.out, /making the copy here with better-sqlite3/, "no fall-through to a local copy");
  assert.deepEqual(names(ctx.backupDir).filter((n) => n.endsWith(".db")), [], "no copy was filed");
});
test("restore with-identity refuses a copy with no owner record", async () => {
  const ctx = await ctxNew();
  const mine = identityFor(IDENTITY_SEED);
  makeDb(join(ctx.data, "crow.db"), ["keep me"]).close();
  mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 });
  makeDb(join(ctx.backupDir, `primary-${today()}.db`), ["from the backup"]).close();
  const copy = join(ctx.backupDir, `primary-identity-${today()}.json`);
  writeFileSync(copy, identityJson(mine.crowId, mine.seed), { mode: 0o600 });
  const r = await run(RESTORE_SH, [`primary-${today()}.db`, "--with-identity"], envFor(ctx));
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /no owner record naming this Crow instance/);
  assert.equal(existsSync(join(ctx.data, "identity.json")), false, "no identity was installed");
  assert.deepEqual(memoriesIn(join(ctx.data, "crow.db")), ["keep me"], "and the database was not replaced");
});

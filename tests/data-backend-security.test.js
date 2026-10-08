/**
 * Data-backend security: registering a backend must not schedule code
 * execution, and SQLite dataset backends must never reach Crow's own
 * databases or write through a "read-only" path.
 *
 *   1. crow_register_backend stored any command and the gateway spawned every
 *      mcp_server row at boot / reload. Now: an mcp_server row is PENDING until
 *      the dashboard owner approves it, and the approval is bound to the exact
 *      connection_ref (any later edit voids it).
 *   2. A sqlite backend could point at crow.db, and crow_data_write (and the
 *      GIS batch geocoder) mutated it. Now: datasets live only under the data
 *      dir's datasets/ or projects/<id>/databases/, never a core DB (by
 *      realpath AND inode), read paths open the file read-only, and
 *      crow_data_write is disabled.
 *   3. The read-only check looked at the first token only.
 *   4. The row cap was skipped whenever the text contained "LIMIT".
 *   5. The path check was a bare startsWith (sibling-prefix escape).
 *
 * Everything runs in a scratch HOME / data dir set BEFORE any app import
 * (several modules resolve paths from homedir() at call time).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, symlinkSync, linkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const ROOT = join(import.meta.dirname, "..");
const HOME = mkdtempSync(join(tmpdir(), "crow-dbsec-"));
const DATA = join(HOME, ".crow", "data");
mkdirSync(DATA, { recursive: true });
process.env.HOME = HOME;
process.env.CROW_HOME = join(HOME, ".crow");
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_DB_PATH = join(DATA, "crow.db");
process.env.NOMINATIM_URL = "http://127.0.0.1:9";
after(() => rmSync(HOME, { recursive: true, force: true }));

execFileSync(process.execPath, ["scripts/init-db.js"], { cwd: ROOT, env: process.env, stdio: "pipe" });
const CORE = join(DATA, "crow.db");

const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

async function connect(server) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  return client;
}
const text = (r) => (r.content || []).map((c) => c.text).join("\n");

function raw() { return new Database(CORE); }
function projectId() {
  const d = raw();
  try {
    const row = d.prepare("SELECT id FROM project_spaces LIMIT 1").get();
    if (row) return row.id;
    return Number(d.prepare("INSERT INTO project_spaces (name, slug, type) VALUES ('t', 't-proj', 'data_connector')").run().lastInsertRowid);
  } finally { d.close(); }
}
function insertSqliteBackend(path) {
  const d = raw();
  try {
    return Number(d.prepare("INSERT INTO data_backends (project_id, name, backend_type, connection_ref, status) VALUES (?, 'b', 'sqlite', ?, 'connected')")
      .run(projectId(), JSON.stringify({ path })).lastInsertRowid);
  } finally { d.close(); }
}
function makeDataset(path, n = 300) {
  mkdirSync(join(path, ".."), { recursive: true });
  const d = new Database(path);
  d.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  const ins = d.prepare("INSERT INTO t (v) VALUES (?)");
  d.transaction(() => { for (let i = 0; i < n; i++) ins.run(`r${i}`); })();
  d.close();
  return path;
}
const userVersion = (p) => { const d = new Database(p, { readonly: true }); try { return d.pragma("user_version", { simple: true }); } finally { d.close(); } };
const count = (p) => { const d = new Database(p, { readonly: true }); try { return d.prepare("SELECT COUNT(*) c FROM t").get().c; } finally { d.close(); } };

// ---------------------------------------------------------------- finding 1

const { createProjectServer } = await import("../servers/research/server.js");
const { loadDynamicBackends } = await import("../servers/gateway/proxy.js");

function markerRef(marker) {
  return JSON.stringify({
    command: process.execPath,
    args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
  });
}

test("finding 1: a backend registered through the MCP tool is never spawned", async () => {
  const marker = join(HOME, "pwned-register");
  const client = await connect(createProjectServer(CORE));
  const r = await client.callTool({ name: "crow_register_backend", arguments: { name: "evil", connection_ref: markerRef(marker) } });
  assert.ok(!r.isError, text(r));
  await loadDynamicBackends();
  assert.equal(existsSync(marker), false, "the registered command ran");
  const d = raw();
  const row = d.prepare("SELECT status, approved_ref_sha256 FROM data_backends WHERE name='evil'").get();
  d.close();
  assert.equal(row.status, "pending_approval");
  assert.equal(row.approved_ref_sha256, null);
  assert.match(text(r), /approv/i, "the tool tells the caller an owner must approve it");
});

test("finding 1: backend_type is limited to the two documented kinds", async () => {
  const client = await connect(createProjectServer(CORE));
  const r = await client.callTool({ name: "crow_register_backend", arguments: { name: "x", backend_type: "shell", connection_ref: markerRef(join(HOME, "shell")) } });
  assert.ok(r.isError, "an unknown backend_type was accepted");
});

test("finding 1: a sqlite backend registered through the tool is path-checked", async () => {
  const client = await connect(createProjectServer(CORE));
  const r = await client.callTool({ name: "crow_register_backend", arguments: { name: "core", backend_type: "sqlite", connection_ref: JSON.stringify({ path: CORE, command: "node" }) } });
  assert.ok(r.isError, "a sqlite backend on crow.db was registered");
});

test("finding 1: an owner approval spawns it; editing the command afterwards voids the approval", async () => {
  const { approveBackend } = await import("../servers/shared/data-backend-approval.js");
  const marker = join(HOME, "approved-run");
  const d = raw();
  const id = Number(d.prepare("INSERT INTO data_backends (project_id, name, backend_type, connection_ref, status) VALUES (?, 'ok', 'mcp_server', ?, 'pending_approval')")
    .run(projectId(), markerRef(marker)).lastInsertRowid);
  d.close();
  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient(CORE);
  await approveBackend(db, id);
  await loadDynamicBackends();
  assert.equal(existsSync(marker), true, "positive control: an approved row is started");

  const marker2 = join(HOME, "swapped-run");
  const d2 = raw();
  d2.prepare("UPDATE data_backends SET connection_ref = ?, status = 'disconnected' WHERE id = ?").run(markerRef(marker2), id);
  d2.close();
  await loadDynamicBackends();
  assert.equal(existsSync(marker2), false, "a command swapped under an approval ran");
});

test("finding 1: data_backends never replicates between instances", async () => {
  const { SYNCED_TABLES } = await import("../servers/sharing/instance-sync.js");
  assert.equal(SYNCED_TABLES.includes("data_backends"), false);
});

// ------------------------------------------------------------ findings 2-5

const qe = await import("../bundles/data-dashboard/server/query-engine.js");

test("finding 2: a read query cannot target crow.db (direct, symlink, hardlink)", async () => {
  const before = readFileSync(CORE);
  const ds = join(DATA, "datasets");
  mkdirSync(ds, { recursive: true });
  symlinkSync(CORE, join(ds, "sym.db"));
  linkSync(CORE, join(ds, "hard.db"));
  for (const p of [CORE, join(ds, "sym.db"), join(ds, "hard.db"), join(DATA, "tasks.db")]) {
    await assert.rejects(qe.executeReadQuery(p, "SELECT 1"), undefined, `allowed ${p}`);
  }
  assert.ok(readFileSync(CORE).equals(before), "crow.db changed");
});

test("finding 2/3: PRAGMA writes through the read path never reach the file", async () => {
  const p = makeDataset(join(DATA, "datasets", "pragma.db"));
  await qe.executeReadQuery(p, "PRAGMA user_version = 77 -- LIMIT").catch(() => {});
  assert.equal(userVersion(p), 0);
});

test("finding 3: WITH … DELETE and stacked statements are refused, nothing deleted", async () => {
  const p = makeDataset(join(DATA, "datasets", "with.db"));
  await qe.executeReadQuery(p, "WITH x AS (SELECT 1) DELETE FROM t -- LIMIT").catch(() => {});
  await qe.executeReadQuery(p, "SELECT 1; DELETE FROM t").catch(() => {});
  await assert.rejects(qe.executeReadQuery(p, "SELECT 1; DELETE FROM t"));
  await assert.rejects(qe.executeReadQuery(p, "WITH x AS (SELECT 1) DELETE FROM t"));
  assert.equal(count(p), 300);
});

test("finding 4: the row cap holds when the text mentions LIMIT", async () => {
  const p = makeDataset(join(DATA, "datasets", "cap.db"));
  const r = await qe.executeReadQuery(p, "SELECT id AS limit_col FROM t", 50);
  assert.equal(r.rows.length, 50);
  const r2 = await qe.executeReadQuery(p, "SELECT * FROM t WHERE id IN (SELECT id FROM t LIMIT 1000)", 25);
  assert.equal(r2.rows.length, 25);
  assert.equal(r2.columns.join(","), "id,v");
});

test("finding 5: a sibling directory sharing the prefix is outside", async () => {
  const p = makeDataset(join(HOME, ".crow", "data-evil", "x.db"), 3);
  await assert.rejects(qe.executeReadQuery(p, "SELECT * FROM t"));
  await assert.rejects(qe.getSchema(p));
});

test("legit datasets still read: datasets/ and projects/<id>/databases/", async () => {
  const a = makeDataset(join(DATA, "datasets", "ok.db"), 5);
  const b = makeDataset(join(DATA, "projects", "7", "databases", "ok.db"), 5);
  for (const p of [a, b]) {
    const r = await qe.executeReadQuery(p, "SELECT COUNT(*) AS n FROM t");
    assert.equal(r.rows[0].n, 5);
    const s = await qe.getSchema(p);
    assert.equal(s.tables[0].name, "t");
  }
});

test("finding 2: crow_data_write cannot touch crow.db (the tool is disabled)", async () => {
  const id = insertSqliteBackend(CORE);
  const { createDataDashboardServer } = await import("../bundles/data-dashboard/server/server.js");
  const client = await connect(await createDataDashboardServer(CORE));
  const r = await client.callTool({ name: "crow_data_write", arguments: { backend_id: id, sql: "CREATE TABLE pwned (x)" } });
  assert.ok(r.isError, text(r));
  const d = raw();
  const hit = d.prepare("SELECT name FROM sqlite_master WHERE name='pwned'").get();
  d.close();
  assert.equal(hit, undefined, "crow_data_write created a table in crow.db");
});

test("finding 2: the GIS batch geocoder cannot ALTER crow.db", async () => {
  const id = insertSqliteBackend(CORE);
  const { createNominatimServer } = await import("../bundles/nominatim/server/server.js");
  const client = await connect(createNominatimServer(CORE));
  const r = await client.callTool({ name: "crow_gis_batch_geocode", arguments: { backend_id: id, table: "memories", address_column: "content", limit: 1 } });
  assert.ok(r.isError, text(r));
  const d = raw();
  const cols = d.prepare("PRAGMA table_info(memories)").all().map((c) => c.name);
  d.close();
  assert.equal(cols.includes("lat"), false, "the geocoder added a column to crow.db");
});

test("finding 5: blog-embed-api uses the shared dataset helper, no private validator", () => {
  const src = readFileSync(join(ROOT, "servers/gateway/routes/blog-embed-api.js"), "utf8");
  assert.doesNotMatch(src, /function isPathSafe|function isReadOnlySql/);
  assert.match(src, /shared\/sqlite-datasets\.js/);
});


// ------------------------------------------------- owner approval, dashboard

async function panelPost(body) {
  const { default: panel } = await import("../servers/gateway/dashboard/panels/projects.js");
  const { createDbClient } = await import("../servers/db.js");
  let redirected = null;
  const res = { redirectAfterPost: (u) => { redirected = u; return u; } };
  await panel.handler({ method: "POST", body, query: {} }, res, { db: createDbClient(CORE), layout: (x) => x, lang: "en" });
  return redirected;
}
function pendingRow(ref) {
  const d = raw();
  try {
    return Number(d.prepare("INSERT INTO data_backends (project_id, name, backend_type, connection_ref, status) VALUES (?, 'p', 'mcp_server', ?, 'pending_approval')")
      .run(projectId(), ref).lastInsertRowid);
  } finally { d.close(); }
}
const approvedHash = (id) => { const d = raw(); try { return d.prepare("SELECT approved_ref_sha256 h FROM data_backends WHERE id=?").get(id).h; } finally { d.close(); } };

test("dashboard: approving needs the hash of the command the owner was shown", async () => {
  const { refHash } = await import("../servers/shared/data-backend-approval.js");
  const ref = markerRef(join(HOME, "never"));
  const id = pendingRow(ref);
  const u1 = await panelPost({ action: "approve_backend", id: String(projectId()), backend_id: String(id), ref_sha256: refHash("something else") });
  assert.match(u1, /error=backend_changed/);
  assert.equal(approvedHash(id), null);
  await panelPost({ action: "approve_backend", id: String(projectId()), backend_id: String(id), ref_sha256: refHash(ref) });
  assert.equal(approvedHash(id), refHash(ref));
  await panelPost({ action: "revoke_backend", id: String(projectId()), backend_id: String(id) });
  assert.equal(approvedHash(id), null);
});

test("dashboard: the approval cell shows the exact command, escaped", async () => {
  const { renderBackendApproval } = await import("../servers/gateway/dashboard/panels/projects.js");
  const html = renderBackendApproval(1, { id: 3, backend_type: "mcp_server", connection_ref: JSON.stringify({ command: "npx", args: ["<script>x</script>"], envVars: ["PG_URL"] }), approved_ref_sha256: null });
  assert.match(html, /npx &lt;script&gt;x&lt;\/script&gt;/);
  assert.match(html, /PG_URL/);
  assert.match(html, /name="action" value="approve_backend"/);
  assert.doesNotMatch(html, /<script>/);
});

// --------------------------------------------------------- more read-path

test("ATTACH and non-read statements are refused on the read path", async () => {
  const p = makeDataset(join(DATA, "datasets", "attach.db"), 1);
  await assert.rejects(qe.executeReadQuery(p, `ATTACH DATABASE '${CORE}' AS c`));
  await assert.rejects(qe.executeReadQuery(p, "PRAGMA user_version = 5"), /read-only|change|readonly/i);
  assert.equal(userVersion(p), 0);
});

test("the GIS geocoder still writes to a database the dashboard created", async () => {
  const { createManagedDatabase } = await import("../servers/shared/sqlite-datasets.js");
  const p = createManagedDatabase(projectId(), "geo");
  const d = new Database(p);
  d.exec(`CREATE TABLE "a""b" (addr TEXT)`);
  d.prepare(`INSERT INTO "a""b" VALUES ('x')`).run();
  d.close();
  const id = insertSqliteBackend(p);
  const { createNominatimServer } = await import("../bundles/nominatim/server/server.js");
  const client = await connect(createNominatimServer(CORE));
  const r = await client.callTool({ name: "crow_gis_batch_geocode", arguments: { backend_id: id, table: 'a"b', address_column: "addr", limit: 1 } });
  assert.ok(!r.isError, text(r));
  const d2 = new Database(p, { readonly: true });
  const cols = d2.prepare(`PRAGMA table_info("a""b")`).all().map((c) => c.name);
  d2.close();
  assert.deepEqual(cols, ["addr", "lat", "lon"]);
});

test("a dataset under datasets/ is not writable by the geocoder (managed folder only)", async () => {
  const p = makeDataset(join(DATA, "datasets", "nowrite.db"), 1);
  const id = insertSqliteBackend(p);
  const { createNominatimServer } = await import("../bundles/nominatim/server/server.js");
  const client = await connect(createNominatimServer(CORE));
  const r = await client.callTool({ name: "crow_gis_batch_geocode", arguments: { backend_id: id, table: "t", address_column: "v", limit: 1 } });
  assert.ok(r.isError, text(r));
});

test("migration 0008 adds the approval column once and is idempotent", async () => {
  const { run, id } = await import("../scripts/migrations/0008-data-backend-approval.mjs");
  assert.equal(id, "0008-data-backend-approval");
  const p = join(HOME, "legacy.db");
  const d = new Database(p);
  d.exec("CREATE TABLE data_backends (id INTEGER PRIMARY KEY, connection_ref TEXT)");
  d.close();
  assert.deepEqual(run({ dbPath: p }).results, ["added"]);
  assert.deepEqual(run({ dbPath: p }).results, ["no-op"]);
  const e = join(HOME, "empty.db");
  new Database(e).close();
  assert.deepEqual(run({ dbPath: e }).results, ["absent"]);
});

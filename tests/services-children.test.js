/**
 * Project services Task 14: one stdio child per connection. A scratch Crow home and data dir
 * (init-db), real connections (github, notion, obsidian from the registry) whose installed
 * add-on entry points at a fake MCP child (tests/fixtures/echo-mcp-server.mjs, run by this node):
 * never npx, uvx or a real service, never ~/.crow.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmScratch } from "./helpers/safe-rm.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(REPO, "tests", "fixtures", "echo-mcp-server.mjs");
const HOME = mkdtempSync(join(tmpdir(), "crow-svcchild-home-"));
const DATA = mkdtempSync(join(tmpdir(), "crow-svcchild-data-"));
const VAULTS = mkdtempSync(join(tmpdir(), "crow-svcchild-vaults-"));
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
delete process.env.CROW_SERVICES_UI;
execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe", cwd: REPO });

const C = await import("../servers/gateway/services/children.js");
const TC = await import("../servers/gateway/services/tool-cache.js");
const SC = await import("../servers/shared/service-connections.js");
const { createDbClient } = await import("../servers/db.js");
const { ensureWriteKey } = await import("../servers/gateway/keychain/store.js");
const { connectedServers } = await import("../servers/gateway/proxy.js");
const { servicesApiRouter } = await import("../servers/gateway/routes/services-api.js");
const { serviceById } = await import("../servers/shared/service-catalog.js");

const GH = "GITHUB_PERSONAL_ACCESS_TOKEN";
const SPAWNS = join(HOME, "spawns.log");
const SECRETS = join(HOME, "secrets");
mkdirSync(SECRETS, { recursive: true });
C._setChildrenForTest({ folder: { otherSecretsDirs: [] } });

after(async () => {
  await C.stopAllChildren();
  for (const d of [HOME, DATA, VAULTS]) rmScratch(d);
});

// ---- scratch install: installed.json, mcp-addons.json, bundle folders ------------------------

const BUNDLES = ["github", "notion", "obsidian"];
function writeInstalled(versions = {}) {
  writeFileSync(join(HOME, "installed.json"), JSON.stringify(BUNDLES.map((id) => ({ id, type: "mcp-server", version: versions[id] || "1.0.0" }))));
}
function writeAddons(extraEnv = {}) {
  const entries = {};
  for (const id of BUNDLES) {
    mkdirSync(join(HOME, "bundles", id), { recursive: true });
    entries[id] = { command: "node", args: [FIXTURE], env: { ECHO_SPAWN_LOG: SPAWNS, ...(extraEnv[id] || {}) } };
  }
  // A Crow-wide token in the shared entry must never reach a project's child.
  entries.github.env[GH] = "test-token-crowwide";
  writeFileSync(join(HOME, "mcp-addons.json"), JSON.stringify(entries), { mode: 0o600 });
}
writeInstalled();
writeAddons();

const spawnCount = () => (existsSync(SPAWNS) ? readFileSync(SPAWNS, "utf8").split("\n").filter(Boolean).length : 0);
const db = () => createDbClient();
const sha = (v) => createHash("sha256").update(v).digest("hex");

async function withDb(fn) {
  const d = db();
  try { return await fn(d); } finally { d.close(); }
}

let slugN = 0;
async function project({ archived = false } = {}) {
  return withDb(async (d) => {
    const slug = `p${++slugN}`;
    const r = await d.execute({ sql: "INSERT INTO project_spaces (slug, name) VALUES (?, ?) RETURNING id", args: [slug, slug] });
    const id = Number(r.rows[0].id);
    if (archived) await d.execute({ sql: "UPDATE project_spaces SET status = 'archived', archived_at = datetime('now') WHERE id = ?", args: [id] });
    return id;
  });
}

async function connect(serviceId, { projectId, label = "work", secrets = {}, config = {} } = {}) {
  const pid = projectId ?? (await project());
  return withDb(async (d) => {
    const key = await ensureWriteKey(d, { crowHome: HOME });
    return SC.createConnection(d, { projectId: pid, serviceId, accountLabel: label, secrets, config, testedAt: new Date() }, { key });
  });
}
const github = (token = "test-token-9", o = {}) => connect("github", { ...o, secrets: { [GH]: token } });

async function call(uuid, name, args = {}) {
  const { client } = await withDb((d) => C.ensureChild(d, uuid, { crowHome: HOME }));
  const r = await client.callTool({ name, arguments: args });
  return JSON.parse(r.content[0].text);
}

async function codeOf(p) {
  try { await p; return "ok"; } catch (err) { return err.code || String(err); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Capture console output while fn runs. */
async function capture(fn) {
  const out = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => { out.push(a.map(String).join(" ")); };
  try { await fn(); } finally { Object.assign(console, orig); }
  return out.join("\n");
}

// ---- the plan's cases ---------------------------------------------------------------------------

test("secret in env, never argv: the connection's token reaches the child's environment only; a gateway env token never does", async () => {
  process.env.BRAVE_API_KEY = "test-token-77";
  try {
    const conn = await github("test-token-9");
    const who = await call(conn.uuid, "whoami");
    assert.ok(who.keys.includes(GH), "the field is in the env");
    assert.ok(who.keys.includes("CROW_ADDON_HOST") && who.keys.includes("CROW_HOME"));
    assert.ok(!who.keys.includes("BRAVE_API_KEY"), "the gateway's own env is an allowlist (M14)");
    assert.equal(who.argc, 2, "argv is node + the fixture, nothing more");
    const h = await call(conn.uuid, "envhash", { name: GH });
    assert.equal(h.sha256, sha("test-token-9"), "the connection's token, not the Crow-wide one in mcp-addons.json");
    assert.equal((await call(conn.uuid, "envhash", { name: "CROW_ADDON_HOST" })).sha256, sha("service"));
    const cmdline = readFileSync(`/proc/${who.pid}/cmdline`, "utf8");
    assert.ok(!cmdline.includes("test-token-9") && !cmdline.includes("test-token"), "no value in argv");
    assert.deepEqual(C.childSecretValues(conn.uuid), ["test-token-9"]);
    assert.ok(!JSON.stringify(C.listChildren()).includes("test-token"), "listChildren carries no value");
  } finally {
    delete process.env.BRAVE_API_KEY;
    await C.stopAllChildren();
  }
});

test("connectionChildEnv: allowlisted base keys, CROW_* host keys, entry env minus fields, then values, then derived", () => {
  const service = serviceById("notion");
  const env = C.connectionChildEnv({
    addonEntry: { env: { NOTION_TOKEN: "test-token-old", OPENAPI_MCP_HEADERS: "stale", EXTRA: "1", CROW_ADDON_HOST: "gateway" } },
    service, secrets: { NOTION_TOKEN: "test-token-5" },
    base: { PATH: "/usr/bin", HOME: "/home/alex", XDG_RUNTIME_DIR: "/run/user/1000", https_proxy: "http://proxy.example.lan:3128", BRAVE_API_KEY: "test-token-77", CROW_DB_PATH: "/x" },
    crowHome: "/home/alex/.crow",
  });
  assert.deepEqual(Object.keys(env).sort(), ["CROW_ADDON_HOST", "CROW_HOME", "EXTRA", "HOME", "NOTION_TOKEN", "OPENAPI_MCP_HEADERS", "PATH", "XDG_RUNTIME_DIR", "https_proxy"].sort());
  assert.equal(env.CROW_ADDON_HOST, "service");
  assert.equal(env.NOTION_TOKEN, "test-token-5");
  assert.equal(env.OPENAPI_MCP_HEADERS, '{"Authorization":"Bearer test-token-5","Notion-Version":"2022-06-28"}');
});

test("derived env: a notion-shaped service's child gets OPENAPI_MCP_HEADERS rendered from its own token", async () => {
  try {
    const conn = await connect("notion", { secrets: { NOTION_TOKEN: "test-token-6" } });
    const who = await call(conn.uuid, "whoami");
    assert.ok(who.keys.includes("OPENAPI_MCP_HEADERS"));
    const h = await call(conn.uuid, "envhash", { name: "OPENAPI_MCP_HEADERS" });
    assert.equal(h.sha256, sha('{"Authorization":"Bearer test-token-6","Notion-Version":"2022-06-28"}'));
  } finally { await C.stopAllChildren(); }
});

test("lazy and idle: nothing runs before ensureChild; an idle child stops after CROW_SERVICE_CHILD_IDLE_MS", async () => {
  process.env.CROW_SERVICE_CHILD_IDLE_MS = "200";
  try {
    const before = spawnCount();
    const conn = await github();
    assert.equal(C.childState(conn.uuid), "stopped");
    assert.equal(spawnCount(), before, "connecting starts nothing");
    await withDb((d) => C.ensureChild(d, conn.uuid, { crowHome: HOME }));
    assert.equal(C.childState(conn.uuid), "running");
    assert.equal(spawnCount(), before + 1);
    await sleep(600);
    assert.equal(C.childState(conn.uuid), "stopped");
  } finally {
    delete process.env.CROW_SERVICE_CHILD_IDLE_MS;
    await C.stopAllChildren();
  }
});

test("cap: at the max the least recently used idle child stops; all busy → busy", async () => {
  process.env.CROW_SERVICE_CHILD_MAX = "2";
  try {
    const pid = await project();
    const a = await github("test-token-11", { projectId: pid, label: "a" });
    const b = await github("test-token-12", { projectId: pid, label: "b" });
    const c = await github("test-token-13", { projectId: pid, label: "c" });
    await withDb((d) => C.ensureChild(d, a.uuid, { crowHome: HOME }));
    await sleep(5);
    await withDb((d) => C.ensureChild(d, b.uuid, { crowHome: HOME }));
    await withDb((d) => C.ensureChild(d, c.uuid, { crowHome: HOME }));
    assert.equal(C.childState(a.uuid), "stopped", "a (least recently used, idle) made room");
    assert.equal(C.childState(b.uuid), "running");
    assert.equal(C.childState(c.uuid), "running");
    // Both running children busy: a fourth start is refused, nothing is spawned.
    const cb = await withDb((d) => C.ensureChild(d, b.uuid, { crowHome: HOME }));
    const cc = await withDb((d) => C.ensureChild(d, c.uuid, { crowHome: HOME }));
    const slow = [cb.client.callTool({ name: "sleep", arguments: { ms: 400 } }), cc.client.callTool({ name: "sleep", arguments: { ms: 400 } })];
    await sleep(50);
    const before = spawnCount();
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, a.uuid, { crowHome: HOME }))), "busy");
    assert.equal(spawnCount(), before);
    await Promise.all(slow);
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, a.uuid, { crowHome: HOME }))), "ok", "room again once one is idle");
  } finally {
    delete process.env.CROW_SERVICE_CHILD_MAX;
    await C.stopAllChildren();
  }
});

test("separate registry: a connection's child never enters connectedServers", async () => {
  const before = new Set(connectedServers.keys());
  try {
    const conn = await github();
    await call(conn.uuid, "whoami");
    assert.deepEqual(new Set(connectedServers.keys()), before);
    const src = readFileSync(join(REPO, "servers", "gateway", "services", "children.js"), "utf8");
    assert.ok(!/connectedServers|proxy\.js/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")), "children.js never touches the shared tool map");
  } finally { await C.stopAllChildren(); }
});

test("two concurrent ensureChild calls spawn one process (single-flight)", async () => {
  try {
    const conn = await github();
    const before = spawnCount();
    const [x, y] = await withDb((d) => Promise.all([C.ensureChild(d, conn.uuid, { crowHome: HOME }), C.ensureChild(d, conn.uuid, { crowHome: HOME })]));
    assert.equal(spawnCount(), before + 1);
    assert.equal(x.client, y.client);
  } finally { await C.stopAllChildren(); }
});

test("a child that exits 3 times is not respawned during the cooldown; recordChildFailure ran once", async () => {
  writeAddons({ github: { ECHO_EXIT: "1" } });
  try {
    const conn = await github();
    const before = spawnCount();
    for (let i = 1; i <= 3; i++) {
      assert.equal(await codeOf(withDb((d) => C.ensureChild(d, conn.uuid, { crowHome: HOME }))), "child_unavailable", `start ${i}`);
      assert.equal(spawnCount(), before + i);
    }
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, conn.uuid, { crowHome: HOME }))), "child_unavailable");
    assert.equal(spawnCount(), before + 3, "the fourth spawns nothing");
    assert.equal(C.childState(conn.uuid), "cooling");
    const row = await withDb((d) => SC.getConnection(d, conn.uuid));
    assert.equal(row.status, "error");
    assert.equal(row.lastError, "child_unavailable");
  } finally {
    writeAddons();
    await C.stopAllChildren();
  }
});

test("a child that exits while running counts toward the cooldown, and a pending call settles", async () => {
  try {
    const conn = await github();
    for (let i = 0; i < 3; i++) {
      const { client } = await withDb((d) => C.ensureChild(d, conn.uuid, { crowHome: HOME }));
      await assert.rejects(client.callTool({ name: "crash", arguments: {} }), "the call settles when its child exits");
      await sleep(50);
    }
    assert.equal(C.childState(conn.uuid), "cooling");
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, conn.uuid, { crowHome: HOME }))), "child_unavailable");
    assert.equal((await withDb((d) => SC.getConnection(d, conn.uuid))).lastError, "child_unavailable");
  } finally { await C.stopAllChildren(); }
});

test("stderr redacted (I6): the token never reaches the console; the ring buffer has [redacted]", async () => {
  writeAddons({ github: { ECHO_STDERR: "1" } });
  try {
    const conn = await github("test-token-9");
    const logs = await capture(async () => {
      await call(conn.uuid, "whoami");
      await sleep(100);
      await C.stopChild(conn.uuid);
    });
    assert.ok(!logs.includes("test-token-9"), logs);
    assert.ok(/child exited \(\d+ stderr lines\)/.test(logs), "one line per exit, the count only");
    const lines = C.childStderr(conn.uuid);
    assert.ok(lines.some((l) => l.includes("[redacted]")), JSON.stringify(lines));
    assert.ok(!lines.join("\n").includes("test-token-9"), "split across two writes, still redacted");
    assert.ok(!lines.join("\n").includes("test-token-crowwide"), "the Crow-wide token never reached it");
  } finally {
    writeAddons();
    await C.stopAllChildren();
  }
});

test("cache, no start: after one start, eight connections list tools with zero spawns; a bumped version misses", async () => {
  try {
    const pid = await project();
    const conns = [];
    for (let i = 0; i < 8; i++) conns.push(await github(`test-token-2${i}`, { projectId: pid, label: `acct${i}` }));
    await call(conns[0].uuid, "whoami");
    await C.stopAllChildren();
    const before = spawnCount();
    for (const c of conns) {
      const tools = await withDb((d) => C.listedTools(d, c.uuid, { crowHome: HOME }));
      assert.deepEqual(tools.map((t) => t.name).sort(), ["crash", "envhash", "sleep", "whoami"]);
      assert.deepEqual(Object.keys(tools[0]).sort(), ["description", "inputSchema", "name"]);
      assert.equal(C.childState(c.uuid), "stopped");
    }
    assert.equal(spawnCount(), before, "listing starts nothing");
    assert.equal(statSync(join(HOME, TC.TOOL_CACHE_FILE)).mode & 0o777, 0o600);
    writeInstalled({ github: "1.0.1" });
    assert.equal(await withDb((d) => C.listedTools(d, conns[0].uuid, { crowHome: HOME })), null, "a version change invalidates it");
    assert.equal(C.serviceTools("github", { crowHome: HOME }), null);
  } finally {
    writeInstalled();
    await C.stopAllChildren();
  }
});

// ---- carries ----------------------------------------------------------------------------------

test("key missing → child_unavailable, no spawn, the row records it", async () => {
  try {
    const conn = await github();
    const before = spawnCount();
    const logs = await capture(async () => {
      assert.equal(await codeOf(withDb((d) => C.ensureChild(d, conn.uuid, { crowHome: HOME, key: null }))), "child_unavailable");
    });
    assert.equal(spawnCount(), before, "never spawned with empty credentials");
    assert.ok(logs.includes("services: keychain key missing, child not started"));
    const row = await withDb((d) => SC.getConnection(d, conn.uuid));
    assert.equal(row.status, "error");
    assert.equal(row.lastError, "child_unavailable");
  } finally { await C.stopAllChildren(); }
});

test("a declared secret with no saved value never spawns", async () => {
  try {
    const conn = await github();
    await withDb((d) => d.execute({ sql: "DELETE FROM crow_keychain WHERE kind = 'service' AND connection_uuid = ?", args: [conn.uuid] }));
    const before = spawnCount();
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, conn.uuid, { crowHome: HOME }))), "child_unavailable");
    assert.equal(spawnCount(), before);
  } finally { await C.stopAllChildren(); }
});

test("archived project → not_active, no spawn; disconnected, needs_install and another owner → not_active", async () => {
  try {
    const pid = await project();
    const conn = await github("test-token-9", { projectId: pid });
    await withDb((d) => d.execute({ sql: "UPDATE project_spaces SET status = 'archived', archived_at = datetime('now') WHERE id = ?", args: [pid] }));
    const before = spawnCount();
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, conn.uuid, { crowHome: HOME }))), "not_active");
    assert.equal(spawnCount(), before);
    const other = await github();
    await withDb((d) => d.execute({ sql: "UPDATE service_connections SET owner_contact_id = 1 WHERE uuid = ?", args: [other.uuid] }));
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, other.uuid, { crowHome: HOME }))), "not_active");
    const paused = await github();
    await withDb((d) => SC.markConnectionsNeedInstall(d, "github"));
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, paused.uuid, { crowHome: HOME }))), "not_active");
    await withDb((d) => SC.restoreConnectionsAfterInstall(d, "github"));
    const gone = await github();
    await withDb((d) => SC.disconnectConnection(d, gone.uuid));
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, gone.uuid, { crowHome: HOME }))), "not_active");
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, "00000000-0000-4000-8000-000000000009", { crowHome: HOME }))), "not_active");
    assert.equal(spawnCount(), before);
  } finally { await C.stopAllChildren(); }
});

test("not installed: no installed record or no add-on entry → not_installed, no spawn, no cooldown", async () => {
  try {
    const conn = await github();
    writeFileSync(join(HOME, "installed.json"), JSON.stringify([{ id: "notion", version: "1.0.0" }]));
    const before = spawnCount();
    for (let i = 0; i < 4; i++) assert.equal(await codeOf(withDb((d) => C.ensureChild(d, conn.uuid, { crowHome: HOME }))), "not_installed");
    assert.equal(spawnCount(), before);
    assert.notEqual(C.childState(conn.uuid), "cooling");
  } finally {
    writeInstalled();
    await C.stopAllChildren();
  }
});

function vault(name) {
  const p = join(VAULTS, name);
  mkdirSync(join(p, ".obsidian"), { recursive: true });
  return p;
}

test("folder re-check at spawn (M4): a planted symlink inside the vault, or a root now under secrets → no spawn, last_error = the class", async () => {
  try {
    const v1 = vault("v1");
    const c1 = await connect("obsidian", { config: { OBSIDIAN_VAULT_PATH: v1 } });
    assert.equal((await call(c1.uuid, "envhash", { name: "OBSIDIAN_VAULT_PATH" })).sha256, sha(v1), "an accepted vault starts");
    await C.stopChild(c1.uuid);
    mkdirSync(join(v1, "notes"));
    symlinkSync(SECRETS, join(v1, "notes", "planted"));
    const before = spawnCount();
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, c1.uuid, { crowHome: HOME }))), "child_unavailable");
    assert.equal(spawnCount(), before);
    let row = await withDb((d) => SC.getConnection(d, c1.uuid));
    assert.equal(row.status, "error");
    assert.equal(row.lastError, "forbidden_target");

    // The root itself swapped for a link into the Crow home's secrets.
    const v2 = vault("v2");
    const c2 = await connect("obsidian", { config: { OBSIDIAN_VAULT_PATH: v2 } });
    renameSync(v2, `${v2}-moved`);
    mkdirSync(join(SECRETS, ".obsidian"), { recursive: true });
    symlinkSync(SECRETS, v2);
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, c2.uuid, { crowHome: HOME }))), "child_unavailable");
    assert.equal(spawnCount(), before);
    row = await withDb((d) => SC.getConnection(d, c2.uuid));
    assert.equal(row.lastError, "forbidden_target");

    // A Restart after the owner removes the link: the start disproves the folder error.
    unlinkSync(join(v1, "notes", "planted"));
    C.resetChildFailures(c1.uuid);
    await withDb((d) => C.ensureChild(d, c1.uuid, { crowHome: HOME, repair: true }));
    row = await withDb((d) => SC.getConnection(d, c1.uuid));
    assert.equal(row.status, "active");
    assert.equal(row.lastError, null);
  } finally { await C.stopAllChildren(); }
});

test("a repair start never revives a failed live test (auth_failed stays for Test again)", async () => {
  try {
    const conn = await github();
    await withDb((d) => SC.recordTest(d, conn.uuid, { ok: false, error: "auth_failed" }));
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, conn.uuid, { crowHome: HOME, repair: true }))), "not_active");
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, conn.uuid, { crowHome: HOME }))), "not_active");
  } finally { await C.stopAllChildren(); }
});

test("shapeServiceResult: text only, redacted across items with the child's own values, capped", async () => {
  try {
    const conn = await github("test-token-31");
    await call(conn.uuid, "whoami");
    const shaped = C.shapeServiceResult({
      content: [{ type: "text", text: "a test-tok" }, { type: "text", text: "en-31 b" }, { type: "resource", resource: { text: "test-token-31" } }],
      isError: true, _meta: { x: 1 }, structuredContent: { t: "test-token-31" },
    }, conn.uuid);
    assert.deepEqual(Object.keys(shaped).sort(), ["content", "isError"]);
    assert.ok(!JSON.stringify(shaped).includes("test-token-31") && !JSON.stringify(shaped).includes("en-31"));
    assert.ok(shaped.content[0].text.includes("[redacted]"));
    const big = C.shapeServiceResult({ content: [{ type: "text", text: "x".repeat(100) + "test-token-31" + "y".repeat(100) }] }, conn.uuid, { maxBytes: 105 });
    assert.equal(big.truncated, true);
    assert.ok(Buffer.byteLength(big.content[0].text) <= 105 && !big.content[0].text.includes("test-tok"));
  } finally { await C.stopAllChildren(); }
});

// ---- routes: disconnect, restart; uninstall -------------------------------------------------

const COOKIE = "crow_session=s1; crow_csrf=tok9";
const AUTH = { cookie: COOKIE, "x-crow-csrf": "tok9" };
const stubGate = (req, res, next) => {
  if (!String(req.headers.cookie || "").includes("crow_session=s1")) return res.status(401).json({ error: "Not authenticated" });
  req.dashboardSession = "s1";
  next();
};

async function withApi(fn) {
  const app = express();
  app.use(servicesApiRouter({
    dbFactory: () => createDbClient(), sessionGate: stubGate, installedIds: () => new Set(BUNDLES), uiEnabled: () => true,
    crowHome: HOME, reservedNames: () => new Set(), refreshMasking: () => {},
  }));
  const s = await new Promise((resolve) => { const x = app.listen(0, "127.0.0.1", () => resolve(x)); });
  try { return await fn(s); } finally { s.close(); }
}

function post(server, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, path, method: "POST", headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, text, json }); });
    });
    req.on("error", reject);
    req.end();
  });
}

test("disconnect stops the child", async () => {
  try {
    const conn = await github();
    await call(conn.uuid, "whoami");
    assert.equal(C.childState(conn.uuid), "running");
    await withApi(async (s) => {
      const r = await post(s, `/dashboard/services/api/connection/${conn.uuid}/disconnect`, AUTH);
      assert.equal(r.status, 200);
    });
    assert.equal(C.childState(conn.uuid), "stopped");
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, conn.uuid, { crowHome: HOME }))), "not_active");
  } finally { await C.stopAllChildren(); }
});

test("restart route (R8): stops, clears the cooldown, starts once; 404 for a disconnected uuid; CSRF and session required", async () => {
  writeAddons({ github: { ECHO_EXIT: "1" } });
  try {
    const conn = await github();
    for (let i = 0; i < 3; i++) await codeOf(withDb((d) => C.ensureChild(d, conn.uuid, { crowHome: HOME })));
    assert.equal(C.childState(conn.uuid), "cooling");
    writeAddons();
    await withApi(async (s) => {
      const path = `/dashboard/services/api/connection/${conn.uuid}/restart`;
      assert.equal((await post(s, path, { cookie: COOKIE })).status, 403, "no CSRF header");
      assert.equal((await post(s, path)).status, 401, "no session");
      assert.equal(C.childState(conn.uuid), "cooling", "a refused request changes nothing");
      const before = spawnCount();
      const r = await post(s, path, AUTH);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json, { ok: true, childState: "running", tools: 4 });
      assert.equal(spawnCount(), before + 1);
      const row = await withDb((d) => SC.getConnection(d, conn.uuid));
      assert.equal(row.status, "active", "the start disproved child_unavailable");
      assert.equal(row.lastError, null);
      // A failing start answers 502 with the fixed class.
      writeAddons({ github: { ECHO_EXIT: "1" } });
      const bad = await post(s, path, AUTH);
      assert.equal(bad.status, 502);
      assert.equal(bad.json.error, "child_unavailable");
      assert.ok(!bad.text.includes("test-token"));
      writeAddons();
      const gone = await github();
      await post(s, `/dashboard/services/api/connection/${gone.uuid}/disconnect`, AUTH);
      assert.equal((await post(s, `/dashboard/services/api/connection/${gone.uuid}/restart`, AUTH)).status, 404);
      assert.equal((await post(s, "/dashboard/services/api/connection/not-a-uuid/restart", AUTH)).status, 404);
    });
  } finally {
    writeAddons();
    await C.stopAllChildren();
  }
});

test("uninstall stops the bundle's children (stopChildrenForBundle, called by the uninstall job)", async () => {
  try {
    const g = await github();
    const n = await connect("notion", { secrets: { NOTION_TOKEN: "test-token-41" } });
    await call(g.uuid, "whoami");
    await call(n.uuid, "whoami");
    assert.equal(await C.stopChildrenForBundle("github"), 1);
    assert.equal(C.childState(g.uuid), "stopped");
    assert.equal(C.childState(n.uuid), "running", "other bundles' children keep running");
    const src = readFileSync(join(REPO, "servers", "gateway", "routes", "bundles.js"), "utf8");
    const job = src.slice(src.indexOf('createJob(bundle_id, "uninstall")'));
    assert.ok(job.indexOf("stopChildrenForBundle(bundle_id)") > 0 && job.indexOf("stopChildrenForBundle(bundle_id)") < job.indexOf("markBundleKeychainRemoved(bundle_id"),
      "the uninstall job stops the children before pausing the rows");
  } finally { await C.stopAllChildren(); }
});

test("settings Advanced shows each connection's child state and a Restart button, never a value", async () => {
  process.env.CROW_SERVICES_UI = "1";
  try {
    const conn = await github("test-token-51");
    await call(conn.uuid, "whoami");
    const section = (await import("../servers/gateway/dashboard/settings/sections/integrations.js")).default;
    const html = await withDb((d) => section.render({ req: {}, db: d, lang: "es" }));
    assert.ok(html.includes(`data-int-restart="${conn.uuid}"`));
    assert.ok(html.includes("Reiniciar"));
    assert.ok(html.includes("En marcha"), "the child's state, in the page language");
    assert.ok(!html.includes("test-token-51"));
    assert.ok(!html.includes("`"), "no backtick in the client script");
  } finally {
    delete process.env.CROW_SERVICES_UI;
    await C.stopAllChildren();
  }
});

test("folderRefusal scanLinks: a link around the Crow home refuses; a walk past the entry budget fails closed; off by default", async () => {
  const { folderRefusal } = await import("../servers/gateway/services/connect-test.js");
  const v = vault("v3");
  const opts = { crowHome: HOME, expectEntry: ".obsidian", otherSecretsDirs: [] };
  writeFileSync(join(v, "a.md"), "x");
  writeFileSync(join(v, "b.md"), "y");
  assert.equal(folderRefusal(v, { ...opts, scanLinks: true }), null);
  assert.equal(folderRefusal(v, { ...opts, scanLinks: true, maxScanEntries: 2 }), "forbidden_target", "fail closed");
  symlinkSync(dirname(HOME), join(v, "up"));
  assert.equal(folderRefusal(v, opts), null, "Connect and test's rule is unchanged without scanLinks");
  assert.equal(folderRefusal(v, { ...opts, scanLinks: true }), "forbidden_target", "a link to a folder holding the Crow home");
});

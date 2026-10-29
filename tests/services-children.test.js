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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync, unlinkSync } from "node:fs";
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
const SENS = await import("../servers/shared/service-sensitivity.js");
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
/** The add-on entries, plus each fixture's knobs in its folder's echo-control.json
 * (`{ECHO_EXIT: "1"}` → exit, `{ECHO_STDERR: "1"}` → stderr, `{leakSchema: true}`). */
function writeAddons(knobs = {}) {
  const entries = {};
  for (const id of BUNDLES) {
    const dir = join(HOME, "bundles", id);
    mkdirSync(dir, { recursive: true });
    const k = knobs[id] || {};
    writeFileSync(join(dir, "echo-control.json"), JSON.stringify({
      spawnLog: SPAWNS, exit: k.ECHO_EXIT === "1", stderr: k.ECHO_STDERR === "1", leakSchema: !!k.leakSchema,
    }));
    entries[id] = { command: "node", args: [FIXTURE], env: {} };
  }
  // A Crow-wide token in the shared entry, under its field name and under another name, must
  // never reach a project's child.
  entries.github.env[GH] = "test-token-crowwide";
  entries.github.env.GITHUB_TOKEN = "test-token-legacy";
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
    const c = await SC.createConnection(d, { projectId: pid, serviceId, accountLabel: label, secrets, config, testedAt: new Date() }, { key });
    // As the owner's connect route does (Task 16c): the binding and its fingerprints in the hidden dir.
    SENS.recordConnectionBinding(c, { crowHome: HOME, service: serviceById(serviceId), values: { config: c.config, secrets } });
    return c;
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
    assert.ok(!who.keys.includes("GITHUB_TOKEN"), "nothing from the add-on entry's env (m11)");
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

test("connectionChildEnv: allowlisted base keys, CROW_* host keys, then the declared fields, then derived; never the entry env", () => {
  const service = serviceById("notion");
  const env = C.connectionChildEnv({
    addonEntry: { env: { NOTION_TOKEN: "test-token-old", OPENAPI_MCP_HEADERS: "stale", EXTRA: "1", CROW_ADDON_HOST: "gateway" } },
    service, secrets: { NOTION_TOKEN: "test-token-5" },
    base: { PATH: "/usr/bin", HOME: "/home/alex", XDG_RUNTIME_DIR: "/run/user/1000", https_proxy: "http://proxy.example.lan:3128", BRAVE_API_KEY: "test-token-77", CROW_DB_PATH: "/x" },
    crowHome: "/home/alex/.crow",
  });
  assert.deepEqual(Object.keys(env).sort(), ["CROW_ADDON_HOST", "CROW_HOME", "HOME", "NOTION_TOKEN", "OPENAPI_MCP_HEADERS", "PATH", "XDG_RUNTIME_DIR", "https_proxy"].sort(),
    "the entry env (EXTRA, a stale header) contributes nothing");
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
      assert.deepEqual(tools.map((t) => t.name).sort(), ["crash", "envhash", "grandchild", "sleep", "whoami"]);
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

test("shapeServiceResult: the mount's rules, with the child's own values passed as secrets", async () => {
  try {
    const conn = await github("test-token-31");
    await call(conn.uuid, "whoami");
    const secrets = C.childSecretValues(conn.uuid);
    const shaped = C.shapeServiceResult({
      content: [{ type: "text", text: "a test-tok" }, { type: "text", text: "en-31 b" }, { type: "resource", resource: { text: "test-token-31" } },
        { type: "image", mimeType: "image/png", data: "QUJD" }, { type: "image", mimeType: "text/html", data: "QUJD" }],
      isError: true, _meta: { x: 1 }, structuredContent: { t: "test-token-31" },
    }, { secrets, tool: "whoami" });
    assert.deepEqual(Object.keys(shaped).sort(), ["content", "isError"]);
    assert.ok(!JSON.stringify(shaped).includes("test-token-31") && !JSON.stringify(shaped).includes("en-31"));
    assert.ok(shaped.content[0].text.includes("[redacted]"));
    assert.deepEqual(shaped.content[2], { type: "image", mimeType: "image/png", data: "QUJD" }, "an allowed image is kept");
    assert.equal(shaped.content[3].text, "2 item(s) of a type this connection does not return were left out.");
    const big = C.shapeServiceResult({ content: [{ type: "text", text: "x".repeat(3000) }] }, { secrets, maxBytes: 1024 });
    assert.deepEqual(big, { content: [{ type: "text", text: "Result too large (3 KiB)." }], isError: true });
    assert.deepEqual(C.shapeServiceResult(null, { tool: "whoami" }), { content: [{ type: "text", text: "whoami failed." }], isError: true });
    assert.deepEqual(C.shapeServiceResult({ code: "busy" }, { lang: "es" }), { content: [{ type: "text", text: "Ocupado, inténtalo de nuevo en un momento." }], isError: true });
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
    ownerCheck: async (_db, req) => req.dashboardSession === "s1",   // the stub gate's session is the owner's (review I1)
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
      assert.deepEqual(r.json, { ok: true, childState: "running", tools: 5 });
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

test("fix round 0: after the cooldown a child_unavailable row is retried once; success → active, failure → counts again; auth_failed never auto-retried", async () => {
  let offset = 0;
  C._setChildrenForTest({ clock: () => Date.now() + offset });
  writeAddons({ github: { ECHO_EXIT: "1" } });
  try {
    const conn = await github();
    for (let i = 0; i < 3; i++) await codeOf(withDb((d) => C.ensureChild(d, conn.uuid, { crowHome: HOME })));
    assert.equal(C.childState(conn.uuid), "cooling");
    assert.equal((await withDb((d) => SC.getConnection(d, conn.uuid))).status, "error");
    let before = spawnCount();
    offset = 4 * 60_000;
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, conn.uuid, { crowHome: HOME }))), "child_unavailable", "still refused during the cooldown");
    assert.equal(spawnCount(), before);
    // Expired, still failing: one try, it counts again (no cooldown yet), the row stays error.
    offset = 6 * 60_000;
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, conn.uuid, { crowHome: HOME }))), "child_unavailable");
    assert.equal(spawnCount(), before + 1, "retried once after the cooldown");
    assert.notEqual(C.childState(conn.uuid), "cooling");
    // Fixed upstream: the next call starts it and the row is active again.
    writeAddons();
    before = spawnCount();
    const [x, y] = await withDb((d) => Promise.all([C.ensureChild(d, conn.uuid, { crowHome: HOME }), C.ensureChild(d, conn.uuid, { crowHome: HOME })]));
    assert.equal(x.client, y.client);
    assert.equal(spawnCount(), before + 1, "single-flight retry");
    const row = await withDb((d) => SC.getConnection(d, conn.uuid));
    assert.equal(row.status, "active");
    assert.equal(row.lastError, null);

    // auth_failed (a failed live test): never auto-retried, cooldown or not.
    const bad = await github();
    await withDb((d) => SC.recordTest(d, bad.uuid, { ok: false, error: "auth_failed" }));
    offset = 60 * 60_000;
    before = spawnCount();
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, bad.uuid, { crowHome: HOME }))), "not_active");
    assert.equal(spawnCount(), before);
    // A folder refused at spawn is not auto-retried either (Restart only).
    const v = vault("v4");
    const ob = await connect("obsidian", { config: { OBSIDIAN_VAULT_PATH: v } });
    symlinkSync(SECRETS, join(v, "planted"));
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, ob.uuid, { crowHome: HOME }))), "child_unavailable");
    unlinkSync(join(v, "planted"));
    offset = 120 * 60_000;
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, ob.uuid, { crowHome: HOME }))), "not_active", "forbidden_target waits for the owner");
  } finally {
    C._setChildrenForTest({ clock: null });
    writeAddons();
    await C.stopAllChildren();
  }
});

test("fix round 0: the cap defaults to 2 and CROW_SERVICE_CHILD_MAX overrides it within 1..32", async () => {
  const prev = process.env.CROW_SERVICE_CHILD_MAX;
  try {
    delete process.env.CROW_SERVICE_CHILD_MAX;
    assert.equal(C.childLimits().maxChildren, 2);
    assert.equal(C.DEFAULT_MAX_CHILDREN, 2);
    for (const [v, want] of [["3", 3], ["1", 1], ["32", 32], ["33", 2], ["0", 2], ["-1", 2], ["2.5", 2], ["lots", 2]]) {
      process.env.CROW_SERVICE_CHILD_MAX = v;
      assert.equal(C.childLimits().maxChildren, want, `CROW_SERVICE_CHILD_MAX=${v}`);
    }
    // The override is live: with 3, three children run side by side.
    process.env.CROW_SERVICE_CHILD_MAX = "3";
    const pid = await project();
    const cs = [];
    for (const l of ["x", "y", "z"]) cs.push(await github(`test-token-6${l.charCodeAt(0) % 10}`, { projectId: pid, label: l }));
    for (const c of cs) await withDb((d) => C.ensureChild(d, c.uuid, { crowHome: HOME }));
    assert.deepEqual(cs.map((c) => C.childState(c.uuid)), ["running", "running", "running"]);
  } finally {
    if (prev === undefined) delete process.env.CROW_SERVICE_CHILD_MAX; else process.env.CROW_SERVICE_CHILD_MAX = prev;
    await C.stopAllChildren();
  }
});

test("fix round 0 (security review): the link walk follows symlinked folders, ends loops, refuses dangling links", async () => {
  const { folderRefusal } = await import("../servers/gateway/services/connect-test.js");
  const OTHER = mkdtempSync(join(tmpdir(), "crow-svcchild-other-"));
  try {
    const otherSecrets = join(OTHER, "secrets");
    mkdirSync(otherSecrets, { recursive: true });
    const opts = { crowHome: HOME, expectEntry: ".obsidian", otherSecretsDirs: [otherSecrets], scanLinks: true };

    const plain = vault("w-plain");
    mkdirSync(join(plain, "notes", "deep"), { recursive: true });
    writeFileSync(join(plain, "notes", "deep", "a.md"), "x");
    assert.equal(folderRefusal(plain, opts), null, "a normal vault with no links passes");

    // A symlinked folder (outside the vault) that holds a second link into another instance's secrets.
    const side = mkdtempSync(join(VAULTS, "side-"));
    symlinkSync(otherSecrets, join(side, "inner"));
    const viaDir = vault("w-viadir");
    symlinkSync(side, join(viaDir, "shared"));
    assert.equal(folderRefusal(viaDir, opts), "forbidden_target", "followed through the symlinked folder");

    // A loop ends, and is not refused for being a loop.
    const loop = vault("w-loop");
    mkdirSync(join(loop, "a"));
    symlinkSync(loop, join(loop, "a", "back"));
    symlinkSync(join(loop, "a"), join(loop, "self-a"));
    assert.equal(folderRefusal(loop, opts), null);
    assert.equal(folderRefusal(loop, { ...opts, maxScanEntries: 2 }), "forbidden_target", "only the budget refuses it");

    // A dangling link: fail closed.
    const dangling = vault("w-dangling");
    symlinkSync(join(VAULTS, "not-there-yet"), join(dangling, "later"));
    assert.equal(folderRefusal(dangling, opts), "forbidden_target");
  } finally {
    rmScratch(OTHER);
  }
});

// ---- fix round 1 (review) ---------------------------------------------------------------------

test("I1: the shared tool cache is sanitized with the WRITER's values: A's token never reaches what B reads", async () => {
  writeAddons({ github: { leakSchema: true } });
  try {
    const a = await github("test-token-81");
    const b = await github("test-token-82");
    await call(a.uuid, "whoami");
    await C.stopAllChildren();
    const file = readFileSync(join(HOME, TC.TOOL_CACHE_FILE), "utf8");
    assert.ok(!file.includes("test-token-81"), "the cache file never holds A's token");
    const tools = await withDb((d) => C.listedTools(d, b.uuid, { crowHome: HOME }));
    const text = JSON.stringify(tools);
    assert.ok(!text.includes("test-token-81"));
    assert.ok(!tools.some((t) => t.name.startsWith("tok_")), "a tool whose name carries the token is dropped");
    const leaky = tools.find((t) => t.name === "leaky");
    assert.ok(leaky, "the rest are kept");
    const mode = leaky.inputSchema.properties.mode;
    assert.equal(mode.default, "[redacted]");
    assert.deepEqual(mode.enum, ["plain", "[redacted]"]);
    assert.deepEqual(mode.examples, ["[redacted]"]);
    assert.equal(mode.title, "t [redacted]");
    assert.equal(leaky.description, "log in with [redacted]");
    // Fix round 2: default-deny, every string at any depth and every key.
    const props = leaky.inputSchema.properties;
    assert.equal(props.odd.pattern, "^[redacted]$");
    assert.equal(props.odd.format, "f-[redacted]");
    assert.equal(props.odd["x-crow-hint"], "h [redacted]");
    assert.ok(!Object.keys(props).some((k) => k.includes("test-token")) && Object.hasOwn(props, "k_[redacted]"), "an object key is redacted");
    assert.equal(props.list.items[0].properties.deep["x-note"][0].v, "[redacted]", "nested in an array of objects");
  } finally {
    writeAddons();
    await C.stopAllChildren();
  }
});

test("I2a: links into /proc, /sys, /dev, ~/.ssh, the app .env, or an unreadable subfolder are refused", async () => {
  const { folderRefusal, SYSTEM_GUARDED } = await import("../servers/gateway/services/connect-test.js");
  assert.deepEqual([...SYSTEM_GUARDED], ["/proc", "/sys", "/dev"]);
  const USER = mkdtempSync(join(tmpdir(), "crow-svcchild-user-"));
  try {
    mkdirSync(join(USER, ".ssh"));
    writeFileSync(join(USER, "app.env"), "X=1\n");
    const env = { HOME: USER, CROW_APP_ENV_PATH: join(USER, "app.env") };
    const opts = { crowHome: HOME, expectEntry: ".obsidian", otherSecretsDirs: [], scanLinks: true, env };
    const cases = { proc: "/proc/self/environ", sys: "/sys/kernel", dev: "/dev/null", ssh: join(USER, ".ssh"), appenv: join(USER, "app.env") };
    for (const [name, target] of Object.entries(cases)) {
      const v = vault(`g-${name}`);
      symlinkSync(target, join(v, "note.md"));
      assert.equal(folderRefusal(v, opts), "forbidden_target", name);
    }
    assert.equal(folderRefusal(vault("g-plain"), opts), null, "a plain vault still passes");
    // The Crow source dir's .env: a folder containing it is refused (path rule, file or not).
    assert.equal(folderRefusal(REPO, { ...opts, expectEntry: null, scanLinks: false }), "forbidden_target");
    // A folder holding ~/.ssh is refused even without the walk.
    assert.equal(folderRefusal(USER, { ...opts, expectEntry: null, scanLinks: false }), "forbidden_target");
    // An unreadable subfolder: fail closed.
    const locked = vault("g-locked");
    mkdirSync(join(locked, "private"));
    chmodSync(join(locked, "private"), 0o000);
    try {
      assert.equal(folderRefusal(locked, opts), "forbidden_target");
    } finally { chmodSync(join(locked, "private"), 0o700); }
  } finally { rmScratch(USER); }
});

test("I2b: a child past its max lifetime is retired at its next idle moment and respawned, which re-runs the walk", async () => {
  let offset = 0;
  C._setChildrenForTest({ clock: () => Date.now() + offset });
  try {
    // Bounds of the override.
    const prev = process.env.CROW_SERVICE_CHILD_MAX_LIFETIME_MS;
    assert.equal(C.childLimits().maxLifetimeMs, 3_600_000);
    for (const [v, want] of [["120000", 120000], ["59999", 3_600_000], ["86400001", 3_600_000], ["x", 3_600_000]]) {
      process.env.CROW_SERVICE_CHILD_MAX_LIFETIME_MS = v;
      assert.equal(C.childLimits().maxLifetimeMs, want, v);
    }
    if (prev === undefined) delete process.env.CROW_SERVICE_CHILD_MAX_LIFETIME_MS; else process.env.CROW_SERVICE_CHILD_MAX_LIFETIME_MS = prev;

    // Busy past the lifetime: kept until its call settles, then stopped; the next call respawns.
    // Expired and idle, no call: stopped at its first idle moment; the next call respawns it.
    const g = await github();
    const first = await withDb((d) => C.ensureChild(d, g.uuid, { crowHome: HOME }));
    await first.client.callTool({ name: "whoami", arguments: {} });
    offset = 61 * 60_000;
    let before = spawnCount();
    const again = await withDb((d) => C.ensureChild(d, g.uuid, { crowHome: HOME }));
    assert.notEqual(again.client, first.client, "never the expired child");
    assert.equal(spawnCount(), before + 1, "respawned on the next call");
    await C.stopAllChildren();
    offset = 0;

    // Idle past the lifetime with a link planted meanwhile: the respawn re-runs the walk.
    offset = 0;
    const v = vault("life-v");
    const ob = await connect("obsidian", { config: { OBSIDIAN_VAULT_PATH: v } });
    await withDb((d) => C.ensureChild(d, ob.uuid, { crowHome: HOME }));
    symlinkSync(SECRETS, join(v, "planted"));
    const running = await withDb((d) => C.ensureChild(d, ob.uuid, { crowHome: HOME }));
    assert.ok(running.client, "within its lifetime, the running child is served");
    offset = 61 * 60_000;
    before = spawnCount();
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, ob.uuid, { crowHome: HOME }))), "child_unavailable");
    assert.equal(spawnCount(), before, "the re-walk refused it before any spawn");
    assert.equal((await withDb((d) => SC.getConnection(d, ob.uuid))).lastError, "forbidden_target");
  } finally {
    C._setChildrenForTest({ clock: null });
    await C.stopAllChildren();
  }
});

test("m7: stopping a child reaps its whole process tree", async () => {
  try {
    const g = await github();
    const { pid } = await call(g.uuid, "grandchild");
    assert.doesNotThrow(() => process.kill(pid, 0), "the grandchild runs");
    await C.stopChild(g.uuid);
    const t = Date.now();
    let alive = true;
    while (alive && Date.now() - t < 4000) {
      try { process.kill(pid, 0); await sleep(50); } catch { alive = false; }
    }
    assert.equal(alive, false, "the grandchild is gone too");
  } finally { await C.stopAllChildren(); }
});

test("m10: a failed shared start rejects both callers with one spawn", async () => {
  writeAddons({ github: { ECHO_EXIT: "1" } });
  try {
    const g = await github();
    const before = spawnCount();
    const out = await withDb((d) => Promise.allSettled([C.ensureChild(d, g.uuid, { crowHome: HOME }), C.ensureChild(d, g.uuid, { crowHome: HOME })]));
    assert.deepEqual(out.map((o) => o.status), ["rejected", "rejected"]);
    assert.deepEqual(out.map((o) => o.reason.code), ["child_unavailable", "child_unavailable"]);
    assert.equal(spawnCount(), before + 1);
  } finally {
    writeAddons();
    await C.stopAllChildren();
  }
});

test("m10: three key-missing calls reach the cooldown, with no spawn", async () => {
  try {
    const g = await github();
    const before = spawnCount();
    for (let i = 0; i < 3; i++) assert.equal(await codeOf(withDb((d) => C.ensureChild(d, g.uuid, { crowHome: HOME, key: null }))), "child_unavailable");
    assert.equal(C.childState(g.uuid), "cooling");
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, g.uuid, { crowHome: HOME }))), "child_unavailable", "even with the key back, during the cooldown");
    assert.equal(spawnCount(), before);
  } finally { await C.stopAllChildren(); }
});

test("m3/m10: a disconnect that lands while the credentials are read aborts the spawn", async () => {
  try {
    const g = await github();
    C._setChildrenForTest({ beforeSpawn: async (uuid) => {
      if (uuid !== g.uuid) return;
      await withDb((d) => SC.disconnectConnection(d, uuid));
      await C.stopChild(uuid, { forget: true });
    } });
    const before = spawnCount();
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, g.uuid, { crowHome: HOME }))), "child_unavailable");
    assert.equal(spawnCount(), before, "never spawned with the just-disconnected credentials");
    assert.equal(C.childState(g.uuid), "stopped");
  } finally {
    C._setChildrenForTest({ beforeSpawn: null });
    await C.stopAllChildren();
  }
});

test("m12: listedTools answers only for a servable connection", async () => {
  try {
    const g = await github();
    await call(g.uuid, "whoami");
    assert.ok(await withDb((d) => C.listedTools(d, g.uuid, { crowHome: HOME })));
    await withDb((d) => SC.disconnectConnection(d, g.uuid));
    assert.equal(await withDb((d) => C.listedTools(d, g.uuid, { crowHome: HOME })), null);
  } finally { await C.stopAllChildren(); }
});

// ---- fix round 2 (security review): the lifetime is a hard ceiling --------------------------

test("fix round 2 (a): an expired child is never handed out, even busy: a fresh one starts (single-flight), or busy at the cap", async () => {
  let offset = 0;
  C._setChildrenForTest({ clock: () => Date.now() + offset });
  try {
    const g = await github();
    const first = await withDb((d) => C.ensureChild(d, g.uuid, { crowHome: HOME }));
    const slow = first.client.callTool({ name: "sleep", arguments: { ms: 400 } });
    offset = 60 * 60_000 + 30_000;   // past the lifetime, inside the grace
    const before = spawnCount();
    const [x, y] = await withDb((d) => Promise.all([C.ensureChild(d, g.uuid, { crowHome: HOME }), C.ensureChild(d, g.uuid, { crowHome: HOME })]));
    assert.notEqual(x.client, first.client, "the expired child is not reused");
    assert.equal(x.client, y.client, "one fresh start for both callers");
    assert.equal(spawnCount(), before + 1);
    assert.equal(JSON.parse((await slow).content[0].text), "slept", "the old call finishes on the retired child");
    await C.stopAllChildren();

    // At the cap, with the only slot held by a busy expired child: busy, never the expired one.
    offset = 0;
    process.env.CROW_SERVICE_CHILD_MAX = "1";
    const h = await github();
    const c1 = await withDb((d) => C.ensureChild(d, h.uuid, { crowHome: HOME }));
    const busyCall = c1.client.callTool({ name: "sleep", arguments: { ms: 400 } });
    offset = 60 * 60_000 + 30_000;
    const n = spawnCount();
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, h.uuid, { crowHome: HOME }))), "busy");
    assert.equal(spawnCount(), n);
    await busyCall;
  } finally {
    delete process.env.CROW_SERVICE_CHILD_MAX;
    C._setChildrenForTest({ clock: null });
    await C.stopAllChildren();
  }
});

test("fix round 2 (b): a long in-flight call is cut at lifetime + grace and rejects with child_unavailable", async () => {
  let offset = 0;
  C._setChildrenForTest({ clock: () => Date.now() + offset });
  try {
    const prev = process.env.CROW_SERVICE_CHILD_GRACE_MS;
    assert.equal(C.childLimits().graceMs, 60_000);
    for (const [v, want] of [["5000", 5000], ["999", 60_000], ["600001", 60_000]]) {
      process.env.CROW_SERVICE_CHILD_GRACE_MS = v;
      assert.equal(C.childLimits().graceMs, want, v);
    }
    if (prev === undefined) delete process.env.CROW_SERVICE_CHILD_GRACE_MS; else process.env.CROW_SERVICE_CHILD_GRACE_MS = prev;

    // A busy child that stays current (nobody asked for it after its lifetime).
    const g = await github();
    const { client } = await withDb((d) => C.ensureChild(d, g.uuid, { crowHome: HOME }));
    const long = client.callTool({ name: "sleep", arguments: { ms: 30_000 } });
    offset = 60 * 60_000 + 30_000;   // past the lifetime, inside the grace
    const other = await github();
    await withDb((d) => C.ensureChild(d, other.uuid, { crowHome: HOME }));   // any call checks the deadlines
    offset = 61 * 60_000 + 1000;     // past lifetime + grace
    await withDb((d) => C.ensureChild(d, other.uuid, { crowHome: HOME })).catch(() => {});
    const t0 = Date.now();
    await assert.rejects(long, (err) => err.code === "child_unavailable");
    assert.ok(Date.now() - t0 < 5000, "cut at the deadline, not left to finish");
    assert.equal(C.childState(g.uuid), "stopped");

    // A retired child (replaced while busy) is cut at its own deadline too.
    offset = 0;
    const r = await github();
    const c1 = await withDb((d) => C.ensureChild(d, r.uuid, { crowHome: HOME }));
    const stuck = c1.client.callTool({ name: "sleep", arguments: { ms: 30_000 } });
    offset = 60 * 60_000 + 1000;
    await withDb((d) => C.ensureChild(d, r.uuid, { crowHome: HOME }));        // retires c1, starts a fresh one
    offset = 61 * 60_000 + 2000;
    await withDb((d) => C.ensureChild(d, r.uuid, { crowHome: HOME })).catch(() => {});
    await assert.rejects(stuck, (err) => err.code === "child_unavailable");
  } finally {
    C._setChildrenForTest({ clock: null });
    await C.stopAllChildren();
  }
});

// ---- fix round 3 (re-review N1): the kernel's realpath, not JS's lexical ".." -----------------

test("fix round 3 (N1): <dir>/L/../secrets/keychain.key, L a link into the Crow home, is refused by folderRefusal and the spawn walk", async () => {
  const { folderRefusal } = await import("../servers/gateway/services/connect-test.js");
  mkdirSync(join(HOME, "bundles"), { recursive: true });
  await withDb((d) => ensureWriteKey(d, { crowHome: HOME }));   // the real scratch key file
  const realKey = readFileSync(join(SECRETS, "keychain.key"), "utf8");
  mkdirSync(join(SECRETS, ".obsidian"), { recursive: true });
  // `side` holds L (→ <home>/bundles, so the kernel's L/.. is <home>) and decoys at the path a
  // lexical ".." would give: <side>/secrets/keychain.key and an innocent <side>/secrets vault.
  const side = mkdtempSync(join(VAULTS, "n1-"));
  symlinkSync(join(HOME, "bundles"), join(side, "L"));
  mkdirSync(join(side, "secrets", ".obsidian"), { recursive: true });
  writeFileSync(join(side, "secrets", "keychain.key"), "decoy");
  const sneaky = `${side}/L/../secrets/keychain.key`;
  assert.equal(readFileSync(sneaky, "utf8"), realKey, "the kernel follows L first: this IS the keychain key");
  const opts = { crowHome: HOME, expectEntry: ".obsidian", otherSecretsDirs: [], scanLinks: true };

  // The walk: a vault link whose target is the sneaky path.
  const v = vault("n1-walk");
  symlinkSync(sneaky, join(v, "note.md"));
  assert.equal(folderRefusal(v, opts), "forbidden_target", "walk");
  // The root: the vault path itself in the sneaky shape.
  assert.equal(folderRefusal(`${side}/L/../secrets`, { ...opts, scanLinks: false }), "forbidden_target", "root");

  try {
    // Through the spawn re-check: neither starts a child.
    const before = spawnCount();
    const c1 = await connect("obsidian", { config: { OBSIDIAN_VAULT_PATH: v } });
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, c1.uuid, { crowHome: HOME }))), "child_unavailable");
    assert.equal((await withDb((d) => SC.getConnection(d, c1.uuid))).lastError, "forbidden_target");
    const c2 = await connect("obsidian", { config: { OBSIDIAN_VAULT_PATH: `${side}/L/../secrets` } });
    assert.equal(await codeOf(withDb((d) => C.ensureChild(d, c2.uuid, { crowHome: HOME }))), "child_unavailable");
    assert.equal((await withDb((d) => SC.getConnection(d, c2.uuid))).lastError, "forbidden_target");
    assert.equal(spawnCount(), before);
  } finally { await C.stopAllChildren(); }
});

test("fix round 3: stopChild (disconnect) also kills a RETIRED child of that uuid at once, no grace wait", async () => {
  let offset = 0;
  C._setChildrenForTest({ clock: () => Date.now() + offset });
  try {
    const g = await github();
    const first = await withDb((d) => C.ensureChild(d, g.uuid, { crowHome: HOME }));
    const { pid } = await first.client.callTool({ name: "whoami", arguments: {} }).then((r) => JSON.parse(r.content[0].text));
    const long = codeOf(first.client.callTool({ name: "sleep", arguments: { ms: 30_000 } }));
    offset = 60 * 60_000 + 10_000;   // past the lifetime, well inside the grace
    const fresh = await withDb((d) => C.ensureChild(d, g.uuid, { crowHome: HOME }));
    assert.notEqual(fresh.client, first.client, "the busy expired child was moved aside");
    await withApi(async (s) => {
      const r = await post(s, `/dashboard/services/api/connection/${g.uuid}/disconnect`, AUTH);
      assert.equal(r.status, 200);
    });
    const t0 = Date.now();
    assert.equal(await long, "child_unavailable", "the retired child's call is cut at once");
    assert.ok(Date.now() - t0 < 3000);
    let alive = true;
    while (alive && Date.now() - t0 < 4000) {
      try { process.kill(pid, 0); await sleep(50); } catch { alive = false; }
    }
    assert.equal(alive, false, "the retired child's process is gone");
    assert.equal(C.listChildren().length, 0);

    // stopAllChildren closes retiring entries too.
    offset = 0;
    const h = await github();
    const c = await withDb((d) => C.ensureChild(d, h.uuid, { crowHome: HOME }));
    const busy = codeOf(c.client.callTool({ name: "sleep", arguments: { ms: 30_000 } }));
    offset = 60 * 60_000 + 10_000;
    await withDb((d) => C.ensureChild(d, h.uuid, { crowHome: HOME }));
    await C.stopAllChildren();
    assert.equal(await busy, "child_unavailable");
  } finally {
    C._setChildrenForTest({ clock: null });
    await C.stopAllChildren();
  }
});

// ---- Task 16c fix round 1: the binding ------------------------------------------------------------

test("binding: a bot flips an obsidian row's service_id to github in crow.db → ensureChild and listedTools refuse before any spawn; a missing binding too; a correct row still works", async () => {
  const v = vault("vbind");
  const ob = await connect("obsidian", { config: { OBSIDIAN_VAULT_PATH: v } });
  await withDb((d) => d.execute({ sql: "UPDATE service_connections SET service_id = 'github', bundle_id = 'github' WHERE uuid = ?", args: [ob.uuid] }));
  const before = spawnCount();
  let err = null;
  try { await withDb((d) => C.ensureChild(d, ob.uuid, { crowHome: HOME })); } catch (e) { err = e; }
  assert.ok(err instanceof C.ChildError, "refused");
  assert.equal(err.code, "not_active");
  assert.equal(err.reason, "binding_mismatch");
  assert.equal(await withDb((d) => C.listedTools(d, ob.uuid, { crowHome: HOME })), null, "nothing listed");
  assert.equal(spawnCount(), before, "nothing spawned");
  assert.equal(C.childState(ob.uuid), "stopped");

  // A connection with no binding at all (made before bindings existed, or by a bot) is refused too.
  const gh = await withDb(async (d) => {
    const key = await ensureWriteKey(d, { crowHome: HOME });
    return SC.createConnection(d, { projectId: await project(), serviceId: "github", accountLabel: "nobind", secrets: { [GH]: "test-token-nb" }, testedAt: new Date() }, { key });
  });
  err = null;
  try { await withDb((d) => C.ensureChild(d, gh.uuid, { crowHome: HOME })); } catch (e) { err = e; }
  assert.equal(err?.reason, "binding_mismatch");
  assert.equal(spawnCount(), before);

  // Once bound with its fingerprints (as the owner's connect route would have), it starts.
  SENS.recordConnectionBinding(gh, { crowHome: HOME, service: serviceById("github"), values: { config: gh.config, secrets: { [GH]: "test-token-nb" } } });
  const ok = await withDb((d) => C.ensureChild(d, gh.uuid, { crowHome: HOME }));
  assert.ok(ok.client);
  assert.equal(spawnCount(), before + 1);
  await C.stopChild(gh.uuid);
});

// ---- Task 16c fix round 2 (review C1): fingerprints ----------------------------------------------

test("fingerprints: a notion token transplanted into an HA connection's HA_TOKEN row, or a rewritten HA_URL, is refused at spawn; a missing fingerprint is refused; a normal connection starts", async () => {
  BUNDLES.push("home-assistant");
  writeInstalled();
  writeAddons();
  try {
    const ha = await connect("home-assistant", { config: { HA_URL: "http://127.0.0.1:8123" }, secrets: { HA_TOKEN: "test-token-ha-1" } });
    const nt = await connect("notion", { secrets: { NOTION_TOKEN: "test-token-notion-9" } });
    const start = () => withDb((d) => C.ensureChild(d, ha.uuid, { crowHome: HOME }));
    const refusedAtSpawn = async (label) => {
      const before = spawnCount();
      let err = null;
      const logs = [];
      const orig = console.warn;
      console.warn = (...a) => { logs.push(a.map(String).join(" ")); };
      try { await start(); } catch (e) { err = e; } finally { console.warn = orig; }
      assert.ok(err instanceof C.ChildError, `${label}: refused`);
      assert.equal(err.code, "not_active", label);
      assert.equal(err.reason, "fingerprint_mismatch", label);
      assert.equal(spawnCount(), before, `${label}: nothing spawned`);
      assert.deepEqual(logs, ["[services] connection values changed since connect, child not started"], `${label}: one fixed line`);
      assert.ok(!logs.join("").includes("test-token"), `${label}: no value logged`);
      const row = await withDb((d) => SC.getConnection(d, ha.uuid));
      assert.equal(row.status, "active", `${label}: the row is left as it is`);
    };

    // A normal connection starts.
    const n0 = spawnCount();
    assert.ok((await start()).client);
    assert.equal(spawnCount(), n0 + 1);
    await C.stopChild(ha.uuid);

    // The transplant: notion's sealed blob into HA's HA_TOKEN row (same key id; the seal has no AAD).
    const own = await withDb(async (d) => (await d.execute({ sql: "SELECT secret_sealed, key_id FROM crow_keychain WHERE connection_uuid = ? AND env_key = 'HA_TOKEN'", args: [ha.uuid] })).rows[0]);
    await withDb((d) => d.execute({
      sql: `UPDATE crow_keychain SET secret_sealed = (SELECT secret_sealed FROM crow_keychain WHERE connection_uuid = ? AND env_key = 'NOTION_TOKEN'),
              key_id = (SELECT key_id FROM crow_keychain WHERE connection_uuid = ? AND env_key = 'NOTION_TOKEN')
            WHERE connection_uuid = ? AND env_key = 'HA_TOKEN'`,
      args: [nt.uuid, nt.uuid, ha.uuid],
    }));
    await refusedAtSpawn("transplanted token");
    await withDb((d) => d.execute({ sql: "UPDATE crow_keychain SET secret_sealed = ?, key_id = ? WHERE connection_uuid = ? AND env_key = 'HA_TOKEN'", args: [own.secret_sealed, own.key_id, ha.uuid] }));
    assert.ok((await start()).client, "the owner's own token again: starts");
    await C.stopChild(ha.uuid);

    // A rewritten address (a listener the bot controls).
    await withDb((d) => d.execute({ sql: "UPDATE service_connections SET config = ? WHERE uuid = ?", args: [JSON.stringify({ HA_URL: "http://203.0.113.9:9" }), ha.uuid] }));
    await refusedAtSpawn("rewritten HA_URL");
    await withDb((d) => d.execute({ sql: "UPDATE service_connections SET config = ? WHERE uuid = ?", args: [JSON.stringify({ HA_URL: "http://127.0.0.1:8123" }), ha.uuid] }));

    // A binding with no fingerprints (made before them, or by anything but the connect route).
    SENS.recordConnectionBinding(ha, { crowHome: HOME });
    await refusedAtSpawn("missing fingerprint");
    SENS.recordConnectionBinding(ha, { crowHome: HOME, service: serviceById("home-assistant"), values: { config: { HA_URL: "http://127.0.0.1:8123" }, secrets: { HA_TOKEN: "test-token-ha-1" } } });
    assert.ok((await start()).client, "re-recorded by the owner: starts");
    await C.stopChild(ha.uuid);

    // The fingerprint key gone (or replaced): nothing verifies.
    const keyFile = join(HOME, "secrets", SENS.FINGERPRINT_KEY_FILENAME);
    const savedKey = readFileSync(keyFile, "utf8");
    writeFileSync(keyFile, "f".repeat(64) + "\n", { mode: 0o600 });
    try { await refusedAtSpawn("another fingerprint key"); } finally { writeFileSync(keyFile, savedKey, { mode: 0o600 }); }
  } finally {
    BUNDLES.pop();
    writeInstalled();
    writeAddons();
  }
});

test("listedTools (review I2): null for a sensitive connection (notion by default) and for one switched private; a correct open one lists", async () => {
  const nt = await connect("notion", { label: "lt", secrets: { NOTION_TOKEN: "test-token-lt" } });
  assert.equal(await withDb((d) => C.listedTools(d, nt.uuid, { crowHome: HOME })), null, "notion: private by default");
  const gh = await github("test-token-lt2", { label: "lt" });
  await withDb((d) => C.ensureChild(d, gh.uuid, { crowHome: HOME }));   // fills the tool cache
  await C.stopChild(gh.uuid);
  assert.ok(await withDb((d) => C.listedTools(d, gh.uuid, { crowHome: HOME })), "github lists");
  SENS.setSensitivityOverride(gh, true, { crowHome: HOME });
  assert.equal(await withDb((d) => C.listedTools(d, gh.uuid, { crowHome: HOME })), null, "switched private: not listed");
  SENS.setSensitivityOverride(gh, false, { crowHome: HOME });
  assert.ok(await withDb((d) => C.listedTools(d, gh.uuid, { crowHome: HOME })));
});

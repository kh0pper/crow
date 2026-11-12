/**
 * Task 1.7 — the gateway spawn reader: `connectAddonServer` unseals an add-on's listed
 * `keychainEnv` names from THIS process's keychain (all or nothing), merges another add-on's
 * shared settings (R6), and keeps the wall's entry secret-free. Scratch CROW_HOME / CROW_DATA_DIR
 * and a scratch keychain; the fixture child answers env key names and value hashes only, so a
 * sentinel value never leaves this process.
 */
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { KEYCHAIN_DDL } from "../servers/gateway/keychain/schema.js";
import { createKeychainKey, keychainKeyPath } from "../servers/gateway/keychain/key.js";
import { deleteEntry, importEntries, saveExtensionSecret } from "../servers/gateway/keychain/store.js";
import { SCAN_TABLE_DDL, captureOutput, scanDb } from "./helpers/sentinel-scan.mjs";

const SENTINEL = "sentinel-" + randomUUID();
const SENTINEL2 = "sentinel-" + randomUUID();
const PLAIN = "plain-" + randomUUID();
const FIXTURE = join(import.meta.dirname, "fixtures", "echo-mcp-server.mjs");

const SCRATCH = mkdtempSync(join(tmpdir(), "crow-proxy-keychain-"));
const HOME = join(SCRATCH, "home");
const DATA = join(SCRATCH, "data");
const CWD = join(SCRATCH, "cwd");
mkdirSync(HOME, { recursive: true });
mkdirSync(DATA, { recursive: true });
mkdirSync(CWD, { recursive: true });
process.env.CROW_HOME = HOME;
process.env.HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
delete process.env.CROW_ADDON_HOST; // this process is the gateway, not a child
delete process.env.CROW_ADDON_SECRETS_KEYCHAIN;
delete process.env.FUNKWHALE_URL;
delete process.env.FUNKWHALE_ACCESS_TOKEN;

const DB_PATH = join(DATA, "crow.db");
const raw = new Database(DB_PATH);
raw.exec(KEYCHAIN_DDL);
raw.exec(SCAN_TABLE_DDL);
const KEY = createKeychainKey({ crowHome: HOME });
const KEY_PATH = keychainKeyPath(HOME);
const { ADDON_KEYS_UNREADABLE, hydrateAddonEntry } = await import("../servers/shared/addon-secrets.js");
const proxy = await import("../servers/gateway/proxy.js");
const { addonStdioEnv, connectAddonServer, connectedServers, getAddonLiveTools, reconnectAddonServer, _setProxyDepsForTest } = proxy;
const { isLegacyConfiguredAddon } = await import("../servers/gateway/services/legacy-sources.js");
const { AddonWallRefused } = await import("../scripts/addon-sandbox/spawn.mjs");

/** better-sqlite3 behind the small async libsql surface the keychain store uses. */
function keychainDb(db) {
  return {
    async execute(q) {
      const { sql, args = [] } = typeof q === "string" ? { sql: q } : q;
      const st = db.prepare(sql);
      if (st.reader) return { rows: st.all(...args) };
      const r = st.run(...args);
      return { rows: [], lastInsertRowid: r.lastInsertRowid, rowsAffected: r.changes };
    },
    async executeMultiple(sql) { db.exec(sql); },
  };
}
const db = keychainDb(raw);

/** The unseal exactly as a spawn computes it (this process registered as the gateway). */
const unsealOpts = () => ({ unsealer: "gateway", dbPath: DB_PATH, keyPath: KEY_PATH });

function writeAddons(addons) {
  writeFileSync(join(HOME, "mcp-addons.json"), JSON.stringify(addons), { mode: 0o600 });
}

async function seed(bundleId, envKey, secret) {
  return saveExtensionSecret(db, KEY, { bundleId, envKey, label: `${bundleId} ${envKey}`, secret, origin: "typed" });
}

const ENTRY = { command: "node", args: [FIXTURE], cwd: CWD, env: { DEMO_URL: "http://demo.local:8123" }, keychainEnv: ["DEMO_TOKEN"] };

async function disconnect(id) {
  const entry = connectedServers.get(id);
  try { await entry?.client?.close?.(); } catch { /* already gone */ }
  connectedServers.delete(id);
}

afterEach(async () => {
  _setProxyDepsForTest(null);
  await disconnect("demo-spawn");
  await disconnect("demo-gone");
  await disconnect("demo-sealed");
});

after(() => {
  try { raw.close(); } catch { /* already closed */ }
  rmSync(SCRATCH, { recursive: true, force: true });
});

// ---- the env a hydrated entry produces -------------------------------------

test("addonStdioEnv carries the unsealed key, not the entry's plain value", async () => {
  await seed("demo-sealed", "DEMO_TOKEN", SENTINEL);
  const hydrated = hydrateAddonEntry("demo-sealed", { ...ENTRY, env: { ...ENTRY.env, DEMO_TOKEN: PLAIN } }, unsealOpts());
  const env = addonStdioEnv(hydrated, {}, null);
  assert.equal(env.DEMO_TOKEN, SENTINEL, "the keychain value reaches the child env");
  assert.equal(env.DEMO_URL, "http://demo.local:8123");
  assert.equal(env.CROW_ADDON_HOST, "gateway");
  assert.notEqual(env.DEMO_TOKEN, PLAIN, "a plain value for a listed name is ignored");
});

test("a Render entry's derived AUTH_HEADER is rendered from the keychain value", async () => {
  await seed("render", "RENDER_API_KEY", SENTINEL2);
  const entry = { command: "node", args: ["x.js"], env: {}, keychainEnv: ["RENDER_API_KEY"] };
  const hydrated = hydrateAddonEntry("render", entry, unsealOpts());
  const env = addonStdioEnv(hydrated, {}, "render");
  assert.equal(env.AUTH_HEADER, `Bearer ${SENTINEL2}`, "derived env uses the hydrated env");
});

// ---- keys that cannot be read stop the add-on (0.4) -----------------------

test("a listed name with no keychain row refuses the spawn: no transport, status error, the fixed sentence", async (t) => {
  const out = captureOutput(t);
  await seed("demo-gone", "DEMO_TOKEN", SENTINEL); // not the row we ask for
  const transports = [];
  const reported = [];
  _setProxyDepsForTest({
    createStdioTransport: (o) => { transports.push(o); throw new Error("must not be created"); },
    reportAddonKeysUnreadable: async (id, err) => { reported.push([id, err]); },
  });

  writeAddons({ "demo-gone": { ...ENTRY, keychainEnv: ["DEMO_TOKEN", "DEMO_NOPE"] } });
  const r = await connectAddonServer("demo-gone", { ...ENTRY, keychainEnv: ["DEMO_TOKEN", "DEMO_NOPE"] });

  assert.equal(r, null);
  assert.deepEqual(transports, [], "no transport was created");
  const entry = connectedServers.get("demo-gone");
  assert.equal(entry.client, null);
  assert.equal(entry.status, "error");
  assert.equal(entry.error, ADDON_KEYS_UNREADABLE);
  assert.equal(entry.isAddon, true);
  assert.deepEqual(entry.keysUnreadable, ["DEMO_TOKEN", "DEMO_NOPE"]);
  assert.equal(reported.length, 1, "the PR3 card reporter was told");
  assert.equal(reported[0][0], "demo-gone");
  const text = out.text();
  assert.match(text, /demo-gone/, "the console line names the add-on id");
  assert.match(text, /DEMO_NOPE/, "and the key names");
  assert.equal(text.split(SENTINEL).length - 1, 0, "never a value");
});

// ---- the wall sees the stored entry, the child sees the secret ------------

test("a walled spawn hands the wall the stored entry (no secret, keychainEnv kept) and its child env the key", async (t) => {
  captureOutput(t);
  await seed("demo-sealed", "DEMO_TOKEN", SENTINEL);
  const built = [];
  const warmed = [];
  _setProxyDepsForTest({
    addonWallMode: () => ({ mode: "walled", reason: null, source: "walled" }),
    warmAddon: async (o) => { warmed.push(o); return { ok: true }; },
    startAddonWall: async (o) => { built.push(o); throw new AddonWallRefused("stop here"); },
  });

  await connectAddonServer("demo-sealed", ENTRY);

  assert.equal(warmed.length, 1);
  assert.equal(JSON.stringify(warmed[0].entry).includes(SENTINEL), false, "the prepare run's entry is secret-free");
  assert.equal(built.length, 1);
  const wall = built[0];
  assert.equal(JSON.stringify(wall.entry).includes(SENTINEL), false, "a secret never travels in the entry");
  assert.deepEqual(wall.entry.keychainEnv, ["DEMO_TOKEN"], "the stored list is preserved");
  assert.equal(wall.entry.env.DEMO_TOKEN, undefined, "and the stored env holds no plain value");
  assert.equal(wall.ownEnv.DEMO_TOKEN, SENTINEL, "only the child env carries it");
  assert.equal(connectedServers.get("demo-sealed").status, "error", "the refused wall leaves it off");
});

// ---- predicates and the live getter --------------------------------------

test("isLegacyConfiguredAddon: a service field listed in keychainEnv counts as set, without unsealing", () => {
  assert.equal(isLegacyConfiguredAddon("render", { env: {}, keychainEnv: ["RENDER_API_KEY"] }, undefined, {}), true);
  assert.equal(isLegacyConfiguredAddon("render", { env: {} }, undefined, {}), false);
  assert.equal(isLegacyConfiguredAddon("home-assistant", { env: { HA_URL: "http://ha.example" }, keychainEnv: ["HA_TOKEN"] }, undefined, {}), true);
});

test("getAddonLiveTools exposes only status and tools (task 1.9's live reuse)", async () => {
  connectedServers.set("demo-live", { client: {}, tools: [{ name: "a" }], status: "connected", isAddon: true, secret: SENTINEL });
  try {
    const live = getAddonLiveTools("demo-live");
    assert.deepEqual(live, { status: "connected", tools: [{ name: "a" }] });
    assert.equal(JSON.stringify(live).includes(SENTINEL), false);
    assert.equal(getAddonLiveTools("nope"), null);
  } finally {
    connectedServers.delete("demo-live");
  }
});

// ---- R6: another add-on's shared settings --------------------------------

test("sunvox-studio's child env takes Funkwhale's URL and keychain token; the share table's other setting takes neither", async (t) => {
  captureOutput(t);
  await seed("funkwhale", "FUNKWHALE_ACCESS_TOKEN", SENTINEL2);
  const funkwhale = { command: "node", args: ["x.js"], env: { FUNKWHALE_URL: "http://funkwhale.local" }, keychainEnv: ["FUNKWHALE_ACCESS_TOKEN"] };
  writeAddons({ funkwhale, "sunvox-studio": { command: "node", args: ["y.js"] } });

  const run = async (deps) => {
    const built = [];
    _setProxyDepsForTest({
      addonWallMode: () => ({ mode: "walled", reason: null, source: "walled" }),
      warmAddon: async () => ({ ok: true }),
      startAddonWall: async (o) => { built.push(o); throw new AddonWallRefused("stop"); },
      ...deps,
    });
    await connectAddonServer("sunvox-studio", { command: "node", args: ["y.js"] });
    return built[0];
  };

  const shared = await run({});
  assert.equal(shared.ownEnv.FUNKWHALE_ACCESS_TOKEN, SENTINEL2, "the share reaches the child env");
  assert.equal(shared.ownEnv.FUNKWHALE_URL, "http://funkwhale.local");
  assert.equal(JSON.stringify(shared.entry).includes(SENTINEL2), false, "never in the entry");

  const off = await run({ addonSecretShares: {} });
  assert.equal("FUNKWHALE_ACCESS_TOKEN" in off.ownEnv, false, "the switch at its other setting shares nothing");
  assert.equal("FUNKWHALE_URL" in off.ownEnv, false);
});

// ---- a real spawn: connect, delete in Settings, import, reconnect ---------

test("a key deleted in Settings refuses the next spawn; importing it again lets a reconnect finish", async (t) => {
  const out = captureOutput(t);
  await seed("demo-spawn", "DEMO_TOKEN", SENTINEL);
  writeAddons({ "demo-spawn": { ...ENTRY, keychainEnv: ["DEMO_TOKEN"] } });

  const first = await connectAddonServer("demo-spawn", { ...ENTRY, keychainEnv: ["DEMO_TOKEN"] });
  assert.ok(first, "the add-on connected");
  assert.equal(connectedServers.get("demo-spawn").status, "connected");
  const list = await first.client.callTool({ name: "whoami", arguments: {} });
  const info = JSON.parse(list.content[0].text);
  assert.ok(info.keys.includes("DEMO_TOKEN"), "the child's env carries the listed key");
  const hashed = await first.client.callTool({ name: "envhash", arguments: { name: "DEMO_TOKEN" } });
  const hash = JSON.parse(hashed.content[0].text).sha256;
  assert.equal(hash, createHash("sha256").update(SENTINEL).digest("hex"), "and its value is the keychain's");

  const rows = await db.execute({ sql: "SELECT id FROM crow_keychain WHERE kind = 'extension' AND bundle_id = ? AND env_key = ?", args: ["demo-spawn", "DEMO_TOKEN"] });
  assert.equal(await deleteEntry(db, rows.rows[0].id), true, "the owner deleted the row in Settings");

  const refused = await reconnectAddonServer("demo-spawn");
  assert.equal(refused.ok, false);
  assert.equal(refused.status, "error");
  assert.equal(connectedServers.get("demo-spawn").error, ADDON_KEYS_UNREADABLE, "fail closed, never a key-less spawn");

  const imported = await importEntries(db, KEY, [{
    kind: "extension", bundle_id: "demo-spawn", env_key: "DEMO_TOKEN", label: "demo-spawn DEMO_TOKEN",
    origin: "typed", status: "active", secret: SENTINEL,
  }]);
  assert.equal(imported.imported, 1, "the keychain import restored the row");

  const again = await reconnectAddonServer("demo-spawn");
  assert.equal(again.ok, true, "reconnect connects again");
  assert.equal(connectedServers.get("demo-spawn").status, "connected");

  const text = out.text();
  assert.equal(text.split(SENTINEL).length - 1, 0, "no console line carries a value");
  assert.deepEqual(scanDb(DB_PATH, SENTINEL), [], "no audit row or bell carries a value");
});
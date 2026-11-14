import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
/** A value distinctive enough that its presence in mcp-addons.json is unmistakable. */
const SECRET = "sentinel-" + randomUUID();

// bundles.js resolves BUNDLES_DIR/INSTALLED_PATH/MCP_ADDONS_PATH from CROW_HOME at
// module load. Point it at a scratch dir BEFORE importing it — even though this
// test always passes an explicit `path` to applyEnvToMcpAddons (so it should never
// touch MCP_ADDONS_PATH), the import itself must not resolve into the operator's
// real ~/.crow. See bundles-install-job.test.js / bundles-auth-bypass.test.js for
// the live incident this pattern guards against.
process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-test-home-"));
// resolveDataDir() (servers/db.js) ignores CROW_HOME — without this the
// router's DB client opens the run's shared data dir (absent in a single-file
// `npm test` run → "Cannot open database because the directory does not
// exist") or, under a raw node --test, the LIVE ~/.crow/data/crow.db.
process.env.CROW_DATA_DIR = join(process.env.CROW_HOME, "data");
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });
// Sealing is ON by default, so a save writes keychain rows into THIS scratch
// data dir and mints its key under the scratch home: the schema has to exist.
execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe", cwd: REPO });
const { applyEnvToMcpAddons, findInvalidEnv } = await import("../servers/gateway/routes/bundles.js");
// applyEnvToMcpAddons seals (async) and refuses to run un-locked (0.6.1), so every call
// below goes through the add-on's lock.
const { withAddonLock } = await import("../servers/gateway/addon-secrets-seal.js");
const { hydrateAddonEntry } = await import("../servers/shared/addon-secrets.js");
const { gatewayKeychainPaths } = await import("../servers/gateway/addon-keys-paths.js");
const applyEnv = (id, ...args) => withAddonLock(id, () => applyEnvToMcpAddons(id, ...args));

/** The spawn-time env of the entry at `path` — the SEALED values come back from the keychain. */
const spawnEnv = (id, path) => hydrateAddonEntry(id, JSON.parse(readFileSync(path, "utf8"))[id], { unsealer: "gateway", ...gatewayKeychainPaths() })?.env || {};

/** Run `fn` with the sealing switch at `on` (off is the operator's explicit "0"). */
async function withSealing(on, fn) {
  const before = process.env.CROW_ADDON_SECRETS_KEYCHAIN;
  process.env.CROW_ADDON_SECRETS_KEYCHAIN = on ? "1" : "0";
  try { return await fn(); } finally {
    if (before === undefined) delete process.env.CROW_ADDON_SECRETS_KEYCHAIN;
    else process.env.CROW_ADDON_SECRETS_KEYCHAIN = before;
  }
}

test("configuring an mcp-server add-on's env updates mcp-addons.json (the file the MCP child actually reads): the secret is SEALED, the rest stays plain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crowmcp-"));
  const path = join(dir, "mcp-addons.json");
  writeFileSync(path, JSON.stringify({
    "home-assistant": { command: "node", args: ["server/index.js"], env: { HA_URL: "" } },
  }));

  const wrote = await applyEnv("home-assistant", { HA_URL: "http://homeassistant.local:8123", HA_TOKEN: SECRET }, path);
  assert.equal(wrote, true);

  const text = readFileSync(path, "utf8");
  const after = JSON.parse(text);
  assert.equal(after["home-assistant"].env.HA_URL, "http://homeassistant.local:8123");
  assert.equal(text.includes(SECRET), false, "a secret value never lands in mcp-addons.json");
  assert.ok(!("HA_TOKEN" in after["home-assistant"].env), "the entry holds no plain value for a sealed name");
  assert.deepEqual(after["home-assistant"].keychainEnv, ["HA_TOKEN"], "the entry names it instead");
  assert.equal(spawnEnv("home-assistant", path).HA_TOKEN, SECRET, "the keychain holds the value the child will get");
  assert.equal(after["home-assistant"].command, "node", "existing config fields survive");
});

test("an empty-string value is skipped — a blank must never land in the MCP env block (it would SHADOW an inherited process.env value at spawn, not clear it)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crowmcp-"));
  const path = join(dir, "mcp-addons.json");
  const EXISTING = "sentinel-existing-" + randomUUID();
  writeFileSync(path, JSON.stringify({
    "home-assistant": { command: "node", env: { HA_TOKEN: EXISTING } },
  }));

  await applyEnv("home-assistant", { HA_TOKEN: "" }, path);

  const text = readFileSync(path, "utf8");
  assert.equal(text.includes(EXISTING), false, "the value the save did not touch is sealed, not left plain");
  assert.equal(spawnEnv("home-assistant", path).HA_TOKEN, EXISTING, "blank must not overwrite — proxy.js spawns with { ...process.env, ...config.env }, so \"\" would shadow a working ambient value");
});

test("an existing env key not mentioned in the update survives the merge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crowmcp-"));
  const path = join(dir, "mcp-addons.json");
  writeFileSync(path, JSON.stringify({
    "home-assistant": { command: "node", env: { HA_URL: "http://ha.local:8123", HA_VERIFY_SSL: "false" } },
  }));

  const wrote = await applyEnv("home-assistant", { HA_TOKEN: SECRET }, path);
  assert.equal(wrote, true);

  const after = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(after["home-assistant"].env.HA_VERIFY_SSL, "false", "untouched existing env key survives");
  assert.equal(after["home-assistant"].env.HA_URL, "http://ha.local:8123");
  assert.deepEqual(after["home-assistant"].keychainEnv, ["HA_TOKEN"]);
  assert.equal(spawnEnv("home-assistant", path).HA_TOKEN, SECRET);
  assert.equal(readFileSync(path, "utf8").includes(SECRET), false, "the secret itself stays out of the file");
});

test("an add-on with no MCP server registration is a no-op (returns false)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crowmcp-"));
  const path = join(dir, "mcp-addons.json");
  writeFileSync(path, JSON.stringify({}));
  assert.equal(await applyEnv("jellyfin", { JELLYFIN_API_KEY: "x" }, path), false);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {});
});

test("a save scrubs loader names already sitting in an entry's env, keeping every other key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crowmcp-"));
  const path = join(dir, "mcp-addons.json");
  // An entry written before the loader rule (or hand-edited): it already carries both names.
  writeFileSync(path, JSON.stringify({
    "home-assistant": {
      command: "node",
      args: ["server/index.js"],
      env: { LD_PRELOAD: "/x.so", NODE_OPTIONS: "--require /x.js", HA_URL: "http://ha.local:8123" },
    },
  }));

  const wrote = await applyEnv("home-assistant", { HA_TOKEN: SECRET }, path);
  assert.equal(wrote, true);

  const text = readFileSync(path, "utf8");
  const entry = JSON.parse(text)["home-assistant"];
  assert.ok(!("LD_PRELOAD" in entry.env), "LD_PRELOAD must not survive a save");
  assert.ok(!("NODE_OPTIONS" in entry.env), "NODE_OPTIONS must not survive a save");
  assert.equal(entry.env.HA_URL, "http://ha.local:8123", "an unrelated key survives the scrub");
  assert.equal(text.includes(SECRET), false, "the key just saved goes to the keychain, not the file");
  assert.deepEqual(entry.keychainEnv, ["HA_TOKEN"], "the key just saved is listed by name");
  assert.equal(spawnEnv("home-assistant", path).HA_TOKEN, SECRET, "and the key just saved is the value the child gets");
  assert.equal(entry.command, "node", "existing config fields survive");
});

test("sealing off (CROW_ADDON_SECRETS_KEYCHAIN=0): the old plain shape, and no keychain row for the new value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crowmcp-"));
  const path = join(dir, "mcp-addons.json");
  writeFileSync(path, JSON.stringify({
    "home-assistant": { command: "node", args: ["server/index.js"], env: { HA_URL: "http://ha.local:8123" }, keychainEnv: ["HA_TOKEN"] },
  }));

  await withSealing(false, () => applyEnv("home-assistant", { HA_TOKEN: SECRET }, path));

  const entry = JSON.parse(readFileSync(path, "utf8"))["home-assistant"];
  assert.equal(entry.env.HA_TOKEN, SECRET, "the operator opted out: the value the owner typed is used, plain");
  assert.equal("keychainEnv" in entry, false, "and the name it was listed under is dropped (0.3 row 4)");
  assert.equal(entry.env.HA_URL, "http://ha.local:8123");
});

test("findInvalidEnv refuses a loader/injection name and leaves ordinary names alone", () => {
  for (const k of ["NODE_OPTIONS", "LD_PRELOAD", "PYTHONSTARTUP", "DYLD_INSERT_LIBRARIES"]) {
    const r = findInvalidEnv({ [k]: "x" });
    assert.equal(r?.key, k, k);
    assert.match(r.why, /loader/i);
  }
  assert.equal(findInvalidEnv({ LD_PRELOAD: "/x.so" })?.key, "LD_PRELOAD");
  assert.equal(findInvalidEnv({ NODE_OPTIONS: "--require /x.js" })?.key, "NODE_OPTIONS");
  assert.equal(findInvalidEnv({ HA_URL: "http://h" }), null, "an ordinary name stays valid");
  assert.equal(findInvalidEnv({ HA_URL: "http://h", MY_PATH: "/data" }), null);
});

test("applyEnvToMcpAddons never copies a loader name into an entry (defence in depth, no gate upstream)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crowmcp-"));
  const path = join(dir, "mcp-addons.json");
  writeFileSync(path, JSON.stringify({
    "home-assistant": { command: "node", args: ["server/index.js"], env: { HA_URL: "http://ha.local:8123" } },
  }));

  const wrote = await applyEnv("home-assistant", {
    NODE_OPTIONS: "--require /x.js",
    LD_PRELOAD: "/x.so",
    FOO: "bar",
  }, path, null, { edited: ["NODE_OPTIONS", "LD_PRELOAD", "FOO"], owner: true });
  assert.equal(wrote, true);

  const after = JSON.parse(readFileSync(path, "utf8"));
  const entry = after["home-assistant"];
  assert.equal(entry.env.FOO, "bar");
  assert.equal(entry.env.HA_URL, "http://ha.local:8123", "an untouched key survives");
  assert.ok(!("NODE_OPTIONS" in entry.env), "NODE_OPTIONS must not reach the MCP child's env");
  assert.ok(!("LD_PRELOAD" in entry.env), "LD_PRELOAD must not reach the MCP child's env");
  assert.deepEqual(entry.ownerSet, ["FOO"], "a skipped key is not written, so it earns no owner claim");
});

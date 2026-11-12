import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const { applyEnvToMcpAddons, findInvalidEnv } = await import("../servers/gateway/routes/bundles.js");

test("configuring an mcp-server add-on's env updates mcp-addons.json (the file the MCP child actually reads)", () => {
  const dir = mkdtempSync(join(tmpdir(), "crowmcp-"));
  const path = join(dir, "mcp-addons.json");
  writeFileSync(path, JSON.stringify({
    "home-assistant": { command: "node", args: ["server/index.js"], env: { HA_URL: "" } },
  }));

  const wrote = applyEnvToMcpAddons("home-assistant", { HA_URL: "http://homeassistant.local:8123", HA_TOKEN: "tok" }, path);
  assert.equal(wrote, true);

  const after = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(after["home-assistant"].env.HA_URL, "http://homeassistant.local:8123");
  assert.equal(after["home-assistant"].env.HA_TOKEN, "tok");
  assert.equal(after["home-assistant"].command, "node", "existing config fields survive");
});

test("an empty-string value is skipped — a blank must never land in the MCP env block (it would SHADOW an inherited process.env value at spawn, not clear it)", () => {
  const dir = mkdtempSync(join(tmpdir(), "crowmcp-"));
  const path = join(dir, "mcp-addons.json");
  writeFileSync(path, JSON.stringify({
    "home-assistant": { command: "node", env: { HA_TOKEN: "existing" } },
  }));

  applyEnvToMcpAddons("home-assistant", { HA_TOKEN: "" }, path);

  const after = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(after["home-assistant"].env.HA_TOKEN, "existing", "blank must not overwrite — proxy.js spawns with { ...process.env, ...config.env }, so \"\" would shadow a working ambient value");
});

test("an existing env key not mentioned in the update survives the merge", () => {
  const dir = mkdtempSync(join(tmpdir(), "crowmcp-"));
  const path = join(dir, "mcp-addons.json");
  writeFileSync(path, JSON.stringify({
    "home-assistant": { command: "node", env: { HA_URL: "http://ha.local:8123", HA_VERIFY_SSL: "false" } },
  }));

  const wrote = applyEnvToMcpAddons("home-assistant", { HA_TOKEN: "tok" }, path);
  assert.equal(wrote, true);

  const after = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(after["home-assistant"].env.HA_VERIFY_SSL, "false", "untouched existing env key survives");
  assert.equal(after["home-assistant"].env.HA_URL, "http://ha.local:8123");
  assert.equal(after["home-assistant"].env.HA_TOKEN, "tok");
});

test("an add-on with no MCP server registration is a no-op (returns false)", () => {
  const dir = mkdtempSync(join(tmpdir(), "crowmcp-"));
  const path = join(dir, "mcp-addons.json");
  writeFileSync(path, JSON.stringify({}));
  assert.equal(applyEnvToMcpAddons("jellyfin", { JELLYFIN_API_KEY: "x" }, path), false);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {});
});

test("a save scrubs loader names already sitting in an entry's env, keeping every other key", () => {
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

  const wrote = applyEnvToMcpAddons("home-assistant", { HA_TOKEN: "tok" }, path);
  assert.equal(wrote, true);

  const after = JSON.parse(readFileSync(path, "utf8"));
  const entry = after["home-assistant"];
  assert.ok(!("LD_PRELOAD" in entry.env), "LD_PRELOAD must not survive a save");
  assert.ok(!("NODE_OPTIONS" in entry.env), "NODE_OPTIONS must not survive a save");
  assert.equal(entry.env.HA_URL, "http://ha.local:8123", "an unrelated key survives the scrub");
  assert.equal(entry.env.HA_TOKEN, "tok", "the key just saved lands");
  assert.equal(entry.command, "node", "existing config fields survive");
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

test("applyEnvToMcpAddons never copies a loader name into an entry (defence in depth, no gate upstream)", () => {
  const dir = mkdtempSync(join(tmpdir(), "crowmcp-"));
  const path = join(dir, "mcp-addons.json");
  writeFileSync(path, JSON.stringify({
    "home-assistant": { command: "node", args: ["server/index.js"], env: { HA_URL: "http://ha.local:8123" } },
  }));

  const wrote = applyEnvToMcpAddons("home-assistant", {
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

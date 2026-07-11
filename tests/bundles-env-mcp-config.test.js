import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// bundles.js resolves BUNDLES_DIR/INSTALLED_PATH/MCP_ADDONS_PATH from CROW_HOME at
// module load. Point it at a scratch dir BEFORE importing it — even though this
// test always passes an explicit `path` to applyEnvToMcpAddons (so it should never
// touch MCP_ADDONS_PATH), the import itself must not resolve into the operator's
// real ~/.crow. See bundles-install-job.test.js / bundles-auth-bypass.test.js for
// the live incident this pattern guards against.
process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-test-home-"));
const { applyEnvToMcpAddons } = await import("../servers/gateway/routes/bundles.js");

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

test("an add-on with no MCP server registration is a no-op (returns false)", () => {
  const dir = mkdtempSync(join(tmpdir(), "crowmcp-"));
  const path = join(dir, "mcp-addons.json");
  writeFileSync(path, JSON.stringify({}));
  assert.equal(applyEnvToMcpAddons("jellyfin", { JELLYFIN_API_KEY: "x" }, path), false);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {});
});

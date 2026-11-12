/**
 * `CROW_LOCAL_INSTANCE_ID` in an add-on child's environment (servers/gateway/proxy.js).
 *
 * Inside its wall a child sees `<data dir>/instance-id` as a masked /dev/null char
 * device — existsSync() is true, readFileSync() throws — so it cannot read the id
 * its per-instance settings rows (dashboard_settings_overrides.key/instance_id) are
 * keyed by. The gateway hands it over instead: its own id, set last, from the
 * gateway only. A child that cannot get it gets no such key at all (never a
 * minted one, and never one an add-on's own entry supplies, which would let an
 * add-on claim another instance's settings).
 *
 * The wall is simulated with a directory named instance-id (readFileSync gives
 * EISDIR, the same "present but unreadable" shape).
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { addonOwnEnv, addonStdioEnv } = await import("../servers/gateway/proxy.js");
const { wallChildEnv } = await import("../scripts/addon-sandbox/wall-env.mjs");

/** The gateway's own instance id (32 hex), and one an add-on might try to pass off as it. */
const GATEWAY_ID = "0123456789abcdef0123456789abcdef";
const OTHER_ID = "fedcba9876543210fedcba9876543210";

const SAVED = {
  CROW_HOME: process.env.CROW_HOME,
  CROW_DATA_DIR: process.env.CROW_DATA_DIR,
  CROW_LOCAL_INSTANCE_ID: process.env.CROW_LOCAL_INSTANCE_ID,
};
const roots = [];

function setEnvId(id) {
  if (id === undefined) delete process.env.CROW_LOCAL_INSTANCE_ID;
  else process.env.CROW_LOCAL_INSTANCE_ID = id;
}

/** A scratch instance whose id file is readable, or masked (a directory), or absent. */
function instance({ unreadable = false, absent = false, envId = undefined } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "crow-addon-instance-id-"));
  roots.push(dir);
  if (unreadable) mkdirSync(join(dir, "instance-id"));
  else if (!absent) writeFileSync(join(dir, "instance-id"), GATEWAY_ID);
  process.env.CROW_HOME = join(dir, "home");
  process.env.CROW_DATA_DIR = dir;
  setEnvId(envId);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setEnvId(SAVED.CROW_LOCAL_INSTANCE_ID);
});

test("both env builders carry the gateway's own instance id", () => {
  instance();
  const base = { PATH: "/usr/bin" };
  assert.equal(addonStdioEnv({ env: { OWN: "1" } }, base, "media").CROW_LOCAL_INSTANCE_ID, GATEWAY_ID);
  assert.equal(addonOwnEnv({ env: { OWN: "1" } }, base, "media").CROW_LOCAL_INSTANCE_ID, GATEWAY_ID);
  assert.equal(addonStdioEnv({}, base, null).CROW_LOCAL_INSTANCE_ID, GATEWAY_ID, "an add-on with no id still gets it");
  // It is the id in the file, and the host marker is not disturbed.
  assert.match(addonStdioEnv({}, base, "media").CROW_LOCAL_INSTANCE_ID, /^[0-9a-f]{32}$/);
  assert.equal(addonStdioEnv({}, base, "media").CROW_ADDON_HOST, "gateway");
});

test("an add-on's own env cannot set or override the id (it is applied last)", () => {
  instance();
  const own = { env: { CROW_LOCAL_INSTANCE_ID: OTHER_ID } };
  assert.equal(addonStdioEnv(own, {}, "media").CROW_LOCAL_INSTANCE_ID, GATEWAY_ID);
  assert.equal(addonOwnEnv(own, {}, "media").CROW_LOCAL_INSTANCE_ID, GATEWAY_ID);
});

test("an id the gateway cannot read is omitted, and the add-on's own value does not fill in", () => {
  instance({ unreadable: true });   // masked: present, readFileSync throws
  const withOwn = { env: { CROW_LOCAL_INSTANCE_ID: OTHER_ID } };
  for (const [name, env] of [
    ["addonStdioEnv", addonStdioEnv(withOwn, {}, "media")],
    ["addonOwnEnv", addonOwnEnv(withOwn, {}, "media")],
  ]) {
    assert.equal("CROW_LOCAL_INSTANCE_ID" in env, false, `${name}: the key must be absent, not the add-on's`);
    assert.equal(env.CROW_ADDON_HOST, "gateway", `${name}: the rest of the env is unaffected`);
  }
  assert.equal("CROW_LOCAL_INSTANCE_ID" in addonStdioEnv({}, {}, null), false, "and with no own env either");
});

test("the wall's own env build passes the key through unchanged", () => {
  instance();
  const ownEnv = addonOwnEnv({ env: { OWN: "1" } }, {}, "media");
  const env = wallChildEnv({ id: "media", kind: "addon", baseEnv: {}, ownEnv, credentialKeys: [] });
  assert.equal(env.CROW_LOCAL_INSTANCE_ID, GATEWAY_ID);
  assert.equal(env.CROW_ADDON_HOST, "gateway");
  // The wall never invents one either.
  const other = wallChildEnv({ id: "media", kind: "addon", baseEnv: {}, ownEnv: {}, credentialKeys: [] });
  assert.equal("CROW_LOCAL_INSTANCE_ID" in other, false);
});
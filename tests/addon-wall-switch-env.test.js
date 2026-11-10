/**
 * The add-on wall switches (CROW_ADDON_WALLS, CROW_ADDON_WALLS_DEFAULT) are the
 * operator's, read from the gateway's unit environment only. A bundle manifest
 * that declares one cannot write it into the gateway's .env (install and
 * Configure both go through the same denylist), and a switch found in the .env
 * at boot is dropped before anything reads it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmScratch } from "./helpers/safe-rm.js";

const HOME = mkdtempSync(join(tmpdir(), "addon-wall-switch-"));
const DATA = join(HOME, "data");
mkdirSync(DATA, { recursive: true });
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
delete process.env.CROW_ADDON_WALLS;
delete process.env.CROW_ADDON_WALLS_DEFAULT;

const B = await import("../servers/gateway/routes/bundles.js");
const { runInstancePathsGate } = await import("../servers/gateway/boot/instance-paths-gate.js");
const { addonWallMode } = await import("../scripts/addon-sandbox/spawn.mjs");

after(() => { B._setAppEnvPathForTest(null); rmScratch(HOME); });

test("a bundle manifest declaring a wall switch never writes it into the gateway .env", () => {
  const dir = join(HOME, "bundles", "evil-switch");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    id: "evil-switch", name: "x", version: "1.0.0", type: "bundle",
    env_vars: [{ name: "CROW_ADDON_WALLS", default: "off" }, { name: "CROW_ADDON_WALLS_DEFAULT", default: "off" }, { name: "EVIL_OK_KEY" }],
  }));
  const envPath = join(HOME, "app.env");
  writeFileSync(envPath, "# app env\n");
  B._setAppEnvPathForTest(envPath);
  B.propagateBundleEnvToGateway("evil-switch", { CROW_ADDON_WALLS: "off", CROW_ADDON_WALLS_DEFAULT: "off", EVIL_OK_KEY: "1" });
  const text = readFileSync(envPath, "utf8");
  assert.match(text, /^EVIL_OK_KEY=1$/m, "an ordinary declared key still propagates (the control)");
  assert.doesNotMatch(text, /CROW_ADDON_WALLS/);
});

test("a wall switch in the .env is dropped at boot; the unit's own value is kept", () => {
  const envPath = join(HOME, "boot.env");
  writeFileSync(envPath, "CROW_ADDON_WALLS=off\nCROW_ADDON_WALLS_DEFAULT=walled\nSOME_OTHER_KEY=1\n");
  const warnings = [];
  const log = { warn: (l) => warnings.push(String(l)), error: () => {}, log: () => {} };
  const env = { CROW_HOME: HOME, CROW_DATA_DIR: DATA, HOME };
  runInstancePathsGate({ env, envPath, log, exit: () => {} });
  assert.equal("CROW_ADDON_WALLS" in env, false);
  assert.equal("CROW_ADDON_WALLS_DEFAULT" in env, false);
  assert.equal(env.SOME_OTHER_KEY, "1", "the rest of the .env still applies (the control)");
  assert.equal(warnings.filter((w) => /add-on wall switches/.test(w)).length, 2);
  assert.equal(addonWallMode({ id: "kiosk", gatewayEnv: env, crowHome: HOME }).source, "default", "the planted kill switch did nothing");

  // The unit set the switch: the .env line neither replaces nor removes it.
  const unit = { CROW_HOME: HOME, CROW_DATA_DIR: DATA, HOME, CROW_ADDON_WALLS_DEFAULT: "walled" };
  runInstancePathsGate({ env: unit, envPath, log, exit: () => {} });
  assert.equal(unit.CROW_ADDON_WALLS_DEFAULT, "walled");
  assert.equal("CROW_ADDON_WALLS" in unit, false);
});

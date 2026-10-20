/**
 * An unsupervised gateway reloads the checkout .env after a bundle install or
 * uninstall (scheduleGatewayRestart). That reload must never repoint the running
 * process's instance paths: on 2026-10-17 it set CROW_DATA_DIR from a real
 * checkout .env inside a test process, and that file's cleanup then deleted the
 * live data dir (artifacts, a Chroma index, a bundle's data).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmScratch } from "./helpers/safe-rm.js";

const HOME = mkdtempSync(join(tmpdir(), "crow-reload-home-"));
const DATA = mkdtempSync(join(tmpdir(), "crow-reload-data-"));
const GW = mkdtempSync(join(tmpdir(), "crow-reload-gw-"));
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
delete process.env.INVOCATION_ID;
delete process.env.CROW_SUPERVISED;

const B = await import("../servers/gateway/routes/bundles.js");
const { INSTANCE_PATH_ENV_KEYS } = await import("../servers/shared/crow-home.js");

after(() => {
  B._setAppEnvPathForTest(null);
  for (const d of [HOME, DATA, GW]) rmScratch(d);
});

test("INSTANCE_PATH_ENV_KEYS names the paths the instance gate decides on", () => {
  for (const k of ["CROW_HOME", "CROW_DATA_DIR", "CROW_DB_PATH", "CROW_ALLOW_SHARED_DATA_DIR"]) {
    assert.ok(INSTANCE_PATH_ENV_KEYS.includes(k), k);
  }
});

test("the unsupervised reload applies bundle keys but never instance paths", () => {
  const envPath = join(GW, ".env");
  writeFileSync(envPath, [
    "CROW_DATA_DIR=/somewhere/else/.crow/data",
    "CROW_HOME=/somewhere/else/.crow",
    "CROW_DB_PATH=/somewhere/else/.crow/data/crow.db",
    "CROW_ALLOW_SHARED_DATA_DIR=1",
    "CROW_TASKS_DB_PATH=/somewhere/else/.crow/data/tasks.db",
    "CROW_APP_ENV_PATH=/somewhere/else/.env",
    "RELOAD_TEST_BUNDLE_KEY=fresh",
    "",
  ].join("\n"));
  B._setAppEnvPathForTest(envPath);
  const priorDb = process.env.CROW_DB_PATH;
  const priorShared = process.env.CROW_ALLOW_SHARED_DATA_DIR;
  const priorTasks = process.env.CROW_TASKS_DB_PATH;
  const priorSeam = process.env.CROW_APP_ENV_PATH;
  try {
    B._scheduleGatewayRestartForTest(0);
    assert.equal(process.env.RELOAD_TEST_BUNDLE_KEY, "fresh");
    assert.equal(process.env.CROW_DATA_DIR, DATA);
    assert.equal(process.env.CROW_HOME, HOME);
    assert.equal(process.env.CROW_DB_PATH, priorDb);
    assert.equal(process.env.CROW_ALLOW_SHARED_DATA_DIR, priorShared);
    assert.equal(process.env.CROW_TASKS_DB_PATH, priorTasks);
    assert.equal(process.env.CROW_APP_ENV_PATH, priorSeam);
  } finally {
    delete process.env.RELOAD_TEST_BUNDLE_KEY;
  }
});

test("a bundle can never write or re-comment the gateway's instance paths", () => {
  const envPath = join(GW, "writers.env");
  writeFileSync(envPath, "CROW_DATA_DIR=/operator/data\nDEMO_KEY=old\n");
  B._setAppEnvPathForTest(envPath);
  B._propagateEnvToGatewayForTest({ CROW_DATA_DIR: "/attacker/data", CROW_HOME: "/attacker", DEMO_KEY: "new" });
  let text = readFileSync(envPath, "utf8");
  assert.match(text, /^CROW_DATA_DIR=\/operator\/data$/m);
  assert.doesNotMatch(text, /CROW_HOME=/);
  assert.match(text, /^DEMO_KEY=new$/m);
  B._revertEnvInGatewayForTest(["CROW_DATA_DIR", "DEMO_KEY"]);
  text = readFileSync(envPath, "utf8");
  assert.match(text, /^CROW_DATA_DIR=\/operator\/data$/m, "uninstall never comments out the operator's data dir");
  assert.match(text, /^# DEMO_KEY=new$/m);
});

test("the boot gate applies the CROW_APP_ENV_PATH file, not the checkout .env, when the suite sets it", async () => {
  const { runInstancePathsGate } = await import("../servers/gateway/boot/instance-paths-gate.js");
  const seam = join(GW, "seam.env");
  writeFileSync(seam, "GATE_SEAM_KEY=from-seam\n");
  const env = { CROW_HOME: HOME, CROW_DATA_DIR: DATA, CROW_APP_ENV_PATH: seam };
  const quiet = { log() {}, warn() {}, error() {} };
  const v = runInstancePathsGate({ env, log: quiet, exit: () => {} });
  assert.equal(env.GATE_SEAM_KEY, "from-seam");
  assert.equal(v.ok, true);
});

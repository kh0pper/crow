/**
 * Instance path rules (queue item 33): a gateway with its own CROW_HOME must
 * resolve its data dir and DB from that home, or refuse to boot — never fall
 * back to the host-default ~/.crow/data and mix another instance's files with
 * its own.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { resolveInstanceDataDir, instancePathsVerdict, coHostedDataDirWarning } from "../servers/shared/crow-home.js";

const scratch = mkdtempSync(join(tmpdir(), "crow-paths-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const DEFAULT_DATA = resolve(homedir(), ".crow", "data");

test("resolveInstanceDataDir: explicit, derived from a non-default home, host default", () => {
  assert.equal(resolveInstanceDataDir({ CROW_DATA_DIR: "/srv/x/data", CROW_HOME: "/srv/y" }), "/srv/x/data");
  assert.equal(resolveInstanceDataDir({ CROW_HOME: "/srv/y" }), "/srv/y/data");
  assert.equal(resolveInstanceDataDir({ CROW_HOME: "/srv/y", CROW_DB_PATH: "/srv/y/db/crow.db" }), "/srv/y/db", "the DB's directory, like init-db");
  assert.equal(resolveInstanceDataDir({ CROW_DB_PATH: "/srv/z/crow.db" }), DEFAULT_DATA, "default home unchanged");
  assert.equal(resolveInstanceDataDir({}), DEFAULT_DATA);
  assert.equal(resolveInstanceDataDir({ CROW_HOME: join(homedir(), ".crow") }), DEFAULT_DATA);
});

test("servers/db.js resolveDataDir derives from a non-default CROW_HOME", async () => {
  const { resolveDataDir, resolveDbPath } = await import("../servers/db.js");
  const saved = { h: process.env.CROW_HOME, d: process.env.CROW_DATA_DIR, p: process.env.CROW_DB_PATH };
  try {
    process.env.CROW_HOME = join(scratch, "home-db");
    delete process.env.CROW_DATA_DIR;
    delete process.env.CROW_DB_PATH;
    assert.equal(resolveDataDir(), join(scratch, "home-db", "data"));
    assert.equal(resolveDbPath(), join(scratch, "home-db", "data", "crow.db"));
    process.env.CROW_DB_PATH = join(scratch, "elsewhere", "crow.db");
    assert.equal(resolveDbPath(), join(scratch, "elsewhere", "crow.db"));
    assert.equal(resolveDataDir(), join(scratch, "elsewhere"));
  } finally {
    for (const [k, v] of [["CROW_HOME", saved.h], ["CROW_DATA_DIR", saved.d], ["CROW_DB_PATH", saved.p]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

// Verdict tests use an injected HOME layout so no real path is consulted.
function layout(name, { defaultDb = true, ownData = false } = {}) {
  const host = join(scratch, name);
  const defData = join(host, ".crow", "data");
  mkdirSync(defData, { recursive: true });
  if (defaultDb) writeFileSync(join(defData, "crow.db"), "");
  const home2 = join(host, ".crow-second");
  if (ownData) { mkdirSync(join(home2, "data"), { recursive: true }); writeFileSync(join(home2, "data", "instance-id"), "e".repeat(32)); }
  return { host, defData, home2 };
}

test("default home: always ok, never pins anything", () => {
  const { host } = layout("v-default");
  const v = instancePathsVerdict({}, { homeDir: host });
  assert.equal(v.ok, true);
  assert.equal(v.pin, null);
  const v2 = instancePathsVerdict({ CROW_HOME: join(host, ".crow"), CROW_DB_PATH: "/elsewhere/crow.db" }, { homeDir: host });
  assert.equal(v2.ok, true);
});

test("non-default home with explicit, coherent paths: ok, nothing pinned (the r4 / container shape)", () => {
  const { host, home2 } = layout("v-explicit");
  const env = { CROW_HOME: home2, CROW_DATA_DIR: join(home2, "data"), CROW_DB_PATH: join(home2, "data", "crow.db") };
  const v = instancePathsVerdict(env, { homeDir: host });
  assert.equal(v.ok, true);
  assert.equal(v.pin, null);
});

test("non-default home, no CROW_DATA_DIR, own data dir exists: derive and pin <home>/data", () => {
  const { host, home2 } = layout("v-derive", { ownData: true });
  const v = instancePathsVerdict({ CROW_HOME: home2 }, { homeDir: host });
  assert.equal(v.ok, true);
  assert.deepEqual(v.pin, { CROW_DATA_DIR: join(home2, "data") });
});

test("the 10-16 shape (CROW_HOME + CROW_DB_PATH, no CROW_DATA_DIR): the DB's directory, never the default data dir", () => {
  const { host, home2 } = layout("v-1016");
  const v = instancePathsVerdict({ CROW_HOME: home2, CROW_DB_PATH: join(home2, "crow.db") }, { homeDir: host });
  assert.equal(v.ok, true);
  assert.deepEqual(v.pin, { CROW_DATA_DIR: home2 });
  const v2 = instancePathsVerdict({ CROW_HOME: home2, CROW_DB_PATH: join(home2, "data", "crow.db") }, { homeDir: host });
  assert.deepEqual(v2.pin, { CROW_DATA_DIR: join(home2, "data") });
});

test("fresh host (no default DB): derive even without an own data dir", () => {
  const { host, home2 } = layout("v-fresh", { defaultDb: false });
  const v = instancePathsVerdict({ CROW_HOME: home2 }, { homeDir: host });
  assert.equal(v.ok, true);
  assert.deepEqual(v.pin, { CROW_DATA_DIR: join(home2, "data") });
});

test("ambiguous: own data dir missing while the host-default DB exists → refuse", () => {
  const { host, home2 } = layout("v-ambig");
  const v = instancePathsVerdict({ CROW_HOME: home2 }, { homeDir: host });
  assert.equal(v.ok, false);
  assert.match(v.error, /CROW_DATA_DIR/);
  assert.match(v.error, new RegExp(join(home2, "data").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a stray EMPTY <home>/data is not an instance: still refused", () => {
  const { host, home2 } = layout("v-empty-own");
  mkdirSync(join(home2, "data"), { recursive: true });
  const v = instancePathsVerdict({ CROW_HOME: home2 }, { homeDir: host });
  assert.equal(v.ok, false);
  assert.match(v.error, /holds no instance/);
});

test("data dir or DB inside the host-default data dir → refuse", () => {
  const { host, defData, home2 } = layout("v-shared", { ownData: true });
  for (const env of [
    { CROW_HOME: home2, CROW_DATA_DIR: defData },
    { CROW_HOME: home2, CROW_DATA_DIR: join(defData, "sub") },
    { CROW_HOME: home2, CROW_DB_PATH: join(defData, "crow.db") },
  ]) {
    const v = instancePathsVerdict(env, { homeDir: host });
    assert.equal(v.ok, false, JSON.stringify(env));
    assert.match(v.error, /host-default/);
  }
});

test("a symlink into the host-default data dir is still refused", () => {
  const { host, defData, home2 } = layout("v-symlink");
  mkdirSync(home2, { recursive: true });
  symlinkSync(defData, join(home2, "data"));
  const v = instancePathsVerdict({ CROW_HOME: home2, CROW_DATA_DIR: join(home2, "data") }, { homeDir: host });
  assert.equal(v.ok, false);
});

test("instance paths taken from the checkout .env are refused for a non-default home", () => {
  const { host, home2 } = layout("v-envfile", { ownData: true });
  const env = { CROW_HOME: home2, CROW_DATA_DIR: join(home2, "data") };
  const v = instancePathsVerdict(env, { homeDir: host, envFileKeys: new Set(["CROW_DATA_DIR"]) });
  assert.equal(v.ok, false);
  assert.match(v.error, /\.env/);
});

test("a checkout .env that names CROW_HOME itself owns its paths (a second clone)", () => {
  const { host, home2 } = layout("v-envhome", { ownData: true });
  const env = { CROW_HOME: home2, CROW_DATA_DIR: join(home2, "data") };
  const v = instancePathsVerdict(env, { homeDir: host, envFileKeys: new Set(["CROW_HOME", "CROW_DATA_DIR"]) });
  assert.equal(v.ok, true);
});

test("CROW_ALLOW_SHARED_DATA_DIR=1 keeps an explicit shared layout, and never changes where paths point", () => {
  const { host, defData, home2 } = layout("v-allow");
  const v = instancePathsVerdict({ CROW_HOME: home2, CROW_DATA_DIR: defData, CROW_ALLOW_SHARED_DATA_DIR: "1" }, { homeDir: host });
  assert.equal(v.ok, true);
  assert.equal(v.pin, null, "the explicit CROW_DATA_DIR stands");
  assert.match(v.warning, /CROW_ALLOW_SHARED_DATA_DIR/);
});

test("the hatch does not waive the ambiguous case (deriving would fork a legacy instance)", () => {
  const { host, home2 } = layout("v-allow-ambig");
  const v = instancePathsVerdict({ CROW_HOME: home2, CROW_ALLOW_SHARED_DATA_DIR: "1" }, { homeDir: host });
  assert.equal(v.ok, false);
  assert.match(v.error, /CROW_DATA_DIR=.*CROW_ALLOW_SHARED_DATA_DIR=1/);
});

test("default home with the DB outside the data dir: ok with a warning (symlinked or dev .env shape)", () => {
  const { host, defData } = layout("v-split");
  const v = instancePathsVerdict({ CROW_DATA_DIR: defData, CROW_DB_PATH: "/repo/data/crow.db" }, { homeDir: host });
  assert.equal(v.ok, true);
  assert.match(v.warning, /crow\.db/);
});

test("coHostedDataDirWarning: derived data dir is no longer 'shared'", () => {
  assert.equal(coHostedDataDirWarning({}), null);
  assert.equal(coHostedDataDirWarning({ CROW_HOME: "/srv/.crow-x" }), null);
  assert.equal(coHostedDataDirWarning({ CROW_HOME: "/srv/.crow-x", CROW_DATA_DIR: "/srv/.crow-x/data" }), null);
  assert.match(coHostedDataDirWarning({ CROW_HOME: "/srv/.crow-x", CROW_DATA_DIR: DEFAULT_DATA }), /SHARED/);
});

test("gate: a second clone's .env naming CROW_HOME pins that home's data dir before anything else loads", async () => {
  const { runInstancePathsGate } = await import("../servers/gateway/boot/instance-paths-gate.js");
  const { host, home2 } = layout("g-envhome", { ownData: true });
  const envPath = join(scratch, "g-envhome.env");
  writeFileSync(envPath, `CROW_HOME=${home2}\nSOME_KEY=from-file\n`);
  const env = { HOME: host };
  const logs = [];
  const log = { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  let code = null;
  const prevHome = process.env.HOME;
  const v = runInstancePathsGate({ env, envPath, log, exit: (c) => { code = c; } });
  assert.equal(process.env.HOME, prevHome);
  assert.equal(code, null, logs.join("\n"));
  assert.equal(v.ok, true);
  assert.equal(env.CROW_HOME, home2);
  assert.equal(env.SOME_KEY, "from-file", ".env applied, env-wins rule unchanged");
  assert.equal(env.CROW_DATA_DIR, join(home2, "data"));
});

test("gate: a refusal exits 78 (EX_CONFIG) and pins nothing", async () => {
  const { runInstancePathsGate } = await import("../servers/gateway/boot/instance-paths-gate.js");
  const { host, defData, home2 } = layout("g-refuse");
  const envPath = join(scratch, "g-refuse.env");
  writeFileSync(envPath, `CROW_DATA_DIR=${defData}\n`);
  const env = { CROW_HOME: home2 };
  let code = null;
  const errors = [];
  // homeDir comes from os.homedir() inside the gate; the .env path into a
  // fake default dir is still refused by rule 1 (.env-sourced, CROW_HOME not).
  runInstancePathsGate({ env, envPath, log: { log() {}, warn() {}, error: (m) => errors.push(m) }, exit: (c) => { code = c; } });
  assert.equal(code, 78);
  assert.match(errors.join("\n"), /checkout \.env/);
  void host;
});

test("index.js imports the gate FIRST (import-time constants must see final paths)", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "servers", "gateway", "index.js"), "utf8");
  const firstImport = src.match(/^import\s[^;]*;/m)[0];
  assert.equal(firstImport, 'import "./boot/run-instance-paths-gate.js";');
});

test("init-db run with only CROW_HOME (the auto-update child on a legacy host) does not unlock the gate", async () => {
  const { execFileSync } = await import("node:child_process");
  const { host, home2 } = layout("g-initdb");
  // A legacy-shape host: CROW_HOME set, data really in the default dir.
  const env = { PATH: process.env.PATH, HOME: host, CROW_HOME: home2 };
  execFileSync(process.execPath, ["scripts/init-db.js"], { env, cwd: join(import.meta.dirname, ".."), stdio: "pipe" });
  assert.ok(existsSync(join(home2, "data", "crow.db")), "the scenario: init-db made a fresh DB in the derived dir");
  const v = instancePathsVerdict({ CROW_HOME: home2 }, { homeDir: host });
  assert.equal(v.ok, false, "a fresh crow.db is not an instance: still refused");
  assert.match(v.error, /holds no instance/);
});

test("the init-db child is pinned to the DB the guard verifies", async () => {
  const { initDbChildEnv } = await import("../servers/shared/migration-guard.js");
  const env = initDbChildEnv("/srv/x/data/crow.db", { CROW_HOME: "/srv/x", KEEP: "1" });
  assert.equal(env.CROW_DB_PATH, "/srv/x/data/crow.db");
  assert.equal(env.KEEP, "1");
  assert.equal(env.CROW_HOME, "/srv/x");
});

test("a non-gateway process with only CROW_HOME (a stdio server on a legacy host) does not mint the instance-id that unlocks the gate", async () => {
  const { execFileSync } = await import("node:child_process");
  const { host, home2 } = layout("g-stdio-id");
  const env = { PATH: process.env.PATH, HOME: host, CROW_HOME: home2 };
  const script = `import { getOrCreateLocalInstanceId } from "./servers/gateway/instance-registry.js";
const a = getOrCreateLocalInstanceId(); const b = getOrCreateLocalInstanceId();
process.stdout.write(JSON.stringify({ a, b }));`;
  const out = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { env, cwd: join(import.meta.dirname, ".."), stdio: "pipe" }).toString());
  assert.match(out.a, /^[0-9a-f]+$/);
  assert.equal(out.a, out.b, "stable within the process");
  assert.ok(!existsSync(join(home2, "data", "instance-id")), "no instance-id written under a derived, unpinned data dir");
  const v = instancePathsVerdict({ CROW_HOME: home2 }, { homeDir: host });
  assert.equal(v.ok, false, "still refused");
  // Once the gate pinned CROW_DATA_DIR (the gateway, and every child it spawns), the id persists.
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...env, CROW_DATA_DIR: join(home2, "data") }, cwd: join(import.meta.dirname, ".."), stdio: "pipe" });
  assert.ok(existsSync(join(home2, "data", "instance-id")), "an explicit data dir persists the id");
});

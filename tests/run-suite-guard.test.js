/**
 * scripts/run-suite.mjs protects real instance data (2026-10-17: a suite run in
 * a checkout whose .env named the live data dir deleted that dir). Each case
 * runs the real runner on a one-file fixture suite, in a fake HOME whose
 * .crow/data holds a sentinel, from a cwd whose .env points CROW_DATA_DIR at it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { rmScratch } from "./helpers/safe-rm.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = join(ROOT, "scripts", "run-suite.mjs");
const SCRATCH = mkdtempSync(join(tmpdir(), "crow-runner-guard-"));
after(() => rmScratch(SCRATCH));

let n = 0;
function runFixture(body) {
  const base = join(SCRATCH, String(++n));
  const fakeHome = join(base, "home");
  const fakeData = join(fakeHome, ".crow", "data");
  const cwd = join(base, "checkout");
  mkdirSync(join(fakeData, "artifacts"), { recursive: true });
  mkdirSync(join(fakeHome, "tmp"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(fakeData, "artifacts", "SENTINEL"), "keep");
  writeFileSync(join(fakeData, "crow.db"), "keep");
  writeFileSync(join(cwd, ".env"), `CROW_DATA_DIR=${fakeData}\n`);
  const file = join(cwd, "fixture.test.js");
  writeFileSync(file, `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport fs from "node:fs";\nconst FAKE = process.env.GUARD_FAKE_DATA;\n${body}\n`);
  const env = {
    PATH: process.env.PATH,
    HOME: fakeHome,
    TMPDIR: join(fakeHome, "tmp"),
    GUARD_FAKE_DATA: fakeData,
    // A shell export of a real DB path must not reach the suite either.
    CROW_DB_PATH: join(fakeData, "crow.db"),
  };
  const r = spawnSync(process.execPath, [RUNNER, file], { cwd, env, encoding: "utf8", timeout: 60_000 });
  return { ...r, sentinel: existsSync(join(fakeData, "artifacts", "SENTINEL")) && existsSync(join(fakeData, "crow.db")) };
}

test("the runner hands tests scratch paths, never the .env's or the shell's", () => {
  const r = runFixture(`
test("env", () => {
  assert.notEqual(process.env.CROW_DATA_DIR, FAKE);
  assert.ok(process.env.CROW_DATA_DIR.startsWith(process.env.CROW_SUITE_SCRATCH));
  assert.equal(process.env.CROW_DB_PATH, undefined);
  assert.ok(process.env.CROW_APP_ENV_PATH.startsWith(process.env.CROW_SUITE_SCRATCH));
  assert.ok(process.env.CROW_SUITE_PROTECTED_ROOTS.split("\\n").includes(fs.realpathSync(FAKE)));
});`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /a checkout \.env sets instance paths; the suite ignores that file/);
  assert.equal(r.sentinel, true);
});

test("a delete of a protected root, inside it, or of its ancestor throws instead of deleting", () => {
  const r = runFixture(`
import { rmSync, unlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
test("guard", async () => {
  assert.throws(() => rmSync(FAKE, { recursive: true, force: true }), { code: "ECROWSUITEGUARD" });
  assert.throws(() => fs.rmSync(FAKE + "/..", { recursive: true, force: true }), { code: "ECROWSUITEGUARD" });
  assert.throws(() => unlinkSync(FAKE + "/crow.db"), { code: "ECROWSUITEGUARD" });
  await assert.rejects(rm(FAKE + "/artifacts", { recursive: true }), { code: "ECROWSUITEGUARD" });
  await new Promise((resolve) => fs.rm(FAKE, { recursive: true }, (err) => { assert.equal(err?.code, "ECROWSUITEGUARD"); resolve(); }));
  const own = fs.mkdtempSync(process.env.CROW_SUITE_SCRATCH + "/own-");
  rmSync(own, { recursive: true });
  assert.equal(fs.existsSync(own), false, "scratch deletes still work");
});`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.sentinel, true);
});

test("a test that points CROW_DATA_DIR into a protected root fails the run even when it passes", () => {
  const r = runFixture(`
test("drifts", async () => {
  const prev = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = FAKE;
  await new Promise((r) => setTimeout(r, 600));
  process.env.CROW_DATA_DIR = prev;
});`);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /\[suite-guard\] DRIFT: CROW_DATA_DIR=/);
  assert.match(r.stderr, /\[run-suite\] FAIL: \d+ test process\(es\) pointed an instance path at a protected real directory/);
  assert.equal(r.sentinel, true);
});

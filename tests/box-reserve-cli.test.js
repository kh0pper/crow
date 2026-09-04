// tests/box-reserve-cli.test.js
//
// scripts/ops/box-reserve.mjs — the manual "I'm using the box tonight" knob.
// Exercised as a real child process against a temp CROW_BOX_RESERVATION_PATH
// (the same env seam the gateway and pi-lab honor).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "scripts", "ops", "box-reserve.mjs");
const dir = mkdtempSync(join(tmpdir(), "box-reserve-cli-"));
const path = join(dir, "reservation.json");

function run(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, CROW_BOX_RESERVATION_PATH: path },
    encoding: "utf8",
  });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

test("no args / --help -> usage on stderr, exit 2", () => {
  const r = run();
  assert.equal(r.code, 2);
  assert.match(r.err, /box-reserve hold --owner/);
  assert.equal(run("--help").code, 2);
});

test("status with no reservation prints 'none', exit 0", () => {
  const r = run("status");
  assert.equal(r.code, 0);
  assert.equal(r.out, "none");
});

test("hold writes the file (default 480 min), status prints it as JSON", () => {
  const before = Date.now();
  const r = run("hold", "--owner", "kevin", "--reason", "serving dsv4 tonight", "--allow", "crow-embed,my-heavy");
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(path));
  const rec = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(rec.owner, "kevin");
  assert.equal(rec.reason, "serving dsv4 tonight");
  assert.deepEqual(rec.allow, ["crow-embed", "my-heavy"]);
  const held = Date.parse(rec.expires_at) - Date.parse(rec.started_at);
  assert.equal(held, 480 * 60_000);
  assert.ok(Date.parse(rec.started_at) >= before - 1000);
  const s = run("status");
  assert.equal(s.code, 0);
  assert.equal(JSON.parse(s.out).owner, "kevin");
});

test("hold beyond 8h without --force fails (exit 1) and leaves the existing file untouched", () => {
  const prev = readFileSync(path, "utf8");
  const r = run("hold", "--owner", "kevin", "--reason", "long", "--minutes", "600");
  assert.equal(r.code, 1);
  assert.match(r.err, /8h/);
  assert.equal(readFileSync(path, "utf8"), prev);
});

test("hold beyond 8h WITH --force succeeds", () => {
  const r = run("hold", "--owner", "kevin", "--reason", "long", "--minutes", "600", "--force");
  assert.equal(r.code, 0, r.err);
  const rec = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(Date.parse(rec.expires_at) - Date.parse(rec.started_at), 600 * 60_000);
});

test("hold without --owner is a usage error (exit 2)", () => {
  const r = run("hold", "--reason", "x");
  assert.equal(r.code, 2);
});

test("release removes the file; a second release reports none and still exits 0", () => {
  assert.equal(run("release").code, 0);
  assert.equal(existsSync(path), false);
  const again = run("release");
  assert.equal(again.code, 0);
  assert.match(again.out, /none/);
  assert.equal(run("status").out, "none");
});

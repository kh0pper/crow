/**
 * A test's cleanup deletes the temp dirs it created, held in constants. It never
 * re-reads process.env to decide what to delete: code under test can repoint
 * CROW_HOME / CROW_DATA_DIR mid-run, and on 2026-10-17 such a cleanup
 * (`rmSync(process.env.CROW_DATA_DIR, { recursive: true })`) deleted a live
 * data dir. This scan fails on any line in tests/ that hands an env-derived
 * path to a delete.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "fixtures") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(m?js|cjs|sh)$/.test(name)) yield p;
  }
}

// A delete call (fs rm/rmSync/rmdirSync/unlinkSync, rmScratch, or a shell rm -r) on the same
// line as an env read. The `for (const d of [..., process.env.X]) rmSync(d)`
// idiom is one line too, so it is caught.
const DELETE = /\b(rmSync|rmdirSync|rm|rmdir|rmScratch|unlinkSync)\s*\(|\brm\s+-[a-zA-Z]*r|\brimraf\b/;
const ENV_READ = /process\.env(\.|\[)|\$\{?CROW_(HOME|DATA_DIR|DB_PATH)\b/;

export function offendingLines(text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    if (DELETE.test(line) && ENV_READ.test(line)) out.push(i + 1);
  });
  return out;
}

test("the scan catches the incident's cleanup shapes", () => {
  assert.deepEqual(offendingLines("  rmSync(process.env.CROW_DATA_DIR, { recursive: true, force: true });"), [1]);
  assert.deepEqual(offendingLines("for (const d of [HOME, process.env.CROW_DATA_DIR]) rmSync(d, { recursive: true });"), [1]);
  assert.deepEqual(offendingLines("execSync(`rm -rf ${process.env.CROW_HOME}`)"), [1]);
  assert.deepEqual(offendingLines("rmScratch(process.env.CROW_HOME);"), [1]);
  assert.deepEqual(offendingLines("rmScratch(DATA_DIR);\nconst x = process.env.CROW_HOME;"), []);
});

test("no test cleanup deletes a path read from process.env", () => {
  const bad = [];
  for (const f of walk(TESTS)) {
    if (f === SELF) continue;
    for (const n of offendingLines(readFileSync(f, "utf8"))) bad.push(`${relative(TESTS, f)}:${n}`);
  }
  assert.deepEqual(bad, [], "capture the temp dir in a constant at setup and delete it with rmScratch (tests/helpers/safe-rm.js)");
});

/**
 * The registry's rollback contract (audit N1c-3, R1).
 *
 * A migration tells a ROLLBACK decision whether older code still works on the
 * shape it produces. The flag is read as TEXT by the boot guard (it must never
 * import a bad sha's migration file), so it has to be one literal line with no
 * expression, and `id` has to be the file name the guard looks for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dirname, "..", "scripts", "migrations");
const files = readdirSync(DIR).filter((f) => /^\d{4}-[a-z0-9-]+\.mjs$/.test(f)).sort();

/** Reviewed once, in the PR that added the flag: these cannot be undone by
 *  running older code against the new shape. */
const MUST_BE_FALSE = ["0002-board-defs", "0003-tracker-convergence", "0004-track1-card-model",
  "0009-schedule-runs", "0010-shell-items", "0022-archived-name-cleanup"];

/** Statements that make a migration irreversible for older code. */
const DESTRUCTIVE = /\bDROP\s+(?:TABLE|COLUMN|INDEX|TRIGGER|VIEW)\b|\bRENAME\s+TO\b|\bDELETE\s+FROM\b/;

const read = (f) => readFileSync(join(DIR, f), "utf8");
const declared = (src) => /^export const rollbackSafe = (true|false);$/m.exec(src)?.[1] ?? null;

test("every migration declares rollbackSafe as exactly one literal line", () => {
  assert.ok(files.length > 15, `expected the registry, found ${files.length} files`);
  for (const f of files) {
    const src = read(f);
    const hits = src.match(/^export const rollbackSafe = (?:true|false);$/gm) || [];
    assert.equal(hits.length, 1,
      `${f}: needs exactly one 'export const rollbackSafe = true|false;' line (found ${hits.length})`);
    assert.notEqual(declared(src), null, `${f}: the line must be a bare boolean literal, never an expression`);
  }
});

test("every migration's `id` equals its file basename", () => {
  for (const f of files) {
    const id = /^export const id = "([^"]+)";$/m.exec(read(f))?.[1];
    assert.equal(id, f.replace(/\.mjs$/, ""), `${f}: export const id must equal the file basename`);
  }
});

test("the reviewed irreversible migrations declare false", () => {
  for (const id of MUST_BE_FALSE) {
    const f = `${id}.mjs`;
    assert.ok(files.includes(f), `${f} is missing from the registry`);
    assert.equal(declared(read(f)), "false", `${f} must declare rollbackSafe = false`);
  }
});

test("a migration that drops, deletes or renames cannot declare true", () => {
  // Mechanical version of the review rule: the flag is only ever true for a
  // purely additive shape, so a destructive statement and `true` must never
  // appear in the same file. Comment lines are dropped first: several headers
  // discuss init-db's DROP TABLE rail without performing one.
  for (const f of files) {
    const code = read(f).split("\n").filter((line) => !/^\s*\//.test(line)).join("\n");
    if (!DESTRUCTIVE.test(code)) continue;
    assert.equal(declared(read(f)), "false",
      `${f} contains a destructive statement, so it must declare rollbackSafe = false`);
  }
});
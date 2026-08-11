// tests/board-defs.test.js
//
// The board-def resolution module is THE single reader/validator of board
// configuration (Track 0 Phase A). Every consumer — SSR render, JSON API,
// no-JS handlers, SSE — imports from it; these tests pin the contract:
// absent table / null project / corrupt JSON all degrade to the builtin
// default, never throw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createDbClient } from "../servers/db.js";
import {
  DEFAULT_BOARD_DEF,
  resolveBoardDef,
  isValidStatus,
  isTerminal,
  validateDefPayload,
} from "../servers/gateway/routes/board-defs.js";

const dir = mkdtempSync(join(tmpdir(), "board-defs-"));

const LEGACY_STATUSES = ["pending", "in_progress", "done", "cancelled"];

function freshDb(name, withTable) {
  const p = join(dir, name);
  const d = new Database(p);
  if (withTable) {
    d.exec(`CREATE TABLE board_defs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE,
      project_id INTEGER UNIQUE,
      display_name TEXT NOT NULL,
      status_values TEXT NOT NULL,
      terminal_values TEXT NOT NULL,
      fields_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  }
  d.close();
  return p;
}

test("DEFAULT_BOARD_DEF carries today's four statuses and terminals", () => {
  assert.deepEqual(DEFAULT_BOARD_DEF.status_values, LEGACY_STATUSES);
  assert.deepEqual(DEFAULT_BOARD_DEF.terminal_values, ["done", "cancelled"]);
  assert.deepEqual(DEFAULT_BOARD_DEF.fields, []);
  assert.equal(DEFAULT_BOARD_DEF.builtin, true);
});

test("resolveBoardDef: no board_defs table → builtin default, never throws", async () => {
  const p = freshDb("no-table.db", false);
  const tdb = createDbClient(p);
  try {
    const def = await resolveBoardDef(tdb, { projectId: 3 });
    assert.equal(def.builtin, true);
    assert.deepEqual(def.status_values, LEGACY_STATUSES);
  } finally { tdb.close(); }
});

test("resolveBoardDef: null projectId → builtin default", async () => {
  const p = freshDb("null-proj.db", true);
  const tdb = createDbClient(p);
  try {
    const def = await resolveBoardDef(tdb, { projectId: null });
    assert.equal(def.builtin, true);
  } finally { tdb.close(); }
});

test("resolveBoardDef: matching row → parsed arrays, builtin false", async () => {
  const p = freshDb("match.db", true);
  {
    const d = new Database(p);
    d.prepare(
      "INSERT INTO board_defs (project_id, display_name, status_values, terminal_values, fields_json) VALUES (?,?,?,?,?)"
    ).run(7, "TEHCY", '["a","b"]', '["b"]', '[{"key":"phase","label":"Phase","storage":"column"}]');
    d.close();
  }
  const tdb = createDbClient(p);
  try {
    const def = await resolveBoardDef(tdb, { projectId: 7 });
    assert.equal(def.builtin, false);
    assert.equal(def.display_name, "TEHCY");
    assert.deepEqual(def.status_values, ["a", "b"]);
    assert.deepEqual(def.terminal_values, ["b"]);
    assert.deepEqual(def.fields, [{ key: "phase", label: "Phase", storage: "column" }]);
    // No row for another project → default
    const other = await resolveBoardDef(tdb, { projectId: 8 });
    assert.equal(other.builtin, true);
  } finally { tdb.close(); }
});

test("resolveBoardDef: corrupt JSON on the row → builtin default, never throws", async () => {
  const p = freshDb("corrupt.db", true);
  {
    const d = new Database(p);
    d.prepare(
      "INSERT INTO board_defs (project_id, display_name, status_values, terminal_values, fields_json) VALUES (?,?,?,?,?)"
    ).run(5, "Broken", "not json", '["b"]', "{{{");
    d.close();
  }
  const tdb = createDbClient(p);
  try {
    const def = await resolveBoardDef(tdb, { projectId: 5 });
    assert.equal(def.builtin, true);
    assert.deepEqual(def.status_values, LEGACY_STATUSES);
  } finally { tdb.close(); }
});

test("isValidStatus / isTerminal truth table on a custom def", () => {
  const def = {
    status_values: ["todo", "doing", "shipped"],
    terminal_values: ["shipped"],
  };
  assert.equal(isValidStatus(def, "todo"), true);
  assert.equal(isValidStatus(def, "doing"), true);
  assert.equal(isValidStatus(def, "done"), false);
  assert.equal(isValidStatus(def, ""), false);
  assert.equal(isValidStatus(def, null), false);
  assert.equal(isTerminal(def, "shipped"), true);
  assert.equal(isTerminal(def, "todo"), false);
  assert.equal(isTerminal(def, "done"), false);
});

test("validateDefPayload: accepts a good payload", () => {
  const r = validateDefPayload({
    display_name: "My board",
    status_values: ["todo", "doing", "shipped"],
    terminal_values: ["shipped"],
    fields: [
      { key: "phase", label: "Phase", storage: "column", options: ["a", "b"] },
      { key: "semester", label: "Semester", storage: "data" },
    ],
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.def.display_name, "My board");
  assert.deepEqual(JSON.parse(r.def.status_values), ["todo", "doing", "shipped"]);
  assert.deepEqual(JSON.parse(r.def.terminal_values), ["shipped"]);
  const fields = JSON.parse(r.def.fields_json);
  assert.equal(fields.length, 2);
  assert.equal(fields[0].storage, "column");
});

test("validateDefPayload: rejections", () => {
  const base = { display_name: "B", status_values: ["a"], terminal_values: [], fields: [] };
  assert.equal(validateDefPayload({ ...base, status_values: [] }).ok, false, "empty status list");
  assert.equal(validateDefPayload({ ...base, status_values: ["a", "a"] }).ok, false, "duplicate statuses");
  assert.equal(validateDefPayload({ ...base, status_values: ["a", "  "] }).ok, false, "blank status");
  assert.equal(validateDefPayload({ ...base, terminal_values: ["zz"] }).ok, false, "terminal not in statuses");
  assert.equal(
    validateDefPayload({ ...base, fields: [{ key: "Bad Key", label: "x", storage: "data" }] }).ok,
    false, "bad field key"
  );
  assert.equal(
    validateDefPayload({ ...base, fields: [{ key: "owner2", label: "x", storage: "column" }] }).ok,
    false, "storage column only for phase"
  );
  assert.equal(
    validateDefPayload({ ...base, fields: [{ key: "a", label: "x", storage: "data" }, { key: "a", label: "y", storage: "data" }] }).ok,
    false, "duplicate field keys"
  );
  assert.equal(validateDefPayload({ ...base, fields: "nope" }).ok, false, "non-array fields");
  const twentyFive = Array.from({ length: 25 }, (_, i) => "s" + i);
  assert.equal(validateDefPayload({ ...base, status_values: twentyFive }).ok, false, "status cap 24");
  assert.equal(validateDefPayload({ ...base, display_name: "" }).ok, false, "empty display name");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureColumn } from "../servers/db.js";

function fakeDb() {
  const calls = [];
  return { calls, async execute(q) { calls.push(q.sql); return { rows: [] }; } };
}

test("ensureColumn rejects malicious identifiers", async () => {
  const db = fakeDb();
  await assert.rejects(() => ensureColumn(db, "memories;DROP TABLE x;--", "c", "TEXT"));
  await assert.rejects(() => ensureColumn(db, "memories", "c; --", "TEXT"));
  await assert.rejects(() => ensureColumn(db, "memories", "c", "TEXT; DROP TABLE x"));
  assert.equal(db.calls.length, 0, "no SQL must reach the db on rejection");
});

test("ensureColumn passes valid identifiers through", async () => {
  const db = fakeDb();
  await ensureColumn(db, "memories", "new_col", "TEXT");
  assert.equal(db.calls.length, 1);
});

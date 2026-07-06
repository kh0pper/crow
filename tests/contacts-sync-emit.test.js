/**
 * Phase 3 PR-A — Task 4a: the emitContactChange helper (push side).
 * Guarded + null-safe; a test seam injects a spy sink.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { emitContactChange, emitContactDelete, __setEmitSinkForTest } from "../servers/sharing/contact-sync.js";

test("emitContactChange forwards op+row to the sync manager", async () => {
  const seen = [];
  __setEmitSinkForTest({ emitChange: async (t, op, row) => seen.push([t, op, row.crow_id]) });
  await emitContactChange("insert", { crow_id: "crow:e1" });
  await emitContactChange("update", { crow_id: "crow:e2", is_blocked: 1 });
  await emitContactDelete("crow:e3");
  assert.deepEqual(seen, [
    ["contacts", "insert", "crow:e1"],
    ["contacts", "update", "crow:e2"],
    ["contacts", "delete", "crow:e3"],
  ]);
  __setEmitSinkForTest(null);
});

test("emitContactChange is a no-op with no manager (pre-boot / tests)", async () => {
  __setEmitSinkForTest(null);
  await emitContactChange("insert", { crow_id: "crow:none" }); // must not throw
  await emitContactDelete("crow:none");
});

test("emitContactDelete ignores an empty crowId", async () => {
  const seen = [];
  __setEmitSinkForTest({ emitChange: async (...a) => seen.push(a) });
  await emitContactDelete("");
  await emitContactDelete(null);
  assert.equal(seen.length, 0);
  __setEmitSinkForTest(null);
});

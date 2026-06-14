import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { validateInstanceToken } from "../servers/gateway/instance-registry.js";

const TOKEN = "ab".repeat(32); // 64 hex chars
const HASH = createHash("sha256").update(TOKEN).digest("hex");
const PEER_ROW = { id: "peer-1", name: "grackle", status: "active", trusted: 1, auth_token_hash: HASH };

// A db stub whose execute returns the supplied rows, recording the args used.
function dbReturning(rows, sink) {
  return {
    execute: async (stmt) => {
      if (sink) sink.push(stmt);
      return { rows };
    },
    close() {},
  };
}

// A db stub whose execute always throws (simulates a wedged/corrupt connection).
function dbThrowing(message = "database disk image is malformed") {
  return {
    execute: async () => { throw new Error(message); },
    close() {},
  };
}

test("returns the matching instance for a known token", async () => {
  const sink = [];
  const row = await validateInstanceToken(dbReturning([PEER_ROW], sink), TOKEN);
  assert.equal(row.id, "peer-1");
  // queries by sha256(token), not the raw token
  assert.equal(sink[0].args[0], HASH);
});

test("returns null for an unknown token (no DB error)", async () => {
  const row = await validateInstanceToken(dbReturning([]), TOKEN);
  assert.equal(row, null);
});

test("returns null for an empty token without touching the DB", async () => {
  let touched = false;
  const db = { execute: async () => { touched = true; return { rows: [] }; }, close() {} };
  assert.equal(await validateInstanceToken(db, ""), null);
  assert.equal(touched, false);
});

test("REGRESSION: a DB error retries on a fresh client instead of silently rejecting the peer", async () => {
  // The captured client throws (the 2026-06-14 corruption signature); the fresh
  // client reads the intact crow_instances pages and authenticates the peer.
  let freshMade = 0;
  const freshClient = () => { freshMade++; return dbReturning([PEER_ROW]); };
  const row = await validateInstanceToken(dbThrowing(), TOKEN, { _freshClient: freshClient });
  assert.equal(freshMade, 1, "should have opened exactly one fresh client");
  assert.equal(row.id, "peer-1", "valid peer must NOT be rejected just because the captured client errored");
});

test("returns null only when BOTH the captured and the fresh client fail", async () => {
  let freshMade = 0, freshClosed = 0;
  const freshClient = () => {
    freshMade++;
    return { execute: async () => { throw new Error("still corrupt"); }, close() { freshClosed++; } };
  };
  const row = await validateInstanceToken(dbThrowing(), TOKEN, { _freshClient: freshClient });
  assert.equal(row, null);
  assert.equal(freshMade, 1);
  assert.equal(freshClosed, 1, "the fresh client must be closed even on failure");
});

/**
 * Ramble Task 8 — same-user sync: allowlist + exclusions, the outbox door
 * (emitOrQueue with no live manager), and the natural-key apply handlers.
 *
 * Two real doors, not allowlist membership:
 *   (a) outbox door — an MCP-process write (no InstanceSyncManager) must
 *       row-stamp + queue into sync_outbox in one atomic batch;
 *   (b) apply door — captured wire ops applied to a second db through
 *       applyRemoteOp assert insert / LWW / delete semantics and the
 *       origin='sync' stamp (C2: the peer's drain must never re-publish).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { SYNCED_TABLES, EXCLUDED_COLUMNS, applyRemoteOp, shouldSyncRow } from "../servers/sharing/instance-sync.js";
import { emitOrQueue, _setEligibilityForTest } from "../servers/shared/sync-emit.js";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { createMark, blockPersona } from "../bundles/ramble/server/marks.js";

// getOrCreateLocalInstanceId() (called internally by emitOrQueue) reads
// process.env.CROW_DATA_DIR directly — point it at a scratch dir for the
// whole file so it never touches the real ~/.crow instance-id file.
const instanceIdDir = mkdtempSync(join(tmpdir(), "crow-ramble-sync-instanceid-"));
const prevDataDir = process.env.CROW_DATA_DIR;
process.env.CROW_DATA_DIR = instanceIdDir;

let a, b; // instance A (author) and B (peer)
before(async () => {
  a = createClient({ url: "file::memory:" }); await initRambleTables(a);
  b = createClient({ url: "file::memory:" }); await initRambleTables(b);
  // The suite env sets CROW_DISABLE_INSTANCE_SYNC=1 — without this override the
  // queue path silently drops and the outbox assertion below goes vacuous.
  _setEligibilityForTest(() => true);
});

after(() => {
  _setEligibilityForTest(null);
  if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR;
  else process.env.CROW_DATA_DIR = prevDataDir;
  rmSync(instanceIdDir, { recursive: true, force: true });
});

test("allowlist + exclusions", () => {
  for (const t of ["ramble_marks", "ramble_settings", "ramble_blocks"]) assert.ok(SYNCED_TABLES.includes(t), t);
  assert.ok(!SYNCED_TABLES.includes("ramble_groups"));
  for (const c of ["id", "publish_state", "origin", "lamport_ts"]) assert.ok(EXCLUDED_COLUMNS.ramble_marks.includes(c), c);
});

test("outbox door: an MCP-process write (no manager) lands in sync_outbox", async () => {
  const row = await createMark(a, {
    author: "a".repeat(64), author_level: "rotating", kind: "mark", visibility: "public", reveal: "open",
    anchor: { anchor_kind: "geo", lat: 30.2672, lon: -97.7431, accuracy_m: 75 }, content: { content_text: "queued" },
  });
  const res = await emitOrQueue(null, a, "ramble_marks", "insert", row);
  assert.ok(res && res.queued, "emitOrQueue returned null — the stamp batch failed (missing lamport_ts?)");
  // Scoped to this table so the count can't be coupled to what later tests queue.
  const { rows } = await a.execute("SELECT table_name, op FROM sync_outbox WHERE table_name = 'ramble_marks'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].table_name, "ramble_marks");
});

test("apply door: insert lands on B as origin=sync, LWW by lamport, delete by mark_id", async () => {
  const row = { mark_id: "m9", author: "pk1", kind: "mark", anchor_kind: "geo", geohash: "9v6", visibility: "public", reveal: "open", content_text: "hi", created_at: 1000 };
  await applyRemoteOp(b, "ramble_marks", "insert", row, 5);
  let got = await b.execute({ sql: "SELECT content_text, origin, publish_state, lamport_ts FROM ramble_marks WHERE mark_id=?", args: ["m9"] });
  assert.equal(got.rows[0].content_text, "hi");
  assert.equal(got.rows[0].origin, "sync");       // C2: the peer's drain must never publish this
  assert.equal(got.rows[0].publish_state, "synced");
  assert.equal(got.rows[0].lamport_ts, 5);
  await applyRemoteOp(b, "ramble_marks", "update", { ...row, content_text: "stale" }, 3); // older → ignored
  // Assert the skip HERE: without it, "stale" would land and then be masked by
  // the "newer" write below, leaving the final assertion green either way.
  got = await b.execute({ sql: "SELECT content_text FROM ramble_marks WHERE mark_id=?", args: ["m9"] });
  assert.equal(got.rows[0].content_text, "hi", "an older mark op overwrote a newer local row");
  await applyRemoteOp(b, "ramble_marks", "update", { ...row, content_text: "newer" }, 7);
  got = await b.execute({ sql: "SELECT content_text FROM ramble_marks WHERE mark_id=?", args: ["m9"] });
  assert.equal(got.rows[0].content_text, "newer");
  await applyRemoteOp(b, "ramble_marks", "delete", { mark_id: "m9" }, 8);
  got = await b.execute({ sql: "SELECT 1 FROM ramble_marks WHERE mark_id=?", args: ["m9"] });
  assert.equal(got.rows.length, 0);
});

test("settings + blocks apply by natural key (idempotent, no UNIQUE throw)", async () => {
  await applyRemoteOp(b, "ramble_settings", "update", { key: "public_identity_level", value: "pseudonym" }, 1);
  await applyRemoteOp(b, "ramble_settings", "update", { key: "public_identity_level", value: "real" }, 2);
  const got = await b.execute({ sql: "SELECT value FROM ramble_settings WHERE key=?", args: ["public_identity_level"] });
  assert.equal(got.rows[0].value, "real");
  await applyRemoteOp(b, "ramble_blocks", "insert", { persona: "b".repeat(64), reason: "x", created_at: 1 }, 1);
  await applyRemoteOp(b, "ramble_blocks", "insert", { persona: "b".repeat(64), reason: "x", created_at: 1 }, 1);
  await applyRemoteOp(b, "ramble_blocks", "delete", { persona: "b".repeat(64) }, 2);
  assert.equal((await b.execute("SELECT 1 FROM ramble_blocks")).rows.length, 0);

  // LWW skip must hold for these two tables too, not just for marks: an op
  // older than the local row's lamport is dropped, it does not overwrite.
  await applyRemoteOp(b, "ramble_settings", "update", { key: "public_identity_level", value: "pseudonym" }, 1);
  const afterStale = await b.execute({ sql: "SELECT value FROM ramble_settings WHERE key=?", args: ["public_identity_level"] });
  assert.equal(afterStale.rows[0].value, "real", "an older settings op overwrote a newer local value");

  const p = "d".repeat(64);
  await applyRemoteOp(b, "ramble_blocks", "insert", { persona: p, reason: "a", created_at: 1 }, 5);
  await applyRemoteOp(b, "ramble_blocks", "update", { persona: p, reason: "b", created_at: 1 }, 3); // older → ignored
  const block = await b.execute({ sql: "SELECT reason, lamport_ts FROM ramble_blocks WHERE persona=?", args: [p] });
  assert.equal(block.rows[0].reason, "a", "an older block op overwrote a newer local row");
  assert.equal(Number(block.rows[0].lamport_ts), 5);
});

test("R9: an id-less natural-key table is lamport-stamped locally on emit", async () => {
  // ramble_blocks has no `id` column — without stampSql's by-persona branch the
  // outbox row would carry the lamport while the source row kept 0, making the
  // apply side's LWW one-sided (a remote op would always beat a newer local edit).
  const persona = "c".repeat(64);
  await blockPersona(a, persona, "x", { emit: (t, op, r) => emitOrQueue(null, a, t, op, r) });

  const local = await a.execute({
    sql: "SELECT lamport_ts FROM ramble_blocks WHERE persona = ?", args: [persona],
  });
  assert.ok(Number(local.rows[0].lamport_ts) > 0, "local ramble_blocks row was never stamped");

  const queued = await a.execute({
    sql: "SELECT lamport_ts FROM sync_outbox WHERE table_name = ?", args: ["ramble_blocks"],
  });
  assert.equal(queued.rows.length, 1);
  // Same atomic batch → the row and its outbox entry must agree.
  assert.equal(Number(queued.rows[0].lamport_ts), Number(local.rows[0].lamport_ts));
});

test("shouldSyncRow gates: local.* settings and keyless rows never sync", async () => {
  // Ruling R3 — per-instance settings stay on the device that wrote them.
  assert.equal(shouldSyncRow("ramble_settings", { key: "local.active_area", value: "[]" }), false);
  assert.equal(shouldSyncRow("ramble_settings", { key: "local.session_id" }), false);
  assert.equal(shouldSyncRow("ramble_settings", { key: "public_identity_level", value: "real" }), true);

  // A row without its natural key can be neither stamped, applied nor deleted
  // on a peer — rejected for all three tables, on emit AND on apply (this
  // function is the shared choke point for both).
  assert.equal(shouldSyncRow("ramble_marks", { author: "x" }), false);
  assert.equal(shouldSyncRow("ramble_blocks", { reason: "x" }), false);
  assert.equal(shouldSyncRow("ramble_settings", { value: "x" }), false);

  // The emit side actually honours it: emitOrQueue's syncability-parity check
  // must drop a local.* setting rather than queue it for the drain.
  // (Runs after the outbox-door test, which is what creates sync_outbox on `a`.)
  const res = await emitOrQueue(null, a, "ramble_settings", "update", { key: "local.active_area", value: "[]" });
  assert.equal(res, null, "a local.* setting was queued instead of being dropped");
  const { rows } = await a.execute("SELECT 1 FROM sync_outbox WHERE table_name = 'ramble_settings'");
  assert.equal(rows.length, 0);
});

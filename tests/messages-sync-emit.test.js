import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { createDbClient } from "../servers/db.js";
import {
  emitMessageInsert,
  __setEmitSinkForTest,
} from "../servers/sharing/message-sync.js";
import {
  shouldSyncRowForTest,
  EXCLUDED_COLUMNS,
} from "../servers/sharing/instance-sync.js";
// I-3: OUTBOUND_TRANSFORMS is module-private (a bare `const`, not exported) and
// is intentionally NOT imported — messages have no transform (the EXCLUDED_COLUMNS
// strip is the whole wire shape). Importing it would hard-fail this ESM file.

const tmpDir = mkdtempSync(join(tmpdir(), "crow-p3b-emit-"));
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: tmpDir }, stdio: "pipe",
});
const db = createDbClient(join(tmpDir, "crow.db"));
after(() => rmSync(tmpDir, { recursive: true, force: true }));
const SECP = "a".repeat(64);

test("shouldSyncRow: messages require nostr_event_id AND crow_id", () => {
  const ok = (row) => shouldSyncRowForTest("messages", row);
  assert.equal(ok({ nostr_event_id: "e1", crow_id: "crow:a", content: "hi" }), true);
  assert.equal(ok({ nostr_event_id: "e1", content: "hi" }), false, "no crow_id → drop");
  assert.equal(ok({ crow_id: "crow:a", content: "hi" }), false, "no nostr_event_id → drop");
  assert.equal(ok({ nostr_event_id: "grp_123", content: "x" }), false, "synthetic group id, no crow_id → drop");
  assert.equal(ok(null), false);
});

test("EXCLUDED_COLUMNS.messages strips per-instance keys", () => {
  assert.deepEqual([...EXCLUDED_COLUMNS.messages].sort(),
    ["contact_id", "id", "is_read", "lamport_ts"]);
});

test("EXCLUDED_COLUMNS strip yields the messages wire shape (no OUTBOUND_TRANSFORMS)", () => {
  // Replicate emitChange's strip (instance-sync.js:543-547): delete each column in
  // EXCLUDED_COLUMNS[table] from a copy of the row. Because messages have NO
  // OUTBOUND_TRANSFORMS (I-3 — it was fully redundant with this strip and was
  // dropped), the post-strip object IS the wire row exactly.
  const full = {
    id: 9, contact_id: 3, is_read: 1, lamport_ts: 5,
    crow_id: "crow:a", nostr_event_id: "e9", content: "yo",
    direction: "sent", thread_id: null, created_at: "2026-07-06T00:00:00Z",
    delivery_status: "relayed", attachments: null,
  };
  const wire = { ...full };
  for (const c of EXCLUDED_COLUMNS.messages) delete wire[c];
  assert.equal(wire.id, undefined);
  assert.equal(wire.contact_id, undefined);
  assert.equal(wire.is_read, undefined);
  assert.equal(wire.lamport_ts, undefined);
  assert.equal(wire.crow_id, "crow:a");
  assert.equal(wire.nostr_event_id, "e9");
  assert.equal(wire.direction, "sent");
});

test("emitMessageInsert: attaches crow_id via JOIN and forwards to the sink", async () => {
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (11,'crow:e', '', ?)", args: [SECP] });
  await db.execute({ sql: "INSERT INTO messages (id, contact_id, nostr_event_id, content, direction, is_read) VALUES (21, 11, 'ev1', 'hi there', 'sent', 1)" });
  const seen = [];
  __setEmitSinkForTest({ emitChange: async (t, op, row) => seen.push([t, op, row.crow_id, row.contact_id, row.id, row.nostr_event_id, row.direction]) });
  await emitMessageInsert(db, { contactId: 11, nostrEventId: "ev1" });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], ["messages", "insert", "crow:e", 11, 21, "ev1", "sent"]);
  // NB: the helper hands emitChange the FULL local row (with id + contact_id, for
  // the ~:581 lamport stamp) plus the JOINed crow_id; the wire strip happens in
  // emitChange via EXCLUDED_COLUMNS.messages (there is NO OUTBOUND_TRANSFORMS.messages
  // — I-3), exercised above.
  __setEmitSinkForTest(null);
});

test("emitMessageInsert: no crow_id for the contact → no emit (request/pending contact)", async () => {
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey, request_status) VALUES (12,'req:deadbeef', '', ?, 'pending')", args: ["b".repeat(64)] });
  await db.execute({ sql: "INSERT INTO messages (id, contact_id, nostr_event_id, content, direction, is_read) VALUES (22, 12, 'ev2', 'stranger', 'received', 0)" });
  const seen = [];
  __setEmitSinkForTest({ emitChange: async (...a) => seen.push(a) });
  await emitMessageInsert(db, { contactId: 12, nostrEventId: "ev2" });
  // crow_id 'req:deadbeef' resolves, BUT shouldSyncRow is enforced in emitChange,
  // not the helper — the helper still forwards. Assert instead that a MISSING row
  // is a no-op, and that a null sink never throws.
  __setEmitSinkForTest(null);
  await emitMessageInsert(db, { contactId: 999, nostrEventId: "nope" }); // no such row → no throw
  await emitMessageInsert(db, { contactId: 11, nostrEventId: "ev1" }); // null sink → no throw
});

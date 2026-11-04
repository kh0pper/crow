// Task 4 of the Crow-to-Crow plan: the outbox (at-least-once, FIFO per stream,
// acked by the peer) and the inbound sequencing contract (R1–R8 at the top of
// servers/sharing/c2c/outbox.js). Two scratch DB files stand in for the owner's
// Crow and the contact's Crow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { C2C_TABLES_SQL } from "../scripts/migrations/0016-crow-to-crow.mjs";
import {
  enqueue, flush, onAck, onRefuse, acceptInbound, commitInbound, consumeInbound,
  pruneAcked, streamOf, withTransaction, BUSY_HOLD_MS,
  cancelEpoch,
} from "../servers/sharing/c2c/outbox.js";

const P1 = "1".repeat(32);
const P2 = "2".repeat(32);
const EPOCH = "e".repeat(32);
const NEW_EPOCH = "0".repeat(32); // a different membership, byte-wise LOWER than EPOCH: epochs compare only for equality (R3)
const CONTACT = 1;
const OTHER_CONTACT = 2;
const LOCAL = "inst-local";
const PEER = "inst-peer";
const SIBLING = "inst-sibling";
const WILDCARD = "*";

/** A scratch crow.db with the real 0016 c2c DDL and the tables it references. */
async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "c2c-outbox-"));
  const dbPath = join(dir, "crow.db");
  const db = createDbClient(dbPath);
  await db.executeMultiple(`
    CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, crow_id TEXT);
    CREATE TABLE project_spaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, uuid TEXT);
    CREATE TABLE project_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, contact_id INTEGER,
      role TEXT NOT NULL, mode TEXT, capabilities TEXT, uuid TEXT, origin_instance_id TEXT,
      accepted_at TEXT, granted_at TEXT NOT NULL DEFAULT (datetime('now')), revoked_at TEXT);
    CREATE TABLE c2c_effect_probe (seq INTEGER NOT NULL);
  `);
  await db.executeMultiple(C2C_TABLES_SQL);
  await db.executeMultiple("INSERT INTO contacts (name) VALUES ('peer-a'), ('peer-b')");
  return {
    dir, dbPath, db,
    close() { try { db.close(); } catch {} },
    dispose() { this.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

// A scratch that is always cleaned up, even when the test fails.
async function withDb(fn) {
  const s = await fresh();
  try {
    return await fn(s);
  } finally {
    s.dispose();
  }
}

// A sender's Crow and a receiver's Crow, both cleaned up.
async function withPair(fn) {
  const owner = await fresh();
  const peer = await fresh();
  try {
    return await fn(owner, peer);
  } finally {
    owner.dispose();
    peer.dispose();
  }
}

const enq = (db, over = {}) => enqueue(db, {
  contactId: CONTACT,
  projectUuid: P1,
  kind: "project.role",
  epoch: EPOCH,
  toInstanceId: PEER,
  body: { role: "viewer" },
  localInstanceId: LOCAL,
  ...over,
});

const invite = (over = {}) => ({
  kind: "project.invite",
  toInstanceId: null, // an invite before the visitor is known: stream "*"
  body: { name: "Labs", role: "viewer", owner_instance_id: LOCAL },
  ...over,
});

const rowsOf = async (db, contactId = CONTACT) => (await db.execute({
  sql: `SELECT project_uuid, to_instance_id, seq, kind, acked_at, attempts, last_attempt_at,
               last_refusal, frame_json
          FROM c2c_outbox WHERE contact_id = ? ORDER BY project_uuid, seq, COALESCE(to_instance_id, '*')`,
  args: [contactId],
})).rows;

/**
 * The frame the outbox actually stored (the wire envelope, not the caller's input).
 * `toInstanceId` narrows to one stream, since a seq is only unique inside a stream.
 */
const frameAt = async (db, seq, { projectUuid = P1, toInstanceId } = {}) => {
  const byStream = toInstanceId !== undefined;
  const rows = (await db.execute({
    sql: `SELECT frame_json FROM c2c_outbox
           WHERE contact_id = ? AND project_uuid = ? AND seq = ?
             ${byStream ? "AND COALESCE(to_instance_id, '*') = ?" : ""}
           ORDER BY id LIMIT 1`,
    args: byStream
      ? [CONTACT, projectUuid, seq, streamOf(toInstanceId)]
      : [CONTACT, projectUuid, seq],
  })).rows;
  return rows.length ? JSON.parse(rows[0].frame_json) : null;
};

/** An inbound mark address taken from a delivered frame (R1: the frame's stream). */
const at = (frame, over = {}) => ({
  contactId: CONTACT,
  senderInstanceId: LOCAL,
  projectUuid: frame.project_uuid,
  stream: streamOf(frame.to_instance_id),
  seq: frame.seq,
  epoch: frame.epoch,
  kind: frame.kind,
  ...over,
});

/** Deliver one stored frame to a receiving Crow, committing it when it is new. */
async function deliverFrame(owner, receiver, seq, opts = {}) {
  const addr = at(await frameAt(owner.db, seq, opts));
  const verdict = await acceptInbound(receiver.db, addr);
  if (verdict === "new") {
    assert.equal(await commitInbound(receiver.db, addr), true, `seq ${seq} committed`);
  }
  return verdict;
}

/* ---------------------------------------------------------------- outbound */

test("seqs are per contact, project and stream and start at 1", async () => {
  await withDb(async ({ db }) => {
    assert.equal(await enq(db), 1);
    assert.equal(await enq(db), 2);
    assert.equal(await enq(db, { projectUuid: P2 }), 1, "a new project starts at 1");
    assert.equal(await enq(db, { contactId: OTHER_CONTACT }), 1, "a new contact starts at 1");
    assert.equal(await enq(db), 3, "the first stream keeps counting");
    // R1: a frame with no target instance is its own stream.
    assert.equal(await enq(db, { toInstanceId: null }), 1, "the '*' stream starts at 1");
    assert.equal(await enq(db, { toInstanceId: SIBLING }), 1, "a sibling stream starts at 1");
    assert.equal(await enq(db, { toInstanceId: null }), 2);
    assert.equal(await enq(db), 4, "another stream never moves this one");

    const frame = await frameAt(db, 1, { toInstanceId: PEER });
    assert.equal(frame.seq, 1);
    assert.equal(frame.epoch, EPOCH);
    assert.equal(frame.project_uuid, P1);
    assert.equal(frame.from_instance_id, LOCAL);
    assert.equal(frame.to_instance_id, PEER);
    assert.deepEqual(frame.body, { role: "viewer" });
  });
});

test("two concurrent enqueues get different seqs", async () => {
  await withDb(async ({ db }) => {
    const five = await Promise.all(Array.from({ length: 5 }, () => enq(db)));
    assert.deepEqual([...five].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
    assert.deepEqual((await rowsOf(db)).map((r) => r.seq), [1, 2, 3, 4, 5]);
  });
});

test("an enqueue inside withTransaction joins it and rolls back with it", async () => {
  await withDb(async ({ db }) => {
    await assert.rejects(
      withTransaction(db, async () => {
        assert.equal(await enq(db), 1);
        assert.equal(await enq(db), 2);
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal((await rowsOf(db)).length, 0, "the frames went back with the transaction");
    assert.equal(await enq(db), 1, "and the stream counter rolled back too (R2)");
  });
});

/* --------------------------------------------------- R7: no implicit joining */

test("enqueue never joins a transaction the caller opened by hand", async () => {
  await withDb(async ({ db }) => {
    await db.execute("BEGIN IMMEDIATE");
    // R7: a failing BEGIN IMMEDIATE is an error, not a cue to join the caller's transaction.
    await assert.rejects(() => enq(db), /transaction/i);
    await db.execute("ROLLBACK");
    assert.equal((await rowsOf(db)).length, 0);
    assert.equal(await enq(db), 1, "the stream counter was not burned");
  });
});

test("work scheduled inside withTransaction does not join a later transaction", async () => {
  await withDb(async ({ db }) => {
    let deferred;
    await withTransaction(db, async () => {
      // Captures this transaction's async context but runs after it has committed.
      deferred = new Promise((resolve) => {
        setImmediate(() => {
          enq(db).then((seq) => resolve({ seq }), (err) => resolve({ err }));
        });
      });
    });
    // An unrelated transaction is open by the time the deferred work runs. If the
    // dead token still read "live", the enqueue would quietly land in this one and
    // vanish on ROLLBACK; R7 says it must open its own (and fail on the busy handle).
    await db.execute("BEGIN IMMEDIATE");
    const r = await deferred;
    await db.execute("ROLLBACK");
    assert.ok(r.err, `the deferred enqueue must not join: ${JSON.stringify(r)}`);
    assert.equal((await rowsOf(db)).length, 0);
    assert.equal(await enq(db), 1, "the counter survives");
  });
});

test("enqueue refuses an unsequenced kind and an invalid frame", async () => {
  await withDb(async ({ db }) => {
    await assert.rejects(
      () => enq(db, { kind: "project.ack", body: { seqs: [1] } }),
      (err) => err.code === "bad_argument",
    );
    await assert.rejects(
      () => enq(db, { body: { role: "owner" } }),
      (err) => err.code === "bad_frame",
    );
    assert.equal((await rowsOf(db)).length, 0);
    assert.equal(await enq(db), 1, "a refused frame never burns a seq");
  });
});

test("flush sends unacked frames in seq order and skips acked ones", async () => {
  await withDb(async ({ db }) => {
    await enq(db);                                             // P1 seq 1
    await enq(db);                                             // P1 seq 2
    await enq(db, { kind: "project.unshare", body: {} });      // P1 seq 3
    await enq(db, { projectUuid: P2 });                        // P2 seq 1
    assert.equal(await onAck(db, { contactId: CONTACT, projectUuid: P1, seqs: [2] }), 1);

    const sent = [];
    const n = await flush(db, (f) => { sent.push(f); }, { contactId: CONTACT });
    assert.equal(n, 3);
    assert.deepEqual(sent.map((f) => `${f.project_uuid}:${f.seq}`), [`${P1}:1`, `${P1}:3`, `${P2}:1`]);

    const rows = await rowsOf(db);
    const ackedRow = rows.find((r) => r.project_uuid === P1 && r.seq === 2);
    assert.ok(ackedRow.acked_at, "the acked row was not resent");
    assert.equal(ackedRow.attempts, 0, "an acked row takes no attempt");
    assert.equal(ackedRow.last_attempt_at, null);
    for (const r of rows.filter((x) => x !== ackedRow)) {
      assert.equal(r.attempts, 1);
      assert.ok(r.last_attempt_at, "the attempt is recorded");
    }

    // Nothing left to send once the peer has acked the rest.
    await onAck(db, { contactId: CONTACT, projectUuid: P1, seqs: [1, 3] });
    await onAck(db, { contactId: CONTACT, projectUuid: P2, seqs: [1] });
    assert.equal(await flush(db, () => { throw new Error("should not send"); }, { contactId: CONTACT }), 0);
  });
});

test("flush holds a project behind an unreadable row (R8)", async () => {
  await withDb(async ({ db }) => {
    await enq(db);                      // P1 seq 1
    await enq(db);                      // P1 seq 2
    await enq(db, { projectUuid: P2 }); // P2 seq 1
    await db.execute({
      sql: "UPDATE c2c_outbox SET frame_json = 'not a frame' WHERE project_uuid = ? AND seq = 1",
      args: [P1],
    });

    const sent = [];
    const n = await flush(db, (f) => { sent.push(`${f.project_uuid}:${f.seq}`); }, { contactId: CONTACT });
    assert.equal(n, 1);
    assert.deepEqual(sent, [`${P2}:1`], "P1 seq 2 is never sent past the hole; other projects still go");

    const behindTheHole = (await rowsOf(db)).find((r) => r.project_uuid === P1 && r.seq === 2);
    assert.equal(behindTheHole.attempts, 0, "the row behind the hole takes no attempt");
    assert.equal(behindTheHole.acked_at, null, "and stays queued");
  });
});

test("flush stops at the first send error and keeps the rest queued", async () => {
  await withDb(async ({ db }) => {
    await enq(db);
    await enq(db);
    let calls = 0;
    const n = await flush(db, () => { calls += 1; throw new Error("Not connected to peer"); }, { contactId: CONTACT });
    assert.equal(n, 0);
    assert.equal(calls, 1, "the later frames are not even attempted");
    const rows = await rowsOf(db);
    assert.deepEqual(rows.map((r) => r.attempts), [0, 0]);
  });
});

test("not_home keeps the frame; forbidden ends it", async () => {
  await withDb(async ({ db }) => {
    const seq = await enq(db);
    await flush(db, () => {}, { contactId: CONTACT });

    // The wrong (paired sibling) instance answered: the frame waits for the target.
    assert.equal(await onRefuse(db, { contactId: CONTACT, projectUuid: P1, seq, reason: "not_home" }), null);
    let [row] = await rowsOf(db);
    assert.equal(row.acked_at, null);
    assert.equal(row.last_refusal, "not_home");
    const resent = [];
    assert.equal(await flush(db, (f) => { resent.push(f.seq); }, { contactId: CONTACT }), 1);
    assert.deepEqual(resent, [seq], "a not_home frame is still delivered later");

    // Terminal: the frame can never apply, so it leaves the queue for good.
    assert.equal(await onRefuse(db, { contactId: CONTACT, projectUuid: P1, seq, reason: "forbidden" }), "forbidden");
    [row] = await rowsOf(db);
    assert.ok(row.acked_at);
    assert.equal(row.last_refusal, "forbidden");
    assert.equal(await flush(db, () => { throw new Error("should not send"); }, { contactId: CONTACT }), 0);
  });
});

test("every holding refusal keeps the frame and every terminal one ends it", async () => {
  await withDb(async ({ db }) => {
    for (const reason of ["not_home", "busy", "gap", "update_required"]) {
      const seq = await enq(db, { kind: "project.role", body: { role: "editor" } });
      assert.equal(await onRefuse(db, { contactId: CONTACT, projectUuid: P1, seq, reason }), null, reason);
    }
    const held = await rowsOf(db);
    assert.deepEqual(held.map((r) => r.acked_at), [null, null, null, null]);
    assert.deepEqual(held.map((r) => r.last_refusal), ["not_home", "busy", "gap", "update_required"]);

    for (const reason of ["forbidden", "stale_epoch", "unsupported", "bad_frame"]) {
      const seq = await enq(db, { projectUuid: P2 });
      assert.equal(await onRefuse(db, { contactId: CONTACT, projectUuid: P2, seq, reason }), reason, reason);
      const ended = (await db.execute({
        sql: "SELECT acked_at FROM c2c_outbox WHERE contact_id = ? AND project_uuid = ? AND seq = ?",
        args: [CONTACT, P2, seq],
      })).rows[0];
      assert.ok(ended.acked_at, `${reason} ends the frame`);
    }
  });
});

test("update_required holds: the next flush re-sends the frame (R5)", async () => {
  await withDb(async ({ db }) => {
    const seq = await enq(db);
    await flush(db, () => {}, { contactId: CONTACT });
    assert.equal(await onRefuse(db, { contactId: CONTACT, projectUuid: P1, seq, reason: "update_required" }), null);
    const [row] = await rowsOf(db);
    assert.equal(row.acked_at, null, "the sender keeps the frame until the peer updates");

    const resent = [];
    assert.equal(await flush(db, (f) => { resent.push(f.seq); }, { contactId: CONTACT }), 1);
    assert.deepEqual(resent, [seq]);
  });
});

test("busy holds the project's run for 60 s", async () => {
  await withDb(async ({ db }) => {
    const seq1 = await enq(db);
    const seq2 = await enq(db);
    await enq(db, { projectUuid: P2 });                 // another project is unaffected
    await flush(db, () => {}, { contactId: CONTACT });  // record the attempts

    await onRefuse(db, { contactId: CONTACT, projectUuid: P1, seq: seq1, reason: "busy" });
    const attemptedAt = Date.parse(
      (await rowsOf(db))[0].last_attempt_at.replace(" ", "T") + "Z",
    );

    // Inside the window: the whole P1 run waits, P2 still goes out.
    const soon = [];
    assert.equal(await flush(db, (f) => { soon.push(f.project_uuid); }, { contactId: CONTACT, now: attemptedAt + 1000 }), 1);
    assert.deepEqual(soon, [P2]);
    await onAck(db, { contactId: CONTACT, projectUuid: P2, seqs: [1] });

    // Once the window has passed, P1 resumes in order (seq1 was never acked).
    const later = [];
    assert.equal(
      await flush(db, (f) => { later.push(f.seq); }, { contactId: CONTACT, now: attemptedAt + BUSY_HOLD_MS + 1000 }),
      2,
    );
    assert.deepEqual(later, [seq1, seq2]);
  });
});

test("pruneAcked drops only old acked rows", async () => {
  await withDb(async ({ db }) => {
    await enq(db);
    await enq(db);
    await enq(db);
    await onAck(db, { contactId: CONTACT, projectUuid: P1, seqs: [1, 2] });
    await db.execute({ sql: "UPDATE c2c_outbox SET acked_at = datetime('now', '-40 days') WHERE seq = 1", args: [] });

    assert.equal(await pruneAcked(db), 1);
    assert.deepEqual((await rowsOf(db)).map((r) => r.seq), [2, 3], "a recent ack and the unacked row stay");

    await db.execute({ sql: "UPDATE c2c_outbox SET acked_at = datetime('now', '-2 days') WHERE seq = 2", args: [] });
    assert.equal(await pruneAcked(db, { olderThanDays: 60 }), 0);
    assert.equal(await pruneAcked(db, { olderThanDays: 1 }), 1, "seq 2 is acked and older than a day");
    assert.deepEqual((await rowsOf(db)).map((r) => r.seq), [3], "an unacked row is never pruned");
  });
});

test("pruneAcked keeps the stream counter: the next seq is new on the receiver (R2)", async () => {
  await withPair(async (owner, peer) => {
    assert.equal(await enq(owner.db), 1);
    // The receiver applied seq 1 before the ack; the sender then pruned the row.
    const first = await frameAt(owner.db, 1);
    await onAck(owner.db, { contactId: CONTACT, projectUuid: P1, seqs: [1] });
    await owner.db.execute({ sql: "UPDATE c2c_outbox SET acked_at = datetime('now', '-40 days') WHERE seq = 1", args: [] });
    assert.equal(await pruneAcked(owner.db), 1, "the acked row is gone");
    assert.equal(await frameAt(owner.db, 1), null, "seq 1 really was pruned");

    // MAX(seq) over c2c_outbox is no longer the counter, so seq 1 is not reissued.
    const next = await enq(owner.db);
    assert.equal(next, 2);

    assert.equal(await acceptInbound(peer.db, at(first)), "new");
    assert.equal(await commitInbound(peer.db, at(first)), true);
    const frame = await frameAt(owner.db, next);
    assert.equal(await acceptInbound(peer.db, at(frame)), "new");
    assert.equal(await commitInbound(peer.db, at(frame)), true);
  });
});

/* ----------------------------------------------------------------- inbound */

const where = (over = {}) => ({
  contactId: CONTACT, senderInstanceId: LOCAL, projectUuid: P1,
  stream: PEER, seq: 1, epoch: EPOCH, kind: "project.role", ...over,
});

test("acceptInbound: dup, new, gap", async () => {
  await withDb(async ({ db }) => {
    assert.equal(await acceptInbound(db, where({ seq: 1 })), "new");
    assert.equal(await commitInbound(db, where({ seq: 1 })), true);
    assert.equal(await acceptInbound(db, where({ seq: 1 })), "dup");
    assert.equal(await acceptInbound(db, where({ seq: 2 })), "new");
    assert.equal(await commitInbound(db, where({ seq: 2 })), true);
    assert.equal(await acceptInbound(db, where({ seq: 2 })), "dup");
    assert.equal(await acceptInbound(db, where({ seq: 3 })), "new");
    assert.equal(await acceptInbound(db, where({ seq: 5 })), "gap", "a hole ahead of it");
    assert.equal(await acceptInbound(db, where({ seq: 9 })), "gap");

    // The mark is per (contact, sender instance, project, stream), so a sibling
    // instance, another project, another contact or another stream starts at 1.
    assert.equal(await acceptInbound(db, where({ seq: 1, senderInstanceId: "inst-sibling" })), "new");
    assert.equal(await acceptInbound(db, where({ seq: 1, projectUuid: P2 })), "new");
    assert.equal(await acceptInbound(db, where({ seq: 1, contactId: OTHER_CONTACT })), "new");
    assert.equal(await acceptInbound(db, where({ seq: 1, stream: WILDCARD })), "new");
    assert.equal(await acceptInbound(db, where({ seq: 1, stream: SIBLING })), "new");
  });
});

test("commitInbound refuses an out-of-order seq and never rewinds the mark", async () => {
  await withDb(async ({ db }) => {
    assert.equal(await commitInbound(db, where({ seq: 3 })), false, "seq 3 with the mark at 0 is a hole");
    assert.equal(await acceptInbound(db, where({ seq: 1 })), "new");
    assert.equal(await commitInbound(db, where({ seq: 1 })), true);
    assert.equal(await commitInbound(db, where({ seq: 3 })), false);
    assert.equal(await commitInbound(db, where({ seq: 1 })), false, "already taken: a dup");
    assert.equal(await commitInbound(db, where({ seq: 2 })), true);
    assert.equal(await acceptInbound(db, where({ seq: 3 })), "new");
    assert.equal(await acceptInbound(db, where({ seq: 2 })), "dup", "below the mark: applied already");
  });
});

test("an invite with a newer epoch resets the stream whatever its seq (R3)", async () => {
  await withDb(async ({ db }) => {
    const inviteAt = (over) => where({ stream: WILDCARD, kind: "project.invite", ...over });
    assert.equal(await acceptInbound(db, inviteAt({ seq: 1 })), "new");
    assert.equal(await commitInbound(db, inviteAt({ seq: 1 })), true);
    assert.equal(await commitInbound(db, where({ stream: WILDCARD, seq: 2 })), true);

    // The re-invite jumps to seq 9: a newer epoch makes it new, not a gap.
    assert.equal(await acceptInbound(db, inviteAt({ seq: 9, epoch: NEW_EPOCH })), "new");
    assert.equal(await commitInbound(db, inviteAt({ seq: 9, epoch: NEW_EPOCH })), true);
    assert.equal(await acceptInbound(db, inviteAt({ seq: 9, epoch: NEW_EPOCH })), "dup", "applied once");
    // The stream restarted at 9 and carries the new epoch.
    assert.equal(await acceptInbound(db, where({ stream: WILDCARD, seq: 10, epoch: NEW_EPOCH })), "new");
    // The same epoch is not "newer": an invite that skips ahead is still a gap.
    assert.equal(await acceptInbound(db, inviteAt({ seq: 12, epoch: NEW_EPOCH })), "gap");
  });
});

test("a frame from an epoch the receiver has left is stale (R3)", async () => {
  await withDb(async ({ db }) => {
    await commitInbound(db, where({ stream: WILDCARD, seq: 1, kind: "project.invite" }));
    await commitInbound(db, where({ stream: WILDCARD, seq: 4, epoch: NEW_EPOCH, kind: "project.invite" }));
    // seq 5 is the next one, but it belongs to the abandoned epoch.
    assert.equal(await acceptInbound(db, where({ stream: WILDCARD, seq: 5, epoch: EPOCH })), "stale");
    assert.equal(await acceptInbound(db, where({ stream: WILDCARD, seq: 5, epoch: NEW_EPOCH })), "new");
  });
});

test("a terminal refusal consumes the seq, so the next frame is not wedged (R4)", async () => {
  await withDb(async ({ db }) => {
    // Task 5 refused seq 1 as stale_epoch before its effect ran: consume instead.
    assert.equal(await acceptInbound(db, where({ seq: 1 })), "new");
    assert.equal(await consumeInbound(db, where({ seq: 1 })), true);
    assert.equal(await acceptInbound(db, where({ seq: 1 })), "dup", "the seq is gone");
    assert.equal(await acceptInbound(db, where({ seq: 2 })), "new", "and the frames after it flow");

    // Consumption obeys R6 too: it takes only the next seq.
    assert.equal(await consumeInbound(db, where({ seq: 4 })), false);
    assert.equal(await acceptInbound(db, where({ seq: 4 })), "gap");

    // A real stale_epoch: the mark carries a newer epoch, so seq 2 of the old one is
    // refused (R3); consuming it (R4) lets the new epoch's frames behind it flow.
    const s = { stream: WILDCARD };
    assert.equal(await commitInbound(db, where({ ...s, seq: 1, epoch: NEW_EPOCH, kind: "project.invite" })), true);
    assert.equal(await acceptInbound(db, where({ ...s, seq: 2, epoch: EPOCH })), "stale");
    assert.equal(await consumeInbound(db, where({ ...s, seq: 2 })), true);
    assert.equal(await acceptInbound(db, where({ ...s, seq: 3, epoch: NEW_EPOCH })), "new");
    assert.equal(await commitInbound(db, where({ ...s, seq: 3, epoch: NEW_EPOCH })), true);
  });
});

test("two concurrent deliveries of one seq apply once (R6)", async () => {
  await withDb(async ({ db }) => {
    const count = async () => (await db.execute("SELECT COUNT(*) AS n FROM c2c_effect_probe")).rows[0].n;
    const deliver = () => withTransaction(db, async () => {
      // The effect and the mark share the transaction (the receive pipeline's shape).
      await db.execute({ sql: "INSERT INTO c2c_effect_probe (seq) VALUES (?)", args: [1] });
      if (!await commitInbound(db, where({ seq: 1 }))) throw new Error("dup");
    }).then(() => true, (err) => {
      assert.match(err.message, /dup/);
      return false;
    });

    const [a, b] = await Promise.all([deliver(), deliver()]);
    assert.deepEqual([a, b].sort(), [false, true], "exactly one delivery took the seq");
    assert.equal(await count(), 1, "the effect was applied once");
    assert.equal(await acceptInbound(db, where({ seq: 1 })), "dup");
  });
});

test("the frame's effect and the high-water advance commit or roll back together", async () => {
  await withDb(async ({ db }) => {
    const probeCount = async () => (await db.execute("SELECT COUNT(*) AS n FROM c2c_effect_probe")).rows[0].n;

    // Rolled back: neither the effect nor the mark survives.
    await assert.rejects(withTransaction(db, async () => {
      await db.execute({ sql: "INSERT INTO c2c_effect_probe (seq) VALUES (?)", args: [1] });
      assert.equal(await commitInbound(db, where({ seq: 1 })), true);
      throw new Error("pipeline failed after the mark");
    }), /pipeline failed/);
    assert.equal(await probeCount(), 0);
    assert.equal(await acceptInbound(db, where({ seq: 1 })), "new", "the mark went back with the effect");

    // Committed: both are there, and a re-delivery is a dup.
    await withTransaction(db, async () => {
      await db.execute({ sql: "INSERT INTO c2c_effect_probe (seq) VALUES (?)", args: [1] });
      assert.equal(await commitInbound(db, where({ seq: 1 })), true);
    });
    assert.equal(await probeCount(), 1);
    assert.equal(await acceptInbound(db, where({ seq: 1 })), "dup");
  });
});

/* ------------------------------------------------- Review Focus 1 (plan 1) */

test("Review Focus 1: unshare then a re-invite with a newer epoch resets the stream", async () => {
  await withPair(async (owner, peer) => {
    const applied = [];
    const deliver = async (seq) => {
      const addr = at(await frameAt(owner.db, seq));
      const verdict = await acceptInbound(peer.db, addr);
      if (verdict === "new") {
        assert.equal(await commitInbound(peer.db, addr), true, `seq ${seq} committed`);
        applied.push(seq);
      } else if (verdict === "stale") {
        await consumeInbound(peer.db, addr); // R4
      }
      return verdict;
    };

    await enq(owner.db, invite());                                                  // 1: invite, epoch e
    await enq(owner.db, { toInstanceId: null, body: { role: "editor" } });           // 2: role, epoch e
    await enq(owner.db, { toInstanceId: null, body: { role: "editor" } });           // 3: in flight
    await enq(owner.db, { kind: "project.unshare", toInstanceId: null, body: {} });  // 4: in flight
    await enq(owner.db, invite({ epoch: NEW_EPOCH }));                              // 5: the re-invite
    await enq(owner.db, { toInstanceId: null, epoch: NEW_EPOCH, body: { role: "editor" } }); // 6

    assert.equal(await deliver(1), "new");
    assert.equal(await deliver(2), "new");
    // The re-invite overtakes the frames still in flight. Its seq jumped (2 → 5):
    // without R3 that would be a gap; the newer epoch makes it new.
    assert.equal(await deliver(5), "new");
    // The abandoned epoch's queued frames are stale, and their seqs are consumed.
    assert.equal(await deliver(3), "stale");
    assert.equal(await deliver(4), "stale");
    // The frames after the invite apply in order.
    assert.equal(await deliver(6), "new");
    assert.equal(await acceptInbound(peer.db, where({ stream: WILDCARD, seq: 7, epoch: NEW_EPOCH })), "new",
      "the restarted stream is contiguous, nothing was left behind");
    assert.deepEqual(applied, [1, 2, 5, 6]);
  });
});

test("contact re-added: the counters restart at 1, the newer epoch still resets the receiver", async () => {
  await withPair(async (owner, peer) => {
    // The owner's first life with this contact: three acked frames on stream "*".
    await enq(owner.db, invite());
    await enq(owner.db, { toInstanceId: null, body: { role: "editor" } });
    await enq(owner.db, { toInstanceId: null, body: { role: "editor" } });
    // The receiver applied them: its mark is at 3, epoch e.
    for (const seq of [1, 2, 3]) {
      const addr = at(await frameAt(owner.db, seq));
      assert.equal(await acceptInbound(peer.db, addr), "new");
      assert.equal(await commitInbound(peer.db, addr), true);
    }
    await onAck(owner.db, { contactId: CONTACT, projectUuid: P1, seqs: [1, 2, 3] });

    // The contact is deleted on the sender; its queue and counters go with it (the
    // FK cascade on a host with foreign_keys on), and it is added again.
    await owner.db.execute({ sql: "DELETE FROM c2c_outbox WHERE contact_id = ?", args: [CONTACT] });
    await owner.db.execute({ sql: "DELETE FROM c2c_outbox_seq WHERE contact_id = ?", args: [CONTACT] });

    assert.equal(await enq(owner.db, invite({ epoch: NEW_EPOCH })), 1, "the counter restarted at 1");
    await enq(owner.db, { toInstanceId: null, epoch: NEW_EPOCH, body: { role: "editor" } }); // 2
    await enq(owner.db, { toInstanceId: null, epoch: NEW_EPOCH, body: { role: "editor" } }); // 3
    // The receiver is still at 3: only the fresh epoch makes the invite new (R3).
    assert.equal(await deliverFrame(owner, peer, 1), "new");
    assert.equal(await deliverFrame(owner, peer, 2), "new", "the new life's frames are new, in order");
    assert.equal(await deliverFrame(owner, peer, 3), "new");
    assert.equal(await acceptInbound(peer.db, where({ stream: WILDCARD, seq: 4, epoch: NEW_EPOCH })), "new");
    assert.equal(await acceptInbound(peer.db, where({ stream: WILDCARD, seq: 6, epoch: NEW_EPOCH })), "gap");
  });
});

test("two siblings: a stream a sibling never saw is new, not a gap (R1, R3)", async () => {
  const owner = await fresh();
  const v1 = await fresh();
  const v2 = await fresh();
  try {
    await enq(owner.db, invite());                                                   // "*" 1
    await enq(owner.db, { toInstanceId: null, body: { role: "editor" } });            // "*" 2
    await enq(owner.db, { kind: "project.unshare", toInstanceId: null, body: {} });   // "*" 3
    await enq(owner.db, invite({ epoch: NEW_EPOCH }));                               // "*" 4

    // V1 took stream "*" in the contact's first life.
    for (const seq of [1, 2, 3]) assert.equal(await deliverFrame(owner, v1, seq), "new");
    // V2 never saw 1..3, so the re-invite at seq 4 is not its hw + 1: R3's epoch
    // makes it new instead of a hole.
    assert.equal(await deliverFrame(owner, v2, 4), "new");
    // And an old-epoch frame reaching V2 afterwards is stale, not a new hole.
    assert.equal(
      await acceptInbound(v2.db, at(await frameAt(owner.db, 3))),
      "stale",
    );

    // A targeted stream is its own sequence and is unaffected by V2's "*" mark.
    assert.equal(await enq(owner.db, { toInstanceId: "inst-v1", body: { role: "editor" } }), 1);
    const targeted = { toInstanceId: "inst-v1" };
    assert.equal(await deliverFrame(owner, v1, 1, targeted), "new");
    assert.equal(await deliverFrame(owner, v2, 1, targeted), "new", "a sibling that never saw this stream starts at 1");
    // Neither sibling's "*" mark moved when the targeted stream ran: V1 is still at
    // 3 with the old membership (it never saw the re-invite), V2 is at 4 with the new one.
    // V1: the re-invite would still reset it; any other new-membership frame is stale
    // until it does (epochs compare only for equality, R3).
    assert.equal(await acceptInbound(v1.db, where({ stream: WILDCARD, seq: 4, epoch: NEW_EPOCH, kind: "project.invite" })), "new");
    assert.equal(await acceptInbound(v1.db, where({ stream: WILDCARD, seq: 5, epoch: NEW_EPOCH })), "stale");
    assert.equal(await acceptInbound(v2.db, where({ stream: WILDCARD, seq: 5, epoch: NEW_EPOCH })), "new");
    // An ack names one stream's frame: acking the "*" seq 1 must not close the
    // targeted seq 1, which is a different frame that happens to share the number.
    assert.equal((await rowsOf(owner.db)).filter((r) => r.seq === 1).length, 2, "two seq-1 rows, one per stream");
    assert.equal(await onAck(owner.db, { contactId: CONTACT, projectUuid: P1, seqs: [1], stream: WILDCARD }), 1);
    const after = (await rowsOf(owner.db)).filter((r) => r.seq === 1);
    assert.ok(after.find((r) => streamOf(r.to_instance_id) === WILDCARD).acked_at, "the '*' seq 1 was acked");
    assert.equal(after.find((r) => streamOf(r.to_instance_id) === "inst-v1").acked_at, null,
      "the targeted seq 1 still waits");
  } finally {
    owner.dispose(); v1.dispose(); v2.dispose();
  }
});

/* ------------------------------------------------- Review Focus 3 (plan 1) */

test("restart resends unacked in order; receiver applies once", async () => {
  const owner = await fresh();
  const peer = await fresh();
  try {
    for (let i = 0; i < 3; i++) await enq(owner.db);

    // The receiving Crow: apply if it is new, then ack — except that the wire
    // loses the first `dropAcks` acks, so the owner never learns they landed.
    const applied = new Map();
    function link(db, { dropAcks = 0 } = {}) {
      const l = { sent: [], dropped: 0 };
      l.send = async (frame) => {
        l.sent.push(frame.seq);
        // The frame's own stream key (R1): the mark is per stream, not per project.
        const addr = at(frame);
        if (await acceptInbound(peer.db, addr) === "new" && await commitInbound(peer.db, addr)) {
          applied.set(frame.seq, (applied.get(frame.seq) || 0) + 1);
        }
        if (l.dropped < dropAcks) {
          l.dropped += 1; // the ack never reaches the sender
          return;
        }
        await onAck(db, { contactId: CONTACT, projectUuid: frame.project_uuid, seqs: [frame.seq] });
      };
      return l;
    }

    const first = link(owner.db, { dropAcks: 2 });
    assert.equal(await flush(owner.db, first.send, { contactId: CONTACT }), 3);
    assert.deepEqual(first.sent, [1, 2, 3]);
    assert.deepEqual((await rowsOf(owner.db)).filter((r) => !r.acked_at).map((r) => r.seq), [1, 2]);

    // "Restart": a new client on the same file, nothing else carried over.
    owner.close();
    const reopened = createDbClient(owner.dbPath);
    try {
      const second = link(reopened);
      assert.equal(await flush(reopened, second.send, { contactId: CONTACT }), 2);
      assert.deepEqual(second.sent, [1, 2], "the unacked frames go again, in order");
      assert.equal(await flush(reopened, second.send, { contactId: CONTACT }), 0, "and then the queue is empty");

      // The receiver applied each seq exactly once: the resends were dups.
      assert.deepEqual([...applied.entries()], [[1, 1], [2, 1], [3, 1]]);
      assert.ok((await rowsOf(reopened)).every((r) => r.acked_at));
    } finally {
      try { reopened.close(); } catch {}
    }
  } finally {
    owner.dispose();
    peer.dispose();
  }
});
test("cancelEpoch ends only the earlier membership's queued frames (R3 owner side)", async () => {
  await withDb(async ({ db }) => {
    await enq(db, { body: { role: "viewer" } });                     // old membership, queued
    await enq(db, { body: { role: "editor" } });                     // old membership, queued
    await enq(db, { ...invite(), epoch: NEW_EPOCH });                // the new membership's invite
    const n = await cancelEpoch(db, { contactId: CONTACT, projectUuid: P1, keepEpoch: NEW_EPOCH });
    assert.equal(n, 2);
    const rows = await rowsOf(db);
    const open = rows.filter((r) => r.acked_at == null);
    assert.equal(open.length, 1, "only the new membership's invite is still queued");
    assert.equal(JSON.parse(open[0].frame_json).epoch, NEW_EPOCH);
    assert.ok(rows.filter((r) => r.acked_at != null).every((r) => r.last_refusal === "cancelled"));
  });
});

test("a second delivery of the same re-invite is a dup, never a second reset (R3 + R6)", async () => {
  await withPair(async (owner, receiver) => {
    await enq(owner.db, { ...invite(), epoch: EPOCH });
    await deliverFrame(owner, receiver, 1, { toInstanceId: null });
    await enq(owner.db, { ...invite(), epoch: NEW_EPOCH });
    const first = await deliverFrame(owner, receiver, 2, { toInstanceId: null });
    const again = await deliverFrame(owner, receiver, 2, { toInstanceId: null });
    assert.equal(first, "new");
    assert.equal(again, "dup", "the stored epoch is the new one, so the same invite takes nothing");
  });
});

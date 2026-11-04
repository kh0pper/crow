// Task 4 of the Crow-to-Crow plan: the outbox (at-least-once, FIFO per stream,
// acked by the peer) and the inbound sequencing contract (S1–S6, R2, R4–R8 at the
// top of servers/sharing/c2c/outbox.js). Two scratch DB files stand in for the
// owner's Crow and the contact's Crow.
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
  cancelEpoch, nextInviteGeneration, inviteSupersedes, ackIsForMe,
} from "../servers/sharing/c2c/outbox.js";
import { buildFrame, parseFrame } from "../servers/sharing/c2c/frames.js";

const P1 = "1".repeat(32);
const P2 = "2".repeat(32);
const EPOCH = "e".repeat(32);
const NEW_EPOCH = "0".repeat(32); // a different membership, byte-wise LOWER than EPOCH: an epoch is a key now, never ordered (S1)
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
  body: { name: "Labs", role: "viewer", owner_instance_id: LOCAL, gen: 1 },
  ...over,
});

/** Ack one stream's seqs (S3: the epoch and the stream are part of the address). */
const ack = (db, seqs, over = {}) => onAck(db, {
  contactId: CONTACT, projectUuid: P1, epoch: EPOCH, stream: PEER, seqs, ...over,
});

/** Refuse one frame on its stream (S3). */
const refuse = (db, seq, reason, over = {}) => onRefuse(db, {
  contactId: CONTACT, projectUuid: P1, epoch: EPOCH, stream: PEER, seq, reason, ...over,
});

const rowsOf = async (db, contactId = CONTACT) => (await db.execute({
  sql: `SELECT project_uuid, epoch, to_instance_id, seq, kind, acked_at, attempts, last_attempt_at,
               last_refusal, frame_json
          FROM c2c_outbox WHERE contact_id = ?
          ORDER BY project_uuid, epoch, seq, COALESCE(to_instance_id, '*')`,
  args: [contactId],
})).rows;

/**
 * The frame the outbox actually stored (the wire envelope, not the caller's input).
 * `toInstanceId` narrows to one stream and `epoch` to one membership, since a seq is
 * only unique inside a stream (S1).
 */
const frameAt = async (db, seq, { projectUuid = P1, toInstanceId, epoch } = {}) => {
  const byStream = toInstanceId !== undefined;
  const byEpoch = epoch !== undefined;
  const rows = (await db.execute({
    sql: `SELECT frame_json FROM c2c_outbox
           WHERE contact_id = ? AND project_uuid = ? AND seq = ?
             ${byStream ? "AND COALESCE(to_instance_id, '*') = ?" : ""}
             ${byEpoch ? "AND epoch = ?" : ""}
           ORDER BY id LIMIT 1`,
    args: [
      CONTACT, projectUuid, seq,
      ...(byStream ? [streamOf(toInstanceId)] : []),
      ...(byEpoch ? [epoch] : []),
    ],
  })).rows;
  return rows.length ? JSON.parse(rows[0].frame_json) : null;
};

/** An inbound mark address taken from a delivered frame (S1: its epoch and stream). */
const at = (frame, over = {}) => ({
  contactId: CONTACT,
  senderInstanceId: LOCAL,
  projectUuid: frame.project_uuid,
  stream: streamOf(frame.to_instance_id),
  seq: frame.seq,
  epoch: frame.epoch,
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

test("seqs are per contact, project, epoch and stream and start at 1", async () => {
  await withDb(async ({ db }) => {
    assert.equal(await enq(db), 1);
    assert.equal(await enq(db), 2);
    assert.equal(await enq(db, { projectUuid: P2 }), 1, "a new project starts at 1");
    assert.equal(await enq(db, { contactId: OTHER_CONTACT }), 1, "a new contact starts at 1");
    assert.equal(await enq(db), 3, "the first stream keeps counting");
    // S1: a frame with no target instance is its own stream.
    assert.equal(await enq(db, { toInstanceId: null }), 1, "the '*' stream starts at 1");
    assert.equal(await enq(db, { toInstanceId: SIBLING }), 1, "a sibling stream starts at 1");
    assert.equal(await enq(db, { toInstanceId: null }), 2);
    assert.equal(await enq(db), 4, "another stream never moves this one");
    // S1: the epoch is part of the key, so a new membership starts every stream at 1 —
    // there is no reset path anywhere.
    assert.equal(await enq(db, { epoch: NEW_EPOCH }), 1, "a new epoch's targeted stream starts at 1");
    assert.equal(await enq(db, { epoch: NEW_EPOCH, toInstanceId: null }), 1, "and so does its '*' stream");
    assert.equal(await enq(db, { epoch: NEW_EPOCH }), 2);

    const frame = await frameAt(db, 1, { toInstanceId: PEER, epoch: EPOCH });
    assert.equal(frame.seq, 1);
    assert.equal(frame.epoch, EPOCH);
    assert.equal(frame.project_uuid, P1);
    assert.equal(frame.from_instance_id, LOCAL);
    assert.equal(frame.to_instance_id, PEER);
    assert.deepEqual(frame.body, { role: "viewer" });
    // The row carries its epoch, so ack, refuse and flush never parse frame_json.
    const row = (await rowsOf(db)).find((r) => r.seq === 1 && r.epoch === EPOCH && streamOf(r.to_instance_id) === PEER);
    assert.equal(row.epoch, EPOCH);
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
      () => enq(db, { kind: "project.ack", body: { epoch: EPOCH, stream: WILDCARD, seqs: [1] } }),
      (err) => err.code === "bad_argument",
    );
    await assert.rejects(
      () => enq(db, { body: { role: "owner" } }),
      (err) => err.code === "bad_frame",
    );
    // S2: an invite without its generation (or with a gen that is not a positive int)
    // is refused before it can be queued.
    for (const gen of [undefined, 0, "1", 1.5]) {
      const body = { name: "Labs", role: "viewer", owner_instance_id: LOCAL };
      if (gen !== undefined) body.gen = gen;
      await assert.rejects(() => enq(db, { ...invite(), body }), (err) => err.code === "bad_frame", String(gen));
    }
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
    assert.equal(await ack(db, [2]), 1);

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
    await ack(db, [1, 3]);
    await ack(db, [1], { projectUuid: P2 });
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

test("S4: flush never sends a row enqueued inside a transaction that rolled back", async () => {
  await withDb(async ({ db }) => {
    const sent = [];
    const send = (f) => { sent.push(f.seq); };
    let arrived;
    const inside = new Promise((resolve) => { arrived = resolve; });

    const doomed = withTransaction(db, async () => {
      assert.equal(await enq(db), 1);
      arrived();
      // Give the concurrent flush every chance to read while this transaction is open.
      await new Promise((r) => setImmediate(r));
      throw new Error("boom");
    });
    await inside;
    const flushed = flush(db, send, { contactId: CONTACT });
    await assert.rejects(doomed, /boom/);
    assert.equal(await flushed, 0, "flush waited for the transaction and found no row");
    assert.deepEqual(sent, [], "a row that rolled back is never sent");

    // The same race with a COMMIT: the flush that waited still sends the row.
    let release;
    const gate = new Promise((r) => { release = r; });
    const committed = withTransaction(db, async () => {
      assert.equal(await enq(db), 1);
      release();
      await new Promise((r) => setImmediate(r));
    });
    await gate;
    const flushed2 = flush(db, send, { contactId: CONTACT });
    await committed;
    assert.equal(await flushed2, 1, "the committed row is sent once the transaction is done");
    assert.deepEqual(sent, [1]);
  });
});

test("S4: two concurrent flushes for one contact never send a row twice", async () => {
  await withDb(async ({ db }) => {
    await enq(db);
    await enq(db);
    const sent = [];
    // A send that yields, so both flushes would be mid-loop if the guard were missing.
    const send = async (f) => { sent.push(f.seq); await new Promise((r) => setImmediate(r)); };
    const [a, b] = await Promise.all([
      flush(db, send, { contactId: CONTACT }),
      flush(db, send, { contactId: CONTACT }),
    ]);
    assert.deepEqual([...sent].sort((x, y) => x - y), [1, 2], "every row goes exactly once");
    assert.equal(a + b, 2);
    assert.equal(Math.min(a, b), 0, "the second flush returns 0 and sends nothing");
    // A later flush is independent: the guard is released (and at-least-once means the
    // unacked rows go again).
    const again = [];
    assert.equal(await flush(db, (f) => { again.push(f.seq); }, { contactId: CONTACT }), 2);
    assert.deepEqual(again, [1, 2]);
  });
});

test("S4: flush inside a live transaction is bad_state; after COMMIT it sends", async () => {
  await withDb(async ({ db }) => {
    const sent = [];
    await assert.rejects(
      withTransaction(db, async () => {
        assert.equal(await enq(db), 1);
        // S4: the rows of an open transaction are not on the queue yet.
        await flush(db, (f) => { sent.push(f.seq); }, { contactId: CONTACT });
      }),
      (err) => err.code === "bad_state",
    );
    assert.deepEqual(sent, [], "nothing was sent from inside the transaction");
    assert.equal((await rowsOf(db)).length, 0, "the throw rolled the enqueue back with it");

    // The same shape, done the way S4 asks: enqueue, COMMIT, then flush.
    await withTransaction(db, async () => { assert.equal(await enq(db), 1); });
    assert.equal(await flush(db, (f) => { sent.push(f.seq); }, { contactId: CONTACT }), 1);
    assert.deepEqual(sent, [1], "the committed row goes out after COMMIT");
  });
});

test("not_home keeps the frame; forbidden ends it", async () => {
  await withDb(async ({ db }) => {
    const seq = await enq(db);
    await flush(db, () => {}, { contactId: CONTACT });

    // The wrong (paired sibling) instance answered: the frame waits for the target.
    assert.equal(await refuse(db, seq, "not_home"), null);
    let [row] = await rowsOf(db);
    assert.equal(row.acked_at, null);
    assert.equal(row.last_refusal, "not_home");
    const resent = [];
    assert.equal(await flush(db, (f) => { resent.push(f.seq); }, { contactId: CONTACT }), 1);
    assert.deepEqual(resent, [seq], "a not_home frame is still delivered later");

    // Terminal: the frame can never apply, so it leaves the queue for good.
    assert.equal(await refuse(db, seq, "forbidden"), "forbidden");
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
      assert.equal(await refuse(db, seq, reason), null, reason);
    }
    const held = await rowsOf(db);
    assert.deepEqual(held.map((r) => r.acked_at), [null, null, null, null]);
    assert.deepEqual(held.map((r) => r.last_refusal), ["not_home", "busy", "gap", "update_required"]);

    for (const reason of ["forbidden", "stale_epoch", "unsupported", "bad_frame"]) {
      const seq = await enq(db, { projectUuid: P2 });
      assert.equal(await refuse(db, seq, reason, { projectUuid: P2 }), reason, reason);
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
    assert.equal(await refuse(db, seq, "update_required"), null);
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

    await refuse(db, seq1, "busy");
    const attemptedAt = Date.parse(
      (await rowsOf(db))[0].last_attempt_at.replace(" ", "T") + "Z",
    );

    // Inside the window: the whole P1 run waits, P2 still goes out.
    const soon = [];
    assert.equal(await flush(db, (f) => { soon.push(f.project_uuid); }, { contactId: CONTACT, now: attemptedAt + 1000 }), 1);
    assert.deepEqual(soon, [P2]);
    await ack(db, [1], { projectUuid: P2 });

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
    await ack(db, [1, 2]);
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
    await ack(owner.db, [1]);
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

test("S3: an ack names one stream — a resent '*' seq 1 never acks V seq 1", async () => {
  await withDb(async ({ db }) => {
    await enq(db, invite());   // "*" seq 1
    await enq(db);             // PEER seq 1: a different frame with the same number
    const open = async () => (await rowsOf(db)).filter((r) => r.seq === 1);
    assert.equal((await open()).length, 2, "two seq-1 rows, one per stream");

    // The visitor re-acks stream "*" seq 1 (a dup ack after a resend).
    assert.equal(await ack(db, [1], { stream: WILDCARD }), 1);
    let rows = await open();
    assert.ok(rows.find((r) => streamOf(r.to_instance_id) === WILDCARD).acked_at, "the '*' seq 1 was acked");
    assert.equal(rows.find((r) => streamOf(r.to_instance_id) === PEER).acked_at, null,
      "the targeted seq 1 is a different frame and still waits");

    // Acking a stream that has no such seq does nothing at all.
    assert.equal(await ack(db, [1], { stream: SIBLING }), 0);
    // A refusal is stream-bound the same way.
    assert.equal(await refuse(db, 1, "not_home", { stream: SIBLING }), null);
    rows = await open();
    assert.equal(rows.find((r) => streamOf(r.to_instance_id) === PEER).last_refusal, null);

    assert.equal(await refuse(db, 1, "forbidden"), "forbidden");
    rows = await open();
    assert.ok(rows.find((r) => streamOf(r.to_instance_id) === PEER).acked_at, "the targeted frame is the one that closed");
  });
});

test("S3: ack and refuse require the epoch and the stream", async () => {
  await withDb(async ({ db }) => {
    const seq = await enq(db);
    for (const over of [{ epoch: undefined }, { stream: undefined }, { epoch: null }, { stream: "" }]) {
      await assert.rejects(() => ack(db, [seq], over), (err) => err.code === "bad_argument", JSON.stringify(over));
      await assert.rejects(() => refuse(db, seq, "gap", over), (err) => err.code === "bad_argument", JSON.stringify(over));
    }
    // Nothing was acked or refused by the refused calls.
    const [row] = await rowsOf(db);
    assert.equal(row.acked_at, null);
    assert.equal(row.last_refusal, null);
  });
});

test("S3: an ack aimed at O1 is dropped at O2 and leaves O2's queue untouched", async () => {
  const o1 = await fresh();
  const o2 = await fresh();
  try {
    const O1 = "inst-o1";
    const O2 = "inst-o2";
    // Both are owner instances of the same Crow (paired siblings), each with its own
    // outbox. O2 has a frame queued for the visitor.
    assert.equal(await enq(o2.db, { localInstanceId: O2 }), 1);

    // The ack the visitor sends answers O1's frame: it names O1, its asker.
    const acked = parseFrame(buildFrame({
      kind: "project.ack", projectUuid: P1, fromInstanceId: PEER, toInstanceId: O1,
      body: { epoch: EPOCH, stream: PEER, seqs: [1] },
    }));
    assert.equal(acked.ok, true);
    assert.equal(ackIsForMe(acked.frame, O1), true);
    assert.equal(ackIsForMe(acked.frame, O2), false, "not for this sibling");
    assert.equal(ackIsForMe(acked.frame, null), false, "no local instance: never ours");
    assert.equal(ackIsForMe(null, O2), false);
    // A refusal names its asker the same way.
    const refused = parseFrame(buildFrame({
      kind: "project.refuse", projectUuid: P1, fromInstanceId: PEER, toInstanceId: O1,
      body: { epoch: EPOCH, stream: PEER, seq: 1, reason: "unsupported" },
    }));
    assert.equal(refused.ok, true);
    assert.equal(ackIsForMe(refused.frame, O2), false);

    // Task 5's rule as the contract states it: drop before onAck/onRefuse, no reply.
    const applyAck = (db, frame, localInstanceId) => ackIsForMe(frame, localInstanceId)
      ? onAck(db, { contactId: CONTACT, projectUuid: frame.project_uuid, ...frame.body })
      : "dropped";

    assert.equal(await applyAck(o2.db, acked.frame, O2), "dropped");
    assert.equal((await rowsOf(o2.db))[0].acked_at, null, "O2's queue was not touched");
    const sent = [];
    assert.equal(await flush(o2.db, (f) => { sent.push(f.seq); }, { contactId: CONTACT }), 1,
      "the frame is still queued on O2 and goes out");
    assert.deepEqual(sent, [1]);

    // The same ack at O1, where it was aimed, is applied.
    assert.equal(await enq(o1.db, { localInstanceId: O1 }), 1);
    assert.equal(await applyAck(o1.db, acked.frame, O1), 1);
    assert.ok((await rowsOf(o1.db))[0].acked_at);
  } finally {
    o1.dispose(); o2.dispose();
  }
});

test("cancelEpoch ends only the earlier membership's queued frames (S6 optimisation)", async () => {
  await withDb(async ({ db }) => {
    await enq(db, { body: { role: "viewer" } });                     // old membership, queued
    await enq(db, { body: { role: "editor" } });                     // old membership, queued
    await enq(db, { ...invite(), epoch: NEW_EPOCH });                // the new membership's invite
    const n = await cancelEpoch(db, { contactId: CONTACT, projectUuid: P1, keepEpoch: NEW_EPOCH });
    assert.equal(n, 2);
    const rows = await rowsOf(db);
    const open = rows.filter((r) => r.acked_at == null);
    assert.equal(open.length, 1, "only the new membership's invite is still queued");
    assert.equal(open[0].epoch, NEW_EPOCH);
    assert.ok(rows.filter((r) => r.acked_at != null).every((r) => r.last_refusal === "cancelled"));
    // S6: it is an optimisation only. Without it the old frames would still be sent and
    // refused as stale_epoch; the epoch being a key (S1) is what keeps them harmless.
    assert.equal(await cancelEpoch(db, { contactId: CONTACT, projectUuid: P1, keepEpoch: EPOCH }), 1);
  });
});

/* ----------------------------------------------------------------- inbound */

const where = (over = {}) => ({
  contactId: CONTACT, senderInstanceId: LOCAL, projectUuid: P1,
  stream: PEER, seq: 1, epoch: EPOCH, ...over,
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

    // The mark is per (contact, sender instance, project, epoch, stream), so a sibling
    // instance, another project, another contact, another epoch or another stream
    // starts at 1.
    assert.equal(await acceptInbound(db, where({ seq: 1, senderInstanceId: "inst-sibling" })), "new");
    assert.equal(await acceptInbound(db, where({ seq: 1, projectUuid: P2 })), "new");
    assert.equal(await acceptInbound(db, where({ seq: 1, contactId: OTHER_CONTACT })), "new");
    assert.equal(await acceptInbound(db, where({ seq: 1, epoch: NEW_EPOCH })), "new", "a new membership is a new stream (S1)");
    assert.equal(await acceptInbound(db, where({ seq: 1, stream: WILDCARD })), "new");
    assert.equal(await acceptInbound(db, where({ seq: 1, stream: SIBLING })), "new");
    // And each of those marks is still where it was left.
    assert.equal(await acceptInbound(db, where({ seq: 3 })), "new", "the EPOCH/PEER mark is still 2");
    assert.equal(await commitInbound(db, where({ seq: 1, epoch: NEW_EPOCH })), true);
    assert.equal(await acceptInbound(db, where({ seq: 2, epoch: NEW_EPOCH })), "new", "E2's mark is its own");
  });
});

test("S1: the same seq on two epochs are two independent streams", async () => {
  await withDb(async ({ db }) => {
    assert.equal(await commitInbound(db, where({ seq: 1, epoch: EPOCH })), true);
    // E1's mark is 1; the new membership's seq 1 is still new (it is a different key).
    assert.equal(await acceptInbound(db, where({ seq: 1, epoch: NEW_EPOCH })), "new");
    assert.equal(await commitInbound(db, where({ seq: 1, epoch: NEW_EPOCH })), true);
    assert.equal(await acceptInbound(db, where({ seq: 2, epoch: EPOCH })), "new", "E1 continues where it was");
    assert.equal(await acceptInbound(db, where({ seq: 2, epoch: NEW_EPOCH })), "new", "E2 does too");
    // Advancing the new membership leaves the old stream's next frame alone.
    assert.equal(await commitInbound(db, where({ seq: 2, epoch: NEW_EPOCH })), true);
    assert.equal(await acceptInbound(db, where({ seq: 2, epoch: EPOCH })), "new",
      "an old epoch's next frame is new on its own stream");
    assert.equal(await acceptInbound(db, where({ seq: 3, epoch: NEW_EPOCH })), "new", "E2 continues too");
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

test("a terminal refusal consumes the seq, so the next frame is not wedged (R4)", async () => {
  await withDb(async ({ db }) => {
    // Task 5 refused seq 1 (say stale_epoch) before its effect ran: consume instead.
    assert.equal(await acceptInbound(db, where({ seq: 1 })), "new");
    assert.equal(await consumeInbound(db, where({ seq: 1 })), true);
    assert.equal(await acceptInbound(db, where({ seq: 1 })), "dup", "the seq is gone");
    assert.equal(await acceptInbound(db, where({ seq: 2 })), "new", "and the frames after it flow");

    // Consumption obeys R6 too: it takes only the next seq.
    assert.equal(await consumeInbound(db, where({ seq: 4 })), false);
    assert.equal(await acceptInbound(db, where({ seq: 4 })), "gap");

    // S1: consuming on one epoch's stream leaves the other epoch's marks alone.
    assert.equal(await acceptInbound(db, where({ seq: 1, epoch: NEW_EPOCH })), "new");
    assert.equal(await acceptInbound(db, where({ seq: 1, epoch: EPOCH })), "dup", "the old stream is untouched");
  });
});

test("two concurrent deliveries of one seq apply once (R6)", async () => {
  await withDb(async ({ db }) => {
    const count = async () => (await db.execute("SELECT COUNT(*) AS n FROM c2c_effect_probe")).rows[0].n;
    const deliver = () => withTransaction(db, async () => {
      // S5's shape: the mark first, the effect only when it took the seq.
      if (!await commitInbound(db, where({ seq: 1 }))) throw new Error("dup");
      await db.execute({ sql: "INSERT INTO c2c_effect_probe (seq) VALUES (?)", args: [1] });
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
      assert.equal(await commitInbound(db, where({ seq: 1 })), true);
      await db.execute({ sql: "INSERT INTO c2c_effect_probe (seq) VALUES (?)", args: [1] });
      throw new Error("pipeline failed after the mark");
    }), /pipeline failed/);
    assert.equal(await probeCount(), 0);
    assert.equal(await acceptInbound(db, where({ seq: 1 })), "new", "the mark went back with the effect");

    // Committed: both are there, and a re-delivery is a dup.
    await withTransaction(db, async () => {
      assert.equal(await commitInbound(db, where({ seq: 1 })), true);
      await db.execute({ sql: "INSERT INTO c2c_effect_probe (seq) VALUES (?)", args: [1] });
    });
    assert.equal(await probeCount(), 1);
    assert.equal(await acceptInbound(db, where({ seq: 1 })), "dup");
  });
});

/* ------------------------------------------------ S1: the production shape */

test("S1: invite, roles, unshare, re-invite and a late old frame, over two DBs", async () => {
  await withPair(async (owner, peer) => {
    const VISITOR = "inst-v"; // the visitor's instance id: the target of every role frame
    const applied = [];
    const deliver = async (seq, opts) => {
      const frame = await frameAt(owner.db, seq, opts);
      assert.ok(frame, `seq ${seq} ${JSON.stringify(opts)} is in the outbox`);
      const addr = at(frame);
      const verdict = await acceptInbound(peer.db, addr);
      if (verdict === "new") {
        assert.equal(await commitInbound(peer.db, addr), true, `frame ${seq} committed`);
        applied.push(`${frame.epoch === NEW_EPOCH ? "E2" : "E1"}:${addr.stream}:${seq}`);
      }
      return { verdict, frame, addr };
    };
    const inv = (epoch, gen) => ({
      ...invite(),
      epoch,
      body: { name: "Labs", role: "viewer", owner_instance_id: LOCAL, gen },
    });

    // 1. the first invite (E1, "*") and the visitor's accept.
    assert.equal(await enq(owner.db, inv(EPOCH, 1)), 1, "E1's '*' stream starts at 1");
    assert.equal((await deliver(1, { toInstanceId: null, epoch: EPOCH })).verdict, "new");

    // 2. two targeted role frames on V.
    assert.equal(await enq(owner.db, { toInstanceId: VISITOR }), 1);
    assert.equal(await enq(owner.db, { toInstanceId: VISITOR, body: { role: "editor" } }), 2);
    assert.equal((await deliver(1, { toInstanceId: VISITOR, epoch: EPOCH })).verdict, "new");
    assert.equal((await deliver(2, { toInstanceId: VISITOR, epoch: EPOCH })).verdict, "new");

    // 3. the unshare on V, and a role frame of the same membership left queued.
    assert.equal(await enq(owner.db, { kind: "project.unshare", toInstanceId: VISITOR, body: {} }), 3);
    assert.equal(await enq(owner.db, { toInstanceId: VISITOR, body: { role: "commenter" } }), 4,
      "still queued when everything below happens");
    assert.equal((await deliver(3, { toInstanceId: VISITOR, epoch: EPOCH })).verdict, "new");

    // 4. the re-invite (E2, gen 2); the visitor accepts again from the same instance V.
    assert.equal(await enq(owner.db, inv(NEW_EPOCH, 2)), 1,
      "S1: the new membership's '*' stream starts at 1 with no reset anywhere");
    assert.equal((await deliver(1, { toInstanceId: null, epoch: NEW_EPOCH })).verdict, "new");

    // 5. a targeted E2 role frame on V is new and applies (its seq 1 is not E1's seq 1).
    assert.equal(await enq(owner.db, { epoch: NEW_EPOCH, toInstanceId: VISITOR, body: { role: "editor" } }), 1);
    const fresh = await deliver(1, { toInstanceId: VISITOR, epoch: NEW_EPOCH });
    assert.equal(fresh.verdict, "new", "E2's targeted seq 1 is new, not a dup of E1's");
    assert.deepEqual(fresh.frame.body, { role: "editor" });

    // 6. the E1 role frame queued above arrives late. It lands on its own old stream
    // (authorization would refuse it stale_epoch) and touches neither of E2's marks.
    const late = await deliver(4, { toInstanceId: VISITOR, epoch: EPOCH });
    assert.equal(late.verdict, "new", "it is simply next on the dead E1 stream");
    assert.equal(late.addr.epoch, EPOCH);
    assert.equal(await acceptInbound(peer.db, where({ stream: WILDCARD, epoch: NEW_EPOCH, seq: 2 })), "new",
      "E2's '*' mark is still at 1");
    assert.equal(await acceptInbound(peer.db, where({ stream: VISITOR, epoch: NEW_EPOCH, seq: 2 })), "new",
      "E2's targeted mark is still at 1");
    assert.equal(await acceptInbound(peer.db, where({ stream: VISITOR, epoch: EPOCH, seq: 4 })), "dup",
      "and the late frame moved only the E1 mark");
    assert.deepEqual(applied, [
      "E1:*:1", "E1:inst-v:1", "E1:inst-v:2", "E1:inst-v:3",
      "E2:*:1", "E2:inst-v:1", "E1:inst-v:4",
    ]);
  });
});

test("two siblings: a targeted stream is independent of the '*' stream (S1)", async () => {
  const owner = await fresh();
  const v1 = await fresh();
  const v2 = await fresh();
  try {
    await enq(owner.db, invite());                                              // "*" 1
    await enq(owner.db, { toInstanceId: null, body: { role: "editor" } });       // "*" 2
    await enq(owner.db, { toInstanceId: "inst-v1", body: { role: "editor" } });  // targeted 1

    for (const seq of [1, 2]) assert.equal(await deliverFrame(owner, v1, seq, { toInstanceId: null }), "new");
    // A sibling that never saw "*" 1 starts at 1 on its own mark.
    assert.equal(await deliverFrame(owner, v2, 1, { toInstanceId: null }), "new");

    // The targeted stream is its own sequence and its own mark, on both siblings.
    assert.equal(await deliverFrame(owner, v1, 1, { toInstanceId: "inst-v1" }), "new");
    assert.equal(await deliverFrame(owner, v2, 1, { toInstanceId: "inst-v1" }), "new",
      "a sibling that never saw this stream starts at 1");
    assert.equal(await acceptInbound(v1.db, where({ stream: WILDCARD, seq: 2 })), "dup",
      "V1's '*' mark did not move when the targeted stream ran");
    assert.equal(await acceptInbound(v1.db, where({ stream: "inst-v1", seq: 2 })), "new",
      "and the targeted mark is still 1, not V1's '*' mark of 2");
    assert.equal(await acceptInbound(v2.db, where({ stream: WILDCARD, seq: 2 })), "new",
      "V2's '*' mark is 1: it never saw seq 2");
  } finally {
    owner.dispose(); v1.dispose(); v2.dispose();
  }
});

/* ------------------------------------------------------------ S2: generations */

test("S2: nextInviteGeneration increases and survives a contact delete", async () => {
  await withDb(async ({ db }) => {
    // S2's hybrid clock: `now` is the seam, the stored counter is the floor.
    const gen = (now) => nextInviteGeneration(db, P1, { now });
    assert.equal(await gen(1000), 1000);
    assert.equal(await gen(1001), 1001);
    assert.equal(await nextInviteGeneration(db, P2, { now: 1000 }), 1000, "another project has its own generation");

    // No contact foreign key on purpose: deleting the contact who held a generation
    // must not hand that generation out again.
    await db.execute({ sql: "DELETE FROM contacts WHERE id = ?", args: [CONTACT] });
    assert.equal(await gen(1002), 1002, "the generation never rewinds");
    assert.equal(await gen(1003), 1003);

    // It runs in the caller's transaction: a rollback un-takes the number.
    await assert.rejects(withTransaction(db, async () => {
      assert.equal(await gen(1004), 1004);
      throw new Error("boom");
    }), /boom/);
    assert.equal(await gen(1004), 1004, "the rolled-back generation is handed out again");
  });
});

test("S2: two owner siblings hand out comparable generations (a clock, not a local count)", async () => {
  const o1 = await fresh();
  const o2 = await fresh();
  const o3 = await fresh();
  try {
    const t = 1_700_000_000_000;
    // O1 sends an invite. O2 never saw it: `c2c_invite_gen` is local-only, so its own
    // counter is still at 1 and a local count would hand out 1 — refused stale_epoch.
    const a = await nextInviteGeneration(o1.db, P1, { now: t });
    assert.equal(a, t);
    // Three seconds later, with O2's clock 200 ms behind O1's: still greater than A.
    const b = await nextInviteGeneration(o2.db, P1, { now: t + 3000 - 200 });
    assert.equal(b, t + 2800);
    assert.ok(b > a, `a sibling re-invite supersedes: ${b} > ${a}`);
    assert.equal(inviteSupersedes({ gen: a, state: "active" }, { body: { gen: b } }), true,
      "so the visitor supersedes the visit instead of refusing the re-invite");

    // The limit the contract states: a sibling whose clock is more than the time since
    // the last invite behind gives gen <= A, which the visitor refuses stale_epoch.
    const behind = await nextInviteGeneration(o3.db, P1, { now: t - 5000 });
    assert.ok(behind <= a, `${behind} <= ${a}`);
    assert.equal(inviteSupersedes({ gen: a, state: "active" }, { body: { gen: behind } }), false,
      "behind the last invite's generation: refused stale_epoch");
  } finally {
    o1.dispose(); o2.dispose(); o3.dispose();
  }
});

test("S2: the generation never goes backwards when the wall clock does", async () => {
  await withDb(async ({ db }) => {
    const t = 1_700_000_000_000;
    assert.equal(await nextInviteGeneration(db, P1, { now: t }), t);
    // The stored counter is the floor, so a clock that jumped back cannot re-issue a
    // generation (which the visitor would refuse stale_epoch).
    assert.equal(await nextInviteGeneration(db, P1, { now: t - 60_000 }), t + 1);
    assert.equal(await nextInviteGeneration(db, P1, { now: t - 60_000 }), t + 2);
    // Still a positive safe integer: frames.js validates exactly that.
    const gen = await nextInviteGeneration(db, P1, { now: t - 120_000 });
    assert.equal(gen, t + 3);
    assert.ok(Number.isSafeInteger(gen) && gen > 0);
  });
});

test("S2: inviteSupersedes refuses an equal or lower gen and supersedes an active visit", () => {
  const frame = (gen) => ({ body: { gen } });
  assert.equal(inviteSupersedes(null, frame(1)), true, "no visit yet: the invite is new");
  assert.equal(inviteSupersedes({ gen: 1, state: "invited" }, frame(1)), false, "the same generation is refused stale_epoch");
  assert.equal(inviteSupersedes({ gen: 2, state: "unshared" }, frame(1)), false, "an old invite overtaking a newer one is refused");
  assert.equal(inviteSupersedes({ gen: 1, state: "active" }, frame(2)), true,
    "a newer invite is also an implicit unshare: it replaces an active visit");
  assert.equal(inviteSupersedes({ gen: 0, state: "invited" }, frame(1)), true, "a visit from before generations");
  // An unvalidated or unreadable value never supersedes anything.
  assert.equal(inviteSupersedes({ gen: 1 }, frame(0)), false);
  assert.equal(inviteSupersedes({ gen: 1 }, {}), false);
  assert.equal(inviteSupersedes({ gen: "x" }, frame(2)), false);
});

test("S2: an old invite (gen 1) arriving after gen 2 is refused", async () => {
  await withDb(async ({ db }) => {
    assert.equal(await nextInviteGeneration(db, P1, { now: 1 }), 1);
    assert.equal(await nextInviteGeneration(db, P1, { now: 2 }), 2);
    // The visitor's visit row (Task 7's upsert) carries the generation it came from.
    const before = { gen: 1, state: "unshared", epoch: EPOCH };
    const current = { gen: 2, state: "active", epoch: NEW_EPOCH };
    assert.equal(inviteSupersedes(before, { body: { gen: 2 } }), true, "gen 2 supersedes gen 1 whatever its state");
    assert.equal(inviteSupersedes(current, { body: { gen: 1 } }), false,
      "gen 1 arriving after gen 2 is refused stale_epoch, whatever epoch it carries");
    assert.equal(inviteSupersedes(current, { body: { gen: 2 } }), false,
      "and a re-delivery of the newest invite takes nothing");
  });
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
        // The frame's own stream (S1/S3): the mark and the ack are per stream.
        const addr = at(frame);
        if (await acceptInbound(peer.db, addr) === "new" && await commitInbound(peer.db, addr)) {
          applied.set(frame.seq, (applied.get(frame.seq) || 0) + 1);
        }
        if (l.dropped < dropAcks) {
          l.dropped += 1; // the ack never reaches the sender
          return;
        }
        await onAck(db, {
          contactId: CONTACT,
          projectUuid: frame.project_uuid,
          epoch: frame.epoch,
          stream: streamOf(frame.to_instance_id),
          seqs: [frame.seq],
        });
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
/**
 * Crow-to-Crow outbox and inbound sequencing (spec §9.4).
 *
 * Outbound: every `project.*` frame that carries state is written to `c2c_outbox`
 * under a sequence number per stream and stays there until the peer acks it.
 * Delivery is at-least-once and FIFO per stream; the receiver dedupes with a
 * per-(contact, sender instance, project, epoch, stream) high-water mark, so a
 * month-long offline queue survives without an age-pruned id store.
 *
 * Ack and refuse frames are NOT sequenced: they are sent directly, never queued.
 *
 * The tables this module owns are local-only (instance-sync LOCAL_ONLY_TABLES).
 * Logs say `[c2c]` and never carry a frame body (it holds contact text).
 *
 * ---------------------------------------------------------------- the contract
 *
 * These rulings settle the cases the spec leaves open. Task 5 (the receive
 * pipeline) follows them; do not change one side without the other.
 *
 * S1. A stream is (contact, project, epoch, target). Target is the frame's
 *     `to_instance_id`, or "*" when that is null (an invite before the visitor is
 *     known). The sender's counter `c2c_outbox_seq` is keyed by
 *     (contact_id, project_uuid, epoch, stream), and the receiver's mark
 *     `c2c_inbound_seq` by (contact_id, sender_instance_id, project_uuid, epoch,
 *     stream): the epoch is part of the KEY, never a stored field to compare. So a
 *     new membership (a new epoch) starts every stream at 1 and there is no reset
 *     logic at all — `acceptInbound` has no invite special case and never says
 *     `stale`. An old-membership frame simply lands on its own old stream and is
 *     numbered there; authorization (Task 5, by `epoch === membership`) refuses it
 *     with `stale_epoch`, and R4 consumes its seq, which is harmless because that
 *     stream is dead. Streams are independent, so a sibling that only sees some of
 *     them never sees a hole in a stream it does receive, and a targeted stream
 *     never moves another's mark.
 *
 * R2. The sender's counter never goes backwards: `c2c_outbox_seq` holds the next
 *     seq to hand out per (contact, project, epoch, stream), claimed in the same
 *     transaction as the insert. It is NOT derived from MAX(seq) over
 *     `c2c_outbox`, so pruning acked rows (or an ack) never re-issues a seq.
 *
 * S2. Invites carry an increasing generation. `c2c_invite_gen(project_uuid,
 *     next_gen)` is the owner's local-only counter with NO contact foreign key, so
 *     deleting a contact never rewinds it; `nextInviteGeneration` takes the next
 *     value inside the caller's transaction and `project.invite` carries it as the
 *     required body field `gen`. The generation is a HYBRID CLOCK:
 *     `gen = max(next_gen, Date.now())`, then `next_gen = gen + 1`. It is a
 *     millisecond wall clock, so the owner's sibling instances (paired Crows, O1 and
 *     O2, each with their own local-only counter) hand out generations that agree to
 *     within clock skew: an O2 re-invite after O1's generation comes out greater than
 *     it, instead of being refused for a smaller local count. The stored counter is
 *     the floor, so the generation stays strictly increasing on one instance even if
 *     the wall clock goes backwards, and it is a positive safe integer (frames.js
 *     validates the same). `c2c_visits.gen` remembers the generation a visit was
 *     created from, and the visitor rule (Task 5/7) is the pure helper
 *     `inviteSupersedes(visit, frame)`:
 *       - an invite whose `gen` is <= the visit's `gen` is refused `stale_epoch`;
 *       - a greater `gen` supersedes the visit whatever its state — an `active`
 *         visit included, because a newer invite is also an implicit unshare of
 *         the membership it replaces. It does not need the old unshare to arrive
 *         first.
 *     Epoch equality alone cannot tell an old invite still in flight from a new
 *     one; the generation can, which is why the visitor rule is a generation and
 *     not an epoch comparison. The cost of a clock: a re-invite from a sibling whose
 *     clock is more than the time since the last invite behind that last invite's
 *     generation is refused `stale_epoch`, and the owner UI shows the refusal
 *     (Task 6/7).
 *
 * S3. Acks and refusals name their frame's stream. `project.ack`'s body is
 *     `{ epoch, stream, seqs }` and `project.refuse`'s is
 *     `{ epoch, stream, seq, reason[, detail] }` (frames.js validates both, and an
 *     ack or refusal carries no envelope epoch). `onAck` / `onRefuse` REQUIRE
 *     `epoch` and `stream` and match them exactly: a seq names a frame only inside
 *     its stream (S1), so there is no "match every stream" default. An ack or a
 *     refusal ALSO names the instance it answers: `to_instance_id` is required and
 *     non-null (frames.js: a null one is `bad_frame`), and it is the answered
 *     frame's `from_instance_id`. Task 5 DROPS an ack or refusal whose
 *     `to_instance_id` is not the local instance (`ackIsForMe`): no `onAck` /
 *     `onRefuse` call and no reply — a sibling of the asker that happens to see the
 *     frame must never apply it to its own queue.
 *
 * R4. A terminal refusal of a well-formed sequenced frame still consumes its seq.
 *     `consumeInbound` advances the mark exactly like a commit, with no effect.
 *     Task 5 calls it for every terminal refusal — `forbidden`, `stale_epoch`,
 *     `unsupported`, and `bad_frame` on a frame whose envelope parsed and whose
 *     seq is the next one — so one refused frame never wedges the frames after it.
 *
 * R5. `update_required` HOLDS instead of ending: the sender keeps the frame until
 *     the peer updates, and a later `flush` re-sends it.
 *
 * R6. Advancing is conditional, so a frame is applied at most once.
 *     `commitInbound` / `consumeInbound` take the seq only when it is exactly
 *     high_water + 1, via one conditional `UPDATE … WHERE high_water = ?` (or an
 *     INSERT for the first row of a stream), and return true/false. `false` means
 *     another delivery already took that seq (S5: return before any effect).
 *
 * R7. No implicit transaction joining. A failing `BEGIN IMMEDIATE` is an error,
 *     never a cue to join somebody else's transaction. `withTransaction` is the
 *     only way in: it opens BEGIN IMMEDIATE (serialized per handle), runs `fn`,
 *     commits, or rolls back on a throw. An inner `enqueue` joins ONLY through
 *     the AsyncLocalStorage token `{ db, live: true }` that `withTransaction`
 *     created, and `live` is set false once COMMIT or ROLLBACK has run — so work
 *     that outlives the transaction can never join it. `fn` must do DB work only:
 *     no network awaits inside, or it would hold the handle's write lock.
 *     `commitInbound` / `consumeInbound` never open a transaction of their own:
 *     they write on the handle they are given, so they ride the caller's
 *     `withTransaction` and commit or roll back with its effect.
 *
 * R8. `flush` holds a project behind an unreadable row: a row whose frame_json
 *     does not parse puts its whole project in `held`, so later frames of that
 *     project are never sent past the hole.
 *
 * S4. `flush` reads through the same per-handle serialization `withTransaction`
 *     uses, so it never sees a row another transaction has not committed: it waits
 *     for that transaction, and a row that then rolls back is never sent. One
 *     flush runs per (handle, contact) at a time — a concurrent flush for the same
 *     contact returns 0 and sends nothing, because the in-flight one is already
 *     walking that contact's queue (a row enqueued meanwhile goes on the next
 *     tick). FLUSH AFTER COMMIT: a flush called from inside a live transaction is a
 *     `bad_state` error. The rows of an open transaction are not on the queue yet,
 *     so there is nothing legitimate to read there, and a flush that joined it would
 *     send a frame the transaction may still roll back.
 *
 * S5. Commit the mark before the effect. Task 5 calls `commitInbound` FIRST inside
 *     its `withTransaction`, and runs the kind's effect only when it returns true.
 *     A false result (another delivery took the seq) returns at once, before any
 *     effect or enqueue. The effect and the mark still commit or roll back
 *     together (R6, R7).
 *     The failure path (Task 5), as the exact sequence:
 *       1. authorization runs BEFORE `commitInbound`, so a frame the rules refuse
 *          is never committed: the refusal is a `consumeInbound` with no effect
 *          (R4), in the same transaction;
 *       2. if the kind's handler throws, the transaction rolls back — the mark
 *          included, so the seq is free again and the frame was not applied;
 *       3. a NEW `withTransaction` runs `consumeInbound` for that seq (R4: it takes
 *          the seq with no effect, so one bad frame never wedges the stream);
 *       4. then the frame is refused `unsupported` — after step 3, never before.
 *
 * S6. `cancelEpoch` is an optimisation, not a correctness rule (S1, S2 do not need
 *     it): it ends the still-queued frames of an earlier membership so fewer dead
 *     frames are sent.
 *
 * R9 (follow-up). Inbound marks are never pruned: `c2c_inbound_seq` keeps one row
 *     per (contact, sender instance, project, epoch, stream) for good, and a new
 *     epoch adds a row instead of resetting one. Dropping the marks of dead
 *     memberships is a follow-up, not this task's.
 *
 * Every write the module makes outside a transaction goes through the same
 * per-handle serialization (`write`): `flush`'s attempt bump, `onAck`, `onRefuse`,
 * `cancelEpoch` and `pruneAcked`. The writes that run INSIDE `withTransaction`
 * (`enqueue`'s claim and insert, `nextInviteGeneration`'s counter) are serialized by
 * that transaction — it holds the handle's turn — so no statement in this module
 * has a path to the handle that skips the chain.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { buildFrame, parseFrame, REFUSALS } from "./frames.js";

/** How long a `busy` refusal holds its project's run (plan 1, task 4). */
export const BUSY_HOLD_MS = 60_000;

/** The stream key of a frame with no target instance yet (S1). */
export const WILDCARD_STREAM = "*";

/** Refusals that end a frame: it will never be accepted, so it is acked away. */
export const TERMINAL_REFUSALS = Object.freeze([
  "forbidden", "stale_epoch", "unsupported", "bad_frame",
]);

/** Refusals that keep the frame queued for another attempt (R5: update_required). */
export const HOLDING_REFUSALS = Object.freeze(["not_home", "busy", "gap", "update_required"]);

const TERMINAL = new Set(TERMINAL_REFUSALS);
const UNSEQUENCED = new Set(["project.ack", "project.refuse"]);

const isSeq = (x) => Number.isSafeInteger(x) && x > 0;

/** S1: the stream a frame is numbered in. */
export function streamOf(toInstanceId) {
  return toInstanceId ?? WILDCARD_STREAM;
}

/**
 * S3: is this ack or refusal meant for this instance? Pure (no DB), so Task 5 can
 * ask before it touches the queue. `frame.to_instance_id` is the answered frame's
 * `from_instance_id` (frames.js requires one), and only the instance it names may
 * answer it: a sibling of the asker that sees the frame drops it instead — no
 * `onAck` / `onRefuse` call and no reply.
 * @returns {boolean}
 */
export function ackIsForMe(frame, localInstanceId) {
  if (typeof localInstanceId !== "string" || !localInstanceId) return false;
  return frame?.to_instance_id === localInstanceId;
}

function c2cError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function requireEpoch(epoch) {
  if (typeof epoch !== "string" || !epoch) throw c2cError("c2c outbox: epoch is required", "bad_argument");
  return epoch;
}

function requireStream(stream) {
  if (typeof stream !== "string" || !stream) throw c2cError("c2c outbox: stream is required", "bad_argument");
  return stream;
}

/** SQLite `datetime('now')` is UTC; parse a stored attempt time back to ms. */
function sqlTimeToMs(value) {
  if (!value) return 0;
  const t = Date.parse(String(value).replace(" ", "T") + "Z");
  return Number.isNaN(t) ? 0 : t;
}

function normalizeSeqs(seqs) {
  if (!Array.isArray(seqs)) return [];
  const out = [];
  for (const s of seqs) {
    if (isSeq(s) && !out.includes(s)) out.push(s);
    if (out.length >= 256) break; // the ack body cap; more would be a lie about the wire
  }
  return out;
}

/* ------------------------------------------------------------ transactions */

// better-sqlite3 runs one statement synchronously, but the libsql-shaped client
// yields between statements, so two concurrent enqueues would otherwise allocate
// the same seq. One write transaction at a time per client handle.
const chains = new WeakMap();
// The transaction the current async context is inside, as { db, live } (R7). Only
// withTransaction creates a token; an inner enqueue joins through it (the outer
// COMMIT decides), and `live = false` after COMMIT/ROLLBACK keeps work that
// outlives the transaction from joining it. commitInbound/consumeInbound take the
// caller's handle instead, so their statements ride that same transaction.
const txScope = new AsyncLocalStorage();
// The contacts whose queue a flush is walking right now, per handle (S4).
const flushing = new WeakMap();

function serialize(db, fn) {
  const prev = chains.get(db) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  chains.set(db, tail);
  tail.then(() => { if (chains.get(db) === tail) chains.delete(db); });
  return run;
}

/** True when this async context is already inside a live transaction on `db`. */
function inLiveTransaction(db) {
  const open = txScope.getStore();
  return Boolean(open?.live && open.db === db);
}

/**
 * One statement on the handle's turn: serialized behind every other write, unless
 * this async context's own live transaction already holds the handle (then it rides
 * it — R7). Every write outside a transaction goes through here (S4, T5).
 */
function write(db, sql, args) {
  const run = () => db.execute({ sql, args });
  return inLiveTransaction(db) ? run() : serialize(db, run);
}

/**
 * Run `fn` in one `BEGIN IMMEDIATE … COMMIT` on `db` (R7).
 *
 * `fn` must do DB work only — no network await: the transaction is serialized per
 * handle, so anything awaited inside holds the only write lock other callers can
 * get. It joins the transaction only when this async context is already inside one
 * this function opened on the same handle; otherwise it opens its own, and a
 * failing BEGIN (a caller's transaction is open on the handle) is an error.
 */
export async function withTransaction(db, fn) {
  const open = txScope.getStore();
  if (open?.live && open.db === db) return fn();
  return serialize(db, async () => {
    await db.execute("BEGIN IMMEDIATE");
    const token = { db, live: true };
    try {
      const out = await txScope.run(token, () => fn());
      await db.execute("COMMIT");
      return out;
    } catch (err) {
      try { await db.execute("ROLLBACK"); } catch { /* the transaction is already gone */ }
      throw err;
    } finally {
      // After COMMIT or ROLLBACK: deferred work must open its own transaction.
      token.live = false;
    }
  });
}

/* ---------------------------------------------------------------- outbound */

/**
 * Take the next seq of a stream and publish the one after it (R2). Runs inside the
 * caller's transaction, so a rollback un-takes it and no reader ever sees a gap.
 * S1: the stream is (epoch, stream), so a new membership's streams start at 1.
 */
async function claimSeq(handle, { contactId, projectUuid, epoch, stream }) {
  const { rows } = await handle.execute({
    sql: `SELECT next_seq FROM c2c_outbox_seq
           WHERE contact_id = ? AND project_uuid = ? AND epoch = ? AND stream = ?`,
    args: [contactId, projectUuid, epoch, stream],
  });
  const seq = rows.length ? Number(rows[0].next_seq) : 1;
  if (!isSeq(seq)) throw c2cError("c2c outbox: the stream counter is unreadable", "bad_state");
  await handle.execute({
    sql: `INSERT INTO c2c_outbox_seq (contact_id, project_uuid, epoch, stream, next_seq)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (contact_id, project_uuid, epoch, stream) DO UPDATE SET next_seq = excluded.next_seq`,
    args: [contactId, projectUuid, epoch, stream, seq + 1],
  });
  return seq;
}

/**
 * Queue one frame and return its sequence number.
 *
 * R2: the next seq comes from `c2c_outbox_seq` for this (contact, project, epoch,
 * stream) and is claimed inside the SAME transaction as the insert, so two
 * concurrent calls can never get the same one and a rollback never burns a number.
 *
 * The frame is validated by `parseFrame` before it is stored: a frame we could
 * never parse back would sit in the queue forever (an invite without a `gen` is
 * refused here, S2).
 *
 * @returns {Promise<number>} seq
 */
export async function enqueue(db, { contactId, projectUuid, kind, epoch, toInstanceId = null, body, localInstanceId }) {
  if (!Number.isSafeInteger(contactId) || contactId <= 0) throw c2cError("c2c outbox: contactId is required", "bad_argument");
  if (UNSEQUENCED.has(kind)) throw c2cError(`c2c outbox: ${kind} is never queued (it is not sequenced)`, "bad_argument");
  requireEpoch(epoch);
  const stream = streamOf(toInstanceId);
  return withTransaction(db, async () => {
    const seq = await claimSeq(db, { contactId, projectUuid, epoch, stream });
    const parsed = parseFrame(buildFrame({
      kind, projectUuid, epoch, seq,
      fromInstanceId: localInstanceId, toInstanceId, body,
    }));
    if (!parsed.ok) {
      // Never log the body: it carries the contact's own words. The throw rolls the
      // counter bump back with it.
      throw c2cError(`c2c outbox: refusing to queue an invalid ${String(kind)} frame (${parsed.reason})`, "bad_frame");
    }
    const frame = parsed.frame;
    await db.execute({
      sql: `INSERT INTO c2c_outbox (contact_id, project_uuid, epoch, seq, kind, to_instance_id, frame_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [contactId, projectUuid, epoch, seq, frame.kind, frame.to_instance_id ?? null, JSON.stringify(frame)],
    });
    return seq;
  });
}

/**
 * Send every unacked frame for a contact, ordered by (project, epoch, stream, seq)
 * so each stream stays FIFO. `send(frame)` is the transport
 * (`peerManager.send(crowId, frame)`); it may be async and it throws when the
 * peer is not connected.
 *
 * A project whose next unacked frame was refused `busy` under 60 s ago is skipped
 * whole — the receiver's queue is full, so later frames of that project would only
 * pile up behind it. R8: a frame that cannot be read does the same, so no later
 * row is sent past the hole.
 *
 * S4: flush after COMMIT. The read is serialized behind any open transaction, and a
 * second concurrent flush for the same contact returns 0 (see the contract). A call
 * from inside a live transaction is a `bad_state` error.
 *
 * @returns {Promise<number>} how many frames were sent
 * @throws {Error & { code: "bad_state" }} when called inside a live transaction (S4)
 */
export async function flush(db, send, { contactId, now = Date.now() } = {}) {
  // S4: flush after COMMIT. Inside the caller's transaction the rows are not on the
  // queue yet (and may still roll back), so there is nothing legitimate to read.
  if (inLiveTransaction(db)) {
    throw c2cError("c2c outbox: flush must run after COMMIT, not inside a transaction", "bad_state");
  }
  let walking = flushing.get(db);
  if (!walking) { walking = new Set(); flushing.set(db, walking); }
  if (walking.has(contactId)) return 0; // S4: the in-flight flush owns this queue
  walking.add(contactId);
  try {
    // S4: never send a row another transaction has not committed (and so never one
    // that is about to roll back). The read takes the handle's turn like any write.
    const rows = await serialize(db, async () => (await db.execute({
      sql: `SELECT id, project_uuid, seq, frame_json, last_refusal, last_attempt_at
              FROM c2c_outbox
             WHERE contact_id = ? AND acked_at IS NULL
             ORDER BY project_uuid, epoch, COALESCE(to_instance_id, '*'), seq`,
      args: [contactId],
    })).rows);
    const held = new Set();
    let sent = 0;
    for (const row of rows) {
      if (held.has(row.project_uuid)) continue;
      if (row.last_refusal === "busy" && now - sqlTimeToMs(row.last_attempt_at) < BUSY_HOLD_MS) {
        held.add(row.project_uuid);
        continue;
      }
      let frame;
      try {
        frame = JSON.parse(row.frame_json);
      } catch {
        console.warn(`[c2c] outbox row ${row.id} is unreadable; its project is held`);
        held.add(row.project_uuid); // R8: never send later seqs past a hole
        continue;
      }
      try {
        await send(frame);
      } catch (err) {
        // The link is gone (or the frame cannot fit it). Stop: nothing after this
        // one could be sent either, and the rows stay queued for the next flush.
        console.warn(`[c2c] flush stopped for contact ${contactId}: ${err?.code || err?.message || "send failed"}`);
        break;
      }
      await write(db,
        "UPDATE c2c_outbox SET attempts = attempts + 1, last_attempt_at = datetime('now') WHERE id = ?",
        [row.id]);
      sent += 1;
    }
    return sent;
  } finally {
    walking.delete(contactId);
  }
}

/**
 * Mark a batch of seqs acked (the peer applied them).
 *
 * S3: an ack names its frame's stream, so `epoch` and `stream` are required and
 * both must match — a seq only means something inside its stream (S1), and a
 * resent "*" seq 1 must never close a targeted seq 1.
 * @returns {Promise<number>} rows acked
 */
export async function onAck(db, { contactId, projectUuid, epoch, stream, seqs }) {
  requireEpoch(epoch);
  requireStream(stream);
  const list = normalizeSeqs(seqs);
  if (!list.length) return 0;
  const marks = list.map(() => "?").join(",");
  const res = await write(db,
    `UPDATE c2c_outbox SET acked_at = datetime('now')
      WHERE contact_id = ? AND project_uuid = ? AND epoch = ? AND acked_at IS NULL
        AND COALESCE(to_instance_id, '*') = ?
        AND seq IN (${marks})`,
    [contactId, projectUuid, epoch, stream, ...list]);
  return res.rowsAffected ?? 0;
}

/**
 * Record a refusal for one frame.
 *
 * `not_home`, `busy`, `gap` and `update_required` keep the frame queued: the wrong
 * instance answered, the receiver is full, a frame is missing ahead of this one,
 * or the peer must update first (R5 — the next flush re-sends it).
 *
 * `forbidden`, `stale_epoch`, `unsupported` and `bad_frame` end it (acked): the
 * frame will never be accepted, so resending it forever would just wedge the
 * project's run. The reason is returned so the caller can surface it.
 *
 * Like `onAck` (S3), `epoch` and `stream` are required and match exactly.
 *
 * @returns {Promise<string|null>} the reason when the frame is ended, else null
 */
export async function onRefuse(db, { contactId, projectUuid, epoch, stream, seq, reason }) {
  if (!REFUSALS.includes(reason)) throw c2cError(`c2c outbox: unknown refusal ${String(reason)}`, "bad_argument");
  requireEpoch(epoch);
  requireStream(stream);
  if (!isSeq(seq)) throw c2cError("c2c outbox: seq is required", "bad_argument");
  const terminal = TERMINAL.has(reason);
  await write(db,
    `UPDATE c2c_outbox
       SET last_refusal = ?,
           acked_at = CASE WHEN ? = 1 THEN datetime('now') ELSE acked_at END
     WHERE contact_id = ? AND project_uuid = ? AND epoch = ? AND seq = ?
       AND COALESCE(to_instance_id, '*') = ?`,
    [reason, terminal ? 1 : 0, contactId, projectUuid, epoch, seq, stream]);
  if (terminal) console.log(`[c2c] frame ${seq} closed with ${reason}`);
  return terminal ? reason : null;
}

/**
 * S6, owner side, optimisation only: end every still-queued frame for
 * (contact, project) whose epoch is not `keepEpoch`, before the invite of a new
 * membership is enqueued, so the peer is not sent frames of a membership it is
 * about to leave. Correctness does not depend on it: each epoch is its own stream
 * (S1) and authorization refuses an old membership with `stale_epoch`.
 * @returns {Promise<number>} frames cancelled
 */
export async function cancelEpoch(db, { contactId, projectUuid, keepEpoch }) {
  if (typeof keepEpoch !== "string" || !keepEpoch) throw c2cError("c2c outbox: keepEpoch is required", "bad_argument");
  const res = await write(db,
    `UPDATE c2c_outbox SET acked_at = datetime('now'), last_refusal = 'cancelled'
      WHERE contact_id = ? AND project_uuid = ? AND acked_at IS NULL AND epoch <> ?`,
    [contactId, projectUuid, keepEpoch]);
  const n = res.rowsAffected ?? 0;
  if (n) console.log(`[c2c] cancelled ${n} queued frame(s) of an earlier membership`);
  return n;
}

/**
 * Drop acked rows older than `olderThanDays` (30 by default).
 * R2: the stream counters in `c2c_outbox_seq` are untouched, so a pruned row's
 * seq is never handed out again.
 * @returns {Promise<number>} rows pruned
 */
export async function pruneAcked(db, { olderThanDays = 30 } = {}) {
  const days = Number.isSafeInteger(olderThanDays) && olderThanDays > 0 ? olderThanDays : 30;
  const res = await write(db,
    "DELETE FROM c2c_outbox WHERE acked_at IS NOT NULL AND acked_at < datetime('now', ?)",
    [`-${days} days`]);
  return res.rowsAffected ?? 0;
}

/* ------------------------------------------------------------- generations */

/**
 * S2: take the next invite generation for a project and publish the one after it.
 *
 * S2's hybrid clock: `gen = max(next_gen, clock)`, then `next_gen = gen + 1`. The
 * clock is wall time in milliseconds, so the owner's sibling instances hand out
 * comparable generations, and the stored counter is the floor, so one instance never
 * goes backwards even if its clock does. `now` is the clock seam (`Date.now()` by
 * default); tests pass it to keep the numbers small and deterministic.
 *
 * Local-only and never reset by a contact delete (no contact foreign key), so a
 * generation stays comparable across memberships of the same project. It runs in
 * the caller's transaction when there is one (the invite and its generation then
 * roll back together), otherwise it opens its own.
 * @param {{ now?: number }} [opts] the clock seam (S2)
 * @returns {Promise<number>} the generation to put in the invite body
 */
export async function nextInviteGeneration(db, projectUuid, opts = {}) {
  if (typeof projectUuid !== "string" || !projectUuid) {
    throw c2cError("c2c invite: projectUuid is required", "bad_argument");
  }
  const clock = opts?.now === undefined ? Date.now() : opts.now;
  if (!isSeq(clock)) throw c2cError("c2c invite: the clock is not a positive safe integer", "bad_argument");
  return withTransaction(db, async () => {
    const { rows } = await db.execute({
      sql: "SELECT next_gen FROM c2c_invite_gen WHERE project_uuid = ?",
      args: [projectUuid],
    });
    const stored = rows.length ? Number(rows[0].next_gen) : 1;
    if (!isSeq(stored)) throw c2cError("c2c invite: the generation counter is unreadable", "bad_state");
    const gen = Math.max(stored, clock);
    if (!Number.isSafeInteger(gen + 1)) throw c2cError("c2c invite: the generation would overflow", "bad_state");
    await db.execute({
      sql: `INSERT INTO c2c_invite_gen (project_uuid, next_gen) VALUES (?, ?)
            ON CONFLICT (project_uuid) DO UPDATE SET next_gen = excluded.next_gen`,
      args: [projectUuid, gen + 1],
    });
    return gen;
  });
}

/**
 * S2, visitor side: does this invite replace the visit record? Pure (no DB), so
 * Task 5/7 can ask before writing anything. `visit` is the local `c2c_visits` row
 * (or null when this owner is unknown), read for its `gen`.
 *
 * `false` means refuse the invite `stale_epoch`: it comes from the generation the
 * visit already has, or an older one (an old invite that overtook a newer one).
 * `true` means it supersedes the visit whatever its state — `active` included,
 * because a newer invite is also an implicit unshare of the membership it replaces.
 *
 * @returns {boolean}
 */
export function inviteSupersedes(visit, frame) {
  const gen = frame?.body?.gen;
  if (!isSeq(gen)) return false; // frames.js already refuses such an invite (bad_frame)
  const known = Number(visit?.gen ?? 0);
  // An unreadable stored generation is not a trust base: refuse rather than supersede.
  if (!Number.isSafeInteger(known) || known < 0) return false;
  return gen > known;
}

/* ----------------------------------------------------------------- inbound */

// S1: the epoch is part of the key, so no stored-epoch field is read or written.
const markArgs = ({ contactId, senderInstanceId, projectUuid, epoch, stream }) =>
  [contactId, senderInstanceId, projectUuid, epoch, stream];

async function readMark(handle, key) {
  const { rows } = await handle.execute({
    sql: `SELECT high_water FROM c2c_inbound_seq
           WHERE contact_id = ? AND sender_instance_id = ? AND project_uuid = ? AND epoch = ? AND stream = ?`,
    args: markArgs(key),
  });
  return Number(rows[0]?.high_water ?? 0);
}

/**
 * Where an incoming frame sits against its stream's mark, without writing:
 * `new` (apply it), `dup` (already applied, ack it) or `gap` (something is missing
 * ahead of it — refuse it `gap`).
 *
 * It does NOT judge membership: an old-membership frame is `new` on its own old
 * stream (S1), and Task 5 refuses it with `stale_epoch` by comparing the frame's
 * epoch with the membership it holds (R4 then consumes the seq).
 *
 * @returns {Promise<"new"|"dup"|"gap">}
 */
export async function acceptInbound(db, {
  contactId, senderInstanceId, projectUuid, epoch, stream = WILDCARD_STREAM, seq,
}) {
  requireEpoch(epoch);
  requireStream(stream);
  if (!isSeq(seq)) throw c2cError("c2c outbox: seq is required", "bad_argument");
  const highWater = await readMark(db, { contactId, senderInstanceId, projectUuid, epoch, stream });
  if (seq <= highWater) return "dup";
  return seq === highWater + 1 ? "new" : "gap";
}

/* The two conditional writes R6 allows. Each touches at most one row, and the WHERE
 * clause is the whole decision, so a second delivery of a seq takes nothing. */

// The next frame in order of this stream (S1: the epoch is in the key).
const ADVANCE_SQL = `UPDATE c2c_inbound_seq SET high_water = ?
                      WHERE contact_id = ? AND sender_instance_id = ? AND project_uuid = ?
                        AND epoch = ? AND stream = ? AND high_water = ?`;

// The first frame of a stream (no row yet). DO NOTHING when one already exists.
const FIRST_SQL = `INSERT INTO c2c_inbound_seq
                     (contact_id, sender_instance_id, project_uuid, epoch, stream, high_water)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT (contact_id, sender_instance_id, project_uuid, epoch, stream) DO NOTHING`;

async function advance(handle, { contactId, senderInstanceId, projectUuid, epoch, stream, seq }) {
  const key = { contactId, senderInstanceId, projectUuid, epoch, stream };
  const moved = await handle.execute({ sql: ADVANCE_SQL, args: [seq, ...markArgs(key), seq - 1] });
  if ((moved.rowsAffected ?? 0) > 0) return true;
  // No row yet: a stream may only start at 1.
  if (seq !== 1) return false;
  const first = await handle.execute({ sql: FIRST_SQL, args: [...markArgs(key), seq] });
  return (first.rowsAffected ?? 0) > 0;
}

/**
 * Advance the high-water mark for a frame whose effect the caller runs in the same
 * transaction (`withTransaction`), so the effect and the mark commit or roll back
 * together — a crash can never leave a frame marked applied but not applied.
 *
 * S5: call this FIRST, and run the effect only when it returns true.
 * R6: it takes the seq only when it is exactly high_water + 1, so a frame is
 * applied at most once. `epoch` and `stream` name the frame's stream (S1).
 *
 * @returns {Promise<boolean>} true when this call took the seq. `false` means
 *   another delivery already took it: return at once, before any effect or
 *   enqueue, and re-ack the frame as a dup.
 */
export async function commitInbound(handle, {
  contactId, senderInstanceId, projectUuid, epoch, stream = WILDCARD_STREAM, seq,
}) {
  requireEpoch(epoch);
  requireStream(stream);
  if (!isSeq(seq)) throw c2cError("c2c outbox: seq is required", "bad_argument");
  return advance(handle, { contactId, senderInstanceId, projectUuid, epoch, stream, seq });
}

/**
 * R4: consume the seq of a well-formed frame that will never be applied (a terminal
 * refusal: `forbidden`, `stale_epoch`, `unsupported`, `bad_frame`). It advances the
 * mark exactly like a commit, with no effect, so one refused frame never wedges the
 * frames after it.
 *
 * Same contract as `commitInbound`: run it in the caller's transaction, name the
 * frame's own stream (an old membership's frame consumes a seq on its own dead
 * stream, S1), and treat `false` as "already taken" (nothing to do — the seq is
 * gone either way).
 *
 * @returns {Promise<boolean>} true when this call took the seq
 */
export async function consumeInbound(handle, {
  contactId, senderInstanceId, projectUuid, epoch, stream = WILDCARD_STREAM, seq,
}) {
  requireEpoch(epoch);
  requireStream(stream);
  if (!isSeq(seq)) throw c2cError("c2c outbox: seq is required", "bad_argument");
  return advance(handle, { contactId, senderInstanceId, projectUuid, epoch, stream, seq });
}
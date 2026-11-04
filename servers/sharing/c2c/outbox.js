/**
 * Crow-to-Crow outbox and inbound sequencing (spec §9.4).
 *
 * Outbound: every `project.*` frame that carries state is written to `c2c_outbox`
 * under a sequence number per stream and stays there until the peer acks it.
 * Delivery is at-least-once and FIFO per stream; the receiver dedupes with a
 * per-(contact, sender instance, project, stream) high-water mark, so a month-long
 * offline queue survives without an age-pruned id store.
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
 * R1. A stream is (contact, project, target). A frame's stream key is its
 *     `to_instance_id`, or "*" when that is null (an invite before the visitor is
 *     known). The sender numbers each stream from 1; the receiver keeps one
 *     high-water mark per (sender instance, project, stream key). Streams are
 *     independent, so a sibling that only sees some of them never sees a hole in
 *     a stream it does receive, and a targeted stream never moves another's mark.
 *
 * R2. The sender's counter never goes backwards: `c2c_outbox_seq` holds the next
 *     seq to hand out per (contact, project, stream), claimed in the same
 *     transaction as the insert. It is NOT derived from MAX(seq) over
 *     `c2c_outbox`, so pruning acked rows (or an ack) never re-issues a seq.
 *
 * R3. An epoch is a membership's identity, not a clock: the owner's member-row
 *     `uuid` (spec §10), random, compared ONLY for equality. `acceptInbound`
 *     compares the frame's `epoch` with the one stored for that mark:
 *       - a `project.invite` whose epoch DIFFERS from the stored one is `new`
 *         whatever its seq, and committing it sets high_water to that seq and
 *         stores the epoch (the stream restarts for the new membership). This is
 *         also how a contact deleted and re-added on one side recovers: its
 *         counters restart at 1 while the peer's mark is still high, and the
 *         re-invite carries a fresh epoch.
 *       - any other frame whose epoch differs from a stored one is `stale`;
 *         Task 5 refuses it with `stale_epoch` and consumes its seq (R4).
 *     Because "differs" cannot tell an old invite from a new one, the OWNER must
 *     cancel (terminal-ack) every still-queued frame of the old epoch for that
 *     contact and project whenever it mints a new epoch (unshare, re-invite,
 *     clone conversion) and before it enqueues the new invite: `cancelEpoch`.
 *     Then the only invite that can reach a peer with a different epoch is the
 *     newest one.
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
 *     high_water + 1 (or the R3 reset), via one conditional `UPDATE … WHERE
 *     high_water = ?` (or an INSERT for the first row), and return true/false.
 *     `false` means another delivery already took that seq: the caller must roll
 *     back its effect (throw out of `withTransaction`) and re-ack it as a dup.
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
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { buildFrame, parseFrame, REFUSALS } from "./frames.js";

/** How long a `busy` refusal holds its project's run (plan 1, task 4). */
export const BUSY_HOLD_MS = 60_000;

/** The stream key of a frame with no target instance yet (R1). */
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

/** R1: the stream a frame is numbered in. */
export function streamOf(toInstanceId) {
  return toInstanceId ?? WILDCARD_STREAM;
}

function c2cError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
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

function serialize(db, fn) {
  const prev = chains.get(db) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  chains.set(db, tail);
  tail.then(() => { if (chains.get(db) === tail) chains.delete(db); });
  return run;
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
 */
async function claimSeq(handle, { contactId, projectUuid, stream }) {
  const { rows } = await handle.execute({
    sql: "SELECT next_seq FROM c2c_outbox_seq WHERE contact_id = ? AND project_uuid = ? AND stream = ?",
    args: [contactId, projectUuid, stream],
  });
  const seq = rows.length ? Number(rows[0].next_seq) : 1;
  if (!isSeq(seq)) throw c2cError("c2c outbox: the stream counter is unreadable", "bad_state");
  await handle.execute({
    sql: `INSERT INTO c2c_outbox_seq (contact_id, project_uuid, stream, next_seq)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (contact_id, project_uuid, stream) DO UPDATE SET next_seq = excluded.next_seq`,
    args: [contactId, projectUuid, stream, seq + 1],
  });
  return seq;
}

/**
 * Queue one frame and return its sequence number.
 *
 * R2: the next seq comes from `c2c_outbox_seq` for this (contact, project, stream)
 * and is claimed inside the SAME transaction as the insert, so two concurrent calls
 * can never get the same one and a rollback never burns a number.
 *
 * The frame is validated by `parseFrame` before it is stored: a frame we could
 * never parse back would sit in the queue forever.
 *
 * @returns {Promise<number>} seq
 */
export async function enqueue(db, { contactId, projectUuid, kind, epoch, toInstanceId = null, body, localInstanceId }) {
  if (!Number.isSafeInteger(contactId) || contactId <= 0) throw c2cError("c2c outbox: contactId is required", "bad_argument");
  if (UNSEQUENCED.has(kind)) throw c2cError(`c2c outbox: ${kind} is never queued (it is not sequenced)`, "bad_argument");
  const stream = streamOf(toInstanceId);
  return withTransaction(db, async () => {
    const seq = await claimSeq(db, { contactId, projectUuid, stream });
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
      sql: `INSERT INTO c2c_outbox (contact_id, project_uuid, seq, kind, to_instance_id, frame_json)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [contactId, projectUuid, seq, frame.kind, frame.to_instance_id ?? null, JSON.stringify(frame)],
    });
    return seq;
  });
}

/**
 * Send every unacked frame for a contact, ordered by (project_uuid, stream, seq)
 * so each stream stays FIFO. `send(frame)` is the transport
 * (`peerManager.send(crowId, frame)`); it may be async and it throws when the
 * peer is not connected.
 *
 * A project whose next unacked frame was refused `busy` under 60 s ago is skipped
 * whole — the receiver's queue is full, so later frames of that project would
 * only pile up behind it. R8: a frame that cannot be read does the same, so no
 * later row is sent past the hole.
 *
 * @returns {Promise<number>} how many frames were sent
 */
export async function flush(db, send, { contactId, now = Date.now() } = {}) {
  const { rows } = await db.execute({
    sql: `SELECT id, project_uuid, seq, frame_json, last_refusal, last_attempt_at
            FROM c2c_outbox
           WHERE contact_id = ? AND acked_at IS NULL
           ORDER BY project_uuid, COALESCE(to_instance_id, '*'), seq`,
    args: [contactId],
  });
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
    await db.execute({
      sql: "UPDATE c2c_outbox SET attempts = attempts + 1, last_attempt_at = datetime('now') WHERE id = ?",
      args: [row.id],
    });
    sent += 1;
  }
  return sent;
}

/**
 * Mark a batch of seqs acked (the peer applied them).
 *
 * A seq only means something inside its stream (R1), and `project.ack` carries no
 * stream, so by default every stream of `projectUuid` is matched — pass `stream`
 * when the caller knows which stream it is acking.
 * @returns {Promise<number>} rows acked
 */
export async function onAck(db, { contactId, projectUuid, seqs, stream = null }) {
  const list = normalizeSeqs(seqs);
  if (!list.length) return 0;
  const marks = list.map(() => "?").join(",");
  const byStream = stream !== null;
  const res = await db.execute({
    sql: `UPDATE c2c_outbox SET acked_at = datetime('now')
           WHERE contact_id = ? AND project_uuid = ? AND acked_at IS NULL
             ${byStream ? "AND COALESCE(to_instance_id, '*') = ?" : ""}
             AND seq IN (${marks})`,
    args: byStream
      ? [contactId, projectUuid, stream, ...list]
      : [contactId, projectUuid, ...list],
  });
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
 * Like `onAck`, a seq names a frame only inside its stream (R1): pass `stream` to
 * end exactly one, or leave it null to end that seq in every stream.
 *
 * @returns {Promise<string|null>} the reason when the frame is ended, else null
 */
export async function onRefuse(db, { contactId, projectUuid, seq, reason, stream = null }) {
  if (!REFUSALS.includes(reason)) throw c2cError(`c2c outbox: unknown refusal ${String(reason)}`, "bad_argument");
  if (!isSeq(seq)) throw c2cError("c2c outbox: seq is required", "bad_argument");
  const terminal = TERMINAL.has(reason);
  const byStream = stream !== null;
  await db.execute({
    sql: `UPDATE c2c_outbox
             SET last_refusal = ?,
                 acked_at = CASE WHEN ? = 1 THEN datetime('now') ELSE acked_at END
           WHERE contact_id = ? AND project_uuid = ? AND seq = ?
             ${byStream ? "AND COALESCE(to_instance_id, '*') = ?" : ""}`,
    args: byStream
      ? [reason, terminal ? 1 : 0, contactId, projectUuid, seq, stream]
      : [reason, terminal ? 1 : 0, contactId, projectUuid, seq],
  });
  if (terminal) console.log(`[c2c] frame ${seq} closed with ${reason}`);
  return terminal ? reason : null;
}

/**
 * R3, owner side: end every still-queued frame for (contact, project) whose epoch is not
 * `keepEpoch`, before the invite of a new membership is enqueued. The peer then never
 * receives an older membership's invite after the newer one (epochs compare only for
 * equality), and the new invite resets its stream whatever seq it carries.
 * @returns {Promise<number>} frames cancelled
 */
export async function cancelEpoch(db, { contactId, projectUuid, keepEpoch }) {
  if (typeof keepEpoch !== "string" || !keepEpoch) throw c2cError("c2c outbox: keepEpoch is required", "bad_argument");
  const rows = (await db.execute({
    sql: "SELECT id, frame_json FROM c2c_outbox WHERE contact_id = ? AND project_uuid = ? AND acked_at IS NULL",
    args: [contactId, projectUuid],
  })).rows;
  let n = 0;
  for (const r of rows) {
    let epoch = null;
    try { epoch = JSON.parse(r.frame_json)?.epoch ?? null; } catch { epoch = null; }
    if (epoch === keepEpoch) continue;
    // An unreadable row is cancelled too: it can never be delivered for the new membership.
    await db.execute({ sql: "UPDATE c2c_outbox SET acked_at = datetime('now'), last_refusal = 'cancelled' WHERE id = ? AND acked_at IS NULL", args: [r.id] });
    n++;
  }
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
  const res = await db.execute({
    sql: "DELETE FROM c2c_outbox WHERE acked_at IS NOT NULL AND acked_at < datetime('now', ?)",
    args: [`-${days} days`],
  });
  return res.rowsAffected ?? 0;
}

/* ----------------------------------------------------------------- inbound */

const markArgs = ({ contactId, senderInstanceId, projectUuid, stream }) =>
  [contactId, senderInstanceId, projectUuid, stream];

async function readMark(handle, key) {
  const { rows } = await handle.execute({
    sql: `SELECT high_water, epoch FROM c2c_inbound_seq
           WHERE contact_id = ? AND sender_instance_id = ? AND project_uuid = ? AND stream = ?`,
    args: markArgs(key),
  });
  const row = rows[0];
  return { highWater: Number(row?.high_water ?? 0), epoch: row?.epoch ?? null };
}

/**
 * Where an incoming frame sits against its stream's mark, without writing:
 * `new` (apply it), `dup` (already applied, ack it), `gap` (something is missing
 * ahead of it) or `stale` (its epoch is one the receiver has already left; refuse
 * it with `stale_epoch` and consume its seq — R3, R4).
 *
 * @returns {Promise<"new"|"dup"|"gap"|"stale">}
 */
export async function acceptInbound(db, {
  contactId, senderInstanceId, projectUuid, stream = WILDCARD_STREAM, seq, epoch, kind,
}) {
  if (!isSeq(seq)) throw c2cError("c2c outbox: seq is required", "bad_argument");
  const mark = await readMark(db, { contactId, senderInstanceId, projectUuid, stream });
  const otherEpoch = typeof epoch === "string" && mark.epoch !== epoch;
  // R3: an invite for a different membership restarts the stream, whatever its seq.
  if (kind === "project.invite" && otherEpoch) return "new";
  // R3: any other frame from a membership the receiver no longer holds is stale, even
  // when its seq would otherwise look next or already applied.
  if (mark.epoch !== null && otherEpoch) return "stale";
  if (seq <= mark.highWater) return "dup";
  return seq === mark.highWater + 1 ? "new" : "gap";
}

/* The three conditional writes R6 allows. Each touches at most one row, and the
 * WHERE clause is the whole decision, so a second delivery of a seq takes nothing. */

// R3 reset: only an invite for a different membership may restart the stream; a second
// delivery of the same invite finds the epoch already stored and takes nothing.
const RESET_SQL = `UPDATE c2c_inbound_seq SET high_water = ?, epoch = ?
                    WHERE contact_id = ? AND sender_instance_id = ? AND project_uuid = ? AND stream = ?
                      AND (epoch IS NULL OR epoch <> ?)`;

// The next frame in order. COALESCE keeps a stored epoch: only a reset replaces it.
const ADVANCE_SQL = `UPDATE c2c_inbound_seq SET high_water = ?, epoch = COALESCE(?, epoch)
                      WHERE contact_id = ? AND sender_instance_id = ? AND project_uuid = ? AND stream = ?
                        AND high_water = ?`;

// The first frame of a stream (no row yet). DO NOTHING when one already exists.
const FIRST_SQL = `INSERT INTO c2c_inbound_seq
                     (contact_id, sender_instance_id, project_uuid, stream, high_water, epoch)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT (contact_id, sender_instance_id, project_uuid, stream) DO NOTHING`;

async function advance(handle, { contactId, senderInstanceId, projectUuid, stream, seq, epoch, kind }) {
  const key = { contactId, senderInstanceId, projectUuid, stream };
  const reset = kind === "project.invite" && typeof epoch === "string";
  if (reset) {
    const res = await handle.execute({ sql: RESET_SQL, args: [seq, epoch, ...markArgs(key), epoch] });
    if ((res.rowsAffected ?? 0) > 0) return true;
  }
  const moved = await handle.execute({ sql: ADVANCE_SQL, args: [seq, epoch ?? null, ...markArgs(key), seq - 1] });
  if ((moved.rowsAffected ?? 0) > 0) return true;
  // No row yet (or the mark is elsewhere). A first row may only start at 1, or be
  // the R3 reset of an invite, which is new whatever its seq.
  if (seq !== 1 && !reset) return false;
  const first = await handle.execute({ sql: FIRST_SQL, args: [...markArgs(key), seq, epoch ?? null] });
  return (first.rowsAffected ?? 0) > 0;
}

/**
 * Advance the high-water mark for a frame that was applied. The caller passes the
 * handle it already has and runs this inside the SAME transaction as the frame's
 * effect (`withTransaction`), so the effect and the mark commit or roll back
 * together — a crash can never leave a frame marked applied but not applied.
 *
 * R6: it takes the seq only when it is exactly high_water + 1 (or the R3 reset of
 * a newer-epoch invite), so a frame is applied at most once.
 *
 * @returns {Promise<boolean>} true when this call took the seq. `false` means
 *   another delivery already took it: roll the effect back (throw out of
 *   `withTransaction`) and re-ack the frame as a dup.
 */
export async function commitInbound(handle, {
  contactId, senderInstanceId, projectUuid, stream = WILDCARD_STREAM, seq, epoch, kind,
}) {
  if (!isSeq(seq)) throw c2cError("c2c outbox: seq is required", "bad_argument");
  return advance(handle, { contactId, senderInstanceId, projectUuid, stream, seq, epoch, kind });
}

/**
 * R4: consume the seq of a well-formed frame that will never be applied (a terminal
 * refusal: `forbidden`, `stale_epoch`, `unsupported`, `bad_frame`). It advances the
 * mark exactly like a commit, with no effect, so one refused frame never wedges the
 * frames after it.
 *
 * Same contract as `commitInbound`: run it in the caller's transaction and treat
 * `false` as "already taken" (nothing to do — the seq is gone either way).
 *
 * Known edge (the ruling's, not solved here): after the sender's counters restart
 * (contact deleted and re-added there), an in-flight frame from the abandoned
 * counter space can carry seq high_water + 1, so consuming it would move the mark
 * into the NEW epoch's numbering and make its next frame a dup. It only ever
 * advances for such a restart — after a reset that keeps the counter (unshare then
 * re-invite) every older-epoch frame is below the mark, so the call is a no-op.
 *
 * @returns {Promise<boolean>} true when this call took the seq
 */
export async function consumeInbound(handle, {
  contactId, senderInstanceId, projectUuid, stream = WILDCARD_STREAM, seq,
}) {
  if (!isSeq(seq)) throw c2cError("c2c outbox: seq is required", "bad_argument");
  return advance(handle, { contactId, senderInstanceId, projectUuid, stream, seq, epoch: null, kind: null });
}
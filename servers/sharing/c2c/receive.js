/**
 * Crow-to-Crow receive pipeline (plan 1, task 5; spec §9–§10).
 *
 * `handleC2cFrame` runs every frame that arrives on a contact's admitted peer
 * channel, in this order (the amended order of 2026-11-03, plus the Task 5 fix
 * wave, is binding):
 *
 *   1. parse; an envelope that does not parse is dropped with no reply (a refusal
 *      needs the frame's epoch, stream, seq and sender, which it lacks). A known
 *      kind whose BODY failed and an unknown kind both keep their parsed
 *      envelope, and continue as envelope-only frames (F3);
 *   2. a legacy (`sig`) proof is refused `update_required` (R5: a holding
 *      refusal) and flagged for the UI, WITHOUT consuming a seq (F4); a `cb`
 *      proof clears that flag again (F6);
 *   3. envelope-only frames then pass the routing check (F4: a foreign target is
 *      the holding `not_home`) and dedupe, and only then consume their seq and
 *      are refused `bad_frame` (a known kind whose body failed) or `unsupported`
 *      (an unknown kind) — R4;
 *   4. acks/refusals are applied only by the instance they name (S3), before any
 *      routing reply, so a sibling never answers them;
 *   5. a frame aimed at another instance is refused `not_home` (a null target is
 *      allowed only for an invite and for an unshare of a member that never
 *      accepted, which has no instance to aim at);
 *   6. dedupe against the stream's high-water mark: dup → re-ack, gap → refuse;
 *   7. the kind's handler is looked up BEFORE any transaction (F1): a kind whose
 *      module has not loaded is refused the holding `busy`, so the sender keeps
 *      its frame and the seq is not consumed;
 *   8. one transaction authorizes FIRST, reading the membership or visit inside
 *      it (F2) — a refusal consumes the seq in that same transaction and the
 *      refusal is sent after COMMIT; otherwise it commits the mark FIRST (S5) and
 *      runs the handler with the in-transaction `member`/`visit`. After COMMIT:
 *      ack, then flush (never inside, S4), then the handler's `afterCommit` hook
 *      (S7/W1) — no network I/O happens inside the transaction, and a hook is run
 *      only for an effect that really committed.
 *
 * A handler may RETURN `{ afterCommit: async () => … }`: the transaction is not the
 * place for a push, an ntfy call or an email (R7 holds the write lock, and the
 * transaction may still roll back). The pipeline captures the hook INSIDE the
 * transaction and runs it only when COMMIT succeeded — after the ack, and after the
 * flush when there is one. A dup, a refusal, the mark cap, a throwing handler or a
 * failed COMMIT drops it. It is wrapped in try/catch and logs
 * `[c2c] <kind> after-commit failed` without ever carrying the body.
 *
 * A throwing handler follows the outbox contract's failure path (S5/R4): the
 * transaction rolls back with the mark, a new transaction consumes the seq, then
 * the frame is refused `unsupported`. If that consume takes nothing (another
 * delivery already took the seq), the frame is re-acked as a dup instead.
 *
 * A contact may create at most C2C_MARK_CAP mark rows (F5): a frame that would
 * create one more is dropped whole — no reply, no consume — so an existing stream
 * keeps working while a new one cannot grow the table.
 *
 * The kind modules (owner.js, visitor.js) are injected through `ctx.handlers`, so
 * this pipeline is testable with stubs. Logs say `[c2c]` and never carry a body.
 */
import { buildFrame, parseFrame } from "./frames.js";
import {
  acceptInbound, ackIsForMe, commitInbound, consumeInbound, flush,
  onAck, onRefuse, streamOf, withTransaction,
} from "./outbox.js";
import { authorizeOwnerFrame, authorizeVisitorFrame } from "./authz.js";

/** The local dashboard_settings_overrides key prefix the UI reads (never synced). */
export const C2C_UPDATE_REQUIRED_PREFIX = "c2c_update_required:";

/** F5: how many `c2c_inbound_seq` rows one contact may ever create. */
export const C2C_MARK_CAP = 512;

/** F5: the cap line is logged once per contact per hour, never once per frame. */
const MARK_CAP_LOG_MS = 3_600_000;
const markCapLoggedAt = new Map();

/** Kinds the owner side receives (the visitor's accept/decline of an invite). */
const OWNER_KINDS = new Set(["project.accept", "project.decline"]);
/** Kinds the visitor side receives (the owner's invite, role change, unshare). */
const VISITOR_KINDS = new Set(["project.invite", "project.role", "project.unshare"]);
/** The handler each sequenced kind runs inside the commit transaction. */
const HANDLER_BY_KIND = Object.freeze({
  "project.invite": "onInvite",
  "project.accept": "onAccept",
  "project.decline": "onDecline",
  "project.role": "onRole",
  "project.unshare": "onUnshare",
});

const isUnsequenced = (kind) => kind === "project.ack" || kind === "project.refuse";

/** The stream address of a parsed frame (S1/S3). */
function addressOf(frame) {
  return {
    projectUuid: frame.project_uuid,
    peerInstanceId: frame.from_instance_id,
    epoch: frame.epoch,
    stream: streamOf(frame.to_instance_id),
    seq: frame.seq,
  };
}

/** The stream address of a parsed envelope (an unknown kind, or a failed body). */
function envelopeAddress(envelope) {
  return {
    projectUuid: envelope.project_uuid,
    peerInstanceId: envelope.from_instance_id,
    epoch: envelope.epoch,
    stream: streamOf(envelope.to_instance_id),
    seq: envelope.seq,
  };
}

/**
 * The routing rule (S1/S3): a frame aimed at this instance belongs here, and a
 * null target is allowed for an invite (sent before the visitor's instance is
 * known) and for an unshare (a member that never accepted has no instance to aim
 * at, so its unshare rides the "*" stream — O2 of task 6). An unknown kind's null
 * target cannot be judged, so it is allowed (F4: "null where allowed").
 */
function routesHere(toInstanceId, kind, localInstanceId) {
  if (toInstanceId === null) {
    return kind === null || kind === "project.invite" || kind === "project.unshare";
  }
  return toInstanceId === localInstanceId;
}

/** Send a reply without letting a dead link break the receive path. */
async function safeSend(ctx, crowId, frame) {
  try {
    await ctx.send(crowId, frame);
  } catch (err) {
    console.warn(`[c2c] reply failed: ${err?.code || err?.message || "send failed"}`);
  }
}

/** Ack one seq on its own stream; the ack names the frame's sender (S3). */
async function sendAck(ctx, crowId, address) {
  await safeSend(ctx, crowId, buildFrame({
    kind: "project.ack",
    projectUuid: address.projectUuid,
    fromInstanceId: ctx.localInstanceId,
    toInstanceId: address.peerInstanceId,
    body: { epoch: address.epoch, stream: address.stream, seqs: [address.seq] },
  }));
}

/** Refuse one seq on its own stream; a refusal must be able to name a stream. */
async function sendRefusal(ctx, crowId, address, reason) {
  if (!address.epoch || !address.seq) return; // an unsequenced frame has no stream to name
  await safeSend(ctx, crowId, buildFrame({
    kind: "project.refuse",
    projectUuid: address.projectUuid,
    fromInstanceId: ctx.localInstanceId,
    toInstanceId: address.peerInstanceId,
    body: { epoch: address.epoch, stream: address.stream, seq: address.seq, reason },
  }));
}

/**
 * R5/step 2: remember that this contact's Crow is on the legacy proof, so the
 * owner's UI can ask them to update. LOCAL scope (dashboard_settings_overrides),
 * keyed per contact; a write failure is logged and never breaks the receive path.
 */
async function recordUpdateRequired(db, localInstanceId, crowId) {
  if (!localInstanceId) return;
  try {
    await db.execute({
      sql: `INSERT INTO dashboard_settings_overrides (key, instance_id, value, updated_at)
            VALUES (?, ?, '1', datetime('now'))
            ON CONFLICT(key, instance_id) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      args: [C2C_UPDATE_REQUIRED_PREFIX + crowId, localInstanceId],
    });
  } catch (err) {
    if (!/no such table/i.test(String(err?.message || err))) {
      console.warn(`[c2c] could not record update_required: ${err?.message}`);
    }
  }
}

/**
 * F6: the contact just sent a `cb`-proof frame, so it is on the bound proof
 * again (or never was on the legacy one) and the UI's "ask them to update Crow"
 * row must go away. Same LOCAL scope as the flag; a failure never breaks the
 * receive path.
 */
async function clearUpdateRequired(db, localInstanceId, crowId) {
  if (!localInstanceId) return;
  try {
    await db.execute({
      sql: "DELETE FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?",
      args: [C2C_UPDATE_REQUIRED_PREFIX + crowId, localInstanceId],
    });
  } catch (err) {
    if (!/no such table/i.test(String(err?.message || err))) {
      console.warn(`[c2c] could not clear update_required: ${err?.message}`);
    }
  }
}

/** The address fields a parsed frame shares with the inbound mark (S1). */
function inboundKey(contactId, address) {
  return {
    contactId,
    senderInstanceId: address.peerInstanceId,
    projectUuid: address.projectUuid,
    epoch: address.epoch,
    stream: address.stream,
    seq: address.seq,
  };
}

/**
 * F5: would this consume/commit CREATE a new `c2c_inbound_seq` row? A stream that
 * already has a mark always keeps working, so only a new (contact, sender,
 * project, epoch, stream) can push a contact's table past the cap. At or above it
 * the frame is dropped whole (no reply, no consume): the sender keeps it, and the
 * contact's epoch churn — not this frame — is the problem. The line is logged once
 * per contact per hour, never once per frame.
 *
 * Runs on the caller's handle, inside its transaction, so two frames cannot both
 * see "under the cap" and then both create a row.
 */
async function markCapReached(db, contactId, key) {
  const { rows: existing } = await db.execute({
    sql: `SELECT 1 AS present FROM c2c_inbound_seq
           WHERE contact_id = ? AND sender_instance_id = ? AND project_uuid = ? AND epoch = ? AND stream = ?
           LIMIT 1`,
    args: [key.contactId, key.senderInstanceId, key.projectUuid, key.epoch, key.stream],
  });
  if (existing.length > 0) return false; // an existing stream is always allowed
  const { rows } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM c2c_inbound_seq WHERE contact_id = ?",
    args: [contactId],
  });
  if (Number(rows[0]?.n ?? 0) < C2C_MARK_CAP) return false;
  const now = Date.now();
  if (now - (markCapLoggedAt.get(contactId) ?? 0) >= MARK_CAP_LOG_MS) {
    markCapLoggedAt.set(contactId, now);
    console.warn(`[c2c] mark cap reached for contact ${contactId}`);
  }
  return true;
}

/**
 * The outbox contract's failure path (S5/R4): the effect transaction rolled back
 * with the mark, so consume the seq in a new transaction and refuse the frame
 * `unsupported`. A false consume means another delivery took the seq (and may
 * have applied it): re-ack as a dup instead, never refuse it.
 */
async function recoverFailedFrame(ctx, crowId, contactId, address) {
  const key = inboundKey(contactId, address);
  let took = false;
  let capped = false;
  try {
    await withTransaction(ctx.db, async () => {
      if (await markCapReached(ctx.db, contactId, key)) { capped = true; return; }
      took = await consumeInbound(ctx.db, key);
    });
  } catch (err) {
    console.warn(`[c2c] could not consume a failed frame: ${err?.message}`);
    return;
  }
  if (capped) return; // F5: no row, no reply, no consume
  if (!took) {
    await sendAck(ctx, crowId, address);
    return;
  }
  await sendRefusal(ctx, crowId, address, "unsupported");
}

/**
 * F3/F4: a frame whose envelope parsed but which carries no usable body — an
 * unknown kind (`reason === "unsupported"`, R4) or a known kind whose body failed
 * (`reason === "bad_frame"`). It passes the same proof gate as a full frame (the
 * caller already ran it, so a legacy proof held it without consuming), then the
 * routing check and dedupe, and only then consumes its seq and is refused. A
 * frame aimed at another instance is HELD (`not_home`) for that instance instead.
 *
 * With no epoch/seq there is no stream to name: nothing to consume, no refusal.
 */
async function handleEnvelopeOnly(ctx, crowId, contactId, envelope, reason, kind) {
  const { db } = ctx;
  const address = envelopeAddress(envelope);
  if (!address.epoch || !address.seq) {
    console.warn(`[c2c] ${reason} frame with no stream address dropped`);
    return;
  }

  if (!routesHere(envelope.to_instance_id, kind, ctx.localInstanceId)) {
    await sendRefusal(ctx, crowId, address, "not_home");
    return;
  }

  const key = inboundKey(contactId, address);
  const verdict = await acceptInbound(db, key);
  if (verdict === "dup") {
    await sendAck(ctx, crowId, address);
    return;
  }
  if (verdict === "gap") {
    await sendRefusal(ctx, crowId, address, "gap");
    return;
  }

  let took = false;
  let capped = false;
  try {
    await withTransaction(db, async () => {
      if (await markCapReached(db, contactId, key)) { capped = true; return; }
      took = await consumeInbound(db, key);
    });
  } catch (err) {
    console.warn(`[c2c] could not consume a ${reason} frame: ${err?.message}`);
    return;
  }
  if (capped) return; // F5: no reply, no consume
  if (!took) {
    await sendAck(ctx, crowId, address);
    return;
  }
  await sendRefusal(ctx, crowId, address, reason);
}

/**
 * Handle one frame from an admitted contact session.
 *
 * @param {{db:object, send:Function, localInstanceId:string, contactByCrowId:Function,
 *   handlers:object, beforeTransaction?:Function}} ctx
 *   `send(crowId, frame)` is the transport. `contactByCrowId(crowId)` resolves the
 *   admitted contact row (or null). `handlers` maps onInvite/onAccept/onDecline/
 *   onRole/onUnshare (Tasks 6/7) plus an optional onRefusal; a kind whose handler
 *   is not loaded is refused `busy` (F1). A handler may RETURN
 *   `{ afterCommit: async () => … }` — network I/O belongs there, never in the
 *   transaction (S7/W1; the hook runs after COMMIT, the ack and the flush). `beforeTransaction` is a TEST SEAM (F2):
 *   it runs once, just before the frame's transaction opens, so a test can commit
 *   a write (a re-invite) that the in-transaction authorization must see.
 * @param {string} crowId the ADMITTED contact's crow id
 * @param {object} payload the raw frame
 * @param {{proof:"cb"|"sig", instanceId:string|null}} meta the connection's proof
 *   and CLAIMED instance id (routing only, never authorization)
 */
export async function handleC2cFrame(ctx, crowId, payload, meta = {}) {
  const { db, localInstanceId, handlers = {} } = ctx;

  // 1. Parse. An envelope that does not parse is dropped without a reply: a
  // refusal needs the frame's epoch, stream, seq and sender, which it lacks.
  const parsed = parseFrame(payload);
  if (!parsed.ok && !parsed.envelope) {
    console.warn("[c2c] bad frame");
    return;
  }

  // The frame is attributed to the admitted contact, never to a sender field.
  const contact = await ctx.contactByCrowId(crowId);
  if (!contact) return;
  const contactId = Number(contact.id);

  const frame = parsed.ok ? parsed.frame : null;
  const envelope = parsed.ok ? null : parsed.envelope;
  const address = frame ? addressOf(frame) : envelopeAddress(envelope);
  // A known kind's body failure still names its kind; an unknown one does not.
  // An unknown kind is routed as `null` (its null target cannot be judged, so it is allowed
  // and consumed, R4); a known kind with a bad body keeps its name for the routing rule.
  const kind = frame ? frame.kind : (parsed.reason === "unsupported" ? null : (typeof payload?.kind === "string" ? payload.kind : null));

  // 2. Legacy proof: a holding refusal (R5) and a UI flag. F4: nothing is
  // consumed here — the frame may still apply once its sender updates. An ack or
  // refusal from that session has no stream to hold or answer, so it is dropped.
  if (meta?.proof !== "cb") {
    await recordUpdateRequired(db, localInstanceId, crowId);
    if (frame && isUnsequenced(frame.kind)) return;
    if (!address.epoch || !address.seq) {
      console.warn("[c2c] legacy-proof frame with no stream address dropped");
      return;
    }
    await sendRefusal(ctx, crowId, address, "update_required");
    return;
  }

  // F6: a bound-proof frame means this contact is no longer on the legacy proof.
  await clearUpdateRequired(db, localInstanceId, crowId);

  // 3. F3/F4: an unknown kind or a known kind whose body failed. Proof has
  // passed; routing and dedupe decide, then the seq is consumed.
  if (envelope) {
    await handleEnvelopeOnly(ctx, crowId, contactId, envelope, parsed.reason, kind);
    return;
  }

  // 4. Acks/refusals are answered by the named instance only (S3), and this runs
  // BEFORE the not_home check: a sibling applies nothing and sends no reply.
  if (isUnsequenced(frame.kind)) {
    if (!ackIsForMe(frame, localInstanceId)) return;
    if (frame.kind === "project.ack") {
      await onAck(db, {
        contactId,
        projectUuid: frame.project_uuid,
        epoch: frame.body.epoch,
        stream: frame.body.stream,
        seqs: frame.body.seqs,
      });
    } else {
      const body = frame.body;
      const terminal = await onRefuse(db, {
        contactId,
        projectUuid: frame.project_uuid,
        epoch: body.epoch,
        stream: body.stream,
        seq: body.seq,
        reason: body.reason,
      });
      try {
        await handlers.onRefusal?.({ contactId, crowId, frame, reason: body.reason, terminal });
      } catch (err) {
        console.warn(`[c2c] onRefusal failed: ${err?.message || err}`);
      }
    }
    return;
  }

  // 5. Routing: only an invite may be sent before the visitor's instance is known.
  if (!routesHere(frame.to_instance_id, frame.kind, localInstanceId)) {
    await sendRefusal(ctx, crowId, address, "not_home");
    return;
  }

  // 6. Dedupe against the frame's own stream (S1). A dup is re-acked; a gap is
  // refused and leaves the mark alone so the missing frame can still land.
  const key = inboundKey(contactId, address);
  const verdict = await acceptInbound(db, key);
  if (verdict === "dup") {
    await sendAck(ctx, crowId, address);
    return;
  }
  if (verdict === "gap") {
    await sendRefusal(ctx, crowId, address, "gap");
    return;
  }

  // 7. F1: the kind's handler must exist before anything is committed. A host
  // whose owner.js/visitor.js has not (or not yet successfully) loaded HOLDS the
  // frame with `busy` instead: the seq is not consumed, so the sender re-sends it
  // once the module is there.
  const handler = handlers[HANDLER_BY_KIND[frame.kind]];
  if (typeof handler !== "function") {
    console.warn(`[c2c] ${frame.kind} handler not loaded`);
    await sendRefusal(ctx, crowId, address, "busy");
    return;
  }

  // 8. One transaction. F2: authorization runs INSIDE it and re-reads the live
  // membership/visit there, so a re-invite (or unshare) that commits between the
  // frame's arrival and this transaction is seen by the rules. S5: the mark is
  // committed before the effect, and the effect only runs when it took the seq.
  let committed = false;
  let consumed = false;
  let refusal = null;
  let capped = false;
  // The handler's in-transaction return value; its `afterCommit` hook (S7/W1) runs
  // only after this transaction has committed.
  let handlerResult;
  // F2's test seam: a write committed just before BEGIN (a re-invite) must be seen
  // by the authorization INSIDE the transaction below.
  if (typeof ctx.beforeTransaction === "function") await ctx.beforeTransaction();
  try {
    await withTransaction(db, async () => {
      // F5: a frame that would create one mark row too many is dropped whole.
      if (await markCapReached(db, contactId, key)) { capped = true; return; }

      const auth = OWNER_KINDS.has(frame.kind)
        ? await authorizeOwnerFrame(db, { frame, contactId })
        : VISITOR_KINDS.has(frame.kind)
          ? await authorizeVisitorFrame(db, { frame, contactId })
          : { ok: false, reason: "unsupported" };

      if (!auth.ok) {
        // R4: a refused frame is consumed with no effect, in this transaction, so
        // one refused frame never wedges the frames after it.
        refusal = auth.reason;
        consumed = await consumeInbound(db, key);
        return;
      }

      if (!(await commitInbound(db, key))) return; // another delivery took the seq: a dup
      handlerResult = await handler(db, {
        frame,
        member: auth.member ?? null,
        visit: auth.visit ?? null,
        contactId,
        localInstanceId,
      });
      committed = true;
    });
  } catch (err) {
    // Never the body: it is the contact's own words. The failure path consumes
    // the seq in a new transaction, then refuses `unsupported` (S5/R4).
    console.warn(`[c2c] ${frame.kind} failed: ${err?.message || err}`);
    await recoverFailedFrame(ctx, crowId, contactId, address);
    return;
  }

  // After COMMIT. F5: a capped frame gets no reply at all.
  if (capped) return;
  if (refusal) {
    // F2: the refusal was decided (and its seq consumed) inside the transaction;
    // it is sent only now, after COMMIT.
    if (consumed) await sendRefusal(ctx, crowId, address, refusal);
    else await sendAck(ctx, crowId, address); // already taken: a dup, not a refusal
    return;
  }
  // A false commit means another delivery took the seq: re-ack as a dup, no effect.
  await sendAck(ctx, crowId, address);
  if (!committed) return;

  // S4: ack, then flush, never inside the transaction. The handler may have
  // queued frames (a role change, an accept), and those go now.
  try {
    await flush(db, (outbound) => ctx.send(crowId, outbound), { contactId });
  } catch (err) {
    console.warn(`[c2c] flush after ${frame.kind} failed: ${err?.message || err}`);
  }

  // W1/S7: the handler's post-commit hook, if it returned one. Every path that did
  // not really commit (a dup, a refusal, the cap, a throw, a failed COMMIT) has
  // already returned above, so an effect that did not happen is never announced.
  const afterCommit = handlerResult?.afterCommit;
  if (typeof afterCommit === "function") {
    try {
      await afterCommit();
    } catch (err) {
      // Never the body: it is the contact's own words.
      console.warn(`[c2c] ${frame.kind} after-commit failed: ${err?.message || err}`);
    }
  }
}
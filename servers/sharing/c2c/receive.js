/**
 * Crow-to-Crow receive pipeline (plan 1, task 5; spec §9–§10).
 *
 * `handleC2cFrame` runs every frame that arrives on a contact's admitted peer
 * channel, in this order (the amended order of 2026-11-03 is binding):
 *
 *   1. parse; a broken envelope is dropped with no reply, an unknown kind whose
 *      envelope parses consumes its seq (R4) and is refused `unsupported`;
 *   2. a legacy (`sig`) proof is refused `update_required` (R5: a holding
 *      refusal) and flagged for the UI;
 *   3. acks/refusals are applied only by the instance they name (S3), before any
 *      routing reply, so a sibling never answers them;
 *   4. a frame aimed at another instance is refused `not_home` (a null target is
 *      allowed only for an invite);
 *   5. dedupe against the stream's high-water mark: dup → re-ack, gap → refuse;
 *   6. authorize against the live membership (owner side) or the visit (visitor
 *      side); a refusal is a consume with no effect, then the refusal reply;
 *   7. one transaction commits the mark FIRST (S5) and runs the handler only when
 *      it took the seq; after COMMIT ack, then flush (never inside, S4).
 *
 * A throwing handler follows the outbox contract's failure path (S5/R4): the
 * transaction rolls back with the mark, a new transaction consumes the seq, then
 * the frame is refused `unsupported`. If that consume takes nothing (another
 * delivery already took the seq), the frame is re-acked as a dup instead.
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

/** The stream address of an unknown kind's parsed envelope (nothing else exists). */
function envelopeAddress(envelope) {
  return {
    projectUuid: envelope.project_uuid,
    peerInstanceId: envelope.from_instance_id,
    epoch: envelope.epoch,
    stream: streamOf(envelope.to_instance_id),
    seq: envelope.seq,
  };
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
 * The outbox contract's failure path (S5/R4): the effect transaction rolled back
 * with the mark, so consume the seq in a new transaction and refuse the frame
 * `unsupported`. A false consume means another delivery took the seq (and may
 * have applied it): re-ack as a dup instead, never refuse it.
 */
async function recoverFailedFrame(ctx, crowId, contactId, address) {
  let took = false;
  try {
    took = await withTransaction(ctx.db, () => consumeInbound(ctx.db, inboundKey(contactId, address)));
  } catch (err) {
    console.warn(`[c2c] could not consume a failed frame: ${err?.message}`);
    return;
  }
  if (!took) {
    await sendAck(ctx, crowId, address);
    return;
  }
  await sendRefusal(ctx, crowId, address, "unsupported");
}

/**
 * Step 1's unknown-kind branch: the envelope parsed, so its seq is consumable
 * even though the kind is not (R4) — a newer Crow's frame must not wedge the
 * stream. The refusal follows. With no epoch/seq there is no stream to name, so
 * there is no refusal to send either.
 */
async function handleUnknownKind(ctx, crowId, contactId, envelope) {
  const address = envelopeAddress(envelope);
  if (!address.epoch || !address.seq) {
    console.warn("[c2c] unsupported frame with no stream address dropped");
    return;
  }
  let took = false;
  try {
    took = await withTransaction(ctx.db, () => consumeInbound(ctx.db, inboundKey(contactId, address)));
  } catch (err) {
    console.warn(`[c2c] could not consume an unsupported frame: ${err?.message}`);
    return;
  }
  if (!took) {
    await sendAck(ctx, crowId, address);
    return;
  }
  await sendRefusal(ctx, crowId, address, "unsupported");
}

/**
 * Handle one frame from an admitted contact session.
 *
 * @param {{db:object, send:Function, localInstanceId:string, contactByCrowId:Function, handlers:object}} ctx
 *   `send(crowId, frame)` is the transport. `contactByCrowId(crowId)` resolves the
 *   admitted contact row (or null). `handlers` maps onInvite/onAccept/onDecline/
 *   onRole/onUnshare (Tasks 6/7) plus an optional onRefusal.
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
  if (!parsed.ok) {
    if (parsed.reason === "unsupported" && parsed.envelope) {
      const contact = await ctx.contactByCrowId(crowId);
      if (!contact) return;
      await handleUnknownKind(ctx, crowId, Number(contact.id), parsed.envelope);
      return;
    }
    console.warn("[c2c] bad frame");
    return;
  }

  // The frame is attributed to the admitted contact, never to a sender field.
  const contact = await ctx.contactByCrowId(crowId);
  if (!contact) return;
  const contactId = Number(contact.id);
  const frame = parsed.frame;
  const address = addressOf(frame);

  // 2. Legacy proof: a holding refusal (R5) and a UI flag. An ack or refusal from
  // that session has no stream to hold or answer, so it is dropped.
  if (meta?.proof !== "cb") {
    await recordUpdateRequired(db, localInstanceId, crowId);
    if (isUnsequenced(frame.kind)) return;
    await sendRefusal(ctx, crowId, address, "update_required");
    return;
  }

  // 3. Acks/refusals are answered by the named instance only (S3), and this runs
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

  // 4. Routing: only an invite may be sent before the visitor's instance is known.
  if (frame.to_instance_id === null) {
    if (frame.kind !== "project.invite") {
      await sendRefusal(ctx, crowId, address, "not_home");
      return;
    }
  } else if (frame.to_instance_id !== localInstanceId) {
    await sendRefusal(ctx, crowId, address, "not_home");
    return;
  }

  // 5. Dedupe against the frame's own stream (S1). A dup is re-acked; a gap is
  // refused and leaves the mark alone so the missing frame can still land.
  const verdict = await acceptInbound(db, inboundKey(contactId, address));
  if (verdict === "dup") {
    await sendAck(ctx, crowId, address);
    return;
  }
  if (verdict === "gap") {
    await sendRefusal(ctx, crowId, address, "gap");
    return;
  }

  // 6. Authorize. KNOWN_KINDS is closed by frames.js, so every kind reaches one
  // rule. A refusal consumes the seq with no effect (R4), then is sent.
  const auth = OWNER_KINDS.has(frame.kind)
    ? await authorizeOwnerFrame(db, { frame, contactId })
    : VISITOR_KINDS.has(frame.kind)
      ? await authorizeVisitorFrame(db, { frame, contactId })
      : { ok: false, reason: "unsupported" };
  if (!auth.ok) {
    let took = false;
    try {
      took = await withTransaction(db, () => consumeInbound(db, inboundKey(contactId, address)));
    } catch (err) {
      console.warn(`[c2c] could not consume a refused frame: ${err?.message}`);
      return;
    }
    if (took) await sendRefusal(ctx, crowId, address, auth.reason);
    else await sendAck(ctx, crowId, address);
    return;
  }

  // 7. S5: commit the mark FIRST, and run the effect only when it took the seq.
  // A false commit means another delivery took it: re-ack as a dup, no effect.
  const handlerName = HANDLER_BY_KIND[frame.kind];
  let committed = false;
  try {
    committed = await withTransaction(db, async () => {
      if (!(await commitInbound(db, inboundKey(contactId, address)))) return false;
      const handler = handlers[handlerName];
      if (typeof handler !== "function") throw new Error(`no handler for ${frame.kind}`);
      await handler(db, {
        frame,
        member: auth.member ?? null,
        visit: auth.visit ?? null,
        contactId,
        localInstanceId,
      });
      return true;
    });
  } catch (err) {
    // Never the body: it is the contact's own words. The failure path consumes
    // the seq in a new transaction, then refuses `unsupported` (S5/R4).
    console.warn(`[c2c] ${frame.kind} failed: ${err?.message || err}`);
    await recoverFailedFrame(ctx, crowId, contactId, address);
    return;
  }

  // After COMMIT: ack, then flush (S4: never inside the transaction). The handler
  // may have queued frames (a role change, an accept), and those go now.
  await sendAck(ctx, crowId, address);
  if (!committed) return;
  try {
    await flush(db, (outbound) => ctx.send(crowId, outbound), { contactId });
  } catch (err) {
    console.warn(`[c2c] flush after ${frame.kind} failed: ${err?.message || err}`);
  }
}
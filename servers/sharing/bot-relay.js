/**
 * Crow Sharing — Bot Relay State + Send/Receive
 *
 * Owns the _pendingRelays and _localInstanceName singletons, plus the
 * sendBotRelay and handleIncomingBotRelay functions.
 */

import { randomBytes } from "node:crypto";
import { createNotification } from "../shared/notifications.js";
import { getOrCreateLocalInstanceId } from "../gateway/instance-registry.js";
import { getManagersOrNull } from "./managers.js";
import { peerTrust } from "../shared/peer-trust.js";
import { claimOnce } from "./processed-events.js";

// ─── Bot Relay: AI-to-AI Task Delegation ───

// Pending relays waiting for results (relay_id → { timeout, instanceName })
const _pendingRelays = new Map();

// Cached local instance name (resolved at first relay)
let _localInstanceName = null;

export async function resolveLocalInstanceName(db) {
  if (_localInstanceName) return _localInstanceName;
  const localId = getOrCreateLocalInstanceId();
  const result = await db.execute({
    sql: "SELECT name FROM crow_instances WHERE id = ?",
    args: [localId],
  });
  _localInstanceName = result.rows.length > 0 ? result.rows[0].name : null;
  return _localInstanceName;
}

/**
 * Look up a pending relay by relayId, clear its timeout, remove it from the
 * map, and return the entry.  Returns undefined if not found.
 * Used by boot.js's bot_relay_result handler.
 */
export function resolvePendingRelay(relayId) {
  const pending = _pendingRelays.get(relayId);
  if (pending) {
    clearTimeout(pending.timeout);
    _pendingRelays.delete(relayId);
  }
  return pending;
}

/** How long a sent relay waits for its result before the "No response" notification. */
export const BOT_RELAY_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Send a task to a remote Crow instance for execution.
 * Uses Nostr self-messaging with target_instance for routing.
 * `opts.timeoutMs` (default 5 min) bounds the wait for the result.
 * Returns { ok, message, relayId? }
 */
export async function sendBotRelay(instanceName, task, { timeoutMs = BOT_RELAY_TIMEOUT_MS } = {}) {
  const waitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : BOT_RELAY_TIMEOUT_MS;
  const managers = getManagersOrNull();
  if (!managers) return { ok: false, message: "Sharing server not initialized" };
  const { db, identity, nostrManager } = managers;

  // Verify the target instance exists and is active
  const result = await db.execute({
    sql: "SELECT * FROM crow_instances WHERE name = ? AND status = 'active'",
    args: [instanceName],
  });
  if (result.rows.length === 0) return { ok: false, message: `Instance not found or inactive: ${instanceName}` };

  const localName = await resolveLocalInstanceName(db);
  const relayId = randomBytes(16).toString("hex");

  const envelope = JSON.stringify({
    type: "crow_social",
    version: 1,
    subtype: "bot_relay",
    payload: {
      relay_id: relayId,
      task,
      target_instance: instanceName,
      sender_name: localName || "unknown",
      sender_instance: localName || "unknown",
      sender_crow_id: identity.crowId,
      timestamp: new Date().toISOString(),
    },
  });

  try {
    const delivery = await nostrManager.sendSelfMessage(envelope);

    // Track the pending relay until its result or the timeout
    const timeout = setTimeout(async () => {
      _pendingRelays.delete(relayId);
      try {
        await createNotification(db, {
          title: `No response from ${instanceName}`,
          body: `Relay task timed out: ${task.slice(0, 100)}`,
          type: "system",
          source: "sharing:bot_relay_timeout",
        });
      } catch {}
    }, waitMs);
    _pendingRelays.set(relayId, { timeout, instanceName });

    return {
      ok: true,
      message: `Task relayed to ${instanceName} via ${delivery.relays.length} relay(s).`,
      relayId,
    };
  } catch (err) {
    return { ok: false, message: `Failed to relay task: ${err.message}` };
  }
}

/**
 * Handle an incoming bot_relay request: execute the task using local AI + tools.
 * `opts.runOneShot` replaces the AI one-shot (default: gateway/ai/one-shot.js).
 */
export async function handleIncomingBotRelay(payload, db, identity, nostrManager, opts = {}) {
  const { relay_id, task, sender_instance, sender_name } = payload;
  console.log(`[sharing] Bot relay from ${sender_instance}: ${task}`);

  let resultText = "";
  let status = "success";

  try {
    const runOneShot = opts.runOneShot || (await import("../gateway/ai/one-shot.js")).runOneShot;
    resultText = await runOneShot(
      "You are a helpful assistant. Execute the requested task using available tools. Reply with a brief result (1-2 sentences).",
      task
    );
  } catch (err) {
    if (err.code === "not_configured") {
      // No AI provider — create notification for manual handling
      try {
        await createNotification(db, {
          title: `Relay task from ${sender_name || sender_instance}`,
          body: task,
          type: "system",
          source: "sharing:bot_relay_manual",
          priority: "high",
        });
      } catch {}
      resultText = "No AI provider configured. Task forwarded as notification.";
      status = "error";
    } else {
      resultText = `Error: ${err.message}`;
      status = "error";
    }
  }

  // Truncate result
  if (resultText.length > 500) resultText = resultText.slice(0, 497) + "...";

  // Send result back
  const localName = await resolveLocalInstanceName(db);
  const envelope = JSON.stringify({
    type: "crow_social",
    version: 1,
    subtype: "bot_relay_result",
    payload: {
      relay_id,
      status,
      result: resultText,
      target_instance: sender_instance,
      responder_instance: localName || "unknown",
      timestamp: new Date().toISOString(),
    },
  });

  try {
    await nostrManager.sendSelfMessage(envelope);
    console.log(`[sharing] Bot relay result sent to ${sender_instance}`);
  } catch (err) {
    console.warn(`[sharing] Failed to send relay result: ${err.message}`);
  }
}

// ─── Inbound routing (PT-2.0, PT-2a) ───
//
// The broad Nostr subscription takes DMs from ANY author, and a bot_relay
// task runs the local AI with the chat tools. Legitimate relays are sent by
// sendBotRelay/handleIncomingBotRelay with sendSelfMessage, i.e. signed by
// this Crow ID's own Nostr key (sibling instances share the seed, so they
// share that key). A task is therefore accepted only when
//   1. the Nostr sender is our own key, and
//   2. the named sender/responder instance is a trusted, live paired row
//      (PT-1's peerTrust predicate, which fails closed on DB errors).
// Everything else is dropped with a warning and no AI run.
//
// PT-2a (replay): our own old signed events stay public on relays, and the
// in-memory seen set is fresh per subscription, so a restart, a re-wire, a
// re-publish, or a second process on the same DB could run a task again. So
// an event must also be fresh (created_at within BOT_RELAY_MAX_SKEW_S of now,
// both sides) and win a persisted, fail-closed claim in the LOCAL
// processed_control_events table (claimOnce).

/** The largest accepted |now - event.created_at| for a bot relay event, in seconds. */
export const BOT_RELAY_MAX_SKEW_S = 600;
const RELAY_ID_RE = /^[0-9a-f]{32}$/;

const xOnly = (k) => (typeof k === "string" && k.length === 66 ? k.slice(2) : k);

/** True when a Nostr event author is this Crow ID's own secp256k1 key (x-only compare, as nostr.js does). */
export function isOwnNostrSender(senderPubkey, ownSecpPubkey) {
  return typeof senderPubkey === "string" && typeof ownSecpPubkey === "string" && !!senderPubkey
    && xOnly(senderPubkey).toLowerCase() === xOnly(ownSecpPubkey).toLowerCase();
}

async function namedInstanceTrusted(db, name, peerTrustOpts) {
  if (typeof name !== "string" || !name) return false;
  let rows;
  try {
    ({ rows } = await db.execute({ sql: "SELECT id FROM crow_instances WHERE name = ?", args: [name] }));
  } catch {
    return false; // fail closed
  }
  for (const { id } of rows) {
    if ((await peerTrust(db, id, peerTrustOpts)).ok) return true;
  }
  return false;
}

/**
 * Route an inbound `bot_relay` / `bot_relay_result` crow_social message.
 *
 * Order: shape → sender → target → age → (result only: resolve the local
 * pending relay) → claim → trust. The pending relay is resolved BEFORE the
 * claim because _pendingRelays lives only in the process that sent the relay,
 * and every process that builds the sharing server runs Nostr receive: if a
 * sibling process on the same DB won the claim, the sender must still clear
 * its timer or it raises a false "No response". The claim comes AFTER the
 * target check because self-DMs reach every sibling, including the sender: a
 * claim on our own outgoing echo would consume the key before the real event.
 * Only the notification and, for bot_relay, the run are gated on claim + trust.
 *
 * Seams (`localName`, `run`, `notify`, `freshClient`, `runOneShot`) default
 * to production.
 * @returns {Promise<'handled'|'ignored'>}
 */
export async function routeBotRelay({
  subtype, payload, senderPubkey, db, identity, nostrManager, eventCreatedAt,
  localName, run = handleIncomingBotRelay, notify = (n) => createNotification(db, n), freshClient, runOneShot,
}) {
  // Shape.
  if (!payload || typeof payload !== "object") return "ignored";
  if (typeof payload.relay_id !== "string" || !RELAY_ID_RE.test(payload.relay_id)) return "ignored";
  if (!Number.isInteger(eventCreatedAt) || eventCreatedAt <= 0) return "ignored";

  // Sender.
  const claimed = subtype === "bot_relay" ? payload.sender_instance : payload.responder_instance;
  if (!isOwnNostrSender(senderPubkey, identity?.secp256k1Pubkey)) {
    console.warn(`[sharing] ${subtype} dropped: sender is not this Crow ID's own Nostr key (claimed instance ${String(claimed).slice(0, 64)})`);
    return "ignored";
  }

  // Target.
  const name = localName ?? await resolveLocalInstanceName(db);
  if (payload.target_instance !== name) return "ignored"; // not for us

  // Age.
  const skew = Math.floor(Date.now() / 1000) - eventCreatedAt;
  if (Math.abs(skew) > BOT_RELAY_MAX_SKEW_S) {
    console.warn(`[sharing] ${subtype} dropped: event created_at is ${skew}s from now (limit ±${BOT_RELAY_MAX_SKEW_S}s)`);
    return "ignored";
  }

  // Result only: clear this process's pending timer, whoever wins the claim.
  if (subtype === "bot_relay_result") resolvePendingRelay(payload.relay_id);

  // Claim (fail closed; any process on this DB, any earlier delivery).
  if (!(await claimOnce(db, `${subtype}:${payload.relay_id}`, subtype))) return "ignored";

  // Trust.
  if (!(await namedInstanceTrusted(db, claimed, { freshClient }))) {
    console.warn(`[sharing] ${subtype} dropped: ${String(claimed).slice(0, 64)} is not a trusted, live paired instance`);
    return "ignored";
  }

  if (subtype === "bot_relay") {
    // Fire-and-forget, as before: an AI run must not hold up the Nostr handler.
    Promise.resolve()
      .then(() => run(payload, db, identity, nostrManager, runOneShot ? { runOneShot } : undefined))
      .catch((err) => console.warn(`[sharing] Bot relay run failed: ${err?.message}`));
    return "handled";
  }
  try {
    await notify({
      title: `${payload.responder_instance}: ${payload.status === "success" ? "Done" : "Error"}`,
      body: payload.result || "No details",
      type: "system",
      source: "sharing:bot_relay_result",
      priority: "high",
    });
  } catch (err) {
    console.warn("[sharing] Failed to create relay result notification:", err.message);
  }
  return "handled";
}

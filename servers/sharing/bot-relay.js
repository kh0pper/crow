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

/**
 * Send a task to a remote Crow instance for execution.
 * Uses Nostr self-messaging with target_instance for routing.
 * Returns { ok, message, relayId? }
 */
export async function sendBotRelay(instanceName, task) {
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

    // Track pending relay with 5-min timeout
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
    }, 5 * 60 * 1000);
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
 */
export async function handleIncomingBotRelay(payload, db, identity, nostrManager) {
  const { relay_id, task, sender_instance, sender_name } = payload;
  console.log(`[sharing] Bot relay from ${sender_instance}: ${task}`);

  let resultText = "";
  let status = "success";

  try {
    const { runOneShot } = await import("../gateway/ai/one-shot.js");
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

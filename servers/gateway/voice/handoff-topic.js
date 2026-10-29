/**
 * The hand-off a device last spoke about (PR 5, Task 5.3; P17/P31). A bare "how's it going?" is about a
 * hand-off only within HANDOFF_TOPIC_EXCHANGES exchanges of the last time one was spoken of on that device:
 * the spoken yes, a status answer, or a heads-up Crow said there. Imports nothing, so handoff-confirm.js,
 * handoff-status.js and handoff.js can all read it without a cycle.
 *
 * On the shared core: `lastHandoffTopic` (device id → { id, exchange, at }) and `exchanges` (device id → the
 * number of turns that ran there). The hand-off afterTurn bumps the counter on EVERY turn it sees, fast paths
 * and relay turns included: each is something the operator said or heard, moving the topic further away.
 *
 *   rememberTopic(core, deviceId, handoffId, { inTurn })   inTurn (a yes, a status answer): the topic is the
 *                                                          exchange now running, numbered as afterTurn will
 *                                                          number it; between turns (a heads-up): the last one
 *   topicFor(core, deviceId)                               { id } while within the window, else null
 *   bumpExchange(core, deviceId)                           afterTurn's counter step
 *
 * A heads-up on a kiosk counts too (the 5.2 carry): the kiosk hub's speak() returns true once the line is
 * QUEUED on the live socket, not once it played. The queue drains in order on a connected display within
 * seconds, so the line is heard in all but a display dropping off at that moment, and the cost of a miscount
 * is small: a bare question there answers about this hand-off, truthfully, instead of going to the model.
 */

/** A bare status question is about the last hand-off topic within this many exchanges after it. */
export const HANDOFF_TOPIC_EXCHANGES = 2;

function maps(core) {
  if (!core || typeof core !== "object") return null;
  if (!(core.lastHandoffTopic instanceof Map)) core.lastHandoffTopic = new Map();
  if (!(core.exchanges instanceof Map)) core.exchanges = new Map();
  return core;
}

/** The number of turns afterTurn has counted on `deviceId`. */
export function exchangeOf(core, deviceId) {
  const c = maps(core);
  return c ? c.exchanges.get(deviceId) || 0 : 0;
}

export function bumpExchange(core, deviceId) {
  const c = maps(core);
  if (!c || typeof deviceId !== "string" || !deviceId) return 0;
  const n = (c.exchanges.get(deviceId) || 0) + 1;
  c.exchanges.set(deviceId, n);
  return n;
}

export function rememberTopic(core, deviceId, handoffId, { inTurn = true } = {}) {
  const c = maps(core);
  if (!c || typeof deviceId !== "string" || !deviceId || handoffId == null) return;
  const at = typeof c.now === "function" ? c.now() : Date.now();
  c.lastHandoffTopic.set(deviceId, { id: handoffId, exchange: exchangeOf(c, deviceId) + (inTurn ? 1 : 0), at });
}

/** The device's last hand-off topic while it is still within the window, else null. */
export function topicFor(core, deviceId) {
  const c = maps(core);
  const t = c && typeof deviceId === "string" ? c.lastHandoffTopic.get(deviceId) : null;
  if (!t || t.id == null) return null;
  return exchangeOf(c, deviceId) - (Number(t.exchange) || 0) <= HANDOFF_TOPIC_EXCHANGES ? { id: t.id } : null;
}

/**
 * Per-device voice memory (PR 2.1, #499): what the voice bot's recent turns on one display did with Crow's own
 * tools, so a later turn inside the window is still guarded and still offered them. Separate from the turn's
 * lastOwn / lastAction / lastFamilies, whose meanings stay as they are.
 *
 *   { intentOrUsedAt, actionAt, lastWrite: { tool, title, start, at, say, lang, tz } | null, families: Map<family, stampedAt> }
 *
 * - families: an own family is stamped when a turn offers it on intent or uses it. A family offered only because
 *   it was carried over is never stamped again, so the window always ends.
 * - Every entry expires VOICE_MODE_WINDOW_MS after it was set.
 * - lastWrite: the last own write that returned ok (the recap a later claim may be replaced with).
 * - The heap: every note prunes every device; while anything is held an unref()'d sweep (sweepMs, 60 s) prunes them
 *   too, so an idle display's record (its last write's title among it) leaves after the window with no one reading
 *   it. The sweep starts on the first note and stops when nothing is held. At most VOICE_MEMORY_MAX_DEVICES devices,
 *   the least recently noted dropped first. setInterval / clearInterval are injectable (tests).
 */
/** How long a turn that offered (on intent) or used one of Crow's own tools keeps a vague follow-up on them (plan constant). */
export const VOICE_MODE_WINDOW_MS = 10 * 60_000;

/** The most displays the voice memory holds at once (least recently noted dropped first). */
export const VOICE_MEMORY_MAX_DEVICES = 64;

export function createVoiceMemory({ now = Date.now, windowMs = VOICE_MODE_WINDOW_MS, sweepMs = 60_000, maxDevices = VOICE_MEMORY_MAX_DEVICES,
  setInterval: setIv = globalThis.setInterval, clearInterval: clearIv = globalThis.clearInterval } = {}) {
  const byDevice = new Map();
  let timer = null;
  const fresh = (at) => Number.isFinite(at) && now() - at <= windowMs;

  /** The device's record with every expired entry dropped; null when nothing is left. */
  function get(deviceId) {
    const r = byDevice.get(deviceId);
    if (!r) return null;
    if (!fresh(r.intentOrUsedAt)) r.intentOrUsedAt = null;
    if (!fresh(r.actionAt)) r.actionAt = null;
    if (r.lastWrite && !fresh(r.lastWrite.at)) r.lastWrite = null;
    for (const [f, at] of r.families) if (!fresh(at)) r.families.delete(f);
    if (r.intentOrUsedAt == null && r.actionAt == null && !r.lastWrite && r.families.size === 0) { byDevice.delete(deviceId); return null; }
    return r;
  }
  /** Prune every device (an empty record is dropped); stop the sweep once nothing is held. */
  function sweep() {
    for (const id of [...byDevice.keys()]) get(id);
    if (byDevice.size === 0 && timer) { clearIv(timer); timer = null; }
  }
  /** The device's record for a note: every device pruned first, this one moved to most recent, the cap kept. */
  function rec(deviceId) {
    sweep();
    let r = byDevice.get(deviceId);
    if (!r) r = { intentOrUsedAt: null, actionAt: null, lastWrite: null, families: new Map() };
    byDevice.delete(deviceId);   // re-insert: the map's order is least recently noted first
    byDevice.set(deviceId, r);
    while (byDevice.size > maxDevices) byDevice.delete(byDevice.keys().next().value);
    if (sweepMs > 0 && !timer) { timer = setIv(sweep, sweepMs); timer?.unref?.(); }
    return r;
  }

  return {
    get,
    /** The own families still inside the window (offered on the next turn; never used to arm the full hold). */
    carried: (deviceId) => new Set(get(deviceId)?.families.keys() || []),
    /** Whether an own entry (an own family, an own intent or use, or an own write) is still inside the window. */
    active: (deviceId) => {
      const r = get(deviceId);
      return !!r && (r.intentOrUsedAt != null || r.families.size > 0 || !!r.lastWrite);
    },
    /** The last own write inside the window, or null. */
    lastWrite: (deviceId) => get(deviceId)?.lastWrite || null,
    /** When the last action request inside the window was made, or null. */
    actionAt: (deviceId) => get(deviceId)?.actionAt ?? null,
    /** A turn offered an own tool on intent or used one: stamps those families (never a carried-only one). */
    noteOwn(deviceId, families) {
      const r = rec(deviceId);
      const t = now();
      r.intentOrUsedAt = t;
      for (const f of families || []) if (typeof f === "string" && f.startsWith("own:")) r.families.set(f, t);
    },
    noteAction(deviceId) { rec(deviceId).actionAt = now(); },
    /** An own write returned ok: { tool, title, start, say, lang, tz }. */
    noteWrite(deviceId, w) { if (w && typeof w.tool === "string") rec(deviceId).lastWrite = { ...w, at: now() }; },
    sweep,
    // Test-only: how many devices the map really holds (no pruning).
    _deviceCount: () => byDevice.size,
  };
}

/**
 * Fix-it Cards registry — pure, no I/O.
 *
 * A service registers a detector (turns failures into items) and a remedy
 * (the safe one-click fix). `emit` dispatches an event to the detectors that
 * handle it; a throwing detector is isolated so it can never break the caller
 * (the emit is on a request path) or its sibling detectors.
 */

const detectors = new Map();      // source -> { source, events, onEvent }
const eventIndex = new Map();      // eventName -> Set<source>
const remedies = new Map();        // actionId -> fn

export function registerDetector(d) {
  if (!d || !d.source || typeof d.onEvent !== "function" || !Array.isArray(d.events)) {
    throw new Error("registerDetector requires { source, events:[], onEvent }");
  }
  detectors.set(d.source, d);
  for (const ev of d.events) {
    if (!eventIndex.has(ev)) eventIndex.set(ev, new Set());
    eventIndex.get(ev).add(d.source);
  }
}

export function registerRemedy(actionId, fn) {
  if (!actionId || typeof fn !== "function") throw new Error("registerRemedy requires (actionId, fn)");
  remedies.set(actionId, fn);
}

export function getRemedy(actionId) {
  return remedies.get(actionId) || null;
}

export async function emit(eventName, payload, store) {
  const sources = eventIndex.get(eventName);
  if (!sources) return;
  for (const source of sources) {
    const d = detectors.get(source);
    if (!d) continue;
    try {
      await d.onEvent(eventName, payload, store);
    } catch (err) {
      console.warn(`[fix-it] detector "${source}" failed on "${eventName}":`, err.message);
    }
  }
}

export function _clearRegistry() {
  detectors.clear();
  eventIndex.clear();
  remedies.clear();
}

/**
 * Can a hand-off target's model answer right now? The voice hand-off's view of model-availability.js, for one
 * model key (a bot's `models.default`: a raw "provider/id" or a `role:<id>` ref):
 *
 *   "up" | "on_demand" | "unavailable"  as annotateAvailability reads the catalogue entry
 *   "unknown"                           no key (the instance default), a role that does not resolve, a key the
 *                                       catalogue does not list, or any failure
 *
 * Cached ttlMs (30 s) per key, as a promise: the probes start when the hand-off tool is offered (handoff.js
 * forTurn), and the call that proposes waits on the same one. Never throws.
 */
export const MODEL_AVAILABILITY_TTL_MS = 30_000;
const STATES = new Set(["up", "on_demand", "unavailable"]);

async function defaultResolve(db, key) {
  const { resolveRole } = await import("../../shared/model-roles-store.js");
  return resolveRole(db, key, { need: "chat" });
}

async function defaultEntries() {
  const { providerModelListWarm } = await import("../perch-model-catalog.js");
  return providerModelListWarm();
}

async function defaultAnnotate(list) {
  const { annotateAvailability } = await import("../model-availability.js");
  return annotateAvailability(list);
}

/**
 * → modelAvailability(db, key) → Promise<"up"|"on_demand"|"unavailable"|"unknown">. The seams are for tests:
 * resolve(db, key) → { key } for a role, entries() → the catalogue (providerModelListWarm), annotate(list).
 */
export function createModelAvailability({ now = Date.now, ttlMs = MODEL_AVAILABILITY_TTL_MS,
  resolve = defaultResolve, entries = defaultEntries, annotate = defaultAnnotate } = {}) {
  const cache = new Map();   // key → { at, p }

  async function probe(db, key) {
    let k = key;
    if (k.startsWith("role:")) {
      const r = await resolve(db, k);
      k = typeof r?.key === "string" && r.key && !r.key.startsWith("role:") ? r.key : null;
      if (!k) return "unknown";
    }
    const { modelKey } = await import("../perch-model-catalog.js");
    const m = (await entries()).find((e) => modelKey(e) === k);
    if (!m) return "unknown";
    const a = (await annotate([m]))[0]?.availability;
    return STATES.has(a) ? a : "unknown";
  }

  return function modelAvailability(db, key) {
    if (typeof key !== "string" || !key.trim()) return Promise.resolve("unknown");
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.p;
    const p = probe(db, key).catch(() => "unknown");
    cache.set(key, { at: now(), p });
    return p;
  };
}

let shared = null;
/** The process-wide one (getHandoffCore's `availability`). */
export function modelAvailability(db, key) {
  shared ??= createModelAvailability();
  return shared(db, key);
}

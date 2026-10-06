/**
 * Which forced-call forms does the engine behind a voice model honour? Measured: a vLLM server
 * honours a named tool_choice and "required"; the llama.cpp server builds in use accept a named
 * choice and ignore it, and on "required" make no call and run text to the token limit.
 *
 *   vllm      named, then "required" if a named choice is refused
 *   llamacpp  nothing is sent (a named choice is ignored there; "required" is harmful)
 *   unknown   named only — what every server was sent before this module existed — never "required"
 *
 * So "required" goes only to an engine KNOWN to honour it. The engine is read from the model
 * server's own GET /models (owned_by) and cached per base URL and model. A model entry in the
 * provider row's `models` JSON may carry toolChoice: "named" | "required" | "none" to override.
 * A base URL that is not local is never probed. The probe never delays a turn by more than
 * waitMs: a slow answer is used from the next turn on.
 */
import { isLocalBase } from "../ai/adapters/openai.js";

export const ENGINE_FORCING = Object.freeze({
  vllm: Object.freeze({ named: true, required: true }),
  llamacpp: Object.freeze({ named: false, required: false }),
});
export const UNKNOWN_FORCING = Object.freeze({ named: true, required: false, engine: "unknown" });
const CONFIGURED = Object.freeze({
  named: Object.freeze({ named: true, required: true, engine: "configured" }),
  required: Object.freeze({ named: false, required: true, engine: "configured" }),
  none: Object.freeze({ named: false, required: false, engine: "configured" }),
});
export const FORCING_TTL_MS = 10 * 60 * 1000;
export const FORCING_RETRY_MS = 60 * 1000;
export const FORCING_WAIT_MS = 250;

/**
 * deps: resolveKey(key) → { baseUrl, model, apiKey }; modelEntry(key, db) → the model's entry in
 * its provider row (or null); fetchImpl; now; log; waitMs; setTimer.
 * → forcing(key, db) → { named, required, engine }. Never throws.
 */
export function createToolForcing({ resolveKey, modelEntry = async () => null, fetchImpl = fetch, now = Date.now, log = () => {}, timeoutMs = 2000, waitMs = FORCING_WAIT_MS, setTimer = setTimeout }) {
  const cache = new Map();     // "<base url>|<model>" → { at, ttl, val }
  const pending = new Map();   // the same key → the probe in flight
  async function probe(id, base, up) {
    let val = UNKNOWN_FORCING, ttl = FORCING_RETRY_MS;
    try {
      const headers = up.apiKey && up.apiKey !== "none" ? { Authorization: `Bearer ${up.apiKey}` } : {};
      const r = await fetchImpl(`${base}/models`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) {
        const list = (await r.json())?.data;
        const m = Array.isArray(list) ? (list.find((x) => x && x.id === up.model) || list[0]) : null;
        const engine = Object.hasOwn(ENGINE_FORCING, m?.owned_by) ? m.owned_by : "unknown";
        val = engine === "unknown" ? UNKNOWN_FORCING : { ...ENGINE_FORCING[engine], engine };
        ttl = FORCING_TTL_MS;
      }
    } catch (err) { log(`[voice-turn] forcing probe for ${up.model} failed: ${err?.message || err}`); }
    cache.set(id, { at: now(), ttl, val });
    pending.delete(id);
    return val;
  }
  return async function forcing(key, db) {
    try {
      const entry = await modelEntry(key, db);
      if (entry && Object.hasOwn(CONFIGURED, entry.toolChoice)) return CONFIGURED[entry.toolChoice];
      const up = await resolveKey(key);
      const base = String(up?.baseUrl || "").replace(/\/+$/, "");
      if (!base || !isLocalBase(base)) return UNKNOWN_FORCING;          // never probed: named only, as before
      const id = `${base}|${up.model || ""}`;                            // a provider re-pointed to another server is a new entry
      const hit = cache.get(id);
      if (hit && now() - hit.at < hit.ttl) return hit.val;
      let p = pending.get(id);
      if (!p) { p = probe(id, base, up); pending.set(id, p); }
      // A must-run turn never waits long for this: past waitMs it goes on as "unknown", and the answer is there for the next turn.
      return await Promise.race([p, new Promise((res) => { const t = setTimer(() => res(UNKNOWN_FORCING), waitMs); t?.unref?.(); })]);
    } catch (err) {
      log(`[voice-turn] forcing for ${key} failed: ${err?.message || err}`);
      return UNKNOWN_FORCING;
    }
  };
}

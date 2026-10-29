/**
 * The voice route's keys (roles phase 1 Task 5, phase 2 Task 20). Moved out of
 * servers/gateway/routes/llm-router.js (which re-exports it) so the voice bot
 * loader, the Models page and the local-marks upgrade can read them without
 * loading express or the GPU orchestrator. A light module: the only static
 * import is the leaf voice-route-defaults.js; the role store, the strict check
 * and the marks load lazily, on the first call
 * (tests/voice-cloud-roles.test.js checks the import graph).
 */
import { VOICE_ROUTE_DEFAULTS } from "./voice-route-defaults.js";

const FAST_KEY = process.env.COMPANION_FAST_MODEL || VOICE_ROUTE_DEFAULTS.fast;
const ESC_KEY = process.env.COMPANION_ESCALATION_MODEL || VOICE_ROUTE_DEFAULTS.escalate;

/** The fast/escalate keys when nothing else applies (env at load, else the baked-in defaults). */
export const VOICE_RAW_KEYS = Object.freeze({ fast: FAST_KEY, escalate: ESC_KEY });

const loggedRoleMisses = new Set();
export function logRoleMiss(what, r) {
  const msg = `${what}: ${r?.reason || "unknown"}`;
  if (loggedRoleMisses.has(msg)) return;
  loggedRoleMisses.add(msg);
  console.warn(`[llm-router] role ${msg}; using the consumer default`);
}

async function defaultResolveRole(dbc, key, opts) {
  const { resolveRole } = await import("./model-roles-store.js");
  return resolveRole(dbc, key, opts);
}

/**
 * Is `key` not proven local under the strict check (isStrictCloud: a row
 * flagged host "cloud" on any hop, or any hop not proven local, with this
 * box's "This is local" marks)? Logs one disagreement per key when the old
 * host-column check said local. Any failure (no role context) is not proof
 * of local: true.
 */
export async function strictVoiceCloud(dbc, key, consumer = "voice") {
  try {
    const [{ loadRoleContext }, { isStrictCloud, oldCheckCloud, logStrictDisagreement }] = await Promise.all([
      import("./model-roles-store.js"), import("./provider-local-marks.js"),
    ]);
    const { providers, localMarks } = await loadRoleContext(dbc);
    const strictCloud = isStrictCloud(key, { providers, localMarks });
    logStrictDisagreement(consumer, key, { strictCloud, oldCloud: oldCheckCloud(key, { providers }) });
    return strictCloud;
  } catch {
    return true;
  }
}

/**
 * The voice route's keys for THIS request. Per side: the env var (read now), else the CHOSEN role binding
 * (role:voice for fast, role:everyday for escalate; a seeded or missing binding is not chosen), else the raw
 * constant. A chosen role that resolves to nothing (its model not configured; voice has no fallback chain) falls
 * to the raw constant, never to another role's model. Never throws.
 * → { fast, escalate, fastRole, escalateRole, fastCloud, escalateCloud }
 *   *Role   the role id when the role gave the key, else null
 *   *Cloud  the key is not proven local (strictVoiceCloud), whatever gave it: env, role or raw constant
 */
export async function resolveVoiceKeys(dbc, { env = process.env, resolveRoleFn = defaultResolveRole } = {}) {
  const side = async (envName, roleId, raw) => {
    const e = env?.[envName];
    if (typeof e === "string" && e) return { key: e, role: null };
    try {
      const r = await resolveRoleFn(dbc, `role:${roleId}`, { need: "chat", chosenOnly: true });
      if (r && typeof r.key === "string" && r.key) return { key: r.key, role: roleId };
      if (r?.reason !== "not_chosen") logRoleMiss(roleId, r);
    } catch (err) {
      logRoleMiss(roleId, { reason: err?.message || String(err) });
    }
    return { key: raw, role: null };
  };
  const [f, e] = await Promise.all([
    side("COMPANION_FAST_MODEL", "voice", FAST_KEY),
    side("COMPANION_ESCALATION_MODEL", "everyday", ESC_KEY),
  ]);
  const [fastCloud, escalateCloud] = await Promise.all([strictVoiceCloud(dbc, f.key), strictVoiceCloud(dbc, e.key)]);
  return { fast: f.key, escalate: e.key, fastRole: f.role, escalateRole: e.role, fastCloud, escalateCloud };
}

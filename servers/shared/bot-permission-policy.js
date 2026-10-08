/**
 * One validator for def.permission_policy, used by every path that writes a
 * bot definition's permissions: the Bot Builder save (owner, authenticated +
 * CSRF) and the trusted-peer patch (bot federation). Bot creation (wizard,
 * templates, "create") writes fixed defaults and never takes policy input.
 *
 *   validatePermissionPolicy(pp, o)  value/shape check — errors[] (empty = ok)
 *   nonPerchChannels(def)            channels that make ask/auto unavailable
 *   stripEngineKeys(pp)              drop keys only the spawning bridge sets
 *   peerPolicyWidening(before, after) the first field a change would WIDEN,
 *                                    or null — a peer may only tighten
 */
import { BASH_POLICIES, isValidBashPolicy, normalizeStoredBashPolicy } from "./bot-bash-policy.js";
import { botEnvScrubbed } from "./bot-env.js";

/** Keys a stored policy may carry. */
export const POLICY_KEYS = Object.freeze([
  "bash", "bash_allow", "bash_allow_shell_meta", "write_paths", "read_paths",
  "external_send", "confirm", "multi_agent", "self_authoring", "skill_learning",
]);
/** Computed per spawn by the bridge; never stored, never patchable. */
export const ENGINE_KEYS = Object.freeze(["classifier", "interactive_ask", "model_capable"]);

const SKILL_LEARNING = ["off", "propose", "auto"];
const EXTERNAL_SEND = ["draft_only", "allow"];

function isAbsPath(p) {
  return typeof p === "string" && p.startsWith("/") && !/[\0\r\n]/.test(p) && !p.split("/").includes("..");
}
const strArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 500 && !/[\0\r\n]/.test(x));

/** Bash modes that open a shell gated by a human or the classifier. */
const ASKING_SHELLS = ["ask", "auto"];

/**
 * The channels a bot talks on other than Perch (Kevin's ruling 2026-10-08:
 * Ask me / Auto are Perch-only for now). A gateway of type "perch" or
 * "none" is the dashboard chat; every other type (gmail, discord, telegram,
 * slack, crow-messages, …) carries attacker-reachable input.
 */
export function nonPerchChannels(def) {
  // ONE normalised reading of the bot's channels, shared by the save guard,
  // the peer guard and the bridge (no second reader with its own shape
  // assumptions): an array, a single object or a bare string all count; an
  // entry with no usable type is "unknown" — never mistaken for Perch.
  const raw = def ? def.gateways : undefined;
  const list = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const g of list) {
    const ty = typeof g === "string" ? g : (g && typeof g === "object" && typeof g.type === "string" ? g.type : null);
    const t = ty == null ? "unknown" : ty.trim().toLowerCase() || "unknown";
    if (t === "perch" || t === "none") continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** The bash mode a stored policy actually runs as (sandbox/unknown → deny). */
export function storedShellMode(pp) {
  return normalizeStoredBashPolicy(pp && typeof pp === "object" ? pp.bash : undefined).value;
}

/**
 * Runtime half of the Perch-only rule: ask/auto run only in a live Perch chat
 * (a human can answer) for a bot with no other channel; otherwise deny.
 */
export function effectiveShellMode(def, { interactive = false } = {}) {
  const mode = storedShellMode(def && def.permission_policy);
  if ((mode === "ask" || mode === "auto") && (!interactive || nonPerchChannels(def).length)) return "deny";
  return mode;
}

/**
 * Value/shape check. Options:
 *   prev      the stored policy: a key whose value is unchanged is not
 *             re-judged (an untouched legacy value never blocks another
 *             save) — the owner save passes it; the peer patch does not
 *   channels  nonPerchChannels(def): ask/auto are refused when non-empty
 *             (judged even when unchanged — the channel may be what changed)
 *   allowUnknownKeys  false on the peer path
 *   env       the gateway env (the bot env scrub switch)
 */
export function validatePermissionPolicy(pp, { allowUnknownKeys = true, env = process.env, prev = null, channels = [] } = {}) {
  const errors = [];
  if (!pp || typeof pp !== "object" || Array.isArray(pp)) return ["permission_policy must be an object"];
  const p = prev && typeof prev === "object" ? prev : null;
  const changed = (k) => !p || JSON.stringify(pp[k]) !== JSON.stringify(p[k]);
  for (const k of Object.keys(pp)) {
    if (!changed(k)) continue;
    if (ENGINE_KEYS.includes(k)) errors.push(`${k} is set by the bot engine, not stored`);
    else if (!POLICY_KEYS.includes(k) && !allowUnknownKeys) errors.push(`unknown permission key ${k}`);
  }
  if ("bash" in pp && changed("bash")) {
    if (!isValidBashPolicy(pp.bash)) errors.push(`bash must be one of: ${BASH_POLICIES.join(", ")}`);
    else if (pp.bash !== "deny" && !botEnvScrubbed(env)) {
      errors.push("a bot shell needs the bot environment scrub, which is switched off (CROW_BOT_ENV_PASSTHROUGH=1)");
    }
  }
  if (ASKING_SHELLS.includes(storedShellMode(pp)) && Array.isArray(channels) && channels.length) {
    errors.push(`Ask me and Auto are for bots you chat with in Perch; this bot also answers on ${channels.join(", ")}`);
  }
  if ("bash_allow" in pp && changed("bash_allow") && !strArray(pp.bash_allow)) errors.push("bash_allow must be a list of commands");
  if ("bash_allow_shell_meta" in pp && changed("bash_allow_shell_meta") && typeof pp.bash_allow_shell_meta !== "boolean") errors.push("bash_allow_shell_meta must be true/false");
  for (const k of ["write_paths", "read_paths"]) {
    if (k in pp && changed(k) && !(Array.isArray(pp[k]) && pp[k].every(isAbsPath))) errors.push(`${k} must be absolute paths without '..'`);
  }
  if ("external_send" in pp && changed("external_send") && !EXTERNAL_SEND.includes(pp.external_send)) errors.push(`external_send must be one of: ${EXTERNAL_SEND.join(", ")}`);
  if ("confirm" in pp && changed("confirm") && !strArray(pp.confirm)) errors.push("confirm must be a list of tool names");
  for (const k of ["multi_agent", "self_authoring"]) {
    if (k in pp && changed(k) && typeof pp[k] !== "boolean") errors.push(`${k} must be true/false`);
  }
  if ("skill_learning" in pp && changed("skill_learning") && !SKILL_LEARNING.includes(pp.skill_learning)) errors.push(`skill_learning must be one of: ${SKILL_LEARNING.join(", ")}`);
  return errors;
}

export function stripEngineKeys(pp) {
  if (!pp || typeof pp !== "object") return pp;
  const out = { ...pp };
  for (const k of ENGINE_KEYS) delete out[k];
  return out;
}

const arr = (v) => (Array.isArray(v) ? v : []);
const bashRank = (v) => (v === "deny" || v == null || !isValidBashPolicy(v) ? 0 : 1);

/**
 * Name the first field where `after` grants more than `before`, else null.
 * Rules: bash may only become deny (or stay); bash_allow/write_paths/
 * read_paths may only lose entries; external_send may only become
 * draft_only (absent = no restriction = allow); confirm may only gain
 * entries; multi_agent/self_authoring/bash_allow_shell_meta may only turn
 * off; skill_learning may only move toward off.
 */
export function peerPolicyWidening(before = {}, after = {}) {
  // The stored value is compared as it is read (a legacy "sandbox" counts as
  // the auto it now runs as).
  const b = { ...(before || {}), bash: normalizeStoredBashPolicy((before || {}).bash).value }, a = after || {};
  if (a.bash !== b.bash && !(a.bash === "deny" || (a.bash == null && bashRank(b.bash) === 0))) return "bash";
  for (const k of ["bash_allow", "write_paths", "read_paths"]) {
    const prev = new Set(arr(b[k]));
    if (arr(a[k]).some((x) => !prev.has(x))) return k;
  }
  const es = (v) => (v === "draft_only" ? 0 : 1);
  if (es(a.external_send) > es(b.external_send)) return "external_send";
  const nextConfirm = new Set(arr(a.confirm));
  if (arr(b.confirm).some((x) => !nextConfirm.has(x))) return "confirm";
  for (const k of ["multi_agent", "self_authoring", "bash_allow_shell_meta"]) {
    if (a[k] === true && b[k] !== true) return k;
  }
  const sl = (v) => Math.max(0, SKILL_LEARNING.indexOf(v));
  if (sl(a.skill_learning) > sl(b.skill_learning)) return "skill_learning";
  for (const k of Object.keys(a)) {
    if (!POLICY_KEYS.includes(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k])) return k;
  }
  return null;
}

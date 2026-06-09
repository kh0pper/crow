/**
 * F4a Layer 3 — pure security core for cross-instance bot edit.
 *
 * redactDefForPeer: the ONLY path from a local bot definition to a remote
 *   editor. Every secret-bearing field is replaced with a non-secret marker so
 *   the editor can show "•••• set" without ever receiving the value.
 * applyPeerPatch / PATCHABLE_FIELDS: the authoritative server-side allowlist.
 *   A patch may only touch the locked non-secret edit surface; anything else
 *   (incl. every gateway credential) throws. Enforced regardless of what the
 *   remote UI sends.
 */

const REDACT = (v) => ({ __redacted: true, set: v != null && v !== "" });

// Secret keys inside a gateway object.
export const GATEWAY_SECRET_KEYS = new Set(["token", "bot_token", "app_token", "password", "secret"]);
// Path segments that must never appear in a patch path (prototype-pollution guard).
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
// Secret-looking spawn_env keys.
const ENV_SECRET_RE = /(TOKEN|KEY|SECRET|PASSWORD|CRED)/i;

/** Deep-clone + redact. Pure (never mutates input). */
export function redactDefForPeer(def) {
  const d = JSON.parse(JSON.stringify(def || {}));
  if (Array.isArray(d.gateways)) {
    for (const gw of d.gateways) {
      if (!gw || typeof gw !== "object") continue;
      for (const k of Object.keys(gw)) {
        if (GATEWAY_SECRET_KEYS.has(k)) gw[k] = REDACT(gw[k]);
      }
    }
  }
  if (d.spawn_env && typeof d.spawn_env === "object") {
    for (const k of Object.keys(d.spawn_env)) {
      if (ENV_SECRET_RE.test(k)) d.spawn_env[k] = REDACT(d.spawn_env[k]);
    }
  }
  return d;
}

/**
 * Allowlist of patchable definition paths (the locked non-secret edit surface).
 * A trailing ".*" means "any direct/nested child of this object". `enabled` is
 * handled by a separate endpoint but accepted here too for completeness; the
 * patch endpoint routes it to the column.
 */
export const PATCHABLE_FIELDS = [
  "display_name",
  "enabled",
  "system_prompt",
  "models.*",
  "tools.crow_mcp",
  "tools.remote_mcp",
  "tools.pi_extensions",
  "tools.skills",
  "tools.pi_builtin",
  "skills",
  "permission_policy.*",
  "triggers.*",
  "tracker_config.*",
];

function isPatchable(path) {
  if (path.split(".").some((p) => FORBIDDEN_SEGMENTS.has(p))) return false;
  for (const allowed of PATCHABLE_FIELDS) {
    if (allowed === path) return true;
    if (allowed.endsWith(".*")) {
      const prefix = allowed.slice(0, -1); // keep the dot
      if (path.startsWith(prefix) && path.length > prefix.length) return true;
    }
  }
  return false;
}

function setByPath(obj, path, value) {
  const parts = path.split(".");
  if (parts.some((p) => FORBIDDEN_SEGMENTS.has(p))) throw new Error("forbidden path segment: " + path);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * Merge a field-scoped patch into a clone of currentDef. Throws on any path not
 * in PATCHABLE_FIELDS. `enabled` is allowed (the endpoint applies it to the
 * column, not the JSON, so it is stripped from the merged def here).
 * Pure (never mutates currentDef).
 */
export function applyPeerPatch(currentDef, patch) {
  const out = JSON.parse(JSON.stringify(currentDef || {}));
  for (const [path, value] of Object.entries(patch || {})) {
    if (path === "enabled") continue; // routed to the column by the caller
    if (!isPatchable(path)) {
      throw new Error(`field not patchable from a peer: ${path}`);
    }
    setByPath(out, path, value);
  }
  return out;
}

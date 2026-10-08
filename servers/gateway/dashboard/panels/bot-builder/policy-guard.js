/**
 * Bot Builder — the one place a dashboard save's permission_policy is
 * checked before it is written.
 *
 * Every editor save (save_basics / abilities / safety / advanced, and the
 * legacy per-tab saves) reaches the database through a single UPDATE in
 * api-handlers.js, and that UPDATE runs this guard first. The command-safety
 * work adds the shared validator servers/shared/bot-permission-policy.js
 * (validatePermissionPolicy), used by this owner save and by the peer patch;
 * when it reaches main, this function delegates to it and the local checks
 * below go away. Until then they enforce the parts this editor can write.
 *
 * The guard runs only when the policy actually changed in this save, so an
 * untouched legacy value (a stored "sandbox") never blocks saving another
 * tab; the editor only ever writes values from the stored vocabulary.
 */
import { isValidStoredBash } from "./bash-mode.js";
import { isValidReadPath } from "../../../../../scripts/pi-bots/bot-read-paths.mjs";

const strList = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * @param {object|undefined} next - permission_policy about to be written
 * @param {object|undefined} prev - permission_policy as stored
 * @returns {string|null} a reason when the write must be refused
 */
export function guardPolicyForSave(next, prev) {
  if (JSON.stringify(next) === JSON.stringify(prev)) return null;
  if (next == null) return null;
  if (typeof next !== "object" || Array.isArray(next)) return "permission_policy must be an object";
  const p = prev || {};
  if (next.bash !== p.bash && next.bash !== undefined && !isValidStoredBash(next.bash)) return "permission_policy.bash: " + String(next.bash);
  for (const k of ["write_paths", "read_paths"]) {
    if (JSON.stringify(next[k]) === JSON.stringify(p[k]) || next[k] === undefined) continue;
    if (!strList(next[k]) || !next[k].every(isValidReadPath)) return `permission_policy.${k} must be absolute paths without '..'`;
  }
  for (const k of ["bash_allow", "confirm"]) {
    if (next[k] !== undefined && JSON.stringify(next[k]) !== JSON.stringify(p[k]) && !strList(next[k])) return `permission_policy.${k} must be a list of strings`;
  }
  if (next.external_send !== p.external_send && next.external_send !== undefined && !["draft_only", "allow"].includes(next.external_send)) {
    return "permission_policy.external_send: " + String(next.external_send);
  }
  if (next.skill_learning !== p.skill_learning && next.skill_learning !== undefined && !["off", "propose", "auto"].includes(next.skill_learning)) {
    return "permission_policy.skill_learning: " + String(next.skill_learning);
  }
  for (const k of ["multi_agent", "self_authoring"]) {
    if (next[k] !== p[k] && next[k] !== undefined && typeof next[k] !== "boolean") return `permission_policy.${k} must be true or false`;
  }
  for (const k of ["classifier", "interactive_ask", "model_capable"]) {
    if (k in next && !(k in p)) return `permission_policy.${k} is set by the bot engine, never stored`;
  }
  return null;
}

/**
 * Bot Builder — the one place a dashboard save's permission_policy is
 * checked before it is written: every editor save (save_basics / abilities /
 * safety / advanced) reaches the database through a single UPDATE in
 * api-handlers.js, and that UPDATE runs this guard first.
 *
 * Both permission writers come through this module: the owner save
 * (guardPolicyForSave) and the trusted-peer patch (guardPolicyForPeer, from
 * bot-federation.js). Both delegate to the shared validator
 * (servers/shared/bot-permission-policy.js) — one rule set for every
 * permission write. Only values that changed in this save are judged, so an
 * untouched legacy value (a stored "sandbox") never blocks saving another
 * tab; the Perch-only rule for Ask me / Auto is judged on every save because
 * the channel can be the thing that changed.
 */
import { validatePermissionPolicy, nonPerchChannels, peerPolicyWidening } from "../../../../shared/bot-permission-policy.js";

/**
 * @param {object|undefined} next - permission_policy about to be written
 * @param {object|undefined} prev - permission_policy as stored
 * @param {object} [def] - the definition about to be written (its channels)
 * @returns {string|null} a reason when the write must be refused
 */
export function guardPolicyForSave(next, prev, def = {}) {
  const errors = validatePermissionPolicy(next == null ? {} : next, { prev: prev || {}, channels: nonPerchChannels(def) });
  return errors.length ? errors.join("; ") : null;
}

/**
 * The trusted-peer patch (bot-federation.js applyPeerPatch): the same
 * validator, strict (every key judged, unknown keys refused), plus the
 * peer-may-only-tighten rule.
 * @returns {string|null} a reason when the patch must be refused
 */
export function guardPolicyForPeer(next, prev, def = {}) {
  const errors = validatePermissionPolicy(next == null ? {} : next, { allowUnknownKeys: false, channels: nonPerchChannels(def) });
  if (errors.length) return "permission_policy: " + errors.join("; ");
  const widened = peerPolicyWidening(prev || {}, next || {});
  return widened ? `permission_policy.${widened} can only be tightened from a peer; change it in this instance's Bot Builder` : null;
}

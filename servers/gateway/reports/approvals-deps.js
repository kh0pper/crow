/**
 * The approvals deps the production callers build, in one place: `reports-api.js` (the owner's API) and
 * `boot/post-listen.js` (the scheduler hook).
 *
 * Why a factory rather than three literals: the approvals module's defaults are fail-closed on purpose
 * (`senderReady` answers false, `getRun` answers null) because `approvals.js` imports nothing under
 * `mail/` and knows no run table. A caller that forgets one seam therefore builds a module that refuses
 * everything, and a caller that wires two of the three (as the boot hook did) leaves the third at its
 * default. That third one showed up in production: the hook's model-change notice resolves the bot's
 * model through `approvals.resolveModelRef`, and with no resolver injected it named the new model as
 * "unavailable" in the sentence the owner reads.
 *
 * So the three real readers are the base:
 *   - `senderReady`: reports/sender-ready.js, the Crow Mail account read.
 *   - `getRun`: reports/run.js's `getRunForApproval`, the run table's reader.
 *   - `resolveModelRef`: approvals.js's own `defaultResolveModelRef`, the bot's model chain.
 * Anything a caller passes in `overrides` wins (`loadSeed`, `now`, `getSchedule`, `registry`,
 * `getSecrets`, and any of the three above), so a test still drives exactly the seams it means to.
 *
 * A member that is absent, or is not a function, falls back to the real reader: `{senderReady:
 * undefined}` is a caller saying nothing, not a caller switching the seam off.
 */
import { defaultResolveModelRef } from "./approvals.js";
import { getRunForApproval } from "./run.js";
import { senderReady } from "./sender-ready.js";

/**
 * The approvals deps, with the three real readers under whatever the caller overrides.
 *
 * @param {object} [overrides] any approvals deps member; a function wins over the default
 * @returns {object} the deps object `approvals.js` takes
 */
export function buildApprovalsDeps(overrides = {}) {
  const given = overrides == null ? {} : overrides;
  const deps = {
    senderReady,
    getRun: getRunForApproval,
    resolveModelRef: defaultResolveModelRef,
    ...given,
  };
  if (typeof deps.senderReady !== "function") deps.senderReady = senderReady;
  if (typeof deps.getRun !== "function") deps.getRun = getRunForApproval;
  if (typeof deps.resolveModelRef !== "function") deps.resolveModelRef = defaultResolveModelRef;
  return deps;
}

export default buildApprovalsDeps;
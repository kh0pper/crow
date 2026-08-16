/**
 * perchAttached(def) — the one place that decides whether a bot definition
 * carries a COMPLETE perch gateway record.
 *
 * Extracted from `routes/perch.js` and `routes/perch-interactive-api.js`
 * (Track 2 §5.1), which duplicated this verbatim — the duplicate's own
 * comment said it existed only because perch.js did not export it.
 */
import { missingGatewayFields } from "../dashboard/panels/bot-builder/gateway-fields.js";

/**
 * Attach semantics (spec §4): observation is free for every bot; conversation
 * requires a COMPLETE perch gateway record. `GATEWAY_REQUIRED_FIELDS.perch` is
 * `[]`, so a bare `{type:"perch"}` is complete by construction — but the check
 * goes through missingGatewayFields() so it stays true to Bot Builder's own
 * notion of completeness rather than re-deciding it here.
 */
export function perchAttached(def) {
  return ((def && def.gateways) || []).some(
    (gw) => gw && gw.type === "perch" && missingGatewayFields(gw).length === 0
  );
}

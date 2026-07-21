/**
 * Shared engine-attach-gate predicate (Task 7, C4).
 *
 * Two save paths need the identical "refuse to attach an engine-channel
 * gateway while the bot engine is absent" check: the Gateways-tab save in
 * api-handlers.js, and the wizard's final create in wizard.js. Both need the
 * SAME pinnable engineStatus() result so a single test call arms both gates.
 *
 * This lives in its own leaf module rather than as a local in api-handlers.js
 * because api-handlers.js already imports handleWizardCreate from wizard.js
 * — wizard.js importing api-handlers.js's local pin back would be a real
 * ESM cycle. A shared leaf both sides import avoids that entirely.
 */
import { ENGINE_CHANNELS, engineStatus } from "../../../bot-engine-status.js";
import { missingGatewayFields } from "./gateway-fields.js";

let _engineStatusPin = null;

/** Test-only: pin engineStatus()'s result for the attach gate (both the
 * Gateways-tab save gate in api-handlers.js and the wizard create gate in
 * wizard.js). Pass null to un-pin (falls back to the real engineStatus()). */
export function _setEngineStatusForTest(status) {
  _engineStatusPin = status || null;
}

function resolveEngineStatus() {
  return _engineStatusPin || engineStatus({ env: process.env });
}

/**
 * True when `gw` (a single normalized gateway record, e.g. `def.gateways[0]`)
 * is a COMPLETE engine-channel record (type ∈ ENGINE_CHANNELS AND no missing
 * required fields) with the bot engine absent — the shared predicate for
 * "refuse to attach/insert this gateway; the fix is installing the engine,
 * not reposting the same form." A type-only draft (incomplete fields) is
 * never gated — no consumer acts on it until it's complete.
 */
export function engineRequiredFor(gw) {
  if (!gw || !ENGINE_CHANNELS.includes(gw.type)) return false;
  if (missingGatewayFields(gw).length !== 0) return false;
  return resolveEngineStatus().state === "absent";
}

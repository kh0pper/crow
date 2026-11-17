/**
 * gateway-stopping.js — the process-wide "the gateway's own shutdown has
 * begun" marker.
 *
 * A Perch child that dies on SIGTERM is only "interrupted by a restart" when
 * THIS process asked for that shutdown (the engine's stopAll) or announced it
 * (markGatewayStopping). A reaper's or a hand-typed SIGTERM leaves the same
 * signal behind and is still an unexpected exit.
 *
 * It lives here, in a module with no imports and no side effects, so the
 * shutdown handler can import it statically and set the marker SYNCHRONOUSLY
 * as its first statement — a dynamic import there would be a cold module load
 * on the shutdown path, and the child's exit could win that race.
 */

let gatewayStopping = false;

/** Announce that this process's own shutdown has begun. Idempotent. */
export function markGatewayStopping() { gatewayStopping = true; }

/** True once markGatewayStopping() has been called in this process. */
export function isGatewayStopping() { return gatewayStopping; }

/** Test seam: back to the fresh-process state (nothing announced). */
export function _resetGatewayStoppingForTests() { gatewayStopping = false; }
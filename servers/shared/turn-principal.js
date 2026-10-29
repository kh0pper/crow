/**
 * Whose turn is this? The ONE owner-turn predicate for the loopback tool
 * families (project services, satellite tools): connected accounts and other
 * owner-only tools run on the owner's own turns only, and both families ask
 * this one function (the loopback mount enforces it before `authorize` unless
 * a family mounts with `ownerTurnOnly: false`).
 *
 * It judges a scope resolveSignedScope (signed-session.js) has ALREADY
 * resolved from rows, never anything the request claims:
 *  - a job (`scope: "job"`): the owner's turn exactly when bot_jobs.principal
 *    is "owner". NULL (a cron job, a delegation that named no principal), ""
 *    or any other value is not;
 *  - a session (`scope: "session"`): only a Perch session (gateway_type
 *    "perch") whose live child the injected Perch engine reports as running
 *    the owner's services (`engine.sessionServicesLive(rowId) === true`).
 *    With no engine every session fails. Gmail, Discord, Telegram and Slack
 *    sessions never pass, whatever an engine says.
 * Anything else, and any throw, is not the owner's turn (fail closed).
 */

/** Session channels that are never the owner's own turn. */
export const NEVER_OWNER_GATEWAYS = Object.freeze(["gmail", "discord", "telegram", "slack"]);

/**
 * @param {object} actor a resolved scope: { scope: "job"|"session", id, gatewayType, principal? }
 * @param {{ engine?: { sessionServicesLive?: (rowId: number) => boolean } | null }} [o]
 * @returns {boolean}
 */
export function isOwnerTurnScope(actor, { engine = null } = {}) {
  try {
    if (!actor || typeof actor !== "object") return false;
    if (actor.scope === "job") return actor.principal === "owner";
    if (actor.scope !== "session") return false;
    const gw = actor.gatewayType == null ? "" : String(actor.gatewayType).trim();
    if (gw !== "perch") return false;
    if (!engine || typeof engine.sessionServicesLive !== "function") return false;
    return engine.sessionServicesLive(actor.id) === true;
  } catch {
    return false;
  }
}

// Who is calling the project server: the owner, a bot, or unknown.
//
// The base actor is fixed when the server is built (stdio: the process env; gateway mounts: an
// authenticated mount is the owner, a --no-auth mount is unknown; the voice executor: its bound
// bot). Each call may then narrow it: a peer-instance caller is unknown (checked before `_meta`,
// so a peer cannot pose as a bot), and a `crow/actor` in the call's `_meta` can name a bot or
// make the caller unknown. Nothing per call ever yields the owner, and a missing actor is never
// the owner.

export const OWNER = Object.freeze({ kind: "owner" });
export const UNKNOWN = Object.freeze({ kind: "unknown" });

const PEER_TOKEN = "peer-instance";

function isPeer(extra) {
  return !!(extra && extra.authInfo && extra.authInfo.token === PEER_TOKEN);
}

function metaActor(extra) {
  const meta = extra && extra._meta;
  return meta && typeof meta === "object" ? meta["crow/actor"] : undefined;
}

/** The base actor from a process env: a bot with an id, an explicit owner, else unknown. */
export function actorFromEnv(env) {
  const e = env || {};
  if (e.CROW_ACTOR_KIND === "bot" && typeof e.CROW_ACTOR_BOT_ID === "string" && e.CROW_ACTOR_BOT_ID) {
    return { kind: "bot", id: e.CROW_ACTOR_BOT_ID };
  }
  if (e.CROW_ACTOR_KIND === "owner") return OWNER;
  return UNKNOWN;
}

/** The actor for one tool call: the base, narrowed by the call (never widened to the owner). */
export function resolveCallActor(base, extra) {
  if (base && base.kind === "bot") return base;
  if (isPeer(extra)) return UNKNOWN;
  const m = metaActor(extra);
  if (m !== undefined && m !== null) {
    if (m && m.kind === "bot" && m.id !== undefined && m.id !== null && String(m.id) !== "") {
      return { kind: "bot", id: String(m.id) };
    }
    return UNKNOWN;
  }
  return base || UNKNOWN;
}

/** What a dispatching router forwards to the server it calls: the incoming actor, or a peer marker. */
export function forwardActorMeta(extra) {
  if (isPeer(extra)) return { _meta: { "crow/actor": { kind: "peer" } } };
  const m = metaActor(extra);
  if (m && typeof m === "object") return { _meta: { "crow/actor": m } };
  return {};
}

/** The verified_by label: "owner", "bot:<id>", or null for unknown. */
export function actorLabel(actor) {
  if (actor && actor.kind === "owner") return "owner";
  if (actor && actor.kind === "bot" && actor.id) return `bot:${actor.id}`;
  return null;
}

/** project_audit_log actor columns. */
export function auditActor(actor) {
  if (actor && actor.kind === "owner") return { actor_type: "local", actor_id: null };
  if (actor && actor.kind === "bot" && actor.id) return { actor_type: "bot", actor_id: String(actor.id) };
  return { actor_type: "local", actor_id: "unknown" };
}

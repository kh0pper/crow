// Who is calling the project server: the owner, a bot, or unknown.
//
// The base actor is fixed when the server is built (stdio: the process env; gateway mounts: an
// authenticated mount is the owner, a --no-auth mount is unknown; the voice executor: its bound
// bot). Each call may then narrow it: a peer-instance caller is unknown (checked before `_meta`,
// so a peer cannot pose as a bot), and a `crow/actor` in the call's `_meta` can name a bot or
// make the caller unknown. A product-generated client (the companion, rookery) that holds the
// gateway token marks itself with an `x-crow-actor-kind` request header (bot | unknown, plus
// `x-crow-actor-id` for a bot): the same downgrade, read from the HTTP request. Nothing per call
// ever yields the owner, and a missing actor is never the owner.

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

const ACTOR_ID_RE = /^[A-Za-z0-9._:@-]{1,128}$/;

function headerValue(extra, name) {
  const headers = extra && extra.requestInfo && extra.requestInfo.headers;
  if (!headers || typeof headers !== "object") return undefined;
  const v = headers[name];
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === "string" ? first.trim() : undefined;
}

/**
 * The actor an `x-crow-actor-kind` header names: undefined when absent (or "owner", which is
 * ignored: a header can only downgrade), a bot when it says bot and carries a plain id, else
 * unknown (any other value fails closed).
 */
function headerActor(extra) {
  const kind = headerValue(extra, "x-crow-actor-kind");
  if (kind === undefined || kind === "") return undefined;
  const k = kind.toLowerCase();
  if (k === "owner") return undefined;
  if (k === "bot") {
    const id = headerValue(extra, "x-crow-actor-id");
    if (id && ACTOR_ID_RE.test(id)) return { kind: "bot", id };
  }
  return UNKNOWN;
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
  const h = headerActor(extra);
  if (h) base = h;
  const m = metaActor(extra);
  if (m !== undefined && m !== null) {
    if (m && m.kind === "bot" && m.id !== undefined && m.id !== null && String(m.id) !== "") {
      const id = String(m.id);
      return ACTOR_ID_RE.test(id) ? { kind: "bot", id } : UNKNOWN;
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
  const h = headerActor(extra);
  if (h) return { _meta: { "crow/actor": h.kind === "bot" ? { kind: "bot", id: h.id } : { kind: "unknown" } } };
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

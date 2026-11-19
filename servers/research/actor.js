// Who is calling the project server: the owner, a bot, or unknown.
//
// The base actor is fixed when the server is built (stdio: the process env; gateway mounts: an
// authenticated mount is the owner, a --no-auth mount is unknown; the voice executor: its bound
// bot). Each call may then narrow it: a peer-instance caller is unknown (checked before `_meta`,
// so a peer cannot pose as a bot), and a `crow/actor` in the call's `_meta` can name a bot or
// make the caller unknown. A product-generated client (a voice device, rookery) that holds the
// gateway token marks itself with an `x-crow-actor-kind` request header (bot | unknown, plus
// `x-crow-actor-id` for a bot): the same downgrade, read from the HTTP request. Nothing per call
// ever yields the owner, and a missing actor is never the owner.
import { peerActorMeta } from "../shared/peer-label.js";

export const OWNER = Object.freeze({ kind: "owner" });
export const UNKNOWN = Object.freeze({ kind: "unknown" });

const PEER_TOKEN = "peer-instance";

function isPeer(extra) {
  return !!(extra && extra.authInfo && extra.authInfo.token === PEER_TOKEN);
}

/**
 * Did this call arrive from a peer instance? TWO shapes count, because a peer reaches a tool two ways:
 *
 *  - the bearer token the gateway's peer mounts record in `authInfo` (`authInfo.token ===
 *    "peer-instance"`) — a direct mount, which `resolveCallActor` also narrows to UNKNOWN;
 *  - the `crow/actor` a forwarding router passes in `_meta` (forwardActorMeta → peerActorMeta):
 *    `{kind: "peer"}` for the ordinary form, and `{kind: "bot", instance}` for the remote-bot form
 *    a peer's gateway produces. A dispatcher's in-process client (router.js's
 *    createInProcessClient over InMemoryTransport) carries NO authInfo at all, so this marker is the
 *    only trace of the peer there — and `resolveCallActor` alone reads it as an unidentified LOCAL
 *    caller, which is the operator's own-client rule. Hence both shapes here.
 *
 * `kind: "peer"` cannot widen anything, and a local caller that sends either shape only refuses
 * itself. A tool that must refuse a peer outright (rather than treat it as an unidentified local
 * caller) asks here instead of looking at the resolved actor.
 */
export function isPeerCall(extra) {
  if (isPeer(extra)) return true;
  const m = metaActor(extra);
  if (!m || typeof m !== "object") return false;
  // `instance` marks a peer's remote-bot form (peerActorMeta). A LOCAL bot never carries it: a
  // router's forwardActorMeta keeps only kind and id, so a locally forwarded bot stays a local bot
  // here and keeps the share gate's answer rather than this refusal.
  return m.kind === "peer" || m.instance != null;
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

/**
 * Did the call's `x-crow-actor-kind` header CLAIM to be a bot? True whether or not it carried a
 * usable id: a bot claim with no id resolves to unknown (headerActor), but the claim itself still
 * has to travel (forwardActorMeta) — a server that must fail closed for a bot reads the claim, and
 * a router that collapsed it to "unknown" would hand an unverifiable bot the operator's own-client
 * rule.
 */
function headerClaimsBot(extra) {
  const kind = headerValue(extra, "x-crow-actor-kind");
  return typeof kind === "string" && kind.toLowerCase() === "bot";
}

/**
 * A bot session with no verifiable bot identity: refused for every project tool. The engine's
 * marker (`CROW_BOT_SESSION`) is on the env, but the actor an env names is not a usable bot (no
 * kind/id, or an id that disagrees with the marker). Frozen so nothing can widen it later.
 */
const UNVERIFIED_BOT = Object.freeze({ kind: "bot", id: null, unverified: true });

/**
 * The base actor from a process env: a bot with an id, an explicit owner, else unknown.
 *
 * `CROW_BOT_SESSION` is the engine-reserved marker the bot engine puts on the pi process's own
 * env (scripts/pi-bots/bridge.mjs): every stdio MCP child inherits it, so "this really is a bot
 * session" is knowable from the env alone. When the marker is present, the marker wins:
 *
 *   - no valid bot actor in the env, or a bot id that differs from the marker's → the unverified
 *     bot (refused everywhere; an unknown actor is otherwise the operator's own client);
 *   - a valid bot actor whose id matches → that bot, carrying `botSession: true`, which is what
 *     `isOperatorVoice` checks: a pi session on the voice bot's id is an ordinary bound bot, so it
 *     can never borrow the operator's voice scope.
 *
 * Nothing else in the env can produce the operator-voice marker.
 *
 * What the marker does NOT close: a bot with a shell that spawns one of these servers itself, with a
 * clean env (no marker), is indistinguishable from the operator's own client. That is the existing
 * containment caveat, not something this function can fix; every path the bot engine itself
 * controls (pi's spawn env, the per-bot MCP config) yields a bot actor or the unverified bot. Nor is
 * the operator-owned global pi config stripped of actor env, so a server it starts resolves from
 * whatever actor env that config's blocks carry.
 */
export function actorFromEnv(env) {
  const e = env || {};
  // A PRESENT key is the marker, even when it is empty: the engine sets it, so an empty value is a
  // bot session whose id no valid bot id can match (the unverified bot), never the owner.
  const marker = typeof e.CROW_BOT_SESSION === "string";
  const botId = e.CROW_ACTOR_KIND === "bot" && typeof e.CROW_ACTOR_BOT_ID === "string" && e.CROW_ACTOR_BOT_ID
    ? e.CROW_ACTOR_BOT_ID
    : null;
  if (marker) {
    if (!botId || botId !== e.CROW_BOT_SESSION) return UNVERIFIED_BOT;
    return { kind: "bot", id: botId, botSession: true };
  }
  if (botId) return { kind: "bot", id: botId };
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
      // Only kind and id are copied: whatever else a call puts in `_meta` stays behind. In
      // particular a per-call actor can never carry the operator-voice marker.
      const id = String(m.id);
      return ACTOR_ID_RE.test(id) ? { kind: "bot", id } : UNKNOWN;
    }
    return UNKNOWN;
  }
  return base || UNKNOWN;
}

/** What a dispatching router forwards to the server it calls: the incoming actor, or a peer marker. */
export function forwardActorMeta(extra) {
  // A peer is forwarded in the one shape every gateway forwarder uses ({kind:"peer", instance, from}).
  if (isPeer(extra)) return peerActorMeta(extra);
  const m = metaActor(extra);
  if (m && typeof m === "object") {
    // A forwarded bot is forwarded as kind and id only, so extra fields (the operator-voice
    // marker among them) do not travel to the server this router dispatches to.
    return { _meta: { "crow/actor": m.kind === "bot" ? { kind: "bot", id: m.id } : m } };
  }
  const h = headerActor(extra);
  if (h) {
    // A bot header whose id was missing or unusable resolves to unknown, but the bot CLAIM is
    // forwarded as a claim ({kind:"bot"}, no id): the target still resolves it to unknown
    // (resolveCallActor never invents an id), and a guard that fails closed for any bot claim
    // (the blog's owner-only guard) can see it instead of the operator's own-client actor.
    const claim = h.kind === "bot" ? { kind: "bot", id: h.id }
      : headerClaimsBot(extra) ? { kind: "bot" } : { kind: "unknown" };
    return { _meta: { "crow/actor": claim } };
  }
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

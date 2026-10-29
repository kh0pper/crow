/**
 * The shared admission gate for loopback tool mounts: loopback-only peer,
 * bearer token, signed actor headers, scope resolution. Each step has its own
 * refusal and a throw in a step is that step's refusal (fail closed).
 */
import { isLocalPeer } from "../shared/peer-class.js";

const REFUSE_LOG_WINDOW_MS = 3_600_000;
const REFUSE_LOG_CAP = 64;
const refusedLogged = new Map();
/** Test seam on module state. */
export function _resetRefusedLogForTest() { refusedLogged.clear(); }

/** Logs `[tag] refused: reason` at most once an hour per tag+reason (LRU, 64 keys).
 * Returns true when it logged. */
export function noteRefusedOnce(tag, reason, { now = Date.now(), log = console.warn } = {}) {
  const key = tag + "\n" + reason;
  const last = refusedLogged.get(key);
  if (last !== undefined && now - last < REFUSE_LOG_WINDOW_MS) return false;
  refusedLogged.delete(key);
  if (refusedLogged.size >= REFUSE_LOG_CAP) refusedLogged.delete(refusedLogged.keys().next().value);
  refusedLogged.set(key, now);
  log(`[${tag}] refused: ${reason}`);
  return true;
}

const first = (v) => {
  const x = Array.isArray(v) ? v[0] : v;
  if (x == null) return undefined;
  return String(x).trim();
};

/** The X-Crow-Actor-* headers, trimmed; missing -> undefined. */
export function readActorHeaders(headers = {}) {
  return {
    kind: first(headers["x-crow-actor-kind"]),
    botId: first(headers["x-crow-actor-id"]),
    scopeRef: first(headers["x-crow-actor-scope"]),
    threadId: first(headers["x-crow-actor-thread"]),
    gatewayType: first(headers["x-crow-actor-gateway"]),
    sig: first(headers["x-crow-actor-sig"]),
  };
}

const refuse = (status, code) => ({ ok: false, status, code });

export async function loopbackActorGate(req, { validateToken, verify, resolve }) {
  // step 2: only a genuine same-box caller, never one that came through auth'd instance/cross-host paths
  try {
    if (!isLocalPeer(req.socket?.remoteAddress, req.headers) || req.instanceAuth || req.crossHostAuth) return refuse(404, "not_found");
  } catch { return refuse(404, "not_found"); }

  // step 3: bearer token
  let token;
  try {
    const m = /^bearer\s+(\S+)\s*$/i.exec(String(first(req.headers?.authorization) ?? ""));
    token = m?.[1];
    if (!token || (await validateToken(token)) !== true) return refuse(401, "bad_token");
  } catch { return refuse(401, "bad_token"); }

  // step 4: signed actor headers
  let actor;
  try {
    actor = await verify(req.headers);
    if (!actor) return refuse(403, "unattributed");
  } catch { return refuse(403, "unattributed"); }

  // step 5: scope resolution
  try {
    const resolved = await resolve(actor);
    if (!resolved) return refuse(403, "unattributed");
    return { ok: true, actor: { ...actor, ...resolved }, token };
  } catch { return refuse(403, "unattributed"); }
}

/**
 * Signed management requests and signed JSON answers, satellite side (SAT-3, spec §5.1, §5.2, §14).
 *
 * Every `/satellite/v1/*` route except pairing runs behind this, after agent.js's Serve-only gate
 * (`classifyPeer(req).via === "serve"`, else an empty 404):
 *
 *   1. `begin`    reads X-Crow-Sat-Nonce (shape only) so even a refusal can be signed, and sets up
 *                 the audit record (spec §6.3: every signed call writes {ts, route, caller, result}).
 *   2. express.raw — the body is kept as the exact bytes received: sha256(body) is in the signed
 *                 string, and a re-serialised JSON value would not hash the same.
 *   3. `verify`   in order: paired at all (else 403 not_paired); verifyRequest against the PINNED mgmt
 *                 key (401 clock_skew | bad_signature | bad_caller); the nonce unseen (401 replay);
 *                 the cert valid, or in the 30-day grace for POST cert / POST unpair only
 *                 (else 403 cert_expired). Then the body is parsed as JSON (signed 400 bad_json).
 *                 Sets req.satCaller, req.satNonce, req.satBody.
 *
 * Answers go through `sendSigned(res, status, obj)`: the JSON is buffered whole, signed with the
 * satellite key over (request nonce, status, sha256(body)) and sent as application/json with
 * X-Crow-Sat-Resp-Sig. Refusals are signed too whenever the request carried a well-formed nonce,
 * so crow's client reads `{error:"clock_skew"}` instead of a bad_response_sig; such a signature
 * only says "the satellite answered this nonce with this refusal", and the nonce is crow's own
 * fresh random value, so it cannot stand in for an answer to any other request.
 */
import { certTimeState, signResponse, sha256Hex, verifyCertSignature, verifyRequest } from "../shared/satellite-protocol.js";

export const NONCE_LRU_MS = 10 * 60000;
export const NONCE_LRU_MAX = 10000;
const NONCE_RE = /^[0-9a-f]{32}$/;
const GRACE_ROUTES = new Set(["POST /satellite/v1/cert", "POST /satellite/v1/unpair"]);
const ROUTE_MAX = 200;

/**
 * "unpaired" when there is no cert, it does not verify, it is not for this satellite, or the pin
 * does not match it; else certTimeState: "valid" | "grace" | "lapsed".
 */
export function pairingState(cert, pinned, ownPubHex, now = Date.now()) {
  if (!cert || !pinned || !verifyCertSignature(cert)) return "unpaired";
  const p = cert.payload;
  if (p.satellite_pubkey !== ownPubHex || pinned.crow_id !== p.crow_id || pinned.root_pubkey !== p.root_pubkey
    || pinned.mgmt_pubkey !== p.mgmt_pubkey) return "unpaired";
  return certTimeState(cert, now);
}

/**
 * Request nonces: an in-memory LRU (10 min, bounded) in front of satellite.db's `nonces` table
 * (24 h, GC'd hourly by the scheduler). check(nonce) → true when fresh (and records it), false on
 * a replay. A nonce in either store is a replay; the table is what survives an LRU eviction or a
 * restart (the ±60 s ts window is far inside the 24 h the table keeps).
 */
export function createNonceGuard({ db, now = Date.now, max = NONCE_LRU_MAX, lruMs = NONCE_LRU_MS }) {
  const lru = new Map(); // nonce → seen_at, insertion ordered
  const insert = db.prepare("INSERT INTO nonces (nonce, seen_at) VALUES (?, ?)");
  return {
    check(nonce) {
      const t = now();
      for (const [n, at] of lru) {
        if (t - at < lruMs) break;
        lru.delete(n);
      }
      if (lru.has(nonce)) return false;
      try {
        insert.run(nonce, t);
      } catch (err) {
        if (String(err?.code || "").startsWith("SQLITE_CONSTRAINT")) return false;
        throw err; // fail closed: the caller answers 500
      }
      lru.set(nonce, t);
      while (lru.size > max) lru.delete(lru.keys().next().value);
      return true;
    },
    lruSize: () => lru.size,
  };
}

/** `sendSigned(res, status, obj)` for a satellite private key. */
export function createSendSigned(privHex, { audit } = {}) {
  return function sendSigned(res, status, obj) {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    const headers = { "Content-Type": "application/json" };
    const nonce = res.locals?.satRespNonce;
    if (nonce) headers["X-Crow-Sat-Resp-Sig"] = signResponse(privHex, { requestNonce: nonce, status, bodySha256: sha256Hex(body) });
    if (audit && res.locals) audit(res, status, obj);
    return res.status(status).set(headers).send(body);
  };
}

/**
 * The auth pieces for a satellite app. `getState()` → {cert, pinned} as the agent holds them now
 * (read per request, so a stored rotation takes effect on the very next call).
 */
export function createSatAuth({ db, key, now = Date.now, getState }) {
  const nonces = createNonceGuard({ db, now });
  const auditStmt = db.prepare("INSERT INTO audit (ts, route, caller, result) VALUES (?, ?, ?, ?)");
  const writeAudit = (res, result) => {
    const a = res.locals.satAudit;
    if (!a || a.done) return;
    a.done = true;
    try { auditStmt.run(new Date(now()).toISOString(), a.route, a.caller ?? null, String(result).slice(0, 64)); } catch { /* never blocks an answer */ }
  };
  const resultOf = (status, obj) => (obj && typeof obj.error === "string" ? obj.error : status < 400 ? "ok" : String(status));
  const sendSigned = createSendSigned(key.ed25519_priv, { audit: (res, status, obj) => writeAudit(res, resultOf(status, obj)) });
  const refuse = (res, status, code) => sendSigned(res, status, { error: code });

  function begin(req, res, next) {
    const n = req.get("x-crow-sat-nonce");
    if (typeof n === "string" && NONCE_RE.test(n)) res.locals.satRespNonce = n;
    const route = (req.baseUrl + req.path).replace(/^\/satellite\/v1\//, "").slice(0, ROUTE_MAX);
    res.locals.satAudit = { route, caller: null, done: false };
    // A route that answers without sendSigned (a plain download) is still audited.
    res.on("finish", () => writeAudit(res, res.statusCode < 400 ? "ok" : String(res.statusCode)));
    next();
  }

  function verify(req, res, next) {
    const { cert, pinned } = getState();
    const t = now();
    const state = pairingState(cert, pinned, key.ed25519_pub, t);
    if (state === "unpaired") return refuse(res, 403, "not_paired");
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const v = verifyRequest(pinned.mgmt_pubkey, {
      method: req.method, pathQuery: req.originalUrl, body, headers: req.headers, satelliteId: key.satellite_id, now: t,
    });
    if (!v.ok) return refuse(res, 401, v.code);
    res.locals.satAudit.caller = v.caller;
    if (!nonces.check(v.nonce)) return refuse(res, 401, "replay");
    const routeKey = `${req.method} ${req.baseUrl}${req.path}`;
    if (state === "lapsed" || (state === "grace" && !GRACE_ROUTES.has(routeKey))) return refuse(res, 403, "cert_expired");
    req.satCaller = v.caller;
    req.satNonce = v.nonce;
    if (body.length === 0) {
      req.satBody = {};
    } else {
      try { req.satBody = JSON.parse(body.toString("utf8")); } catch { return refuse(res, 400, "bad_json"); }
    }
    next();
  }

  return { begin, verify, sendSigned };
}

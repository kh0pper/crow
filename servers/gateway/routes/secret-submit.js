/**
 * Credential card (R1.2 spec §10.2, §10.3; §10.5 option 1): the operator's password card submits
 * here, and only here.
 *
 *   POST /dashboard/perch-api/secret/:id?sid=<session>   body { value } or { cancel: true }
 *
 * Rails:
 *  - dashboardAuth, then a refusal for any peer-signed request, then CSRF (the `X-Crow-Csrf`
 *    header; the dashboard router's own CSRF rail runs too). Mounted under /dashboard/perch-api,
 *    which is never on Funnel and skips the rate limiter like the rest of the dashboard.
 *  - Its own 4kb JSON parser: the path is in index.js `_hasOwnParser`, so the gateway's global
 *    parser never reads this body, and a malformed or oversized body gets the fixed answer and
 *    the fixed log line from the error handler at the end of this router, never the parser's
 *    message (Node's JSON.parse message quotes the body).
 *  - `Cache-Control: no-store` on every answer.
 *
 * The value: read from the body exactly once (and deleted from it), checked as a non-empty
 * string, then passed straight to the request's target through deliverSecret. Nothing else
 * keeps it: it is never logged, put in an error, a frame, a response or the audit row. Every
 * answer is a fixed code.
 *
 * The flow: claimSecret (single use, bound to the session) → deliverSecret (the target's
 * deliver, which queues the bot's note) → the card frame `done` (or `failed`). A cancel is
 * cancelSecret → the closed note → the card frame `closed`.
 */
import express, { Router } from "express";
import { csrfMiddleware } from "../dashboard/shared/csrf.js";
import { createDbClient, auditLog } from "../../db.js";
import { resolveCrowHome } from "../../shared/crow-home.js";
import { refreshGatewaySecretValues } from "../../shared/secret-values-collect.js";
import { claimSecret, cancelSecret, deliverSecret, emitSecretCard, secretFrame } from "../secrets/request-store.js";
import { KEYCHAIN_NOTES } from "../secrets/targets.js";

const BASE = "/dashboard/perch-api/secret";

/** The path this router parses itself (index.js `_hasOwnParser` uses it). */
export const SECRET_SUBMIT_PATH_RE = /^\/dashboard\/perch-api\/secret\/[^/]+$/;

/** A typed password longer than this is refused (the parser's own cap is 4kb). */
export const SECRET_VALUE_MAX = 1024;

/** Every answer this route gives: [status, body]. */
const ANSWERS = Object.freeze({
  saved: [200, { ok: true, code: "saved" }],
  closed: [200, { ok: true, code: "closed" }],
  notSetUp: [200, { ok: false, code: "not_set_up" }],
  notSaved: [200, { ok: false, code: "not_saved" }],
  badValue: [400, { error: "bad_value" }],
  badBody: [400, { error: "bad_body" }],
  tooLarge: [413, { error: "too_large" }],
  expired: [410, { error: "expired" }],
  notFound: [404, { error: "not_found" }],
  forbidden: [403, { error: "forbidden" }],
  internal: [500, { error: "internal" }],
});
const answer = (res, key) => { const [status, body] = ANSWERS[key]; return res.status(status).json(body); };

function refusal(outcome) {
  // A wrong session reads as not_found: the route is no oracle for another chat's ids.
  return outcome === "expired" ? "expired" : "notFound";
}

/**
 * @param {Function} dashboardAuth the dashboard session gate
 * @param {object} [o]
 * @param {() => object} [o.dbFactory] a crow.db client for the keychain target
 * @param {string} [o.crowHome] where the keychain key lives (default CROW_HOME)
 * @param {(sid, frame, opts) => any} [o.emit] the card hook (default the request store's seam)
 * @param {Function} [o.audit] auditLog(db, event, { details })
 * @param {() => void} [o.refreshMasking] re-collect this gateway's masking sets after a save
 */
export default function secretSubmitRouter(dashboardAuth, {
  dbFactory = () => createDbClient(),
  crowHome,
  emit = emitSecretCard,
  audit = auditLog,
  refreshMasking,
} = {}) {
  const home = () => crowHome || resolveCrowHome();
  const maskEnv = () => ({ ...process.env, CROW_HOME: home() });
  const refresh = () => {
    try { (refreshMasking || (() => refreshGatewaySecretValues({ env: maskEnv() })))(); } catch { console.warn("[secrets] masking refresh failed"); }
  };
  const show = (request, state) => {
    try {
      const out = emit(request.sessionId, secretFrame(request, state), { botId: request.botId });
      if (out && typeof out.then === "function") out.then(null, () => {});
    } catch { /* the card is display only */ }
  };

  const router = Router();
  router.use(BASE, dashboardAuth, (req, res, next) => {
    if (req.headers["x-crow-signature"]) return answer(res, "forbidden");   // never for paired instances
    res.set("Cache-Control", "no-store");
    next();
  }, csrfMiddleware);

  const jsonBody = express.json({ limit: "4kb" });

  router.post(BASE + "/:id", jsonBody, async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const id = String(req.params.id);
      const sid = typeof req.query.sid === "string" ? req.query.sid : "";

      if (body.cancel === true) {
        delete body.value;
        const out = cancelSecret(id, sid);
        if (out.outcome !== "ok") return answer(res, refusal(out.outcome));
        show(out.request, "closed");
        return answer(res, "closed");
      }

      // Read exactly once; the body keeps no copy.
      let value = body.value;
      delete body.value;
      if (typeof value !== "string" || value.length === 0 || value.length > SECRET_VALUE_MAX) {
        value = null;
        return answer(res, "badValue");
      }
      const claim = claimSecret(id, { sessionId: sid });
      if (claim.outcome !== "ok") {
        value = null;
        return answer(res, refusal(claim.outcome));
      }
      let out;
      let db = null;
      try {
        db = dbFactory();
        out = await deliverSecret(claim.request, value, { db, crowHome: home(), audit, env: maskEnv() });
      } finally {
        value = null;
        if (db) { try { db.close(); } catch { /* closed */ } }
      }
      if (out.ok) refresh();
      show(claim.request, out.ok ? "done" : "failed");
      if (out.ok) return answer(res, "saved");
      return answer(res, out.note === KEYCHAIN_NOTES.notSetUp ? "notSetUp" : "notSaved");
    } catch (err) {
      console.error("[secrets] submit failed: " + ((err && err.name) || "Error"));
      if (!res.headersSent) answer(res, "internal");
    }
  });

  // The body's own parser: a malformed or oversized body may hold the password, so it answers
  // a fixed code and logs a fixed line, never the parser's message.
  router.use(BASE, (err, req, res, next) => {
    if (!err || res.headersSent) return next(err);
    if (typeof err.type === "string") {   // every body-parser refusal carries a type
      console.warn("[secrets] bad body");
      return answer(res, Number(err.status || err.statusCode) === 413 ? "tooLarge" : "badBody");
    }
    console.error("[secrets] request failed: " + ((err && err.name) || "Error"));
    answer(res, "internal");
  });

  return router;
}

/**
 * OAuth consent — the security audit's finding.
 *
 * Before this module, CrowOAuthProvider.authorize() minted an authorization code
 * for ANY registered client, and client registration is open by design (MCP
 * dynamic registration). So anyone who could reach the gateway could register a
 * client, call /authorize with their own PKCE challenge, read the code out of
 * the 302 Location, exchange it at /token and hold a full operator MCP bearer
 * token — bypassing the dashboard password entirely.
 *
 * Now authorize() only records a PENDING request and sends the browser here; a
 * code is minted (issueAuthorizationCode) only after the instance owner, signed
 * in to the dashboard, clicks Allow. The pending store is in memory on purpose:
 * a consent request that does not outlive the gateway process is dead, which is
 * the safe direction for a credential hand-off.
 */

import express, { Router } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { isAllowedNetwork, parseCookies, sessionFromRequest } from "./dashboard/auth.js";
import { escapeHtml } from "./dashboard/shared/components.js";
import { SUPPORTED_LANGS, t } from "./dashboard/shared/i18n.js";

const CONSENT_PATH = "/dashboard/oauth/consent";
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 200;
const CSRF_COOKIE = "crow_csrf";

/**
 * The ONLY `next` the login page will honour: the consent page's own URL, with
 * the exact 32-char request id oauth-consent minted. Anything else (a foreign
 * origin, a bare /dashboard, a truncated id, extra query fields) is ignored, so
 * this hand-off can never become an open redirect.
 */
const CONSENT_NEXT_RE = /^\/dashboard\/oauth\/consent\?req=[A-Za-z0-9_-]{32}$/;

/**
 * Pending authorization requests, in memory, capped: id → { client, params, expiresAt }.
 * Exported so tests can age an entry out; nothing in the product mutates it
 * except createPendingAuthorization / takePending below.
 */
export const pendingAuthorizations = new Map();

/** The provider the consent POST mints codes through; set once at gateway boot. */
let oauthProvider = null;

export function setOAuthProvider(provider) {
  oauthProvider = provider;
}

export function isConsentNext(next) {
  return typeof next === "string" && CONSENT_NEXT_RE.test(next);
}

function pruneExpired(now) {
  for (const [id, entry] of pendingAuthorizations) {
    if (entry.expiresAt <= now) pendingAuthorizations.delete(id);
  }
}

/**
 * Record a pending authorization request and return its id.
 * Capped at MAX_PENDING: expired entries go first, and if the store is STILL
 * full the oldest request is dropped — a flood of /authorize calls can never
 * wedge the owner's own consent page out of existence.
 */
export function createPendingAuthorization(client, params) {
  const now = Date.now();
  pruneExpired(now);
  if (pendingAuthorizations.size >= MAX_PENDING) {
    let oldestId = null;
    let oldestExpiry = Infinity;
    for (const [id, entry] of pendingAuthorizations) {
      if (entry.expiresAt < oldestExpiry) {
        oldestExpiry = entry.expiresAt;
        oldestId = id;
      }
    }
    if (oldestId !== null) pendingAuthorizations.delete(oldestId);
  }
  const id = randomBytes(24).toString("base64url"); // 32 chars
  pendingAuthorizations.set(id, { client, params, expiresAt: now + PENDING_TTL_MS });
  return id;
}

/** Single use: the entry leaves the store the moment it is looked up, so a
 * replayed POST can never decide twice (and never mints a second code). */
function takePending(id) {
  if (typeof id !== "string" || id === "") return null;
  const entry = pendingAuthorizations.get(id);
  if (!entry) return null;
  pendingAuthorizations.delete(id);
  return entry.expiresAt <= Date.now() ? null : entry;
}

/** Constant-time compare of the body's `_csrf` against the crow_csrf cookie. */
function csrfMatches(req, presented) {
  const cookie = parseCookies(req)[CSRF_COOKIE];
  if (typeof cookie !== "string" || !cookie || typeof presented !== "string" || !presented) return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function langOf(req) {
  const cookies = parseCookies(req);
  return SUPPORTED_LANGS.includes(cookies.crow_lang) ? cookies.crow_lang : "en";
}

/** A standalone page: these routes live outside the dashboard shell (and the
 * app is waiting on the other end), so they carry no nav and no client JS. */
function pageHtml({ title, body, lang }) {
  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — Crow</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
           background: #111; color: #eee; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    main { width: min(34rem, calc(100vw - 2rem)); box-sizing: border-box; padding: 1.5rem;
           background: #1a1a1a; border: 1px solid #333; border-radius: 12px; }
    h1 { font-size: 1.25rem; margin: 0 0 1rem; }
    p { line-height: 1.5; margin: 0 0 1rem; }
    .app { font-weight: 600; font-size: 1.1rem; }
    code { font-family: ui-monospace, monospace; word-break: break-all; }
    .warning { border-left: 3px solid #d9a03c; padding-left: 0.75rem; color: #f0d9a8; }
    .actions { display: flex; gap: 0.75rem; margin-top: 1.25rem; }
    .actions form { flex: 1; }
    button { width: 100%; font: inherit; padding: 0.7rem 1rem; border-radius: 8px; cursor: pointer;
             background: #262626; color: #eee; border: 1px solid #555; }
    button.allow { background: #2f6f3f; border-color: #3f8f53; }
  </style>
</head>
<body><main>${body}</main></body>
</html>`;
}

/** Every consent response is unscreenable and uncacheable. */
function sendPage(res, status, html) {
  res.set({
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'",
    "Cache-Control": "no-store",
  });
  return res.status(status).type("html").send(html);
}

function expiredPage(res, lang) {
  return sendPage(res, 400, pageHtml({
    title: t("oauthConsent.expiredTitle", lang),
    lang,
    body: `<h1>${escapeHtml(t("oauthConsent.expiredTitle", lang))}</h1>
      <p>${escapeHtml(t("oauthConsent.expired", lang))}</p>`,
  }));
}

/**
 * Routes:
 *   GET  /dashboard/oauth/consent?req=<id>  — the Allow/Deny page
 *   POST /dashboard/oauth/consent           — the decision
 */
export function createOAuthConsentRouter() {
  const router = Router();
  // dashboard/index.js already parses urlencoded bodies for /dashboard (this
  // router is mounted after that); repeating it keeps the router self-contained
  // for a harness that mounts it on its own. body-parser no-ops on a body that
  // is already parsed.
  const urlencoded = express.urlencoded({ extended: false });

  router.get(CONSENT_PATH, async (req, res) => {
    const lang = langOf(req);
    const id = typeof req.query.req === "string" ? req.query.req : "";

    // sessionFromRequest applies the network rule too: no session below means
    // either "not signed in" or "not on an allowed address".
    const session = await sessionFromRequest(req);
    if (!session) {
      if (!isAllowedNetwork(req)) {
        // A loopback request on the server itself has no login page it could
        // usefully be sent to (dashboardAuth refuses it just the same), so say
        // what actually works instead of dead-ending.
        return sendPage(res, 403, pageHtml({
          title: t("oauthConsent.wrongAddressTitle", lang),
          lang,
          body: `<h1>${escapeHtml(t("oauthConsent.wrongAddressTitle", lang))}</h1>
            <p>${escapeHtml(t("oauthConsent.wrongAddress", lang))}</p>`,
        }));
      }
      const next = `${CONSENT_PATH}?req=${id}`;
      return res.redirect(302, "/dashboard/login?next=" + encodeURIComponent(next));
    }

    const entry = pendingAuthorizations.get(id);
    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) pendingAuthorizations.delete(id);
      return expiredPage(res, lang);
    }

    // Attacker-controlled (client_name comes from open dynamic registration):
    // escape it, and never let it choose where a POST goes.
    const rawName = typeof entry.client?.client_name === "string" ? entry.client.client_name.trim() : "";
    const appName = escapeHtml(rawName || t("oauthConsent.unnamedApp", lang));
    let origin = "";
    try {
      origin = new URL(entry.params.redirectUri).origin;
    } catch {
      origin = String(entry.params.redirectUri || "");
    }
    const csrf = parseCookies(req)[CSRF_COOKIE] || "";
    const hidden = `<input type="hidden" name="req" value="${escapeHtml(id)}">
          <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">`;

    return sendPage(res, 200, pageHtml({
      title: t("oauthConsent.title", lang),
      lang,
      body: `<h1>${escapeHtml(t("oauthConsent.title", lang))}</h1>
      <p>${escapeHtml(t("oauthConsent.intro", lang))}</p>
      <p class="app">${appName}</p>
      <p>${escapeHtml(t("oauthConsent.redirectOrigin", lang))} <code>${escapeHtml(origin)}</code></p>
      <p class="warning">${escapeHtml(t("oauthConsent.warning", lang))}</p>
      <div class="actions">
        <form method="POST" action="${CONSENT_PATH}">
          ${hidden}
          <input type="hidden" name="decision" value="allow">
          <button type="submit" class="allow">${escapeHtml(t("oauthConsent.allow", lang))}</button>
        </form>
        <form method="POST" action="${CONSENT_PATH}">
          ${hidden}
          <input type="hidden" name="decision" value="deny">
          <button type="submit">${escapeHtml(t("oauthConsent.deny", lang))}</button>
        </form>
      </div>`,
    }));
  });

  router.post(CONSENT_PATH, urlencoded, async (req, res) => {
    const lang = langOf(req);
    const body = req.body || {};

    // 1. Only the signed-in owner decides. Nothing is consumed on a refusal, so
    //    a cross-site POST cannot burn the owner's pending request.
    const session = await sessionFromRequest(req);
    if (!session) {
      return sendPage(res, 403, pageHtml({
        title: t("oauthConsent.title", lang),
        lang,
        body: `<h1>${escapeHtml(t("oauthConsent.title", lang))}</h1>
          <p>${escapeHtml(t("oauthConsent.needSession", lang))}</p>`,
      }));
    }

    // 2. CSRF, checked here explicitly: csrfMiddleware skips requests without a
    //    session cookie, so it cannot be the rail for THIS route, and a consent
    //    grant is exactly what a forged cross-site form would aim for. This one
    //    ignores the CROW_CSRF_STRICT rollback switch on purpose — turning the
    //    dashboard's forgery rail off must not turn a credential grant into a
    //    one-click cross-site action.
    if (!csrfMatches(req, body._csrf)) {
      return sendPage(res, 403, pageHtml({
        title: t("oauthConsent.title", lang),
        lang,
        body: `<h1>${escapeHtml(t("oauthConsent.title", lang))}</h1>
          <p>${escapeHtml(t("oauthConsent.csrfFailed", lang))}</p>`,
      }));
    }

    // 3. Single use, whatever the decision.
    const entry = takePending(typeof body.req === "string" ? body.req : "");
    if (!entry) return expiredPage(res, lang);

    if (body.decision === "allow") {
      if (!oauthProvider) {
        return sendPage(res, 500, pageHtml({
          title: t("oauthConsent.title", lang),
          lang,
          body: `<h1>${escapeHtml(t("oauthConsent.title", lang))}</h1>
            <p>${escapeHtml(t("oauthConsent.notConfigured", lang))}</p>`,
        }));
      }
      // The code is minted HERE, only now, and only by the provider.
      return res.redirect(303, oauthProvider.issueAuthorizationCode(entry.client, entry.params));
    }

    // Anything that is not an explicit Allow is a denial: no code at all.
    const target = new URL(entry.params.redirectUri);
    const search = new URLSearchParams({ error: "access_denied" });
    if (entry.params.state !== undefined) search.set("state", entry.params.state);
    target.search = search.toString();
    return res.redirect(303, target.toString());
  });

  return router;
}
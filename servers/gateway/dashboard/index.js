/**
 * Dashboard Routes — Route mounting, auth, panel dispatch
 */

import { Router } from "express";
import express from "express";
import { renderLayout, renderLogin, renderLogoutConfirm, render2faVerify, render2faRecovery, render2faSetup, renderResetRequest, renderResetForm } from "./shared/layout.js";
import { playerBarHtml, playerBarJs } from "./shared/player.js";
import { headerIconsHtml, headerIconsJs, headerIconsTrayHtml, tamagotchiHtml, tamagotchiJs, tamagotchiTrayHtml } from "./shared/notifications.js";
import {
  dashboardAuth,
  isPasswordSet,
  setPassword,
  attemptLogin,
  complete2faLogin,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  parseCookies,
  validatePasswordStrength,
  isAllowedNetwork,
  loginNetworkAllowed,
  sendNetworkRefusal,
  mintSsoSession,
  SSO_SESSION_MAX_AGE,
} from "./auth.js";
import {
  is2faEnabled,
  needs2faSetup,
  verifyTotp,
  verifyRecoveryCode,
  verifyPending2faToken,
  createPending2faToken,
  getPending2faContext,
  getTotpSecret,
  generateTotpSecret,
  generateQrDataUri,
  generateRecoveryCodes,
  saveTotpSetup,
  enable2fa,
  createDeviceTrust,
  DEVICE_TRUST_TTL,
} from "./totp.js";
import { getPeerCreds } from "../../shared/peer-credentials.js";
import { peerTrust, rowIsTrusted } from "../../shared/peer-trust.js";
import { signTicket, verifyTicket, isSafeDestPath } from "../../shared/sso-ticket.js";
import { auditCrossHostCall } from "../../shared/cross-host-auth.js";
import { isSelfOrigin, warnBridgeOverlap } from "../../shared/self-origin.js";
import { getOrCreateLocalInstanceId } from "../instance-registry.js";
import { SUPPORTED_LANGS, t } from "./shared/i18n.js";
import { allowFirstRun, clearSetupToken, isDirectLoopback } from "./setup-token.js";
import { isSameOriginRequest, isLoopbackHost, FIRST_RUN_CROSS_ORIGIN_MESSAGE } from "./same-origin.js";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { registerPanel, loadExternalPanels, getAllPanels, getVisiblePanels, getPanel, getPanelRoutes } from "./panel-registry.js";
import { resolveNavGroups } from "./nav-registry.js";
import { readSetting } from "./settings/registry.js";
import { healthAttentionRouter } from "./panels/health.js";
import { csrfMiddleware, csrfRefusal } from "./shared/csrf.js";
import { createOAuthConsentRouter, isConsentNext } from "../oauth-consent.js";
import secretSubmitRouter from "../routes/secret-submit.js";
import { twoFactorSetupGate } from "./two-factor-setup-gate.js";
import federationRouterFactory from "../routes/federation.js";
import federationCompanionRouterFactory from "../routes/federation-companion.js";
import federationResolveRouterFactory from "../routes/federation-resolve.js";
import { getTrustedInstances } from "./panels/nest/data-queries.js";
import { getPeerOverview } from "./overview-cache.js";
import { isCrowTalkAvailable } from "./shared/crow-talk.js";
import { createDbClient } from "../../db.js";

// Import built-in panels
import messagesPanel from "./panels/messages.js";
import blogPanel from "./panels/blog.js";
import filesPanel from "./panels/files.js";
import healthPanel from "./panels/health.js";
import memoryPanel from "./panels/memory.js";
import extensionsPanel from "./panels/extensions.js";
import modelCatalogPanel from "./panels/model-catalog.js";
import skillsPanel from "./panels/skills.js";
import schedulePanel, { schedulePreview } from "./panels/schedule.js";
import projectsPanel from "./panels/projects.js";
import settingsPanel from "./panels/settings.js";
import contactsPanel from "./panels/contacts.js";
import botBuilderPanel from "./panels/bot-builder.js";
import botBoardPanel from "./panels/bot-board.js";
import historyPanel, { mountHistoryRoutes } from "./panels/history.js";
import boardPanel from "./panels/board.js";
import designSystemPanel from "./panels/design-system.js";
import onboardingPanel, { handleIdentityBackupPost, handleCloudProviderPost, handleMeetPost, handlePreviewsPost } from "./panels/onboarding.js";
import connectPanel from "./panels/connect.js";
import fediversePanel from "./panels/fediverse.js";
import meteringPanel from "./panels/metering.js";
import perchHubPanel from "./panels/perch-hub.js";
import makePanel, { openMakeItem } from "./panels/make.js";
import projectHomePanel from "./panels/project-home.js";
import projectServicesPanel from "./panels/project-services.js";
import forYouPanel from "./panels/for-you.js";
import widgetsPanel from "./panels/widgets.js";
import { servicesUiEnabled } from "../services/ui-flag.js";
import "../services/launcher-tile.js"; // registers the "Add a service" launcher tile
import { serveArtifactPreview, serveWorkspacePreview, enablePreviews } from "../make/previews.js";
import { handleFixItAction } from "../fix-it/index.js";
import bundlesRouterFactory from "../routes/bundles.js";
import { keychainApiRouter } from "../keychain/api.js";
import perchApiRouter from "../routes/perch.js";
import { shellApiRouter } from "../routes/shell-api.js";
import { appsApiRouter } from "../routes/apps-api.js";
import { makeApiRouter } from "../routes/make-api.js";
import { c2cApiRouter } from "../routes/c2c-api.js";
import perchInteractiveApiRouter from "../routes/perch-interactive-api.js";
import perchDictationRouter from "../routes/perch-dictation.js";
import voiceHandoffsRouter from "../routes/voice-handoffs.js";
import stagedPageRouter from "../routes/staged-page.js";
import mailApiRouter from "../routes/mail-api.js";
import widgetsRouter from "../routes/widgets.js";
import { shellRouter, resolveRequestMode, resolveShellPage, nestIsExplicit } from "./shell/request.js";
import { isLocalPasswordSessionOn } from "./local-session.js";
import { withForYouOwner } from "./shell/chrome.js";
import { forYouEnabled } from "../for-you/flag.js";

/** A first-run gate message: where the token lives is described (this machine or
 * the container), never as a host path the browser could be told to read. */
function setupTokenMessage(key, lang) {
  return t(key, lang);
}

/** A retried 2FA step's pending token keeps the SSO context, the on-host flag
 * and any dashboard-consent hand-off (auth.js / oauth-consent.js). */
function retryPendingCtx(ssoCtx, onHost, next) {
  const ctx = {};
  if (ssoCtx) ctx.sso = ssoCtx;
  if (onHost) ctx.onhost = true;
  if (next) ctx.next = next;
  return Object.keys(ctx).length ? ctx : null;
}

/**
 * @param {Function|null} mcpAuthMiddleware - OAuth auth middleware (for unified auth)
 * @returns {Router}
 */
export default function dashboardRouter(mcpAuthMiddleware, { renderLayout: renderPage = renderLayout } = {}) {
  const router = Router();
  // Once at start: a bridge subnet over the LAN makes some LAN clients "this machine" (self-origin.js).
  warnBridgeOverlap();

  // URL-encoded body parsing for form submissions
  router.use("/dashboard", express.urlencoded({ extended: false }));

  // Register built-in panels
  registerPanel(healthPanel);
  registerPanel(messagesPanel);
  registerPanel(memoryPanel);
  registerPanel(projectsPanel);
  registerPanel(blogPanel);
  registerPanel(filesPanel);
  registerPanel(extensionsPanel);
  registerPanel(modelCatalogPanel);
  registerPanel(skillsPanel);
  registerPanel(schedulePanel);
  registerPanel(settingsPanel);
  registerPanel(contactsPanel);
  registerPanel(botBuilderPanel);
  registerPanel(botBoardPanel);
  registerPanel(historyPanel);
  registerPanel(boardPanel);
  registerPanel(designSystemPanel);
  registerPanel(onboardingPanel);
  registerPanel(connectPanel);
  registerPanel(fediversePanel);
  registerPanel(meteringPanel);
  registerPanel(perchHubPanel);
  registerPanel(makePanel);
  registerPanel(projectHomePanel);
  registerPanel(projectServicesPanel);
  registerPanel(forYouPanel); // 404s unless CROW_FOR_YOU=1 (the panel checks per request)
  // The generic widget page (widgets phase 2, Task 3): the same gate and flag as For You, one swipe in.
  registerPanel(widgetsPanel);

  // Load third-party panels (async, non-blocking)
  loadExternalPanels().catch((err) => {
    console.warn("[dashboard] Failed to load external panels:", err.message);
  });

  // --- Public routes (no auth) ---

  // Login page. First run only (no password yet): a request that is not direct
  // loopback BY A NAME THAT CAN ONLY BE THIS MACHINE must carry the setup token,
  // or it gets the gated message instead of the password form — a LAN neighbour
  // cannot claim the instance (setup-token.js), and neither can a DNS-rebinding
  // page whose loopback socket carries its own domain as the Host
  // (isLoopbackHost, same-origin.js).
  router.get("/dashboard/login", async (req, res) => {
    // The network gate comes first: a source every private route refuses must
    // not be handed a page that takes a password (nor a setup link). Direct
    // loopback stays allowed — that is the first-run setup path.
    if (!loginNetworkAllowed(req)) return sendNetworkRefusal(req, res);
    const cookies = parseCookies(req);
    const lang = SUPPORTED_LANGS.includes(cookies.crow_lang) ? cookies.crow_lang : "en";
    // An app's consent hand-off survives the login round trip only in the exact
    // shape oauth-consent.js minted (isConsentNext): anything else is ignored,
    // so ?next= can never become an open redirect.
    const next = isConsentNext(req.query.next) ? req.query.next : undefined;
    const hasPassword = await isPasswordSet();
    if (!hasPassword) {
      const gate = allowFirstRun(req, { from: "query" });
      if (!gate.allowed) {
        return res.type("html").send(renderLogin({ isSetup: true, error: setupTokenMessage("login.setupTokenGated", lang), lang, next }));
      }
      return res.type("html").send(renderLogin({ isSetup: true, setupToken: gate.token || undefined, lang, next }));
    }
    res.type("html").send(renderLogin({ isSetup: false, lang, next }));
  });

  // Login handler
  router.post("/dashboard/login", async (req, res) => {
    // Before the password check, the lockout counter, isPasswordSet() and any
    // read of the body: a refused source never gets to guess.
    if (!loginNetworkAllowed(req)) return sendNetworkRefusal(req, res);
    const cookies = parseCookies(req);
    const lang = SUPPORTED_LANGS.includes(cookies.crow_lang) ? cookies.crow_lang : "en";
    const { password, confirm } = req.body;
    // The consent hand-off, again only in the exact minted shape.
    const next = isConsentNext(req.body.next) ? req.body.next : undefined;
    const hasPassword = await isPasswordSet();
    const wasFirstSetup = !hasPassword; // capture before setPassword() runs below

    if (!hasPassword) {
      // N1a-2: the first password is only accepted from this gateway's own page.
      // This POST runs BEFORE csrfMiddleware (an anonymous first-run request has
      // no session cookie, and csrf.js skips those) and bare loopback needs no
      // setup token, so without this a web page open in the owner's browser could
      // auto-submit a form to http://localhost:3001/dashboard/login and pick the
      // password. A browser cannot forge Origin / Sec-Fetch-Site; a request with
      // neither header is a script on the box and is left to the token gate.
      if (!isSameOriginRequest(req)) {
        return res.status(403).type("text/plain").send(FIRST_RUN_CROSS_ORIGIN_MESSAGE);
      }
      // First-time setup. The setup token comes first: while no password exists,
      // only direct loopback (the owner on this machine or through an SSH
      // tunnel) BY A LOOPBACK HOST may set it, or a request carrying the matching
      // one-time token. CROW_SETUP_TOKEN (hosted) has no loopback exemption
      // (setup-token.js).
      const gate = allowFirstRun(req, { from: "body" });
      if (!gate.allowed) {
        // N1a-2 fix round 1 — DNS rebinding. A loopback socket under a Host that
        // names neither this machine nor a configured origin is the shape of a
        // page that re-pointed its own domain at 127.0.0.1: Host and Origin then
        // agree (so the check above passes) and no forwarding header exists (so
        // the loopback socket looks like the owner's). Without the token that is
        // the plain refusal a foreign page gets, not the gated login page a real
        // LAN visitor sees; with the token, allowFirstRun() allowed it above and
        // the setup link keeps working.
        if (isDirectLoopback(req) && !isLoopbackHost(req)) {
          return res.status(403).type("text/plain").send(FIRST_RUN_CROSS_ORIGIN_MESSAGE);
        }
        return res.type("html").send(renderLogin({ isSetup: true, error: setupTokenMessage("login.setupTokenInvalid", lang), lang }));
      }
      // Every error render below carries the validated token back into the form:
      // without it the retry would be refused, since the peer is not loopback.
      const retryToken = gate.token || undefined;
      const strength = validatePasswordStrength(password);
      if (!strength.valid) {
        return res.type("html").send(renderLogin({ isSetup: true, setupToken: retryToken, error: strength.message, lang }));
      }
      if (password !== confirm) {
        return res.type("html").send(renderLogin({ isSetup: true, setupToken: retryToken, error: "Passwords don't match.", lang }));
      }
      await setPassword(password);
      // The first password exists: the one-time token has done its job.
      clearSetupToken();
    }

    const deviceTrustToken = cookies.crow_2fa_trusted || null;
    const userAgent = req.headers["user-agent"] || null;
    // A login from this machine itself (its console, the shared browser, a local script) is
    // stored as 'dashboard onhost': signed in, never the owner's turn (local-session.js).
    const result = await attemptLogin(password, req.ip, deviceTrustToken, userAgent, { onHost: isSelfOrigin(req), next });
    if (result.error) {
      let lockoutHelp = "";
      if (result.locked) {
        const hostedMode = !!process.env.CROW_HOSTED;
        if (hostedMode) {
          const instanceId = process.env.CROW_GATEWAY_URL || "your instance";
          lockoutHelp = `<div style="margin-top:1rem;padding:1rem;background:var(--crow-bg-deep,#1a1a1a);border:1px solid var(--crow-border,#333);border-radius:8px;font-size:0.85rem">
            <p><a href="/dashboard/reset">${t("login.forgotPassword", lang)}</a></p>
            <p style="margin-top:0.5rem;color:var(--crow-text-tertiary,#888)">${t("login.lockoutSupport", lang)}: <a href="mailto:support@maestro.press">support@maestro.press</a></p>
            <p style="margin-top:0.25rem;font-size:0.75rem;color:var(--crow-text-tertiary,#666)">Instance: ${instanceId}</p>
          </div>`;
        } else {
          lockoutHelp = `<div style="margin-top:1rem;padding:1rem;background:var(--crow-bg-deep,#1a1a1a);border:1px solid var(--crow-border,#333);border-radius:8px;font-size:0.85rem">
            <p style="color:var(--crow-text-secondary,#aaa)">${t("login.lockoutSelfHosted", lang)}</p>
            <pre style="margin-top:0.5rem;font-size:0.8rem;color:var(--crow-text-primary)">npm run reset-password</pre>
          </div>`;
        }
      }
      return res.type("html").send(renderLogin({ isSetup: false, error: result.error, lockoutHelp, lang, next }));
    }

    if (result.requires2fa) {
      // Set pending_2fa cookie and show 2FA page
      const secure = process.env.CROW_HOSTED || process.env.NODE_ENV === "production";
      const secureSuffix = secure ? "; Secure" : "";
      res.setHeader("Set-Cookie", `crow_pending_2fa=${result.pending2faToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=300${secureSuffix}`);
      return res.type("html").send(render2faVerify({ lang }));
    }

    // Check if managed hosting requires 2FA setup
    if (await needs2faSetup()) {
      // Issue session first so they can access the setup page
      setSessionCookie(res, result.token);
      return res.redirectAfterPost("/dashboard/login/2fa/setup");
    }

    setSessionCookie(res, result.token);

    // W3-3: redirect to onboarding only on first-ever setup AND only when the
    // completion flag has never been set (so existing operators who reset their
    // password are never nagged). `next` is dropped on first run on purpose: an app
    // sign-in started before the owner existed is restarted from the app after onboarding.
    if (wasFirstSetup) {
      let onboardingDone = false;
      const _loginDb = createDbClient();
      try {
        const { rows } = await _loginDb.execute({
          sql: "SELECT value FROM dashboard_settings WHERE key='onboarding_completed_at'",
          args: [],
        });
        onboardingDone = rows.length > 0 && !!rows[0].value;
      } catch {} finally {
        try { _loginDb.close(); } catch {}
      }
      return res.redirectAfterPost(onboardingDone ? "/dashboard" : "/dashboard/onboarding");
    }
    res.redirectAfterPost(next || "/dashboard");
  });

  // 2FA verification (TOTP code entry after password)
  router.post("/dashboard/login/2fa", async (req, res) => {
    // Same network gate as the login page and its POST: a source the rest of the
    // dashboard refuses never gets to guess a code.
    if (!loginNetworkAllowed(req)) return sendNetworkRefusal(req, res);
    const cookies = parseCookies(req);
    const lang = SUPPORTED_LANGS.includes(cookies.crow_lang) ? cookies.crow_lang : "en";
    const pendingToken = cookies.crow_pending_2fa;

    // Read any SSO context bound to this pending token BEFORE it is consumed.
    const pendingCtx = await getPending2faContext(pendingToken);
    const ssoCtx = pendingCtx?.sso || null;
    // A dashboard-consent hand-off rides the same pending token (auth.js).
    const consentNext = isConsentNext(pendingCtx?.next) ? pendingCtx.next : undefined;
    // On-host if the password step or this step came from this machine (auth.js passwordSessionScopes).
    const onHost = pendingCtx?.onhost === true || isSelfOrigin(req);

    // Verify pending token
    const validPending = await verifyPending2faToken(pendingToken);
    if (!validPending) {
      return res.type("html").send(renderLogin({ error: t("login.2faSessionExpired", lang), lang }));
    }

    const { totp_code, trust_device } = req.body;
    const secret = await getTotpSecret();
    if (!secret || !verifyTotp(totp_code, secret)) {
      // Re-create pending token for retry, preserving any SSO context.
      const newToken = await createPending2faToken(retryPendingCtx(ssoCtx, onHost, consentNext));
      const secure = process.env.CROW_HOSTED || process.env.NODE_ENV === "production";
      const secureSuffix = secure ? "; Secure" : "";
      res.setHeader("Set-Cookie", `crow_pending_2fa=${newToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=300${secureSuffix}`);
      return res.type("html").send(render2faVerify({ error: t("login.2faInvalidCode", lang), lang }));
    }

    // 2FA verified. If this flow originated from cross-instance SSO (context
    // bound to the pending token), mint a 24h SSO session and return to the
    // SSO destination — NOT a normal 7d session.
    const ssoSrc = ssoCtx?.src || null;
    const ssoDest = ssoCtx?.dest || null;
    // PT-1: mintSsoSession re-checks the source peer (it may have been revoked
    // or paused since the ticket arrived); the pending token is already spent.
    let result;
    try {
      result = ssoSrc ? await mintSsoSession(ssoSrc) : await complete2faLogin(req.ip, { onHost });
    } catch (err) {
      if (err?.code !== "sso_refused") throw err;
      res.setHeader("Set-Cookie", `crow_pending_2fa=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
      return res.status(401).type("html").send(renderLogin({ error: t("login.ssoRefused", lang), lang }));
    }
    const sessionMaxAge = ssoSrc ? SSO_SESSION_MAX_AGE : undefined;
    const redirectTo = ssoSrc
      ? (ssoDest && isSafeDestPath(ssoDest) ? ssoDest : "/dashboard")
      : (consentNext || "/dashboard");

    // Clear pending cookie
    const cookieHeaders = [`crow_pending_2fa=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`];

    // Set device trust if requested
    if (trust_device === "1") {
      const trustToken = await createDeviceTrust();
      const maxAge = DEVICE_TRUST_TTL / 1000;
      const secure = process.env.CROW_HOSTED || process.env.NODE_ENV === "production";
      const secureSuffix = secure ? "; Secure" : "";
      cookieHeaders.push(`crow_2fa_trusted=${trustToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureSuffix}`);
    }

    setSessionCookie(res, result.token, sessionMaxAge);
    // Append our extra cookies
    const existing = res.getHeader("Set-Cookie") || [];
    res.setHeader("Set-Cookie", [...(Array.isArray(existing) ? existing : [existing]), ...cookieHeaders]);
    res.redirectAfterPost(redirectTo);
  });

  // 2FA recovery code entry page
  router.get("/dashboard/login/2fa/recovery", async (req, res) => {
    if (!loginNetworkAllowed(req)) return sendNetworkRefusal(req, res);
    const cookies = parseCookies(req);
    const lang = SUPPORTED_LANGS.includes(cookies.crow_lang) ? cookies.crow_lang : "en";
    res.type("html").send(render2faRecovery({ lang }));
  });

  // 2FA recovery code verification
  router.post("/dashboard/login/2fa/recovery", async (req, res) => {
    if (!loginNetworkAllowed(req)) return sendNetworkRefusal(req, res);
    const cookies = parseCookies(req);
    const lang = SUPPORTED_LANGS.includes(cookies.crow_lang) ? cookies.crow_lang : "en";
    const pendingToken = cookies.crow_pending_2fa;

    // Read SSO context bound to the pending token before it is consumed.
    const pendingCtx = await getPending2faContext(pendingToken);
    const ssoCtx = pendingCtx?.sso || null;
    const consentNext = isConsentNext(pendingCtx?.next) ? pendingCtx.next : undefined;
    const onHost = pendingCtx?.onhost === true || isSelfOrigin(req);

    const validPending = await verifyPending2faToken(pendingToken);
    if (!validPending) {
      return res.type("html").send(renderLogin({ error: t("login.2faSessionExpired", lang), lang }));
    }

    const { recovery_code } = req.body;
    const valid = await verifyRecoveryCode(recovery_code);
    if (!valid) {
      // Re-create pending token for retry, preserving any SSO context.
      const newToken = await createPending2faToken(retryPendingCtx(ssoCtx, onHost, consentNext));
      const secure = process.env.CROW_HOSTED || process.env.NODE_ENV === "production";
      const secureSuffix = secure ? "; Secure" : "";
      res.setHeader("Set-Cookie", `crow_pending_2fa=${newToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=300${secureSuffix}`);
      return res.type("html").send(render2faRecovery({ error: t("login.2faInvalidCode", lang), lang }));
    }

    // Same SSO-origin handling as the TOTP path: a recovery-code login that
    // came from cross-instance SSO gets a 24h SSO session + the SSO dest.
    const ssoSrc = ssoCtx?.src || null;
    const ssoDest = ssoCtx?.dest || null;
    // PT-1: mintSsoSession re-checks the source peer (it may have been revoked
    // or paused since the ticket arrived); the pending token is already spent.
    let result;
    try {
      result = ssoSrc ? await mintSsoSession(ssoSrc) : await complete2faLogin(req.ip, { onHost });
    } catch (err) {
      if (err?.code !== "sso_refused") throw err;
      res.setHeader("Set-Cookie", `crow_pending_2fa=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
      return res.status(401).type("html").send(renderLogin({ error: t("login.ssoRefused", lang), lang }));
    }
    const sessionMaxAge = ssoSrc ? SSO_SESSION_MAX_AGE : undefined;
    const redirectTo = ssoSrc
      ? (ssoDest && isSafeDestPath(ssoDest) ? ssoDest : "/dashboard")
      : (consentNext || "/dashboard");

    const cookieHeaders = [`crow_pending_2fa=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`];
    setSessionCookie(res, result.token, sessionMaxAge);
    const existing = res.getHeader("Set-Cookie") || [];
    res.setHeader("Set-Cookie", [...(Array.isArray(existing) ? existing : [existing]), ...cookieHeaders]);
    res.redirectAfterPost(redirectTo);
  });

  // 2FA setup page (mandatory for managed hosting, optional access for self-hosted via settings)
  router.get("/dashboard/login/2fa/setup", async (req, res) => {
    res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });
    // Same network gate as the login page: a refused source must not reach
    // twoFactorSetupGate, nor be handed a fresh secret and recovery codes.
    if (!loginNetworkAllowed(req)) return sendNetworkRefusal(req, res);
    // Signed in, and 2FA not already on: otherwise this GET would replace the
    // live secret and recovery codes for anyone who can reach it.
    const gate = await twoFactorSetupGate(req);
    if (gate) return res.redirect(gate);
    const cookies = parseCookies(req);
    const lang = SUPPORTED_LANGS.includes(cookies.crow_lang) ? cookies.crow_lang : "en";

    const { secret, uri } = generateTotpSecret();
    const qrDataUri = await generateQrDataUri(uri);
    const recoveryCodes = generateRecoveryCodes();

    // Save setup state (not yet enabled)
    await saveTotpSetup(secret, recoveryCodes);

    res.type("html").send(render2faSetup({ secret, qrDataUri, recoveryCodes, lang }));
  });

  // 2FA setup verification (verify first code to enable)
  router.post("/dashboard/login/2fa/setup", async (req, res) => {
    res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });
    // Same network gate: a refused source never gets to verify a code here.
    if (!loginNetworkAllowed(req)) return sendNetworkRefusal(req, res);
    const gate = await twoFactorSetupGate(req);
    if (gate) return res.redirectAfterPost(gate);
    const cookies = parseCookies(req);
    const lang = SUPPORTED_LANGS.includes(cookies.crow_lang) ? cookies.crow_lang : "en";
    const { totp_code, secret } = req.body;

    const currentSecret = await getTotpSecret();
    if (!currentSecret || currentSecret !== secret) {
      return res.redirectAfterPost("/dashboard/login/2fa/setup");
    }

    if (!verifyTotp(totp_code, currentSecret)) {
      // Re-render setup with error (codes already saved, just need QR)
      const uri = new (await import("otpauth")).TOTP({
        issuer: "Crow",
        label: "Crow's Nest",
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        secret: (await import("otpauth")).Secret.fromBase32(currentSecret),
      }).toString();
      const qrDataUri = await generateQrDataUri(uri);
      return res.type("html").send(render2faSetup({ secret: currentSecret, qrDataUri, error: t("login.2faInvalidCode", lang), lang }));
    }

    // Enable 2FA
    await enable2fa();
    res.redirectAfterPost("/dashboard");
  });

  // Password reset request page
  router.get("/dashboard/reset", async (req, res) => {
    if (!loginNetworkAllowed(req)) return sendNetworkRefusal(req, res);
    const cookies = parseCookies(req);
    const lang = SUPPORTED_LANGS.includes(cookies.crow_lang) ? cookies.crow_lang : "en";
    const isHosted = !!process.env.CROW_HOSTED;

    // If coming from email link with token, show the new password form
    if (req.query.token) {
      if (!isHosted || !process.env.CROW_HOSTING_API_URL) {
        return res.type("html").send(renderResetRequest({ error: t("login.resetNotAvailable", lang), isHosted, lang }));
      }
      // Validate token with hosting API
      try {
        const resp = await fetch(`${process.env.CROW_HOSTING_API_URL}/api/password-reset/validate`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Instance-Token": process.env.CROW_HOSTING_AUTH_TOKEN },
          body: JSON.stringify({ token: req.query.token }),
        });
        if (!resp.ok) {
          return res.type("html").send(renderResetRequest({ error: t("login.resetInvalidToken", lang), isHosted, lang }));
        }
      } catch {
        return res.type("html").send(renderResetRequest({ error: t("login.resetNotAvailable", lang), isHosted, lang }));
      }
      return res.type("html").send(renderResetForm({ token: req.query.token, lang }));
    }

    res.type("html").send(renderResetRequest({ isHosted, lang }));
  });

  // Password reset request handler (managed hosting — triggers email via hosting API)
  router.post("/dashboard/reset", async (req, res) => {
    if (!loginNetworkAllowed(req)) return sendNetworkRefusal(req, res);
    const cookies = parseCookies(req);
    const lang = SUPPORTED_LANGS.includes(cookies.crow_lang) ? cookies.crow_lang : "en";
    const isHosted = !!process.env.CROW_HOSTED;

    if (!isHosted || !process.env.CROW_HOSTING_API_URL) {
      return res.type("html").send(renderResetRequest({ error: t("login.resetNotAvailable", lang), isHosted, lang }));
    }

    try {
      await fetch(`${process.env.CROW_HOSTING_API_URL}/api/password-reset/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Instance-Token": process.env.CROW_HOSTING_AUTH_TOKEN },
      });
    } catch {
      // Silently succeed to not leak info
    }

    // Always show success message (don't reveal whether email exists)
    const { auditLog: audit } = await import("../../db.js");
    const { createDbClient } = await import("../../db.js");
    const db = createDbClient();
    try { await audit(db, "password_reset_requested", {}); } finally { db.close(); }

    res.type("html").send(renderResetRequest({ success: t("login.resetEmailSent", lang), isHosted, lang }));
  });

  // Password reset completion (new password form submission)
  router.post("/dashboard/reset/complete", async (req, res) => {
    if (!loginNetworkAllowed(req)) return sendNetworkRefusal(req, res);
    const cookies = parseCookies(req);
    const lang = SUPPORTED_LANGS.includes(cookies.crow_lang) ? cookies.crow_lang : "en";
    const isHosted = !!process.env.CROW_HOSTED;
    const { token, password, confirm } = req.body;

    if (!isHosted || !process.env.CROW_HOSTING_API_URL || !token) {
      return res.type("html").send(renderResetRequest({ error: t("login.resetNotAvailable", lang), isHosted, lang }));
    }

    // Validate password
    const strength = validatePasswordStrength(password);
    if (!strength.valid) {
      return res.type("html").send(renderResetForm({ error: strength.message, token, lang }));
    }
    if (password !== confirm) {
      return res.type("html").send(renderResetForm({ error: "Passwords don't match.", token, lang }));
    }

    // Validate token one more time
    try {
      const resp = await fetch(`${process.env.CROW_HOSTING_API_URL}/api/password-reset/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Instance-Token": process.env.CROW_HOSTING_AUTH_TOKEN },
        body: JSON.stringify({ token }),
      });
      if (!resp.ok) {
        return res.type("html").send(renderResetRequest({ error: t("login.resetInvalidToken", lang), isHosted, lang }));
      }
    } catch {
      return res.type("html").send(renderResetRequest({ error: t("login.resetNotAvailable", lang), isHosted, lang }));
    }

    // Set new password
    await setPassword(password);

    // Mark token as used
    try {
      await fetch(`${process.env.CROW_HOSTING_API_URL}/api/password-reset/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Instance-Token": process.env.CROW_HOSTING_AUTH_TOKEN },
        body: JSON.stringify({ token }),
      });
    } catch {
      // Non-critical — password already changed
    }

    const { auditLog: audit, createDbClient } = await import("../../db.js");
    const db = createDbClient();
    try { await audit(db, "password_reset_completed", {}); } finally { db.close(); }

    res.type("html").send(renderLogin({ error: t("login.resetSuccess", lang), lang }));
  });

  // (Logout lives AFTER dashboardAuth + csrfMiddleware, below. It used to be
  // here, in the public section, as a plain GET — see its comment.)

  // SSO accept — PUBLIC route (no password). Authenticated by a single-use,
  // HMAC-signed ticket minted by a paired+trusted source instance. Mounted
  // BEFORE dashboardAuth, so it explicitly re-applies the tailnet-only guard
  // (isAllowedNetwork) that dashboardAuth would otherwise provide. It is never
  // reachable via Funnel — rejectFunneledMiddleware (global) 403s any
  // /dashboard/* path that isn't in PUBLIC_FUNNEL_PREFIXES.
  router.get("/dashboard/sso/accept", async (req, res) => {
    if (!isAllowedNetwork(req)) {
      return res.status(403).type("text/plain").send("Forbidden: local network or Tailscale only.");
    }
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");

    const db = createDbClient();
    const localId = getOrCreateLocalInstanceId();
    const src = String(req.query.src || "");
    // An audit failure never turns a refusal into a 500 (PT-1).
    const audit = async (extra) => {
      try {
        await auditCrossHostCall(db, {
          sourceInstanceId: src || null,
          targetInstanceId: localId,
          direction: "inbound",
          action: "sso.accept",
          ...extra,
        });
      } catch { /* audit is best effort */ }
    };
    try {
      const payloadB64 = String(req.query.t || "");
      const sig = String(req.query.sig || "");
      if (!src || !payloadB64 || !sig) {
        await audit({ hmacValid: false, error: "missing_params" });
        return res.status(400).type("text/plain").send("Bad request.");
      }

      // B-local opt-in. Default off.
      if ((await readSetting(db, "sso_enabled")) !== "true") {
        await audit({ hmacValid: false, error: "sso_disabled" });
        return res.status(403).type("text/plain").send("Single sign-on is disabled on this instance.");
      }

      // Must be a trusted live peer (the one trust predicate, PT-1) AND hold
      // its shared signing key. One response for every refusal, so a caller
      // cannot learn which ids exist or are revoked; the reason is audited.
      const trust = await peerTrust(db, src);
      if (!trust.ok) {
        await audit({ hmacValid: false, error: `peer_not_trusted:${trust.reason}` });
        return res.status(401).type("text/plain").send("Single sign-on refused.");
      }
      const creds = getPeerCreds(src);
      if (!creds || !creds.signing_key) {
        await audit({ hmacValid: false, error: "no_signing_key_for_source" });
        return res.status(401).type("text/plain").send("Single sign-on refused.");
      }

      const result = verifyTicket({ payloadB64, sig, signingKey: creds.signing_key, expectedDst: localId });
      if (!result.valid) {
        await audit({ hmacValid: false, error: result.reason });
        return res.status(401).type("text/plain").send("Single sign-on refused.");
      }
      // The signature already binds src (signed with that peer's key), but make
      // the claimed query src and the signed src agree so the audit row is accurate.
      if (result.ticket.src !== src) {
        await audit({ hmacValid: true, nonce: result.ticket.nonce, error: "src_mismatch" });
        return res.status(401).type("text/plain").send("Single sign-on refused.");
      }
      const dest = result.ticket.dest; // already validated by verifyTicket

      // SSO replaces the password step only. If this instance has 2FA, send
      // the user through its existing TOTP flow; the session is minted as a
      // 24h SSO session after the second factor (see POST /dashboard/login/2fa).
      const secure = process.env.CROW_HOSTED || process.env.NODE_ENV === "production";
      const secureSuffix = secure ? "; Secure" : "";
      if (await is2faEnabled()) {
        // Bind the SSO context to the single-use pending-2FA token (not a
        // separate cookie) so it can't bleed into a later normal login.
        const pendingToken = await createPending2faToken({ sso: { src, dest } });
        res.setHeader("Set-Cookie",
          `crow_pending_2fa=${pendingToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=300${secureSuffix}`);
        await audit({ hmacValid: true, nonce: result.ticket.nonce, error: "2fa_required" });
        return res.redirect(302, "/dashboard/login/2fa");
      }

      let token;
      try {
        ({ token } = await mintSsoSession(src));
      } catch (err) {
        if (err?.code !== "sso_refused") throw err;
        await audit({ hmacValid: true, nonce: result.ticket.nonce, error: `peer_not_trusted:${err.reason}` });
        return res.status(401).type("text/plain").send("Single sign-on refused.");
      }
      setSessionCookie(res, token, SSO_SESSION_MAX_AGE);
      await audit({ hmacValid: true, nonce: result.ticket.nonce });
      return res.redirect(303, dest);
    } catch (err) {
      console.warn("[sso] accept failed:", err.message);
      return res.status(500).type("text/plain").send("SSO error.");
    } finally {
      db.close();
    }
  });

  // --- Protected routes ---

  // OAuth consent — the security audit's finding. Mounted in the PUBLIC
  // section, BEFORE dashboardAuth, because it does its own session check
  // (sessionFromRequest) so that a signed-out owner can be carried through the
  // login page and back (?next=), which dashboardAuth's bare redirect loses. It
  // is still Funnel-refused (sessionFromRequest applies isAllowedNetwork) and
  // its POST re-checks the session and the CSRF token itself, because
  // csrfMiddleware below skips requests that carry no session cookie. The
  // urlencoded body parser above already covers its POST body.
  router.use(createOAuthConsentRouter());

  // Instantiate bundles router once so the cross-host bypass and the normal
  // dashboard-auth mount both dispatch to the same routes.
  const bundlesRouter = bundlesRouterFactory();

  // Federation router — HMAC-gated only, no session-auth path. Mount behind
  // a kill-switch so operators can disable federation without redeploying
  // the dashboard. Defaults on; set CROW_UNIFIED_DASHBOARD=0 to disable.
  const federationEnabled = process.env.CROW_UNIFIED_DASHBOARD !== "0";
  const federationRouter = federationEnabled
    ? federationRouterFactory({ createDbClient })
    : null;

  // Cross-host bypass: signed peer-to-peer calls route to the appropriate
  // HMAC-authenticated router based on path, skipping dashboardAuth. Each
  // target router runs its own HMAC verification middleware.
  router.use("/dashboard", (req, res, next) => {
    if (!req.headers["x-crow-signature"]) return next();
    // /dashboard/overview → federationRouter (Phase 1)
    // /dashboard/capabilities → federationRouter (F4a Layer 1)
    // /dashboard/advertised-bots → federationRouter (Theme 12 roster auto-advertise)
    // /dashboard/bot-federation/* → federationRouter (F4a Layer 3, parameterized paths)
    if (federationRouter && (req.path === "/overview" || req.path === "/capabilities" || req.path === "/advertised-bots" || req.path.startsWith("/bot-federation/"))) {
      return federationRouter(req, res, next);
    }
    // Everything else (bundles) → bundlesRouter (existing behavior)
    return bundlesRouter(req, res, next);
  });

  // Auth middleware for all other dashboard routes
  router.use("/dashboard", dashboardAuth);

  // A CSRF mismatch on the logout POST is a STALE PAGE, not an attack: the form
  // was rendered with a token that has since been replaced (a second tab logged
  // in again, say), and answering the plain-text 403 would leave the viewer
  // stuck on "CSRF token mismatch." So this ONE route sends them back (303) to
  // the GET confirm page, which renders whatever token the cookie carries now.
  //
  // Mounted BEFORE csrfMiddleware and scoped to POST /dashboard/logout; every
  // other route keeps csrfMiddleware's plain 403. dashboardAuth has already run
  // (so this only ever sees a live session), and on anything but a mismatch —
  // no crow_csrf cookie at all, no token echoed, or a matching token — it calls
  // next(), so the real chain (csrfMiddleware, then the POST handler below)
  // makes the decision. The comparison is csrf.js's own (csrfRefusal), not a
  // second implementation of it.
  router.use("/dashboard", (req, res, next) => {
    if (req.method !== "POST") return next();
    if (req.path !== "/logout" && req.path !== "/dashboard/logout") return next();
    if (csrfRefusal(req) !== "mismatch") return next();
    res.set("Cache-Control", "no-store");
    return res.redirect(303, "/dashboard/logout");
  });

  // CSRF double-submit validation for state-changing requests.
  // Skips: GET/HEAD/OPTIONS, HMAC-signed peer calls (handled above),
  // pre-auth flows (no session cookie yet), and CROW_CSRF_STRICT=0 rollback.
  router.use("/dashboard", csrfMiddleware);

  // --- Logout: POST only, and CSRF-checked (session-authed by dashboardAuth
  // and token-checked by csrfMiddleware, both above; a STALE token is answered
  // by the 303-to-the-confirm-page handler in front of csrfMiddleware).
  //
  // It used to be a GET in the public section that destroyed the session and
  // redirected. That made /dashboard/logout a state-changing GET on a
  // same-origin path, and the dashboard renders untrusted HTML in the owner's
  // browser: a bot's markdown reply containing `![x](/dashboard/logout)` fired
  // the request as the viewer and signed them out on read. The GET now only
  // confirms; nothing changes until the form's POST arrives.
  router.post("/dashboard/logout", async (req, res) => {
    const cookies = parseCookies(req);
    await destroySession(cookies.crow_session);
    clearSessionCookie(res);
    res.redirect("/dashboard/login");
  });

  router.get("/dashboard/logout", async (req, res) => {
    // No session change here — ever. dashboardAuth already answered a request
    // with no valid session (redirect to /dashboard/login).
    const db = createDbClient();
    let lang = "en";
    try {
      const stored = await readSetting(db, "language");
      if (SUPPORTED_LANGS.includes(stored)) lang = stored;
    } catch (err) {
      console.warn("[logout] language lookup failed, using en:", err.message);
    } finally {
      try { db.close(); } catch {}
    }
    res.set("Cache-Control", "no-store");
    res.type("html").send(renderLogoutConfirm({ lang, csrfToken: req.csrfToken || "" }));
  });

  // There is no /dashboard/models page (it is /dashboard/model-catalog), but
  // older notifications stored that link in their action_url.
  router.get("/dashboard/models", (req, res) => res.redirect("/dashboard/model-catalog"));

  // The Schedule panel's live preview: plain words → the read-back and the next 3 runs (JSON).
  // Session-gated by dashboardAuth above; read-only (GET).
  router.get("/dashboard/schedule/preview", async (req, res) => {
    const db = createDbClient();
    try { await schedulePreview(req, res, db); }
    catch (err) { if (!res.headersSent) res.status(500).json({ ok: false, error: "preview failed" }); console.warn("[schedule] preview:", err.message); }
    finally { db.close(); }
  });

  // Make tab: open a tile (marks it seen, then redirects). Session-gated by dashboardAuth above.
  router.get("/dashboard/make/open/:kind/:ref", async (req, res) => {
    const db = createDbClient();
    try { await openMakeItem(req, res, db); } finally { db.close(); }
  });

  // Make tab previews (Task 4.5). Session-gated by dashboardAuth above; the artifact image
  // re-checks eligibility on every request (make/previews.js).
  router.get("/dashboard/make/preview/artifact/:id", async (req, res) => {
    const db = createDbClient();
    try { await serveArtifactPreview(req, res, db); }
    catch (err) { console.warn(`[make] preview route: ${err.message}`); if (!res.headersSent) res.status(404).type("text/plain").send("not found"); }
    finally { db.close(); }
  });
  router.get("/dashboard/make/preview/workspace_file/:id", async (req, res) => {
    try { await serveWorkspacePreview(req, res); }
    catch (err) { console.warn(`[make] workspace preview route: ${err.message}`); if (!res.headersSent) res.status(404).type("text/plain").send("not found"); }
  });
  // "Turn on previews": session-authed + CSRF-protected by the two middlewares above.
  router.post("/dashboard/make/previews/enable", async (req, res) => {
    const db = createDbClient();
    try { await enablePreviews(req, res, db); } finally { db.close(); }
  });

  // Crow keychain API (Settings → Security & passwords → Saved passwords & keys + the Extensions first-view banner).
  // Session-authed + CSRF-protected by the two middlewares above; the router itself
  // refuses peer-signed requests and serves every response no-store.
  router.use(keychainApiRouter());

  // Perch Hub P1 (C-5): the gateway API the proxied bots lens calls.
  // Mounted HERE — inside the dashboard router, after dashboardAuth AND after
  // csrfMiddleware — rather than at app root beside bot-board-api, because
  // that ordering is what gives it the real CSRF rail: routers mounted at app
  // root in boot/feature-mounts.js run BEFORE this file's middleware and would
  // silently skip it. The rate-limit skip for /dashboard applies either way.
  // The router still installs dashboardAuth on its own prefix (bot-board-api
  // idiom) so it is closed wherever it is mounted.
  router.use(perchApiRouter(dashboardAuth));

  // Shell: the apps launcher's read (GET /dashboard/shell-api/apps). Same slot
  // and rails as the Perch API above; its own dashboardAuth covers only /apps.
  router.use(appsApiRouter(dashboardAuth));

  // Shell: move an item (thread, artifact, Workspace file) between projects.
  // Same slot and rails as the Perch API above.
  router.use(shellApiRouter(dashboardAuth));

  // Make tab: create a blank Workspace file in the current project. Same slot and rails.
  router.use(makeApiRouter(dashboardAuth));

  // Crow-to-Crow sharing (plan 1, task 7B): invite a contact's Crow, change the
  // role, unshare, read the live members, and answer an invitation. Same slot and
  // rails as the Make API above (session + CSRF, Funnel refused upstream); the
  // router's own owner check (isLocalPasswordSessionOn) is what keeps a peer-SSO or
  // instance-auth request out. See routes/c2c-api.js's header.
  router.use(c2cApiRouter(dashboardAuth));

  // Perch Hub P2 (C-15): the interactive ("spawn as bot") API. Same mount
  // slot, same reasons — see perch.js's header above and this file's own
  // comment on the P1 mount.
  router.use(perchInteractiveApiRouter(dashboardAuth));

  // Credential card (spec §10.2): the password card's submit. Same slot, same rails (session +
  // CSRF, Funnel refused upstream); its own 4kb parser and fixed-code error handler (the path is
  // in index.js _hasOwnParser). See routes/secret-submit.js's header.
  router.use(secretSubmitRouter(dashboardAuth));

  // Perch composer dictation (queue item 15): one-shot speech-to-text through
  // the configured STT profile. Same slot, same reasons (session + CSRF rails,
  // Funnel refused upstream); see routes/perch-dictation.js's header.
  router.use(perchDictationRouter(dashboardAuth));

  // The voice hand-off's phone confirm page (a kiosk's hand-off, confirmed on
  // the operator's phone). Same slot, same rails: session + CSRF, Funnel
  // refused upstream, its own dashboardAuth on its prefix; see
  // routes/voice-handoffs.js's header.
  router.use(voiceHandoffsRouter(dashboardAuth));

  // The staged draft's standalone page (spec §12): a draft a bot made from a
  // channel turn or a job has no Perch chat to draw its card in, so the
  // notification opens /dashboard/staged/:id. Same slot and rails as the phone
  // confirm page above (session + CSRF, Funnel refused upstream), and the page
  // is owner-only on its own prefix — see routes/staged-page.js's header.
  router.use(stagedPageRouter(dashboardAuth));

  // Crow Mail's private JSON API (`CROW_MAIL`): the same slot and rails as the staged page above
  // (session + CSRF, Funnel refused upstream), owner-only on its own prefix — see routes/mail-api.js.
  router.use(mailApiRouter(dashboardAuth));

  // The "What needs me" widget's API (widgets phase 1): the JSON summary both renderers draw and
  // the act endpoint that answers an item in place. Same slot and rails as the phone confirm page
  // above — session + CSRF, Funnel refused upstream, its own dashboardAuth and owner check on
  // /dashboard/widgets-api; see routes/widgets.js's header.
  router.use(widgetsRouter(dashboardAuth));

  // The shell's POST /dashboard/mode and /dashboard/scope (redesign P2): after
  // dashboardAuth and csrfMiddleware, like every state-changing dashboard route.
  router.use(shellRouter({ createDbClient }));

  // Health attention: the "This is expected" ack and the alert landing route.
  router.use(healthAttentionRouter({ createDbClient }));

  // W3-3: "Run backup now" action — dashboard-authed, CSRF-protected
  router.post("/dashboard/nest/backup", async (req, res) => {
    try {
      const { runBackup } = await import("../routes/admin-backup.js");
      await runBackup();
      res.redirectAfterPost("/dashboard/nest?flash=backup_ok");
    } catch (err) {
      console.error("[nest-backup] FAILED:", err.message);
      res.redirectAfterPost("/dashboard/nest?flash=backup_fail");
    }
  });

  // F.14: Fediverse Admin action POSTs (confirm/reject moderation, cancel/retry crosspost)
  router.post("/dashboard/fediverse/action", async (req, res) => {
    const db = createDbClient();
    try {
      await fediversePanel.handleAction(req, res, { db });
    } finally {
      try { db.close(); } catch {}
    }
  });

  // Fix-it Cards action POST (remedy / dismiss) — dashboard-authed, CSRF-protected.
  router.post("/dashboard/fix-it/action", async (req, res) => {
    const db = createDbClient();
    try {
      await handleFixItAction(req, res, { db });
    } finally {
      try { db.close(); } catch {}
    }
  });

  // 4-PR3: identity backup download (onboarding done step + Settings → Help &
  // Setup). Hand-registered — panels expose GET handlers only — and mounted
  // AFTER dashboardAuth + csrfMiddleware above, so it is session-authed and
  // CSRF-protected exactly like the fix-it action POST. The wrapper passes an
  // explicit empty opts: Express would otherwise hand `next` to the handler as
  // its third argument, i.e. as the options object.
  router.post("/dashboard/onboarding/identity-backup", (req, res) =>
    handleIdentityBackupPost(req, res, {}));

  // Task 7: onboarding AI step's cloud-provider paste-a-key form — same
  // mounting slot as identity-backup above (session-authed + CSRF-protected).
  // Inline db-lifecycle wrapper mirrors the fix-it action POST: the handler
  // itself takes an injectable `{ db, upsertProviderFn, invalidateCacheFn }`
  // for tests, production always supplies a real db here.
  router.post("/dashboard/onboarding/cloud-provider", async (req, res) => {
    const db = createDbClient();
    try {
      await handleCloudProviderPost(req, res, { db });
    } finally {
      try { db.close(); } catch {}
    }
  });

  // Task 8: onboarding "Meet your Crow" step — seeds the starter agent +
  // conversation and hands the user into their first chat. Same mounting
  // slot as identity-backup/cloud-provider above (session-authed +
  // CSRF-protected). Inline db-lifecycle wrapper mirrors both siblings.
  router.post("/dashboard/onboarding/meet", async (req, res) => {
    const db = createDbClient();
    try {
      await handleMeetPost(req, res, { db });
    } finally {
      try { db.close(); } catch {}
    }
  });

  // The starter step's "Previews in Make" toggle: records the choice (applied when the
  // tour is first finished). Same slot as the meet POST (session-authed + CSRF-protected).
  router.post("/dashboard/onboarding/previews", async (req, res) => {
    const db = createDbClient();
    try {
      await handlePreviewsPost(req, res, { db });
    } finally {
      try { db.close(); } catch {}
    }
  });

  // Federation companion router (Phase 3) — session-authed, under dashboard
  // auth. Mounted AFTER dashboardAuth so session cookies are validated.
  // /dashboard/federation/companion-overview → merged local+peer WM registry.
  // /dashboard/federation/resolve-instance  → name-to-id resolver for AI.
  if (federationEnabled) {
    const federationCompanionRouter = federationCompanionRouterFactory({ createDbClient });
    const federationResolveRouter = federationResolveRouterFactory({ createDbClient });
    router.use("/dashboard", federationCompanionRouter);
    router.use("/dashboard", federationResolveRouter);
  }

  // Normal mount (session-cookie-authenticated path)
  router.use("/dashboard", bundlesRouter);

  // Perch Hub itself is a registered panel now (panels/perch-hub.js),
  // dispatched by the generic "/dashboard/:panelId" route below — no
  // separate mount here. This is just the short link. Outside the
  // /dashboard mount, so it carries no auth — it is a redirect with no
  // content, and the destination is fully gated.
  router.get("/perch", (req, res) => res.redirect(302, "/dashboard/perch"));

  // SSO launch — authenticated on THIS instance (after dashboardAuth). Mints a
  // signed ticket for a paired+trusted target and 302s the browser to the
  // target's /dashboard/sso/accept. Falls back to a direct link (which will
  // prompt for the target's password) when SSO isn't possible.
  router.get("/dashboard/sso/launch", async (req, res) => {
    const db = createDbClient();
    try {
      const target = String(req.query.target || "");
      // The default lands on the target's home, which routes per its own mode.
      let dest = String(req.query.to || "/dashboard");
      if (!isSafeDestPath(dest)) dest = "/dashboard";
      if (!target) return res.status(400).type("text/plain").send("Missing target.");

      const { rows } = await db.execute({
        sql: "SELECT id, gateway_url, trusted, status FROM crow_instances WHERE id = ?",
        args: [target],
      });
      const row = rows[0];
      const base = row?.gateway_url ? String(row.gateway_url).replace(/\/+$/, "") : null;
      const ssoOn = (await readSetting(db, "sso_enabled")) === "true";
      const eligible = ssoOn && row && rowIsTrusted(row) && base; // PT-1: trusted AND active/offline
      const creds = eligible ? getPeerCreds(target) : null;

      if (!eligible || !creds || !creds.signing_key) {
        // Not SSO-eligible — fall back to a direct link (prompts for password)
        // if we at least have a gateway URL; otherwise back to the local home.
        if (base) return res.redirect(302, `${base}${dest}`);
        return res.redirect(302, "/dashboard");
      }

      const localId = getOrCreateLocalInstanceId();
      const { payloadB64, sig } = signTicket({ src: localId, dst: target, dest, signingKey: creds.signing_key });
      const url = new URL(`${base}/dashboard/sso/accept`);
      url.searchParams.set("src", localId);
      url.searchParams.set("t", payloadB64);
      url.searchParams.set("sig", sig);
      return res.redirect(302, url.toString());
    } catch (err) {
      console.warn("[sso] launch failed:", err.message);
      return res.status(500).type("text/plain").send("SSO error.");
    } finally {
      db.close();
    }
  });

  // Dashboard home — unified carousel when enabled + peers trusted; else
  // falls back to the first visible panel (today's behavior).
  router.get("/dashboard", async (req, res, next) => {
    const db = createDbClient();
    try {
      // New-shell devices open on Chat; classic keeps the nest / first panel.
      if ((await resolveRequestMode(req, res, db)).mode === "new") {
        // Keep the query (?project= ...) on the way to Chat.
        const q = req.url.indexOf("?");
        return res.redirect("/dashboard/perch" + (q >= 0 ? req.url.slice(q) : ""));
      }

      const unifiedEnvOn = process.env.CROW_UNIFIED_DASHBOARD !== "0";
      const setting = await readSetting(db, "unified_dashboard_enabled");
      // Default ON when the env switch is on and no explicit setting exists.
      const unifiedOn = unifiedEnvOn && setting !== "false";

      if (unifiedOn) {
        const trusted = await getTrustedInstances(db);
        if (trusted.length > 0) {
          // Fan out peer overviews with a cold-cache budget. allSettled so
          // one slow/broken peer never blocks the page. 2s per peer (via
          // overview-cache.FETCH_TIMEOUT_MS) + ~1500ms aggregate budget.
          const overall = new Promise((resolve) => setTimeout(() => resolve("__budget_exceeded__"), 1500));
          const fan = Promise.allSettled(trusted.map(i => getPeerOverview(db, i.id)));
          const settled = await Promise.race([fan, overall]);
          const peerOverviews = Array.isArray(settled)
            ? settled.map((s, i) => s.status === "fulfilled" ? s.value : {
                instanceId: trusted[i].id,
                status: "unavailable",
                reason: s.reason?.message || "rejected",
                tiles: [],
              })
            : trusted.map(i => ({
                instanceId: i.id,
                status: "unavailable",
                reason: "budget_exceeded",
                tiles: [],
              }));

          // Stash for the nest panel handler; reroute through the normal
          // panel dispatch so session/layout/header wiring is unchanged.
          req._crowNest = { trustedInstances: trusted, peerOverviews, unifiedOn: true };
          req.url = "/dashboard/nest";
          return next();
        }
      }

      // Fallback — pre-Phase-2 behavior.
      const visible = getVisiblePanels();
      if (visible.length > 0) {
        res.redirect(visible[0].route);
      } else {
        res.redirect("/dashboard/settings");
      }
    } catch (err) {
      console.warn("[dashboard] unified home wrapper failed, falling back:", err.message);
      const visible = getVisiblePanels();
      if (visible.length > 0) {
        res.redirect(visible[0].route);
      } else {
        res.redirect("/dashboard/settings");
      }
    } finally {
      db.close();
    }
  });

  // The Crow's Nest is the classic home. In new mode a bare landing on it (the
  // app's launch, a notification tap, an old bookmark, the PWA start_url)
  // answers 303 to the new home instead of rendering the classic grid inside
  // the shell. An explicit request still opens it: any query beyond
  // ?project= counts, and ?open=1 is the canonical form (see nestIsExplicit).
  // Classic mode, and the classic /dashboard wrapper's rewrite to this path,
  // pass straight through.
  router.get("/dashboard/nest", async (req, res, next) => {
    if (req._crowNest || nestIsExplicit(req.query)) return next();
    const db = createDbClient();
    try {
      if ((await resolveRequestMode(req, res, db)).mode !== "new") return next();
      const project = typeof req.query.project === "string" && req.query.project !== ""
        ? "?project=" + encodeURIComponent(req.query.project) : "";
      return res.redirect(303, "/dashboard/perch" + project);
    } catch (err) {
      console.warn("[dashboard] nest landing check failed, rendering the nest:", err.message);
      return next();
    } finally {
      db.close();
    }
  });

  // Panel routes: /dashboard/<panel>, and a project's home at
  // /dashboard/project/<slug> (the project-home panel; req.params.slug is the
  // project, read by resolveShellPage and the panel).
  router.all("/dashboard/project/:slug", (req, res, next) => dispatchPanel(req, res, next, "project-home"));
  // A project's Services page (project services): hidden, and a 404 like any unknown path, while
  // CROW_SERVICES_UI is off.
  router.all("/dashboard/project/:slug/services", (req, res, next) => (servicesUiEnabled() ? dispatchPanel(req, res, next, "project-services") : next()));
  // Version history pages (implementation plan Task 5): the nested paths
  // (/dashboard/history/jobs, /dashboard/history/trash and an item's
  // /dashboard/history/<type>/<id>) are registered before the single-segment
  // panel route, and dispatch to the hidden `history` panel so they get the
  // dashboard's normal chrome. Owner-only, GET and POST alike — the panel
  // checks (dashboard/index.js's `/dashboard/:panelId` never sees them).
  mountHistoryRoutes(router, (req, res, next) => dispatchPanel(req, res, next, "history"));
  router.all("/dashboard/:panelId", (req, res, next) => {
    const panelId = req.params.panelId;
    // Skip if it matches login/logout (already handled)
    if (panelId === "login" || panelId === "logout") return next();
    return dispatchPanel(req, res, next, panelId);
  });

  /** One panel page: nav, header, the shell-or-classic decision, then the panel's handler. */
  async function dispatchPanel(req, res, next, panelId) {
    const panel = getPanel(panelId);
    if (!panel) return next();

    const db = createDbClient();
    let lang = "en";
    try {
      const visiblePanels = getVisiblePanels();

      // Resolve nav groups for sidebar
      let navGroups;
      try {
        navGroups = await resolveNavGroups(db, visiblePanels);
      } catch (err) {
        console.warn("[dashboard] Nav groups resolution failed, using flat nav:", err.message);
      }

      // Get tamagotchi + language preferences.
      // These keys are not in the sync allowlist → writes fall to local-scope
      // dashboard_settings_overrides. Use readSetting so the layout sees the
      // per-instance value, not the stale global row.
      const [tamaVal, langVal] = await Promise.all([
        readSetting(db, "tamagotchi_enabled"),
        readSetting(db, "language"),
      ]);
      const tamaEnabled = tamaVal !== "false";
      lang = langVal || "en";

      // The header is one button, the bird: tap → tray, long-press → the
      // Talk to Crow voice overlay. The overlay is the Kiosk extension's
      // session display, so both the tray row and the long-press exist only
      // when the INSTALLED Kiosk panel declares it and its routes loaded.
      const talkAvailable = isCrowTalkAvailable(getPanel("kiosk"), getPanelRoutes().has("kiosk"));
      const activeHeaderJs = tamaEnabled ? tamagotchiJs(lang) : headerIconsJs(lang);

      // New shell or classic, per device; sets req.crowMode and req.crowScope.
      const shellOpts = await resolveShellPage(req, res, db, panelId, lang);

      // New shell (phone review 2026-10-29): the mascot (or bell) opens ONE
      // "Notifications and settings" sheet, which holds its tray; classic
      // keeps the dropdown tray in the header.
      const sheet = shellOpts.variant === "shell";
      const headerOpts = { talkAvailable, sheet };
      const activeHeaderHtml = tamaEnabled ? tamagotchiHtml(lang, headerOpts) : headerIconsHtml(lang, headerOpts);
      if (sheet) {
        const tray = tamaEnabled ? tamagotchiTrayHtml(lang, { talkAvailable }) : headerIconsTrayHtml(lang, { talkAvailable });
        shellOpts.shell = { ...shellOpts.shell, tray };
      }

      // For You's entry points (the drawer's card, the mascot sheet's link and, through the
      // drawer, the phone drag reveal's target) are the OWNER's alone: the page itself 404s for
      // every other session, so linking it would only offer dead ends. One check per page, and
      // only while the flag is on. The chrome takes it as `forYouOwner`; the card, sheet and
      // swipe all follow that one attribute.
      let forYouOwner = false;
      if (forYouEnabled()) {
        try { forYouOwner = await isLocalPasswordSessionOn(db, req); } catch (err) { forYouOwner = false; console.warn("[for-you] owner check failed:", err && err.message); }
      }

      const result = await panel.handler(req, res, {
        db,
        appRoot: resolve(import.meta.dirname, "../../.."),
        lang,
        // Bot Builder's "Use for voice…" binds through the Kiosk's own endpoints: offered only when it is there.
        kioskAvailable: talkAvailable,
        layout: (opts) => withForYouOwner(forYouOwner, () => renderPage({
          ...opts,
          ...shellOpts,
          activePanel: panelId,
          panels: visiblePanels,
          navGroups,
          lang,
          // The sidebar's logout form needs the viewer's CSRF token. It comes
          // from csrfMiddleware (above), which populates it on every request
          // that carries the crow_csrf cookie.
          csrf: req.csrfToken || "",
          headerIcons: activeHeaderHtml,
          afterContent: playerBarHtml(lang),
          scripts: (opts.scripts || "") + playerBarJs(lang) + activeHeaderJs,
        })),
      });

      // Handler may have already sent response
      if (!res.headersSent && result) {
        res.type("html").send(result);
      }
    } catch (err) {
      console.error(`[dashboard] Panel ${panelId} error:`, err);
      if (!res.headersSent) {
        res.status(500).type("html").send(renderLayout({
          title: "Error",
          content: `<div class="alert alert-error">Something went wrong: ${err.message}</div>`,
          activePanel: panelId,
          panels: getVisiblePanels(),
          lang,
        }));
      }
    } finally {
      db.close();
    }
  }

  return router;
}

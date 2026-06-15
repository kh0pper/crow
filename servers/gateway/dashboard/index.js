/**
 * Dashboard Routes — Route mounting, auth, panel dispatch
 */

import { Router } from "express";
import express from "express";
import { renderLayout, renderLogin, render2faVerify, render2faRecovery, render2faSetup, renderResetRequest, renderResetForm } from "./shared/layout.js";
import { playerBarHtml, playerBarJs } from "./shared/player.js";
import { headerIconsHtml, headerIconsJs, tamagotchiHtml, tamagotchiJs } from "./shared/notifications.js";
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
import { signTicket, verifyTicket, isSafeDestPath } from "../../shared/sso-ticket.js";
import { auditCrossHostCall } from "../../shared/cross-host-auth.js";
import { getOrCreateLocalInstanceId } from "../instance-registry.js";
import { SUPPORTED_LANGS } from "./shared/i18n.js";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { registerPanel, loadExternalPanels, getAllPanels, getVisiblePanels, getPanel } from "./panel-registry.js";
import { resolveNavGroups } from "./nav-registry.js";
import { readSetting, readSettings } from "./settings/registry.js";
import { csrfMiddleware } from "./shared/csrf.js";
import federationRouterFactory from "../routes/federation.js";
import federationCompanionRouterFactory from "../routes/federation-companion.js";
import federationResolveRouterFactory from "../routes/federation-resolve.js";
import { getTrustedInstances } from "./panels/nest/data-queries.js";
import { getPeerOverview } from "./overview-cache.js";
import { resolveCompanionTarget } from "./companion-target.js";
import { createDbClient } from "../../db.js";

// Import built-in panels
import messagesPanel from "./panels/messages.js";
import blogPanel from "./panels/blog.js";
import filesPanel from "./panels/files.js";
import healthPanel from "./panels/health.js";
import memoryPanel from "./panels/memory.js";
import extensionsPanel from "./panels/extensions.js";
import skillsPanel from "./panels/skills.js";
import projectsPanel from "./panels/projects.js";
import settingsPanel from "./panels/settings.js";
import contactsPanel from "./panels/contacts.js";
import botBuilderPanel from "./panels/bot-builder.js";
import botBoardPanel from "./panels/bot-board.js";
import designSystemPanel from "./panels/design-system.js";
import onboardingPanel from "./panels/onboarding.js";
import connectPanel from "./panels/connect.js";
import fediversePanel from "./panels/fediverse.js";
import { handleFixItAction } from "../fix-it/index.js";
import bundlesRouterFactory from "../routes/bundles.js";

/**
 * @param {Function|null} mcpAuthMiddleware - OAuth auth middleware (for unified auth)
 * @returns {Router}
 */
export default function dashboardRouter(mcpAuthMiddleware) {
  const router = Router();

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
  registerPanel(skillsPanel);
  registerPanel(settingsPanel);
  registerPanel(contactsPanel);
  registerPanel(botBuilderPanel);
  registerPanel(botBoardPanel);
  registerPanel(designSystemPanel);
  registerPanel(onboardingPanel);
  registerPanel(connectPanel);
  registerPanel(fediversePanel);

  // Load third-party panels (async, non-blocking)
  loadExternalPanels().catch((err) => {
    console.warn("[dashboard] Failed to load external panels:", err.message);
  });

  // --- Public routes (no auth) ---

  // Login page
  router.get("/dashboard/login", async (req, res) => {
    const cookies = parseCookies(req);
    const lang = SUPPORTED_LANGS.includes(cookies.crow_lang) ? cookies.crow_lang : "en";
    const hasPassword = await isPasswordSet();
    const setupToken = process.env.CROW_SETUP_TOKEN;
    if (!hasPassword && setupToken && req.query.token !== setupToken) {
      // Setup token required but not provided — show gated message
      return res.type("html").send(renderLogin({ isSetup: true, error: "Use the link you were sent to set up your password.", lang }));
    }
    res.type("html").send(renderLogin({ isSetup: !hasPassword, setupToken: !hasPassword ? setupToken : undefined, lang }));
  });

  // Login handler
  router.post("/dashboard/login", async (req, res) => {
    const cookies = parseCookies(req);
    const lang = SUPPORTED_LANGS.includes(cookies.crow_lang) ? cookies.crow_lang : "en";
    const { password, confirm } = req.body;
    const hasPassword = await isPasswordSet();
    const wasFirstSetup = !hasPassword; // capture before setPassword() runs below

    if (!hasPassword) {
      // First-time setup
      const strength = validatePasswordStrength(password);
      if (!strength.valid) {
        return res.type("html").send(renderLogin({ isSetup: true, error: strength.message, lang }));
      }
      if (password !== confirm) {
        return res.type("html").send(renderLogin({ isSetup: true, error: "Passwords don't match.", lang }));
      }
      // Setup token gating: if CROW_SETUP_TOKEN is set and no password exists, require it
      const setupToken = process.env.CROW_SETUP_TOKEN;
      if (setupToken && req.body.setup_token !== setupToken) {
        return res.type("html").send(renderLogin({ isSetup: true, error: "Invalid setup token. Use the link you were sent.", lang }));
      }
      await setPassword(password);
    }

    const deviceTrustToken = cookies.crow_2fa_trusted || null;
    const userAgent = req.headers["user-agent"] || null;
    const result = await attemptLogin(password, req.ip, deviceTrustToken, userAgent);
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
      return res.type("html").send(renderLogin({ isSetup: false, error: result.error, lockoutHelp, lang }));
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
    // password are never nagged).
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
    res.redirectAfterPost("/dashboard");
  });

  // 2FA verification (TOTP code entry after password)
  router.post("/dashboard/login/2fa", async (req, res) => {
    const cookies = parseCookies(req);
    const lang = SUPPORTED_LANGS.includes(cookies.crow_lang) ? cookies.crow_lang : "en";
    const pendingToken = cookies.crow_pending_2fa;

    // Read any SSO context bound to this pending token BEFORE it is consumed.
    const ssoCtx = (await getPending2faContext(pendingToken))?.sso || null;

    // Verify pending token
    const validPending = await verifyPending2faToken(pendingToken);
    if (!validPending) {
      return res.type("html").send(renderLogin({ error: t("login.2faSessionExpired", lang), lang }));
    }

    const { totp_code, trust_device } = req.body;
    const secret = await getTotpSecret();
    if (!secret || !verifyTotp(totp_code, secret)) {
      // Re-create pending token for retry, preserving any SSO context.
      const newToken = await createPending2faToken(ssoCtx ? { sso: ssoCtx } : null);
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
    const result = ssoSrc ? await mintSsoSession(ssoSrc) : await complete2faLogin(req.ip);
    const sessionMaxAge = ssoSrc ? SSO_SESSION_MAX_AGE : undefined;
    const redirectTo = (ssoSrc && ssoDest && isSafeDestPath(ssoDest)) ? ssoDest : "/dashboard";

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
    const cookies = parseCookies(req);
    const lang = SUPPORTED_LANGS.includes(cookies.crow_lang) ? cookies.crow_lang : "en";
    res.type("html").send(render2faRecovery({ lang }));
  });

  // 2FA recovery code verification
  router.post("/dashboard/login/2fa/recovery", async (req, res) => {
    const cookies = parseCookies(req);
    const lang = SUPPORTED_LANGS.includes(cookies.crow_lang) ? cookies.crow_lang : "en";
    const pendingToken = cookies.crow_pending_2fa;

    // Read SSO context bound to the pending token before it is consumed.
    const ssoCtx = (await getPending2faContext(pendingToken))?.sso || null;

    const validPending = await verifyPending2faToken(pendingToken);
    if (!validPending) {
      return res.type("html").send(renderLogin({ error: t("login.2faSessionExpired", lang), lang }));
    }

    const { recovery_code } = req.body;
    const valid = await verifyRecoveryCode(recovery_code);
    if (!valid) {
      // Re-create pending token for retry, preserving any SSO context.
      const newToken = await createPending2faToken(ssoCtx ? { sso: ssoCtx } : null);
      const secure = process.env.CROW_HOSTED || process.env.NODE_ENV === "production";
      const secureSuffix = secure ? "; Secure" : "";
      res.setHeader("Set-Cookie", `crow_pending_2fa=${newToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=300${secureSuffix}`);
      return res.type("html").send(render2faRecovery({ error: t("login.2faInvalidCode", lang), lang }));
    }

    // Same SSO-origin handling as the TOTP path: a recovery-code login that
    // came from cross-instance SSO gets a 24h SSO session + the SSO dest.
    const ssoSrc = ssoCtx?.src || null;
    const ssoDest = ssoCtx?.dest || null;
    const result = ssoSrc ? await mintSsoSession(ssoSrc) : await complete2faLogin(req.ip);
    const sessionMaxAge = ssoSrc ? SSO_SESSION_MAX_AGE : undefined;
    const redirectTo = (ssoSrc && ssoDest && isSafeDestPath(ssoDest)) ? ssoDest : "/dashboard";

    const cookieHeaders = [`crow_pending_2fa=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`];
    setSessionCookie(res, result.token, sessionMaxAge);
    const existing = res.getHeader("Set-Cookie") || [];
    res.setHeader("Set-Cookie", [...(Array.isArray(existing) ? existing : [existing]), ...cookieHeaders]);
    res.redirectAfterPost(redirectTo);
  });

  // 2FA setup page (mandatory for managed hosting, optional access for self-hosted via settings)
  router.get("/dashboard/login/2fa/setup", async (req, res) => {
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

  // Logout
  router.get("/dashboard/logout", async (req, res) => {
    const cookies = parseCookies(req);
    await destroySession(cookies.crow_session);
    clearSessionCookie(res);
    res.redirect("/dashboard/login");
  });

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
    const audit = (extra) => auditCrossHostCall(db, {
      sourceInstanceId: src || null,
      targetInstanceId: localId,
      direction: "inbound",
      action: "sso.accept",
      ...extra,
    });
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

      // Must be a paired peer (shared signing key) AND trusted locally.
      const creds = getPeerCreds(src);
      if (!creds || !creds.signing_key) {
        await audit({ hmacValid: false, error: "unknown_peer" });
        return res.status(401).type("text/plain").send("Unknown source instance.");
      }
      const { rows } = await db.execute({
        sql: "SELECT trusted, status FROM crow_instances WHERE id = ?",
        args: [src],
      });
      const peerRow = rows[0];
      if (!peerRow || Number(peerRow.trusted) !== 1 || peerRow.status === "revoked") {
        await audit({ hmacValid: false, error: "untrusted_peer" });
        return res.status(403).type("text/plain").send("Source instance is not trusted.");
      }

      const result = verifyTicket({ payloadB64, sig, signingKey: creds.signing_key, expectedDst: localId });
      if (!result.valid) {
        await audit({ hmacValid: false, error: result.reason });
        return res.status(401).type("text/plain").send("Invalid SSO ticket.");
      }
      // The signature already binds src (signed with that peer's key), but make
      // the claimed query src and the signed src agree so the audit row is accurate.
      if (result.ticket.src !== src) {
        await audit({ hmacValid: true, nonce: result.ticket.nonce, error: "src_mismatch" });
        return res.status(401).type("text/plain").send("Invalid SSO ticket.");
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

      const { token } = await mintSsoSession(src);
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
    // /dashboard/bot-federation/* → federationRouter (F4a Layer 3, parameterized paths)
    if (federationRouter && (req.path === "/overview" || req.path === "/capabilities" || req.path.startsWith("/bot-federation/"))) {
      return federationRouter(req, res, next);
    }
    // Everything else (bundles) → bundlesRouter (existing behavior)
    return bundlesRouter(req, res, next);
  });

  // Auth middleware for all other dashboard routes
  router.use("/dashboard", dashboardAuth);

  // CSRF double-submit validation for state-changing requests.
  // Skips: GET/HEAD/OPTIONS, HMAC-signed peer calls (handled above),
  // pre-auth flows (no session cookie yet), and CROW_CSRF_STRICT=0 rollback.
  router.use("/dashboard", csrfMiddleware);

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

  // SSO launch — authenticated on THIS instance (after dashboardAuth). Mints a
  // signed ticket for a paired+trusted target and 302s the browser to the
  // target's /dashboard/sso/accept. Falls back to a direct link (which will
  // prompt for the target's password) when SSO isn't possible.
  router.get("/dashboard/sso/launch", async (req, res) => {
    const db = createDbClient();
    try {
      const target = String(req.query.target || "");
      let dest = String(req.query.to || "/dashboard/nest");
      if (!isSafeDestPath(dest)) dest = "/dashboard/nest";
      if (!target) return res.status(400).type("text/plain").send("Missing target.");

      const { rows } = await db.execute({
        sql: "SELECT id, gateway_url, trusted, status FROM crow_instances WHERE id = ?",
        args: [target],
      });
      const row = rows[0];
      const base = row?.gateway_url ? String(row.gateway_url).replace(/\/+$/, "") : null;
      const ssoOn = (await readSetting(db, "sso_enabled")) === "true";
      const eligible = ssoOn && row && Number(row.trusted) === 1 && row.status !== "revoked" && base;
      const creds = eligible ? getPeerCreds(target) : null;

      if (!eligible || !creds || !creds.signing_key) {
        // Not SSO-eligible — fall back to a direct link (prompts for password)
        // if we at least have a gateway URL; otherwise back to the local nest.
        if (base) return res.redirect(302, `${base}${dest}`);
        return res.redirect(302, "/dashboard/nest");
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

  // Panel routes
  router.all("/dashboard/:panelId", async (req, res, next) => {
    const panelId = req.params.panelId;

    // Skip if it matches login/logout (already handled)
    if (panelId === "login" || panelId === "logout") return next();

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

      // Get theme + tamagotchi + language preferences.
      // These keys are not in the sync allowlist → writes fall to local-scope
      // dashboard_settings_overrides. Use readSetting/readSettings so the
      // layout sees the per-instance value, not the stale global row.
      const [tamaVal, langVal, themeMap] = await Promise.all([
        readSetting(db, "tamagotchi_enabled"),
        readSetting(db, "language"),
        readSettings(db, "blog_theme_%"),
      ]);
      const ts = {};
      for (const [k, v] of themeMap) ts[k.replace("blog_", "")] = v;
      const globalMode = ts.theme_mode || "dark";
      const effectiveDashMode = ts.theme_dashboard_mode || globalMode;
      const theme = effectiveDashMode;
      const glass = ts.theme_glass === "true";
      const serif = ts.theme_serif !== "false";
      const tamaEnabled = tamaVal !== "false";
      lang = langVal || "en";

      // Companion target resolution — checks LOCAL first (bundle installed
      // + docker up), falls back to any TRUSTED PEER whose cached overview
      // includes a companion tile. If any path succeeds, the header icon
      // renders and clicking it launches the companion iframe at whichever
      // host the resolver picked. This lets a kiosk running on grackle
      // open the companion hosted on crow (or vice versa) without the
      // user having to know where it lives.
      const companionTarget = await resolveCompanionTarget({ db, origin: req.headers.host });
      const companionAvailable = companionTarget.available;
      const headerOpts = { companionAvailable };
      const activeHeaderHtml = tamaEnabled ? tamagotchiHtml(lang, headerOpts) : headerIconsHtml(lang, headerOpts);
      const activeHeaderJs = tamaEnabled ? tamagotchiJs(lang) : headerIconsJs(lang);

      // Expose the resolved URL to the kiosk-toggle inline JS. The layout
      // reads window.__crowCompanionUrl; if the host isn't "local" we also
      // pass the host name for aria/title text. Stringified safely — URL
      // is already constructed server-side from validated gateway_url.
      const companionConfigJs = `<script>
        window.__crowCompanionUrl = ${JSON.stringify(companionTarget.url || "")};
        window.__crowCompanionHost = ${JSON.stringify(companionTarget.host || "")};
        window.__crowCompanionHostName = ${JSON.stringify(companionTarget.name || "")};
      </script>`;

      // Auto-restore kiosk mode if it was active
      let kioskAutoStart = "";
      if (companionAvailable) {
        if ((await readSetting(db, "kiosk_mode")) === "true") {
          kioskAutoStart = "if (typeof toggleKioskMode === 'function') toggleKioskMode();";
        }
      }

      const result = await panel.handler(req, res, {
        db,
        appRoot: resolve(import.meta.dirname, "../../.."),
        lang,
        layout: (opts) => renderLayout({
          ...opts,
          activePanel: panelId,
          panels: visiblePanels,
          navGroups,
          theme,
          glass,
          serif,
          lang,
          headerIcons: activeHeaderHtml,
          // companionConfigJs sets window.__crowCompanionUrl before any
          // kiosk-button click can fire. Placing it in afterContent puts
          // it inside <body>, ensuring globals are set even for a user
          // who clicks before the layout's inline scripts run.
          afterContent: companionConfigJs + playerBarHtml(lang),
          scripts: (opts.scripts || "") + playerBarJs(lang) + activeHeaderJs + kioskAutoStart,
        }),
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
          theme: "dark",
          lang,
        }));
      }
    } finally {
      db.close();
    }
  });

  return router;
}

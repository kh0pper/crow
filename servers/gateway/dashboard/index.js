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
} from "./auth.js";
import {
  is2faEnabled,
  needs2faSetup,
  verifyTotp,
  verifyRecoveryCode,
  verifyPending2faToken,
  getTotpSecret,
  generateTotpSecret,
  generateQrDataUri,
  generateRecoveryCodes,
  saveTotpSetup,
  enable2fa,
  createDeviceTrust,
  DEVICE_TRUST_TTL,
} from "./totp.js";
import { SUPPORTED_LANGS } from "./shared/i18n.js";
import { resolve } from "node:path";
import { registerPanel, loadExternalPanels, getAllPanels, getVisiblePanels, getPanel } from "./panel-registry.js";
import { resolveNavGroups } from "./nav-registry.js";
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
      return res.redirect("/dashboard/login/2fa/setup");
    }

    setSessionCookie(res, result.token);
    res.redirect("/dashboard");
  });

  // 2FA verification (TOTP code entry after password)
  router.post("/dashboard/login/2fa", async (req, res) => {
    const cookies = parseCookies(req);
    const lang = SUPPORTED_LANGS.includes(cookies.crow_lang) ? cookies.crow_lang : "en";
    const pendingToken = cookies.crow_pending_2fa;

    // Verify pending token
    const validPending = await verifyPending2faToken(pendingToken);
    if (!validPending) {
      return res.type("html").send(renderLogin({ error: t("login.2faSessionExpired", lang), lang }));
    }

    const { totp_code, trust_device } = req.body;
    const secret = await getTotpSecret();
    if (!secret || !verifyTotp(totp_code, secret)) {
      // Re-create pending token for retry
      const { createPending2faToken } = await import("./totp.js");
      const newToken = await createPending2faToken();
      const secure = process.env.CROW_HOSTED || process.env.NODE_ENV === "production";
      const secureSuffix = secure ? "; Secure" : "";
      res.setHeader("Set-Cookie", `crow_pending_2fa=${newToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=300${secureSuffix}`);
      return res.type("html").send(render2faVerify({ error: t("login.2faInvalidCode", lang), lang }));
    }

    // 2FA verified — issue session
    const result = await complete2faLogin(req.ip);

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

    setSessionCookie(res, result.token);
    // Append our extra cookies
    const existing = res.getHeader("Set-Cookie") || [];
    res.setHeader("Set-Cookie", [...(Array.isArray(existing) ? existing : [existing]), ...cookieHeaders]);
    res.redirect("/dashboard");
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

    const validPending = await verifyPending2faToken(pendingToken);
    if (!validPending) {
      return res.type("html").send(renderLogin({ error: t("login.2faSessionExpired", lang), lang }));
    }

    const { recovery_code } = req.body;
    const valid = await verifyRecoveryCode(recovery_code);
    if (!valid) {
      // Re-create pending token for retry
      const { createPending2faToken } = await import("./totp.js");
      const newToken = await createPending2faToken();
      const secure = process.env.CROW_HOSTED || process.env.NODE_ENV === "production";
      const secureSuffix = secure ? "; Secure" : "";
      res.setHeader("Set-Cookie", `crow_pending_2fa=${newToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=300${secureSuffix}`);
      return res.type("html").send(render2faRecovery({ error: t("login.2faInvalidCode", lang), lang }));
    }

    const result = await complete2faLogin(req.ip);
    res.setHeader("Set-Cookie", `crow_pending_2fa=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    setSessionCookie(res, result.token);
    const existing = res.getHeader("Set-Cookie") || [];
    res.setHeader("Set-Cookie", Array.isArray(existing) ? existing : [existing]);
    res.redirect("/dashboard");
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
      return res.redirect("/dashboard/login/2fa/setup");
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
    res.redirect("/dashboard");
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

  // --- Protected routes ---

  // Auth middleware for all other dashboard routes
  router.use("/dashboard", dashboardAuth);

  // Mount bundles API (protected by dashboard auth above)
  router.use("/dashboard", bundlesRouterFactory());

  // Dashboard home — redirect to first visible panel
  router.get("/dashboard", (req, res) => {
    const visible = getVisiblePanels();
    if (visible.length > 0) {
      res.redirect(visible[0].route);
    } else {
      res.redirect("/dashboard/settings");
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

      // Get theme + tamagotchi + language preferences
      const [themeResult, tamaResult, langResult, themeSettingsResult] = await Promise.all([
        db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'dashboard_theme'", args: [] }),
        db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'tamagotchi_enabled'", args: [] }),
        db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'language'", args: [] }),
        db.execute({ sql: "SELECT key, value FROM dashboard_settings WHERE key IN ('blog_theme_mode', 'blog_theme_glass', 'blog_theme_serif', 'blog_theme_dashboard_mode')", args: [] }),
      ]);
      // Build unified theme settings
      const ts = {};
      for (const r of themeSettingsResult.rows) ts[r.key.replace("blog_", "")] = r.value;
      const globalMode = ts.theme_mode || "dark";
      const effectiveDashMode = ts.theme_dashboard_mode || globalMode;
      const theme = effectiveDashMode;
      const glass = ts.theme_glass === "true";
      const serif = ts.theme_serif !== "false";
      // Missing key = true (tamagotchi on by default)
      const tamaEnabled = tamaResult.rows[0]?.value !== "false";
      lang = langResult.rows[0]?.value || "en";

      const activeHeaderHtml = tamaEnabled ? tamagotchiHtml(lang) : headerIconsHtml(lang);
      const activeHeaderJs = tamaEnabled ? tamagotchiJs(lang) : headerIconsJs(lang);

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
          afterContent: playerBarHtml(lang),
          scripts: (opts.scripts || "") + playerBarJs(lang) + activeHeaderJs,
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

/**
 * Dashboard Routes — Route mounting, auth, panel dispatch
 */

import { Router } from "express";
import express from "express";
import { renderLayout, renderLogin } from "./shared/layout.js";
import { playerBarHtml, playerBarJs } from "./shared/player.js";
import { headerIconsHtml, headerIconsJs, tamagotchiHtml, tamagotchiJs } from "./shared/notifications.js";
import {
  dashboardAuth,
  isPasswordSet,
  setPassword,
  attemptLogin,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  parseCookies,
  validatePasswordStrength,
} from "./auth.js";
import { SUPPORTED_LANGS } from "./shared/i18n.js";
import { resolve } from "node:path";
import { registerPanel, loadExternalPanels, getAllPanels, getVisiblePanels, getPanel } from "./panel-registry.js";
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

    const result = await attemptLogin(password, req.ip);
    if (result.error) {
      return res.type("html").send(renderLogin({ isSetup: false, error: result.error, lang }));
    }

    setSessionCookie(res, result.token);
    res.redirect("/dashboard");
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

  // Contacts redirect — absorbed into Messages panel
  router.get("/dashboard/contacts", (req, res) => {
    res.redirect("/dashboard/messages");
  });

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

/**
 * Dashboard Routes — Route mounting, auth, panel dispatch
 */

import { Router } from "express";
import express from "express";
import { renderLayout, renderLogin } from "./shared/layout.js";
import {
  dashboardAuth,
  isPasswordSet,
  setPassword,
  attemptLogin,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  parseCookies,
} from "./auth.js";
import { resolve } from "node:path";
import { registerPanel, loadExternalPanels, getAllPanels, getPanel } from "./panel-registry.js";
import { createDbClient } from "../../db.js";

// Import built-in panels
import messagesPanel from "./panels/messages.js";
import blogPanel from "./panels/blog.js";
import filesPanel from "./panels/files.js";
import healthPanel from "./panels/health.js";
import memoryPanel from "./panels/memory.js";
import extensionsPanel from "./panels/extensions.js";
import skillsPanel from "./panels/skills.js";
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
    const hasPassword = await isPasswordSet();
    res.type("html").send(renderLogin({ isSetup: !hasPassword }));
  });

  // Login handler
  router.post("/dashboard/login", async (req, res) => {
    const { password, confirm } = req.body;
    const hasPassword = await isPasswordSet();

    if (!hasPassword) {
      // First-time setup
      if (!password || password.length < 6) {
        return res.type("html").send(renderLogin({ isSetup: true, error: "Password must be at least 6 characters." }));
      }
      if (password !== confirm) {
        return res.type("html").send(renderLogin({ isSetup: true, error: "Passwords don't match." }));
      }
      await setPassword(password);
    }

    const result = await attemptLogin(password, req.ip);
    if (result.error) {
      return res.type("html").send(renderLogin({ isSetup: false, error: result.error }));
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

  // Dashboard home — redirect to first panel
  router.get("/dashboard", (req, res) => {
    const panels = getAllPanels();
    if (panels.length > 0) {
      res.redirect(panels[0].route);
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
    try {
      const allPanels = getAllPanels();

      // Get theme preference
      const themeResult = await db.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = 'dashboard_theme'",
        args: [],
      });
      const theme = themeResult.rows[0]?.value || "dark";

      const result = await panel.handler(req, res, {
        db,
        appRoot: resolve(import.meta.dirname, "../../.."),
        layout: (opts) => renderLayout({
          ...opts,
          activePanel: panelId,
          panels: allPanels,
          theme,
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
          panels: getAllPanels(),
          theme: "dark",
        }));
      }
    } finally {
      db.close();
    }
  });

  return router;
}

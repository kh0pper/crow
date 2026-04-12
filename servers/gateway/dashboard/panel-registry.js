/**
 * Panel Registry — Discovers and manages dashboard panels
 *
 * Built-in panels live in ./panels/. Third-party panels in ~/.crow/panels/
 * with explicit opt-in via ~/.crow/panels.json.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/** @type {Map<string, object>} */
const panels = new Map();

/** @type {Map<string, Function>} Panel routes: id → (authMiddleware) => Router */
const panelRoutes = new Map();

/** @type {Map<string, Function>} Panel WS setup hooks: id → (httpServer) => any */
const panelWebSocketSetups = new Map();

/**
 * Register a built-in panel.
 * @param {object} manifest - { id, name, icon, route, navOrder, handler }
 */
export function registerPanel(manifest) {
  panels.set(manifest.id, manifest);
}

/**
 * Load third-party panels from ~/.crow/panels/ (if enabled in panels.json).
 */
export async function loadExternalPanels() {
  const crowDir = join(homedir(), ".crow");
  const panelsDir = join(crowDir, "panels");
  const configPath = join(crowDir, "panels.json");

  if (!existsSync(configPath)) return;

  let enabledIds;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    enabledIds = Array.isArray(config) ? config : config.enabled || [];
  } catch {
    return;
  }

  for (const id of enabledIds) {
    const panelPath = join(panelsDir, `${id}.js`);
    if (!existsSync(panelPath)) continue;

    try {
      const mod = await import(panelPath);
      const manifest = mod.default || mod.manifest;
      if (manifest && manifest.id && manifest.handler) {
        panels.set(manifest.id, manifest);
      }
    } catch (err) {
      console.warn(`[dashboard] Failed to load panel ${id}:`, err.message);
    }

    // Check for companion routes file ({id}-routes.js)
    const routesPath = join(panelsDir, `${id}-routes.js`);
    if (existsSync(routesPath)) {
      try {
        const routesMod = await import(routesPath);
        const routerFn = routesMod.default || routesMod.createRouter;
        if (typeof routerFn === "function") {
          panelRoutes.set(id, routerFn);
        }
        // Panels may also expose a `setupWebSocket(httpServer)` named export.
        // We collect it here; index.js invokes it once the HTTP server is up.
        if (typeof routesMod.setupWebSocket === "function") {
          panelWebSocketSetups.set(id, routesMod.setupWebSocket);
        }
      } catch (err) {
        console.warn(`[dashboard] Failed to load panel routes ${id}:`, err.message);
      }
    }
  }
}

/**
 * Get all registered panels sorted by navOrder.
 */
export function getAllPanels() {
  return [...panels.values()].sort((a, b) => (a.navOrder || 0) - (b.navOrder || 0));
}

/**
 * Get visible panels (excludes hidden panels) sorted by navOrder.
 * Used for sidebar nav and dashboard home redirect.
 */
export function getVisiblePanels() {
  return [...panels.values()]
    .filter((p) => !p.hidden)
    .sort((a, b) => (a.navOrder || 0) - (b.navOrder || 0));
}

/**
 * Get a panel by ID.
 */
export function getPanel(id) {
  return panels.get(id);
}

/**
 * Get all registered panel routes.
 * @returns {Map<string, Function>} id → (authMiddleware) => Router
 */
export function getPanelRoutes() {
  return panelRoutes;
}

/**
 * Get all registered panel WebSocket setup hooks.
 * Each hook is called once with the HTTP server instance during gateway
 * startup, after `app.listen()`.
 * @returns {Map<string, Function>} id → (httpServer) => any
 */
export function getPanelWebSocketSetups() {
  return panelWebSocketSetups;
}

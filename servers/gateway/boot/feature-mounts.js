/**
 * boot/feature-mounts.js — feature route mounts (admin backup, storage, blog, wm,
 * media public, knowledge-base public, tea-maps public, AI chat, peer messages,
 * notifications, turbo streams, bot-board api, fileview, push, settings scope,
 * stt-debug).
 *
 * C3: import.meta.dirname re-anchored for code living one level deeper in boot/.
 * All per-block try/catch constructs are verbatim.
 * deps: { authMiddleware, dashboardAuth, peerExposureGate, sessionManager, instructions, PORT }
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mountMcpServer } from "../routes/mcp.js";
import { createDbClient } from "../../db.js";

// Re-anchored gateway dir for repo-fallback bundle paths (C3)
const __gatewayDir = dirname(fileURLToPath(import.meta.url));
// boot/ is one level deeper than gateway/, so go up one extra level
const __featureGatewayDir = dirname(__gatewayDir); // → servers/gateway/

export async function mountFeatureRoutes(app, deps) {
  const { authMiddleware, dashboardAuth, peerExposureGate, sessionManager, instructions, PORT } = deps;

  // --- Mount Admin Backup Endpoint ---
  // In-process SQLite backup (localhost-only). Replaces the external sqlite3
  // .backup cron we removed on 2026-04-22 because that process's close was
  // unlinking -wal/-shm and orphaning the gateway's FDs under WAL mode.
  try {
    const { default: adminBackupRouter } = await import("../routes/admin-backup.js");
    app.use(adminBackupRouter());
    console.log("Admin backup endpoint mounted at POST /api/admin/backup");
  } catch (err) {
    console.warn("[admin-backup] Failed to mount:", err.message);
  }

  // --- Mount Storage Server (conditional) ---
  try {
    const { createStorageServer } = await import("../../storage/server.js");
    mountMcpServer(app, "/storage", () => createStorageServer(undefined, { instructions }), sessionManager, authMiddleware, peerExposureGate);

    // Storage HTTP routes (upload/download)
    const { default: storageHttpRouter } = await import("../routes/storage-http.js");
    app.use(storageHttpRouter(authMiddleware));

    console.log("Storage server mounted");
  } catch (err) {
    // Storage server not available (missing deps or not configured)
    if (err.code !== "ERR_MODULE_NOT_FOUND") {
      console.warn("[storage] Failed to mount:", err.message);
    }
  }

  // --- Mount Blog Server ---
  try {
    const { createBlogServer } = await import("../../blog/server.js");
    mountMcpServer(app, "/blog-mcp", () => createBlogServer(undefined, { instructions }), sessionManager, authMiddleware, peerExposureGate);

    // Songbook routes (must mount before blog's /:slug catch-all)
    const { default: songbookRouter } = await import("../routes/songbook.js");
    app.use(songbookRouter());

    // Blog embed API (public, read-only, hydrates case-study figures).
    // MUST mount BEFORE blogPublicRouter — /blog/api/* and /blog/figures/*
    // would otherwise collide with blog-public.js's /blog/:slug catch-all.
    // blog-public.js also has a defensive slug guard for this.
    try {
      const { blogEmbedApiRouter } = await import("../routes/blog-embed-api.js");
      app.use(blogEmbedApiRouter());
      console.log("Blog embed API mounted at /blog/api/* and /blog/figures/*");
    } catch (embedErr) {
      console.warn("[blog-embed-api] Failed to mount:", embedErr.message);
    }

    // Public blog routes (no auth)
    const { default: blogPublicRouter } = await import("../routes/blog-public.js");
    app.use(blogPublicRouter());

    console.log("Blog server mounted");
  } catch (err) {
    if (err.code !== "ERR_MODULE_NOT_FOUND") {
      console.warn("[blog] Failed to mount:", err.message);
    }
  }

  // --- Mount Window Manager Server ---
  // Same auth chain as every other MCP mount (W5 hardening — this was the one
  // null-auth mount): local MCP token (the companion's mcp-proxy already sends
  // it), OAuth bearer, or a paired instance gated default-deny by the peer
  // exposure gate. crow_wm is not view-only — it can spawn the pet process and
  // send P2P invites/memos/reactions — so it must not be reachable bare.
  try {
    const { createWmServer } = await import("../../wm/server.js");
    mountMcpServer(app, "/wm", () => createWmServer(undefined, { instructions }), sessionManager, authMiddleware, peerExposureGate);
    console.log("Window Manager server mounted");
  } catch (err) {
    if (err.code !== "ERR_MODULE_NOT_FOUND") {
      console.warn("[wm] Failed to mount:", err.message);
    }
  }

  // Media is now a bundle add-on (bundles/media/). Install via Extensions panel or: crow bundle install media
  // Mount public media routes (playlists) — no auth required
  try {
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const { homedir } = await import("node:os");
    const installed = join(homedir(), ".crow", "bundles", "media", "panel", "routes.js");
    // C3: re-anchored — boot/ is one level deeper, need ../../bundles
    const repo = join(__featureGatewayDir, "../../bundles/media/panel/routes.js");
    const routesPath = existsSync(installed) ? installed : repo;
    if (existsSync(routesPath)) {
      const { mediaPublicRouter } = await import(pathToFileURL(routesPath).href);
      if (mediaPublicRouter) {
        app.use(mediaPublicRouter());
        console.log("Media public routes mounted at /media/playlists/*");
      }
    }
  } catch (err) {
    // Media bundle not installed — skip silently
  }

  // Mount Knowledge Base public routes (no auth required)
  try {
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const { homedir } = await import("node:os");
    const installed = join(homedir(), ".crow", "bundles", "knowledge-base", "routes", "kb-public.js");
    // C3: re-anchored — boot/ is one level deeper, need ../../bundles
    const repo = join(__featureGatewayDir, "../../bundles/knowledge-base/routes/kb-public.js");
    const routesPath = existsSync(installed) ? installed : repo;
    if (existsSync(routesPath)) {
      const { default: kbPublicRouter } = await import(pathToFileURL(routesPath).href);
      if (kbPublicRouter) {
        app.use(kbPublicRouter());
        console.log("Knowledge Base public routes mounted at /kb/*");

        // Start LAN discovery (mDNS) for KB collections with lan_enabled = 1.
        // The stdio bundle entrypoint (server/index.js) calls initKbTables on
        // startup, but the in-process LAN-discovery path bypasses that entry,
        // so on a gateway whose crow.db has never hosted the KB bundle (MPA,
        // finance) the kb_collections table is absent and startLanDiscovery
        // logs SQLITE_ERROR.
        //
        // Initialize the tables ONLY if kb_collections is missing — running
        // initKbTables unconditionally on a DB that already has the tables
        // can trip on partial-init states (e.g. FTS5 shadow tables present
        // but the main virtual table gone) that are cosmetic on their own
        // but can cascade into downstream "database disk image is malformed"
        // errors during peer/instance-sync handling. Primary's crow.db has
        // these partials; MPA and finance are fresh and need real init.
        try {
          const lanPath = routesPath.replace(/routes[/\\]kb-public\.js$/, "server/lan-discovery.js");
          const dbPath = routesPath.replace(/routes[/\\]kb-public\.js$/, "server/db.js");
          const initPath = routesPath.replace(/routes[/\\]kb-public\.js$/, "server/init-tables.js");
          if (existsSync(lanPath) && existsSync(dbPath)) {
            const { createDbClient: createKbDb } = await import(pathToFileURL(dbPath).href);
            if (existsSync(initPath)) {
              const kbDb = createKbDb();
              try {
                const { rows } = await kbDb.execute({
                  sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='kb_collections' LIMIT 1",
                  args: [],
                });
                if (rows.length === 0) {
                  const { initKbTables } = await import(pathToFileURL(initPath).href);
                  await initKbTables(kbDb);
                }
              } catch (initErr) {
                console.warn("[knowledge-base] table init skipped:", initErr.message);
              }
            }
            const { startLanDiscovery } = await import(pathToFileURL(lanPath).href);
            await startLanDiscovery(createKbDb(), PORT);
          }
        } catch (lanErr) {
          console.warn("[knowledge-base] LAN discovery not started:", lanErr.message);
        }
      }
    }
  } catch (err) {
    // Knowledge Base bundle not installed — skip silently
    if (err.code !== "ERR_MODULE_NOT_FOUND") {
      console.warn("[knowledge-base] Failed to mount public routes:", err.message);
    }
  }

  // Mount tea-maps public routes (capstone choropleth bundle; no auth required)
  try {
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const { homedir } = await import("node:os");
    const installed = join(homedir(), ".crow", "bundles", "tea-maps", "routes", "tea-maps-public.js");
    // C3: re-anchored — boot/ is one level deeper, need ../../bundles
    const repo = join(__featureGatewayDir, "../../bundles/tea-maps/routes/tea-maps-public.js");
    const routesPath = existsSync(installed) ? installed : repo;
    if (existsSync(routesPath)) {
      const { teaMapsRouter } = await import(pathToFileURL(routesPath).href);
      if (teaMapsRouter) {
        app.use(teaMapsRouter(createDbClient));
        console.log("tea-maps public routes mounted at /bundles/tea-maps/*");
      }
    }
  } catch (err) {
    if (err.code !== "ERR_MODULE_NOT_FOUND") {
      console.warn("[tea-maps] Failed to mount public routes:", err.message);
    }
  }

  // --- Mount AI Chat Routes ---
  try {
    const { default: chatRouter } = await import("../routes/chat.js");
    app.use(chatRouter(dashboardAuth));
    console.log("AI Chat routes mounted at /api/chat");
  } catch (err) {
    console.warn("[chat] Failed to mount:", err.message);
  }

  // --- Mount Peer Messages API ---
  try {
    const { default: peerMessagesRouter } = await import("../routes/peer-messages.js");
    app.use(peerMessagesRouter(dashboardAuth));
    console.log("Peer Messages API mounted at /api/messages");
  } catch (err) {
    console.warn("[peer-messages] Failed to mount:", err.message);
  }


  // --- Mount Notifications API ---
  try {
    const { default: notificationsRouter } = await import("../routes/notifications.js");
    app.use(notificationsRouter(dashboardAuth));
    console.log("Notifications API mounted at /api/notifications");
  } catch (err) {
    console.warn("[notifications] Failed to mount:", err.message);
  }

  // --- Mount Turbo Streams (server-pushed HTML fragments) ---
  // Private routes under /dashboard/streams/*; the Funnel-reject
  // middleware above blocks public access. See routes/streams.js for the
  // per-route invariants.
  try {
    const { default: streamsRouter } = await import("../routes/streams.js");
    app.use(streamsRouter(dashboardAuth));
    console.log("Turbo Streams mounted at /dashboard/streams");
  } catch (err) {
    console.warn("[streams] Failed to mount:", err.message);
  }

  // Crow Bot Builder Phase 4 — board mutation API. Mounted EXACTLY as
  // streamsRouter above (dynamic import + app.use(...(dashboardAuth))),
  // adjacent to it, so it inherits the global rejectFunneledMiddleware()
  // and the router's own first-line dashboardAuth gate on its prefix.
  try {
    const { default: botBoardApiRouter } = await import("../routes/bot-board-api.js");
    app.use(botBoardApiRouter(dashboardAuth));
    console.log("Bot Board API mounted at /dashboard/bot-board-api");
  } catch (err) {
    console.warn("[bot-board-api] Failed to mount:", err.message);
  }

  // Markdown file viewer — read-only, auth-gated, tailnet-only. Under /dashboard/
  // so rejectFunneledMiddleware() blocks Funnel; renders allowlisted local .md
  // files (default root /home/kh0pp) as sanitized HTML. NOT in PUBLIC_FUNNEL_PREFIXES.
  try {
    const { default: fileviewRouter } = await import("../routes/fileview.js");
    app.use(fileviewRouter(dashboardAuth));
    console.log("Markdown file viewer mounted at /dashboard/fileview");
  } catch (err) {
    console.warn("[fileview] Failed to mount:", err.message);
  }

  // --- Mount Push Subscription API ---
  try {
    const { default: pushRouter } = await import("../routes/push.js");
    app.use(pushRouter(dashboardAuth));
    console.log("Push API mounted at /api/push");
  } catch (err) {
    console.warn("[push] Failed to mount:", err.message);
  }

  // --- Mount Settings Scope API (global vs per-instance override) ---
  try {
    const { default: settingsScopeRouter } = await import("../routes/settings-scope.js");
    app.use(settingsScopeRouter(dashboardAuth));
    console.log("Settings Scope API mounted at /api/settings/scope");
  } catch (err) {
    console.warn("[settings-scope] Failed to mount:", err.message);
  }

  // --- Mount STT Debug endpoint (smoke test for STT profiles) ---
  try {
    const { default: sttDebugRouter } = await import("../routes/stt-debug.js");
    app.use(sttDebugRouter(dashboardAuth));
    console.log("STT debug API mounted at /api/stt/debug");
  } catch (err) {
    console.warn("[stt-debug] Failed to mount:", err.message);
  }
}

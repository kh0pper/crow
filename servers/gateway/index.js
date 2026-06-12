#!/usr/bin/env node

/**
 * Crow Gateway — Streamable HTTP + SSE Server
 *
 * Exposes crow-memory, crow-projects, crow-sharing, crow-storage, and crow-blog
 * as HTTP endpoints for remote access. Supports both Streamable HTTP (2025-03-26)
 * and legacy SSE (2024-11-05) transports for maximum platform compatibility.
 * OAuth 2.1 with Dynamic Client Registration.
 *
 * Routes:
 *   POST|GET|DELETE /{server}/mcp  — Streamable HTTP (memory, projects, sharing, storage, blog, tools)
 *   POST|GET|DELETE /router/mcp   — Consolidated router (category tools instead of the full raw tool surface; major context reduction)
 *   GET  /{server}/sse             — SSE transport init
 *   POST /{server}/messages        — SSE message handling
 *   POST /storage/upload           — Multipart file upload
 *   GET  /storage/file/:key        — File download (presigned redirect)
 *   GET  /blog                     — Public blog index
 *   GET  /blog/:slug               — Public blog post
 *   GET  /blog/feed.xml            — RSS 2.0 feed
 *   GET  /blog/feed.atom           — Atom feed
 *   GET  /dashboard/*              — Crow's Nest UI
 *   POST /dashboard/bundles/api/*  — Bundle lifecycle API (install, uninstall, start, stop)
 *   GET  /discover/profile          — Contact discovery (opt-in public profile)
 *   POST /relay/store              — Peer relay store-and-forward
 *   GET  /relay/fetch              — Peer relay fetch pending blobs
 *   GET  /crow.md                  — Cross-platform behavioral context
 *   GET  /health                   — Health check
 *   GET  /setup                    — Integration status page
 *   OAuth routes (/.well-known/*, /authorize, /token, /register)
 */

// Load .env file if present (for systemd and other environments without dotenv)
import { readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath, dirname as dirnamePath } from "node:path";
import { fileURLToPath } from "node:url";

const __gatewayDir = dirnamePath(fileURLToPath(import.meta.url));
const __appRoot = resolvePath(__gatewayDir, "../..");
const envPath = resolvePath(__appRoot, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !(match[1] in process.env)) {
      // Only set if not already in environment (env vars take precedence over .env)
      process.env[match[1]] = match[2];
    }
  }
}

import { mcpAuthRouter, createOAuthMetadata } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { mcpAuthMetadataRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import express from "express";
import rateLimit from "express-rate-limit";
import cors from "cors";
import { crowdsecMiddleware } from "./middleware/crowdsec.js";
import { rejectFunneledMiddleware } from "./funnel.js";

import { validateRoomToken } from "../sharing/server.js";
import { createDbClient } from "../db.js";
import { createOAuthProvider, initOAuthTables } from "./auth.js";
import { loadDynamicBackends } from "./proxy.js";
import { dashboardAuth } from "./dashboard/auth.js";
import { SessionManager } from "./session-manager.js";
import { generateInstructions } from "../shared/instructions.js";
// startAutoUpdate/startScheduler/connectedServers/initProxyServers/loadRemoteInstances
// are imported directly by boot/post-listen.js (not needed here).
import { initWebPush } from "./push/web-push.js";
import { join } from "node:path";
import { mountPublicEndpoints, crowMdHandler } from "./boot/public-endpoints.js";
import { mountMcpServers } from "./boot/mcp-mounts.js";
import { mountFeatureRoutes } from "./boot/feature-mounts.js";
import { mountAdminApi } from "./boot/admin-api.js";
import { mountPeerPublicApi } from "./boot/peer-public-api.js";
import { mountLateRoutes } from "./boot/late-mounts.js";
import { runPostListenSetup } from "./boot/post-listen.js";

const PORT = parseInt(process.env.PORT || process.env.CROW_GATEWAY_PORT || "3001", 10);
const BIND = process.env.CROW_GATEWAY_BIND || "0.0.0.0";
const noAuth = process.argv.includes("--no-auth");

if (noAuth && process.env.NODE_ENV === "production") {
  console.error("ERROR: --no-auth cannot be used when NODE_ENV=production. Exiting.");
  process.exit(1);
}

// Detect public-looking gateway URLs and refuse --no-auth
if (noAuth) {
  const gwUrl = process.env.CROW_GATEWAY_URL || "";
  const publicPatterns = [".ts.net", ".onrender.com", ".railway.app", ".fly.dev", ".maestro.press", ".crow.maestro.press"];
  if (publicPatterns.some(p => gwUrl.includes(p))) {
    console.error(`ERROR: --no-auth cannot be used with a public gateway URL (${gwUrl}).`);
    console.error("Remove --no-auth or unset CROW_GATEWAY_URL to run locally.");
    process.exit(1);
  }
  console.warn("⚠️  WARNING: Running without authentication. Do NOT use in production.");
}

if (process.env.CROW_DASHBOARD_PUBLIC === "true") {
  console.warn("⚠️  WARNING: CROW_DASHBOARD_PUBLIC=true — Crow's Nest dashboard is exposed to the public internet.");
  console.warn("   Ensure you have a strong admin password and 2FA enabled. Prefer `tailscale serve` for private remote access.");
}

// Initialize OAuth tables
await initOAuthTables();

// Verify core schema exists — auto-initialize if missing (Docker first run)
try {
  const _schemaDb = createDbClient();
  const { rows } = await _schemaDb.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('memories', 'dashboard_settings', 'crow_context')"
  );
  _schemaDb.close();
  if (rows.length < 3) {
    console.log("Database schema incomplete — running init-db...");
    const { execFileSync } = await import("node:child_process");
    const { dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const gatewayDir = dirname(fileURLToPath(import.meta.url));
    const appRoot = dirname(dirname(gatewayDir));
    try {
      execFileSync("node", ["scripts/init-db.js"], { cwd: appRoot, stdio: "inherit" });
      console.log("Database schema initialized successfully.");
    } catch (initErr) {
      console.error("ERROR: Failed to auto-initialize database schema:", initErr.message);
      console.error("  Run 'npm run init-db' manually.");
      process.exit(1);
    }
  }
} catch (e) {
  console.error("ERROR: Could not verify database schema:", e.message);
  console.error("  Run 'npm run init-db' first.");
  process.exit(1);
}

// Clean up old audit log entries (90-day retention)
try {
  const _cleanupDb = createDbClient();
  await _cleanupDb.execute("DELETE FROM audit_log WHERE created_at < datetime('now', '-90 days')");
  _cleanupDb.close();
} catch (e) {
  // audit_log table may not exist yet (first run before init-db)
}

// Run startup migrations (idempotent; each migration self-tracks via dashboard_settings.migrations)
try {
  const { runGatewayMigrations } = await import("./migrations.js");
  const _migDb = createDbClient();
  const results = await runGatewayMigrations(_migDb);
  _migDb.close();
  for (const r of results) {
    if (r.ran) console.log(`[migrations] ${r.id}: applied (profile="${r.profileName}", voice=${r.voice})`);
    else if (r.error) console.warn(`[migrations] ${r.id}: FAILED — ${r.error}`);
  }
} catch (e) {
  console.warn("[migrations] startup migrations skipped:", e.message);
}

// Consolidated session manager
const sessionManager = new SessionManager();

// Create Express app
const app = express();

// Trust reverse proxies (Tailscale Funnel, Cloudflare Tunnel, etc.)
app.set("trust proxy", 1);

// `res.redirectAfterPost(url)` → res.redirect(303, url). Turbo Drive treats
// 302-after-POST as "stay on current URL" and 303 as "GET the new URL", so
// any redirect that can be issued in response to a non-GET request should use
// 303. See scripts/migrate-redirect-303.js for the codemod that migrated the
// existing POST handlers.
app.use((req, res, next) => {
  res.redirectAfterPost = (url) => res.redirect(303, url);
  next();
});

// --- Security Middleware ---

// Cached storage-origin for CSP img-src. Set once at first request after
// gateway startup; the storage config is normally ready by then.
let _cspStorageOrigin = null;
async function resolveCspStorageOrigin() {
  if (_cspStorageOrigin !== null) return _cspStorageOrigin;
  try {
    const { getStorageOrigin } = await import("../storage/s3-client.js");
    _cspStorageOrigin = getStorageOrigin() || ""; // "" marks "resolved but unavailable"
  } catch {
    _cspStorageOrigin = "";
  }
  return _cspStorageOrigin;
}

// Security headers
app.use(async (req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Frame embedding: X-Frame-Options is legacy and doesn't support cross-port.
  // Skip for /proxy/ (proxied apps manage own), /blog/ and /dashboard/ (loaded in companion iframe).
  // CSP frame-ancestors (below) provides the actual protection.
  if (!req.path.startsWith("/proxy/") && !req.path.startsWith("/companion") && !req.path.startsWith("/blog") && !req.path.startsWith("/dashboard")) {
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
  }
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // Content Security Policy — allows Google Fonts (dashboard), podcast audio,
  // data URIs, and (when configured) the storage endpoint so Nest panels can
  // render presigned-URL thumbnails for MinIO-backed assets.
  const storageOrigin = await resolveCspStorageOrigin();
  const imgSrc = storageOrigin
    ? `img-src 'self' data: blob: ${storageOrigin}`
    : "img-src 'self' data: blob:";
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "script-src 'self' 'unsafe-inline'",
    imgSrc,
    "media-src 'self' https: blob:",
    "connect-src 'self'",
    "frame-src 'self' https:",
    "frame-ancestors 'self' https:",
  ].join("; "));
  if (req.secure || req.headers["x-forwarded-proto"] === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// Reject Tailscale Funnel traffic for all non-public paths. Public paths
// are blog, feeds, sitemap, robots, setup, .well-known (OAuth metadata),
// health, push subscription endpoints are also blocked here by default —
// if an operator needs a path public, either add it to PUBLIC_FUNNEL_PREFIXES
// or set CROW_DASHBOARD_PUBLIC=true.
// This is defense in depth: a misconfigured `tailscale funnel /` used to
// expose the entire gateway (including the Nest dashboard) to the internet;
// this middleware ensures even that misconfig fails closed.
//
// NOTE (Turbo Streams): /dashboard/streams/* SSE endpoints are private
// and intentionally NOT in PUBLIC_FUNNEL_PREFIXES. Adding any /dashboard
// prefix here would expose all stream-emitted data (unread counts,
// media state, orchestrator events) to the public internet.
// Allowlist + middleware live in ./funnel.js so tests can import
// PUBLIC_FUNNEL_PREFIXES and assert new routes never slip into the public
// surface by accident.
app.use(rejectFunneledMiddleware());

// PR 0: CrowdSec gateway-middleware bouncer (no-op when CROW_CROWDSEC_BOUNCER_KEY is unset).
// Mounted after security headers, before CORS/rate-limit so banned IPs get a fast 403
// without consuming rate-limit budget. Uses synchronous LAPI lookup with 200ms timeout
// and fail-open on any error. See servers/gateway/middleware/crowdsec.js.
app.use(crowdsecMiddleware({ db: createDbClient() }));

// CORS
const corsOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : false;
app.use(cors({
  origin: corsOrigins,
  methods: ["GET", "POST", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "mcp-session-id"],
  credentials: true,
}));

// Rate limiting — general (skip for --no-auth since it's a local-only bridge)
if (!noAuth) {
  app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
    skip: (req) => req.path.startsWith("/dashboard") || req.path.startsWith("/api/meta-glasses/") || req.path.startsWith("/llm"),
  }));
}

// Rate limiting — auth endpoints (stricter)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many authentication attempts, please try again later" },
});
app.use("/authorize", authLimiter);
app.use("/token", authLimiter);
app.use("/register", authLimiter);

// Dashboard login rate limit. Key on req.ip + Tailscale-User-Login because
// Funnel traffic all appears as 127.0.0.1 and would otherwise share one
// bucket with the legit operator. rejectFunneled blocks Funnel before this
// fires, but this is defense in depth if that middleware is ever bypassed.
//
// Only count POST requests (actual credential submissions). GET requests
// to /dashboard/login are page loads — the browser re-fetches the form on
// every redirect-from-unauth-dashboard-route, and counting those burns
// the 10/15min budget within a normal browsing session.
const dashboardLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${req.headers["tailscale-user-login"] || ""}`,
  skip: (req) => req.method !== "POST",
  message: { error: "Too many login attempts, please try again later" },
});
app.use("/dashboard/login", dashboardLoginLimiter);

// Body parsing with size limit. The /llm LLM-router has its own route-scoped
// 10mb parser (multi-turn voice transcripts with tool history + image parts
// exceed 1mb), so skip the global 1mb parser there — otherwise it 413s a large
// turn before the route is reached.
const _jsonParser = express.json({ limit: "1mb" });
app.use((req, res, next) => (req.path.startsWith("/llm") ? next() : _jsonParser(req, res, next)));

// --- Static files (PWA manifest, service worker, icons) ---
app.use(express.static(join(__gatewayDir, "public"), {
  maxAge: "1h",
  setHeaders: (res, filePath) => {
    // Service worker must not be cached aggressively
    if (filePath.endsWith("sw.js")) {
      res.setHeader("Cache-Control", "no-cache");
    }
  },
}));

// --- Initialize Web Push ---
initWebPush();

// C1: relayDb created here BEFORE module-1 call so .well-known handlers can close over it.
// Also reused by module-5 (peer-public-api.js — relay endpoints + discovery).
const relayDb = createDbClient();

// boot/public-endpoints.js — robots.txt, root redirect, room-validate, TURN creds,
// identity .well-known ×2, /health, /setup, crowMdHandler (exported, mount below)
await mountPublicEndpoints(app, { relayDb, validateRoomToken });

// --- System Health API (protected — exposes RAM, disk, CPU info) ---
// Mounted after dashboard auth setup below (see "Protected API endpoints" section)

// --- OAuth Setup ---
// --- Instance-to-instance auth (bearer token from registered instances) ---
// This runs before OAuth and allows federated requests with pre-shared tokens.
import { instanceAuthMiddleware } from "./instance-registry.js";
app.use(instanceAuthMiddleware(createDbClient()));
// F6c-2: local MCP token verifier. Runs AFTER instance auth (which wins) and
// BEFORE OAuth. Sets req.localTokenAuth for a valid static token; the MCP
// routes' skipAuthForInstance turns that into full local-operator access.
import { localTokenAuthMiddleware } from "./local-token.js";
app.use(localTokenAuthMiddleware(createDbClient()));

// --- Instance enrollment (Phase 5-MVP peer pairing) ---
// Off by default; set CROW_ENROLL_ENABLED=1 during the pairing ceremony.
try {
  const { instanceEnrollRouter } = await import("./routes/instance-enroll.js");
  app.use(instanceEnrollRouter(createDbClient()));
  if (process.env.CROW_ENROLL_ENABLED === "1") {
    console.log("⚠ Instance enrollment ENABLED (POST /instance/enroll-request). Disable after pairing.");
  }
} catch (err) {
  console.warn("[instance-enroll] Failed to mount:", err.message);
}

let authMiddleware = null;

if (!noAuth) {
  const provider = createOAuthProvider();
  const publicUrl = process.env.CROW_GATEWAY_URL || process.env.RENDER_EXTERNAL_URL;
  const serverUrl = publicUrl
    ? new URL(publicUrl)
    : new URL(`http://${BIND}:${PORT}`);

  // Auth routes (register, authorize, token)
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: serverUrl,
    scopesSupported: ["mcp:tools"],
  }));

  // Protected resource metadata
  const oauthMetadata = createOAuthMetadata({
    provider,
    issuerUrl: serverUrl,
    scopesSupported: ["mcp:tools"],
  });

  app.use(mcpAuthMetadataRouter({
    oauthMetadata,
    resourceServerUrl: serverUrl,
    scopesSupported: ["mcp:tools"],
    resourceName: "Crow",
  }));

  // Introspection endpoint for token verification
  app.post("/introspect", async (req, res) => {
    try {
      const { token } = req.body;
      if (!token) {
        res.status(400).json({ error: "Token is required" });
        return;
      }
      const tokenInfo = await provider.verifyAccessToken(token);
      res.json({
        active: true,
        client_id: tokenInfo.clientId,
        scope: tokenInfo.scopes.join(" "),
        exp: tokenInfo.expiresAt,
        aud: tokenInfo.resource,
      });
    } catch {
      res.status(401).json({ active: false });
    }
  });

  // Bearer auth middleware
  const tokenVerifier = {
    verifyAccessToken: async (token) => {
      return provider.verifyAccessToken(token);
    },
  };

  authMiddleware = requireBearerAuth({
    verifier: tokenVerifier,
    requiredScopes: [],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(serverUrl),
  });

  console.log("OAuth 2.1 enabled — Dynamic Client Registration available");
} else {
  console.log("WARNING: Running without authentication (--no-auth). For development only.");
}

// --- Mount crow.md (with auth if enabled) ---
if (authMiddleware) {
  app.get("/crow.md", authMiddleware, crowMdHandler);
} else {
  app.get("/crow.md", crowMdHandler);
}

// --- Generate MCP Instructions (pre-computed, reused across all sessions) ---

const deviceId = process.env.CROW_DEVICE_ID || null;
const instructions = await generateInstructions({ deviceId });
const routerInstructions = await generateInstructions({ routerStyle: true, deviceId });

// boot/mcp-mounts.js — core MCP servers, per-client proxies, router (C2: returns peerExposureGate)
const { peerExposureGate } = await mountMcpServers(app, { authMiddleware, noAuth, instructions, routerInstructions, sessionManager });

// boot/feature-mounts.js — admin backup, storage, blog+embed+songbook, wm, media/kb/tea-maps
// public routes, AI chat, peer messages, notifications, turbo streams, bot-board api,
// fileview, push, settings scope, stt-debug (C3: import.meta.dirname re-anchored)
await mountFeatureRoutes(app, { authMiddleware, dashboardAuth, peerExposureGate, sessionManager, instructions, PORT });

// boot/admin-api.js — /api/health, provider health, LLM migration, provider seed/reconciler, storage wiring
await mountAdminApi(app, { dashboardAuth });

// --- Mount Crow's Nest (conditional) ---
try {
  const { default: dashboardRouter } = await import("./dashboard/index.js");
  app.use(dashboardRouter(authMiddleware));
  console.log("Crow's Nest mounted at /dashboard");

  // Mount external panel routes at app root (preserves /api/* paths).
  //
  // GOTCHA: bundles mounted here share the app-root namespace. A panel that
  // does `router.use(middleware)` WITHOUT a path prefix will have that
  // middleware applied to every request that reaches its router — including
  // traffic destined for later-mounted panels (Express forwards unmatched
  // requests through every router in mount order). If that middleware is an
  // auth check, it 302s ALL unmatched traffic to /dashboard/login, silently
  // starving every subsequent panel.
  //
  // We inspect each panel router for that anti-pattern and either (a) log a
  // loud warning in dev, or (b) refuse to mount in production. Bundles must
  // path-scope their auth middleware: `router.use("/api", authMiddleware)`.
  try {
    const { loadExternalPanels, getPanelRoutes } = await import("./dashboard/panel-registry.js");
    await loadExternalPanels();
    // Express 5 marks a `router.use(mw)` (no path prefix) layer with
    // `slash: true` — it matches every request path.
    for (const [id, routerFn] of getPanelRoutes()) {
      const instance = routerFn(dashboardAuth);
      const unscoped = (instance?.stack || []).filter((layer) =>
        !layer.route && layer.slash === true
      );
      // Crow's own dbMiddleware pattern and the first few layers are typically
      // benign pass-throughs (they call next()). The dangerous ones are
      // middleware that terminate the response (redirect/send) without
      // calling next(). We can't know that statically, so we flag count > 0
      // and let STRICT_PANEL_MOUNT=1 enforce.
      if (unscoped.length > 0) {
        const msg = `[panel] ${id}: ${unscoped.length} unpathed router.use(middleware) layer(s). Scope with router.use("/api", ...) or similar — otherwise it can intercept traffic destined for panels mounted AFTER this one.`;
        if (process.env.STRICT_PANEL_MOUNT === "1") {
          console.error(msg, "Refusing to mount (STRICT_PANEL_MOUNT=1).");
          continue;
        }
        console.warn(msg);
      }
      app.use(instance);
      console.log(`  [panel] ${id} routes mounted`);
    }
  } catch (err) {
    console.warn("[panel-routes] Failed to load:", err.message);
  }
} catch (err) {
  if (err.code !== "ERR_MODULE_NOT_FOUND") {
    console.warn("[dashboard] Failed to mount:", err.message);
  }
}

// boot/peer-public-api.js — reload endpoint, relay store/fetch, discovery profile/find
await mountPeerPublicApi(app, { authMiddleware, relayDb, loadDynamicBackends });

// --- Start Server ---

// boot/late-mounts.js — calls routes, LLM-router, companion proxy, extension proxy
// S1: returns all three handles for WS wiring in the listen callback
const { setupCallsSignaling: _setupCallsSignaling, setupCompanionProxy: _setupCompanionProxy, extensionProxyWsSetup: _extensionProxyWsSetup } = await mountLateRoutes(app, { dashboardAuth });

const server = app.listen(PORT, BIND, (error) => {
  if (error) {
    console.error("Failed to start gateway:", error);
    process.exit(1);
  }
  // boot/post-listen.js — WS wiring, logging, proxy init, scheduler, health monitor, etc.
  // S2: called fire-and-forget; listen callback cannot await
  runPostListenSetup(server, app, {
    setupCallsSignaling: _setupCallsSignaling,
    setupCompanionProxy: _setupCompanionProxy,
    extensionProxyWsSetup: _extensionProxyWsSetup,
    PORT,
    BIND,
    noAuth,
  });
});

// --- Graceful Shutdown ---

let shuttingDown = false;

async function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\nShutting down gateway...");
  const { shutdownAll } = await import("./proxy.js");
  await Promise.race([
    Promise.allSettled([sessionManager.closeAll(), shutdownAll()]),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

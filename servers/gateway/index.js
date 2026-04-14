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
 *   POST|GET|DELETE /router/mcp   — Consolidated router (7 tools instead of 49+, ~75% context reduction)
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
import { createHmac } from "node:crypto";
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

import { createMemoryServer } from "../memory/server.js";
import { createProjectServer } from "../research/server.js";
import { createSharingServer, getInstanceSyncManager, validateRoomToken } from "../sharing/server.js";
import { createRelayHandlers } from "../sharing/relay.js";
import { generateCrowContext } from "../memory/crow-context.js";
import { createDbClient } from "../db.js";
import { createOAuthProvider, initOAuthTables } from "./auth.js";
import { initProxyServers, createProxyServer, getProxyStatus, loadDynamicBackends, loadRemoteInstances } from "./proxy.js";
import { createRouterServer } from "./router.js";
import { setupPageHandler } from "./setup-page.js";
import { dashboardAuth } from "./dashboard/auth.js";
import { SessionManager } from "./session-manager.js";
import { mountMcpServer } from "./routes/mcp.js";
import { generateInstructions } from "../shared/instructions.js";
import { startAutoUpdate } from "./auto-update.js";
import { startScheduler } from "./scheduler.js";
// startOrchestratorPipelines is loaded lazily — its open-multi-agent
// dependency is a sibling-repo path dep that may not be installed on
// every deployment (hosted relays don't need orchestrator).
import { connectedServers } from "./proxy.js";
import { initWebPush } from "./push/web-push.js";
import { join } from "node:path";

const PORT = parseInt(process.env.PORT || process.env.CROW_GATEWAY_PORT || "3001", 10);
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

// --- Security Middleware ---

// Security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Frame embedding: X-Frame-Options is legacy and doesn't support cross-port.
  // Skip for /proxy/ (proxied apps manage own), /blog/ and /dashboard/ (loaded in companion iframe).
  // CSP frame-ancestors (below) provides the actual protection.
  if (!req.path.startsWith("/proxy/") && !req.path.startsWith("/companion") && !req.path.startsWith("/blog") && !req.path.startsWith("/dashboard")) {
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
  }
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // Content Security Policy — allows Google Fonts (dashboard), podcast audio, data URIs
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "script-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
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
const PUBLIC_FUNNEL_PREFIXES = [
  "/blog",
  "/robots.txt",
  "/sitemap.xml",
  "/.well-known/",
  "/favicon.ico",
  "/manifest.json",
];
app.use((req, res, next) => {
  if (!req.headers["tailscale-funnel-request"]) return next();
  if (process.env.CROW_DASHBOARD_PUBLIC === "true") return next();
  if (PUBLIC_FUNNEL_PREFIXES.some((p) => req.path === p || req.path.startsWith(p))) return next();
  res.status(403).type("text/plain").send("Forbidden: private path not reachable via Tailscale Funnel.");
});

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
const dashboardLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${req.headers["tailscale-user-login"] || ""}`,
  message: { error: "Too many login attempts, please try again later" },
});
app.use("/dashboard/login", dashboardLoginLimiter);

// Body parsing with size limit
app.use(express.json({ limit: "1mb" }));

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

// --- robots.txt (site-wide, before any router mounts) ---
app.get("/robots.txt", (req, res) => {
  const gatewayUrl = process.env.CROW_GATEWAY_URL || process.env.RENDER_EXTERNAL_URL;
  let body = `User-agent: *\nDisallow: /\nAllow: /blog/\n`;
  if (gatewayUrl) {
    body += `Sitemap: ${gatewayUrl}/blog/sitemap.xml\n`;
  }
  res.set("Content-Type", "text/plain");
  res.set("Cache-Control", "public, max-age=3600");
  res.send(body);
});

// --- Root redirect (convenience for managed hosting users) ---
app.get("/", (req, res) => res.redirect("/dashboard/nest"));

// --- Room Token Validation (used by companion for WebSocket auth) ---
app.get("/api/room/validate", (req, res) => {
  const { room, token } = req.query;
  if (!room || !token) return res.status(400).json({ valid: false, error: "Missing room or token" });
  const result = validateRoomToken(String(room), String(token));
  if (!result) return res.status(401).json({ valid: false });
  res.json({ valid: true, ...result });
});

// --- TURN Credentials (time-limited, HMAC-based for coturn use-auth-secret) ---
const turnCredLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true });
app.get("/api/turn-credentials", turnCredLimiter, (req, res) => {
  const secret = process.env.TURN_SECRET;
  const turnUrl = process.env.TURN_URL || process.env.WEBRTC_TURN_URL;
  if (!secret || !turnUrl) {
    return res.status(404).json({ error: "TURN server not configured" });
  }
  const ttl = 3600; // 1 hour
  const timestamp = Math.floor(Date.now() / 1000) + ttl;
  const username = String(timestamp);
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  res.json({
    urls: turnUrl,
    username,
    credential,
    ttl,
  });
});

// --- F.11: Identity Attestation (.well-known endpoints, rate-limited) ---
// Public, unauthenticated, rate-limited to 60 req/min/IP. Paginated at
// 256 active attestations per page. Revocations >1 year move to cold
// storage (not yet implemented — current window retains everything).
const identityLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true });
const IDENTITY_PAGE_SIZE = 256;

app.get("/.well-known/crow-identity.json", identityLimiter, async (req, res) => {
  try {
    const { loadOrCreateIdentity } = await import("../sharing/identity.js");
    const identity = loadOrCreateIdentity();
    const cursor = Number(req.query.cursor) || 0;
    const rows = await relayDb.execute({
      sql: `SELECT id, app, external_handle, app_pubkey, sig, version, created_at
            FROM identity_attestations
            WHERE crow_id = ? AND revoked_at IS NULL
            ORDER BY id ASC LIMIT ? OFFSET ?`,
      args: [identity.crowId, IDENTITY_PAGE_SIZE + 1, cursor],
    });
    const hasNext = rows.rows.length > IDENTITY_PAGE_SIZE;
    const page = rows.rows.slice(0, IDENTITY_PAGE_SIZE);
    res.set("Cache-Control", "public, max-age=60");
    res.json({
      version: 1,
      crow_id: identity.crowId,
      root_pubkey: identity.ed25519Pubkey,
      page_size: IDENTITY_PAGE_SIZE,
      cursor,
      next: hasNext ? cursor + IDENTITY_PAGE_SIZE : null,
      active_attestations: page.map(r => ({
        id: Number(r.id),
        app: r.app,
        external_handle: r.external_handle,
        app_pubkey: r.app_pubkey || null,
        sig: r.sig,
        version: Number(r.version),
        created_at: Number(r.created_at),
      })),
      revocation_list_url: "/.well-known/crow-identity-revocations.json",
    });
  } catch (err) {
    res.status(500).json({ error: "identity publication unavailable" });
  }
});

app.get("/.well-known/crow-identity-revocations.json", identityLimiter, async (req, res) => {
  try {
    const { loadOrCreateIdentity } = await import("../sharing/identity.js");
    const identity = loadOrCreateIdentity();
    const cursor = Number(req.query.cursor) || 0;
    const rows = await relayDb.execute({
      sql: `SELECT r.id, r.attestation_id, r.revoked_at, r.reason, r.sig, a.app, a.external_handle, a.version
            FROM identity_attestation_revocations r
            JOIN identity_attestations a ON a.id = r.attestation_id
            WHERE a.crow_id = ?
            ORDER BY r.revoked_at DESC LIMIT ? OFFSET ?`,
      args: [identity.crowId, IDENTITY_PAGE_SIZE + 1, cursor],
    });
    const hasNext = rows.rows.length > IDENTITY_PAGE_SIZE;
    const page = rows.rows.slice(0, IDENTITY_PAGE_SIZE);
    res.set("Cache-Control", "public, max-age=60");
    res.json({
      version: 1,
      crow_id: identity.crowId,
      page_size: IDENTITY_PAGE_SIZE,
      cursor,
      next: hasNext ? cursor + IDENTITY_PAGE_SIZE : null,
      revocations: page.map(r => ({
        attestation_id: Number(r.attestation_id),
        app: r.app,
        external_handle: r.external_handle,
        version: Number(r.version),
        revoked_at: Number(r.revoked_at),
        reason: r.reason || null,
        sig: r.sig,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "revocation list unavailable" });
  }
});

// --- Health Check ---
app.get("/health", async (req, res) => {
  const proxyStatus = getProxyStatus();
  const connectedTools = proxyStatus.filter((s) => s.status === "connected");
  const servers = ["crow-memory", "crow-projects", "crow-sharing"];

  // Conditionally include storage/blog based on availability
  try {
    const { isAvailable } = await import("../storage/s3-client.js");
    if (await isAvailable()) servers.push("crow-storage");
  } catch {}
  servers.push("crow-blog");
  // crow-media is now a bundle add-on — its tools appear via proxy when installed

  const externalToolCount = connectedTools.reduce((sum, s) => sum + s.toolCount, 0);
  const coreToolCount = 49; // 12 memory + 12 research + 8 sharing + 5 storage + 12 blog
  const routerDisabled = process.env.CROW_DISABLE_ROUTER === "1";

  res.json({
    status: "ok",
    servers,
    externalServers: connectedTools.map((s) => ({ id: s.id, name: s.name, tools: s.toolCount })),
    toolCounts: {
      core: coreToolCount,
      external: externalToolCount,
      total: coreToolCount + externalToolCount,
      routerMode: routerDisabled ? null : 7,
    },
  });
});

// --- System Health API (protected — exposes RAM, disk, CPU info) ---
// Mounted after dashboard auth setup below (see "Protected API endpoints" section)

// --- Setup Page (no auth — first-run password only, redirects after password set) ---
app.get("/setup", setupPageHandler);

// --- crow.md Endpoint (protected when auth is enabled) ---
const crowMdHandler = async (req, res) => {
  const db = createDbClient();
  const platform = req.query.platform || "generic";
  const includeDynamic = req.query.dynamic !== "false";
  try {
    const markdown = await generateCrowContext(db, { includeDynamic, platform, deviceId: process.env.CROW_DEVICE_ID || null });
    res.type("text/markdown").send(markdown);
  } catch (err) {
    console.error("Error generating crow.md:", err);
    res.status(500).send("Error generating crow.md");
  } finally {
    db.close();
  }
};

// --- OAuth Setup ---
// --- Instance-to-instance auth (bearer token from registered instances) ---
// This runs before OAuth and allows federated requests with pre-shared tokens.
import { instanceAuthMiddleware } from "./instance-registry.js";
app.use(instanceAuthMiddleware(createDbClient()));

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
    : new URL(`http://0.0.0.0:${PORT}`);

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

// --- Mount Core MCP Servers ---

// Initialize sharing managers eagerly (starts Hyperswarm + Nostr + InstanceSync on boot, not on first request)
createSharingServer(undefined, { instructions });
// Get the sync manager so memory server can emit change entries
const syncManager = getInstanceSyncManager();

mountMcpServer(app, "/memory", () => createMemoryServer(undefined, { instructions, syncManager }), sessionManager, authMiddleware);
const projectServerFactory = () => createProjectServer(undefined, { instructions });
mountMcpServer(app, "/projects", projectServerFactory, sessionManager, authMiddleware);
// Legacy alias — existing remote clients use /research/mcp
mountMcpServer(app, "/research", projectServerFactory, sessionManager, authMiddleware);
mountMcpServer(app, "/sharing", () => createSharingServer(undefined, { instructions }), sessionManager, authMiddleware);
mountMcpServer(app, "/tools", createProxyServer, sessionManager, authMiddleware);

// Also mount at /mcp for single-server compatibility (uses memory)
mountMcpServer(app, "", () => createMemoryServer(undefined, { instructions, syncManager }), sessionManager, authMiddleware);

// --- Mount Router (consolidated endpoint, ~75% context reduction) ---
if (process.env.CROW_DISABLE_ROUTER !== "1") {
  mountMcpServer(app, "/router", () => createRouterServer({ instructions: routerInstructions }), sessionManager, authMiddleware);
  console.log("Router server mounted (8 tools instead of 58+)");
}

// --- Mount Storage Server (conditional) ---
try {
  const { createStorageServer } = await import("../storage/server.js");
  mountMcpServer(app, "/storage", () => createStorageServer(undefined, { instructions }), sessionManager, authMiddleware);

  // Storage HTTP routes (upload/download)
  const { default: storageHttpRouter } = await import("./routes/storage-http.js");
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
  const { createBlogServer } = await import("../blog/server.js");
  mountMcpServer(app, "/blog-mcp", () => createBlogServer(undefined, { instructions }), sessionManager, authMiddleware);

  // Songbook routes (must mount before blog's /:slug catch-all)
  const { default: songbookRouter } = await import("./routes/songbook.js");
  app.use(songbookRouter());

  // Public blog routes (no auth)
  const { default: blogPublicRouter } = await import("./routes/blog-public.js");
  app.use(blogPublicRouter());

  console.log("Blog server mounted");
} catch (err) {
  if (err.code !== "ERR_MODULE_NOT_FOUND") {
    console.warn("[blog] Failed to mount:", err.message);
  }
}

// --- Mount Window Manager Server ---
try {
  const { createWmServer } = await import("../wm/server.js");
  mountMcpServer(app, "/wm", () => createWmServer(undefined, { instructions }), sessionManager, null);
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
  const repo = join(import.meta.dirname, "../../bundles/media/panel/routes.js");
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
  const repo = join(import.meta.dirname, "../../bundles/knowledge-base/routes/kb-public.js");
  const routesPath = existsSync(installed) ? installed : repo;
  if (existsSync(routesPath)) {
    const { default: kbPublicRouter } = await import(pathToFileURL(routesPath).href);
    if (kbPublicRouter) {
      app.use(kbPublicRouter());
      console.log("Knowledge Base public routes mounted at /kb/*");

      // Start LAN discovery (mDNS) for KB collections with lan_enabled = 1
      try {
        const lanPath = routesPath.replace(/routes[/\\]kb-public\.js$/, "server/lan-discovery.js");
        const dbPath = routesPath.replace(/routes[/\\]kb-public\.js$/, "server/db.js");
        if (existsSync(lanPath) && existsSync(dbPath)) {
          const { startLanDiscovery } = await import(pathToFileURL(lanPath).href);
          const { createDbClient: createKbDb } = await import(pathToFileURL(dbPath).href);
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

// --- Mount AI Chat Routes ---
try {
  const { default: chatRouter } = await import("./routes/chat.js");
  app.use(chatRouter(dashboardAuth));
  console.log("AI Chat routes mounted at /api/chat");
} catch (err) {
  console.warn("[chat] Failed to mount:", err.message);
}

// --- Mount Peer Messages API ---
try {
  const { default: peerMessagesRouter } = await import("./routes/peer-messages.js");
  app.use(peerMessagesRouter(dashboardAuth));
  console.log("Peer Messages API mounted at /api/messages");
} catch (err) {
  console.warn("[peer-messages] Failed to mount:", err.message);
}

// --- Mount Bot Chat API ---
try {
  const { default: botChatRouter } = await import("./routes/bot-chat.js");
  app.use(botChatRouter(dashboardAuth));
  console.log("Bot Chat API mounted at /api/bot-chat");
} catch (err) {
  console.warn("[bot-chat] Failed to mount:", err.message);
}

// --- Mount Notifications API ---
try {
  const { default: notificationsRouter } = await import("./routes/notifications.js");
  app.use(notificationsRouter(dashboardAuth));
  console.log("Notifications API mounted at /api/notifications");
} catch (err) {
  console.warn("[notifications] Failed to mount:", err.message);
}

// --- Mount Push Subscription API ---
try {
  const { default: pushRouter } = await import("./routes/push.js");
  app.use(pushRouter(dashboardAuth));
  console.log("Push API mounted at /api/push");
} catch (err) {
  console.warn("[push] Failed to mount:", err.message);
}

// --- Mount STT Debug endpoint (smoke test for STT profiles) ---
try {
  const { default: sttDebugRouter } = await import("./routes/stt-debug.js");
  app.use(sttDebugRouter(dashboardAuth));
  console.log("STT debug API mounted at /api/stt/debug");
} catch (err) {
  console.warn("[stt-debug] Failed to mount:", err.message);
}

// --- Protected API endpoints (behind dashboard auth) ---
app.get("/api/health", dashboardAuth, async (req, res) => {
  const os = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const totalMem = Math.round(os.totalmem() / 1048576);
  const freeMem = Math.round(os.freemem() / 1048576);
  let diskFreeMb = null;
  try {
    const df = execFileSync("df", ["-BM", "--output=avail", "/"], { timeout: 5000 }).toString();
    const lines = df.trim().split("\n");
    if (lines.length > 1) diskFreeMb = parseInt(lines[1], 10) || null;
  } catch {}
  res.json({
    ram_total_mb: totalMem,
    ram_free_mb: freeMem,
    ram_used_mb: totalMem - freeMem,
    disk_free_mb: diskFreeMb,
    uptime_seconds: Math.round(os.uptime()),
    cpus: os.cpus().length,
  });
});

// --- Provider health matrix (orchestrator registry liveness) ---
try {
  const { providersHealthHandler } = await import("../orchestrator/providers.js");
  app.get("/api/providers/health", dashboardAuth, providersHealthHandler);
  console.log("Provider health matrix mounted at /api/providers/health");
} catch (err) {
  console.warn("[providers] Failed to mount health matrix:", err.message);
}

// --- Provider DB seed (Phase 5-full: first-boot migration from models.json) ---
try {
  const { seedProvidersFromModelsJson } = await import("../orchestrator/providers-db.js");
  const seed = await seedProvidersFromModelsJson(createDbClient());
  if (seed.seeded > 0) {
    console.log(`[providers] Seeded ${seed.seeded} providers from ${seed.source}`);
  }
} catch (err) {
  console.warn("[providers] First-boot seed skipped:", err.message);
}

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

// --- Backend Reload Endpoint (admin-only) ---
const reloadHandler = async (req, res) => {
  try {
    await loadDynamicBackends();
    res.json({ status: "ok", message: "Dynamic backends reloaded" });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
};

if (authMiddleware) {
  app.post("/api/reload-backends", authMiddleware, reloadHandler);
} else {
  app.post("/api/reload-backends", reloadHandler);
}

// --- Peer Relay Endpoints ---
const relayDb = createDbClient();
const relayHandlers = createRelayHandlers(relayDb);

if (authMiddleware) {
  app.post("/relay/store", authMiddleware, relayHandlers.store);
  app.get("/relay/fetch", authMiddleware, relayHandlers.fetch);
} else {
  app.post("/relay/store", relayHandlers.store);
  app.get("/relay/fetch", relayHandlers.fetch);
}

// --- Contact Discovery Endpoints (public, opt-in) ---
app.get("/discover/profile", async (req, res) => {
  try {
    const setting = await relayDb.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'discovery_enabled'",
      args: [],
    });
    if (!setting.rows.length || setting.rows[0].value !== "true") {
      return res.status(404).json({ error: "Discovery not enabled" });
    }
    const { loadOrCreateIdentity } = await import("../sharing/identity.js");
    const identity = loadOrCreateIdentity();
    const nameSetting = await relayDb.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'discovery_name'",
      args: [],
    });
    res.json({
      crow_discovery: true,
      crow_id: identity.crowId,
      display_name: nameSetting.rows[0]?.value || null,
      ed25519_pubkey: identity.ed25519Public,
      secp256k1_pubkey: identity.secp256k1Public,
    });
  } catch (err) {
    res.status(500).json({ error: "Discovery unavailable" });
  }
});

// Find a user by email hash (privacy-preserving contact discovery)
app.get("/discover/find", async (req, res) => {
  try {
    const { hash } = req.query;
    if (!hash || hash.length !== 64) {
      return res.status(400).json({ error: "Missing or invalid hash parameter (expected SHA-256 hex)" });
    }

    // Check if this instance has opted into discovery with a matching email hash
    const emailHash = await relayDb.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'discovery_email_hash'",
      args: [],
    });

    if (!emailHash.rows.length || emailHash.rows[0].value !== hash) {
      return res.json({ found: false });
    }

    const { loadOrCreateIdentity } = await import("../sharing/identity.js");
    const identity = loadOrCreateIdentity();
    const nameSetting = await relayDb.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'discovery_name'",
      args: [],
    });

    res.json({
      found: true,
      crow_id: identity.crowId,
      display_name: nameSetting.rows[0]?.value || null,
    });
  } catch (err) {
    res.status(500).json({ error: "Discovery unavailable" });
  }
});

// --- Start Server ---

// --- Mount Calls Routes (gated behind CROW_CALLS_ENABLED) ---
let _setupCallsSignaling = null;
if (process.env.CROW_CALLS_ENABLED === "1") {
  try {
    const { default: callsPageRouter } = await import("./routes/calls-page.js");
    app.use(callsPageRouter(dashboardAuth));
    const { default: setupCallsSignaling } = await import("./routes/calls-signaling.js");
    _setupCallsSignaling = setupCallsSignaling;
  } catch (err) {
    if (err.code !== "ERR_MODULE_NOT_FOUND") {
      console.warn("[calls] Failed to mount:", err.message);
    }
  }
}

// --- Mount Companion Proxy ---
let _setupCompanionProxy = null;
try {
  const { default: setupCompanionProxy } = await import("./routes/companion-proxy.js");
  _setupCompanionProxy = setupCompanionProxy;
} catch (err) {
  if (err.code !== "ERR_MODULE_NOT_FOUND") {
    console.warn("[companion-proxy] Failed to load:", err.message);
  }
}

// --- Mount Extension Web UI Proxy ---
let _extensionProxyWsSetup = null;
try {
  const { default: extensionProxyRouter } = await import("./routes/extension-proxy.js");
  const { router, setupWebSocket } = extensionProxyRouter(dashboardAuth);
  app.use(router);
  _extensionProxyWsSetup = setupWebSocket;
} catch (err) {
  if (err.code !== "ERR_MODULE_NOT_FOUND") {
    console.warn("[extension-proxy] Failed to mount:", err.message);
  }
}

const server = app.listen(PORT, "0.0.0.0", (error) => {
  if (error) {
    console.error("Failed to start gateway:", error);
    process.exit(1);
  }

  // Wire up calls WebSocket signaling (MUST be before extension and companion)
  if (_setupCallsSignaling) {
    _setupCallsSignaling(server);
  }

  // Wire up WebSocket upgrade for extension proxies (needs server instance)
  if (_extensionProxyWsSetup) {
    _extensionProxyWsSetup(server);
  }

  // Wire up companion proxy (needs server instance for WebSocket upgrade)
  if (_setupCompanionProxy) {
    _setupCompanionProxy(app, server);
  }

  // Wire up any panel-registered WebSocket setups (e.g. meta-glasses /session)
  import("./dashboard/panel-registry.js")
    .then(({ getPanelWebSocketSetups }) => {
      for (const [id, setupFn] of getPanelWebSocketSetups()) {
        try {
          setupFn(server);
          console.log(`  [panel] ${id} WebSocket handler mounted`);
        } catch (err) {
          console.warn(`  [panel] ${id} WebSocket setup failed:`, err.message);
        }
      }
    })
    .catch((err) => console.warn("[panel-ws] setup skipped:", err.message));
  // Graceful shutdown: close listening socket so systemd restart doesn't hit EADDRINUSE
  process.on("crow:shutdown", () => {
    console.log("[gateway] Closing server for restart...");
    server.close();
  });

  console.log(`Crow Gateway listening on http://0.0.0.0:${PORT}`);
  console.log(`  Streamable HTTP (2025-03-26):`);
  console.log(`    Memory:   POST ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/memory/mcp`);
  console.log(`    Projects: POST ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/projects/mcp`);
  console.log(`    Sharing:  POST ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/sharing/mcp`);
  console.log(`    Tools:    POST ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/tools/mcp`);
  if (process.env.CROW_DISABLE_ROUTER !== "1") {
    console.log(`    Router:   POST ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/router/mcp  (7 tools, recommended)`);
  }
  console.log(`  SSE (2024-11-05):`);
  console.log(`    Memory:   GET  ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/memory/sse`);
  console.log(`    Projects: GET  ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/projects/sse`);
  console.log(`    Sharing:  GET  ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/sharing/sse`);
  console.log(`    Tools:    GET  ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/tools/sse`);
  console.log(`  Relay:`);
  console.log(`    Store:  POST ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/relay/store`);
  console.log(`    Fetch:  GET  ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/relay/fetch`);
  console.log(`  Setup:    GET  http://localhost:${PORT}/setup`);
  console.log(`  Health:   GET  http://localhost:${PORT}/health`);
  // Detect Tailscale hostname for convenience logging
  import("child_process").then(({ execFileSync }) => {
    try {
      const tsJson = execFileSync("tailscale", ["status", "--json"], { timeout: 3000, stdio: "pipe" });
      const tsStatus = JSON.parse(tsJson);
      const tsHostname = tsStatus.Self?.HostName;
      const tsIp = tsStatus.Self?.TailscaleIPs?.[0];
      if (tsHostname) {
        console.log(`  Tailscale:  http://${tsHostname}:${PORT}${tsHostname === "crow" ? `  (or http://crow/)` : ""}`);
      }
      if (tsIp) {
        console.log(`  Tailnet IP: http://${tsIp}:${PORT}`);
      }
    } catch {
      // Tailscale not installed or not authenticated — skip
    }
  }).catch(() => {});
  console.log(`\n  First time? Visit http://localhost:${PORT}/setup for integration status and next steps.`);

  // Initialize external server proxy AFTER listening (so health checks pass during startup).
  initProxyServers().catch((err) => {
    console.error("[proxy] Failed to initialize:", err.message);
  });

  // Probe and connect to remote Crow instances (federation)
  loadRemoteInstances().catch((err) => {
    console.warn("[proxy] Remote instance loading:", err.message);
  });

  // Start auto-update checker
  startAutoUpdate(createDbClient()).catch((err) => {
    console.error("[auto-update] Failed to start:", err.message);
  });

  // Start schedule executor
  startScheduler(createDbClient()).catch((err) => {
    console.error("[scheduler] Failed to start:", err.message);
  });

  // Start orchestrator pipeline runner (polls for pipeline: schedules).
  // Lazy import so deployments without the open-multi-agent sibling repo
  // (e.g. hosted relays) keep running.
  import("../orchestrator/server.js")
    .then(({ startOrchestratorPipelines }) => {
      startOrchestratorPipelines(createDbClient(), { connectedServers });
    })
    .catch((err) => {
      if (err.code === "ERR_MODULE_NOT_FOUND") {
        console.warn("[pipeline-runner] Orchestrator unavailable (open-multi-agent not installed). Skipping.");
      } else {
        console.error("[pipeline-runner] Failed to start:", err.message);
      }
    });

  // Register this instance in the instance registry
  import("./instance-registry.js").then(async ({ ensureLocalInstanceRegistered }) => {
    try {
      const { loadOrCreateIdentity } = await import("../sharing/identity.js");
      const identity = loadOrCreateIdentity();

      // Prefer Tailscale HTTPS serve URL, fall back to Tailscale IP, then localhost
      let gatewayUrl = `http://localhost:${PORT}`;
      try {
        const { execFileSync } = await import("child_process");
        // Check if Tailscale serve is configured (provides HTTPS URLs)
        const serveStatus = execFileSync("tailscale", ["serve", "status"], { timeout: 3000, stdio: "pipe" }).toString();
        const serveMatch = serveStatus.match(/https:\/\/[\w.-]+\.ts\.net(?::\d+)?/);
        if (serveMatch) {
          // Find the serve entry that proxies to our port
          const lines = serveStatus.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const urlMatch = lines[i].match(/(https:\/\/[\w.-]+\.ts\.net(?::\d+)?)/);
            if (urlMatch && lines[i + 1]?.includes(`localhost:${PORT}`)) {
              gatewayUrl = urlMatch[1];
              break;
            }
          }
          // If no port-specific match, use the first HTTPS URL
          if (gatewayUrl.startsWith("http://") && serveMatch) {
            gatewayUrl = serveMatch[0];
          }
        }
        // Fall back to Tailscale IP if no serve URL found
        if (gatewayUrl.startsWith("http://localhost")) {
          const tsIp = execFileSync("tailscale", ["ip", "-4"], { timeout: 3000, stdio: "pipe" }).toString().trim();
          if (tsIp) gatewayUrl = `http://${tsIp}:${PORT}`;
        }
      } catch {}

      await ensureLocalInstanceRegistered(createDbClient(), {
        crowId: identity.crowId,
        gatewayUrl,
      });
    } catch (err) {
      // Non-fatal — instance registry is optional for basic operation
      console.warn("[instance-registry] Auto-registration skipped:", err.message);
    }
  }).catch(() => {});
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

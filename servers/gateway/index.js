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

import { createMemoryServer } from "../memory/server.js";
import { createProjectServer } from "../research/server.js";
import { createSharingServer } from "../sharing/server.js";
import { createRelayHandlers } from "../sharing/relay.js";
import { generateCrowContext } from "../memory/crow-context.js";
import { createDbClient } from "../db.js";
import { createOAuthProvider, initOAuthTables } from "./auth.js";
import { initProxyServers, createProxyServer, getProxyStatus, loadDynamicBackends } from "./proxy.js";
import { createRouterServer } from "./router.js";
import { setupPageHandler, setupIntegrationsHandler } from "./setup-page.js";
import { dashboardAuth } from "./dashboard/auth.js";
import { SessionManager } from "./session-manager.js";
import { mountMcpServer } from "./routes/mcp.js";
import { generateInstructions } from "../shared/instructions.js";
import { startAutoUpdate } from "./auto-update.js";

const PORT = parseInt(process.env.PORT || process.env.CROW_GATEWAY_PORT || "3001", 10);
const noAuth = process.argv.includes("--no-auth");

if (noAuth && process.env.NODE_ENV === "production") {
  console.error("ERROR: --no-auth cannot be used when NODE_ENV=production. Exiting.");
  process.exit(1);
}
if (noAuth) {
  console.warn("⚠️  WARNING: Running without authentication. Do NOT use in production.");
}

// Initialize OAuth tables
await initOAuthTables();

// Verify core schema exists — auto-initialize if missing (Turso/Docker first run)
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

// Consolidated session manager
const sessionManager = new SessionManager();

// Create Express app
const app = express();

// --- Security Middleware ---

// Security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (req.secure || req.headers["x-forwarded-proto"] === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

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

// Rate limiting — general
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
}));

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

// Body parsing with size limit
app.use(express.json({ limit: "1mb" }));

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
    auth: !noAuth,
  });
});

// --- System Health API (for resource checks) ---
app.get("/api/health", async (req, res) => {
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

// --- Setup Page (no auth) ---
app.get("/setup", setupPageHandler);
app.post("/setup/integrations", express.urlencoded({ extended: false }), dashboardAuth, setupIntegrationsHandler);

// --- crow.md Endpoint (protected when auth is enabled) ---
const crowMdHandler = async (req, res) => {
  const db = createDbClient();
  const platform = req.query.platform || "generic";
  const includeDynamic = req.query.dynamic !== "false";
  try {
    const markdown = await generateCrowContext(db, { includeDynamic, platform });
    res.type("text/markdown").send(markdown);
  } catch (err) {
    console.error("Error generating crow.md:", err);
    res.status(500).send("Error generating crow.md");
  } finally {
    db.close();
  }
};

// --- OAuth Setup ---
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

mountMcpServer(app, "/memory", () => createMemoryServer(undefined, { instructions }), sessionManager, authMiddleware);
const projectServerFactory = () => createProjectServer(undefined, { instructions });
mountMcpServer(app, "/projects", projectServerFactory, sessionManager, authMiddleware);
// Legacy alias — existing remote clients use /research/mcp
mountMcpServer(app, "/research", projectServerFactory, sessionManager, authMiddleware);
mountMcpServer(app, "/sharing", () => createSharingServer(undefined, { instructions }), sessionManager, authMiddleware);
mountMcpServer(app, "/tools", createProxyServer, sessionManager, authMiddleware);

// Also mount at /mcp for single-server compatibility (uses memory)
mountMcpServer(app, "", () => createMemoryServer(undefined, { instructions }), sessionManager, authMiddleware);

// --- Mount Router (consolidated endpoint, ~75% context reduction) ---
if (process.env.CROW_DISABLE_ROUTER !== "1") {
  mountMcpServer(app, "/router", () => createRouterServer({ instructions: routerInstructions }), sessionManager, authMiddleware);
  console.log("Router server mounted (7 tools instead of 49+)");
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

  // Public blog routes (no auth)
  const { default: blogPublicRouter } = await import("./routes/blog-public.js");
  app.use(blogPublicRouter());

  console.log("Blog server mounted");
} catch (err) {
  if (err.code !== "ERR_MODULE_NOT_FOUND") {
    console.warn("[blog] Failed to mount:", err.message);
  }
}

// --- Mount Crow's Nest (conditional) ---
try {
  const { default: dashboardRouter } = await import("./dashboard/index.js");
  app.use(dashboardRouter(authMiddleware));
  console.log("Crow's Nest mounted at /dashboard");
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
const relayHandlers = createRelayHandlers();

if (authMiddleware) {
  app.post("/relay/store", authMiddleware, relayHandlers.store);
  app.get("/relay/fetch", authMiddleware, relayHandlers.fetch);
} else {
  app.post("/relay/store", relayHandlers.store);
  app.get("/relay/fetch", relayHandlers.fetch);
}

// --- Contact Discovery Endpoint (public, opt-in) ---
app.get("/discover/profile", async (req, res) => {
  try {
    const setting = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'discovery_enabled'",
      args: [],
    });
    if (!setting.rows.length || setting.rows[0].value !== "true") {
      return res.status(404).json({ error: "Discovery not enabled" });
    }
    const { loadOrCreateIdentity } = await import("../sharing/identity.js");
    const identity = loadOrCreateIdentity();
    const nameSetting = await db.execute({
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

// --- Start Server ---

app.listen(PORT, "0.0.0.0", (error) => {
  if (error) {
    console.error("Failed to start gateway:", error);
    process.exit(1);
  }
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
  try {
    const { execFileSync } = await import("child_process");
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
  console.log(`\n  First time? Visit http://localhost:${PORT}/setup for integration status and next steps.`);

  // Initialize external server proxy AFTER listening (so health checks pass during startup).
  initProxyServers().catch((err) => {
    console.error("[proxy] Failed to initialize:", err.message);
  });

  // Start auto-update checker
  startAutoUpdate(createDbClient()).catch((err) => {
    console.error("[auto-update] Failed to start:", err.message);
  });
});

// --- Graceful Shutdown ---

process.on("SIGINT", async () => {
  console.log("\nShutting down gateway...");
  await sessionManager.closeAll();
  process.exit(0);
});

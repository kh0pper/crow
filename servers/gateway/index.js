#!/usr/bin/env node

/**
 * Crow Gateway — Streamable HTTP + SSE Server
 *
 * Exposes crow-memory, crow-research, crow-sharing, crow-storage, and crow-blog
 * as HTTP endpoints for remote access. Supports both Streamable HTTP (2025-03-26)
 * and legacy SSE (2024-11-05) transports for maximum platform compatibility.
 * OAuth 2.1 with Dynamic Client Registration.
 *
 * Routes:
 *   POST|GET|DELETE /{server}/mcp  — Streamable HTTP (memory, research, sharing, storage, blog, tools)
 *   GET  /{server}/sse             — SSE transport init
 *   POST /{server}/messages        — SSE message handling
 *   POST /storage/upload           — Multipart file upload
 *   GET  /storage/file/:key        — File download (presigned redirect)
 *   GET  /blog                     — Public blog index
 *   GET  /blog/:slug               — Public blog post
 *   GET  /blog/feed.xml            — RSS 2.0 feed
 *   GET  /blog/feed.atom           — Atom feed
 *   GET  /dashboard/*              — Dashboard UI
 *   POST /relay/store              — Peer relay store-and-forward
 *   GET  /relay/fetch              — Peer relay fetch pending blobs
 *   GET  /crow.md                  — Cross-platform behavioral context
 *   GET  /health                   — Health check
 *   GET  /setup                    — Integration status page
 *   OAuth routes (/.well-known/*, /authorize, /token, /register)
 */

import { mcpAuthRouter, createOAuthMetadata } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { mcpAuthMetadataRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import express from "express";
import rateLimit from "express-rate-limit";
import cors from "cors";

import { createMemoryServer } from "../memory/server.js";
import { createResearchServer } from "../research/server.js";
import { createSharingServer } from "../sharing/server.js";
import { createRelayHandlers } from "../sharing/relay.js";
import { generateCrowContext } from "../memory/crow-context.js";
import { createDbClient } from "../db.js";
import { createOAuthProvider, initOAuthTables } from "./auth.js";
import { initProxyServers, createProxyServer, getProxyStatus } from "./proxy.js";
import { setupPageHandler } from "./setup-page.js";
import { SessionManager } from "./session-manager.js";
import { mountMcpServer } from "./routes/mcp.js";

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

// --- Health Check ---
app.get("/health", async (req, res) => {
  const proxyStatus = getProxyStatus();
  const connectedTools = proxyStatus.filter((s) => s.status === "connected");
  const servers = ["crow-memory", "crow-research", "crow-sharing"];

  // Conditionally include storage/blog based on availability
  try {
    const { isAvailable } = await import("../storage/s3-client.js");
    if (await isAvailable()) servers.push("crow-storage");
  } catch {}
  servers.push("crow-blog");

  res.json({
    status: "ok",
    servers,
    externalServers: connectedTools.map((s) => ({ id: s.id, name: s.name, tools: s.toolCount })),
    auth: !noAuth,
  });
});

// --- Setup Page (no auth) ---
app.get("/setup", setupPageHandler);

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
    resourceName: "Crow AI Platform",
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

// --- Mount Core MCP Servers ---

mountMcpServer(app, "/memory", createMemoryServer, sessionManager, authMiddleware);
mountMcpServer(app, "/research", createResearchServer, sessionManager, authMiddleware);
mountMcpServer(app, "/sharing", createSharingServer, sessionManager, authMiddleware);
mountMcpServer(app, "/tools", createProxyServer, sessionManager, authMiddleware);

// Also mount at /mcp for single-server compatibility (uses memory)
mountMcpServer(app, "", createMemoryServer, sessionManager, authMiddleware);

// --- Mount Storage Server (conditional) ---
try {
  const { createStorageServer } = await import("../storage/server.js");
  mountMcpServer(app, "/storage", createStorageServer, sessionManager, authMiddleware);

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
  mountMcpServer(app, "/blog-mcp", createBlogServer, sessionManager, authMiddleware);

  // Public blog routes (no auth)
  const { default: blogPublicRouter } = await import("./routes/blog-public.js");
  app.use(blogPublicRouter());

  console.log("Blog server mounted");
} catch (err) {
  if (err.code !== "ERR_MODULE_NOT_FOUND") {
    console.warn("[blog] Failed to mount:", err.message);
  }
}

// --- Mount Dashboard (conditional) ---
try {
  const { default: dashboardRouter } = await import("./dashboard/index.js");
  app.use(dashboardRouter(authMiddleware));
  console.log("Dashboard mounted at /dashboard");
} catch (err) {
  if (err.code !== "ERR_MODULE_NOT_FOUND") {
    console.warn("[dashboard] Failed to mount:", err.message);
  }
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

// --- Start Server ---

app.listen(PORT, "0.0.0.0", (error) => {
  if (error) {
    console.error("Failed to start gateway:", error);
    process.exit(1);
  }
  console.log(`Crow Gateway listening on http://0.0.0.0:${PORT}`);
  console.log(`  Streamable HTTP (2025-03-26):`);
  console.log(`    Memory:   POST ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/memory/mcp`);
  console.log(`    Research: POST ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/research/mcp`);
  console.log(`    Sharing:  POST ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/sharing/mcp`);
  console.log(`    Tools:    POST ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/tools/mcp`);
  console.log(`  SSE (2024-11-05):`);
  console.log(`    Memory:   GET  ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/memory/sse`);
  console.log(`    Research: GET  ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/research/sse`);
  console.log(`    Sharing:  GET  ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/sharing/sse`);
  console.log(`    Tools:    GET  ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/tools/sse`);
  console.log(`  Relay:`);
  console.log(`    Store:  POST ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/relay/store`);
  console.log(`    Fetch:  GET  ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/relay/fetch`);
  console.log(`  Setup:    GET  http://localhost:${PORT}/setup`);
  console.log(`  Health:   GET  http://localhost:${PORT}/health`);

  // Initialize external server proxy AFTER listening (so health checks pass during startup).
  initProxyServers().catch((err) => {
    console.error("[proxy] Failed to initialize:", err.message);
  });
});

// --- Graceful Shutdown ---

process.on("SIGINT", async () => {
  console.log("\nShutting down gateway...");
  await sessionManager.closeAll();
  process.exit(0);
});

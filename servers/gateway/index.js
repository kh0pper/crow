#!/usr/bin/env node

/**
 * Crow Gateway — Streamable HTTP Server
 *
 * Exposes crow-memory and crow-research as HTTP endpoints for remote access
 * (Claude mobile apps, Claude.ai Connectors). Supports OAuth 2.1 with
 * Dynamic Client Registration.
 *
 * Routes:
 *   POST|GET|DELETE /memory/mcp   — crow-memory MCP endpoint
 *   POST|GET|DELETE /research/mcp — crow-research MCP endpoint
 *   GET /health                   — health check
 *   OAuth routes (/.well-known/*, /authorize, /token, /register)
 *
 * Usage:
 *   node servers/gateway/index.js              # With OAuth (default)
 *   node servers/gateway/index.js --no-auth    # Without OAuth (dev only)
 */

import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

/**
 * Simple in-memory EventStore for StreamableHTTPServerTransport resumability.
 * Inlined here because the SDK doesn't publicly export this class.
 */
class InMemoryEventStore {
  constructor() { this.events = new Map(); }
  generateEventId(streamId) {
    return `${streamId}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  }
  getStreamIdFromEventId(eventId) {
    return eventId.split("_")[0] || "";
  }
  async storeEvent(streamId, message) {
    const eventId = this.generateEventId(streamId);
    this.events.set(eventId, { streamId, message });
    return eventId;
  }
  async replayEventsAfter(lastEventId, { send }) {
    if (!lastEventId || !this.events.has(lastEventId)) return "";
    const streamId = this.getStreamIdFromEventId(lastEventId);
    if (!streamId) return "";
    let found = false;
    const sorted = [...this.events.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [eventId, { streamId: sid, message }] of sorted) {
      if (sid !== streamId) continue;
      if (eventId === lastEventId) { found = true; continue; }
      if (found) await send(eventId, message);
    }
    return streamId;
  }
}
import { mcpAuthRouter, createOAuthMetadata } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { mcpAuthMetadataRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import express from "express";
import { createMemoryServer } from "../memory/server.js";
import { createResearchServer } from "../research/server.js";
import { createOAuthProvider, initOAuthTables } from "./auth.js";

const PORT = parseInt(process.env.PORT || process.env.CROW_GATEWAY_PORT || "3001", 10);
const noAuth = process.argv.includes("--no-auth");

// Initialize OAuth tables
await initOAuthTables();

// Session storage: Map<sessionId, { transport, server }>
const memorySessions = new Map();
const researchSessions = new Map();

// Create Express app
const app = express();
app.use(express.json());

// --- Health Check ---
app.get("/health", (req, res) => {
  res.json({ status: "ok", servers: ["crow-memory", "crow-research"], auth: !noAuth });
});

// --- OAuth Setup ---
let authMiddleware = null;

if (!noAuth) {
  const provider = createOAuthProvider();
  // Use the public HTTPS URL when deployed, fall back to local HTTP.
  // RENDER_EXTERNAL_URL is auto-provided by Render (e.g. https://crow-gateway.onrender.com)
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

// --- MCP Request Handler Factory ---

function createMcpHandler(sessions, createServer) {
  const postHandler = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];

    try {
      if (sessionId && sessions.has(sessionId)) {
        // Existing session
        const session = sessions.get(sessionId);
        await session.transport.handleRequest(req, res, req.body);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New session
        const eventStore = new InMemoryEventStore();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          eventStore,
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, server });
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) sessions.delete(sid);
        };

        const server = createServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null,
        });
      }
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };

  const getHandler = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    const session = sessions.get(sessionId);
    await session.transport.handleRequest(req, res);
  };

  const deleteHandler = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    const session = sessions.get(sessionId);
    await session.transport.handleRequest(req, res);
  };

  return { postHandler, getHandler, deleteHandler };
}

// --- Mount MCP Endpoints ---

const memoryHandlers = createMcpHandler(memorySessions, createMemoryServer);
const researchHandlers = createMcpHandler(researchSessions, createResearchServer);

function mountEndpoint(path, handlers) {
  if (authMiddleware) {
    app.post(path, authMiddleware, handlers.postHandler);
    app.get(path, authMiddleware, handlers.getHandler);
    app.delete(path, authMiddleware, handlers.deleteHandler);
  } else {
    app.post(path, handlers.postHandler);
    app.get(path, handlers.getHandler);
    app.delete(path, handlers.deleteHandler);
  }
}

mountEndpoint("/memory/mcp", memoryHandlers);
mountEndpoint("/research/mcp", researchHandlers);

// Also mount at /mcp for single-server compatibility (uses memory)
mountEndpoint("/mcp", memoryHandlers);

// --- Start Server ---

app.listen(PORT, "0.0.0.0", (error) => {
  if (error) {
    console.error("Failed to start gateway:", error);
    process.exit(1);
  }
  console.log(`Crow Gateway listening on http://0.0.0.0:${PORT}`);
  console.log(`  Memory:   POST ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/memory/mcp`);
  console.log(`  Research: POST ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/research/mcp`);
  console.log(`  Health:   GET  http://localhost:${PORT}/health`);
});

// --- Graceful Shutdown ---

process.on("SIGINT", async () => {
  console.log("\nShutting down gateway...");
  for (const [sid, session] of [...memorySessions, ...researchSessions]) {
    try {
      await session.transport.close();
    } catch {}
  }
  memorySessions.clear();
  researchSessions.clear();
  process.exit(0);
});

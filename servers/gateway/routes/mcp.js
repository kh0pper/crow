/**
 * MCP Route Mounting — Streamable HTTP + SSE transports
 *
 * Provides factory functions to mount any MCP server on Express routes
 * with both Streamable HTTP (2025-03-26) and legacy SSE (2024-11-05)
 * transports.
 */

import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Router } from "express";

/**
 * Simple in-memory EventStore for StreamableHTTPServerTransport resumability.
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

/**
 * Create Streamable HTTP handlers for an MCP server.
 * @param {Map} sessions - Session store from SessionManager
 * @param {Function} createServer - Factory function returning McpServer
 */
function createMcpHandler(sessions, createServer) {
  const postHandler = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    try {
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId);
        await session.transport.handleRequest(req, res, req.body);
      } else if (!sessionId && isInitializeRequest(req.body)) {
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

/**
 * Create SSE handlers for an MCP server.
 * @param {Map} sessions - Session store from SessionManager
 * @param {Function} createServer - Factory function returning McpServer
 * @param {string} messagesPath - The POST path for SSE messages
 */
function createSseHandler(sessions, createServer, messagesPath) {
  const sseHandler = async (req, res) => {
    try {
      const transport = new SSEServerTransport(messagesPath, res);
      const sessionId = transport.sessionId;
      sessions.set(sessionId, { transport, server: null });
      res.on("close", () => { sessions.delete(sessionId); });
      const server = createServer();
      sessions.get(sessionId).server = server;
      await server.connect(transport);
    } catch (error) {
      console.error("Error creating SSE session:", error);
      if (!res.headersSent) {
        res.status(500).send("Failed to create SSE session");
      }
    }
  };

  const messagesHandler = async (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send("Invalid or missing sessionId query parameter");
      return;
    }
    try {
      const session = sessions.get(sessionId);
      await session.transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      console.error("Error handling SSE message:", error);
      if (!res.headersSent) {
        res.status(500).send("Error handling message");
      }
    }
  };

  return { sseHandler, messagesHandler };
}

/**
 * Mount an MCP server on the given router with both transports.
 *
 * @param {Router} router - Express router to mount on
 * @param {string} prefix - Route prefix (e.g. "/memory")
 * @param {Function} createServer - Server factory
 * @param {import("../session-manager.js").SessionManager} sessionManager
 * @param {Function|null} authMiddleware - Optional auth middleware
 */
export function mountMcpServer(router, prefix, createServer, sessionManager, authMiddleware) {
  const streamableSessions = sessionManager.getStore(prefix.replace("/", ""), "streamable");
  const sseSessions = sessionManager.getStore(prefix.replace("/", ""), "sse");

  const handlers = createMcpHandler(streamableSessions, createServer);
  const sseHandlers = createSseHandler(sseSessions, createServer, `${prefix}/messages`);

  const mcpPath = `${prefix}/mcp`;
  const ssePath = `${prefix}/sse`;
  const messagesPath = `${prefix}/messages`;

  if (authMiddleware) {
    router.post(mcpPath, authMiddleware, handlers.postHandler);
    router.get(mcpPath, authMiddleware, handlers.getHandler);
    router.delete(mcpPath, authMiddleware, handlers.deleteHandler);
    router.get(ssePath, authMiddleware, sseHandlers.sseHandler);
    router.post(messagesPath, authMiddleware, sseHandlers.messagesHandler);
  } else {
    router.post(mcpPath, handlers.postHandler);
    router.get(mcpPath, handlers.getHandler);
    router.delete(mcpPath, handlers.deleteHandler);
    router.get(ssePath, sseHandlers.sseHandler);
    router.post(messagesPath, sseHandlers.messagesHandler);
  }
}

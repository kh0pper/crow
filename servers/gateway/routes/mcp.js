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
import { recordSessionStart, recordToolCall, recordSessionEnd } from "../session-logger.js";
import { applyLocalTokenAuth } from "../local-token.js";
import { verifyRemoteActor, noteRemoteActorResult } from "../../shared/remote-actor.js";
import { defaultPairKey } from "../../shared/sync-pair-binding.js";
import { getOrCreateLocalInstanceId } from "../instance-registry.js";

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
 * Who opened a session (req.auth.clientId; "instance:<id>" for a paired peer),
 * so a revoke can close that peer's open streams (PT-1).
 */
function sessionOwner(req) {
  return req.auth?.clientId || null;
}

/**
 * Item 46 PR-B: the remote actor a paired peer's GATEWAY signed for this tools/call, verified against the
 * pair key of the bearer-authenticated peer (servers/shared/remote-actor.js). Returns the record for
 * req.auth.extra.remoteActor, or null. Every outcome is handed to noteRemoteActorResult (its rate-limited
 * "accepted" / "downgraded" line), and anything that goes wrong is a failed verify: the call keeps the
 * "Crow (via <name>)" label and still runs. Only a single JSON-RPC object is ever verified, never a batch.
 */
function verifiedRemoteActor(req, prefix) {
  const body = req.body;
  if (req.method !== "POST" || !body || typeof body !== "object" || Array.isArray(body) || body.method !== "tools/call") return null;
  const sourceId = req.instanceAuth.instance.id;
  let result;
  try {
    result = verifyRemoteActor({
      headers: req.headers, body, peerId: sourceId, localId: getOrCreateLocalInstanceId(), mount: prefix, keyLookup: defaultPairKey,
    });
  } catch {
    result = { ok: false, reason: "verify_error" };
  }
  try { noteRemoteActorResult({ sourceId, mount: prefix, result }); } catch { /* logging never affects the call */ }
  if (!result?.ok) return null;
  const { bot, name, src } = result.actor;
  return { kind: "bot", id: bot, name, instanceId: src };
}

/**
 * Create Streamable HTTP handlers for an MCP server.
 * @param {Map} sessions - Session store from SessionManager
 * @param {Function} createServer - Factory function returning McpServer
 * @param {string} serverName
 * @param {{resumable?: boolean}} [opts] - resumable (default true): keep an in-memory event store
 */
export function createMcpHandler(sessions, createServer, serverName, { resumable = true } = {}) {
  const postHandler = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    try {
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId);
        await session.transport.handleRequest(req, res, req.body);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // resumable: false keeps no event store (nothing replayable, no result
        // held in memory after it was sent); the loopback tool mounts use it.
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          ...(resumable ? { eventStore: new InMemoryEventStore() } : {}),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, server, owner: sessionOwner(req) });
            // Log session start
            const clientInfo = req.body?.params?.clientInfo || null;
            recordSessionStart({ sessionId: sid, serverName, transport: "streamable", clientInfo });
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            sessions.delete(sid);
            recordSessionEnd(sid);
          }
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
function createSseHandler(sessions, createServer, messagesPath, serverName) {
  const sseHandler = async (req, res) => {
    try {
      const transport = new SSEServerTransport(messagesPath, res);
      const sessionId = transport.sessionId;
      sessions.set(sessionId, { transport, server: null, owner: sessionOwner(req) });
      recordSessionStart({ sessionId, serverName, transport: "sse", clientInfo: null });
      res.on("close", () => {
        sessions.delete(sessionId);
        recordSessionEnd(sessionId);
      });
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
    // Track tool calls on SSE messages
    if (sessionId && req.body?.method === "tools/call") {
      const toolName = req.body?.params?.name;
      if (toolName) recordToolCall(sessionId, toolName);
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
 * @param {Function} [peerGate] - Optional default-deny peer-exposure gate: async (prefix, req, res) => boolean. Returns false (and writes its own JSON-RPC error) to reject a peer-instance call to a non-exposed capability.
 */
export function mountMcpServer(router, prefix, createServer, sessionManager, authMiddleware, peerGate) {
  const serverName = prefix.replace("/", "");
  const streamableSessions = sessionManager.getStore(serverName, "streamable");
  const sseSessions = sessionManager.getStore(serverName, "sse");

  const handlers = createMcpHandler(streamableSessions, createServer, serverName);
  const sseHandlers = createSseHandler(sseSessions, createServer, `${prefix}/messages`, serverName);

  const mcpPath = `${prefix}/mcp`;
  const ssePath = `${prefix}/sse`;
  const messagesPath = `${prefix}/messages`;

  // Tool call tracking middleware for Streamable HTTP
  const toolTrackMiddleware = (req, res, next) => {
    if (req.method === "POST" && req.body?.method === "tools/call") {
      const sessionId = req.headers["mcp-session-id"];
      const toolName = req.body?.params?.name;
      if (sessionId && toolName) {
        recordToolCall(sessionId, toolName);
      }
    }
    next();
  };

  if (authMiddleware) {
    // Skip OAuth when the request has already been authenticated as a
    // paired Crow instance (instanceAuthMiddleware at index.js ran before
    // us and set req.instanceAuth). Without this bypass, federated MCP
    // calls from paired instances were failing: the peer bearer token
    // passes the instance check but isn't recognised by OAuth's verifier,
    // so OAuth would reject the request with 401 despite it being a
    // trusted peer.
    //
    // We synthesize a req.auth compatible with what requireBearerAuth
    // would have set — downstream MCP handlers (tool executor, session
    // manager) read fields off req.auth and error out with a generic 500
    // "Internal Server Error" when it's missing. Using the paired
    // instance's id as clientId keeps audit trails meaningful.
    const skipAuthForInstance = async (req, res, next) => {
      if (req.instanceAuth?.instance) {
        // F4a Layer 2a: default-deny exposure gate. A trusted peer may invoke
        // only capabilities this instance has exposed. Runs only for peer
        // callers; local-operator calls take the authMiddleware branch below
        // and are never gated here. The gate writes its own JSON-RPC error on
        // deny, so we just stop.
        if (peerGate) {
          let allowed = true;
          try { allowed = await peerGate(prefix, req, res); }
          catch (err) {
            console.warn(`[mcp] peer exposure gate error (${prefix}):`, err.message);
            allowed = false; // fail closed
            if (!res.headersSent) {
              res.status(403).json({ jsonrpc: "2.0", id: req.body?.id ?? null, error: { code: -32002, message: "Exposure check failed" } });
            }
          }
          if (!allowed) return;
        }
        req.auth = {
          token: "peer-instance",
          clientId: `instance:${req.instanceAuth.instance.id}`,
          scopes: ["mcp:tools"],
          expiresAt: Math.floor(Date.now() / 1000) + 300,
          // Handlers see this as extra.authInfo.extra; peerActorMeta (shared/peer-label.js) forwards it.
          extra: { peerName: req.instanceAuth.peerName ?? null },
        };
        // A peer gateway's signed bot actor upgrades the label to "<bot> (bot from <name>)"; never refuses.
        const remoteActor = verifiedRemoteActor(req, prefix);
        if (remoteActor) req.auth.extra.remoteActor = remoteActor;
        return next();
      }
      // F6c-2: a validated local MCP token is a full local-operator credential
      // (same access surface as an OAuth client). It is NOT a paired peer, so
      // applyLocalTokenAuth deliberately does NOT run peerGate. Sits after the
      // instance branch (instance auth wins) and before the OAuth fallback.
      if (applyLocalTokenAuth(req)) return next();
      return authMiddleware(req, res, next);
    };
    router.post(mcpPath, skipAuthForInstance, toolTrackMiddleware, handlers.postHandler);
    router.get(mcpPath, skipAuthForInstance, handlers.getHandler);
    router.delete(mcpPath, skipAuthForInstance, handlers.deleteHandler);
    router.get(ssePath, skipAuthForInstance, sseHandlers.sseHandler);
    router.post(messagesPath, skipAuthForInstance, sseHandlers.messagesHandler);
  } else {
    router.post(mcpPath, toolTrackMiddleware, handlers.postHandler);
    router.get(mcpPath, handlers.getHandler);
    router.delete(mcpPath, handlers.deleteHandler);
    router.get(ssePath, sseHandlers.sseHandler);
    router.post(messagesPath, sseHandlers.messagesHandler);
  }
}

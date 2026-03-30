/**
 * Chat API Routes
 *
 * REST + SSE endpoints for AI chat conversations.
 * Protected by dashboard session auth (cookie-based).
 *
 * Routes:
 *   POST   /api/chat/conversations              — Create conversation
 *   GET    /api/chat/conversations              — List conversations
 *   GET    /api/chat/conversations/:id          — Get conversation + messages
 *   DELETE /api/chat/conversations/:id          — Delete conversation
 *   POST   /api/chat/conversations/:id/messages — Send message → SSE stream
 *   POST   /api/chat/conversations/:id/cancel   — Cancel in-progress generation
 *   GET    /api/chat/providers                  — List providers + config status
 *   POST   /api/chat/providers/test             — Test provider connection
 */

import { Router } from "express";
import { createDbClient } from "../../db.js";
import { createProviderAdapter, createAdapterFromProfile, getProviderConfig, getAiProfiles, listProviders, testProviderConnection, testProfileConnection } from "../ai/provider.js";
import { createToolExecutor, getChatTools, MAX_TOOL_ROUNDS } from "../ai/tool-executor.js";
import { generateSystemPrompt } from "../ai/system-prompt.js";
import { getPresignedUrl, isAvailable as isStorageAvailable } from "../../storage/s3-client.js";

/** Sliding window: max messages to send to AI */
const CONTEXT_WINDOW = 20;

/** Active generation controllers: conversationId → AbortController */
const activeGenerations = new Map();

/** Rate limiter state: sessionToken → { count, windowStart } */
const rateLimits = new Map();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

function checkRateLimit(sessionToken) {
  const now = Date.now();
  let entry = rateLimits.get(sessionToken);
  if (!entry || (now - entry.windowStart) > RATE_LIMIT_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    rateLimits.set(sessionToken, entry);
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

export default function chatRouter(dashboardAuth) {
  const router = Router();

  // All chat routes require dashboard auth
  router.use("/api/chat", dashboardAuth);

  // --- Provider Info ---

  router.get("/api/chat/providers", (req, res) => {
    const providers = listProviders();
    const config = getProviderConfig();
    res.json({
      providers,
      current: config ? {
        provider: config.provider,
        model: config.model || null,
        baseUrl: config.baseUrl || null,
      } : null,
    });
  });

  router.post("/api/chat/providers/test", async (req, res) => {
    const result = await testProviderConnection();
    res.json(result);
  });

  // --- AI Profiles ---

  router.get("/api/chat/profiles", async (req, res) => {
    const db = createDbClient();
    try {
      const profiles = await getAiProfiles(db);
      const envConfig = getProviderConfig();
      res.json({
        profiles,
        envConfig: envConfig ? { provider: envConfig.provider, model: envConfig.model, baseUrl: envConfig.baseUrl } : null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  router.post("/api/chat/profiles/test", async (req, res) => {
    const { profile_id } = req.body || {};
    if (!profile_id) return res.status(400).json({ error: "profile_id required" });
    const db = createDbClient();
    try {
      const profiles = await getAiProfiles(db, { includeKeys: true });
      const profile = profiles.find(p => p.id === profile_id);
      if (!profile) return res.status(404).json({ error: "Profile not found" });
      const result = await testProfileConnection(profile);
      res.json(result);
    } finally {
      db.close();
    }
  });

  // --- Conversations CRUD ---

  router.post("/api/chat/conversations", async (req, res) => {
    const db = createDbClient();
    try {
      const { title, system_prompt, profile_id, model } = req.body || {};

      let provider, convModel, profileId = null;

      if (profile_id) {
        // Profile-based conversation
        const profiles = await getAiProfiles(db);
        const profile = profiles.find(p => p.id === profile_id);
        if (!profile) return res.status(400).json({ error: "Unknown profile" });
        provider = profile.provider;
        convModel = model || profile.defaultModel || "";
        profileId = profile_id;
      } else {
        // Env-based fallback
        const config = getProviderConfig();
        if (!config) {
          return res.status(400).json({ error: "No AI provider configured. Add an AI Profile in Settings." });
        }
        provider = config.provider;
        convModel = model || config.model || "";
      }

      const result = await db.execute({
        sql: `INSERT INTO chat_conversations (title, provider, model, system_prompt, profile_id)
              VALUES (?, ?, ?, ?, ?)`,
        args: [
          title || "New conversation",
          provider,
          convModel,
          system_prompt || null,
          profileId,
        ],
      });

      res.status(201).json({
        id: Number(result.lastInsertRowid),
        title: title || "New conversation",
        provider,
        model: convModel,
        profile_id: profileId,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  router.get("/api/chat/conversations", async (req, res) => {
    const db = createDbClient();
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 100);
      const offset = parseInt(req.query.offset) || 0;

      const { rows } = await db.execute({
        sql: `SELECT id, title, provider, model, profile_id, total_tokens, created_at, updated_at
              FROM chat_conversations
              ORDER BY updated_at DESC
              LIMIT ? OFFSET ?`,
        args: [limit, offset],
      });

      res.json({ conversations: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  router.get("/api/chat/conversations/:id", async (req, res) => {
    const db = createDbClient();
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid conversation ID" });

      const { rows: convRows } = await db.execute({
        sql: "SELECT * FROM chat_conversations WHERE id = ?",
        args: [id],
      });

      if (convRows.length === 0) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const { rows: msgRows } = await db.execute({
        sql: `SELECT id, role, content, tool_calls, tool_call_id, tool_name,
                     input_tokens, output_tokens, attachments, created_at
              FROM chat_messages
              WHERE conversation_id = ?
              ORDER BY id ASC`,
        args: [id],
      });

      const messages = msgRows.map((m) => ({
        ...m,
        attachments: m.attachments ? JSON.parse(m.attachments) : null,
      }));

      res.json({
        conversation: convRows[0],
        messages,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  router.delete("/api/chat/conversations/:id", async (req, res) => {
    const db = createDbClient();
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid conversation ID" });

      // Cancel any active generation
      const controller = activeGenerations.get(id);
      if (controller) {
        controller.abort();
        activeGenerations.delete(id);
      }

      await db.execute({ sql: "DELETE FROM chat_conversations WHERE id = ?", args: [id] });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  // --- Update Conversation (model switch) ---

  router.patch("/api/chat/conversations/:id", async (req, res) => {
    const db = createDbClient();
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid conversation ID" });

      const { model } = req.body || {};
      if (!model || typeof model !== "string" || model.length > 100) {
        return res.status(400).json({ error: "Valid model name required" });
      }

      // Validate model against profile's model list (if profile-based)
      const conv = await db.execute({ sql: "SELECT profile_id FROM chat_conversations WHERE id = ?", args: [id] });
      if (!conv.rows[0]) return res.status(404).json({ error: "Conversation not found" });

      if (conv.rows[0].profile_id) {
        const profiles = await getAiProfiles(db);
        const profile = profiles.find(p => p.id === conv.rows[0].profile_id);
        if (profile?.models && !profile.models.includes(model)) {
          return res.status(400).json({ error: "Model not available in this profile" });
        }
      }

      await db.execute({
        sql: "UPDATE chat_conversations SET model = ?, updated_at = datetime('now') WHERE id = ?",
        args: [model, id],
      });
      res.json({ ok: true, model });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  // --- Send Message (SSE stream) ---

  router.post("/api/chat/conversations/:id/messages", async (req, res) => {
    const convId = parseInt(req.params.id);
    if (!convId) return res.status(400).json({ error: "Invalid conversation ID" });

    // Rate limiting
    const sessionToken = req.ip || "unknown";
    if (!checkRateLimit(sessionToken)) {
      return res.status(429).json({ error: "Rate limited — max 10 messages per minute" });
    }

    const db = createDbClient();
    const toolExecutor = createToolExecutor();

    // Set up SSE
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    function sendEvent(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    // AbortController for cancellation
    const abortController = new AbortController();
    activeGenerations.set(convId, abortController);

    // Clean up on client disconnect
    req.on("close", () => {
      abortController.abort();
      activeGenerations.delete(convId);
    });

    try {
      // Verify conversation exists
      const { rows: convRows } = await db.execute({
        sql: "SELECT * FROM chat_conversations WHERE id = ?",
        args: [convId],
      });
      if (convRows.length === 0) {
        sendEvent("error", { message: "Conversation not found", code: "not_found" });
        res.end();
        return;
      }
      const conversation = convRows[0];

      // Save user message
      const { content, attachments } = req.body || {};
      if ((!content || typeof content !== "string" || !content.trim()) && (!attachments || !attachments.length)) {
        sendEvent("error", { message: "Message content or attachments required", code: "invalid_input" });
        res.end();
        return;
      }
      const messageText = (content || "(attachment)").trim();
      const attachJson = attachments && attachments.length > 0 ? JSON.stringify(attachments) : null;

      await db.execute({
        sql: "INSERT INTO chat_messages (conversation_id, role, content, attachments) VALUES (?, 'user', ?, ?)",
        args: [convId, messageText, attachJson],
      });

      // Get provider adapter (profile-aware)
      let adapter;
      try {
        if (conversation.profile_id) {
          const profiles = await getAiProfiles(db, { includeKeys: true });
          const profile = profiles.find(p => p.id === conversation.profile_id);
          if (!profile) {
            // Profile deleted — fall back to env config
            const result = await createProviderAdapter();
            adapter = result.adapter;
          } else {
            const result = await createAdapterFromProfile(profile, conversation.model);
            adapter = result.adapter;
          }
        } else {
          const result = await createProviderAdapter();
          adapter = result.adapter;
        }
      } catch (err) {
        sendEvent("error", { message: err.message, code: err.code || "provider_error" });
        res.end();
        return;
      }

      // Build system prompt
      const systemPrompt = await generateSystemPrompt({
        customPrompt: conversation.system_prompt || undefined,
      });

      // Get MCP tools for AI
      const tools = getChatTools();

      // Tool call loop
      let rounds = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      while (rounds < MAX_TOOL_ROUNDS) {
        if (abortController.signal.aborted) break;
        rounds++;

        // Load recent messages (sliding window)
        const { rows: recentMessages } = await db.execute({
          sql: `SELECT role, content, tool_calls, tool_call_id, tool_name, attachments
                FROM chat_messages
                WHERE conversation_id = ?
                ORDER BY id DESC
                LIMIT ?`,
          args: [convId, CONTEXT_WINDOW],
        });
        recentMessages.reverse();

        // Resolve image attachment presigned URLs for vision models
        for (const m of recentMessages) {
          if (m.role === "user" && m.attachments) {
            try {
              const atts = typeof m.attachments === "string" ? JSON.parse(m.attachments) : m.attachments;
              const imageAtts = (atts || []).filter((a) => a.mime_type && a.mime_type.startsWith("image/") && a.s3_key);
              if (imageAtts.length > 0 && await isStorageAvailable()) {
                m._imageUrls = [];
                for (const att of imageAtts) {
                  try {
                    const url = await getPresignedUrl(att.s3_key, { expiry: 3600 });
                    m._imageUrls.push(url);
                  } catch {}
                }
              }
            } catch {}
          }
        }

        // Build messages array for AI
        const aiMessages = [
          { role: "system", content: systemPrompt },
          ...recentMessages,
        ];

        // Stream response from AI
        let assistantContent = "";
        const toolCalls = [];
        let roundInputTokens = 0;
        let roundOutputTokens = 0;

        try {
          for await (const event of adapter.chatStream(aiMessages, tools, {
            signal: abortController.signal,
          })) {
            if (abortController.signal.aborted) break;

            switch (event.type) {
              case "content_delta":
                assistantContent += event.text;
                sendEvent("content", { delta: event.text });
                break;

              case "tool_call":
                toolCalls.push({
                  id: event.id,
                  name: event.name,
                  arguments: event.arguments,
                });
                sendEvent("tool_call_start", {
                  id: event.id,
                  name: event.name,
                  arguments: event.arguments,
                });
                break;

              case "done":
                roundInputTokens = event.usage?.input_tokens || 0;
                roundOutputTokens = event.usage?.output_tokens || 0;
                totalInputTokens += roundInputTokens;
                totalOutputTokens += roundOutputTokens;
                break;
            }
          }
        } catch (err) {
          if (abortController.signal.aborted) {
            // Cancelled — save partial content
            if (assistantContent) {
              assistantContent += " [cancelled]";
            }
          } else {
            sendEvent("error", {
              message: err.message,
              code: err.code || "provider_error",
            });
            // Save what we have and exit
            if (assistantContent) {
              await db.execute({
                sql: `INSERT INTO chat_messages (conversation_id, role, content, input_tokens, output_tokens)
                      VALUES (?, 'assistant', ?, ?, ?)`,
                args: [convId, assistantContent, roundInputTokens, roundOutputTokens],
              });
            }
            break;
          }
        }

        // Save assistant message
        if (assistantContent || toolCalls.length > 0) {
          await db.execute({
            sql: `INSERT INTO chat_messages (conversation_id, role, content, tool_calls, input_tokens, output_tokens)
                  VALUES (?, 'assistant', ?, ?, ?, ?)`,
            args: [
              convId,
              assistantContent || null,
              toolCalls.length > 0 ? JSON.stringify(toolCalls.map(tc => ({
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
              }))) : null,
              roundInputTokens,
              roundOutputTokens,
            ],
          });
        }

        // If no tool calls, we're done
        if (toolCalls.length === 0 || abortController.signal.aborted) break;

        // Execute tool calls
        const results = await toolExecutor.executeToolCalls(toolCalls);

        for (const result of results) {
          sendEvent("tool_call_result", {
            id: result.id,
            name: result.name,
            result: result.result,
            isError: result.isError,
          });

          // Save tool result as a message
          await db.execute({
            sql: `INSERT INTO chat_messages (conversation_id, role, content, tool_call_id, tool_name)
                  VALUES (?, 'tool', ?, ?, ?)`,
            args: [convId, result.result, result.id, result.name],
          });
        }

        // Loop back for AI to process tool results
      }

      // Update conversation metadata
      const firstUserMsg = content.trim().slice(0, 100);
      await db.execute({
        sql: `UPDATE chat_conversations
              SET total_tokens = total_tokens + ?,
                  updated_at = datetime('now'),
                  title = CASE WHEN title = 'New conversation' THEN ? ELSE title END
              WHERE id = ?`,
        args: [totalInputTokens + totalOutputTokens, firstUserMsg, convId],
      });

      sendEvent("done", {
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
      });
    } catch (err) {
      try {
        sendEvent("error", { message: err.message, code: "internal_error" });
      } catch {}
    } finally {
      activeGenerations.delete(convId);
      await toolExecutor.close();
      db.close();
      res.end();
    }
  });

  // --- Cancel Generation ---

  router.post("/api/chat/conversations/:id/cancel", (req, res) => {
    const convId = parseInt(req.params.id);
    const controller = activeGenerations.get(convId);
    if (controller) {
      controller.abort();
      activeGenerations.delete(convId);
      res.json({ ok: true, cancelled: true });
    } else {
      res.json({ ok: true, cancelled: false });
    }
  });

  return router;
}

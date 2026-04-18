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
import { openStream } from "../streams/sse.js";
import { resolveProviderConfig } from "../ai/resolve-profile.js";
import { checkVendorSwitch } from "../ai/vendor-guard.js";
import { listProvidersAll } from "../../orchestrator/providers-db.js";
import { chooseProvider as smartRoute, stripSlashCommand, SmartChatDisabled } from "../ai/smart-router.js";

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

  // DB-backed registry view for the Quick Chat picker. Returns only
  // enabled rows, flattened to { id, label, type, models[] } so the
  // client can build provider + model dropdowns without another DB
  // round-trip per selection.
  router.get("/api/chat/registry-providers", async (req, res) => {
    const db = createDbClient();
    try {
      const all = await listProvidersAll(db);
      res.json({
        providers: all
          .filter((p) => !p.disabled)
          .map((p) => ({
            id: p.id,
            host: p.host,
            provider_type: p.provider_type || null,
            models: (p.models || []).map((m) => (typeof m === "string" ? m : m.id)).filter(Boolean),
          })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  // --- AI Profiles ---

  router.get("/api/chat/profiles", async (req, res) => {
    const db = createDbClient();
    try {
      const profiles = await getAiProfiles(db);
      // Enrich pointer-mode profiles with the DB provider row's models list
      // and provider_type, so the client compose-bar picker + profile UI
      // can render the model dropdown without looking up the provider
      // separately. Migrated profiles have `provider` / `models` stripped.
      const registry = await listProvidersAll(db).catch(() => []);
      const byId = new Map(registry.map((p) => [p.id, p]));
      const enriched = profiles.map((p) => {
        if (!p?.provider_id) return p;
        const reg = byId.get(p.provider_id);
        if (!reg) return p;
        const models = Array.isArray(p.models) && p.models.length
          ? p.models
          : (reg.models || []).map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean);
        return {
          ...p,
          provider: p.provider || reg.provider_type || null,
          baseUrl: p.baseUrl || reg.base_url || null,
          models,
        };
      });
      const envConfig = getProviderConfig();
      res.json({
        profiles: enriched,
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
      const result = await testProfileConnection(profile, db);
      res.json(result);
    } finally {
      db.close();
    }
  });

  // --- Conversations CRUD ---

  router.post("/api/chat/conversations", async (req, res) => {
    const db = createDbClient();
    try {
      const { title, system_prompt, profile_id, model, provider: bodyProvider } = req.body || {};

      let provider, convModel, profileId = null;

      if (profile_id) {
        // Path A — Profile-based conversation. Pointer-mode profiles have
        // no direct `provider` field; resolve via DB so conversation.provider
        // carries a vendor label (openai / anthropic / …) that the vendor
        // guard + adapter dispatch can use.
        const profiles = await getAiProfiles(db);
        const profile = profiles.find(p => p.id === profile_id);
        if (!profile) return res.status(400).json({ error: "Unknown profile" });
        if (profile.kind === "auto") {
          // Auto profiles don't carry a provider or model — smart-router
          // resolves both per-message. chat_conversations.{provider,model}
          // are NOT NULL, so write sentinel + empty string; the message-send
          // path's smart_route branch overrides them before adapter dispatch.
          provider = "auto";
          convModel = "";
        } else {
          convModel = model || profile.model_id || profile.defaultModel || "";
          if (profile.provider_id) {
            const cfg = await resolveProviderConfig(db, profile.provider_id, convModel || null).catch(() => null);
            provider = cfg?.provider_type || profile.provider || null;
            if (cfg && !convModel) convModel = cfg.model || "";
          } else {
            provider = profile.provider;
          }
        }
        profileId = profile_id;
      } else if (bodyProvider) {
        // Path B — Quick Chat: body carries provider + model (+ optional system_prompt).
        // `bodyProvider` may be either a provider_type label (legacy: "openai")
        // OR a provider row id (new: "cloud-openai-main"). Accept both; the
        // message-send path resolves the row by either key.
        provider = bodyProvider;
        convModel = model || "";
      } else {
        // Env-based fallback (legacy, kept during the dual-ship window)
        const config = getProviderConfig();
        if (!config) {
          return res.status(400).json({ error: "No AI provider configured. Add an AI Profile or use Quick Chat." });
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

      const { model, provider: newProvider } = req.body || {};
      if (!model || typeof model !== "string" || model.length > 100) {
        return res.status(400).json({ error: "Valid model name required" });
      }

      // Validate model against profile's model list (if profile-based)
      const conv = await db.execute({ sql: "SELECT profile_id, provider FROM chat_conversations WHERE id = ?", args: [id] });
      if (!conv.rows[0]) return res.status(404).json({ error: "Conversation not found" });

      if (conv.rows[0].profile_id) {
        const profiles = await getAiProfiles(db);
        const profile = profiles.find(p => p.id === conv.rows[0].profile_id);
        // Pointer-mode profiles carry no direct `models`; validate against
        // the DB provider row instead. Missing row / empty list ⇒ skip the
        // guard (resolveProviderConfig honors explicit model IDs not in the
        // stored list, matching its tolerant behavior).
        let allowed = Array.isArray(profile?.models) ? profile.models : null;
        if (!allowed && profile?.provider_id) {
          const cfg = await resolveProviderConfig(db, profile.provider_id).catch(() => null);
          // resolveProviderConfig only returns the picked model; fetch the
          // full list via a direct query so the guard can still enforce.
          if (cfg) {
            const { rows: rrows } = await db.execute({
              sql: "SELECT models FROM providers WHERE id = ? AND disabled = 0",
              args: [profile.provider_id],
            });
            try {
              const parsed = JSON.parse(rrows[0]?.models || "[]");
              allowed = parsed.map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean);
            } catch { allowed = null; }
          }
        }
        if (allowed && allowed.length && !allowed.includes(model)) {
          return res.status(400).json({ error: "Model not available in this profile" });
        }
      }

      // Cross-vendor tool-use guard — if caller sends `provider` alongside
      // `model` and the new vendor bucket differs from the conversation's
      // current one, reject when the conversation has active tool_calls.
      if (newProvider && typeof newProvider === "string") {
        const err = await checkVendorSwitch(db, id, conv.rows[0].provider, newProvider);
        if (err) return res.status(400).json(err);
      }

      await db.execute({
        sql: newProvider
          ? "UPDATE chat_conversations SET model = ?, provider = ?, updated_at = datetime('now') WHERE id = ?"
          : "UPDATE chat_conversations SET model = ?, updated_at = datetime('now') WHERE id = ?",
        args: newProvider ? [model, newProvider, id] : [model, id],
      });
      res.json({ ok: true, model, provider: newProvider || conv.rows[0].provider });
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

    // Shared SSE primitive — handles heartbeats, keep-alive, EPIPE, and
    // idempotent close. See servers/gateway/streams/sse.js.
    const { send: sendEvent, close: closeStream } = openStream(res);

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
        closeStream();
        return;
      }
      const conversation = convRows[0];

      // Save user message
      const { content, attachments, model: bodyModel, provider: bodyProvider } = req.body || {};
      if ((!content || typeof content !== "string" || !content.trim()) && (!attachments || !attachments.length)) {
        sendEvent("error", { message: "Message content or attachments required", code: "invalid_input" });
        closeStream();
        return;
      }
      const messageText = (content || "(attachment)").trim();
      const attachJson = attachments && attachments.length > 0 ? JSON.stringify(attachments) : null;

      await db.execute({
        sql: "INSERT INTO chat_messages (conversation_id, role, content, attachments) VALUES (?, 'user', ?, ?)",
        args: [convId, messageText, attachJson],
      });

      // Per-message model override (Path A): body.model wins for THIS
      // assistant turn only — does NOT PATCH conversation.model. Pairs
      // with an optional body.provider so Quick Chats can one-shot a
      // different vendor without sticking. If the proposed vendor
      // differs from the conversation's current vendor AND the history
      // carries active tool_calls, fail with 400 (cross-vendor tool-lock).
      let effectiveModel = (typeof bodyModel === "string" && bodyModel.trim()) ? bodyModel.trim() : conversation.model;
      let effectiveProvider = conversation.provider;
      if (typeof bodyProvider === "string" && bodyProvider.trim()) {
        const guardErr = await checkVendorSwitch(db, convId, conversation.provider, bodyProvider);
        if (guardErr) {
          sendEvent("error", { message: guardErr.message, code: guardErr.code });
          closeStream();
          return;
        }
        effectiveProvider = bodyProvider.trim();
      }

      // Path C — Smart Crow Chat: when the conversation's profile has
      // kind="auto" and the operator has enabled feature_flags.smart_chat,
      // run smart-router.chooseProvider() to pick the route for THIS
      // message. Overrides any Path A body.model (the plan's compose-bar
      // picker is disabled for auto profiles anyway). Gracefully no-ops
      // via SmartChatDisabled when the flag is off.
      let smartRoute_result = null;
      if (conversation.profile_id) {
        try {
          const profilesLookup = await getAiProfiles(db);
          const pf = profilesLookup.find((p) => p.id === conversation.profile_id);
          if (pf?.kind === "auto") {
            const all = await listProvidersAll(db);
            smartRoute_result = await smartRoute({
              db,
              convId,
              content: messageText,
              attachments: attachments || null,
              currentProvider: conversation.provider,
              currentModel: conversation.model,
              autoRules: pf.auto_rules || null,
              providers: all,
            });
            if (smartRoute_result.provider_id) effectiveProvider = smartRoute_result.provider_id;
            if (smartRoute_result.model_id) effectiveModel = smartRoute_result.model_id;
            sendEvent("smart_route", {
              provider_id: smartRoute_result.provider_id,
              model_id: smartRoute_result.model_id,
              reason: smartRoute_result.reason,
            });
          }
        } catch (err) {
          if (err instanceof SmartChatDisabled) {
            // Flag off — stay on conversation.model / profile defaults. No-op.
          } else {
            console.warn(`[chat] smart-router failed for conv ${convId}:`, err.message);
          }
        }
      }

      // Get provider adapter (profile-aware; per-message overrides honored)
      let adapter;
      try {
        const providerDiffers = effectiveProvider && effectiveProvider !== conversation.provider;
        if (providerDiffers) {
          // Path B per-message override OR Path C smart-route picked a
          // different provider — resolve via the DB-first resolver
          // (accepts provider_id or provider_type), fall back to
          // models.json if no DB row matches.
          const cfg = await resolveProviderConfig(db, effectiveProvider, effectiveModel).catch(() => null);
          if (cfg) {
            const { createAdapterFromProfile: fromProfile } = await import("../ai/provider.js");
            // DB rows for bundle-registered local providers (crow-swap-*,
            // crow-chat, crow-dispatch, grackle-*) have provider_type=NULL
            // because their endpoints are OpenAI-compatible (vLLM / llama.cpp)
            // rather than a named SDK. Fall back to "openai" rather than the
            // provider id, which isn't a known adapter key.
            const pseudoProfile = {
              provider: cfg.provider_type || "openai",
              apiKey: cfg.apiKey || "none",
              baseUrl: cfg.baseUrl,
            };
            const result = await fromProfile(pseudoProfile, effectiveModel);
            adapter = result.adapter;
          } else {
            sendEvent("error", { message: `Unknown provider: ${effectiveProvider}`, code: "provider_error" });
            closeStream();
            return;
          }
        } else if (conversation.profile_id) {
          const profiles = await getAiProfiles(db, { includeKeys: true });
          const profile = profiles.find(p => p.id === conversation.profile_id);
          if (!profile) {
            // Profile deleted — fall back to env config
            const result = await createProviderAdapter();
            adapter = result.adapter;
          } else {
            // Pass db so pointer-mode profiles (migrated to provider_id)
            // resolve baseUrl/apiKey from the providers DB table. Direct-
            // mode profiles ignore the db arg and use embedded fields.
            const result = await createAdapterFromProfile(profile, effectiveModel, db);
            adapter = result.adapter;
          }
        } else {
          // No profile: try DB-first resolver on the conversation's
          // provider/model (Quick Chat). Fall back to env on miss.
          const cfg = await resolveProviderConfig(db, effectiveProvider, effectiveModel).catch(() => null);
          if (cfg) {
            const { createAdapterFromProfile: fromProfile } = await import("../ai/provider.js");
            // DB rows for bundle-registered local providers (crow-swap-*,
            // crow-chat, crow-dispatch, grackle-*) have provider_type=NULL
            // because their endpoints are OpenAI-compatible (vLLM / llama.cpp)
            // rather than a named SDK. Fall back to "openai" rather than the
            // provider id, which isn't a known adapter key.
            const pseudoProfile = {
              provider: cfg.provider_type || "openai",
              apiKey: cfg.apiKey || "none",
              baseUrl: cfg.baseUrl,
            };
            const result = await fromProfile(pseudoProfile, effectiveModel);
            adapter = result.adapter;
          } else {
            const result = await createProviderAdapter();
            adapter = result.adapter;
          }
        }
      } catch (err) {
        sendEvent("error", { message: err.message, code: err.code || "provider_error" });
        closeStream();
        return;
      }

      // Warm up on-demand local bundles (vLLM / llama.cpp swap groups).
      // Fast path if already resident; returns null for cloud + peer-hosted
      // providers (no-op). Swap-siblings on the same port are stopped first.
      try {
        const { maybeAcquireLocalProvider } = await import("../gpu-orchestrator.js");
        sendEvent("provider_warming", { provider_id: effectiveProvider });
        const warmed = await maybeAcquireLocalProvider(effectiveProvider);
        if (warmed === false) {
          sendEvent("error", {
            message: `Local provider "${effectiveProvider}" did not become ready in time. Check "docker compose logs" for its bundle.`,
            code: "provider_not_ready",
          });
          closeStream();
          return;
        }
      } catch (err) {
        console.warn(`[chat] gpu-orchestrator acquire(${effectiveProvider}) failed: ${err.message}`);
        // fall through — adapter will surface the real connection error.
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

        // Build messages array for AI. When the smart-router matched on
        // a slash-command, strip the `/code`/`/vision`/etc. prefix from
        // the current user message before it reaches the adapter —
        // the raw prefix stays in chat_messages.content for
        // transparency in the chat log, but the model should see the
        // clean prompt.
        const aiMessages = [
          { role: "system", content: systemPrompt },
          ...recentMessages.map((m) => {
            if (
              smartRoute_result
              && typeof smartRoute_result.reason === "string"
              && /matched \//.test(smartRoute_result.reason)
              && m.role === "user"
              && typeof m.content === "string"
              && m === recentMessages[recentMessages.length - 1]
            ) {
              return { ...m, content: stripSlashCommand(m.content) };
            }
            return m;
          }),
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
                sql: `INSERT INTO chat_messages (conversation_id, role, content, input_tokens, output_tokens, model_id)
                      VALUES (?, 'assistant', ?, ?, ?, ?)`,
                args: [convId, assistantContent, roundInputTokens, roundOutputTokens, effectiveModel || null],
              });
            }
            break;
          }
        }

        // Save assistant message (model_id records which model actually
        // answered — may differ from conversation.model for per-message
        // Path A overrides). NULLable; user-row + tool-row INSERTs
        // elsewhere in this file intentionally leave it unset.
        if (assistantContent || toolCalls.length > 0) {
          await db.execute({
            sql: `INSERT INTO chat_messages (conversation_id, role, content, tool_calls, input_tokens, output_tokens, model_id)
                  VALUES (?, 'assistant', ?, ?, ?, ?, ?)`,
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
              effectiveModel || null,
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
      closeStream();
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

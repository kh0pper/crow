/**
 * Bot Chat API Routes
 *
 * REST endpoints for chatting with CrowClaw bots via OpenClaw agent CLI.
 * Image messages use a vision model pipeline: images are analyzed by the
 * configured vision model (e.g., glm-4.6v), and the description is injected
 * into the agent's context before the CLI call.
 * Protected by dashboard session auth (cookie-based).
 *
 * Routes:
 *   GET  /api/bot-chat/:botId/messages           — Get message history
 *   POST /api/bot-chat/:botId/messages           — Send message, spawn agent turn
 *   GET  /api/bot-chat/:botId/messages/:msgId/status — Poll for agent response
 *   POST /api/bot-chat/:botId/new-session        — Start fresh conversation
 */

import { Router } from "express";
import { execFile, execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, mkdirSync, createWriteStream, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { createDbClient } from "../../db.js";
import { getObject } from "../../storage/s3-client.js";

/** Rate limiter: botId → { count, windowStart } */
const rateLimits = new Map();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_MESSAGE_BYTES = 10 * 1024;

/** Resolve openclaw CLI path — may not be in systemd PATH */
function findOpenclawBin() {
  try {
    return execFileSync("which", ["openclaw"], { encoding: "utf8" }).trim();
  } catch {
    const home = process.env.HOME || "/home/kh0pp";
    const nvmDir = `${home}/.nvm/versions/node`;
    try {
      const versions = readdirSync(nvmDir).sort().reverse();
      for (const v of versions) {
        const p = `${nvmDir}/${v}/bin/openclaw`;
        if (existsSync(p)) return p;
      }
    } catch {}
    return "openclaw";
  }
}
const OPENCLAW_BIN = findOpenclawBin();

/** In-flight agent turns: messageId → { pending: true } or { response: ... } */
const pendingTurns = new Map();

/** MIME extension map for inbound media */
const MIME_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "audio/mpeg": "mp3", "audio/ogg": "ogg", "video/mp4": "mp4", "application/pdf": "pdf" };

/**
 * Download an S3 object to OpenClaw's media inbound directory.
 * Returns the local file path, or null on failure.
 */
async function saveToInbound(configDir, s3Key, mimeType) {
  try {
    const inboundDir = resolve(configDir, "..", "media", "inbound");
    mkdirSync(inboundDir, { recursive: true });

    const ext = MIME_EXT[mimeType] || s3Key.split(".").pop() || "bin";
    const filename = `${randomUUID()}.${ext}`;
    const localPath = resolve(inboundDir, filename);

    const { stream } = await getObject(s3Key);
    await new Promise((res, rej) => {
      const ws = createWriteStream(localPath);
      stream.pipe(ws);
      ws.on("finish", res);
      ws.on("error", rej);
    });

    return localPath;
  } catch (err) {
    console.error("[bot-chat] Failed to save inbound media:", err.message);
    return null;
  }
}

/**
 * Read the bot's vision model config from openclaw.json.
 * Returns { model, provider } from tools.media.models (image capability).
 */
function readVisionModelConfig(configDir) {
  try {
    const configPath = resolve(configDir, "openclaw.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const mediaModels = config.tools?.media?.models || [];
    const imageModel = mediaModels.find(m => m.capabilities?.includes("image"));
    if (imageModel) return { model: imageModel.model, provider: imageModel.provider };
    // Fallback: use agents.defaults.imageModel
    const imgModel = config.agents?.defaults?.imageModel?.primary;
    if (imgModel) {
      const [provider, model] = imgModel.includes("/") ? imgModel.split("/", 2) : [null, imgModel];
      return { model, provider };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the API base URL and key for a vision model provider using Crow's AI profiles.
 * Handles both legacy direct-mode profiles (embedded baseUrl/apiKey) and pointer-mode
 * profiles migrated to the providers DB (resolves via resolveProfileToConfig).
 */
async function resolveVisionApiConfig(provider) {
  const db = createDbClient();
  try {
    const { rows } = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'ai_profiles'",
      args: [],
    });
    if (!rows[0]) return null;
    const profiles = JSON.parse(rows[0].value);
    // Match provider name to profile (zai → Z.AI, etc.)
    const providerMap = { zai: "Z.AI", "qwen-portal": "Dashscope", meta: "Meta AI" };
    const profileName = providerMap[provider] || provider;
    const profile = profiles.find(p => p.name === profileName || p.name?.toLowerCase() === provider);
    if (!profile) return null;
    if (profile.baseUrl && profile.apiKey) {
      return { baseUrl: profile.baseUrl, apiKey: profile.apiKey };
    }
    if (profile.provider_id) {
      const { resolveProfileToConfig } = await import("../ai/resolve-profile.js");
      const cfg = await resolveProfileToConfig(profile, db).catch(() => null);
      if (cfg?.baseUrl && cfg?.apiKey && cfg.apiKey !== "none") {
        return { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Call a vision model to analyze an image file and return a text description.
 * This mirrors OpenClaw's inbound media pipeline: the vision model (e.g., glm-4.6v)
 * generates a description, which gets injected into the agent's context as text.
 * The agent's primary model (e.g., glm-5) doesn't need vision capabilities.
 *
 * @param {string} imagePath - Local image file path
 * @param {string} mimeType - Image MIME type
 * @param {string} baseUrl - Vision model API base URL
 * @param {string} apiKey - API key
 * @param {string} model - Vision model ID
 * @returns {Promise<string>} Text description of the image
 */
async function analyzeImageWithVision(imagePath, mimeType, baseUrl, apiKey, model) {
  const { analyzeImage } = await import("../ai/vision.js");
  const { description } = await analyzeImage({
    providerConfig: { baseUrl, apiKey, model },
    prompt: "Describe this image in detail. Include all visible text, numbers, and relevant information.",
    imagePath,
    mime: mimeType,
    timeoutMs: 60_000,
    maxTokens: 1000,
  });
  return description || "Unable to analyze image.";
}

function checkRateLimit(botId) {
  const now = Date.now();
  let entry = rateLimits.get(botId);
  if (!entry || (now - entry.windowStart) > RATE_LIMIT_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    rateLimits.set(botId, entry);
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

function expandTilde(p) {
  if (p && p.startsWith("~/")) return resolve(process.env.HOME || "/home/kh0pp", p.slice(2));
  return p;
}

export default function botChatRouter(dashboardAuth) {
  const router = Router();

  router.use("/api/bot-chat", dashboardAuth);

  // --- Get bot info (for validation) ---
  async function getBot(db, botId) {
    const { rows } = await db.execute({
      sql: "SELECT id, name, display_name, status, config_dir, gateway_port FROM crowclaw_bots WHERE id = ?",
      args: [botId],
    });
    return rows[0] || null;
  }

  // --- Get message history ---
  router.get("/api/bot-chat/:botId/messages", async (req, res) => {
    const db = createDbClient();
    try {
      const botId = parseInt(req.params.botId);
      if (!botId) return res.status(400).json({ error: "Invalid bot ID" });

      const bot = await getBot(db, botId);
      if (!bot) return res.status(404).json({ error: "Bot not found" });

      const sessionId = req.query.sessionId || null;
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);

      let sql, args;
      if (sessionId) {
        sql = `SELECT id, role, content, tool_name, tool_result, session_id, attachments, created_at
               FROM crowclaw_bot_messages
               WHERE bot_id = ? AND session_id = ?
               ORDER BY id ASC LIMIT ?`;
        args = [botId, sessionId, limit];
      } else {
        // Get latest session's messages
        sql = `SELECT id, role, content, tool_name, tool_result, session_id, attachments, created_at
               FROM crowclaw_bot_messages
               WHERE bot_id = ? AND session_id = (
                 SELECT session_id FROM crowclaw_bot_messages WHERE bot_id = ? ORDER BY id DESC LIMIT 1
               )
               ORDER BY id ASC LIMIT ?`;
        args = [botId, botId, limit];
      }

      const { rows } = await db.execute({ sql, args });
      const messages = rows.map((r) => ({
        ...r,
        attachments: r.attachments ? JSON.parse(r.attachments) : null,
      }));

      res.json({
        bot: { id: bot.id, name: bot.name, displayName: bot.display_name, status: bot.status },
        messages,
        sessionId: messages.length > 0 ? messages[0].session_id : null,
      });
    } catch (err) {
      console.error("[bot-chat] GET messages error:", err.message);
      res.status(500).json({ error: "Failed to load messages" });
    }
  });

  // --- Send message ---
  router.post("/api/bot-chat/:botId/messages", async (req, res) => {
    const db = createDbClient();
    try {
      const botId = parseInt(req.params.botId);
      if (!botId) return res.status(400).json({ error: "Invalid bot ID" });

      const bot = await getBot(db, botId);
      if (!bot) return res.status(404).json({ error: "Bot not found" });
      if (bot.status !== "running") return res.status(409).json({ error: "Bot is not running" });

      if (!checkRateLimit(botId)) {
        return res.status(429).json({ error: "Rate limit exceeded (10 msg/min)" });
      }

      const { content, sessionId: requestedSessionId, attachments } = req.body || {};
      if ((!content || typeof content !== "string") && (!attachments || !attachments.length)) {
        return res.status(400).json({ error: "Message content or attachments required" });
      }
      const messageText = content || "(attachment)";
      if (Buffer.byteLength(messageText, "utf8") > MAX_MESSAGE_BYTES) {
        return res.status(413).json({ error: "Message too large (max 10KB)" });
      }

      // Use provided session ID or get the latest one or create new
      let sessionId = requestedSessionId;
      if (!sessionId) {
        const { rows } = await db.execute({
          sql: "SELECT session_id FROM crowclaw_bot_messages WHERE bot_id = ? ORDER BY id DESC LIMIT 1",
          args: [botId],
        });
        sessionId = rows[0]?.session_id || randomUUID();
      }

      // Save user message (with attachment metadata)
      const attachJson = attachments && attachments.length > 0 ? JSON.stringify(attachments) : null;
      let userMsgId;
      try {
        const insertResult = await db.execute({
          sql: `INSERT INTO crowclaw_bot_messages (bot_id, role, content, session_id, attachments)
                VALUES (?, 'user', ?, ?, ?)`,
          args: [botId, messageText, sessionId, attachJson],
        });
        userMsgId = Number(insertResult.lastInsertRowid);
      } catch (insertErr) {
        console.error("[bot-chat] INSERT failed:", insertErr.message);
        return res.status(500).json({ error: "Failed to save message" });
      }

      // Return immediately with message ID — agent runs in background
      const turnKey = `${botId}:${userMsgId}`;
      pendingTurns.set(turnKey, { pending: true });

      res.json({ messageId: userMsgId, sessionId, status: "processing" });

      // Process attachments: save images to OpenClaw's inbound media dir
      const configDir = expandTilde(bot.config_dir);
      const inboundPaths = [];
      if (attachments && attachments.length > 0) {
        for (const att of attachments) {
          if (att.s3_key && att.mime_type && att.mime_type.startsWith("image/")) {
            const localPath = await saveToInbound(configDir, att.s3_key, att.mime_type);
            if (localPath) inboundPaths.push({ path: localPath, contentType: att.mime_type });
          }
        }
      }

      // Route: WebSocket for image messages (triggers vision pipeline), CLI for text-only
      const hasImages = inboundPaths.length > 0;

      if (hasImages) {
        // --- Vision path: analyze images with vision model, then send enriched text to agent ---
        // This mirrors OpenClaw's inbound media pipeline: the vision model generates a
        // text description that gets prepended to the user's message. The agent's primary
        // model doesn't need vision capabilities.
        const visionConfig = readVisionModelConfig(configDir);
        const apiConfig = visionConfig ? await resolveVisionApiConfig(visionConfig.provider) : null;

        if (!visionConfig || !apiConfig) {
          console.error("[bot-chat] No vision model configured for bot", botId);
          pendingTurns.set(turnKey, { pending: false, error: "Bot vision model not configured" });
          setTimeout(() => pendingTurns.delete(turnKey), 5 * 60 * 1000);
          return;
        }

        // Analyze each image with the vision model, then send to agent via CLI
        (async () => {
          try {
            const descriptions = [];
            for (const { path: imgPath, contentType } of inboundPaths) {
              try {
                const desc = await analyzeImageWithVision(
                  imgPath, contentType, apiConfig.baseUrl, apiConfig.apiKey, visionConfig.model
                );
                descriptions.push(desc);
              } catch (visionErr) {
                console.error("[bot-chat] Vision analysis failed:", visionErr.message);
                descriptions.push("(Image could not be analyzed)");
              }
            }

            // Build enriched message: vision descriptions + original text
            const imageContext = descriptions.map((d, i) =>
              `[Image ${i + 1} analysis]\n${d}`
            ).join("\n\n");
            const agentMessage = `${imageContext}\n\n${messageText}`;

            // Send to agent via CLI with vision context
            const env = { ...process.env, OPENCLAW_CONFIG_PATH: resolve(configDir, "openclaw.json") };

            execFile(
              OPENCLAW_BIN,
              ["agent", "--session-id", sessionId, "--message", agentMessage, "--json"],
              { env, timeout: 120_000, maxBuffer: 1024 * 1024 },
              async (err, stdout, stderr) => {
                try {
                  if (err) {
                    const errMsg = err.killed ? "Agent timed out (120s)" : (stderr || err.message);
                    await db.execute({
                      sql: `INSERT INTO crowclaw_bot_messages (bot_id, role, content, session_id)
                            VALUES (?, 'assistant', ?, ?)`,
                      args: [botId, `Error: ${errMsg}`, sessionId],
                    });
                    pendingTurns.set(turnKey, { pending: false, error: errMsg });
                  } else {
                    let agentResult;
                    try { agentResult = JSON.parse(stdout.trim()); }
                    catch { agentResult = { reply: stdout.trim() || "No response from agent." }; }

                    let replyText;
                    if (agentResult.result?.payloads?.length > 0) {
                      replyText = agentResult.result.payloads.map(p => p.text).filter(Boolean).join("\n\n");
                    }
                    if (!replyText) {
                      replyText = agentResult.reply || agentResult.response || agentResult.content
                        || agentResult.text || (typeof agentResult.message === "string" ? agentResult.message : null)
                        || JSON.stringify(agentResult);
                    }

                    await db.execute({
                      sql: `INSERT INTO crowclaw_bot_messages (bot_id, role, content, session_id)
                            VALUES (?, 'assistant', ?, ?)`,
                      args: [botId, replyText, sessionId],
                    });
                    pendingTurns.set(turnKey, { pending: false, response: replyText });
                  }
                } catch (saveErr) {
                  console.error("[bot-chat] Error saving agent response:", saveErr.message);
                  pendingTurns.set(turnKey, { pending: false, error: "Failed to save response" });
                }
                for (const { path } of inboundPaths) unlink(path).catch(() => {});
                setTimeout(() => pendingTurns.delete(turnKey), 5 * 60 * 1000);
              },
            );
          } catch (err) {
            console.error("[bot-chat] Vision pipeline error:", err.message);
            const errMsg = err.message || "Vision analysis failed";
            await db.execute({
              sql: `INSERT INTO crowclaw_bot_messages (bot_id, role, content, session_id)
                    VALUES (?, 'assistant', ?, ?)`,
              args: [botId, `Error: ${errMsg}`, sessionId],
            });
            pendingTurns.set(turnKey, { pending: false, error: errMsg });
            for (const { path } of inboundPaths) unlink(path).catch(() => {});
            setTimeout(() => pendingTurns.delete(turnKey), 5 * 60 * 1000);
          }
        })();
      } else {
        // --- CLI path: text-only messages (simpler, proven) ---
        let agentMessage = messageText;
        if (attachments && attachments.length > 0 && !hasImages) {
          const sanitize = (s, max) => String(s || "").replace(/[\[\]\n\r]/g, "_").slice(0, max);
          const fileRefs = attachments.map((a) => `[Attached: ${sanitize(a.name, 255)} (${sanitize(a.mime_type, 100)})]`).join("\n");
          agentMessage = `${fileRefs}\n\n${messageText}`;
        }

        const env = { ...process.env, OPENCLAW_CONFIG_PATH: resolve(configDir, "openclaw.json") };

        execFile(
          OPENCLAW_BIN,
          ["agent", "--session-id", sessionId, "--message", agentMessage, "--json"],
          { env, timeout: 120_000, maxBuffer: 1024 * 1024 },
          async (err, stdout, stderr) => {
            try {
              if (err) {
                const errMsg = err.killed ? "Agent timed out (120s)" : (stderr || err.message);
                await db.execute({
                  sql: `INSERT INTO crowclaw_bot_messages (bot_id, role, content, session_id)
                        VALUES (?, 'assistant', ?, ?)`,
                  args: [botId, `Error: ${errMsg}`, sessionId],
                });
                pendingTurns.set(turnKey, { pending: false, error: errMsg });
                setTimeout(() => pendingTurns.delete(turnKey), 5 * 60 * 1000);
                return;
              }

              let agentResult;
              try {
                agentResult = JSON.parse(stdout.trim());
              } catch {
                agentResult = { reply: stdout.trim() || "No response from agent." };
              }

              let replyText;
              if (agentResult.result?.payloads?.length > 0) {
                replyText = agentResult.result.payloads.map(p => p.text).filter(Boolean).join("\n\n");
              }
              if (!replyText) {
                replyText = agentResult.reply
                  || agentResult.response
                  || agentResult.content
                  || agentResult.text
                  || (typeof agentResult.message === "string" ? agentResult.message : null)
                  || JSON.stringify(agentResult);
              }

              if (agentResult.toolCalls && Array.isArray(agentResult.toolCalls)) {
                for (const tc of agentResult.toolCalls) {
                  await db.execute({
                    sql: `INSERT INTO crowclaw_bot_messages (bot_id, role, content, tool_name, tool_result, session_id)
                          VALUES (?, 'tool', NULL, ?, ?, ?)`,
                    args: [botId, tc.name || "tool", JSON.stringify(tc.result || tc.output || "").slice(0, 2000), sessionId],
                  });
                }
              }

              await db.execute({
                sql: `INSERT INTO crowclaw_bot_messages (bot_id, role, content, session_id)
                      VALUES (?, 'assistant', ?, ?)`,
                args: [botId, replyText, sessionId],
              });

              pendingTurns.set(turnKey, { pending: false, response: replyText });
              setTimeout(() => pendingTurns.delete(turnKey), 5 * 60 * 1000);
            } catch (saveErr) {
              console.error("[bot-chat] Error saving agent response:", saveErr.message);
              pendingTurns.set(turnKey, { pending: false, error: "Failed to save response" });
              setTimeout(() => pendingTurns.delete(turnKey), 5 * 60 * 1000);
            }
          },
        );
      }
    } catch (err) {
      console.error("[bot-chat] POST message error:", err.message);
      res.status(500).json({ error: "Failed to send message" });
    }
  });

  // --- Poll for agent response ---
  router.get("/api/bot-chat/:botId/messages/:msgId/status", async (req, res) => {
    const db = createDbClient();
    try {
      const botId = parseInt(req.params.botId);
      const msgId = parseInt(req.params.msgId);
      if (!botId || !msgId) return res.status(400).json({ error: "Invalid IDs" });

      const turnKey = `${botId}:${msgId}`;
      const turn = pendingTurns.get(turnKey);

      if (turn && turn.pending) {
        return res.json({ status: "processing" });
      }

      // Check DB for messages after the user message
      const { rows } = await db.execute({
        sql: `SELECT id, role, content, tool_name, tool_result, session_id, attachments, created_at
              FROM crowclaw_bot_messages
              WHERE bot_id = ? AND id > ?
              ORDER BY id ASC`,
        args: [botId, msgId],
      });

      if (rows.length > 0) {
        pendingTurns.delete(turnKey);
        const messages = rows.map((r) => ({
          ...r,
          attachments: r.attachments ? JSON.parse(r.attachments) : null,
        }));
        return res.json({ status: "complete", messages });
      }

      // Still no response — check if we know about this turn
      if (turn && turn.error) {
        pendingTurns.delete(turnKey);
        return res.json({ status: "error", error: turn.error });
      }

      // Unknown turn or not started yet
      res.json({ status: "processing" });
    } catch (err) {
      console.error("[bot-chat] Poll status error:", err.message);
      res.status(500).json({ error: "Failed to check status" });
    }
  });

  // --- New session ---
  router.post("/api/bot-chat/:botId/new-session", async (req, res) => {
    try {
      const botId = parseInt(req.params.botId);
      if (!botId) return res.status(400).json({ error: "Invalid bot ID" });

      const db = createDbClient();
      const bot = await getBot(db, botId);
      if (!bot) return res.status(404).json({ error: "Bot not found" });

      const sessionId = randomUUID();
      res.json({ sessionId, botId });
    } catch (err) {
      console.error("[bot-chat] New session error:", err.message);
      res.status(500).json({ error: "Failed to create session" });
    }
  });

  // --- List running bots (for Messages panel) ---
  router.get("/api/bot-chat/bots", async (req, res) => {
    const db = createDbClient();
    try {
      const { rows } = await db.execute(
        `SELECT b.id, b.name, b.display_name, b.status, b.gateway_port,
                (SELECT MAX(m.created_at) FROM crowclaw_bot_messages m WHERE m.bot_id = b.id) as last_activity
         FROM crowclaw_bots b
         WHERE b.status = 'running'
         ORDER BY last_activity DESC NULLS LAST`
      );
      res.json({ bots: rows });
    } catch (err) {
      // Table may not exist yet if CrowClaw not installed
      console.error("[bot-chat] List bots error:", err.message);
      res.json({ bots: [] });
    }
  });

  return router;
}

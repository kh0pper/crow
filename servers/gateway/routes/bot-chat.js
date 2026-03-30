/**
 * Bot Chat API Routes
 *
 * REST endpoints for chatting with CrowClaw bots via OpenClaw agent CLI.
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
import { existsSync, readdirSync } from "node:fs";
import { createDbClient } from "../../db.js";

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
        sql = `SELECT id, role, content, tool_name, tool_result, session_id, created_at
               FROM crowclaw_bot_messages
               WHERE bot_id = ? AND session_id = ?
               ORDER BY id ASC LIMIT ?`;
        args = [botId, sessionId, limit];
      } else {
        // Get latest session's messages
        sql = `SELECT id, role, content, tool_name, tool_result, session_id, created_at
               FROM crowclaw_bot_messages
               WHERE bot_id = ? AND session_id = (
                 SELECT session_id FROM crowclaw_bot_messages WHERE bot_id = ? ORDER BY id DESC LIMIT 1
               )
               ORDER BY id ASC LIMIT ?`;
        args = [botId, botId, limit];
      }

      const { rows } = await db.execute({ sql, args });

      res.json({
        bot: { id: bot.id, name: bot.name, displayName: bot.display_name, status: bot.status },
        messages: rows,
        sessionId: rows.length > 0 ? rows[0].session_id : null,
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

      const { content, sessionId: requestedSessionId } = req.body || {};
      if (!content || typeof content !== "string") {
        return res.status(400).json({ error: "Message content required" });
      }
      if (Buffer.byteLength(content, "utf8") > MAX_MESSAGE_BYTES) {
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

      // Save user message
      let userMsgId;
      try {
        const insertResult = await db.execute({
          sql: `INSERT INTO crowclaw_bot_messages (bot_id, role, content, session_id)
                VALUES (?, 'user', ?, ?)`,
          args: [botId, content, sessionId],
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

      // Spawn agent turn in background
      const configDir = expandTilde(bot.config_dir);
      const env = { ...process.env, OPENCLAW_CONFIG_PATH: resolve(configDir, "openclaw.json") };

      execFile(
        OPENCLAW_BIN,
        ["agent", "--session-id", sessionId, "--message", content, "--json"],
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
              return;
            }

            // Parse JSON output from openclaw agent --json (pretty-printed multi-line JSON)
            let agentResult;
            try {
              agentResult = JSON.parse(stdout.trim());
            } catch {
              // Fallback: treat entire stdout as plain text response
              agentResult = { reply: stdout.trim() || "No response from agent." };
            }

            // Extract response text from openclaw agent --json structure:
            // { result: { payloads: [{ text: "...", mediaUrl: ... }] } }
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

            // Save tool calls if present
            if (agentResult.toolCalls && Array.isArray(agentResult.toolCalls)) {
              for (const tc of agentResult.toolCalls) {
                await db.execute({
                  sql: `INSERT INTO crowclaw_bot_messages (bot_id, role, content, tool_name, tool_result, session_id)
                        VALUES (?, 'tool', NULL, ?, ?, ?)`,
                  args: [botId, tc.name || "tool", JSON.stringify(tc.result || tc.output || "").slice(0, 2000), sessionId],
                });
              }
            }

            // Save assistant response
            await db.execute({
              sql: `INSERT INTO crowclaw_bot_messages (bot_id, role, content, session_id)
                    VALUES (?, 'assistant', ?, ?)`,
              args: [botId, replyText, sessionId],
            });

            pendingTurns.set(turnKey, { pending: false, response: replyText });

            // Clean up old pending turns after 5 minutes
            setTimeout(() => pendingTurns.delete(turnKey), 5 * 60 * 1000);
          } catch (saveErr) {
            console.error("[bot-chat] Error saving agent response:", saveErr.message);
            pendingTurns.set(turnKey, { pending: false, error: "Failed to save response" });
          }
        },
      );
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
        sql: `SELECT id, role, content, tool_name, tool_result, session_id, created_at
              FROM crowclaw_bot_messages
              WHERE bot_id = ? AND id > ?
              ORDER BY id ASC`,
        args: [botId, msgId],
      });

      if (rows.length > 0) {
        pendingTurns.delete(turnKey);
        return res.json({ status: "complete", messages: rows });
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

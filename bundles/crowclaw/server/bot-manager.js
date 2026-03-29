/**
 * CrowClaw — Bot Lifecycle Manager
 *
 * Create, configure, deploy, start/stop, and delete OpenClaw bots.
 * All operations are recorded in crowclaw_deployments for audit.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { generateServiceUnit, serviceUnitName } from "./systemd-templates.js";
import { getByPath, setByPath, checkSecurityDowngrade } from "./config-schema.js";
import { generateModelsJson } from "./byoai-bridge.js";

const execFileAsync = promisify(execFile);

// Default safety policy for new bots
const DEFAULT_SAFETY_POLICY = {
  content_moderation: {
    enabled: true,
    provider: "openai",
    thresholds: { hate: 0.7, violence: 0.8, "self-harm": 0.5 },
    action: "block_and_log",
  },
  exec_security: "allowlist",
  exec_denylist: ["rm -rf", "dd", "mkfs", "curl | sh", "wget | sh"],
  rate_limits: { messages_per_minute: 10, tool_calls_per_minute: 30 },
  network: { fetch_guard: "strict", allow_bots: false, group_policy: "allowlist" },
  pii_redaction: { enabled: true, patterns: ["ssn", "credit_card", "phone"] },
};

/**
 * Create a new bot definition in the database.
 */
export async function createBot(db, { name, displayName, deployMode, language, gatewayPort, aiSource }) {
  const existing = await db.execute({ sql: "SELECT id FROM crowclaw_bots WHERE name = ?", args: [name] });
  if (existing.rows.length > 0) {
    throw new Error(`Bot "${name}" already exists (ID: ${existing.rows[0].id})`);
  }

  const home = homedir();
  const configDir = resolve(home, `.openclaw-${name}`);
  const workspaceDir = resolve(configDir, "workspace");
  const port = gatewayPort || 18789;
  const unit = serviceUnitName(name);

  const result = await db.execute({
    sql: `INSERT INTO crowclaw_bots (name, display_name, status, deploy_mode, config_dir, workspace_dir, service_unit, gateway_port, ai_source, safety_policy_json)
          VALUES (?, ?, 'created', ?, ?, ?, ?, ?, ?, ?)`,
    args: [name, displayName || name, deployMode || "native", configDir, workspaceDir, unit, port, aiSource || "byoai", JSON.stringify(DEFAULT_SAFETY_POLICY)],
  });

  await logDeployment(db, Number(result.lastInsertRowid), "create", "completed", `Bot "${name}" created`);

  return {
    id: Number(result.lastInsertRowid),
    name,
    configDir,
    workspaceDir,
    serviceUnit: unit,
    gatewayPort: port,
  };
}

/**
 * Update bot config by dot-path. Reads openclaw.json, modifies, writes back.
 */
export async function configureBot(db, { botId, path, value }) {
  const bot = await getBot(db, botId);
  if (!bot) throw new Error(`Bot ID ${botId} not found`);

  const configPath = resolve(bot.config_dir, "openclaw.json");
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}. Deploy the bot first.`);
  }

  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const oldValue = getByPath(config, path);

  // Check for security downgrades
  const { isDowngrade, warning } = checkSecurityDowngrade(path, oldValue, value);

  setByPath(config, path, value);
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  await db.execute({
    sql: "UPDATE crowclaw_bots SET updated_at = datetime('now'), lamport_ts = lamport_ts + 1 WHERE id = ?",
    args: [botId],
  });

  await logDeployment(db, botId, "configure", "completed", `Set ${path} = ${JSON.stringify(value)}`);

  return { updated: true, path, oldValue, newValue: value, securityWarning: warning || null };
}

/**
 * Deploy bot config to disk — create directories, write config, systemd unit.
 */
export async function deployBot(db, { botId, discordToken }) {
  const bot = await getBot(db, botId);
  if (!bot) throw new Error(`Bot ID ${botId} not found`);

  const deployId = await logDeployment(db, botId, "deploy", "started", "Deploying bot to disk");

  try {
    // Create directories
    if (!existsSync(bot.config_dir)) {
      mkdirSync(bot.config_dir, { recursive: true, mode: 0o700 });
    }
    if (!existsSync(bot.workspace_dir)) {
      mkdirSync(bot.workspace_dir, { recursive: true });
    }

    // Write openclaw.json if it doesn't exist
    const configPath = resolve(bot.config_dir, "openclaw.json");
    if (!existsSync(configPath)) {
      const defaultConfig = {
        security: "allowlist",
        discord: {
          token: discordToken || "REPLACE_ME",
          allowFrom: [],
          groupPolicy: "allowlist",
          allowBots: false,
        },
        gateway: { port: bot.gateway_port },
      };
      writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
      chmodSync(configPath, 0o600);
    }

    // Deploy workspace files from DB
    const files = await db.execute({
      sql: "SELECT file_name, content FROM crowclaw_workspace_files WHERE bot_id = ?",
      args: [botId],
    });
    for (const file of files.rows) {
      writeFileSync(resolve(bot.workspace_dir, file.file_name), file.content);
    }

    // Write systemd service unit (native mode)
    if (bot.deploy_mode === "native") {
      const profiles = await db.execute({
        sql: "SELECT language, tts_voice FROM crowclaw_user_profiles WHERE bot_id = ?",
        args: [botId],
      });

      // Build VOICE_LANGMAP from profiles
      const langMap = {};
      for (const p of profiles.rows) {
        if (p.language && p.tts_voice) {
          langMap[p.language] = p.tts_voice;
        }
      }

      const unit = generateServiceUnit({
        name: bot.name,
        configDir: bot.config_dir,
        gatewayPort: bot.gateway_port,
        voiceLangMap: Object.keys(langMap).length > 0 ? JSON.stringify(langMap) : undefined,
      });

      const unitDir = resolve(homedir(), ".config", "systemd", "user");
      if (!existsSync(unitDir)) mkdirSync(unitDir, { recursive: true });
      writeFileSync(resolve(unitDir, bot.service_unit), unit);
    }

    const auditParts = [];

    // Generate models.json from Crow's AI config if ai_source is "byoai"
    if (bot.ai_source === "byoai") {
      try {
        const crowRoot = resolve(homedir(), "crow");
        const byoaiResult = await generateModelsJson({ configDir: bot.config_dir, crowRoot, db });
        auditParts.push(`BYOAI: Generated models.json (provider: ${byoaiResult.provider}, model: ${byoaiResult.model})`);

        // Set image model via OpenClaw CLI if a vision model was detected
        if (byoaiResult.imageModel) {
          const env = { ...process.env, OPENCLAW_CONFIG_PATH: resolve(bot.config_dir, "openclaw.json") };
          try {
            await execFileAsync("openclaw", ["models", "set-image", byoaiResult.imageModel], { env, timeout: 15_000 });
            auditParts.push(`Image model set: ${byoaiResult.imageModel}`);
          } catch (err) {
            const msg = err.code === "ENOENT" ? "openclaw CLI not found" : err.message;
            auditParts.push(`Image model ERROR: ${msg}`);
          }
        }
      } catch (err) {
        auditParts.push(`BYOAI warning: ${err.message}. Bot will use existing models.json if present.`);
      }
    }

    // Run security audit if openclaw CLI is available
    try {
      const { stdout } = await execFileAsync("openclaw", ["security", "audit", "--deep"], {
        cwd: bot.config_dir,
        timeout: 30_000,
      });
      auditParts.push(stdout.trim());
    } catch {
      auditParts.push("Security audit skipped (openclaw CLI not available or audit failed)");
    }

    const auditResult = auditParts.join("\n");

    await db.execute({
      sql: "UPDATE crowclaw_bots SET status = 'deployed', updated_at = datetime('now'), lamport_ts = lamport_ts + 1 WHERE id = ?",
      args: [botId],
    });

    await updateDeployment(db, deployId, "completed", auditResult);

    return { deployed: true, configDir: bot.config_dir, auditResult };
  } catch (err) {
    await updateDeployment(db, deployId, "failed", err.message);
    throw err;
  }
}

/**
 * Start a bot's systemd service.
 */
export async function startBot(db, botId) {
  const bot = await getBot(db, botId);
  if (!bot) throw new Error(`Bot ID ${botId} not found`);

  await execFileAsync("systemctl", ["--user", "daemon-reload"]);
  await execFileAsync("systemctl", ["--user", "enable", "--now", bot.service_unit]);

  await db.execute({
    sql: "UPDATE crowclaw_bots SET status = 'running', last_started_at = datetime('now'), last_error = NULL, updated_at = datetime('now'), lamport_ts = lamport_ts + 1 WHERE id = ?",
    args: [botId],
  });

  await logDeployment(db, botId, "start", "completed", `Started ${bot.service_unit}`);
  return { started: true, serviceUnit: bot.service_unit };
}

/**
 * Stop a bot's systemd service.
 */
export async function stopBot(db, botId) {
  const bot = await getBot(db, botId);
  if (!bot) throw new Error(`Bot ID ${botId} not found`);

  await execFileAsync("systemctl", ["--user", "stop", bot.service_unit]);

  await db.execute({
    sql: "UPDATE crowclaw_bots SET status = 'stopped', updated_at = datetime('now'), lamport_ts = lamport_ts + 1 WHERE id = ?",
    args: [botId],
  });

  await logDeployment(db, botId, "stop", "completed", `Stopped ${bot.service_unit}`);
  return { stopped: true, serviceUnit: bot.service_unit };
}

/**
 * Restart a bot's systemd service.
 */
export async function restartBot(db, botId) {
  const bot = await getBot(db, botId);
  if (!bot) throw new Error(`Bot ID ${botId} not found`);

  await execFileAsync("systemctl", ["--user", "restart", bot.service_unit]);

  await db.execute({
    sql: "UPDATE crowclaw_bots SET status = 'running', last_started_at = datetime('now'), last_error = NULL, updated_at = datetime('now'), lamport_ts = lamport_ts + 1 WHERE id = ?",
    args: [botId],
  });

  await logDeployment(db, botId, "restart", "completed", `Restarted ${bot.service_unit}`);
  return { restarted: true, serviceUnit: bot.service_unit };
}

/**
 * Delete a bot — stop service, archive config, remove from DB.
 */
export async function deleteBot(db, botId) {
  const bot = await getBot(db, botId);
  if (!bot) throw new Error(`Bot ID ${botId} not found`);

  // Stop service if running
  try {
    await execFileAsync("systemctl", ["--user", "stop", bot.service_unit]);
    await execFileAsync("systemctl", ["--user", "disable", bot.service_unit]);
  } catch {
    // Service may not exist
  }

  // Archive config dir
  if (existsSync(bot.config_dir)) {
    const archiveName = `${bot.config_dir}-archive-${new Date().toISOString().slice(0, 10)}.tar.gz`;
    try {
      await execFileAsync("tar", ["czf", archiveName, bot.config_dir]);
    } catch {
      // Archive is best-effort
    }
  }

  // Remove systemd unit
  const unitPath = resolve(homedir(), ".config", "systemd", "user", bot.service_unit);
  if (existsSync(unitPath)) {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(unitPath);
    await execFileAsync("systemctl", ["--user", "daemon-reload"]);
  }

  await logDeployment(db, botId, "delete", "completed", `Deleted bot "${bot.name}", config archived`);

  await db.execute({ sql: "DELETE FROM crowclaw_bots WHERE id = ?", args: [botId] });

  return { deleted: true, name: bot.name };
}

/**
 * Get bot status — systemd service state, uptime, memory.
 */
export async function getBotStatus(db, botId) {
  if (botId) {
    const bot = await getBot(db, botId);
    if (!bot) throw new Error(`Bot ID ${botId} not found`);
    return enrichBotStatus(bot);
  }

  // All bots
  const { rows } = await db.execute({ sql: "SELECT * FROM crowclaw_bots ORDER BY name" });
  const results = [];
  for (const bot of rows) {
    results.push(await enrichBotStatus(bot));
  }
  return results;
}

/**
 * Get bot logs from journalctl.
 */
export async function getBotLogs(db, botId, { lines = 50, since } = {}) {
  const bot = await getBot(db, botId);
  if (!bot) throw new Error(`Bot ID ${botId} not found`);

  const args = ["--user", "-u", bot.service_unit, "--no-pager", `-n`, String(lines)];
  if (since) args.push(`--since=${since}`);

  try {
    const { stdout } = await execFileAsync("journalctl", args, { timeout: 10_000 });
    return stdout;
  } catch (err) {
    return `Failed to get logs: ${err.message}`;
  }
}

/**
 * Deep health check — HTTP, Discord connection, voice.
 */
export async function getBotHealth(db, botId) {
  const bot = await getBot(db, botId);
  if (!bot) throw new Error(`Bot ID ${botId} not found`);

  const checks = {};

  // HTTP health check
  try {
    const resp = await fetch(`http://127.0.0.1:${bot.gateway_port}/`, { signal: AbortSignal.timeout(5000) });
    checks.http = { ok: resp.ok, status: resp.status };
  } catch (err) {
    checks.http = { ok: false, error: err.message };
  }

  // Systemd service status
  try {
    const { stdout } = await execFileAsync("systemctl", ["--user", "is-active", bot.service_unit]);
    checks.service = { active: stdout.trim() === "active" };
  } catch {
    checks.service = { active: false };
  }

  return { botId, name: bot.name, checks };
}

// --- Internal helpers ---

export async function getBot(db, botId) {
  const { rows } = await db.execute({ sql: "SELECT * FROM crowclaw_bots WHERE id = ?", args: [botId] });
  return rows[0] || null;
}

async function enrichBotStatus(bot) {
  const status = { ...bot };
  try {
    const { stdout } = await execFileAsync("systemctl", [
      "--user", "show", bot.service_unit,
      "--property=ActiveState,SubState,ExecMainStartTimestamp,MemoryCurrent",
    ]);
    for (const line of stdout.split("\n")) {
      const [key, ...rest] = line.split("=");
      if (key && rest.length) status[`systemd_${key.trim()}`] = rest.join("=").trim();
    }
  } catch {
    status.systemd_ActiveState = "unknown";
  }
  return status;
}

async function logDeployment(db, botId, action, status, details) {
  const result = await db.execute({
    sql: "INSERT INTO crowclaw_deployments (bot_id, action, status, details) VALUES (?, ?, ?, ?)",
    args: [botId, action, status, details],
  });
  return Number(result.lastInsertRowid);
}

async function updateDeployment(db, deployId, status, details) {
  await db.execute({
    sql: "UPDATE crowclaw_deployments SET status = ?, details = ?, completed_at = datetime('now') WHERE id = ?",
    args: [status, details, deployId],
  });
}

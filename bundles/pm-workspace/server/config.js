/**
 * PM Workspace — configuration loader.
 *
 * Layered, lowest to highest precedence:
 *   1. $CROW_HOME/env/pm-workspace.env  (KEY=VALUE lines)
 *   2. $PM_SECRETS_FILE                 (same format, if set)
 *   3. process.env                      (always wins)
 *
 * File format: one KEY=VALUE per line. Blank lines and lines starting
 * with '#' are ignored. A leading "export " is stripped, and values may
 * be wrapped in single or double quotes (stripped).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function crowHome() {
  return process.env.CROW_HOME || join(homedir(), ".crow");
}

/** Parse a KEY=VALUE env file into a plain object. Missing file → {}. */
export function parseEnvFile(path) {
  const out = {};
  try {
    if (!path || !existsSync(path)) return out;
    const text = readFileSync(path, "utf8");
    for (const rawLine of text.split("\n")) {
      let line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("export ")) line = line.slice("export ".length).trim();
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      ) {
        value = value.slice(1, -1);
      }
      if (key) out[key] = value;
    }
  } catch (err) {
    console.warn(`[pm-workspace] Failed to read env file ${path}: ${err.message}`);
  }
  return out;
}

const KEYS = [
  "PM_SECRETS_FILE",
  "PM_RUN_CRON",
  "OCR_VISION_URL",
  "OCR_VISION_MODEL",
  "OCR_VISION_API_KEY",
  "PM_EMBED_URL",
  "PM_EMBED_MODEL",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "DIGEST_TO",
  "DIGEST_CRON",
  "SYNC_CRON",
  "MONDAY_TOKEN",
  "SYNC_CONFIG_FILE",
  "NTFY_TOPIC",
  "NTFY_URL",
  "GOOGLE_TOKEN_FILE",
  "OUTLOOK_INGEST_URL",
  "OUTLOOK_INGEST_TOKEN",
  "OUTLOOK_INGEST_MAX_AGE_MIN",
  "OUTLOOK_DRIVE_FOLDER_ID",
  "OUTLOOK_TZ",
  "PLANNER_DRIVE_FOLDER_ID",
  "PLANNER_CATEGORY",
  "PLANNER_CRON",
  "CROW_GATEWAY_URL",
  "CROW_GATEWAY_ALT_URLS",
  "CROW_TASKS_DB_PATH",
  "CROW_DATA_DIR",
  "CROW_DB_PATH",
];

/**
 * Build the effective config. Re-reads files on every call so long-lived
 * processes see edits without restart (calls are infrequent — digest/sync
 * runs and tool invocations).
 */
export function loadConfig() {
  const base = parseEnvFile(join(crowHome(), "env", "pm-workspace.env"));
  // Secrets file may be named by process.env or by the base env file.
  const secretsPath = process.env.PM_SECRETS_FILE || base.PM_SECRETS_FILE || null;
  const secrets = parseEnvFile(secretsPath);

  const merged = { ...base, ...secrets };
  for (const k of KEYS) {
    if (process.env[k] !== undefined && process.env[k] !== "") merged[k] = process.env[k];
  }

  return {
    ...merged,
    // Defaults
    DIGEST_CRON: merged.DIGEST_CRON || "0 7 * * *",
    SYNC_CRON: merged.SYNC_CRON || "*/15 * * * *",
    SMTP_PORT: merged.SMTP_PORT || "587",
    PLANNER_CRON: merged.PLANNER_CRON || "*/15 * * * *",
    OCR_VISION_API_KEY: merged.OCR_VISION_API_KEY || "none",
    NTFY_URL: merged.NTFY_URL || "https://ntfy.sh",
  };
}

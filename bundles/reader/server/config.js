/**
 * Reader — configuration loader.
 *
 * Layered, lowest to highest precedence:
 *   1. $CROW_HOME/env/reader.env         (KEY=VALUE lines)
 *   2. $READER_SECRETS_FILE              (same format, if set)
 *   3. process.env                       (always wins)
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
    console.warn(`[reader] Failed to read env file ${path}: ${err.message}`);
  }
  return out;
}

const KEYS = [
  "READER_SECRETS_FILE",
  "READER_EMBED_URL",
  "READER_EMBED_MODEL",
  "GOOGLE_TOKEN_FILE",
  "READER_EXPORT_DRIVE_FOLDER_ID",
  "READER_UV_BIN",
  "READER_EXTRACT_TIMEOUT_MS",
  "READER_MAX_UPLOAD_MB",
  "READER_AUDIO_CACHE_MB",
  "READER_ALLOW_PRIVATE_URLS",
  "READER_INGEST_ROOTS",
  "CROW_DATA_DIR",
  "CROW_DB_PATH",
];

/**
 * Build the effective config. Re-reads files on every call so long-lived
 * processes see edits without restart (calls are infrequent — tool invocations).
 */
export function loadConfig() {
  const base = parseEnvFile(join(crowHome(), "env", "reader.env"));
  // Secrets file may be named by process.env or by the base env file.
  const secretsPath = process.env.READER_SECRETS_FILE || base.READER_SECRETS_FILE || null;
  const secrets = parseEnvFile(secretsPath);

  const merged = { ...base, ...secrets };
  for (const k of KEYS) {
    if (process.env[k] !== undefined && process.env[k] !== "") merged[k] = process.env[k];
  }

  return {
    ...merged,
    // Defaults
    READER_UV_BIN: merged.READER_UV_BIN || "uv",
    READER_EXTRACT_TIMEOUT_MS: merged.READER_EXTRACT_TIMEOUT_MS || "180000",
    READER_MAX_UPLOAD_MB: merged.READER_MAX_UPLOAD_MB || "50",
    READER_AUDIO_CACHE_MB: merged.READER_AUDIO_CACHE_MB || "2048",
  };
}

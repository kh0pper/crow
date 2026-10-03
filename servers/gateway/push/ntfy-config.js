/**
 * ntfy push config — where this instance publishes, and what a paired app gets.
 *
 * DB-FREE on purpose: the corruption breaker (shared/cross-host-auth.js) and the
 * migration guard call sendNtfyNotification directly because crow.db may be
 * malformed; the config they need must not live in that DB. Design note:
 * docs/superpowers/specs/2026-10-03-ntfy-autowire-design.md.
 *
 * Two sources:
 *   env  — NTFY_TOPIC is set: everything behaves exactly as before this module existed.
 *   auto — $CROW_DATA_DIR/ntfy-push.json (0600), written by ntfy-provision.js.
 *          NTFY_HOST / NTFY_PORT / NTFY_EXTERNAL_URL / NTFY_EXTRA_TOPICS still
 *          override field by field.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync, renameSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

/**
 * Atomic 0600 write (same contract as bundle-env-secrets.js writePrivateFile, kept local
 * so the push path does not import the keychain's argon2 module).
 */
function writePrivateFile(path, content) {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export const CONFIG_FILE = "ntfy-push.json";
export const STATUS_FILE = "ntfy-push-status.json";

/** Same resolution as the instance-id file (instance-registry.js) — one dir per instance. */
export function ntfyDataDir(env = process.env) {
  return env.CROW_DATA_DIR ? resolve(env.CROW_DATA_DIR) : resolve(homedir(), ".crow", "data");
}

export function ntfyConfigPath(env = process.env) {
  return join(ntfyDataDir(env), CONFIG_FILE);
}

export function ntfyStatusPath(env = process.env) {
  return join(ntfyDataDir(env), STATUS_FILE);
}

function readJson(path) {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** The stored auto config, or null (missing, unreadable, or not a usable record). */
export function readStoredNtfyConfig(env = process.env) {
  const c = readJson(ntfyConfigPath(env));
  if (!c || typeof c.topic !== "string" || !c.topic) return null;
  return c;
}

export function writeStoredNtfyConfig(cfg, env = process.env) {
  mkdirSync(ntfyDataDir(env), { recursive: true, mode: 0o700 });
  writePrivateFile(ntfyConfigPath(env), JSON.stringify(cfg, null, 2) + "\n");
}

export function removeStoredNtfyConfig(env = process.env) {
  rmSync(ntfyConfigPath(env), { force: true });
}

/**
 * Validate a phone-facing server address. Returns the normalized origin(+path), "" for
 * empty (= clear the setting), or null when unusable.
 */
export function normalizeExternalUrl(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (s.length > 300) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || u.search || u.hash) return null;
  return (u.origin + u.pathname).replace(/\/+$/, "");
}

/** NTFY_EXTERNAL_URL → stored setting → gateway URL host + ntfy port (the pre-autowire derivation). */
function resolveExternalUrl({ env, stored, port }) {
  if (env.NTFY_EXTERNAL_URL) return env.NTFY_EXTERNAL_URL;
  if (stored) return stored;
  const gatewayUrl = env.CROW_GATEWAY_URL;
  if (!gatewayUrl) return null;
  try {
    const parsed = new URL(gatewayUrl);
    parsed.port = String(port);
    return parsed.origin;
  } catch {
    return null;
  }
}

function extraTopics(env, primary) {
  return [...new Set(String(env.NTFY_EXTRA_TOPICS || "")
    .split(",").map((t) => t.trim()).filter((t) => t.length > 0 && t !== primary))];
}

/**
 * Resolve the effective config, or null when push is not configured.
 *
 * @returns {null | {
 *   source: "env"|"auto", topic: string, topics: string[],
 *   publishHost: string, publishPort: string, publishToken: string|null,
 *   subscriberToken: string|null, externalUrl: string|null, storedExternalUrl: string,
 * }}
 */
export function resolveNtfyConfig(env = process.env) {
  if (env.NTFY_TOPIC) {
    const port = env.NTFY_PORT || "2586";
    const publishToken = env.NTFY_AUTH_TOKEN || null;
    return {
      source: "env",
      topic: env.NTFY_TOPIC,
      topics: [env.NTFY_TOPIC, ...extraTopics(env, env.NTFY_TOPIC)],
      publishHost: env.NTFY_HOST || "localhost",
      publishPort: port,
      publishToken,
      // Unchanged behavior: an env host hands NTFY_AUTH_TOKEN to apps unless it sets a
      // separate read-only NTFY_SUBSCRIBER_TOKEN.
      subscriberToken: env.NTFY_SUBSCRIBER_TOKEN || publishToken,
      externalUrl: resolveExternalUrl({ env, stored: null, port }),
      storedExternalUrl: "",
    };
  }
  const c = readStoredNtfyConfig(env);
  if (!c) return null;
  const port = env.NTFY_PORT || String(c.port || "2586");
  const stored = typeof c.externalUrl === "string" ? c.externalUrl : "";
  return {
    source: "auto",
    topic: c.topic,
    topics: [c.topic, ...extraTopics(env, c.topic)],
    publishHost: env.NTFY_HOST || c.host || "localhost",
    publishPort: port,
    publishToken: c.publisherToken || null,
    subscriberToken: c.subscriberToken || null,
    externalUrl: resolveExternalUrl({ env, stored, port }),
    storedExternalUrl: stored,
  };
}

/** Best-effort status record (last push, last app fetch). Never throws. */
export function readNtfyStatus(env = process.env) {
  return readJson(ntfyStatusPath(env)) || {};
}

export function recordNtfyStatus(patch, env = process.env) {
  try {
    const next = { ...readNtfyStatus(env), ...patch };
    mkdirSync(ntfyDataDir(env), { recursive: true, mode: 0o700 });
    writePrivateFile(ntfyStatusPath(env), JSON.stringify(next) + "\n");
  } catch {
    // Status is advisory — a full disk or read-only dir must never affect a send.
  }
}

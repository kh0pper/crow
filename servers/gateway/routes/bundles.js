/**
 * Add-on API Routes — Install, uninstall, start, stop, status
 *
 * Supports all add-on types:
 *   - bundle:     Docker Compose services (pull images, start/stop containers)
 *   - mcp-server: External MCP servers (register in ~/.crow/mcp-addons.json)
 *   - skill:      Markdown skill files (copy to ~/.crow/skills/)
 *   - panel:      Dashboard panels (copy to ~/.crow/panels/, register in panels.json)
 *
 * POST /bundles/api/install   — Install an add-on
 * POST /bundles/api/uninstall — Remove an add-on
 * POST /bundles/api/start     — Start bundle containers (Docker only)
 * POST /bundles/api/stop      — Stop bundle containers (Docker only)
 * GET  /bundles/api/status    — Get status of all installed add-ons
 * POST /bundles/api/env       — Save env vars for an add-on
 * GET  /bundles/api/jobs/:id  — Poll install job progress
 */

import { Router } from "express";
import { createNotification } from "../../shared/notifications.js";
import { createDbClient } from "../../db.js";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, copyFileSync, unlinkSync, symlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { checkInstall as checkHardwareGate } from "../hardware-gate.js";
import { checkGpuArchCompatible } from "../gpu-arch.js";

// PR 0: Consent token configuration (server-validated, race-safe install consent)
const CONSENT_TOKEN_TTL_SECONDS = 15 * 60; // 15 min — covers slow image pulls
const CONSENT_TOKEN_SCHEMA_VERSION = 1;

const __dirname = dirname(fileURLToPath(import.meta.url));
const CROW_HOME = join(homedir(), ".crow");
const BUNDLES_DIR = join(CROW_HOME, "bundles");
const SKILLS_DIR = join(CROW_HOME, "skills");
const PANELS_DIR = join(CROW_HOME, "panels");
const MCP_ADDONS_PATH = join(CROW_HOME, "mcp-addons.json");
const PANELS_CONFIG_PATH = join(CROW_HOME, "panels.json");
const INSTALLED_PATH = join(CROW_HOME, "installed.json");
const APP_ROOT = resolve(__dirname, "../../..");
const APP_BUNDLES = join(APP_ROOT, "bundles");
const APP_ENV_PATH = join(APP_ROOT, ".env");

function resolvePanelPath(manifest, bundleId) {
  if (!manifest?.panel) return null;
  if (typeof manifest.panel === "string") return manifest.panel;
  const panelId = manifest.panel.id || bundleId;
  return `panel/${panelId}.js`;
}

// In-memory job tracking (simple — no DB table needed for MVP)
const jobs = new Map();
let jobCounter = 0;

function createJob(bundleId, action) {
  const id = String(++jobCounter);
  const job = {
    id,
    bundleId,
    action,
    status: "running",
    log: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  jobs.set(id, job);
  // Clean up old jobs after 10 minutes
  setTimeout(() => jobs.delete(id), 600_000);
  return job;
}

function appendLog(job, line) {
  job.log.push(line);
}

function finishJob(job, status) {
  job.status = status;
  job.completedAt = new Date().toISOString();
}

/** Read installed.json as array */
function getInstalled() {
  try {
    if (existsSync(INSTALLED_PATH)) {
      const data = JSON.parse(readFileSync(INSTALLED_PATH, "utf8"));
      return Array.isArray(data) ? data : Object.entries(data).map(([id, v]) => ({ id, ...v }));
    }
  } catch { /* ignore */ }
  return [];
}

/** Write installed.json */
function saveInstalled(arr) {
  mkdirSync(dirname(INSTALLED_PATH), { recursive: true });
  writeFileSync(INSTALLED_PATH, JSON.stringify(arr, null, 2));
}

/** Read manifest.json for a bundle from app source */
function getManifest(bundleId) {
  const manifestPath = join(APP_BUNDLES, bundleId, "manifest.json");
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

/** Run a shell command safely with execFile */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 300_000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stdout, stderr }));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Detect available Docker Compose command.
 * Returns { cmd, args } for either `docker compose` (v2) or `python3 -m compose` (v1 fallback).
 */
let _composeCmd = null;
async function getComposeCmd() {
  if (_composeCmd) return _composeCmd;
  // Try docker compose v2 first
  try {
    await run("docker", ["compose", "version"]);
    _composeCmd = { cmd: "docker", prefix: ["compose"] };
    return _composeCmd;
  } catch {}
  // Try python3 -m compose (docker-compose v1 via python package)
  try {
    await run("python3", ["-m", "compose", "version"]);
    _composeCmd = { cmd: "python3", prefix: ["-m", "compose"] };
    return _composeCmd;
  } catch {}
  // Try docker-compose binary directly
  try {
    await run("docker-compose", ["version"]);
    _composeCmd = { cmd: "docker-compose", prefix: [] };
    return _composeCmd;
  } catch {}
  throw new Error("No docker compose command found. Install docker-compose-plugin or docker-compose.");
}

/** Run a docker compose command with the detected compose variant */
async function runCompose(composeArgs, opts = {}) {
  const compose = await getComposeCmd();
  return run(compose.cmd, [...compose.prefix, ...composeArgs], opts);
}

/** Read JSON file with fallback */
function readJsonSafe(path, fallback) {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  } catch { /* ignore */ }
  return fallback;
}

/** Write JSON file (creates parent dirs) */
function writeJsonSafe(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/** Validate bundle ID format (alphanumeric + hyphens only) */
function isValidBundleId(id) {
  return /^[a-z0-9][a-z0-9-]*$/.test(id) && id.length <= 64;
}

/**
 * Validate a docker-compose.yml for security issues.
 * Rejects: sensitive host mounts, privileged mode, dangerous capabilities.
 * Returns { valid: true } or { valid: false, reason: string }.
 */
/**
 * Inspect a compose file for security concerns.
 *
 * @param {string} composePath - path to docker-compose.yml
 * @param {string} bundleId
 * @param {object} [opts]
 * @param {object} [opts.manifest] - bundle manifest; if it has `privileged: true`
 *   AND `opts.consentVerified` is true, NET_ADMIN/host-network/privileged are allowed.
 *   Read-only Docker socket mounts are allowed when manifest declares `consent_required: true`
 *   (and consent has been verified) — bundles like netdata/dozzle need this.
 * @param {boolean} [opts.consentVerified=false] - true when the install request supplied a
 *   valid consent token consumed by validateConsentToken().
 * @returns {{valid: boolean, reason?: string}}
 */
function validateComposeFile(composePath, bundleId, opts = {}) {
  const { manifest, consentVerified = false } = opts;
  const isPrivilegedAllowed = !!(manifest?.privileged && consentVerified);
  const isConsentBundle = !!(manifest?.consent_required && consentVerified);
  try {
    const content = readFileSync(composePath, "utf8");

    // Sensitive host paths that should never be mounted (regardless of consent)
    const sensitivePatterns = [
      /^\s*-\s+["']?\/:/m,                    // root mount /
      /^\s*-\s+["']?\/etc[/:]/m,              // /etc
      /^\s*-\s+["']?~?\/?\.ssh[/:]/m,         // ~/.ssh
      /^\s*-\s+["']?~?\/?\.crow\/data[/:]/m,  // ~/.crow/data
    ];

    for (const pattern of sensitivePatterns) {
      if (pattern.test(content)) {
        return { valid: false, reason: `Compose file mounts a sensitive host path (matched: ${pattern.source})` };
      }
    }

    // Docker socket — allowed read-only ONLY when manifest has consent_required and consent was verified
    // (netdata, dozzle pattern). Read-write Docker socket is never allowed via this path.
    const rwSocketPattern = /^\s*-\s+["']?\/var\/run\/docker\.sock(?!\s*:[^:]*:\s*ro)/m;
    const anySocketPattern = /^\s*-\s+["']?\/var\/run\/docker/m;
    if (rwSocketPattern.test(content)) {
      return { valid: false, reason: "Read-write Docker socket mounts are not permitted" };
    }
    if (anySocketPattern.test(content) && !isConsentBundle && !isPrivilegedAllowed) {
      return { valid: false, reason: "Docker socket mount requires manifest 'consent_required: true' and verified consent" };
    }

    // Privileged mode
    if (/^\s*privileged:\s*true/m.test(content) && !isPrivilegedAllowed) {
      return { valid: false, reason: "Compose file uses privileged mode but manifest does not declare 'privileged: true' (or consent was not verified)" };
    }

    // Dangerous capabilities (NET_ADMIN etc.) — gated by manifest.privileged + consent
    if (/NET_ADMIN|SYS_ADMIN|SYS_PTRACE|SYS_RAWIO|NET_RAW/m.test(content) && !isPrivilegedAllowed) {
      return { valid: false, reason: "Compose file requests dangerous capabilities (NET_ADMIN, SYS_ADMIN, NET_RAW, etc.) but manifest does not declare 'privileged: true' (or consent was not verified)" };
    }

    // Host networking — gated by manifest.privileged + consent
    if (/network_mode:\s*host/i.test(content) && !isPrivilegedAllowed) {
      return { valid: false, reason: "Compose file uses host networking but manifest does not declare 'privileged: true' (or consent was not verified)" };
    }

    return { valid: true };
  } catch (err) {
    return { valid: false, reason: `Could not read compose file: ${err.message}` };
  }
}

// --- PR 0: Consent token helpers (server-validated install consent) ---

/**
 * Mint a single-use consent token for a bundle install. Stores in install_consents table
 * with an expiry. The client passes this token back on POST /install.
 */
async function mintConsentToken(db, bundleId) {
  const token = randomBytes(32).toString("hex");
  const now = Math.floor(Date.now() / 1000);
  await db.execute({
    sql: `INSERT INTO install_consents (token, bundle_id, schema_version, created_at, expires_at, consumed)
          VALUES (?, ?, ?, ?, ?, 0)`,
    args: [token, bundleId, CONSENT_TOKEN_SCHEMA_VERSION, now, now + CONSENT_TOKEN_TTL_SECONDS],
  });
  return { token, expires_in_seconds: CONSENT_TOKEN_TTL_SECONDS };
}

/**
 * Atomically validate-and-consume a consent token. Returns true only if:
 *   - token row exists for the given bundleId
 *   - schema_version matches current version
 *   - not yet expired
 *   - not yet consumed
 * The consume step is atomic to prevent double-spend / double-install races.
 */
async function validateConsentToken(db, bundleId, token) {
  if (!token || typeof token !== "string") return false;
  const now = Math.floor(Date.now() / 1000);
  const result = await db.execute({
    sql: `UPDATE install_consents
          SET consumed = 1
          WHERE token = ?
            AND bundle_id = ?
            AND schema_version = ?
            AND consumed = 0
            AND expires_at > ?
          RETURNING token`,
    args: [token, bundleId, CONSENT_TOKEN_SCHEMA_VERSION, now],
  });
  return result.rows.length > 0;
}

/**
 * Best-effort cleanup of expired consent tokens. Called opportunistically.
 */
async function pruneExpiredConsents(db) {
  const now = Math.floor(Date.now() / 1000);
  await db.execute({
    sql: "DELETE FROM install_consents WHERE expires_at < ? OR consumed = 1",
    args: [now],
  }).catch(() => {});
}

/**
 * Determine whether a bundle requires consent (privileged or consent_required).
 */
function manifestRequiresConsent(manifest) {
  return !!(manifest && (manifest.privileged === true || manifest.consent_required === true));
}

/**
 * Pick the install_consent_message for the user's preferred language.
 * Falls back to English, then to a generic message.
 */
function pickConsentMessage(manifest, lang = "en") {
  if (manifest?.install_consent_messages && typeof manifest.install_consent_messages === "object") {
    return manifest.install_consent_messages[lang]
      ?? manifest.install_consent_messages.en
      ?? manifest.install_consent_message
      ?? "This bundle requires explicit consent to install.";
  }
  return manifest?.install_consent_message ?? "This bundle requires explicit consent to install.";
}

/**
 * Summarize the privileged capabilities a bundle requests, for display in the install modal.
 */
function summarizePrivileges(manifest, composePath) {
  const caps = [];
  if (manifest?.privileged) {
    try {
      const content = readFileSync(composePath, "utf8");
      if (/network_mode:\s*host/i.test(content)) caps.push("host networking");
      if (/NET_ADMIN/.test(content)) caps.push("NET_ADMIN (modify firewall)");
      if (/NET_RAW/.test(content)) caps.push("NET_RAW (raw sockets)");
      if (/SYS_ADMIN/.test(content)) caps.push("SYS_ADMIN (system administration)");
      if (/SYS_PTRACE/.test(content)) caps.push("SYS_PTRACE (process tracing)");
      if (/^\s*privileged:\s*true/m.test(content)) caps.push("full privileged mode");
    } catch { /* ignore */ }
  }
  if (manifest?.consent_required && !manifest?.privileged) {
    try {
      const content = readFileSync(composePath, "utf8");
      if (/\/var\/run\/docker/.test(content)) caps.push("read Docker socket (sees all containers/env)");
    } catch { /* ignore */ }
  }
  return caps;
}

/**
 * Find installed bundles that depend on a given bundle (via requires.bundles).
 * Used to block uninstall when dependents would break.
 */
function findDependents(bundleId) {
  const installed = getInstalled();
  const dependents = [];
  for (const entry of installed) {
    if (entry.id === bundleId) continue;
    const m = getManifest(entry.id);
    const reqs = m?.requires?.bundles;
    if (Array.isArray(reqs) && reqs.includes(bundleId)) {
      dependents.push(entry.id);
    }
  }
  return dependents;
}

/**
 * Propagate env vars from a bundle install to the gateway's .env file.
 * Uncomments and sets values for vars that are already present as comments,
 * or appends them if not found.
 */
function propagateEnvToGateway(envVars) {
  if (!envVars || typeof envVars !== "object" || Object.keys(envVars).length === 0) return;
  if (!existsSync(APP_ENV_PATH)) return;

  let content = readFileSync(APP_ENV_PATH, "utf8");

  for (const [key, value] of Object.entries(envVars)) {
    if (value === undefined || value === "") continue;
    // Match commented-out or existing lines like: # KEY=value or KEY=value
    const pattern = new RegExp(`^(#\\s*)?${key}=.*$`, "m");
    if (pattern.test(content)) {
      content = content.replace(pattern, `${key}=${value}`);
    } else {
      // Append if not found at all
      content = content.trimEnd() + `\n${key}=${value}\n`;
    }
  }

  writeFileSync(APP_ENV_PATH, content);
}

/**
 * Re-comment env vars in the gateway's .env file during uninstall.
 * Turns `KEY=value` back into `# KEY=value`.
 */
function revertEnvInGateway(envKeys) {
  if (!envKeys || envKeys.length === 0) return;
  if (!existsSync(APP_ENV_PATH)) return;

  let content = readFileSync(APP_ENV_PATH, "utf8");

  for (const key of envKeys) {
    // Match uncommented lines like KEY=value
    const pattern = new RegExp(`^(${key}=.*)$`, "m");
    if (pattern.test(content)) {
      content = content.replace(pattern, "# $1");
    }
  }

  writeFileSync(APP_ENV_PATH, content);
}

/**
 * Schedule a graceful gateway restart so new env vars take effect.
 * Uses the same pattern as auto-update: exit with code 1 so systemd restarts.
 * Emits 'crow:shutdown' on process so the HTTP server can close its listening
 * socket before the exit — prevents EADDRINUSE when systemd starts the new instance.
 * For non-systemd, just sets process.env so the storage server can reinitialize.
 */
function scheduleGatewayRestart(delayMs = 2000) {
  if (process.env.INVOCATION_ID) {
    // Running as systemd service — close server, then exit to trigger restart
    console.log("[bundles] Restarting gateway to apply new configuration...");
    setTimeout(() => {
      process.emit("crow:shutdown");
      // Give server.close() time to release the port, then exit
      setTimeout(() => process.exit(1), 1000);
    }, delayMs);
  } else {
    // Not systemd — reload env vars into current process
    try {
      const envContent = readFileSync(APP_ENV_PATH, "utf8");
      for (const line of envContent.split("\n")) {
        const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (match && !match[1].startsWith("#")) {
          process.env[match[1]] = match[2];
        }
      }
      console.log("[bundles] Reloaded env vars into current process");
    } catch {}
  }
}

/**
 * Map AI bundle IDs to AI Provider settings for auto-configuration.
 * When a local AI bundle is installed, these settings are written to .env
 * so the BYOAI Chat in the Messages panel works immediately.
 */
function getAiProviderConfig(bundleId, envVars) {
  const configs = {
    ollama: {
      provider: "ollama",
      baseUrl: envVars?.OLLAMA_HOST || "http://localhost:11434",
    },
    localai: {
      provider: "openai",
      baseUrl: (envVars?.LOCALAI_HOST || "http://localhost:8080") + "/v1",
    },
  };
  return configs[bundleId] || null;
}

/**
 * @returns {Router}
 */
export default function bundlesRouter() {
  const router = Router();

  // GET /bundles/api/status — List installed bundles with container status
  router.get("/bundles/api/status", async (req, res) => {
    const installed = getInstalled();
    const results = [];

    for (const entry of installed) {
      const bundleDir = join(BUNDLES_DIR, entry.id);
      const composePath = join(bundleDir, "docker-compose.yml");
      const manifest = getManifest(entry.id);
      const info = { ...entry, name: manifest?.name || entry.id, type: manifest?.type || entry.type || "unknown" };

      if (existsSync(composePath)) {
        try {
          const { stdout } = await runCompose(["ps", "--format", "json"], { cwd: bundleDir });
          const containers = stdout.trim().split("\n").filter(Boolean).map((line) => {
            try { return JSON.parse(line); } catch { return null; }
          }).filter(Boolean);

          info.containers = containers.map((c) => ({
            name: c.Name || c.Service,
            state: c.State || "unknown",
            status: c.Status || "",
          }));
          info.running = containers.some((c) => c.State === "running");
        } catch {
          info.containers = [];
          info.running = false;
        }
      } else {
        info.containers = null; // MCP server type — no containers
        info.running = null;
      }

      results.push(info);
    }

    res.json({ bundles: results });
  });

  // GET /bundles/api/consent-challenge/:id — Mint a consent token for a privileged or consent_required bundle.
  // Returns { required: false } for bundles that don't need consent (so the UI can skip the modal).
  router.get("/bundles/api/consent-challenge/:id", async (req, res) => {
    const bundleId = req.params.id;
    if (!bundleId || !isValidBundleId(bundleId)) {
      return res.status(400).json({ error: "Invalid bundle ID" });
    }
    const manifest = getManifest(bundleId);
    if (!manifest) {
      return res.status(404).json({ error: `Bundle '${bundleId}' not found` });
    }
    if (!manifestRequiresConsent(manifest)) {
      return res.json({ required: false });
    }
    const composePath = join(APP_BUNDLES, bundleId, "docker-compose.yml");
    const lang = (req.query.lang || req.headers["accept-language"] || "en").toString().slice(0, 2).toLowerCase();
    const db = createDbClient();
    try {
      await pruneExpiredConsents(db);
      const { token, expires_in_seconds } = await mintConsentToken(db, bundleId);
      // Compute prereq install state for UI to show prereq checklist
      const reqBundles = manifest.requires?.bundles || [];
      const installedIds = new Set(getInstalled().map((i) => i.id));
      const prereqs = reqBundles.map((id) => ({ id, installed: installedIds.has(id) }));
      res.json({
        required: true,
        bundle_id: bundleId,
        bundle_name: manifest.name || bundleId,
        privileged: !!manifest.privileged,
        consent_required: !!manifest.consent_required,
        message: pickConsentMessage(manifest, lang),
        capabilities: summarizePrivileges(manifest, composePath),
        prereqs,
        min_android_app: manifest.requires?.min_android_app || null,
        token,
        expires_in_seconds,
      });
    } catch (err) {
      res.status(500).json({ error: `Failed to mint consent token: ${err.message}` });
    } finally {
      try { db.close(); } catch {}
    }
  });

  // POST /bundles/api/install — Install a bundle
  router.post("/bundles/api/install", async (req, res) => {
    const { bundle_id, env_vars, consent_token } = req.body;

    if (!bundle_id || !isValidBundleId(bundle_id)) {
      return res.status(400).json({ error: "Invalid bundle ID" });
    }

    // Check source exists
    const sourceDir = join(APP_BUNDLES, bundle_id);
    if (!existsSync(sourceDir)) {
      return res.status(404).json({ error: `Bundle '${bundle_id}' not found` });
    }

    // Check not already installed
    const installed = getInstalled();
    if (installed.find((i) => i.id === bundle_id)) {
      return res.status(409).json({ error: `Bundle '${bundle_id}' is already installed` });
    }

    // PR 0: dependency check — refuse install if any required bundle is missing
    const manifestPre = getManifest(bundle_id);
    const requiredBundles = manifestPre?.requires?.bundles || [];
    if (requiredBundles.length > 0) {
      const installedIds = new Set(installed.map((i) => i.id));
      const missing = requiredBundles.filter((id) => !installedIds.has(id));
      if (missing.length > 0) {
        return res.status(400).json({
          ok: false,
          error: `Bundle '${bundle_id}' requires the following bundles to be installed first: ${missing.join(", ")}`,
          missing_dependencies: missing,
        });
      }
    }

    // PR 3: advisory Android-app version gate. The gateway can't verify the
    // user's phone from here — the check happens on the phone when the panel
    // JS reads navigator.userAgent. Log a warning so ops can see the
    // requirement and include it in the install response for UIs that want
    // to surface it.
    const minAndroidApp = manifestPre?.requires?.min_android_app;
    if (minAndroidApp) {
      console.log(`[bundles] ${bundle_id} declares min_android_app=${minAndroidApp} — enforced client-side on the Crow Android app`);
    }

    // F.0: hardware gate — refuse install if RAM/disk headroom is insufficient,
    // warn (but allow) if under the recommended threshold. MemAvailable + SSD-
    // backed swap at half-weight is the effective-RAM basis; already-installed
    // bundles' recommended_ram_mb is subtracted from the pool. Bypass via
    // `force_install: true` (CLI-only — the web UI never surfaces this flag).
    if (!req.body.force_install) {
      const gate = checkHardwareGate({
        manifest: manifestPre,
        installed,
        manifestLookup: (id) => getManifest(id),
        dataDir: CROW_HOME,
      });
      if (!gate.allow) {
        return res.status(400).json({
          ok: false,
          error: gate.reason,
          hardware_gate: gate,
        });
      }
      if (gate.level === "warn") {
        // Attach warning to the job so the UI can surface it; install proceeds.
        req._hardwareWarning = gate;
      }
    }

    // GPU arch gate — refuse install if the bundle's required GPU architecture
    // family doesn't match what the host actually has (e.g. CUDA-only bundle on
    // an AMD ROCm box). No force_install bypass: the install would crash anyway.
    {
      const gpuCheck = checkGpuArchCompatible(manifestPre);
      if (!gpuCheck.ok) {
        return res.status(400).json({
          ok: false,
          error: gpuCheck.reason,
          gpu_arch_gate: gpuCheck,
        });
      }
    }

    // PR 0: consent token check — required for privileged or consent_required bundles
    let consentVerified = false;
    if (manifestRequiresConsent(manifestPre)) {
      if (!consent_token) {
        return res.status(403).json({
          ok: false,
          error: "Consent token required. Call GET /bundles/api/consent-challenge/:id to obtain one.",
          consent_required: true,
        });
      }
      const consentDb = createDbClient();
      try {
        consentVerified = await validateConsentToken(consentDb, bundle_id, consent_token);
      } finally {
        try { consentDb.close(); } catch {}
      }
      if (!consentVerified) {
        return res.status(403).json({
          ok: false,
          error: "Consent token is invalid, expired, or already consumed. Mint a new one and retry.",
          consent_expired: true,
        });
      }
    }

    // Block bundles with network_mode: host on managed hosting (security risk on shared infrastructure)
    if (process.env.CROW_HOSTED) {
      const composePath = join(sourceDir, "docker-compose.yml");
      if (existsSync(composePath)) {
        const composeContent = readFileSync(composePath, "utf8");
        if (/network_mode:\s*host/i.test(composeContent)) {
          return res.status(403).json({ ok: false, error: "This bundle requires host networking and is not available on managed hosting." });
        }
      }
    }

    // Create job for async tracking
    const job = createJob(bundle_id, "install");
    res.json({ ok: true, job_id: job.id, message: `Installing ${bundle_id}...` });

    // Run install async (don't block the response)
    (async () => {
      try {
        const manifest = getManifest(bundle_id);
        const addonType = manifest?.type || "bundle";

        // 1. Copy bundle files to ~/.crow/bundles/<id>
        const destDir = join(BUNDLES_DIR, bundle_id);
        mkdirSync(destDir, { recursive: true });
        cpSync(sourceDir, destDir, { recursive: true });
        appendLog(job, "Copied bundle files");

        // 2. Write env vars if provided
        if (env_vars && typeof env_vars === "object") {
          const envLines = Object.entries(env_vars)
            .filter(([, v]) => v !== undefined && v !== "")
            .map(([k, v]) => `${k}=${v}`);
          if (envLines.length > 0) {
            writeFileSync(join(destDir, ".env"), envLines.join("\n") + "\n");
            appendLog(job, `Wrote ${envLines.length} env vars`);
          }
        } else if (existsSync(join(destDir, ".env.example")) && !existsSync(join(destDir, ".env"))) {
          cpSync(join(destDir, ".env.example"), join(destDir, ".env"));
          appendLog(job, "Created .env from .env.example");
        }

        // 3. Type-specific install steps
        let needsRestart = false;
        if (addonType === "bundle") {
          // Docker bundle — pull images and start containers
          const composePath = join(destDir, "docker-compose.yml");
          if (existsSync(composePath)) {
            // PR 0: validate compose for ALL bundles (first-party + community).
            // First-party bundles with privileged/host-network must declare manifest.privileged
            // and the install request must include a verified consent token.
            const validation = validateComposeFile(composePath, bundle_id, {
              manifest,
              consentVerified,
            });
            if (!validation.valid) {
              appendLog(job, `Security check failed: ${validation.reason}`);
              // Clean up copied files
              rmSync(destDir, { recursive: true, force: true });
              finishJob(job, "failed");
              return;
            }
            appendLog(job, "Security check passed");

            appendLog(job, "Pulling Docker images...");
            try {
              await runCompose(["pull"], { cwd: destDir });
              appendLog(job, "Docker images pulled");
            } catch (err) {
              appendLog(job, `Warning: docker compose pull failed: ${err.message}`);
            }

            // Start containers (add --build if compose file has build directives)
            const composeContent = readFileSync(composePath, "utf8");
            const needsBuild = /^\s+build:/m.test(composeContent);
            const upArgs = needsBuild ? ["up", "-d", "--build"] : ["up", "-d"];
            appendLog(job, needsBuild ? "Building and starting containers..." : "Starting containers...");
            try {
              await runCompose(upArgs, { cwd: destDir });
              appendLog(job, "Containers started");
            } catch (err) {
              const detail = err.stderr || err.message;
              appendLog(job, `docker compose up failed: ${detail}`);
              // Still add to installed.json so user can configure env vars and hit "Start"
              const installed2 = getInstalled();
              if (!installed2.find((i) => i.id === bundle_id)) {
                installed2.push({ id: bundle_id, type: addonType, version: manifest?.version, installedAt: new Date().toISOString() });
                saveInstalled(installed2);
              }
              finishJob(job, "failed");
              return;
            }
          }

          // Propagate env vars to gateway .env so dependent services connect
          if (env_vars && Object.keys(env_vars).length > 0) {
            propagateEnvToGateway(env_vars);
            appendLog(job, "Configuration applied to gateway");
            needsRestart = true;
          }

          // Bundle types can also have MCP servers — register if manifest has server config
          if (manifest?.server) {
            const mcpAddons = readJsonSafe(MCP_ADDONS_PATH, {});
            const env = {};
            if (manifest.server.envKeys && env_vars) {
              for (const key of manifest.server.envKeys) {
                if (env_vars[key]) env[key] = env_vars[key];
              }
            }
            if (manifest.env_vars) {
              for (const v of manifest.env_vars) {
                if (v.default && !env[v.name]) env[v.name] = v.default;
              }
            }
            // Add CROW_DB_PATH if not set
            if (!env.CROW_DB_PATH) env.CROW_DB_PATH = join(APP_ROOT, "data", "crow.db");
            mcpAddons[bundle_id] = {
              command: manifest.server.command,
              args: manifest.server.args || [],
              ...(Object.keys(env).length > 0 ? { env } : {}),
            };
            writeJsonSafe(MCP_ADDONS_PATH, mcpAddons);
            appendLog(job, `Registered MCP server '${bundle_id}'`);
            needsRestart = true;
          }

          // Bundle types can also have panels — install them
          if (manifest?.panel) {
            mkdirSync(PANELS_DIR, { recursive: true });
            const panelPath = resolvePanelPath(manifest, bundle_id);
            const panelSrc = join(destDir, panelPath);
            if (existsSync(panelSrc)) {
              cpSync(panelSrc, join(PANELS_DIR, `${bundle_id}.js`));
              appendLog(job, `Installed panel: ${bundle_id}`);
            }
            if (manifest.panelRoutes) {
              const routesSrc = join(destDir, manifest.panelRoutes);
              if (existsSync(routesSrc)) {
                cpSync(routesSrc, join(PANELS_DIR, `${bundle_id}-routes.js`));
                appendLog(job, `Installed panel routes: ${bundle_id}-routes`);
              }
            }
            // Ensure panels dir can resolve gateway dependencies
            const nmLink = join(PANELS_DIR, "node_modules");
            if (!existsSync(nmLink)) {
              const gatewayNm = join(APP_ROOT, "node_modules");
              if (existsSync(gatewayNm)) {
                try { symlinkSync(gatewayNm, nmLink); } catch {}
              }
            }
            const panelsConfig = readJsonSafe(PANELS_CONFIG_PATH, []);
            if (!panelsConfig.includes(bundle_id)) {
              panelsConfig.push(bundle_id);
              writeJsonSafe(PANELS_CONFIG_PATH, panelsConfig);
            }
            needsRestart = true;
          }
        } else if (addonType === "mcp-server") {
          // MCP server — register in mcp-addons.json
          if (manifest?.server) {
            const mcpAddons = readJsonSafe(MCP_ADDONS_PATH, {});
            const env = {};
            // Collect user-provided env vars
            if (manifest.server.envKeys && env_vars) {
              for (const key of manifest.server.envKeys) {
                if (env_vars[key]) env[key] = env_vars[key];
              }
            }
            // Also include default values from manifest.env_vars
            if (manifest.env_vars) {
              for (const v of manifest.env_vars) {
                if (v.default && !env[v.name]) env[v.name] = v.default;
              }
            }
            mcpAddons[bundle_id] = {
              command: manifest.server.command,
              args: manifest.server.args || [],
              ...(Object.keys(env).length > 0 ? { env } : {}),
            };
            writeJsonSafe(MCP_ADDONS_PATH, mcpAddons);
            appendLog(job, `Registered MCP server '${bundle_id}'`);
          }

          // Install npm dependencies if package.json exists
          const pkgJson = join(destDir, "package.json");
          if (existsSync(pkgJson)) {
            appendLog(job, "Installing dependencies...");
            try {
              const { execFileSync } = await import("node:child_process");
              execFileSync("npm", ["install", "--prefix", destDir, "--omit=dev"], {
                stdio: "pipe",
                timeout: 120_000,
              });
              appendLog(job, "Dependencies installed");
            } catch (npmErr) {
              appendLog(job, `Warning: npm install failed — ${npmErr.message}`);
            }
          }

          // Install panel + routes if present in manifest
          if (manifest?.panel) {
            mkdirSync(PANELS_DIR, { recursive: true });
            const panelPath = resolvePanelPath(manifest, bundle_id);
            const panelSrc = join(destDir, panelPath);
            if (existsSync(panelSrc)) {
              cpSync(panelSrc, join(PANELS_DIR, `${bundle_id}.js`));
              appendLog(job, `Installed panel: ${bundle_id}`);
            }
            if (manifest.panelRoutes) {
              const routesSrc = join(destDir, manifest.panelRoutes);
              if (existsSync(routesSrc)) {
                cpSync(routesSrc, join(PANELS_DIR, `${bundle_id}-routes.js`));
                appendLog(job, `Installed panel routes: ${bundle_id}-routes`);
              }
            }
            // Ensure panels dir can resolve gateway dependencies (express, multer, etc.)
            const nmLink = join(PANELS_DIR, "node_modules");
            if (!existsSync(nmLink)) {
              const gatewayNm = join(APP_ROOT, "node_modules");
              if (existsSync(gatewayNm)) {
                try {
                  symlinkSync(gatewayNm, nmLink);
                  appendLog(job, "Linked gateway node_modules for panel route resolution");
                } catch {}
              }
            }
            // Register in panels.json
            const panelsConfig = readJsonSafe(PANELS_CONFIG_PATH, []);
            if (!panelsConfig.includes(bundle_id)) {
              panelsConfig.push(bundle_id);
              writeJsonSafe(PANELS_CONFIG_PATH, panelsConfig);
            }
            needsRestart = true;
          }
        } else if (addonType === "skill") {
          // Skill — copy skill files to ~/.crow/skills/
          mkdirSync(SKILLS_DIR, { recursive: true });
          if (manifest?.skills) {
            for (const skillPath of manifest.skills) {
              const src = join(destDir, skillPath);
              const dest = join(SKILLS_DIR, skillPath.split("/").pop());
              if (existsSync(src)) {
                cpSync(src, dest);
                appendLog(job, `Installed skill: ${skillPath.split("/").pop()}`);
              }
            }
          }
        } else if (addonType === "panel") {
          // Panel — copy panel file to ~/.crow/panels/ and register
          mkdirSync(PANELS_DIR, { recursive: true });
          if (manifest?.panel) {
            const panelPath = resolvePanelPath(manifest, bundle_id);
            const src = join(destDir, panelPath);
            const dest = join(PANELS_DIR, panelPath.split("/").pop());
            if (existsSync(src)) {
              cpSync(src, dest);
              const panelsCfg = readJsonSafe(PANELS_CONFIG_PATH, []);
              if (!panelsCfg.includes(bundle_id)) {
                panelsCfg.push(bundle_id);
                writeJsonSafe(PANELS_CONFIG_PATH, panelsCfg);
              }
              appendLog(job, `Installed panel: ${panelPath.split("/").pop()}`);
            }
          }
        }

        // 3b. Handle panel field on any add-on type
        if (manifest.panel && addonType !== "panel") {
          const panelPath = resolvePanelPath(manifest, bundle_id);
          const panelSourceDir = join(APP_BUNDLES, bundle_id, panelPath.replace(/[^a-zA-Z0-9_\-\/\.]/g, ""));
          if (existsSync(panelSourceDir)) {
            const panelFilename = panelPath.split("/").pop();
            const panelDest = join(CROW_HOME, "panels", panelFilename);
            // Ensure panels directory exists
            mkdirSync(join(CROW_HOME, "panels"), { recursive: true });
            copyFileSync(panelSourceDir, panelDest);
            // Register in panels.json
            const panelsJsonPath = join(CROW_HOME, "panels.json");
            let panelsList = [];
            if (existsSync(panelsJsonPath)) {
              try { panelsList = JSON.parse(readFileSync(panelsJsonPath, "utf8")); } catch {}
            }
            const panelId = panelFilename.replace(/\.js$/, "");
            if (!panelsList.includes(panelId)) {
              panelsList.push(panelId);
              writeFileSync(panelsJsonPath, JSON.stringify(panelsList, null, 2));
            }
            needsRestart = true;
            appendLog(job, `Installed panel: ${panelFilename}`);
          }
        }

        // 4. Copy any associated skills (bundles and mcp-servers can have skills too)
        if (addonType !== "skill" && manifest?.skills) {
          mkdirSync(SKILLS_DIR, { recursive: true });
          for (const skillPath of manifest.skills) {
            const src = join(destDir, skillPath);
            const dest = join(SKILLS_DIR, skillPath.split("/").pop());
            if (existsSync(src)) {
              cpSync(src, dest);
              appendLog(job, `Installed skill: ${skillPath.split("/").pop()}`);
            }
          }
        }

        // 5. Auto-configure AI Provider when installing local AI bundles
        if (manifest?.category === "ai" && addonType === "bundle") {
          const aiConfig = getAiProviderConfig(bundle_id, env_vars);
          if (aiConfig) {
            try {
              const { resolveEnvPath, writeEnvVar, sanitizeEnvValue } = await import("../env-manager.js");
              const envPath = resolveEnvPath();
              writeEnvVar(envPath, "AI_PROVIDER", sanitizeEnvValue(aiConfig.provider));
              writeEnvVar(envPath, "AI_BASE_URL", sanitizeEnvValue(aiConfig.baseUrl));
              // Invalidate cached provider config
              try {
                const { invalidateConfigCache } = await import("../ai/provider.js");
                invalidateConfigCache();
              } catch {}
              appendLog(job, `AI Chat configured — provider: ${aiConfig.provider}, endpoint: ${aiConfig.baseUrl}`);
              appendLog(job, "Open Messages → AI Chat to start chatting with your local AI");
              needsRestart = true;
            } catch (err) {
              appendLog(job, `Note: Could not auto-configure AI Chat: ${err.message}. Set it manually in Settings.`);
            }
          }
        }

        // 6. Track installation
        installed.push({
          id: bundle_id,
          type: addonType,
          version: manifest?.version || "1.0.0",
          installedAt: new Date().toISOString(),
        });
        saveInstalled(installed);
        appendLog(job, "Installation tracked");

        // Open firewall ports and set up Tailscale HTTPS for direct-mode web UIs
        if (manifest?.ports && Array.isArray(manifest.ports)) {
          const { execFileSync: efs } = await import("node:child_process");
          for (const port of manifest.ports) {
            // Open firewall for Tailscale
            try {
              efs("sudo", ["-n", "ufw", "allow", "from", "100.64.0.0/10", "to", "any", "port", String(port), "proto", "tcp", "comment", `Crow: ${manifest.name || bundle_id}`], { timeout: 10000 });
              appendLog(job, `Opened firewall port ${port}/tcp for Tailscale`);
            } catch {
              appendLog(job, `Note: Could not open port ${port} (sudo/ufw not available — open manually if needed)`);
            }
          }
          // Set up Tailscale HTTPS proxy for direct-mode webUI ports (SPA apps need TLS due to HSTS)
          if (manifest?.webUI?.proxyMode === "direct" && manifest.webUI.port) {
            try {
              efs("sudo", ["-n", "tailscale", "serve", "--bg", "--https", String(manifest.webUI.port), `http://localhost:${manifest.webUI.port}`], { timeout: 15000 });
              appendLog(job, `Set up Tailscale HTTPS on port ${manifest.webUI.port}`);
            } catch {
              appendLog(job, `Note: Could not set up Tailscale HTTPS for port ${manifest.webUI.port}`);
            }
          }
        }

        let notifDb;
        try {
          notifDb = createDbClient();
          await createNotification(notifDb, {
            title: `Installed: ${manifest?.name || bundle_id}`,
            type: "system",
            source: "bundle-installer",
            action_url: "/dashboard/extensions",
          });
        } catch {} finally {
          notifDb?.close();
        }

        finishJob(job, needsRestart ? "complete_restart" : "complete");

        // Auto-restart gateway if panels or MCP servers were added
        if (needsRestart) {
          appendLog(job, "Scheduling gateway restart to load new panels/servers...");
          scheduleGatewayRestart(3000);
        }
      } catch (err) {
        appendLog(job, `Error: ${err.message}`);
        finishJob(job, "failed");
      }
    })();
  });

  // POST /bundles/api/uninstall — Remove a bundle
  router.post("/bundles/api/uninstall", async (req, res) => {
    const { bundle_id, delete_data } = req.body;

    if (!bundle_id || !isValidBundleId(bundle_id)) {
      return res.status(400).json({ error: "Invalid bundle ID" });
    }

    const bundleDir = join(BUNDLES_DIR, bundle_id);
    if (!existsSync(bundleDir)) {
      return res.status(404).json({ error: `Bundle '${bundle_id}' is not installed` });
    }

    // PR 0: refuse to uninstall when other installed bundles depend on this one
    const dependents = findDependents(bundle_id);
    if (dependents.length > 0) {
      return res.status(409).json({
        ok: false,
        error: `Cannot uninstall '${bundle_id}' — other installed bundles depend on it: ${dependents.join(", ")}. Uninstall the dependents first.`,
        dependents,
      });
    }

    const job = createJob(bundle_id, "uninstall");
    res.json({ ok: true, job_id: job.id, message: `Removing ${bundle_id}...` });

    (async () => {
      try {
        const manifest = getManifest(bundle_id);
        const addonType = manifest?.type || "bundle";

        // 1. Type-specific cleanup
        if (addonType === "bundle") {
          const composePath = join(bundleDir, "docker-compose.yml");
          if (existsSync(composePath)) {
            appendLog(job, "Stopping containers...");
            const downArgs = ["down", "--remove-orphans"];
            if (delete_data) downArgs.push("-v");
            try {
              await runCompose(downArgs, { cwd: bundleDir });
              appendLog(job, delete_data ? "Containers stopped, volumes removed" : "Containers stopped (data preserved)");
            } catch (err) {
              appendLog(job, `Warning: docker compose down: ${err.message}`);
            }
          }
        } else if (addonType === "mcp-server") {
          // Remove from mcp-addons.json
          const mcpAddons = readJsonSafe(MCP_ADDONS_PATH, {});
          if (mcpAddons[bundle_id]) {
            delete mcpAddons[bundle_id];
            writeJsonSafe(MCP_ADDONS_PATH, mcpAddons);
            appendLog(job, "Removed MCP server registration");
          }
          // Disconnect the live proxy connection
          try {
            const { disconnectAddonServer } = await import("../proxy.js");
            await disconnectAddonServer(bundle_id);
            appendLog(job, "Disconnected addon server");
          } catch {}
          // Remove panel + routes files
          const panelFile = join(PANELS_DIR, `${bundle_id}.js`);
          const routesFile = join(PANELS_DIR, `${bundle_id}-routes.js`);
          if (existsSync(panelFile)) { rmSync(panelFile); appendLog(job, "Removed panel"); }
          if (existsSync(routesFile)) { rmSync(routesFile); appendLog(job, "Removed panel routes"); }
          // Remove from panels.json
          const panelsCfg2 = readJsonSafe(PANELS_CONFIG_PATH, []);
          const idx2 = panelsCfg2.indexOf(bundle_id);
          if (idx2 !== -1) {
            panelsCfg2.splice(idx2, 1);
            writeJsonSafe(PANELS_CONFIG_PATH, panelsCfg2);
          }
        } else if (addonType === "panel") {
          // Remove from panels.json and delete panel file
          const panelsCfg = readJsonSafe(PANELS_CONFIG_PATH, []);
          const idx = panelsCfg.indexOf(bundle_id);
          if (idx !== -1) {
            panelsCfg.splice(idx, 1);
            writeJsonSafe(PANELS_CONFIG_PATH, panelsCfg);
          }
          if (manifest?.panel) {
            const panelPath = resolvePanelPath(manifest, bundle_id);
            const panelFile = join(PANELS_DIR, panelPath.split("/").pop());
            if (existsSync(panelFile)) rmSync(panelFile);
            appendLog(job, "Removed panel file and registration");
          }
        }

        // 1b. Handle panel cleanup for any add-on type
        let needsRestart = false;
        if (manifest && manifest.panel && addonType !== "panel") {
          const panelPath = resolvePanelPath(manifest, bundle_id);
          const panelFilename = panelPath.split("/").pop();
          const panelDest = join(CROW_HOME, "panels", panelFilename);
          const panelId = panelFilename.replace(/\.js$/, "");
          // Remove panel file
          if (existsSync(panelDest)) {
            unlinkSync(panelDest);
          }
          // Remove from panels.json
          const panelsJsonPath = join(CROW_HOME, "panels.json");
          if (existsSync(panelsJsonPath)) {
            try {
              let panelsList = JSON.parse(readFileSync(panelsJsonPath, "utf8"));
              panelsList = panelsList.filter(p => p !== panelId);
              writeFileSync(panelsJsonPath, JSON.stringify(panelsList, null, 2));
            } catch {}
          }
          needsRestart = true;
          appendLog(job, `Removed panel: ${panelFilename}`);
        }

        // 2. Remove associated skills (all types can have skills)
        if (manifest?.skills) {
          for (const skillPath of manifest.skills) {
            const skillFile = join(SKILLS_DIR, skillPath.split("/").pop());
            if (existsSync(skillFile)) {
              rmSync(skillFile);
              appendLog(job, `Removed skill: ${skillPath.split("/").pop()}`);
            }
          }
        }

        // 3. Re-comment env vars in gateway .env
        if (addonType === "bundle" && manifest?.env_vars) {
          const envKeys = manifest.env_vars.map((v) => v.name);
          revertEnvInGateway(envKeys);
          appendLog(job, "Reverted gateway configuration");
          needsRestart = true;
        }

        // 4. Close firewall ports (if manifest has ports and ufw is available)
        if (manifest?.ports && Array.isArray(manifest.ports)) {
          const { execFileSync: efs } = await import("node:child_process");
          for (const port of manifest.ports) {
            try {
              efs("sudo", ["-n", "ufw", "delete", "allow", "from", "100.64.0.0/10", "to", "any", "port", String(port), "proto", "tcp"], { timeout: 10000 });
              appendLog(job, `Closed firewall port ${port}/tcp`);
            } catch {
              appendLog(job, `Note: Could not close port ${port} (sudo/ufw not available)`);
            }
          }
          // Remove Tailscale HTTPS proxy for direct-mode webUI
          if (manifest?.webUI?.proxyMode === "direct" && manifest.webUI.port) {
            try {
              efs("sudo", ["-n", "tailscale", "serve", `--https=${manifest.webUI.port}`, "off"], { timeout: 10000 });
              appendLog(job, `Removed Tailscale HTTPS on port ${manifest.webUI.port}`);
            } catch {}
          }
        }

        // 5. Remove bundle files
        rmSync(bundleDir, { recursive: true, force: true });
        appendLog(job, "Bundle files removed");

        // 6. Update installed.json
        const installed = getInstalled().filter((i) => i.id !== bundle_id);
        saveInstalled(installed);
        appendLog(job, "Installation record removed");

        let notifDb;
        try {
          notifDb = createDbClient();
          await createNotification(notifDb, {
            title: `Removed: ${manifest?.name || bundle_id}`,
            type: "system",
            source: "bundle-installer",
            action_url: "/dashboard/extensions",
          });
        } catch {} finally {
          notifDb?.close();
        }

        finishJob(job, needsRestart ? "complete_restart" : "complete");

        // Auto-restart gateway after uninstall if panels/servers were removed
        if (needsRestart) {
          scheduleGatewayRestart(3000);
        }
      } catch (err) {
        appendLog(job, `Error: ${err.message}`);
        finishJob(job, "failed");
      }
    })();
  });

  // POST /bundles/api/start — Start bundle containers
  router.post("/bundles/api/start", async (req, res) => {
    const { bundle_id } = req.body;

    if (!bundle_id || !isValidBundleId(bundle_id)) {
      return res.status(400).json({ error: "Invalid bundle ID" });
    }

    const bundleDir = join(BUNDLES_DIR, bundle_id);
    const composePath = join(bundleDir, "docker-compose.yml");
    if (!existsSync(composePath)) {
      return res.status(404).json({ error: `Bundle '${bundle_id}' has no Docker containers` });
    }

    try {
      const content = readFileSync(composePath, "utf8");
      const upArgs = /^\s+build:/m.test(content) ? ["up", "-d", "--build"] : ["up", "-d"];
      await runCompose(upArgs, { cwd: bundleDir });
      res.json({ ok: true, message: `Bundle '${bundle_id}' started` });
    } catch (err) {
      res.status(500).json({ error: `Failed to start: ${err.stderr || err.message}` });
    }
  });

  // POST /bundles/api/stop — Stop bundle containers
  router.post("/bundles/api/stop", async (req, res) => {
    const { bundle_id } = req.body;

    if (!bundle_id || !isValidBundleId(bundle_id)) {
      return res.status(400).json({ error: "Invalid bundle ID" });
    }

    const bundleDir = join(BUNDLES_DIR, bundle_id);
    const composePath = join(bundleDir, "docker-compose.yml");
    if (!existsSync(composePath)) {
      return res.status(404).json({ error: `Bundle '${bundle_id}' has no Docker containers` });
    }

    try {
      await runCompose(["stop"], { cwd: bundleDir });
      res.json({ ok: true, message: `Bundle '${bundle_id}' stopped` });
    } catch (err) {
      res.status(500).json({ error: `Failed to stop: ${err.stderr || err.message}` });
    }
  });

  // POST /bundles/api/env — Save env vars for an installed bundle
  router.post("/bundles/api/env", (req, res) => {
    const { bundle_id, env_vars } = req.body;

    if (!bundle_id || !isValidBundleId(bundle_id)) {
      return res.status(400).json({ error: "Invalid bundle ID" });
    }

    const bundleDir = join(BUNDLES_DIR, bundle_id);
    if (!existsSync(bundleDir)) {
      return res.status(404).json({ error: `Bundle '${bundle_id}' is not installed` });
    }

    if (!env_vars || typeof env_vars !== "object") {
      return res.status(400).json({ error: "env_vars must be an object" });
    }

    // Read existing .env, merge with new values
    const envPath = join(bundleDir, ".env");
    const existing = {};
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, "utf8").split("\n")) {
        const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (match) existing[match[1]] = match[2];
      }
    }

    Object.assign(existing, env_vars);
    const envContent = Object.entries(existing)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n";
    writeFileSync(envPath, envContent);

    res.json({ ok: true, message: "Environment variables saved" });
  });

  // GET /bundles/api/jobs/:id — Poll job progress
  router.get("/bundles/api/jobs/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    res.json(job);
  });

  // POST /bundles/api/restart — Client-triggered gateway restart
  // Called by the client after it confirms the job is done and is ready for the restart.
  router.post("/bundles/api/restart", (req, res) => {
    res.json({ ok: true, message: "Restarting..." });
    scheduleGatewayRestart(1000);
  });

  return router;
}

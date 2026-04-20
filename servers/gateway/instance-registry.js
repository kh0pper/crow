/**
 * Instance Registry — manages Crow instance registration, discovery, and heartbeat.
 *
 * Instances are directory-scoped Crow installations (each with its own SQLite DB,
 * gateway, and MCP servers). The registry enables:
 * - Same-machine discovery via ~/.crow/instances.json
 * - Cross-machine discovery via Hyperswarm (future: Phase 4)
 * - Home instance designation (hub for sync)
 * - Bearer token management for instance-to-instance auth
 */

import { randomBytes, createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { hostname as osHostname } from "os";
import bus from "../shared/event-bus.js";

const INSTANCES_JSON_PATH = resolve(homedir(), ".crow", "instances.json");

/**
 * Generate a new instance UUID (used as primary key in crow_instances).
 */
export function generateInstanceId() {
  return randomBytes(16).toString("hex");
}

/**
 * Generate a bearer token for instance-to-instance auth.
 * Returns { token, hash } — token is given to the peer, hash is stored locally.
 */
export function generateAuthToken() {
  const token = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(token).digest("hex");
  return { token, hash };
}

/**
 * Verify a bearer token against a stored hash.
 */
export function verifyAuthToken(token, hash) {
  const computed = createHash("sha256").update(token).digest("hex");
  return computed === hash;
}

/**
 * Register a new instance in the database and update ~/.crow/instances.json.
 */
export async function registerInstance(db, {
  id,
  name,
  crowId,
  directory,
  hostname,
  tailscaleIp,
  gatewayUrl,
  syncUrl,
  syncProfile = "full",
  topics,
  isHome = false,
  authTokenHash,
}) {
  // If designating as home, clear any existing home first
  if (isHome) {
    await db.execute({
      sql: "UPDATE crow_instances SET is_home = 0 WHERE is_home = 1",
      args: [],
    });
  }

  await db.execute({
    sql: `INSERT INTO crow_instances (id, name, crow_id, directory, hostname, tailscale_ip, gateway_url, sync_url, sync_profile, topics, is_home, auth_token_hash, last_seen_at, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 'active')
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            crow_id = excluded.crow_id,
            directory = excluded.directory,
            hostname = excluded.hostname,
            tailscale_ip = excluded.tailscale_ip,
            gateway_url = excluded.gateway_url,
            sync_url = excluded.sync_url,
            sync_profile = excluded.sync_profile,
            topics = excluded.topics,
            is_home = excluded.is_home,
            auth_token_hash = excluded.auth_token_hash,
            last_seen_at = datetime('now'),
            status = 'active',
            updated_at = datetime('now')`,
    args: [
      id, name, crowId, directory || null, hostname || null,
      tailscaleIp || null, gatewayUrl || null, syncUrl || null,
      syncProfile, topics || null, isHome ? 1 : 0, authTokenHash || null,
    ],
  });

  // Update local instances.json for same-machine discovery
  if (directory) {
    updateLocalInstancesJson(id, { name, directory, gatewayUrl });
  }

  return { id };
}

/**
 * List all registered instances.
 */
export async function listInstances(db, { status } = {}) {
  let sql = "SELECT * FROM crow_instances";
  const args = [];

  if (status) {
    sql += " WHERE status = ?";
    args.push(status);
  }

  sql += " ORDER BY is_home DESC, name ASC";

  const result = await db.execute({ sql, args });
  return result.rows;
}

/**
 * Get a single instance by ID.
 */
export async function getInstance(db, id) {
  const result = await db.execute({
    sql: "SELECT * FROM crow_instances WHERE id = ?",
    args: [id],
  });
  return result.rows[0] || null;
}

/**
 * Get the home instance.
 */
export async function getHomeInstance(db) {
  const result = await db.execute({
    sql: "SELECT * FROM crow_instances WHERE is_home = 1",
    args: [],
  });
  return result.rows[0] || null;
}

/**
 * Update an instance's heartbeat (last_seen_at) and optionally status.
 */
export async function heartbeatInstance(db, id, { status } = {}) {
  if (status) {
    await db.execute({
      sql: "UPDATE crow_instances SET last_seen_at = datetime('now'), status = ?, updated_at = datetime('now') WHERE id = ?",
      args: [status, id],
    });
  } else {
    await db.execute({
      sql: "UPDATE crow_instances SET last_seen_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      args: [id],
    });
  }
}

/**
 * Update instance fields.
 */
export async function updateInstance(db, id, fields) {
  const allowed = [
    "name", "directory", "hostname", "tailscale_ip", "gateway_url",
    "sync_url", "sync_profile", "topics", "is_home", "auth_token_hash", "status",
    "trusted",
  ];

  const sets = [];
  const args = [];

  for (const [key, value] of Object.entries(fields)) {
    const dbKey = key.replace(/([A-Z])/g, "_$1").toLowerCase(); // camelCase → snake_case
    if (allowed.includes(dbKey)) {
      sets.push(`${dbKey} = ?`);
      args.push(value);
    }
  }

  if (sets.length === 0) return;

  // If setting is_home, clear others first
  if (fields.is_home || fields.isHome) {
    await db.execute({
      sql: "UPDATE crow_instances SET is_home = 0 WHERE is_home = 1",
      args: [],
    });
  }

  sets.push("updated_at = datetime('now')");
  args.push(id);

  await db.execute({
    sql: `UPDATE crow_instances SET ${sets.join(", ")} WHERE id = ?`,
    args,
  });

  // Emit an event so downstream caches (e.g. overview-cache) can
  // invalidate synchronously. Only fires when trust- or status-relevant
  // fields changed — avoids noise when an operator renames a peer.
  // Wrapped in try/catch per bus emit discipline; a subscriber error
  // must not fail the primary DB write.
  const trustRelevantKeys = new Set(["trusted", "status"]);
  const changed = [];
  for (const [key] of Object.entries(fields)) {
    const dbKey = key.replace(/([A-Z])/g, "_$1").toLowerCase();
    if (trustRelevantKeys.has(dbKey)) changed.push(dbKey);
  }
  if (changed.length > 0) {
    try {
      bus.emit("crow_instances:row_updated", { id, changed, fields });
    } catch { /* subscriber failures are not primary-write failures */ }
  }
}

/**
 * Revoke an instance — sets status to 'revoked' and clears auth token.
 */
export async function revokeInstance(db, id) {
  await db.execute({
    sql: "UPDATE crow_instances SET status = 'revoked', auth_token_hash = NULL, updated_at = datetime('now') WHERE id = ?",
    args: [id],
  });

  // Remove from local instances.json
  removeFromLocalInstancesJson(id);

  // Tell downstream caches the peer is gone NOW, not in 30s.
  try {
    bus.emit("crow_instances:row_updated", { id, changed: ["status"], fields: { status: "revoked" } });
  } catch {}
}

/**
 * Designate an instance as home.
 */
export async function setHomeInstance(db, id) {
  await db.execute({
    sql: "UPDATE crow_instances SET is_home = 0 WHERE is_home = 1",
    args: [],
  });
  await db.execute({
    sql: "UPDATE crow_instances SET is_home = 1, updated_at = datetime('now') WHERE id = ?",
    args: [id],
  });
}

/**
 * Rotate auth token for an instance. Returns the new plaintext token.
 */
export async function rotateAuthToken(db, id) {
  const { token, hash } = generateAuthToken();
  await db.execute({
    sql: "UPDATE crow_instances SET auth_token_hash = ?, updated_at = datetime('now') WHERE id = ?",
    args: [hash, id],
  });
  return token;
}

// --- Same-machine discovery via ~/.crow/instances.json ---

/**
 * Read the local instances.json file.
 * Format: { [instanceId]: { name, directory, gatewayUrl } }
 */
export function readLocalInstances() {
  try {
    if (existsSync(INSTANCES_JSON_PATH)) {
      return JSON.parse(readFileSync(INSTANCES_JSON_PATH, "utf-8"));
    }
  } catch (err) {
    console.warn("[instance-registry] Failed to read instances.json:", err.message);
  }
  return {};
}

/**
 * Add or update an instance in ~/.crow/instances.json.
 */
function updateLocalInstancesJson(id, { name, directory, gatewayUrl }) {
  const instances = readLocalInstances();
  instances[id] = { name, directory, gatewayUrl: gatewayUrl || null, updatedAt: new Date().toISOString() };
  writeLocalInstancesJson(instances);
}

/**
 * Remove an instance from ~/.crow/instances.json.
 */
function removeFromLocalInstancesJson(id) {
  const instances = readLocalInstances();
  if (instances[id]) {
    delete instances[id];
    writeLocalInstancesJson(instances);
  }
}

/**
 * Write the instances.json file.
 */
function writeLocalInstancesJson(instances) {
  try {
    const dir = resolve(homedir(), ".crow");
    mkdirSync(dir, { recursive: true });
    writeFileSync(INSTANCES_JSON_PATH, JSON.stringify(instances, null, 2));
  } catch (err) {
    console.warn("[instance-registry] Failed to write instances.json:", err.message);
  }
}

/**
 * Discover same-machine instances from ~/.crow/instances.json.
 * Returns entries that are NOT already registered in the DB.
 */
export async function discoverLocalInstances(db) {
  const local = readLocalInstances();
  const registered = await listInstances(db);
  const registeredIds = new Set(registered.map((r) => r.id));

  const discovered = [];
  for (const [id, info] of Object.entries(local)) {
    if (!registeredIds.has(id)) {
      discovered.push({ id, ...info });
    }
  }
  return discovered;
}

/**
 * Get the current instance's ID. Reads from ~/.crow/data/instance-id or generates one.
 */
export function getOrCreateLocalInstanceId() {
  const dataDir = process.env.CROW_DATA_DIR
    ? resolve(process.env.CROW_DATA_DIR)
    : resolve(homedir(), ".crow", "data");
  const idPath = resolve(dataDir, "instance-id");

  try {
    if (existsSync(idPath)) {
      return readFileSync(idPath, "utf-8").trim();
    }
  } catch {}

  const id = generateInstanceId();
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(idPath, id);
  } catch (err) {
    console.warn("[instance-registry] Failed to persist instance-id:", err.message);
  }
  return id;
}

/**
 * Auto-register the current instance if not already registered.
 * Called on gateway startup.
 */
export async function ensureLocalInstanceRegistered(db, { crowId, gatewayUrl, name } = {}) {
  const instanceId = getOrCreateLocalInstanceId();

  const existing = await getInstance(db, instanceId);
  if (existing) {
    // Update heartbeat
    await heartbeatInstance(db, instanceId);
    return existing;
  }

  // Auto-register this instance
  const hn = osHostname();
  const cwd = process.cwd();
  const instanceName = name || `${hn}:${cwd}`;

  await registerInstance(db, {
    id: instanceId,
    name: instanceName,
    crowId: crowId || "unknown",
    directory: cwd,
    hostname: hn,
    gatewayUrl: gatewayUrl || null,
  });

  const instance = await getInstance(db, instanceId);
  console.log(`[instance-registry] Registered local instance: ${instanceName} (${instanceId})`);
  return instance;
}

/**
 * Compute Hyperswarm discovery topic for instance sync.
 * topic = sha256(crowId + "instance-sync")
 */
export function computeInstanceSyncTopic(crowId) {
  return createHash("sha256")
    .update(crowId + "instance-sync")
    .digest();
}

/**
 * Validate a bearer token against registered instances.
 * Used for instance-to-instance HTTP authentication.
 *
 * @param {import("@libsql/client").Client} db
 * @param {string} token - The bearer token from the Authorization header
 * @returns {Promise<object|null>} The matching instance row, or null if invalid
 */
export async function validateInstanceToken(db, token) {
  if (!token) return null;

  const tokenHash = createHash("sha256").update(token).digest("hex");

  try {
    const { rows } = await db.execute({
      sql: "SELECT * FROM crow_instances WHERE auth_token_hash = ? AND status = 'active'",
      args: [tokenHash],
    });
    return rows[0] || null;
  } catch {
    return null;
  }
}

/**
 * Express middleware for instance-to-instance auth.
 * Checks for Bearer token in Authorization header and validates against instance registry.
 * Sets req.instanceAuth = { instance } on success.
 */
export function instanceAuthMiddleware(db) {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return next(); // No bearer token — fall through to other auth methods
    }

    const token = authHeader.slice(7);
    const instance = await validateInstanceToken(db, token);

    if (instance) {
      req.instanceAuth = { instance };
      return next();
    }

    // Invalid token — don't reject, fall through to other auth
    return next();
  };
}

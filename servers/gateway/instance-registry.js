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
import { resolve, dirname } from "path";
import { homedir } from "os";
import { hostname as osHostname } from "os";
import bus from "../shared/event-bus.js";
import { livenessStatusSql } from "../shared/instance-status.js";
import { createDbClient } from "../db.js";
import { isPeerUsableUrl, deriveSelfDialAddress } from "../shared/self-dial-address.js";

// CROW_INSTANCES_JSON_PATH is a test seam (scripts/run-suite.mjs sets it to the
// scratch dir): every suite gateway used to register itself in the host's REAL
// ~/.crow/instances.json — 1,647 stale worktree entries on crow by 2026-10-04.
// Unset in production, so the default path is unchanged.
const INSTANCES_JSON_PATH = process.env.CROW_INSTANCES_JSON_PATH
  || resolve(homedir(), ".crow", "instances.json");

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
 * Register a new instance in the database and update ~/.crow/instances.json.
 */
export async function registerInstance(db, {
  id,
  name,
  crowId,
  directory,
  dataDir,
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

  // data_dir stores CROW_DATA_DIR so same-host peers (e.g. primary + MPA
  // on the same grackle filesystem) can read each other's DB files
  // directly rather than going through MCP federation. MCP reads on MPA
  // are blocked by a chronic libsql WAL wedge (Day 1 gotcha) — direct
  // SQL from a fresh libsql client sidesteps the wedge cleanly.
  await db.execute({
    sql: `INSERT INTO crow_instances (id, name, crow_id, directory, data_dir, hostname, tailscale_ip, gateway_url, sync_url, sync_profile, topics, is_home, auth_token_hash, last_seen_at, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 'active')
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            crow_id = excluded.crow_id,
            directory = excluded.directory,
            data_dir = COALESCE(excluded.data_dir, crow_instances.data_dir),
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
      id, name, crowId, directory || null, dataDir || null, hostname || null,
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
    // A heartbeat is liveness: it may set 'active'/'offline' but never
    // overwrite an operator's revoke/pause (livenessStatusSql throws on any
    // other value). Revoke/pause go through revokeInstance/updateInstance.
    await db.execute({
      sql: `UPDATE crow_instances SET last_seen_at = datetime('now'), status = ${livenessStatusSql(status)}, updated_at = datetime('now') WHERE id = ?`,
      args: [id],
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
    mkdirSync(dirname(INSTANCES_JSON_PATH), { recursive: true });
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
    // Exclusive create (O_EXCL) — atomic against a concurrent first-ever-boot
    // racer. A plain writeFileSync (or a rename-over-target) is NOT exclusive:
    // both racers would "succeed" with different in-memory ids while one
    // silently clobbers the other's file, so a file-content-only check passes
    // vacuously. On EEXIST we lost the race — re-read and return the winner's
    // id so both racers agree.
    writeFileSync(idPath, id, { flag: "wx" });
  } catch (err) {
    if (err.code === "EEXIST") {
      try {
        return readFileSync(idPath, "utf-8").trim();
      } catch (readErr) {
        console.warn("[instance-registry] Failed to re-read winning instance-id:", readErr.message);
      }
    } else {
      console.warn("[instance-registry] Failed to persist instance-id:", err.message);
    }
  }
  return id;
}

/**
 * The operator-configured URL paired instances should dial for this gateway
 * (the self row's gateway_url), from CROW_PEER_GATEWAY_URL — or null when
 * unset or unusable as a peer address (unparseable, not http(s), a
 * wildcard bind like http://0.0.0.0:3001, or loopback). Trailing slash stripped so
 * comparisons are stable.
 *
 * Deliberately NOT CROW_GATEWAY_URL: that is the PUBLIC URL (OAuth issuer,
 * blog links, push click-through). On crow it is the Funnel host, which
 * serves only public paths, so using it as the peer address would point
 * every peer at a door that refuses private routes.
 */
export function configuredSelfGatewayUrl(env = process.env) {
  const raw = String(env.CROW_PEER_GATEWAY_URL || "").trim();
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!u.hostname || u.hostname === "0.0.0.0" || u.hostname === "[::]") return null;
  // Loopback is never a peer address: it goes to peers in the pairing
  // handshake, and a peer would dial its OWN loopback with our bearer (review M6).
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host)) return null;
  return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
}

/** This gateway's backend port, resolved the way servers/gateway/index.js does. */
export function gatewayBackendPort(env = process.env) {
  const n = parseInt(env.PORT || env.CROW_GATEWAY_PORT || "3001", 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 3001;
}

/**
 * The dial address this instance hands a peer at PAIRING time:
 * { gateway_url, tailscale_ip, sync_port }.
 *
 * gateway_url: CROW_PEER_GATEWAY_URL (explicit override) → the derived
 * address (a NON-Funnel Serve endpoint for our port, else
 * http://<tailnet ip>:<port>) → the self row's gateway_url. NEVER
 * CROW_GATEWAY_URL — the public URL, on crow the Funnel :443 door, which
 * refuses private routes and which instance sync never dials (black-swan's
 * six-week stall). tailscale_ip + sync_port ride along: the sync transport
 * dials them whenever gateway_url is a :443 URL. Never throws.
 */
export async function selfPairingAddress(db, { env = process.env, port = gatewayBackendPort(env), execFileSyncImpl } = {}) {
  const configured = configuredSelfGatewayUrl(env);
  let row = null;
  try { row = db ? await getInstance(db, getOrCreateLocalInstanceId()) : null; } catch { row = null; }
  // Probe tailscale only when needed (each probe is a bounded sync exec).
  const needDerive = !configured || !(row?.tailscale_ip);
  const derived = needDerive
    ? deriveSelfDialAddress({ port, env, configuredUrl: configured, ...(execFileSyncImpl ? { execFileSyncImpl } : {}) })
    : { gateway_url: configured, tailscale_ip: null };
  let gatewayUrl = configured || null;
  if (!gatewayUrl && derived.gateway_url && isPeerUsableUrl(derived.gateway_url)) gatewayUrl = derived.gateway_url;
  if (!gatewayUrl && row?.gateway_url && isPeerUsableUrl(row.gateway_url)) gatewayUrl = row.gateway_url;
  return {
    gateway_url: gatewayUrl,
    tailscale_ip: derived.tailscale_ip || row?.tailscale_ip || null,
    sync_port: port,
  };
}

/**
 * Auto-register the current instance if not already registered.
 * Called on gateway startup.
 *
 * `gatewayUrlConfigured: true` marks gatewayUrl as operator-set
 * (CROW_PEER_GATEWAY_URL): it then also corrects an EXISTING self row whose
 * gateway_url drifted (raven's and r4's rows kept the first auto-detected
 * Serve URL, 2026-09-24). An auto-detected URL never overwrites an existing
 * row — detection can pick the wrong Serve port.
 */
export async function ensureLocalInstanceRegistered(db, { crowId, gatewayUrl, name, gatewayUrlConfigured = false, tailscaleIp = null } = {}) {
  const instanceId = getOrCreateLocalInstanceId();

  const existing = await getInstance(db, instanceId);
  if (existing) {
    // Update heartbeat
    await heartbeatInstance(db, instanceId);
    const updates = {};
    if (gatewayUrlConfigured && gatewayUrl && existing.gateway_url !== gatewayUrl) {
      updates.gateway_url = gatewayUrl;
      console.log(`[instance-registry] self gateway_url ${existing.gateway_url || "(none)"} -> ${gatewayUrl} (CROW_PEER_GATEWAY_URL)`);
    } else if (!gatewayUrlConfigured && gatewayUrl && isPeerUsableUrl(gatewayUrl)
      && !isPeerUsableUrl(existing.gateway_url) && existing.gateway_url !== gatewayUrl) {
      // Boot repair: a self row with NO usable address (empty, or the
      // http://localhost fallback of a boot that raced tailscaled) gets the
      // derived one. A usable row — including a private :443 Serve URL,
      // which browsers and HTTP peer calls rely on — is never overwritten
      // by detection; the sync transport dials tailscale_ip + port for it.
      updates.gateway_url = gatewayUrl;
      console.log(`[instance-registry] self gateway_url ${existing.gateway_url || "(none)"} -> ${gatewayUrl} (no usable address; derived)`);
    }
    if (tailscaleIp && !existing.tailscale_ip) updates.tailscale_ip = tailscaleIp;
    if (Object.keys(updates).length) {
      await updateInstance(db, instanceId, updates);
      return { ...existing, ...updates };
    }
    return existing;
  }

  // Auto-register this instance
  const hn = osHostname();
  const cwd = process.cwd();
  const instanceName = name || `${hn}:${cwd}`;
  // Prefer CROW_DATA_DIR (the directory that actually holds crow.db) over
  // cwd so same-host peers can find this instance's DB file without
  // guessing.
  const dataDir = process.env.CROW_DATA_DIR || null;

  await registerInstance(db, {
    id: instanceId,
    name: instanceName,
    crowId: crowId || "unknown",
    directory: cwd,
    dataDir,
    hostname: hn,
    gatewayUrl: gatewayUrl || null,
    tailscaleIp: tailscaleIp || null,
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
export async function validateInstanceToken(db, token, opts = {}) {
  if (!token) return null;

  const tokenHash = createHash("sha256").update(token).digest("hex");

  // Authenticate any paired, non-revoked peer regardless of liveness.
  // Filtering on status='active' created a deadlock: a peer marked
  // 'offline' (after any probe failure — a restart, network blip, or the
  // downtime that originally flipped it) could never re-authenticate to
  // prove it was back, so federated MCP calls 500'd forever. `offline` is a
  // liveness signal, not a trust gate; trust is the token-hash match plus
  // not being revoked. Mirrors getTrustedInstances' predicate.
  const sql = "SELECT * FROM crow_instances WHERE auth_token_hash = ? AND status IN ('active','offline')";

  try {
    const { rows } = await db.execute({ sql, args: [tokenHash] });
    return rows[0] || null;
  } catch (err) {
    // A DB error here is NOT proof the token is invalid. The old
    // `catch { return null }` silently rejected EVERY paired peer as
    // `invalid_token` whenever this captured-at-startup connection hit a
    // transient WAL/shm desync or on-disk corruption — turning a database
    // fault into a total, SILENT cross-instance federation blackout that only
    // a gateway restart cleared, and that looked exactly like a bad token
    // (misdirecting diagnosis to the auth layer). Make it loud, and retry once
    // on a FRESH client: re-opening the file re-maps the WAL/shm and clears the
    // common transient case without a restart. Genuine corruption still fails,
    // but now visibly. (2026-06-14 incident: corrupt cross_host_calls page on
    // crow's primary crow.db blacked out all federated tool calls.)
    console.error(
      `[instance-registry] validateInstanceToken: DB error on captured client (retrying on a fresh client): ${err.message}`,
    );
    const makeFresh = opts._freshClient || createDbClient;
    let fresh;
    try {
      fresh = makeFresh();
      const { rows } = await fresh.execute({ sql, args: [tokenHash] });
      return rows[0] || null;
    } catch (err2) {
      console.error(
        `[instance-registry] validateInstanceToken: retry on a fresh client ALSO failed — federated auth is degraded, peer will be rejected: ${err2.message}`,
      );
      return null;
    } finally {
      try { fresh?.close?.(); } catch { /* ignore close errors */ }
    }
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

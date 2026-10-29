/**
 * Local MCP token — a single, per-instance, full-tool-access static bearer
 * token for headless / no-browser MCP clients (the remote-HTTP path that does
 * not run the OAuth dance). Only sha256(token) is stored, in a local-scoped
 * dashboard setting that never syncs to paired instances; the raw value is
 * shown exactly once at generation. See
 * the private engineering notes
 */
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { resolveCrowHome } from "../shared/crow-home.js";
import { writeFileSync, existsSync, chmodSync, mkdirSync, renameSync, unlinkSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { ensureSecretsDir, migrateLegacySecretFile } from "../shared/peer-credentials.js";
import {
  readSetting, writeSetting, deleteLocalSetting,
} from "./dashboard/settings/registry.js";

const HASH_KEY = "mcp_local_token_hash";
const CREATED_KEY = "mcp_local_token_created";

// Board token (Track 1 Task 6, D-T1.1 §3): a SECOND per-instance static
// token, same hash-in-settings shape as the local token above, but scoped at
// the TRANSPORT level to /board/(mcp|sse|messages) — see BOARD_PATH_RE below
// and its use in localTokenAuthMiddleware. Handing bots this token instead of
// the full-surface local token bounds their reach to exactly the board-mcp
// mount (which itself registers ONLY board_* tools), without a second
// tool-level allowlist. The raw token is never shown in the dashboard (there
// is no bot-facing UI reveal flow yet) — it is minted at boot when absent and
// persisted to <crowHome>/board-token mode 0600, the exact peer-tokens.json
// precedent mcp_writer.mjs already reads beside it (see crow-server-catalog.mjs).
const BOARD_HASH_KEY = "mcp_board_token_hash";
const BOARD_CREATED_KEY = "mcp_board_token_created";
const BOARD_PATH_RE = /^\/board\/(?:mcp|sse|messages)$/;

// Phone token (Phone bundle plan A): same shape as the board token, PATH-SCOPED
// to /phone/(mcp|sse|messages). Lets bots propose calls; nothing on that
// mount can dial (dialing requires an owner-approved single-use token).
const PHONE_HASH_KEY = "mcp_phone_token_hash";
const PHONE_CREATED_KEY = "mcp_phone_token_created";
const PHONE_PATH_RE = /^\/phone\/(?:mcp|sse|messages)$/;
function phoneTokenPath() {
  return join(crowHome(), "phone-token");
}

// Artifacts token (Crow Artifacts, spec §7.1): same shape, PATH-SCOPED to
// /artifacts/(mcp|sse|messages). A caller with only this token and no valid
// signed actor is UNATTRIBUTED there and sees nothing (fail closed).
const ARTIFACTS_HASH_KEY = "mcp_artifacts_token_hash";
const ARTIFACTS_CREATED_KEY = "mcp_artifacts_token_created";
const ARTIFACTS_PATH_RE = /^\/artifacts\/(?:mcp|sse|messages)$/;
function artifactsTokenPath() {
  return join(crowHome(), "artifacts-token");
}

// Not importing resolveCrowHome from ./proxy.js — proxy.js pulls in the
// McpServer/Client/StdioClientTransport machinery. The shared resolver is
// dependency-free.
function crowHome() {
  return resolveCrowHome();
}

function boardTokenPath() {
  return join(crowHome(), "board-token");
}

function sha256Hex(s) {
  return createHash("sha256").update(s).digest("hex");
}

/** Generate a new token, overwriting any existing one (this is also "rotate").
 *  Stores only the hash; returns the raw token for one-time display. */
export async function generateLocalToken(db) {
  const token = randomBytes(32).toString("hex");
  await writeSetting(db, HASH_KEY, sha256Hex(token), { scope: "local" });
  await writeSetting(db, CREATED_KEY, new Date().toISOString(), { scope: "local" });
  return token;
}

export async function revokeLocalToken(db) {
  await deleteLocalSetting(db, HASH_KEY);
  await deleteLocalSetting(db, CREATED_KEY);
}

/** Non-sensitive status for the UI. Never returns the raw token or the hash. */
export async function getLocalTokenMeta(db) {
  const hash = await readSetting(db, HASH_KEY);
  if (!hash) return { present: false, createdAt: null };
  const createdAt = await readSetting(db, CREATED_KEY);
  return { present: true, createdAt: createdAt || null };
}

export async function validateLocalToken(db, token) {
  if (!token) return false;
  const stored = await readSetting(db, HASH_KEY);
  if (!stored) return false;
  const a = Buffer.from(sha256Hex(token), "hex");
  const b = Buffer.from(stored, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Synthesized req.auth for a validated local-operator token request. Full
 *  tool access, identical surface to an OAuth client (scopes ["mcp:tools"]).
 *  The 300s expiry is NOT a session lifetime: skipAuthForInstance re-runs and
 *  re-synthesizes per request, exactly like the peer branch (mcp.js:247).
 *  Nothing downstream re-checks expiresAt. */
export function localOperatorAuth(tokenScope) {
  const auth = {
    token: "local-mcp",
    clientId: "local-mcp",
    scopes: ["mcp:tools"],
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  };
  // S2: which static token authenticated ("phone" for the path-scoped phone
  // token). Lets /phone/mcp tell a bot's shared token from the operator's full
  // local token; the full token carries no scope, exactly as before.
  if (tokenScope) auth.extra = { tokenScope };
  return auth;
}

/** Turn a validated local-token flag into a full-access req.auth. Returns true
 *  when it handled the request (caller should next()), false to fall through to
 *  OAuth. Deliberately takes ONLY req: it has no peerGate dependency, so a local
 *  token is never run through the peer exposure gate. Called by
 *  skipAuthForInstance in routes/mcp.js, after the instance branch. */
export function applyLocalTokenAuth(req) {
  if (!req.localTokenAuth) return false;
  req.auth = localOperatorAuth(req.localTokenAuth.scope);
  return true;
}

/** Generate a new board token, overwriting any existing one. Stores only the
 *  hash (local-scope setting) plus persists the raw value to
 *  <crowHome>/board-token mode 0600 (bot configs read the raw file directly,
 *  db-agnostic mcp_writer.mjs never touches the settings registry). Returns
 *  the raw token. */
export async function generateBoardToken(db) {
  const token = randomBytes(32).toString("hex");
  await writeSetting(db, BOARD_HASH_KEY, sha256Hex(token), { scope: "local" });
  await writeSetting(db, BOARD_CREATED_KEY, new Date().toISOString(), { scope: "local" });
  const path = boardTokenPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
  // writeFileSync's `mode` is honored only when it CREATES the file; an
  // existing-but-empty file would keep whatever perms it had.
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
  return token;
}

export async function validateBoardToken(db, token) {
  if (!token) return false;
  const stored = await readSetting(db, BOARD_HASH_KEY);
  if (!stored) return false;
  const a = Buffer.from(sha256Hex(token), "hex");
  const b = Buffer.from(stored, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Non-sensitive status. Never returns the raw token or the hash. */
export async function getBoardTokenMeta(db) {
  const hash = await readSetting(db, BOARD_HASH_KEY);
  if (!hash) return { present: false, createdAt: null };
  const createdAt = await readSetting(db, BOARD_CREATED_KEY);
  return { present: true, createdAt: createdAt || null };
}

/** Idempotent boot mint (called from boot/mcp-mounts.js): a hash setting AND
 *  a readable raw file both present → no-op (the common case on every boot
 *  after the first). Hash present but the file is missing (deleted disk,
 *  fresh restore) → re-mint both, since the raw file is the ONLY place a bot
 *  config could have read the token from — nothing currently holds a valid
 *  copy if it's gone. No hash at all → mint fresh. Returns {minted:boolean}. */
export async function ensureBoardToken(db) {
  const hash = await readSetting(db, BOARD_HASH_KEY);
  if (hash && existsSync(boardTokenPath())) return { minted: false };
  await generateBoardToken(db);
  return { minted: true };
}

export async function generatePhoneToken(db) {
  const token = randomBytes(32).toString("hex");
  await writeSetting(db, PHONE_HASH_KEY, sha256Hex(token), { scope: "local" });
  await writeSetting(db, PHONE_CREATED_KEY, new Date().toISOString(), { scope: "local" });
  const path = phoneTokenPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
  return token;
}

export async function validatePhoneToken(db, token) {
  if (!token) return false;
  const stored = await readSetting(db, PHONE_HASH_KEY);
  if (!stored) return false;
  const a = Buffer.from(sha256Hex(token), "hex");
  const b = Buffer.from(stored, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function ensurePhoneToken(db) {
  const hash = await readSetting(db, PHONE_HASH_KEY);
  if (hash && existsSync(phoneTokenPath())) return { minted: false };
  await generatePhoneToken(db);
  return { minted: true };
}

export const PHONE_TOKEN_KEYS = { PHONE_HASH_KEY, PHONE_CREATED_KEY };

export async function generateArtifactsToken(db) {
  const token = randomBytes(32).toString("hex");
  await writeSetting(db, ARTIFACTS_HASH_KEY, sha256Hex(token), { scope: "local" });
  await writeSetting(db, ARTIFACTS_CREATED_KEY, new Date().toISOString(), { scope: "local" });
  const path = artifactsTokenPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
  return token;
}

export async function validateArtifactsToken(db, token) {
  if (!token) return false;
  const stored = await readSetting(db, ARTIFACTS_HASH_KEY);
  if (!stored) return false;
  const a = Buffer.from(sha256Hex(token), "hex");
  const b = Buffer.from(stored, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function ensureArtifactsToken(db) {
  const hash = await readSetting(db, ARTIFACTS_HASH_KEY);
  if (hash && existsSync(artifactsTokenPath())) return { minted: false };
  await generateArtifactsToken(db);
  return { minted: true };
}

// Peer-relay token (item 46 PR-B): same shape as the artifacts token (hash in
// a local-scope setting, raw value in <crowHome>/secrets/peer-relay-token 600,
// in the 700 dir the pi sandbox hides from bots; older versions kept it at
// <crowHome>/peer-relay-token and it is moved at boot). The bot engine reads
// it outside the sandbox and hands its VALUE to the remote proxy in the
// proxy's block env, never a path a bot shell could open. A pi
// bot's remote proxy presents it, with its signed actor headers, to the
// loopback relay at /peer-relay/... (routes/peer-relay.js), which validates it
// itself. It is accepted NOWHERE else: localTokenAuthMiddleware never consults
// it, so it authenticates no MCP mount.
const PEER_RELAY_HASH_KEY = "mcp_peer_relay_token_hash";
const PEER_RELAY_CREATED_KEY = "mcp_peer_relay_token_created";
export function peerRelayTokenPath() {
  return join(crowHome(), "secrets", "peer-relay-token");
}
function legacyPeerRelayTokenPath() {
  return join(crowHome(), "peer-relay-token");
}

export async function generatePeerRelayToken(db) {
  const token = randomBytes(32).toString("hex");
  await writeSetting(db, PEER_RELAY_HASH_KEY, sha256Hex(token), { scope: "local" });
  await writeSetting(db, PEER_RELAY_CREATED_KEY, new Date().toISOString(), { scope: "local" });
  const path = peerRelayTokenPath();
  ensureSecretsDir(dirname(path));
  writeFileSync(path, token, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
  return token;
}

export async function validatePeerRelayToken(db, token) {
  if (!token || typeof token !== "string") return false;
  const stored = await readSetting(db, PEER_RELAY_HASH_KEY);
  if (!stored) return false;
  const a = Buffer.from(sha256Hex(token), "hex");
  const b = Buffer.from(stored, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function ensurePeerRelayToken(db) {
  const hash = await readSetting(db, PEER_RELAY_HASH_KEY);
  // An older version's token at <crowHome>/peer-relay-token moves into
  // secrets/ only when it is the minted one (its hash matches): a bot shell
  // can write the old path, so anything else there is discarded.
  const legacy = legacyPeerRelayTokenPath();
  try {
    if (existsSync(legacy)) {
      const tok = readFileSync(legacy, "utf8").trim();
      if (hash && tok && sha256Hex(tok) === hash) migrateLegacySecretFile(legacy, peerRelayTokenPath());
      else { unlinkSync(legacy); console.warn(`[gateway] discarded ${legacy}: not this instance's minted relay token`); }
    }
  } catch (err) {
    console.warn(`[gateway] could not move the peer-relay token into secrets/: ${err.message}`);
  }
  if (hash && existsSync(peerRelayTokenPath())) return { minted: false };
  await generatePeerRelayToken(db);
  return { minted: true };
}

// Kiosk announce token (kiosk spec §4.1): lets the kiosk bundle's stdio MCP
// server reach the gateway's live display sessions through loopback-only
// /api/kiosk/internal/*. Same shape as the board/phone tokens (hash in a
// local-scope setting, raw value in <crowHome>/kiosk-announce-token 0600) but
// accepted NOWHERE else — validateLocalToken never consults it.
const KIOSK_ANNOUNCE_HASH_KEY = "kiosk_announce_token_hash";
const KIOSK_ANNOUNCE_CREATED_KEY = "kiosk_announce_token_created";
function kioskAnnounceTokenPath() {
  return join(crowHome(), "kiosk-announce-token");
}

export async function generateKioskAnnounceToken(db) {
  const token = randomBytes(32).toString("hex");
  await writeSetting(db, KIOSK_ANNOUNCE_HASH_KEY, sha256Hex(token), { scope: "local" });
  await writeSetting(db, KIOSK_ANNOUNCE_CREATED_KEY, new Date().toISOString(), { scope: "local" });
  const path = kioskAnnounceTokenPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
  return token;
}

export async function validateKioskAnnounceToken(db, token) {
  if (!token) return false;
  const stored = await readSetting(db, KIOSK_ANNOUNCE_HASH_KEY);
  if (!stored) return false;
  const a = Buffer.from(sha256Hex(token), "hex");
  const b = Buffer.from(stored, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function ensureKioskAnnounceToken(db) {
  const hash = await readSetting(db, KIOSK_ANNOUNCE_HASH_KEY);
  if (hash && existsSync(kioskAnnounceTokenPath())) return { minted: false };
  await generateKioskAnnounceToken(db);
  return { minted: true };
}

export const KIOSK_ANNOUNCE_TOKEN_KEYS = { HASH: KIOSK_ANNOUNCE_HASH_KEY, CREATED: KIOSK_ANNOUNCE_CREATED_KEY };

// Models token (models arc plan 2, Task 6): path-scoped to the lifecycle API
// under /llm/models. pi-lab reads it from <crowHome>/models-token. It cannot
// reach any MCP mount: the MCP middleware never consults it.
const MODELS_HASH_KEY = "mcp_models_token_hash";
const MODELS_CREATED_KEY = "mcp_models_token_created";
export function modelsTokenPath() {
  return join(crowHome(), "models-token");
}

export async function generateModelsToken(db) {
  const token = randomBytes(32).toString("hex");
  await writeSetting(db, MODELS_HASH_KEY, sha256Hex(token), { scope: "local" });
  await writeSetting(db, MODELS_CREATED_KEY, new Date().toISOString(), { scope: "local" });
  const path = modelsTokenPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
  return token;
}

export async function validateModelsToken(db, token) {
  if (!token) return false;
  const stored = await readSetting(db, MODELS_HASH_KEY);
  if (!stored) return false;
  const a = Buffer.from(sha256Hex(token), "hex");
  const b = Buffer.from(stored, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function ensureModelsToken(db) {
  const hash = await readSetting(db, MODELS_HASH_KEY);
  if (hash && existsSync(modelsTokenPath())) return { minted: false };
  await generateModelsToken(db);
  return { minted: true };
}

export const MODELS_TOKEN_KEYS = { MODELS_HASH_KEY, MODELS_CREATED_KEY };

// Cloud-door token (roles phase 2, Task 14): lets bots reach cloud models
// through the gateway's /llm/c door without ever holding a provider key. pi
// reads it per request from a models.json `!<command>` apiKey (pi runs that
// command uncached on every auth resolve), so a token rotated at boot reaches
// a pi process that is already running.
//
// The file deliberately lives at <crowHome>/llm-cloud-token, OUTSIDE
// <crowHome>/secrets/: the bot sandbox (bwrap) hides secrets/ from pi, so a
// token there would be unreadable to the bots it exists for. Peer tokens are
// moving INTO secrets/; this one is different on purpose: it is meant for
// bots, and it is scoped to the cloud door only. validateLlmCloudToken checks
// this one hash and nothing else, so no other token (local, board, phone,
// artifacts, kiosk, models) opens the door, and this token opens nothing but
// the door (no other validator consults its hash).
//
// Rotated on EVERY boot (no ensure/no-op path): a fresh random value per start.
const LLM_CLOUD_HASH_KEY = "mcp_llm_cloud_token_hash";
const LLM_CLOUD_CREATED_KEY = "mcp_llm_cloud_token_created";
export function llmCloudTokenPath() {
  return join(crowHome(), "llm-cloud-token");
}

/** New random 32-byte hex token every call. Order keeps the file and the
 *  stored hash matching whenever a step fails:
 *    1. write the raw value to a temp file in the same directory (wx, 0600),
 *       then chmod 0600: a failure here changes nothing;
 *    2. store the new hash (local scope): a failure here removes the temp
 *       file, and the old file and old hash still match;
 *    3. rename the temp file over the old one: a failure here puts the old
 *       hash back, so the old file keeps validating.
 *  A reader sees the old token or the new one, never a partial or
 *  world-readable file. Returns the raw token. */
export async function rotateLlmCloudToken(db) {
  return rotateTokenFile(db, {
    path: llmCloudTokenPath(), hashKey: LLM_CLOUD_HASH_KEY, createdKey: LLM_CLOUD_CREATED_KEY, label: "llm-cloud-token",
    ensureDir: (d) => mkdirSync(d, { recursive: true }), onFailure: "restore",
  });
}

/**
 * The one rotation both per-boot token shapes use (the cloud-door token and
 * every pathScopedToken). Steps 1-3 as rotateLlmCloudToken describes. What a
 * failure leaves behind is the caller's choice:
 *  - "restore" (the cloud door): the old file and the old hash keep matching,
 *    so the old token keeps validating;
 *  - "fail-closed" (the loopback tool families, "rotated every boot"): ANY
 *    failure deletes the stored hash, so no token validates (not even the
 *    previous boot's) until a rotation succeeds.
 * Throws the step's error either way.
 */
async function rotateTokenFile(db, { path, hashKey, createdKey, label, ensureDir, onFailure }) {
  const token = randomBytes(32).toString("hex");
  const failClosed = async (err) => {
    try { await deleteLocalSetting(db, hashKey); } catch (e) {
      console.warn(`[${label}] could not delete the stored hash after a failed rotation: ${e.message}`);
    }
    throw err;
  };
  const bail = async (err) => { if (onFailure === "fail-closed") return failClosed(err); throw err; };
  try { ensureDir(dirname(path)); } catch (err) { return bail(err); }
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const dropTmp = () => { try { unlinkSync(tmp); } catch { /* already gone */ } };
  try {
    writeFileSync(tmp, token, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
  } catch (err) {
    dropTmp();
    return bail(err);
  }
  let oldHash;
  try {
    oldHash = await readSetting(db, hashKey);
    await writeSetting(db, hashKey, sha256Hex(token), { scope: "local" });
  } catch (err) {
    dropTmp();
    return bail(err);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    dropTmp();
    if (onFailure === "fail-closed") return failClosed(err);
    try {
      if (oldHash) await writeSetting(db, hashKey, oldHash, { scope: "local" });
      else await deleteLocalSetting(db, hashKey);
    } catch (restoreErr) {
      // Best effort: the next boot rotates again. Until then the stored hash
      // matches no file, so nothing validates.
      console.warn(`[${label}] could not put the old hash back after a failed rename: ${restoreErr.message}`);
    }
    throw err;
  }
  try {
    await writeSetting(db, createdKey, new Date().toISOString(), { scope: "local" });
  } catch { /* informational only */ }
  return token;
}

/** Timing-safe check against the cloud-door hash ONLY. */
export async function validateLlmCloudToken(db, token) {
  if (!token || typeof token !== "string") return false;
  const stored = await readSetting(db, LLM_CLOUD_HASH_KEY);
  if (!stored) return false;
  const a = Buffer.from(sha256Hex(token), "hex");
  const b = Buffer.from(stored, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const LLM_CLOUD_TOKEN_KEYS = { HASH: LLM_CLOUD_HASH_KEY, CREATED: LLM_CLOUD_CREATED_KEY };

// Path-scoped token factory (loopback mount helper, spec §2.1): ONE shape for
// every loopback-mounted family (services, satellite tools, ...). The raw token
// lives at <crowHome>/secrets/<name>-token (0600), only its sha256 in a
// local-scope setting under the family's OWN hash key, so validate() accepts
// that family's token and nothing else: no local/board/phone/... token opens a
// family mount, and a family token opens no other validator (none of them
// consult these keys). `home` (string or () => string) overrides the crow home
// for tests. Rotated on EVERY boot (see boot/mcp-mounts.js), never "ensure".
export function pathScopedToken({ name, hashKey, createdKey, home }) {
  const root = () => (typeof home === "function" ? home() : home) || crowHome();
  const path = () => join(root(), "secrets", `${name}-token`);
  return {
    name,
    path,
    /** rotateTokenFile's ordering (a reader sees the old token or the new
     *  one, never a partial or world-readable file), failing CLOSED: any
     *  failure deletes this family's stored hash, so the previous boot's
     *  token stops validating and the family refuses every request until a
     *  rotation succeeds (the next boot). secrets/ is made (and tightened)
     *  0700 by the shared ensureSecretsDir. */
    async rotate(db) {
      return rotateTokenFile(db, { path: path(), hashKey, createdKey, label: `${name}-token`, ensureDir: ensureSecretsDir, onFailure: "fail-closed" });
    },
    /** Timing-safe check against this family's hash ONLY. */
    async validate(db, token) {
      try {
        if (!token || typeof token !== "string") return false;
        const stored = await readSetting(db, hashKey);
        if (!stored) return false;
        const a = Buffer.from(sha256Hex(token), "hex");
        const b = Buffer.from(stored, "hex");
        return a.length === b.length && timingSafeEqual(a, b);
      } catch { return false; }
    },
  };
}

// Key names follow this file's existing `mcp_<x>_token_hash` / `_created` shape.
export const SERVICES_TOKEN = pathScopedToken({ name: "services", hashKey: "mcp_services_token_hash", createdKey: "mcp_services_token_created" });
export const SATELLITE_TOOLS_TOKEN = pathScopedToken({ name: "satellite-tools", hashKey: "mcp_satellite_tools_token_hash", createdKey: "mcp_satellite_tools_token_created" });

// MCP transport paths are `/mcp`, `/sse`, `/messages`, optionally under ONE
// server-prefix segment (e.g. /router/mcp, /memory/sse, /tools-x/messages,
// /blog-mcp/mcp; see mcp.js:194-196 and the single-segment mountMcpServer
// prefixes in index.js). req.localTokenAuth is only consumed on these, so the
// middleware reads the DB only for them. Anchoring to this exact shape avoids
// matching unrelated routes that merely end in /messages (e.g.
// /dashboard/streams/messages, /api/chat/.../messages).
const MCP_PATH_RE = /^(?:\/[a-z0-9-]+)?\/(?:mcp|sse|messages)$/;
function isMcpPath(p) {
  return typeof p === "string" && MCP_PATH_RE.test(p);
}

/** Express middleware. Mounted globally right after instanceAuthMiddleware, but
 *  it only reads the DB for MCP-path requests (cost guard). Sets
 *  req.localTokenAuth on a valid local token. Yields to instance auth, never
 *  hard-rejects (falls through to OAuth), and fast-exits with no Bearer header,
 *  no token configured, or a non-MCP path. */
export function localTokenAuthMiddleware(db) {
  return async (req, res, next) => {
    try {
      if (req.instanceAuth) return next();
      if (!isMcpPath(req.path)) return next();
      const h = req.headers?.authorization;
      if (!h || !h.startsWith("Bearer ")) return next();
      const token = h.slice(7);
      if (await validateLocalToken(db, token)) {
        req.localTokenAuth = { token: "local-mcp" };
        return next();
      }
      // Board token (Track 1 Task 6): PATH-SCOPED — only tried, and only ever
      // authenticates, on the /board/(mcp|sse|messages) transport paths. A
      // board token presented against any other MCP mount (e.g. /memory/mcp)
      // falls through unauthenticated here and 401s downstream via OAuth,
      // same as any other unrecognized bearer token. Synthesizes the SAME
      // req.localTokenAuth flag as the full local token: the scoping this
      // token provides is entirely the path check above — /board/mcp itself
      // registers only board_* tools, so there is no separate tool-level
      // allowlist to apply.
      if (BOARD_PATH_RE.test(req.path) && await validateBoardToken(db, token)) {
        // S5: scope "board" lets board-mcp tell the bots' shared token from
        // the operator's full local token (a board-token caller is never the
        // owner 'session' actor). Same mechanism as the phone scope below.
        req.localTokenAuth = { token: "local-mcp", scope: "board" };
      }
      if (!req.localTokenAuth && PHONE_PATH_RE.test(req.path) && await validatePhoneToken(db, token)) {
        req.localTokenAuth = { token: "local-mcp", scope: "phone" };
      }
      if (!req.localTokenAuth && ARTIFACTS_PATH_RE.test(req.path) && await validateArtifactsToken(db, token)) {
        req.localTokenAuth = { token: "local-mcp", scope: "artifacts" };
      }
    } catch (err) {
      // Treat a DB/read error as non-fatal: log and fall through to the other
      // auth methods (OAuth) rather than propagating a 500. A transient settings
      // read must never block a legitimate OAuth-authenticated MCP request.
      console.warn("[local-token] auth check error:", err.message);
    }
    return next();
  };
}

export const LOCAL_TOKEN_KEYS = { HASH_KEY, CREATED_KEY };
export const BOARD_TOKEN_KEYS = { HASH_KEY: BOARD_HASH_KEY, CREATED_KEY: BOARD_CREATED_KEY };

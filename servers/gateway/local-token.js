/**
 * Local MCP token — a single, per-instance, full-tool-access static bearer
 * token for headless / no-browser MCP clients (the remote-HTTP path that does
 * not run the OAuth dance). Only sha256(token) is stored, in a local-scoped
 * dashboard setting that never syncs to paired instances; the raw value is
 * shown exactly once at generation. See
 * docs/superpowers/specs/2026-06-10-f6c2-connect-token-design.md.
 */
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
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

// Deliberately self-contained (not importing resolveCrowHome from ./proxy.js)
// — proxy.js pulls in the McpServer/Client/StdioClientTransport machinery for
// the external-integrations proxy, which this file has no other reason to
// load. Identical resolution order to proxy.js's resolveCrowHome().
function crowHome() {
  return process.env.CROW_HOME || join(homedir(), ".crow");
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
export function localOperatorAuth() {
  return {
    token: "local-mcp",
    clientId: "local-mcp",
    scopes: ["mcp:tools"],
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  };
}

/** Turn a validated local-token flag into a full-access req.auth. Returns true
 *  when it handled the request (caller should next()), false to fall through to
 *  OAuth. Deliberately takes ONLY req: it has no peerGate dependency, so a local
 *  token is never run through the peer exposure gate. Called by
 *  skipAuthForInstance in routes/mcp.js, after the instance branch. */
export function applyLocalTokenAuth(req) {
  if (!req.localTokenAuth) return false;
  req.auth = localOperatorAuth();
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
        req.localTokenAuth = { token: "local-mcp" };
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

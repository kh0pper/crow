/**
 * Local MCP token — a single, per-instance, full-tool-access static bearer
 * token for headless / no-browser MCP clients (the remote-HTTP path that does
 * not run the OAuth dance). Only sha256(token) is stored, in a local-scoped
 * dashboard setting that never syncs to paired instances; the raw value is
 * shown exactly once at generation. See
 * docs/superpowers/specs/2026-06-10-f6c2-connect-token-design.md.
 */
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import {
  readSetting, writeSetting, deleteLocalSetting,
} from "./dashboard/settings/registry.js";

const HASH_KEY = "mcp_local_token_hash";
const CREATED_KEY = "mcp_local_token_created";

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
      if (await validateLocalToken(db, h.slice(7))) {
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

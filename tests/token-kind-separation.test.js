// S4 (2026-10-02): dashboard sessions and OAuth MCP tokens share the
// oauth_tokens table (both token_type 'access'). They must not stand in for
// each other in EITHER direction:
//  - a dashboard session token must not verify as an MCP bearer token
//    (verifyAccessToken also backs /introspect);
//  - an OAuth MCP token must not verify as a dashboard session, which holds
//    as long as no OAuth client can ever be registered as 'dashboard'.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const iso = (deltaMs) => new Date(Date.now() + deltaMs).toISOString();
const HOUR = 3_600_000;

const saved = { CROW_DB_PATH: process.env.CROW_DB_PATH };
let dir, dbPath, raw;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "token-kind-"));
  dbPath = join(dir, "crow.db");
  process.env.CROW_DB_PATH = dbPath;
  raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE oauth_clients (client_id TEXT PRIMARY KEY, metadata TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE oauth_tokens (token TEXT PRIMARY KEY, token_type TEXT NOT NULL, client_id TEXT NOT NULL,
      scopes TEXT DEFAULT '', resource TEXT, expires_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, actor TEXT,
      ip_address TEXT, details TEXT, created_at TEXT DEFAULT (datetime('now')));
  `);
  // Exactly the shapes the two writers produce.
  raw.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', 'dashboard', ?)")
    .run(sha("dash-session"), iso(HOUR));
  raw.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', 'dashboard sso', ?)")
    .run(sha("dash-sso"), iso(HOUR));
  raw.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, resource) VALUES (?, 'access', ?, 'mcp:tools', datetime('now', '+3600 seconds'), NULL)")
    .run(sha("mcp-token"), "0b6c1c62-9f7e-4d2a-8a39-1c1b2f7a4e11");
});

after(() => {
  try { raw.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test("a dashboard session token is NOT an MCP bearer token", async () => {
  const { createOAuthProvider } = await import("../servers/gateway/auth.js");
  const p = createOAuthProvider(dbPath);
  try {
    await assert.rejects(p.verifyAccessToken("dash-session"), /invalid token/i);
    await assert.rejects(p.verifyAccessToken("dash-sso"), /invalid token/i);
    // The rejection must not delete the live session row (only expiry does).
    assert.ok(raw.prepare("SELECT 1 FROM oauth_tokens WHERE token=?").get(sha("dash-session")));
  } finally { p.db.close(); }
});

test("a real OAuth MCP token still verifies as a bearer token", async () => {
  const { createOAuthProvider } = await import("../servers/gateway/auth.js");
  const p = createOAuthProvider(dbPath);
  try {
    const info = await p.verifyAccessToken("mcp-token");
    assert.equal(info.clientId, "0b6c1c62-9f7e-4d2a-8a39-1c1b2f7a4e11");
    assert.deepEqual(info.scopes, ["mcp:tools"]);
  } finally { p.db.close(); }
});

test("reverse: an OAuth MCP token is NOT a dashboard session; a session still is", async () => {
  const { verifySession } = await import("../servers/gateway/dashboard/auth.js");
  assert.equal(await verifySession("mcp-token"), false);
  assert.equal(await verifySession("dash-session"), true);
});

test("reverse: no OAuth client can be registered under the dashboard's client_id", async () => {
  const { createOAuthProvider, DASHBOARD_CLIENT_ID } = await import("../servers/gateway/auth.js");
  assert.equal(DASHBOARD_CLIENT_ID, "dashboard");
  const p = createOAuthProvider(dbPath);
  try {
    await assert.rejects(p.clientsStore.registerClient({ client_id: "dashboard", redirect_uris: ["https://x/cb"] }), /reserved/);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM oauth_clients WHERE client_id='dashboard'").get().n, 0);
    const ok = await p.clientsStore.registerClient({ client_id: "c-normal", redirect_uris: ["https://x/cb"] });
    assert.equal(ok.client_id, "c-normal");
  } finally { p.db.close(); }
});

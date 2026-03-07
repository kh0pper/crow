/**
 * Crow Gateway — OAuth 2.1 Provider
 *
 * Implements OAuth 2.1 with Dynamic Client Registration for Claude Connectors.
 * Stores clients and tokens in SQLite for persistence across restarts.
 * Based on the MCP SDK's DemoInMemoryOAuthProvider pattern but production-ready.
 */

import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class CrowOAuthClientsStore {
  constructor(db) {
    this.db = db;
  }

  async getClient(clientId) {
    const row = this.db.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(clientId);
    if (!row) return undefined;
    return JSON.parse(row.metadata);
  }

  async registerClient(clientMetadata) {
    this.db.prepare(
      "INSERT OR REPLACE INTO oauth_clients (client_id, metadata, created_at) VALUES (?, ?, datetime('now'))"
    ).run(clientMetadata.client_id, JSON.stringify(clientMetadata));
    return clientMetadata;
  }
}

export class CrowOAuthProvider {
  constructor(db) {
    this.db = db;
    this.clientsStore = new CrowOAuthClientsStore(db);
    this.codes = new Map(); // Ephemeral — auth codes are short-lived
  }

  async authorize(client, params, res) {
    const code = randomUUID();
    const searchParams = new URLSearchParams({ code });

    if (params.state !== undefined) {
      searchParams.set("state", params.state);
    }

    this.codes.set(code, { client, params, expiresAt: Date.now() + 600000 }); // 10 min

    if (!client.redirect_uris || !client.redirect_uris.includes(params.redirectUri)) {
      res.status(400).json({ error: "invalid_request", error_description: "Unregistered redirect_uri" });
      return;
    }

    const targetUrl = new URL(params.redirectUri);
    targetUrl.search = searchParams.toString();
    res.redirect(targetUrl.toString());
  }

  async challengeForAuthorizationCode(client, authorizationCode) {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData) throw new Error("Invalid authorization code");
    return codeData.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier) {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData) throw new Error("Invalid authorization code");
    if (codeData.expiresAt < Date.now()) {
      this.codes.delete(authorizationCode);
      throw new Error("Authorization code expired");
    }
    if (codeData.client.client_id !== client.client_id) {
      throw new Error("Authorization code was not issued to this client");
    }

    this.codes.delete(authorizationCode);

    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    const expiresIn = 86400; // 24 hours

    // Store tokens in DB
    this.db.prepare(`
      INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, resource)
      VALUES (?, 'access', ?, ?, datetime('now', '+${expiresIn} seconds'), ?)
    `).run(
      accessToken,
      client.client_id,
      (codeData.params.scopes || []).join(" "),
      codeData.params.resource || null
    );

    this.db.prepare(`
      INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, resource)
      VALUES (?, 'refresh', ?, ?, datetime('now', '+30 days'), ?)
    `).run(
      refreshToken,
      client.client_id,
      (codeData.params.scopes || []).join(" "),
      codeData.params.resource || null
    );

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: (codeData.params.scopes || []).join(" "),
    };
  }

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    const row = this.db.prepare(
      "SELECT * FROM oauth_tokens WHERE token = ? AND token_type = 'refresh' AND client_id = ?"
    ).get(refreshToken, client.client_id);

    if (!row) throw new Error("Invalid refresh token");
    if (new Date(row.expires_at) < new Date()) {
      this.db.prepare("DELETE FROM oauth_tokens WHERE token = ?").run(refreshToken);
      throw new Error("Refresh token expired");
    }

    // Issue new access token
    const newAccessToken = randomUUID();
    const expiresIn = 86400;

    this.db.prepare(`
      INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, resource)
      VALUES (?, 'access', ?, ?, datetime('now', '+${expiresIn} seconds'), ?)
    `).run(
      newAccessToken,
      client.client_id,
      row.scopes,
      resource || row.resource
    );

    return {
      access_token: newAccessToken,
      token_type: "bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken, // Reuse same refresh token
      scope: row.scopes,
    };
  }

  async verifyAccessToken(token) {
    const row = this.db.prepare(
      "SELECT * FROM oauth_tokens WHERE token = ? AND token_type = 'access'"
    ).get(token);

    if (!row) throw new Error("Invalid token");
    if (new Date(row.expires_at) < new Date()) {
      this.db.prepare("DELETE FROM oauth_tokens WHERE token = ?").run(token);
      throw new Error("Token expired");
    }

    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes ? row.scopes.split(" ") : [],
      expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000),
      resource: row.resource,
    };
  }
}

/**
 * Initialize OAuth tables in the database.
 */
export function initOAuthTables(dbPath) {
  const DB_PATH = dbPath || process.env.CROW_DB_PATH || resolve(__dirname, "../../data/crow.db");
  mkdirSync(dirname(DB_PATH), { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      metadata TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      token TEXT PRIMARY KEY,
      token_type TEXT NOT NULL CHECK(token_type IN ('access', 'refresh')),
      client_id TEXT NOT NULL,
      scopes TEXT DEFAULT '',
      resource TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tokens_client ON oauth_tokens(client_id);
    CREATE INDEX IF NOT EXISTS idx_tokens_type ON oauth_tokens(token_type);
  `);

  // Clean up expired tokens on startup
  db.prepare("DELETE FROM oauth_tokens WHERE expires_at < datetime('now')").run();

  db.close();
}

/**
 * Create an OAuth provider backed by the given database.
 */
export function createOAuthProvider(dbPath) {
  const DB_PATH = dbPath || process.env.CROW_DB_PATH || resolve(__dirname, "../../data/crow.db");
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  return new CrowOAuthProvider(db);
}

/**
 * Crow Gateway — OAuth 2.1 Provider
 *
 * Implements OAuth 2.1 with Dynamic Client Registration for Claude Connectors.
 * Stores clients and tokens in the database for persistence across restarts.
 * Based on the MCP SDK's DemoInMemoryOAuthProvider pattern but production-ready.
 */

import { randomUUID, createHash } from "node:crypto";
import { createDbClient } from "../db.js";

export class CrowOAuthClientsStore {
  constructor(db) {
    this.db = db;
  }

  async getClient(clientId) {
    const { rows } = await this.db.execute({
      sql: "SELECT * FROM oauth_clients WHERE client_id = ?",
      args: [clientId],
    });
    if (rows.length === 0) return undefined;
    return JSON.parse(rows[0].metadata);
  }

  async registerClient(clientMetadata) {
    await this.db.execute({
      sql: "INSERT OR REPLACE INTO oauth_clients (client_id, metadata, created_at) VALUES (?, ?, datetime('now'))",
      args: [clientMetadata.client_id, JSON.stringify(clientMetadata)],
    });
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

  async exchangeAuthorizationCode(client, authorizationCode, codeVerifier) {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData) throw new Error("Invalid authorization code");
    if (codeData.expiresAt < Date.now()) {
      this.codes.delete(authorizationCode);
      throw new Error("Authorization code expired");
    }
    if (codeData.client.client_id !== client.client_id) {
      throw new Error("Authorization code was not issued to this client");
    }

    // PKCE validation
    if (codeData.params.codeChallenge) {
      if (!codeVerifier) {
        throw new Error("Code verifier required");
      }
      if (codeData.params.codeChallengeMethod === "S256") {
        const hash = createHash("sha256").update(codeVerifier).digest("base64url");
        if (hash !== codeData.params.codeChallenge) {
          throw new Error("Invalid code verifier");
        }
      } else if (codeVerifier !== codeData.params.codeChallenge) {
        throw new Error("Invalid code verifier");
      }
    }

    this.codes.delete(authorizationCode);

    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    const expiresIn = 86400; // 24 hours

    // Store tokens in DB
    await this.db.execute({
      sql: `INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, resource)
            VALUES (?, 'access', ?, ?, datetime('now', '+' || ? || ' seconds'), ?)`,
      args: [
        accessToken,
        client.client_id,
        (codeData.params.scopes || []).join(" "),
        expiresIn,
        codeData.params.resource || null,
      ],
    });

    await this.db.execute({
      sql: `INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, resource)
            VALUES (?, 'refresh', ?, ?, datetime('now', '+30 days'), ?)`,
      args: [
        refreshToken,
        client.client_id,
        (codeData.params.scopes || []).join(" "),
        codeData.params.resource || null,
      ],
    });

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: (codeData.params.scopes || []).join(" "),
    };
  }

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    const { rows } = await this.db.execute({
      sql: "SELECT * FROM oauth_tokens WHERE token = ? AND token_type = 'refresh' AND client_id = ?",
      args: [refreshToken, client.client_id],
    });

    if (rows.length === 0) throw new Error("Invalid refresh token");
    const row = rows[0];
    if (new Date(row.expires_at) < new Date()) {
      await this.db.execute({ sql: "DELETE FROM oauth_tokens WHERE token = ?", args: [refreshToken] });
      throw new Error("Refresh token expired");
    }

    // Absolute session expiration — reject if token was created more than 30 days ago
    if (row.created_at) {
      const createdAt = new Date(row.created_at);
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      if (Date.now() - createdAt.getTime() > thirtyDaysMs) {
        await this.db.execute({ sql: "DELETE FROM oauth_tokens WHERE token = ?", args: [refreshToken] });
        throw new Error("Session expired — please re-authenticate");
      }
    }

    // Issue new access token
    const newAccessToken = randomUUID();
    const expiresIn = 86400;

    await this.db.execute({
      sql: `INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, resource)
            VALUES (?, 'access', ?, ?, datetime('now', '+' || ? || ' seconds'), ?)`,
      args: [
        newAccessToken,
        client.client_id,
        row.scopes,
        expiresIn,
        resource || row.resource,
      ],
    });

    return {
      access_token: newAccessToken,
      token_type: "bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken, // Reuse same refresh token
      scope: row.scopes,
    };
  }

  async verifyAccessToken(token) {
    const { rows } = await this.db.execute({
      sql: "SELECT * FROM oauth_tokens WHERE token = ? AND token_type = 'access'",
      args: [token],
    });

    if (rows.length === 0) throw new Error("Invalid token");
    const row = rows[0];
    if (new Date(row.expires_at) < new Date()) {
      await this.db.execute({ sql: "DELETE FROM oauth_tokens WHERE token = ?", args: [token] });
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
export async function initOAuthTables(dbPath) {
  const db = createDbClient(dbPath);

  await db.executeMultiple(`
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
  await db.execute("DELETE FROM oauth_tokens WHERE expires_at < datetime('now')");

  db.close();
}

/**
 * Create an OAuth provider backed by the given database.
 */
export function createOAuthProvider(dbPath) {
  const db = createDbClient(dbPath);
  return new CrowOAuthProvider(db);
}

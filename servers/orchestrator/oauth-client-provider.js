/**
 * OAuthClientProvider for Google OAuth 2.0 — used by StreamableHTTPClientTransport
 * when connecting to remote MCP servers that require OAuth (e.g. Google's
 * managed MCP endpoints at gmailmcp.googleapis.com, calendarmcp.googleapis.com).
 *
 * Background:
 *   - Google doesn't support Dynamic Client Registration, so the user
 *     pre-creates an OAuth client (Desktop App type) in Google Cloud Console
 *     and downloads credentials.json.
 *   - User also runs a one-time consent flow (see scripts/google-mcp-auth.mjs
 *     in this repo) that writes token.json with the refresh_token.
 *   - This provider reads both files at runtime. The MCP SDK handles refresh
 *     grant automatically on 401; we just hand it tokens and persist the
 *     fresh ones it gives us back.
 *
 * This implementation is explicitly non-interactive: if the refresh_token
 * is missing or rejected, redirectToAuthorization throws so the gateway
 * logs an auth error rather than trying to open a browser in a background
 * process. The operator re-runs the consent script to recover.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Read the client credentials from a Google Cloud credentials.json file.
 * Supports both Desktop App ({installed:{...}}) and Web App ({web:{...}}) shapes.
 */
function readClientCredentials(credentialsFile) {
  if (!existsSync(credentialsFile)) {
    throw new Error(`OAuth credentials file not found: ${credentialsFile}`);
  }
  const raw = JSON.parse(readFileSync(credentialsFile, "utf8"));
  const inner = raw.installed || raw.web;
  if (!inner || !inner.client_id || !inner.client_secret) {
    throw new Error(
      `OAuth credentials file ${credentialsFile} missing installed.client_id or installed.client_secret`,
    );
  }
  return {
    clientId: inner.client_id,
    clientSecret: inner.client_secret,
    // Desktop-app flow uses "urn:ietf:wg:oauth:2.0:oob" or a local server redirect
    redirectUri: (inner.redirect_uris && inner.redirect_uris[0]) || "urn:ietf:wg:oauth:2.0:oob",
  };
}

/**
 * Read and normalize the token file (shape from Google's google-auth-library).
 * Returns the OAuthTokens shape the MCP SDK expects, or undefined if the file
 * doesn't exist.
 */
function readTokensFile(tokenFile) {
  if (!existsSync(tokenFile)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(tokenFile, "utf8"));
    // Python google-auth shape: { "token": "...", "refresh_token": "...", "token_uri": "...", "client_id": "...", "client_secret": "...", "scopes": [...], "expiry": "2026-04-22T20:30:00Z" }
    // Normalize both python-style and SDK-style into the MCP SDK's OAuthTokens.
    const accessToken = raw.access_token || raw.token;
    const refreshToken = raw.refresh_token;
    if (!accessToken && !refreshToken) return undefined;
    let expiresIn;
    if (raw.expires_in != null) {
      expiresIn = Number(raw.expires_in);
    } else if (raw.expiry) {
      const expiryMs = new Date(raw.expiry).getTime();
      const remaining = Math.floor((expiryMs - Date.now()) / 1000);
      expiresIn = remaining > 0 ? remaining : 0;
    }
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: raw.token_type || "Bearer",
      expires_in: expiresIn,
      scope: Array.isArray(raw.scopes) ? raw.scopes.join(" ") : raw.scope,
    };
  } catch (err) {
    console.warn(`[oauth-provider] token file ${tokenFile} unreadable: ${err.message}`);
    return undefined;
  }
}

/**
 * Atomically write tokens back, preserving Python google-auth-library shape
 * so the same file can be consumed by other tools that expect that format.
 */
function writeTokensFile(tokenFile, tokens, clientCreds, scopes) {
  mkdirSync(dirname(tokenFile), { recursive: true });
  const expiry = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : undefined;
  const payload = {
    token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_uri: "https://oauth2.googleapis.com/token",
    client_id: clientCreds.clientId,
    client_secret: clientCreds.clientSecret,
    scopes,
    expiry,
  };
  const tmp = `${tokenFile}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  renameSync(tmp, tokenFile);
}

/**
 * Build an OAuthClientProvider for the MCP SDK's StreamableHTTPClientTransport.
 *
 * @param {object} options
 * @param {string} options.credentialsFile - Path to Google OAuth credentials.json
 * @param {string} options.tokenFile       - Path to the token.json for this scope set
 * @param {string[]} options.scopes        - OAuth scopes bound to the stored token
 * @param {string} [options.label]         - Human-readable label for log messages
 * @returns {import("@modelcontextprotocol/sdk/client/auth.js").OAuthClientProvider}
 */
export function createGoogleOAuthProvider({ credentialsFile, tokenFile, scopes, label }) {
  const creds = readClientCredentials(credentialsFile);
  const labelStr = label || tokenFile;

  let cachedTokens = readTokensFile(tokenFile);

  return {
    // Non-interactive: there is no redirect URL we can usefully return,
    // so signal to the SDK that interactive flows are not supported here.
    get redirectUrl() {
      return undefined;
    },

    get clientMetadata() {
      return {
        client_name: `crow-remote-mcp-${labelStr}`,
        // Desktop-app clients register with OOB or localhost redirect; the
        // MCP SDK requires the metadata to advertise something.
        redirect_uris: [creds.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post",
      };
    },

    clientInformation() {
      return {
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uris: [creds.redirectUri],
      };
    },

    tokens() {
      return cachedTokens;
    },

    saveTokens(tokens) {
      cachedTokens = tokens;
      try {
        writeTokensFile(tokenFile, tokens, creds, scopes);
      } catch (err) {
        console.warn(`[oauth-provider] failed to persist tokens for ${labelStr}: ${err.message}`);
      }
    },

    // Non-interactive: we cannot redirect a user agent in a server process.
    // The SDK calls this only when no refresh path is available. Throwing
    // here surfaces a clear actionable error in the gateway logs.
    redirectToAuthorization(authorizationUrl) {
      throw new Error(
        `OAuth consent required for ${labelStr} but this gateway is non-interactive. ` +
        `Re-run the consent script (scripts/google-mcp-auth.mjs) to refresh ${tokenFile}. ` +
        `Authorization URL was: ${authorizationUrl}`,
      );
    },

    // PKCE hooks — unused for refresh-token flows but must exist.
    async saveCodeVerifier(_verifier) {
      // No-op; we never run the interactive authorization_code flow here.
    },
    async codeVerifier() {
      throw new Error(
        `codeVerifier requested for ${labelStr}, but this provider is refresh-only. ` +
        `The MCP SDK should not reach this path when a refresh_token is present.`,
      );
    },
  };
}

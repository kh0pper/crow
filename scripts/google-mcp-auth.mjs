#!/usr/bin/env node
/**
 * google-mcp-auth.mjs — one-time OAuth consent flow for Google's managed
 * MCP endpoints (gmailmcp.googleapis.com, calendarmcp.googleapis.com).
 *
 * Reads a Google Cloud OAuth Desktop Client credentials.json, runs the
 * authorization_code + loopback redirect flow, exchanges the code for
 * tokens, and writes token.json in the shape that
 * servers/orchestrator/oauth-client-provider.js reads.
 *
 * Usage:
 *   node scripts/google-mcp-auth.mjs \
 *     --credentials ~/.config/google-workspace-mcp-mpa/credentials.json \
 *     --token       ~/.config/google-workspace-mcp-mpa/gmail-token.json \
 *     --scopes      "https://mail.google.com/"
 *
 *   # Combined token for Gmail + Calendar in one consent:
 *   node scripts/google-mcp-auth.mjs \
 *     --credentials ~/.config/google-workspace-mcp-mpa/credentials.json \
 *     --token       ~/.config/google-workspace-mcp-mpa/gws-token.json \
 *     --scopes      "https://mail.google.com/,https://www.googleapis.com/auth/calendar"
 *
 * Designed to be run interactively on grackle (or any host with a browser).
 * The script prints an authorization URL; the operator opens it (xdg-open
 * is tried automatically if available), grants consent, and the loopback
 * handler captures the code and completes the exchange.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(
    "Usage: node google-mcp-auth.mjs --credentials <path> --token <path> --scopes <csv>",
  );
  process.exit(message ? 2 : 0);
}

function parseCli() {
  const { values } = parseArgs({
    options: {
      credentials: { type: "string" },
      token: { type: "string" },
      scopes: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) usage();
  if (!values.credentials) usage("--credentials is required");
  if (!values.token) usage("--token is required");
  if (!values.scopes) usage("--scopes is required (comma-separated)");
  return {
    credentialsFile: resolve(String(values.credentials)),
    tokenFile: resolve(String(values.token)),
    scopes: String(values.scopes).split(",").map(s => s.trim()).filter(Boolean),
  };
}

function readCredentials(file) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const inner = raw.installed || raw.web;
  if (!inner?.client_id || !inner?.client_secret) {
    throw new Error(
      `credentials file ${file} has no installed.client_id / installed.client_secret`,
    );
  }
  return { clientId: inner.client_id, clientSecret: inner.client_secret };
}

function writeToken(tokenFile, resp, clientCreds, scopes) {
  mkdirSync(dirname(tokenFile), { recursive: true });
  const expiry = resp.expires_in
    ? new Date(Date.now() + Number(resp.expires_in) * 1000).toISOString()
    : undefined;
  const payload = {
    token: resp.access_token,
    refresh_token: resp.refresh_token,
    token_uri: TOKEN_ENDPOINT,
    client_id: clientCreds.clientId,
    client_secret: clientCreds.clientSecret,
    scopes,
    expiry,
  };
  const tmp = `${tokenFile}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  renameSync(tmp, tokenFile);
}

function tryOpenBrowser(url) {
  // Best-effort; fine if it silently fails (operator will open the URL manually).
  try {
    spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // ignore
  }
}

async function exchangeCodeForTokens({ clientId, clientSecret }, code, redirectUri) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function main() {
  const { credentialsFile, tokenFile, scopes } = parseCli();
  const creds = readCredentials(credentialsFile);

  // Loopback server on an OS-assigned port.
  const state = randomBytes(16).toString("hex");
  let resolveCode, rejectCode;
  const codePromise = new Promise((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== "/") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const gotState = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const err = url.searchParams.get("error");
    if (err) {
      res.statusCode = 400;
      res.end(`OAuth error: ${err}`);
      rejectCode(new Error(`authorization error: ${err}`));
      return;
    }
    if (gotState !== state) {
      res.statusCode = 400;
      res.end("state mismatch");
      rejectCode(new Error("state mismatch"));
      return;
    }
    if (!code) {
      res.statusCode = 400;
      res.end("missing code");
      rejectCode(new Error("missing code"));
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/html");
    res.end(
      `<!doctype html><html><body style="font-family:sans-serif;padding:2rem">` +
      `<h2>Authorization complete</h2>` +
      `<p>You can close this window. Tokens have been written to <code>${tokenFile}</code>.</p>` +
      `</body></html>`,
    );
    resolveCode(code);
  });

  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind loopback server");
  }
  const redirectUri = `http://127.0.0.1:${address.port}/`;

  const authUrl = new URL(AUTH_ENDPOINT);
  authUrl.searchParams.set("client_id", creds.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scopes.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  console.log("Open this URL in a browser (trying xdg-open automatically):");
  console.log("");
  console.log(authUrl.toString());
  console.log("");
  console.log(`Loopback listening on ${redirectUri}`);
  tryOpenBrowser(authUrl.toString());

  let code;
  try {
    code = await codePromise;
  } finally {
    server.close();
  }

  const tokenResp = await exchangeCodeForTokens(creds, code, redirectUri);
  if (!tokenResp.refresh_token) {
    console.warn(
      "Warning: token response had no refresh_token. This can happen if you've " +
      "consented to this client+scopes before — revoke the app's access at " +
      "https://myaccount.google.com/permissions and re-run to get a fresh refresh_token.",
    );
  }
  writeToken(tokenFile, tokenResp, creds, scopes);
  console.log(`\nWrote ${tokenFile}`);
  console.log(
    `Scopes: ${scopes.join(" ")}${tokenResp.refresh_token ? "" : " (no refresh_token — see warning above)"}`,
  );
}

main().catch((err) => {
  console.error(`\nconsent flow failed: ${err.message}`);
  process.exit(1);
});

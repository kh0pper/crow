/**
 * Shared harness for the models-panel route tests (plan 3a): a scratch
 * CROW_DATA_DIR with the real schema (never the real ~/.crow), a seeded
 * dashboard session, and the real modelsRouter on an ephemeral port. Same
 * shape as tests/models-panel.test.js's inline harness.
 */
import express from "express";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

import modelsRouter from "../../servers/gateway/routes/models.js";
import { setProviderSyncManager } from "../../servers/shared/providers-db.js";

const repoRoot = join(import.meta.dirname, "..", "..");

export function freshLibsql(prefix = "models-routes-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: repoRoot,
  });
  const prevDataDir = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return {
    dir, db,
    async cleanup() {
      setProviderSyncManager(null);
      if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR;
      else process.env.CROW_DATA_DIR = prevDataDir;
      try { db.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function seedSession(db, token = "test-session-token") {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  await db.execute({
    sql: "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', 'dashboard', ?)",
    args: [createHash("sha256").update(token).digest("hex"), expiresAt],
  });
  return token;
}

export const CSRF = "test-csrf-value";

/** Session + tailnet identity + the double-submit CSRF pair. */
export function authHeaders(token, extra = {}) {
  return {
    "tailscale-user-login": "test@example.com",
    cookie: `crow_session=${token}; crow_csrf=${CSRF}`,
    "x-crow-csrf": CSRF,
    "content-type": "application/json",
    ...extra,
  };
}

/** Session but no X-Crow-Csrf echo. */
export function noCsrfHeaders(token) {
  const h = authHeaders(token);
  delete h["x-crow-csrf"];
  return h;
}

export function noSessionHeaders() {
  return { "tailscale-user-login": "test@example.com", "content-type": "application/json" };
}

export async function withServer(opts, fn) {
  const app = express();
  app.use(express.json());
  app.use(modelsRouter((req, res, next) => next(), opts));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

export async function withOrchestrationDisabled(fn) {
  const prev = process.env.CROW_DISABLE_MODEL_ORCHESTRATION;
  process.env.CROW_DISABLE_MODEL_ORCHESTRATION = "1";
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.CROW_DISABLE_MODEL_ORCHESTRATION;
    else process.env.CROW_DISABLE_MODEL_ORCHESTRATION = prev;
  }
}

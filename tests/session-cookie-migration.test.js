/**
 * The plain-cookie migration keeps the session it migrates: it never extends it.
 *
 * Over HTTPS the dashboard reads `__Host-crow_session`. A browser that still
 * holds only the OLD plain `crow_session` from an earlier release is migrated:
 * the response re-issues the cookie under the `__Host-` name for the session's
 * OWN remaining lifetime (never a fresh week — replaying the migration cannot
 * keep a credential alive) and expires the plain one, host-only AND at the
 * request host's parent domain where a sibling could have tossed it.
 *
 * The real dashboardAuth middleware is driven directly over a scratch
 * CROW_DATA_DIR (same harness shape as dashboard-logout.test.js), with the
 * network gate opened by CROW_DASHBOARD_PUBLIC because isAllowedNetwork is
 * auth-network.test.js's subject, not this one's.
 *
 * NOT tested here: a one-time door (a per-session "already migrated" marker).
 * That needs a schema change and is deliberately not part of this change — see
 * the known residual in servers/gateway/dashboard/auth.js's header.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "session-cookie-migration-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
mkdirSync(process.env.CROW_HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
process.env.CROW_DASHBOARD_PUBLIC = "true";
writeFileSync(join(dir, "instance-id"), "instance-session-migration");

const REPO = new URL("..", import.meta.url).pathname;
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_MAX_AGE_MS = 7 * DAY_MS;

let dashboardAuth, hashToken;

/** A dashboard session row expiring `days` from now; returns nothing. */
function seedSession(token, days = 2) {
  const c = new Database(join(dir, "crow.db"));
  try {
    c.prepare(
      "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) " +
      "VALUES (?, 'access', 'dashboard', 'dashboard', ?)",
    ).run(hashToken(token), new Date(Date.now() + days * DAY_MS).toISOString());
  } finally {
    c.close();
  }
}

/** An HTTPS request carrying exactly `cookie` (Host: a tailnet-shaped install). */
function httpsReq(cookie, host = "crow.example.ts.net") {
  return { secure: true, method: "GET", headers: { cookie, host } };
}

/** Drive the real middleware; resolves what it chose to do. */
function auth(req) {
  return new Promise((resolve) => {
    const headers = {};
    const res = {
      headers,
      location: null,
      setHeader(name, value) { headers[String(name).toLowerCase()] = value; },
      redirect(url) { res.location = url; resolve({ next: false, res }); },
      redirectAfterPost(url) { res.location = url; resolve({ next: false, res }); },
    };
    dashboardAuth(req, res, () => resolve({ next: true, res }));
  });
}

const cookiesOf = (res) => [].concat(res.headers["set-cookie"] || []);
const maxAgeOf = (cookie) => Number(/Max-Age=(\d+)/.exec(cookie)?.[1] ?? NaN);

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  ({ dashboardAuth, hashToken } = await import("../servers/gateway/dashboard/auth.js"));
});
after(() => { rmSync(dir, { recursive: true, force: true }); });

test("the migration re-issues __Host- for the session's OWN remaining lifetime", async () => {
  const token = "migrate-keeps-lifetime";
  seedSession(token, 2);

  const { next, res } = await auth(httpsReq(`crow_session=${token}`));
  assert.equal(next, true, "a lone plain cookie over HTTPS is migrated");
  assert.equal(res.location, null);

  const cookies = cookiesOf(res);
  const host = cookies.find((c) => c.startsWith("__Host-crow_session="));
  assert.ok(host, cookies.join(" | "));
  const maxAge = maxAgeOf(host);
  assert.ok(
    Math.abs(maxAge - 2 * 24 * 60 * 60) <= 60,
    `keeps ~2 days, not a fresh week (got ${maxAge}s)`,
  );
  assert.ok(maxAge * 1000 < SESSION_MAX_AGE_MS, "and never longer than the session had left");
  assert.match(host, /; Secure/);
  // The plain cookie is expired — host-only AND at the parent domain a sibling
  // would have used.
  const plain = cookies.filter((c) => c.startsWith("crow_session=;"));
  assert.equal(plain.length, 2, cookies.join(" | "));
  assert.ok(plain.some((c) => /; Domain=example\.ts\.net/.test(c)), "the tossed Domain= copy goes too");
});

test("a request already carrying __Host- gets no re-issue at all", async () => {
  const token = "already-host";
  seedSession(token, 1);

  const { next, res } = await auth(httpsReq(`__Host-crow_session=${token}`));
  assert.equal(next, true);
  assert.deepEqual(cookiesOf(res), [], "no re-issue: the browser already has the __Host- cookie");
});

test("a session created before the release is still migrated", async () => {
  const token = "legacy-row";
  seedSession(token, 3); // exactly what an upgraded crow.db holds
  const { next, res } = await auth(httpsReq(`crow_session=${token}`));
  assert.equal(next, true);
  assert.ok(cookiesOf(res).some((c) => c.startsWith("__Host-crow_session=")));
});

test("a plain HTTP request is untouched: no __Host- cookie", async () => {
  const token = "lan";
  seedSession(token, 1);
  const req = { secure: false, method: "GET", headers: { cookie: `crow_session=${token}`, host: "192.168.1.20:3001" } };
  const { next, res } = await auth(req);
  assert.equal(next, true);
  assert.deepEqual(cookiesOf(res), [], "nothing is re-issued over plain HTTP");
});
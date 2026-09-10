// Regression tests for the two defects that made dashboard login unreachable on
// any install with 2FA enabled (found on the R4 instance, 2026-09-09):
//
//   1. dashboard/totp.js stored the pending-2FA token in `oauth_tokens`, whose
//      CHECK(token_type IN ('access','refresh')) rejected token_type
//      ='pending_2fa'. attemptLogin's DB-failure path swallowed it, so a
//      CORRECT password rendered "Login temporarily unavailable (server
//      database error)" with no way in from the UI. Fixed additively with a
//      dedicated `dashboard_pending_2fa` table (no rebuild of a live table).
//   2. dashboard/index.js called t() at 17 sites without importing it, so the
//      lockout / 2FA-error / password-reset-error paths threw
//      `ReferenceError: t is not defined` — and because an unhandled rejection
//      is fatal there, each one took the whole gateway process down.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// --- Defect 1: the pending-2FA token round-trip -----------------------------

const PENDING_DDL = `
  CREATE TABLE IF NOT EXISTS dashboard_pending_2fa (
    token TEXT PRIMARY KEY,
    meta TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pending_2fa_expires ON dashboard_pending_2fa(expires_at);
`;

// oauth_tokens exactly as it exists on a live crow.db — the narrow CHECK is the
// whole point of this fix, so the test asserts against the real constraint.
const OAUTH_DDL = `
  CREATE TABLE oauth_tokens (
    token TEXT PRIMARY KEY,
    token_type TEXT NOT NULL CHECK(token_type IN ('access', 'refresh')),
    client_id TEXT NOT NULL,
    scopes TEXT DEFAULT '',
    resource TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`;

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "crow-2fa-test-"));
  const path = join(dir, "crow.db");
  const d = new Database(path);
  d.exec(OAUTH_DDL);
  d.exec(PENDING_DDL);
  d.close();
  return { dir, path };
}

test("the old storage really was impossible: oauth_tokens rejects token_type='pending_2fa'", () => {
  const { dir, path } = freshDb();
  const d = new Database(path);
  assert.throws(
    () => d.prepare(
      "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, resource, expires_at) VALUES (?, 'pending_2fa', 'dashboard', '2fa', ?, ?)"
    ).run("t1", null, new Date(Date.now() + 60000).toISOString()),
    /CHECK constraint failed/,
    "the pre-fix INSERT must still fail — that is the bug this table replaces"
  );
  d.close();
  rmSync(dir, { recursive: true, force: true });
});

test("pending-2FA token: create → read context → single-use verify", async () => {
  const { dir, path } = freshDb();
  process.env.CROW_DB_PATH = path;
  const totp = await import("../servers/gateway/dashboard/totp.js");

  const token = await totp.createPending2faToken({ src: "a", dest: "/dashboard" });
  assert.equal(typeof token, "string");
  assert.ok(token.length >= 32, "token should be a long random string");

  // The row is stored HASHED, never in the clear.
  const d = new Database(path);
  const rows = d.prepare("SELECT token, meta FROM dashboard_pending_2fa").all();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token, token, "the plaintext token must not be stored");
  d.close();

  assert.deepEqual(await totp.getPending2faContext(token), { src: "a", dest: "/dashboard" });
  // getPending2faContext must NOT consume the token.
  assert.deepEqual(await totp.getPending2faContext(token), { src: "a", dest: "/dashboard" });

  assert.equal(await totp.verifyPending2faToken(token), true, "first verify succeeds");
  assert.equal(await totp.verifyPending2faToken(token), false, "token is single-use");
  assert.equal(await totp.getPending2faContext(token), null, "context gone after consumption");

  delete process.env.CROW_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

test("pending-2FA token: an expired token is rejected and swept", async () => {
  const { dir, path } = freshDb();
  process.env.CROW_DB_PATH = path;
  const totp = await import("../servers/gateway/dashboard/totp.js");

  const d = new Database(path);
  d.prepare("INSERT INTO dashboard_pending_2fa (token, meta, expires_at) VALUES (?, NULL, ?)")
    .run("stale-hash", "2000-01-01T00:00:00.000Z");
  d.close();

  assert.equal(await totp.verifyPending2faToken("anything"), false);
  // Creating a new token sweeps expired rows.
  await totp.createPending2faToken(null);
  const d2 = new Database(path);
  const stale = d2.prepare("SELECT count(*) n FROM dashboard_pending_2fa WHERE token='stale-hash'").get();
  d2.close();
  assert.equal(stale.n, 0, "expired rows are swept on create");

  delete process.env.CROW_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

test("no code path stores a pending-2FA token in oauth_tokens any more", () => {
  const src = readFileSync(join(REPO_ROOT, "servers/gateway/dashboard/totp.js"), "utf8");
  const statements = src.split("\n").filter((l) => /sql:\s*"/.test(l));
  for (const line of statements) {
    assert.ok(
      !/oauth_tokens/.test(line),
      "totp.js SQL must not touch oauth_tokens: " + line.trim()
    );
  }
});

// --- Defect 2: the missing i18n import (static rot-guard) -------------------

test("dashboard/index.js imports every i18n helper it calls", () => {
  const src = readFileSync(join(REPO_ROOT, "servers/gateway/dashboard/index.js"), "utf8");
  const importLine = src.split("\n").find((l) => l.includes('from "./shared/i18n.js"'));
  assert.ok(importLine, "index.js must import from shared/i18n.js");
  const imported = new Set(
    (importLine.match(/\{([^}]*)\}/)?.[1] || "").split(",").map((x) => x.trim()).filter(Boolean)
  );

  // Bare t(...) / tJs(...) calls, excluding member calls like foo.t(...).
  const called = new Set();
  for (const m of src.matchAll(/(^|[^\w.$])(t|tJs)\(/g)) called.add(m[2]);

  for (const fn of called) {
    assert.ok(
      imported.has(fn),
      `index.js calls ${fn}() but does not import it — every such call site throws ` +
      `ReferenceError at runtime, and an unhandled rejection here kills the gateway`
    );
  }
  assert.ok(called.has("t"), "guard is only meaningful while index.js still calls t()");
});

test("the i18n keys index.js asks for actually exist", async () => {
  const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");
  const src = readFileSync(join(REPO_ROOT, "servers/gateway/dashboard/index.js"), "utf8");
  const keys = [...src.matchAll(/(?:^|[^\w.$])t(?:Js)?\("([a-zA-Z0-9._]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 0, "expected some t() keys in index.js");
  for (const k of new Set(keys)) {
    // t() returns the key itself when the entry is missing.
    assert.notEqual(t(k, "en"), k, `i18n key "${k}" is missing from shared/i18n.js`);
  }
});

// --- Defect 3: verifyTotp threw on a missing code ----------------------------
//
// A POST to /dashboard/login/2fa (or /2fa/setup, or the settings enable_2fa
// action) with the `totp_code` field simply absent reached
// verifyTotp(undefined, secret). otpauth reads `.length` off the token, so an
// absent field raised `TypeError: Cannot read properties of undefined` inside
// an async route handler — an unhandled rejection, which is fatal, so a
// malformed request took the gateway down. Same class as defect 2: a bad
// request must render an error, never end the process.

const TEST_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // RFC 6238 SHA1 seed

test("verifyTotp answers false for a missing code instead of throwing", async () => {
  const { verifyTotp } = await import("../servers/gateway/dashboard/totp.js");
  for (const absent of [undefined, null]) {
    assert.equal(verifyTotp(absent, TEST_SECRET), false);
  }
});

test("verifyTotp answers false for a code that is not a usable string", async () => {
  const { verifyTotp } = await import("../servers/gateway/dashboard/totp.js");
  for (const junk of ["", "   ", "abc", 123456, {}, [], true]) {
    assert.equal(verifyTotp(junk, TEST_SECRET), false);
  }
});

test("verifyTotp answers false for a missing or unusable secret", async () => {
  const { verifyTotp } = await import("../servers/gateway/dashboard/totp.js");
  // /dashboard/login/2fa/setup and the settings enable_2fa action both pass a
  // secret straight from the request body, so this argument is attacker-shaped
  // too — and Secret.fromBase32(undefined) throws the same way.
  for (const bad of [undefined, null, "", "not base32!"]) {
    assert.equal(verifyTotp("123456", bad), false);
  }
});

test("verifyTotp still accepts the real code for the current period", async () => {
  const { verifyTotp } = await import("../servers/gateway/dashboard/totp.js");
  const OTPAuth = await import("otpauth");
  const totp = new OTPAuth.TOTP({
    issuer: "Crow",
    label: "Crow's Nest",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(TEST_SECRET),
  });
  assert.equal(verifyTotp(totp.generate(), TEST_SECRET), true);
});

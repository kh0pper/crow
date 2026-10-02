// S1 (2026-10-02): mixed-format timestamp comparisons.
//
// Expiries written by JS are ISO ("2026-10-08T01:20:15.637Z"); SQLite's
// datetime('now') is "2026-10-08 01:20:15". Compared as TEXT, 'T' (0x54) sorts
// after ' ' (0x20), so an ISO expiry from earlier the SAME UTC day still read
// as "in the future": a dashboard session stayed valid for up to ~24 h past its
// expiry. Every fixed site now compares julianday() to julianday(). These tests
// pin the boundary: expired one minute ago → rejected, one minute ahead →
// accepted. (Inside the first minute after UTC midnight "one minute ago" is the
// previous day, which the old code also rejected; the fixed-string test below
// covers the same-day case deterministically.)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const iso = (deltaMs) => new Date(Date.now() + deltaMs).toISOString();
const MIN = 60_000;

const saved = { CROW_DB_PATH: process.env.CROW_DB_PATH, TZ: process.env.TZ };
let dir, dbPath, raw;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "ts-expiry-"));
  dbPath = join(dir, "crow.db");
  process.env.CROW_DB_PATH = dbPath;
  raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE oauth_tokens (token TEXT PRIMARY KEY, token_type TEXT NOT NULL, client_id TEXT NOT NULL,
      scopes TEXT DEFAULT '', resource TEXT, expires_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE dashboard_pending_2fa (token TEXT PRIMARY KEY, meta TEXT, expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, actor TEXT,
      ip_address TEXT, details TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE maker_sessions (token TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'active', expires_at TEXT NOT NULL);
    CREATE TABLE bot_message_invites (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, token TEXT, expires_at TEXT,
      max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, is_read INTEGER DEFAULT 0, is_dismissed INTEGER DEFAULT 0,
      snoozed_until TEXT, expires_at TEXT);
  `);
});

after(() => {
  try { raw.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test("the old TEXT comparison was wrong on the same UTC day; julianday() is right", () => {
  const expired = "2026-10-02T12:00:00.000Z"; // one minute before "now"
  const now = "2026-10-02 12:01:00";           // datetime('now') shape
  assert.equal(raw.prepare("SELECT ? > ? AS v").get(expired, now).v, 1, "the bug: text compare says still valid");
  assert.equal(raw.prepare("SELECT julianday(?) > julianday(?) AS v").get(expired, now).v, 0);
  assert.equal(raw.prepare("SELECT julianday(?) > julianday(?) AS v").get("2026-10-02T12:02:00.000Z", now).v, 1);
});

test("verifySession: expired 1 minute ago → rejected; valid 1 minute ahead → accepted", async () => {
  const { verifySession } = await import("../servers/gateway/dashboard/auth.js");
  const ins = raw.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', 'dashboard', ?)");
  ins.run(sha("sess-expired"), iso(-MIN));
  ins.run(sha("sess-valid"), iso(MIN));
  assert.equal(await verifySession("sess-expired"), false);
  assert.equal(await verifySession("sess-valid"), true);
});

test("pending 2FA token: expired 1 minute ago → rejected; 1 minute ahead → accepted", async () => {
  const { verifyPending2faToken, getPending2faContext } = await import("../servers/gateway/dashboard/totp.js");
  const ins = raw.prepare("INSERT INTO dashboard_pending_2fa (token, meta, expires_at) VALUES (?, ?, ?)");
  ins.run(sha("p2fa-expired"), JSON.stringify({ src: "x" }), iso(-MIN));
  ins.run(sha("p2fa-valid"), JSON.stringify({ src: "y" }), iso(MIN));
  assert.equal(await getPending2faContext("p2fa-expired"), null);
  assert.equal(await verifyPending2faToken("p2fa-expired"), false);
  assert.deepEqual(await getPending2faContext("p2fa-valid"), { src: "y" });
  assert.equal(await verifyPending2faToken("p2fa-valid"), true);
});

test("OAuth tokens: SQLite-shaped expiries are read as UTC even off a UTC host", async () => {
  process.env.TZ = "America/Chicago"; // the crow host's zone; new Date("Y-M-D h:m:s") would read local
  const { dbTimeMs, createOAuthProvider } = await import("../servers/gateway/auth.js");
  assert.equal(dbTimeMs("2026-10-02 12:00:00"), Date.parse("2026-10-02T12:00:00Z"));
  assert.equal(dbTimeMs("2026-10-02T12:00:00.000Z"), Date.parse("2026-10-02T12:00:00Z"));
  const stamp = (deltaMs) => new Date(Date.now() + deltaMs).toISOString().slice(0, 19).replace("T", " ");
  const ins = raw.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'c1', 'mcp:tools', ?)");
  ins.run(sha("mcp-expired"), stamp(-MIN));
  ins.run(sha("mcp-valid"), stamp(MIN));
  const p = createOAuthProvider(dbPath);
  await assert.rejects(p.verifyAccessToken("mcp-expired"), /expired/i);
  const ok = await p.verifyAccessToken("mcp-valid");
  assert.equal(ok.clientId, "c1");
  assert.ok(Math.abs(ok.expiresAt * 1000 - (Date.now() + MIN)) < 5_000, "expiresAt is UTC, not shifted by the zone offset");
  p.db.close();
});

test("kiosk guard: a maker session expired 1 minute ago is not active; 1 minute ahead is", async () => {
  const { createDbClient } = await import("../servers/db.js");
  const { isKioskActive } = await import("../servers/shared/kiosk-guard.js");
  const db = createDbClient(dbPath);
  raw.prepare("INSERT INTO maker_sessions (token, expires_at) VALUES ('k1', ?)").run(iso(-MIN));
  assert.equal(await isKioskActive(db), false);
  await new Promise((r) => setTimeout(r, 1100)); // past the guard's 1 s cache
  raw.prepare("INSERT INTO maker_sessions (token, expires_at) VALUES ('k2', ?)").run(iso(MIN));
  assert.equal(await isKioskActive(db), true);
  db.close();
});

test("bot message invites: expired 1 minute ago is refused; 1 minute ahead is accepted", async () => {
  const { consumeInvite } = await import("../scripts/pi-bots/gateways/crow-messages-store.mjs");
  const { getActiveInvite } = await import("../servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js");
  const { createDbClient } = await import("../servers/db.js");
  raw.prepare("INSERT INTO bot_message_invites (bot_id, token, expires_at) VALUES ('b1', 'old', ?)").run(iso(-MIN));
  assert.equal(consumeInvite(raw, "b1", "old"), false);
  const db = createDbClient(dbPath);
  assert.equal(await getActiveInvite(db, "b1"), null);
  raw.prepare("INSERT INTO bot_message_invites (bot_id, token, expires_at) VALUES ('b2', 'new', ?)").run(iso(MIN));
  assert.equal((await getActiveInvite(db, "b2")).token, "new");
  assert.equal(consumeInvite(raw, "b2", "new"), true);
  db.close();
});

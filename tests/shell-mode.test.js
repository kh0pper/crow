/**
 * Per-device mode (new / classic): the pure resolver, the per-instance cookie
 * names, the first-boot stamp and the lazy-stamp race.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "shell-mode-"));
process.env.CROW_DATA_DIR = dir;

let db, mode, hashToken, registry, allow;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  mode = await import("../servers/gateway/dashboard/shell/mode.js");
  ({ hashToken } = await import("../servers/gateway/dashboard/auth.js"));
  registry = await import("../servers/gateway/dashboard/settings/registry.js");
  allow = await import("../servers/gateway/dashboard/settings/sync-allowlist.js");
});

after(() => {
  try { db && db.close && db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

test("a cookie wins", () => {
  assert.deepEqual(
    mode.resolveDeviceMode({ cookieMode: "classic", sessionCreatedAt: "2027-01-01", shellSince: "2026-11-01" }),
    { mode: "classic", offerTry: false, persist: false },
  );
  assert.deepEqual(
    mode.resolveDeviceMode({ cookieMode: "new", sessionCreatedAt: "2026-01-01", shellSince: "2026-11-01" }),
    { mode: "new", offerTry: false, persist: false },
  );
});

test("a device logged in before the upgrade opens classic with the offer", () => {
  assert.deepEqual(
    mode.resolveDeviceMode({ cookieMode: undefined, sessionCreatedAt: "2026-10-20 10:00:00", shellSince: "2026-11-01 00:00:00" }),
    { mode: "classic", offerTry: true, persist: true },
  );
});

test("a device that logs in after the upgrade opens new", () => {
  assert.deepEqual(
    mode.resolveDeviceMode({ sessionCreatedAt: "2026-11-02 10:00:00", shellSince: "2026-11-01 00:00:00" }),
    { mode: "new", offerTry: false, persist: true },
  );
});

test("no shell_since yet, or no session date: new", () => {
  const want = { mode: "new", offerTry: false, persist: true };
  assert.deepEqual(mode.resolveDeviceMode({ sessionCreatedAt: "2026-10-20 10:00:00", shellSince: null }), want);
  assert.deepEqual(mode.resolveDeviceMode({ sessionCreatedAt: null, shellSince: "2026-11-01 00:00:00" }), want);
  assert.deepEqual(mode.resolveDeviceMode({}), want);
});

test("a junk cookie is ignored", () => {
  assert.deepEqual(
    mode.resolveDeviceMode({ cookieMode: "fancy", sessionCreatedAt: "2026-10-20 10:00:00", shellSince: "2026-11-01 00:00:00" }),
    { mode: "classic", offerTry: true, persist: true },
  );
  assert.equal(mode.resolveDeviceMode({ cookieMode: "fancy" }).mode, "new");
});

test("stampShellSince keeps the first value", async () => {
  const a = await mode.stampShellSince(db);
  assert.match(a, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(await mode.stampShellSince(db), a);
  assert.equal(await registry.readSetting(db, "shell_since"), a);
});

test("shell_since stays local", async () => {
  assert.equal(allow.isSyncable("shell_since"), false);
  assert.equal(allow.isInstanceScope("shell_since"), false);
  const row = await db.execute("SELECT 1 FROM dashboard_settings_overrides WHERE key = 'shell_since'");
  assert.equal(row.rows.length, 1);
  const g = await db.execute("SELECT 1 FROM dashboard_settings WHERE key = 'shell_since'");
  assert.equal(g.rows.length, 0);
});

test("cookie names are per instance", () => {
  const mk = (id) => {
    const d = mkdtempSync(join(tmpdir(), "shell-mode-home-"));
    mkdirSync(d, { recursive: true });
    if (id) writeFileSync(join(d, "instance-id"), id);
    return { CROW_DATA_DIR: d };
  };
  const a = mode.cookieName(mode.MODE_COOKIE, mk("instance-aaa"));
  const b = mode.cookieName(mode.MODE_COOKIE, mk("instance-bbb"));
  assert.match(a, /^crow_mode_[0-9a-f]{8}$/);
  assert.match(b, /^crow_mode_[0-9a-f]{8}$/);
  assert.notEqual(a, b);
  assert.equal(mode.cookieName(mode.MODE_COOKIE, mk(null)), "crow_mode_local");
  assert.match(mode.cookieName(mode.SCOPE_COOKIE, mk("x")), /^crow_scope_[0-9a-f]{8}$/);
  assert.match(mode.cookieName(mode.TRY_COOKIE, mk("x")), /^crow_try_new_[0-9a-f]{8}$/);
});

test("modeCookie is readable by the client, 400 days, Lax", () => {
  const c = mode.modeCookie("classic");
  assert.match(c, /^crow_mode_[0-9a-z]+=classic; Path=\/; Max-Age=34560000; SameSite=Lax/);
  assert.ok(!/HttpOnly/i.test(c));
});

test("sessionCreatedAt reads the dashboard session row", async () => {
  await db.execute({
    sql: "INSERT INTO oauth_tokens (token, token_type, client_id, expires_at, created_at) VALUES (?, 'access', 'dashboard', datetime('now','+1 day'), '2026-10-20 10:00:00')",
    args: [hashToken("tok-1")],
  });
  assert.equal(await mode.sessionCreatedAt(db, "tok-1"), "2026-10-20 10:00:00");
  assert.equal(await mode.sessionCreatedAt(db, "nope"), null);
});

test("no boot race: a lazy stamp still counts an earlier session as existing", async () => {
  await db.execute("DELETE FROM dashboard_settings_overrides WHERE key = 'shell_since'");
  await db.execute({
    sql: "INSERT INTO oauth_tokens (token, token_type, client_id, expires_at, created_at) VALUES (?, 'access', 'dashboard', datetime('now','+1 day'), datetime('now','-1 minute'))",
    args: [hashToken("tok-2")],
  });
  const since = await mode.ensureShellSince(db);
  const created = await mode.sessionCreatedAt(db, "tok-2");
  const r = mode.resolveDeviceMode({ cookieMode: undefined, sessionCreatedAt: created, shellSince: since });
  assert.equal(r.mode, "classic");
  assert.equal(r.offerTry, true);
});

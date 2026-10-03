/** Re-auth gate + keychain API (Task 4). Express on 127.0.0.1:0, scratch DB + key, stub verifiers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-kcapi-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const { createDbClient } = await import("../servers/db.js");
const { createReauthGate } = await import("../servers/gateway/keychain/reauth.js");
const { keychainApiRouter } = await import("../servers/gateway/keychain/api.js");
const { createKeychainKey, keychainKeyPath } = await import("../servers/gateway/keychain/key.js");
import { writeFileSync } from "node:fs";
const K = await import("../servers/gateway/keychain/store.js");

const AUDIT_DDL = "CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, actor TEXT, ip_address TEXT, details TEXT, created_at TEXT DEFAULT (datetime('now')))";

async function setup({ twoFa = false, hasPassword = true, verifier, clock = { t: Date.parse("2026-10-03T12:00:00Z") }, vault } = {}) {
  const dbPath = join(mkdtempSync(join(tmpdir(), "crow-kcapi-db-")), "crow.db");
  const crowHome = mkdtempSync(join(tmpdir(), "crow-kcapi-home-"));
  const seedDb = createDbClient(dbPath);
  await seedDb.execute(AUDIT_DDL);
  const gate = createReauthGate({
    now: () => clock.t,
    is2faEnabled: async () => twoFa,
    hasDashboardPassword: async () => hasPassword,
    verifyTotpCode: async (c) => c === "123456",
    verifyDashboardPassword: verifier || (async (p) => p === "right-password"),
  });
  const vaultCalls = [];
  const notes = [];
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => { req.dashboardSession = req.headers["x-test-session"] || null; next(); });
  app.use(keychainApiRouter({
    openDb: () => createDbClient(dbPath),
    crowHome,
    gate,
    notify: async (_db, n) => { notes.push(n); },
    vault: vault || { status: () => ({ installed: true, cliPath: "/x/bw.js", serverUrl: "http://localhost:18097" }), save: async (o) => { vaultCalls.push(o); return { ok: true }; } },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/dashboard/keychain/api`;
  const call = (path, { session = "S1", body, method = body ? "POST" : "GET", headers = {} } = {}) =>
    fetch(base + path, { method, headers: { "content-type": "application/json", ...(session ? { "x-test-session": session } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined })
      .then(async (r) => ({ status: r.status, body: await r.json(), cache: r.headers.get("cache-control"), disposition: r.headers.get("content-disposition") }));
  const audits = async () => (await seedDb.execute("SELECT event_type, details FROM audit_log ORDER BY id")).rows;
  const key = () => createKeychainKey({ crowHome });
  return { db: seedDb, crowHome, key, call, audits, clock, vaultCalls, notes, close: () => server.close() };
}

test("entries list never carries a secret; reveal without a grant is 403 reauth_required", async () => {
  const s = await setup();
  try {
    const { id } = await K.saveExtensionSecret(s.db, s.key(), { bundleId: "workspace", envKey: "WORKSPACE_ADMIN_PASSWORD", label: "Workspace admin", secret: "s3cr3t-value", origin: "typed" });
    const list = await s.call("/entries");
    assert.equal(list.status, 200);
    assert.equal(list.body.entries[0].id, id);
    assert.equal(list.body.entries[0].readable, true);
    assert.equal(list.body.reauth_method, "password");
    assert.ok(!JSON.stringify(list.body).includes("s3cr3t-value"));
    const r = await s.call("/reveal", { body: { id, purpose: "reveal" } });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "reauth_required");
  } finally { s.close(); }
});

test("re-auth with the password → reveal and copy work, are no-store, and are audited without the value", async () => {
  const s = await setup();
  try {
    const { id } = await K.saveExtensionSecret(s.db, s.key(), { bundleId: "workspace", envKey: "WORKSPACE_ADMIN_PASSWORD", label: "Workspace admin", secret: "s3cr3t-value", origin: "typed" });
    assert.equal((await s.call("/reauth", { body: { password: "right-password" } })).status, 200);
    const r = await s.call("/reveal", { body: { id, purpose: "reveal" } });
    assert.equal(r.status, 200);
    assert.equal(r.body.secret, "s3cr3t-value");
    assert.equal(r.cache, "no-store");
    assert.equal((await s.call("/reveal", { body: { id, purpose: "copy" } })).body.secret, "s3cr3t-value");
    const ev = await s.audits();
    assert.deepEqual(ev.map((e) => e.event_type), ["keychain_reauth_ok", "keychain_reveal", "keychain_copy"]);
    assert.ok(!JSON.stringify(ev).includes("s3cr3t-value"), "audit details never hold the value");
  } finally { s.close(); }
});

test("REVIEW FOCUS 4 — grants are per session, expire at 5 min, lock after 5 failures, and 20/hour locks the whole instance", async () => {
  const s = await setup();
  try {
    const { id } = await K.addManualSecret(s.db, s.key(), { label: "Phone", secret: "app-pass" });
    await s.call("/reauth", { session: "S1", body: { password: "right-password" } });
    assert.equal((await s.call("/reveal", { session: "S2", body: { id } })).status, 403, "another session's grant does not count");
    assert.equal((await s.call("/reveal", { session: "S1", body: { id } })).status, 200);
    s.clock.t += 5 * 60 * 1000 + 1;
    assert.equal((await s.call("/reveal", { session: "S1", body: { id } })).status, 403, "expired after 5 minutes");

    for (let i = 0; i < 5; i++) assert.equal((await s.call("/reauth", { session: "S3", body: { password: "wrong" } })).status, 401);
    const locked = await s.call("/reauth", { session: "S3", body: { password: "right-password" } });
    assert.equal(locked.status, 429, "the right password is refused while locked");
    s.clock.t += 15 * 60 * 1000 + 1;
    assert.equal((await s.call("/reauth", { session: "S3", body: { password: "right-password" } })).status, 200, "lock lifts after 15 minutes");

    // S1: a peer minting fresh sessions gets 4 tries each, but the instance-wide ceiling still trips.
    for (let i = 0; i < 15; i++) await s.call("/reauth", { session: `P${Math.floor(i / 4)}`, body: { password: "wrong" } });
    const global = await s.call("/reauth", { session: "FRESH", body: { password: "right-password" } });
    assert.equal(global.status, 429, "20 failures in an hour lock re-auth for every session");
    assert.equal(s.notes.length, 1, "the owner is notified once");
    assert.ok((await s.audits()).some((e) => e.event_type === "keychain_reauth_lockout"));
    s.clock.t += 60 * 60 * 1000 + 1;
    assert.equal((await s.call("/reauth", { session: "FRESH", body: { password: "right-password" } })).status, 200);
  } finally { s.close(); }
});

test("with dashboard 2FA on, only the TOTP code re-authenticates", async () => {
  const s = await setup({ twoFa: true });
  try {
    assert.equal((await s.call("/entries")).body.reauth_method, "totp");
    assert.equal((await s.call("/reauth", { body: { password: "right-password" } })).status, 401, "the password alone is not enough");
    assert.equal((await s.call("/reauth", { body: { totp_code: "123456" } })).status, 200);
  } finally { s.close(); }
});

test("Q6 — no dashboard password and no 2FA: reveal/export are refused with an explanation, no bypass", async () => {
  const s = await setup({ hasPassword: false });
  try {
    const { id } = await K.addManualSecret(s.db, s.key(), { label: "Phone", secret: "app-pass" });
    assert.equal((await s.call("/entries")).body.reauth_method, "none");
    const r = await s.call("/reauth", { body: { password: "" } });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "reauth_unavailable");
    for (const [path, body] of [["/reveal", { id }], ["/export", { passphrase: "x".repeat(12) }], ["/delete", { id }]]) {
      const x = await s.call(path, { body });
      assert.equal(x.status, 403, path);
      assert.equal(x.body.code, "reauth_unavailable", path);
    }
  } finally { s.close(); }
});

test("REVIEW FOCUS 2 (API) — first-view works once without re-auth, then 410", async () => {
  const s = await setup();
  try {
    const { id } = await K.saveExtensionSecret(s.db, s.key(), { bundleId: "vaultwarden", envKey: "VAULTWARDEN_ADMIN_TOKEN", label: "Vaultwarden admin token", secret: "tok-1", origin: "generated", firstView: true });
    const one = await s.call("/first-view", { body: { id } });
    assert.equal(one.status, 200);
    assert.equal(one.body.secret, "tok-1");
    const two = await s.call("/first-view", { body: { id } });
    assert.equal(two.status, 410);
    assert.equal(two.body.code, "first_view_spent");
  } finally { s.close(); }
});

test("C7 — entries sealed under a missing key list as unreadable and reveal answers 409 key_missing", async () => {
  const s = await setup();
  try {
    const other = createKeychainKey({ crowHome: mkdtempSync(join(tmpdir(), "crow-kcapi-other-")) });
    const { id } = await K.addManualSecret(s.db, other, { label: "From the old machine", secret: "old" });
    const list = await s.call("/entries");
    assert.equal(list.body.entries[0].readable, false);
    assert.equal(list.body.key_present, false);
    await s.call("/reauth", { body: { password: "right-password" } });
    const r = await s.call("/reveal", { body: { id } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "key_missing");
  } finally { s.close(); }
});

test("C5 — deleting an in-use generated token needs an explicit confirmation", async () => {
  const s = await setup();
  try {
    const { id } = await K.saveExtensionSecret(s.db, s.key(), { bundleId: "vaultwarden", envKey: "VAULTWARDEN_ADMIN_TOKEN", label: "Vaultwarden admin token", secret: "tok", origin: "generated" });
    await s.call("/reauth", { body: { password: "right-password" } });
    const r = await s.call("/delete", { body: { id } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "generated_in_use");
    assert.equal((await s.call("/delete", { body: { id, confirm_generated: true } })).status, 200);
  } finally { s.close(); }
});

test("Export then Import (re-auth required): the file round-trips; a wrong passphrase imports nothing", async () => {
  const s = await setup();
  try {
    await K.addManualSecret(s.db, s.key(), { label: "Phone", username: "kevin", secret: "app-pass" });
    assert.equal((await s.call("/export", { body: { passphrase: "correct horse battery" } })).status, 403);
    await s.call("/reauth", { body: { password: "right-password" } });
    assert.equal((await s.call("/export", { body: { passphrase: "short" } })).status, 400);
    const ex = await s.call("/export", { body: { passphrase: "correct horse battery" } });
    assert.equal(ex.status, 200);
    assert.match(ex.disposition, /attachment; filename="crow-keychain-\d{4}-\d{2}-\d{2}\.json"/);
    assert.equal(ex.body.count, 1);
    assert.ok(!JSON.stringify(ex.body).includes("app-pass"));

    const t = await setup();
    try {
      await t.call("/reauth", { body: { password: "right-password" } });
      assert.equal((await t.call("/import", { body: { file: ex.body, passphrase: "wrong passphrase!!" } })).status, 400);
      const im = await t.call("/import", { body: { file: ex.body, passphrase: "correct horse battery" } });
      assert.deepEqual(im.body, { ok: true, imported: 1, skipped: 0 });
      const [e] = (await t.call("/entries")).body.entries;
      assert.equal(e.readable, true);
      assert.equal((await t.call("/reveal", { body: { id: e.id } })).body.secret, "app-pass");
      assert.deepEqual((await t.audits()).filter((a) => a.event_type === "keychain_import").map((a) => JSON.parse(a.details)), [{ imported: 1, skipped: 0 }]);
    } finally { t.close(); }
  } finally { s.close(); }
});

test("add needs no grant; delete needs one; both audited", async () => {
  const s = await setup();
  try {
    const add = await s.call("/add", { body: { label: "Workspace phone (Kevin)", username: "kevin", url: "https://ws:8456", secret: "abcd-efgh-ijkl" } });
    assert.equal(add.status, 200);
    assert.equal((await s.call("/delete", { body: { id: add.body.id } })).status, 403);
    await s.call("/reauth", { body: { password: "right-password" } });
    assert.equal((await s.call("/delete", { body: { id: add.body.id } })).status, 200);
    assert.deepEqual((await s.audits()).map((e) => e.event_type), ["keychain_add", "keychain_reauth_ok", "keychain_delete"]);
    assert.equal((await s.call("/add", { body: { label: "", secret: "x" } })).status, 400);
    assert.equal((await s.call("/add", { body: { label: "x", secret: "" } })).status, 400);
  } finally { s.close(); }
});

test("vault-save: grant required, credentials passed through once, never audited", async () => {
  const s = await setup();
  try {
    const { id } = await K.addManualSecret(s.db, s.key(), { label: "Phone", username: "kevin", secret: "app-pass" });
    assert.equal((await s.call("/vault-save", { body: { id, vault_email: "k@example.invalid", vault_password: "Master-PW" } })).status, 403);
    await s.call("/reauth", { body: { password: "right-password" } });
    const r = await s.call("/vault-save", { body: { id, vault_email: "k@example.invalid", vault_password: "Master-PW" } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(s.vaultCalls[0].masterPassword, "Master-PW");
    assert.equal(s.vaultCalls[0].item.password, "app-pass");
    const ev = JSON.stringify(await s.audits());
    assert.ok(!ev.includes("Master-PW") && !ev.includes("app-pass"));
  } finally { s.close(); }
});

test("peer-signed and session-less requests are refused", async () => {
  const s = await setup();
  try {
    assert.equal((await s.call("/entries", { headers: { "x-crow-signature": "abc" } })).status, 403);
    assert.equal((await s.call("/entries", { session: null })).status, 401);
  } finally { s.close(); }
});

test("m1/m2 — a damaged key with entries refuses saves (409 key_invalid); a lost key is re-created once and reported", async () => {
  const s = await setup();
  try {
    await K.addManualSecret(s.db, s.key(), { label: "Phone", secret: "app-pass" });
    writeFileSync(keychainKeyPath(s.crowHome), "");
    const r = await s.call("/add", { body: { label: "New", secret: "x-1" } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "key_invalid");
    assert.match(r.body.error, /keychain\.key/);

    const { rmSync } = await import("node:fs");
    rmSync(keychainKeyPath(s.crowHome));
    const ok = await s.call("/add", { body: { label: "New", secret: "x-1" } });
    assert.equal(ok.status, 200, "a MISSING key is simply created");
    assert.equal(s.notes.length, 1, "the user is told the older entries need an Import");
    assert.match(s.notes[0].body, /1 saved password/);
    assert.ok((await s.audits()).some((e) => e.event_type === "keychain_key_created"));
  } finally { s.close(); }
});

test("S2 — concurrent wrong /reauth calls cannot bypass the per-session or the instance-wide lockout", async () => {
  let calls = 0;
  const slow = async (p) => { calls++; await new Promise((r) => setTimeout(r, 50)); return p === "right-password"; };
  const s = await setup({ verifier: slow });
  try {
    const rs = await Promise.all(Array.from({ length: 10 }, () => s.call("/reauth", { session: "BURST", body: { password: "wrong" } })));
    assert.ok(calls <= 5, `at most 5 verifier calls allowed, got ${calls}`);
    assert.equal(rs.filter((r) => r.status === 429).length, 10 - calls);
    assert.equal((await s.call("/reauth", { session: "BURST", body: { password: "right-password" } })).status, 429);

    calls = 0;
    const g = await Promise.all(Array.from({ length: 40 }, (_, i) => s.call("/reauth", { session: `G${i}`, body: { password: "wrong" } })));
    assert.ok(calls <= 20 - 5, `global ceiling counts in-flight attempts, got ${calls}`);
    assert.equal(g.filter((r) => r.status === 429).length, 40 - calls);
    assert.equal(s.notes.length, 1, "lockout notification once");
    assert.equal((await s.call("/reauth", { session: "FRESH", body: { password: "right-password" } })).status, 429);
  } finally { s.close(); }
});

test("add rejects a non-http(s) url with a value-free 400", async () => {
  const s = await setup();
  try {
    const r = await s.call("/add", { body: { label: "x", url: "javascript:alert(1)", secret: "abcd-efgh" } });
    assert.equal(r.status, 400);
    assert.ok(!JSON.stringify(r.body).includes("javascript"));
    assert.equal((await s.call("/add", { body: { label: "x", url: "http://ok.example", secret: "abcd-efgh" } })).status, 200);
  } finally { s.close(); }
});

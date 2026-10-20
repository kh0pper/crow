/**
 * Keychain Export as a real, one-time file download (2026-10-20). POST /export parks the sealed
 * file behind a ticket; GET /export/file/<token> serves it once as an attachment to the same
 * session; the Nest reminder is recorded only after the file was served, or (?confirm=1, the
 * Crow app) only after POST /export/saved. Express on 127.0.0.1:0, scratch DB + key.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { rmScratch } from "./helpers/safe-rm.js";

const TMP_HOME = mkdtempSync(join(tmpdir(), "crow-kcdl-home-"));
const TMP_DATA = mkdtempSync(join(tmpdir(), "crow-kcdl-data-"));
process.env.CROW_HOME = TMP_HOME;
process.env.CROW_DATA_DIR = TMP_DATA;
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe" });
after(() => { rmScratch(TMP_HOME); rmScratch(TMP_DATA); });

const { createDbClient } = await import("../servers/db.js");
const { keychainApiRouter } = await import("../servers/gateway/keychain/api.js");
const { createExportTickets } = await import("../servers/gateway/keychain/export-tickets.js");
const { createKeychainKey } = await import("../servers/gateway/keychain/key.js");
const K = await import("../servers/gateway/keychain/store.js");
const R = await import("../servers/gateway/keychain/reminder.js");

const PASS = "a long export passphrase";

async function setup() {
  const crowHome = mkdtempSync(join(tmpdir(), "crow-kcdl-key-"));
  const db = createDbClient();
  await db.execute("DELETE FROM audit_log");
  const clock = { t: Date.parse("2026-10-20T12:00:00Z") };
  const gate = { method: async () => "password", isGranted: (s) => s === "S1" || s === "S2", expiresAt: () => null, verify: async () => ({ ok: true }) };
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => { req.dashboardSession = req.headers["x-test-session"] || null; next(); });
  app.use(keychainApiRouter({ openDb: () => createDbClient(), crowHome, gate, notify: async () => {}, tickets: createExportTickets({ now: () => clock.t }) }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const base = `${origin}/dashboard/keychain/api`;
  const call = async (path, { session = "S1", body, method = body ? "POST" : "GET", headers = {} } = {}) => {
    const r = await fetch(path.startsWith("/dashboard/") ? origin + path : base + path, { method, headers: { "content-type": "application/json", ...(session ? { "x-test-session": session } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
    const text = method === "HEAD" ? "" : await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, text, body: json, headers: r.headers };
  };
  const key = createKeychainKey({ crowHome });
  await K.saveExtensionSecret(db, key, { bundleId: "romm", envKey: "ROMM_AUTH_SECRET_KEY", label: "RomM — secret", secret: "rm-" + "r".repeat(40), origin: "generated" });
  const unexported = () => R.unexportedCount(db, key.id);
  const audits = async () => (await db.execute("SELECT event_type, details FROM audit_log ORDER BY id")).rows;
  const settle = () => new Promise((r) => setTimeout(r, 50));
  const eventually = async (fn, want) => { for (let i = 0; i < 100; i++) { if ((await fn()) === want) return want; await new Promise((r) => setTimeout(r, 20)); } return fn(); };
  return { db, key, call, clock, unexported, audits, settle, eventually, close: () => { server.close(); db.close(); } };
}

test("POST /export returns a one-time link and no file, and records nothing", async () => {
  const s = await setup();
  try {
    const ex = await s.call("/export", { body: { passphrase: PASS } });
    assert.equal(ex.status, 200);
    assert.equal(ex.body.ok, true);
    assert.equal(ex.body.count, 1);
    assert.match(ex.body.filename, /^crow-keychain-\d{4}-\d{2}-\d{2}\.json$/);
    assert.match(ex.body.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(ex.body.download, `/dashboard/keychain/api/export/file/${ex.body.token}`);
    assert.equal(ex.body.ciphertext, undefined, "the sealed file is not in the POST answer");
    assert.equal(ex.headers.get("cache-control"), "no-store");
    assert.equal(await s.unexported(), 1, "nothing was saved yet: the reminder stays");
    assert.deepEqual((await s.audits()).map((a) => a.event_type), [], "nothing has left the server yet");
  } finally { s.close(); }
});

test("GET serves the file once, as an attachment, and only then records the reminder", async () => {
  const s = await setup();
  try {
    const ex = await s.call("/export", { body: { passphrase: PASS } });
    const dl = await s.call(ex.body.download);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get("content-type"), /^application\/json; charset=utf-8/);
    assert.equal(dl.headers.get("content-disposition"), `attachment; filename="${ex.body.filename}"`);
    assert.equal(dl.headers.get("x-content-type-options"), "nosniff");
    assert.equal(dl.headers.get("cache-control"), "no-store");
    assert.equal(dl.body.format, "crow-keychain-export");
    assert.ok(!dl.text.includes("rm-rrrr"), "sealed, never plaintext");
    assert.equal(await s.eventually(s.unexported, 0), 0, "served: the reminder clears");
    const again = await s.call(ex.body.download);
    assert.equal(again.status, 410);
    assert.equal(again.body.code, "export_link_used");
    // The file opens with the passphrase (round trip through Import's reader).
    const { openExport } = await import("../servers/gateway/keychain/export.js");
    assert.equal((await openExport(dl.body, PASS)).length, 1);
    const ev = await s.audits();
    assert.deepEqual(ev.map((a) => a.event_type), ["keychain_export"]);
    assert.deepEqual(JSON.parse(ev[0].details), { count: 1 });
    assert.ok(!JSON.stringify(ev).includes(ex.body.token), "the token is never audited");
  } finally { s.close(); }
});

test("HEAD, another session, a junk token and no session never consume the ticket", async () => {
  const s = await setup();
  try {
    const ex = await s.call("/export", { body: { passphrase: PASS } });
    assert.equal((await s.call(ex.body.download, { method: "HEAD" })).status, 405);
    for (const [h, v] of [["sec-purpose", "prefetch"], ["x-sec-purpose", "prefetch"], ["purpose", "prefetch"], ["sec-purpose", "prefetch;prerender"], ["x-moz", "prefetch"]]) {
      assert.equal((await s.call(ex.body.download, { headers: { [h]: v } })).status, 409, h);
    }
    assert.equal((await s.call(ex.body.download, { method: "POST", body: {} })).status, 405);
    assert.equal((await s.call(ex.body.download, { session: "S2" })).status, 404);
    assert.equal((await s.call(ex.body.download, { session: null })).status, 401);
    assert.equal((await s.call("/export/file/" + "A".repeat(43))).status, 404);
    assert.equal((await s.call("/export/file/short")).status, 404);
    assert.equal(await s.unexported(), 1);
    assert.equal((await s.call(ex.body.download)).status, 200, "its owner still gets it");
  } finally { s.close(); }
});

test("a GET from the Crow app's WebView (a navigation) never counts as saved", async () => {
  const s = await setup();
  try {
    const ex = await s.call("/export", { body: { passphrase: PASS } });
    const dl = await s.call(ex.body.download, { headers: { "user-agent": "Mozilla/5.0 (Linux; Android 15) Chrome/130 Mobile Safari/537.36 CrowAndroid/1.6.1" } });
    assert.equal(dl.status, 200);
    await s.settle();
    assert.equal(await s.unexported(), 1);
    assert.deepEqual((await s.audits()).map((a) => a.event_type), ["keychain_export_fetched"]);
  } finally { s.close(); }
});

test("an expired link is 410 and records nothing", async () => {
  const s = await setup();
  try {
    const ex = await s.call("/export", { body: { passphrase: PASS } });
    s.clock.t += 121_000;
    const dl = await s.call(ex.body.download);
    assert.equal(dl.status, 410);
    assert.equal(dl.body.code, "export_link_expired");
    await s.settle();
    assert.equal(await s.unexported(), 1);
  } finally { s.close(); }
});

test("?confirm=1 (the Crow app): served, but the reminder waits for POST /export/saved", async () => {
  const s = await setup();
  try {
    const ex = await s.call("/export", { body: { passphrase: PASS } });
    const dl = await s.call(ex.body.download + "?confirm=1");
    assert.equal(dl.status, 200);
    await s.settle();
    assert.equal(await s.unexported(), 1, "fetched by the page is not saved on the phone");
    assert.equal((await s.call(ex.body.download)).status, 410, "still served once");
    assert.equal((await s.call("/export/saved", { session: "S2", body: { token: ex.body.token } })).status, 404);
    assert.equal((await s.call("/export/saved", { body: {} })).status, 404);
    const ok = await s.call("/export/saved", { body: { token: ex.body.token } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { ok: true });
    assert.equal(await s.unexported(), 0);
    assert.equal((await s.call("/export/saved", { body: { token: ex.body.token } })).status, 404, "once");
    const ev = await s.audits();
    assert.deepEqual(ev.map((a) => a.event_type), ["keychain_export_fetched", "keychain_export_saved"], "fetched by the app is not 'Exported'");
  } finally { s.close(); }
});

test("saved before the file was fetched, or after a plain fetch, records nothing new", async () => {
  const s = await setup();
  try {
    const ex = await s.call("/export", { body: { passphrase: PASS } });
    const early = await s.call("/export/saved", { body: { token: ex.body.token } });
    assert.equal(early.status, 409);
    assert.equal(early.body.code, "export_not_fetched");
    assert.equal(await s.unexported(), 1);
  } finally { s.close(); }
});

test("POST /export/saved after the 10-minute confirm window is 410 and records nothing", async () => {
  const s = await setup();
  try {
    const ex = await s.call("/export", { body: { passphrase: PASS } });
    assert.equal((await s.call(ex.body.download + "?confirm=1")).status, 200);
    s.clock.t += 600_001;
    const late = await s.call("/export/saved", { body: { token: ex.body.token } });
    assert.equal(late.status, 410);
    assert.equal(late.body.code, "export_link_expired");
    assert.equal(await s.unexported(), 1);
  } finally { s.close(); }
});

test("a second Export replaces the first link (one live link per session)", async () => {
  const s = await setup();
  try {
    const a = await s.call("/export", { body: { passphrase: PASS } });
    const b = await s.call("/export", { body: { passphrase: PASS } });
    assert.notEqual(a.body.token, b.body.token);
    assert.equal((await s.call(a.body.download)).status, 404);
    assert.equal((await s.call(b.body.download)).status, 200);
  } finally { s.close(); }
});

test("export without a grant is still refused, and makes no link", async () => {
  const s = await setup();
  try {
    const r = await s.call("/export", { session: "S9", body: { passphrase: PASS } });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "reauth_required");
  } finally { s.close(); }
});

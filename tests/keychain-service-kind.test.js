/**
 * Keychain kind 'service' (project services Task 6): a project connection's secrets, keyed by the
 * connection uuid and filtered to the service's own field names. Scratch DB/home; never touches ~/.crow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-kcsvc-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const { createDbClient } = await import("../servers/db.js");
const K = await import("../servers/gateway/keychain/store.js");
const { createKeychainKey } = await import("../servers/gateway/keychain/key.js");
const { sealExport, openExport } = await import("../servers/gateway/keychain/export.js");
const { createReauthGate } = await import("../servers/gateway/keychain/reauth.js");
const { keychainApiRouter } = await import("../servers/gateway/keychain/api.js");
const { SERVICE_CONNECTIONS_DDL } = await import("../servers/shared/project-services-schema.js");

const SECRET_A = "test-token-61";
const SECRET_B = "test-token-62";
const SECRET_X = "test-token-63";

const home = () => mkdtempSync(join(tmpdir(), "crow-kcsvc-home-"));
const dbAt = () => {
  const path = join(mkdtempSync(join(tmpdir(), "crow-kcsvc-db-")), "crow.db");
  return { path, db: createDbClient(path) };
};
const fresh = () => {
  const { path, db } = dbAt();
  return { path, db, key: createKeychainKey({ crowHome: home() }) };
};
const rowsOf = async (db) => (await db.execute("SELECT * FROM crow_keychain ORDER BY id")).rows;
const save = (db, key, envKey, secret, extra = {}) =>
  K.saveServiceSecret(db, key, { connectionUuid: "u-7", bundleId: "github", envKey, label: `GitHub — ${envKey}`, secret, ...extra });

test("save two secrets for one connection; serviceSecretsFor returns only the allowed keys; a resave updates in place", async () => {
  const { db, key } = fresh();
  const a = await save(db, key, "A", SECRET_A);
  const b = await save(db, key, "B", SECRET_B);
  assert.equal(a.created, true);
  assert.equal(b.created, true);
  assert.deepEqual(await K.serviceSecretsFor(db, key, "u-7", { allowedKeys: ["A", "B"] }), { A: SECRET_A, B: SECRET_B });
  const rows = await rowsOf(db);
  assert.deepEqual(rows.map((r) => [r.kind, r.connection_uuid, r.env_key, r.origin, r.status]), [["service", "u-7", "A", "typed", "active"], ["service", "u-7", "B", "typed", "active"]]);
  assert.ok(!JSON.stringify(rows).includes(SECRET_A), "only sealed in the DB");

  const again = await save(db, key, "A", "test-token-64");
  assert.deepEqual(again, { id: a.id, created: false });
  assert.equal((await rowsOf(db)).length, 2);
  assert.equal((await K.serviceSecretsFor(db, key, "u-7", { allowedKeys: ["A"] })).A, "test-token-64");
});

test("an extra env key on a row is never returned", async () => {
  const { db, key } = fresh();
  await save(db, key, "A", SECRET_A);
  await save(db, key, "B", SECRET_B);
  await save(db, key, "LD_PRELOAD", SECRET_X);
  assert.deepEqual(await K.serviceSecretsFor(db, key, "u-7", { allowedKeys: ["A"] }), { A: SECRET_A });
  assert.deepEqual(await K.serviceSecretsFor(db, key, "u-7", { allowedKeys: [] }), {}, "no allowed keys → nothing");
  assert.deepEqual(await K.serviceSecretsFor(db, key, "u-7", {}), {}, "allowedKeys missing → nothing");
  assert.deepEqual(await K.serviceSecretsFor(db, key, "u-8", { allowedKeys: ["A"] }), {}, "another connection's rows never");
  assert.deepEqual(await K.serviceSecretsFor(db, null, "u-7", { allowedKeys: ["A"] }), {}, "no key → nothing");
  const other = createKeychainKey({ crowHome: home() });
  assert.deepEqual(await K.serviceSecretsFor(db, other, "u-7", { allowedKeys: ["A"] }), {}, "rows sealed under another key are unreadable");
});

test("M5 — a service secret without a connection uuid is refused, and the error carries no secret", async () => {
  const { db, key } = fresh();
  for (const connectionUuid of [undefined, null, "", "   ", 7]) {
    await assert.rejects(K.saveServiceSecret(db, key, { connectionUuid, envKey: "A", secret: SECRET_A }), (e) => /connection uuid/.test(e.message) && !e.message.includes(SECRET_A));
  }
  await assert.rejects(K.saveServiceSecret(db, key, { connectionUuid: "u-7", envKey: "A", secret: "" }));
  await assert.rejects(K.saveServiceSecret(db, null, { connectionUuid: "u-7", envKey: "A", secret: SECRET_A }), (e) => e.code === "KEYCHAIN_KEY_MISSING");
  assert.equal((await rowsOf(db)).length, 0, "nothing was written");
  const out = await K.importEntries(db, key, [{ kind: "service", label: "x", env_key: "A", secret: SECRET_A, connection_uuid: null }, { kind: "service", label: "x", env_key: "A", secret: SECRET_A }]);
  assert.equal(out.imported, 0);
  assert.equal(out.skipped, 2);
  assert.equal((await rowsOf(db)).length, 0);
});

test("uninstall marks a bundle's service rows removed (not served), and reinstall brings them back", async () => {
  const { db, key } = fresh();
  await save(db, key, "A", SECRET_A);
  await save(db, key, "B", SECRET_B);
  await K.saveExtensionSecret(db, key, { bundleId: "github", envKey: "GITHUB_PERSONAL_ACCESS_TOKEN", label: "legacy", secret: SECRET_X, origin: "typed" });
  await K.saveServiceSecret(db, key, { connectionUuid: "u-9", bundleId: "trello", envKey: "A", secret: SECRET_X });
  assert.equal(await K.markBundleRemoved(db, "github"), 3);
  const st = (await rowsOf(db)).map((r) => [r.kind, r.bundle_id, r.status]);
  assert.deepEqual(st, [["service", "github", "extension_removed"], ["service", "github", "extension_removed"], ["extension", "github", "extension_removed"], ["service", "trello", "active"]]);
  assert.deepEqual(await K.serviceSecretsFor(db, key, "u-7", { allowedKeys: ["A", "B"] }), {}, "a removed bundle's secrets reach no child");
  assert.equal(await K.reactivateBundleEntries(db, "github", ["GITHUB_PERSONAL_ACCESS_TOKEN"]), 3);
  assert.deepEqual(await K.serviceSecretsFor(db, key, "u-7", { allowedKeys: ["A", "B"] }), { A: SECRET_A, B: SECRET_B });
  assert.ok((await rowsOf(db)).every((r) => r.status === "active"));
  assert.equal(await K.markBundleRemoved(db, "github"), 3);
  assert.equal(await K.reactivateBundleEntries(db, "github", []), 2, "service rows come back even with no reused extension keys");
});

test("import never attaches by id (C1): an imported row keeps its uuid and never reaches a local connection with the same id", async () => {
  const one = fresh();
  await K.saveServiceSecret(one.db, one.key, { connectionUuid: "u-7", bundleId: "github", envKey: "GITHUB_PERSONAL_ACCESS_TOKEN", label: "GitHub — Work", secret: SECRET_A });
  const exported = await K.exportableEntries(one.db, one.key);
  assert.equal(exported.length, 1);
  assert.equal(exported[0].connection_uuid, "u-7");
  assert.equal(exported[0].kind, "service");
  const file = await sealExport(exported, "a long passphrase");
  const entries = await openExport(file, "a long passphrase");

  // DB 2: a different service's connection already holds local id 1, with uuid u-other.
  const two = fresh();
  await two.db.execute("CREATE TABLE IF NOT EXISTS project_spaces (id INTEGER PRIMARY KEY)");
  await two.db.execute("INSERT INTO project_spaces (id) VALUES (1)");
  await two.db.executeMultiple(SERVICE_CONNECTIONS_DDL);
  await two.db.execute("INSERT INTO service_connections (id, uuid, project_id, service_id, bundle_id, method, account_label, label_slug) VALUES (1, 'u-other', 1, 'github', 'github', 'token', 'Home', 'home')");
  // Even an export carrying a local-looking id must not attach by it.
  const out = await K.importEntries(two.db, two.key, entries.map((e) => ({ ...e, id: 1, connection_id: 1 })));
  assert.equal(out.imported, 1);
  assert.deepEqual(await K.serviceSecretsFor(two.db, two.key, "u-other", { allowedKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN"] }), {});
  const rows = await rowsOf(two.db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].connection_uuid, "u-7", "the imported row keeps its own uuid: unattached for good");
  assert.equal(rows[0].kind, "service");
  assert.deepEqual(await K.serviceSecretsFor(two.db, two.key, "u-7", { allowedKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN"] }), { GITHUB_PERSONAL_ACCESS_TOKEN: SECRET_A });

  // A second import of the same file skips the readable pair.
  const again = await K.importEntries(two.db, two.key, entries);
  assert.deepEqual([again.imported, again.skipped], [0, 1]);
  assert.equal((await rowsOf(two.db)).length, 1);
});

test("an unreadable service row (old key) is replaced by its import: the restore path", async () => {
  const { db, key } = fresh();
  const oldKey = createKeychainKey({ crowHome: home() });
  await save(db, oldKey, "A", SECRET_A);
  assert.deepEqual(await K.serviceSecretsFor(db, key, "u-7", { allowedKeys: ["A"] }), {});
  const out = await K.importEntries(db, key, [{ kind: "service", label: "GitHub — A", bundle_id: "github", env_key: "A", connection_uuid: "u-7", secret: SECRET_A, status: "active" }]);
  assert.equal(out.imported, 1);
  assert.equal((await rowsOf(db)).length, 1);
  assert.deepEqual(await K.serviceSecretsFor(db, key, "u-7", { allowedKeys: ["A"] }), { A: SECRET_A });
});

test("deleteEntry refuses a service row; deleteServiceSecrets removes exactly one connection's rows", async () => {
  const { db, key } = fresh();
  const a = await save(db, key, "A", SECRET_A);
  await save(db, key, "B", SECRET_B);
  await K.saveServiceSecret(db, key, { connectionUuid: "u-8", envKey: "A", secret: SECRET_X });
  const { id: manual } = await K.addManualSecret(db, key, { label: "Phone", secret: "app-pass" });
  await assert.rejects(K.deleteEntry(db, a.id), (e) => e instanceof K.KeychainServiceRowError && e.code === "KEYCHAIN_SERVICE_ROW" && !e.message.includes(SECRET_A));
  assert.equal((await rowsOf(db)).length, 4, "nothing deleted");
  assert.equal(await K.deleteEntry(db, manual), true, "other kinds still delete");
  assert.equal(await K.deleteEntry(db, 9999), false);
  assert.deepEqual(await K.deleteServiceSecrets(db, "u-7"), { deleted: 2 });
  assert.deepEqual(await K.serviceSecretsFor(db, key, "u-7", { allowedKeys: ["A", "B"] }), {});
  assert.deepEqual(await K.serviceSecretsFor(db, key, "u-8", { allowedKeys: ["A"] }), { A: SECRET_X }, "another connection is untouched");
  assert.deepEqual(await K.deleteServiceSecrets(db, ""), { deleted: 0 });
  assert.deepEqual(await K.deleteServiceSecrets(db, undefined), { deleted: 0 });
});

test("listEntries shows a service row's metadata (uuid, field name) and never its secret", async () => {
  const { db, key } = fresh();
  await save(db, key, "A", SECRET_A);
  const list = await K.listEntries(db, { keyId: key.id });
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, "service");
  assert.equal(list[0].connection_uuid, "u-7");
  assert.equal(list[0].env_key, "A");
  assert.equal(list[0].readable, true);
  assert.ok(!JSON.stringify(list).includes(SECRET_A));
  assert.ok(!("secret_sealed" in list[0]));
});

test("A12 — readableSecretsSync (the bot secret-masking reader) includes service secrets, so approval cards mask them", async () => {
  const { path, db, key } = fresh();
  await save(db, key, "A", SECRET_A);
  await K.addManualSecret(db, key, { label: "Phone", secret: "app-pass" });
  db.close();
  const raw = new Database(path, { readonly: true });
  try {
    const out = K.readableSecretsSync(raw, key);
    assert.ok(out.some((e) => e.kind === "service" && e.secret === SECRET_A), "service secret masked");
    assert.ok(out.some((e) => e.kind === "manual"));
  } finally { raw.close(); }
});

test("the delete route answers 409 {error:'service_row'} for a service row, audits nothing, and no response carries the secret", async () => {
  const AUDIT_DDL = "CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, actor TEXT, ip_address TEXT, details TEXT, created_at TEXT DEFAULT (datetime('now')))";
  const { path } = dbAt();
  const crowHome = home();
  const db = createDbClient(path);
  await db.execute(AUDIT_DDL);
  const key = createKeychainKey({ crowHome });
  const { id } = await K.saveServiceSecret(db, key, { connectionUuid: "u-7", bundleId: "github", envKey: "A", label: "GitHub — A", secret: SECRET_A });
  const gate = createReauthGate({ is2faEnabled: async () => false, hasDashboardPassword: async () => true, verifyTotpCode: async () => false, verifyDashboardPassword: async (p) => p === "right-password" });
  const logs = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => { logs.push(a.map(String).join(" ")); };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.dashboardSession = "S1"; next(); });
  app.use(keychainApiRouter({ openDb: () => createDbClient(path), crowHome, gate, notify: async () => {}, vault: { status: () => null, save: async () => ({ ok: false }) } }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/dashboard/keychain/api`;
  const call = (p, body) => fetch(base + p, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, text: await r.text() }));
  try {
    assert.equal((await call("/reauth", { password: "right-password" })).status, 200);
    const del = await call("/delete", { id });
    assert.equal(del.status, 409);
    assert.deepEqual(JSON.parse(del.text), { error: "service_row" });
    assert.equal((await rowsOf(db)).length, 1, "the row stays");
    const list = await call("/entries");
    assert.equal(list.status, 200);
    assert.ok(JSON.parse(list.text).entries.some((e) => e.kind === "service" && e.env_key === "A"));
    const events = (await db.execute("SELECT event_type, details FROM audit_log")).rows;
    assert.ok(!events.some((e) => e.event_type === "keychain_delete"), "a refused delete is not audited as a delete");
    for (const blob of [del.text, list.text, JSON.stringify(events), logs.join("\n")]) assert.ok(!blob.includes(SECRET_A));
  } finally {
    Object.assign(console, orig);
    server.close();
  }
});

test("the store's service paths never log a secret", () => {
  const src = readFileSync(new URL("../servers/gateway/keychain/store.js", import.meta.url), "utf8");
  assert.ok(!/console\.(log|warn|error|info)/.test(src), "the store has no logging at all");
});

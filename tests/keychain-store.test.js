/** Crow keychain store + its own key + export file (Task 3). Scratch DB/home; never touches ~/.crow. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-kc-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const { createDbClient } = await import("../servers/db.js");
const K = await import("../servers/gateway/keychain/store.js");
const KEY = await import("../servers/gateway/keychain/key.js");
const X = await import("../servers/gateway/keychain/export.js");
const SYNC = await import("../servers/sharing/instance-sync.js");
const { emitOrQueue } = await import("../servers/shared/sync-emit.js");
const D3 = await import("../scripts/ops/grackle-d3-import.mjs");

const home = () => mkdtempSync(join(tmpdir(), "crow-kc-home-"));
const freshDb = () => createDbClient(join(mkdtempSync(join(tmpdir(), "crow-kc-db-")), "crow.db"));
const mode = (p) => statSync(p).mode & 0o777;

test("C7 — the keychain key is its own random file: 600 in a 700 dir, created only on demand", () => {
  const h = home();
  assert.equal(KEY.loadKeychainKey({ crowHome: h }), null, "no key until something is saved");
  assert.equal(KEY.keychainKeyState({ crowHome: h }).state, "missing");
  const k = KEY.createKeychainKey({ crowHome: h });
  assert.equal(k.seed.length, 32);
  assert.match(k.id, /^[0-9a-f]{16}$/);
  const p = KEY.keychainKeyPath(h);
  assert.equal(p, join(h, "secrets", "keychain.key"));
  assert.equal(mode(p), 0o600);
  assert.equal(mode(join(h, "secrets")), 0o700);
  assert.deepEqual(KEY.createKeychainKey({ crowHome: h }), k, "a second create reuses the file");
  assert.deepEqual(readdirSync(join(h, "secrets")), ["keychain.key"], "m1: no temp file left behind");
});

test("m1 — an empty/damaged key is replaced only while the table is empty; otherwise a clear refusal", async () => {
  const h = home();
  const db = freshDb();
  const k = KEY.createKeychainKey({ crowHome: h });
  await K.addManualSecret(db, k, { label: "Phone", secret: "app-pass" });
  writeFileSync(KEY.keychainKeyPath(h), "");
  assert.equal(KEY.keychainKeyState({ crowHome: h }).state, "invalid");
  assert.throws(() => KEY.createKeychainKey({ crowHome: h }), (e) => e.code === "KEYCHAIN_KEY_INVALID" && e.message.includes(KEY.keychainKeyPath(h)));
  await assert.rejects(K.ensureWriteKey(db, { crowHome: h }), (e) => e.code === "KEYCHAIN_KEY_INVALID", "rows exist → refuse, never silently re-key");
  assert.equal(readFileSync(KEY.keychainKeyPath(h), "utf8"), "", "the damaged file is left for the user to restore");

  const h2 = home();
  const db2 = freshDb();
  KEY.createKeychainKey({ crowHome: h2 });
  writeFileSync(KEY.keychainKeyPath(h2), "{\"v\":1,\"id\":\"short\"}");
  const fresh = await K.ensureWriteKey(db2, { crowHome: h2 });
  assert.equal(fresh.seed.length, 32, "empty table → replaced");
  assert.ok(readdirSync(join(h2, "secrets")).some((n) => n.startsWith("keychain.key.invalid-")), "the damaged file is moved aside, never deleted");
});

test("m2 — a new key created while rows exist (old key lost) is reported through onNewKey", async () => {
  const db = freshDb();
  const lost = KEY.createKeychainKey({ crowHome: home() });
  await K.addManualSecret(db, lost, { label: "Old", secret: "x" });
  const seen = [];
  const k = await K.ensureWriteKey(db, { crowHome: home(), onNewKey: (info) => seen.push(info) });
  assert.ok(k);
  assert.deepEqual(seen, [{ orphaned: 1 }]);
});

test("C7 — no backup path can carry the key: it lives outside the data dir and no backup code names it", () => {
  const h = home();
  assert.ok(!KEY.keychainKeyPath(h).startsWith(process.env.CROW_DATA_DIR), "crow.db copies never include it");
  for (const f of ["servers/gateway/routes/admin-backup.js", "servers/sharing/identity.js", "bundles/workspace/ops/backup.sh"]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /keychain\.key|secrets\/keychain/, `${f} must never copy the keychain key`);
  }
});

test("C7 — the whole <CROW_HOME>/secrets dir (keychain key AND vault device id) stays out of every backup path", async () => {
  const VS = await import("../servers/gateway/keychain/vault-save.js");
  const h = home();
  const secretsDir = join(h, "secrets");
  assert.equal(join(KEY.keychainKeyPath(h), ".."), secretsDir);
  assert.equal(join(VS.vaultDeviceIdPath(h), ".."), secretsDir, "the vault device id lives beside the key");
  assert.ok(!secretsDir.startsWith(process.env.CROW_DATA_DIR), "crow.db copies never include the secrets dir");
  for (const f of ["servers/gateway/routes/admin-backup.js", "servers/sharing/identity.js", "bundles/workspace/ops/backup.sh", "scripts/backup.sh"]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /keychain\.key|vault-device-id|\bsecrets\/|["'`]secrets["'`]/, `${f} must never copy anything from <CROW_HOME>/secrets`);
  }
});

test("save → list carries metadata only; open returns the plaintext; the column holds ciphertext", async () => {
  const db = freshDb();
  const key = KEY.createKeychainKey({ crowHome: home() });
  const { id, created } = await K.saveExtensionSecret(db, key, { bundleId: "workspace", envKey: "WORKSPACE_ADMIN_PASSWORD", label: "Crow Workspace — admin password", username: "admin", url: null, secret: "p a$s'w\"d", origin: "typed", firstView: false });
  assert.equal(created, true);
  const [e] = await K.listEntries(db, { keyId: key.id });
  assert.equal(e.id, id);
  assert.equal(e.readable, true);
  assert.equal(e.status, "active");
  assert.ok(!JSON.stringify(e).includes("p a$s"), "list never carries the secret");
  assert.equal(await K.openEntrySecret(db, key, id), "p a$s'w\"d");
  const raw = (await db.execute({ sql: "SELECT secret_sealed FROM crow_keychain WHERE id = ?", args: [id] })).rows[0].secret_sealed;
  assert.match(raw, /^enc:v1:/);
});

test("C7 — restored without the key: entries list as unreadable, open/first-view throw KEYCHAIN_KEY_MISSING, never crash", async () => {
  const db = freshDb();
  const oldKey = KEY.createKeychainKey({ crowHome: home() });
  const { id } = await K.saveExtensionSecret(db, oldKey, { bundleId: "vaultwarden", envKey: "VAULTWARDEN_ADMIN_TOKEN", label: "L", secret: "tok", origin: "generated", firstView: true });
  const newKey = KEY.createKeychainKey({ crowHome: home() });
  const [e] = await K.listEntries(db, { keyId: newKey.id });
  assert.equal(e.readable, false);
  assert.equal((await K.listEntries(db, { keyId: null }))[0].readable, false, "no key at all → unreadable too");
  await assert.rejects(K.openEntrySecret(db, newKey, id), (err) => err.code === "KEYCHAIN_KEY_MISSING");
  await assert.rejects(K.openEntrySecret(db, null, id), (err) => err.code === "KEYCHAIN_KEY_MISSING");
  await assert.rejects(K.consumeFirstView(db, newKey, id), (err) => err.code === "KEYCHAIN_KEY_MISSING");
  assert.deepEqual(await K.pendingFirstViews(db, { keyId: newKey.id }), [], "no banner for an unreadable token");
  assert.equal(await K.deleteEntry(db, id), true, "an unreadable entry can still be deleted");
});

test("a second save for the same bundle+key updates in place (no duplicates)", async () => {
  const db = freshDb();
  const key = KEY.createKeychainKey({ crowHome: home() });
  const a = await K.saveExtensionSecret(db, key, { bundleId: "b", envKey: "K", label: "L", secret: "one", origin: "typed" });
  const b = await K.saveExtensionSecret(db, key, { bundleId: "b", envKey: "K", label: "L2", secret: "two", origin: "typed" });
  assert.equal(b.id, a.id);
  assert.equal(b.created, false);
  assert.equal((await K.listEntries(db)).length, 1);
  assert.equal(await K.openEntrySecret(db, key, a.id), "two");
  await assert.rejects(K.saveExtensionSecret(db, key, { bundleId: "b", envKey: "K", label: "L", secret: "x", origin: "bogus" }), /origin/);
});

test("manual entries; delete; uninstall marks extension entries and a later save reactivates them", async () => {
  const db = freshDb();
  const key = KEY.createKeychainKey({ crowHome: home() });
  const m = await K.addManualSecret(db, key, { label: "Phone app password", username: "casey", url: "https://ws.example:8456", secret: "abcd-efgh" });
  const x = await K.saveExtensionSecret(db, key, { bundleId: "vaultwarden", envKey: "VAULTWARDEN_ADMIN_TOKEN", label: "Vaultwarden — admin token", secret: "t", origin: "generated" });
  assert.equal(await K.markBundleRemoved(db, "vaultwarden"), 1);
  assert.equal((await K.getEntry(db, x.id)).status, "extension_removed");
  assert.equal((await K.getEntry(db, m.id)).status, "active", "manual entries are never touched by uninstall");
  assert.equal(await K.reactivateBundleEntries(db, "vaultwarden", ["VAULTWARDEN_ADMIN_TOKEN"]), 1);
  assert.equal((await K.getEntry(db, x.id)).status, "active");
  assert.equal(await K.deleteEntry(db, m.id), true);
  assert.equal(await K.deleteEntry(db, m.id), false);
  assert.equal(await K.getEntry(db, m.id), null);
});

test("REVIEW FOCUS 2 — first view is single-use and expires", async () => {
  const db = freshDb();
  const key = KEY.createKeychainKey({ crowHome: home() });
  const t0 = new Date("2026-10-03T12:00:00Z");
  const { id } = await K.saveExtensionSecret(db, key, { bundleId: "vaultwarden", envKey: "VAULTWARDEN_ADMIN_TOKEN", label: "L", secret: "tok", origin: "generated", firstView: true, now: t0 });
  assert.equal((await K.pendingFirstViews(db, { now: t0, keyId: key.id })).length, 1);
  assert.equal(await K.consumeFirstView(db, key, id, { now: new Date(t0.getTime() + 60_000) }), "tok");
  assert.equal(await K.consumeFirstView(db, key, id, { now: new Date(t0.getTime() + 61_000) }), null, "second look refused");
  const late = await K.saveExtensionSecret(db, key, { bundleId: "x", envKey: "Y", label: "L", secret: "tok2", origin: "generated", firstView: true, now: t0 });
  assert.equal(await K.consumeFirstView(db, key, late.id, { now: new Date(t0.getTime() + K.FIRST_VIEW_MS + 1) }), null, "expired after 30 min");
});

test("Export → Import round-trips through a passphrase file; wrong passphrase opens nothing; readable entries are never overwritten", async () => {
  const db = freshDb();
  const key = KEY.createKeychainKey({ crowHome: home() });
  await K.saveExtensionSecret(db, key, { bundleId: "workspace", envKey: "WORKSPACE_ADMIN_PASSWORD", label: "WS admin", username: "admin", secret: "ws-pass 1", origin: "typed" });
  await K.addManualSecret(db, key, { label: "Phone", username: "casey", secret: "app-pass" });
  const entries = await K.exportableEntries(db, key);
  assert.equal(entries.length, 2);
  const file = await X.sealExport(entries, "correct horse battery");
  assert.equal(file.format, "crow-keychain-export");
  assert.ok(!JSON.stringify(file).includes("ws-pass") && !JSON.stringify(file).includes("WS admin"), "nothing readable in the file");
  assert.equal(await X.openExport(file, "wrong passphrase!!"), null);
  await assert.rejects(X.sealExport(entries, "short"), /at least 12/);

  // New machine: fresh DB + new key, the old crow.db rows restored (unreadable there).
  const db2 = freshDb();
  const key2 = KEY.createKeychainKey({ crowHome: home() });
  await K.saveExtensionSecret(db2, key, { bundleId: "workspace", envKey: "WORKSPACE_ADMIN_PASSWORD", label: "WS admin", secret: "stale", origin: "typed" });
  const out = await K.importEntries(db2, key2, await X.openExport(file, "correct horse battery"));
  assert.deepEqual(out, { imported: 2, skipped: 0 }, "the unreadable restored row is replaced");
  const list = await K.listEntries(db2, { keyId: key2.id });
  assert.ok(list.every((e) => e.readable));
  const ws = list.find((e) => e.env_key === "WORKSPACE_ADMIN_PASSWORD");
  assert.equal(await K.openEntrySecret(db2, key2, ws.id), "ws-pass 1");
  assert.deepEqual(await K.importEntries(db2, key2, await X.openExport(file, "correct horse battery")), { imported: 0, skipped: 2 }, "re-import overwrites nothing");
});

test("init-db creates crow_keychain with the same columns as the store's lazy ensure (no CHECK constraints)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-kc-initdb-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe" });
  const a = new Database(join(dir, "crow.db"), { readonly: true });
  const fromInit = a.prepare("PRAGMA table_info(crow_keychain)").all().map((c) => c.name);
  const ddl = a.prepare("SELECT sql FROM sqlite_master WHERE name = 'crow_keychain'").get().sql;
  a.close();
  const db = freshDb();
  await K.ensureKeychainTable(db);
  const fromLazy = (await db.execute("PRAGMA table_info(crow_keychain)")).rows.map((c) => c.name);
  assert.deepEqual(fromInit, fromLazy);
  assert.ok(fromInit.includes("key_id") && fromInit.includes("first_view_until"));
  assert.doesNotMatch(ddl, /CHECK/);
});

test("REVIEW FOCUS 3 — crow_keychain can never replicate (and the grackle D3 importer skips it)", async () => {
  assert.ok(SYNC.LOCAL_ONLY_TABLES.includes("crow_keychain"));
  assert.ok(!SYNC.SYNCED_TABLES.includes("crow_keychain"));
  assert.throws(() => SYNC.assertLocalOnlyDisjoint(["memories", "crow_keychain"], SYNC.LOCAL_ONLY_TABLES), /local-only/);
  assert.equal(SYNC.shouldSyncRowForTest("crow_keychain", { id: 1 }), false);
  const row = { id: 1, secret_sealed: "enc:v1:x" };
  assert.equal(await SYNC.InstanceSyncManager.prototype.emitChange.call({ feedsDisabled: false }, "crow_keychain", "insert", row), null);
  const db = freshDb();
  assert.equal(await emitOrQueue(null, db, "crow_keychain", "insert", row), null);
  assert.equal((await db.execute("SELECT name FROM sqlite_master WHERE name = 'sync_outbox'")).rows.length, 0, "nothing was even queued");
  const writes = [];
  const fakeThis = { db: { execute: async (q) => { writes.push(q); return { rows: [] }; } } };
  await SYNC.InstanceSyncManager.prototype._applyEntry.call(fakeThis, "peer", { table: "crow_keychain", op: "insert", row, lamport_ts: 1, instance_id: "peer" });
  assert.equal(writes.length, 0);
  assert.match(D3.SKIP_REASONS.crow_keychain, /Export/);
  const offenders = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (n === "node_modules") continue; if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".js") && /emit(OrQueue|Change)\([^)]*crow_keychain/.test(readFileSync(p, "utf8"))) offenders.push(p); } };
  walk("servers");
  assert.deepEqual(offenders, []);
});

test("B2 — a crafted export is refused fast: only the v1 KDF constants and exact salt/nonce/tag lengths", async () => {
  const db = freshDb();
  const key = KEY.createKeychainKey({ crowHome: home() });
  await K.addManualSecret(db, key, { label: "Phone", secret: "app-pass" });
  const good = await X.sealExport(await K.exportableEntries(db, key), "correct horse battery");
  const variants = [
    { ...good, kdf: { ...good.kdf, memory: 2097152 } },
    { ...good, kdf: { ...good.kdf, passes: 2097152 } },
    { ...good, kdf: { ...good.kdf, parallelism: 64 } },
    { ...good, kdf: { ...good.kdf, salt: Buffer.alloc(8).toString("base64") } },
    { ...good, nonce: Buffer.alloc(16).toString("base64") },
    { ...good, tag: Buffer.alloc(4).toString("base64") },
    { ...good, version: 2 },
    { ...good, ciphertext: "x".repeat(5 * 1024 * 1024) },
  ];
  const t0 = Date.now();
  for (const v of variants) assert.equal(await X.openExport(v, "correct horse battery"), null);
  assert.ok(Date.now() - t0 < 1000, "refused before any key derivation");
  assert.equal((await X.openExport(good, "correct horse battery")).length, 1, "the genuine file still opens");
});

test("import drops a non-http(s) url but still imports the entry", async () => {
  const db = freshDb();
  const key = KEY.createKeychainKey({ crowHome: home() });
  const out = await K.importEntries(db, key, [
    { kind: "manual", label: "Evil link", username: null, url: "javascript:alert(1)", secret: "s1" },
    { kind: "manual", label: "Good link", username: null, url: "HTTPS://ok.example", secret: "s2" },
  ]);
  assert.deepEqual(out, { imported: 2, skipped: 0 });
  const list = await K.listEntries(db, { keyId: key.id });
  assert.equal(list.find((e) => e.label === "Evil link").url, null);
  assert.equal(list.find((e) => e.label === "Good link").url, "HTTPS://ok.example");
});

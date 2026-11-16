/**
 * Crow Mail's keychain rows belong to Crow: one bundle id, named once by the keychain store and
 * reused by the mail credentials module, and reserved so no add-on installed under that id can
 * overwrite, revive, remove or be handed one. Scratch DB + scratch key home; never ~/.crow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-kc-mail-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const { createDbClient } = await import("../servers/db.js");
const K = await import("../servers/gateway/keychain/store.js");
const KEY = await import("../servers/gateway/keychain/key.js");
const HOOKS = await import("../servers/gateway/keychain/install-hooks.js");
const { MAIL_BUNDLE_ID, createMailCredentials } = await import("../servers/gateway/mail/credentials.js");

const ACCOUNT = "ma-0123456789abcdef";
const freshDb = () => createDbClient(join(mkdtempSync(join(tmpdir(), "crow-kc-mail-db-")), "crow.db"));
const home = () => mkdtempSync(join(tmpdir(), "crow-kc-mail-home-"));
const statusOf = async (db, id) => (await K.getEntry(db, id)).status;

/** One live mail password, written the way the mail credentials module writes it. */
async function mailRow(db, key) {
  return K.saveServiceSecret(db, key, {
    connectionUuid: ACCOUNT,
    bundleId: MAIL_BUNDLE_ID,
    envKey: "MAIL_PASSWORD",
    label: "Mail: alex@example.com",
    secret: "app-password",
  });
}

const reserved = (err) => err instanceof Error && /reserved for Crow itself/.test(err.message);

test("the mail bundle id has one source: the keychain store's MAIL_BUNDLE is the credentials module's MAIL_BUNDLE_ID", () => {
  assert.equal(MAIL_BUNDLE_ID, K.MAIL_BUNDLE);
  assert.equal(MAIL_BUNDLE_ID, "crow-mail");
  assert.ok(K.SYSTEM_BUNDLE_IDS.has(K.MAIL_BUNDLE), "the mail rows are Crow's own, not an add-on's");
  assert.equal(K.isSystemBundleId(MAIL_BUNDLE_ID), true);
});

test("markBundleRemoved on the mail bundle id removes nothing and leaves an active mail row active", async () => {
  const db = freshDb();
  const key = KEY.createKeychainKey({ crowHome: home() });
  const row = await mailRow(db, key);
  assert.equal(await K.markBundleRemoved(db, MAIL_BUNDLE_ID), 0);
  assert.equal(await statusOf(db, row.id), "active");
  assert.equal(await K.openEntrySecret(db, key, row.id), "app-password", "the password still opens");
});

test("reactivateBundleEntries never revives a mail row an earlier removal marked", async () => {
  const db = freshDb();
  const key = KEY.createKeychainKey({ crowHome: home() });
  const row = await mailRow(db, key);
  await db.execute({ sql: "UPDATE crow_keychain SET status = 'extension_removed' WHERE id = ?", args: [row.id] });
  assert.equal(await K.reactivateBundleEntries(db, MAIL_BUNDLE_ID, ["MAIL_PASSWORD"]), 0);
  assert.equal(await statusOf(db, row.id), "extension_removed");
  assert.equal(await K.reactivateBundleEntries(db, MAIL_BUNDLE_ID, []), 0, "the service leg is refused too");
  assert.equal(await statusOf(db, row.id), "extension_removed");
});

test("saveExtensionSecret and rememberExtensionSecret refuse the mail bundle id for an add-on", async () => {
  const db = freshDb();
  const key = KEY.createKeychainKey({ crowHome: home() });
  await assert.rejects(
    () => K.saveExtensionSecret(db, key, { bundleId: MAIL_BUNDLE_ID, envKey: "MAIL_PASSWORD", label: "x", secret: "attacker", origin: "typed" }),
    reserved,
  );
  await assert.rejects(
    () => K.rememberExtensionSecret(db, key, { bundleId: MAIL_BUNDLE_ID, envKey: "MAIL_PASSWORD", label: "x", secret: "attacker", origin: "typed" }),
    reserved,
  );
  assert.deepEqual(await K.listEntries(db), [], "nothing was written");
  // The owner's own import path names the owner explicitly and still works (the recovery rail).
  const { id } = await K.saveExtensionSecret(db, key, { bundleId: MAIL_BUNDLE_ID, envKey: "MAIL_PASSWORD", label: "x", secret: "imported", origin: "typed", systemOwner: true });
  assert.equal(await K.getEntry(db, id).then((e) => e.bundle_id), MAIL_BUNDLE_ID);
  assert.equal(await K.openEntrySecret(db, key, id), "imported");
});

test("the install hooks skip the mail bundle id: nothing is read back, written or marked removed", async () => {
  const db = freshDb();
  const key = KEY.createKeychainKey({ crowHome: home() });
  const row = await mailRow(db, key);
  const manifest = { id: MAIL_BUNDLE_ID, name: "Mail", env_vars: [{ name: "MAIL_PASSWORD", generate: "hex32", keychain: true }] };

  // An entry for that id does exist (the owner's own import wrote one): the add-on is still handed nothing.
  const { id: imported } = await K.saveExtensionSecret(db, key, { bundleId: MAIL_BUNDLE_ID, envKey: "MAIL_PASSWORD", label: "Mail", secret: "imported", origin: "generated", systemOwner: true });
  assert.deepEqual(await HOOKS.keychainRestoreValues(MAIL_BUNDLE_ID, manifest), { values: {}, unreadable: [], failed: false });

  const log = [];
  const install = await HOOKS.recordKeychainForInstall({
    bundleId: MAIL_BUNDLE_ID,
    manifest,
    env: { MAIL_PASSWORD: "attacker" },
    minted: { MAIL_PASSWORD: "attacker" },
    log: (m) => log.push(m),
  });
  assert.equal(install.saved, 0);
  assert.deepEqual(install.firstView, []);
  assert.ok(log.some((m) => /reserved for Crow itself/.test(m)), "the install log says why nothing was saved");
  assert.equal(await K.openEntrySecret(db, key, imported), "imported", "the existing entry is untouched");

  assert.equal(await HOOKS.markBundleKeychainRemoved(MAIL_BUNDLE_ID), undefined);
  assert.equal(await statusOf(db, row.id), "active");
  assert.equal(await statusOf(db, imported), "active");
});

test("deleteEntry refuses a mail row with KEYCHAIN_MAIL_ROW for every status, and the row survives", async () => {
  const db = freshDb();
  const key = KEY.createKeychainKey({ crowHome: home() });
  const row = await mailRow(db, key);
  for (const status of ["active", "extension_removed", "disconnected"]) {
    await db.execute({ sql: "UPDATE crow_keychain SET status = ? WHERE id = ?", args: [status, row.id] });
    await assert.rejects(
      () => K.deleteEntry(db, row.id),
      (err) => err instanceof K.KeychainMailRowError && err.code === "KEYCHAIN_MAIL_ROW",
      status,
    );
    assert.equal(await statusOf(db, row.id), status, `${status}: the row is still there`);
  }
  assert.equal(await K.openEntrySecret(db, key, row.id), "app-password");
});

test("the mail credentials reader serves nothing for a mail row that is not active", async () => {
  const db = freshDb();
  await db.execute("CREATE TABLE mail_accounts (id TEXT PRIMARY KEY, address TEXT)");
  await db.execute({ sql: "INSERT INTO mail_accounts (id, address) VALUES (?, ?)", args: [ACCOUNT, "alex@example.com"] });
  const crowHome = home();
  const key = KEY.createKeychainKey({ crowHome });
  const row = await mailRow(db, key);
  const credentials = createMailCredentials({ db, crowHome });

  assert.deepEqual(await credentials.getSecrets(ACCOUNT), { MAIL_PASSWORD: "app-password" });
  for (const status of ["extension_removed", "disconnected"]) {
    await db.execute({ sql: "UPDATE crow_keychain SET status = ? WHERE id = ?", args: [status, row.id] });
    assert.deepEqual(await credentials.getSecrets(ACCOUNT), {}, `${status}: no secret is handed out`);
  }

  // Crow Mail's own write path has no extension-owner rule, so an account is still saved and read.
  await db.execute({ sql: "UPDATE crow_keychain SET status = 'active' WHERE id = ?", args: [row.id] });
  await credentials.saveSecret(ACCOUNT, "MAIL_PASSWORD", "second-password");
  assert.deepEqual(await credentials.getSecrets(ACCOUNT), { MAIL_PASSWORD: "second-password" });
});

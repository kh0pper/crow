/**
 * Crow Mail, plan 2 Task 9: a mail password is removed with its account, never from the
 * Passwords page, and the page says so in words. Scratch DB + scratch key home; never ~/.crow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import express from "express";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";

process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-mail-kc-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const { createDbClient } = await import("../servers/db.js");
const K = await import("../servers/gateway/keychain/store.js");
const KEY = await import("../servers/gateway/keychain/key.js");
const { createMailCredentials } = await import("../servers/gateway/mail/credentials.js");
const { keychainApiRouter } = await import("../servers/gateway/keychain/api.js");
const { renderPasswordsPage, passwordsClientJS } = await import("../servers/gateway/dashboard/settings/sections/passwords.js");
const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");

const ACCOUNT = "ma-0123456789abcdef";
const MAIL_SENTENCE = "This password belongs to a Mail account. Remove the account in Mail settings.";

async function seed() {
  const dbPath = join(mkdtempSync(join(tmpdir(), "crow-mail-kc-db-")), "crow.db");
  const db = createDbClient(dbPath);
  // The two tables the keychain's mail rule and a project connection's rule read.
  await db.execute("CREATE TABLE IF NOT EXISTS mail_accounts (id TEXT PRIMARY KEY, address TEXT)");
  await db.execute("CREATE TABLE IF NOT EXISTS service_connections (uuid TEXT PRIMARY KEY, status TEXT DEFAULT 'active')");
  await db.execute({ sql: "INSERT INTO mail_accounts (id, address) VALUES (?, ?)", args: [ACCOUNT, "alex@example.com"] });
  const crowHome = mkdtempSync(join(tmpdir(), "crow-mail-kc-home-"));
  const credentials = createMailCredentials({ db, crowHome });
  const saved = await credentials.saveSecret(ACCOUNT, "MAIL_PASSWORD", "app-password");
  return { db, dbPath, crowHome, credentials, id: saved.id };
}

const keyOf = (s) => KEY.loadKeychainKey({ crowHome: s.crowHome });

test("deleteEntry on a mail row throws KeychainMailRowError and the row survives", async () => {
  const s = await seed();
  await assert.rejects(
    () => K.deleteEntry(s.db, s.id),
    (err) => err instanceof K.KeychainMailRowError && err.code === "KEYCHAIN_MAIL_ROW",
  );
  const rows = await K.listEntries(s.db, { keyId: keyOf(s)?.id || null });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bundle_id, "crow-mail");
  assert.equal(await K.openEntrySecret(s.db, keyOf(s), s.id), "app-password");
});

test("deleteEntry on an ordinary orphan service row still deletes", async () => {
  const s = await seed();
  const key = keyOf(s);
  const orphan = await K.saveServiceSecret(s.db, key, {
    connectionUuid: "u-orphan",
    bundleId: "github",
    envKey: "GITHUB_PERSONAL_ACCESS_TOKEN",
    label: "GitHub — Work",
    secret: "ghp-value",
  });
  assert.equal(await K.deleteEntry(s.db, orphan.id), true);
  assert.equal(await K.getEntry(s.db, orphan.id), null);
});

test("after removing the account through deleteSecrets the row is gone", async () => {
  const s = await seed();
  assert.deepEqual(await s.credentials.deleteSecrets(ACCOUNT), { deleted: 1 });
  assert.deepEqual(await K.listEntries(s.db), []);
  assert.equal(await K.getEntry(s.db, s.id), null);
});

test("the keychain API answers 409 mail_row for a mail row and keeps it", async () => {
  const s = await seed();
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => { req.dashboardSession = "S1"; next(); });
  app.use(keychainApiRouter({
    openDb: () => createDbClient(s.dbPath),
    crowHome: s.crowHome,
    gate: { method: async () => "password", isGranted: () => true, expiresAt: () => null },
    isOwner: async () => true,
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/dashboard/keychain/api/delete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-session": "S1" },
      body: JSON.stringify({ id: s.id }),
    });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "mail_row" });
    assert.equal((await K.listEntries(s.db)).length, 1, "the password is still there");
  } finally {
    server.close();
  }
});

test("the Passwords page renders Crow Mail for the row and the mail_row sentence exists in en and es", async () => {
  const s = await seed();
  const entries = await K.listEntries(s.db, { keyId: keyOf(s)?.id || null });
  const page = renderPasswordsPage({ entries, method: "password", vaultAvailable: false, lang: "en" });
  assert.match(page, /<td>Crow Mail<\/td>/);
  assert.ok(!page.includes("crow-mail"), "the bundle id is not shown raw");

  assert.equal(t("passwords.deleteMailRow", "en"), MAIL_SENTENCE);
  for (const lang of ["en", "es"]) {
    assert.notEqual(t("passwords.deleteMailRow", lang), "passwords.deleteMailRow", lang);
  }
  assert.notEqual(t("passwords.deleteMailRow", "es"), t("passwords.deleteMailRow", "en"), "a real Spanish sentence");
  assert.ok(passwordsClientJS("en").includes(MAIL_SENTENCE), "the page's own script carries the sentence");
  assert.ok(passwordsClientJS("es").includes(t("passwords.deleteMailRow", "es")));
});

test("a mail row neither breaks listEntries nor the page", async () => {
  const s = await seed();
  const entries = await K.listEntries(s.db, { keyId: keyOf(s)?.id || null });
  const mail = entries.find((e) => e.id === s.id);
  assert.equal(mail.kind, "service");
  assert.equal(mail.bundle_id, "crow-mail");
  assert.equal(mail.readable, true);
  assert.ok(!JSON.stringify(entries).includes("app-password"), "metadata only");

  const { document } = parseHTML(`<html><body>${renderPasswordsPage({ entries, method: "password", vaultAvailable: false, lang: "en" })}</body></html>`);
  const row = document.querySelector(`tr.pw-row[data-id="${s.id}"]`);
  assert.ok(row, "the row renders");
  assert.match(row.textContent, new RegExp(t("passwords.statusActive", "en")));
  assert.ok(row.querySelector(".pw-delete"), "Delete stays offered; the answer explains why it is refused");
});

test("a mail_row refusal shows the Mail sentence and keeps the row", async () => {
  const s = await seed();
  const entries = await K.listEntries(s.db, { keyId: keyOf(s)?.id || null });
  const html = renderPasswordsPage({ entries, method: "password", vaultAvailable: false, lang: "en" });
  const client = passwordsClientJS("en");
  const js = client.slice(client.indexOf("<script>") + 8, client.lastIndexOf("</script>"));
  const { window, document } = parseHTML(`<html><body>${html}</body></html>`);
  const calls = [];
  const ctx = vm.createContext({
    window,
    document,
    console,
    Date,
    fetch: (url, init) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      const isDelete = String(url).endsWith("/delete");
      return Promise.resolve({
        ok: !isDelete,
        status: isDelete ? 409 : 200,
        json: () => Promise.resolve(isDelete ? { error: "mail_row" } : { events: [] }),
      });
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    confirm: () => true,
  });
  vm.runInContext(js, ctx);
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  await settle();

  const row = document.querySelector(`tr.pw-row[data-id="${s.id}"]`);
  row.querySelector(".pw-delete").dispatchEvent(new window.Event("click", { bubbles: true }));
  await settle();
  const refused = document.getElementById("pw-delete-refused");
  assert.equal(refused.hidden, false);
  assert.equal(refused.textContent, MAIL_SENTENCE);
  assert.ok(document.querySelector(`tr.pw-row[data-id="${s.id}"]`), "the row stays");
  assert.deepEqual(calls.find((c) => c.url.endsWith("/delete")).body, { id: s.id });
});
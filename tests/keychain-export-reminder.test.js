/**
 * Export reminder (recovery keys, queue item 30): while a key Crow GENERATED is in no keychain
 * Export, the Nest shows an info issue (strip only, never a push). It goes away when the user
 * exports, and comes back for a key saved after that export. The last-export time is a local
 * setting: it never syncs to a paired instance. Real init-db in a scratch home.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-kcrem-home-"));
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-kcrem-data-"));
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe" });

const K = await import("../servers/gateway/keychain/store.js");
const { createKeychainKey } = await import("../servers/gateway/keychain/key.js");
const { createDbClient } = await import("../servers/db.js");
const HS = await import("../servers/gateway/dashboard/panels/nest/health-signals.js");
const { isSyncable } = await import("../servers/gateway/dashboard/settings/sync-allowlist.js");
const R = await import("../servers/gateway/keychain/reminder.js");
after(() => { for (const d of [process.env.CROW_HOME, process.env.CROW_DATA_DIR]) rmSync(d, { recursive: true, force: true }); });

const key = createKeychainKey();
const db = createDbClient();
after(() => db.close());

async function signal() {
  HS.invalidateHealthCache();
  const r = await HS.collectHealthSignals(db, { lang: "en" });
  return { issue: r.issues.find((i) => i.id === "keychainExport") || null, card: r.details.find((d) => d.id === "keychainExport") || null };
}

test("no generated keys → no reminder at all (a manual entry never counts)", async () => {
  await K.addManualSecret(db, key, { label: "my bank", secret: "hunter2-hunter2" });
  const s = await signal();
  assert.equal(s.issue, null);
  assert.equal(s.card, null);
});

test("an extension key that was never exported → an info issue that links to Settings → Passwords", async () => {
  await K.saveExtensionSecret(db, key, { bundleId: "tax", envKey: "CROW_TAX_ENCRYPTION_KEY", label: "Tax — data encryption key", secret: "k1-" + "x".repeat(40), origin: "generated" });
  const s = await signal();
  assert.ok(s.issue, "the reminder is shown");
  assert.equal(s.issue.severity, "info", "info only: shown on the Nest strip, never pushed");
  assert.match(s.issue.label, /^1 .*not in a keychain Export/i);
  assert.equal(s.issue.actionHref, "/dashboard/settings?section=passwords");
});

test("a key KEPT from an older install (origin typed) counts too", async () => {
  await K.saveExtensionSecret(db, key, { bundleId: "mastodon", envKey: "MASTODON_OTP_SECRET", label: "Mastodon — two-factor secret", secret: "kept-" + "z".repeat(40), origin: "typed" });
  assert.equal(await R.unexportedCount(db, key.id), 2);
});

test("after an export the reminder is gone; a key saved or re-saved after the export brings it back", async () => {
  await R.recordKeychainExport(db, key.id);
  assert.equal((await signal()).issue, null, "everything is in an Export");
  await K.saveExtensionSecret(db, key, { bundleId: "campaigns", envKey: "CROW_CAMPAIGNS_ENCRYPTION_KEY", label: "Campaigns — data encryption key", secret: "k2-" + "y".repeat(40), origin: "generated" });
  assert.match((await signal()).issue.label, /^1 /, "a new key is in no Export");
  await R.recordKeychainExport(db, key.id);
  // A re-mint over an existing row keeps its created_at but is a new secret: it counts again.
  await K.saveExtensionSecret(db, key, { bundleId: "tax", envKey: "CROW_TAX_ENCRYPTION_KEY", label: "Tax — data encryption key", secret: "k3-" + "w".repeat(40), origin: "generated" });
  assert.equal(await R.unexportedCount(db, key.id), 1);
});

test("entries that came in through an Import are in that file: they do not count", async () => {
  await R.recordKeychainExport(db, key.id);
  const { ids } = await K.importEntries(db, key, [{ kind: "extension", bundle_id: "pixelfed", env_key: "PIXELFED_APP_KEY", label: "Pixelfed — data encryption key", secret: "base64:" + "q".repeat(44), origin: "generated" }]);
  assert.equal(ids.length, 1);
  assert.equal(await R.unexportedCount(db, key.id), 1, "before recording the import it would count");
  await R.recordKeychainImport(db, key.id, ids);
  assert.equal(await R.unexportedCount(db, key.id), 0);
});

test("the export fingerprints are local: not in the sync allowlist", () => {
  assert.equal(isSyncable(R.LAST_EXPORT_SETTING), false);
});

test("an entry of a removed extension is in the Export too: reinstalling it does not raise the reminder", async () => {
  await K.saveExtensionSecret(db, key, { bundleId: "peertube", envKey: "PEERTUBE_SECRET", label: "PeerTube — server secret", secret: "pt-" + "p".repeat(40), origin: "generated" });
  await K.markBundleRemoved(db, "peertube");
  await R.recordKeychainExport(db, key.id);
  await K.reactivateBundleEntries(db, "peertube", ["PEERTUBE_SECRET"]);
  assert.equal(await R.unexportedCount(db, key.id), 0);
});

test("the real export + import routes record the reminder state (HTTP, injected re-auth gate)", async () => {
  const express = (await import("express")).default;
  const { keychainApiRouter } = await import("../servers/gateway/keychain/api.js");
  const gate = { method: async () => "password", isGranted: () => true, expiresAt: () => null, verify: async () => ({ ok: true }) };
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use((req, res, next) => { req.dashboardSession = "test-session"; next(); });
  app.use(keychainApiRouter({ gate, openDb: () => createDbClient() }));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  try {
    const url = (p) => `http://127.0.0.1:${server.address().port}/dashboard/keychain/api${p}`;
    await K.saveExtensionSecret(db, key, { bundleId: "romm", envKey: "ROMM_AUTH_SECRET_KEY", label: "RomM — secret", secret: "rm-" + "r".repeat(40), origin: "generated" });
    assert.ok((await R.unexportedCount(db, key.id)) > 0);
    const ex = await fetch(url("/export"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: "a long export passphrase" }) });
    assert.equal(ex.status, 200);
    const file = await ex.json();
    assert.equal(await R.unexportedCount(db, key.id), 0, "everything readable is in that Export");
    HS.invalidateHealthCache();
    assert.equal((await signal()).issue, null);
    // Import into a fresh keychain row set: what comes in is in the file, so it never counts.
    await db.execute("DELETE FROM crow_keychain WHERE bundle_id = 'romm'");
    const im = await fetch(url("/import"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file, passphrase: "a long export passphrase" }) });
    assert.equal(im.status, 200);
    assert.equal((await im.json()).imported, 1);
    assert.equal(await R.unexportedCount(db, key.id), 0);
  } finally { server.close(); }
});

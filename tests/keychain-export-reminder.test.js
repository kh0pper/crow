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

test("the export and import routes record the reminder state and drop the health cache", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../servers/gateway/keychain/api.js", import.meta.url), "utf8");
  const exportRoute = src.slice(src.indexOf("/export`"), src.indexOf("/import`"));
  assert.match(exportRoute, /recordKeychainExport\(db, key\.id\)/);
  assert.ok(exportRoute.indexOf("recordKeychainExport") > exportRoute.indexOf("sealExport"), "only after the file is sealed");
  assert.match(exportRoute, /invalidateHealthCache\(\)/);
  const importRoute = src.slice(src.indexOf("/import`"), src.indexOf("/vault-save`"));
  assert.match(importRoute, /recordKeychainImport\(db, ikey\.id, ids\)/);
});

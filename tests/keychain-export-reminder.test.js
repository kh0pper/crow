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

test("a generated key that was never exported → an info issue that links to Settings → Passwords", async () => {
  await K.saveExtensionSecret(db, key, { bundleId: "tax", envKey: "CROW_TAX_ENCRYPTION_KEY", label: "Tax — data encryption key", secret: "k1-" + "x".repeat(40), origin: "generated" });
  const s = await signal();
  assert.ok(s.issue, "the reminder is shown");
  assert.equal(s.issue.severity, "info", "info only: shown on the Nest strip, never pushed");
  assert.match(s.issue.label, /1 .*not in a keychain Export/i);
  assert.equal(s.issue.actionHref, "/dashboard/settings?section=passwords");
  assert.deepEqual(await R.unexportedGeneratedCount(db), 1);
});

test("after an export the reminder is gone; a key generated after the export brings it back", async () => {
  await R.recordKeychainExport(db, new Date(Date.now() + 1000));
  assert.equal((await signal()).issue, null, "everything generated is in an Export");
  await new Promise((r) => setTimeout(r, 1100));
  await K.saveExtensionSecret(db, key, { bundleId: "campaigns", envKey: "CROW_CAMPAIGNS_ENCRYPTION_KEY", label: "Campaigns — data encryption key", secret: "k2-" + "y".repeat(40), origin: "generated" });
  const s = await signal();
  assert.ok(s.issue, "the newer key is in no Export");
  assert.match(s.issue.label, /^1 /);
});

test("the last-export time is local: it is not in the sync allowlist", () => {
  assert.equal(isSyncable(R.LAST_EXPORT_SETTING), false);
});

test("POST /api/keychain/export records the export time (route wiring)", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../servers/gateway/keychain/api.js", import.meta.url), "utf8");
  const exportRoute = src.slice(src.indexOf("/export`"), src.indexOf("/import`"));
  assert.match(exportRoute, /recordKeychainExport\(db/);
  assert.ok(exportRoute.indexOf("recordKeychainExport") > exportRoute.indexOf("sealExport"), "only after the file is sealed");
});

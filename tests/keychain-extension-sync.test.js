/**
 * Task 1.2 — extensionSecretsSync: the one synchronous, all-or-nothing reader of an
 * add-on's listed env keys. Scratch DB + scratch CROW_HOME; rows are written through the
 * same libsql-shaped wrapper over a better-sqlite3 handle the satellite agent uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { KEYCHAIN_DDL } from "../servers/gateway/keychain/schema.js";
import { createKeychainKey, keychainKeyPath } from "../servers/gateway/keychain/key.js";
import {
  KeychainKeyMissingError, KeychainRowsMissingError, extensionSecretsSync, saveExtensionSecret,
} from "../servers/gateway/keychain/store.js";
import { SCAN_TABLE_DDL, captureOutput, scanDb } from "./helpers/sentinel-scan.mjs";

const SENTINEL = "sentinel-" + randomUUID();
const SENTINEL2 = "sentinel-" + randomUUID();

/** better-sqlite3 behind the small async libsql surface the keychain store uses. */
function keychainDb(raw) {
  return {
    async execute(q) {
      const { sql, args = [] } = typeof q === "string" ? { sql: q } : q;
      const st = raw.prepare(sql);
      if (st.reader) return { rows: st.all(...args) };
      const r = st.run(...args);
      return { rows: [], lastInsertRowid: r.lastInsertRowid, rowsAffected: r.changes };
    },
    async executeMultiple(sql) { raw.exec(sql); },
  };
}

/** A scratch crow.db (keychain + the scanned tables) and a scratch CROW_HOME with a key. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "crow-kc-sync-"));
  const dbPath = join(dir, "crow.db");
  const raw = new Database(dbPath);
  raw.pragma("journal_mode = WAL");
  raw.exec(KEYCHAIN_DDL);
  raw.exec(SCAN_TABLE_DDL);
  const home = mkdtempSync(join(tmpdir(), "crow-kc-sync-home-"));
  const key = createKeychainKey({ crowHome: home });
  return { dir, dbPath, raw, wrapper: keychainDb(raw), key, home, keyPath: keychainKeyPath(home) };
}

async function saveTwo(ctx, { bundleId = "home-assistant" } = {}) {
  await saveExtensionSecret(ctx.wrapper, ctx.key, { bundleId, envKey: "HA_TOKEN", label: "HA token", secret: SENTINEL, origin: "typed" });
  await saveExtensionSecret(ctx.wrapper, ctx.key, { bundleId, envKey: "HA_PASSWORD", label: "HA password", secret: SENTINEL2, origin: "typed" });
}

test("all present: every listed name comes back, and nothing else", async () => {
  const ctx = scratch();
  await saveTwo(ctx);
  await saveExtensionSecret(ctx.wrapper, ctx.key, { bundleId: "home-assistant", envKey: "OTHER_KEY", label: "other", secret: "unlisted", origin: "typed" });
  const out = extensionSecretsSync(ctx.raw, ctx.key, "home-assistant", ["HA_TOKEN", "HA_PASSWORD"]);
  assert.deepEqual(out, { HA_TOKEN: SENTINEL, HA_PASSWORD: SENTINEL2 });
  assert.equal(Object.keys(out).length, 2, "a name nobody asked for is never returned");
});

test("one listed name missing: the whole read fails with EVERY requested name", async () => {
  const ctx = scratch();
  await saveExtensionSecret(ctx.wrapper, ctx.key, { bundleId: "home-assistant", envKey: "HA_TOKEN", label: "HA token", secret: SENTINEL, origin: "typed" });
  assert.throws(
    () => extensionSecretsSync(ctx.raw, ctx.key, "home-assistant", ["HA_TOKEN", "HA_PASSWORD"]),
    (e) => e instanceof KeychainRowsMissingError
      && e.code === "KEYCHAIN_ROWS_MISSING"
      && JSON.stringify(e.names) === JSON.stringify(["HA_TOKEN", "HA_PASSWORD"])
      && !e.message.includes(SENTINEL),
  );
});

test("an uninstalled bundle's row (status extension_removed) is not served", async () => {
  const ctx = scratch();
  await saveTwo(ctx);
  ctx.raw.prepare("UPDATE crow_keychain SET status = 'extension_removed' WHERE env_key = 'HA_PASSWORD'").run();
  assert.throws(() => extensionSecretsSync(ctx.raw, ctx.key, "home-assistant", ["HA_TOKEN", "HA_PASSWORD"]), KeychainRowsMissingError);
  assert.deepEqual(extensionSecretsSync(ctx.raw, ctx.key, "home-assistant", ["HA_TOKEN"]), { HA_TOKEN: SENTINEL });
});

test("a row sealed under another key id (a restored crow.db) is missing, never a wrong plaintext", async () => {
  const ctx = scratch();
  await saveTwo(ctx);
  const otherKey = createKeychainKey({ crowHome: mkdtempSync(join(tmpdir(), "crow-kc-sync-other-")) });
  assert.throws(() => extensionSecretsSync(ctx.raw, otherKey, "home-assistant", ["HA_TOKEN"]), KeychainRowsMissingError);
  assert.throws(() => extensionSecretsSync(ctx.raw, otherKey, "home-assistant", ["HA_TOKEN"]), (e) => !e.message.includes(SENTINEL));
});

test("a damaged row (fails to open) fails the whole read", async () => {
  const ctx = scratch();
  await saveTwo(ctx);
  ctx.raw.prepare("UPDATE crow_keychain SET secret_sealed = ? WHERE env_key = 'HA_TOKEN'").run("enc:v1:" + Buffer.alloc(40, 7).toString("base64"));
  assert.throws(() => extensionSecretsSync(ctx.raw, ctx.key, "home-assistant", ["HA_TOKEN"]), KeychainRowsMissingError);
});

test("no key, or a key of the wrong shape: KeychainKeyMissingError", async () => {
  const ctx = scratch();
  await saveTwo(ctx);
  assert.throws(() => extensionSecretsSync(ctx.raw, null, "home-assistant", ["HA_TOKEN"]), KeychainKeyMissingError);
  assert.throws(() => extensionSecretsSync(ctx.raw, { id: "0123456789abcdef", seed: "not-a-buffer" }, "home-assistant", ["HA_TOKEN"]), KeychainKeyMissingError);
  assert.throws(() => extensionSecretsSync(ctx.raw, undefined, "home-assistant", ["HA_TOKEN"]), (e) => e.code === "KEYCHAIN_KEY_MISSING");
});

test("no table at all: every requested name is reported missing, not a driver error", () => {
  const raw = new Database(join(mkdtempSync(join(tmpdir(), "crow-kc-sync-bare-")), "crow.db"));
  const key = createKeychainKey({ crowHome: mkdtempSync(join(tmpdir(), "crow-kc-sync-bare-home-")) });
  try {
    assert.throws(() => extensionSecretsSync(raw, key, "home-assistant", ["HA_TOKEN"]), (e) => e instanceof KeychainRowsMissingError && e.names[0] === "HA_TOKEN");
  } finally { raw.close(); }
});

test("a system bundle id and an empty name list are {} — the key is not even consulted", () => {
  assert.deepEqual(extensionSecretsSync(null, null, "offsite-backup", ["OFFSITE_KEY"]), {});
  assert.deepEqual(extensionSecretsSync(null, null, "home-assistant", []), {});
  assert.deepEqual(extensionSecretsSync(null, null, "home-assistant", [5, null, ""]), {}, "nothing name-shaped was listed");
});

test("the sentinel reaches neither console output, an audit row nor a notification", async (t) => {
  const out = captureOutput(t);
  const ctx = scratch();
  await saveTwo(ctx);
  // Every path a caller can take: a good read, a missing name, a damaged row.
  extensionSecretsSync(ctx.raw, ctx.key, "home-assistant", ["HA_TOKEN"]);
  assert.throws(() => extensionSecretsSync(ctx.raw, ctx.key, "home-assistant", ["HA_TOKEN", "NOPE_TOKEN"]));
  ctx.raw.prepare("UPDATE crow_keychain SET secret_sealed = 'enc:v1:AAAA' WHERE env_key = 'HA_PASSWORD'").run();
  assert.throws(() => extensionSecretsSync(ctx.raw, ctx.key, "home-assistant", ["HA_PASSWORD"]));

  assert.equal(out.text().split(SENTINEL).length - 1, 0, "no console line carries a value");
  assert.equal(out.text().split(SENTINEL2).length - 1, 0);
  assert.deepEqual(scanDb(ctx.dbPath, SENTINEL), [], "no audit row or notification carries a value");

  // Positive control: the scan really would see it in both tables.
  ctx.raw.prepare("INSERT INTO audit_log (event_type, details) VALUES ('probe', ?)").run(SENTINEL);
  ctx.raw.prepare("INSERT INTO notifications (title) VALUES (?)").run(SENTINEL);
  const hits = scanDb(ctx.dbPath, SENTINEL).map((h) => h.table).sort();
  assert.deepEqual(hits, ["audit_log", "notifications"]);
});
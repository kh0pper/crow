/**
 * Task 1.4 — sealEntrySecrets (the seal, its read-back proof and the opt-out) and
 * withAddonLock (the per-add-on lock every sealing writer holds).
 *
 * Scratch crow.db + scratch CROW_HOME; every secret is a sentinel that must never reach the
 * console, an audit row, a notification or a Fix-it card.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { KEYCHAIN_DDL } from "../servers/gateway/keychain/schema.js";
import { createKeychainKey, keychainKeyPath } from "../servers/gateway/keychain/key.js";
import { saveExtensionSecret } from "../servers/gateway/keychain/store.js";
import { sealSecret } from "../servers/sharing/secret-box.js";
import {
  ADDON_KEYS_UNREADABLE, AddonKeysUnavailableError, readAddonSecretsSync,
} from "../servers/shared/addon-secrets.js";
import {
  ADDON_KEY_CARD_KEY, ADDON_KEY_CARD_SOURCE, AddonKeysSaveRefusedError, KEY_SAVE_REFUSED,
  isAddonLockHeld, sealEntrySecrets, withAddonLock,
} from "../servers/gateway/addon-secrets-seal.js";
import { SCAN_TABLE_DDL, captureOutput, scanDb } from "./helpers/sentinel-scan.mjs";

const SENTINEL = "sentinel-" + randomUUID();
const SENTINEL2 = "sentinel-" + randomUUID();
const SENTINEL3 = "sentinel-" + randomUUID();
const PLAIN = "plain-" + randomUUID();

const FIX_IT_DDL = `
  CREATE TABLE IF NOT EXISTS fix_it_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    source           TEXT NOT NULL,
    dedup_key        TEXT NOT NULL,
    title            TEXT NOT NULL,
    why              TEXT,
    severity         TEXT NOT NULL DEFAULT 'warn',
    remedies         TEXT NOT NULL DEFAULT '[]',
    context          TEXT,
    status           TEXT NOT NULL DEFAULT 'pending',
    count            INTEGER NOT NULL DEFAULT 1,
    suppressed_until TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_fix_it_items_dedup ON fix_it_items(source, dedup_key);
`;

const MANIFEST = {
  name: "Home Assistant",
  env_vars: [{ name: "HA_TOKEN", secret: true }, { name: "HA_URL" }],
};

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

/** A scratch crow.db (keychain + audit/notification + Fix-it tables) and a scratch home. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "crow-addon-seal-"));
  const dbPath = join(dir, "crow.db");
  const raw = new Database(dbPath);
  raw.pragma("journal_mode = WAL");
  raw.exec(KEYCHAIN_DDL);
  raw.exec(SCAN_TABLE_DDL);
  raw.exec(FIX_IT_DDL);
  const home = mkdtempSync(join(tmpdir(), "crow-addon-seal-home-"));
  return { dir, dbPath, raw, wrapper: keychainDb(raw), home, keyPath: keychainKeyPath(home) };
}

/** The caller seams that keep every test inside its scratch DB and home. */
const depsFor = (ctx) => ({
  db: ctx.wrapper,
  crowHome: () => ctx.home,
  paths: () => ({ dbPath: ctx.dbPath, keyPath: ctx.keyPath }),
});

/**
 * Set the sealing switch for one test. CROW_HOME is pointed at a scratch home so the
 * split-DB rule (0.3) can never decide the answer on a developer's shell.
 */
function sealSwitch(t, on) {
  const keys = ["CROW_ADDON_SECRETS_KEYCHAIN", "CROW_HOME", "CROW_DB_PATH", "CROW_DATA_DIR"];
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const k of keys) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  });
  process.env.CROW_ADDON_SECRETS_KEYCHAIN = on ? "1" : "0";
  process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-addon-seal-switch-"));
}

const countAudit = (ctx, eventType) =>
  ctx.raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = ?").get(eventType).n;

// ─── sealing OFF: the opt-out after sealing (0.3 row 4) ─────────────────────

test("sealing off: a listed name written plain is un-listed and stays plain (the opt-out)", async (t) => {
  sealSwitch(t, false);
  const ctx = scratch();
  const entry = {
    command: "node",
    args: ["server/index.js"],
    env: { HA_URL: "http://ha.local:8123", HA_TOKEN: PLAIN },
    keychainEnv: ["HA_TOKEN", "HA_PASSWORD"],
  };
  const before = structuredClone(entry);
  const out = await sealEntrySecrets({
    bundleId: "home-assistant",
    entry,
    manifest: MANIFEST,
    // Nothing may be opened on the opt-out path.
    deps: { db: null, openDb: () => { throw new Error("sealing off must not open the DB"); } },
  });
  assert.deepEqual(out.keychainEnv, ["HA_PASSWORD"], "the new plain value wins: the name is no longer listed");
  assert.equal(out.env.HA_TOKEN, PLAIN, "the value the owner just typed is used");
  assert.equal(out.env.HA_URL, "http://ha.local:8123");
  assert.deepEqual(entry, before, "the input entry is not mutated");
});

test("sealing off: a listed name with no plain value keeps its list, and nothing else changes", async (t) => {
  sealSwitch(t, false);
  const entry = { env: { HA_URL: "http://ha.local:8123" }, keychainEnv: ["HA_TOKEN"] };
  const out = await sealEntrySecrets({
    bundleId: "home-assistant",
    entry,
    manifest: MANIFEST,
    deps: { db: null, openDb: () => { throw new Error("sealing off must not open the DB"); } },
  });
  assert.equal(out, entry, "today's entry, byte for byte");
});

test("sealing off: the field is dropped when every listed name was written plain", async (t) => {
  sealSwitch(t, false);
  const out = await sealEntrySecrets({
    bundleId: "home-assistant",
    entry: { env: { HA_TOKEN: PLAIN }, keychainEnv: ["HA_TOKEN"] },
    manifest: MANIFEST,
    deps: { db: null, openDb: () => { throw new Error("sealing off must not open the DB"); } },
  });
  assert.equal("keychainEnv" in out, false);
  assert.equal(out.env.HA_TOKEN, PLAIN);
});

// ─── sealing ON: the seal, the list, the proof ──────────────────────────────

test("sealing on: HA_TOKEN is sealed, HA_URL stays plain, the list is the sorted union", async (t) => {
  sealSwitch(t, true);
  const ctx = scratch();
  createKeychainKey({ crowHome: ctx.home });
  const entry = {
    command: "node",
    args: ["server/index.js"],
    env: { HA_URL: "http://ha.local:8123", HA_TOKEN: SENTINEL },
    keychainEnv: ["HA_PASSWORD"],
  };
  const before = structuredClone(entry);
  const out = await sealEntrySecrets({ bundleId: "home-assistant", entry, manifest: MANIFEST, deps: depsFor(ctx) });

  assert.deepEqual(out.env, { HA_URL: "http://ha.local:8123" }, "every sealed value left the entry");
  assert.deepEqual(out.keychainEnv, ["HA_PASSWORD", "HA_TOKEN"], "listed ∪ sealed, sorted");
  assert.equal(out.command, "node");
  assert.deepEqual(entry, before, "the stored entry the caller passed is untouched");

  const rows = ctx.raw.prepare("SELECT env_key, origin, label FROM crow_keychain WHERE kind = 'extension' AND bundle_id = ?").all("home-assistant");
  assert.deepEqual(rows, [{ env_key: "HA_TOKEN", origin: "typed", label: "Home Assistant - HA_TOKEN" }]);
  assert.deepEqual(
    readAddonSecretsSync("home-assistant", ["HA_TOKEN"], { unsealer: "gateway", dbPath: ctx.dbPath, keyPath: ctx.keyPath }),
    { HA_TOKEN: SENTINEL },
    "the read-back proof's row opens through the spawn's own paths",
  );

  const audited = ctx.raw.prepare("SELECT details FROM audit_log WHERE event_type = 'keychain_save'").all();
  assert.equal(audited.length, 1);
  const details = JSON.parse(audited[0].details);
  assert.equal(typeof details.entry_id, "number");
  delete details.entry_id;
  assert.deepEqual(details, { bundle_id: "home-assistant", env_key: "HA_TOKEN", origin: "typed", sealed_from: "mcp-addons" });
});

test("sealing on: an existing row is overwritten — the value typed now wins", async (t) => {
  sealSwitch(t, true);
  const ctx = scratch();
  const key = createKeychainKey({ crowHome: ctx.home });
  await saveExtensionSecret(ctx.wrapper, key, { bundleId: "home-assistant", envKey: "HA_TOKEN", label: "old", secret: SENTINEL2, origin: "typed" });

  await sealEntrySecrets({ bundleId: "home-assistant", entry: { env: { HA_TOKEN: SENTINEL } }, manifest: MANIFEST, deps: depsFor(ctx) });

  assert.deepEqual(
    readAddonSecretsSync("home-assistant", ["HA_TOKEN"], { unsealer: "gateway", dbPath: ctx.dbPath, keyPath: ctx.keyPath }),
    { HA_TOKEN: SENTINEL },
  );
  const n = ctx.raw.prepare("SELECT COUNT(*) AS n FROM crow_keychain WHERE kind = 'extension' AND bundle_id = 'home-assistant' AND env_key = 'HA_TOKEN'").get().n;
  assert.equal(n, 1, "one row per add-on + name, never a second one");
});

test("sealing on: re-saving the SAME value keeps the row's identity — label, username, address, origin and the one-time first-view window", async (t) => {
  sealSwitch(t, true);
  const ctx = scratch();
  const key = createKeychainKey({ crowHome: ctx.home });
  // The first-admin setup's shape: the login, its account and a one-time view. The same
  // value is then pushed into the MCP entry, which seals it again.
  await saveExtensionSecret(ctx.wrapper, key, {
    bundleId: "frigate", envKey: "FRIGATE_PASSWORD", label: "Frigate - admin login",
    username: "admin", url: "http://127.0.0.1:8971", secret: SENTINEL, origin: "generated", firstView: true,
  });
  const fvu = ctx.raw.prepare("SELECT first_view_until FROM crow_keychain").get().first_view_until;
  assert.ok(fvu, "the first view was granted");

  await sealEntrySecrets({
    bundleId: "frigate",
    entry: { env: { FRIGATE_PASSWORD: SENTINEL } },
    manifest: { name: "Frigate", env_vars: [{ name: "FRIGATE_PASSWORD", secret: true }] },
    deps: depsFor(ctx),
  });

  const row = ctx.raw.prepare("SELECT label, username, url, first_view_until, origin FROM crow_keychain").get();
  assert.deepEqual({ label: row.label, username: row.username, url: row.url }, {
    label: "Frigate - admin login", username: "admin", url: "http://127.0.0.1:8971",
  });
  assert.equal(row.first_view_until, fvu, "the one-time first-view window survives a re-seal of the same value");
  assert.equal(row.origin, "generated", "the row keeps its own provenance while the value is unchanged (not 'typed')");
});

test("sealing on: a DIFFERENT value clears the window and takes the caller's metadata and origin", async (t) => {
  sealSwitch(t, true);
  const ctx = scratch();
  const key = createKeychainKey({ crowHome: ctx.home });
  await saveExtensionSecret(ctx.wrapper, key, {
    bundleId: "frigate", envKey: "FRIGATE_PASSWORD", label: "Frigate - admin login",
    username: "admin", url: "http://127.0.0.1:8971", secret: SENTINEL2, origin: "generated", firstView: true,
  });
  assert.ok(ctx.raw.prepare("SELECT first_view_until FROM crow_keychain").get().first_view_until);

  await sealEntrySecrets({
    bundleId: "frigate",
    entry: { env: { FRIGATE_PASSWORD: SENTINEL } }, // a new password
    manifest: { name: "Frigate", env_vars: [{ name: "FRIGATE_PASSWORD", secret: true }] },
    deps: depsFor(ctx),
  });

  const row = ctx.raw.prepare("SELECT label, username, url, first_view_until, origin FROM crow_keychain").get();
  assert.equal(row.first_view_until, null, "a NEW value must not become viewable inside the OLD value's window");
  assert.equal(row.label, "Frigate - FRIGATE_PASSWORD", "the seal's own label for a value it wrote itself");
  assert.equal(row.username, null);
  assert.equal(row.url, null);
  assert.equal(row.origin, "typed", "the origin describes THIS write when the value changed");
  assert.deepEqual(
    readAddonSecretsSync("frigate", ["FRIGATE_PASSWORD"], { unsealer: "gateway", dbPath: ctx.dbPath, keyPath: ctx.keyPath }),
    { FRIGATE_PASSWORD: SENTINEL },
  );
});

test("sealing on: a consumeFirstView racing the re-seal leaves the window spent (never a timestamp read earlier)", async (t) => {
  sealSwitch(t, true);
  const ctx = scratch();
  const key = createKeychainKey({ crowHome: ctx.home });
  await saveExtensionSecret(ctx.wrapper, key, {
    bundleId: "frigate", envKey: "FRIGATE_PASSWORD", label: "Frigate - admin login",
    username: "admin", secret: SENTINEL, origin: "generated", firstView: true,
  });

  // The race: the seal reads the prior row, and the window is spent before it writes. The
  // interceptor runs the spend right after the prior-row SELECT (its `LIMIT 1`) returns.
  let spent = 0;
  const racing = {
    async execute(q) {
      const out = await ctx.wrapper.execute(q);
      const sql = typeof q === "string" ? q : q.sql;
      if (/FROM crow_keychain WHERE kind = 'extension'/.test(sql) && /LIMIT 1$/.test(sql.trim())) {
        spent += ctx.raw.prepare("UPDATE crow_keychain SET first_view_until = NULL WHERE first_view_until IS NOT NULL").run().changes;
      }
      return out;
    },
    async executeMultiple(sql) { return ctx.wrapper.executeMultiple(sql); },
  };

  await sealEntrySecrets({
    bundleId: "frigate",
    entry: { env: { FRIGATE_PASSWORD: SENTINEL } }, // the SAME value: the window would be kept
    manifest: { name: "Frigate", env_vars: [{ name: "FRIGATE_PASSWORD", secret: true }] },
    deps: { ...depsFor(ctx), db: racing },
  });

  assert.equal(spent, 1, "positive control: the window was live and spent between the read and the write");
  const row = ctx.raw.prepare("SELECT first_view_until FROM crow_keychain").get();
  assert.equal(row.first_view_until, null, "the seal writes no earlier timestamp back: the value stays shown once");
});

test("sealing on: a value another writer replaced between the prior-row read and the UPDATE is not kept as unchanged (the keep is pinned)", async (t) => {
  sealSwitch(t, true);
  const ctx = scratch();
  const key = createKeychainKey({ crowHome: ctx.home });
  await saveExtensionSecret(ctx.wrapper, key, {
    bundleId: "frigate", envKey: "FRIGATE_PASSWORD", label: "Frigate - admin login",
    username: "admin", secret: SENTINEL, origin: "generated", firstView: true,
  });
  assert.ok(ctx.raw.prepare("SELECT first_view_until FROM crow_keychain").get().first_view_until);
  const otherWritersBlob = sealSecret(SENTINEL3, { seed: key.seed });

  // The race: the seal reads the prior row and decides "same value" from it; another writer
  // replaces the value before the UPDATE. The interceptor runs right after the prior-row SELECT.
  let replaced = 0;
  const racing = {
    async execute(q) {
      const out = await ctx.wrapper.execute(q);
      const sql = typeof q === "string" ? q : q.sql;
      if (/FROM crow_keychain WHERE kind = 'extension'/.test(sql) && /LIMIT 1$/.test(sql.trim())) {
        replaced += ctx.raw.prepare("UPDATE crow_keychain SET secret_sealed = ? WHERE first_view_until IS NOT NULL").run(otherWritersBlob).changes;
      }
      return out;
    },
    async executeMultiple(sql) { return ctx.wrapper.executeMultiple(sql); },
  };

  await sealEntrySecrets({
    bundleId: "frigate",
    entry: { env: { FRIGATE_PASSWORD: SENTINEL } }, // the SAME value the seal's own read saw
    manifest: { name: "Frigate", env_vars: [{ name: "FRIGATE_PASSWORD", secret: true }] },
    deps: { ...depsFor(ctx), db: racing },
  });

  assert.equal(replaced, 1, "positive control: the value was replaced after the prior-row read");
  const row = ctx.raw.prepare("SELECT first_view_until FROM crow_keychain").get();
  assert.equal(row.first_view_until, null, "the pin names the row the seal read: a replaced value is not 'unchanged' and earns no window");
});

test("sealing on: origin is the caller's, else the manifest's generate kind, else typed", async (t) => {
  sealSwitch(t, true);
  const ctx = scratch();
  createKeychainKey({ crowHome: ctx.home });
  const manifest = {
    env_vars: [
      { name: "HA_TOKEN", secret: true },
      { name: "HA_PASSWORD", secret: true, generate: "secret" },
    ],
  };
  await sealEntrySecrets({
    bundleId: "home-assistant",
    entry: { env: { HA_TOKEN: SENTINEL, HA_PASSWORD: SENTINEL2 } },
    manifest,
    origins: { HA_TOKEN: "generated" },
    deps: depsFor(ctx),
  });
  const rows = ctx.raw.prepare("SELECT env_key, origin, label FROM crow_keychain ORDER BY env_key").all();
  assert.deepEqual(rows, [
    { env_key: "HA_PASSWORD", origin: "generated", label: "home-assistant - HA_PASSWORD" },
    { env_key: "HA_TOKEN", origin: "generated", label: "home-assistant - HA_TOKEN" },
  ]);
});

test("sealing on: a store_as field is never sealed — its keychain row holds the plaintext token", async (t) => {
  sealSwitch(t, true);
  const ctx = scratch();
  createKeychainKey({ crowHome: ctx.home });
  const entry = { env: { WORKSPACE_ADMIN_PASSWORD_HASH: SENTINEL } };
  const before = structuredClone(entry);
  const out = await sealEntrySecrets({
    bundleId: "workspace",
    entry,
    manifest: { env_vars: [{ name: "WORKSPACE_ADMIN_PASSWORD_HASH", store_as: "WORKSPACE_ADMIN_PASSWORD" }] },
    deps: depsFor(ctx),
  });
  assert.equal(out, entry, "nothing changed, so the same object comes back");
  assert.equal(ctx.raw.prepare("SELECT COUNT(*) AS n FROM crow_keychain").get().n, 0, "sealing the hash would overwrite the real secret");
  assert.deepEqual(entry, before);
});

test("sealing on: nothing sealable changes nothing", async (t) => {
  sealSwitch(t, true);
  const entry = { env: { HA_URL: "http://ha.local:8123" } };
  const out = await sealEntrySecrets({
    bundleId: "home-assistant",
    entry,
    manifest: MANIFEST,
    deps: { db: null, openDb: () => { throw new Error("nothing to seal must not open the DB"); } },
  });
  assert.equal(out, entry);
});

test("sealing on: the proof reads through the spawn's paths — a mismatch throws and the input entry is unchanged", async (t) => {
  sealSwitch(t, true);
  const ctx = scratch();
  createKeychainKey({ crowHome: ctx.home });
  const otherHome = mkdtempSync(join(tmpdir(), "crow-addon-seal-other-"));
  createKeychainKey({ crowHome: otherHome });

  const entry = { env: { HA_TOKEN: SENTINEL } };
  const before = structuredClone(entry);
  const deps = { ...depsFor(ctx), paths: () => ({ dbPath: ctx.dbPath, keyPath: keychainKeyPath(otherHome) }) };
  await assert.rejects(
    sealEntrySecrets({ bundleId: "home-assistant", entry, manifest: MANIFEST, deps }),
    (e) => e instanceof AddonKeysUnavailableError && e.code === "ROWS_MISSING"
      && e.message === ADDON_KEYS_UNREADABLE && e.bundleId === "home-assistant"
      && JSON.stringify(e.names) === JSON.stringify(["HA_TOKEN"]),
  );
  assert.deepEqual(entry, before, "a failed proof never returns a stripped entry");
});

test("sealing on: a damaged key file with saved rows propagates KeychainKeyInvalidError", async (t) => {
  sealSwitch(t, true);
  const ctx = scratch();
  const key = createKeychainKey({ crowHome: ctx.home });
  await saveExtensionSecret(ctx.wrapper, key, { bundleId: "other-addon", envKey: "OTHER_TOKEN", label: "x", secret: SENTINEL2, origin: "typed" });
  writeFileSync(ctx.keyPath, "{ not a key file");

  await assert.rejects(
    sealEntrySecrets({ bundleId: "home-assistant", entry: { env: { HA_TOKEN: SENTINEL } }, manifest: MANIFEST, deps: depsFor(ctx) }),
    (e) => e.code === "KEYCHAIN_KEY_INVALID",
  );
});

// ─── the key file is gone (review round 2, item 3) ──────────────────────────

test("sealing on: key file missing while rows exist REFUSES the save and raises the one card", async (t) => {
  sealSwitch(t, true);
  const ctx = scratch();
  const key = createKeychainKey({ crowHome: ctx.home });
  await saveExtensionSecret(ctx.wrapper, key, { bundleId: "other-addon", envKey: "OTHER_TOKEN", label: "x", secret: SENTINEL2, origin: "typed" });
  rmSync(ctx.keyPath);

  const entry = { env: { HA_TOKEN: SENTINEL } };
  const before = structuredClone(entry);
  await assert.rejects(
    sealEntrySecrets({ bundleId: "home-assistant", entry, manifest: MANIFEST, deps: depsFor(ctx) }),
    (e) => e instanceof AddonKeysSaveRefusedError && e.code === "KEYCHAIN_KEY_MISSING_ROWS"
      && e.message === KEY_SAVE_REFUSED && e.bundleId === "home-assistant"
      && JSON.stringify(e.names) === JSON.stringify(["HA_TOKEN"]),
  );
  assert.equal(existsSync(ctx.keyPath), false, "a save never mints a key while rows depend on the old one");
  assert.deepEqual(entry, before);
  assert.equal(countAudit(ctx, "keychain_key_created"), 0, "no key was created");
  assert.equal(ctx.raw.prepare("SELECT COUNT(*) AS n FROM crow_keychain").get().n, 1, "the existing row is left for the owner to recover");

  const cards = ctx.raw.prepare("SELECT source, dedup_key, status FROM fix_it_items").all();
  assert.deepEqual(cards, [{ source: ADDON_KEY_CARD_SOURCE, dedup_key: ADDON_KEY_CARD_KEY, status: "pending" }]);
});

test("sealing on: key file missing with an EMPTY keychain mints a key and audits it (first save)", async (t) => {
  sealSwitch(t, true);
  const ctx = scratch(); // no key file yet, no rows
  const out = await sealEntrySecrets({
    bundleId: "home-assistant",
    entry: { env: { HA_TOKEN: SENTINEL } },
    manifest: MANIFEST,
    deps: depsFor(ctx),
  });
  assert.equal(existsSync(ctx.keyPath), true, "the first save creates the key");
  assert.deepEqual(out.env, undefined, "every value moved, so the env field is gone");
  assert.deepEqual(out.keychainEnv, ["HA_TOKEN"]);
  const created = ctx.raw.prepare("SELECT details FROM audit_log WHERE event_type = 'keychain_key_created'").all();
  assert.equal(created.length, 1);
  assert.deepEqual(JSON.parse(created[0].details), { orphaned: 0 });
  assert.deepEqual(
    readAddonSecretsSync("home-assistant", ["HA_TOKEN"], { unsealer: "gateway", dbPath: ctx.dbPath, keyPath: ctx.keyPath }),
    { HA_TOKEN: SENTINEL },
  );
});

// ─── the per-add-on lock (0.6.1, review round 2 item 1) ─────────────────────

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("lock: two calls on the same id run strictly in order", async () => {
  const events = [];
  const first = withAddonLock("same-addon", async () => {
    events.push("1:start");
    await tick();
    events.push("1:end");
  });
  const second = withAddonLock("same-addon", async () => {
    events.push("2:start");
    events.push("2:end");
  });
  await Promise.all([first, second]);
  assert.deepEqual(events, ["1:start", "1:end", "2:start", "2:end"]);
});

test("lock: two different ids overlap", async () => {
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const a = withAddonLock("addon-a", async () => {
    events.push("a:start");
    await gate;
    events.push("a:end");
  });
  await tick();
  assert.deepEqual(events, ["a:start"]);
  const b = withAddonLock("addon-b", async () => {
    events.push("b:start");
    events.push("b:end");
  });
  await b;
  assert.deepEqual(events, ["a:start", "b:start", "b:end"], "b never waited for a");
  release();
  await a;
  assert.deepEqual(events, ["a:start", "b:start", "b:end", "a:end"]);
});

test("lock: a throw releases it", async () => {
  await assert.rejects(withAddonLock("boom-addon", async () => { throw new Error("nope"); }), /nope/);
  assert.equal(isAddonLockHeld("boom-addon"), false);
  assert.equal(await withAddonLock("boom-addon", async () => "after"), "after", "the next caller is not stuck behind a thrower");
});

test("lock: re-entrant — the install path holds it and the first-admin seam completes (round 2)", async () => {
  const events = [];
  const out = await withAddonLock("home-assistant", async () => {
    events.push("install:start");
    // The first-admin seam asks for the SAME id: inline, no deadlock, no throw.
    const written = await withAddonLock("home-assistant", async () => {
      assert.equal(isAddonLockHeld("home-assistant"), true, "the nested call runs inside the holder");
      events.push("applyMcpEnv");
      return "written";
    });
    events.push("install:end");
    return written;
  });
  assert.equal(out, "written");
  assert.deepEqual(events, ["install:start", "applyMcpEnv", "install:end"]);
});

test("lock: re-entrancy is per id — a nested different id still queues behind that id's holder", async () => {
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const other = withAddonLock("addon-b", async () => {
    events.push("b:start");
    await gate;
    events.push("b:end");
  });
  await tick();
  const outer = withAddonLock("addon-a", async () => {
    events.push("a:start");
    await withAddonLock("addon-b", async () => { events.push("a->b"); });
    events.push("a:end");
  });
  await tick();
  assert.deepEqual(events, ["b:start", "a:start"], "a holds its own id while b is held elsewhere");
  release();
  await Promise.all([other, outer]);
  assert.deepEqual(events, ["b:start", "a:start", "b:end", "a->b", "a:end"]);
});

test("lock: isAddonLockHeld is true only inside the holder's async context", async () => {
  assert.equal(isAddonLockHeld("held-addon"), false, "false outside any lock");
  const seen = [];
  await withAddonLock("held-addon", async () => {
    seen.push(isAddonLockHeld("held-addon"));
    await tick();
    seen.push(isAddonLockHeld("held-addon"));
    seen.push(isAddonLockHeld("some-other-addon"));
  });
  assert.deepEqual(seen, [true, true, false]);
  assert.equal(isAddonLockHeld("held-addon"), false, "false again once fn returned");
});

test("lock: a missing id or fn is a caller bug, not a silent global lock", async () => {
  await assert.rejects(withAddonLock("", async () => {}), TypeError);
  await assert.rejects(withAddonLock(undefined, async () => {}), TypeError);
  await assert.rejects(withAddonLock("addon", null), TypeError);
});

// ─── the sentinel scan ──────────────────────────────────────────────────────

test("sealing writes the sentinel nowhere: not console, not the audit logs, not the bell", async (t) => {
  const out = captureOutput(t);
  sealSwitch(t, true);
  const ctx = scratch();
  createKeychainKey({ crowHome: ctx.home });

  // A good save.
  await sealEntrySecrets({
    bundleId: "home-assistant",
    entry: { env: { HA_URL: "http://ha.local:8123", HA_TOKEN: SENTINEL } },
    manifest: MANIFEST,
    deps: depsFor(ctx),
  });
  // A failed proof (a different key).
  const otherHome = mkdtempSync(join(tmpdir(), "crow-addon-seal-other-"));
  createKeychainKey({ crowHome: otherHome });
  await assert.rejects(sealEntrySecrets({
    bundleId: "home-assistant",
    entry: { env: { HA_PASSWORD: SENTINEL2 } },
    manifest: { env_vars: [{ name: "HA_PASSWORD", secret: true }] },
    deps: { ...depsFor(ctx), paths: () => ({ dbPath: ctx.dbPath, keyPath: keychainKeyPath(otherHome) }) },
  }));
  // A refusal (the key file is gone while rows exist).
  rmSync(ctx.keyPath);
  await assert.rejects(sealEntrySecrets({
    bundleId: "home-assistant",
    entry: { env: { HA_TOKEN: SENTINEL3 } },
    manifest: MANIFEST,
    deps: depsFor(ctx),
  }));

  const text = out.text();
  for (const sentinel of [SENTINEL, SENTINEL2, SENTINEL3]) {
    assert.equal(text.split(sentinel).length - 1, 0, "no console line carries a value");
    assert.deepEqual(scanDb(ctx.dbPath, sentinel), [], "no audit row, notification or card carries a value");
  }

  // Positive control: the scan really would see a value in both scanned tables.
  ctx.raw.prepare("INSERT INTO audit_log (event_type, details) VALUES ('probe', ?)").run(SENTINEL);
  ctx.raw.prepare("INSERT INTO notifications (title) VALUES (?)").run(SENTINEL);
  assert.deepEqual(scanDb(ctx.dbPath, SENTINEL).map((h) => h.table).sort(), ["audit_log", "notifications"]);
});
/**
 * Task 1.3 — readAddonSecretsSync / hydrateAddonEntry / sharedAddonEnv / entryConfiguredNames:
 * the spawn-time unseal. Scratch DB + scratch CROW_HOME; every secret is a sentinel that must
 * never leave the returned env.
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
import { saveExtensionSecret } from "../servers/gateway/keychain/store.js";
import {
  ADDON_KEYS_UNREADABLE, AddonKeysUnavailableError, entryConfiguredNames, hydrateAddonEntry,
  readAddonSecretsSync, sharedAddonEnv,
} from "../servers/shared/addon-secrets.js";
import { SCAN_TABLE_DDL, captureOutput, scanDb } from "./helpers/sentinel-scan.mjs";

const SENTINEL = "sentinel-" + randomUUID();
const SENTINEL2 = "sentinel-" + randomUUID();
const PLAIN = "plain-" + randomUUID();

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

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "crow-addon-hydrate-"));
  const dbPath = join(dir, "crow.db");
  const raw = new Database(dbPath);
  raw.exec(KEYCHAIN_DDL);
  raw.exec(SCAN_TABLE_DDL);
  const home = mkdtempSync(join(tmpdir(), "crow-addon-hydrate-home-"));
  const key = createKeychainKey({ crowHome: home });
  return { dir, dbPath, raw, wrapper: keychainDb(raw), key, keyPath: keychainKeyPath(home) };
}

async function seed(ctx) {
  await saveExtensionSecret(ctx.wrapper, ctx.key, { bundleId: "home-assistant", envKey: "HA_TOKEN", label: "HA token", secret: SENTINEL, origin: "typed" });
  await saveExtensionSecret(ctx.wrapper, ctx.key, { bundleId: "home-assistant", envKey: "HA_PASSWORD", label: "HA password", secret: SENTINEL2, origin: "typed" });
  await saveExtensionSecret(ctx.wrapper, ctx.key, { bundleId: "funkwhale", envKey: "FUNKWHALE_ACCESS_TOKEN", label: "Funkwhale token", secret: SENTINEL, origin: "typed" });
}

const ENTRY = {
  command: "node",
  args: ["server/index.js"],
  env: { HA_URL: "http://ha.local:8123" },
  keychainEnv: ["HA_PASSWORD", "HA_TOKEN"],
};

test("readAddonSecretsSync: the listed names come back from the real file, nothing else", async () => {
  const ctx = scratch();
  await seed(ctx);
  const out = readAddonSecretsSync("home-assistant", ["HA_TOKEN", "HA_PASSWORD"], {
    unsealer: "gateway", dbPath: ctx.dbPath, keyPath: ctx.keyPath,
  });
  assert.deepEqual(out, { HA_TOKEN: SENTINEL, HA_PASSWORD: SENTINEL2 });
});

test("readAddonSecretsSync: a caller that did not opt in is refused BEFORE any file is opened", () => {
  for (const unsealer of [undefined, null, "wall", "child"]) {
    assert.throws(
      () => readAddonSecretsSync("home-assistant", ["HA_TOKEN"], { unsealer, dbPath: "/nonexistent/never-opened.db", keyPath: "/nonexistent/never-opened.key" }),
      (e) => e instanceof AddonKeysUnavailableError && e.code === "CHILD_CONTEXT" && e.message === ADDON_KEYS_UNREADABLE && e.bundleId === "home-assistant" && e.names[0] === "HA_TOKEN",
      String(unsealer),
    );
  }
});

test("readAddonSecretsSync: an add-on child's env (CROW_ADDON_HOST) is refused even with a registered role", () => {
  assert.throws(
    () => readAddonSecretsSync("home-assistant", ["HA_TOKEN"], { unsealer: "gateway", dbPath: "/nonexistent/db", env: { CROW_ADDON_HOST: "gateway" } }),
    (e) => e.code === "CHILD_CONTEXT",
  );
});

test("readAddonSecretsSync: error codes — KEY_MISSING, ROWS_MISSING, DB_UNREADABLE", async () => {
  const ctx = scratch();
  await seed(ctx);
  // no key file at all
  assert.throws(
    () => readAddonSecretsSync("home-assistant", ["HA_TOKEN"], { unsealer: "gateway", dbPath: ctx.dbPath, keyPath: join(ctx.dir, "no-such-key.key") }),
    (e) => e.code === "KEY_MISSING" && e.message === ADDON_KEYS_UNREADABLE,
  );
  // a listed name with no row
  assert.throws(
    () => readAddonSecretsSync("home-assistant", ["HA_TOKEN", "HA_NOPE"], { unsealer: "gateway", dbPath: ctx.dbPath, keyPath: ctx.keyPath }),
    (e) => e.code === "ROWS_MISSING" && JSON.stringify(e.names) === JSON.stringify(["HA_TOKEN", "HA_NOPE"]),
  );
  // no DB at all
  assert.throws(
    () => readAddonSecretsSync("home-assistant", ["HA_TOKEN"], { unsealer: "gateway", dbPath: join(ctx.dir, "missing.db"), keyPath: ctx.keyPath }),
    (e) => e.code === "DB_UNREADABLE" && e.message === ADDON_KEYS_UNREADABLE,
  );
  // no paths passed at all
  assert.throws(() => readAddonSecretsSync("home-assistant", ["HA_TOKEN"], { unsealer: "gateway" }), (e) => e.code === "DB_UNREADABLE");
});

test("readAddonSecretsSync: a null key with no keyPath is KEY_MISSING, never the default ~/.crow key", async () => {
  // A key DOES exist at the default path for this test (a scratch home this test points the
  // default at). The old fallback would have loaded it and failed on the rows (ROWS_MISSING)
  // or, worse, unsealed against a home the caller never named.
  const home = mkdtempSync(join(tmpdir(), "crow-addon-hydrate-defhome-"));
  const before = process.env.CROW_HOME;
  process.env.CROW_HOME = home;
  try {
    const ctx = scratch();
    await seed(ctx);
    const defKey = createKeychainKey({ crowHome: home });
    assert.notEqual(defKey.id, ctx.key.id, "the two keys are different, so a fallback would be visible");
    assert.throws(
      () => readAddonSecretsSync("home-assistant", ["HA_TOKEN"], { unsealer: "gateway", dbPath: ctx.dbPath }),
      (e) => e.code === "KEY_MISSING" && e.message === ADDON_KEYS_UNREADABLE && e.bundleId === "home-assistant",
    );
    // An empty keyPath is the same answer: not a path, so no default is guessed either.
    assert.throws(
      () => readAddonSecretsSync("home-assistant", ["HA_TOKEN"], { unsealer: "gateway", dbPath: ctx.dbPath, keyPath: "" }),
      (e) => e.code === "KEY_MISSING" && e.message === ADDON_KEYS_UNREADABLE,
    );
  } finally {
    if (before === undefined) delete process.env.CROW_HOME;
    else process.env.CROW_HOME = before;
  }
});

test("readAddonSecretsSync: a caller-supplied handle is used and left open", async () => {
  const ctx = scratch();
  await seed(ctx);
  const out = readAddonSecretsSync("home-assistant", ["HA_TOKEN"], { unsealer: "gateway", rawDb: ctx.raw, key: ctx.key });
  assert.deepEqual(out, { HA_TOKEN: SENTINEL });
  assert.equal(ctx.raw.open, true, "the caller owns the handle");
});

// ─── hydrateAddonEntry ──────────────────────────────────────────────────────

test("hydrate: an entry with no keychainEnv is returned as the SAME object and nothing is opened", () => {
  const entry = { command: "node", env: { HA_URL: "http://ha.local:8123" } };
  const out = hydrateAddonEntry("home-assistant", entry, { unsealer: "gateway", dbPath: "/nonexistent/never-opened.db", keyPath: "/nonexistent/never-opened.key" });
  assert.equal(out, entry, "today's spawn, byte for byte");
});

test("hydrate: a listed secret joins the env, the entry's own field is gone, and the input is untouched", async () => {
  const ctx = scratch();
  await seed(ctx);
  const entry = { ...ENTRY, env: { ...ENTRY.env }, keychainEnv: [...ENTRY.keychainEnv] };
  const out = hydrateAddonEntry("home-assistant", entry, { unsealer: "gateway", dbPath: ctx.dbPath, keyPath: ctx.keyPath });
  assert.deepEqual(out.env, { HA_URL: "http://ha.local:8123", HA_TOKEN: SENTINEL, HA_PASSWORD: SENTINEL2 });
  assert.equal("keychainEnv" in out, false, "the hydrated object carries no list to write back");
  assert.equal(out.command, "node");
  assert.deepEqual(out.args, ["server/index.js"]);
  assert.deepEqual(entry.keychainEnv, ["HA_PASSWORD", "HA_TOKEN"], "the stored entry is not mutated");
  assert.equal(entry.env.HA_TOKEN, undefined);
});

test("hydrate: a plain value for a listed name is replaced by the keychain's, with one name-only log line", async (t) => {
  const out = captureOutput(t);
  const ctx = scratch();
  await seed(ctx);
  const entry = { ...ENTRY, env: { HA_URL: "http://ha.local:8123", HA_TOKEN: PLAIN } };
  const hydrated = hydrateAddonEntry("home-assistant", entry, { unsealer: "gateway", dbPath: ctx.dbPath, keyPath: ctx.keyPath });
  assert.equal(hydrated.env.HA_TOKEN, SENTINEL, "the keychain wins");
  const text = out.text();
  assert.match(text, /HA_TOKEN/, "the log names the key");
  assert.equal(text.split(PLAIN).length - 1, 0, "and never the plain value it ignored");
  assert.equal(text.split(SENTINEL).length - 1, 0);
});

test("hydrate: a hidden failure is the fixed sentence with the codes a caller switches on", async () => {
  const ctx = scratch();
  await seed(ctx);
  assert.throws(
    () => hydrateAddonEntry("home-assistant", { ...ENTRY, keychainEnv: ["HA_TOKEN", "HA_NOPE"] }, { unsealer: "gateway", dbPath: ctx.dbPath, keyPath: ctx.keyPath }),
    (e) => e.code === "ROWS_MISSING" && e.bundleId === "home-assistant" && JSON.stringify(e.names) === JSON.stringify(["HA_TOKEN", "HA_NOPE"]),
  );
});

test("hydrate: loader names in the entry's env never reach the child, listed or not", async () => {
  const ctx = scratch();
  await seed(ctx);
  const entry = { ...ENTRY, env: { HA_URL: "http://ha.local:8123", NODE_OPTIONS: "--require /tmp/x.js" } };
  const out = hydrateAddonEntry("home-assistant", entry, { unsealer: "gateway", dbPath: ctx.dbPath, keyPath: ctx.keyPath });
  assert.equal("NODE_OPTIONS" in out.env, false);
});

// ─── sharedAddonEnv (R6) ────────────────────────────────────────────────────

test("sharedAddonEnv: sunvox-studio reads Funkwhale's URL (plain) and access token (keychain)", async () => {
  const ctx = scratch();
  await seed(ctx);
  const funkwhale = { command: "node", env: { FUNKWHALE_URL: "http://funkwhale.local" }, keychainEnv: ["FUNKWHALE_ACCESS_TOKEN"] };
  const readEntry = (id) => (id === "funkwhale" ? funkwhale : null);
  const out = sharedAddonEnv("sunvox-studio", readEntry, { unsealer: "gateway", dbPath: ctx.dbPath, keyPath: ctx.keyPath });
  assert.deepEqual(out, { FUNKWHALE_URL: "http://funkwhale.local", FUNKWHALE_ACCESS_TOKEN: SENTINEL });
});

test("sharedAddonEnv: an add-on with no share entry, a missing source, or an empty switch yields {}", async () => {
  const ctx = scratch();
  await seed(ctx);
  const opts = { unsealer: "gateway", dbPath: ctx.dbPath, keyPath: ctx.keyPath };
  const funkwhale = { command: "node", env: { FUNKWHALE_URL: "http://funkwhale.local" }, keychainEnv: ["FUNKWHALE_ACCESS_TOKEN"] };
  assert.deepEqual(sharedAddonEnv("home-assistant", () => funkwhale, opts), {}, "no share table entry");
  assert.deepEqual(sharedAddonEnv("sunvox-studio", () => null, opts), {}, "the source is not installed");
  assert.deepEqual(sharedAddonEnv("sunvox-studio", () => funkwhale, { ...opts, shares: {} }), {}, "the switch at its other setting");
});

test("sharedAddonEnv: the source's own unreadable keys propagate — never half a share", async () => {
  const ctx = scratch();
  await seed(ctx);
  const funkwhale = { command: "node", env: { FUNKWHALE_URL: "http://funkwhale.local" }, keychainEnv: ["FUNKWHALE_ACCESS_TOKEN"] };
  assert.throws(
    () => sharedAddonEnv("sunvox-studio", () => funkwhale, { unsealer: "gateway", dbPath: ctx.dbPath, keyPath: join(ctx.dir, "gone.key") }),
    (e) => e.code === "KEY_MISSING",
  );
});

// ─── entryConfiguredNames ───────────────────────────────────────────────────

test("entryConfiguredNames: non-empty env keys plus listed names, unsealing nothing", () => {
  assert.deepEqual(entryConfiguredNames({ env: { HA_URL: "http://ha.local:8123", EMPTY: "" }, keychainEnv: ["HA_TOKEN"] }), ["HA_TOKEN", "HA_URL"]);
  assert.deepEqual(entryConfiguredNames({ env: {}, keychainEnv: [] }), []);
  assert.deepEqual(entryConfiguredNames({}), []);
  assert.deepEqual(entryConfiguredNames({ env: { EMPTY: "" }, keychainEnv: ["LD_PRELOAD"] }), []);
});

// ─── the one DB file the seal, the proof and the spawn all read (0.7) ───────

test("gatewayKeychainPaths: the spawn's DB is resolveDbPath()'s DB, and the key is this home's", async () => {
  const [{ gatewayKeychainPaths }, { resolveDbPath }, { resolveCrowHome, resolveInstanceDataDir }] = await Promise.all([
    import("../servers/gateway/addon-keys-paths.js"),
    import("../servers/db.js"),
    import("../servers/shared/crow-home.js"),
  ]);
  const paths = gatewayKeychainPaths();
  assert.equal(paths.dbPath, resolveDbPath(), "the same resolver createDbClient opens");
  assert.equal(paths.dbPath, join(resolveInstanceDataDir(), "crow.db"));
  assert.equal(paths.keyPath, join(resolveCrowHome(), "secrets", "keychain.key"));
});

// ─── the sentinel scan ──────────────────────────────────────────────────────

test("unsealing writes the sentinel nowhere: not to console, not to the audit logs, not to the bell", async (t) => {
  const out = captureOutput(t);
  const ctx = scratch();
  await seed(ctx);
  const opts = { unsealer: "gateway", dbPath: ctx.dbPath, keyPath: ctx.keyPath };
  const hydrated = hydrateAddonEntry("home-assistant", { ...ENTRY, env: { ...ENTRY.env, HA_TOKEN: PLAIN } }, opts);
  assert.equal(hydrated.env.HA_TOKEN, SENTINEL);
  readAddonSecretsSync("home-assistant", ["HA_TOKEN"], opts);
  assert.throws(() => readAddonSecretsSync("home-assistant", ["HA_TOKEN", "GONE_TOKEN"], opts));
  assert.throws(() => readAddonSecretsSync("home-assistant", ["HA_TOKEN"], { ...opts, keyPath: join(ctx.dir, "gone.key") }));

  const text = out.text();
  assert.equal(text.split(SENTINEL).length - 1, 0, "no console line carries a value");
  assert.equal(text.split(SENTINEL2).length - 1, 0);
  assert.deepEqual(scanDb(ctx.dbPath, SENTINEL), [], "no audit row or notification carries a value");
  assert.deepEqual(scanDb(ctx.dbPath, SENTINEL2), []);
});
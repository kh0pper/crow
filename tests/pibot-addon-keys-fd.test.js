/**
 * Task 2.2 — `writeBotMcp` hydrates a sealed add-on ONLY for an fd turn.
 *
 * A sealed add-on (an mcp-addons.json entry whose `keychainEnv` lists env NAMES) can only be
 * spawned with its real values by a process that unseals them, and only into a config that
 * travels on pi's inherited fd (mcp-delivery.mjs). `opts.addonKeys` says which turn this is:
 *
 *   "omit"    (default) — the block stays key-less; the caller only validates it;
 *   "hydrate" — `readAddonSecretsSync` / `sharedAddonEnv` unseal the values into the returned
 *               config, FD DELIVERY ONLY (a file write cannot carry them, so the writer throws);
 *   a file-mode turn leaves a sealed add-on out of the config with one warning.
 *
 * The tests below run the same value through both paths: the plaintext must appear in the
 * fd-mode block's env and NEVER in `.mcp.json`, in a warning, on the console or in an audit
 * row. Every secret here is a random sentinel.
 *
 * The writer resolves its DB and its keychain key from process.env at CALL time
 * (botsDbPath(), anchoredPath), so each fixture points the whole process at its own scratch
 * instance — the same instance the gateway sealed the rows in.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { KEYCHAIN_DDL } from "../servers/gateway/keychain/schema.js";
import { createKeychainKey } from "../servers/gateway/keychain/key.js";
import { saveExtensionSecret } from "../servers/gateway/keychain/store.js";
import { SCAN_TABLE_DDL, captureOutput, scanDb } from "./helpers/sentinel-scan.mjs";

// A scratch $HOME before mcp_writer.mjs is imported: its `$HOME/.crow` fallback is read at
// module load. Each test then re-points the instance env at its own fixture.
const USER_HOME = mkdtempSync(join(tmpdir(), "pibot-addon-fd-user-"));
process.env.HOME = USER_HOME;
process.env.CROW_HOME = join(USER_HOME, ".crow");
process.env.CROW_DATA_DIR = join(USER_HOME, ".crow", "data");
process.env.CROW_DB_PATH = join(USER_HOME, ".crow", "data", "crow.db");
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });

const { writeBotMcp, WARN_ADDON_KEYS_FILE_MODE, WARN_ADDON_KEYS_UNREADABLE } =
  await import("../scripts/pi-bots/mcp_writer.mjs");
const { botsDbPath } = await import("../scripts/pi-bots/instance-paths.mjs");
const { resolveDbPath } = await import("../servers/db.js");

/** The three env keys the writer's instance resolution reads. */
const INSTANCE_KEYS = ["CROW_HOME", "CROW_DATA_DIR", "CROW_DB_PATH"];

const TMP_ROOTS = [];
after(() => { for (const d of TMP_ROOTS) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

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

/**
 * A scratch instance: an mcp-addons.json, a bundle dir per add-on, a crow.db carrying the
 * keychain (and the tables a sentinel scan scans) and a freshly minted keychain key.
 * It also becomes THIS process's instance, because the writer resolves the DB and the key
 * from process.env at call time.
 */
function instance(addons, { bundleDirs } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pibot-addon-fd-"));
  TMP_ROOTS.push(dir);
  const home = join(dir, ".crow");
  const data = join(home, "data");
  const dbPath = join(data, "crow.db");
  mkdirSync(data, { recursive: true });
  for (const id of bundleDirs ?? Object.keys(addons)) mkdirSync(join(home, "bundles", id), { recursive: true });
  writeFileSync(join(home, "mcp-addons.json"), JSON.stringify(addons));
  const raw = new Database(dbPath);
  raw.exec(KEYCHAIN_DDL);
  raw.exec(SCAN_TABLE_DDL);
  raw.close();
  const key = createKeychainKey({ crowHome: home });
  const sessionDir = join(dir, "session");
  mkdirSync(sessionDir, { recursive: true });
  process.env.CROW_HOME = home;
  process.env.CROW_DATA_DIR = data;
  process.env.CROW_DB_PATH = dbPath;
  return {
    dir, home, data, dbPath, key, sessionDir,
    binding: { CROW_HOME: home, CROW_DATA_DIR: data, CROW_DB_PATH: dbPath, CROW_TASKS_DB_PATH: join(data, "tasks.db") },
    canonicalPath: join(dir, "canonical.json"),
  };
}

/** Snapshot/restore the instance env (a test that changes it must not leak into the next). */
function withInstanceEnv(over, fn) {
  const before = Object.fromEntries(INSTANCE_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of INSTANCE_KEYS) {
      if (over[k] === undefined) delete process.env[k];
      else process.env[k] = over[k];
    }
    return fn();
  } finally {
    for (const k of INSTANCE_KEYS) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
}

/** Seal rows for the fixtures: `[[bundleId, envKey, value], …]` through the real writer. */
async function seed(ctx, rows) {
  const raw = new Database(ctx.dbPath);
  try {
    for (const [bundleId, envKey, secret] of rows) {
      await saveExtensionSecret(keychainDb(raw), ctx.key, { bundleId, envKey, label: envKey, secret, origin: "typed" });
    }
  } finally {
    raw.close();
  }
}

const CANONICAL = { mcpServers: { "third-party": { command: "node", args: ["server.js"] } } };
const def = (ids) => ({ tools: { crow_mcp: ids.map((id) => id + "/tool") } });

/** One writeBotMcp call against the fixture instance. */
function run(ctx, ids, opts = {}) {
  writeFileSync(ctx.canonicalPath, JSON.stringify(CANONICAL));
  return writeBotMcp(def(ids), {
    sessionDir: ctx.sessionDir,
    canonicalPath: ctx.canonicalPath,
    crowHome: ctx.home,
    binding: ctx.binding,
    ...opts,
  });
}

const mcpFile = (ctx) => join(ctx.sessionDir, ".mcp.json");
const SENTINEL = "sentinel-" + randomUUID();
const PLAIN = "plain-stale-" + randomUUID();

const sealedEntry = (extra = {}) => ({
  command: "node",
  args: ["server/index.js"],
  env: { HA_URL: "http://ha.example:8123", HA_TOKEN: PLAIN },
  keychainEnv: ["HA_TOKEN"],
  ...extra,
});

// ─── fd + hydrate ───────────────────────────────────────────────────────────

test("fd + hydrate: the keychain value lands in that block's env, and no .mcp.json is written", async () => {
  const ctx = instance({ "home-assistant": sealedEntry() });
  await seed(ctx, [["home-assistant", "HA_TOKEN", SENTINEL]]);

  const res = run(ctx, ["home-assistant"], { write: false, addonKeys: "hydrate" });

  const block = res.json.mcpServers["home-assistant"];
  assert.equal(block.env.HA_TOKEN, SENTINEL, "the unsealed value is in the block the bridge pipes to pi");
  assert.equal(block.env.HA_URL, "http://ha.example:8123", "the plain settings survive");
  assert.equal(block.env.CROW_HOME, ctx.home, "the block still names this instance");
  assert.equal(block.env.HA_TOKEN === PLAIN, false, "never the stale plaintext from the entry");
  assert.equal(res.path, null, "fd delivery: no path");
  assert.equal(existsSync(mcpFile(ctx)), false, "nothing was written for pi to inherit");
  assert.deepEqual(readdirSync(ctx.sessionDir), [], "not even a temp file");
  assert.deepEqual(res.needsKeys, {}, "a hydrated block owes nothing");
  assert.ok(res.servers.includes("home-assistant"), "and it stays an ACTIVE server");
  assert.equal(JSON.stringify(res.warnings).includes(SENTINEL), false);
});

test("fd + hydrate: a service add-on's derived env is rendered from the KEYCHAIN value, not the entry's stale copy", async () => {
  // render's reviewed manifest derives AUTH_HEADER: "Bearer ${RENDER_API_KEY}". The entry keeps
  // a stale plaintext for the same name (a pre-seal value) — the keychain's is what the child gets.
  const ctx = instance({
    render: { command: "node", args: ["server/index.js"], env: { RENDER_API_KEY: PLAIN }, keychainEnv: ["RENDER_API_KEY"] },
  });
  await seed(ctx, [["render", "RENDER_API_KEY", SENTINEL]]);

  const res = run(ctx, ["render"], { write: false, addonKeys: "hydrate" });
  const env = res.json.mcpServers.render.env;
  assert.equal(env.RENDER_API_KEY, SENTINEL);
  assert.equal(env.AUTH_HEADER, "Bearer " + SENTINEL, "the derived header is built from what the child will really get");
  assert.equal(JSON.stringify(res.json).includes(PLAIN), false, "the stale plaintext is nowhere in the config");

  // Control: without hydration the same add-on carries no derived header at all — it cannot be
  // rendered from a value this writer never read.
  const omitted = run(ctx, ["render"], { write: false });
  assert.equal(omitted.json.mcpServers.render.env.RENDER_API_KEY, undefined);
  assert.equal(omitted.json.mcpServers.render.env.AUTH_HEADER, undefined);
});

test("fd + hydrate: an add-on that READS another one gets the SOURCE add-on's keychain value", async () => {
  const SHARED = "sentinel-" + randomUUID();
  const ctx = instance({
    "sunvox-studio": {
      command: "node", args: ["server/index.js"], env: { SUNVOX_TOKEN: PLAIN }, keychainEnv: ["SUNVOX_TOKEN"],
    },
    funkwhale: {
      command: "node", args: ["server/index.js"],
      env: { FUNKWHALE_URL: "http://funk.example:5000" }, keychainEnv: ["FUNKWHALE_ACCESS_TOKEN"],
    },
  });
  await seed(ctx, [["sunvox-studio", "SUNVOX_TOKEN", SENTINEL], ["funkwhale", "FUNKWHALE_ACCESS_TOKEN", SHARED]]);

  // The bot selects sunvox-studio only: funkwhale's values arrive as a SHARE, read through
  // funkwhale's own entry and its own keychain rows.
  const res = run(ctx, ["sunvox-studio"], { write: false, addonKeys: "hydrate" });
  const env = res.json.mcpServers["sunvox-studio"].env;
  assert.equal(env.SUNVOX_TOKEN, SENTINEL);
  assert.equal(env.FUNKWHALE_ACCESS_TOKEN, SHARED, "the shared token came from the source add-on's rows");
  assert.equal(env.FUNKWHALE_URL, "http://funk.example:5000");

  // The switch at its other setting: no share table, so no shared value is produced.
  const noShares = run(ctx, ["sunvox-studio"], { write: false, addonKeys: "hydrate", addonSecretShares: {} });
  const env2 = noShares.json.mcpServers["sunvox-studio"].env;
  assert.equal(env2.SUNVOX_TOKEN, SENTINEL, "its own value is still its own");
  assert.equal(env2.FUNKWHALE_ACCESS_TOKEN, undefined, "and no other add-on's value is invented");
});

test("fd + hydrate: a name with no active row leaves that add-on out, and every other server intact", async () => {
  const ctx = instance({
    sealed: sealedEntry(),
    plain: { command: "node", args: ["server/index.js"], env: { HA_URL: "http://plain.example:8123" } },
  });
  // No row for sealed/HA_TOKEN: the read is all-or-throw, so the add-on must not spawn half-set.
  const res = run(ctx, ["sealed", "plain", "third-party"], { write: false, addonKeys: "hydrate" });

  assert.deepEqual(res.json.mcpServers.sealed, { disabled: true }, "left out of this turn");
  assert.equal(res.servers.includes("sealed"), false, "not an active server");
  assert.ok(res.disabled.includes("sealed"));
  assert.ok(res.warnings.includes(WARN_ADDON_KEYS_UNREADABLE("sealed")), "one fixed sentence, naming the add-on and no value");
  assert.equal(res.json.mcpServers.plain.env.HA_URL, "http://plain.example:8123", "an unsealed add-on is untouched");
  assert.ok(res.json.mcpServers["third-party"], "an unrelated canonical server is untouched");
  assert.deepEqual(res.needsKeys, {}, "a disabled block is not owed to a later caller either");
  assert.equal(JSON.stringify(res).includes(SENTINEL), false);
  assert.equal(existsSync(mcpFile(ctx)), false);
});

test("fd + hydrate with no key file at all: KEY_MISSING is the same fixed sentence, never a value", async () => {
  const ctx = instance({ sealed: sealedEntry() });
  await seed(ctx, [["sealed", "HA_TOKEN", SENTINEL]]);
  const keyFile = join(ctx.home, "secrets", "keychain.key");
  const moved = keyFile + ".aside";
  renameSync(keyFile, moved);
  let res;
  try {
    res = run(ctx, ["sealed"], { write: false, addonKeys: "hydrate" });
  } finally {
    renameSync(moved, keyFile);
  }
  assert.deepEqual(res.json.mcpServers.sealed, { disabled: true });
  assert.ok(res.warnings.includes(WARN_ADDON_KEYS_UNREADABLE("sealed")));
  assert.equal(JSON.stringify(res).includes(SENTINEL), false);
  // The rows are still there and a restored key reads them: the refusal was the key, not the add-on.
  const again = run(ctx, ["sealed"], { write: false, addonKeys: "hydrate" });
  assert.equal(again.json.mcpServers.sealed.env.HA_TOKEN, SENTINEL);
});

// ─── fd + omit (the default) ────────────────────────────────────────────────

test("fd + omit (the default): the block is key-less and the owed names are reported back", async () => {
  const ctx = instance({ "home-assistant": sealedEntry() });
  await seed(ctx, [["home-assistant", "HA_TOKEN", SENTINEL]]);

  const res = run(ctx, ["home-assistant"], { write: false });
  const block = res.json.mcpServers["home-assistant"];
  assert.ok(block, "the block is still offered — the caller only validates it");
  assert.equal(block.env?.HA_TOKEN, undefined, "no value in an omitting turn");
  assert.equal(block.env.HA_URL, "http://ha.example:8123");
  assert.equal(JSON.stringify(res.json).includes(SENTINEL), false);
  assert.deepEqual(res.needsKeys, { "home-assistant": ["HA_TOKEN"] }, "the names it still owes, values never");
  assert.equal(existsSync(mcpFile(ctx)), false, "and nothing written");

  // An explicit "omit" is the same turn.
  const explicit = run(ctx, ["home-assistant"], { write: false, addonKeys: "omit" });
  assert.deepEqual(explicit.json.mcpServers["home-assistant"].env, block.env);
  assert.deepEqual(explicit.needsKeys, { "home-assistant": ["HA_TOKEN"] });
});

// ─── file mode ──────────────────────────────────────────────────────────────

test("file mode: a sealed add-on is disabled with one warning, and the file carries no value", async () => {
  const ctx = instance({ "home-assistant": sealedEntry() });
  await seed(ctx, [["home-assistant", "HA_TOKEN", SENTINEL]]);

  const res = run(ctx, ["home-assistant"]);
  assert.deepEqual(res.json.mcpServers["home-assistant"], { disabled: true });
  assert.ok(res.warnings.includes(WARN_ADDON_KEYS_FILE_MODE("home-assistant")));
  assert.match(res.warnings.join("\n"), /file-mode MCP delivery cannot carry them/);
  assert.equal(res.servers.includes("home-assistant"), false);
  assert.deepEqual(res.needsKeys, {}, "a file-mode turn leaves nothing for a later caller either");

  const written = readFileSync(mcpFile(ctx), "utf8");
  assert.equal(written.includes(SENTINEL), false, "the written .mcp.json carries no secret");
  assert.equal(written.includes(PLAIN), false, "nor the entry's stale plaintext");
  assert.equal(written.includes("keychainEnv"), false, "and no keychainEnv field");
  assert.match(written, /"home-assistant": \{\s*"disabled": true\s*\}/);
});

test("hydrate is fd delivery only: a file write is refused before anything is written", async () => {
  const ctx = instance({ "home-assistant": sealedEntry() });
  await seed(ctx, [["home-assistant", "HA_TOKEN", SENTINEL]]);
  writeFileSync(ctx.canonicalPath, JSON.stringify(CANONICAL));

  for (const write of [true, undefined]) {
    assert.throws(
      () => writeBotMcp(def(["home-assistant"]), {
        sessionDir: ctx.sessionDir, canonicalPath: ctx.canonicalPath, crowHome: ctx.home, binding: ctx.binding,
        addonKeys: "hydrate", ...(write === undefined ? {} : { write }),
      }),
      /fd delivery only/,
    );
  }
  assert.equal(existsSync(mcpFile(ctx)), false, "the assertion fires before the write decision");

  // An unknown setting is a programming error, not a silent default.
  assert.throws(
    () => writeBotMcp(def(["home-assistant"]), {
      sessionDir: ctx.sessionDir, canonicalPath: ctx.canonicalPath, crowHome: ctx.home, binding: ctx.binding,
      write: false, addonKeys: "hydrated",
    }),
    /must be "hydrate" or "omit"/,
  );
});

// ─── one DB file ────────────────────────────────────────────────────────────

test("botsDbPath() is resolveDbPath() under every layout, so the writer reads the rows the gateway sealed", () => {
  const alt = mkdtempSync(join(tmpdir(), "pibot-addon-fd-alt-"));
  TMP_ROOTS.push(alt);
  const defaultData = join(USER_HOME, ".crow", "data");
  mkdirSync(defaultData, { recursive: true });

  // (a) no instance env at all: the host-default ~/.crow/data
  withInstanceEnv({}, () => {
    assert.equal(botsDbPath(), resolveDbPath(), "defaults");
    assert.equal(botsDbPath(), join(defaultData, "crow.db"));
  });
  // (b) CROW_DB_PATH only
  const dbPath = join(alt, "elsewhere", "crow.db");
  withInstanceEnv({ CROW_DB_PATH: dbPath }, () => {
    assert.equal(botsDbPath(), resolveDbPath(), "CROW_DB_PATH");
    assert.equal(botsDbPath(), dbPath);
  });
  // (c) CROW_DATA_DIR only
  const dataDir = join(alt, "data-two");
  withInstanceEnv({ CROW_DATA_DIR: dataDir }, () => {
    assert.equal(botsDbPath(), resolveDbPath(), "CROW_DATA_DIR");
    assert.equal(botsDbPath(), join(dataDir, "crow.db"));
  });
  // (d) a non-default CROW_HOME, with and without its own data dir
  const home = join(alt, "crow-alt");
  withInstanceEnv({ CROW_HOME: home }, () => {
    assert.equal(botsDbPath(), resolveDbPath(), "non-default CROW_HOME");
    assert.equal(botsDbPath(), join(home, "data", "crow.db"));
  });
  withInstanceEnv({ CROW_HOME: home, CROW_DATA_DIR: join(home, "data") }, () => {
    assert.equal(botsDbPath(), resolveDbPath(), "non-default CROW_HOME + data dir");
  });
});

// ─── the sentinel scan ──────────────────────────────────────────────────────

test("unsealing for an fd turn leaves the value on no console line, in no audit row and in no file", async (t) => {
  const out = captureOutput(t);
  const ctx = instance({ "home-assistant": sealedEntry(), rowless: sealedEntry() });
  await seed(ctx, [["home-assistant", "HA_TOKEN", SENTINEL]]);

  const hydrated = run(ctx, ["home-assistant"], { write: false, addonKeys: "hydrate" });
  assert.equal(hydrated.json.mcpServers["home-assistant"].env.HA_TOKEN, SENTINEL, "positive control: it IS in the fd config");
  // A second add-on with no row: the refusal path must be just as quiet.
  const refused = run(ctx, ["home-assistant", "rowless"], { write: false, addonKeys: "hydrate" });
  assert.deepEqual(refused.json.mcpServers.rowless, { disabled: true });
  assert.deepEqual(readdirSync(ctx.sessionDir), [], "two fd turns wrote nothing at all");

  // The file-mode turn of the same fixture: one file, and no value in it.
  run(ctx, ["home-assistant"]);
  assert.deepEqual(readdirSync(ctx.sessionDir), [".mcp.json"]);
  assert.match(readFileSync(mcpFile(ctx), "utf8"), /"disabled": true/);

  const text = out.text();
  assert.equal(text.split(SENTINEL).length - 1, 0, "no console line carries a value");
  assert.equal(text.split(PLAIN).length - 1, 0, "nor the stale plaintext");
  assert.deepEqual(scanDb(ctx.dbPath, SENTINEL), [], "no audit row or bell carries a value");
});
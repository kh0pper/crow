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
 *
 * Task 2.3 adds the CROW-SIDE half: the turn builders (`writeWorldMcp` in bot-world.mjs and
 * `job_runner.mjs`) must ASK for hydration on an fd turn and never on a file turn; the Perch
 * path (perch-interactive.js → its `opts.bridge` seam → buildBotWorld) is walked here too, in a
 * process that registered the `gateway` unsealer role; and `regenerateBotMcp` (the Bot Builder
 * panel + the federation patch) must keep asking for NOTHING and never hand back the `json`.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
// mcp_writer pins CANONICAL_MCP_PATH = $HOME/.pi/agent/mcp.json at module load; a world build
// reads it at call time. Point it at an empty canonical so the bot-world legs (below) mint a
// config deterministically instead of depending on whether this host has pi installed.
mkdirSync(join(USER_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(join(USER_HOME, ".pi", "agent", "mcp.json"), JSON.stringify({ mcpServers: {} }));
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

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
 *
 * `fullSchema` builds the real schema with scripts/init-db.js instead (the world builder and the
 * Perch engine read bot_sessions, project_spaces, …).
 */
function instance(addons, { bundleDirs, fullSchema = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pibot-addon-fd-"));
  TMP_ROOTS.push(dir);
  const home = join(dir, ".crow");
  const data = join(home, "data");
  const dbPath = join(data, "crow.db");
  mkdirSync(data, { recursive: true });
  for (const id of bundleDirs ?? Object.keys(addons)) mkdirSync(join(home, "bundles", id), { recursive: true });
  writeFileSync(join(home, "mcp-addons.json"), JSON.stringify(addons));
  if (fullSchema) {
    execFileSync(process.execPath, ["scripts/init-db.js"], {
      cwd: REPO, stdio: "pipe",
      env: { ...process.env, CROW_HOME: home, CROW_DATA_DIR: data, CROW_DB_PATH: dbPath },
    });
  } else {
    const raw = new Database(dbPath);
    raw.exec(KEYCHAIN_DDL);
    raw.exec(SCAN_TABLE_DDL);
    raw.close();
  }
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

// ═══════════════════════════════════════════════════════════════════════════
// Task 2.3 — the turn builders ask for hydration, and only an fd turn does
// ═══════════════════════════════════════════════════════════════════════════

const WORLD_BOT = "addonfd-world";
const FILE_BOT = "addonfd-file";
const PERCH_BOT = "addonfd-perch";
const REGEN_BOT = "addonfd-regen";
const BOTS = [WORLD_BOT, FILE_BOT, PERCH_BOT, REGEN_BOT];

/** A bot that selects the sealed add-on (a `<server>/<tool>` crow_mcp id), on no project. */
const worldDef = (sessionDir) => ({
  system_prompt: "You are a test bot.",
  models: { default: "stub/m1" },
  tools: { pi_builtin: ["read"], crow_mcp: ["home-assistant/tool"] },
  permission_policy: { bash: "deny", write_paths: [], multi_agent: false },
  session_dir: sessionDir,
});

/**
 * The "gateway" instance: the real schema (bot defs, bot_sessions, project_spaces, audit…) plus
 * the sealed add-on. One instance for the Task 2.3 legs, because the bot engine pins its DB path
 * at MODULE LOAD — the first `await gateway()` must therefore run before the first import of
 * bridge.mjs / bot-world.mjs, and every later leg reuses it.
 */
let G = null;
async function gateway() {
  if (G) return G;
  const ctx = instance({ "home-assistant": sealedEntry() }, { fullSchema: true });
  const raw = new Database(ctx.dbPath);
  try {
    const ins = raw.prepare("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,?)");
    for (const botId of BOTS) {
      ins.run(botId, botId, JSON.stringify(worldDef(join(ctx.home, "pi-bots", botId))), 1);
    }
  } finally { raw.close(); }
  await seed(ctx, [["home-assistant", "HA_TOKEN", SENTINEL]]);
  G = ctx;
  // The whole process is this instance from here on (the engine resolves its DB per call).
  for (const k of INSTANCE_KEYS) process.env[k] = ctx.binding[k];
  return G;
}

/** The engine modules, imported ONCE against the gateway instance (their DB paths are load-time). */
let MODS = null;
async function worldModules() {
  if (MODS) return MODS;
  await gateway();
  const world = await import("../scripts/pi-bots/bot-world.mjs");
  const sig = await import("../scripts/pi-bots/actor-sig.mjs");
  const addonSecrets = await import("../servers/shared/addon-secrets.js");
  const perch = await import("../servers/gateway/perch-interactive.js");
  // This process IS the gateway (perch-interactive runs inside it), so it registers the role the
  // gateway's own entry point registers. The writer names its own "bot-engine" role per call; the
  // registration is what makes this leg the process the real Perch path runs in.
  addonSecrets.registerAddonUnsealer("gateway");
  // An in-memory actor key, exactly as the gateway mints at boot: without it a world build with a
  // live session row would ask the loopback signing relay over the network for signatures.
  sig._resetActorKeyForTest();
  sig.initGatewayActorKey();
  MODS = { world, sig, perch };
  return MODS;
}

/** Set the delivery mode for one leg, then restore it. */
async function withDelivery(mode, fn) {
  const before = process.env.PIBOT_MCP_CONFIG_DELIVERY;
  process.env.PIBOT_MCP_CONFIG_DELIVERY = mode;
  try { return await fn(); } finally {
    if (before === undefined) delete process.env.PIBOT_MCP_CONFIG_DELIVERY;
    else process.env.PIBOT_MCP_CONFIG_DELIVERY = before;
  }
}

/** Every regular file under `dir`, recursively. */
function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Paths (under `dir`) whose bytes contain `needle`; [] when the value reached no file. */
function filesHolding(dir, needle) {
  return filesUnder(dir).filter((p) => { try { return readFileSync(p, "utf8").includes(needle); } catch { return false; } });
}

test("bot-world: an fd turn carries the key in world.mcpConfig and writes no .mcp.json", { timeout: 120_000 }, async (t) => {
  await gateway();
  const out = captureOutput(t);
  const { world: W } = await worldModules();

  const world = await withDelivery("fd", () => W.buildBotWorld({ botId: WORLD_BOT, threadId: "fd-" + randomUUID(), gatewayType: "gmail" }));

  assert.equal(world.mcpDelivery, "fd", "the builder chose fd, so the config stays in memory");
  assert.equal(world.mcpConfigPath, null, "fd mode names no config path");
  const block = world.mcpConfig.mcpServers["home-assistant"];
  assert.ok(block, "the sealed add-on is in this turn's config");
  assert.equal(block.env.HA_TOKEN, SENTINEL, "the keychain value the writer unsealed for this fd turn");
  assert.equal(block.env.HA_URL, "http://ha.example:8123", "its plain settings survive");
  assert.equal(existsSync(join(world.sessionDir, ".mcp.json")), false, "nothing was written for pi to inherit");
  assert.deepEqual(filesHolding(world.sessionDir, SENTINEL), [], "no file under the world root holds the value");
  assert.equal(out.text().split(SENTINEL).length - 1, 0, "no console line carries it");
  assert.deepEqual(scanDb(G.dbPath, SENTINEL), [], "no audit row or bell carries it");
});

test("bot-world: a file turn writes .mcp.json WITHOUT the add-on and with no value anywhere", { timeout: 120_000 }, async (t) => {
  await gateway();
  const out = captureOutput(t);
  const { world: W } = await worldModules();

  const world = await withDelivery("file", () => W.buildBotWorld({ botId: FILE_BOT, threadId: "file-" + randomUUID(), gatewayType: "gmail" }));

  assert.equal(world.mcpDelivery, "file");
  assert.equal(world.mcpConfigPath, join(world.sessionDir, ".mcp.json"));
  assert.deepEqual(world.mcpConfig.mcpServers["home-assistant"], { disabled: true },
    "a file cannot carry its keys, so the add-on is left out of this turn");

  const written = readFileSync(world.mcpConfigPath, "utf8");
  assert.match(written, /"home-assistant": \{\s*"disabled": true\s*\}/);
  assert.equal(written.includes(SENTINEL), false, "the file carries no keychain value");
  assert.equal(written.includes(PLAIN), false, "nor the entry's stale plaintext");
  assert.equal(written.includes("keychainEnv"), false, "and no keychainEnv field");
  assert.deepEqual(filesHolding(world.sessionDir, SENTINEL), [], "no file under the world root holds the value");
  assert.equal(out.text().split(SENTINEL).length - 1, 0, "no console line carries it");
  assert.deepEqual(scanDb(G.dbPath, SENTINEL), [], "no audit row or bell carries it");
});

test("regenerateBotMcp: no `json` comes back, no add-on value in the result or on disk", { timeout: 120_000 }, async () => {
  const g = await gateway();
  const { regenerateBotMcp } = await import("../servers/gateway/dashboard/panels/bot-mcp-regen.js");
  const sessionDir = join(g.home, "pi-bots", REGEN_BOT);
  /** One regeneration against a connection of its own (closed before the next one). */
  const regen = () => {
    const raw = new Database(g.dbPath);
    return Promise.resolve()
      .then(() => regenerateBotMcp(keychainDb(raw), REGEN_BOT))
      .finally(() => { try { raw.close(); } catch { /* closed */ } });
  };

  // fd delivery (the panel has no turn to pipe to): it validates, drops any stale file — and
  // asking for NO keys, it reports the names it owes and keeps the block key-less.
  const fd = await withDelivery("fd", regen);
  assert.equal("json" in fd, false, "the built config is never handed back (it can carry headers/tokens)");
  assert.equal(fd.path, null, "fd delivery writes nothing");
  assert.ok(fd.servers.includes("home-assistant"), "the selection is still validated");
  assert.deepEqual(fd.needsKeys, { "home-assistant": ["HA_TOKEN"] }, "names it owes, never a value");
  assert.equal(JSON.stringify(fd).includes(SENTINEL), false, "the result carries no value");
  assert.equal(existsSync(join(sessionDir, ".mcp.json")), false);

  // file delivery: the sealed add-on is left out of the written config, with one warning.
  const file = await withDelivery("file", regen);
  assert.equal("json" in file, false);
  assert.equal(file.path, join(sessionDir, ".mcp.json"));
  assert.equal(file.servers.includes("home-assistant"), false);
  assert.deepEqual(file.needsKeys, {});
  assert.equal(JSON.stringify(file).includes(SENTINEL), false, "the result carries no value");
  assert.deepEqual(filesHolding(sessionDir, SENTINEL), [], "nor does any file it wrote");
});

test("Perch path: the gateway's own seam builds an fd world whose config carries the key", { timeout: 120_000 }, async (t) => {
  const g = await gateway();
  const out = captureOutput(t);
  const { perch, world: W } = await worldModules();

  const state = { worlds: [], instances: [] };
  class FakePi {
    constructor(o) {
      this.opts = o;
      this.onEvent = o.onEvent;
      this.toolsCsv = "";
      this.turns = [];
      this._exitCode = null;
      this.proc = { pid: 910000 + state.instances.length };
      this.piSessionId = "pisession-perch-addonfd";
      let done;
      this.exited = new Promise((r) => { done = r; });
      this._done = done;
      state.instances.push(this);
    }
    async getState() { return { data: { sessionId: this.piSessionId } }; }
    async getSessionStats() { return { data: { tokens: { input: 1, output: 1, cacheRead: 0 } } }; }
    promptTurn(message) {
      const rec = { message };
      rec.promise = new Promise((resolve, reject) => { rec.resolve = resolve; rec.reject = reject; });
      this.turns.push(rec);
      return rec.promise;
    }
    trimLog() {} async abortSince() { return null; } send() {}
    async close() { this.exit(0); }
    exit(code = 0) { if (this._exitCode != null) return; this._exitCode = code; this._done(code); }
    _exitError() { return new Error("pi exited"); }
  }
  const RESOLVED = { provider: "stub", model: "m1", key: "stub/m1", escalated: false, source: "default" };
  // The engine's own seam shape (perch-interactive.js opts.bridge): the REAL world builder, and a
  // prepareSpawn that stops before model resolution (this test is about the config, not a spawn).
  const seam = {
    PiRpc: FakePi,
    LIFECYCLE_DEFAULTS: { maxPi: 8 },
    countLivePi: () => 0,
    async buildBotWorld(args) { state.worlds.push(args); return W.buildBotWorld(args); },
    async prepareSpawn(world) {
      return {
        sysFile: join(g.dir, "sys.md"), selfAuthoringDir: null, resolved: RESOLVED,
        piRpcOpts: {
          def: world.def, sessionDir: world.sessionDir, resolved: RESOLVED, piProvider: "stub",
          remoteEnabled: false, narrowedTools: null,
          mcpDelivery: world.mcpDelivery, mcpConfig: world.mcpConfig,
        },
      };
    },
    async warmModel() {}, async meterTurn() { return { recorded: true }; }, appendAudit() {},
  };
  const engine = perch.createInteractiveEngine({
    crowHome: g.home,
    // The suite runner sets CROW_DISABLE_PERCH=1 for a scratch gateway (it must never start the
    // runtime); this engine is constructed by hand, so it asks for an enabled one.
    env: { ...process.env, CROW_HOME: g.home, CROW_DISABLE_PERCH: "0" },
    bridge: seam, log: () => {},
    now: () => 1_700_000_000_000, setTimer: () => 0, clearTimer: () => {},
  });

  const r = await withDelivery("fd", () => engine.spawn({ botId: PERCH_BOT }));
  const pi = state.instances[0];
  assert.ok(pi, "the engine started a child");
  assert.equal(state.worlds.length, 1, "through the in-gateway seam, once");
  assert.equal(state.worlds[0].gatewayType, "perch", "the Perch path is what was built");
  assert.equal(pi.opts.mcpDelivery, "fd");
  const block = pi.opts.mcpConfig.mcpServers["home-assistant"];
  assert.ok(block, "the sealed add-on rides this Perch turn's config");
  assert.equal(block.env.HA_TOKEN, SENTINEL, "hydrated by the gateway process itself");
  const sessionDir = join(g.home, "pi-bots", PERCH_BOT);
  assert.equal(existsSync(join(sessionDir, ".mcp.json")), false, "the Perch path wrote no config file either");
  assert.deepEqual(filesHolding(sessionDir, SENTINEL), [], "no file in the bot world holds the value");
  assert.equal(out.text().split(SENTINEL).length - 1, 0, "no console line carries it");
  assert.deepEqual(scanDb(g.dbPath, SENTINEL), [], "the session rows, audit rows and bells carry no value");
  await engine.stop(r.sessionId);
});
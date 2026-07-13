import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";

// The Finding-2 regression (grackle): the gateway's .env sets CROW_DB_PATH to the
// repo data dir (where crow.db physically lives), but identity.json exists ONLY in
// the instance data dir (~/.crow/data — whose crow.db is a symlink to the repo file).
// The instance seed must anchor on resolveDataDir() (instanceSeedDir()) — the SAME
// anchor servers/sharing/identity.js uses for the instance's own identity — never
// on dirname(CROW_DB_PATH). Working files (bots db, tasks db) stay DB-anchored.

// instance-paths.mjs reads process.env at call time: set/clear per case.
const ENV_KEYS = ["CROW_DB_PATH", "CROW_TASKS_DB_PATH", "CROW_DATA_DIR"];
const savedEnv = {};
const tmpDirs = [];

before(() => { for (const k of ENV_KEYS) savedEnv[k] = process.env[k]; });
after(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function clearEnv() { for (const k of ENV_KEYS) delete process.env[k]; }
function tmp(prefix) { const d = mkdtempSync(join(tmpdir(), prefix)); tmpDirs.push(d); return d; }

const SEED_HEX = "ab".repeat(32); // 64 hex chars → 32-byte seed

/** Grackle layout: identity.json in the instance dir; crow.db (NO identity.json) in the repo data dir. */
function grackleLayout() {
  const instanceDir = tmp("iseed-instance-");
  const repoDataDir = tmp("iseed-repodata-");
  writeFileSync(join(instanceDir, "identity.json"), JSON.stringify({ seed: SEED_HEX }));
  writeFileSync(join(repoDataDir, "crow.db"), "");
  clearEnv();
  process.env.CROW_DATA_DIR = instanceDir;
  process.env.CROW_DB_PATH = join(repoDataDir, "crow.db");
  return { instanceDir, repoDataDir };
}

const { botsDbPath, tasksDbPath, instanceSeedDir } = await import("../scripts/pi-bots/instance-paths.mjs");
const { loadInstanceSeed, deriveBotIdentity } = await import("../servers/sharing/identity.js");

test("grackle layout: seed resolves from the instance dir, NOT dirname(CROW_DB_PATH)", () => {
  const { instanceDir } = grackleLayout();
  assert.equal(instanceSeedDir(), resolve(instanceDir), "seed anchor = resolveDataDir()");
  const seed = loadInstanceSeed(instanceSeedDir());
  assert.ok(Buffer.isBuffer(seed), "seed is a Buffer");
  assert.equal(seed.length, 32, "32-byte seed");
  // Prove this test exercises the real hazard: the OLD anchor (dirname of the DB
  // path — no identity.json there) throws, which is exactly what killed grackle's
  // bot advertisement.
  assert.throws(() => loadInstanceSeed(dirname(botsDbPath())),
    /ENOENT|no such file/i, "old dirname(botsDbPath()) anchor throws under this layout");
});

test("MPA layout: CROW_DATA_DIR and CROW_DB_PATH colocated still resolves and loads", () => {
  const dir = tmp("iseed-mpa-");
  writeFileSync(join(dir, "identity.json"), JSON.stringify({ seed: SEED_HEX }));
  writeFileSync(join(dir, "crow.db"), "");
  clearEnv();
  process.env.CROW_DATA_DIR = dir;
  process.env.CROW_DB_PATH = join(dir, "crow.db");
  assert.equal(instanceSeedDir(), resolve(dir));
  const seed = loadInstanceSeed(instanceSeedDir());
  assert.equal(seed.length, 32);
});

test("working files stay DB-anchored: botsDbPath()/tasksDbPath() still honor CROW_DB_PATH", () => {
  const { repoDataDir } = grackleLayout();
  assert.equal(botsDbPath(), join(repoDataDir, "crow.db"), "bots db = CROW_DB_PATH verbatim");
  assert.equal(tasksDbPath(), join(repoDataDir, "tasks.db"), "tasks db sits beside the crow.db in use");
});

test("consumer: botIdentityFor derives a bot identity under the grackle layout (used to throw)", async () => {
  const { instanceDir } = grackleLayout();
  // botIdentityFor is DB-free (loadInstanceSeed + deriveBotIdentity) and reads the
  // seed at call time, so it can be exercised directly under the split env.
  const admin = await import("../servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js");
  const ident = admin.botIdentityFor("bot1");
  assert.ok(ident && typeof ident.crowId === "string" && ident.crowId.startsWith("crow:"), "returns a bot identity");
  // Parity: identical to deriving straight from the instance dir's seed.
  const expected = deriveBotIdentity(loadInstanceSeed(resolve(instanceDir)), "bot1");
  assert.equal(ident.crowId, expected.crowId, "crow_id anchored on the instance seed dir");
  assert.equal(ident.secp256k1Pubkey, expected.secp256k1Pubkey, "secp key parity");
});

test("consumer: ensureLocalBotContact resolves the seed under the grackle layout (used to return null)", async () => {
  grackleLayout();
  // Stub libsql client: ensureLocalBotContact swallows identity failures and
  // returns null, so a successful INSERT proves the REAL defaultIdentityFor
  // (no _identityFor injection) resolved the seed from the instance dir.
  const { ensureLocalBotContact } = await import("../servers/gateway/dashboard/shared/ensure-local-bot-contact.js");
  const inserts = [];
  const stubDb = {
    async execute(arg) {
      const sql = typeof arg === "string" ? arg : arg.sql;
      if (sql.includes("pi_bot_defs")) return { rows: [{ display_name: "Grackle Bot" }] };
      if (sql.startsWith("SELECT id FROM contacts")) return { rows: [] };
      if (sql.startsWith("INSERT INTO contacts")) { inserts.push(arg.args); return { lastInsertRowid: 42 }; }
      return { rows: [] };
    },
  };
  const id = await ensureLocalBotContact(stubDb, "bot1");
  assert.equal(id, 42, "contact created (null would mean the seed lookup threw)");
  assert.equal(inserts.length, 1);
  assert.ok(String(inserts[0][0]).startsWith("crow:"), "derived crow_id inserted");
});

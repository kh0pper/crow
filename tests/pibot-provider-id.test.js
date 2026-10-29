/**
 * Roles phase 2, Task 17: the bot engine maps a provider row id to the pi
 * provider it spawns with. A consented cloud row reaches pi as the gateway's
 * door entry `crow-c-<rowId>` (servers/shared/pi-models-sync.js); a
 * hand-written or allow-listed entry under the row's own id wins; a pi
 * built-in id with no entry of either kind fails closed (never the
 * operator's own pi login); a co-hosted instance never maps onto the
 * primary's door entries. Scratch $HOME, scratch models.json, fake values.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const k of Object.keys(process.env)) if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];
const USER_HOME = mkdtempSync(join(tmpdir(), "crow-provider-id-user-"));
process.env.HOME = USER_HOME;
const HOME = join(USER_HOME, ".crow");
mkdirSync(join(HOME, "data"), { recursive: true });
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = join(HOME, "data");
delete process.env.CROW_DB_PATH;
// Never the operator's real file: the engine reads this scratch one.
const MODELS = join(USER_HOME, "scratch-models.json");
process.env.PI_MODELS_JSON = MODELS;

const { piProviderIdFor } = await import("../scripts/pi-bots/pi_provider_id.mjs");
const { buildManagedEntries } = await import("../servers/shared/pi-models-sync.js");
const { checkPiModel } = await import("../scripts/pi-bots/pi-model-catalog.mjs");

const DEFAULT = { crowHome: join("/home/u", ".crow"), homeDir: "/home/u" };
const COHOSTED = { crowHome: join("/home/u", ".crow-r4"), homeDir: "/home/u" };

test("piProviderIdFor: the door entry for a consented row (default home)", () => {
  assert.equal(piProviderIdFor("cloud-a", { providers: { "crow-c-cloud-a": {} } }, DEFAULT), "crow-c-cloud-a");
});

test("piProviderIdFor: a hand-written (or allow-listed) entry under the row's own id wins", () => {
  assert.equal(piProviderIdFor("cloud-a", { providers: { "cloud-a": {}, "crow-c-cloud-a": {} } }, DEFAULT), "cloud-a");
  assert.equal(piProviderIdFor("cloud-a", { providers: { "cloud-a": {} } }, DEFAULT), "cloud-a");
});

test("piProviderIdFor: neither entry gives the row id (pi's own error or M2 handles it)", () => {
  assert.equal(piProviderIdFor("cloud-a", { providers: {} }, DEFAULT), "cloud-a");
  assert.equal(piProviderIdFor("cloud-a", null, DEFAULT), "cloud-a", "an unreadable file is an empty one");
});

test("piProviderIdFor: a pi built-in id with no entry of either kind fails closed", () => {
  assert.equal(piProviderIdFor("openai", { providers: {} }, DEFAULT), null);
  assert.equal(piProviderIdFor("anthropic", null, DEFAULT), null);
  assert.equal(piProviderIdFor("openai", { providers: { "crow-c-openai": {} } }, DEFAULT), "crow-c-openai");
  assert.equal(piProviderIdFor("openai", { providers: { openai: {} } }, DEFAULT), "openai", "a hand-written override of the built-in is the operator's choice");
});

test("piProviderIdFor: co-hosted bots keep their own ids (N1)", () => {
  assert.equal(piProviderIdFor("cloud-a", { providers: { "crow-c-cloud-a": {} } }, COHOSTED), "cloud-a");
  assert.equal(piProviderIdFor("openai", { providers: { "crow-c-openai": {} } }, COHOSTED), null);
});

test("piProviderIdFor: a non-string id gives null", () => {
  assert.equal(piProviderIdFor(undefined, { providers: {} }, DEFAULT), null);
  assert.equal(piProviderIdFor("", { providers: {} }, DEFAULT), null);
});

test("checkPiModel (M2) checks the MAPPED key and fails closed on a bare built-in", async () => {
  const json = { providers: { "crow-c-cloud-a": { models: [{ id: "c1" }] } } };
  const deps = { piModelsJsonFn: () => json, crowHome: HOME, homeDir: USER_HOME, piKeysFn: undefined,
    resolvePiCliFn: () => ({ cliPath: "/fake/pi/cli.js" }), resolveNodeBinFn: () => "/fake/node",
    execFileFn: (_b, _a, _o, cb) => cb(null, "provider  model\n", "") };
  assert.deepEqual(await checkPiModel({ provider: "cloud-a", model: "c1" }, deps), { ok: true });
  const r = await checkPiModel({ provider: "openai", model: "gpt-x" }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.message, 'model "openai/gpt-x" is not available to the bot engine');
});

// --- the spawn itself ------------------------------------------------------
const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");
const { probePiSandbox, _resetPiSandboxForTest } = await import("../scripts/pi-bots/pi_sandbox.mjs");
const { PiModelUnavailableError } = await import("../scripts/pi-bots/pi-model-catalog.mjs");
_resetPiSandboxForTest();
const SANDBOX = probePiSandbox({ force: true });
const noSandbox = SANDBOX.ok ? false : "pi sandbox unavailable here: " + SANDBOX.reason;

// The door token file where the gateway writes it (<CROW_HOME>/llm-cloud-token,
// outside secrets/), and a second one under a directory with a quote in it.
const TOKEN_VALUE = "fixturetoken" + "0a1b".repeat(13);
const TOKEN = join(HOME, "llm-cloud-token");
writeFileSync(TOKEN, TOKEN_VALUE, { mode: 0o600 });
mkdirSync(join(HOME, "secrets"), { recursive: true, mode: 0o700 });
const QUOTED_DIR = join(USER_HOME, "it's $HOME `x`");
mkdirSync(QUOTED_DIR, { recursive: true });
const QUOTED_TOKEN = join(QUOTED_DIR, "llm-cloud-token");
writeFileSync(QUOTED_TOKEN, TOKEN_VALUE, { mode: 0o600 });

/** The apiKey pi would run, from the real entry builder. */
function apiKeyFor(tokenPath) {
  const row = { id: "cloud-a", baseUrl: "https://api.example.com/v1", apiKey: "fixture-secret-123", provider_type: "openai-compat", models: [{ id: "c1" }], gpuPolicy: null };
  return buildManagedEntries([row], { cloudDoorPort: 3001, consent: { "cloud-a": CONSENT }, consentSalt: SALT, tokenPath })["crow-c-cloud-a"].apiKey;
}
const SALT = "cd".repeat(32);
const { createHmac } = await import("node:crypto");
const CONSENT = { target: "https://api.example.com/v1", keyFp: createHmac("sha256", Buffer.from(SALT, "hex")).update("fixture-secret-123").digest("hex").slice(0, 16) };

/** Spawn a stub pi that reports its argv, its env, and what /bin/sh -c <apiKey command> prints inside. */
async function spawnReport({ provider = "cloud-a", model = "c1", commands = [], mode = "auto" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "crow-provider-id-spawn-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const stub = join(dir, "stub-pi.mjs");
  writeFileSync(stub, [
    'import { execSync } from "node:child_process";',
    `const cmds = ${JSON.stringify(commands)};`,
    // pi 0.85.1 resolve-config-value.js: execSync(command.slice(1)) under the default /bin/sh, 10 s timeout.
    'const ran = cmds.map((c) => { try { return execSync(c.slice(1), { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return "ERR"; } });',
    'process.stdout.write(JSON.stringify({ type: "report", argv: process.argv.slice(2), env: process.env, ran }) + "\\n");',
    "setTimeout(() => process.exit(0), 50);",
  ].join("\n"));
  const prev = process.env.CROW_PI_SANDBOX;
  process.env.CROW_PI_SANDBOX = mode;
  try {
    const pi = new PiRpc({ def: {}, sessionDir: dir, resolved: { provider, model, key: `${provider}/${model}` },
      nodeBin: process.execPath, cliPath: stub, diagLog: () => {} });
    const r = await pi.waitFor((m) => m.type === "report", 10000, "report");
    await pi.exited;
    return { pi, r };
  } finally {
    if (prev === undefined) delete process.env.CROW_PI_SANDBOX; else process.env.CROW_PI_SANDBOX = prev;
  }
}
const flag = (argv, name) => argv[argv.indexOf(name) + 1];

test("bridge spawn: cloud-a/c1 runs pi as crow-c-cloud-a; no env value is the door token", async () => {
  writeFileSync(MODELS, JSON.stringify({ providers: { "crow-c-cloud-a": { models: [{ id: "c1" }] } } }));
  const { r } = await spawnReport({ mode: "off" });
  assert.equal(flag(r.argv, "--provider"), "crow-c-cloud-a");
  assert.equal(flag(r.argv, "--model"), "c1");
  assert.equal(r.env.PI_PROVIDER, "crow-c-cloud-a");
  for (const [k, v] of Object.entries(r.env)) assert.notEqual(v, TOKEN_VALUE, `env ${k} carries the token`);
});

test("bridge spawn: a bare pi built-in with no entry refuses to start pi", async () => {
  writeFileSync(MODELS, JSON.stringify({ providers: {} }));
  await assert.rejects(spawnReport({ provider: "openai", model: "gpt-x", mode: "off" }),
    (e) => e instanceof PiModelUnavailableError && /model "openai\/gpt-x" is not available to the bot engine/.test(e.message));
});

test("sandboxed: the door token file is readable by the apiKey command inside bwrap (and through a quoted path)", { skip: noSandbox }, async () => {
  writeFileSync(MODELS, JSON.stringify({ providers: { "crow-c-cloud-a": { models: [{ id: "c1" }] } } }));
  const plainCmd = apiKeyFor(TOKEN);
  const quotedCmd = apiKeyFor(QUOTED_TOKEN);
  assert.equal(plainCmd, "!cat '" + TOKEN + "'");
  assert.ok(quotedCmd.includes("'\\''"), "the embedded quote is escaped");
  const secretProbe = "!cat '" + join(HOME, "secrets", "probe") + "'";
  writeFileSync(join(HOME, "secrets", "probe"), "hidden", { mode: 0o600 });
  const { pi, r } = await spawnReport({ commands: [plainCmd, quotedCmd, secretProbe] });
  assert.equal(pi.sandboxed, true);
  assert.equal(r.ran[0], TOKEN_VALUE, "the token file is outside secrets/ and visible");
  assert.equal(r.ran[1], TOKEN_VALUE, "the quoted path reaches the same bytes, no shell expansion");
  assert.equal(r.ran[2], "ERR", "control: secrets/ itself is hidden");
  assert.equal(flag(r.argv, "--provider"), "crow-c-cloud-a");
});

test("co-hosted bridge spawn: cloud-a/c1 keeps --provider cloud-a (N1)", async () => {
  writeFileSync(MODELS, JSON.stringify({ providers: { "crow-c-cloud-a": { models: [{ id: "c1" }] } } }));
  const r4 = join(USER_HOME, ".crow-r4");
  mkdirSync(join(r4, "data"), { recursive: true });
  const prev = { h: process.env.CROW_HOME, d: process.env.CROW_DATA_DIR };
  process.env.CROW_HOME = r4;
  process.env.CROW_DATA_DIR = join(r4, "data");
  try {
    const { r } = await spawnReport({ mode: "off" });
    assert.equal(flag(r.argv, "--provider"), "cloud-a");
    assert.equal(r.env.PI_PROVIDER, "cloud-a");
  } finally {
    process.env.CROW_HOME = prev.h;
    process.env.CROW_DATA_DIR = prev.d;
  }
});

// --- Fix round 1 -------------------------------------------------------------
const { isPiBuiltinId, piSpawnTarget, rowIdForPiProvider } = await import("../scripts/pi-bots/pi_provider_id.mjs");

test("fix 1: a case variant of a built-in is a built-in, and fails closed", () => {
  assert.equal(isPiBuiltinId("OpenAI"), true);
  assert.equal(piProviderIdFor("OpenAI", { providers: {} }, DEFAULT), null);
  assert.equal(piProviderIdFor("ZAI", { providers: {} }, DEFAULT), null);
  assert.equal(piProviderIdFor("OpenAI", { providers: { OpenAI: {} } }, DEFAULT), null, "pi folds it onto the built-in whatever the file says");
  assert.equal(piProviderIdFor("OpenAI", { providers: { "crow-c-OpenAI": {} } }, DEFAULT), null);
});

test("fix 1: an id the file holds under more than one case is ambiguous and refused", () => {
  assert.equal(piProviderIdFor("cloud-a", { providers: { "cloud-a": {}, "Cloud-A": {} } }, DEFAULT), null);
  assert.equal(piProviderIdFor("Cloud-A", { providers: { "cloud-a": {} } }, DEFAULT), null, "pi would resolve another row's entry");
  assert.equal(piProviderIdFor("cloud-a", { providers: { "crow-c-Cloud-A": {} } }, DEFAULT), null);
  assert.equal(piProviderIdFor("Cloud-A", { providers: { "crow-c-Cloud-A": {} } }, DEFAULT), "crow-c-Cloud-A");
});

test("fix 2: piSpawnTarget is the one rule the pickers share", () => {
  const json = { providers: { "crow-c-cloud-a": { models: [{ id: "c1" }] } } };
  assert.deepEqual(piSpawnTarget("cloud-a", "c1", json, DEFAULT), { ok: true, piProvider: "crow-c-cloud-a", key: "crow-c-cloud-a/c1" });
  assert.deepEqual(piSpawnTarget("openai", "gpt-x", json, DEFAULT), { ok: false, reason: 'model "openai/gpt-x" is not available to the bot engine' });
});

test("fix 2: rowIdForPiProvider maps a door entry back to its row on the default home only", () => {
  const def = { HOME: "/home/u", CROW_HOME: "/home/u/.crow" };
  assert.equal(rowIdForPiProvider("crow-c-cloud-a", { env: def }), "cloud-a");
  assert.equal(rowIdForPiProvider("crow-local", { env: def }), "crow-local");
  assert.equal(rowIdForPiProvider("crow-c-cloud-a", { env: { HOME: "/home/u", CROW_HOME: "/home/u/.crow-r4" } }), "crow-c-cloud-a");
});

test("fix 3: PiRpc spawns with the provider prepareSpawn mapped, without re-reading the file", async () => {
  writeFileSync(MODELS, JSON.stringify({ providers: {} }));            // a re-read would now refuse "openai"
  const dir = mkdtempSync(join(tmpdir(), "crow-provider-id-pre-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const stub = join(dir, "stub-pi.mjs");
  writeFileSync(stub, 'process.stdout.write(JSON.stringify({ type: "report", argv: process.argv.slice(2) }) + "\\n"); setTimeout(() => process.exit(0), 50);');
  process.env.CROW_PI_SANDBOX = "off";
  try {
    const pi = new PiRpc({ def: {}, sessionDir: dir, resolved: { provider: "openai", model: "gpt-x", key: "openai/gpt-x" },
      piProvider: "crow-c-openai", nodeBin: process.execPath, cliPath: stub, diagLog: () => {} });
    const r = await pi.waitFor((m) => m.type === "report", 10000, "report");
    await pi.exited;
    assert.equal(flag(r.argv, "--provider"), "crow-c-openai");
  } finally { delete process.env.CROW_PI_SANDBOX; }
});

test("fix 3: prepareSpawn maps the provider (before the bridge writes an active session) and hands it to PiRpc", async () => {
  const { prepareSpawn } = await import("../scripts/pi-bots/bot-world.mjs");
  // The providers rows resolveModel validates a def's key against (scratch crow.db).
  const { default: Database } = await import("better-sqlite3");
  const d = new Database(join(HOME, "data", "crow.db"));
  d.exec("CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, models TEXT, disabled INTEGER DEFAULT 0)");
  d.prepare("INSERT OR REPLACE INTO providers (id, models, disabled) VALUES (?, ?, 0)").run("cloud-a", JSON.stringify([{ id: "c1" }]));
  d.prepare("INSERT OR REPLACE INTO providers (id, models, disabled) VALUES (?, ?, 0)").run("openai", JSON.stringify([{ id: "gpt-x" }]));
  d.close();
  writeFileSync(MODELS, JSON.stringify({ providers: { "crow-c-cloud-a": { models: [{ id: "c1" }] } } }));
  const world = { def: { system_prompt: "x", models: { default: "cloud-a/c1" }, tools: {} }, crowHome: HOME, sessionDir: mkdtempSync(join(tmpdir(), "crow-provider-id-world-")) };
  const prep = await prepareSpawn(world, {});
  assert.equal(prep.resolved.provider, "cloud-a", "the row id stays the session's model");
  assert.equal(prep.piRpcOpts.piProvider, "crow-c-cloud-a");
  writeFileSync(MODELS, JSON.stringify({ providers: {} }));
  const bare = { ...world, def: { ...world.def, models: { default: "openai/gpt-x" } } };
  await assert.rejects(prepareSpawn(bare, {}), (e) => e instanceof PiModelUnavailableError);
});

// --- Final fix wave ----------------------------------------------------------

test("final F1: a row whose own id is in the reserved crow-c- namespace maps to nothing, on any home", () => {
  // The primary wrote the door entry for its row cloud-a; a row literally
  // named crow-c-cloud-a (peer-written, or made by a co-hosted operator) must
  // never borrow it, and the prefix is matched without regard to case.
  const json = { providers: { "crow-c-cloud-a": {}, "CROW-C-x": {}, "crow-c-x": {} } };
  for (const where of [DEFAULT, COHOSTED]) {
    assert.equal(piProviderIdFor("crow-c-cloud-a", json, where), null, `crow-c-cloud-a on ${where.crowHome}`);
    assert.equal(piProviderIdFor("CROW-C-x", json, where), null, `CROW-C-x on ${where.crowHome}`);
    assert.equal(piProviderIdFor("Crow-C-cloud-a", { providers: {} }, where), null, "no entry at all");
  }
  assert.deepEqual(piSpawnTarget("crow-c-cloud-a", "c1", json, COHOSTED),
    { ok: false, reason: 'model "crow-c-cloud-a/c1" is not available to the bot engine' });
});

test("final F1: the bridge refuses a turn bound to a crow-c-* row, on the primary and on a co-hosted home", async () => {
  writeFileSync(MODELS, JSON.stringify({ providers: { "crow-c-cloud-a": { models: [{ id: "c1" }] } } }));
  await assert.rejects(spawnReport({ provider: "crow-c-cloud-a", model: "c1", mode: "off" }),
    (e) => e instanceof PiModelUnavailableError && /model "crow-c-cloud-a\/c1" is not available to the bot engine/.test(e.message));
  const r4 = join(USER_HOME, ".crow-r4");
  mkdirSync(join(r4, "data"), { recursive: true });
  const prev = { h: process.env.CROW_HOME, d: process.env.CROW_DATA_DIR };
  process.env.CROW_HOME = r4;
  process.env.CROW_DATA_DIR = join(r4, "data");
  try {
    await assert.rejects(spawnReport({ provider: "CROW-C-cloud-a", model: "c1", mode: "off" }),
      (e) => e instanceof PiModelUnavailableError && /not available to the bot engine/.test(e.message));
  } finally {
    process.env.CROW_HOME = prev.h;
    process.env.CROW_DATA_DIR = prev.d;
  }
});

test("final F3c: the bridge's piModelsJsonPath honours PI_CODING_AGENT_DIR (and PI_MODELS_JSON still wins)", async () => {
  const { piModelsJsonPath, piProviderIdHere } = await import("../scripts/pi-bots/pi_provider_id.mjs");
  const agentDir = mkdtempSync(join(tmpdir(), "crow-provider-id-agent-"));
  assert.equal(piModelsJsonPath({ HOME: "/home/u", PI_CODING_AGENT_DIR: agentDir }), join(agentDir, "models.json"));
  assert.equal(piModelsJsonPath({ HOME: "/home/u" }), join("/home/u", ".pi", "agent", "models.json"));
  assert.equal(piModelsJsonPath({ HOME: "/home/u", PI_CODING_AGENT_DIR: agentDir, PI_MODELS_JSON: "/x/m.json" }), "/x/m.json");
  // End to end: the mapping reads the agent dir's file.
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "crow-c-cloud-a": { models: [{ id: "c1" }] } } }));
  const env = { HOME: USER_HOME, CROW_HOME: HOME, PI_CODING_AGENT_DIR: agentDir };
  assert.equal(piProviderIdHere("cloud-a", { env }), "crow-c-cloud-a");
});

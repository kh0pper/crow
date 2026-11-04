/**
 * SAT-7 part B: the pi MCP block a bot gets for a satellite-hosted bundle
 * (scripts/pi-bots/satellite-blocks.mjs). No socket: the seam only BUILDS the config, and the
 * MCP endpoint it names is exercised in tests/satellite-tools-mount.test.js.
 *
 * A scratch Crow home with installed.json (one satellite-hosted bundle, one local bundle), a real
 * init-db database holding the satellites row, the per-bot opt-in and the bot defs, the real
 * actor key (this process is the signer, as the gateway is), a token file, and a stub db opener.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { rmScratch } from "./helpers/safe-rm.js";

const HOME = mkdtempSync(join(tmpdir(), "crow-satblocks-home-"));
const DATA = mkdtempSync(join(tmpdir(), "crow-satblocks-data-"));
const DB_PATH = join(DATA, "crow.db");
const saved = { CROW_HOME: process.env.CROW_HOME, CROW_DATA_DIR: process.env.CROW_DATA_DIR, CROW_DB_PATH: process.env.CROW_DB_PATH };
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_DB_PATH = DB_PATH;

const SB = await import("../scripts/pi-bots/satellite-blocks.mjs");
const { writeBotMcp } = await import("../scripts/pi-bots/mcp_writer.mjs");
const AS = await import("../scripts/pi-bots/actor-sig.mjs");
const { initGatewayActorKey, _resetActorKeyForTest, scopeRefFor, signScopeActor } = AS;
const { SATELLITE_TOOLS_TOKEN } = await import("../servers/gateway/local-token.js");
const { satelliteToolsTokenPath } = SB;

const SAT_A = "sat-alpha-0001";
const SAT_B = "sat-bravo-0002";
const TOKEN = "sat-family-token-0123456789abcdef";
const PORT = 4555;
const BUNDLE = "gitea";
const OTHER = "notes";
const savedEnv = { PORT: process.env.PORT, CROW_GATEWAY_PORT: process.env.CROW_GATEWAY_PORT };

// The seam closes the connection its `openDb` gave it (production opens one per call), so the stub
// opens a fresh read-only client every time, exactly like the bot hosts' own reader.
const openDb = () => new Database(DB_PATH, { readonly: true, fileMustExist: true });

const raw = (fn) => { const d = new Database(DB_PATH); try { return fn(d); } finally { d.close(); } };

/** installed.json: one satellite-hosted bundle on SAT_A, another on SAT_B, and a local one. */
function writeInstalled(extra = []) {
  writeFileSync(join(HOME, "installed.json"), JSON.stringify([
    { id: BUNDLE, mode: "satellite", host: SAT_A, version: "1.0.0" },
    { id: OTHER, mode: "satellite", host: SAT_B, version: "1.0.0" },
    { id: "browser", type: "mcp-server", version: "1.0.0" },
    ...extra,
  ], null, 2));
}

const def = (crowMcp, extra = {}) => ({ tools: { crow_mcp: crowMcp }, ...extra });
// `mcpDelivery: "fd"` unless a case overrides it: fd mode is the default this seam is for, and the
// sandbox's pi-lab may report file mode (mcpConfigDelivery falls back when the compat probe fails).
const world = (d, over = {}) => ({ def: d, crowHome: HOME, projectId: null, bot: { bot_id: "b1" }, gatewayType: "job", mcpDelivery: "fd", ...over });
const opts = (over = {}) => ({
  scopeRef: scopeRefFor({ jobId: "job-1" }), ownerTurn: true, log: () => {},
  actor: { botId: "b1", threadId: "job-job-1", gatewayType: "job", jobId: "job-1" },
  openDb, readToken: () => TOKEN, presign: async () => false, ...over,
});

before(async () => {
  assert.ok(process.env.CROW_SUITE_SCRATCH, "runs only in the scratch suite env");
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  raw((d) => {
    const ins = d.prepare("INSERT INTO satellites (id, name, tailnet_host, satellite_pubkey, mgmt_pubkey, cert_json, cert_serial, cert_expires_at, primary_url, status) VALUES (?,?,?,?,?,?,?,?,?,?)");
    ins.run(SAT_A, "black-swan-test", "satellite.example.ts.net", "a".repeat(64), "b".repeat(64), "{}", "s1", "2027-01-01T00:00:00Z", "https://crow.example.ts.net:8444", "active");
    ins.run(SAT_B, "black-swan-test-2", "satellite.example.ts.net", "c".repeat(64), "d".repeat(64), "{}", "s2", "2027-01-01T00:00:00Z", "https://crow.example.ts.net:8444", "active");
    d.prepare("INSERT INTO satellite_bot_optins (bot_id, any_turn) VALUES ('opted', 1)").run();
  });
  writeInstalled();
  mkdirSync(join(HOME, "secrets"), { recursive: true });
  writeFileSync(satelliteToolsTokenPath(), TOKEN, { mode: 0o600 });
  process.env.PORT = String(PORT);
  process.env.CROW_GATEWAY_PORT = String(PORT);
  _resetActorKeyForTest();
  initGatewayActorKey();
});

after(() => {
  _resetActorKeyForTest();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [HOME, DATA]) rmScratch(d);
});

// ── naming the files and the URL ─────────────────────────────────────────────────────────────────

test("the token file reader opens the file local-token.js rotates, and the new kind is a scope kind", () => {
  assert.equal(satelliteToolsTokenPath(), SATELLITE_TOOLS_TOKEN.path());
  assert.ok(AS.SCOPE_ACTOR_KINDS.includes("satellite-tools"));
});

test("fd mode: one block per granted satellite bundle, at the loopback mount, with the family token and a v3 signature", async () => {
  const prep = { piRpcOpts: { mcpConfig: { mcpServers: { board: { url: "http://127.0.0.1:3001/board/mcp" } } } } };
  const r = await SB.withSatelliteBlocks(world(def(["gitea/gitea_list_repos", "gitea/gitea_create_issue", "notes/notes_list"])), prep, opts());
  const servers = prep.piRpcOpts.mcpConfig.mcpServers;
  assert.ok(servers[BUNDLE], "the gitea block");
  assert.ok(servers.board, "the existing config is kept");
  assert.equal(servers[BUNDLE].url, `http://127.0.0.1:${PORT}/satellite-tools/${SAT_A}/${BUNDLE}/mcp`);
  assert.equal(servers[OTHER].url, `http://127.0.0.1:${PORT}/satellite-tools/${SAT_B}/${OTHER}/mcp`);
  const h = servers[BUNDLE].headers;
  assert.equal(h.Authorization, "Bearer " + TOKEN);
  assert.equal(h["X-Crow-Actor-Kind"], "satellite-tools");
  assert.equal(h["X-Crow-Actor-Id"], "b1");
  assert.equal(h["X-Crow-Actor-Scope"], scopeRefFor({ jobId: "job-1" }));
  assert.equal(h["X-Crow-Actor-Thread"], "job-job-1");
  assert.equal(h["X-Crow-Actor-Gateway"], "job");
  assert.equal(AS.verifyScopeActorSig({ kind: "satellite-tools", botId: "b1", scope: h["X-Crow-Actor-Scope"], threadId: "job-job-1", gatewayType: "job", sig: h["X-Crow-Actor-Sig"] }), true);
  assert.deepEqual(r.satelliteBlocks, { [BUNDLE]: BUNDLE, [OTHER]: OTHER });
});

test("the port is the gateway's (an explicit one for a test), never a fixed literal", () => {
  const r = SB.satelliteBlocksFor({
    def: def(["gitea/gitea_list_repos"]), bundles: [{ id: BUNDLE, host: SAT_A }],
    actor: { botId: "b1", threadId: "job-job-1", gatewayType: "job", jobId: "job-1" },
    scopeRef: scopeRefFor({ jobId: "job-1" }), ownerTurn: true, port: 3001, delivery: "fd", token: TOKEN,
  });
  assert.equal(r.blocks[BUNDLE].url, `http://127.0.0.1:3001/satellite-tools/${SAT_A}/${BUNDLE}/mcp`);
});

// ── the refusals ─────────────────────────────────────────────────────────────────────────────────

test("file mode emits no block and logs one fixed line", async () => {
  const lines = [];
  const prep = { piRpcOpts: { mcpConfig: { mcpServers: {} }, mcpDelivery: "file" } };
  const r = await SB.withSatelliteBlocks(world(def(["gitea/gitea_list_repos"])), prep, opts({ log: (m) => lines.push(m) }));
  assert.deepEqual(prep.piRpcOpts.mcpConfig.mcpServers, {});
  assert.deepEqual(r.satelliteBlocks, {});
  assert.deepEqual(lines, [SB.WARN_FILE_MODE]);
});

test("an ungranted bundle emits nothing; a bare bundle name grants nothing", async () => {
  for (const grants of [["crow-memory"], [BUNDLE], ["otherbundle/x"]]) {
    const prep = { piRpcOpts: { mcpConfig: { mcpServers: {} } } };
    const r = await SB.withSatelliteBlocks(world(def(grants)), prep, opts());
    assert.deepEqual(prep.piRpcOpts.mcpConfig.mcpServers, {}, JSON.stringify(grants));
    assert.deepEqual(r.satelliteBlocks, {});
  }
  assert.deepEqual(SB.grantedBundles(def([BUNDLE, "gitea/x"])), new Set(["gitea"]));
});

test("a revoked satellite emits nothing; a satellite row that is gone emits nothing", async () => {
  raw((d) => d.prepare("UPDATE satellites SET status = 'revoked' WHERE id = ?").run(SAT_A));
  try {
    const prep = { piRpcOpts: { mcpConfig: { mcpServers: {} } } };
    const r = await SB.withSatelliteBlocks(world(def(["gitea/gitea_list_repos", "notes/notes_list"])), prep, opts());
    assert.equal(prep.piRpcOpts.mcpConfig.mcpServers[BUNDLE], undefined, "revoked");
    assert.ok(prep.piRpcOpts.mcpConfig.mcpServers[OTHER], "the other satellite's bundle is unaffected");
    assert.deepEqual(Object.keys(r.satelliteBlocks), [OTHER]);
  } finally {
    raw((d) => d.prepare("UPDATE satellites SET status = 'active' WHERE id = ?").run(SAT_A));
  }
  raw((d) => d.prepare("DELETE FROM satellites WHERE id = ?").run(SAT_B));
  try {
    const prep = { piRpcOpts: { mcpConfig: { mcpServers: {} } } };
    await SB.withSatelliteBlocks(world(def(["gitea/gitea_list_repos", "notes/notes_list"])), prep, opts());
    assert.equal(prep.piRpcOpts.mcpConfig.mcpServers[OTHER], undefined, "no row, no block");
    assert.ok(prep.piRpcOpts.mcpConfig.mcpServers[BUNDLE]);
  } finally {
    raw((d) => d.prepare("INSERT INTO satellites (id, name, tailnet_host, satellite_pubkey, mgmt_pubkey, cert_json, cert_serial, cert_expires_at, primary_url, status) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(SAT_B, "black-swan-test-2", "satellite.example.ts.net", "c".repeat(64), "d".repeat(64), "{}", "s2", "2027-01-01T00:00:00Z", "https://crow.example.ts.net:8444", "active"));
  }
});

test("a bundle the bot's own config already names with a REAL local entry is never replaced", async () => {
  const lines = [];
  const prep = { piRpcOpts: { mcpConfig: { mcpServers: { gitea: { command: "node", args: ["local.js"] } } } } };
  const r = await SB.withSatelliteBlocks(world(def(["gitea/gitea_list_repos"])), prep, opts({ log: (m) => lines.push(m) }));
  assert.deepEqual(prep.piRpcOpts.mcpConfig.mcpServers.gitea, { command: "node", args: ["local.js"] }, "a local server wins");
  assert.deepEqual(lines, [SB.WARN_COLLIDES("gitea")]);
  assert.deepEqual(r.satelliteBlocks, {});
});

// ── F1: the real writer's config leaves a disabled placeholder, which the block replaces ────────

test("F1: the real writer's config marks a satellite bundle {disabled:true}, and the block replaces exactly that", async () => {
  // The two records a satellite install writes: installed.json (in before) and mcp-addons.json.
  writeFileSync(join(HOME, "mcp-addons.json"), JSON.stringify({
    [BUNDLE]: { transport: "satellite", satellite_id: SAT_A, bundle: BUNDLE },
    [OTHER]: { transport: "satellite", satellite_id: SAT_B, bundle: OTHER },
  }, null, 2));
  const sessionDir = mkdtempSync(join(tmpdir(), "crow-satblocks-sess-"));
  try {
    const d = def(["gitea/gitea_list_repos", "notes/notes_list", "crow-memory/crow_recall"]);
    const written = writeBotMcp(d, {
      write: false, sessionDir, canonical: { mcpServers: {} }, crowHome: HOME,
      botId: "b1", threadId: "job-job-1", gatewayType: "job",
    });
    assert.deepEqual(written.json.mcpServers[BUNDLE], { disabled: true }, "the real writer disables the bundle");
    assert.deepEqual(written.json.mcpServers[OTHER], { disabled: true }, "and the one on the other satellite");
    const prep = { piRpcOpts: { mcpConfig: written.json } };
    const r = await SB.withSatelliteBlocks(world(d), prep, opts());
    const servers = prep.piRpcOpts.mcpConfig.mcpServers;
    assert.equal(servers[BUNDLE].url, `http://127.0.0.1:${PORT}/satellite-tools/${SAT_A}/${BUNDLE}/mcp`);
    assert.equal(servers[OTHER].url, `http://127.0.0.1:${PORT}/satellite-tools/${SAT_B}/${OTHER}/mcp`);
    assert.equal(servers[BUNDLE].headers.Authorization, "Bearer " + TOKEN);
    assert.deepEqual(Object.keys(r.satelliteBlocks).sort(), [BUNDLE, OTHER].sort());
    assert.deepEqual(written.json.mcpServers[BUNDLE], { disabled: true }, "the writer's own object is not mutated");
    // The same result re-applied to a rebuild of the same config (bot-world.mjs writeWorldMcp).
    const rebuilt = SB.applySatelliteBlocks(written.json, r.result);
    assert.equal(rebuilt.mcpServers[BUNDLE].url, `http://127.0.0.1:${PORT}/satellite-tools/${SAT_A}/${BUNDLE}/mcp`);
  } finally {
    rmScratch(sessionDir);
  }
});

test("Q2: another person's turn emits nothing unless the bot opted in", async () => {
  const discord = { scopeRef: `s:41`, ownerTurn: false, actor: { botId: "b1", sessionId: 41, threadId: "dc-1", gatewayType: "discord" }, openDb, readToken: () => TOKEN, presign: async () => false };
  const lines = [];
  let prep = { piRpcOpts: { mcpConfig: { mcpServers: {} } } };
  await SB.withSatelliteBlocks(world(def(["gitea/gitea_list_repos"]), { gatewayType: "discord" }), prep, { ...discord, log: (m) => lines.push(m) });
  assert.deepEqual(prep.piRpcOpts.mcpConfig.mcpServers, {});
  assert.deepEqual(lines, [SB.WARN_NOT_OWNER("discord")]);
  // The same turn for a bot the owner opted in: the block is emitted, signed for the s: scope
  // (this process holds the scope key, as the gateway does).
  const optedActor = { botId: "opted", sessionId: 41, threadId: "dc-1", gatewayType: "discord" };
  prep = { piRpcOpts: { mcpConfig: { mcpServers: {} } } };
  lines.length = 0;
  const r = await SB.withSatelliteBlocks(world(def(["gitea/gitea_list_repos"]), { gatewayType: "discord" }), prep,
    { ...discord, actor: optedActor, openDb, readToken: () => TOKEN, presign: async () => false, log: (m) => lines.push(m) });
  assert.ok(prep.piRpcOpts.mcpConfig.mcpServers[BUNDLE], "opted in: " + JSON.stringify(lines));
  const h = prep.piRpcOpts.mcpConfig.mcpServers[BUNDLE].headers;
  assert.equal(h["X-Crow-Actor-Id"], "opted");
  assert.equal(h["X-Crow-Actor-Scope"], "s:41");
  assert.equal(AS.verifyScopeActorSig({ kind: "satellite-tools", botId: "opted", scope: "s:41", threadId: "dc-1", gatewayType: "discord", sig: h["X-Crow-Actor-Sig"] }), true);
  assert.deepEqual(Object.keys(r.satelliteBlocks), [BUNDLE]);
});

test("an unsigned host (no scope key, no presign) emits nothing and says so", async () => {
  _resetActorKeyForTest();
  const lines = [];
  try {
    const prep = { piRpcOpts: { mcpConfig: { mcpServers: {} } } };
    const r = await SB.withSatelliteBlocks(world(def(["gitea/gitea_list_repos"])), prep, opts({ log: (m) => lines.push(m) }));
    assert.deepEqual(prep.piRpcOpts.mcpConfig.mcpServers, {});
    assert.deepEqual(r.satelliteBlocks, {});
    assert.deepEqual(lines, [SB.WARN_UNSIGNED]);
  } finally {
    initGatewayActorKey();
  }
});

test("a key-less host asks the signing relay for exactly this kind, and only on an owner job turn", async () => {
  _resetActorKeyForTest();
  const asked = [];
  const presign = async (o) => { asked.push(o); return true; };
  try {
    // An owner job turn: one request, one kind.
    await SB.withSatelliteBlocks(world(def(["gitea/gitea_list_repos"])), { piRpcOpts: { mcpConfig: { mcpServers: {} } } }, opts({ presign }));
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0].kinds, ["satellite-tools"]);
    assert.equal(asked[0].jobId, "job-1");
    // A channel turn: never asked (the relay signs a scope kind for an owner job only, and a
    // refused request would strip that turn's other signatures).
    asked.length = 0;
    await SB.withSatelliteBlocks(world(def(["gitea/gitea_list_repos"]), { gatewayType: "gmail" }),
      { piRpcOpts: { mcpConfig: { mcpServers: {} } } },
      { scopeRef: "s:42", ownerTurn: false, actor: { botId: "opted", sessionId: 42, threadId: "gm-1", gatewayType: "gmail" }, openDb, readToken: () => TOKEN, presign });
    assert.deepEqual(asked, []);
  } finally {
    initGatewayActorKey();
  }
});

// ── the allowlist ────────────────────────────────────────────────────────────────────────────────

test("toolAllowlist spells an expanded bundle's grant mcp__<bundle>__<tool>, and leaves it alone without a block", async () => {
  const { toolAllowlist } = await import("../scripts/pi-bots/bridge.mjs");
  const d = def(["gitea/gitea_list_repos", "gitea/gitea_create_issue", "crow-memory/crow_recall"]);
  assert.equal(toolAllowlist(d), "mcp__gitea__gitea_list_repos,mcp__gitea__gitea_create_issue,mcp__crow-memory__crow_recall");
  assert.equal(toolAllowlist(d, { satelliteBlocks: { [BUNDLE]: BUNDLE } }),
    "mcp__gitea__gitea_list_repos,mcp__gitea__gitea_create_issue,mcp__crow-memory__crow_recall");
  assert.deepEqual(SB.expandSatelliteEntry("gitea/gitea_list_repos", { satelliteBlocks: { gitea: "gitea" } }), ["mcp__gitea__gitea_list_repos"]);
  assert.equal(SB.expandSatelliteEntry("gitea/gitea_list_repos", { satelliteBlocks: null }), null);
  assert.equal(SB.expandSatelliteEntry("crow-memory/crow_recall", { satelliteBlocks: { gitea: "gitea" } }), null);
});

// ── F2: the allowlist is wired to the blocks ────────────────────────────────────────────────────

// `satelliteBlocks` is block name -> bundle id (what withSatelliteBlocks sets on piRpcOpts), so a
// block name that differs from the bundle id shows whether the entry was expanded at all. Without
// the wiring the csv keeps today's `mcp__<bundle>__<tool>` spelling and never carries the block's.
test("F2: the allowlist holds the granted tool's name from the block, and never without one", async () => {
  const { toolAllowlist, buildToolsCsv } = await import("../scripts/pi-bots/bridge.mjs");
  const d = def(["gitea/gitea_list_repos", "crow-memory/crow_recall"]);
  const fromBlock = "mcp__gitea-remote__gitea_list_repos";
  const withBlock = toolAllowlist(d, { satelliteBlocks: { "gitea-remote": "gitea" } }).split(",");
  assert.ok(withBlock.includes(fromBlock), "the block's spelling: " + withBlock.join(","));
  // No block (a revoked satellite, file-mode delivery, an ungranted bundle): never the block's name.
  for (const none of [undefined, null, {}, { other: "notes" }]) {
    const csv = toolAllowlist(d, none === undefined ? {} : { satelliteBlocks: none });
    assert.ok(!csv.split(",").includes(fromBlock), JSON.stringify(none) + ": " + csv);
    assert.ok(csv.split(",").includes("mcp__gitea__gitea_list_repos"), "today's spelling stays: " + csv);
  }
  // buildToolsCsv (the child's --tools pin, and the channel preflight's count) carries the same name.
  const resolved = { provider: "crow-local", model: "some-model" };
  const pinned = buildToolsCsv(d, { resolved, satelliteBlocks: { "gitea-remote": "gitea" } }).csv.split(",");
  assert.ok(pinned.includes(fromBlock), "the --tools csv: " + pinned.join(","));
  const unpinned = buildToolsCsv(d, { resolved }).csv.split(",");
  assert.ok(!unpinned.includes(fromBlock), "no block, no name: " + unpinned.join(","));
  assert.ok(unpinned.includes("mcp__gitea__gitea_list_repos"));
});

test("applySatelliteBlocks is a no-op without blocks and never replaces an existing server", () => {
  const base = { mcpServers: { gitea: { url: "http://elsewhere/mcp" } } };
  assert.equal(SB.applySatelliteBlocks(base, { blocks: {} }), base);
  assert.equal(SB.applySatelliteBlocks(null, { blocks: { gitea: { url: "x" } } }), null);
  const out = SB.applySatelliteBlocks(base, { blocks: { gitea: { url: "http://127.0.0.1:1/x" }, notes: { url: "http://127.0.0.1:1/y" } } });
  assert.equal(out.mcpServers.gitea.url, "http://elsewhere/mcp", "a real local entry wins even unnamed");
  assert.equal(out.mcpServers.notes.url, "http://127.0.0.1:1/y");
  assert.equal(base.mcpServers.notes, undefined, "the input config is not mutated");
});

test("F1: only the {disabled:true} placeholder is ever replaced, and only when the result says so", () => {
  const block = { url: "http://127.0.0.1:1/x", headers: {} };
  const base = { mcpServers: { gitea: { disabled: true }, notes: { command: "node", args: ["n.js"] } } };
  // No `replacing` (a hand-built result): nothing is replaced.
  let out = SB.applySatelliteBlocks(base, { blocks: { gitea: block, notes: { ...block, url: "http://127.0.0.1:1/y" } } });
  assert.deepEqual(out.mcpServers.gitea, { disabled: true });
  assert.deepEqual(out.mcpServers.notes, { command: "node", args: ["n.js"] });
  // A real local entry is never replaced, even if the result claims it.
  out = SB.applySatelliteBlocks(base, { blocks: { gitea: block, notes: { ...block, url: "http://127.0.0.1:1/y" } }, replacing: ["gitea", "notes"] });
  assert.equal(out.mcpServers.gitea.url, "http://127.0.0.1:1/x", "the placeholder is replaced");
  assert.deepEqual(out.mcpServers.notes, { command: "node", args: ["n.js"] }, "a real entry still wins");
});
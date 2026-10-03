/**
 * S6-CROW — bot read confinement, crow side.
 *
 * pi-lab >= c8bbb02 confines a bot's read tools to: the spawn cwd,
 * dirname(PI_BOT_MCP_CONFIG), write_paths and permission_policy.read_paths,
 * and reads the bot's MCP config from an inherited fd (PI_BOT_MCP_CONFIG_FD).
 * Crow's half, pinned here:
 *
 *   - the effective read_paths (explicit entries + the bot's project
 *     workspace, ONLY for a bot with a project) — bot-read-paths.mjs;
 *   - fd delivery: PI_BOT_MCP_CONFIG_FD=4, the JSON piped and the write end
 *     closed, no .mcp.json anywhere on disk (world root and /tmp/pibot-job-*),
 *     a stale file from an earlier file-mode turn removed — mcp-delivery.mjs;
 *   - the file fallback (PIBOT_MCP_CONFIG_DELIVERY=file) unchanged;
 *   - the pi-lab minimum (pi-lab-compat.mjs).
 *
 * The acceptance legs drive the REAL channel path (bridge.handleInbound) and
 * the REAL job path (job_runner.runJob) for two bots with a stub pi that
 * records what it was handed — argv, env, cwd — reads fd 4 to EOF (it would
 * block forever if the bridge did not close its end), proves the fd is then
 * gone, and checks whether any .mcp.json exists at spawn time. Bot A's read
 * roots are then evaluated the way pi-lab's botReadRoots() builds them.
 *
 * Hermetic: CROW_DATA_DIR/CROW_HOME/HOME are scratch.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, sep } from "node:path";
import Database from "better-sqlite3";

for (const k of Object.keys(process.env)) {
  if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];
}

const dir = mkdtempSync(join(tmpdir(), "s6-read-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.PIBOT_MAX_PI = "99";
process.env.PIBOT_WARM_GATEWAY_URL = "http://127.0.0.1:1";
process.env.PIBOT_WARM_TIMEOUT_MS = "1500";
process.env.PIBOT_PROMPT_ACK_TIMEOUT_MS = "8000";
process.env.PIBOT_TURN_TIMEOUT_MS = "8000";
process.env.PIBOT_JOB_TIMEOUT_MS = "8000";
process.env.PI_MODELS_JSON = join(dir, "models.json");
// No sandbox wrapper: the stub pi must see exactly the fds the bridge hands it.
process.env.CROW_PI_SANDBOX = "off";
mkdirSync(join(process.env.CROW_HOME, "skills"), { recursive: true });
writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({ providers: { stub: { models: [{ id: "m1" }] } } }));
process.env.HOME = join(dir, "fakehome");
mkdirSync(join(process.env.HOME, ".pi", "agent"), { recursive: true });
// One canonical server the bots select per-def, so each bot's delivered config
// is distinguishable (A selects it, B does not -> B's copy has it disabled).
writeFileSync(join(process.env.HOME, ".pi", "agent", "mcp.json"), JSON.stringify({
  mcpServers: { "marker-srv": { command: "node", args: ["-e", "0"] } },
}));

const DB_FILE = join(dir, "crow.db");
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

// ---- the recording stub pi -------------------------------------------------
const STUB_PI = join(dir, "stub-pi.mjs");
writeFileSync(STUB_PI, [
  'import { writeFileSync, readFileSync, closeSync, fstatSync, existsSync } from "node:fs";',
  'import { join } from "node:path";',
  'const env = {};',
  'for (const k of Object.keys(process.env).sort()) if (/^(PI_|PIBOT_)/.test(k)) env[k] = process.env[k];',
  'const cap = { argv: process.argv.slice(2), env, cwd: process.cwd(), cfgText: null, fdErr: null, fdGoneAfterClose: null,',
  '  mcpJsonInCwd: existsSync(join(process.cwd(), ".mcp.json")), mcpJsonAtEnvPath: null };',
  'if (process.env.PI_BOT_MCP_CONFIG) cap.mcpJsonAtEnvPath = existsSync(process.env.PI_BOT_MCP_CONFIG);',
  'const fdKey = process.env.PI_BOT_MCP_CONFIG_FD;',
  'if (fdKey) {',
  // exactly what pi-lab mcp-client does: read to EOF once, close
  '  const fd = Number(fdKey);',
  '  try { cap.cfgText = readFileSync(fd, "utf8"); } catch (e) { cap.fdErr = e.code || String(e); }',
  '  try { closeSync(fd); } catch {}',
  '  try { fstatSync(fd); cap.fdGoneAfterClose = false; } catch (e) { cap.fdGoneAfterClose = e.code === "EBADF"; }',
  '}',
  'const flush = () => writeFileSync(process.env.PIBOT_TEST_CAPTURE, JSON.stringify(cap));',
  'flush();',
  'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
  'let buf = "";',
  'process.stdin.on("data", (chunk) => {',
  '  buf += chunk.toString("utf8");',
  '  let nl;',
  '  while ((nl = buf.indexOf("\\n")) >= 0) {',
  '    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);',
  '    if (!line.trim()) continue;',
  '    let m; try { m = JSON.parse(line); } catch { continue; }',
  '    if (m.type === "get_state") out({ type: "response", command: "get_state", data: { sessionId: "s6-uuid" } });',
  '    else if (m.type === "get_session_stats") out({ type: "response", command: "get_session_stats", id: m.id, data: { tokens: { input: 1, output: 1, cacheRead: 0 } } });',
  '    else if (m.type === "prompt") { out({ type: "response", command: "prompt" });',
  '      out({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] }); }',
  '    else if (m.type === "abort") out({ type: "response", command: "abort" });',
  '  }',
  '});',
  'process.stdin.resume();',
  '',
].join("\n"));
process.env.PIBOT_PI_CLI = STUB_PI;

const { handleInbound } = await import("../scripts/pi-bots/bridge.mjs");
const { runJob } = await import("../scripts/pi-bots/job_runner.mjs");
const { effectiveReadPaths, parseReadPathsInput, isValidReadPath } = await import("../scripts/pi-bots/bot-read-paths.mjs");
const { mcpConfigDelivery, MCP_CONFIG_FD } = await import("../scripts/pi-bots/mcp-delivery.mjs");
const { checkPiLabCompat, findPiLabDir, MIN_PI_LAB_REV } = await import("../scripts/pi-bots/pi-lab-compat.mjs");
const { writeBotMcp } = await import("../scripts/pi-bots/mcp_writer.mjs");

// ---- fixture: two projects, three bots -------------------------------------
const W1 = join(dir, "projects", "alpha");       // bot A's project workspace
const W2 = join(dir, "projects", "beta");        // bot C's project workspace
const A_WORLD = join(W1, "bots", "bota");
const B_WORLD = join(process.env.CROW_HOME, "pi-bots", "botb"); // no project, no session_dir
const C_WORLD = join(W2, "bots", "botc");
const EXTRA = join(dir, "operator-notes");       // A's explicit read_paths entry

const baseDef = (crowMcp) => ({
  system_prompt: "You are a test bot.",
  models: { default: "stub/m1" },
  tools: { pi_builtin: ["read", "grep"], crow_mcp: crowMcp },
  permission_policy: { bash: "deny", write_paths: [] },
  gateways: [{ type: "gmail" }],
  tracker_config: { type: "none" }, // no tasks.db in this scratch instance
});

before(() => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO,
  });
  for (const d of [W1, W2, EXTRA]) mkdirSync(d, { recursive: true });
  const c = new Database(DB_FILE);
  c.prepare("INSERT INTO project_spaces (id, slug, name, workspace_dir) VALUES (?,?,?,?)").run(101, "alpha", "Alpha", W1);
  c.prepare("INSERT INTO project_spaces (id, slug, name, workspace_dir) VALUES (?,?,?,?)").run(102, "beta", "Beta", W2);
  const ins = c.prepare("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,?,?)");
  const defA = baseDef(["marker-srv/x"]);
  defA.permission_policy.read_paths = [EXTRA, "relative/junk"]; // junk is dropped at spawn
  ins.run("bota", "Bot A", JSON.stringify(defA), 1, 101);
  ins.run("botb", "Bot B", JSON.stringify(baseDef([])), 1, null);
  ins.run("botc", "Bot C", JSON.stringify(baseDef([])), 1, 102);
  c.close();
});

after(() => { rmSync(dir, { recursive: true, force: true }); });

let capFile = null;
function arm(leg) {
  capFile = join(dir, "cap-" + leg + ".json");
  if (existsSync(capFile)) rmSync(capFile);
  process.env.PIBOT_TEST_CAPTURE = capFile;
}
const readCap = () => JSON.parse(readFileSync(capFile, "utf8"));

async function channelTurn(botId, leg) {
  arm(leg);
  let r;
  try { r = await handleInbound({
    bot_id: botId, gateway_thread_id: "t-" + leg, gateway_type: "gmail", user_message: "hi",
    sendReply: async () => {}, log: () => {},
  }); } catch (e) { throw new Error("handleInbound threw: " + e.message + "\n" + e.stack); }
  assert.equal(r.action, "asked", "the turn completed against the stub (" + JSON.stringify(r) + ")");
  return readCap();
}

/** pi-lab's botReadRoots(), from what the child was actually handed. */
function readRootsOf(cap) {
  const policy = JSON.parse(cap.env.PI_BOT_PERMISSION_POLICY);
  const roots = [cap.cwd];
  if (cap.env.PI_BOT_MCP_CONFIG) roots.push(dirname(cap.env.PI_BOT_MCP_CONFIG));
  if (Array.isArray(policy.write_paths)) roots.push(...policy.write_paths);
  if (Array.isArray(policy.read_paths)) roots.push(...policy.read_paths);
  return roots;
}
const under = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
const readable = (cap, p) => readRootsOf(cap).some((r) => under(p, r));

function findMcpJson(root) {
  const hits = [];
  const walk = (d) => {
    let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === ".mcp.json") hits.push(p);
    }
  };
  walk(root);
  return hits;
}

// ---- units -------------------------------------------------------------------

test("effectiveReadPaths: explicit entries kept, project workspace added only for a project bot, junk dropped", () => {
  const def = { permission_policy: { read_paths: ["/srv/notes/", "/srv/notes", "rel/x", "/a/../etc", 7] } };
  assert.deepEqual(effectiveReadPaths(def, { projectWorkspaceDir: "/w/alpha" }), ["/srv/notes", "/w/alpha"]);
  assert.deepEqual(effectiveReadPaths(def, {}), ["/srv/notes"], "no project => no workspace");
  assert.deepEqual(effectiveReadPaths({}, {}), [], "nothing explicit, no project => nothing");
  assert.deepEqual(effectiveReadPaths({}, { projectWorkspaceDir: "/w/alpha", extra: ["/world"] }), ["/w/alpha", "/world"]);
  const before = JSON.stringify(def);
  effectiveReadPaths(def, { projectWorkspaceDir: "/w" });
  assert.equal(JSON.stringify(def), before, "the stored def is never mutated");
});

test("parseReadPathsInput: one per line, absolute only, no '..', normalized + de-duplicated", () => {
  assert.deepEqual(parseReadPathsInput(" /a/b/ \n\n/a/b\n/c//d/./e\n"), { paths: ["/a/b", "/c/d/e"], invalid: [] });
  assert.deepEqual(parseReadPathsInput("notes\n/ok\n/x/../y\n~/home"), { paths: ["/ok"], invalid: ["notes", "/x/../y", "~/home"] });
  assert.deepEqual(parseReadPathsInput(undefined), { paths: [], invalid: [] });
  assert.equal(isValidReadPath("/a\0b"), false);
});

test("mcpConfigDelivery: explicit fd/file win; auto follows the pi-lab check", () => {
  assert.equal(mcpConfigDelivery({ env: { PIBOT_MCP_CONFIG_DELIVERY: "file" }, compat: () => ({ ok: true }) }), "file");
  assert.equal(mcpConfigDelivery({ env: { PIBOT_MCP_CONFIG_DELIVERY: "FD" }, compat: () => ({ ok: false }) }), "fd");
  assert.equal(mcpConfigDelivery({ env: {}, compat: () => ({ ok: true }) }), "fd");
  assert.equal(mcpConfigDelivery({ env: {}, compat: () => ({ ok: false }) }), "file", "an older pi-lab would ignore the fd");
  assert.equal(mcpConfigDelivery({ env: {}, compat: () => { throw new Error("x"); } }), "file");
  assert.equal(MCP_CONFIG_FD, 4);
});

test("pi-lab compat: declares c8bbb02; finds pi-lab via settings.json packages[]; feature markers decide without git", () => {
  assert.equal(MIN_PI_LAB_REV, "c8bbb02");
  const root = mkdtempSync(join(dir, "pilab-"));
  const agent = join(root, "agent");
  const lab = join(root, "pi-lab");
  mkdirSync(agent, { recursive: true });
  mkdirSync(join(lab, "extensions"), { recursive: true });
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: ["pkg/other", "../pi-lab"] }));
  writeFileSync(join(lab, "extensions", "mcp-client.ts"), "// old\n");
  writeFileSync(join(lab, "extensions", "permission-gating.ts"), "// old\n");
  const env = { PI_CODING_AGENT_DIR: agent, HOME: root };
  assert.equal(findPiLabDir({ env }), lab);
  const old = checkPiLabCompat({ env });
  assert.equal(old.ok, false);
  assert.match(old.reason, /predates c8bbb02/);
  writeFileSync(join(lab, "extensions", "mcp-client.ts"), 'export const BOT_MCP_CONFIG_FD_ENV = "PI_BOT_MCP_CONFIG_FD";\n');
  writeFileSync(join(lab, "extensions", "permission-gating.ts"), "read_paths?: string[];\n");
  assert.deepEqual(checkPiLabCompat({ env }), { ok: true, dir: lab, how: "markers", reason: null });
  const none = checkPiLabCompat({ env: { PI_CODING_AGENT_DIR: join(root, "nope"), HOME: root } });
  assert.equal(none.ok, false);
  assert.match(none.reason, /not found/);
});

test("writeBotMcp write:false builds the config, writes nothing, removes a stale file", () => {
  const sd = mkdtempSync(join(dir, "wb-"));
  writeFileSync(join(sd, ".mcp.json"), '{"stale":true}');
  const r = writeBotMcp(baseDef(["marker-srv/x"]), { sessionDir: sd, crowHome: process.env.CROW_HOME, write: false });
  assert.equal(r.path, null);
  assert.equal(r.removedStale, true);
  assert.ok(r.json && r.json.mcpServers && r.json.mcpServers["marker-srv"], "the built config is returned");
  assert.ok(!existsSync(join(sd, ".mcp.json")), "no file left behind");
  const w = writeBotMcp(baseDef([]), { sessionDir: sd, crowHome: process.env.CROW_HOME });
  assert.equal(w.path, join(sd, ".mcp.json"), "default still writes (file mode unchanged)");
  assert.ok(existsSync(w.path));
  rmSync(sd, { recursive: true, force: true }); // the acceptance scan below must see only bot worlds
});

// ---- acceptance: two bots, fd mode ------------------------------------------

test("ACCEPTANCE (fd): bot A's read roots cover its own world + project + explicit folder, and exclude bot B's and bot C's worlds", async () => {
  process.env.PIBOT_MCP_CONFIG_DELIVERY = "fd";
  // A stale file-mode config in A's world must be gone after an fd turn.
  mkdirSync(A_WORLD, { recursive: true });
  writeFileSync(join(A_WORLD, ".mcp.json"), '{"mcpServers":{"stale":{"command":"x"}}}');

  const a = await channelTurn("bota", "a-fd");
  const b = await channelTurn("botb", "b-fd");
  const c = await channelTurn("botc", "c-fd");

  // delivery: fd only, consumed to EOF, then gone; nothing on disk
  for (const [name, cap] of [["A", a], ["B", b], ["C", c]]) {
    assert.equal(cap.env.PI_BOT_MCP_CONFIG_FD, "4", name + ": config over fd 4");
    assert.equal(cap.env.PI_BOT_MCP_CONFIG, undefined, name + ": no config FILE variable in fd mode");
    assert.equal(cap.fdErr, null, name + ": fd 4 readable");
    assert.ok(cap.cfgText && JSON.parse(cap.cfgText).mcpServers, name + ": the whole config arrived (EOF => bridge closed its end)");
    assert.equal(cap.fdGoneAfterClose, true, name + ": the fd is consumed — closed after the one read");
    assert.equal(cap.mcpJsonInCwd, false, name + ": no .mcp.json in the spawn cwd");
  }
  assert.deepEqual(findMcpJson(dir), [], "no .mcp.json anywhere under the instance (stale A file removed too)");

  // per-bot delivery: A selected marker-srv, B did not
  const aCfg = JSON.parse(a.cfgText), bCfg = JSON.parse(b.cfgText);
  assert.ok(aCfg.mcpServers["marker-srv"] && !aCfg.mcpServers["marker-srv"].disabled, "A got its own server");
  assert.ok(!bCfg.mcpServers["marker-srv"] || bCfg.mcpServers["marker-srv"].disabled, "B did not get A's server");

  // read roots (pi-lab botReadRoots over what the child was handed)
  const aPolicy = JSON.parse(a.env.PI_BOT_PERMISSION_POLICY);
  assert.deepEqual(aPolicy.read_paths, [EXTRA, W1], "explicit (junk dropped) + project workspace");
  assert.equal(a.cwd, A_WORLD);
  assert.ok(readable(a, join(A_WORLD, "notes.md")), "A reads its own world");
  assert.ok(readable(a, join(W1, "docs", "plan.md")), "A reads its project workspace");
  assert.ok(readable(a, join(EXTRA, "x.txt")), "A reads its explicit folder");
  for (const p of [B_WORLD, join(B_WORLD, "sessions", "t.jsonl"), join(B_WORLD, ".mcp.json"),
                   C_WORLD, join(C_WORLD, "notes.md"), W2, process.env.CROW_HOME, dir]) {
    assert.equal(readable(a, p), false, "A must not reach " + p);
  }

  const bPolicy = JSON.parse(b.env.PI_BOT_PERMISSION_POLICY);
  assert.equal(bPolicy.read_paths, undefined, "a bot with no project and no explicit folders gets no read_paths");
  assert.equal(b.cwd, B_WORLD);
  for (const p of [A_WORLD, W1, EXTRA, C_WORLD, W2]) assert.equal(readable(b, p), false, "B must not reach " + p);

  const cPolicy = JSON.parse(c.env.PI_BOT_PERMISSION_POLICY);
  assert.deepEqual(cPolicy.read_paths, [W2], "C gets ITS project, never A's");
  for (const p of [A_WORLD, W1, B_WORLD, EXTRA]) assert.equal(readable(c, p), false, "C must not reach " + p);
});

test("ACCEPTANCE (fd): a background job writes no /tmp/pibot-job-*/.mcp.json and keeps the project read root", async () => {
  process.env.PIBOT_MCP_CONFIG_DELIVERY = "fd";
  arm("job-a");
  const r = await runJob({ job_id: "job-s6", bot_id: "bota", goal: "do it", escalate: 0 }, { log: () => {} });
  assert.equal(r.result, "ok");
  const cap = readCap();
  assert.match(cap.cwd, /pibot-job-/);
  assert.equal(cap.env.PI_BOT_MCP_CONFIG_FD, "4");
  assert.equal(cap.env.PI_BOT_MCP_CONFIG, undefined);
  assert.equal(cap.mcpJsonInCwd, false, "the job dir holds no config file");
  assert.ok(JSON.parse(cap.cfgText).mcpServers["marker-srv"], "the job's bot still gets its tools");
  assert.equal(cap.fdGoneAfterClose, true);
  assert.deepEqual(JSON.parse(cap.env.PI_BOT_PERMISSION_POLICY).read_paths, [EXTRA, W1]);
  assert.equal(readable(cap, B_WORLD), false);
});

test("FALLBACK (file): PIBOT_MCP_CONFIG_DELIVERY=file keeps the pre-S6 file + env, never the fd", async () => {
  process.env.PIBOT_MCP_CONFIG_DELIVERY = "file";
  try {
    const a = await channelTurn("bota", "a-file");
    assert.equal(a.env.PI_BOT_MCP_CONFIG, join(A_WORLD, ".mcp.json"));
    assert.equal(a.env.PI_BOT_MCP_CONFIG_FD, undefined);
    assert.equal(a.mcpJsonAtEnvPath, true, "the file exists when pi starts");
    assert.equal(a.cfgText, null);
    assert.deepEqual(JSON.parse(a.env.PI_BOT_PERMISSION_POLICY).read_paths, [EXTRA, W1],
      "read_paths are sent in file mode too (an older pi-lab ignores the key)");
  } finally {
    process.env.PIBOT_MCP_CONFIG_DELIVERY = "fd";
  }
});

test("PiRpc: fd mode with a chosen cwd adds the world root to read_paths; bypass reads '/'; a stray FD var never leaks into file mode", async () => {
  const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");
  const world = mkdtempSync(join(dir, "pirpc-world-"));
  const chosen = mkdtempSync(join(dir, "pirpc-cwd-"));
  const def = { tools: { pi_builtin: ["read"] }, permission_policy: { bash: "deny", write_paths: [] } };
  const resolved = { provider: "stub", model: "m1", key: "stub/m1" };
  const spawnOnce = async (leg, opts) => {
    arm(leg);
    const pi = new PiRpc(Object.assign({ def, sessionDir: world, resolved, nodeBin: process.execPath, cliPath: STUB_PI }, opts));
    try { await pi.getState(); } finally { await pi.close(); }
    return readCap();
  };
  const fd = await spawnOnce("pirpc-fd", { cwd: chosen, mcpDelivery: "fd", mcpConfig: { mcpServers: { z: { command: "y" } } } });
  assert.deepEqual(JSON.parse(fd.env.PI_BOT_PERMISSION_POLICY).read_paths, [world],
    "with no PI_BOT_MCP_CONFIG the world root (uploads/outputs) must still be a read root");
  assert.deepEqual(JSON.parse(fd.cfgText), { mcpServers: { z: { command: "y" } } });

  const empty = await spawnOnce("pirpc-empty", { mcpDelivery: "fd", mcpConfig: null });
  assert.deepEqual(JSON.parse(empty.cfgText), { mcpServers: {} }, "an unbuildable config is an empty bot layer, never a stale file");
  assert.equal(JSON.parse(empty.env.PI_BOT_PERMISSION_POLICY).read_paths, undefined, "cwd === world root: nothing added");

  const bypass = await spawnOnce("pirpc-bypass", { mcpDelivery: "fd", mcpConfig: {}, permissionMode: "bypass", projectWorkspaceDir: "/w" });
  assert.deepEqual(JSON.parse(bypass.env.PI_BOT_PERMISSION_POLICY).read_paths, ["/"]);

  process.env.PI_BOT_MCP_CONFIG_FD = "9";
  try {
    const file = await spawnOnce("pirpc-file", {});
    assert.equal(file.env.PI_BOT_MCP_CONFIG_FD, undefined, "file mode strips an inherited FD variable");
    assert.equal(file.env.PI_BOT_MCP_CONFIG, join(world, ".mcp.json"));
  } finally {
    delete process.env.PI_BOT_MCP_CONFIG_FD;
  }
});

test("Bot Builder: invalid read folders refuse the save; the field round-trips (parse contract)", () => {
  // The handler maps parseReadPathsInput().invalid to an error redirect and
  // stores .paths; pinned here at the parse seam (the handler is exercised
  // by the i18n/csrf suites for shape).
  const ok = parseReadPathsInput("/home/u/notes\n/home/u/notes/\n");
  assert.deepEqual(ok, { paths: ["/home/u/notes"], invalid: [] });
  const bad = parseReadPathsInput("/home/u/notes\nDocuments");
  assert.deepEqual(bad.invalid, ["Documents"]);
});

/**
 * Phase 1 bot↔project shares, Task 10 — workspace-file reach at spawn.
 *
 * A share row grants a bot a project at `read` or `read_write`. What a bot's
 * NATIVE FILE TOOLS can reach is decided by the read_paths/write_paths pi is
 * spawned with. The share's `project_spaces.workspace_dir` is NOT one root: its
 * top-level entries are granted one by one, so
 *
 *   - every top-level entry of the workspace is a read root (either level);
 *   - it is a write root as well, ONLY for `read_write`;
 *   - the workspace's own `bots` subtree is NEVER granted: every bot homed at
 *     that project keeps its engine state (sessions/, outputs/, .pi/,
 *     .mcp.json with signed actor headers) under <workspace_dir>/bots/<id>, so
 *     a shared root there would expose — and let a read_write bot rewrite —
 *     other bots' sessions. The `bots` tree is an ALLOWLIST: it may contain no
 *     link at all except Crow's own moved-bot link, a direct child
 *     `<workspace>/bots/<id>` -> `<projectsRoot>/<slug>/workspace/bots/<id>`
 *     whose target name is its own; every other link in that tree — a bot home
 *     linked to a legacy root, a carried-over `sessions`/`.pi`/`outputs`/`.mcp.json`
 *     entry, a link deeper inside a bot home, a dangling link — refuses the whole
 *     share's roots with one warning, and so does an accepted link whose target
 *     subtree holds a link (or a tree the walk could not finish).
 *
 * The workspace's OTHER top-level entries are walked the same way (bounded, never
 * following a link): a link inside one is harmless — a `.venv`'s system-python
 * and `lib64 -> lib` links, a dangling link — unless its realpath lands in
 * another project (or this project's bots tree), inside the Crow home, or inside
 * the data directory outside this workspace. Such an entry is not granted (one
 * line names the reason) and its siblings still are.
 *
 * A suspended share (either side has an outside member), a revoked one, one
 * whose project is archived/tombstoned, one with no workspace_dir, one whose
 * workspace_dir is a dangerous root (/, the user's home or a parent of it, the
 * Crow home or above, anything under <crowHome>/secrets), and one whose
 * workspace_dir — or any entry it would contribute — does not really sit under
 * the instance's projects area (a missing dir, a dir elsewhere, a symlink that
 * resolves out) add nothing. None of them may break a spawn.
 *
 * The boundary this file pins (and the code documents): file-system reach
 * follows the share at the NEXT SPAWN, because pi's roots are fixed when the
 * child starts. The MCP tools are a different path — rechecked on every call
 * (servers/shared/project-bot-shares.js resolveBotAccess), covered by the
 * share-store suites, not here.
 *
 * Hermetic: CROW_DATA_DIR/CROW_HOME/HOME are scratch, the bot engine is a stub.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

// Hermetic env: an ambient PI_*/PIBOT_* var would otherwise reach the stub.
for (const k of Object.keys(process.env)) {
  if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];
}

const dir = realpathSync(mkdtempSync(join(tmpdir(), "share-roots-")));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
// No sandbox wrapper: the stub must be the process pi is handed.
process.env.CROW_PI_SANDBOX = "off";
process.env.PIBOT_MAX_PI = "99";
process.env.PIBOT_WARM_GATEWAY_URL = "http://127.0.0.1:1";
process.env.PIBOT_WARM_TIMEOUT_MS = "1500";
process.env.PIBOT_PROMPT_ACK_TIMEOUT_MS = "8000";
process.env.PIBOT_TURN_TIMEOUT_MS = "8000";
process.env.PI_MODELS_JSON = join(dir, "models.json");
mkdirSync(join(process.env.CROW_HOME, "skills"), { recursive: true });
writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({ providers: { stub: { models: [{ id: "m1" }] } } }));
// mcp_writer pins the canonical config path at module load; give it a scratch
// HOME with a readable one.
process.env.HOME = join(dir, "fakehome");
mkdirSync(join(process.env.HOME, ".pi", "agent"), { recursive: true });
writeFileSync(join(process.env.HOME, ".pi", "agent", "mcp.json"), JSON.stringify({ mcpServers: {} }));

const DB_FILE = join(dir, "crow.db");
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

// ---- the recording protocol stub -------------------------------------------
const STUB_PI = join(dir, "stub-pi.mjs");
writeFileSync(STUB_PI, [
  'import { writeFileSync, readFileSync, closeSync } from "node:fs";',
  'const env = {};',
  'for (const k of Object.keys(process.env).sort()) if (/^(PI_|PIBOT_)/.test(k)) env[k] = process.env[k];',
  'const cap = { argv: process.argv.slice(2), env, cwd: process.cwd(), cfgText: null };',
  'const fdKey = process.env.PI_BOT_MCP_CONFIG_FD;',
  'if (fdKey) { try { cap.cfgText = readFileSync(Number(fdKey), "utf8"); } catch { cap.cfgText = null; }',
  '  try { closeSync(Number(fdKey)); } catch {} }',
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
  '    if (m.type === "get_state") out({ type: "response", command: "get_state", data: { sessionId: "share-uuid" } });',
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

const { handleInbound, PiRpc, loadBotShares } = await import("../scripts/pi-bots/bridge.mjs");
const {
  buildBotWorld, prepareSpawn, shareWorkspaceRoots, botsHoldout,
  BOTS_TREE_MAX_DEPTH, BOTS_TREE_MAX_ENTRIES, SHARE_ENTRY_MAX_DEPTH, SHARE_ENTRY_MAX_ENTRIES,
} = await import("../scripts/pi-bots/bot-world.mjs");
const { effectiveReadPaths } = await import("../scripts/pi-bots/bot-read-paths.mjs");
const { buildContainPlan, ContainRefused } = await import("../scripts/pi-bots/pi_contain.mjs");
const { createInteractiveEngine, _resetInteractiveEngineForTest } = await import("../servers/gateway/perch-interactive.js");

// ---- fixture ----------------------------------------------------------------
// The instance's projects area (bot-world/job_runner pass exactly this root): a
// share workspace is a root only when it really sits under it.
const PROJECTS_ROOT = join(dir, "projects");
const ws = (name) => join(PROJECTS_ROOT, name, "workspace");
const W_HOME = ws("home");
const W_X = ws("shared-x");
const W_ARCH = ws("archived");
const W_TOMB = ws("tombstoned");
const W_SUSP = ws("suspended");

const P_HOME = 201, P_X = 202, P_ARCH = 203, P_TOMB = 204, P_NOWS = 205, P_SUSP = 206, P_HOMELINK = 207;
// A workspace_dir that is a symlink to the (scratch) user's home: a path-level
// denylist sees nothing wrong with it, the realpath allowlist must refuse it.
const W_HOMELINK = join(PROJECTS_ROOT, "link-to-home");

const baseDef = () => ({
  system_prompt: "You are a test bot.",
  models: { default: "stub/m1" },
  tools: { pi_builtin: ["read"], crow_mcp: [] },
  permission_policy: { bash: "deny", write_paths: [] },
  gateways: [{ type: "gmail" }],
  tracker_config: { type: "none" },
});

before(() => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO,
  });
  for (const d of [W_HOME, W_X, W_ARCH, W_TOMB, W_SUSP]) mkdirSync(d, { recursive: true });
  // The shared project's own top-level entries: each one is granted to a share
  // on its own. `bots/` is X's engine state (every bot homed at X lives there)
  // and is never granted.
  mkdirSync(join(W_X, "docs"), { recursive: true });
  writeFileSync(join(W_X, "docs", "index.md"), "# Shared\n");
  writeFileSync(join(W_X, "data.csv"), "a,b\n");
  mkdirSync(join(W_X, "bots", "other", "sessions"), { recursive: true });
  writeFileSync(join(W_X, "bots", "other", "sessions", "x.jsonl"), "{}\n");
  // A plain entry with nothing behind it: a symlink that resolves outside the
  // workspace is not reachable through the share either.
  const c = new Database(DB_FILE);
  const proj = c.prepare("INSERT INTO project_spaces (id, slug, name, workspace_dir, status, archived_at) VALUES (?,?,?,?,?,?)");
  proj.run(P_HOME, "home", "Home", W_HOME, "active", null);
  proj.run(P_X, "shared-x", "Shared X", W_X, "active", null);
  proj.run(P_ARCH, "archived-one", "Archived One", W_ARCH, "archived", null);
  proj.run(P_TOMB, "tombstoned-one", "Tombstoned One", W_TOMB, "active", "2026-01-01 00:00:00");
  proj.run(P_NOWS, "no-workspace", "No Workspace", null, "active", null);
  proj.run(P_SUSP, "suspended-one", "Suspended One", W_SUSP, "active", null);
  symlinkSync(process.env.HOME, W_HOMELINK);
  proj.run(P_HOMELINK, "link-to-home", "Link To Home", W_HOMELINK, "active", null);

  const ins = c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,?,?)");
  const def = (id) => JSON.stringify({ ...baseDef(), session_dir: join(dir, "bots", id) });
  for (const id of ["reader", "writer", "suspended", "arch", "tomb", "nows", "revoked", "nothing", "deadbot", "homelink"]) {
    ins.run(id, id, def(id), 1, P_HOME);
  }
  // A def whose permission_policy names no write_paths at all (M6): an empty
  // extraWritePaths must not add the key to the spawn policy.
  ins.run("plainbot", "plainbot", JSON.stringify({
    system_prompt: "You are a test bot.",
    models: { default: "stub/m1" },
    tools: { pi_builtin: ["read"], crow_mcp: [] },
    permission_policy: { bash: "deny" },
    gateways: [{ type: "gmail" }],
    tracker_config: { type: "none" },
    session_dir: join(dir, "bots", "plainbot"),
  }), 1, P_HOME);
  ins.run("homeless", "homeless", def("homeless"), 1, null);

  // An outside member on the project the "suspended" bot is shared: while that
  // row is active the share is suspended on the PROJECT side.
  c.prepare("INSERT INTO contacts (id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (?,?,?,?,?)")
    .run(9001, "crow-guest", "Guest", "ed25519-fixture", "secp-fixture");
  c.prepare("INSERT INTO project_members (project_id, contact_id, role) VALUES (?,?,?)").run(P_SUSP, 9001, "editor");

  const share = c.prepare("INSERT INTO project_bot_shares (project_id, bot_id, level, revoked_at) VALUES (?,?,?,?)");
  share.run(P_X, "reader", "read", null);
  share.run(P_X, "writer", "read_write", null);
  share.run(P_SUSP, "suspended", "read", null);
  share.run(P_ARCH, "arch", "read", null);
  share.run(P_TOMB, "tomb", "read", null);
  share.run(P_NOWS, "nows", "read_write", null);
  share.run(P_HOMELINK, "homelink", "read_write", null);
  share.run(P_X, "revoked", "read", "2026-01-02 00:00:00");
  share.run(P_X, "deadbot", "read", null);
  c.close();
});

after(() => { rmSync(dir, { recursive: true, force: true }); });

beforeEach(() => { if (_resetInteractiveEngineForTest) _resetInteractiveEngineForTest(); });

let capFile = null;
function arm(leg) {
  capFile = join(dir, "cap-" + leg + ".json");
  if (existsSync(capFile)) rmSync(capFile);
  process.env.PIBOT_TEST_CAPTURE = capFile;
}
const readCap = () => JSON.parse(readFileSync(capFile, "utf8"));
const policyOf = (cap) => JSON.parse(cap.env.PI_BOT_PERMISSION_POLICY);

// What a share of W_X contributes: one root per top-level entry, never `bots`,
// never the workspace itself.
const X_ROOTS = [join(W_X, "data.csv"), join(W_X, "docs")];
const BOTS_SUBTREE = join(W_X, "bots");
const OTHER_BOT_SESSION = join(W_X, "bots", "other", "sessions", "x.jsonl");
const sorted = (xs) => [...(xs || [])].sort();
/** Does any root in `roots` cover `p`? (pi-lab's own rule: equal, or under it.) */
const coversPath = (roots, p) => (roots || []).some((r) => p === r || p.startsWith(r.endsWith("/") ? r : r + "/"));

/** One real channel turn; returns what pi was handed. */
async function channelTurn(botId, leg) {
  arm(leg);
  const r = await handleInbound({
    bot_id: botId, gateway_thread_id: "t-" + leg, gateway_type: "gmail", user_message: "hi",
    sendReply: async () => {}, log: () => {},
  });
  assert.equal(r.action, "asked", "the turn completed against the stub: " + JSON.stringify(r));
  return readCap();
}

/** A direct PiRpc spawn (the permissionMode bypass seam channel turns never set). */
async function directSpawn(leg, opts) {
  arm(leg);
  const pi = new PiRpc(Object.assign({
    nodeBin: process.execPath, cliPath: STUB_PI,
  }, opts));
  try { await pi.getState(); } finally { try { await pi.close(); } catch { /* exiting */ } }
  return readCap();
}

// ---------------------------------------------------------------------------
// loadBotShares — the spend-side read of the share tables
// ---------------------------------------------------------------------------

test("loadBotShares returns the live shares with name, level, workspace_dir and suspension", () => {
  assert.deepEqual(loadBotShares("reader"), [
    { project_id: P_X, level: "read", workspace_dir: W_X, name: "Shared X", suspended: false },
  ]);
  assert.deepEqual(loadBotShares("writer"), [
    { project_id: P_X, level: "read_write", workspace_dir: W_X, name: "Shared X", suspended: false },
  ]);
  const susp = loadBotShares("suspended");
  assert.equal(susp.length, 1);
  assert.equal(susp[0].project_id, P_SUSP);
  assert.equal(susp[0].suspended, true, "an outside member on the shared project suspends the share");
  assert.deepEqual(loadBotShares("nothing"), []);
  assert.deepEqual(loadBotShares("no-such-bot"), []);
  assert.deepEqual(loadBotShares(null), []);
});

test("loadBotShares leaves out a revoked share, an archived project, a tombstoned project, and a dead bot def", () => {
  assert.deepEqual(loadBotShares("revoked"), [], "revoked_at set => not live");
  assert.deepEqual(loadBotShares("arch"), [], "status='archived' => no access");
  assert.deepEqual(loadBotShares("tomb"), [], "archived_at set => no access");
  const c = new Database(DB_FILE);
  c.prepare("DELETE FROM pi_bot_defs WHERE bot_id = ?").run("deadbot");
  c.close();
  assert.deepEqual(loadBotShares("deadbot"), [], "a share whose bot def is gone resolves to nothing");
  // ...and the row itself is untouched, so re-creating the bot would not silently inherit it.
  const c2 = new Database(DB_FILE);
  assert.equal(c2.prepare("SELECT COUNT(*) AS n FROM project_bot_shares WHERE bot_id='deadbot'").get().n, 1);
  c2.close();
});

test("loadBotShares never throws: a missing table (older DB) is 'no shares'", () => {
  const c = new Database(DB_FILE);
  c.exec("ALTER TABLE project_bot_shares RENAME TO project_bot_shares_gone");
  c.close();
  try {
    assert.deepEqual(loadBotShares("reader"), []);
  } finally {
    const c2 = new Database(DB_FILE);
    c2.exec("ALTER TABLE project_bot_shares_gone RENAME TO project_bot_shares");
    c2.close();
  }
  assert.equal(loadBotShares("reader").length, 1, "and the live row is back afterwards");
});

/** A share workspace with two ordinary top-level entries and a `bots` subtree. */
function shareFixture(name) {
  const d = ws("unit-" + name);
  mkdirSync(join(d, "docs"), { recursive: true });
  writeFileSync(join(d, "docs", "a.md"), "a\n");
  writeFileSync(join(d, "top.txt"), "t\n");
  mkdirSync(join(d, "bots", "other", "sessions"), { recursive: true });
  writeFileSync(join(d, "bots", "other", "sessions", "x.jsonl"), "{}\n");
  return d;
}
const fixtureRoots = (d) => [join(d, "docs"), join(d, "top.txt")];
const sortRoots = (r) => ({ read: sorted(r.read), write: sorted(r.write) });

test("shareWorkspaceRoots: one read root per top-level entry, a write root only for read_write, and nothing for a suspended/unusable row", () => {
  const one = shareFixture("one");
  const two = shareFixture("two");
  const three = shareFixture("three");
  assert.deepEqual(sortRoots(shareWorkspaceRoots([
    { project_id: 1, level: "read", workspace_dir: one, suspended: false },
    { project_id: 2, level: "read_write", workspace_dir: two, suspended: false },
  ], { projectsRoot: PROJECTS_ROOT })), {
    read: sorted([...fixtureRoots(one), ...fixtureRoots(two)]),
    write: sorted(fixtureRoots(two)),
  });
  assert.deepEqual(shareWorkspaceRoots([
    { project_id: 3, level: "read_write", workspace_dir: three, suspended: true },
    { project_id: 4, level: "read_write", workspace_dir: null, suspended: false },
    { project_id: 5, level: "read", workspace_dir: "relative/dir", suspended: false },
  ], { projectsRoot: PROJECTS_ROOT }), { read: [], write: [] });
  assert.deepEqual(shareWorkspaceRoots([], { projectsRoot: PROJECTS_ROOT }), { read: [], write: [] });
  assert.deepEqual(shareWorkspaceRoots(null, { projectsRoot: PROJECTS_ROOT }), { read: [], write: [] });
});

test("shareWorkspaceRoots: the bots subtree is never a root, and neither is the workspace itself", () => {
  const d = shareFixture("no-bots");
  const r = shareWorkspaceRoots([{ project_id: 7, level: "read_write", workspace_dir: d, suspended: false }],
    { projectsRoot: PROJECTS_ROOT });
  assert.equal(coversPath(r.read, join(d, "bots")), false, "no read root covers <ws>/bots");
  assert.equal(coversPath(r.read, join(d, "bots", "other", "sessions", "x.jsonl")), false,
    "another bot's transcript is out of reach");
  assert.equal(coversPath(r.write, join(d, "bots")), false, "no write root covers <ws>/bots");
  assert.equal(coversPath(r.read, d), false, "the workspace itself is not a root");
  for (const root of fixtureRoots(d)) {
    assert.ok(coversPath(r.read, root), "the top-level entry " + root + " is readable");
    assert.ok(coversPath(r.write, root), "...and writable for read_write");
  }
  assert.equal(r.read.includes(join(d, "bots")), false);
  assert.equal(r.write.includes(join(d, "bots")), false);
});

test("shareWorkspaceRoots: a symlink that leaves the workspace (or points into bots) is not granted", () => {
  const d = shareFixture("links");
  // A neighbour INSIDE the projects area: this test is about the workspace rule,
  // the projects-root allowlist is the next test's subject.
  const outside = ws("unit-neighbour");
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(d, "escape"));
  symlinkSync(join(d, "bots"), join(d, "bots-alias"));
  const r = shareWorkspaceRoots([{ project_id: 8, level: "read_write", workspace_dir: d, suspended: false }],
    { projectsRoot: PROJECTS_ROOT });
  assert.equal(coversPath(r.read, join(d, "escape")), false, "a link out of the workspace is not a root");
  assert.equal(coversPath(r.write, join(d, "escape")), false);
  assert.equal(coversPath(r.read, join(d, "bots-alias")), false, "a link to the bots subtree is not a root");
  assert.equal(coversPath(r.write, join(d, "bots-alias")), false);
  for (const root of fixtureRoots(d)) assert.ok(coversPath(r.read, root), root);
});

test("shareWorkspaceRoots: a link to the workspace itself, or into its bots subtree, is not a root", () => {
  const d = shareFixture("self-links");
  const real = realpathSync(d);
  // self -> . and an absolute link to the workspace's own realpath: either would put the workspace
  // (and everything under it, bots included) back in reach as one root.
  symlinkSync(".", join(d, "self-rel"));
  symlinkSync(real, join(d, "self-abs"));
  // bots-alias -> bots, and a link straight into one bot's sessions directory.
  symlinkSync(join(d, "bots"), join(d, "bots-alias"));
  symlinkSync(join(d, "bots", "other", "sessions"), join(d, "sessions-alias"));
  // A link that leaves the workspace altogether.
  const outside = ws("unit-neighbour-self");
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(d, "escape"));
  // A plain directory and a link to a sibling directory inside the workspace are fine.
  symlinkSync(join(d, "docs"), join(d, "docs-alias"));

  const r = shareWorkspaceRoots([{ project_id: 12, level: "read_write", workspace_dir: d, suspended: false }],
    { projectsRoot: PROJECTS_ROOT });

  for (const name of ["self-rel", "self-abs"]) {
    assert.equal(coversPath(r.read, d), false, name + ": the workspace itself is not covered");
    assert.equal(coversPath(r.read, join(d, name)), false, name + " is not a read root");
    assert.equal(coversPath(r.write, join(d, name)), false, name + " is not a write root");
  }
  assert.equal(r.read.includes(real), false, "the workspace realpath is never a granted entry");
  assert.equal(r.write.includes(real), false);
  for (const name of ["bots-alias", "sessions-alias"]) {
    assert.equal(coversPath(r.read, join(d, name)), false, name + ": the bots subtree stays out");
    assert.equal(coversPath(r.write, join(d, name)), false);
  }
  assert.equal(coversPath(r.read, join(d, "bots")), false, "no root covers <ws>/bots");
  assert.equal(coversPath(r.read, join(d, "bots", "other", "sessions", "x.jsonl")), false,
    "another bot's transcript stays out of reach");
  assert.equal(r.read.includes(join(d, "bots")), false, "the bots realpath is not a root");
  assert.equal(coversPath(r.read, join(d, "escape")), false, "a link out of the workspace is not a root");
  assert.equal(coversPath(r.read, outside), false);

  // A granted entry is the entry's REALPATH: the plain dir, the sibling link, the plain file.
  assert.deepEqual(sortRoots(r), {
    read: sorted([realpathSync(join(d, "docs")), join(d, "top.txt")]),
    write: sorted([realpathSync(join(d, "docs")), join(d, "top.txt")]),
  });
  assert.equal(r.read.includes(join(d, "docs-alias")), false, "the link's own path is not the root");
});

test("shareWorkspaceRoots: a `bots` symlink refuses the whole share's roots, with one warning", () => {
  // `<ws>/bots` itself a link: the bots home is not the directory the share's own entries were
  // listed from, so there is no tree this share can hold out with confidence. Fail closed.
  const d = ws("unit-bots-link");
  mkdirSync(join(d, ".state", "bots", "other", "sessions"), { recursive: true });
  writeFileSync(join(d, ".state", "bots", "other", "sessions", "x.jsonl"), "{}\n");
  symlinkSync(".state", join(d, "bots"));
  symlinkSync(".state", join(d, "state-alias"));
  mkdirSync(join(d, "docs"), { recursive: true });
  writeFileSync(join(d, "docs", "a.md"), "a\n");
  writeFileSync(join(d, "top.txt"), "t\n");
  const otherSession = join(realpathSync(join(d, ".state")), "bots", "other", "sessions", "x.jsonl");

  const said = [];
  const r = shareWorkspaceRoots([{ project_id: 13, level: "read_write", workspace_dir: d, suspended: false }],
    { projectsRoot: PROJECTS_ROOT, log: (m) => said.push(m) });

  assert.deepEqual(r, { read: [], write: [] }, "a symlinked bots tree grants nothing for the workspace");
  assert.equal(said.length, 1, "exactly one warning line: " + JSON.stringify(said));
  assert.equal(coversPath(r.read, otherSession), false, "another bot's transcript stays out of reach");
  assert.equal(r.read.includes(realpathSync(d)), false, "nor is the workspace itself ever a root");
});

test("shareWorkspaceRoots: a bot home under `<ws>/bots` that is a symlink refuses the whole share, with one warning", () => {
  // `<ws>/bots/<id>` links to `<ws>/elsewhere`: `elsewhere` is an ordinary top-level entry, so
  // granting it as a root would hand the bot the state the linked bot home keeps there.
  const d = ws("unit-bot-home-link");
  mkdirSync(join(d, "docs"), { recursive: true });
  writeFileSync(join(d, "docs", "a.md"), "a\n");
  writeFileSync(join(d, "top.txt"), "t\n");
  mkdirSync(join(d, "elsewhere", "sessions"), { recursive: true });
  writeFileSync(join(d, "elsewhere", "sessions", "x.jsonl"), "{}\n");
  mkdirSync(join(d, "bots", "plain"), { recursive: true });
  symlinkSync(join(d, "elsewhere"), join(d, "bots", "linked"));

  const clean = shareFixture("clean-alongside");
  const said = [];
  const r = shareWorkspaceRoots([
    { project_id: 15, level: "read_write", workspace_dir: d, suspended: false },
    { project_id: 16, level: "read", workspace_dir: clean, suspended: false },
  ], { projectsRoot: PROJECTS_ROOT, log: (m) => said.push(m) });

  assert.equal(coversPath(r.read, join(d, "elsewhere")), false, "the link's target is not a read root");
  assert.equal(coversPath(r.write, join(d, "elsewhere")), false);
  for (const name of ["docs", "top.txt"]) {
    assert.equal(coversPath(r.read, join(d, name)), false, name + " is not granted either: the share fails closed");
  }
  assert.deepEqual(sortRoots(r), { read: sorted(fixtureRoots(clean)), write: [] },
    "the other share in the same call still grants its own entries");
  assert.equal(said.length, 1, "exactly one warning line: " + JSON.stringify(said));
  assert.match(said[0], /symlink/);
});

test("shareWorkspaceRoots: a normal bots tree (real directories) grants the workspace's other entries", () => {
  const d = shareFixture("normal-bots");
  const said = [];
  const r = shareWorkspaceRoots([{ project_id: 14, level: "read_write", workspace_dir: d, suspended: false }],
    { projectsRoot: PROJECTS_ROOT, log: (m) => said.push(m) });
  assert.deepEqual(sortRoots(r), {
    read: sorted(fixtureRoots(d)),
    write: sorted(fixtureRoots(d)),
  });
  assert.deepEqual(said, [], "a normal bots tree says nothing");
});

test("shareWorkspaceRoots: a workspace with no bots directory grants its entries", () => {
  const d = ws("unit-no-bots-dir");
  mkdirSync(join(d, "docs"), { recursive: true });
  writeFileSync(join(d, "docs", "a.md"), "a\n");
  writeFileSync(join(d, "top.txt"), "t\n");
  const said = [];
  const r = shareWorkspaceRoots([{ project_id: 17, level: "read", workspace_dir: d, suspended: false }],
    { projectsRoot: PROJECTS_ROOT, log: (m) => said.push(m) });
  assert.deepEqual(sortRoots(r), { read: sorted(fixtureRoots(d)), write: [] });
  assert.deepEqual(said, []);
});

// ---------------------------------------------------------------------------
// the WHOLE bots tree is checked, not only its top level
// ---------------------------------------------------------------------------

/** shareWorkspaceRoots for one workspace, with the warning lines it emitted. */
function shareOf(d, projectId, level = "read_write", opts = {}) {
  const said = [];
  const r = shareWorkspaceRoots([{ project_id: projectId, level, workspace_dir: d, suspended: false }],
    { projectsRoot: PROJECTS_ROOT, ...opts, log: (m) => said.push(m) });
  return { r, said };
}

/** The share grants nothing at all, and says why once. */
function assertRefused(d, projectId, why) {
  const { r, said } = shareOf(d, projectId);
  assert.deepEqual(r, { read: [], write: [] }, "nothing granted for " + d);
  assert.equal(said.length, 1, "exactly one warning line: " + JSON.stringify(said));
  assert.match(said[0], why, "the warning names the reason: " + said[0]);
}

/** A share workspace whose ordinary entries are beside a bots tree `tamper` shapes. */
function botsTreeFixture(name, tamper) {
  const d = ws("unit-" + name);
  mkdirSync(join(d, "docs"), { recursive: true });
  writeFileSync(join(d, "docs", "a.md"), "a\n");
  writeFileSync(join(d, "top.txt"), "t\n");
  mkdirSync(join(d, "bots", "other"), { recursive: true });
  tamper(d, join(d, "bots", "other"));
  return d;
}

const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

test("shareWorkspaceRoots: a symlink nested inside a bot home (2 and 4 levels down) refuses the whole share", () => {
  // `<ws>/bots/<id>/sessions -> <ws>/data` is the same reach as a symlinked bot home: the bot's
  // transcripts now sit in an ordinary top-level entry this share would otherwise grant.
  const cases = [
    ["sessions", ["sessions"]],
    ["deep", ["a", "b", "c", "sessions"]],
  ];
  for (const [label, path] of cases) {
    const d = botsTreeFixture("nested-link-" + label, (root, home) => {
      mkdirSync(join(root, "data"), { recursive: true });
      writeFileSync(join(root, "data", "x.jsonl"), "{}\n");
      mkdirSync(join(home, ...path.slice(0, -1)), { recursive: true });
      symlinkSync(join(root, "data"), join(home, ...path));
    });
    assertRefused(d, 30, /symlink/);
  }
});

test("shareWorkspaceRoots: a file symlink (.mcp.json) inside a bot home refuses the whole share", () => {
  // A bot's .mcp.json carries signed actor headers; a link to a top-level file would hand them over.
  const d = botsTreeFixture("mcp-link", (root, home) => {
    writeFileSync(join(root, "signed-actors.json"), '{"mcpServers":{}}\n');
    symlinkSync(join(root, "signed-actors.json"), join(home, ".mcp.json"));
  });
  assertRefused(d, 31, /symlink/);
});

test("shareWorkspaceRoots: a carried-over bot home (one link to the bot's legacy root) refuses the whole share", () => {
  // world-root.mjs "root" mode: the whole bot home is one link to the bot's legacy root. That is not
  // Crow's moved-bot shape, so the bots tree no longer vouches for it: the share grants nothing.
  const whole = ws("unit-carried-root");
  mkdirSync(join(whole, "docs"), { recursive: true });
  writeFileSync(join(whole, "docs", "a.md"), "a\n");
  writeFileSync(join(whole, "top.txt"), "t\n");
  const legacyWhole = join(dir, "legacy-worlds", "whole");
  mkdirSync(join(legacyWhole, "sessions"), { recursive: true });
  writeFileSync(join(legacyWhole, "sessions", "s.jsonl"), "{}\n");
  mkdirSync(join(whole, "bots"), { recursive: true });
  symlinkSync(legacyWhole, join(whole, "bots", "carried"));

  assertRefused(whole, 36, /moved-bot/);
});

test("shareWorkspaceRoots: carried-over entries (sessions/outputs/.pi/.mcp.json linked to the legacy root) refuse the share", () => {
  // world-root.mjs "entries" mode: sessions/outputs/.pi/.mcp.json each link to the legacy root.
  const legacy = join(dir, "legacy-worlds", "other");
  mkdirSync(join(legacy, "sessions"), { recursive: true });
  writeFileSync(join(legacy, "sessions", "s.jsonl"), "{}\n");
  mkdirSync(join(legacy, "outputs"), { recursive: true });
  mkdirSync(join(legacy, ".pi", "agent"), { recursive: true });
  writeFileSync(join(legacy, ".mcp.json"), "{}\n");
  const d = botsTreeFixture("carried-entries", (_root, home) => {
    for (const name of ["sessions", "outputs", ".pi", ".mcp.json"]) {
      symlinkSync(join(legacy, name), join(home, name));
    }
  });
  assertRefused(d, 37, /symlink/);
});

test("shareWorkspaceRoots: a link inside a bot home that resolves INSIDE the workspace refuses the share", () => {
  // The same shape as a carried-over entry, but pointing at a top-level entry of this very
  // workspace: granting that entry would hand over the bot home's state through it.
  const d = botsTreeFixture("inside-link", (root, home) => {
    mkdirSync(join(root, "elsewhere", "sessions"), { recursive: true });
    writeFileSync(join(root, "elsewhere", "sessions", "x.jsonl"), "{}\n");
    symlinkSync(join(root, "elsewhere"), join(home, "sessions"));
  });
  assertRefused(d, 38, /symlink/);
});

test("shareWorkspaceRoots: a link in a bot home with no resolvable target refuses the share", () => {
  // Nothing to check the target against, so nothing can vouch for it: fail closed.
  const d = botsTreeFixture("dangling-link", (_root, home) => {
    symlinkSync(join(dir, "legacy-worlds", "gone"), join(home, "sessions"));
  });
  assertRefused(d, 39, /unresolvable symlink/);
});

// ---------------------------------------------------------------------------
// Crow's moved-bot link is the ONE shape accepted under <workspace>/bots
// ---------------------------------------------------------------------------

/** A project workspace that really homes `id`: the target of a moved-bot link. */
function movedFrom(name, id) {
  const d = ws(name);
  mkdirSync(join(d, "bots", id, "sessions"), { recursive: true });
  writeFileSync(join(d, "bots", id, "sessions", "s.jsonl"), "{}\n");
  return d;
}

test("shareWorkspaceRoots: Crow's moved-bot link (bots/<id> -> <slug>/workspace/bots/<id>) is accepted", () => {
  const from = movedFrom("unit-moved-from", "moved");
  const d = botsTreeFixture("moved-bot", () => {});
  symlinkSync(join(from, "bots", "moved"), join(d, "bots", "moved"));

  const { r, said } = shareOf(d, 40);
  assert.deepEqual(sortRoots(r), { read: sorted(fixtureRoots(d)), write: sorted(fixtureRoots(d)) },
    "the workspace's other entries are granted");
  assert.deepEqual(said, [], "an accepted moved-bot link says nothing");
  const target = realpathSync(join(from, "bots", "moved"));
  assert.equal(r.read.includes(target), false, "the bot home's target is never a root");

  const held = botsHoldout(join(d, "bots"), { realDir: realpathSync(d), projectsRoot: realpathSync(PROJECTS_ROOT) });
  assert.equal(held.ok, true, JSON.stringify(held));
  assert.equal(held.real, realpathSync(join(d, "bots")), "the bots dir itself is held out");
  assert.ok(held.homes.includes(target), "the moved bot's home is held out: " + JSON.stringify(held.homes));
  assert.ok(held.homes.includes(realpathSync(join(d, "bots", "other"))),
    "and so is the bot homed here: " + JSON.stringify(held.homes));
});

test("shareWorkspaceRoots: a moved-bot link whose target names a different bot is refused", () => {
  const from = movedFrom("unit-moved-other-name", "someone-else");
  const d = botsTreeFixture("moved-other-name", () => {});
  symlinkSync(join(from, "bots", "someone-else"), join(d, "bots", "moved"));
  assertRefused(d, 41, /moved-bot/);
});

test("shareWorkspaceRoots: a bot-home link to a target that is not <slug>/workspace/bots/<id> is refused", () => {
  // The right project, the wrong place inside it.
  const elsewhere = ws("unit-moved-elsewhere");
  mkdirSync(join(elsewhere, "elsewhere", "sessions"), { recursive: true });
  const wrongPlace = botsTreeFixture("moved-wrong-place", () => {});
  symlinkSync(join(elsewhere, "elsewhere"), join(wrongPlace, "bots", "moved"));
  assertRefused(wrongPlace, 42, /moved-bot/);

  // A legacy root outside the projects area: world-root.mjs's carry-over shape.
  const legacy = join(dir, "legacy-worlds", "moved-legacy");
  mkdirSync(join(legacy, "sessions"), { recursive: true });
  const outside = botsTreeFixture("moved-legacy", () => {});
  symlinkSync(legacy, join(outside, "bots", "moved"));
  assertRefused(outside, 43, /moved-bot/);

  // Another project's workspace ROOT: one segment short of the shape.
  const shortShape = botsTreeFixture("moved-short-shape", () => {});
  symlinkSync(elsewhere, join(shortShape, "bots", "moved"));
  assertRefused(shortShape, 44, /moved-bot/);
});

test("shareWorkspaceRoots: an accepted moved-bot home whose subtree holds a link back is refused", () => {
  // The moved home lives in another project; its `outputs` links back into THIS workspace's docs. The
  // target subtree is walked exactly like the bots tree (never through a link), so a link anywhere in
  // it refuses — an outside directory cannot smuggle a way back in.
  const from = movedFrom("unit-moved-tainted", "moved");
  const d = botsTreeFixture("moved-tainted-link", () => {});
  symlinkSync(join(from, "bots", "moved"), join(d, "bots", "moved"));
  symlinkSync(join(d, "docs"), join(from, "bots", "moved", "outputs"));
  assertRefused(d, 45, /symlink/);
});

test("shareWorkspaceRoots: a cross-share link of another shape under bots is refused", () => {
  // bots/<id> -> another project's docs: neither Crow's moved-bot shape nor a link this share can
  // vouch for.
  const other = ws("unit-cross-target");
  mkdirSync(join(other, "docs"), { recursive: true });
  const d = botsTreeFixture("cross-share", () => {});
  symlinkSync(join(other, "docs"), join(d, "bots", "moved"));
  assertRefused(d, 46, /moved-bot/);
});

test("shareWorkspaceRoots: a link chain under bots is refused, whatever it finally resolves to", () => {
  const d = botsTreeFixture("bots-chain", (root, home) => {
    symlinkSync(join(home, "b"), join(home, "a"));
    symlinkSync(join(root, "docs"), join(home, "b"));
  });
  assertRefused(d, 47, /symlink/);
});

test("shareWorkspaceRoots: a dangling link directly under bots is refused", () => {
  const d = botsTreeFixture("bots-dangling", () => {});
  symlinkSync(join(dir, "legacy-worlds", "not-there"), join(d, "bots", "carried"));
  assertRefused(d, 48, /unresolvable symlink/);
});

// ---------------------------------------------------------------------------
// granted entries: only a DANGEROUS link target refuses the entry
// ---------------------------------------------------------------------------

/** The first existing system path a .venv would link its interpreter to. */
const SYSTEM_BIN = ["/usr/bin/python3", "/usr/bin/python3.12", "/usr/bin/env"]
  .find((p) => existsSync(p)) || process.execPath;

test("shareWorkspaceRoots: a .venv in a granted entry (system python, lib64 -> lib, python3 -> python) is granted", () => {
  assert.equal(SHARE_ENTRY_MAX_DEPTH, 32, "the granted-entry walk's depth bound");
  assert.equal(SHARE_ENTRY_MAX_ENTRIES, 200_000, "...and its entry bound across the whole share");
  const d = shareFixture("venv-entry");
  const venv = join(d, ".venv");
  mkdirSync(join(venv, "bin"), { recursive: true });
  mkdirSync(join(venv, "lib", "python3.12", "site-packages"), { recursive: true });
  symlinkSync(SYSTEM_BIN, join(venv, "bin", "python"));
  symlinkSync("python", join(venv, "bin", "python3"));
  symlinkSync("lib", join(venv, "lib64"));
  symlinkSync(SYSTEM_BIN, join(venv, "bin", "python3.12"));

  const { r, said } = shareOf(d, 49);
  assert.deepEqual(sortRoots(r), {
    read: sorted([...fixtureRoots(d), realpathSync(venv)]),
    write: sorted([...fixtureRoots(d), realpathSync(venv)]),
  }, "the venv is a granted entry like any other");
  assert.deepEqual(said, [], "a link to a system path, and a link inside the workspace, say nothing");
  assert.ok(coversPath(r.read, join(venv, "bin", "python3")), "the venv's own files are readable through it");
});

test("shareWorkspaceRoots: a link inside an entry to another project refuses that entry only", () => {
  const other = ws("unit-entry-other");
  mkdirSync(join(other, "data"), { recursive: true });
  const d = shareFixture("entry-other-project");
  symlinkSync(join(other, "data"), join(d, "docs", "their-data"));
  // A chain: the first hop is a link in the same entry, the final realpath is the other project's dir.
  symlinkSync(join(d, "docs", "their-data"), join(d, "docs", "hop"));

  const { r, said } = shareOf(d, 50);
  assert.equal(r.read.includes(realpathSync(join(d, "docs"))), false, "the entry holding the link is not granted");
  assert.equal(coversPath(r.read, join(d, "docs", "a.md")), false);
  assert.ok(coversPath(r.read, join(d, "top.txt")), "the sibling entry is still granted");
  assert.equal(said.length, 1, "one line names why: " + JSON.stringify(said));
  assert.match(said[0], /another project/, said[0]);
});

test("shareWorkspaceRoots: a link inside an entry to the Crow home's secrets or the data directory refuses that entry", () => {
  const crowHome = join(dir, "crowhome-entry-links");
  mkdirSync(join(crowHome, "secrets", "keys"), { recursive: true });
  const secrets = shareFixture("entry-secrets");
  symlinkSync(join(crowHome, "secrets", "keys"), join(secrets, "docs", "keys"));
  const s = shareOf(secrets, 51, "read", { crowHome });
  assert.equal(s.r.read.includes(realpathSync(join(secrets, "docs"))), false,
    "the entry with the secrets link is not granted");
  assert.ok(coversPath(s.r.read, join(secrets, "top.txt")), "the sibling entry is granted");
  assert.match(s.said[0] || "", /Crow home/, JSON.stringify(s.said));

  const dataEntry = shareFixture("entry-datadir");
  symlinkSync(DB_FILE, join(dataEntry, "docs", "the-db"));
  const e = shareOf(dataEntry, 52);
  assert.equal(e.r.read.includes(realpathSync(join(dataEntry, "docs"))), false,
    "the entry with the data-dir link is not granted");
  assert.ok(coversPath(e.r.read, join(dataEntry, "top.txt")));
  assert.match(e.said[0] || "", /data directory/, JSON.stringify(e.said));
});

test("shareWorkspaceRoots: a link inside an entry to this project's bots tree refuses that entry", () => {
  const d = shareFixture("entry-bots-link");
  symlinkSync(join(d, "bots", "other", "sessions"), join(d, "docs", "state"));
  const { r, said } = shareOf(d, 53);
  assert.equal(r.read.includes(realpathSync(join(d, "docs"))), false, "the entry with the bots link is not granted");
  assert.ok(coversPath(r.read, join(d, "top.txt")), "the sibling entry is granted");
  assert.match(said[0] || "", /bots tree/, JSON.stringify(said));
});

test("shareWorkspaceRoots: a dangling link inside a granted entry is harmless and the entry is granted", () => {
  const d = shareFixture("entry-dangling");
  symlinkSync(join(dir, "no-such-target"), join(d, "docs", "gone"));
  symlinkSync(join(dir, "no-such-target-2"), join(d, "dangling-top"));
  const { r, said } = shareOf(d, 54);
  assert.deepEqual(sortRoots(r), { read: sorted(fixtureRoots(d)), write: sorted(fixtureRoots(d)) },
    "a dangling link resolves nowhere, so the entry is granted");
  assert.deepEqual(said, [], "and nothing is said about it");
});

test("shareWorkspaceRoots: a bots tree over the entry bound refuses the share instead of half-inspecting it", () => {
  // Sizing note: the bound is a real constant (pi session transcripts and outputs/ files accumulate
  // in a bot home), so the test passes a SMALL bound down the walk rather than creating 100,000 files.
  assert.equal(BOTS_TREE_MAX_ENTRIES, 100_000, "the bound is sized for real pi trees");
  const d = botsTreeFixture("huge-bots-tree", (_root, home) => {
    const sessions = join(home, "sessions");
    mkdirSync(sessions, { recursive: true });
    // One entry past the bound is enough: the walk stopped, so a link further in could go unseen.
    for (let i = 0; i < 6; i++) writeFileSync(join(sessions, "s" + i + ".jsonl"), "");
  });
  const said = [];
  const r = shareWorkspaceRoots([{ project_id: 32, level: "read_write", workspace_dir: d, suspended: false }],
    { projectsRoot: PROJECTS_ROOT, botsTreeMaxEntries: 4, log: (m) => said.push(m) });
  assert.deepEqual(r, { read: [], write: [] }, "a tree past the bound grants nothing");
  assert.equal(said.length, 1, "exactly one warning line: " + JSON.stringify(said));
  assert.match(said[0], /entries/, said[0]);

  // The very same tree is well inside the default bound, so the share is granted there.
  const under = shareOf(d, 32);
  assert.deepEqual(sortRoots(under.r), { read: sorted(fixtureRoots(d)), write: sorted(fixtureRoots(d)) });
  assert.deepEqual(under.said, []);
});

test("shareWorkspaceRoots: a bots tree of real dirs and files — a deep one included — still grants the other entries", () => {
  const d = botsTreeFixture("real-bots-deep", (_root, home) => {
    // bots/<id>/sessions/2026/01/02/s.jsonl sits five levels below bots; .mcp.json is a real file.
    assert.ok(5 <= BOTS_TREE_MAX_DEPTH, "the fixture's depth stays inside the walk's bound");
    mkdirSync(join(home, "sessions", "2026", "01", "02"), { recursive: true });
    writeFileSync(join(home, "sessions", "2026", "01", "02", "s.jsonl"), "{}\n");
    writeFileSync(join(home, ".mcp.json"), "{}\n");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  });
  const { r, said } = shareOf(d, 33);
  assert.deepEqual(sortRoots(r), { read: sorted(fixtureRoots(d)), write: sorted(fixtureRoots(d)) });
  assert.deepEqual(said, [], "a normal bots tree says nothing");
});

test("shareWorkspaceRoots: an unreadable bots directory refuses the share (never 'no bots here')", {
  skip: IS_ROOT ? "root reads a mode-000 directory" : false,
}, () => {
  const d = botsTreeFixture("unreadable-bots", (_root, home) => {
    mkdirSync(join(home, "sessions"), { recursive: true });
  });
  chmodSync(join(d, "bots"), 0o000);
  try {
    assertRefused(d, 34, /EACCES/);
  } finally {
    chmodSync(join(d, "bots"), 0o755);
  }
});

test("shareWorkspaceRoots: a `<ws>/bots` that is a regular file refuses the share (ENOTDIR)", () => {
  const d = ws("unit-bots-is-a-file");
  mkdirSync(join(d, "docs"), { recursive: true });
  writeFileSync(join(d, "docs", "a.md"), "a\n");
  writeFileSync(join(d, "top.txt"), "t\n");
  writeFileSync(join(d, "bots"), "not a directory\n");
  assertRefused(d, 35, /ENOTDIR/);
});

test("shareWorkspaceRoots: more top-level entries than the cap grants nothing for that share, with one warning", () => {
  const d = ws("unit-wide");
  mkdirSync(d, { recursive: true });
  for (let i = 0; i < 201; i++) writeFileSync(join(d, `f${i}.txt`), "");
  const said = [];
  const r = shareWorkspaceRoots([{ project_id: 9, level: "read", workspace_dir: d, suspended: false }],
    { projectsRoot: PROJECTS_ROOT, log: (m) => said.push(m) });
  assert.deepEqual(r, { read: [], write: [] });
  assert.equal(said.length, 1, "exactly one warning line: " + JSON.stringify(said));
});

test("shareWorkspaceRoots: a dangerous workspace_dir is dropped with one warning (M3)", () => {
  const crowHome = join(dir, "crowhome-share-roots");
  mkdirSync(join(crowHome, "secrets", "keys"), { recursive: true });
  const cases = [
    ["the filesystem root", "/"],
    ["the user's home", process.env.HOME],
    ["a parent of the user's home", dirname(process.env.HOME)],
    ["the Crow home", crowHome],
    ["above the Crow home", dirname(crowHome)],
    ["under <crowHome>/secrets", join(crowHome, "secrets", "keys")],
  ];
  for (const [label, d] of cases) {
    const said = [];
    assert.deepEqual(
      shareWorkspaceRoots([{ project_id: 10, level: "read_write", workspace_dir: d, suspended: false }],
        { crowHome, projectsRoot: PROJECTS_ROOT, log: (m) => said.push(m) }),
      { read: [], write: [] }, label);
    assert.equal(said.length, 1, label + " warns once: " + JSON.stringify(said));
  }
  // The named reasons still name themselves (the belt is not just the projects-root allowlist).
  const reason = (d) => {
    const said = [];
    shareWorkspaceRoots([{ project_id: 11, level: "read", workspace_dir: d, suspended: false }],
      { crowHome, projectsRoot: PROJECTS_ROOT, log: (m) => said.push(m) });
    return said[0] || "";
  };
  assert.match(reason(process.env.HOME), /the user's home/);
  assert.match(reason(dirname(process.env.HOME)), /above the user's home/);
  assert.match(reason(join(crowHome, "secrets", "keys")), /secrets/);
});

test("shareWorkspaceRoots: the projects area is an allowlist — only a dir that really sits under it is a root", () => {
  const allowed = shareFixture("allowed");
  const quiet = [];
  assert.deepEqual(sortRoots(shareWorkspaceRoots(
    [{ project_id: 20, level: "read", workspace_dir: allowed, suspended: false }],
    { projectsRoot: PROJECTS_ROOT, log: (m) => quiet.push(m) },
  )), { read: sorted(fixtureRoots(allowed)), write: [] }, "a normal <dataDir>/projects/<slug>/workspace is a root");
  assert.deepEqual(quiet, [], "a granted share says nothing");

  const linkToHome = join(PROJECTS_ROOT, "unit-link-home");
  symlinkSync(process.env.HOME, linkToHome);
  const outsideProjects = join(dir, "outside-projects");
  mkdirSync(join(outsideProjects, "docs"), { recursive: true });
  writeFileSync(join(outsideProjects, "docs", "a.md"), "a\n");
  const cases = [
    ["a workspace_dir that is a symlink to the user's home", linkToHome],
    ["a workspace_dir outside the projects area", outsideProjects],
    ["the projects root itself", PROJECTS_ROOT],
    ["a parent of the projects root", dir],
    ["a missing dir", join(PROJECTS_ROOT, "unit-gone", "workspace")],
  ];
  for (const [label, d] of cases) {
    const said = [];
    assert.deepEqual(
      shareWorkspaceRoots([{ project_id: 21, level: "read_write", workspace_dir: d, suspended: false }],
        { crowHome: process.env.CROW_HOME, projectsRoot: PROJECTS_ROOT, log: (m) => said.push(m) }),
      { read: [], write: [] }, label);
    assert.equal(said.length, 1, label + " warns once: " + JSON.stringify(said));
  }
});

test("shareWorkspaceRoots: an entry that is a symlink resolving outside the projects area is not granted", () => {
  const d = shareFixture("escape-projects");
  const outside = join(dir, "escape-target");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "x.txt"), "x\n");
  symlinkSync(outside, join(d, "escape"));
  const r = shareWorkspaceRoots([{ project_id: 22, level: "read_write", workspace_dir: d, suspended: false }],
    { projectsRoot: PROJECTS_ROOT });
  assert.equal(coversPath(r.read, join(d, "escape")), false, "a link out of the projects area is not a read root");
  assert.equal(coversPath(r.write, join(d, "escape")), false);
  assert.equal(coversPath(r.read, outside), false);
  for (const root of fixtureRoots(d)) assert.ok(coversPath(r.read, root), root);
});

test("shareWorkspaceRoots: no projects root means nothing is granted (fail closed), with one warning", () => {
  const d = shareFixture("no-root");
  const absent = join(dir, "absent-projects-root");
  for (const projectsRoot of [undefined, null, "", "relative/projects", absent]) {
    const said = [];
    assert.deepEqual(
      shareWorkspaceRoots([{ project_id: 23, level: "read_write", workspace_dir: d, suspended: false }],
        { projectsRoot, log: (m) => said.push(m) }),
      { read: [], write: [] }, String(projectsRoot));
    assert.equal(said.length, 1, String(projectsRoot) + " warns once: " + JSON.stringify(said));
  }
});

// ---------------------------------------------------------------------------
// the spawn's effective roots (a real channel turn, real world build)
// ---------------------------------------------------------------------------

test("a READ share's top-level entries are read roots and never write roots", async () => {
  const cap = await channelTurn("reader", "read-share");
  const policy = policyOf(cap);
  assert.deepEqual(sorted(policy.read_paths), sorted([W_HOME, ...X_ROOTS]),
    "the bot's own project workspace, then one root per shared top-level entry");
  assert.deepEqual(policy.write_paths, [], "a read share grants no write reach");
});

test("a READ_WRITE share's top-level entries are both read and write roots", async () => {
  const cap = await channelTurn("writer", "write-share");
  const policy = policyOf(cap);
  assert.deepEqual(sorted(policy.read_paths), sorted([W_HOME, ...X_ROOTS]));
  assert.deepEqual(sorted(policy.write_paths), sorted(X_ROOTS));
});

test("a share never reaches the shared project's bots subtree; its other top-level entries are covered", async () => {
  const read = policyOf(await channelTurn("reader", "bots-read"));
  assert.equal(coversPath(read.read_paths, OTHER_BOT_SESSION), false,
    "a read share cannot read X/bots/<other>/sessions/x");
  assert.equal(coversPath(read.read_paths, BOTS_SUBTREE), false);
  for (const root of X_ROOTS) assert.ok(coversPath(read.read_paths, root), "covered: " + root);

  const rw = policyOf(await channelTurn("writer", "bots-write"));
  assert.equal(coversPath(rw.write_paths, BOTS_SUBTREE), false, "a read_write share has no write root over X/bots");
  assert.equal(coversPath(rw.write_paths, OTHER_BOT_SESSION), false);
  for (const root of X_ROOTS) assert.ok(coversPath(rw.write_paths, root), "covered: " + root);
});

test("a bot with no write share gets no write_paths key added to its spawn policy (M6)", async () => {
  const cap = await channelTurn("plainbot", "no-write-key");
  const policy = policyOf(cap);
  assert.equal(Object.prototype.hasOwnProperty.call(policy, "write_paths"), false,
    "an empty share write list leaves the def's policy untouched: " + JSON.stringify(policy));
  assert.deepEqual(policy.read_paths, [W_HOME]);
});

test("a SUSPENDED share adds no root, at either level", async () => {
  const cap = await channelTurn("suspended", "suspended-share");
  const policy = policyOf(cap);
  assert.deepEqual(policy.read_paths, [W_HOME], "the suspended project's workspace stays out");
  assert.deepEqual(policy.write_paths, []);
});

test("an ARCHIVED or TOMBSTONED project adds no root", async () => {
  const arch = await channelTurn("arch", "arch-share");
  assert.deepEqual(policyOf(arch).read_paths, [W_HOME]);
  assert.deepEqual(policyOf(arch).write_paths, []);
  const tomb = await channelTurn("tomb", "tomb-share");
  assert.deepEqual(policyOf(tomb).read_paths, [W_HOME]);
  assert.deepEqual(policyOf(tomb).write_paths, []);
});

test("a REVOKED share adds no root", async () => {
  const cap = await channelTurn("revoked", "revoked-share");
  assert.deepEqual(policyOf(cap).read_paths, [W_HOME]);
  assert.deepEqual(policyOf(cap).write_paths, []);
});

test("a project with a NULL workspace_dir adds no root and does not break the turn", async () => {
  const cap = await channelTurn("nows", "no-workspace");
  assert.deepEqual(policyOf(cap).read_paths, [W_HOME]);
  assert.deepEqual(policyOf(cap).write_paths, []);
});

test("a bot with no share adds nothing, and a bot with no project keeps no read_paths at all", async () => {
  const none = await channelTurn("nothing", "no-share");
  assert.deepEqual(policyOf(none).read_paths, [W_HOME], "only its own project workspace");
  assert.deepEqual(policyOf(none).write_paths, []);
  const homeless = await channelTurn("homeless", "no-project");
  assert.equal(policyOf(homeless).read_paths, undefined, "no project, no explicit roots, no shares => no read_paths key");
  assert.deepEqual(policyOf(homeless).write_paths, []);
});

test("the world reports the loaded shares as projectShares for a later UI read", async () => {
  const world = await buildBotWorld({ botId: "writer", threadId: "world-shares", gatewayType: "gmail" });
  assert.deepEqual(world.projectShares, [
    { project_id: P_X, level: "read_write", workspace_dir: W_X, name: "Shared X", suspended: false },
  ]);
  assert.deepEqual(sorted(world.extraReadPaths), sorted(X_ROOTS), "one root per top-level entry, never X/bots");
  assert.deepEqual(sorted(world.extraWritePaths), sorted(X_ROOTS));
  const reader = await buildBotWorld({ botId: "reader", threadId: "world-shares-read", gatewayType: "gmail" });
  assert.deepEqual(sorted(reader.extraReadPaths), sorted(X_ROOTS));
  assert.deepEqual(reader.extraWritePaths, [], "a read share never reaches the write roots");
});

test("a share whose workspace_dir is a symlink to the user's home adds no root at spawn", async () => {
  const world = await buildBotWorld({ botId: "homelink", threadId: "world-home-link", gatewayType: "gmail" });
  assert.equal(world.projectShares.length, 1, "the share row itself is still reported");
  assert.deepEqual(world.extraReadPaths, [], "nothing of the home is reachable through the share");
  assert.deepEqual(world.extraWritePaths, []);
  const cap = await channelTurn("homelink", "home-link-share");
  assert.deepEqual(policyOf(cap).read_paths, [W_HOME], "only the bot's own project workspace");
  assert.deepEqual(policyOf(cap).write_paths, []);
});

test("a top-level entry created after a spawn is out of that spawn's reach and in the next one", async () => {
  const before = policyOf(await channelTurn("reader", "late-before"));
  const late = join(W_X, "late-comer.txt");
  writeFileSync(late, "late\n");
  try {
    assert.equal(coversPath(before.read_paths, late), false, "the earlier spawn's fixed roots cannot reach it");
    const after = policyOf(await channelTurn("reader", "late-after"));
    assert.ok(coversPath(after.read_paths, late), "the next spawn grants it");
  } finally { rmSync(late, { force: true }); }
});

test("bypass permission mode is unchanged by shares: read_paths and write_paths are still '/'", async () => {
  const world = await buildBotWorld({ botId: "writer", threadId: "bypass", gatewayType: "gmail" });
  const prep = await prepareSpawn(world, { log: () => {} });
  const cap = await directSpawn("bypass", Object.assign({}, prep.piRpcOpts, { permissionMode: "bypass" }));
  const policy = policyOf(cap);
  assert.deepEqual(policy.read_paths, ["/"], "bypass reads everything; a share adds nothing to that");
  assert.deepEqual(policy.write_paths, ["/"], "and writes everything — the share roots are not appended to '/'");
});

// ---------------------------------------------------------------------------
// Perch: an open-anywhere session working OUTSIDE the home workspace (M2)
// ---------------------------------------------------------------------------

let pidSeq = 790000;
function makeFakePi(state) {
  return class FakePi {
    constructor(o) {
      this.opts = o;
      this.sent = [];
      this.closed = 0;
      this.proc = { pid: ++pidSeq };
      this.piSessionId = "pisess-" + this.proc.pid;
      this.toolsCsv = "read";
      this._exitCode = null;
      let done;
      this.exited = new Promise((r) => { done = r; });
      this._done = done;
      state.instances.push(this);
    }
    async getState() { return { data: { sessionId: this.piSessionId } }; }
    async getSessionStats() { return { data: { tokens: { input: 1, output: 1, cacheRead: 0 } } }; }
    async trimLog() {}
    async abortSince() { return null; }
    send(o) { this.sent.push(o); }
    async close() { this.closed += 1; this.exit(0); }
    exit(code = 0) {
      if (this._exitCode != null) return;
      this._exitCode = code;
      this._done(code);
    }
    _exitError() { return new Error("pi exited (code " + this._exitCode + ")"); }
    emit() {}
  };
}
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function makeEngine() {
  const state = { instances: [] };
  const seam = {
    PiRpc: makeFakePi(state),
    LIFECYCLE_DEFAULTS: { maxPi: 99 },
    countLivePi: () => 0,
    buildBotWorld: (args) => buildBotWorld(args),
    prepareSpawn: (world, opts) => prepareSpawn(world, opts),
    warmModel: async () => {},
    meterTurn: async () => ({}),
    appendAudit: () => {},
    planForCard: () => null,
    projectContextBlock: () => "",
    cardStatus: () => "todo",
    boardVocab: () => ({ statuses: [], terminals: [] }),
    cardText: () => ({ title: null, description: null }),
    capFor: () => null,
  };
  const engine = createInteractiveEngine({
    crowHome: process.env.CROW_HOME,
    env: { CROW_HOME: process.env.CROW_HOME },
    bridge: seam,
    log: () => {},
  });
  return { engine, state };
}

test("PERCH open-anywhere, READ share: the chosen cwd stays writable, the shared workspace is read-only (M2)", async () => {
  const chosen = join(dir, "operator-chosen");
  mkdirSync(chosen, { recursive: true });
  const { engine, state } = makeEngine();
  const r = await engine.spawn({ botId: "reader", cwd: chosen });
  await tick();
  const pi = state.instances[0];
  assert.ok(pi, "the engine started a child");
  const outputsDir = join(pi.opts.sessionDir, "outputs", r.sessionId);
  assert.deepEqual(pi.opts.extraWritePaths, [outputsDir, chosen],
    "only outputsDir and the operator's chosen dir are writable — the read share adds nothing");
  const readPaths = effectiveReadPaths(pi.opts.def, {
    projectWorkspaceDir: pi.opts.projectWorkspaceDir, extra: pi.opts.extraReadPaths,
  });
  for (const root of X_ROOTS) assert.ok(readPaths.includes(root), "the shared top-level entry " + root + " is readable");
  assert.ok(!coversPath(readPaths, OTHER_BOT_SESSION), "the shared project's bots subtree is not readable");
  assert.ok(!coversPath(pi.opts.extraWritePaths, X_ROOTS[0]), "the read share is not in the child's write roots");
});

test("PERCH: a READ_WRITE share's workspace joins the child's write roots too", async () => {
  const chosen = join(dir, "operator-chosen-rw");
  mkdirSync(chosen, { recursive: true });
  const { engine, state } = makeEngine();
  const r = await engine.spawn({ botId: "writer", cwd: chosen });
  await tick();
  const pi = state.instances[0];
  assert.ok(pi, "the engine started a child");
  const outputsDir = join(pi.opts.sessionDir, "outputs", r.sessionId);
  assert.deepEqual(sorted(pi.opts.extraWritePaths), sorted([outputsDir, chosen, ...X_ROOTS]));
  assert.equal(coversPath(pi.opts.extraWritePaths, BOTS_SUBTREE), false, "never X's bots subtree");
});

// ---------------------------------------------------------------------------
// the contain tier's bind plan
// ---------------------------------------------------------------------------

const pairs = (args) => {
  const o = [];
  for (let i = 0; i < args.length; i++) {
    if (["--ro-bind", "--bind", "--symlink"].includes(args[i])) { o.push([args[i], args[i + 1], args[i + 2]]); i += 2; }
    else if (["--tmpfs", "--dev", "--proc", "--chdir"].includes(args[i])) { o.push([args[i], args[i + 1]]); i += 1; }
    else o.push([args[i]]);
  }
  return o;
};
const has = (args, flag, src, dst = src) => pairs(args).some((p) => p[0] === flag && p[1] === src && (p.length < 3 || p[2] === dst));

test("CONTAIN: a share read root binds read-only, a read_write root read-write, and the Crow home stays refused", () => {
  const T = realpathSync(mkdtempSync(join(tmpdir(), "share-contain-")));
  const H = join(T, "home", "alice");
  const mk = (...p) => { const d = join(...p); mkdirSync(d, { recursive: true }); return d; };
  const crowHome = mk(H, ".crow");
  const data = mk(crowHome, "data");
  writeFileSync(join(data, "crow.db"), "");
  mk(crowHome, "secrets");
  const app = mk(H, "crow-checkout"); // a small fake checkout: nothing large to scan
  const session = mk(T, "sess", "bot-reader");
  const readRoot = mk(H, "shared-read");   // a `read` share's workspace_dir
  const writeRoot = mk(H, "shared-write"); // a `read_write` share's workspace_dir

  const plan = (over = {}) => buildContainPlan({
    home: H, nodeBin: null, cliPath: null, appRoot: app, piLabDir: null,
    crowHome, dataDir: data, sessionDir: session, cwd: session,
    writePaths: [], readPaths: [], mcpServers: [], systemDirs: ["/usr", "/etc"], ...over,
  });

  // What the bridge hands the plan: read_paths carries every share root,
  // write_paths only the read_write ones (bridge.mjs containPlanInputs).
  const { args } = plan({ readPaths: [readRoot], writePaths: [writeRoot] });
  assert.ok(has(args, "--ro-bind", readRoot), "the read share's workspace is mounted read-only");
  assert.ok(!has(args, "--bind", readRoot), "...and never read-write");
  assert.ok(has(args, "--bind", writeRoot), "the read_write share's workspace is mounted read-write");
  assert.ok(!has(args, "--ro-bind", writeRoot), "...and not at the same time");

  assert.throws(() => plan({ writePaths: [crowHome] }), ContainRefused,
    "a write root covering the Crow home still refuses the spawn");
  const ro = plan({ readPaths: [crowHome] });
  assert.ok(!has(ro.args, "--ro-bind", crowHome), "a read root covering the Crow home is not bound");
  assert.ok(ro.refused.some((r) => r.path === crowHome), "and the refusal is recorded");
});
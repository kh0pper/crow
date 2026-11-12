/**
 * Per-bot git access, PR B (task B2): the spawn-side decision and the bridge
 * wiring.
 *
 * Two halves:
 *
 *  1. Table tests on the PURE functions (scripts/pi-bots/bot_git_spawn.mjs):
 *     gitPreSpawn (every fact that must hold before a key dir is used) and
 *     gitPostLaunch (the env changes, and the launch facts that turn git off).
 *     No DB, no spawn, no filesystem: each row states one rule.
 *
 *  2. A real PiRpc integration (the tests/pi-sandbox.test.js pattern): a
 *     scratch Crow home with a seeded pi_bot_defs row and a bot's key dir on
 *     disk, spawned through the real sandbox. The child prints
 *     GIT_SSH_COMMAND and whether a key path exists inside. It needs the pidns
 *     tier (git is pidns-only), so it SKIPS exactly where the sandbox cannot
 *     provide one — the same noSandbox/noPidns convention as that file.
 *
 *  3. The spawn-time fd handover (review BLOCKER): what the bridge hands to
 *     `spawn()`, with the fd seams installed (`node:fs`.openSync and
 *     `node:child_process`.spawn wrapped, then syncBuiltinESMExports — the
 *     pattern tests/roost-strip-data.test.js uses). The sandbox probe is
 *     primed with a stub bwrap, so these run anywhere: a userns-only probe, an
 *     old bwrap without --ro-bind-fd, or an expose entry validExposed drops
 *     (the key dir's mode changes in the window between Crow's checks and the
 *     mount) must leave fd GIT_KEYDIR_FD off stdio and the descriptor closed in
 *     the parent before the spawn.
 *
 * Nothing here writes a real key: the fixture writes a fake file of the shape
 * `checkKeyDir` accepts (0600, one link, under a 0700 dir). A real ssh key is
 * generated only in tests/bot-git-store.test.js, behind an ssh-keygen skip.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import Database from "better-sqlite3";
import { rmScratch } from "./helpers/safe-rm.js";

const G = await import("../scripts/pi-bots/bot_git_spawn.mjs");
const P = await import("../servers/shared/bot-git/paths.js");
const { probePiSandbox, _resetPiSandboxForTest } = await import("../scripts/pi-bots/pi_sandbox.mjs");

// A scratch Crow home, set BEFORE bridge.mjs is imported: it freezes CROW_DB
// and the other instance paths at module load.
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), "bot-git-spawn-home-")));
const CROW_HOME = join(SCRATCH, ".crow");
const DATA_DIR = join(SCRATCH, "data");
const CROW_DB_PATH = join(DATA_DIR, "crow.db");
const AGENT = join(SCRATCH, ".pi", "agent");
mkdirSync(AGENT, { recursive: true });
writeFileSync(join(AGENT, "mcp.json"), JSON.stringify({ mcpServers: {} }));
mkdirSync(DATA_DIR, { recursive: true });
process.env.HOME = SCRATCH;
process.env.CROW_HOME = CROW_HOME;
process.env.CROW_DB_PATH = CROW_DB_PATH;
process.env.CROW_DATA_DIR = DATA_DIR;
delete process.env.CROW_PI_SANDBOX;
delete process.env.CROW_PI_CONTAIN_BOTS;
after(() => rmScratch(SCRATCH));
process.on("exit", () => { try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* gone */ } });

// The co-host scan must not read the host's /etc: point its system half at
// empty scratch dirs (same discipline as tests/pi-sandbox.test.js).
const SCAN_UNITS = join(SCRATCH, "scan-units");
const SCAN_ENV = join(SCRATCH, "scan-etc-crow");
mkdirSync(SCAN_UNITS, { recursive: true });
mkdirSync(SCAN_ENV, { recursive: true });
const { _setSystemScanDirsForTest } = await import("../servers/shared/secret-values.js");
_setSystemScanDirsForTest({ unitDirs: [SCAN_UNITS], envFileDirs: [SCAN_ENV] });

const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");
const Store = await import("../servers/shared/bot-git/store.js");

const CREATED_AT = "2026-11-12 10:00:00";
const SECRETS = join(CROW_HOME, "secrets");

// ---- 1. the pure functions -------------------------------------------------

const CAND = "/home/u/.crow/secrets/bot-git/bota";

/** Every fact a happy spawn needs; each test flips exactly one. */
function preFacts(over = {}) {
  return {
    candidate: CAND,
    containedSpawn: false,
    optsBotId: "bota",
    noGit: false,
    gitDirExists: true,
    metaCreatedAt: CREATED_AT,
    rowCreatedAt: CREATED_AT,
    keyDirCheck: { ok: true },
    safePath: true,
    instanceAllowed: true,
    // The sandbox the bridge passes in (probePiSandbox()): a host that can build
    // the PID-namespace tier AND whose bwrap knows --ro-bind-fd.
    probe: { ok: true, pidns: true, bindFd: true },
    ...over,
  };
}

test("gitPreSpawn: every fact holding gives the key dir; each failure gives null and its reason", () => {
  assert.deepEqual(G.gitPreSpawn(preFacts()), { gitDir: CAND, keyDir: CAND, reason: null });
  const cases = [
    ["noGit", { noGit: true }, /off/],
    ["no bot id", { optsBotId: undefined }, /bot id/],
    ["a def-shaped id naming another bot", { optsBotId: "b" }, /another bot/],
    ["an id that steps out of the dir", { optsBotId: "../b" }, /bot id/],
    ["contain", { containedSpawn: true }, /contain/],
    ["instance not allowed", { instanceAllowed: false }, /only enabled bot/],
    ["no key dir", { gitDirExists: false }, /no git key/],
    ["created_at mismatch", { metaCreatedAt: "2026-11-12 10:00:01" }, /created/],
    ["key dir check failed", { keyDirCheck: { ok: false, reason: "the private key is missing" } }, /key dir is not usable/],
    ["no key dir check", { keyDirCheck: null }, /key dir is not usable/],
    ["unsafe path", { safePath: false }, /cannot be used/],
    // Review item 1b: the sandbox probe is a fact like any other, and the fd is
    // never opened without it.
    ["no probe at all", { probe: null }, /sandbox cannot bind/],
    ["a host with no PID namespace", { probe: { ok: true, pidns: false, bindFd: true } }, /sandbox cannot bind/],
    ["an old bwrap without --ro-bind-fd", { probe: { ok: true, pidns: true, bindFd: false } }, /sandbox cannot bind/],
    ["no usable sandbox", { probe: { ok: false, pidns: false, bindFd: false } }, /sandbox cannot bind/],
  ];
  for (const [what, over, reason] of cases) {
    const r = G.gitPreSpawn(preFacts(over));
    assert.equal(r.gitDir, null, what);
    if (reason) assert.match(String(r.reason), reason, what);
  }
  // Review item 3 stated as its own case: opts.botId undefined while the
  // candidate is another bot's real key dir -> never that bot's key.
  assert.equal(G.gitPreSpawn(preFacts({ optsBotId: undefined, candidate: "/home/u/.crow/secrets/bot-git/b" })).gitDir, null);
});

test("gitPreSpawn: a sandbox that cannot bind the key dir still names it, so the GIT_* strip applies", () => {
  for (const probe of [null, { ok: false, pidns: false, bindFd: false }, { ok: true, pidns: false, bindFd: true },
    { ok: true, pidns: true, bindFd: false }]) {
    const r = G.gitPreSpawn(preFacts({ probe }));
    assert.equal(r.gitDir, null, JSON.stringify(probe));
    assert.equal(r.keyDir, CAND, "the bot owns this key dir even when it cannot be exposed");
    assert.equal(r.reason, "sandbox cannot bind the key dir");
  }
  // Any EARLIER failure names no key dir at all: nothing to strip for a bot that
  // has no usable key.
  assert.equal(G.gitPreSpawn(preFacts({ keyDirCheck: { ok: false } })).keyDir, null);
  assert.equal(G.gitPreSpawn(preFacts({ noGit: true })).keyDir, null);
  assert.equal(G.gitPreSpawn(preFacts({ candidate: null, gitDirExists: false })).keyDir, null);
  // And the happy path names it twice: the same dir is exposed and stripped.
  const ok = G.gitPreSpawn(preFacts());
  assert.equal(ok.gitDir, ok.keyDir);
});

test("gitPreSpawn: the created_at check needs two matching strings (housekeeping, not security)", () => {
  // A missing row (no DB / no bot row) or an unreadable meta.json can never match.
  assert.equal(G.gitPreSpawn(preFacts({ rowCreatedAt: null })).gitDir, null);
  assert.equal(G.gitPreSpawn(preFacts({ metaCreatedAt: null })).gitDir, null);
  assert.equal(G.gitPreSpawn(preFacts({ metaCreatedAt: null, rowCreatedAt: null })).gitDir, null, "two unknowns are not agreement");
  assert.equal(G.gitPreSpawn(preFacts({ metaCreatedAt: "", rowCreatedAt: "" })).gitDir, null);
});

test("countEnabledPiBots: enabled rows whose engine is pi or absent", () => {
  assert.equal(G.countEnabledPiBots(null), 0);
  assert.equal(G.countEnabledPiBots([]), 0);
  const rows = [
    { enabled: 1, definition: null },
    { enabled: 1, definition: "{}" },
    { enabled: 1, definition: JSON.stringify({ engine: "pi" }) },
    { enabled: 1, definition: JSON.stringify({ engine: "other" }) },
    { enabled: 0, definition: "{}" },
    { enabled: "1", definition: "{}" },
    { enabled: 1, definition: "not json" },
  ];
  assert.equal(G.countEnabledPiBots(rows), 5, "every enabled pi/absent-engine row, malformed included");
  assert.equal(G.countEnabledPiBots([{ enabled: 1, definition: JSON.stringify({ engine: "other" }) }]), 0);
});

const LAUNCH = Object.freeze({ wrapper: "bwrap", tier: "pidns", pidNamespace: true, exposed: [CAND] });

test("gitPostLaunch: no key dir leaves the spawn env untouched", () => {
  assert.deepEqual(G.gitPostLaunch({ gitDir: null, launch: LAUNCH }), { remove: [], set: null, reason: null });
  assert.deepEqual(G.gitPostLaunch(), { remove: [], set: null, reason: null });
  assert.deepEqual(G.gitPostLaunch({ gitDir: null, launch: null }), { remove: [], set: null, reason: null });
});

test("gitPostLaunch: a launch that cannot have git still strips every GIT_* key", () => {
  const launches = [
    ["setpriv", { wrapper: "setpriv", tier: "nnp", pidNamespace: false, exposed: [] }],
    ["plain", { wrapper: null, tier: "none", pidNamespace: false, exposed: [] }],
    ["contain", { wrapper: "bwrap", tier: "contain", pidNamespace: true, exposed: [CAND] }],
    ["contain-noseccomp", { wrapper: "bwrap", tier: "contain-noseccomp-hostnet", pidNamespace: true, exposed: [CAND] }],
    // Review item 2: the userns tier cannot have git (host /proc is visible).
    ["userns", { wrapper: "bwrap", tier: "userns", pidNamespace: false, exposed: [CAND] }],
    ["not exposed", { wrapper: "bwrap", tier: "pidns", pidNamespace: true, exposed: [] }],
    ["exposed another dir", { wrapper: "bwrap", tier: "pidns", pidNamespace: true, exposed: ["/x"] }],
  ];
  for (const [what, launch] of launches) {
    const r = G.gitPostLaunch({ gitDir: CAND, launch });
    assert.deepEqual(r.remove, ["GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_CONFIG_GLOBAL"], what);
    assert.equal(r.set, null, what);
    assert.equal(typeof r.reason, "string", what + " says why");
    assert.ok(r.reason.length > 0);
  }
});

test("gitPostLaunch: the happy path sets exactly the pinned two keys", () => {
  const r = G.gitPostLaunch({ gitDir: CAND, launch: LAUNCH });
  assert.deepEqual(r.remove, ["GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_CONFIG_GLOBAL"]);
  assert.equal(r.reason, null);
  assert.deepEqual(Object.keys(r.set).sort(), ["GIT_CONFIG_GLOBAL", "GIT_SSH_COMMAND"]);
  assert.equal(r.set.GIT_CONFIG_GLOBAL, CAND + "/gitconfig");
  const cmd = r.set.GIT_SSH_COMMAND;
  assert.ok(cmd.startsWith("ssh "), "starts with ssh");
  for (const part of ["-F /dev/null", "-i " + CAND + "/id_ed25519", "IdentitiesOnly=yes", "IdentityAgent=none",
    "UserKnownHostsFile=" + CAND + "/known_hosts", "GlobalKnownHostsFile=/dev/null", "StrictHostKeyChecking=yes",
    "UpdateHostKeys=no", "BatchMode=yes", "LogLevel=ERROR", "ConnectTimeout=10"]) {
    assert.ok(cmd.includes(part), "GIT_SSH_COMMAND carries " + part);
  }
});

test("gitPostLaunch: a key dir path that cannot go into a shell command disables git", () => {
  const spaced = "/home/u/.crow/secrets/bot-git/two words";
  const r = G.gitPostLaunch({ gitDir: spaced, launch: { ...LAUNCH, exposed: [spaced] } });
  assert.equal(r.set, null);
  assert.match(r.reason, /cannot be used/);
  assert.deepEqual(r.remove, ["GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_CONFIG_GLOBAL"]);
});

test("the spawn env sequence: a def's GIT_* value is replaced when a key dir is chosen, kept when it is not", () => {
  // The exact two lines the bridge runs (bridge.mjs, gitPostLaunch call site).
  const apply = (env, gitDir, launch) => {
    const post = G.gitPostLaunch({ gitDir, launch });
    for (const k of post.remove) delete env[k];
    if (post.set) Object.assign(env, post.set);
    return env;
  };
  const evil = { GIT_SSH_COMMAND: "evil", GIT_SSH: "/tmp/x", GIT_CONFIG_GLOBAL: "/tmp/g", OTHER: "1" };
  const withGit = apply({ ...evil }, CAND, LAUNCH);
  assert.ok(withGit.GIT_SSH_COMMAND.startsWith("ssh "), "the engine's command wins");
  assert.equal(withGit.GIT_CONFIG_GLOBAL, CAND + "/gitconfig");
  assert.equal(withGit.GIT_SSH, undefined, "GIT_SSH removed");
  assert.equal(withGit.OTHER, "1", "unrelated keys untouched");
  const withoutGit = apply({ ...evil }, null, LAUNCH);
  assert.deepEqual(withoutGit, evil, "today's behaviour, byte for byte");
});

// ---- 2. the real spawn -----------------------------------------------------

_resetPiSandboxForTest();
const SANDBOX = probePiSandbox({ force: true });
const noSandbox = SANDBOX.ok ? false : "pi sandbox unavailable here: " + SANDBOX.reason;
const noPidns = SANDBOX.ok && SANDBOX.pidns ? false : "no PID-namespace sandbox here: " + (SANDBOX.pidnsReason || SANDBOX.reason);
const PIDNS_SKIP = noSandbox || noPidns;

/** A public-key blob of the shape ssh writes: <len><type><len><bytes>. */
function syntheticKey(type) {
  const label = Buffer.from(type, "latin1");
  const body = Buffer.alloc(32, 0x5a);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(label.length);
  const blen = Buffer.alloc(4);
  blen.writeUInt32BE(body.length);
  return Buffer.concat([len, label, blen, body]).toString("base64");
}

/** A key dir of the shape checkKeyDir + botKeyStatus accept, with a meta.json for `createdAt`. */
function seedKeyDir(botId, { createdAt = CREATED_AT } = {}) {
  const dir = join(SECRETS, "bot-git", botId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const d of [SECRETS, join(SECRETS, "bot-git"), dir]) chmodSync(d, 0o700);
  const key = join(dir, "id_ed25519");
  writeFileSync(key, "fake-private-key-for-" + botId + "\n", { mode: 0o600 });
  chmodSync(key, 0o600);
  const pub = join(dir, "id_ed25519.pub");
  writeFileSync(pub, "ssh-ed25519 " + syntheticKey("ssh-ed25519") + " crow-bot:" + botId + "\n", { mode: 0o600 });
  chmodSync(pub, 0o600);
  writeFileSync(join(dir, "meta.json"),
    JSON.stringify({ bot_id: botId, created_at: createdAt, fingerprint: "SHA256:fake", generated_at: CREATED_AT }) + "\n",
    { mode: 0o600 });
  return dir;
}

test("fixture sanity: a seeded key dir passes the checks the bridge applies and its spawn files are written", () => {
  const dir = seedKeyDir("fixture-bot");
  assert.deepEqual(P.checkKeyDir(dir), { ok: true });
  const written = Store.writeSpawnFiles({ botId: "fixture-bot", displayName: "Fixture Bot" });
  assert.deepEqual(written, { ok: true });
  assert.match(readFileSync(join(dir, "gitconfig"), "utf8"), /noreply\+fixture-bot@crow-bot\.invalid/);
  assert.match(readFileSync(join(dir, "gitconfig"), "utf8"), /Fixture Bot \(Crow bot\)/);
  assert.match(readFileSync(join(dir, "known_hosts"), "utf8"), /^github\.com ssh-ed25519 /);
});

let seeded = false;
function seedDb(rows) {
  const db = new Database(CROW_DB_PATH);
  try {
    db.prepare("CREATE TABLE IF NOT EXISTS pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, definition TEXT, " +
      "enabled INTEGER NOT NULL DEFAULT 1, project_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)").run();
    db.prepare("DELETE FROM pi_bot_defs").run();
    const insert = db.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?)");
    for (const r of rows) insert.run(r.bot_id, r.display_name || r.bot_id, r.definition || "{}", r.enabled == null ? 1 : r.enabled, r.created_at || CREATED_AT, CREATED_AT);
  } finally { db.close(); }
}

/** A stub pi that reports the git facts it can see, then exits. */
function gitProbeStub() {
  const stub = join(SCRATCH, "stub-pi.mjs");
  writeFileSync(stub, [
    'import { existsSync } from "node:fs";',
    'const out = {',
    '  command: process.env.GIT_SSH_COMMAND === undefined ? null : process.env.GIT_SSH_COMMAND,',
    '  config: process.env.GIT_CONFIG_GLOBAL === undefined ? null : process.env.GIT_CONFIG_GLOBAL,',
    '  paths: JSON.parse(process.env.CROW_TEST_GIT_PATHS || "{}"),',
    '};',
    'for (const k of Object.keys(out.paths)) out.paths[k] = existsSync(out.paths[k]);',
    'process.stdout.write(JSON.stringify({ type: "git-report", ...out }) + "\\n");',
    'process.stdin.resume();',
  ].join("\n"));
  return stub;
}

/** The shared fixture: two key dirs, one enabled pi bot, one enabled non-pi bot. */
function seedSpawnFixture() {
  const botA = "spawn-bota", botB = "spawn-botb";
  const dirA = seedKeyDir(botA);
  seedKeyDir(botB);
  if (!seeded) {
    seeded = true;
    seedDb([
      { bot_id: botA, display_name: "Bot A", created_at: CREATED_AT },
      // botB's key dir exists but the bot is disabled, so it is not one of the
      // "enabled pi bots" the single-bot ruling counts (its key must never be
      // used by anyone else's spawn).
      { bot_id: botB, display_name: "Bot B", created_at: CREATED_AT, enabled: 0 },
      // An enabled NON-pi bot does not count towards "the only enabled bot".
      { bot_id: "other-engine", definition: JSON.stringify({ engine: "other" }) },
    ]);
  }
  const realSecrets = realpathSync(SECRETS);
  return { botA, botB, dirA, realSecrets, stub: gitProbeStub(),
    paths: {
      own: join(realSecrets, "bot-git", botA, "id_ed25519"),
      other: join(realSecrets, "bot-git", botB, "id_ed25519"),
      ownDir: join(realSecrets, "bot-git", botA),
    } };
}

/** A PiRpc whose stub reports git facts; `defBotId` goes into the DEF only. */
function spawnProbe(f, sessionName, { botId, defBotId } = {}) {
  const session = join(SCRATCH, sessionName);
  mkdirSync(join(session, "sessions"), { recursive: true });
  const def = { spawn_env: { CROW_TEST_GIT_PATHS: JSON.stringify(f.paths), GIT_SSH_COMMAND: "evil" } };
  if (defBotId) def.bot_id = defBotId;
  return new PiRpc({ def, sessionDir: session, resolved: { provider: "p", model: "m", key: "p/m" },
    nodeBin: process.execPath, cliPath: f.stub, botId,
    extraEnv: { CROW_TEST_GIT_PATHS: JSON.stringify(f.paths) } });
}

test("integration: a git-enabled bot gets its own key and no other; a def naming it does not", { skip: PIDNS_SKIP, timeout: 60000 }, async () => {
  const f = seedSpawnFixture();

  // A: opts.botId names the bot with a key dir.
  const first = spawnProbe(f, "session-a", { botId: f.botA });
  try {
    const report = await first.waitFor((m) => m.type === "git-report", 20000, "git-report");
    assert.ok(report.command && report.command.startsWith("ssh "), "GIT_SSH_COMMAND is the engine's: " + report.command);
    assert.ok(report.command.includes("-i " + f.realSecrets + "/bot-git/" + f.botA + "/id_ed25519"), "it names this bot's key");
    assert.equal(report.config, f.realSecrets + "/bot-git/" + f.botA + "/gitconfig");
    assert.equal(report.paths.own, true, "its own key is readable inside");
    assert.equal(report.paths.other, false, "another bot's key does not exist inside");
    assert.match(readFileSync(join(f.dirA, "gitconfig"), "utf8"), /noreply\+spawn-bota@crow-bot\.invalid/);
  } finally { await first.close(); }

  // B: the DEF says another bot's id, but there is no opts.botId: no git at
  // all, and that bot's key is not even visible (review item 3, end to end).
  const second = spawnProbe(f, "session-b", { defBotId: f.botB });
  try {
    const report = await second.waitFor((m) => m.type === "git-report", 20000, "git-report");
    assert.equal(report.command, "evil", "no key dir chosen: the def's own value is untouched (today's behaviour)");
    assert.equal(report.config, null);
    assert.equal(report.paths.own, false, "nothing is exposed");
    assert.equal(report.paths.other, false);
    assert.equal(report.paths.ownDir, false);
  } finally { await second.close(); }
});

// Runs anywhere (a plain spawn, no namespace): the bridge still FINDS the key
// dir and applies the removal, so the def's own GIT_* value can never survive
// a bot that was chosen for git — while the env is untouched for a spawn with
// no key dir. The positive (both vars set to the engine's) needs the pidns tier
// and lives in the test above.
test("integration: without a pidns tier the key dir is chosen but every GIT_* key is removed", async () => {
  const f = seedSpawnFixture();
  const prev = process.env.CROW_PI_SANDBOX;
  process.env.CROW_PI_SANDBOX = "off";
  try {
    const pi = spawnProbe(f, "session-off", { botId: f.botA });
    try {
      const report = await pi.waitFor((m) => m.type === "git-report", 20000, "git-report");
      assert.equal(report.command, null, "the def's GIT_SSH_COMMAND was removed, never kept");
      assert.equal(report.config, null, "GIT_CONFIG_GLOBAL was not set without a sandbox");
    } finally { await pi.close(); }
    const control = spawnProbe(f, "session-off-control", { defBotId: f.botA });
    try {
      const report = await control.waitFor((m) => m.type === "git-report", 20000, "git-report");
      assert.equal(report.command, "evil", "no opts.botId: today's behaviour, byte for byte");
    } finally { await control.close(); }
  } finally {
    if (prev === undefined) delete process.env.CROW_PI_SANDBOX; else process.env.CROW_PI_SANDBOX = prev;
  }
});

// ---- 3. the spawn-time fd handover (review BLOCKER) -------------------------
//
// What the bridge hands `spawn()` is only visible from the seams: `node:fs`'s
// openSync (which key dir descriptor Crow opened) and `node:child_process`'s
// spawn (the stdio array, the argv). Both are wrapped and re-published with
// syncBuiltinESMExports, so bridge.mjs's own named imports see them (the same
// pattern tests/roost-strip-data.test.js uses for readdirSync).
//
// The sandbox probe is PRIMED with a stub bwrap, so these need no real
// bubblewrap and never run a namespace: the child is a shell script that exits.
const fsCjs = createRequire(import.meta.url)("node:fs");
const cpCjs = createRequire(import.meta.url)("node:child_process");
const REAL_OPEN_SYNC = fsCjs.openSync;
const REAL_SPAWN = cpCjs.spawn;
let seamsOn = false;
let seamsKeyDir = null;    // the key dir this spawn is about
let seamsOnOpen = null;    // optional hook, run for every openSync path
let keyOpens = [];         // [{ fd, closedAtSpawn }] for seamsKeyDir
let spawnCalls = [];       // exactly what the bridge passed to spawn()

function armSeams({ keyDir = null, onOpen = null } = {}) {
  seamsKeyDir = keyDir;
  seamsOnOpen = onOpen;
  keyOpens = [];
  spawnCalls = [];
  if (seamsOn) return;
  seamsOn = true;
  fsCjs.openSync = function (p, ...rest) {
    const path = String(p);
    if (typeof seamsOnOpen === "function") seamsOnOpen(path);
    const fd = REAL_OPEN_SYNC.call(this, p, ...rest);
    if (seamsKeyDir && path === seamsKeyDir) keyOpens.push({ fd, closedAtSpawn: null });
    return fd;
  };
  cpCjs.spawn = function (cmd, args, opts) {
    // "closed in the parent BEFORE the spawn", checked at the exact moment the
    // bridge hands the child its fds: libuv recycles the lowest free numbers for
    // the pipes it creates during spawn, so a later fstat could see a reused
    // number and hide a leak.
    for (const o of keyOpens) {
      try { fstatSync(o.fd); o.closedAtSpawn = false; } catch { o.closedAtSpawn = true; }
    }
    spawnCalls.push({ cmd: String(cmd), args: Array.isArray(args) ? args.slice() : args,
      stdio: opts && Array.isArray(opts.stdio) ? opts.stdio.slice() : (opts && opts.stdio) });
    return REAL_SPAWN.call(this, cmd, args, opts);
  };
  syncBuiltinESMExports();
}

function disarmSeams() {
  if (!seamsOn) return;
  seamsOn = false;
  seamsKeyDir = null;
  seamsOnOpen = null;
  fsCjs.openSync = REAL_OPEN_SYNC;
  cpCjs.spawn = REAL_SPAWN;
  syncBuiltinESMExports();
}
after(disarmSeams);

/** The stub bwrap a primed probe names: exits at once, so nothing is really sandboxed. */
function bwrapStub() {
  const p = join(SCRATCH, "stub-bwrap.sh");
  writeFileSync(p, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

/** Prime pi_sandbox's probe for the NEXT spawn (the bridge and wrapPiSpawn both
 *  read that cache), running no bwrap at all. `bindFd` false is an older
 *  bubblewrap: its --help has no --ro-bind-fd. */
function primeProbe({ pidns = true, bindFd = true } = {}) {
  _resetPiSandboxForTest();
  return probePiSandbox({
    force: true, bwrap: bwrapStub(), bwrapHelp: bindFd ? "--ro-bind-fd" : "",
    runProbe: (bin, args) => (pidns || !args.includes("--unshare-pid") ? null : "bwrap cannot create a PID namespace here"),
  });
}

/** The descriptor is gone from this process: EBADF, or — if libuv recycled the
 *  number for a pipe after the close — at least no longer a directory. */
function assertFdGone(fd, what) {
  let st = null;
  try { st = fstatSync(fd); } catch (e) { assert.equal(e.code, "EBADF", what + ": " + e.message); return; }
  assert.equal(st.isDirectory(), false, what + ": fd " + fd + " still names a directory");
}

/** Nothing the child gets can reach the key dir. */
function assertNothingHandedOver(call) {
  const stdio = (call && call.stdio) || [];
  const at7 = 7 in stdio ? stdio[7] : undefined;
  assert.ok(at7 === undefined || at7 === "ignore", "stdio[7] is not a descriptor: " + String(at7));
  for (const o of keyOpens) {
    const at = stdio.map((x, i) => (x === o.fd ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(at, [], "the key dir fd must not appear on stdio");
  }
  assert.ok(!(call.args || []).includes("--ro-bind-fd"), "the argv must not bind the key dir");
}

test("bridge: a userns-only probe never opens the key dir fd, so nothing reaches the child", async () => {
  const f = seedSpawnFixture();
  const probe = primeProbe({ pidns: false });
  assert.deepEqual([probe.ok, probe.pidns, probe.bindFd], [true, false, true], "the userns tier, with a bwrap that could bind");
  armSeams({ keyDir: realpathSync(f.dirA) });
  const pi = spawnProbe(f, "session-userns", { botId: f.botA });
  try {
    assert.equal(spawnCalls.length, 1, "the spawn happened");
    assert.equal(pi.sandboxTier, "userns");
    assert.equal(keyOpens.length, 0, "gitPreSpawn refuses it: the fd is never even opened");
    assertNothingHandedOver(spawnCalls[0]);
  } finally { await pi.close(); }
});

test("bridge: an old bwrap without --ro-bind-fd never opens the key dir fd either", async () => {
  const f = seedSpawnFixture();
  const probe = primeProbe({ bindFd: false });
  assert.deepEqual([probe.ok, probe.pidns, probe.bindFd], [true, true, false]);
  armSeams({ keyDir: realpathSync(f.dirA) });
  const pi = spawnProbe(f, "session-old-bwrap", { botId: f.botA });
  try {
    assert.equal(spawnCalls.length, 1, "the spawn happened");
    assert.equal(pi.sandboxTier, "pidns");
    assert.equal(keyOpens.length, 0, "the fd is never even opened");
    assertNothingHandedOver(spawnCalls[0]);
  } finally { await pi.close(); }
});

test("bridge: an expose entry validExposed drops leaves the fd closed before the spawn", async () => {
  const f = seedSpawnFixture();
  const keyDir = realpathSync(f.dirA);
  primeProbe();                    // ok + pidns + bindFd: gitPreSpawn allows the fd
  // The key dir's mode changes in the window between its own checks and the
  // mount (the race validExposed's fstat is there to catch): wrapPiSpawn drops
  // the entry, so nothing in the argv consumes fd 7.
  armSeams({ keyDir, onOpen: (p) => { if (p === keyDir) chmodSync(keyDir, 0o755); } });
  let pi = null;
  try {
    pi = spawnProbe(f, "session-dropped", { botId: f.botA });
    assert.equal(spawnCalls.length, 1, "the spawn still happened");
    assert.equal(keyOpens.length, 1, "gitPreSpawn allowed it, so the bridge opened the key dir");
    assert.equal(keyOpens[0].closedAtSpawn, true, "and closed it BEFORE the spawn");
    assertNothingHandedOver(spawnCalls[0]);
    assertFdGone(keyOpens[0].fd, "the key dir fd");
  } finally {
    chmodSync(keyDir, 0o700);
    if (pi) await pi.close();
  }
});

test("bridge: a throw after the key dir fd is opened closes it (checkedInstanceSecretsDirs refuses the spawn)", () => {
  const f = seedSpawnFixture();
  const keyDir = realpathSync(f.dirA);
  primeProbe();                    // the fd IS opened on this path
  armSeams({ keyDir });
  // A remembered co-host whose secrets dir is gone: checkedInstanceSecretsDirs()
  // throws — and it runs AFTER the key dir fd was opened, before the launch.
  const known = join(SECRETS, "known-instance-secrets");
  writeFileSync(known, "1:2:/nonexistent/other-home/secrets\n", { mode: 0o600 });
  try {
    assert.throws(() => spawnProbe(f, "session-leak", { botId: f.botA }), /was hidden before and is gone or replaced/);
  } finally {
    rmSync(known, { force: true });
  }
  assert.equal(spawnCalls.length, 0, "nothing was spawned");
  assert.equal(keyOpens.length, 1, "the bridge had opened the key dir");
  assertFdGone(keyOpens[0].fd, "the key dir fd");
});
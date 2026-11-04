/**
 * Links that cross the shell's scopes (follow-up wave):
 *
 *  - no plain /dashboard/nest link outside the allowlist. In new mode a bare
 *    /dashboard/nest (or one carrying only ?project=) is a LANDING and answers
 *    303 to /dashboard/perch, so a link that means the classic Nest must say
 *    ?open=1 (see nestIsExplicit in dashboard/shell/request.js).
 *  - the federation audit warning opens the classic Nest (?open=1).
 *  - the "needs you" alert of a bot parked on the browser opens its chat in the
 *    session's own project (?project=<slug>), keeping take-over=1 and the hash.
 *
 * The third one drives the real interactive engine with a fake pi child (the
 * seam shape tests/browser-take-over.test.js uses): a scratch init-db'd
 * crow.db for the session rows, an injected bridge, an injected notification
 * sink, and an injected clock so no real timer ever runs.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

for (const k of Object.keys(process.env)) if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];
process.env.CROW_PI_SANDBOX = "off";

const dir = mkdtempSync(join(tmpdir(), "dashboard-nest-links-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.PI_MODELS_JSON = join(dir, "models.json");
const CROW_HOME = process.env.CROW_HOME;
const REPO = new URL("..", import.meta.url).pathname;

let createInteractiveEngine, _resetInteractiveEngineForTest;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  mkdirSync(CROW_HOME, { recursive: true });
  writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({ providers: { "crow-local": { models: [{ id: "qwen3.6-35b-a3b" }] } } }));
  const mod = await import("../servers/gateway/perch-interactive.js");
  createInteractiveEngine = mod.createInteractiveEngine;
  _resetInteractiveEngineForTest = mod._resetInteractiveEngineForTest;
});

after(() => {
  try { if (_resetInteractiveEngineForTest) _resetInteractiveEngineForTest(); } catch { /* best effort */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ---------------------------------------------------------------------------
// 1. the scan: a bare /dashboard/nest is a landing, never a link
// ---------------------------------------------------------------------------

/**
 * Files whose /dashboard/nest is not a link the operator taps into the nest:
 * the service worker's precached shell, the gateway's own route + its landing
 * check, the nest panel's peer links (an SSO launch target, another
 * instance's own nest), and the companion's window-manager map.
 */
const ALLOWED = new Set([
  "servers/gateway/public/sw.js",
  "servers/gateway/dashboard/index.js",
  "servers/gateway/dashboard/shell/request.js",
  "servers/gateway/dashboard/panels/nest/html.js",
  "bundles/companion/scripts/crow-wm.js",
]);
const SKIP_DIRS = new Set(["node_modules", "vendor", ".git"]);

/** A quoted string literal naming the Nest's path; a `?` after it means explicit
 *  (?open=1, ?flash=…, ?action=…, ?card=…), which the landing rule honors, and a
 *  `/` means a sub-route (/dashboard/nest/backup), never a landing. */
const LITERAL_RE = /(["'`])\/dashboard\/nest(?!\?|\/)/;
/** A comment line is prose about the path, not a link. */
const COMMENT_RE = /^\s*(\/\/|\*|\/\*)/;
/** A panel's own route registration names the page; it is not a link to it. */
const ROUTE_RE = /\broute:\s*$/;

function walk(root, out = []) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(join(root, e.name), out); continue; }
    if (e.isFile() && /\.(js|mjs)$/.test(e.name)) out.push(join(root, e.name));
  }
  return out;
}

test("no plain /dashboard/nest link outside the allowlist", () => {
  const offenders = [];
  for (const file of [...walk(join(REPO, "servers")), ...walk(join(REPO, "bundles"))]) {
    const rel = relative(REPO, file);
    if (ALLOWED.has(rel)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (COMMENT_RE.test(line)) continue;
      const m = LITERAL_RE.exec(line);
      if (!m) continue;
      if (ROUTE_RE.test(line.slice(0, m.index))) continue;
      offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a bare /dashboard/nest sends a new-mode device to Chat: write /dashboard/nest?open=1",
  );
});

// ---------------------------------------------------------------------------
// 2. the federation audit warning
// ---------------------------------------------------------------------------

test("the federation audit warning opens the classic Nest", async () => {
  const { _resetAuditBreaker, _setAlertChannels, isAuditDegraded, auditCrossHostCall } =
    await import("../servers/shared/cross-host-auth.js");
  const hs = await import("../servers/gateway/dashboard/panels/nest/health-signals.js");
  try {
    // Stub the two DB-free alert channels: this test trips the breaker on purpose.
    _setAlertChannels({ sendNtfyNotification: async () => {}, sendEmailNotification: async () => {} });
    const corrupt = { execute: async () => { throw new Error("database disk image is malformed"); } };
    for (let i = 0; i < 3; i++) await auditCrossHostCall(corrupt, { direction: "in", action: "whoami" });
    assert.equal(isAuditDegraded(), true, "three structural failures open the audit breaker");
    hs._setDiskReader(() => "Filesystem 1024-blocks Used Available Capacity\n/dev/x 1000000 100000 900000 10%\n");
    hs._setTailscaleReader(() => "{}");
    hs._setArtifactNodeReader(async () => null);
    hs.invalidateHealthCache();
    const r = await hs.collectHealthSignals(null, { now: () => Date.now(), lang: "en" });
    const issue = r.issues.find((x) => x.id === "federationAudit");
    assert.ok(issue, "the degraded audit DB is an issue in the Nest");
    assert.equal(issue.severity, "warn");
    // A bare /dashboard/nest would be a landing in new mode (303 back to Chat).
    assert.equal(issue.actionHref, "/dashboard/nest?open=1");
  } finally {
    _resetAuditBreaker();
    _setAlertChannels(null);
    hs._setDiskReader(null);
    hs._setTailscaleReader(null);
    hs._setArtifactNodeReader(null);
    hs.invalidateHealthCache();
  }
});

// ---------------------------------------------------------------------------
// 3. the "needs you" alert of a bot parked on the browser
// ---------------------------------------------------------------------------

let pidSeq = 910000;

function makeClock() {
  let t = 1_700_000_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer(fn, ms) { const id = ++seq; timers.set(id, { fn, at: t + Number(ms) }); return id; },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      const target = t + ms;
      for (;;) {
        let pick = null;
        for (const [id, e] of timers) if (e.at <= target && (pick === null || e.at < pick.entry.at)) pick = { id, entry: e };
        if (!pick) break;
        timers.delete(pick.id);
        t = pick.entry.at;
        pick.entry.fn();
      }
      t = target;
    },
  };
}
const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function makeBridge(project) {
  const state = { instances: [] };
  class FakePi {
    constructor(o) {
      this.opts = o; this.onEvent = o.onEvent; this.turns = []; this.closed = 0; this.aborts = 0; this._exitCode = null;
      this.proc = { pid: ++pidSeq }; this.piSessionId = "pisess-" + this.proc.pid;
      let done; this.exited = new Promise((r) => { done = r; }); this._done = done;
      state.instances.push(this);
    }
    async getState() { return { data: { sessionId: this.piSessionId } }; }
    async getSessionStats() { return { data: { tokens: { input: 1, output: 1, cacheRead: 0 } } }; }
    promptTurn(message, ms, images) {
      const rec = { message, ms, images };
      rec.promise = new Promise((resolve, reject) => { rec.resolve = resolve; rec.reject = reject; });
      this.turns.push(rec); return rec.promise;
    }
    trimLog() {}
    async abortSince() { this.aborts += 1; return null; }
    send() {}
    async close() { this.closed += 1; this.exit(0); }
    exit(code = 0) { if (this._exitCode != null) return; this._exitCode = code; this._done(code); }
    _exitError() { return new Error("pi exited (code " + this._exitCode + ")"); }
    emit(m) { this.onEvent(m); }
    lastTurn() { return this.turns[this.turns.length - 1]; }
  }
  const resolved = { provider: "crow-local", model: "qwen3.6-35b-a3b", key: "crow-local/qwen3.6-35b-a3b", escalated: false, source: "default" };
  return {
    _state: state, PiRpc: FakePi, LIFECYCLE_DEFAULTS: { maxPi: 8 }, countLivePi: () => 0,
    async buildBotWorld(args) {
      return {
        def: { session_dir: join(dir, "bots", args.botId), permission_policy: { bash: "deny", write_paths: [] } },
        bot: { bot_id: args.botId }, crowHome: CROW_HOME,
        // The world builder's own project space (bridge loadProjectSpace): the
        // row for the bot's project, or null with no project / an archived one.
        projectId: project ? project.id : null, projectSpace: project, projectMembers: [],
        sessionDir: join(dir, "bots", args.botId), tasksDbPath: join(dir, "tasks.db"),
        remoteEnabled: false, peerGatewayUrls: {}, session: null, narrowedTools: null, gatewayType: args.gatewayType,
      };
    },
    async prepareSpawn(world) {
      return { sysFile: join(dir, "sys.md"), selfAuthoringDir: null, resolved,
        piRpcOpts: { def: world.def, sessionDir: world.sessionDir, resolved, selfAuthoringDir: null, remoteEnabled: false, narrowedTools: null } };
    },
    async warmModel() {}, async meterTurn() { return { recorded: true }; }, appendAudit() {},
  };
}

let leaseSeq = 0;
function makeEngine(project) {
  const clock = makeClock();
  const bridge = makeBridge(project);
  const leaseDir = join(dir, "lease-" + (++leaseSeq));
  mkdirSync(leaseDir, { recursive: true });
  const notes = [];
  const notifications = {
    async createNotification(_db, opts) { notes.push(opts); return { id: notes.length }; },
    async upsertGroupedNotification() { return { created: true }; },
    async closeNotificationGroup() {},
    async repushNotificationGroup() { return null; },
  };
  const engine = createInteractiveEngine({
    crowHome: CROW_HOME, env: { CROW_HOME }, bridge,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    log: () => {}, notifications,
    browserLease: { installed: true, dir: leaseDir, isAlive: () => false },
  });
  return { engine, clock, state: bridge._state, notes };
}

const WAIT = "mcp__browser__crow_browser_wait_for_user";
const parked = { content: [{ type: "text", text: JSON.stringify({ status: "waiting_for_user", message: "2FA code" }, null, 2) }] };

/** Spawn, start a turn, and let the bot park on wait_for_user. */
async function parkedTurn(h) {
  const s = await h.engine.spawn({ botId: "botty" });
  await tick();
  await h.engine.message(s.sessionId, "log in");
  const pi = h.state.instances[0];
  pi.emit({ type: "tool_execution_start", toolName: WAIT, toolCallId: "w1", args: { message: "2FA code" } });
  pi.emit({ type: "tool_execution_end", toolName: WAIT, toolCallId: "w1", isError: false, result: parked });
  await tick();
  return s;
}

test("the needs-you alert links to the session's project", async () => {
  const project = { id: 7, slug: "garden", name: "Garden", archived_at: null };
  const h = makeEngine(project);
  const s = await parkedTurn(h);
  const note = h.notes.find((n) => n.type === "attention");
  assert.ok(note, "a parked bot raises one needs-you item");
  // A link without ?project= would open whatever scope the operator last had.
  assert.equal(
    note.action_url,
    "/dashboard/perch?project=garden&take-over=1#" + s.sessionId,
    "the chat opens in the session's project, with the Take over sheet and its hash",
  );
  // A session with no live project (no project space, or an archived one) keeps
  // the bare link: there is no project to scope it to.
  const bare = makeEngine(null);
  const s2 = await parkedTurn(bare);
  const note2 = bare.notes.find((n) => n.type === "attention");
  assert.ok(note2, "the unfiled session raises its item too");
  assert.equal(note2.action_url, "/dashboard/perch?take-over=1#" + s2.sessionId);
});
/**
 * The credential canary harness (credential card spec §10.3 item 1): a known random value goes
 * through a path, then every sink a secret could leak into is grepped for it. Zero hits is the
 * pass.
 *
 * It runs the REAL Perch interactive engine (a fake pi behind the PiRpc seam, the
 * perch-interactive.test.js shape), the REAL perch-api router behind the REAL CSRF middleware,
 * and the REAL services-api router, against a scratch init-db'd crow.db and a scratch CROW_HOME.
 * It never touches ~/.crow and never spawns pi.
 *
 *   const h = await createCanaryHarness();
 *   const canary = makeCanary();
 *   const s = await h.spawnSession();               // engine session, frames collected
 *   await h.post(`/dashboard/perch-api/interactive/${s.sessionId}/message`, { message: canary });
 *   assert.deepEqual(await h.grepEverywhere(canary), []);
 *   await h.close();
 *
 * Sinks grepped (hit.sink): "console" (every console.* call while the harness is open, plus the
 * engine's log), "frames" (every engine event a subscriber saw: what the SSE stream and the
 * Activity rail carry), "model" (the fake pi's sent frames, turn prompts and images: what the
 * model would see), "seam" (the engine's audit and meter calls), "db-bytes" (crow.db, tasks.db
 * and their -wal/-shm files, raw bytes), "tables" (perch_session_files, audit_log,
 * project_audit_log, notifications), "files" (every file under the scratch CROW_HOME and data
 * dir), "responses" (every HTTP response body the harness received).
 *
 * No pi transcript JSONL sink, by design: the fake pi writes none, and a secret's value never
 * goes to pi at all, so the "model" sink (everything pi would receive: sent frames, turn
 * prompts, images) is the boundary that matters. A transcript is only what pi received.
 *
 * The default allowlist is the one by-design copy: `secrets/pi-bot-secret-values` under
 * CROW_HOME (the masking values file, map §4). Pass `allow` to add more (see grepEverywhere).
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { format } from "node:util";
import http from "node:http";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A random 32-character canary with upper, lower and digit characters (so the detector's
 *  entropy rule would also see it). */
export function makeCanary(length = 32) {
  for (;;) {
    const bytes = randomBytes(length * 2);
    let s = "";
    for (const b of bytes) {
      if (b >= 248) continue; // 248 = 62 * 4: unbiased
      s += ALNUM[b % 62];
      if (s.length === length) break;
    }
    if (s.length === length && /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s)) return s;
  }
}

/** Capture every console.* call (formatted as console would print it). Quiet by default;
 *  `tee: true` also passes the lines through. stop() restores console. */
export function captureConsole({ tee = false } = {}) {
  const lines = [];
  const methods = ["log", "info", "warn", "error", "debug", "trace"];
  const orig = {};
  for (const m of methods) {
    orig[m] = console[m];
    console[m] = (...args) => {
      lines.push(format(...args));
      if (tee) orig[m].apply(console, args);
    };
  }
  return { lines, stop() { Object.assign(console, orig); } };
}

function walkFiles(root) {
  const out = [];
  if (!existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) stack.push(p);
      else if (st.isFile()) out.push(p);
    }
  }
  return out;
}

const DEFAULT_ALLOW = [{ sink: "files", path: "secrets/pi-bot-secret-values" }];

function allowed(hit, allow) {
  return allow.some((a) => {
    if (typeof a === "function") return a(hit);
    if (a.sink && a.sink !== hit.sink) return false;
    if (a.path && hit.path !== a.path) return false;
    if (a.where && hit.where !== a.where) return false;
    return true;
  });
}

/** One fake pi (the perch-interactive.test.js FakePi, trimmed to what a canary run needs). */
function makeBridge(dir, crowHome) {
  let pidSeq = 700000;
  const state = { instances: [], audit: [], meter: [] };
  class FakePi {
    constructor(o) {
      this.opts = o;
      this.onEvent = o.onEvent;
      this.sent = [];
      this.turns = [];
      this._exitCode = null;
      this.proc = { pid: ++pidSeq };
      this.piSessionId = "pisess-" + this.proc.pid;
      this.statsSeq = 0;
      let done;
      this.exited = new Promise((r) => { done = r; });
      this._done = done;
      state.instances.push(this);
    }
    async getState() { return { data: { sessionId: this.piSessionId } }; }
    async getSessionStats() {
      this.statsSeq += 1;
      return { data: { tokens: { input: 10 * this.statsSeq, output: 5 * this.statsSeq, cacheRead: 0 } } };
    }
    promptTurn(message, ms, images) {
      const rec = { message, ms, images };
      rec.promise = new Promise((resolve, reject) => { rec.resolve = resolve; rec.reject = reject; });
      this.turns.push(rec);
      return rec.promise;
    }
    trimLog() {}
    async abortSince() { return null; }
    send(o) {
      if (this._exitCode != null) throw new Error("pi exited");
      this.sent.push(o);
    }
    async close() { this.exit(0); }
    exit(code = 0) {
      if (this._exitCode != null) return;
      this._exitCode = code;
      this._done(code);
    }
    _exitError() { return new Error("pi exited (code " + this._exitCode + ") before responding"); }
    emit(m) { this.onEvent(m); }
    lastTurn() { return this.turns[this.turns.length - 1]; }
  }
  const modelKey = "crow-local/qwen3.6-35b-a3b";
  return {
    _state: state,
    PiRpc: FakePi,
    LIFECYCLE_DEFAULTS: { maxPi: 4 },
    countLivePi: () => 0,
    async buildBotWorld(args) {
      const sessionDir = join(dir, "bots", args.botId);
      return {
        def: { session_dir: sessionDir, permission_policy: { bash: "deny", write_paths: [] } },
        bot: { bot_id: args.botId },
        crowHome, projectId: null, projectSpace: null, projectMembers: [],
        sessionDir, tasksDbPath: join(dir, "data", "tasks.db"),
        remoteEnabled: false, peerGatewayUrls: {}, session: null, narrowedTools: null,
        gatewayType: args.gatewayType,
      };
    },
    async prepareSpawn(world) {
      const resolved = { provider: "crow-local", model: "qwen3.6-35b-a3b", key: modelKey, escalated: false, source: "default", escalationRequestedButUnavailable: false };
      return {
        sysFile: join(dir, "sys.md"), selfAuthoringDir: null, resolved,
        piRpcOpts: { def: world.def, sessionDir: world.sessionDir, resolved, selfAuthoringDir: null, remoteEnabled: false, narrowedTools: null, appendSystemPromptFile: join(dir, "sys.md") },
      };
    },
    async warmModel() {},
    async meterTurn(args) { state.meter.push(args); return { recorded: true }; },
    appendAudit(projectId, o) { state.audit.push({ projectId, ...o }); },
  };
}

/** Timers the engine arms (idle, stall, lease refresh) are held, never fired: a canary run is
 *  not about timing, and a real timer would keep the test process alive. */
function heldClock() {
  let t = 1_700_000_000_000, seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer(fn, ms) { const id = ++seq; timers.set(id, { fn, at: t + Number(ms) }); return id; },
    clearTimer(id) { timers.delete(id); },
  };
}

const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/**
 * Build the harness. Sets CROW_HOME / CROW_DATA_DIR / CROW_TASKS_DB_PATH / PI_MODELS_JSON for
 * this process BEFORE importing any gateway module, so call it before anything else imports
 * servers/db.js. Options:
 *   - services: mount the services-api router (default true), with a fake Connect test.
 *   - teeConsole: pass captured console lines through (debugging only).
 */
export async function createCanaryHarness({ services = true, teeConsole = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "crow-canary-"));
  const dataDir = join(dir, "data");
  const crowHome = join(dir, "home");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(crowHome, { recursive: true });
  process.env.CROW_DATA_DIR = dataDir;
  process.env.CROW_HOME = crowHome;
  delete process.env.CROW_DB_PATH;
  process.env.CROW_TASKS_DB_PATH = join(dataDir, "tasks.db");
  process.env.PI_MODELS_JSON = join(dir, "models.json");
  process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
  writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({ providers: { "crow-local": { models: [{ id: "qwen3.6-35b-a3b" }] } } }));
  writeFileSync(join(dir, "sys.md"), "");
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dataDir }, stdio: "pipe", cwd: REPO });
  const dbFile = join(dataDir, "crow.db");

  const cap = captureConsole({ tee: teeConsole });
  const responses = [];
  const frames = [];
  const unsubs = [];

  const { default: express } = await import("express");
  const { createDbClient } = await import("../../servers/db.js");
  const { createInteractiveEngine } = await import("../../servers/gateway/perch-interactive.js");
  const { default: perchInteractiveApiRouter } = await import("../../servers/gateway/routes/perch-interactive-api.js");
  const { csrfMiddleware } = await import("../../servers/gateway/dashboard/shared/csrf.js");
  const { parseCookies } = await import("../../servers/gateway/dashboard/auth.js");

  const bridge = makeBridge(dir, crowHome);
  const clock = heldClock();
  const engine = createInteractiveEngine({
    crowHome,
    env: { CROW_HOME: crowHome },
    bridge,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    // The gateway's own default log line, so it lands in the console sink.
    log: (m) => console.log("[perch-interactive] " + m),
    hiddenDirs: [],
  });

  // A project for the services connect path.
  const db = createDbClient(dbFile);
  await db.execute({ sql: "INSERT INTO project_spaces (slug, name) VALUES (?, ?)", args: ["home", "Home"] });

  const app = express();
  // Express skips its stack log when env is "test"; the canary must see what prod would print.
  app.set("env", "development");
  // The gateway's global 1mb JSON parser, skipping the routes that parse their own body: the
  // same predicate as servers/gateway/index.js `_hasOwnParser` for the prefixes mounted here.
  const globalJson = express.json({ limit: "1mb" });
  const hasOwnParser = (p) => /^\/dashboard\/perch-api\/interactive\/[^/]+\/(files|message)$/.test(p) || p.toLowerCase().startsWith("/dashboard/services/api/");
  app.use((req, res, next) => (hasOwnParser(req.path) ? next() : globalJson(req, res, next)));

  const sessionGate = (req, res, next) => {
    if (parseCookies(req).crow_session !== "good") return res.status(401).json({ error: "unauthorized" });
    req.dashboardSession = "good";
    next();
  };
  const connectTests = [];
  if (services) {
    const { servicesApiRouter } = await import("../../servers/gateway/routes/services-api.js");
    const { refreshGatewaySecretValues } = await import("../../servers/shared/secret-values-collect.js");
    app.use(servicesApiRouter({
      dbFactory: () => createDbClient(dbFile),
      sessionGate,
      testConnection: async (service) => { connectTests.push(service.id); return { ok: true }; },
      installedIds: () => new Set(["github"]),
      uiEnabled: () => true,
      crowHome,
      reservedNames: () => new Set(),
      refreshMasking: () => refreshGatewaySecretValues({ env: { ...process.env, CROW_HOME: crowHome, CROW_DATA_DIR: dataDir }, dbPath: dbFile }),
    }));
  }
  const dash = express.Router();
  dash.use("/dashboard", csrfMiddleware);
  dash.use(perchInteractiveApiRouter(sessionGate, {
    engine: () => engine,
    annotate: async (m) => m, providerModels: () => [], piProviders: () => null,
  }));
  app.use(dash);
  // The gateway's last handler (servers/gateway/index.js registers it after every router).
  const { bodyErrorHandler } = await import("../../servers/gateway/body-error-handler.js");
  app.use(bodyErrorHandler);
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const port = server.address().port;

  const AUTH = { cookie: "crow_session=good; crow_csrf=tok", "x-crow-csrf": "tok" };

  /** POST `body` (an object is JSON-encoded; a string is sent as-is, so a malformed body is a
   *  plain string). Returns { status, text, json }. */
  function post(path, body, { headers = {}, contentType = "application/json" } = {}) {
    const payload = typeof body === "string" ? body : JSON.stringify(body == null ? {} : body);
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1", port, path, method: "POST",
        headers: { "content-type": contentType, "content-length": Buffer.byteLength(payload), ...AUTH, ...headers },
      }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* not JSON */ }
          responses.push({ path, status: res.statusCode, text });
          resolve({ status: res.statusCode, text, json });
        });
      });
      req.on("error", reject);
      req.end(payload);
    });
  }

  /** Spawn an engine session and collect every event it emits into `frames`. */
  async function spawnSession(botId = "canary-bot") {
    const r = await engine.spawn({ botId });
    await tick();
    const off = await engine.subscribe(r.sessionId, (e) => frames.push({ sessionId: r.sessionId, event: e }));
    unsubs.push(off);
    return r;
  }

  /** The newest fake pi (the one a spawned session drives). */
  const pi = () => bridge._state.instances[bridge._state.instances.length - 1];

  /** End the in-flight turn with an assistant reply. */
  async function endTurn(text = "ok") {
    const p = pi();
    const t = p && p.lastTurn();
    if (t) t.resolve({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text }] }] });
    await tick();
  }

  /** Raw keychain rows (sealed values) for the sealed-row check. */
  async function keychainRows() {
    const has = (await db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='crow_keychain'")).rows.length;
    if (!has) return [];
    return (await db.execute("SELECT * FROM crow_keychain ORDER BY id")).rows;
  }

  /** Decrypt one keychain row with the scratch home's key. */
  async function openKeychain(id) {
    const { loadKeychainKey } = await import("../../servers/gateway/keychain/key.js");
    const { openEntrySecret } = await import("../../servers/gateway/keychain/store.js");
    return openEntrySecret(db, loadKeychainKey({ crowHome }), id);
  }

  /**
   * Every place `canary` shows up: [{ sink, where, path? }]. A hit is the whole canary or any
   * `fragment`-character piece of it (default 10: Node's JSON.parse error quotes a 10-character
   * window of the body, so a parser message leaks part of a secret, never all of it). `allow`
   * entries extend the default allowlist; each is a predicate (hit) => bool or
   * { sink?, path?, where? } (all given fields must match; `path` is relative to CROW_HOME for
   * "files" hits). An empty array is the pass.
   */
  async function grepEverywhere(canary, { allow = [], fragment = 10 } = {}) {
    const needle = String(canary);
    if (needle.length < 8) throw new Error("grepEverywhere: canary too short to grep for");
    const len = Math.min(Math.max(8, fragment), needle.length);
    const pieces = [];
    for (let i = 0; i + len <= needle.length; i++) pieces.push(needle.slice(i, i + len));
    const pieceBytes = pieces.map((p) => Buffer.from(p, "utf8"));
    const has = (str) => pieces.some((p) => str.includes(p));
    const hasBytes = (buf) => pieceBytes.some((p) => buf.includes(p));
    const hits = [];
    const add = (sink, where, path) => hits.push(path ? { sink, where, path } : { sink, where });
    const inText = (v) => {
      try { return has(typeof v === "string" ? v : JSON.stringify(v) || ""); } catch { return false; }
    };

    cap.lines.forEach((l, i) => { if (has(l)) add("console", "line " + i); });
    frames.forEach((f, i) => { if (inText(f.event)) add("frames", `${f.event && f.event.type} #${i}`); });
    for (const p of bridge._state.instances) {
      p.sent.forEach((o, i) => { if (inText(o)) add("model", `pi ${p.proc.pid} sent #${i}`); });
      p.turns.forEach((t, i) => {
        if (inText(t.message)) add("model", `pi ${p.proc.pid} turn #${i} prompt`);
        if (t.images && inText(t.images)) add("model", `pi ${p.proc.pid} turn #${i} images`);
      });
    }
    bridge._state.audit.forEach((a, i) => { if (inText(a)) add("seam", "audit #" + i); });
    bridge._state.meter.forEach((m, i) => { if (inText({ ...m, resolved: undefined })) add("seam", "meter #" + i); });
    responses.forEach((r, i) => { if (has(r.text)) add("responses", `${r.path} #${i}`); });

    for (const base of [dbFile, join(dataDir, "tasks.db")]) {
      for (const f of [base, base + "-wal", base + "-shm", base + "-journal"]) {
        if (existsSync(f) && hasBytes(readFileSync(f))) add("db-bytes", relative(dir, f));
      }
    }
    for (const table of ["perch_session_files", "audit_log", "project_audit_log", "notifications"]) {
      const has = (await db.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", args: [table] })).rows.length;
      if (!has) { add("tables", table + " (missing table: the harness cannot vouch for it)"); continue; }
      const { rows } = await db.execute(`SELECT * FROM ${table}`);
      rows.forEach((r, i) => { if (inText(r)) add("tables", `${table} row ${i}`); });
    }
    for (const root of [crowHome, dataDir, join(dir, "bots")]) {
      for (const f of walkFiles(root)) {
        if (!hasBytes(readFileSync(f))) continue;
        const path = f.startsWith(crowHome + "/") ? relative(crowHome, f) : relative(dir, f);
        add("files", path, path);
      }
    }
    return hits.filter((h) => !allowed(h, [...DEFAULT_ALLOW, ...allow]));
  }

  async function close() {
    for (const off of unsubs) { try { off(); } catch { /* gone */ } }
    try { await engine.stopAll(); } catch { /* best effort */ }
    cap.stop();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    try { db.close(); } catch { /* closed */ }
    rmSync(dir, { recursive: true, force: true });
  }

  /** Mount another router behind the same CSRF rail and session gate (a later task's route,
   *  e.g. the secret submit route). Its paths are reached because the harness has no 404. */
  function mountDashboard(router) { dash.use(router); }

  return {
    dir, dataDir, crowHome, dbFile, db, engine, bridge, frames, responses, connectTests,
    console: cap, AUTH, sessionGate,
    post, spawnSession, mountDashboard, pi, endTurn, keychainRows, openKeychain, grepEverywhere, close, tick,
  };
}

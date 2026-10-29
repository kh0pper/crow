/**
 * Two REAL gateways, paired through the REAL pairing ceremony (PT-1 §1.5).
 *
 * Each instance is its own child process (`node servers/gateway/index.js`)
 * with its own scratch home: CROW_HOME, data dir, crow.db, peer-tokens.json,
 * instances.json, on a free 127.0.0.1 port. One process per instance is the
 * point: peerTokensFile() resolves from process.env, so two instances in one
 * process would share one credential store and could not model "A deleted
 * B's key while B kept A's".
 *
 * Every request reaches a gateway through a Tailscale-Serve-shaped relay in
 * the test process (tests/fixtures/serve-peer.mjs): it replaces
 * X-Forwarded-For with the caller's fake tailnet address and sets
 * X-Forwarded-Host. The children run with CROW_SERVE_PEER_UIDS = this uid, so
 * the relay's loopback socket is what the gateway honours as Serve.
 *
 * Pairing runs `scripts/cli/instance-pair.js` as the enroller (its own env)
 * against the peer's real /instance/enroll-request route. Signed calls run
 * the real forwardSignedRequest inside a separate SIGNER child with the
 * caller's env (no test-only code path in the gateway). Nothing is
 * hand-inserted except where a test says so (the legacy trusted=0 shape).
 */
import { spawn, execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { generateEnrollOtc } from "../../servers/shared/enroll-guard.js";
import { ensureSyncTables } from "../../servers/shared/sync-stamp.js";

export const REPO = new URL("../..", import.meta.url).pathname;
const UID = String(typeof process.getuid === "function" ? process.getuid() : 0);
export const sha = (s) => createHash("sha256").update(s).digest("hex");

/**
 * A gateway port, probed free on the gateway's own bind (0.0.0.0) and taken
 * from BELOW the kernel's ephemeral range. The port stays unbound while the
 * gateway is down (between init and boot, and across every reboot of a
 * pairing), and a port from listen(0) is one the kernel hands straight back
 * to the next listen(0) or outbound connect on the host: in CI, another test
 * file's gateway once took a peer's port while it rebooted into pairing mode,
 * answered /health, and refused the enroll (enrollment_disabled). Below the
 * ephemeral range only an explicit picker can collide; boot() also checks
 * that its own child is the listener.
 */
function ephemeralLow() {
  try { return Number(readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/)[0]) || 32768; } catch { return 32768; }
}
const PORT_LO = 10_000;
function probe(port) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "0.0.0.0", () => s.close(() => resolve(true)));
  });
}
async function freePort() {
  const hi = Math.min(ephemeralLow(), 32768);
  for (let i = 0; i < 200; i++) {
    const port = PORT_LO + Math.floor(Math.random() * (hi - PORT_LO));
    if (await probe(port)) return port;
  }
  throw new Error("peer-pair: no free port below the ephemeral range");
}

const SCRUB = ["CROW_HOME", "CROW_DATA_DIR", "CROW_DB_PATH", "CROW_BACKUP_DIR", "CROW_INSTANCES_JSON_PATH", "CROW_REFCOUNT_PATH",
  "CROW_PEER_TOKENS_PATH", "NTFY_TOPIC", "CROW_GATEWAY_URL", "PORT", "CROW_GATEWAY_PORT", "CROW_ENROLL_OTC", "CROW_ENROLL_ENABLED",
  "CROW_PEER_GATEWAY_URL", "CROW_DASHBOARD_PUBLIC", "CROW_APP_ENV_PATH"];

/** A Serve-shaped relay in front of `port`, presenting callers as `clientIp`. */
async function startRelay(port, clientIp) {
  const relay = createServer((inReq, inRes) => {
    const headers = { ...inReq.headers, "x-forwarded-for": clientIp, "x-forwarded-host": inReq.headers.host };
    const out = request({ host: "127.0.0.1", port, path: inReq.url, method: inReq.method, headers }, (r) => {
      inRes.writeHead(r.statusCode, r.headers);
      r.pipe(inRes);
    });
    out.on("error", () => { if (!inRes.headersSent) inRes.statusCode = 502; inRes.end(); });
    inReq.pipe(out);
  });
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));
  return relay;
}

/** The pre-PT-2a main (PT-3, #594): the old tree of the pair-binding gate. */
export const PT3_SHA = "d733b582bbbc977a377c60bf95893cf2d5902635";
const LOCAL_DHT = new URL("./gateway-local-dht.mjs", import.meta.url).href;
const OLD_TREE_TIMING = new URL("./old-tree-timing.mjs", import.meta.url).href;
/**
 * Advertised as this host's tailnet IP in sync legs. Not a tailnet address,
 * so it is never advertised in a handshake nor accepted by enroll, and the
 * gateway never shells out to the dev box's tailscaled (whose real address
 * would let a peer learn it and ladder onto the box's LIVE 3001/3002).
 */
const NO_TAILNET_IP = "192.0.2.1";

/**
 * Sync-leg timer overrides (servers/shared/test-timing.js: honoured only in
 * the suite's scratch env, which every child inherits). Production waits a
 * minute for the outbox drain and the rescan and backs off to a minute
 * between dials; the gate's legs wait on those ticks. An old-tree child does
 * not read these; tests/fixtures/old-tree-timing.mjs swaps its drain timer
 * alone, and its dial backoff and rescan keep production's cadence.
 */
export const SYNC_TIMING = {
  CROW_TEST_SYNC_DRAIN_MS: 1_000,
  CROW_TEST_TAILNET_RETRY_BASE_MS: 500,
  CROW_TEST_TAILNET_RETRY_MAX_MS: 2_000,
  CROW_TEST_TAILNET_IDLE_RECHECK_MS: 1_000,
  CROW_TEST_TAILNET_RESCAN_MS: 2_000,
};

export class Instance {
  /**
   * `repo`: the tree the gateway, the pair CLI and the stdio marker writer run
   * from (an old tree from tests/fixtures/old-tree.mjs, or this checkout).
   * `id`: a fixed instance id (tests that need a given dialer election).
   */
  constructor(name, ip, { repo = REPO, id = null } = {}) {
    this.name = name;
    this.ip = ip;
    this.repo = repo;
    // Sync legs (useLoopbackSync): the gateway runs instance sync over
    // tailnet only. Off by default: the PT-1 legs keep the suite's switch.
    this.sync = false;
    this.dir = mkdtempSync(join(tmpdir(), `pt-gw-${name}-`));
    this.dataDir = join(this.dir, "data");
    mkdirSync(this.dataDir, { recursive: true });
    this.id = id || `inst-${name}-${randomBytes(4).toString("hex")}`;
    writeFileSync(join(this.dataDir, "instance-id"), `${this.id}\n`);
    // The store lives in the hidden secrets dir (an override naming the old
    // <CROW_HOME>/peer-tokens.json default is treated as outdated and moved).
    mkdirSync(join(this.dir, "secrets"), { recursive: true, mode: 0o700 });
    this.tokensPath = join(this.dir, "secrets", "peer-tokens.json");
    this.log = "";
    this.child = null;
  }

  get env() {
    const env = { ...process.env };
    for (const k of SCRUB) delete env[k];
    Object.assign(env, {
      HOME: this.dir,
      CROW_HOME: this.dir,
      CROW_DATA_DIR: this.dataDir,
      CROW_DB_PATH: join(this.dataDir, "crow.db"),
      CROW_PEER_TOKENS_PATH: this.tokensPath,
      CROW_INSTANCES_JSON_PATH: join(this.dir, "instances.json"),
      CROW_BACKUP_DIR: join(this.dir, "backups"),
      CROW_APP_ENV_PATH: join(this.dir, "gateway.env"),
      CROW_SERVE_PEER_UIDS: UID,
      CROW_DISABLE_HEALTH_MONITOR: "1",
      // Every child, new and old tree: Hyperswarm never carries instance
      // sync here, so tailnet is the only sync transport.
      CROW_INSTANCE_SYNC_HYPERSWARM: "0",
      // remote-actor.js treats headers dated in the first minute after boot as
      // pre_boot (servers/shared/test-timing.js: honoured only in the suite's
      // scratch env); these gateways sign and verify seconds after they start.
      CROW_TEST_REMOTE_ACTOR_BOOT_GRACE_MS: "1",
    });
    if (this.sync) {
      Object.assign(env, { CROW_DISABLE_NOSTR: "1", CROW_TAILNET_IP: NO_TAILNET_IP }, SYNC_TIMING);
      if (!String(env.NODE_OPTIONS || "").includes(LOCAL_DHT)) env.NODE_OPTIONS = `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ""}--import=${LOCAL_DHT}`;
      // An old tree cannot read SYNC_TIMING: the preload swaps its drain timer.
      if (this.repo !== REPO && !String(env.NODE_OPTIONS).includes(OLD_TREE_TIMING)) env.NODE_OPTIONS = `${env.NODE_OPTIONS} --import=${OLD_TREE_TIMING}`;
    }
    if (this.port) {
      env.PORT = String(this.port);
      env.CROW_GATEWAY_URL = `http://127.0.0.1:${this.port}`;
      // The advertised (tailnet-shaped) address; never dialed by the tests.
      env.CROW_PEER_GATEWAY_URL = `http://${this.ip}:${this.port}`;
    }
    return env;
  }

  async init({ seedFrom = null } = {}) {
    this.port = await freePort();
    execFileSync(process.execPath, ["scripts/init-db.js"], { env: this.env, cwd: REPO, stdio: "pipe" });
    this.sql(`INSERT INTO crow_instances (id, name, crow_id, gateway_url, tailscale_ip, status) VALUES (?, ?, ?, ?, ?, 'active')`,
      [this.id, this.name, this.id, `http://${this.ip}:${this.port}`, this.ip]);
    if (seedFrom) copyFileSync(join(seedFrom.dataDir, "identity.json"), join(this.dataDir, "identity.json"));
    else {
      execFileSync(process.execPath, ["--input-type=module", "-e",
        `const { loadOrCreateIdentity } = await import(${JSON.stringify(new URL("../../servers/sharing/identity.js", import.meta.url).href)}); loadOrCreateIdentity(); process.exit(0);`],
        { env: this.env, cwd: REPO, stdio: "pipe" });
    }
    return this;
  }

  /** Synchronous SQL on this instance's DB (WAL; the gateway may be running). */
  sql(sqlText, args = []) {
    const db = new Database(join(this.dataDir, "crow.db"));
    db.pragma("busy_timeout = 5000");
    try {
      const st = db.prepare(sqlText);
      return st.reader ? st.all(...args) : st.run(...args);
    } finally { db.close(); }
  }

  row(id) { return this.sql("SELECT * FROM crow_instances WHERE id = ?", [id])[0] || null; }
  tokens() { return existsSync(this.tokensPath) ? JSON.parse(readFileSync(this.tokensPath, "utf8")) : {}; }
  audit(sourceId) {
    return this.sql("SELECT * FROM cross_host_calls WHERE source_instance_id = ? AND direction = 'inbound' ORDER BY id DESC LIMIT 1", [sourceId])[0] || null;
  }

  async boot({ otc = null, extraEnv = {}, repo = null } = {}) {
    await this.stop();
    if (repo) this.repo = repo;
    const env = { ...this.env, ...(this.sync ? { CROW_DISABLE_INSTANCE_SYNC: "0" } : {}), ...extraEnv };
    if (otc) Object.assign(env, { CROW_ENROLL_ENABLED: "1", CROW_ENROLL_OTC: otc });
    this.log = "";
    this.child = spawn(process.execPath, ["servers/gateway/index.js"], { env, cwd: this.repo, stdio: ["ignore", "pipe", "pipe"] });
    this.child.stdout.on("data", (c) => { this.log += c; });
    this.child.stderr.on("data", (c) => { this.log += c; });
    const exited = new Promise((r) => this.child.once("exit", (code) => r(code)));
    this._exited = exited;
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`${this.name}: gateway not healthy\n${this.log.slice(-3000)}`);
      const done = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 250))]);
      if (done) {
        this.child = null;
        // Port taken by someone else before this instance ever served: no
        // peer, row or relay knows its port yet, so move it and boot again.
        if (/EADDRINUSE/.test(this.log) && !this.served && (this._portRetries = (this._portRetries || 0) + 1) <= 3) {
          await this.movePort();
          return this.boot({ otc, extraEnv, repo });
        }
        throw new Error(`${this.name}: gateway exited during boot\n${this.log.slice(-3000)}`);
      }
      // Ready only once THIS child has bound the port (its listen callback
      // logs this line): until then a 200 from /health may be whatever else
      // holds the port, which is not this instance and not in pairing mode.
      if (!this.log.includes(`Crow Gateway listening on http://0.0.0.0:${this.port}`)) continue;
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/health`);
        if (r.status === 200) break;
      } catch { /* not up yet */ }
    }
    this.served = true;
    if (!this.relays) this.relays = new Map();
    return this;
  }

  /** A fresh port for an instance that has never served (its self row follows). */
  async movePort() {
    this.port = await freePort();
    this.sql("UPDATE crow_instances SET gateway_url = ? WHERE id = ?", [`http://${this.ip}:${this.port}`, this.id]);
  }

  /** The URL `caller` uses to reach this gateway (a relay presenting caller's tailnet IP). */
  async urlFor(caller) {
    if (!this.relays) this.relays = new Map();
    const ip = caller?.ip || "100.64.20.250";
    if (!this.relays.has(ip)) this.relays.set(ip, await startRelay(this.port, ip));
    return `http://127.0.0.1:${this.relays.get(ip).address().port}`;
  }

  async stop() {
    if (!this.child) return;
    const c = this.child;
    this.child = null;
    try { c.kill("SIGTERM"); } catch { /* gone */ }
    const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* gone */ } }, 5_000);
    await this._exited;
    clearTimeout(t);
  }

  async cleanup() {
    await this.stop();
    for (const r of this.relays?.values() || []) { r.closeAllConnections?.(); await new Promise((res) => r.close(res)); }
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** Run a script in a child with THIS instance's env (the stdio door, the signer). */
  runAs(code, { timeout = 60_000 } = {}) {
    return new Promise((resolve) => {
      execFile(process.execPath, ["--input-type=module", "-e", code], { cwd: REPO, env: this.env, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout), err: String(stderr) });
      });
    });
  }

  /** The real pair CLI, run as this instance. */
  pairCli(args) {
    return new Promise((resolve) => {
      execFile(process.execPath, ["scripts/cli/instance-pair.js", ...args], { cwd: this.repo, env: this.env, timeout: 60_000 }, (err, stdout, stderr) => {
        resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}${stderr}` });
      });
    });
  }

  /** A dashboard session on this instance (the operator, for Settings POSTs). */
  operatorSession() {
    const token = randomBytes(32).toString("hex");
    this.sql("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', 'dashboard', ?)",
      [sha(token), new Date(Date.now() + 3_600_000).toISOString()]);
    return token;
  }
}

/** An Instance whose pair CLI enrolls under its own name: the CLI reads $HOSTNAME, never the real host's. */
export class Named extends Instance { get env() { return { ...super.env, HOSTNAME: this.name }; } }

/**
 * Install the real Workspace add-on on `inst` (mcp-addons.json → its own tree's
 * bundles/workspace/server/index.js) against the hermetic fake Nextcloud `fake`
 * (tests/helpers/workspace-fake-nextcloud.js), and expose `exposed` to peers.
 * Takes effect at the next boot.
 */
export function installWorkspace(inst, fake, { exposed = ["workspace"] } = {}) {
  const dir = join(inst.dir, "bundles", "workspace");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".env"),
    "WORKSPACE_BOOTSTRAP_DONE=1\nWORKSPACE_PUBLIC_HOST=crow.test\nWORKSPACE_BOT_APP_PASSWORD=pw-secret-123\nWORKSPACE_ONLYOFFICE_JWT_SECRET=jwt\n", { mode: 0o600 });
  writeFileSync(join(inst.dir, "mcp-addons.json"), JSON.stringify({
    workspace: { command: "node", args: ["server/index.js"], cwd: join(inst.repo, "bundles", "workspace"),
      env: { WORKSPACE_NC_INTERNAL_URL: fake.ncUrl, WORKSPACE_OO_INTERNAL_URL: fake.ooUrl } },
  }), { mode: 0o600 });
  inst.sql("INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES ('remote_exposed_tools', ?)", [JSON.stringify(exposed)]);
}

const mod = (p) => JSON.stringify(new URL(`../../${p}`, import.meta.url).href);

/**
 * A signed call from `from` to `to` through the real forwardSignedRequest, in
 * a signer child with `from`'s env. The target row's gateway_url is mapped to
 * `to`'s relay for this call only (the stored URL is tailnet-shaped and not
 * dialable in a test); everything else, including the trust gate and the
 * credential lookup, is the production code reading `from`'s real state.
 */
export async function signedCall(from, to, method, path, body) {
  const url = await to.urlFor(from);
  const code = `
    const { forwardSignedRequest } = await import(${mod("servers/shared/peer-forward.js")});
    const { createDbClient } = await import(${mod("servers/db.js")});
    const real = createDbClient();
    const db = {
      async execute(st) {
        const r = await real.execute(st);
        if (/FROM crow_instances WHERE id = \\?/.test(st?.sql || "") && st.args?.[0] === ${JSON.stringify(to.id)}) {
          return { ...r, rows: r.rows.map((x) => ({ ...x, gateway_url: ${JSON.stringify(url)} })) };
        }
        return r;
      },
      batch: (...a) => real.batch(...a), close: () => real.close(),
    };
    const r = await forwardSignedRequest({ db, sourceInstanceId: ${JSON.stringify(from.id)}, targetInstanceId: ${JSON.stringify(to.id)},
      method: ${JSON.stringify(method)}, path: ${JSON.stringify(path)}, ${body === undefined ? "" : `body: ${JSON.stringify(body)},`} auditAction: "pt1.test", timeoutMs: 15000 });
    console.log("RESULT " + JSON.stringify({ ok: r.ok, status: r.status, error: r.error ?? null, body: r.body ?? null }));
    process.exit(0);`;
  const r = await from.runAs(code);
  const line = r.out.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`signer failed: ${r.err.slice(-2000)}`);
  return JSON.parse(line.slice(7));
}

/** A raw request with explicit signature headers built from a given key (old-key checks). */
export async function rawSigned(from, to, { method = "GET", path, body, authToken, signingKey }) {
  const { signRequest } = await import("../../servers/shared/cross-host-auth.js");
  const raw = body === undefined ? "" : JSON.stringify(body);
  const headers = signRequest({ method, path, body: raw, authToken, signingKey, sourceInstanceId: from.id });
  if (raw) headers["Content-Type"] = "application/json";
  const r = await fetch(`${await to.urlFor(from)}${path}`, { method, headers, body: raw || undefined });
  let json = null; try { json = await r.json(); } catch { /* not json */ }
  return { status: r.status, body: json };
}

/** MCP initialize + tools/list on `to`'s /memory/mcp with `from`'s outbound bearer. */
export async function bearerMcp(from, to, bearer = from.tokens()[to.id]?.auth_token) {
  const url = `${await to.urlFor(from)}/memory/mcp`;
  const h = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${bearer || "none"}` };
  const init = await fetch(url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pt1", version: "1" } } }) });
  await init.text();
  if (init.status !== 200) return { status: init.status, listStatus: null };
  const sid = init.headers.get("mcp-session-id");
  const list = await fetch(url, { method: "POST", headers: { ...h, "mcp-session-id": sid }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) });
  const text = await list.text();
  return { status: init.status, listStatus: list.status, hasTools: /"tools"/.test(text), sessionId: sid };
}

/** Settings → Paired Instances → Revoke on `on`, as its operator. */
export async function settingsRevoke(on, targetId) {
  const session = on.operatorSession();
  const csrf = randomBytes(16).toString("hex");
  const r = await fetch(`${await on.urlFor({ ip: "100.64.20.251" })}/dashboard/settings`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: `crow_session=${session}; crow_csrf=${csrf}`, "x-crow-csrf": csrf },
    body: new URLSearchParams({ action: "revoke_instance", instance_id: targetId, _csrf: csrf }).toString(),
  });
  return { status: r.status, location: r.headers.get("location") };
}

/** The stdio door: revokePeer from a child with `on`'s env and no sync manager. */
export async function stdioRevoke(on, targetId, extraEnv = null) {
  const code = `
    const { revokePeer } = await import(${mod("servers/sharing/revoke-peer.js")});
    const { createDbClient } = await import(${mod("servers/db.js")});
    const db = createDbClient();
    const r = await revokePeer(db, ${JSON.stringify(targetId)}, { instanceSyncManager: null });
    console.log("RESULT " + JSON.stringify({ ok: r.ok, creds_deleted: r.creds_deleted ?? null, reason: r.reason ?? null }));
    process.exit(0);`;
  const r = extraEnv
    ? await new Promise((resolve) => execFile(process.execPath, ["--input-type=module", "-e", code], { cwd: REPO, env: { ...on.env, ...extraEnv }, timeout: 60_000 },
      (err, stdout, stderr) => resolve({ out: String(stdout), err: String(stderr) })))
    : await on.runAs(code);
  const line = r.out.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`stdio revoke failed: ${r.err.slice(-2000)}`);
  return JSON.parse(line.slice(7));
}

/**
 * Pair `enroller` into `peer` with the real CLI: `peer` reboots in pairing
 * mode with a fresh one-time code, the CLI runs as `enroller`, `peer` reboots
 * normally. Extra CLI args (e.g. --peer-id) pass through.
 */
export async function pairInto(enroller, peer, extraArgs = []) {
  const otc = generateEnrollOtc();
  await peer.boot({ otc });
  const r = await enroller.pairCli(["--peer-url", await peer.urlFor(enroller), "--otc", otc, ...extraArgs]);
  await peer.boot();
  return r;
}

/** Boot two instances (one shared seed: sibling instances of one user; separate seeds: a co-hosted or household instance) and pair B into A. */
export async function bootPair({ sameIdentity, repoA = REPO, repoB = REPO, ids = {} }) {
  // The caller only learns of A and B on success, so a failure part-way
  // (B's init, a boot, the pairing) must stop and remove whatever started.
  let A = null, B = null;
  try {
    A = await new Instance("a", "100.64.20.11", { repo: repoA, id: ids.a }).init();
    B = await new Instance("b", "100.64.20.12", { repo: repoB, id: ids.b }).init({ seedFrom: sameIdentity ? A : null });
    await B.boot();
    const r = await pairInto(B, A);
    if (r.code !== 0) throw new Error(`pairing failed: ${r.out}`);
  } catch (err) {
    for (const x of [B, A]) { try { await x?.cleanup(); } catch { /* best effort; the original error is the one that matters */ } }
    throw err;
  }
  return { A, B, async cleanup() { await A.cleanup(); await B.cleanup(); } };
}

export async function until(fn, ms = 15_000, step = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

/**
 * Point each side's row for the other at the other's real loopback port, for
 * tailnet instance sync (both must be stopped; the next boot runs sync).
 * gateway_url is rewritten; tailscale_ip (also an address column, never a
 * trust column) is cleared on the peer rows and the self rows, because the
 * dial ladder appends ws://<tailscale_ip>:<port> plus 3001/3002 behind the
 * gateway_url, and the fixture's 100.64.20.x addresses route off the box.
 * With NO_TAILNET_IP the gateways advertise no tailnet IP, so nothing is
 * learned back: the loopback URL is the only dial candidate.
 */
export async function useLoopbackSync(a, b) {
  await a.stop();
  await b.stop();
  for (const [x, y] of [[a, b], [b, a]]) {
    const r = x.sql("UPDATE crow_instances SET gateway_url = ?, tailscale_ip = NULL WHERE id = ?", [`http://127.0.0.1:${y.port}`, y.id]);
    if (r.changes !== 1) throw new Error(`useLoopbackSync: ${x.name} has no row for ${y.name}`);
    x.sql("UPDATE crow_instances SET tailscale_ip = NULL WHERE id = ?", [x.id]);
    x.sync = true;
  }
}

/** This instance's LOCAL `sync_pair_bound:<peer>` pin (true when set). */
export function pairPinned(inst, peerId) {
  const r = inst.sql("SELECT value FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?", [`sync_pair_bound:${peerId}`, inst.id])[0];
  return Number(r?.value) >= 1;
}

/**
 * Store a memory whose content is `text` through the real stdio door: the
 * instance tree's own memory MCP server (servers/memory/index.js) in a child
 * with the instance's env and no InstanceSyncManager, so the write is queued
 * in sync_outbox and reaches peers only through the gateway's outbox drain.
 */
export async function writeMarker(inst, text) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  // memories.id is INTEGER AUTOINCREMENT and a sync insert is INSERT OR
  // IGNORE: two siblings writing at once would both take id N, and each side
  // would keep its own row (a recorded insert conflict), not the peer's. Each
  // marker takes a fresh random id, so a marker only ever
  // fails to arrive because the link did not carry it.
  // (A random gap ABOVE everything this side has seen: after a sync both
  // sides hold the same ids, so a fixed range would collide again.)
  const top = Number(inst.sql("SELECT MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'memories'), 0), COALESCE((SELECT MAX(id) FROM memories), 0)) AS t")[0].t);
  const seq = top + 1 + randomBytes(4).readUInt32BE(0);
  const bumped = inst.sql("UPDATE sqlite_sequence SET seq = ? WHERE name = 'memories'", [seq]);
  if (bumped.changes === 0) inst.sql("INSERT INTO sqlite_sequence (name, seq) VALUES ('memories', ?)", [seq]);
  const { queued } = await callMemoryTool(inst, "crow_store_memory", { content: text, category: "general", importance: 5, source: "pt2a-gate" },
    { queuedWhen: () => outboxAudit(inst, text).length > 0 });
  if (!await until(() => hasMarker(inst, text), 15_000)) throw new Error(`${inst.name}: marker not stored`);
  return { queued };
}

/**
 * Call one tool of `inst`'s memory MCP server through the real stdio door
 * (the instance tree's servers/memory/index.js in a child with the instance's
 * env plus `extraEnv`, and no InstanceSyncManager): its sync writes are
 * queued in sync_outbox and reach peers only through the gateway's drain.
 * `queuedWhen` (optional) is polled, with the child still alive, until it
 * holds: tools queue their outbox row fire-and-forget after answering, and
 * the drain can empty sync_outbox before a poll sees it, so the predicate
 * should read the test-only audit copy (watchOutbox / outboxAuditRows).
 * Returns { result, queued }; a tool error throws.
 */
export async function callMemoryTool(inst, name, args, { extraEnv = {}, queuedWhen = null } = {}) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const env = { ...inst.env, ...extraEnv };
  // The stdio door's eligibility reads this switch; the suite sets it to 1.
  delete env.CROW_DISABLE_INSTANCE_SYNC;
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(inst.repo, "servers/memory/index.js")], env, cwd: inst.repo, stderr: "pipe" });
  const client = new Client({ name: "pt2a-marker", version: "1.0.0" });
  const cap = (p, what) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error(`${inst.name}: ${what} timed out`)), 60_000))]);
  let queued = false;
  let result;
  watchOutbox(inst);
  try {
    await cap(client.connect(transport), `${name} MCP connect`);
    result = await cap(client.callTool({ name, arguments: args }), name);
    if (result.isError) throw new Error(`${inst.name}: ${name} failed: ${JSON.stringify(result.content).slice(0, 300)}`);
    if (queuedWhen) queued = await until(queuedWhen, 15_000, 100);
  } finally {
    try { await client.close(); } catch { /* gone */ }
  }
  return { result, queued };
}

/** Does `inst`'s DB hold a memory with exactly this content? */
export function hasMarker(inst, text) {
  return inst.sql("SELECT 1 FROM memories WHERE content = ? LIMIT 1", [text]).length > 0;
}

/**
 * Test-only, in this instance's scratch DB: an AFTER INSERT trigger on
 * sync_outbox copies each queued row's identity into crow_test_outbox_audit,
 * which nothing in the product reads or drains. sync_outbox is created with
 * the product's own DDL (ensureSyncTables, the same IF NOT EXISTS the drain and
 * the stdio door run) so the trigger exists before the first marker. Idempotent;
 * init-db and the gateway never drop objects they do not know.
 */
export function watchOutbox(inst) {
  const db = new Database(join(inst.dataDir, "crow.db"));
  db.pragma("busy_timeout = 5000");
  try {
    ensureSyncTables({ executeMultiple: (ddl) => db.exec(ddl) });
    db.exec(`
      CREATE TABLE IF NOT EXISTS crow_test_outbox_audit (outbox_id INTEGER, table_name TEXT, op TEXT, row_json TEXT);
      CREATE TRIGGER IF NOT EXISTS crow_test_outbox_audit_ins AFTER INSERT ON sync_outbox BEGIN
        INSERT INTO crow_test_outbox_audit (outbox_id, table_name, op, row_json) VALUES (NEW.id, NEW.table_name, NEW.op, NEW.row_json);
      END;`);
  } finally { db.close(); }
}

/** Every sync_outbox row ever queued on `inst` for `table` (watchOutbox's audit copy), row_json parsed. */
export function outboxAuditRows(inst, table) {
  return inst.sql("SELECT op, row_json FROM crow_test_outbox_audit WHERE table_name = ? ORDER BY outbox_id", [table])
    .map((r) => ({ op: r.op, row: JSON.parse(r.row_json) }));
}

/** Every sync_outbox row ever queued on `inst` carrying this marker (watchOutbox's audit copy). */
export function outboxAudit(inst, text) {
  return inst.sql("SELECT outbox_id FROM crow_test_outbox_audit WHERE table_name = 'memories' AND row_json LIKE ?", [`%${text}%`]);
}

/** Why a marker's outbox row was not recorded (a failure message's tail). */
export function outboxDiag(inst, text) {
  const q = (sqlText, args = []) => { try { return JSON.stringify(inst.sql(sqlText, args)); } catch (e) { return `error: ${e.message}`; } };
  return [
    `memory row: ${q("SELECT id, lamport_ts FROM memories WHERE content = ?", [text])}`,
    `audit trigger: ${q("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'sync_outbox'")}`,
    `audit rows (all): ${q("SELECT COUNT(*) AS n FROM crow_test_outbox_audit")}`,
    `outbox now: ${q("SELECT id, table_name, substr(row_json, 1, 120) AS r FROM sync_outbox ORDER BY id DESC LIMIT 3")}`,
    `sync_deployment_enabled: ${q("SELECT 'override' AS s, instance_id, value FROM dashboard_settings_overrides WHERE key = 'sync_deployment_enabled' UNION ALL SELECT 'global', NULL, value FROM dashboard_settings WHERE key = 'sync_deployment_enabled'")}`,
  ].join("\n");
}

/** `inst`'s queued sync_outbox rows carrying this marker. A failing query throws (it must never read as "drained"). */
export function outboxRows(inst, text) {
  return inst.sql("SELECT id FROM sync_outbox WHERE table_name = 'memories' AND row_json LIKE ?", [`%${text}%`]);
}

/**
 * Has `inst`'s gateway drained the marker (appended it to every paired peer's
 * out-feed)? Only meaningful once the marker's outbox row was recorded (writeMarker's
 * `queued`): an empty result alone cannot tell "drained" from "never matched".
 */
export function markerDrained(inst, text) {
  return hasMarker(inst, text) && outboxRows(inst, text).length === 0;
}

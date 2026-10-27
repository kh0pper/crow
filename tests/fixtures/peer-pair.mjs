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

export const REPO = new URL("../..", import.meta.url).pathname;
const UID = String(typeof process.getuid === "function" ? process.getuid() : 0);
export const sha = (s) => createHash("sha256").update(s).digest("hex");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
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

export class Instance {
  constructor(name, ip) {
    this.name = name;
    this.ip = ip;
    this.dir = mkdtempSync(join(tmpdir(), `pt-gw-${name}-`));
    this.dataDir = join(this.dir, "data");
    mkdirSync(this.dataDir, { recursive: true });
    this.id = `inst-${name}-${randomBytes(4).toString("hex")}`;
    writeFileSync(join(this.dataDir, "instance-id"), `${this.id}\n`);
    this.tokensPath = join(this.dir, "peer-tokens.json");
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
    });
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

  async boot({ otc = null, extraEnv = {} } = {}) {
    await this.stop();
    const env = { ...this.env, ...extraEnv };
    if (otc) Object.assign(env, { CROW_ENROLL_ENABLED: "1", CROW_ENROLL_OTC: otc });
    this.log = "";
    this.child = spawn(process.execPath, ["servers/gateway/index.js"], { env, cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    this.child.stdout.on("data", (c) => { this.log += c; });
    this.child.stderr.on("data", (c) => { this.log += c; });
    const exited = new Promise((r) => this.child.once("exit", (code) => r(code)));
    this._exited = exited;
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`${this.name}: gateway not healthy\n${this.log.slice(-3000)}`);
      const done = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 250))]);
      if (done) throw new Error(`${this.name}: gateway exited during boot\n${this.log.slice(-3000)}`);
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/health`);
        if (r.status === 200) break;
      } catch { /* not up yet */ }
    }
    if (!this.relays) this.relays = new Map();
    return this;
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
      execFile(process.execPath, ["scripts/cli/instance-pair.js", ...args], { cwd: REPO, env: this.env, timeout: 60_000 }, (err, stdout, stderr) => {
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

/** Boot two instances (same seed: the raven shape; separate seeds: r4/household) and pair B into A. */
export async function bootPair({ sameIdentity }) {
  const A = await new Instance("a", "100.64.20.11").init();
  const B = await new Instance("b", "100.64.20.12").init({ seedFrom: sameIdentity ? A : null });
  await B.boot();
  const r = await pairInto(B, A);
  if (r.code !== 0) throw new Error(`pairing failed: ${r.out}`);
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

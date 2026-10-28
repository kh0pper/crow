/**
 * Multi-process bot-relay harness: real Crow sharing processes (each a child
 * of `timeout`, a scratch CROW_HOME, the real managers and the real Nostr
 * receive wiring) on a LOCAL Nostr relay (tests/fixtures/nostr-relay.mjs, on
 * 127.0.0.1). Several processes may share one home (one DB), the way a
 * gateway and a stdio sharing server do. No AI provider is configured in a
 * scratch home (its own empty .env), so a task run takes the production
 * "no provider" path and no model is ever contacted; the child refuses to
 * start otherwise. The child refuses any WebSocket but the local relay.
 *
 * Exports:
 * - makeBotRelayHome({ name, instanceName, peers, seedHex }) → { home, dataDir, dbPath, instanceId }
 *     init-db in a scratch home; crow_instances rows for itself and each peer
 *     ({ id, name, trusted, status }); identity.json from seedHex.
 * - startBotRelayNode({ label, home, dataDir, relayUrl, wire }) → node:
 *     { route(args), send(target, task, timeoutMs), wire(), connect(), sql(sql, args),
 *       logLines(re), log, stop() }
 * - stopAllBotRelayNodes()  kills every child and removes every home
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { createDbClient } from "../../servers/db.js";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CHILD = new URL("./bot-relay-node-child.mjs", import.meta.url).pathname;
const CHILD_WALL_S = 240; // hard cap per child process

const SCRUB = ["CROW_HOME", "CROW_DATA_DIR", "CROW_DB_PATH", "CROW_TASKS_DB_PATH", "CROW_BACKUP_DIR", "CROW_INSTANCES_JSON_PATH",
  "CROW_REFCOUNT_PATH", "CROW_PEER_TOKENS_PATH", "NTFY_TOPIC", "CROW_GATEWAY_URL", "PORT", "CROW_GATEWAY_PORT",
  "CROW_PEER_GATEWAY_URL", "CROW_DASHBOARD_PUBLIC", "CROW_APP_ENV_PATH", "AI_PROVIDER", "AI_API_KEY", "AI_MODEL", "AI_BASE_URL",
  "BOT_RELAY_NODE_CONFIG"];

const live = new Set();
const homes = new Set();

function env(home, config, dataDir = join(home, "data")) {
  const e = { ...process.env };
  for (const k of SCRUB) delete e[k];
  Object.assign(e, {
    HOME: home,
    CROW_HOME: home,
    CROW_DATA_DIR: dataDir,
    CROW_DB_PATH: join(dataDir, "crow.db"),
    CROW_INSTANCES_JSON_PATH: join(home, "instances.json"),
    CROW_BACKUP_DIR: join(home, "backups"),
    CROW_APP_ENV_PATH: join(home, ".env"),
    CROW_DISABLE_INSTANCE_SYNC: "1",
    CROW_DISABLE_NOSTR: config?.relayUrl ? "0" : "1",
    CROW_DISABLE_HEALTH_MONITOR: "1",
  });
  if (config) e.BOT_RELAY_NODE_CONFIG = JSON.stringify(config);
  return e;
}

export async function makeBotRelayHome({ name, instanceName, instanceId = `inst-${name}`, peers = [], seedHex }) {
  const home = mkdtempSync(join(tmpdir(), `crow-br-${name}-`));
  homes.add(home);
  const dataDir = join(home, "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "instance-id"), `${instanceId}\n`);
  writeFileSync(join(home, ".env"), "# scratch home: no AI provider\n");
  if (seedHex) writeFileSync(join(dataDir, "identity.json"), JSON.stringify({ version: 1, seed: seedHex }), { mode: 0o600 });
  execFileSync(process.execPath, [join(REPO, "scripts/init-db.js")], { env: env(home, null), cwd: REPO, stdio: "pipe", timeout: 120_000 });
  const dbPath = join(dataDir, "crow.db");
  const db = createDbClient(dbPath);
  try {
    const rows = [{ id: instanceId, name: instanceName, trusted: 1, status: "active" }, ...peers];
    for (const r of rows) {
      await db.execute({
        sql: "INSERT INTO crow_instances (id, name, crow_id, status, trusted, last_seen_at) VALUES (?, ?, 'crow:shared', ?, ?, '2000-01-01 00:00:00')",
        args: [r.id, r.name, r.status ?? "active", r.trusted ?? 1],
      });
    }
  } finally {
    try { db.close(); } catch {}
  }
  return { home, dataDir, dbPath, instanceId };
}

export async function startBotRelayNode({ label, home, dataDir = join(home, "data"), relayUrl = null, wire = false }) {
  const config = { relayUrl, wire };
  const child = spawn("timeout", ["-k", "5", String(CHILD_WALL_S), process.execPath, CHILD], {
    cwd: REPO,
    env: env(home, config, dataDir),
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  const pending = new Map();
  let seq = 0;
  let exited = false;
  let readyResolve, readyReject;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
  readline.createInterface({ input: child.stdio[3] }).on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if ("ready" in msg) { msg.ready ? readyResolve() : readyReject(new Error(`${label}: ${msg.error}`)); return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.ok ? p.resolve(msg.result) : p.reject(new Error(`${label}: ${msg.error}`));
  });
  const exitedP = new Promise((res) => child.once("exit", (code, sig) => {
    exited = true;
    const err = new Error(`${label}: child exited (${code ?? sig})\n${log.slice(-3000)}`);
    readyReject(err);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    res();
  }));
  const call = (op, args = {}, ms = 30_000) => {
    if (exited) return Promise.reject(new Error(`${label}: child is not running`));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(id); reject(new Error(`${label}: ${op} timed out`)); }, ms);
      pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      child.stdio[3].write(JSON.stringify({ id, op, args }) + "\n");
    });
  };
  const node = {
    label, home,
    get log() { return log; },
    logLines: (re) => log.split("\n").filter((l) => re.test(l)),
    route: (args) => call("route", args),
    send: (target, task, timeoutMs) => call("send", { target, task, timeoutMs }),
    wire: () => call("wire"),
    connect: () => call("connect"),
    sql: (sql, args = []) => call("sql", { sql, args }),
    identity: () => call("identity"),
    async stop() {
      if (!exited) {
        call("stop", {}, 5_000).catch(() => {});
        const t = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, 6_000);
        await exitedP;
        clearTimeout(t);
      }
      live.delete(node);
    },
  };
  live.add(node);
  let readyTimer;
  try {
    await Promise.race([ready, new Promise((_, rej) => { readyTimer = setTimeout(() => rej(new Error(`${label}: not ready in 45 s\n${log.slice(-3000)}`)), 45_000); })]);
  } catch (err) {
    await node.stop();
    throw err;
  } finally {
    clearTimeout(readyTimer);
  }
  return node;
}

export async function stopAllBotRelayNodes() {
  await Promise.all([...live].map((n) => n.stop().catch(() => {})));
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  homes.clear();
}

export async function until(fn, ms = 20_000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

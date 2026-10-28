/**
 * Multi-process contact harness: real Crow sharing nodes (each its own child
 * process with a scratch CROW_HOME), paired through the real invite flow,
 * talking over a LOCAL hyperdht testnet and a LOCAL Nostr relay, both on
 * 127.0.0.1. Nothing here dials a public DHT node or a public relay; the
 * child (contact-node-child.mjs) refuses both.
 *
 * Exports:
 * - REPO, PT3_BASE_SHA
 * - startTestnet() → { bootstrap, destroy() }          createTestnet(3) on 127.0.0.1
 * - startContactNode({ name, repo, bootstrap, relayUrl, seedFrom, home, extraEnv, bindingAdvertDelayMs })
 *     → node: { name, repo, home, dataDir, crowId, ed25519Pubkey, secp256k1Pubkey,
 *               tool(name, args), sql(sql, args), exec(sql, args), identity(), seedHex(),
 *               isConnected(crowId), log, logLines(re), guardViolations(),
 *               stop({ keepHome }), restart({ repo }) }
 * - stopAllContactNodes()                               kills every child, removes every home
 * - inviteAndAccept(inviter, acceptor)
 * - waitConnected(a, b), shareMemory(from, toCrowId, text), hasMemory(node, text),
 *   shareStatus(node, itemId), isPinned(node, crowId), until(fn, ms)
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import readline from "node:readline";

export const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
/** The main sha PT-3 is cut from (a literal, never a merge-base). */
export const PT3_BASE_SHA = "697d5d07ba915994b3d591d55dbce820c2274b14";
const CHILD = new URL("./contact-node-child.mjs", import.meta.url).pathname;
const GUARD = "[contact-node-guard]";

const SCRUB = ["CROW_HOME", "CROW_DATA_DIR", "CROW_DB_PATH", "CROW_TASKS_DB_PATH", "CROW_BACKUP_DIR", "CROW_INSTANCES_JSON_PATH",
  "CROW_REFCOUNT_PATH", "CROW_PEER_TOKENS_PATH", "NTFY_TOPIC", "CROW_GATEWAY_URL", "PORT", "CROW_GATEWAY_PORT",
  "CROW_PEER_GATEWAY_URL", "CROW_DASHBOARD_PUBLIC", "CROW_APP_ENV_PATH", "CROW_SKIP_CONFIRM_GATES", "CONTACT_NODE_CONFIG"];

export async function until(fn, ms = 30_000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

/** A three-node hyperdht testnet on 127.0.0.1 (the first node on an ephemeral port). */
export async function startTestnet() {
  const require = createRequire(join(REPO, "package.json"));
  const createTestnet = require("hyperdht/testnet.js");
  const testnet = await createTestnet(3, { host: "127.0.0.1", port: [0, 0] });
  for (const n of testnet.bootstrap) if (n.host !== "127.0.0.1") throw new Error("testnet bootstrap must be on 127.0.0.1");
  return { bootstrap: testnet.bootstrap.map(({ host, port }) => ({ host, port })), destroy: () => testnet.destroy() };
}

const live = new Set(); // every running node, for stopAllContactNodes
const homes = new Set(); // every scratch home not yet removed

function nodeEnv(home, extraEnv, config) {
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  const dataDir = join(home, "data");
  Object.assign(env, {
    HOME: home,
    CROW_HOME: home,
    CROW_DATA_DIR: dataDir,
    CROW_DB_PATH: join(dataDir, "crow.db"),
    CROW_INSTANCES_JSON_PATH: join(home, "instances.json"),
    CROW_BACKUP_DIR: join(home, "backups"),
    CROW_APP_ENV_PATH: join(home, "gateway.env"),
    CROW_DISABLE_INSTANCE_SYNC: "0",
    CROW_DISABLE_NOSTR: "0",
    CROW_INSTANCE_SYNC_HYPERSWARM: "0",
    CROW_DISABLE_HEALTH_MONITOR: "1",
    ...extraEnv,
  });
  if (config) env.CONTACT_NODE_CONFIG = JSON.stringify(config);
  return env;
}

function makeHome(name, repo, seedFrom) {
  const home = mkdtempSync(join(tmpdir(), `crow-cn-${name}-`));
  homes.add(home);
  const dataDir = join(home, "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "instance-id"), `inst-${name}-${randomBytes(4).toString("hex")}\n`);
  execFileSync(process.execPath, [join(repo, "scripts/init-db.js")], { env: nodeEnv(home, {}), cwd: repo, stdio: "pipe", timeout: 120_000 });
  if (seedFrom) copyFileSync(join(seedFrom.dataDir, "identity.json"), join(dataDir, "identity.json"));
  return home;
}

/**
 * Start one node. `home` reuses an existing node's scratch home (same seed and
 * DB) without re-initialising it; otherwise a fresh home is created and
 * init-db from `repo` runs in it. `seedFrom` copies another node's identity.json.
 */
export async function startContactNode({ name, repo = REPO, bootstrap, relayUrl, seedFrom = null, home = null, extraEnv = {}, bindingAdvertDelayMs } = {}) {
  if (!name) throw new Error("startContactNode: name is required");
  if (!Array.isArray(bootstrap) || bootstrap.length === 0) throw new Error("startContactNode: the local testnet bootstrap is required");
  if (!/^ws:\/\/127\.0\.0\.1:\d+\/?$/.test(String(relayUrl))) throw new Error("startContactNode: relayUrl must be the local relay");
  if (!home) home = makeHome(name, repo, seedFrom);
  const dataDir = join(home, "data");
  const config = { repo, bootstrap, relayUrl, ...(Number.isFinite(bindingAdvertDelayMs) ? { bindingAdvertDelayMs } : {}) };
  const child = spawn(process.execPath, [CHILD], {
    cwd: repo,
    env: nodeEnv(home, extraEnv, config),
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
  const ctl = child.stdio[3];
  readline.createInterface({ input: ctl }).on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if ("ready" in msg) { msg.ready ? readyResolve(msg.identity) : readyReject(new Error(`${name}: ${msg.error}`)); return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.ok ? p.resolve(msg.result) : p.reject(new Error(`${name}: ${msg.error}`));
  });
  const exitedP = new Promise((res) => child.once("exit", (code, sig) => {
    exited = true;
    const err = new Error(`${name}: child exited (${code ?? sig})\n${log.slice(-4000)}`);
    readyReject(err);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    res();
  }));

  const call = (op, args = {}, timeoutMs = 60_000) => {
    if (exited) return Promise.reject(new Error(`${name}: child is not running`));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${name}: ${op} timed out`)); }, timeoutMs);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      ctl.write(JSON.stringify({ id, op, args }) + "\n");
    });
  };

  const node = {
    name, repo, home, dataDir, child,
    get log() { return log; },
    logLines: (re) => log.split("\n").filter((l) => re.test(l)),
    guardViolations: () => log.split("\n").filter((l) => l.includes(GUARD)),
    tool: (toolName, args = {}) => call("tool", { name: toolName, args }),
    sql: (sql, args = []) => call("sql", { sql, args }),
    exec: (sql, args = []) => call("exec", { sql, args }),
    identity: () => call("identity"),
    seedHex: () => call("seedHex"),
    isConnected: (crowId) => call("isConnected", { crowId }),
    async stop({ keepHome = false } = {}) {
      if (!exited) {
        call("stop", {}, 5_000).catch(() => {});
        const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 8_000);
        await exitedP;
        clearTimeout(t);
      }
      live.delete(node);
      if (!keepHome) { rmSync(home, { recursive: true, force: true }); homes.delete(home); }
    },
    /** Stop, then start again on `repo` with the same home (seed and DB). */
    async restart({ repo: nextRepo = repo, ...rest } = {}) {
      await node.stop({ keepHome: true });
      return startContactNode({ name, repo: nextRepo, bootstrap, relayUrl, home, extraEnv, bindingAdvertDelayMs, ...rest });
    },
  };
  live.add(node);
  try {
    const ident = await Promise.race([
      ready,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${name}: not ready in 45 s\n${log.slice(-4000)}`)), 45_000)),
    ]);
    Object.assign(node, ident);
  } catch (err) {
    await node.stop({ keepHome: true });
    throw err;
  }
  return node;
}

/** Kill every child still running and remove every scratch home. */
export async function stopAllContactNodes() {
  await Promise.all([...live].map((n) => n.stop().catch(() => {})));
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  homes.clear();
}

const FULL_ROW = "SELECT id, crow_id, ed25519_pubkey FROM contacts WHERE crow_id = ? AND request_status IS NULL AND is_blocked = 0 AND ed25519_pubkey != ''";

/** The real invite flow: generate on `inviter`, accept on `acceptor`, full rows on both sides. */
export async function inviteAndAccept(inviter, acceptor, { timeoutMs = 60_000 } = {}) {
  const gen = await inviter.tool("crow_generate_invite", {});
  const code = gen.text.match(/`([^`]+)`/)?.[1];
  if (gen.isError || !code) throw new Error(`${inviter.name}: no invite code in: ${gen.text}`);
  const acc = await acceptor.tool("crow_accept_invite", { invite_code: code });
  if (acc.isError) throw new Error(`${acceptor.name}: accept failed: ${acc.text}`);
  const ok = await until(async () =>
    (await acceptor.sql(FULL_ROW, [inviter.crowId])).length === 1
    && (await inviter.sql(FULL_ROW, [acceptor.crowId])).length === 1, timeoutMs);
  if (!ok) throw new Error(`pairing ${inviter.name} → ${acceptor.name}: full contact rows did not appear on both sides`);
}

/** Both ends hold an admitted Hyperswarm connection to each other. */
export async function waitConnected(a, b, ms = 60_000) {
  return until(async () => (await a.isConnected(b.crowId)) && (await b.isConnected(a.crowId)), ms, 200);
}

/** Seed a memory on `from` and share it to `toCrowId` through crow_share (preview, then confirm). */
export async function shareMemory(from, toCrowId, text) {
  const { lastInsertRowid: itemId } = await from.exec("INSERT INTO memories (content, category) VALUES (?, 'general')", [text]);
  const preview = await from.tool("crow_share", { contact: toCrowId, share_type: "memory", item_id: itemId, confirm_token: "" });
  const token = preview.text.match(/confirm_token: "([^"]+)"/)?.[1];
  if (preview.isError || !token) throw new Error(`${from.name}: no share confirm token in: ${preview.text}`);
  const done = await from.tool("crow_share", { contact: toCrowId, share_type: "memory", item_id: itemId, confirm_token: token });
  if (done.isError) throw new Error(`${from.name}: crow_share failed: ${done.text}`);
  return { itemId, text: done.text };
}

export async function hasMemory(node, text) {
  return (await node.sql("SELECT id FROM memories WHERE content = ?", [text])).length > 0;
}

/** The sender-side delivery_status of the newest share of memory `itemId`. */
export async function shareStatus(node, itemId) {
  const rows = await node.sql(
    "SELECT delivery_status FROM shared_items WHERE share_type = 'memory' AND item_id = ? AND direction = 'sent' ORDER BY id DESC LIMIT 1",
    [itemId]);
  return rows[0]?.delivery_status ?? null;
}

/** Whether `node` holds the PT-3 "this contact binds" pin for `crowId` (LOCAL override). */
export async function isPinned(node, crowId) {
  const rows = await node.sql("SELECT value FROM dashboard_settings_overrides WHERE key = ?", [`contact_hs_cb:${crowId}`]);
  return rows.some((r) => Number(r.value) >= 1);
}


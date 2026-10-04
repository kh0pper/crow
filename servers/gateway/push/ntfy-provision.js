/**
 * ntfy autowire — Crow creates its own login on the local ntfy server, a private
 * per-instance topic, and stores the tokens in ntfy-push.json (ntfy-config.js).
 * Design note: the private engineering notes
 *
 * Every step is idempotent and runs through `docker exec <container> ntfy …` with
 * an injectable runner (execFile semantics, no shell). The key is derived from the
 * instance id, so a second CROW_DATA_DIR on the same host (a co-hosted instance
 * sharing one ntfy) provisions its own users, topic and tokens.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  ntfyDataDir, ntfyConfigPath, readStoredNtfyConfig, writeStoredNtfyConfig, removeStoredNtfyConfig,
} from "./ntfy-config.js";

function isUnderTmp(dir) {
  const roots = [tmpdir(), "/tmp", "/var/tmp"].map((r) => { try { return realpathSync(r); } catch { return r; } });
  let d = dir;
  try { d = realpathSync(dir); } catch { /* not created yet */ }
  return roots.some((r) => d === r || d.startsWith(r.endsWith(sep) ? r : r + sep));
}

export const NTFY_CONTAINER = "crow-ntfy";
export const AUTOWIRE_KIND = "ntfy-push";
const TOKEN_LABEL = "crow-autowire";
const NOT_STARTED_RE = /auth-file does not exist/i;
const NO_AUTH_RE = /auth-file|not configured|user database/i;

export function defaultRunner(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 20_000, maxBuffer: 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** `crow-<first 10 hex of the instance id>` — ntfy topic/user charset safe. */
export function instanceKey(instanceId) {
  const hex = String(instanceId || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (hex.length < 6) throw new Error("instance id unavailable — cannot derive a push topic");
  return `crow-${hex.slice(0, 10)}`;
}

/** Read-only: the instance id file in this instance's data dir (never creates one). */
export function readInstanceId(env = process.env) {
  try {
    return readFileSync(join(ntfyDataDir(env), "instance-id"), "utf8").trim();
  } catch {
    return null;
  }
}

export function namesFor(key) {
  return { topic: key, publisher: `${key}-pub`, subscriber: `${key}-app` };
}

/**
 * Older ntfy (≤ 2.13, incl. the stock bundle's v2.11.0) prints user/token/access results
 * to STDERR; newer builds print to stdout. Parse both.
 */
function out(r) {
  return `${r?.stdout || ""}\n${r?.stderr || ""}`;
}

function errText(err) {
  return `${err?.stderr || ""} ${err?.stdout || ""} ${err?.message || ""}`.trim();
}

/** Is the ntfy container running on this host? Never throws. */
export async function ntfyContainerRunning({ runner = defaultRunner, container = NTFY_CONTAINER } = {}) {
  try {
    const { stdout } = await runner("docker", ["inspect", "-f", "{{.State.Running}}", container], { timeout: 10_000 });
    return String(stdout).trim() === "true";
  } catch {
    return false;
  }
}

/** Parse `ntfy user list` → Set of usernames. */
export function parseUsers(stdout) {
  const set = new Set();
  for (const m of String(stdout).matchAll(/^user (\S+) \(role:/gm)) if (m[1] !== "*") set.add(m[1]);
  return set;
}

/** Parse `ntfy token list <user>` → Set of tokens. */
export function parseTokens(stdout) {
  return new Set([...String(stdout).matchAll(/\b(tk_[A-Za-z0-9]+)\b/g)].map((m) => m[1]));
}

/** Tokens Crow minted (label crow-autowire) in a `token list` output. */
export function parseAutowireTokens(text) {
  return [...String(text).matchAll(/^- (tk_[A-Za-z0-9]+) \(crow-autowire\)/gm)].map((m) => m[1]);
}

/** NTFY_PORT from this instance's installed ntfy bundle .env, or undefined. */
export function bundleNtfyPort(env = process.env) {
  try {
    const home = env.CROW_HOME || join(homedir(), ".crow");
    const m = /^\s*NTFY_PORT\s*=\s*["']?(\d{1,5})["']?\s*$/m.exec(readFileSync(join(home, "bundles", "ntfy", ".env"), "utf8"));
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Provision (or repair) this instance's ntfy login + private topic.
 *
 * @param {object} [o]
 * @param {Function} [o.runner]  (cmd, args, opts) => Promise<{stdout, stderr}>
 * @param {object} [o.env]       defaults to process.env (CROW_DATA_DIR picks the instance)
 * @param {string} [o.instanceId] defaults to the instance-id file
 * @param {string} [o.container]
 * @param {number} [o.port]       host port the gateway publishes to (default: stored, NTFY_PORT, 2586)
 * @param {number} [o.startWaitMs] how long to wait for a just-started server's auth db
 * @param {Function} [o.sleep]
 * @param {Function} [o.log]
 * @returns {Promise<{ok:true, topic:string, created:{users:string[], tokens:string[]}} | {ok:false, reason:string}>}
 */
// Single-flight per config file: a double-clicked Set up, or install + boot ensure
// overlapping, must not mint two token pairs (the loser's would linger on the server).
const _inflight = new Map();
const PROVISION_DEADLINE_MS = 120_000;
export function provisionNtfy(opts = {}) {
  const k = ntfyConfigPath(opts.env || process.env);
  if (_inflight.has(k)) return _inflight.get(k);
  // Overall cap: a wedged docker daemon must not hold a Settings POST open for minutes.
  const deadlineMs = opts.deadlineMs ?? PROVISION_DEADLINE_MS;
  let timer;
  const inner = _provisionNtfy(opts);
  const capped = Promise.race([
    inner,
    new Promise((r) => { timer = setTimeout(() => r({ ok: false, reason: `The notification server did not answer within ${Math.round(deadlineMs / 1000)} s — is Docker running?` }), deadlineMs); timer.unref?.(); }),
  ]);
  // The in-flight slot is held until the INNER run settles, so a retry after the cap
  // fires cannot race a late run (its orphan sweep would revoke the token being stored).
  inner.finally(() => { if (_inflight.get(k) === p) _inflight.delete(k); }).catch(() => {});
  const p = capped.finally(() => clearTimeout(timer));
  _inflight.set(k, p);
  return p;
}

async function _provisionNtfy({
  runner = defaultRunner, env = process.env, instanceId, container = NTFY_CONTAINER,
  port, startWaitMs = 30_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {},
} = {}) {
  let key;
  try {
    let id = instanceId ?? readInstanceId(env);
    if (!id && env === process.env) {
      // A fresh instance may not have minted its id yet — the canonical minting path.
      const { getOrCreateLocalInstanceId } = await import("../instance-registry.js");
      id = getOrCreateLocalInstanceId();
    }
    key = instanceKey(id);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  const { topic, publisher, subscriber } = namesFor(key);
  const ntfy = (args, opts = {}) => runner("docker", ["exec", ...(opts.execFlags || []), container, "ntfy", ...args], { timeout: 20_000, ...(opts.env ? { env: opts.env } : {}) });

  if (!(await ntfyContainerRunning({ runner, container }))) {
    return { ok: false, reason: `The notification server (${container}) is not running on this computer. Install or start the Push Notifications extension first.` };
  }

  // 1. Users. A just-started server has not created its auth db yet — wait for it.
  let users;
  const deadline = Date.now() + startWaitMs;
  for (;;) {
    try {
      users = parseUsers(out(await ntfy(["user", "list"])));
      break;
    } catch (err) {
      const text = errText(err);
      if (NOT_STARTED_RE.test(text)) {
        if (Date.now() < deadline) { await sleep(2000); continue; }
        return { ok: false, reason: "The notification server is still starting. Wait a moment, then press Set up again." };
      }
      if (NO_AUTH_RE.test(text)) {
        return { ok: false, reason: "This notification server has no user database (auth-file), so Crow cannot create a private login on it. Reinstall the Push Notifications extension (version 1.1.0 or later) or add auth-file to its server.yml." };
      }
      return { ok: false, reason: `Could not reach the notification server: ${text.slice(0, 200)}` };
    }
  }

  const created = { users: [], tokens: [] };
  try {
    for (const user of [publisher, subscriber]) {
      if (users.has(user)) continue;
      // Throwaway password: Crow only ever uses tokens. Passed as the docker CLI's own
      // environment with a bare `-e NTFY_PASSWORD`, so it never appears in argv.
      const password = randomBytes(24).toString("base64url");
      try {
        await ntfy(["user", "add", user], { execFlags: ["-e", "NTFY_PASSWORD"], env: { ...process.env, NTFY_PASSWORD: password } });
        created.users.push(user);
      } catch (err) {
        if (!/already exists/i.test(errText(err))) throw err;
      }
    }

    // 2. Topic ACL — re-applying is a no-op. `everyone … deny` keeps the topic private
    //    even on a server whose default access is read-write.
    await ntfy(["access", publisher, topic, "write-only"]);
    await ntfy(["access", subscriber, topic, "read-only"]);
    await ntfy(["access", "everyone", topic, "deny"]);

    // 3. Tokens — reuse a stored one only while the server still knows it.
    const prev = readStoredNtfyConfig(env);
    const samePrev = prev && prev.topic === topic ? prev : null;
    const ensureToken = async (user, stored) => {
      const listing = out(await ntfy(["token", "list", user]));
      const keep = stored && parseTokens(listing).has(stored) ? stored : null;
      // Revoke Crow's own orphans (a reinstall that kept the volume, a lost config file,
      // an earlier interrupted run) so no stale credential stays valid.
      for (const old of parseAutowireTokens(listing)) {
        if (old === keep) continue;
        try { await ntfy(["token", "remove", user, old]); } catch { /* already gone */ }
      }
      if (keep) return keep;
      const tok = [...parseTokens(out(await ntfy(["token", "add", `--label=${TOKEN_LABEL}`, user])))][0];
      if (!tok) throw new Error(`ntfy did not return a token for ${user}`);
      created.tokens.push(user);
      return tok;
    };
    const publisherToken = await ensureToken(publisher, samePrev?.publisherToken);
    const subscriberToken = await ensureToken(subscriber, samePrev?.subscriberToken);

    const storedPort = Number.parseInt(port ?? env.NTFY_PORT ?? bundleNtfyPort(env) ?? prev?.port ?? 2586, 10) || 2586;
    writeStoredNtfyConfig({
      version: 1,
      topic,
      publisherUser: publisher,
      subscriberUser: subscriber,
      publisherToken,
      subscriberToken,
      host: "localhost",
      port: storedPort,
      container,
      externalUrl: typeof prev?.externalUrl === "string" ? prev.externalUrl : "",
      provisionedAt: samePrev?.provisionedAt || new Date().toISOString(),
      checkedAt: new Date().toISOString(),
    }, env);
  } catch (err) {
    return { ok: false, reason: `Setting up the notification login failed: ${errText(err).slice(0, 200)}` };
  }
  log(`Phone notifications: topic ${topic} ready${created.users.length ? ` (created ${created.users.join(", ")})` : ""}`);
  return { ok: true, topic, created };
}

/**
 * Revoke this instance's stored tokens on the server (best-effort) and forget the config.
 * Used before the bundle's containers go away. Never throws.
 */
export async function deprovisionNtfy({ runner = defaultRunner, env = process.env, container = NTFY_CONTAINER } = {}) {
  const c = readStoredNtfyConfig(env);
  if (!c) return { removed: false };
  for (const [user, tok] of [[c.publisherUser, c.publisherToken], [c.subscriberUser, c.subscriberToken]]) {
    if (!user || !tok) continue;
    try { await runner("docker", ["exec", container, "ntfy", "token", "remove", user, tok], { timeout: 20_000 }); } catch { /* server already gone */ }
  }
  removeStoredNtfyConfig(env);
  return { removed: true };
}

/** Bundle ids in this instance's installed.json (array or object shape). Never throws. */
export function installedBundleIds(env = process.env) {
  try {
    const home = env.CROW_HOME || join(homedir(), ".crow");
    const d = JSON.parse(readFileSync(join(home, "installed.json"), "utf8"));
    const arr = Array.isArray(d) ? d : Object.entries(d || {}).map(([k, v]) => ({ id: k, ...v }));
    return arr.map((e) => (typeof e === "string" ? e : e?.id)).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Boot-time ensure: only when nothing is configured yet (no NTFY_TOPIC, no stored
 * config) and this instance installed the bundle or shares a running crow-ntfy.
 * Never throws.
 */
export async function autowireAtBoot({
  env = process.env, runner = defaultRunner, installedIds = () => [], log = console.log, throwaway = isUnderTmp,
} = {}) {
  try {
    if (env.CROW_DISABLE_NTFY_AUTOWIRE === "1") return { skipped: "disabled" };
    if (env.NTFY_TOPIC) return { skipped: "env" };
    if (readStoredNtfyConfig(env)) return { skipped: "configured" };
    // Throwaway gateways (a raw single-file test run outside run-suite) live under the
    // OS temp dir — never let one add users to a host's real notification server.
    if (throwaway(ntfyDataDir(env))) return { skipped: "temp-data-dir" };
    const installed = (() => { try { return installedIds(); } catch { return []; } })();
    if (!installed.includes("ntfy") && !(await ntfyContainerRunning({ runner }))) return { skipped: "no-server" };
    const r = await provisionNtfy({ env, runner, log: (m) => log(`[ntfy-autowire] ${m}`) });
    if (!r.ok) log(`[ntfy-autowire] not set up: ${r.reason}`);
    return r;
  } catch (err) {
    log(`[ntfy-autowire] failed: ${err?.message || err}`);
    return { ok: false, reason: String(err?.message || err) };
  }
}

/**
 * Live pi driver: drives a real bot turn by turn through handleInbound() inside a scratch Crow
 * home. This file holds the configuration guards (all pure) and constants; the process tree
 * helpers and runConversation are added by later tasks.
 *
 * v1 threat model (no network namespace in live mode). Isolation is (a) the endpoint allowlist
 * below, (b) a tool surface checked before any pi spawn (checkToolSurface here, and again in the
 * child with the effective skill tools), and (c) pi never seeing a gateway URL (childEnv pins
 * every gateway variable to a closed port). Nothing here is a sandbox.
 *
 * This module must never import the bridge, better-sqlite3 or servers/db*; a test asserts it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { protectedHit, protectedRoots, realish, realUserCrowDir, within } from "./protected-paths.mjs";
import { scratchEnv } from "./eval-scratch.mjs";
import { INSTANCE_PATH_ENV_KEYS, PINNED_PATH_ENV_KEYS } from "../../servers/shared/crow-home.js";
import { SECRET_NAME_RE } from "../../servers/shared/bot-env.js";
// Imported for the later tasks (prodMaxPi default); allowed here, its imports are built-ins only.
export { LIFECYCLE_DEFAULTS } from "../pi-bots/pi_lifecycle.mjs";

/** A bad configuration. Thrown before anything spawns and never retried (D7). */
export class DriverRefusal extends Error {
  constructor(message) { super(message); this.name = "DriverRefusal"; }
}
const refuse = (msg) => { throw new DriverRefusal(`live pi driver refused: ${msg}`); };
const strictlyInside = (p, root) => p !== root && within(p, root);

export const EXTRA_ENV_ALLOW = Object.freeze(["CROW_SESSION_SUMMARIES", "CROW_SESSION_BRIEFING"]);
export const GATEWAY_PORTS = Object.freeze([3001, 3002]);
export const PARENT_ENV_ALLOW = Object.freeze(["PATH", "LANG", "TZ", "TMPDIR", "TERM", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"]);

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const DEFAULT_PORT = { "http:": 80, "https:": 443 };

/**
 * Refuse any provider that is not a direct model endpoint: loopback or an exact `host:port` in
 * allowHosts, never a gateway port, never a /llm/ or /proxy/ path.
 */
export function checkEndpoints(models, { allowHosts = [], gatewayPort = process.env.CROW_GATEWAY_PORT, gatewayPorts = [] } = {}) {
  const providers = models && models.providers;
  if (!providers || typeof providers !== "object" || !Object.keys(providers).length) refuse("models.providers is empty");
  if (!Array.isArray(allowHosts)) refuse("allowHosts must be an array");
  if (!Array.isArray(gatewayPorts)) refuse("gatewayPorts must be an array");
  const blocked = new Set([...GATEWAY_PORTS, ...gatewayPorts.map(Number)]);
  if (gatewayPort !== undefined && gatewayPort !== "" && Number.isFinite(Number(gatewayPort))) blocked.add(Number(gatewayPort));
  for (const [name, p] of Object.entries(providers)) {
    if (!p || typeof p.baseUrl !== "string" || !p.baseUrl) refuse(`provider ${name} has no baseUrl`);
    let u;
    try { u = new URL(p.baseUrl); } catch { refuse(`provider ${name} baseUrl is not a URL`); }
    if (!(u.protocol in DEFAULT_PORT)) refuse(`provider ${name} baseUrl must be http or https`);
    if (u.username || u.password) refuse(`provider ${name} baseUrl must not carry userinfo`);
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const port = u.port ? Number(u.port) : DEFAULT_PORT[u.protocol];
    const hostPort = `${host.includes(":") ? `[${host}]` : host}:${port}`;
    const allowed = LOOPBACK.has(host) || allowHosts.some((h) => String(h).toLowerCase() === hostPort || String(h).toLowerCase() === `${host}:${port}`);
    if (!allowed) refuse(`provider ${name} host ${hostPort} is not loopback and not in allowHosts`);
    if (blocked.has(port)) refuse(`provider ${name} port ${port} is a gateway port`);
    if (/\/(llm|proxy)\//.test(`${u.pathname.toLowerCase()}/`)) refuse(`provider ${name} path ${u.pathname} goes through a gateway`);
  }
}

/** The bot def must be self-consistent against the models it will run on. */
export function checkBotDef(botDef, models, scratchHome) {
  if (!botDef || typeof botDef.id !== "string" || !botDef.id) refuse("botDef.id must be a non-empty string");
  const bm = botDef.models;
  if (!bm || typeof bm.default !== "string" || !bm.default) refuse("botDef.models.default is required (else the resolver falls back to crow-local)");
  const providers = (models && models.providers) || {};
  for (const [role, ref] of Object.entries(bm)) {
    if (typeof ref !== "string" || !ref.includes("/")) refuse(`botDef.models.${role} must be provider/id`);
    const i = ref.indexOf("/");
    const prov = ref.slice(0, i);
    const id = ref.slice(i + 1);
    const p = providers[prov];
    if (!p) refuse(`botDef.models.${role} names unknown provider ${prov}`);
    if (!Array.isArray(p.models) || !p.models.some((m) => m && m.id === id)) refuse(`botDef.models.${role} names unknown model ${ref}`);
  }
  if (botDef.session_dir !== undefined && botDef.session_dir !== null) {
    if (typeof botDef.session_dir !== "string" || !strictlyInside(realish(botDef.session_dir), realish(scratchHome))) {
      refuse("botDef.session_dir must be strictly inside the scratch home");
    }
  }
}

/** Returns the realpath of the scratch home, or throws. `env` supplies the protected roots. */
export function checkScratchHome(scratchHome, env = process.env) {
  if (typeof scratchHome !== "string" || !scratchHome) refuse("scratchHome must be a path");
  const real = realish(scratchHome);
  const tmp = realish(tmpdir());
  if (real === tmp || !within(real, tmp)) refuse(`scratch home ${scratchHome} is not strictly below the temp dir`);
  if (protectedHit(real, protectedRoots(env))) refuse(`scratch home ${scratchHome} overlaps a protected instance directory`);
  const userCrow = realish(realUserCrowDir());
  if (within(real, userCrow) || within(userCrow, real)) refuse("scratch home overlaps the real user's crow dir");
  const db = join(real, "data", "crow.db");
  if (!existsSync(db) || !statSync(db).isFile()) refuse(`scratch home has no data/crow.db`);
  return real;
}

/** Only the allowlisted flags, as strings. Instance-path keys are refused by name regardless. */
export function checkExtraEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (INSTANCE_PATH_ENV_KEYS.includes(k) || PINNED_PATH_ENV_KEYS.includes(k)) refuse(`extra env ${k} is an instance path key`);
    if (!EXTRA_ENV_ALLOW.includes(k)) refuse(`extra env ${k} is not allowlisted`);
    if (typeof v !== "string") refuse(`extra env ${k} must be a string`);
    out[k] = v;
  }
  return out;
}

/** Static tool-surface checks (R7). The child adds the effective withSkillTools check. */
export function checkToolSurface(botDef, { allowServers, allowSkills = [], scratchHome } = {}) {
  const d = botDef || {};
  const pol = d.permission_policy || {};
  if (!Array.isArray(allowServers)) refuse("allowServers must be an array");
  if (!Array.isArray(allowSkills)) refuse("allowSkills must be an array");
  if (pol.bash !== "deny") refuse('permission_policy.bash must be "deny"');
  if (pol.multi_agent) refuse("permission_policy.multi_agent must be falsy");
  const tools = d.tools || {};
  const builtin = tools.pi_builtin === undefined ? [] : tools.pi_builtin;
  if (tools.crow_mcp !== undefined && !Array.isArray(tools.crow_mcp)) refuse("tools.crow_mcp must be an array");
  if (!Array.isArray(builtin) || builtin.some((t) => !["read", "write", "edit"].includes(t))) refuse('tools.pi_builtin must be a subset of ["read","write","edit"]');
  const home = realish(scratchHome);
  for (const w of pol.write_paths || []) {
    if (typeof w !== "string" || !strictlyInside(realish(w), home)) refuse(`write_paths entry ${w} is not strictly inside the scratch home`);
  }
  const servers = new Set(allowServers);
  for (const e of tools.crow_mcp || []) {
    const server = String(e).split("/")[0];
    if (server === "board") refuse("crow_mcp server board is refused in v1");
    if (!servers.has(server)) refuse(`crow_mcp server ${server} is not in allowServers`);
  }
  const nonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : v && typeof v === "object" ? Object.keys(v).length > 0 : Boolean(v));
  if (nonEmpty(tools.remote_mcp)) refuse("tools.remote_mcp must be absent or empty in v1");
  if (nonEmpty(d.spawn_env)) refuse("spawn_env must be absent or empty");
  // The bridge reads these nested (tools / permission_policy); the top-level forms are refused too (fail closed).
  for (const [where, o] of [["", d], ["tools.", tools]]) {
    if (nonEmpty(o.pi_extensions)) refuse(`${where}pi_extensions must be absent or empty`);
  }
  for (const [where, o] of [["", d], ["permission_policy.", pol]]) {
    if (o.skill_learning !== undefined && o.skill_learning !== null && o.skill_learning !== "off") refuse(`${where}skill_learning must be absent or "off"`);
    if (o.self_authoring) refuse(`${where}self_authoring must be falsy`);
  }
  if (d.project_id !== undefined && d.project_id !== null) refuse("project_id must be absent (v1 bots are project-less)");
  for (const s of d.skills || []) if (!allowSkills.includes(s)) refuse(`skill ${s} is not in allowSkills`);
}

/**
 * The child's environment: an allowlist of the parent env, scratchEnv on top, the pinned
 * driver variables, then the validated extraEnv. No key from the parent may look like a secret;
 * that check runs before extraEnv goes on (CROW_SESSION_* would match SECRET_NAME_RE).
 */
export function childEnv({ home, botId, runId, piCli, extraEnv = {}, turnTimeoutMs, parent = process.env }) {
  if (typeof piCli !== "string" || !isAbsolute(piCli)) refuse("piCli must be an absolute path");
  if (typeof turnTimeoutMs !== "number" || !Number.isFinite(turnTimeoutMs) || turnTimeoutMs <= 0) refuse("turnTimeoutMs must be a positive finite number");
  if (typeof runId !== "string" || !runId) refuse("runId must be a non-empty string");
  const extra = checkExtraEnv(extraEnv);
  const testCtx = parent.NODE_TEST_CONTEXT !== undefined;
  const picked = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    const ok = PARENT_ENV_ALLOW.includes(k) || k.startsWith("LC_") || k === "NODE_TEST_CONTEXT" || (testCtx && k.startsWith("PIBOT_TEST_"));
    if (ok && !SECRET_NAME_RE.test(k)) picked[k] = v;
  }
  const agentDir = join(home, "pi-agent");
  return {
    ...scratchEnv(home, botId, picked),
    PI_CODING_AGENT_DIR: agentDir,
    PI_MODELS_JSON: join(agentDir, "models.json"),
    PIBOT_WARM_GATEWAY_URL: "http://127.0.0.1:1",
    PIBOT_WARM_TIMEOUT_MS: "1000",
    CROW_GATEWAY_PORT: "1",
    CROW_GATEWAY_URL: "http://127.0.0.1:1",
    PIBOT_MAX_PI: "99",
    PIBOT_TURN_TIMEOUT_MS: String(turnTimeoutMs),
    PIBOT_PROMPT_ACK_TIMEOUT_MS: "60000",
    CROW_EVAL_RUN_ID: runId,
    // buildBotBaseEnv's operator extra-allow list: pi (and its MCP children) carry the run
    // marker too, so survivorsByMarker sees an escaped pi. Pinned: a parent value never lands.
    CROW_BOT_ENV_ALLOW: "CROW_EVAL_RUN_ID",
    PIBOT_PI_CLI: piCli,
    ...extra,
  };
}

// ---------------------------------------------------------------------------------------------
// Process tree kill (D4, R3). Linux only: everything is read from /proc. The walk goes strictly
// DOWN from a given pid by ppid chain; nothing is ever matched by name.
// ---------------------------------------------------------------------------------------------

export const KILL_GRACE_MS = 5000;

const defaultReadProc = (p) => readFileSync(p, "latin1");
const defaultListPids = () => readdirSync("/proc").filter((n) => /^\d+$/.test(n)).map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Parse /proc/<pid>/stat: split after the LAST ")" because comm may hold spaces and parens. */
function parseStat(text) {
  const i = text.lastIndexOf(")");
  if (i < 0) return null;
  const f = text.slice(i + 1).trim().split(/\s+/);
  return { state: f[0], ppid: Number(f[1]), pgrp: Number(f[2]) };
}
function statOf(pid, readProc) {
  try { return parseStat(readProc(`/proc/${pid}/stat`)); } catch { return null; }
}
/** Alive = readable stat and not a zombie. */
const isAlive = (pid, readProc = defaultReadProc) => { const s = statOf(pid, readProc); return !!s && s.state !== "Z"; };

/** Every descendant of pid (ppid chain, breadth-first), excluding pid itself. */
export function descendants(pid, { readProc = defaultReadProc, listPids = defaultListPids } = {}) {
  const kids = new Map();
  for (const n of listPids()) {
    const s = statOf(n, readProc);
    if (!s || !Number.isFinite(s.ppid)) continue;
    if (!kids.has(s.ppid)) kids.set(s.ppid, []);
    kids.get(s.ppid).push(n);
  }
  const out = [];
  const seen = new Set([pid]);
  for (let q = [pid]; q.length;) {
    const next = [];
    for (const p of q) for (const c of kids.get(p) || []) if (!seen.has(c)) { seen.add(c); out.push(c); next.push(c); }
    q = next;
  }
  return out;
}

const signal = (target, sig) => { try { process.kill(target, sig); } catch (e) { if (e.code !== "ESRCH") throw e; } };

/** SIGTERM/SIGKILL a snapshot. A pgid is signalled as a group only when every live member is in the set. */
function signalSet(pids, sig) {
  const set = new Set(pids);
  const groups = new Map();
  for (const n of defaultListPids()) { // one scan: pgid -> members (all live processes)
    const s = statOf(n, defaultReadProc);
    if (!s || s.state === "Z") continue;
    if (!groups.has(s.pgrp)) groups.set(s.pgrp, []);
    groups.get(s.pgrp).push(n);
  }
  const ownPgid = statOf(process.pid, defaultReadProc)?.pgrp;
  const done = new Set();
  for (const pid of set) {
    const s = statOf(pid, defaultReadProc);
    if (!s) continue;
    const g = s.pgrp;
    if (g > 1 && g !== ownPgid && !done.has(g) && (groups.get(g) || []).every((m) => set.has(m))) {
      done.add(g);
      signal(-g, sig);
    }
  }
  for (const pid of set) signal(pid, sig); // idempotent after a group signal; covers shared groups
}

async function waitGone(pids, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const left = pids.filter((p) => isAlive(p));
    if (!left.length || Date.now() >= end) return left;
    await sleep(Math.min(25, Math.max(1, end - Date.now())));
  }
}

/**
 * Kill pid's whole tree (pi runs detached, in its own group, so a group kill of the child alone
 * would orphan it). includeRoot:false kills only the descendants. TERM, wait graceMs, re-walk to
 * catch late children, KILL the remainder, then re-walk once more if the root is still alive.
 * Resolves with whatever is still alive.
 */
export async function killTree(pid, { graceMs = KILL_GRACE_MS, includeRoot = true } = {}) {
  // Our own pid is allowed only for its descendants (the child's parent-death cleanup).
  if (!Number.isInteger(pid) || pid <= 1 || (pid === process.pid && includeRoot)) throw new DriverRefusal(`killTree refuses pid ${pid}`);
  const known = new Set();
  const collect = () => {
    const found = [...(includeRoot && isAlive(pid) ? [pid] : []), ...descendants(pid)].filter((p) => p !== process.pid);
    for (const p of found) known.add(p);
    return found;
  };
  for (let round = 0; round < 2; round++) {
    const snap = collect();
    if (!snap.length) break;
    signalSet(snap, "SIGTERM");
    await waitGone(snap, graceMs);
    // Late children (spawned after the snapshot, e.g. on SIGTERM) are only reachable through the root.
    const live = [...new Set([...snap, ...collect()])].filter((p) => isAlive(p));
    if (live.length) { signalSet(live, "SIGKILL"); await waitGone(live, 1000); }
    if (!isAlive(pid)) break; // root gone: nothing left to re-walk from
    if (!includeRoot && !descendants(pid).length) break;
  }
  return { survivors: [...known].filter((p) => isAlive(p)) };
}

let clkTck;
const clkTckHz = () => {
  if (clkTck) return clkTck;
  try { clkTck = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()); } catch { /* fall back */ }
  if (!Number.isFinite(clkTck) || clkTck <= 0) clkTck = 100;
  return clkTck;
};

/** Seconds since boot (/proc/uptime field 1). Capture at run start and pass as sinceBootSec. */
export function bootSecNow(readProc = defaultReadProc) {
  return Number(readProc("/proc/uptime").trim().split(/\s+/)[0]);
}

/**
 * Every pid whose environ carries CROW_EVAL_RUN_ID=<runId> exactly, whatever its age. Fails
 * closed for a process of our uid whose environ is unreadable (EACCES), but only if it started
 * at or after sinceBootSec (the run's start, seconds since boot): long-lived unreadable
 * processes (sshd, systemd --user, gpg-agent) cannot belong to the run. Other users' processes
 * and vanished pids are skipped.
 */
export function survivorsByMarker(runId, { sinceBootSec, readProc = defaultReadProc, listPids = defaultListPids, uid = process.getuid() } = {}) {
  if (!Number.isFinite(sinceBootSec)) throw new DriverRefusal("survivorsByMarker requires a finite sinceBootSec");
  const want = `CROW_EVAL_RUN_ID=${runId}`;
  const out = [];
  for (const n of listPids()) {
    if (n === process.pid) continue;
    try {
      if (readProc(`/proc/${n}/environ`).split("\0").includes(want)) out.push(n);
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "ESRCH") continue;
      try {
        const m = /^Uid:\s+(\d+)/m.exec(readProc(`/proc/${n}/status`));
        if (!m || Number(m[1]) !== uid) continue;
        const t = readProc(`/proc/${n}/stat`);
        const startTicks = Number(t.slice(t.lastIndexOf(")") + 1).trim().split(/\s+/)[19]); // stat field 22
        if (!Number.isFinite(startTicks) || startTicks / clkTckHz() >= sinceBootSec) out.push(n);
      } catch { /* vanished while checking */ }
    }
  }
  return out;
}

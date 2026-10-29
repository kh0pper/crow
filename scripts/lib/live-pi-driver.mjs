/**
 * Live pi driver: drives a real bot turn by turn through handleInbound() inside a scratch Crow
 * home. This file is the parent: the configuration guards (all pure), the process tree helpers
 * and runConversation, which spawns one live-pi-driver-child.mjs per thread and owns every limit.
 *
 * v1 threat model (no network namespace in live mode). Isolation is (a) the endpoint allowlist
 * below, (b) a tool surface checked before any pi spawn (checkToolSurface here, and again in the
 * child with the effective skill tools), and (c) pi never seeing a gateway URL (childEnv pins
 * every gateway variable to a closed port). Nothing here is a sandbox.
 *
 * This module must never import the bridge, better-sqlite3 or servers/db*; a test asserts it.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { protectedHit, protectedRoots, realish, realUserCrowDir, within } from "./protected-paths.mjs";
import { scratchEnv } from "./eval-scratch.mjs";
import { INSTANCE_PATH_ENV_KEYS, PINNED_PATH_ENV_KEYS } from "../../servers/shared/crow-home.js";
import { SECRET_NAME_RE } from "../../servers/shared/bot-env.js";
// The prodMaxPi default; allowed here, its imports are built-ins only.
import { LIFECYCLE_DEFAULTS } from "../pi-bots/pi_lifecycle.mjs";
export { LIFECYCLE_DEFAULTS };

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
 * Refuses a grant with no `server/tool` crow_mcp entry. pi's --tools matches exact names, so a
 * bare server (crow_mcp: ["crow-projects"] → mcp__crow-projects, the router-mode name) or an
 * empty list gives pi no MCP tool at all and the row measures nothing (seen with real pi).
 * The parent checks the static def (skipped when the def lists skills, which may add the grant),
 * the child always checks the effective one; `allowToolless` (stub tests) is the only bypass.
 */
export function checkToolGrant(botDef, { allowToolless = false } = {}) {
  if (allowToolless === true) return;
  const entries = botDef && botDef.tools && botDef.tools.crow_mcp;
  const granted = Array.isArray(entries) && entries.some((e) => typeof e === "string" && /^[^/]+\/[^/]+$/.test(e));
  if (!granted) refuse('no crow_mcp entry of the form "server/tool": a bare server or an empty grant gives pi no MCP tool (allowToolless bypasses this)');
}

/**
 * The first failed model call in a pi session JSONL, as a contamination string, or null: an
 * assistant message whose stopReason is "error" or "aborted". pi records a failed call this way
 * and the bridge still reports the turn as asked (seen with real pi: a 400 became "(no reply)").
 */
export function modelErrorOf(jsonl) {
  for (const line of String(jsonl ?? "").split("\n")) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const m = o && o.type === "message" ? o.message : null;
    if (m && m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted")) {
      return `model call failed: ${String(m.errorMessage ?? `stopReason ${m.stopReason}`).slice(0, 200)}`;
    }
  }
  return null;
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

/** ppid is 1, or our uid's `systemd` (the user subreaper). Unreadable = not orphaned. */
function orphaned(ppid, readProc, uid) {
  if (ppid === 1) return true;
  try {
    if (readProc(`/proc/${ppid}/comm`).trim() !== "systemd") return false;
    const m = /^Uid:\s+(\d+)/m.exec(readProc(`/proc/${ppid}/status`));
    return !!m && Number(m[1]) === uid;
  } catch { return false; }
}

/**
 * Every pid whose environ carries CROW_EVAL_RUN_ID=<runId> exactly, whatever its age. Fails
 * closed for a process of our uid whose environ is unreadable (EACCES), but only if it started
 * at or after sinceBootSec (the run's start, seconds since boot): long-lived unreadable
 * processes (sshd, systemd --user, gpg-agent) cannot belong to the run, and only if its parent
 * is init or our uid's systemd (an escaped pi is reparented there). Other users' processes,
 * zombies and vanished pids are skipped. A readable marked pid always counts.
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
        const st = parseStat(t);
        if (st?.state === "Z") continue; // a zombie's environ is EACCES too; it is dead
        // An escaped pi is reparented to init or the user subreaper; a sudo/ssh/gpg another
        // session started meanwhile has an ordinary parent and is not ours.
        if (!st || !orphaned(st.ppid, readProc, uid)) continue;
        const startTicks = Number(t.slice(t.lastIndexOf(")") + 1).trim().split(/\s+/)[19]); // stat field 22
        if (!Number.isFinite(startTicks) || startTicks / clkTckHz() >= sinceBootSec) out.push(n);
      } catch { /* vanished while checking */ }
    }
  }
  return out;
}

/**
 * survivorsByMarker until it settles: only pids present in every one of `rounds` scans `gapMs`
 * apart. A same-uid process that is merely exiting (environ EACCES for a moment) drops out; a
 * live one, marked or unreadable, stays.
 */
export async function settledSurvivorsByMarker(runId, { sinceBootSec, rounds = 3, gapMs = 300 } = {}) {
  let left = survivorsByMarker(runId, { sinceBootSec });
  for (let i = 1; i < rounds && left.length; i++) {
    await sleep(gapMs);
    const now = new Set(survivorsByMarker(runId, { sinceBootSec }));
    left = left.filter((p) => now.has(p));
  }
  return left;
}

// ---------------------------------------------------------------------------------------------
// runConversation: threads in order over one scratch home, one detached child per thread.
// ---------------------------------------------------------------------------------------------

/**
 * The bridge's own worst case on top of the turn timeout: a 60 s prompt ack, the 15 s
 * --list-models check, two 15 s pre-prompt waits (getState, getSessionStats), the 5 s close,
 * and 30 s margin. The bridge's timeout normally fires first (the child exits 4); the parent
 * timer is the backstop for a wedged child.
 */
export const TURN_SLACK_MS = 140_000;
// Observed with real pi 0.85.1 (tests/live-pi-driver-real.test.js): the session file is
// `<sessionDir>/<ISO timestamp, ":" and "." as "-">_<pi session id>.jsonl` with a uuid v7 id,
// e.g. 2026-10-29T04-59-46-791Z_01a18607-48e6-720a-aed8-ff0047fec50e.jsonl, and an MCP tool
// is spelled mcp__<server>__<tool> (mcp__crow-projects__crow_list_projects) in both the request's
// tools array and the session's toolCall/toolResult lines. A bare server grant (crow_mcp:
// ["crow-projects"]) pins --tools mcp__crow-projects, the router-mode name, so a non-router
// server offers no tools; grant "server/tool" to get mcp__server__tool.
export const SESSION_MISSING = "cannot find the pi session file for a completed turn; refusing to report it";

const CHILD = join(import.meta.dirname, "live-pi-driver-child.mjs");
const CROW_ROOT = join(import.meta.dirname, "..", "..");
const ERR_TAIL_BYTES = 8192;
const POLL_MS = 100;
const EXIT_AFTER_KILL_MS = 10_000;
const THREAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `git -C <path> rev-parse HEAD` (argv, no shell), or null. */
const gitSha = (path) => new Promise((res) => {
  execFile("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 10_000 }, (err, out) => {
    const sha = String(out || "").trim();
    res(!err && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null);
  });
});

function tailOf(path, bytes = ERR_TAIL_BYTES) {
  let fd;
  try { fd = openSync(path, "r"); } catch { return ""; }
  try {
    const size = fstatSync(fd).size;
    const n = Math.min(size, bytes);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    return buf.toString("utf8");
  } finally { closeSync(fd); }
}

/** Reads only complete lines appended since the last call (byte offset, split on raw "\n"). */
function progressTail(path) {
  let offset = 0;
  let partial = Buffer.alloc(0);
  return () => {
    let fd;
    try { fd = openSync(path, "r"); } catch { return []; }
    try {
      const size = fstatSync(fd).size;
      if (size > offset) {
        const buf = Buffer.alloc(size - offset);
        const got = readSync(fd, buf, 0, buf.length, offset);
        offset += got;
        partial = Buffer.concat([partial, buf.subarray(0, got)]);
      }
    } finally { closeSync(fd); }
    const lines = [];
    for (let nl; (nl = partial.indexOf(0x0a)) >= 0;) {
      const l = partial.subarray(0, nl).toString("utf8");
      partial = partial.subarray(nl + 1);
      if (l.trim()) lines.push(l);
    }
    return lines;
  };
}

/** Each distinct piSessionId resolves to exactly one `<sessionDir>/*_<id>.jsonl`, else null. */
function sessionPathsOf(turns, home) {
  const byId = new Map();
  for (const e of turns) {
    if (typeof e.piSessionId !== "string" || !e.piSessionId || typeof e.sessionDir !== "string") return null;
    if (byId.has(e.piSessionId) && byId.get(e.piSessionId) !== e.sessionDir) return null;
    byId.set(e.piSessionId, e.sessionDir);
  }
  const out = [];
  for (const [id, dir] of byId) {
    if (!strictlyInside(realish(dir), home)) return null;
    let hits;
    try { hits = readdirSync(dir).filter((n) => n.endsWith(`_${id}.jsonl`)); } catch { return null; }
    if (hits.length !== 1) return null;
    out.push(join(dir, hits[0]));
  }
  return out.length ? out : null;
}

/**
 * Drive `threads` in order through handleInbound, one child per thread, over the same scratch
 * DB. Bad configuration throws DriverRefusal before anything is written or spawned; a run-time
 * failure resolves `{ ok: false, contaminated }` and the remaining threads do not run.
 * `parentEnv` (default process.env) is the env the child's allowlist reads; process.env itself
 * is never written. `turnSlackMs` may be negative (tests); the parent timer is clamped to 1 s.
 */
export async function runConversation({
  botDef, models, scratchHome, threads, env = {}, allowHosts = [], allowServers, allowSkills = [], piPackages = [],
  gatewayType = "perch", piCli, turnTimeoutMs = 600_000, turnSlackMs = TURN_SLACK_MS, wallMs,
  prodMaxPi = LIFECYCLE_DEFAULTS.maxPi, mcpOverrides = null, allowToolless = false, parentEnv = process.env, log = () => {},
} = {}) {
  const sinceBootSec = bootSecNow();
  const runId = randomUUID();
  const say = (e) => { try { log(e); } catch { /* a logging hook never breaks a run */ } };

  // --- Before any spawn: every guard, then the pi agent dir. -----------------------------------
  if (!Array.isArray(allowServers)) refuse("allowServers is required (an array)");
  if (typeof piCli !== "string" || !isAbsolute(piCli)) refuse("piCli must be an absolute path");
  if (!existsSync(piCli) || !statSync(piCli).isFile()) refuse(`piCli ${piCli} does not exist`);
  if (typeof wallMs !== "number" || !Number.isFinite(wallMs) || wallMs <= 0) refuse("wallMs is required (a positive finite number of ms)");
  if (typeof turnSlackMs !== "number" || !Number.isFinite(turnSlackMs)) refuse("turnSlackMs must be a finite number");
  if (!Number.isInteger(prodMaxPi) || prodMaxPi < 1) refuse("prodMaxPi must be a positive integer");
  if (typeof gatewayType !== "string" || !gatewayType) refuse("gatewayType must be a non-empty string");
  // parentEnv never weakens a guard: the real process.env always applies, parentEnv only adds.
  const protectedEnv = { CROW_SUITE_PROTECTED_ROOTS: [process.env, parentEnv].map((e) => e.CROW_SUITE_PROTECTED_ROOTS || "").join("\n") };
  const home = checkScratchHome(scratchHome, protectedEnv);
  const extraPort = parentEnv.CROW_GATEWAY_PORT;
  const gatewayPorts = extraPort !== undefined && extraPort !== "" && Number.isFinite(Number(extraPort)) ? [Number(extraPort)] : [];
  checkEndpoints(models, { allowHosts, gatewayPort: process.env.CROW_GATEWAY_PORT, gatewayPorts });
  checkBotDef(botDef, models, home);
  checkToolSurface(botDef, { allowServers, allowSkills, scratchHome: home });
  if (typeof allowToolless !== "boolean") refuse("allowToolless must be a boolean");
  // A def with skills defers to the child's EFFECTIVE check: withSkillTools may add the grant.
  if (!(Array.isArray(botDef.skills) && botDef.skills.length > 0)) checkToolGrant(botDef, { allowToolless });
  if (!Array.isArray(threads) || !threads.length) refuse("threads must be a non-empty array");
  const ids = new Set();
  for (const th of threads) {
    if (!th || typeof th.id !== "string" || !THREAD_ID_RE.test(th.id)) refuse(`thread id ${th && th.id} must match ${THREAD_ID_RE}`);
    if (ids.has(th.id)) refuse(`thread ids must be unique (${th.id} repeats)`);
    ids.add(th.id);
    if (!Array.isArray(th.turns) || !th.turns.length) refuse(`thread ${th.id} turns must be a non-empty array`);
  }
  if (!Array.isArray(piPackages)) refuse("piPackages must be an array");
  for (const p of piPackages) {
    if (typeof p !== "string" || !isAbsolute(p)) refuse(`piPackages entry ${p} must be an absolute path`);
    if (!existsSync(p)) refuse(`piPackages entry ${p} does not exist`);
  }
  // Validates piCli, turnTimeoutMs and env; the same env serves every thread.
  const cenv = childEnv({ home, botId: botDef.id, runId, piCli, extraEnv: env, turnTimeoutMs, parent: parentEnv });
  const turnMs = Math.max(1000, turnTimeoutMs + turnSlackMs);

  const agentDir = join(home, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  const providers = {};
  for (const [name, p] of Object.entries(models.providers)) providers[name] = { ...p, apiKey: p.apiKey ?? "stub" };
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ ...models, providers }, null, 2));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: piPackages }, null, 2));
  // An EMPTY <home>/.pi/agent/mcp.json: no global MCP servers reach the bot. It must exist: the
  // bridge's writeBotMcp reads it as the canonical config and, when it is missing, skips the
  // per-bot config, so a real pi got no crow_mcp tools at all (seen with real pi, Task 6).
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "mcp.json"), JSON.stringify({ mcpServers: {} }));

  const meta = {
    packages: await Promise.all(piPackages.map(async (path) => ({ path, sha: await gitSha(path) }))),
    crow_sha: await gitSha(CROW_ROOT),
    flags: null,
  };
  const wallEnd = Date.now() + wallMs;
  const out = [];
  let contaminated = null;
  let reason = null;

  for (const thread of threads) {
    if (Date.now() >= wallEnd) { contaminated = "conversation exceeded wallMs"; break; }
    const r = await runThread({ thread, home, cenv, runId, sinceBootSec, turnMs, wallEnd, say, job: {
      botDef, gatewayType, allowServers, allowSkills, allowToolless, prodMaxPi, capacityCount: null, mcpOverrides, runId, thread,
    } });
    if (meta.flags === null && r.flags) meta.flags = r.flags;
    out.push({ id: thread.id, sessionPaths: r.sessionPaths, turns: r.turns });
    if (r.contaminated) { contaminated = r.contaminated; reason = r.reason; break; }
  }
  return { ok: contaminated === null, contaminated, reason, threads: out, meta };
}

/** One thread: spawn, tail, enforce the timers, wait for exit, sweep by marker, find sessions. */
async function runThread({ thread, home, cenv, runId, sinceBootSec, turnMs, wallEnd, say, job }) {
  const id = thread.id;
  const jobPath = join(home, `job-${id}.json`);
  const progressPath = join(home, `progress-${id}.ndjson`);
  const errPath = join(home, `driver-${id}.err`);
  writeFileSync(jobPath, JSON.stringify(job));
  writeFileSync(progressPath, "");
  const outFd = openSync(join(home, `driver-${id}.out`), "a");
  const errFd = openSync(errPath, "a");
  let child;
  try {
    child = spawn(process.execPath, [CHILD, jobPath, progressPath], { cwd: home, env: cenv, stdio: ["ignore", outFd, errFd], detached: true });
  } finally { closeSync(outFd); closeSync(errFd); }
  let exited = null;
  child.on("exit", (code, signal) => { exited = { code, signal }; });
  child.on("error", (error) => { if (!exited) exited = { code: null, signal: null, error }; });
  say({ ev: "spawn", thread: id, pid: child.pid, runId });

  const drain = progressTail(progressPath);
  const turns = [];
  let flags = null;
  let done = false;
  let badLine = null;
  let turnDeadline = null;
  let turnN = 0;
  const take = () => {
    for (const l of drain()) {
      let e;
      try { e = JSON.parse(l); } catch { badLine = badLine || l.slice(0, 200); continue; }
      say({ ev: "progress", thread: id, line: e });
      if (e.ev === "start") flags = e.flags ?? null;
      else if (e.ev === "turn-start") { turnN = Number(e.turn) + 1; turnDeadline = Date.now() + turnMs; }
      else if (e.ev === "turn-end") { turnDeadline = null; turns.push(e); }
      else if (e.ev === "done") done = true;
    }
  };

  let killReason = null;
  let treeSurvivors = [];
  try {
    let killedAt = null;
    while (!exited) {
      take();
      const now = Date.now();
      if (!killReason && child.pid) {
        if (turnDeadline !== null && now >= turnDeadline) killReason = `turn ${turnN} of ${id} exceeded ${turnMs} ms`;
        else if (now >= wallEnd) killReason = "conversation exceeded wallMs";
        if (killReason) {
          killedAt = now;
          say({ ev: "kill", thread: id, pid: child.pid, at: now, why: killReason });
          treeSurvivors = (await killTree(child.pid)).survivors;
        }
      }
      if (exited) break;
      if (killedAt !== null && Date.now() - killedAt > EXIT_AFTER_KILL_MS) break; // unkillable: survivors say so
      await sleep(POLL_MS);
    }
  } finally {
    // A throw in this loop must not leave the child running.
    if (!exited && child.pid && isAlive(child.pid)) treeSurvivors = (await killTree(child.pid)).survivors;
  }
  take();

  let why = killReason;
  if (!why) {
    const x = exited || {};
    const errTail = tailOf(errPath);
    if (x.error) why = `child failed to spawn: ${x.error.message}`;
    else if (x.signal) why = `child killed by ${x.signal}`;
    else if (x.code === 4) {
      const last = turns.at(-1);
      const m = /ended with action \S+: (.*)$/m.exec(errTail);
      why = last ? `turn ${Number(last.turn) + 1} action ${last.action}${m ? `: ${m[1]}` : ""}` : "child exited 4 without a turn-end";
    } else if (x.code === 6) why = "prod pi capacity";
    else if (x.code === 5) why = "child exited 5 (parent died)";
    else if (x.code !== 0) why = `child exited ${x.code}`;
    else if (badLine) why = `unparseable progress line: ${badLine}`;
    else if (!done) why = "child exited 0 without a done event";
  }
  if (treeSurvivors.length) why = `${why ? `${why}; ` : ""}killTree survivors: ${treeSurvivors.join(",")}`;

  // After EVERY thread: a pi reparented by an exited child is invisible to the tree walk.
  const marked = await settledSurvivorsByMarker(runId, { sinceBootSec });
  if (marked.length) {
    // Kill only pids whose environ positively carries the marker; an unreadable one (the
    // scan fails closed) still contaminates, but is never signalled on a guess.
    const want = `CROW_EVAL_RUN_ID=${runId}`;
    const carries = (p) => { try { return defaultReadProc(`/proc/${p}/environ`).split("\0").includes(want); } catch { return false; } };
    const confirmed = marked.filter(carries);
    for (const p of confirmed) signal(p, "SIGKILL");
    await waitGone(confirmed, 1000);
    const unconfirmed = marked.filter((p) => !confirmed.includes(p));
    why = `${why ? `${why}; ` : ""}run processes survived the thread: ${confirmed.join(",") || "none"} killed${unconfirmed.length ? `, ${unconfirmed.join(",")} unreadable (not signalled)` : ""}`;
  }

  let sessionPaths = [];
  if (!why) {
    const paths = sessionPathsOf(turns, home);
    if (!paths) why = SESSION_MISSING;
    else sessionPaths = paths;
  }
  // A failed model call contaminates the whole thread, whichever turn it was (Lane D).
  for (const p of sessionPaths) {
    if (why) break;
    let text = "";
    try { text = readFileSync(p, "utf8"); } catch (e) { why = `cannot read session ${p}: ${e.message}`; break; }
    why = modelErrorOf(text);
  }
  return { contaminated: why, reason: why ? tailOf(errPath) || null : null, turns, sessionPaths, flags };
}

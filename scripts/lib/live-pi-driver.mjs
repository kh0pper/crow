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
import { existsSync, statSync } from "node:fs";
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
  const blocked = new Set([...GATEWAY_PORTS, ...gatewayPorts.map(Number)]);
  if (gatewayPort !== undefined && gatewayPort !== "" && Number.isFinite(Number(gatewayPort))) blocked.add(Number(gatewayPort));
  for (const [name, p] of Object.entries(providers)) {
    if (!p || typeof p.baseUrl !== "string" || !p.baseUrl) refuse(`provider ${name} has no baseUrl`);
    let u;
    try { u = new URL(p.baseUrl); } catch { refuse(`provider ${name} baseUrl is not a URL`); }
    if (!(u.protocol in DEFAULT_PORT)) refuse(`provider ${name} baseUrl must be http or https`);
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const port = u.port ? Number(u.port) : DEFAULT_PORT[u.protocol];
    const hostPort = `${host.includes(":") ? `[${host}]` : host}:${port}`;
    const allowed = LOOPBACK.has(host) || allowHosts.some((h) => String(h).toLowerCase() === hostPort || String(h).toLowerCase() === `${host}:${port}`);
    if (!allowed) refuse(`provider ${name} host ${hostPort} is not loopback and not in allowHosts`);
    if (blocked.has(port)) refuse(`provider ${name} port ${port} is a gateway port`);
    if (`${u.pathname}/`.includes("/llm/") || `${u.pathname}/`.includes("/proxy/")) refuse(`provider ${name} path ${u.pathname} goes through a gateway`);
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
  if (pol.bash !== "deny") refuse('permission_policy.bash must be "deny"');
  if (pol.multi_agent) refuse("permission_policy.multi_agent must be falsy");
  const tools = d.tools || {};
  const builtin = tools.pi_builtin === undefined ? [] : tools.pi_builtin;
  if (!Array.isArray(builtin) || builtin.some((t) => !["read", "write", "edit"].includes(t))) refuse('tools.pi_builtin must be a subset of ["read","write","edit"]');
  const home = realish(scratchHome);
  for (const w of pol.write_paths || []) {
    if (typeof w !== "string" || !strictlyInside(realish(w), home)) refuse(`write_paths entry ${w} is not strictly inside the scratch home`);
  }
  const servers = new Set(allowServers || []);
  for (const e of tools.crow_mcp || []) {
    const server = String(e).split("/")[0];
    if (server === "board") refuse("crow_mcp server board is refused in v1");
    if (!servers.has(server)) refuse(`crow_mcp server ${server} is not in allowServers`);
  }
  const nonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : v && typeof v === "object" ? Object.keys(v).length > 0 : Boolean(v));
  if (nonEmpty(d.spawn_env)) refuse("spawn_env must be absent or empty");
  if (nonEmpty(d.pi_extensions)) refuse("pi_extensions must be absent or empty");
  if (d.skill_learning !== undefined && d.skill_learning !== null && d.skill_learning !== "off") refuse('skill_learning must be absent or "off"');
  if (d.self_authoring) refuse("self_authoring must be falsy");
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
    PIBOT_PI_CLI: piCli,
    ...extra,
  };
}

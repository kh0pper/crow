#!/usr/bin/env node
/**
 * Crow Bot Builder — the per-instance Crow server catalog.
 *
 * THE INVARIANT: a bot must never resolve a Crow server bound to an instance
 * other than its own. Stated structurally, which is how this module achieves
 * it: no file that can name an instance may describe a Crow server.
 *
 * So Crow servers are DERIVED, never copied out of the user-global
 * ~/.pi/agent/mcp.json:
 *   - core servers  -> scripts/server-registry.js, run from the repo root,
 *                      env bound to THIS instance
 *   - bundle servers -> <crowHome>/mcp-addons.json, cwd under THIS instance
 * The homedir config keeps only third-party servers, which carry credentials
 * rather than instance identity.
 *
 * Imports are deliberately limited to server-registry.js and instance-paths.mjs
 * so neither ext_registry.mjs nor mcp_writer.mjs can form a cycle through here.
 */
import { resolveAddonCommand, checkLauncherArgs } from "../../servers/shared/resolve-command.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  CORE_SERVERS,
  CONDITIONAL_SERVERS,
  ROOT,
  loadEnv,
  resolveEnvValue,
} from "../server-registry.js";
import { botsDbPath, resolveSqlitePath } from "./instance-paths.mjs";
import { signActor, signBoardActor, signArtifactsActor, signBoardThreadActor, signSecretsActor } from "./actor-sig.mjs";
// Leaf module (registry read only): no path back to ext_registry.mjs or mcp_writer.mjs.
import { isLegacyConfiguredAddon, addonDerivedEnv } from "../../servers/gateway/services/legacy-sources.js";
// Leaf module (no imports): loader/injection names a child must never inherit from the
// addon entry — NODE_OPTIONS --require and LD_PRELOAD run code before the server does.
import { withoutLoaderEnv } from "../../servers/shared/loader-env.js";
// Names only, never a value: this module resolves no keychain handle and unseals nothing
// (the spawning process hydrates; see addonKeychainNeeds below). INSTANCE_ENV_KEYS comes from
// there too: the shared module needs the same list to drop a listed instance key, and this
// module may not be imported BY it (that would be a cycle).
import { ADDON_KEYCHAIN_FIELD, ADDON_SECRET_SHARES, INSTANCE_ENV_KEYS, keychainEnvNames } from "../../servers/shared/addon-secrets.js";

/**
 * The env vars that name an instance. r4-deploy.sh warns that a child missing
 * any of these silently resolves to the PRIMARY instance, which is exactly the
 * failure this list exists to prevent. Defined in servers/shared/addon-secrets.js
 * (keychainEnvNames drops a listed instance key) and re-exported here.
 */
export { INSTANCE_ENV_KEYS };

/** The default primary-instance home — the one botsDbPath()/tasksDbPath() fall back to. */
const DEFAULT_CROW_HOME = join(homedir(), ".crow");

/**
 * This instance's canonical values for the four instance-scoped env vars.
 *
 * botsDbPath()/tasksDbPath() (instance-paths.mjs) resolve from the PROCESS
 * env (CROW_DB_PATH / CROW_DATA_DIR, and since queue item 33 a non-default
 * process CROW_HOME), never from the `crowHome` argument, so a caller that
 * hands us a `crowHome` for ANOTHER instance would otherwise resolve to this
 * process's database — silently rebinding a correct block onto the wrong
 * instance, which is worse than not rebinding at all. So when the env doesn't
 * decide, honor the crowHome argument itself (unless it IS the default, in
 * which case botsDbPath()'s own fallback is already correct).
 *
 * The tasks path is normalized through resolveSqlitePath(): production stores
 * `file:` URIs in project_spaces.tasks_db_uri and better-sqlite3 has no URI
 * support, so an un-normalized value reaches a bundle as an unopenable
 * filename (the PR #278 defect).
 */
export function instanceBinding(crowHome, opts = {}) {
  let dbPath = opts.dbPath;
  if (!dbPath) {
    if (process.env.CROW_DB_PATH) {
      dbPath = process.env.CROW_DB_PATH;
    } else if (process.env.CROW_DATA_DIR) {
      dbPath = join(process.env.CROW_DATA_DIR, "crow.db");
    } else if (crowHome && crowHome !== DEFAULT_CROW_HOME) {
      dbPath = join(crowHome, "data", "crow.db");
    } else {
      dbPath = botsDbPath();
    }
  }
  const tasksPath =
    opts.tasksDbPath ||
    process.env.CROW_TASKS_DB_PATH ||
    join(dirname(dbPath), "tasks.db");
  return {
    CROW_HOME: crowHome,
    CROW_DATA_DIR: dirname(dbPath),
    CROW_DB_PATH: dbPath,
    CROW_TASKS_DB_PATH: resolveSqlitePath(tasksPath),
  };
}

/** A bundle cwd under SOME instance home: /…/.crow<suffix>/bundles/<id>. */
const INSTANCE_BUNDLE_CWD = /\/\.crow[^/]*\/bundles\/([^/]+)\/?$/;

/**
 * The board MCP entry (Track 1 Task 7, D-T1.3/D-T1.5) — a direct
 * streamable-HTTP `{url, headers}` block at THIS instance's gateway
 * `/board/mcp` mount. Unlike every other catalog entry, there is nothing to
 * spawn: the gateway process already runs the mount in-process, so this is a
 * remote reference, not a stdio command.
 *
 * Bearer = the RAW board token at `<crowHome>/board-token` (minted by
 * ensureBoardToken at gateway boot, servers/gateway/local-token.js) — read
 * directly off disk, like the peer-relay token the remote-forward-proxy
 * blocks name (this module stays DB-agnostic on purpose). Actor headers (D-T1.3) let board-mcp.js's
 * resolveActor attribute a mutation to this bot and, when a job dispatched
 * the turn, to that job — the SAME botId/jobId that land in bot_sessions and
 * bot_jobs, which is what makes the result-service lock exemption
 * (card-service.js's lockExemptMatches) actually match.
 *
 * Missing/unreadable token file -> return null (never throw): config
 * generation must survive a not-yet-booted gateway or a pre-Task-6 install.
 * The caller (crowServerCatalog) surfaces this through `unconfigured`, the
 * same channel every other not-available-right-now server uses — so a bot
 * that never selects "board" never sees a warning, and one that does gets
 * exactly one line, once, from buildBotMcp's existing warnings plumbing.
 */
function boardTokenPath(crowHome) {
  return join(crowHome, "board-token");
}

function boardBlock(crowHome, { botId, jobId, threadId, gatewayType, port } = {}) {
  let token;
  try {
    token = readFileSync(boardTokenPath(crowHome), "utf8").trim();
  } catch {
    return null;
  }
  if (!token) return null;
  // Same loopback-gateway convention as scripts/pi-bots/warm.mjs
  // (PIBOT_WARM_GATEWAY_URL / CROW_GATEWAY_PORT, default :3001).
  const gatewayPort = port || process.env.CROW_GATEWAY_PORT || 3001;
  const headers = { Authorization: "Bearer " + token, "X-Crow-Actor-Kind": "bot" };
  if (botId) headers["X-Crow-Actor-Id"] = String(botId);
  if (jobId) headers["X-Crow-Job-Id"] = String(jobId);
  // S5: board-mcp honours the actor headers only with this signature (present
  // only when this process holds the per-boot key; see actor-sig.mjs).
  const sig = signBoardActor({ botId, jobId });
  if (sig) headers["X-Crow-Actor-Sig"] = sig;
  // P5: when the turn belongs to a chat, bind (bot, thread, gateway) under its
  // own kind so /board/mcp can offer a card back into that conversation.
  if (threadId) {
    headers["X-Crow-Actor-Thread"] = String(threadId);
    if (gatewayType) headers["X-Crow-Actor-Gateway"] = String(gatewayType);
    const tsig = signBoardThreadActor({ botId, threadId, gatewayType });
    if (tsig) headers["X-Crow-Actor-Thread-Sig"] = tsig;
  }
  return { url: `http://127.0.0.1:${gatewayPort}/board/mcp`, headers };
}

function phoneTokenPath(crowHome) { return join(crowHome, "phone-token"); }

/** Phone bundle: {url, headers} block for /phone/mcp. The actor headers carry
 *  the bot, the thread and the gateway so the call result can be delivered
 *  back to the conversation that asked for it. Absent token file → null. */
function phoneBlock(crowHome, { botId, threadId, gatewayType, port } = {}) {
  let token;
  try { token = readFileSync(phoneTokenPath(crowHome), "utf8").trim(); } catch { return null; }
  if (!token) return null;
  const gatewayPort = port || process.env.CROW_GATEWAY_PORT || 3001;
  const headers = { Authorization: "Bearer " + token, "X-Crow-Actor-Kind": "bot" };
  if (botId) headers["X-Crow-Actor-Id"] = String(botId);
  if (threadId) headers["X-Crow-Actor-Thread"] = String(threadId);
  if (gatewayType) headers["X-Crow-Actor-Gateway"] = String(gatewayType);
  // S2: bind the actor headers to this (bot, thread, gateway). The key lives
  // only in this process's memory (actor-sig.mjs); without it no signature is
  // written and /phone/mcp treats the caller as unattributed.
  const sig = signActor({ kind: "bot", botId, threadId, gatewayType });
  if (sig) headers["X-Crow-Actor-Sig"] = sig;
  return { url: `http://127.0.0.1:${gatewayPort}/phone/mcp`, headers };
}

function artifactsTokenPath(crowHome) { return join(crowHome, "artifacts-token"); }

/** Crow Artifacts: {url, headers} block for /artifacts/mcp, signed with kind
 *  "artifacts" (actor-sig.mjs) so the mount can attribute — and, for an
 *  untrusted round, scope — every call. Absent token file → null. */
function artifactsBlock(crowHome, { botId, threadId, gatewayType, port } = {}) {
  let token;
  try { token = readFileSync(artifactsTokenPath(crowHome), "utf8").trim(); } catch { return null; }
  if (!token) return null;
  const gatewayPort = port || process.env.CROW_GATEWAY_PORT || 3001;
  const headers = { Authorization: "Bearer " + token, "X-Crow-Actor-Kind": "bot" };
  if (botId) headers["X-Crow-Actor-Id"] = String(botId);
  if (threadId) headers["X-Crow-Actor-Thread"] = String(threadId);
  if (gatewayType) headers["X-Crow-Actor-Gateway"] = String(gatewayType);
  const sig = signArtifactsActor({ botId, threadId, gatewayType });
  if (sig) headers["X-Crow-Actor-Sig"] = sig;
  return { url: `http://127.0.0.1:${gatewayPort}/artifacts/mcp`, headers };
}

/** The catalog name of the credential card's mount (spec §10.2). */
export const SECRETS_SERVER = "crow-secrets";

// The secrets token lives in <crowHome>/secrets (the 700 dir the pi sandbox hides from bots),
// rotated at every gateway boot (local-token.js SECRETS_TOKEN); this runs outside the sandbox.
function secretsTokenPath(crowHome) { return join(crowHome, "secrets", "secrets-token"); }

/** Credential card: {url, headers} block for /secrets/mcp, signed with kind "secrets" like
 *  artifactsBlock. crow_request_secret answers only a signed Perch actor (secrets/mcp.js).
 *  Absent token file → null. */
function secretsBlock(crowHome, { botId, threadId, gatewayType, port } = {}) {
  let token;
  try { token = readFileSync(secretsTokenPath(crowHome), "utf8").trim(); } catch { return null; }
  if (!token) return null;
  const gatewayPort = port || process.env.CROW_GATEWAY_PORT || 3001;
  const headers = { Authorization: "Bearer " + token, "X-Crow-Actor-Kind": "bot" };
  if (botId) headers["X-Crow-Actor-Id"] = String(botId);
  if (threadId) headers["X-Crow-Actor-Thread"] = String(threadId);
  if (gatewayType) headers["X-Crow-Actor-Gateway"] = String(gatewayType);
  const sig = signSecretsActor({ botId, threadId, gatewayType });
  if (sig) headers["X-Crow-Actor-Sig"] = sig;
  return { url: `http://127.0.0.1:${gatewayPort}/secrets/mcp`, headers };
}

function applyJournalGuard(env) {
  // The WAL-unlink scar: every server touching a crow.db runs journal DELETE.
  if (env && env.CROW_DB_PATH) env.CROW_JOURNAL_MODE = "DELETE";
  return env;
}

/**
 * The env NAMES an add-on cannot start without, read from the entries alone — never a value.
 *
 * Two sources: the entry's own `keychainEnv` (its sealed settings) and ADDON_SECRET_SHARES
 * (another add-on's settings this one reads, R6 — e.g. sunvox-studio reading Funkwhale's
 * URL and access token). Producing the values is the CALLER's business (the gateway hydrates
 * from its own keychain); a bot config only learns which names are owed.
 *
 * A SHARE name is owed only when the SOURCE add-on's own entry lists it in `keychainEnv`:
 * sunvox-studio never seals Funkwhale's settings itself, so with Funkwhale not installed (no
 * entry) or unsealed (nothing listed) it owes no keychain name at all — and a file-mode bot
 * keeps it instead of dropping it with a warning about keys that do not exist. `opts.addons`
 * is the whole mcp-addons.json map (the source entries live there, not in this entry).
 *
 * Empty for an add-on with neither, which is what keeps today's entries byte-identical.
 */
export function addonKeychainNeeds(id, entry, opts = {}) {
  const names = [...keychainEnvNames(entry)];
  const shares = typeof id === "string" && Object.prototype.hasOwnProperty.call(ADDON_SECRET_SHARES, id)
    ? ADDON_SECRET_SHARES[id]
    : null;
  if (shares && typeof shares === "object") {
    const addons = opts.addons && typeof opts.addons === "object" ? opts.addons : {};
    for (const [sourceId, wanted] of Object.entries(shares)) {
      // The source must be installed (it has an entry) and must itself seal the name.
      const source = Object.prototype.hasOwnProperty.call(addons, sourceId) ? addons[sourceId] : null;
      if (!source || typeof source !== "object") continue;
      const listed = keychainEnvNames(source);
      for (const name of Array.isArray(wanted) ? wanted : []) {
        if (typeof name !== "string" || name === "" || !listed.includes(name)) continue;
        if (!names.includes(name)) names.push(name);
      }
    }
  }
  return names;
}

/**
 * A block's env with the plain value of every keychain-listed name removed.
 *
 * A listed name is authoritative at spawn: its value comes from the keychain, so any plain
 * copy left in the entry is stale by definition and must not board a bot's MCP config.
 * An entry with no listed names gets the SAME object back (today's behaviour, byte for
 * byte). Instance-scoped keys are never stripped: they name the instance, not a secret,
 * and removing one would let the child inherit whatever ambient value the caller has.
 *
 * `listed` is the caller's already-read keychainEnvNames() result when it has one (a
 * caller that reads the names twice would log a malformed entry's warning twice);
 * omitted, the entry is read here.
 */
export function withoutKeychainValues(entry, env, listed) {
  const source = env && typeof env === "object" ? env : null;
  if (!source) return env;
  const names = (Array.isArray(listed) ? listed : keychainEnvNames(entry))
    .filter((n) => !INSTANCE_ENV_KEYS.includes(n));
  if (names.length === 0) return env;
  const out = { ...source };
  for (const name of names) delete out[name];
  return out;
}

/**
 * Rebind a server block that did NOT come from the catalog — a third-party or
 * `crow-browser` entry out of the homedir config — onto this instance.
 *
 * Returns {block, rebound} or {disabled, reason}. `optIn` is stripped: pi
 * activates an optIn server only when a project file says {"enabled": true},
 * so a verbatim copy of an optIn block silently never loads. Selecting the
 * server IS the opt-in.
 *
 * The /.crow anchor is deliberate. `/home/alex/crow/bundles/browser` and
 * `/home/alex/crow` do not match, so the repo is left alone — it is
 * instance-neutral, correctly.
 */
export function rebindBlock(name, block, binding, crowHome) {
  const clone = JSON.parse(JSON.stringify(block));
  delete clone.optIn;
  const rebound = [];
  if (clone.env) {
    for (const k of INSTANCE_ENV_KEYS) {
      if (k in clone.env && clone.env[k] !== binding[k]) {
        clone.env[k] = binding[k];
        rebound.push(k);
      }
    }
  }
  const m = clone.cwd ? INSTANCE_BUNDLE_CWD.exec(clone.cwd) : null;
  if (m) {
    const target = join(crowHome, "bundles", m[1]);
    if (!existsSync(target)) {
      return {
        disabled: true,
        reason: `bundle '${m[1]}' is not installed on this instance (${target})`,
      };
    }
    if (clone.cwd !== target) {
      clone.cwd = target;
      rebound.push("cwd");
    }
  }
  applyJournalGuard(clone.env);
  return { block: clone, rebound };
}

function readAddons(crowHome) {
  try {
    return JSON.parse(readFileSync(join(crowHome, "mcp-addons.json"), "utf8")) || {};
  } catch {
    return {};
  }
}

/**
 * Build a core-server block from its registry entry. Instance-scoped env keys
 * come from the binding; everything else resolves against the repo .env.
 * Returns {block, missing} — `missing` names required templates (no `:-`
 * default) that resolved empty.
 */
function coreBlock(spec, binding, repoEnv, node) {
  const env = {};
  const missing = [];
  for (const [k, tmpl] of Object.entries(spec.mcpEnv || {})) {
    if (INSTANCE_ENV_KEYS.includes(k)) {
      env[k] = binding[k];
      continue;
    }
    const v = resolveEnvValue(tmpl, repoEnv);
    if (!v && /\$\{\w+\}/.test(tmpl)) missing.push(k);
    // An optional key (`${KEY:-}`) with no value is left OUT: an empty string in block.env
    // would shadow a real value the child inherits from process.env.
    else if (!v && /\$\{\w+:-\}/.test(tmpl)) continue;
    else env[k] = v;
  }
  applyJournalGuard(env);
  return { block: { command: node, args: [...spec.args], cwd: ROOT, env }, missing };
}

/**
 * Every Crow server available to THIS instance, plus the ones that exist but
 * cannot be spawned here and why.
 *
 * `unconfigured` is not an error channel — it is what the GUI renders so an
 * operator sees "crow-storage: unconfigured, missing MINIO_ENDPOINT" instead
 * of an opaque spawn failure.
 *
 * `coreNames` names the subset of `servers` sourced from the registry
 * (CORE_SERVERS + CONDITIONAL_SERVERS, plus the core-mounted `phone` http
 * entry when its token exists) rather than from mcp-addons.json. It
 * exists so a consumer that wants ONLY the registry-sourced servers (the ones
 * that vanish from the picker once Crow entries leave the homedir config) can
 * select them without re-deriving the split — `probeExtensions` already owns
 * the addon half of `servers` and is already instance-correct, so folding
 * addons back in elsewhere would double-list and double-spawn them.
 */
export function crowServerCatalog(crowHome = process.env.CROW_HOME || join(homedir(), ".crow"), opts = {}) {
  const binding = opts.binding || instanceBinding(crowHome, opts);
  const node = opts.node || process.execPath;
  const repoEnv = loadEnv();
  const servers = {};
  const unconfigured = {};
  const coreNames = [];
  // id -> the env names it owes the keychain. Names only, and only for blocks this catalog
  // actually emitted: the caller hydrates them (or refuses the spawn) — this module never does.
  const needsKeys = {};

  // Board entry FIRST (Track 1 Task 7) — the one {url, headers} block in an
  // otherwise all-stdio catalog. See boardBlock() above.
  const board = boardBlock(crowHome, { botId: opts.botId, jobId: opts.jobId, threadId: opts.threadId, gatewayType: opts.gatewayType, port: opts.gatewayPort });
  if (board) servers.board = board;
  else unconfigured.board = "board token not found — mint one from the dashboard (or ensureBoardToken at boot)";
  const phone = phoneBlock(crowHome, { botId: opts.botId, threadId: opts.threadId, gatewayType: opts.gatewayType, port: opts.gatewayPort });
  // Phone joins coreNames so serversForProbe offers its tools in the Bot
  // Builder Tools tab (an http block; probeServerTools speaks HTTP). Only when
  // the gateway minted a phone token, i.e. the Phone bundle is installed.
  if (phone) { servers.phone = phone; coreNames.push("phone"); }
  const artifacts = artifactsBlock(crowHome, { botId: opts.botId, threadId: opts.threadId, gatewayType: opts.gatewayType, port: opts.gatewayPort });
  if (artifacts) { servers.artifacts = artifacts; coreNames.push("artifacts"); }
  const secrets = secretsBlock(crowHome, { botId: opts.botId, threadId: opts.threadId, gatewayType: opts.gatewayType, port: opts.gatewayPort });
  if (secrets) { servers[SECRETS_SERVER] = secrets; coreNames.push(SECRETS_SERVER); }

  for (const spec of CORE_SERVERS) {
    const { block } = coreBlock(spec, binding, repoEnv, node);
    servers[spec.name] = block;
    coreNames.push(spec.name);
  }
  for (const spec of CONDITIONAL_SERVERS) {
    const { block, missing } = coreBlock(spec, binding, repoEnv, node);
    if (missing.length) unconfigured[spec.name] = `unconfigured: missing ${missing.join(", ")}`;
    else servers[spec.name] = block;
    coreNames.push(spec.name);
  }
  // A service add-on's fields count as set in its entry, the repo .env, or the
  // caller's environment (the child inherits it), as in the gateway's proxy.
  const addonEnv = { ...repoEnv, ...process.env };
  // Read once: a SHARE name is owed only when the SOURCE add-on's own entry lists it
  // (addonKeychainNeeds), which needs the whole map, not this entry.
  const addons = readAddons(crowHome);
  for (const [id, addon] of Object.entries(addons)) {
    // Satellite-hosted bundles have no local MCP server to spawn: crow reaches them through its
    // own satellite tool entry (spec §8, §9.1), so they are never catalog blocks here.
    if (addon?.transport === "satellite") {
      unconfigured[id] = "satellite: its tools come from the paired server";
      continue;
    }
    // The names this entry seals in the keychain (never a value). Read once, before the
    // block is built: a listed name's plain copy is dropped and no derived env is rendered.
    const listed = keychainEnvNames(addon);
    if (!isLegacyConfiguredAddon(id, addon, undefined, addonEnv)) {
      unconfigured[id] = "service: its account fields are not set";
      continue;
    }
    const cwd = resolve(addon.cwd || join(crowHome, "bundles", id));
    if (!existsSync(cwd)) {
      unconfigured[id] = `bundle not installed on this instance (${cwd})`;
      continue;
    }
    const r = rebindBlock(id, { ...addon, cwd }, binding, crowHome);
    if (r.disabled) {
      unconfigured[id] = r.reason;
    } else {
      // A bundle server runs UNDER this instance, so it must be told which one.
      // rebindBlock only rewrites instance keys a block already carries, and most
      // addon blocks carry none — which left CROW_HOME to whatever ambient
      // environment the caller happened to have (the browser bundle wrote its
      // sessions wherever that pointed). CROW_HOME only: injecting CROW_DB_PATH
      // would trip touchesCrowDb() and apply the journal guard to bundles that
      // never open crow.db.
      // A service add-on also gets its manifest's derived env (Render's AUTH_HEADER), rendered
      // from the entry's own env ONLY: those values are already in this block, so nothing new
      // is written. A field the child would inherit from the environment is never rendered into
      // the block (that would copy a gateway .env secret into the bot's MCP config).
      // A SEALED add-on (keychainEnv lists a name) gets no derived env at all: `derived` is
      // rendered from the entry's plain values, so a listed name's stale plaintext could come
      // back through a derived header (Render's `AUTH_HEADER: Bearer ${...}`) even after the
      // plain value itself was stripped below.
      const derived = listed.length > 0 ? {} : addonDerivedEnv(id, addon.env, undefined, {});
      // Loader names (NODE_OPTIONS, LD_PRELOAD, …) are stripped from BOTH sides: the block's
      // env is cloned from the addon entry, and `derived` is rendered from that same entry's
      // env, so a loader name can reach the child through either. CROW_HOME is added here by
      // the catalog itself and is never stripped.
      // A listed name is authoritative at spawn (its value comes from the keychain), so its
      // plain copy is removed — the value is unsealed by the spawning process, never here.
      r.block.env = { ...withoutLoaderEnv(withoutKeychainValues(addon, r.block.env, listed)),
        ...withoutLoaderEnv(derived), CROW_HOME: crowHome };
      // The list itself is not part of a spawn block: no `keychainEnv` field ever reaches a
      // bot's MCP config (only the names the caller still owes travel, via needsKeys).
      delete r.block[ADDON_KEYCHAIN_FIELD];
      // A bare command (uvx, uv, npx) is resolved to an absolute path here:
      // the gateway's systemd PATH usually lacks ~/.local/bin, so the bot's
      // pi child failed with ENOENT and the server silently dropped.
      if (typeof r.block.command === "string") {
        const rc = resolveAddonCommand(r.block.command, { sha256: r.block.command_sha256, cwd: r.block.cwd || cwd });
        const argProblem = rc.missing ? null : checkLauncherArgs(rc.command, r.block.args);
        if (argProblem) { unconfigured[id] = `command '${r.block.command}' not usable: ${argProblem}`; continue; }
        if (rc.missing) {
          unconfigured[id] = `command '${r.block.command}' not usable: ${rc.reason || "not found"} (searched the gateway PATH, ~/.local/bin, ~/.cargo/bin, ~/bin, /usr/local/bin)`;
          continue;
        }
        r.block.command = rc.command;
        // A pinned launcher keeps its pin: pi-lab's mcp-client re-hashes it
        // right before it spawns the server (verification at spawn time).
        if (rc.sha256) r.block.command_sha256 = rc.sha256; else delete r.block.command_sha256;
      }
      servers[id] = r.block;
      // Only an EMITTED block owes keys: an unconfigured or unusable add-on is not in the
      // config at all, so there is nothing for the caller to hydrate.
      const needs = addonKeychainNeeds(id, addon, { addons });
      if (needs.length > 0) needsKeys[id] = needs;
    }
  }
  return { servers, unconfigured, coreNames, needsKeys };
}

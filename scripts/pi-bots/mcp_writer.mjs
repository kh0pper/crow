#!/usr/bin/env node
/**
 * Crow Bot Builder — per-bot MCP config writer + tool-list prober.
 *
 * PRECEDENCE (verified live against pi 0.82.0 + pi-lab main, 2026-08-08):
 * pi-lab/extensions/mcp-client.ts merges ~/.pi/agent/mcp.json FIRST, then every
 * cwd-ancestor .mcp.json from the filesystem root down to cwd — the NEAREST
 * project file WINS. pi-lab commit 671e116 (2026-07-04) changed this; the old
 * "homedir wins on collision" rule this file used to assert is FALSE, and
 * believing it hid three live bugs for a month. A project file may also delete
 * an inherited server with {"name": {"disabled": true}}.
 *
 * So the per-bot <session_dir>/.mcp.json is AUTHORITATIVE, and this writer
 * writes it CLOSED-WORLD: the bot's selected servers with instance-correct
 * bindings, plus {"disabled": true} for every other server named in CANONICAL
 * that pi would otherwise inherit. That makes the file the complete statement
 * of CANONICAL's world, not of the bot's actual world — pi also merges every
 * cwd-ancestor .mcp.json between the filesystem root and the session dir, and
 * a server defined only in one of THOSE files (never in canonical) is neither
 * disabled nor known here, so it can still reach the bot unnarrowed. Omission
 * of a canonical name is NOT narrowing — an unmentioned homedir server still
 * loads.
 *
 * Crow servers are never copied out of the homedir file; they are derived
 * per-instance by crow-server-catalog.mjs. See
 * the private engineering notes
 *
 * Also exports probeServerTools(): a dependency-free MCP stdio `tools/list`
 * (initialize -> notifications/initialized -> tools/list) reusing the
 * same stdio wire plumbing — this is the authoritative GUI tool-picker data
 * source (plan §5: pi's effective mcp.json + a LIVE per-server tools/list, NOT
 * getProxyStatus()). Each tool is flagged `hasPattern` if its inputSchema
 * contains a `pattern`/regex anywhere (drives the Phase-2.3 SOFT-WARN; S4
 * proved the crow-chat --jinja regex scar does NOT reproduce under pi).
 */
import { resolveAddonCommand, checkLauncherArgs } from "../../servers/shared/resolve-command.js";
import { buildBotBaseEnv } from "../../servers/shared/bot-env.js";
import { withoutLoaderEnv } from "../../servers/shared/loader-env.js";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { botsDbPath } from "./instance-paths.mjs";
import { mintRemoteBlocks } from "./remote-blocks.mjs";
import { crowServerCatalog, instanceBinding, rebindBlock, SECRETS_SERVER, addonKeychainNeeds, withoutKeychainValues } from "./crow-server-catalog.mjs";
import { mcpConfigDelivery } from "./mcp-delivery.mjs";
import { applyActorEnv, actorEnvFor } from "./actor-env.mjs";
import { signMailDraftActor } from "./actor-sig.mjs";
// Task 2.2: the ONLY place on the bot-config path that unseals — and only for an fd turn.
// readAddonSecretsSync is all-or-throw (a name with no active row is ROWS_MISSING), so it is
// never handed another add-on's shared names: those are read through their OWN entry.
import { AddonKeysUnavailableError, ADDON_SECRET_SHARES, keychainEnvNames, readAddonSecretsSync, sharedAddonEnv } from "../../servers/shared/addon-secrets.js";
// The anchored secrets dir (700, fd-anchored): the keychain key is read through it, exactly as
// the bot engine's values collector does, so a plantable path is never followed.
import { anchoredPath } from "../../servers/shared/secret-values.js";
// A service add-on's derived env (Render's AUTH_HEADER) must be rendered from the values the
// child will actually get — the unsealed ones — not from the stripped plaintext (Task 2.1).
import { addonDerivedEnv } from "../../servers/gateway/services/legacy-sources.js";

const HOME = process.env.HOME || homedir();
export const CANONICAL_MCP_PATH = HOME + "/.pi/agent/mcp.json";

export function readCanonicalMcp(path = CANONICAL_MCP_PATH) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    // The errno travels on the error (`ENOENT`, `EACCES`, …). A caller that
    // renders to the operator needs it: a FRESH install has no mcp.json at all,
    // which is a normal state ("no tools yet"), not a failure to report (audit
    // N5-4). The message is unchanged for every existing reader.
    const err = new Error("cannot read canonical mcp.json at " + path + ": " + e.message);
    err.code = e.code || "EREAD";
    throw err;
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    const err = new Error("canonical mcp.json is not valid JSON: " + e.message);
    err.code = "EJSON";
    throw err;
  }
  if (!j || typeof j.mcpServers !== "object" || !j.mcpServers) {
    const err = new Error("canonical mcp.json has no mcpServers object");
    err.code = "ESHAPE";
    throw err;
  }
  return j;
}

/** Distinct MCP server names a bot references via def.tools.crow_mcp. */
export function serversForBot(def) {
  const sel = (def && def.tools && def.tools.crow_mcp) || [];
  const set = new Set();
  for (const entry of sel) {
    if (typeof entry !== "string" || !entry) continue;
    // "server/tool" -> "server"; a bare "server" -> "server"
    set.add(entry.split("/")[0]);
  }
  return [...set];
}

// Credential card (spec §10.2): crow_request_secret is "granted with the browser or Workspace
// tools". A def that selects any of these servers also gets the secrets server (it stays
// selectable on its own too, as `crow-secrets/crow_request_secret`). The browser is the canonical
// `crow-browser` or its add-on id `browser`; Workspace is the Crow Workspace bundle (`workspace`)
// and the Google Workspace server (`google-workspace`).
export const SECRETS_GRANTING_SERVERS = Object.freeze(["crow-browser", "browser", "workspace", "google-workspace"]);

/** The servers a def's selection implies (today only the secrets server; see above). */
export function impliedServers(def) {
  const sel = new Set(serversForBot(def));
  return SECRETS_GRANTING_SERVERS.some((n) => sel.has(n)) ? [SECRETS_SERVER] : [];
}

// ---- Crow Mail's drafting turn (plan 3, Task 8b) ----------------------------
//
// A drafting turn is not a channel turn: it gets three tools and ONE MCP server, and that server is
// this instance's own `/mail-draft/mcp` mount, reached with a per-turn `mdt_` token and a
// `mail-draft` actor signature (servers/gateway/mail-draft-mcp.js). Nothing else is in its config —
// no bot's selected servers, no implied secrets block, no service, satellite, extension or remote
// block — so a pi spawned for a drafting turn never starts a credential-bearing child it could not
// call anyway.
//
// The three names are the whole surface, and they exist only for this spawn: `toolAllowlist` never
// builds them, and `buildToolsCsv` takes them through the separate `exactTools` option.

/** The block name pi-lab turns into `mcp__<name>__<tool>`, and the single server of a drafting turn. */
export const MAIL_DRAFT_SERVER = "crow-mail-draft";

/** The three names, in the code-unit order `buildToolsCsv`'s canonical ordering uses. */
export const DRAFTING_TURN_TOOLS = Object.freeze([
  `mcp__${MAIL_DRAFT_SERVER}__mail_draft_propose`,
  `mcp__${MAIL_DRAFT_SERVER}__mail_draft_read_context`,
  `mcp__${MAIL_DRAFT_SERVER}__mail_draft_read_thread`,
]);

/**
 * Is `value` exactly the drafting tool set — the same three names, no more and no less? Order does not
 * matter: both sides are compared sorted, so an added name, a missing one, a renamed one or a repeat
 * (which must drop one of the three) is refused. The bridge refuses anything else before a turn starts.
 */
export function isDraftingTurnTools(value) {
  if (!Array.isArray(value) || value.length !== DRAFTING_TURN_TOOLS.length) return false;
  const got = [];
  for (const name of value) {
    if (typeof name !== "string") return false;
    got.push(name);
  }
  const want = [...DRAFTING_TURN_TOOLS].sort();
  got.sort();
  return got.every((name, at) => name === want[at]);
}

const MAIL_DRAFT_TURN_TOKEN_RE = /^mdt_[0-9a-f]{64}$/;
/** An id half of the actor tuple: non-empty, and neither whitespace nor a colon (actor-sig.mjs). */
const MAIL_DRAFT_ID_RE = /^[^\s:]+$/;

/**
 * The folder under `<CROW_HOME>` that holds a drafting turn's world roots: one directory per bot,
 * then one per draft. It is NOT under a bot's world root, because a bot can write there.
 */
export const MAIL_DRAFT_TURNS_DIRNAME = "mail-draft-turns";

/**
 * One path segment of a drafting turn's own directory: a leading letter or digit (so `..` and a
 * hidden name are refused) and then only characters that cannot be a separator. `/` and `\` are
 * outside it by construction, so neither id can move the turn's world root anywhere else.
 */
export const MAIL_DRAFT_DIR_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Is `value` usable as one half of `<CROW_HOME>/mail-draft-turns/<botId>/<draftId>`? */
export function isMailDraftDirSegment(value) {
  return typeof value === "string" && MAIL_DRAFT_DIR_SEGMENT_RE.test(value);
}

/**
 * The ONE path a drafting turn's world root may be: `<CROW_HOME>/mail-draft-turns/<botId>/<draftId>`.
 * `null` when either id cannot be one path segment or no home was resolved — the caller refuses.
 * turn.js builds its dir with this and bridge.mjs checks the sessionDir it is handed against it, so
 * the two cannot drift into two different paths.
 */
export function mailDraftTurnDir(crowHome, botId, draftId) {
  if (typeof crowHome !== "string" || crowHome === "") return null;
  if (!isMailDraftDirSegment(botId) || !isMailDraftDirSegment(draftId)) return null;
  return join(crowHome, MAIL_DRAFT_TURNS_DIRNAME, botId, draftId);
}

/** `p` with the links of its deepest existing ancestor resolved (a path that does not exist yet stays a path). */
function realHomePath(p) {
  let cur = resolve(p);
  const rest = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

/**
 * The ONE path a drafting turn's world root may be, with the home's links resolved:
 * `<realpath(CROW_HOME)>/mail-draft-turns/<botId>/<draftId>`.
 *
 * A Crow home linked onto another disk is a supported layout, and so is a link on an ancestor of it.
 * The turn's dirs are therefore created at the home's REAL path — every directory below it is checked
 * for being its own real path — so the expected path has to be built from that same real path. Built
 * from the unresolved home instead, the two disagree on a linked install and every drafting turn is
 * refused. turn.js and bridge.mjs both take the path from here, so they cannot drift again.
 *
 * @param {string|null|undefined} crowHome this instance's home (default: the resolved CROW_HOME)
 * @param {string} botId the bot the turn runs as
 * @param {string} draftId the draft the turn is for
 * @returns {string|null} null when the home or an id cannot be one path segment
 */
export function resolvedMailDraftTurnDir(crowHome, botId, draftId) {
  const home = crowHome == null ? resolveCrowHome() : crowHome;
  if (typeof home !== "string" || home === "") return null;
  return mailDraftTurnDir(realHomePath(home), botId, draftId);
}

/**
 * The `crow-mail-draft` block for one drafting turn: this instance's gateway, the turn's own bearer,
 * and the actor headers the mount verifies. The signature is made HERE, in this process — the same
 * way the board entry gets its own (crow-server-catalog.mjs) — so the caller must be a process that
 * holds the gateway's per-boot actor key (`initGatewayActorKey`). A process without it gets a
 * refusal, never an unsigned block: an unsigned block would only fail at the mount, after a spawn.
 *
 * @param {{botId: string, draftId: string, turnId: string, token: string, port?: number|string}} opts
 * @returns {{url: string, headers: Record<string, string>}}
 */
export function mailDraftBlock({ botId, draftId, turnId, token, port } = {}) {
  const id = (value, field) => {
    const text = value == null ? "" : String(value);
    if (!MAIL_DRAFT_ID_RE.test(text)) throw new TypeError(`mailDraftBlock needs a ${field}`);
    return text;
  };
  const bot = id(botId, "botId");
  const draft = id(draftId, "draftId");
  const turn = id(turnId, "turnId");
  const bearer = token == null ? "" : String(token);
  if (!MAIL_DRAFT_TURN_TOKEN_RE.test(bearer)) throw new TypeError("mailDraftBlock needs a turn token (mdt_ and 32 bytes as hex)");
  const sig = signMailDraftActor({ botId: bot, draftId: draft, turnId: turn });
  if (!sig) throw new Error("mailDraftBlock: this process holds no actor key, so the drafting turn's block cannot be signed");
  // The same loopback-gateway convention as the board entry (crow-server-catalog.mjs).
  const gatewayPort = Number(port || process.env.CROW_GATEWAY_PORT || 3001);
  if (!Number.isInteger(gatewayPort) || gatewayPort <= 0 || gatewayPort > 65535) throw new TypeError("mailDraftBlock needs a gateway port");
  return {
    url: `http://127.0.0.1:${gatewayPort}/mail-draft/mcp`,
    headers: {
      Authorization: "Bearer " + bearer,
      "X-Crow-Actor-Kind": "mail-draft",
      "X-Crow-Actor-Id": bot,
      "X-Crow-Actor-Sig": sig,
    },
  };
}

/**
 * The WHOLE config a drafting turn hands pi: this box's `/mail-draft/mcp` and nothing else ACTIVE.
 *
 * pi-lab's mcp-client loads the operator's global `~/.pi/agent/mcp.json` in BOTH delivery modes, so a
 * config that merely omits the operator's servers would still start every one of them as a child of
 * a turn that must have exactly one server. A normal bot config answers that by disabling every
 * unselected canonical name (buildBotMcp's closed-world pass); this one runs the same pass with an
 * empty selection, so the only enabled block is the turn's own.
 *
 * @param {{url: string, headers: Record<string, string>}} block mailDraftBlock's result
 * @returns {{mcpServers: Record<string, object>}}
 */
export function draftingTurnMcpConfig(block, { canonical, canonicalPath } = {}) {
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    throw new TypeError("draftingTurnMcpConfig needs the turn's server block");
  }
  const canon = canonical || canonicalOrEmpty(canonicalPath);
  const out = { mcpServers: {} };
  forEachUnselectedServer(canon, new Set([MAIL_DRAFT_SERVER]), (name) => { out.mcpServers[name] = { disabled: true }; });
  // Set last, so the turn's own server is enabled even if the global file happens to name it.
  out.mcpServers[MAIL_DRAFT_SERVER] = { ...block };
  return out;
}

// The gateway mounts that serve the project tools with a gateway token's authority: routes/mcp.js
// treats a valid local MCP token as the owner, and a url block gets no actor env, so a bot handed
// one of these would act as the owner. Each mount (mountMcpServer) answers on <prefix>/mcp,
// <prefix>/sse and <prefix>/messages; the prefixes are /router, /projects, /research, /memory,
// /sharing, /storage, /blog-mcp, /wm, /tools and /tools-<name> (servers/gateway/boot/mcp-mounts.js
// for the first group, boot/feature-mounts.js for /storage, /blog-mcp and /wm). These paths exist
// only on Crow gateways (any host, any scheme: loopback, LAN, a Serve HTTPS front); legitimate peer
// access goes through stdio crow-remote-proxy blocks. Board/secrets/phone/artifacts mounts carry
// signed actor headers instead, so they are deliberately absent here. /memory and /storage too: a
// bot reaching them with the gateway token would run as an unknown caller (e.g. able to change the
// operator's writing rules, or read every project's files). /sharing and /wm reach the operator's
// contacts and the window manager the same way. The gateway's root /mcp is matched only on a
// loopback host (isOwnerProjectUrl): `/mcp` is the ordinary path of third-party remote MCP servers.
// The gateway reached by a tailnet or LAN name at its root is a known limit until bot containment
// keeps the gateway token from bots.
const OWNER_MOUNT_PATH = /^\/(router|projects|research|memory|sharing|storage|blog-mcp|wm|tools(-[a-z0-9-]+)?)\/(mcp|sse|messages)$/;

/** True if a url block reaches a Crow gateway's owner-capable mounts. */
export function isOwnerProjectUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { return false; } // new URL resolves dot segments
  let path;
  try { path = decodeURIComponent(u.pathname); } catch { return true; } // undecodable: refuse it
  path = path.toLowerCase().replace(/\/+$/, "");
  if (OWNER_MOUNT_PATH.test(path)) return true;
  // The gateway's root mount (/mcp, /sse, /messages) on THIS box: a loopback host can only be
  // the local gateway or something the operator runs here, never a third-party remote server.
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = host === "localhost" || host === "::1" || /^127\./.test(host) || host === "0.0.0.0";
  return loopback && /^\/(mcp|sse|messages)$/.test(path);
}

/** True if a server block touches crow.db (so the journal guard applies). */
function touchesCrowDb(block) {
  return !!(block && block.env && block.env.CROW_DB_PATH);
}

/**
 * The bot identity a writer call carries, in ONE shape. The two call styles differ —
 * `buildBotMcp` takes `opts.actor` ({botId, displayName, threadId}), `writeBotMcp` takes the flat
 * `opts.botId`/`displayName`/`threadId` — so a caller that passes either (or `buildBotMcp` with
 * only `opts.botId`) still gets the actor. A flat id wins when both are given. null when the call
 * names no bot (a caller that predates the actor plumbing stays byte-identical).
 */
function actorOf(opts = {}) {
  const nested = opts.actor && typeof opts.actor === "object" ? opts.actor : null;
  const botId = opts.botId || (nested && nested.botId) || null;
  if (!botId) return null;
  const pick = (flat, fromNested) => (flat !== undefined ? flat : (fromNested === undefined ? undefined : fromNested));
  return {
    botId: String(botId),
    displayName: pick(opts.displayName, nested ? nested.displayName : undefined),
    threadId: pick(opts.threadId, nested ? nested.threadId : undefined),
  };
}

/** Reported instead of a remote-proxy block while the bot holds a live project share. */
const REMOTE_SHARE_OFF_WARNING = "remote tools are off while this bot holds a project share";

/** Keys that name WHO the caller is: an actor env or the engine-reserved bot-session marker. */
const ACTOR_ENV_NAME = /^CROW_ACTOR_/;
const ENGINE_ACTOR_KEYS = new Set(["CROW_BOT_SESSION"]);

/** True for a name a block must not set: it would let a file choose the caller's identity. */
function isActorEnvName(key) {
  return ACTOR_ENV_NAME.test(String(key)) || ENGINE_ACTOR_KEYS.has(String(key));
}

/**
 * Strip every actor-identity name from every block's env (replacing, never mutating, a block).
 * A block's env is laid OVER the env the child inherits from pi (pi-lab's mcp-client), so a value
 * left in a block would win over the one the engine wrote into pi's own env: a canonical file
 * generated for the owner (CROW_ACTOR_KIND=owner), a hand-edited block naming another bot, or a
 * CROW_BOT_SESSION marker would otherwise let a file choose whose scope a bot runs with.
 */
function stripActorEnv(mcpServers) {
  for (const [name, block] of Object.entries(mcpServers || {})) {
    if (!block || typeof block !== "object" || !block.env || typeof block.env !== "object") continue;
    const env = Object.fromEntries(Object.entries(block.env).filter(([k]) => !isActorEnvName(k)));
    if (Object.keys(env).length === Object.keys(block.env).length) continue;
    mcpServers[name] = { ...block, env };
  }
}

// ---- A5: extension addon servers -> minted per-bot pi blocks ---------------
/**
 * This instance's peer-relay token, read here (outside the pi sandbox): its
 * file is in <crowHome>/secrets, which the sandbox hides from pi and every
 * child it spawns, the remote proxy included. Empty when not minted yet.
 */
function readRelayToken(crowHome) {
  try { return readFileSync(join(crowHome, "secrets", "peer-relay-token"), "utf8").trim(); } catch { return ""; }
}

// A bot may select an MCP server that lives in <crowHome>/mcp-addons.json but
// is ABSENT from the canonical ~/.pi/agent/mcp.json (e.g. texas-gov-data,
// bots-sql-mcp, tasks on MPA). pi-lab's additive merge (CONFIRMED against the
// installed v0.74.2 and re-verified on v0.82.0 (2026-07-25 probe run): extensions/mcp-client.ts reverses the path list so homedir
// is Object.assign'd LAST and wins on key collision; the per-bot sessionDir
// /.mcp.json is a cwd-self entry and is the SOLE source for absent-from-homedir
// servers) means we can safely ADD such servers in the per-bot file — never
// mutating the canonical homedir config. We mint a pi-compatible block from the
// addon block, defaulting cwd exactly as the gateway proxy and pi-lab require.
//
// kept local (no ext_registry import) so the lower-level writer has no cycle.
const _HOME_FOR_CROW = HOME;
function resolveCrowHome() {
  return process.env.CROW_HOME || _HOME_FOR_CROW + "/.crow";
}
function readAddons(crowHome) {
  try {
    return JSON.parse(readFileSync(join(crowHome, "mcp-addons.json"), "utf8")) || {};
  } catch {
    return {};
  }
}
/**
 * Default an addon block's cwd the SAME way the gateway proxy does
 * (proxy.js:197) and pi-lab requires (mcp-client spawns `cwd: cfg.cwd` with NO
 * default — a cwd-less addon would run `node server/index.js` from the bot's
 * sessionDir and MODULE_NOT_FOUND). Returns a shallow copy with cwd filled.
 */
function addonSpawnBlock(serverId, block, crowHome) {
  // The launcher is resolved and verified (servers/shared/resolve-command.js);
  // one that fails is OMITTED — never passed on for a PATH lookup.
  const cwd = block.cwd || join(crowHome, "bundles", serverId);
  const rc = resolveAddonCommand(block.command, { sha256: block.command_sha256, cwd });
  const argProblem = rc.missing ? null : checkLauncherArgs(rc.command, block.args);
  if (rc.missing || argProblem) {
    console.warn(`[pi-bots] add-on '${serverId}' omitted: ${rc.reason || argProblem}`);
    return null;
  }
  // `keychainEnv` lists NAMES whose values live in the keychain, and is not part of a spawn
  // block: no bot's .mcp.json may carry it, and no value is produced HERE. The block this
  // function mints is key-less by construction; the values are owed back as `needsKeys` and
  // only writeBotMcp's fd-only `addonKeys: "hydrate"` turn unseals them (see below).
  const { command_sha256: _pin, keychainEnv: _keychainEnv, env: entryEnv, ...rest } = block;
  // The entry's env is handed to the child as-is EXCEPT loader/injection names
  // (NODE_OPTIONS, LD_PRELOAD, …): those run code before the server itself does — and except
  // a sealed name's plain value, which is stale by definition (the keychain value wins).
  // A block with no env stays without one. `env` is taken OUT of `rest` above, so an emptied
  // env cannot survive by not being overridden.
  const kept = withoutKeychainValues(block, entryEnv);
  // A block whose env held ONLY sealed names has nothing left to pass: it must not gain an
  // empty `env` object the entry never had.
  const emptied = kept && typeof kept === "object" && kept !== entryEnv && Object.keys(kept).length === 0;
  const env = kept && typeof kept === "object" && !emptied ? { env: withoutLoaderEnv(kept) } : {};
  // The pin rides along so pi-lab re-verifies it at spawn time.
  return { ...rest, ...env, ...(rc.resolved ? { command: rc.command } : {}), ...(rc.sha256 ? { command_sha256: rc.sha256 } : {}),
    cwd };
}

/**
 * Mint pi-compatible blocks for the bot's selected servers that are ABSENT from
 * canonical but present in <crowHome>/mcp-addons.json. Returns
 * `{ servers, needsKeys }`: a `{name: block}` map (cwd defaulted; the journal
 * guard is applied later by buildBotMcp on the clone) plus, per sealed add-on,
 * the env NAMES it owes the keychain (values are never read here). Servers absent
 * from BOTH canonical and addons are left out so buildBotMcp surfaces them as a
 * warning.
 *
 * @param {object} opts.canonical  pre-read canonical (avoids a second read)
 */
export function extraServersFromExtensions(def, crowHome = resolveCrowHome(), opts = {}) {
  const want = serversForBot(def);
  const canonical = opts.canonical || readCanonicalMcp(opts.canonicalPath);
  const addons = readAddons(crowHome);
  const servers = {};
  const needsKeys = {};
  for (const name of want) {
    // The catalog (crow-server-catalog.mjs) already covers every Crow server on
    // this instance and is consulted first by buildBotMcp, so this path only
    // ever fills a NON-Crow name absent from canonical. Kept as a seam for
    // callers that pass their own canonical without a catalog.
    if (canonical.mcpServers[name]) continue;
    const addon = addons[name];
    if (!addon) continue; // absent from both -> buildBotMcp warns
    // A satellite-hosted bundle's tools arrive through crow's satellite entry, never through a pi
    // MCP block on this host (spec §9.1). Part 2 of SAT-7 adds the bot mount.
    if (addon.transport === "satellite") continue;
    const blk = addonSpawnBlock(name, addon, crowHome);
    if (!blk) continue;
    servers[name] = blk;
    const needs = addonKeychainNeeds(name, addon, { addons });
    if (needs.length > 0) needsKeys[name] = needs;
  }
  return { servers, needsKeys };
}

/**
 * The closed-world pass both configs below make: every name in the canonical (global) file that this
 * one does not select is offered to `fn`. pi-lab's mcp-client loads `~/.pi/agent/mcp.json` itself, in
 * BOTH delivery modes, so a per-turn file that simply omits a server does not stop it from starting.
 * Sorted, so a written config is diffable.
 */
function forEachUnselectedServer(canonical, selected, fn) {
  for (const name of Object.keys((canonical && canonical.mcpServers) || {}).sort()) {
    if (selected.has(name)) continue;
    fn(name);
  }
}

/**
 * The canonical file's names, or none when there is no file at all.
 *
 * Only `ENOENT` may mean "no global servers": a fresh install has no `~/.pi/agent/mcp.json`, and that
 * is a normal state. Any other read or parse failure (EACCES, a directory in its place, invalid JSON,
 * a wrong shape) means this process does not know which servers pi would inherit from that file, so a
 * config that only disables the names it could read would let the rest start as children of a turn
 * that must have exactly one server. It throws instead, and the drafting turn is refused before a
 * spawn.
 */
function canonicalOrEmpty(canonicalPath) {
  try {
    return readCanonicalMcp(canonicalPath);
  } catch (err) {
    if (err && err.code === "ENOENT") return { mcpServers: {} };
    throw err;
  }
}

/**
 * Build the per-bot `.mcp.json` object. CLOSED-WORLD — see the file header.
 *
 * Resolution order for a selected name:
 *   1. catalog   — instance-derived, always correct. Wins.
 *   2. canonical — for names the catalog does not know (third-party servers,
 *                  crow-browser). Rebound onto this instance as a belt.
 *   3. extraServers — the mcp-addons seam retained for callers without a catalog.
 * Then every OTHER canonical name is emitted as {"disabled": true}, because
 * canonical is exactly what pi would otherwise inherit.
 *
 * @returns {{ json, servers, warnings, journalGuarded, minted, rebound, disabled }}
 *   `servers` lists ACTIVE names only; disabled names are in `disabled`.
 */
export function buildBotMcp(def, canonical, opts = {}) {
  // opts.ensureServers (Track 3 acceptance F2): names unioned into the
  // selection BEFORE catalog resolution, so a card-bound session gets the
  // board entry (it must be able to call board_report_result — that call is
  // what ends the run) even when the def never selected board/*. An ensured
  // name absent from the catalog rides the same unconfigured/soft-warning
  // path as a selected-but-absent server.
  const ensure = (opts.ensureServers || []).filter((n) => typeof n === "string" && n);
  const catalog = opts.catalog || {};
  // An IMPLIED name (impliedServers) joins only when the catalog has it: unlike an explicit or
  // ensured name it never warns (an instance without the secrets token just doesn't offer it).
  // Only for an interactive (Perch) spawn, the same gate as bridge.mjs buildToolsCsv: a channel
  // or job bot could never use crow_request_secret, so it gets no entry at all.
  const implied = opts.interactive === true ? impliedServers(def).filter((n) => catalog[n]) : [];
  const want = [...new Set([...serversForBot(def), ...ensure, ...implied])];
  const unconfigured = opts.unconfigured || {};
  const binding = opts.binding;
  const crowHome = opts.crowHome;
  const extra = opts.extraServers || {};
  const out = { mcpServers: {} };
  const warnings = [];
  const journalGuarded = [];
  const minted = [];
  const rebound = [];
  const disabled = [];
  const active = [];

  const disable = (name, reason) => {
    out.mcpServers[name] = { disabled: true };
    disabled.push(name);
    if (reason) warnings.push(`server '${name}' ${reason}`);
  };

  // `minted` keeps its A5 meaning: resolved from somewhere canonical does NOT
  // have it. A core server present in BOTH the catalog and canonical is not
  // minted — logging it as "minted from extensions" would be false on the
  // commonest path (bot-world.mjs and the regen message both print this).
  const noteMinted = (name) => { if (!canonical.mcpServers[name]) minted.push(name); };
  // `journalGuarded` exists to make the WAL-unlink guard OBSERVABLE, so it
  // reports every active crow.db server carrying the guard — uniformly, on
  // whichever path resolved it. Reporting only the blocks this function
  // happened to flip would hide the catalog path, which is now the common one.
  const noteGuard = (name, block) => { if (touchesCrowDb(block)) journalGuarded.push(name); };

  for (const name of want) {
    if (catalog[name]) {
      out.mcpServers[name] = catalog[name];
      active.push(name);
      noteMinted(name);
      noteGuard(name, catalog[name]);
      continue;
    }
    if (unconfigured[name]) {
      disable(name, unconfigured[name]);
      continue;
    }
    const source = canonical.mcpServers[name] || extra[name];
    if (!source) {
      warnings.push(
        "server '" + name + "' is selected but absent from the instance catalog, " +
        "canonical mcp.json AND mcp-addons.json — pi will NOT have it"
      );
      continue;
    }
    // No binding means a caller that predates instance binding (tests, CLI):
    // fall back to the old verbatim copy + journal guard rather than crash.
    if (!binding) {
      const clone = JSON.parse(JSON.stringify(source));
      if (touchesCrowDb(clone)) {
        clone.env = clone.env || {};
        if (clone.env.CROW_JOURNAL_MODE !== "DELETE") {
          clone.env.CROW_JOURNAL_MODE = "DELETE";
          journalGuarded.push(name);
        }
      }
      out.mcpServers[name] = clone;
      active.push(name);
      noteMinted(name);
      continue;
    }
    const r = rebindBlock(name, source, binding, crowHome);
    if (r.disabled) {
      disable(name, r.reason);
      continue;
    }
    if (r.rebound.length) rebound.push({ name, keys: r.rebound });
    noteGuard(name, r.block);
    out.mcpServers[name] = r.block;
    active.push(name);
    noteMinted(name);
  }

  // Closed-world. Sorted so the written file is diffable.
  forEachUnselectedServer(canonical, new Set(want), (name) => disable(name, null));

  // A bot must never reach the project tools through a gateway mount (a gateway token is the owner).
  for (const name of [...active]) {
    const block = out.mcpServers[name];
    if (block && block.url && isOwnerProjectUrl(block.url)) {
      disable(name, "was disabled: a bot must not reach the operator's research tools with a gateway token (owner authority)");
      active.splice(active.indexOf(name), 1);
      for (const list of [journalGuarded, minted]) {
        const i = list.indexOf(name);
        if (i >= 0) list.splice(i, 1);
      }
    }
  }

  // A canonical file generated for the owner (scripts/generate-mcp-config.js) marks its project
  // server CROW_ACTOR_KIND=owner; a bot must never inherit that — nor any other actor name a block
  // carries (another bot's id, the engine's bot-session marker). Stripped BEFORE applyActorEnv
  // below, which then writes this turn's actor onto every stdio block.
  stripActorEnv(out.mcpServers);

  const actor = actorOf(opts);
  if (actor) applyActorEnv(out.mcpServers, actorEnvFor(actor));

  return { json: out, servers: active, warnings, journalGuarded, minted, rebound, disabled };
}

/**
 * S6-CROW: remove a file-mode `.mcp.json` left behind, once it is older than
 * a grace age. The grace exists because delivery mode is chosen per process:
 * a file-mode process may have JUST written this file for a pi that has not
 * read it yet (warmModel can take tens of seconds), and an fd-mode turn or a
 * Bot Builder save for the same bot must not pull it out from under that pi.
 * Signatures are per gateway boot, so a stale file outlives its value at the
 * next restart anyway. Returns true when a file was removed.
 */
export const STALE_MCP_GRACE_MS = 10 * 60 * 1000;
export function removeStaleBotMcp(path, graceMs = STALE_MCP_GRACE_MS) {
  try {
    const st = statSync(path);
    if (Date.now() - st.mtimeMs < graceMs) return false;
    unlinkSync(path);
    return true;
  } catch { return false; }
}

/**
 * The two sentences a sealed add-on's block is reported with when it cannot be hydrated.
 * Both carry the add-on ID and nothing else — never a value, never a fragment of one.
 */
export const WARN_ADDON_KEYS_FILE_MODE = (id) =>
  `add-on ${id}: its keys are in the keychain and file-mode MCP delivery cannot carry them; the add-on is left out`;
export const WARN_ADDON_KEYS_UNREADABLE = (id) =>
  `add-on ${id}: its saved keys could not be read; left out of this turn`;

// ---- the shared-settings table: one frozen table, no production override -----
/**
 * The table add-on shares are hydrated from (ADDON_SECRET_SHARES). It is NOT a writeBotMcp
 * option: the share switch is a code change in servers/shared/addon-secrets.js, so a caller
 * (a bridge, a panel, a CLI) must not be able to point a bot at a different add-on's keys.
 * Tests that need a different table set it here and set it back.
 */
let addonSecretSharesTable = ADDON_SECRET_SHARES;

/** TEST ONLY: replace the share table for the rest of this process; returns the previous one. */
export function _setAddonSecretSharesForTest(table) {
  const prev = addonSecretSharesTable;
  addonSecretSharesTable = table && typeof table === "object" ? table : ADDON_SECRET_SHARES;
  return prev;
}

/**
 * Is `crowHome` the instance THIS process resolves its DB and keychain key from?
 *
 * writeBotMcp reads the add-on entries from `crowHome` (opts.crowHome, or CROW_HOME, or
 * ~/.crow), but botsDbPath() and anchoredPath() resolve from the process env. When the two
 * name different instances, hydrating would read THIS process's keychain rows for ANOTHER
 * instance's entries — and anchoring would create a secrets dir under the wrong home. The
 * hydrate step therefore refuses in that case (WARN_ADDON_KEYS_UNREADABLE, add-on dropped);
 * compare the resolved paths, since `~/.crow` and a trailing slash name the same home.
 */
export function addonUnsealInstanceMatches(crowHome, env = process.env) {
  if (typeof crowHome !== "string" || crowHome === "") return false;
  const envHome = (env && env.CROW_HOME) || _HOME_FOR_CROW + "/.crow";
  return resolve(crowHome) === resolve(envHome);
}

/**
 * The boot line the bot engine logs ONCE when the secrets dir cannot be anchored (unsafe
 * ancestors while CROW_BOT_UID is set): every unseal then fails closed, so a sealed add-on is
 * left out of every bot turn. Fixed sentence, no path, no value.
 */
export const ADDON_KEYS_BOT_UNAVAILABLE =
  "[addon-secrets] bots cannot read add-on keys: the secrets folder is not safe for the bot user; sealed add-ons are left out of bot turns";

/**
 * Bot-engine startup check: log ADDON_KEYS_BOT_UNAVAILABLE when the keychain key cannot be
 * reached through the anchored secrets dir (anchoredPath returns null: the ancestors are not
 * safe for the bot uid, so every read fails closed). Returns true when it logged. `anchor` is
 * the seam (the real anchoredPath by default); it is the same call the hydrate step makes, so
 * a null here means the hydrate step will drop sealed add-ons too.
 */
export function warnIfAddonKeysUnanchorable(log = (m) => console.warn(m), { env = process.env, anchor = anchoredPath } = {}) {
  let path = null;
  try { path = anchor(env, "keychain.key"); } catch { path = null; }
  if (path) return false;
  log(ADDON_KEYS_BOT_UNAVAILABLE);
  return true;
}

/**
 * Write `<session_dir>/.mcp.json` for a bot. Idempotent (full rewrite each
 * call). Throws only on a missing session_dir in the def or an unreadable
 * canonical; a selected-but-absent server is a soft warning (returned).
 *
 * M3b: callers may override session_dir via opts.sessionDir — the bridge
 * uses this when a project_space workspace resolves to a different path
 * than the legacy def.session_dir. Without the override, mcp.json drifts
 * out of sync with the actual pi cwd and the bot relies solely on the
 * canonical ~/.pi/agent/mcp.json fallback.
 *
 * Task 2.2: `opts.addonKeys` is "omit" (default — a sealed add-on's block stays key-less) or
 * "hydrate" (unseal its keychain values into the returned config; FD DELIVERY ONLY, so it
 * throws when combined with a file write). A file-mode turn leaves a sealed add-on out of the
 * config entirely, with one warning: a file cannot carry its keys, and a key-less spawn would
 * fail later instead. Hydration reads the same instance the entries came from or nothing: a
 * `crowHome` that is not this process's CROW_HOME drops the add-on (WARN_ADDON_KEYS_UNREADABLE).
 * The ADDON_SECRET_SHARES table is NOT an option (see _setAddonSecretSharesForTest).
 */
export function writeBotMcp(def, opts = {}) {
  const sessionDir = opts.sessionDir || (def && def.session_dir);
  if (!sessionDir) throw new Error("bot def has no session_dir (and no opts.sessionDir override)");
  const canonical = opts.canonical || readCanonicalMcp(opts.canonicalPath);
  // A5: resolve the active instance + mint addon blocks for selected servers
  // absent from canonical. opts.crowHome lets the bridge/GUI/CLI pin the
  // instance explicitly; otherwise CROW_HOME env (MPA service) or ~/.crow.
  const crowHome = opts.crowHome || resolveCrowHome();
  // Both sources report the env names a sealed add-on owes the keychain (`needsKeys`). The
  // build itself never produces a value — it only keeps stale plaintext out of the block (see
  // addonSpawnBlock); the fd-only "hydrate" turn below is the ONE place in this file that
  // unseals them. A caller-supplied opts.extraServers map is trusted verbatim and carries no
  // needsKeys (the CLI/test seam: nothing is ever unsealed on its behalf).
  const extra = opts.extraServers
    ? { servers: opts.extraServers, needsKeys: {} }
    : extraServersFromExtensions(def, crowHome, { canonical });
  // The instance catalog is the FIRST source for any Crow server. opts.binding
  // lets tests and the panel pin an instance without mutating process.env.
  const binding = opts.binding || instanceBinding(crowHome, opts);
  // botId/jobId (Track 1 Task 7): threaded into the catalog's board entry so
  // its X-Crow-Actor-Id/X-Crow-Job-Id headers carry THIS turn's identity —
  // see crow-server-catalog.mjs's boardBlock(). Absent for callers that
  // predate the job_id plumbing (the GUI regen handler, the CLI): the board
  // entry then omits those headers. S5: board-mcp.js's resolveActor honours
  // the headers only with the X-Crow-Actor-Sig the catalog adds when this
  // process holds the actor key; anything else on the board token resolves
  // to an unattributed bot (never 'session').
  const { servers: catalog, unconfigured, needsKeys: catalogNeedsKeys } = crowServerCatalog(crowHome, {
    binding, botId: opts.botId, jobId: opts.jobId, threadId: opts.threadId, gatewayType: opts.gatewayType,
  });
  const built = buildBotMcp(def, canonical, {
    extraServers: extra.servers, catalog, unconfigured, binding, crowHome,
    ensureServers: opts.ensureServers,
    interactive: opts.interactive === true,
    actor: actorOf(opts) || undefined,
  });
  // F4a L2b: merge cross-instance forward-proxy blocks when the caller has
  // confirmed feature_flags.remote_invocation is on (the DB read is done by the
  // caller — bridge/panel/CLI — since this module is DB-agnostic). Default
  // off: callers that don't pass remoteEnabled get byte-identical output.
  //
  // Phase 1 project shares: a bot holding a live share gets NO remote-proxy
  // block. Its relayed calls arrive at the peer as a relayed actor, not as this
  // bot, so the gate there is not the bot's (P2 adds signed identity
  // forwarding). A live share blocks the proxy whether or not it is currently
  // suspended, so a suspension can never be used to regain it; the decision is
  // re-made on EVERY build, so a revoke restores the blocks at the next spawn.
  // opts.holdsShare is false/absent for every caller without the DB at hand,
  // which keeps the flag-off output byte-identical.
  let remoteWarnings = [];
  if (opts.holdsShare) {
    remoteWarnings = [REMOTE_SHARE_OFF_WARNING];
  } else if (opts.remoteEnabled) {
    const node = opts.node || process.execPath;
    const proxyPath = opts.proxyPath || join(import.meta.dirname, "crow-remote-proxy.mjs");
    // Item 46 PR-B: the proxy calls THIS gateway's loopback relay (same port
    // convention as the board block), never the peer, and holds no peer
    // credential. The relay token is this instance's; the actor is this turn's.
    const gatewayPort = opts.gatewayPort || process.env.CROW_GATEWAY_PORT || 3001;
    // opts.sessionId: this turn's bot_sessions.id, which the relay signature
    // binds (actor-sig.mjs v2) and the relay resolves and checks.
    const actor = opts.botId ? { botId: opts.botId, sessionId: opts.sessionId, threadId: opts.threadId, gatewayType: opts.gatewayType } : undefined;
    const { blocks, warnings } = mintRemoteBlocks(def, {
      peerGatewayUrls: opts.peerGatewayUrls || {},
      proxyPath,
      node,
      relayBaseUrl: `http://127.0.0.1:${gatewayPort}`,
      relayToken: readRelayToken(crowHome),
      actor,
    });
    // Like every other stdio block, the proxy carries the bot's actor env.
    const actorEnv = actorOf(opts);
    if (actorEnv) applyActorEnv(blocks, actorEnvFor(actorEnv));
    remoteWarnings = warnings;
    for (const [name, block] of Object.entries(blocks)) built.json.mcpServers[name] = block;
  }
  // ---- Task 2.2: a sealed add-on is hydrated ONLY for an fd turn -------------
  // A sealed add-on's values live in the keychain (Task 2.1's merged `needsKeys` names them).
  // `addonKeys: "hydrate"` unseals them into the IN-MEMORY config the bridge pipes to pi on
  // its inherited fd (mcp-delivery.mjs); `"omit"` (the default) leaves the block key-less, for
  // a caller that only validates. The two never mix with a file: `.mcp.json` is readable by
  // every process that can reach the session dir, so a file-mode turn can never carry a value.
  // Such an add-on is therefore left OUT of the config with one warning, rather than spawned
  // with a partial env that would only fail later.
  const addonKeys = opts.addonKeys === undefined ? "omit" : opts.addonKeys;
  if (addonKeys !== "omit" && addonKeys !== "hydrate") {
    throw new Error('writeBotMcp: opts.addonKeys must be "hydrate" or "omit"');
  }
  const fileMode = opts.write !== false;
  // Internal assertion (see above): a hydrated block carries plaintext, so it must never be
  // written to disk. Stated as a throw rather than a branch so a later refactor cannot make
  // the two coexist silently.
  if (addonKeys === "hydrate" && fileMode) {
    throw new Error('writeBotMcp: addonKeys "hydrate" is fd delivery only (opts.write === false); a hydrated block is never written to .mcp.json');
  }
  const hydratedAddons = new Set();
  // Only an ACTIVE block owes keys: a name the build disabled (unconfigured, owner-authority,
  // forgotten with the closed world) is not in the config, so nothing is left to hydrate.
  const owedKeys = [];
  for (const [name, names] of Object.entries({ ...catalogNeedsKeys, ...extra.needsKeys })) {
    const block = built.json.mcpServers[name];
    if (block && block.disabled !== true && Array.isArray(names) && names.length > 0) owedKeys.push([name, names]);
  }
  if (owedKeys.length > 0) {
    // The unseal paths: the DB this process's bridge/panel resolves, and the keychain key read
    // through the anchored secrets dir (never through a path another principal could plant).
    // botsDbPath() is resolveDbPath()'s file for every layout (pinned by the test) — the SAME
    // rows the gateway sealed, never a second instance's. So they are used ONLY when the
    // entries came from this same instance: `crowHome` is what the blocks were read from, and
    // when it names another home the two disagree — a mismatch fails closed below.
    const sameInstance = addonUnsealInstanceMatches(crowHome);
    let unseal = null;
    const unsealPaths = () => {
      if (!unseal) {
        unseal = { unsealer: "bot-engine", dbPath: botsDbPath(), keyPath: anchoredPath(process.env, "keychain.key") };
      }
      return unseal;
    };
    const addonEntries = readAddons(crowHome);
    // A name this turn drops moves the block into `disabled` and takes its bookkeeping with
    // it: it is not active, so it journals nothing and mints nothing.
    const drop = (name, warning) => {
      built.json.mcpServers[name] = { disabled: true };
      const i = built.servers.indexOf(name);
      if (i >= 0) built.servers.splice(i, 1);
      for (const list of [built.journalGuarded, built.minted]) {
        const j = list.indexOf(name);
        if (j >= 0) list.splice(j, 1);
      }
      if (!built.disabled.includes(name)) built.disabled.push(name);
      built.warnings.push(warning);
    };
    for (const [id, names] of owedKeys) {
      if (fileMode) { drop(id, WARN_ADDON_KEYS_FILE_MODE(id)); continue; }
      if (addonKeys === "omit") continue; // key-less block: the caller only validates it
      if (!sameInstance) { drop(id, WARN_ADDON_KEYS_UNREADABLE(id)); continue; } // never another instance's rows
      try {
        const entry = addonEntries[id];
        const own = keychainEnvNames(entry);
        const secrets = own.length > 0 ? readAddonSecretsSync(id, own, unsealPaths()) : {};
        // Another add-on's settings this one reads (ADDON_SECRET_SHARES, R6): hydrated through
        // the SOURCE's own entry, so its rows are read under its own id, never this one's. The
        // table is the frozen module constant (or a test's replacement) — never a caller option.
        const shared = sharedAddonEnv(id, (sourceId) => addonEntries[sourceId] ?? null, {
          ...unsealPaths(),
          shares: addonSecretSharesTable,
        });
        const block = built.json.mcpServers[id];
        // The derived env is rendered from `{ ...block.env, ...secrets }` — the values the child
        // really gets. Rendering it from the entry's own (stripped) env is what would put a
        // stale plaintext back into the block through Render's `AUTH_HEADER`.
        block.env = {
          ...block.env,
          ...withoutLoaderEnv(secrets),
          ...withoutLoaderEnv(shared),
          ...withoutLoaderEnv(addonDerivedEnv(id, { ...block.env, ...secrets }, undefined, {})),
          CROW_HOME: crowHome,
        };
        hydratedAddons.add(id);
      } catch (err) {
        // Never a value and never a driver message: the fixed sentence plus the add-on id.
        if (!(err instanceof AddonKeysUnavailableError)) throw err;
        drop(id, WARN_ADDON_KEYS_UNREADABLE(id));
      }
    }
  }
  // S6-CROW: opts.write === false is fd delivery (mcp-delivery.mjs) — the
  // config is returned for the bridge to pipe to pi, NOTHING is written, and a
  // stale <sessionDir>/.mcp.json left by an earlier file-mode turn is removed
  // once past the grace age (removeStaleBotMcp; opts.staleGraceMs overrides).
  // Absent/true keeps the file write byte-identical to before.
  const path = join(sessionDir, ".mcp.json");
  let removedStale = false;
  if (opts.write === false) {
    removedStale = removeStaleBotMcp(path, opts.staleGraceMs);
  } else {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(path, JSON.stringify(built.json, null, 2) + "\n", { mode: 0o600 });
  }
  // What is still OWED to a caller: a hydrated block already carries its values, and a block
  // this function disabled is not in the config at all.
  const needsKeys = {};
  for (const [name, names] of Object.entries({ ...catalogNeedsKeys, ...extra.needsKeys })) {
    if (hydratedAddons.has(name)) continue;
    const block = built.json.mcpServers[name];
    if (block && block.disabled !== true && Array.isArray(names) && names.length > 0) needsKeys[name] = names;
  }
  return {
    path: opts.write === false ? null : path,
    json: built.json,
    removedStale,
    needsKeys,
    servers: built.servers,
    warnings: built.warnings,
    journalGuarded: built.journalGuarded,
    minted: built.minted,
    rebound: built.rebound,
    disabled: built.disabled,
    remoteWarnings,
  };
}

// ---- dependency-free MCP stdio tools/list (GUI picker source) -------------

/**
 * True if a tool's `inputSchema` contains a `pattern`/regex ANYWHERE (nested included).
 * Exported because every source of Bot Builder tools must answer `hasPattern` the same
 * way: a sealed add-on's tools come from the gateway's LIVE connection (raw MCP tool
 * objects) instead of this probe, and ext_registry maps them with this.
 */
export function deepHasPattern(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 12) return false;
  if (Object.prototype.hasOwnProperty.call(schema, "pattern")) return true;
  for (const k of Object.keys(schema)) {
    const v = schema[k];
    if (v && typeof v === "object" && deepHasPattern(v, depth + 1)) return true;
  }
  return false;
}

/**
 * MCP tool annotations the Bot Builder uses to sort a source's tools into
 * "only looks" / "changes things" (Read-only mode). Only boolean hints are
 * carried; anything else is left out so the name heuristic decides.
 */
function toolHints(t) {
  const a = (t && t.annotations) || {};
  const out = {};
  if (typeof a.readOnlyHint === "boolean") out.readOnlyHint = a.readOnlyHint;
  if (typeof a.destructiveHint === "boolean") out.destructiveHint = a.destructiveHint;
  return out;
}

/**
 * Live `tools/list` for a URL-based (streamable HTTP) MCP server block.
 * Mirrors the stdio probe's return shape. Never throws.
 */
async function probeHttpServerTools(block, timeoutMs) {
  let client, transport;
  try {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const requestInit = {};
    if (block.headers && typeof block.headers === "object") requestInit.headers = block.headers;
    transport = new StreamableHTTPClientTransport(new URL(block.url), { requestInit });
    client = new Client({ name: "pibot-picker", version: "0" });
    let timer;
    await Promise.race([
      client.connect(transport),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error("connect timeout")), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    const list = await client.listTools();
    const tools = (list && list.tools ? list.tools : []).map((t) => ({
      name: t.name,
      description: (t.description || "").slice(0, 240),
      hasPattern: deepHasPattern(t.inputSchema),
      ...toolHints(t),
    }));
    return { ok: true, serverName: block.url, tools };
  } catch (e) {
    return { ok: false, error: "http probe failed: " + (e.message || String(e)) };
  } finally {
    try { await client?.close(); } catch { /* ignore */ }
    try { await transport?.close(); } catch { /* ignore */ }
  }
}

/**
 * The environment a probe spawns a server block with: what a bot's pi child would
 * really give it — the bot env allowlist (servers/shared/bot-env.js) plus the
 * block's own env, minus loader/injection names — never the gateway's environment
 * this prober runs inside. Under CROW_BOT_ENV_PASSTHROUGH=1 that allowlist is the
 * whole environment minus credential keys, which is exactly what bots get under
 * that switch.
 * The block here may be a raw mcp-addons entry from the Tools tab, not a block
 * run through rebindBlock, so it is stripped here: NODE_OPTIONS --require and
 * LD_PRELOAD would run code before the server itself. withoutLoaderEnv returns a
 * new object and maps a missing env to {}, so an env-less block gains nothing.
 * Exported so a test can judge the env without spawning.
 */
export function probeSpawnEnv(block, source = process.env) {
  return Object.assign({}, buildBotBaseEnv(source), withoutLoaderEnv(block?.env));
}

/**
 * Live `tools/list` for one MCP server block. Handles both stdio servers
 * (command/args/cwd/env exactly as pi-lab/mcp-client would spawn it) and
 * URL-based streamable-HTTP servers. Never throws — returns {ok:false,error}.
 * @returns {Promise<{ok:boolean, serverName?:string, tools?:Array<{name:string,description:string,hasPattern:boolean}>, error?:string}>}
 */
export function probeServerTools(block, opts = {}) {
  const timeoutMs = opts.timeoutMs || 15000;
  // URL-based (streamable HTTP) MCP server — probe over HTTP, never stdio spawn.
  // spawn(undefined) throws "The 'file' argument must be of type string".
  if (block && block.url && !block.command) {
    return probeHttpServerTools(block, timeoutMs);
  }
  // Removed / half-installed addon: its cwd points at a bundle dir that no
  // longer exists, so spawn() would throw ENOENT ("proc error: spawn node
  // ENOENT"). Report it cleanly instead of a cryptic error / 15s hang.
  if (block && block.cwd && !existsSync(block.cwd)) {
    return Promise.resolve({ ok: false, error: "not installed (missing " + block.cwd + ")" });
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
      resolve(r);
    };
    let child;
    try {
      child = spawn(block.command, block.args || [], {
        cwd: block.cwd,
        env: probeSpawnEnv(block),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      return resolve({ ok: false, error: "spawn failed: " + e.message });
    }
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (e) => finish({ ok: false, error: "proc error: " + e.message }));
    const hardTimer = setTimeout(
      () => finish({ ok: false, error: "timeout (stderr: " + stderr.slice(-300) + ")" }),
      timeoutMs
    );

    let buf = "";
    const pending = new Map();
    let nextId = 1;
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id != null && pending.has(msg.id)) {
          const { resolve: rs, reject: rj } = pending.get(msg.id);
          pending.delete(msg.id);
          msg.error ? rj(new Error(JSON.stringify(msg.error))) : rs(msg.result);
        }
      }
    });
    const rpc = (method, params) => {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return new Promise((rs, rj) => {
        pending.set(id, { resolve: rs, reject: rj });
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            rj(new Error("rpc timeout " + method));
          }
        }, timeoutMs);
      });
    };
    const notify = (method, params) =>
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

    (async () => {
      try {
        const init = await rpc("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "pibot-picker", version: "0" },
        });
        notify("notifications/initialized", {});
        const list = await rpc("tools/list", {});
        clearTimeout(hardTimer);
        const tools = (list && list.tools ? list.tools : []).map((t) => ({
          name: t.name,
          description: (t.description || "").slice(0, 240),
          hasPattern: deepHasPattern(t.inputSchema),
          ...toolHints(t),
        }));
        finish({
          ok: true,
          serverName: (init && init.serverInfo && init.serverInfo.name) || "?",
          tools,
        });
      } catch (e) {
        clearTimeout(hardTimer);
        finish({ ok: false, error: e.message + " (stderr: " + stderr.slice(-200) + ")" });
      }
    })();
  });
}

// CLI: write <botId> | probe <serverName> | list-servers
if (import.meta.url === "file://" + process.argv[1]) {
  const cmd = process.argv[2];
  const arg = process.argv[3];
  const CROW_DB = botsDbPath();
  if (cmd === "list-servers") {
    const c = readCanonicalMcp();
    console.log(Object.keys(c.mcpServers).join("\n"));
    process.exit(0);
  }
  if (cmd === "probe" && arg) {
    // This CLI reads the canonical ~/.pi/agent/mcp.json only, never this instance's
    // mcp-addons.json: an add-on entry that lists `keychainEnv` names is never seen here, so
    // this path can neither spawn it key-less nor unseal it (the Bot Builder probe handles
    // that — scripts/pi-bots/ext_registry.mjs extensionTools).
    const c = readCanonicalMcp();
    const block = c.mcpServers[arg];
    if (!block) {
      console.error("no such server: " + arg);
      process.exit(2);
    }
    probeServerTools(block).then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
    });
  } else if (cmd === "write" && arg) {
    // load the bot def from crow.db
    import("better-sqlite3").then((m) => {
      const Database = m.default;
      const d = new Database(CROW_DB);
      d.pragma("busy_timeout = 10000");
      const row = d
        .prepare("SELECT definition, display_name FROM pi_bot_defs WHERE bot_id=?")
        .get(arg);
      // Phase 1 shares: this CLI has the DB open, so it can tell whether the bot holds a live share
      // (the better-sqlite3 mirror of botHoldsLiveShare, servers/shared/project-bot-shares.js) and
      // keep the remote-proxy blocks out of the config it writes. FAIL CLOSED: a read error counts
      // as a share, so a broken read can never hand the proxy blocks back; only a DB that predates
      // the table (`no such table`) is "no share".
      let holdsShare = true;
      try {
        holdsShare = !!d.prepare("SELECT 1 AS x FROM project_bot_shares WHERE bot_id=? AND revoked_at IS NULL LIMIT 1").get(arg);
      } catch (err) { holdsShare = !/no such table/i.test(String((err && err.message) || "")); }
      d.close();
      if (!row) {
        console.error("no such bot: " + arg);
        process.exit(2);
      }
      const def = JSON.parse(row.definition || "{}");
      // A5: thread the active instance (CROW_HOME env -> ~/.crow-mpa on MPA)
      // so minted addon blocks resolve against the same instance as CROW_DB.
      // S6-CROW: honour the delivery mode — in fd mode the bridge pipes the
      // config per turn, so this only validates (and removes a stale file).
      // The bot's identity (botId + display name) rides along so every stdio
      // block carries the actor, as a bridge-written config does.
      // Never print the built config: it carries signed headers and tokens.
      const res = writeBotMcp(def, { crowHome: resolveCrowHome(), botId: arg, displayName: row.display_name, holdsShare,
        write: mcpConfigDelivery() === "file" });
      const { json: _omit, ...printable } = res;
      console.log(JSON.stringify(printable, null, 2));
      process.exit(0);
    });
  } else {
    console.error(
      "usage: mcp_writer.mjs list-servers | probe <server> | write <botId>"
    );
    process.exit(2);
  }
}

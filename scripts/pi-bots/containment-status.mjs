/**
 * An honest containment status (bot containment Phase 1, Tasks 8).
 *
 * The contain tier gives a bot an empty root, a door-only agent dir, a PID
 * namespace, seccomp and a closed network. It does NOT make the bot
 * "contained": `crow.db`/`tasks.db` are bound read-write, an add-on MCP server
 * in the bot's config runs inside the sandbox with its own credentials, and no
 * browser door exists yet. Phase 1 can therefore never report `contained` for a
 * bot that has a config — a contain spawn is at best `partly contained`, and
 * this module is what says so, in one place, for the spawn log and the Bot
 * Runtime settings section.
 *
 * The status is computed, never stored in the DB: the defs are read at render,
 * and the last spawn's facts (tier, level, open list) are kept in this process
 * by bridge.mjs (recordedContainment) because the gateway runs the bot runtime
 * in its own process. A gateway restart forgets them. A bot with NO record —
 * and every bot while PIBOT_SUPERVISOR=external, whose spawns run in another
 * unit with an env this process never sees — is `not contained` with
 * OPEN_UNOBSERVED (unobservedContainment). The status is NEVER inferred from
 * the gateway's own env: that env is not necessarily the env the bot spawned
 * with, and guessing from it could print a tier the bot does not have.
 *
 * Words are exact (the private engineering notes' policy): `contained`,
 * `partly contained`, `not contained`. The open lines are exact too — the docs,
 * the spawn log and the settings page quote the same sentences — so they live
 * here as constants, never as prose assembled from parts.
 *
 * This module is a LEAF: no bridge, no sandbox, no database. That is what lets
 * the dashboard settings section import it.
 */

/** The three status words, exact. */
export const LEVEL_CONTAINED = "contained";
export const LEVEL_PARTLY = "partly contained";
export const LEVEL_NOT = "not contained";

/** What every contain-tier bot still reaches in Phase 1 (crow.db is bound). */
export const OPEN_DATA_DBS =
  "crow.db and tasks.db are readable and writable (provider keys, OAuth tokens, settings, bot definitions)";
/** A configured browser has no door, so a contained bot cannot reach it. */
export const OPEN_BROWSER = "the browser is unreachable (no browser door yet)";
/**
 * Instance-level: this spawn's tier cannot hold the identity-file mask, and an
 * identity file exists. Two shapes, one sentence, because the operator's read is
 * the same either way: `pidns` is the only default tier that makes the mask
 * hold (bwrap without its own PID namespace leaves the host /proc reachable
 * through /proc/<pid>/root/..., and the setpriv/plain fallbacks mask nothing at
 * all). The contain tier always has a PID namespace, so it never carries this
 * line. The bridge does NOT refuse such a spawn (the operator decides); it logs
 * a loud warning and names the exposure here.
 */
export const OPEN_IDENTITY_UNMASKED =
  "the instance's identity file is not hidden (this spawn has no bubblewrap sandbox with its own PID namespace)";
/** Instance-level: a `not contained` bot shares this uid with the gateway. */
export const OPEN_SECRETS_SWAP =
  "an uncontained bot could replace the hidden secrets dir before a restart (peer tokens, service bindings)";
/** An uncontained bot keeps today's world: everything the uid has. */
export const OPEN_UNCONTAINED = "runs with the operator's files, network and keys";
/**
 * The operator exempted this bot from the contain tier (CROW_PI_CONTAIN_EXCLUDE):
 * it never entered the tier, so it runs the default one. The words say WHY, so
 * the exemption is never mistaken for a containment failure — and they say what
 * the exemption costs: `crow.db` is bound read-write into every CONTAINED bot and
 * it holds `pi_bot_defs`, so any contained bot can rewrite this bot's definition
 * (instructions, tools, write_paths) and have it run at the default tier. An
 * exemption is not a boundary, and the line must not read like one.
 */
export const OPEN_EXCLUDED = "not contained (excluded by the operator — other bots can change its settings)";
/** Instance-level: the contain tier cannot even start (pi_sandbox.mjs). */
export const OPEN_NO_BWRAP = "this host has no bwrap";
/**
 * Instance-level: this process cannot see the bot's spawns (no record here, or
 * PIBOT_SUPERVISOR=external / a supervised channel child), so no tier is
 * claimed for it at all.
 */
export const OPEN_UNOBSERVED =
  "spawns outside this process are not observed here, so this bot counts as not contained";

/** `<server> runs inside the sandbox with its own credentials` */
export function addOnLine(server) {
  return server + " runs inside the sandbox with its own credentials";
}

/** `provider <id> has no door` — the same words pi_sandbox.mjs refuses with. */
export function noDoorLine(provider) {
  return "provider " + provider + " has no door";
}

/**
 * A CONFIGURED writable path (session dir, cwd, workspace, a write_paths entry) that did not
 * exist at spawn, so the plan dropped it (pi_contain.mjs `droppedWrites`): inside the sandbox
 * the empty $HOME is a tmpfs, so a write there still "succeeds" and is discarded with the
 * spawn — the folder is never created on the host, unlike the loose tier. The line NAMES the
 * path, so that silent success is never the only evidence (travel-agent, 2026-11-19).
 *
 * The path is bot-visible text (an operator's configured path, or one a def named) and it lands
 * inside the ONE `[containment]` line, whose items are joined with "; " — so a newline there
 * would forge a log line and a ";" would forge an item. Control characters (C0/C1, \r, \n and
 * \t included) and the item separator are therefore stripped before it enters the line. The
 * path the spawn refusal logs stays byte-exact; only this display line is flattened.
 */
export function droppedWriteLine(path) {
  return "the write path " + oneLineItem(path) + " did not exist, so writes there are lost";
}

/** A path made safe for the single `[containment]` line: no control characters (C0/C1) and no
 *  `;` (the separator between that line's items), so it cannot open a line or an item of its own. */
function oneLineItem(path) {
  // eslint-disable-next-line no-control-regex
  return String(path == null ? "" : path).replace(/[\u0000-\u001f\u007f-\u009f;]/g, "");
}

/**
 * Crow's own MCP servers, which run with THIS instance's authority (the DB,
 * the gateway's mounts) rather than with credentials of their own. Anything
 * else in a bot's config is an add-on: it runs inside the sandbox with its own
 * secrets in env/token paths (the documented Phase 1 residual).
 */
const CROW_OWN_SERVERS = new Set([
  "crow-memory", "crow-projects", "crow-sharing", "crow-blog", "crow-storage", "crow-tasks",
  "crow-bots-sql", "crow-secrets", "board", "phone", "artifacts", "secrets",
]);

/** True for a server name Crow itself ships (see CROW_OWN_SERVERS). */
export function isCrowOwnServer(name) {
  const n = String(name || "");
  return CROW_OWN_SERVERS.has(n) || n.startsWith("crow-");
}

/** The browser is the canonical `crow-browser` MCP or its add-on id `browser`. */
const BROWSER_SERVER_RE = /^(?:crow-)?browser(?:-.+)?$/i;
export function isBrowserServer(name) {
  return BROWSER_SERVER_RE.test(String(name || ""));
}

/** A tool name that reaches a browser (an add-on's tool, or a pi extension's). */
export function isBrowserTool(name) {
  return /browser/i.test(String(name || ""));
}

/**
 * The MCP servers a bot def grants, by server name: `"server/tool"` and
 * `"server__tool"` both reduce to `server` (the same reduction as
 * scripts/pi-bots/mcp_writer.mjs serversForBot — copied rather than imported,
 * because that module resolves launchers and this one must stay a leaf).
 */
export function crowMcpServers(def) {
  const sel = (def && def.tools && def.tools.crow_mcp) || [];
  const out = [];
  for (const entry of sel) {
    if (typeof entry !== "string" || !entry) continue;
    const name = entry.split("/")[0].split("__")[0];
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Every tool name a def grants (pi builtins and MCP entries alike). */
export function defToolNames(def) {
  const t = (def && def.tools) || {};
  return [...(Array.isArray(t.pi_builtin) ? t.pi_builtin : []), ...(Array.isArray(t.crow_mcp) ? t.crow_mcp : [])]
    .filter((n) => typeof n === "string" && n);
}

const RANK = { [LEVEL_CONTAINED]: 2, [LEVEL_PARTLY]: 1, [LEVEL_NOT]: 0 };
const rank = (level) => (Object.prototype.hasOwnProperty.call(RANK, level) ? RANK[level] : 0);

function dedupe(lines) {
  const out = [];
  for (const line of lines) if (typeof line === "string" && line && !out.includes(line)) out.push(line);
  return out;
}

/**
 * One bot's containment status.
 *
 * @param {object} a
 * @param {string|null} a.tier        the last spawn's sandbox tier ("contain",
 *                                    "contain-noseccomp", "-hostnet" forms,
 *                                    "pidns"/"userns"/"nnp"/"none"), or null
 * @param {string[]} [a.mcpServers]   the bot's MCP server names (its closed-world config)
 * @param {string[]} [a.providerIds]  the providers the spawn needed (carried for the record)
 * @param {Array<{provider?: string, reason?: string}|string>} [a.missing]
 *                                    providers with no door: the spawn was REFUSED
 * @param {string[]} [a.tools]        tool names, for browser detection
 * @param {boolean} [a.excluded]      the operator exempted this bot from the
 *                                    contain tier (CROW_PI_CONTAIN_EXCLUDE)
 * @param {string[]} [a.droppedWrites] configured writable paths the plan dropped
 *                                    because they do not exist (pi_contain.mjs);
 *                                    each one gets its own open line
 * @param {boolean} [a.identityExposed] an identity file exists and this spawn's
 *                                    tier cannot hold the mask (see
 *                                    OPEN_IDENTITY_UNMASKED)
 * @returns {{level: string, open: string[]}}
 */
export function botContainment({ tier = null, mcpServers = [], providerIds = [], missing = [], tools = [], excluded = false, droppedWrites = [], identityExposed = false } = {}) {
  // A refused spawn is not a weaker containment: it did not run. Say what stood
  // in the way (the same sentence the failed turn carries).
  const refused = dedupe((Array.isArray(missing) ? missing : []).map((m) => {
    if (typeof m === "string") return m ? (m.startsWith("provider ") ? m : noDoorLine(m)) : null;
    if (!m || typeof m !== "object") return null;
    if (typeof m.reason === "string" && m.reason) return m.reason;
    const id = m.provider != null ? m.provider : (m.id != null ? m.id : m.label);
    return id == null ? null : noDoorLine(id);
  }));
  if (refused.length) return { level: LEVEL_NOT, open: refused };
  // An exemption is not a refusal and not a downgrade: the spawn ran exactly as
  // the operator asked, in the tier it would have had without the contain
  // switch. Said plainly, so the status never reads like a containment bug.
  if (excluded === true) return { level: LEVEL_NOT, open: [OPEN_EXCLUDED, ...(identityExposed === true ? [OPEN_IDENTITY_UNMASKED] : [])] };

  const servers = (Array.isArray(mcpServers) ? mcpServers : []).filter((n) => typeof n === "string" && n);
  const contain = typeof tier === "string" && tier.startsWith("contain");
  if (!contain) {
    return { level: LEVEL_NOT, open: [OPEN_UNCONTAINED, ...(identityExposed === true ? [OPEN_IDENTITY_UNMASKED] : [])] };
  }

  // Contain tier, Phase 1: never "contained". The data dir is bound read-write,
  // so the DB line always applies; each add-on brings its own secrets; and a
  // configured browser has no door. `providerIds` is accepted for the record
  // (and by the settings renderer) but changes no line.
  const open = [OPEN_DATA_DBS];
  // A configured writable path that did not exist was dropped, not bound: say which one, so
  // the operator sees why a write there left nothing behind.
  for (const p of Array.isArray(droppedWrites) ? droppedWrites : []) {
    if (typeof p === "string" && p) open.push(droppedWriteLine(p));
  }
  let browser = false;
  for (const name of servers) {
    if (isBrowserServer(name)) { browser = true; continue; }
    if (!isCrowOwnServer(name)) open.push(addOnLine(name));
  }
  if (!browser) browser = (Array.isArray(tools) ? tools : []).some(isBrowserTool);
  if (browser) open.push(OPEN_BROWSER);
  void providerIds;
  return { level: LEVEL_PARTLY, open: dedupe(open) };
}

/**
 * The instance's containment status, folded from its bots.
 *
 * Level = the WEAKEST bot level (an instance is only as contained as its least
 * contained bot). Open = the union of every bot's open lines, de-duplicated,
 * each prefixed with the bot id that carries it. A host without bwrap cannot
 * contain anything, so it is `not contained` with `this host has no bwrap`.
 * Any `not contained` bot — including every unobserved one — also adds the
 * secrets-dir line: such a bot runs as this uid (Phase 1) and can replace the
 * hidden secrets dir before a restart.
 *
 * @param {Array<{botId?: string, level: string, open?: string[]}>} bots
 * @param {{host?: {bwrap?: boolean}}} [opts]
 * @returns {{level: string, open: string[]}}
 */
export function instanceContainment(bots = [], { host = {} } = {}) {
  const list = Array.isArray(bots) ? bots : [];
  const open = [];
  for (const b of list) {
    if (!b || !Array.isArray(b.open)) continue;
    const prefix = b.botId ? String(b.botId) + ": " : "";
    for (const line of b.open) if (typeof line === "string" && line) open.push(prefix + line);
  }
  if (host && host.bwrap === false) {
    return { level: LEVEL_NOT, open: dedupe([...open, OPEN_NO_BWRAP]) };
  }
  let level = LEVEL_CONTAINED;
  // A level this module does not know (a bad record) cannot claim a rank.
  for (const b of list) if (b && Object.prototype.hasOwnProperty.call(RANK, b.level) && rank(b.level) < rank(level)) level = b.level;
  if (list.some((b) => b && b.level === LEVEL_NOT)) open.push(OPEN_SECRETS_SWAP);
  return { level, open: dedupe(open) };
}

// ---- the last spawn's facts, kept in this process ---------------------------
// The gateway runs the bot runtime (and the Perch engine) in its own process by
// default — but NOT while PIBOT_SUPERVISOR=external, and never for a supervised
// channel child, which is a process of its own. So a record covers only the
// spawns THIS process made: bridge.mjs writes here and the settings section
// reads it. Nothing is written to disk and no DB column exists (Phase 1 has no
// migration); a bot without a record is reported as not contained, never
// guessed from the local env.
const lastSpawn = new Map();   // botId -> {level, open, tier, at}

/**
 * The status of a bot whose spawns this process cannot observe (no record here,
 * or PIBOT_SUPERVISOR=external): `not contained`, with the one line that says
 * why. Never inferred from the local env.
 */
export function unobservedContainment() {
  return { level: LEVEL_NOT, open: [OPEN_UNOBSERVED] };
}

/** Remember one spawn's status (bridge.mjs, once per spawn). */
export function recordContainment(botId, status) {
  if (!botId || !status) return null;
  const entry = {
    level: status.level,
    open: Array.isArray(status.open) ? [...status.open] : [],
    tier: status.tier === undefined ? null : status.tier,
    at: new Date().toISOString(),
  };
  lastSpawn.set(String(botId), entry);
  return entry;
}

/** The last spawn's recorded status for a bot, or null (never spawned here). */
export function recordedContainment(botId) {
  if (!botId) return null;
  const e = lastSpawn.get(String(botId));
  return e ? { ...e, open: [...e.open] } : null;
}

/** Test seam only. */
export function _resetContainmentForTest() { lastSpawn.clear(); }

/**
 * The one `[containment]` line per spawn (the operator greps for it). Fixed
 * shape: `[containment] <bot> <level>: <n> open (<line>; <line>)`.
 */
export function formatContainmentLine(botId, status) {
  const level = (status && status.level) || LEVEL_NOT;
  const open = (status && Array.isArray(status.open)) ? status.open : [];
  return "[containment] " + (botId ? String(botId) + " " : "") + level + ": " + open.length + " open" +
    (open.length ? " (" + open.join("; ") + ")" : "");
}
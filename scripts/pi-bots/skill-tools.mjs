/**
 * A repo skill's declared tools reach the bot (research fetch-before-cite,
 * PR 2, Task 14).
 *
 * A skill's frontmatter `tools:` list has always been informational. An entry
 * spelled as an exact `server/tool` (`crow-projects/crow_add_source`) now
 * GRANTS that one tool to a bot that selects the skill, under three limits:
 *
 *   1. Only skills shipped in the running checkout's skills/ directory
 *      (REPO_SKILLS_DIR) grant anything. A <crowHome>/skills copy (an
 *      installed or bot-proposed skill) grants nothing, even when it shadows a
 *      repo skill of the same name, so "approving a proposal can never grant a
 *      tool" (skill_proposals.mjs) still holds.
 *   2. Bare server names (`filesystem`, `crow-memory`) and bare tool names stay
 *      informational: shipped skills already list them, and granting whole
 *      servers would widen every bot that selects one.
 *   3. A skill switched off on this instance grants nothing.
 *   4. Only servers in GRANTABLE_SERVERS can be granted, and a server the def
 *      selects Read-only gets only tools Bot Builder's classifier calls read.
 *
 * The owner's unticks win: `def.tools.skill_tools_declined` lists the
 * `server/tool` entries a selected skill requires that the owner left off in
 * Bot Builder, and every union below skips them. The union is applied to a
 * COPY of the def at spawn (bot-world.mjs buildBotWorld) and for background
 * jobs (job_runner.mjs); it is never written back from there. It never passes
 * the model's tool cap (counted like addCompanionsGuarded); over the cap the
 * tools are not added and the caller says so.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { parseSkillMeta } from "../../servers/gateway/skills-catalog.js";
import { resolveSkill, REPO_SKILLS_DIR, EXEMPT_FROM_OFF } from "./skill_resolver.mjs";
import { normalizeSkillName } from "./skill_proposals.mjs";
import { offSkills } from "../../servers/shared/skill-state.js";
import { resolveCrowHome } from "../../servers/shared/crow-home.js";
import { isVoiceBotDef } from "../../servers/shared/voice-bot.js";
import { classifyTool, classifyToolDetail, LEGACY_READ } from "../../servers/shared/tool-classify.js";
import { installPaths, satelliteBundleIds } from "../../servers/gateway/satellites/installs.js";

/** An exact `server/tool` entry (the only spelling that grants). */
export const SKILL_TOOL_RE = /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9_]+$/;

/**
 * The only servers a skill can grant tools from (review fix round 1: a bot
 * whose write paths cover the checkout could edit a repo skill's `tools:`
 * and give itself any tool on its next turn). Entries for any other server
 * stay informational — a satellite-hosted bundle included: its grants are the
 * owner's own ticks in Bot Builder (SAT-7 §9.4).
 */
export const GRANTABLE_SERVERS = Object.freeze(["crow-projects"]);

/** The one read/write rule, shared with Bot Builder's Read-only mode (servers/shared/tool-classify.js). */
export const isReadTool = (tool, opts) => classifyTool({ name: tool }, opts) === "read";

// ── satellite-hosted bundles (SAT-7 §9.4) ───────────────────────────────────────────────────────
// A satellite picks its own tool names, so the name rule says nothing about its tools: every one
// of them is WRITE unless the owner marked it read against the pinned list. The bundle ids come
// from installed.json (local, no network, no DB); the read marks come from whoever holds the pins
// (Bot Builder — satelliteReadMarks), so a caller without them fails CLOSED (write).

/** The satellite-hosted bundle ids, read once per call chain (installed.json only). */
export function satelliteBundleIdSet({ crowHome } = {}) {
  try { return satelliteBundleIds(installPaths(crowHome || resolveCrowHome())); } catch { return new Set(); }
}

/**
 * The classifyTool options for one server: {isSatellite, readMarks} when the server is a
 * satellite-hosted bundle (named in `satelliteMarks`, or installed.json places it on a satellite),
 * undefined for everything else.
 * @param {string} server
 * @param {{crowHome?:string, satelliteMarks?:Map<string,string[]>, ids?:Set<string>}} [opts]
 * @returns {{isSatellite:true, readMarks:string[]}|undefined}
 */
export function satelliteClassifyOpts(server, opts = {}) {
  const s = String(server || "");
  const marks = opts.satelliteMarks instanceof Map ? opts.satelliteMarks.get(s) : undefined;
  if (marks === undefined) {
    const ids = opts.ids instanceof Set ? opts.ids : satelliteBundleIdSet(opts);
    if (!ids.has(s)) return undefined;
  }
  return { isSatellite: true, readMarks: Array.isArray(marks) ? marks : [] };
}

/** Split a crow_mcp entry ("server/tool" or "server__tool") into [server, tool]; null for a bare server.
 *  Exported for the services mount (servers/gateway/services/mount.js), so the spellings that
 *  grant cannot drift between the bridge and the door. */
export function splitEntry(e) {
  if (typeof e !== "string") return null;
  const i = e.indexOf("/"), j = e.indexOf("__");
  if (i > 0) return [e.slice(0, i), e.slice(i + 1)];
  if (j > 0) return [e.slice(0, j), e.slice(j + 2)];
  return null;
}

/**
 * Is `server` selected Read-only in this crow_mcp list, for the union? True
 * when the selection is NON-EMPTY, is not a whole-server grant, and holds no
 * tool the classifier calls write, except LEGACY_READ entries (a def saved as
 * Read-only when crow_fetch_source still classified as read stores it; that
 * selection is still Read-only). Fails closed: a tool name the rule does
 * not recognise does not take the selection OUT of read mode (it can never
 * turn a read-only pick into write grants), and in read mode the union adds
 * only tools the classifier calls read (an unrecognised one counts as write
 * there, so it is never added).
 */
export function serverInReadMode(list, server, opts = {}) {
  if (!Array.isArray(list) || list.includes(server)) return false;
  const sat = satelliteClassifyOpts(server, opts);
  const mine = list.map(splitEntry).filter((x) => x && x[0] === server).map((x) => x[1]);
  return mine.length > 0 && mine.every((tool) => LEGACY_READ.has(tool) || classifyToolDetail({ name: tool }, sat) !== "write");
}

/**
 * The list without the LEGACY_READ entries of any server it selects
 * Read-only (serverInReadMode), so a Read-only bot never keeps a tool that
 * writes. Entries of a server with a real write pick are kept. PURE.
 */
export function dropLegacyRead(list, opts = {}) {
  if (!Array.isArray(list)) return [];
  const ro = new Map();
  const readMode = (server) => {
    if (!ro.has(server)) ro.set(server, serverInReadMode(list, server, opts));
    return ro.get(server);
  };
  return list.filter((e) => {
    const x = splitEntry(e);
    return !(x && LEGACY_READ.has(x[1]) && readMode(x[0]));
  });
}

const inside = (dir, p) => {
  const r = relative(resolve(dir), resolve(p));
  return !!r && !r.startsWith("..") && !isAbsolute(r);
};

/**
 * Resolve a skill the way skill_resolver does (<crowHome>/skills first, then
 * the repo dir), with the repo dir overridable for tests.
 */
function locate(name, { crowHome, repoSkillsDir }) {
  const repo = repoSkillsDir ? resolve(repoSkillsDir) : REPO_SKILLS_DIR;
  if (repo === REPO_SKILLS_DIR) return resolveSkill(name, { crowHome });
  const base = normalizeSkillName(name);
  if (!base) return null;
  for (const dir of [join(crowHome || resolveCrowHome(), "skills"), repo]) {
    const p = join(dir, base + ".md");
    if (existsSync(p)) return { name, path: p, text: readFileSync(p, "utf8") };
  }
  return null;
}

const toolEntries = (text, slug) => parseSkillMeta(text, "en", slug).tools.filter((x) => SKILL_TOOL_RE.test(x));

function isOff(name, crowHome) {
  const base = normalizeSkillName(name);
  return !!base && !EXEMPT_FROM_OFF.includes(base) && offSkills(crowHome || resolveCrowHome()).has(base);
}

/**
 * The `server/tool` entries a skill's frontmatter declares, read from the
 * repo copy only. `ignoreOff` is for clearing declines of a dropped skill.
 */
function declaredRepoTools(name, { crowHome, repoSkillsDir, ignoreOff = false } = {}) {
  const home = crowHome || resolveCrowHome();
  const repo = repoSkillsDir ? resolve(repoSkillsDir) : REPO_SKILLS_DIR;
  const r = locate(name, { crowHome: home, repoSkillsDir: repo });
  if (!r || !inside(repo, r.path)) return [];
  if (!ignoreOff && isOff(name, home)) return [];
  return [...new Set(toolEntries(r.text, normalizeSkillName(name) || "").filter((e) => GRANTABLE_SERVERS.includes(e.split("/")[0])))];
}

/** @returns {string[]} the tools a selected skill grants ([] unless a repo skill that is on). */
export function skillRequiredTools(name, { crowHome, repoSkillsDir } = {}) {
  return declaredRepoTools(name, { crowHome, repoSkillsDir });
}

/** Does `list` already grant `entry` (per tool, `__` spelling, or the whole server)? */
export function grantsTool(list, entry) {
  if (!Array.isArray(list)) return false;
  const [server, tool] = entry.split("/");
  return list.includes(entry) || list.includes(`${server}__${tool}`) || list.includes(server);
}

/**
 * PURE union of crowMcp with the required tools of `skills`.
 * @returns {{ list: string[], added: string[] }}
 */
export function withSkillRequiredTools(crowMcp, skills, { crowHome, declined = [], repoSkillsDir, satelliteMarks } = {}) {
  // A Read-only server's legacy entries (crow_fetch_source) are dropped
  // (the satellite ids are read once here, not once per tool)
  const satOpts = { crowHome, satelliteMarks, ids: satelliteBundleIdSet({ crowHome }) };
  const list = dropLegacyRead(crowMcp, satOpts);
  const skip = new Set(Array.isArray(declined) ? declined : []);
  const added = [];
  // a server in Read-only mode (judged on the list as given) gets read tools only
  const readOnly = (server) => serverInReadMode(crowMcp, server, satOpts);
  for (const s of Array.isArray(skills) ? skills : []) {
    if (typeof s !== "string") continue;
    for (const entry of skillRequiredTools(s, { crowHome, repoSkillsDir })) {
      if (skip.has(entry) || grantsTool(list, entry)) continue;
      const [server, tool] = entry.split("/");
      if (readOnly(server) && !isReadTool(tool, satelliteClassifyOpts(server, satOpts))) continue;
      list.push(entry);
      added.push(entry);
    }
  }
  return { list, added };
}

const declinedOf = (def) => {
  const d = def && def.tools && def.tools.skill_tools_declined;
  return Array.isArray(d) ? d.filter((x) => typeof x === "string") : [];
};
const crowMcpOf = (def) => (def && def.tools && Array.isArray(def.tools.crow_mcp) ? def.tools.crow_mcp : []);

/** What the bot actually gets from crow_mcp: the stored list plus its repo skills' tools, minus declines. */
export function effectiveCrowMcp(def, { crowHome, repoSkillsDir, satelliteMarks } = {}) {
  return withSkillRequiredTools(crowMcpOf(def), def && def.skills, { crowHome, repoSkillsDir, satelliteMarks, declined: declinedOf(def) }).list;
}

/**
 * Cap-guarded union for a spawn or a job.
 * @returns {Promise<{def: object, added: string[], refused: boolean, wanted: string[]}>}
 *   a NEW def when tools are added or a Read-only server's LEGACY_READ
 *   entries are dropped (the input is never mutated); `refused` when the
 *   candidate passes the model's tool cap (`wanted` names them; the legacy
 *   entries are still dropped).
 */
export async function addSkillToolsGuarded(def, { crowHome, budget = null, repoSkillsDir, satelliteMarks } = {}) {
  if (!def || typeof def !== "object" || isVoiceBotDef(def)) return { def, added: [], refused: false, wanted: [] };
  const stored = crowMcpOf(def);
  const { list, added } = withSkillRequiredTools(stored, def.skills, { crowHome, repoSkillsDir, satelliteMarks, declined: declinedOf(def) });
  // the stored list minus a Read-only server's legacy entries: what the bot
  // runs with when nothing is added (or the union is refused)
  const base = dropLegacyRead(stored, { crowHome, satelliteMarks });
  const baseDef = base.length === stored.length ? def : { ...def, tools: { ...(def.tools || {}), crow_mcp: base } };
  if (!added.length) return { def: baseDef, added: [], refused: false, wanted: [] };
  const candidate = { ...def, tools: { ...(def.tools || {}), crow_mcp: list } };
  // lazy: artifacts-companions imports bot-world.mjs, which imports this module
  const b = budget || (await (await import("./artifacts-companions.mjs")).defaultCompanionBudget(def));
  if (Number.isInteger(b.cap) && b.cap > 0 && b.countFor(candidate) > b.cap) return { def: baseDef, added: [], refused: true, wanted: added };
  return { def: candidate, added, refused: false, wanted: added };
}

/**
 * Selected skills that declare `server/tool` entries the def does not grant
 * and the union does not cover (a non-repo copy), for the Bot Builder hint.
 * @returns {Array<{skill: string, servers: string[]}>}
 */
export function skillToolHints(def, { crowHome, repoSkillsDir } = {}) {
  const home = crowHome || resolveCrowHome();
  const repo = repoSkillsDir ? resolve(repoSkillsDir) : REPO_SKILLS_DIR;
  const granted = crowMcpOf(def);
  const out = [];
  for (const s of Array.isArray(def && def.skills) ? def.skills : []) {
    if (typeof s !== "string" || isOff(s, home)) continue;
    const r = locate(s, { crowHome: home, repoSkillsDir: repo });
    if (!r || inside(repo, r.path)) continue; // missing, or a repo skill (the union covers it)
    const missing = toolEntries(r.text, normalizeSkillName(s) || "").filter((e) => !grantsTool(granted, e));
    if (missing.length) out.push({ skill: s, servers: [...new Set(missing.map((e) => e.split("/")[0]))] });
  }
  return out;
}

/** The repo tools a skill declares even when it is switched off (to clear a dropped skill's declines). */
export function skillDeclaredRepoTools(name, opts = {}) {
  return declaredRepoTools(name, { ...opts, ignoreOff: true });
}

/** Would the union grant `entry` on top of `list` (Read-only mode respected; declines not considered)? */
export function unionMayGrant(list, entry, opts = {}) {
  const [server, tool] = entry.split("/");
  if (!GRANTABLE_SERVERS.includes(server)) return false;
  return !(serverInReadMode(list, server, opts) && !isReadTool(tool, satelliteClassifyOpts(server, opts)));
}

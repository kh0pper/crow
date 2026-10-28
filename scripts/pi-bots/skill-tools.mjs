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

/** An exact `server/tool` entry (the only spelling that grants). */
export const SKILL_TOOL_RE = /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9_]+$/;

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
  return [...new Set(toolEntries(r.text, normalizeSkillName(name) || ""))];
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
export function withSkillRequiredTools(crowMcp, skills, { crowHome, declined = [], repoSkillsDir } = {}) {
  const list = Array.isArray(crowMcp) ? crowMcp.slice() : [];
  const skip = new Set(Array.isArray(declined) ? declined : []);
  const added = [];
  for (const s of Array.isArray(skills) ? skills : []) {
    if (typeof s !== "string") continue;
    for (const entry of skillRequiredTools(s, { crowHome, repoSkillsDir })) {
      if (skip.has(entry) || grantsTool(list, entry)) continue;
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
export function effectiveCrowMcp(def, { crowHome, repoSkillsDir } = {}) {
  return withSkillRequiredTools(crowMcpOf(def), def && def.skills, { crowHome, repoSkillsDir, declined: declinedOf(def) }).list;
}

/**
 * Cap-guarded union for a spawn or a job.
 * @returns {Promise<{def: object, added: string[], refused: boolean, wanted: string[]}>}
 *   a NEW def when tools are added (the input is never mutated); `refused`
 *   when the candidate passes the model's tool cap (`wanted` names them).
 */
export async function addSkillToolsGuarded(def, { crowHome, budget = null, repoSkillsDir } = {}) {
  if (!def || typeof def !== "object" || isVoiceBotDef(def)) return { def, added: [], refused: false, wanted: [] };
  const { list, added } = withSkillRequiredTools(crowMcpOf(def), def.skills, { crowHome, repoSkillsDir, declined: declinedOf(def) });
  if (!added.length) return { def, added: [], refused: false, wanted: [] };
  const candidate = { ...def, tools: { ...(def.tools || {}), crow_mcp: list } };
  // lazy: artifacts-companions imports bot-world.mjs, which imports this module
  const b = budget || (await (await import("./artifacts-companions.mjs")).defaultCompanionBudget(def));
  if (Number.isInteger(b.cap) && b.cap > 0 && b.countFor(candidate) > b.cap) return { def, added: [], refused: true, wanted: added };
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

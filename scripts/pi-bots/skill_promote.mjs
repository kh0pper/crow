#!/usr/bin/env node
/**
 * Crow Bot Builder — shared skill promotion (self-learning, plan §B4).
 *
 * ONE code path that writes a skill file into ~/.crow/skills and attaches its
 * name to the bot's def (def.skills + def.tools.skills), used by BOTH:
 *   - the operator approve handler (bot-board-api.js) — mode:"operator"
 *   - the auto-mode review pass (skill_review.mjs)     — mode:"auto"
 *
 * Mode-specific rules (review C5/C6):
 *   operator: never overwrite an existing ~/.crow/skills file (409). Unchanged
 *             semantics from the original approve handler.
 *   auto:     - NEVER write/patch a shipped repo skill (~/crow/skills) — protected.
 *             - create a NEW skill only if no skill of that name exists elsewhere
 *               that this bot didn't author.
 *             - patch an existing ~/.crow/skills file ONLY if provenance shows
 *               this bot created it (botAuthoredSkill). Otherwise refuse so the
 *               caller can downgrade to a propose draft.
 * Repo ~/crow/skills is never a write target in any mode (target is always
 * ~/.crow/skills), so shipped skills are structurally safe.
 *
 * The def update is a BEGIN IMMEDIATE better-sqlite3 transaction (read-modify-
 * write), because the auto path has no human to retry the SSR save path's
 * optimistic-concurrency 409. busy_timeout-only; no journal_mode pragma.
 *
 * Returns { ok:true, action:"create"|"patch", target } or
 * { ok:false, code, message } with code ∈ invalid-name | empty | escape |
 * symlink | exists | protected | not-author | unknown-bot | write-failed |
 * db-failed. The caller maps these (operator → HTTP status; auto → downgrade).
 */
import Database from "/home/kh0pp/crow/node_modules/better-sqlite3/lib/index.js";
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { normalizeSkillName } from "./skill_proposals.mjs";
import { resolveSkill } from "./skill_resolver.mjs";
import { botAuthoredSkill, recordSkillEvent } from "./skill_provenance.mjs";

const HOME = homedir();
const CROW_DB = process.env.CROW_DB_PATH || HOME + "/.crow-mpa/data/crow.db";
const CROW_USER_SKILLS = join(HOME, ".crow", "skills");   // sole write target (matches approve handler)
const REPO_SKILLS = join(HOME, "crow", "skills");         // protected (shipped) — never written

function db() { const d = new Database(CROW_DB); d.pragma("busy_timeout = 10000"); return d; }

// Transactional read-modify-write of pi_bot_defs.definition: add `name` to
// def.skills + def.tools.skills. BEGIN IMMEDIATE so a concurrent SSR save can't
// interleave between our read and write. Returns {ok} / {ok:false,message}.
function attachSkillToDef(bot_id, name) {
  const c = db();
  try {
    const tx = c.transaction(() => {
      const row = c.prepare("SELECT definition FROM pi_bot_defs WHERE bot_id=?").get(bot_id);
      if (!row) throw new Error("unknown-bot");
      let def; try { def = JSON.parse(row.definition || "{}"); } catch { def = {}; }
      def.skills = Array.isArray(def.skills) ? def.skills : [];
      if (!def.skills.includes(name)) def.skills.push(name);
      def.tools = def.tools || {};
      def.tools.skills = Array.isArray(def.tools.skills) ? def.tools.skills : [];
      if (!def.tools.skills.includes(name)) def.tools.skills.push(name);
      c.prepare("UPDATE pi_bot_defs SET definition=?, updated_at=datetime('now') WHERE bot_id=?")
        .run(JSON.stringify(def), bot_id);
    });
    tx.immediate();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  } finally {
    c.close();
  }
}

/**
 * @param {{ bot_id:string, name:string, text:string, mode:"operator"|"auto",
 *           model?:string, flags?:any, crowHome?:string }} opts
 */
export function promoteSkill(opts) {
  const name = normalizeSkillName(opts.name);
  if (!name) return { ok: false, code: "invalid-name", message: "invalid skill name" };
  const text = typeof opts.text === "string" ? opts.text : "";
  if (!text.trim()) return { ok: false, code: "empty", message: "content (non-empty) required" };
  const mode = opts.mode === "operator" ? "operator" : "auto";

  mkdirSync(CROW_USER_SKILLS, { recursive: true });
  // containment: the resolved skills root must be a prefix of the target.
  const realRoot = realpathSync(CROW_USER_SKILLS);
  if (!join(realRoot, name + ".md").startsWith(realRoot + "/")) {
    return { ok: false, code: "escape", message: "target escapes the skills dir" };
  }
  const target = join(CROW_USER_SKILLS, name + ".md");
  const targetExists = existsSync(target);
  if (targetExists && lstatSync(target).isSymbolicLink()) {
    return { ok: false, code: "symlink", message: "target is a symlink — refusing" };
  }

  // What does this name already resolve to across all skill dirs (first match)?
  const existing = resolveSkill(name, { crowHome: opts.crowHome });

  let action, prevContent = null;
  if (mode === "operator") {
    if (targetExists) {
      return { ok: false, code: "exists", message: "a skill named '" + name + "' already exists in ~/.crow/skills; rename or remove it first (refusing to overwrite)" };
    }
    action = "create";
  } else {
    // auto: protect shipped repo skills; gate patch/create on authorship.
    if (existing && existing.path && existing.path.startsWith(REPO_SKILLS + "/")) {
      return { ok: false, code: "protected", message: "a shipped (repo) skill named '" + name + "' exists; refusing to shadow it" };
    }
    if (targetExists) {
      if (botAuthoredSkill(opts.bot_id, name)) { action = "patch"; prevContent = readFileSync(target, "utf8"); }
      else return { ok: false, code: "not-author", message: "skill '" + name + "' exists in ~/.crow/skills and was not authored by this bot" };
    } else if (existing && !botAuthoredSkill(opts.bot_id, name)) {
      return { ok: false, code: "not-author", message: "skill '" + name + "' exists elsewhere and was not authored by this bot" };
    } else {
      action = "create";
    }
  }

  try { writeFileSync(target, text, "utf8"); }
  catch (e) { return { ok: false, code: "write-failed", message: String((e && e.message) || e) }; }

  const upd = attachSkillToDef(opts.bot_id, name);
  if (!upd.ok) {
    // roll back the file so a failed def update doesn't leave an orphan/clobber.
    try {
      if (action === "create") unlinkSync(target);
      else if (prevContent != null) writeFileSync(target, prevContent, "utf8");
    } catch {}
    return { ok: false, code: upd.message === "unknown-bot" ? "unknown-bot" : "db-failed", message: upd.message };
  }

  recordSkillEvent({ bot_id: opts.bot_id, skill_name: name, action, mode, model: opts.model, flags: opts.flags });
  return { ok: true, action, target };
}

export { CROW_USER_SKILLS, REPO_SKILLS };

#!/usr/bin/env node
/**
 * Crow Bot Builder — skill text resolver (Slice A, A3).
 *
 * Single source of truth for turning a bot's def.skills[] names into prompt
 * text. Used by the bridge (pi path, here in Slice A) and — Slice B/C — by the
 * glasses voice path and the self-authoring approval flow. Skills are PURE
 * PROMPT TEXT: resolving one only reads a .md file and returns its contents;
 * it can never grant tools or alter permissions (those live in def.tools /
 * def.permission_policy).
 *
 * SEARCH ORDER (skills audit A28, 2026-10-16):
 *   1. <crowHome>/skills      — THIS instance's skills (crowHome defaults to
 *                               CROW_HOME, then ~/.crow)
 *   2. <checkout>/skills      — repo skills shipped with the RUNNING checkout
 *
 * There is no fallback to the primary instance's ~/.crow/skills any more. It
 * existed for the retired MPA, whose bots kept their skills in the primary's
 * dir; on a co-hosted instance (CROW_HOME=~/.crow-r4) it leaked the primary's
 * skills (Design kit, personal ones) into that instance's Bot Builder and
 * bots. The repo dir comes from this module's path, not a hard-coded
 * $HOME/crow. First match wins per name.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSkillName } from "./skill_proposals.mjs";
import { resolveCrowHome } from "../../servers/shared/crow-home.js";

/** The running checkout's shipped skills directory. */
export const REPO_SKILLS_DIR = resolve(fileURLToPath(new URL("../../skills", import.meta.url)));

/** Ordered, deduped skill directories for an instance. */
export function skillDirs(crowHome) {
  return [...new Set([join(crowHome || resolveCrowHome(), "skills"), REPO_SKILLS_DIR])];
}

/** Resolve one skill name to {name, path, text} or null (searched in order). */
export function resolveSkill(name, opts = {}) {
  const base = normalizeSkillName(name);
  if (!base) return null;
  const fname = base + ".md";
  for (const dir of skillDirs(opts.crowHome)) {
    const p = join(dir, fname);
    if (existsSync(p)) return { name, path: p, text: readFileSync(p, "utf8") };
  }
  return null;
}

/**
 * Resolve a list of skill names.
 * @returns {{ sections: Array<{name,path,text}>, missing: string[], dirs: string[] }}
 */
export function resolveSkills(names, opts = {}) {
  const sections = [];
  const missing = [];
  for (const name of names || []) {
    const r = resolveSkill(name, opts);
    if (r) sections.push(r);
    else missing.push(name);
  }
  return { sections, missing, dirs: skillDirs(opts.crowHome) };
}

/**
 * Convenience: the concatenated skill text (each section prefixed with the
 * same "\n\n" separator the bridge used when appending to the system prompt),
 * plus the list of names that could not be resolved (callers log these).
 * @returns {{ text: string, missing: string[] }}
 */
export function resolveSkillText(names, opts = {}) {
  const { sections, missing } = resolveSkills(names, opts);
  const text = sections.map((s) => "\n\n" + s.text).join("");
  return { text, missing };
}

// CLI: resolveSkillText <name[,name...]> [--crow-home <dir>]
if (import.meta.url === "file://" + process.argv[1]) {
  const a = process.argv.slice(2);
  const names = (a[0] || "").split(",").filter(Boolean);
  const chIdx = a.indexOf("--crow-home");
  const crowHome = chIdx >= 0 ? a[chIdx + 1] : process.env.CROW_HOME;
  const { sections, missing, dirs } = resolveSkills(names, { crowHome });
  console.error("search dirs: " + dirs.join(", "));
  for (const s of sections) console.error("resolved: " + s.name + " <- " + s.path);
  if (missing.length) console.error("MISSING: " + missing.join(", "));
  console.log(sections.map((s) => s.text).join("\n\n"));
  process.exit(missing.length ? 1 : 0);
}

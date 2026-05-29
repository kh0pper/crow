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
 * SEARCH ORDER (review finding A3 — must preserve existing behavior):
 *   1. <crowHome>/skills      — per-instance operator skills (MPA: ~/.crow-mpa/skills)
 *   2. ~/.crow/skills         — PRIMARY operator skills
 *   3. ~/crow/skills          — repo skills (shipped with Crow)
 *
 * The bridge previously hardcoded [~/.crow/skills, ~/crow/skills]. The MPA
 * bots that actually use skills (pir-portal-runner -> govqa-portal/oag-portal,
 * grackle -> household-kitchen) have those files in ~/.crow/skills (primary),
 * and ~/.crow-mpa/skills does not exist. Adding the per-instance dir FIRST
 * while KEEPING ~/.crow/skills (deduped) makes resolution instance-aware
 * without breaking any current injection. First match wins per name.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Ordered, deduped skill directories for an instance. */
export function skillDirs(crowHome) {
  const HOME = homedir();
  const dirs = [];
  if (crowHome) dirs.push(join(crowHome, "skills"));
  dirs.push(join(HOME, ".crow", "skills"));
  dirs.push(join(HOME, "crow", "skills"));
  return [...new Set(dirs)];
}

/** Resolve one skill name to {name, path, text} or null (searched in order). */
export function resolveSkill(name, opts = {}) {
  const fname = name.endsWith(".md") ? name : name + ".md";
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

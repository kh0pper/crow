#!/usr/bin/env node
/**
 * Crow Bot Builder — opt-in self-authoring skill proposals (Slice C).
 *
 * A self_authoring bot (permission_policy.self_authoring === true) may DRAFT a
 * new skill as ONE markdown file into a CONFINED staging dir:
 *
 *     <def.session_dir>/proposed-skills/<name>.md
 *
 * The file is INERT: skill_resolver loads skills only BY NAME from
 * skillDirs() = [<crowHome>/skills, ~/.crow/skills, ~/crow/skills], and the
 * staging dir is none of those. A proposal cannot load — and is not in
 * def.skills — until an OPERATOR approves it in the Bot Builder, which copies
 * the (operator-reviewed) text into ~/.crow/skills/<name>.md AND appends the
 * name to def.skills. Skills are PURE PROMPT TEXT: approval can never grant a
 * tool or change permission_policy (those come from def.tools /
 * def.permission_policy). The only residual risk is prompt-level guardrail
 * weakening at approval time — surfaced (never auto-acted) by
 * flagGuardrailPhrases() so the operator can edit before approving.
 *
 * This module is pure (node:fs/path/os only) and is consumed by bridge.mjs
 * (system-prompt block + staging dir, on the pi path) and the Bot Builder
 * panel + bot-board-api (operator review/approve/reject).
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** permission_policy.self_authoring default — opt-in, OFF by default. */
export const SELF_AUTHORING_DEFAULT = false;

/** The confined staging dir for a bot, keyed on its def.session_dir.
 *  Deterministic + project-workspace-INDEPENDENT: the bridge instructs the bot
 *  with this absolute path and the Bot Builder scans the same one. */
export function proposalsDir(sessionDir) {
  return join(String(sessionDir || ""), "proposed-skills");
}

/** Validate + normalize a proposed skill name to a safe kebab base (no .md, no
 *  path separators, no traversal). Returns the base or null if unusable. This
 *  is the ONLY name source for any write/delete path — never trust a raw
 *  on-disk filename. */
export function normalizeSkillName(raw) {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return null;
  if (s.toLowerCase().endsWith(".md")) s = s.slice(0, -3);
  s = s.toLowerCase();
  // Reject traversal / separators / anything outside the kebab charset, and
  // require a leading alphanumeric (matches the slug-hardening style used in
  // bot-board-api.js project/tracker slugs).
  if (s.includes("/") || s.includes("\\") || s.includes("..")) return null;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(s)) return null;
  if (s.length > 80) return null;
  return s;
}

/**
 * Guardrail-phrase heuristic (Q4). Returns [{label, snippet}] for phrasing that
 * could weaken a bot's safety posture if approved verbatim. ADVISORY ONLY —
 * surfaced to the operator in the approval UI; it never blocks or auto-edits.
 * The real protection is the operator gate + skills being prompt-text-only.
 */
export const GUARDRAIL_PATTERNS = Object.freeze([
  { label: "ignore/override prior instructions", re: /\b(ignore|disregard|override|forget)\b[^.\n]{0,40}\b(previous|prior|earlier|above|system|all)\b[^.\n]{0,20}\b(instruction|prompt|rule|polic)/i },
  { label: "bypass/skip a gate or policy", re: /\b(bypass|skip|circumvent|defeat|disable|turn off)\b[^.\n]{0,30}\b(gate|polic|permission|guardrail|confirmation|approval|safety|check)/i },
  { label: "act without confirmation", re: /\b(without|no|skip(ping)?|don'?t|do not)\b[^.\n]{0,20}\b(confirm|confirmation|ask(ing)?|approval|permission)\b/i },
  { label: "external send / publish", re: /\b(send|publish|post|email|e-mail|deliver)\b[^.\n]{0,30}\b(email|e-mail|message|externally|to the public|the post|gmail)\b/i },
  { label: "you may send (override draft_only)", re: /\byou (may|can|should|are allowed to)\b[^.\n]{0,20}\b(send|publish|post|email)\b/i },
  { label: "permission_policy / write_paths / external_send mutation", re: /\b(permission_policy|write_paths|external_send|bash_allow|self_authoring|multi_agent)\b/i },
  { label: "destructive shell", re: /\b(sudo\b|rm\s+-[a-z]*[rf]|mkfs|dd\s+if=|--no-preserve-root)/i },
  { label: "treat-as-exception phrasing", re: /\b(as an exception|just this once|in this case only|trust me|no need to (check|verify|ask))\b/i },
]);

export function flagGuardrailPhrases(text) {
  const t = String(text || "");
  const flags = [];
  for (const { label, re } of GUARDRAIL_PATTERNS) {
    const m = re.exec(t);
    if (m) {
      const i = Math.max(0, m.index - 24);
      const snippet = t.slice(i, m.index + m[0].length + 24).replace(/\s+/g, " ").trim();
      flags.push({ label, snippet });
    }
  }
  return flags;
}

/**
 * List the staged proposals for a bot's session dir.
 * @returns {Array<{name,path,text,mtime,flags}>} (empty if the dir is absent).
 * Only top-level *.md files are read; non-md files and subdirs are ignored.
 * `name` is the normalized base (entries that fail normalization are skipped —
 * they can never be approved anyway).
 */
export function listProposals(sessionDir) {
  const dir = proposalsDir(sessionDir);
  if (!sessionDir || !existsSync(dir)) return [];
  let entries = [];
  try { entries = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const fname of entries) {
    if (!fname.toLowerCase().endsWith(".md")) continue;
    const name = normalizeSkillName(fname);
    if (!name) continue;
    const p = join(dir, fname);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (!st.isFile()) continue;
    let text = "";
    try { text = readFileSync(p, "utf8"); } catch { continue; }
    out.push({ name, path: p, text, mtime: String(st.mtimeMs), flags: flagGuardrailPhrases(text) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** The system-prompt directive appended (by the bridge) for a self_authoring
 *  bot. Names the absolute staging dir; the propose→operator-approves
 *  contract; the inert-until-approved guarantee. */
export function selfAuthoringPromptBlock(stagingDir) {
  return [
    "## Self-authoring skills (opt-in, operator-gated)",
    "",
    "Your operator has enabled self-authoring. When you notice a recurring",
    "workflow that no existing skill covers — or the operator asks you to",
    "\"write a skill for X\" — you MAY PROPOSE a new skill by writing exactly ONE",
    "markdown file into your staging directory:",
    "",
    "    " + stagingDir + "/<kebab-case-name>.md",
    "",
    "Follow the skill-writing structure (Title, Description, When to Activate,",
    "Workflow, Tips). Use a clear kebab-case filename. Write ONLY into that",
    "staging directory — never into ~/.crow/skills or any other skills folder;",
    "you do not have permission to and it will be blocked.",
    "",
    "A proposed file is INERT: it does nothing and is not loaded by anyone until",
    "the operator reviews and approves it in the Bot Builder. After writing the",
    "file, tell the operator (in your gateway reply) that you drafted a skill",
    "proposal and it is awaiting their approval. Do not assume it is active.",
  ].join("\n");
}

// CLI for offline tests: list <sessionDir> | flag <file> | name <raw> | dir <sessionDir>
if (import.meta.url === "file://" + process.argv[1]) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "list") {
    const items = listProposals(arg);
    console.log(JSON.stringify(items.map((i) => ({ name: i.name, mtime: i.mtime, flags: i.flags })), null, 2));
    process.exit(0);
  }
  if (cmd === "flag") {
    const flags = flagGuardrailPhrases(readFileSync(arg, "utf8"));
    console.log(JSON.stringify(flags, null, 2));
    process.exit(flags.length ? 2 : 0);
  }
  if (cmd === "name") {
    const n = normalizeSkillName(arg);
    console.log(n == null ? "REJECT" : n);
    process.exit(n == null ? 1 : 0);
  }
  if (cmd === "dir") {
    console.log(proposalsDir(arg));
    process.exit(0);
  }
  console.error("usage: skill_proposals.mjs list <sessionDir> | flag <file> | name <raw> | dir <sessionDir>");
  process.exit(1);
}

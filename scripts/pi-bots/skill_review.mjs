#!/usr/bin/env node
/**
 * Crow Bot Builder — post-turn self-learning review (plan §B1/B2/B3).
 *
 * Crow's analogue of Hermes' agent/background_review.py: AFTER a turn completes,
 * optionally run a SECOND, cheap pi pass whose only job is "should any skill be
 * created or patched from what just happened?". It is fired fire-and-forget by
 * the bridge (never blocks the user's reply or the next turn) and is gated hard:
 *
 *   - mode: def.permission_policy.skill_learning ∈ off(default)|propose|auto.
 *   - IDLE-ONLY (review C1): spawns only when countLivePi() === 0, so the extra
 *     pi can never consume the last turn slot on Crow's 2-slot node. If the node
 *     is busy, the review is skipped silently (best-effort; a later idle turn
 *     learns instead).
 *   - DEFAULT model only (never escalation) to bound local compute.
 *   - OUT-OF-PROCESS reaper safe: the review pi is a normal `--mode rpc` child,
 *     so reapStalePi() (gateway_runner + gmail tick) culls it if it ever wedges;
 *     PiRpc.close() kills it on the happy path.
 *
 * The review pi is spawned with a MINIMAL tool set (read/write/list/glob/grep)
 * and write_paths confined to a throwaway review dir — no MCP, no bash, no
 * network (matches Hermes' "skill/memory tools only" whitelist). It writes at
 * most a few <skill-name>.md files into that dir; the bridge then routes each by
 * mode:
 *   propose → copy into the operator staging dir (inert until approved).
 *   auto    → guardrail-phrase HARD BLOCK ⇒ downgrade to a propose draft; size
 *             cap / skill-count cap ⇒ downgrade; otherwise promoteSkill(auto)
 *             (create new, or patch a skill THIS bot auto-authored). Any
 *             promote refusal (not-author/protected/exists) ⇒ downgrade.
 * Every outcome is recorded in bot_skill_events (provenance + null-project-safe
 * audit). PiRpc is imported LAZILY to avoid a static import cycle with bridge.mjs.
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { countLivePi } from "./pi_lifecycle.mjs";
import { resolveModel } from "./model_resolver.mjs";
import { resolveSkills } from "./skill_resolver.mjs";
import { proposalsDir, normalizeSkillName, flagGuardrailPhrases } from "./skill_proposals.mjs";
import { promoteSkill } from "./skill_promote.mjs";
import { recordSkillEvent, botAuthoredSkill, countAuthoredSkills } from "./skill_provenance.mjs";

const REVIEW_TIMEOUT_MS = Number(process.env.PIBOT_REVIEW_TIMEOUT_MS || 180000); // cheap, short
const MAX_AUTO_SKILLS = Number(process.env.PIBOT_MAX_AUTO_SKILLS || 12);          // B3 per-bot cap
const MAX_SKILL_BYTES = Number(process.env.PIBOT_MAX_SKILL_BYTES || 16000);       // B3 per-skill cap
const MAX_FILES_PER_REVIEW = Number(process.env.PIBOT_MAX_REVIEW_FILES || 3);     // bound output

// One-line description for the in-prompt skill index: first markdown heading or
// first non-empty line, trimmed. Keeps the review prompt small.
function describeSkill(text) {
  for (const raw of String(text || "").split("\n")) {
    const line = raw.replace(/^#+\s*/, "").trim();
    if (line) return line.slice(0, 100);
  }
  return "(no description)";
}

function buildSystemPrompt(def, crowHome, reviewDir) {
  const { sections } = resolveSkills(def.skills || [], { crowHome });
  const index = sections.length
    ? sections.map((s) => "  - " + s.name + ": " + describeSkill(s.text)).join("\n")
    : "  (this bot has no skills yet)";
  // Crow port of Hermes' _SKILL_REVIEW_PROMPT, condensed, with the anti-patterns
  // ported VERBATIM in spirit — those are what keep the library from filling with
  // junk. The file-writing contract replaces Hermes' skill_manage tool calls.
  return [
    "You are a SKILL-REVIEW pass for a Crow bot. You are NOT talking to a user.",
    "Look at the single turn transcript provided and decide whether the bot's",
    "skill library should gain or improve a skill so a FUTURE session handles",
    "this class of task better.",
    "",
    "This bot's current skills:",
    index,
    "",
    "Prefer the earliest action that fits:",
    "  1. IMPROVE AN EXISTING SKILL above — if one covers this territory, rewrite",
    "     its full content with the lesson folded in. Name the file EXACTLY that",
    "     skill's name so it patches in place.",
    "  2. CREATE A NEW class-level skill only if none fits. The name MUST be at the",
    "     class level (how to do a TYPE of task), kebab-case, and MUST NOT be a",
    "     one-session artifact (no dates, error strings, ticket numbers, codenames).",
    "",
    "DO NOT capture (these become self-imposed constraints that bite later):",
    "  - Environment-dependent failures: missing binaries, unconfigured creds,",
    "    'command not found', post-migration path mismatches. The operator fixes",
    "    these; they are not durable rules.",
    "  - Negative claims about tools ('X is broken', 'cannot use Y'). They harden",
    "    into refusals the bot cites against itself long after the issue is fixed.",
    "  - One-off task narratives. 'Summarize today's email' is not a skill.",
    "  - Transient errors that resolved before the turn ended. If a retry worked,",
    "    the lesson is the retry pattern, not the original failure.",
    "",
    "If something is worth saving, write EXACTLY ONE markdown file (you may write",
    "up to " + MAX_FILES_PER_REVIEW + ") into this directory:",
    "    " + reviewDir + "/<kebab-name>.md",
    "Use the skill structure (Title, Description, When to Activate, Workflow, Tips).",
    "Keep it under " + MAX_SKILL_BYTES + " bytes. Write ONLY into that directory.",
    "If nothing is worth saving, write NOTHING and reply 'Nothing to save.'",
  ].join("\n");
}

function buildPrompt(transcript) {
  const tools = (transcript.toolNames && transcript.toolNames.length)
    ? transcript.toolNames.join(", ") : "(none)";
  return [
    "TURN TRANSCRIPT to review:",
    "",
    "User said:",
    String(transcript.user || "").slice(0, 4000),
    "",
    "You (the bot) replied:",
    String(transcript.assistant || "").slice(0, 4000),
    "",
    "Tools used this turn: " + tools,
    "",
    "Decide per your instructions. Write a skill file only if it clears the bar;",
    "otherwise reply 'Nothing to save.' and write nothing.",
  ].join("\n");
}

// Plan §B2 guardrail #2: auto-mode is disallowed by default for HIGH-BLAST-RADIUS
// bots — those that can send externally unsupervised, run non-deny bash, or spawn
// sub-agents. For these, auto silently degrades to propose (operator-gated). An
// explicit per-bot override (skill_learning_auto_override:true) opts back in.
export function isHighBlastRadius(pp) {
  if (!pp) return false;
  const es = pp.external_send;
  if (es && es !== "draft_only" && es !== "deny") return true; // e.g. "allow"
  if (pp.bash && pp.bash !== "deny") return true;              // allowlist/sandbox/open
  if (pp.multi_agent === true) return true;
  return false;
}

// Route one review-written skill file by mode. Never throws. Exported for tests.
export function routeOne({ bot_id, def, crowHome, name, text, mode, model, log }) {
  const staging = proposalsDir(def.session_dir);
  const downgrade = (reason, flags) => {
    try {
      mkdirSync(staging, { recursive: true });
      writeFileSync(join(staging, name + ".md"), text, { mode: 0o600 });
    } catch (e) { log("downgrade write failed for '" + name + "': " + ((e && e.message) || e)); }
    recordSkillEvent({ bot_id, skill_name: name, action: "downgrade", mode, model, flags: flags || null });
    log("skill '" + name + "' downgraded to a propose draft (" + reason + ") — awaiting operator approval");
  };

  if (Buffer.byteLength(text, "utf8") > MAX_SKILL_BYTES) { downgrade("too-large"); return; }

  if (mode === "propose") {
    try {
      mkdirSync(staging, { recursive: true });
      writeFileSync(join(staging, name + ".md"), text, { mode: 0o600 });
      recordSkillEvent({ bot_id, skill_name: name, action: "propose", mode: "propose", model });
      log("skill '" + name + "' proposed — awaiting operator approval");
    } catch (e) { log("propose write failed for '" + name + "': " + ((e && e.message) || e)); }
    return;
  }

  // auto
  const flags = flagGuardrailPhrases(text);
  if (flags.length) { downgrade("guardrail-flags", flags); return; }
  const wouldCreate = !botAuthoredSkill(bot_id, name);
  if (wouldCreate && countAuthoredSkills(bot_id) >= MAX_AUTO_SKILLS) { downgrade("skill-cap"); return; }

  const r = promoteSkill({ bot_id, name, text, mode: "auto", model, crowHome });
  if (r.ok) { log("skill '" + name + "' auto-" + r.action + "ed into ~/.crow/skills"); return; }
  if (r.code === "not-author" || r.code === "protected" || r.code === "exists") { downgrade(r.code); return; }
  log("auto promote of '" + name + "' failed: " + r.code + " — " + r.message);
}

/**
 * Run the post-turn review. Fire-and-forget from the bridge (returns a promise
 * but the bridge does NOT await it). Never throws.
 * @param {{ bot_id, def, crowHome, sessionDir, transcript:{user,assistant,toolNames}, log? }} opts
 */
export async function runSkillReview(opts) {
  const { bot_id, def, crowHome, transcript } = opts;
  const log = opts.log || (() => {});
  let reviewDir = null;
  try {
    const pp = (def && def.permission_policy) || {};
    const requestedMode = pp.skill_learning;
    if (requestedMode !== "propose" && requestedMode !== "auto") return { skipped: "mode-off" };
    if (!def.session_dir) return { skipped: "no-session-dir" };
    // Guardrail #2: degrade auto -> propose for high-blast-radius bots (unless
    // the operator explicitly overrode). effectiveMode drives all routing below.
    let mode = requestedMode;
    if (mode === "auto" && isHighBlastRadius(pp) && pp.skill_learning_auto_override !== true) {
      mode = "propose";
      log("auto degraded to propose — high-blast-radius bot (external_send/bash/multi_agent)");
    }
    // IDLE-ONLY gate (C1): only when no pi is live, so we never take the last slot.
    if (countLivePi() !== 0) { log("skill-review skipped — node busy"); return { skipped: "busy" }; }

    reviewDir = mkdtempSync(join(tmpdir(), "pibot-review-"));
    mkdirSync(join(reviewDir, "sessions"), { recursive: true });
    const sysFile = join(reviewDir, "review-sys.md");
    writeFileSync(sysFile, buildSystemPrompt(def, crowHome, reviewDir), { mode: 0o600 });

    // DEFAULT model only (never escalation).
    const resolved = await resolveModel(def, { escalate: false });

    // Minimal review def: read/write/list/glob/grep, writes confined to reviewDir,
    // no crow_mcp (so no MCP servers, no crow.db touch). cwd=reviewDir means no
    // per-bot .mcp.json is present to auto-load.
    const reviewDef = {
      tools: { pi_builtin: ["read", "write", "list", "glob", "grep"] },
      permission_policy: { bash: "deny", write_paths: [reviewDir] },
      spawn_env: def.spawn_env,
    };

    const { PiRpc } = await import("./bridge.mjs"); // lazy — avoids static import cycle
    const pi = new PiRpc({ def: reviewDef, sessionDir: reviewDir, resolved, selfAuthoringDir: null,
      piSessionId: null, appendSystemPromptFile: sysFile });
    try {
      await pi.getState().catch(() => null);
      await pi.prompt(buildPrompt(transcript), REVIEW_TIMEOUT_MS);
    } finally {
      await pi.close();
    }

    // Process whatever the review wrote (cap the count).
    const files = readdirSync(reviewDir).filter((f) => f.toLowerCase().endsWith(".md") && f !== "review-sys.md");
    let processed = 0;
    for (const f of files.slice(0, MAX_FILES_PER_REVIEW)) {
      const name = normalizeSkillName(f);
      if (!name) { log("review wrote unusable filename '" + f + "' — ignored"); continue; }
      let text = "";
      try { text = readFileSync(join(reviewDir, f), "utf8"); } catch { continue; }
      if (!text.trim()) continue;
      routeOne({ bot_id, def, crowHome, name, text, mode, model: resolved.key, log });
      processed++;
    }
    if (!processed) log("skill-review: nothing to save");
    return { ok: true, processed };
  } catch (e) {
    log("skill-review error: " + ((e && e.message) || e));
    return { error: String((e && e.message) || e) };
  } finally {
    if (reviewDir && existsSync(reviewDir)) { try { rmSync(reviewDir, { recursive: true, force: true }); } catch {} }
  }
}

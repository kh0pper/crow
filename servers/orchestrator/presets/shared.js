import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __sharedDir = dirname(fileURLToPath(import.meta.url));

// Phase 8.6 (2026-05-12) — ATS platforms registry loaded at module load.
// Edit ats_platforms.json + restart crow-mpa-gateway to pick up changes.
export const ATS_PLATFORMS_JSON = readFileSync(
  join(__sharedDir, "..", "ats_platforms.json"),
  "utf8",
);

// Phase 9.6 (2026-05-13) — user writing voice rules.
// Sourced from ~/spring-2026/.claude/skills/{sending-email,drafting-essays}/SKILL.md
// and ~/spring-2026/CLAUDE.md "Writing Style" section. ANY preset whose agent
// composes prose addressed to a human (the user OR an external recipient
// like TEA, ISD, AG, employer) must include this block in its systemPrompt.
// Append to the existing prompt via string concatenation; the rules are
// terminal — nothing else should override them.
export const WRITING_VOICE_RULES =
  "\n\n=== USER WRITING VOICE — APPLY TO ALL DRAFTED PROSE ===\n" +
  "(Source: ~/spring-2026/.claude/skills/sending-email and drafting-essays. These " +
  "rules override any default LLM email phrasings. Violations make the email " +
  "obviously bot-written and the user will reject the draft.)\n\n" +

  "ABSOLUTE BANS:\n" +
  "  - NO em dashes (—, –). Use commas, semicolons, periods, or parentheses.\n" +
  "  - NO hedging: 'I think', 'I feel', 'I believe', 'perhaps', 'I would', " +
  "'may', 'might', 'could potentially'. State positions directly.\n" +
  "  - NO rhetorical questions. State the claim.\n" +
  "  - NO 'Furthermore', 'Moreover', 'Additionally'. Use 'However', " +
  "'In addition to', 'Beyond', 'Building on this'.\n" +
  "  - NO banned vocabulary: 'crucial', 'pivotal', 'comprehensive', " +
  "'facilitate', 'leverage', 'utilize', 'paramount', 'robust' (when filler), " +
  "'fundamental' (when filler), 'navigate' (when figurative). Plain alternatives " +
  "always.\n" +
  "  - NO throat-clearing openers ('I hope this finds you well', 'I am writing " +
  "to follow up on...'). Open with the substance or a brief thank-you.\n" +
  "  - NO research process / methodology / inner monologue when writing to " +
  "EXTERNAL recipients (TEA, ISDs, AG, employers). Never disclose analytical " +
  "frameworks, regression models, or insider methodology.\n\n" +

  "EMAIL FORMAT (when composing an email body):\n" +
  "  - Keep it short: one acknowledgment / thank-you paragraph, then numbered " +
  "asks if any. State what is still needed, not what was already received.\n" +
  "  - Each paragraph is ONE long line. NO mid-sentence hard wraps at 70/80 " +
  "chars (Gmail wraps for you). Paragraphs separated by \\n\\n.\n" +
  "  - Signature block (only for personal messages addressed to external " +
  "recipients; bot digests to the user don't need a signature):\n" +
  "      Best,\\n" +
  "      Kevin Hopper\\n" +
  "      kevin.hopper1@gmail.com\n\n" +

  "TONE:\n" +
  "  - Assertive and direct. State positions without hedging.\n" +
  "  - Short declarative sentences. One idea per sentence.\n" +
  "  - Engage as a peer, not deferentially.\n" +
  "  - For PIR follow-ups: cite the statutory deadline (10 business days under " +
  "Tex. Gov't Code Ch. 552) when the entity has missed it. Don't ask politely; " +
  "state the deadline is past and request the timeline.\n" +
  "=== END WRITING VOICE RULES ===\n";

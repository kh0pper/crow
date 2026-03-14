#!/usr/bin/env node

/**
 * Sync Skills Reference — Scans skills/*.md and auto-generates the tables in docs/skills/index.md.
 *
 * Usage: npm run sync-skills
 *
 * Reads each skill file's YAML frontmatter (name, description) or first heading,
 * then regenerates the Core Skills, Platform Skills, Integration Skills, and Developer Skills
 * tables in docs/skills/index.md.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SKILLS_DIR = join(__dirname, "..", "skills");
const DOCS_FILE = join(__dirname, "..", "docs", "skills", "index.md");

// Classification of skills into categories
const CORE_SKILLS = new Set([
  "superpowers", "memory-management", "research-pipeline", "session-context",
  "plan-review", "session-summary", "reflection", "skill-writing", "i18n",
]);

const PLATFORM_SKILLS = new Set([
  "crow-context", "safety-guardrails", "ideation", "blog", "podcast", "storage",
  "sharing", "social", "peer-network", "onboarding", "onboarding-tour",
  "data-backends", "add-ons", "network-setup", "scheduling", "tutoring",
  "backup", "bug-report", "context-management",
]);

const DEVELOPER_SKILLS = new Set([
  "crow-developer",
]);

// Everything else is an integration skill

function parseSkillFile(filePath) {
  const content = readFileSync(filePath, "utf-8");
  const fileName = basename(filePath, ".md");

  // Try YAML frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  let name = fileName;
  let description = "";

  if (fmMatch) {
    const fm = fmMatch[1];
    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    const descMatch = fm.match(/^description:\s*(.+)$/m);
    if (nameMatch) name = nameMatch[1].trim();
    if (descMatch) description = descMatch[1].trim();
  }

  // Fallback: use first heading
  if (!description) {
    const headingMatch = content.match(/^#\s+(.+)$/m);
    if (headingMatch) {
      // Use the second line after heading as description
      const afterHeading = content.split(headingMatch[0])[1];
      const descLine = afterHeading?.split("\n").find((l) => l.trim() && !l.startsWith("#"));
      if (descLine) description = descLine.trim().replace(/^[-*]\s*/, "").substring(0, 120);
    }
  }

  // Title-case the name for display
  const displayName = name
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  return { fileName, name, displayName, description };
}

function generateTable(skills) {
  const header = "| Skill | File | Purpose |\n|---|---|---|";
  const rows = skills
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map((s) => `| **${s.displayName}** | \`${s.fileName}.md\` | ${s.description} |`);
  return [header, ...rows].join("\n");
}

// Main
const files = readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md"));
const skills = files.map((f) => parseSkillFile(join(SKILLS_DIR, f)));

const core = skills.filter((s) => CORE_SKILLS.has(s.fileName));
const platform = skills.filter((s) => PLATFORM_SKILLS.has(s.fileName));
const developer = skills.filter((s) => DEVELOPER_SKILLS.has(s.fileName));
const integration = skills.filter(
  (s) => !CORE_SKILLS.has(s.fileName) && !PLATFORM_SKILLS.has(s.fileName) && !DEVELOPER_SKILLS.has(s.fileName)
);

const output = `# Skills

Skills are markdown files in \`skills/\` that define behavioral prompts for the AI assistant. They're not code — they describe workflows, trigger patterns, and integration logic that Claude loads on demand.

## Core Skills

${generateTable(core)}

## Platform Skills

${generateTable(platform)}

## Integration Skills

${generateTable(integration)}

## Developer Skills

${generateTable(developer)}

## How Skills Work

1. **Trigger**: The \`superpowers.md\` skill has a trigger table that maps user intent phrases to skill activations
2. **Activate**: When a match is found, the relevant skill file is loaded
3. **Execute**: The skill defines the workflow — which tools to use, in what order, and how to handle results
4. **Surface**: Skill activations are shown to the user: *[crow: activated skill — research-pipeline.md]*

## Compound Workflows

Skills can combine to handle complex requests:

- **"Daily briefing"** → Gmail + Calendar + Slack + Trello + Memory
- **"Start research on X"** → Memory + Projects + Brave Search + arXiv + Zotero
- **"Prepare for meeting"** → Calendar + Gmail + Memory + Research + Slack
- **"Publish my research"** → Projects + Blog + Storage (upload images)
- **"Set up file sharing"** → Storage + Sharing + Peer Network

## Creating New Skills

Skills are plain markdown. To add a new one:

1. Create \`skills/your-skill.md\` with description, triggers, and workflow
2. Add a row to the trigger table in \`skills/superpowers.md\`
3. Run \`npm run sync-skills\` to update this page
4. The skill will be available immediately — no build step needed
`;

writeFileSync(DOCS_FILE, output);
console.log(`Synced ${skills.length} skills to ${DOCS_FILE}`);
console.log(`  Core: ${core.length}, Platform: ${platform.length}, Integration: ${integration.length}, Developer: ${developer.length}`);

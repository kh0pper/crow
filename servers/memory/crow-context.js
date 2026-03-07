/**
 * Crow Context Generator
 *
 * Assembles the crow.md document from structured sections in the database,
 * optionally injecting dynamic data (memory stats, active projects, etc.).
 *
 * Used by:
 * - MCP tools (crow_get_context)
 * - MCP resource (crow://context)
 * - HTTP endpoint (GET /crow.md)
 */

/** Section keys that cannot be deleted (only updated or disabled) */
export const PROTECTED_SECTIONS = [
  "identity",
  "memory_protocol",
  "research_protocol",
  "session_protocol",
  "transparency_rules",
  "skills_reference",
  "key_principles",
];

/**
 * Generate the full crow.md document.
 *
 * @param {import("@libsql/client").Client} db
 * @param {object} options
 * @param {boolean} [options.includeDynamic=true] - Include dynamic data sections
 * @param {string} [options.platform="generic"] - Target platform hint
 * @returns {Promise<string>} Assembled markdown document
 */
export async function generateCrowContext(db, { includeDynamic = true, platform = "generic" } = {}) {
  let sections;

  try {
    const result = await db.execute(
      "SELECT * FROM crow_context WHERE enabled = 1 ORDER BY sort_order ASC, id ASC"
    );
    sections = result.rows;
  } catch {
    // Table doesn't exist — return static fallback
    return getFallbackDocument();
  }

  if (!sections || sections.length === 0) {
    return getFallbackDocument();
  }

  // Assemble static sections
  const parts = ["# crow.md — Cross-Platform Behavioral Context\n"];

  for (const section of sections) {
    parts.push(`## ${section.section_title}\n`);

    let content = section.content;

    // Inject platform-specific transparency formatting hint
    if (section.section_key === "transparency_rules" && platform !== "generic") {
      content += getPlatformHint(platform);
    }

    parts.push(content);
    parts.push(""); // blank line between sections
  }

  // Dynamic sections
  if (includeDynamic) {
    const dynamicContent = await generateDynamicSections(db);
    if (dynamicContent) {
      parts.push("## Current Context (Dynamic)\n");
      parts.push(dynamicContent);
    }
  }

  parts.push(`---\n*Generated: ${new Date().toISOString()}*`);

  return parts.join("\n");
}

/**
 * Generate dynamic data sections from live database content.
 */
async function generateDynamicSections(db) {
  const lines = [];

  try {
    // Memory stats by category
    const { rows: catStats } = await db.execute(
      "SELECT category, COUNT(*) as count FROM memories GROUP BY category ORDER BY count DESC"
    );
    if (catStats.length > 0) {
      lines.push("### Memory Overview");
      const total = catStats.reduce((sum, r) => sum + Number(r.count), 0);
      lines.push(`Total memories: **${total}**\n`);
      lines.push(catStats.map((r) => `- ${r.category}: ${r.count}`).join("\n"));
      lines.push("");
    }

    // User preferences (high importance)
    const { rows: prefs } = await db.execute(
      "SELECT substr(content, 1, 200) as preview FROM memories WHERE category = 'preference' AND importance >= 8 ORDER BY updated_at DESC LIMIT 10"
    );
    if (prefs.length > 0) {
      lines.push("### Key Preferences");
      lines.push(prefs.map((r) => `- ${r.preview}`).join("\n"));
      lines.push("");
    }

    // Active research projects
    const { rows: projects } = await db.execute(
      "SELECT name, description, (SELECT COUNT(*) FROM research_sources WHERE project_id = research_projects.id) as source_count, (SELECT COUNT(*) FROM research_notes WHERE project_id = research_projects.id) as note_count FROM research_projects WHERE status = 'active' ORDER BY updated_at DESC LIMIT 5"
    );
    if (projects.length > 0) {
      lines.push("### Active Research Projects");
      for (const p of projects) {
        lines.push(`- **${p.name}**${p.description ? ` — ${p.description}` : ""} (${p.source_count} sources, ${p.note_count} notes)`);
      }
      lines.push("");
    }

    // Recent important memories
    const { rows: recent } = await db.execute(
      "SELECT substr(content, 1, 150) as preview, category, importance FROM memories WHERE importance >= 8 ORDER BY created_at DESC LIMIT 5"
    );
    if (recent.length > 0) {
      lines.push("### Recent Important Memories");
      lines.push(recent.map((r) => `- [${r.category}, imp:${r.importance}] ${r.preview}`).join("\n"));
      lines.push("");
    }
  } catch {
    // If any query fails (e.g. tables don't exist), skip dynamic sections
    return null;
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Platform-specific transparency formatting hints.
 */
function getPlatformHint(platform) {
  const hints = {
    claude: "\n\n> **Platform note (Claude):** Use *italic* for Tier 1 FYI lines and **bold** for Tier 2 checkpoints.",
    chatgpt: "\n\n> **Platform note (ChatGPT):** Use [bracketed text] for both Tier 1 and Tier 2 transparency markers.",
    gemini: "\n\n> **Platform note (Gemini):** Use [bracketed text] for both Tier 1 and Tier 2 transparency markers.",
    grok: "\n\n> **Platform note (Grok):** Use [bracketed text] for both Tier 1 and Tier 2 transparency markers.",
    cursor: "\n\n> **Platform note (Cursor/IDE):** Minimize transparency output. Only show Tier 2 checkpoints as brief comments.",
    windsurf: "\n\n> **Platform note (Windsurf/IDE):** Minimize transparency output. Only show Tier 2 checkpoints as brief comments.",
    cline: "\n\n> **Platform note (Cline/IDE):** Minimize transparency output. Only show Tier 2 checkpoints as brief comments.",
  };
  return hints[platform.toLowerCase()] || "";
}

/**
 * Static fallback when crow_context table doesn't exist.
 */
function getFallbackDocument() {
  return `# crow.md — Cross-Platform Behavioral Context

## Setup Required

The crow.md context system has not been initialized yet. Run:

\`\`\`bash
npm run init-db
\`\`\`

This will create the \`crow_context\` table and seed it with default behavioral sections.

Once initialized, you can:
- Read this document via the \`crow_get_context\` tool or \`crow://context\` resource
- Customize sections with \`crow_update_context_section\`
- Add custom sections with \`crow_add_context_section\`

---
*Generated: ${new Date().toISOString()}*
`;
}

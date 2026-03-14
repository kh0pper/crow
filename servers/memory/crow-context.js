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
 * @param {string} [options.deviceId=null] - Device ID for per-device overrides (null = global only)
 * @returns {Promise<string>} Assembled markdown document
 */
export async function generateCrowContext(db, { includeDynamic = true, platform = "generic", deviceId = null } = {}) {
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

  // Merge global + device-specific sections (device overrides global for same section_key)
  sections = mergeDeviceSections(sections, deviceId);

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
 * Merge global and device-specific context sections.
 *
 * Global sections have device_id = NULL. Device-specific sections override
 * global sections with the same section_key. Device-only sections (no global
 * counterpart) are appended at the end.
 *
 * @param {Array} sections - All sections (global + device-specific)
 * @param {string|null} deviceId - Target device ID, or null for global only
 * @returns {Array} Merged sections
 */
function mergeDeviceSections(sections, deviceId) {
  if (!deviceId) {
    // No device specified — return only global sections
    return sections.filter((s) => !s.device_id);
  }

  const globalSections = new Map();
  const deviceSections = new Map();

  for (const section of sections) {
    if (!section.device_id) {
      globalSections.set(section.section_key, section);
    } else if (section.device_id === deviceId) {
      deviceSections.set(section.section_key, section);
    }
    // Sections for other devices are ignored
  }

  // Start with global sections, override with device-specific
  const merged = [];
  for (const [key, section] of globalSections) {
    merged.push(deviceSections.has(key) ? deviceSections.get(key) : section);
  }

  // Append device-only sections (no global counterpart)
  for (const [key, section] of deviceSections) {
    if (!globalSections.has(key)) {
      merged.push(section);
    }
  }

  return merged;
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
 * Generate a condensed version of crow.md for MCP instructions field.
 *
 * Extracts the 5 most critical sections (identity, memory_protocol,
 * session_protocol, transparency_rules, skills_reference), condenses
 * each to essential content, and returns a ~1.5KB string with generic
 * [bracket] formatting suitable for any platform.
 *
 * @param {import("@libsql/client").Client} db
 * @param {object} [options]
 * @param {boolean} [options.routerStyle=false] - Use category tool names for router endpoint
 * @param {string} [options.deviceId=null] - Device ID for per-device overrides
 * @returns {Promise<string|null>} Condensed context or null if unavailable
 */
export async function generateCondensedContext(db, { routerStyle = false, deviceId = null } = {}) {
  const essentialKeys = [
    "identity",
    "memory_protocol",
    "session_protocol",
    "transparency_rules",
    "skills_reference",
  ];

  let sections;
  try {
    const result = await db.execute({
      sql: "SELECT section_key, section_title, content, device_id FROM crow_context WHERE enabled = 1 AND section_key IN (?, ?, ?, ?, ?) ORDER BY sort_order ASC",
      args: essentialKeys,
    });
    sections = result.rows;
  } catch {
    return null;
  }

  if (!sections || sections.length === 0) {
    return null;
  }

  // Merge global + device-specific sections
  sections = mergeDeviceSections(sections, deviceId);

  const parts = ["Crow — Behavioral Context\n"];

  for (const section of sections) {
    // Condense each section to its most essential content
    const condensed = condenseSection(section.section_key, section.content, { routerStyle });
    if (condensed) {
      parts.push(condensed);
    }
  }

  parts.push("\nUse the session-start or crow-guide prompts for full guidance.");

  return parts.join("\n");
}

/**
 * Extract a condensed skill routing table from the skills_reference content.
 * Parses the markdown table in the DB content and produces a compact string.
 */
function extractSkillRouting(content) {
  if (!content) return "";

  // Try to extract rows from a markdown table (| intent | capability | tools |)
  const tableRows = content
    .split("\n")
    .filter((l) => l.startsWith("|") && !l.startsWith("|---") && !l.startsWith("| User"))
    .map((l) =>
      l
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean)
    )
    .filter((cols) => cols.length >= 2);

  if (tableRows.length > 0) {
    // Condense to: Skills: "intent" → capability, ...
    const pairs = tableRows
      .slice(0, 12) // cap at 12 rows to stay within budget
      .map((cols) => `${cols[0]} → ${cols[1]}`)
      .join(", ");
    return `Skills: ${pairs}`;
  }

  // Fallback: return first 200 chars of content
  return content.slice(0, 200);
}

/**
 * Condense a section to its essential content for the instructions field.
 */
function condenseSection(key, content, { routerStyle = false } = {}) {
  if (!content) return null;

  // Extract first meaningful paragraph or key lines
  const lines = content.split("\n").filter((l) => l.trim());

  switch (key) {
    case "identity":
      // First 2 sentences
      return lines.slice(0, 2).join(" ").slice(0, 200);

    case "session_protocol":
      // Extract the session-start action items
      return "Session protocol: On session start, call crow_recall_by_context with the user's first message. On session end, store important learnings with crow_store_memory.";

    case "memory_protocol":
      // Core memory rules
      return "Memory: Categories: general, project, preference, person, process, decision, learning, goal. Importance 1-10 (8+ = high priority). Search before storing duplicates. Update existing memories when information changes.";

    case "transparency_rules":
      // Generic bracket format (works on all platforms)
      return "Transparency: Show [crow: action] notes for autonomous actions (Tier 1). Ask before high-impact actions like deleting memories or sharing data (Tier 2).";

    case "skills_reference": {
      // Condensed intent-to-skill routing + tool capabilities
      // Extract trigger table from DB content if available, otherwise use defaults
      const skillRouting = extractSkillRouting(content);
      if (routerStyle) {
        return `Capabilities: crow_memory (store/search/recall memories), crow_projects (projects/sources/citations/data backends), crow_blog (create/publish posts), crow_sharing (P2P sharing/messaging), crow_storage (file upload/download), crow_tools (external integrations). Use crow_discover for full action schemas.\n${skillRouting}`;
      }
      return `Capabilities: Memory (crow_store_memory, crow_search_memories, crow_recall_by_context), Projects (crow_create_project, crow_add_source, crow_generate_bibliography, crow_register_backend), Blog (crow_create_post, crow_publish_post), Sharing (crow_generate_invite, crow_share, crow_send_message), Storage (crow_upload_file, crow_list_files).\n${skillRouting}`;
    }

    default:
      return lines.slice(0, 2).join(" ").slice(0, 150);
  }
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

/**
 * Bot Builder — creation templates (data, not code). Item 5 PR1, spec §D2.
 *
 * Consumed by the guided-creation wizard: a template preselects the channel
 * type and overlays tools/skills/tracker/system_prompt onto
 * defaultDefinition(). Card copy lives in i18n (botbuilder.tpl_<id>_title /
 * _desc / _needs); system_prompt stays EN by design (model-facing text the
 * operator can edit afterward, not UI copy).
 *
 * Resilience (spec §D2): tools.crow_mcp additions are filtered at apply time
 * against the live probe surface and skills against loadSkills() — a missing
 * server/tool/skill is dropped silently. A template can never make creation
 * fail. Permission policy is never overlaid: every template inherits
 * defaultDefinition()'s safe defaults.
 */

export const BOT_TEMPLATES = [
  {
    id: "personal-assistant",
    gwType: "crow-messages",
    tools: {
      crow_mcp: [
        "crow-memory/crow_search_memories",
        "crow-memory/crow_store_memory",
        "crow-memory/crow_recall_by_context",
      ],
    },
    skills: [],
    tracker: "none",
    system_prompt:
      "You are a helpful personal assistant. Answer questions, help with " +
      "planning and writing, and remember useful facts the user shares " +
      "(store them with your memory tools, and search them before answering " +
      "questions about past conversations). Be concise and friendly. If you " +
      "are unsure, say so rather than guessing.",
  },
  {
    id: "email-responder",
    gwType: "gmail",
    tools: {},
    skills: [],
    tracker: "none",
    system_prompt:
      "You are a polite email assistant. Read each incoming email carefully " +
      "and write a clear, courteous reply. Keep replies short and helpful. " +
      "If a request needs the owner's personal decision, say the owner will " +
      "follow up, and summarize what is being asked. Never invent facts, " +
      "commitments, or prices.",
  },
  {
    id: "discord-qa",
    gwType: "discord",
    tools: {},
    skills: [],
    tracker: "none",
    system_prompt:
      "You are a friendly community Q&A helper in a Discord server. Answer " +
      "questions clearly and briefly, in a casual tone. If a question has " +
      "been answered in the conversation already, point to that answer. If " +
      "you do not know, say so and suggest where to look. Never share " +
      "private information.",
  },
  {
    id: "project-manager",
    gwType: "none",
    tools: {},
    skills: [],
    tracker: "kanban",
    system_prompt:
      "You are a project assistant working a task board. For each task you " +
      "are given: read it, do the work or draft what is needed, record the " +
      "result, and move the task forward (pending, in progress, done) with " +
      "your task tools. Give a short status summary when asked. One task at " +
      "a time.",
  },
  {
    id: "blank",
    gwType: "none",
    tools: {},
    skills: [],
    // tracker undefined = leave tracker_config untouched (absent == implicit
    // kanban everywhere it's read) — full parity with quick create.
    // Empty prompt = keep defaultDefinition()'s stock prompt, same reason.
    system_prompt: "",
  },
];

export function getTemplate(id) {
  return BOT_TEMPLATES.find((tp) => tp.id === id) || null;
}

/**
 * Build the Set of available "server/tool" keys from a probeAll() result.
 * On {_error} (e.g. no canonical ~/.pi/agent/mcp.json on a fresh install)
 * returns an empty set — the filter then drops ALL template additions and
 * the bot keeps only defaultDefinition()'s baked preset, which is exactly
 * what plain create produces (spec §D2 probe semantics).
 */
export function availableMcpSet(probe) {
  const out = new Set();
  if (!probe || probe._error) return out;
  for (const srv of Object.keys(probe)) {
    const p = probe[srv];
    if (!p || !p.ok || !Array.isArray(p.tools)) continue;
    for (const tool of p.tools) out.add(`${srv}/${tool.name}`);
  }
  return out;
}

/**
 * Overlay a template onto a freshly-built defaultDefinition() object.
 * Mutates and returns def. Filtering rules per spec §D2.
 *
 * @param {object} def - defaultDefinition() output
 * @param {object} tpl - a BOT_TEMPLATES entry
 * @param {{availableMcp: Set<string>, availableSkills: string[]}} ctx
 */
export function applyTemplate(def, tpl, { availableMcp, availableSkills }) {
  if (!tpl) return def;
  const addMcp = ((tpl.tools && tpl.tools.crow_mcp) || []).filter((k) => availableMcp.has(k));
  if (addMcp.length) {
    def.tools.crow_mcp = [...new Set([...(def.tools.crow_mcp || []), ...addMcp])];
  }
  const skillSet = new Set(availableSkills || []);
  const addSkills = (tpl.skills || []).filter((s) => skillSet.has(s));
  if (addSkills.length) {
    def.skills = [...new Set([...(def.skills || []), ...addSkills])];
    def.tools.skills = def.skills;
  }
  // tracker: "kanban"/"none" set explicitly; undefined leaves the def alone.
  if (tpl.tracker) {
    def.tracker_config = { ...(def.tracker_config || {}), type: tpl.tracker };
  }
  if (tpl.system_prompt) def.system_prompt = tpl.system_prompt;
  return def;
}

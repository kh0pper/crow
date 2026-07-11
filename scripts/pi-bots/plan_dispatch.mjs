// scripts/pi-bots/plan_dispatch.mjs
// Pure helpers for board plan dispatch (Plan 1 Task 7). The planning model
// ends its reply with exactly one `PLAN_FILE: <relative path>` line; we take
// the LAST well-formed occurrence and refuse absolute/traversal paths (the
// same rules parsePlanRef enforces when the ref is stored).
export function extractPlanFileLine(text) {
  const matches = [...String(text || "").matchAll(/^PLAN_FILE:\s*(.+?)\s*$/gm)];
  if (!matches.length) return null;
  const p = matches[matches.length - 1][1];
  if (!p || p.startsWith("/") || p.split("/").includes("..")) return null;
  return p;
}

export function buildPlanPrompt(card, plansDir) {
  return (
    "You are the PLANNING model for a kanban card. Explore this repository " +
    "READ-ONLY and produce an implementation plan.\n\n" +
    "CARD #" + card.id + ": " + (card.title || "(untitled)") + "\n" +
    (card.description ? "DESCRIPTION:\n" + card.description + "\n" : "") + "\n" +
    "Write the plan as a markdown file under " + plansDir + "/ named " +
    "<YYYY-MM-DD>-card-" + card.id + "-<short-slug>.md (create the directory if needed). " +
    "The plan must contain numbered steps with exact file paths, code-level detail, and a " +
    "testing section. Do NOT modify any file outside " + plansDir + "/ and docs/.\n\n" +
    "End your reply with exactly one line:\nPLAN_FILE: <path relative to the repository root>"
  );
}

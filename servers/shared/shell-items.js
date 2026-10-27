// servers/shared/shell-items.js — the pure rules for which project a shell item (a Perch thread,
// an artifact, a Workspace file) belongs to. No I/O here: callers hand in the facts.

// A project an item may be filed under: not archived, not a learner profile. Used as a SQL
// fragment against project_spaces (the 0010 backfill, and the readers that follow it).
export const ACTIVE_PROJECT_WHERE = "archived_at IS NULL AND status != 'archived' AND (type IS NULL OR type != 'learner_profile')";

function firstLive(candidates, liveProjectIds) {
  for (const c of candidates) {
    if (c !== null && c !== undefined && liveProjectIds.has(Number(c))) return Number(c);
  }
  return null;
}

/** The thread's card's project, else the session's, else the bot's — the first that is still live. */
export function deriveThreadProject({ cardProjectId, sessionProjectId, botProjectId, liveProjectIds }) {
  return firstLive([cardProjectId, sessionProjectId, botProjectId], liveProjectIds);
}

/** The origin card's project, else the origin thread's, else the creating bot's — the first still live. */
export function deriveArtifactProject({ cardProjectId, threadProjectId, botProjectId, liveProjectIds }) {
  return firstLive([cardProjectId, threadProjectId, botProjectId], liveProjectIds);
}

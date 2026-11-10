/**
 * Fix-it detector: data backends whose approval predates keyed approvals.
 *
 * An `mcp_server` data backend is a command the gateway runs, and the owner's
 * approval is stored in the same crow.db row it approves. Older versions stored
 * a plain SHA-256 there — a value anyone who can write crow.db can recompute —
 * so those rows prove nothing. The gateway stops every one of them and the
 * owner approves them again on the Projects page (which writes the keyed form).
 * This card says how many are waiting, once, so the owners of older installs do
 * not lose a backend's tools without being told why.
 *
 * No event fires for a database row, so this is a BOOT check: fix-it/index.js's
 * runBootChecks() calls `check()` once per gateway start, and the card resolves
 * itself once nothing is left to re-approve.
 */
import { isLegacyApproval } from "../../../shared/data-backend-approval.js";

export const SOURCE = "data-backend-reapproval";
export const DEDUP_KEY = "data-backend:legacy-approval";
/** Where the owner re-approves a backend (the Projects panel's route). */
export const PROJECTS_URL = "/dashboard/projects";

export const TITLE = "Data backends need approving again";

/** The card's body, with the number of backends waiting. */
export function bodyText(count) {
  const n = Number(count) || 0;
  return `${n} data backend(s) were approved before Crow protected approvals with a key kept outside its database. `
    + "They stay stopped until you approve them again on the Projects page.";
}

/** How many mcp_server rows carry the old bare-hash approval. */
export async function countLegacyApprovals(db) {
  if (!db || typeof db.execute !== "function") return 0;
  const { rows } = await db.execute({
    sql: "SELECT approved_ref_sha256 FROM data_backends WHERE backend_type = 'mcp_server' AND approved_ref_sha256 IS NOT NULL",
    args: [],
  });
  return (rows || []).filter((r) => isLegacyApproval(r)).length;
}

export default {
  source: SOURCE,
  // A database row emits no event: runBootChecks() calls check() at gateway start.
  events: [],
  async onEvent() {},
  /**
   * Upsert one card while any legacy approval is left, RESOLVE it once there
   * are none. Never throws into boot (runBootChecks isolates a detector).
   */
  async check(store, opts = {}) {
    const count = await countLegacyApprovals(opts.db || store?.db);
    if (count === 0) {
      try { await store.resolveByKey(SOURCE, DEDUP_KEY); } catch { /* no row yet, or no store */ }
      return null;
    }
    await store.upsertItem({
      source: SOURCE,
      dedupKey: DEDUP_KEY,
      title: TITLE,
      why: bodyText(count),
      severity: "warn",
      // A link, not a POST: the owner approves on the Projects page, where the
      // command is shown in full. handleFixItAction refuses a non-instant entry,
      // so this actionId can never be executed as one.
      remedies: [{ actionId: "open-projects-page", kind: "link", label: "Open the Projects page", href: PROJECTS_URL }],
      context: { legacyApprovals: count, projectsUrl: PROJECTS_URL },
    });
    return { count };
  },
};
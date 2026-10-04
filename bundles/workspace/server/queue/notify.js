/** Spec §5.9: one Crow notification per queue event (type system, action_url → Office › Quick edit for the file). Never throws. */
import { appImport } from "../app-root.js";

const base = (r) => String(r.path || "").split("/").pop();
const names = (r) => { try { return JSON.parse(r.open_by_json || "[]").join(", "); } catch { return ""; } };
const TITLES = {
  queued: (r) => `Crow has a change waiting for ${base(r)}${names(r) ? ` (open by ${names(r)})` : ""}`,
  applied_live: (r) => `Crow's change to ${base(r)} was applied`,
  applied_close: (r) => `Crow's change to ${base(r)} was applied`,
  failed: (r) => `Crow's change to ${base(r)} could not be applied`,
  expired: (r) => `Crow's change to ${base(r)} expired`,
};
const REASONS = {
  target_changed: "the text or cells it was meant to change are different now",
  changed_since: "the file changed after that edit, so it was not undone",
  ambiguous: "Crow could not tell whether it was already applied in the editor, so it did not apply it again",
  not_saved: "it was applied in the editor but is not in the saved file (removed, undone, or not saved before closing)",
};
export async function notifyChange(db, r, event, extra = {}) {
  try {
    if (!r || !TITLES[event]) return;
    const { createNotification } = await appImport("servers/shared/notifications.js");
    const body = event === "queued" ? `Open by ${names(r) || "someone"}. It will appear in their editor, or when they close it.`
      : event.startsWith("applied") ? `${extra.detected ? "Found already applied in the editor. " : ""}Undo id: ${extra.version_id || r.version_id || r.id}`
      : event === "expired" ? "It waited 7 days without the file being closed, so it was dropped."
      : `Reason: ${extra.message_for_user || REASONS[extra.reason] || extra.reason || "unknown"}.`;
    await createNotification(db, { title: TITLES[event](r), body, type: "system", source: "workspace:queue", action_url: `/dashboard/workspace?view=quick&path=${encodeURIComponent(r.path)}`, metadata: { change_id: r.id, event } });
  } catch (e) { console.warn(`[workspace] notification failed: ${e.message}`); }
}

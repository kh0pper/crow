/**
 * Reading the operator's "This is local" marks (provider-local-marks.js has
 * the rest). A no-import leaf, so the binding store (model-roles-store.js)
 * can read marks without importing provider-local-marks.js, which imports
 * the store: no import cycle (tests/model-roles-import-graph.test.js).
 */

export const LOCAL_MARKS_KEY = "provider_local_marks";

/** A stored marks value as an object; {} when it is missing, not an object, or does not parse. */
export function parseMarksMap(v) {
  try {
    const parsed = v ? JSON.parse(v) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/** Every mark on this box, or {} when none is stored or it does not parse. */
export async function readLocalMarks(db) {
  try {
    const { rows } = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [LOCAL_MARKS_KEY] });
    return parseMarksMap(rows[0]?.value ?? null);
  } catch { return {}; }
}

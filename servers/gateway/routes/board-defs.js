/**
 * Board configuration — THE single reader/validator of per-board status values
 * and declared fields (Track 0 Phase A).
 *
 * Boards are configured in tasks.db's `board_defs` (created by migration
 * 0002-board-defs): a row keyed by project_id (project/cards boards) or slug
 * (tracker-style boards, Phase B). A board with no row — and every failure
 * mode: absent table, corrupt JSON, null project — resolves to the builtin
 * default, which is byte-for-byte today's four-status behavior. Read paths
 * never throw; write paths validate through validateDefPayload before any SQL.
 *
 * Import from here; do not re-derive. The lock predicate learned this lesson
 * the hard way (routes/board-lock.js) — three drifting copies of one rule.
 */

const LEGACY_STATUSES = ["pending", "in_progress", "done", "cancelled"];

export const DEFAULT_BOARD_DEF = Object.freeze({
  id: null,
  project_id: null,
  slug: null,
  display_name: "Board",
  status_values: Object.freeze([...LEGACY_STATUSES]),
  terminal_values: Object.freeze(["done", "cancelled"]),
  fields: Object.freeze([]),
  builtin: true,
});

const MAX_VALUES = 24;
const MAX_VALUE_LEN = 60;
const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
// Columns a declared field may bind to directly (storage:'column'). Exactly
// the hand-rolled per-board column Track 0 legitimizes — nothing else.
const COLUMN_FIELD_KEYS = new Set(["phase"]);

function parseArray(text) {
  const v = JSON.parse(text);
  if (!Array.isArray(v)) throw new Error("not an array");
  return v.map((s) => String(s));
}

/**
 * Resolve the board definition for a project's cards board. Returns an object
 * shaped like DEFAULT_BOARD_DEF (arrays parsed, `builtin` false) when a
 * board_defs row matches; the frozen default otherwise. Never throws.
 * @param tdb the tasks.db client (createDbClient(TASKS_DB))
 */
export async function resolveBoardDef(tdb, { projectId } = {}) {
  if (projectId == null || !Number.isInteger(Number(projectId))) return DEFAULT_BOARD_DEF;
  let row;
  try {
    row = (await tdb.execute({
      sql: "SELECT id, slug, project_id, display_name, status_values, terminal_values, fields_json FROM board_defs WHERE project_id=?",
      args: [Number(projectId)],
    })).rows[0];
  } catch {
    return DEFAULT_BOARD_DEF; // table absent / transient — behave as today
  }
  if (!row) return DEFAULT_BOARD_DEF;
  try {
    const status_values = parseArray(row.status_values);
    if (!status_values.length) return DEFAULT_BOARD_DEF;
    const terminal_values = parseArray(row.terminal_values);
    const fields = JSON.parse(row.fields_json || "[]");
    if (!Array.isArray(fields)) return DEFAULT_BOARD_DEF;
    return {
      id: Number(row.id),
      project_id: row.project_id == null ? null : Number(row.project_id),
      slug: row.slug == null ? null : String(row.slug),
      display_name: String(row.display_name || "Board"),
      status_values,
      terminal_values,
      fields,
      builtin: false,
    };
  } catch {
    return DEFAULT_BOARD_DEF; // corrupt config never breaks the board
  }
}

/**
 * Resolve a slug (tracker-style) board. Returns the parsed def or NULL —
 * slug boards have no builtin fallback; a missing def is "tracker not found".
 * Never throws.
 */
export async function resolveSlugBoardDef(tdb, slug) {
  const s = typeof slug === "string" ? slug.trim() : "";
  if (!s) return null;
  let row;
  try {
    row = (await tdb.execute({
      sql: "SELECT id, slug, project_id, display_name, status_values, terminal_values, fields_json FROM board_defs WHERE slug=?",
      args: [s],
    })).rows[0];
  } catch { return null; }
  if (!row) return null;
  try {
    const status_values = parseArray(row.status_values);
    if (!status_values.length) return null;
    const terminal_values = parseArray(row.terminal_values);
    const fields = JSON.parse(row.fields_json || "[]");
    if (!Array.isArray(fields)) return null;
    return {
      id: Number(row.id), project_id: null, slug: String(row.slug),
      display_name: String(row.display_name || row.slug),
      status_values, terminal_values, fields, builtin: false,
    };
  } catch { return null; }
}

export function isValidStatus(def, v) {
  return v != null && def.status_values.includes(String(v));
}

export function isTerminal(def, v) {
  return v != null && def.terminal_values.includes(String(v));
}

/**
 * Validate a settings payload for create/update of a board_defs row.
 * Returns { ok:true, def:{display_name, status_values, terminal_values,
 * fields_json} } with the JSON columns pre-serialized, or { ok:false, error }.
 */
export function validateDefPayload(body) {
  const b = body || {};
  const display_name = typeof b.display_name === "string" ? b.display_name.trim() : "";
  if (!display_name) return { ok: false, error: "display_name is required" };

  if (!Array.isArray(b.status_values) || !b.status_values.length) {
    return { ok: false, error: "status_values must be a non-empty array" };
  }
  if (b.status_values.length > MAX_VALUES) {
    return { ok: false, error: `at most ${MAX_VALUES} status values` };
  }
  const statuses = [];
  for (const raw of b.status_values) {
    const s = String(raw ?? "").trim();
    if (!s) return { ok: false, error: "status values must be non-empty" };
    if (s.length > MAX_VALUE_LEN) return { ok: false, error: `status values must be ≤ ${MAX_VALUE_LEN} chars` };
    if (statuses.includes(s)) return { ok: false, error: `duplicate status '${s}'` };
    statuses.push(s);
  }

  const terminalsIn = Array.isArray(b.terminal_values) ? b.terminal_values : [];
  const terminals = [];
  for (const raw of terminalsIn) {
    const s = String(raw ?? "").trim();
    if (!statuses.includes(s)) return { ok: false, error: `terminal value '${s}' is not a status` };
    if (!terminals.includes(s)) terminals.push(s);
  }

  const fieldsIn = b.fields ?? [];
  if (!Array.isArray(fieldsIn)) return { ok: false, error: "fields must be an array" };
  if (fieldsIn.length > MAX_VALUES) return { ok: false, error: `at most ${MAX_VALUES} fields` };
  const fields = [];
  const seenKeys = new Set();
  for (const f of fieldsIn) {
    if (!f || typeof f !== "object") return { ok: false, error: "each field must be an object" };
    const key = String(f.key ?? "");
    if (!FIELD_KEY_RE.test(key)) return { ok: false, error: `bad field key '${key}'` };
    if (seenKeys.has(key)) return { ok: false, error: `duplicate field key '${key}'` };
    seenKeys.add(key);
    const label = typeof f.label === "string" && f.label.trim() ? f.label.trim() : key;
    const storage = String(f.storage ?? "data");
    if (storage !== "data" && storage !== "column") return { ok: false, error: `bad storage '${storage}'` };
    if (storage === "column" && !COLUMN_FIELD_KEYS.has(key)) {
      return { ok: false, error: `storage 'column' is only allowed for: ${[...COLUMN_FIELD_KEYS].join(", ")}` };
    }
    const out = { key, label, storage };
    if (f.options != null) {
      if (!Array.isArray(f.options)) return { ok: false, error: `field '${key}' options must be an array` };
      out.options = f.options.map((o) => String(o));
    }
    if (f.required != null) out.required = !!f.required;
    fields.push(out);
  }

  return {
    ok: true,
    def: {
      display_name,
      status_values: JSON.stringify(statuses),
      terminal_values: JSON.stringify(terminals),
      fields_json: JSON.stringify(fields),
    },
  };
}

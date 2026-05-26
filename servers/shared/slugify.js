// Project-space slug generation.
//
// Slug format: <kebab-case-of-name>-<id>. The trailing -<id> guarantees
// uniqueness without needing a SELECT roundtrip — collisions on the bare
// kebab-case form (e.g., two projects both named "Test") resolve naturally.
//
// Used by:
//   - scripts/init-db.js (one-shot migration of legacy research_projects rows)
//   - the new crow_create_project path (M2+) before writing to project_spaces
//   - the SQL fallback trigger on research_projects → project_spaces uses a
//     simpler SQL-only form (lower/replace) because SQLite UDFs are
//     per-connection in libsql and registering on every connection is fragile.
//     The SQL fallback is close enough; new code paths get this richer form.

const KEBAB_TRANSFORM = /[^a-z0-9]+/g;
const TRIM = /^-+|-+$/g;
const MAX_LEN = 60;

export function slugify(name, id) {
  let base = String(name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    // strip diacritics
    .replace(/[̀-ͯ]/g, "")
    // collapse smart quotes, em-dashes, etc. into separators
    .replace(KEBAB_TRANSFORM, "-")
    .replace(TRIM, "");

  if (base.length === 0) base = "project";
  if (base.length > MAX_LEN) base = base.slice(0, MAX_LEN).replace(TRIM, "");

  if (id == null || id === "") return base;
  return `${base}-${id}`;
}

// Returns a relative MinIO key prefix for a project. Keeps a trailing slash so
// concatenating "<prefix>filename" produces a valid key.
export function storagePrefixFor(slug) {
  return `projects/${slug}/`;
}

// Returns the absolute filesystem path for a project's workspace, given a
// data directory root (typically resolveDataDir() from servers/db.js).
export function workspacePathFor(dataDir, slug) {
  return `${dataDir}/projects/${slug}/workspace`;
}

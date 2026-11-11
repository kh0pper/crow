/**
 * workspace-deny.js — what a project's file history NEVER records.
 *
 * The history walker (workspace-index.js) records the workspace itself: it does
 * not ask git to select files, so a `.gitignore` a bot writes cannot hide its own
 * edits — and, for the same reason, a secret a `.gitignore` used to keep out
 * would be recorded unless this list keeps it out instead.
 *
 * The rule of the list is the ENTRY NAME, at any depth (case-insensitive):
 *
 *   credentials and local misfiles   `.env`, `.env.*`, `.mcp.json`, `.netrc`,
 *                                    `.npmrc`, `.pypirc`, `.git-credentials`,
 *                                    `credentials.json`, `*.kdbx`, and the
 *                                    folders `.ssh`, `.aws`, `.gnupg`, `.kube`,
 *                                    and `.docker/config.json`
 *   keys                             `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`,
 *                                    `id_ecdsa*`, `*.p12`, `*.pfx`
 *   a bot's own private world        `.pi` (pi session files)
 *   caches, dependencies, builds     `.venv`, `node_modules`, `__pycache__`,
 *                                    `.cache`, `target`, `dist`, `.next`
 *   live databases                   `*.db`, `*.db-wal`, `*.db-shm`
 *
 * plus the directory `sessions` at the WORKSPACE ROOT only (a bot's carried
 * session folder, which the carry-over links in at the root; a folder a user
 * happens to name `sessions` deeper down is ordinary content).
 *
 * scripts/pi-bots/world-root.mjs's CARRIED_ENTRIES says which entries a bot's
 * world cares about (`sessions`, `outputs`, `.pi`, `.mcp.json`). Everything there
 * except `outputs` — the user's own deliverables, recorded on purpose — must be
 * denied here; a test imports that list and holds the two in step.
 *
 * A file bigger than MAX_FILE_BYTES is skipped too (by workspace-index.js, not
 * here): a project workspace can hold a video or a model, and history is not a
 * second copy of it.
 */

/** The largest file the history records, in bytes. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Denied names, whatever the entry's type (a file or a folder with one of these
 * names is skipped, and a folder is not descended into).
 */
export const DENIED_ANY_NAME = Object.freeze([
  ".mcp.json",
  ".pi",
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa*",
  "id_ed25519*",
  "id_ecdsa*",
  "*.p12",
  "*.pfx",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  "credentials.json",
  "*.kdbx",
]);

/** Denied FOLDER names (a file of the same name is ordinary content). */
export const DENIED_DIR_NAME = Object.freeze([
  ".venv",
  "node_modules",
  "__pycache__",
  ".cache",
  "target",
  "dist",
  ".next",
]);

/** Denied FILE names (a folder of the same name is ordinary content). */
export const DENIED_FILE_NAME = Object.freeze(["*.db", "*.db-wal", "*.db-shm"]);

/** Denied folder names at the WORKSPACE ROOT only. */
export const DENIED_ROOT_DIR_NAME = Object.freeze(["sessions"]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A name pattern against a name: `*` matches any run of characters, everything
 * else is literal. Both sides are lowercased by the caller.
 */
function nameMatches(pattern, name) {
  if (!pattern.includes("*")) return pattern === name;
  return new RegExp(`^${pattern.split("*").map(escapeRe).join(".*")}$`).test(name);
}

/** The last element of a POSIX relative path. */
function baseName(relPath) {
  const text = String(relPath == null ? "" : relPath).replace(/\/+$/, "");
  const at = text.lastIndexOf("/");
  return at < 0 ? text : text.slice(at + 1);
}

/**
 * Would the history skip this workspace entry?
 *
 * @param {string} relPath  the entry's POSIX path, relative to the workspace root
 * @param {boolean} isDir   whether the entry is a directory
 * @returns {boolean}
 */
export function isDeniedEntry(relPath, isDir) {
  const name = baseName(relPath).toLowerCase();
  if (name === "") return false;
  // Docker's registry credentials: only this one file of `.docker` is a secret.
  if (!isDir) {
    const lowered = String(relPath == null ? "" : relPath).toLowerCase();
    if (lowered === ".docker/config.json" || lowered.endsWith("/.docker/config.json")) return true;
  }
  for (const pattern of DENIED_ANY_NAME) {
    if (nameMatches(pattern, name)) return true;
  }
  if (isDir) {
    for (const pattern of DENIED_DIR_NAME) {
      if (nameMatches(pattern, name)) return true;
    }
    const rel = String(relPath == null ? "" : relPath).replace(/\/+$/, "");
    for (const pattern of DENIED_ROOT_DIR_NAME) {
      if (nameMatches(pattern, name) && !rel.includes("/")) return true;
    }
  } else {
    for (const pattern of DENIED_FILE_NAME) {
      if (nameMatches(pattern, name)) return true;
    }
  }
  return false;
}
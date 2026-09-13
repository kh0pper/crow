/**
 * perch-files.js — read-only cwd browsing for the Perch hub Files tab (PR-B,
 * audit item 18).
 *
 * The hub's Files tab already lists a session's OUTPUTS (the fd-based,
 * O_NOFOLLOW, outputs-jail-only download route in perch-interactive-api.js —
 * untouched here). This adds the OTHER half pi-lab has: browse the session's
 * working directory (its `cwd`) read-only, and view a text file in-app.
 *
 * Posture (from the parity audit + open-anywhere decision 1): the dashboard
 * operator IS the machine owner, so this is a picker/viewer, NOT a trust
 * boundary — but every path is realpath-JAILED under the session's own `cwd`
 * so a session's browsing scope stays honest (no `..` or symlink escape into
 * the rest of the box), and the session's `uploadsDir` is NEVER listed or read
 * (that direction is upload-only). Downloads stay outputs-jail-only.
 *
 * These are pure functions of (rootDir, reqPath): they do their own fs I/O and
 * return plain result objects (or null / {error}), so they unit-test against a
 * real scratch dir with no engine, no route, no HTTP.
 */
import {
  realpathSync,
  readdirSync,
  openSync,
  closeSync,
  readSync,
  fstatSync,
  statSync,
  constants as fsConstants,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Byte cap on the in-app text viewer. Big enough for a source file or log
 *  tail, small enough that a huge file can't balloon an SSE-free JSON body.
 *  We read cap+1 to detect truncation without reading the whole file. */
export const CWD_READ_CAP = 256 * 1024;

/** Extension → mime for the in-app TEXT viewer. Fail-closed: an extension not
 *  in this map is not viewable (the file still LISTS, the viewer just refuses
 *  it) — "text/plain-ish mimes only" per the brief. No image/binary/archive
 *  mimes; svg is deliberately excluded (it renders as an image, not text). */
export const TEXT_EXT_MIME = Object.freeze({
  ".txt": "text/plain", ".text": "text/plain", ".log": "text/plain",
  ".md": "text/markdown", ".markdown": "text/markdown", ".rst": "text/plain",
  ".json": "application/json", ".jsonl": "application/x-ndjson",
  ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript",
  ".jsx": "text/plain", ".ts": "text/plain", ".tsx": "text/plain", ".mts": "text/plain",
  ".py": "text/x-python", ".sh": "text/x-shellscript", ".bash": "text/x-shellscript",
  ".zsh": "text/x-shellscript", ".fish": "text/plain",
  ".yml": "text/yaml", ".yaml": "text/yaml", ".toml": "text/plain",
  ".ini": "text/plain", ".cfg": "text/plain", ".conf": "text/plain",
  ".csv": "text/csv", ".tsv": "text/csv",
  ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".scss": "text/plain",
  ".xml": "text/xml", ".env": "text/plain", ".gitignore": "text/plain",
  ".sql": "text/x-sql", ".rb": "text/x-ruby", ".go": "text/x-go", ".rs": "text/x-rust",
  ".java": "text/x-java", ".kt": "text/plain", ".c": "text/x-c", ".h": "text/x-c",
  ".cpp": "text/x-c++", ".cc": "text/x-c++", ".hpp": "text/x-c++", ".cs": "text/plain",
  ".php": "text/plain", ".pl": "text/plain", ".lua": "text/plain", ".r": "text/plain",
  ".diff": "text/x-diff", ".patch": "text/x-diff", ".tex": "text/x-tex",
  ".makefile": "text/plain", ".dockerfile": "text/plain", ".editorconfig": "text/plain",
});

/** A few common extension-less text filenames, lowercased, that the viewer
 *  still serves as text/plain (fail-closed otherwise). */
const TEXT_BASENAMES = new Set([
  "makefile", "dockerfile", "license", "licence", "readme", "notice",
  "authors", "changelog", "contributing", "gemfile", "rakefile", "procfile",
  ".gitignore", ".gitattributes", ".env", ".editorconfig", ".dockerignore",
]);

/** Hard cap on listing entries so a huge dir (node_modules, a home dir) can't
 *  balloon the JSON body. Dirs and files are capped independently. */
const LIST_CAP = 500;

/**
 * Resolve `reqPath` under `rootDir` and JAIL it: the resolved realpath must be
 * the root's realpath itself or strictly under it. Returns
 * `{ rootReal, real, rel }` or `null` (unreadable / escape / a request that
 * lands on the excluded `uploadsDir`).
 *
 * `reqPath` may be empty (the cwd root), absolute, or relative-to-root. A
 * leading `~` is NOT expanded here (unlike the operator dir-picker /browse) —
 * cwd browsing is scoped to the session's own directory, so an absolute path
 * outside the jail simply fails the under-root check.
 */
export function jailUnderCwd(rootDir, reqPath, uploadsDir) {
  if (!rootDir) return null;
  let rootReal;
  try { rootReal = realpathSync(rootDir); } catch { return null; }

  const raw = (reqPath == null || String(reqPath) === "")
    ? rootReal
    : isAbsolute(String(reqPath)) ? resolve(String(reqPath)) : resolve(rootReal, String(reqPath));

  let real;
  try { real = realpathSync(raw); } catch { return null; }

  // The jail: root itself, or strictly under it (the `+ sep` is what makes it
  // "strictly under", not "shares a string prefix" — /home/foo vs /home/foobar).
  if (real !== rootReal && !real.startsWith(rootReal + sep)) return null;

  // Never expose the session's uploadsDir (upload-only, never re-served).
  if (uploadsDir) {
    let uploadsReal;
    try { uploadsReal = realpathSync(uploadsDir); } catch { uploadsReal = null; }
    if (uploadsReal && (real === uploadsReal || real.startsWith(uploadsReal + sep))) return null;
  }

  return { rootReal, real, rel: real === rootReal ? "" : relative(rootReal, real) };
}

/** Dot-last, then alphabetical — the /browse ordering, so a dir full of
 *  dotfiles still surfaces the human-named entries first. */
function dotLastAlpha(a, b) {
  const ad = a.name.startsWith("."), bd = b.name.startsWith(".");
  if (ad !== bd) return ad ? 1 : -1;
  return a.name.localeCompare(b.name);
}

/**
 * List a directory under the session's cwd (read-only, jailed).
 * Returns `{ root, path, rel, parent, dirs[], files[] }` or `null`.
 *   dirs  — {name, path} (symlink→dir followed, like /browse)
 *   files — {name, path, size, mtime} (regular files only; symlinks skipped)
 *   parent — the resolved parent dir, or null at the cwd root (can't go above)
 */
export function cwdList(rootDir, reqPath, { uploadsDir } = {}) {
  const j = jailUnderCwd(rootDir, reqPath, uploadsDir);
  if (!j) return null;
  let entries;
  try { entries = readdirSync(j.real, { withFileTypes: true }); } catch { return null; }

  // "Never list uploadsDir" means it must not even APPEAR as an entry in its
  // parent's listing (not just refuse to be navigated into). In the common
  // case uploadsDir is not under cwd at all, so this rarely fires — it covers
  // the edge where an operator points a session's cwd at a dir that contains
  // the session's own uploads.
  let uploadsReal = null;
  if (uploadsDir) { try { uploadsReal = realpathSync(uploadsDir); } catch { uploadsReal = null; } }

  const dirs = [];
  const files = [];
  for (const e of entries) {
    const full = join(j.real, e.name);
    if (uploadsReal && full === uploadsReal) continue;   // hide the uploadsDir entry
    let isDir = false;
    if (e.isDirectory()) isDir = true;
    else if (e.isSymbolicLink()) {
      try { isDir = statSync(full).isDirectory(); } catch { isDir = false; }
    }
    if (isDir) { dirs.push({ name: e.name, path: full }); continue; }
    if (e.isFile()) {
      let st;
      try { st = statSync(full); } catch { continue; }
      files.push({ name: e.name, path: full, size: st.size, mtime: Math.round(st.mtimeMs) });
    }
    // symlinks-to-files and sockets/fifos are skipped (never recursed, never served)
  }
  dirs.sort(dotLastAlpha);
  files.sort(dotLastAlpha);

  const parent = j.real === j.rootReal ? null : dirname(j.real);
  return {
    root: j.rootReal,
    path: j.real,
    rel: j.rel,
    parent,
    dirs: dirs.slice(0, LIST_CAP),
    files: files.slice(0, LIST_CAP),
    truncatedDirs: dirs.length > LIST_CAP,
    truncatedFiles: files.length > LIST_CAP,
  };
}

/**
 * Read a TEXT file under the session's cwd (read-only, jailed, capped).
 * Returns `{ name, rel, mime, text, truncated, size }`, or `{ error }` for a
 * non-text/binary file (route → 415), or `null` for not-found / jail-escape /
 * not-a-regular-file (route → 404).
 *
 * Fail-closed on type: the extension must be in TEXT_EXT_MIME (or a known
 * text basename), AND the bytes must be free of NUL (a binary wearing a .txt
 * name is still refused). Opened O_NOFOLLOW on the already-resolved real path
 * so a child racing to swap the leaf for a symlink can't redirect the read.
 */
export function cwdRead(rootDir, reqPath, { uploadsDir, cap = CWD_READ_CAP } = {}) {
  const j = jailUnderCwd(rootDir, reqPath, uploadsDir);
  if (!j) return null;

  const name = basename(j.real);

  // Type order matters: a DIRECTORY (or symlink, or device) is "not viewable"
  // → null (404), checked BEFORE the extension gate so a dir named e.g. "src"
  // is a 404, not a 415 "unsupported type". Only a regular file reaches the
  // fail-closed text-extension gate.
  let st;
  try { st = statSync(j.real); } catch { return null; }
  if (!st.isFile()) return null;

  const ext = extname(name).toLowerCase();
  const mime = TEXT_EXT_MIME[ext] || (TEXT_BASENAMES.has(name.toLowerCase()) ? "text/plain" : null);
  if (!mime) return { error: "unsupported" };

  let fd;
  try {
    fd = openSync(j.real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch { return null; }                               // ELOOP (leaf symlink) / EACCES / ENOENT
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile()) return null;
    const size = fst.size;
    const want = Math.min(size, cap + 1);
    const buf = Buffer.alloc(want);
    let off = 0;
    while (off < want) {
      const n = readSync(fd, buf, off, want - off, off);
      if (n <= 0) break;
      off += n;
    }
    const slice = buf.subarray(0, off);
    if (slice.indexOf(0) !== -1) return { error: "unsupported" };   // NUL → binary
    return {
      name,
      rel: j.rel,
      mime,
      text: slice.subarray(0, cap).toString("utf8"),
      truncated: size > cap,
      size,
    };
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * Reader — local-path ingest allowlist guard.
 *
 * `crow_reader_ingest` only reads local files under READER_INGEST_ROOTS
 * (default: the user home directory). resolve() alone does not dereference
 * symlinks, so a symlink planted under an allowed root could point outside
 * it and defeat a plain prefix check. realpathSync both the target and each
 * configured root before comparing.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve `path` to its real (symlink-free) path and reject it unless that
 * real path falls under one of the configured allowlist roots (also
 * symlink-resolved). Returns the resolved real path on success.
 * Throws Error on a missing file or a path outside the allowlist.
 */
export function assertPathAllowed(path, config = {}) {
  const roots = (config.READER_INGEST_ROOTS || homedir())
    .split(":")
    .filter(Boolean)
    .map((r) => realpathSync(resolve(r)));

  const resolvedPath = resolve(path);
  let target;
  try {
    target = realpathSync(resolvedPath);
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`File not found: ${resolvedPath}`);
    }
    throw err;
  }

  if (!roots.some((r) => target === r || target.startsWith(r + "/"))) {
    throw new Error(`Path outside READER_INGEST_ROOTS allowlist: ${target}`);
  }
  return target;
}

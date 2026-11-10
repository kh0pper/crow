/**
 * The installed compose file's bookkeeping, for the default compose refresh
 * (security audit N8-1).
 *
 * A docker bundle's compose file used to be copied into `~/.crow/bundles/<id>/`
 * only at install, or on a version change when the manifest opted in with
 * `refreshFiles`. Installs made before a port bind was tightened therefore kept
 * the old bind forever. The refresh now covers the compose by default — but it
 * must never overwrite an owner's edit, so the installed folder remembers:
 *
 *   .crow-compose.sha256   the sha256 of the compose bytes as last copied by
 *                          Crow (install or refresh). Equal bytes → unmodified.
 *   .crow-compose.edited   present when the installed compose matched neither
 *                          the recorded sha nor the bundle's compose at any past
 *                          commit of the checkout: an owner edit, left as is and
 *                          surfaced on a Fix-it card.
 *
 * Both files live inside the installed bundle folder, are never part of
 * `refreshFiles` copying (which only copies repo → installed) and are never
 * synced to a peer.
 */
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { manifestComposeFile } from "./bundles-config.js";

export const COMPOSE_SHA_FILE = ".crow-compose.sha256";
export const COMPOSE_EDITED_FILE = ".crow-compose.edited";

/** How many past commits of the checkout are searched for an unmodified compose. */
export const COMPOSE_HISTORY_COMMITS = 200;

/** Time bound for one git call (never a git process without one). */
export const COMPOSE_GIT_TIMEOUT_MS = 20_000;

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** The sha256 of a file's bytes, or null when it cannot be read. */
export function fileSha256(path) {
  try { return sha256(readFileSync(path)); } catch { return null; }
}

/** The sha recorded at the last install/refresh, or null when there is none. */
export function readRecordedComposeSha(destDir) {
  try { return readFileSync(join(destDir, COMPOSE_SHA_FILE), "utf8").trim() || null; } catch { return null; }
}

/**
 * Record the compose bytes Crow just copied into destDir, and clear any
 * "edited" note: the installed compose is Crow's own copy again.
 * @returns {string|null} the recorded sha, or null when there is no compose
 */
export function recordInstalledCompose(destDir, manifest) {
  const rel = manifestComposeFile(manifest);
  if (!rel) return null;
  const sha = fileSha256(join(destDir, rel));
  if (!sha) return null;
  writeFileSync(join(destDir, COMPOSE_SHA_FILE), `${sha}\n`);
  clearComposeEdited(destDir);
  return sha;
}

/** Note that the installed compose was left alone because it carries owner changes. */
export function markComposeEdited(destDir, composeRel) {
  writeFileSync(join(destDir, COMPOSE_EDITED_FILE), `${JSON.stringify({ compose: composeRel })}\n`);
}

export function clearComposeEdited(destDir) {
  rmSync(join(destDir, COMPOSE_EDITED_FILE), { force: true });
}

/** The "edited" note for an installed bundle, or null when there is none. */
export function readComposeEdited(destDir) {
  if (!existsSync(join(destDir, COMPOSE_EDITED_FILE))) return null;
  try { return JSON.parse(readFileSync(join(destDir, COMPOSE_EDITED_FILE), "utf8")) || {}; } catch { return {}; }
}

/**
 * Whether the bundle's compose file at ANY past commit of the checkout has the
 * given sha256 (`null` when git cannot answer: no git, not a checkout, an
 * unreadable log). Installs made before this bookkeeping existed have no
 * recorded sha; their compose is still unmodified when it is byte-identical to
 * what the repo shipped at some commit. The search stops at the first match,
 * and every git call is time-bounded and goes through the caller's runner (the
 * same seam as the rest of the install/refresh paths).
 *
 * @param {object} o
 * @param {string} o.appRoot    the repo checkout (git -C)
 * @param {string} o.bundleId
 * @param {string} o.composeRel bundle-relative compose path
 * @param {string} o.sha        the installed compose's sha256
 * @param {Function} o.runner   (cmd, args, opts) => Promise<{stdout}>
 * @param {number} [o.maxCommits]
 * @param {number} [o.timeoutMs]
 * @returns {Promise<boolean|null>}
 */
export async function composeInPastCommits({ appRoot, bundleId, composeRel, sha, runner, maxCommits = COMPOSE_HISTORY_COMMITS, timeoutMs = COMPOSE_GIT_TIMEOUT_MS }) {
  const rel = `bundles/${bundleId}/${composeRel}`.split("\\").join("/");
  let stdout;
  try {
    ({ stdout } = await runner("git", ["-C", appRoot, "log", "--format=%H", "-n", String(maxCommits), "--", rel], { timeout: timeoutMs }));
  } catch {
    return null; // no git, or not a checkout: history is unavailable
  }
  const commits = String(stdout || "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => /^[0-9a-f]{7,64}$/.test(s));
  if (commits.length === 0) return null;
  for (const commit of commits) {
    try {
      const { stdout: blob } = await runner("git", ["-C", appRoot, "show", `${commit}:${rel}`], { timeout: timeoutMs });
      if (sha256(String(blob ?? "")) === sha) return true;
    } catch {
      continue; // the path did not exist at that commit
    }
  }
  return false;
}
/**
 * The installed compose file's bookkeeping, for the default compose refresh
 * (security audit N8-1).
 *
 * A docker bundle's compose file used to be copied into `~/.crow/bundles/<id>/`
 * only at install, or on a version change when the manifest opted in with
 * `refreshFiles`. Installs made before a port bind was tightened therefore kept
 * the old bind forever. The refresh now covers the compose on EVERY boot, at
 * any version — but it must never overwrite an owner's edit, so the installed
 * folder remembers:
 *
 *   .crow-compose.sha256        the sha256 of the compose bytes as last copied
 *                              by Crow (install or refresh). Equal bytes →
 *                              unmodified, and a refresh needs no git at all.
 *   .crow-compose.state.json   { installedSha, repoComposeSha, verdict }: the
 *                              decision made for this exact pair of files, so a
 *                              steady-state boot only hashes two files and runs
 *                              no git. verdict is one of "match" (the installed
 *                              bytes are a version the checkout ships),
 *                              "edited" (they are not), "unknown" (git could not
 *                              answer) or "needs-config" (the shipped compose
 *                              needs a key the installed .env does not set).
 *   .crow-compose.edited       present while the installed compose matched
 *                              neither the recorded sha nor any past commit: an
 *                              owner edit, left as is and surfaced on a Fix-it
 *                              card. Removed by itself as soon as the file
 *                              matches again.
 *   .crow-compose.needs-config { compose, missing }: the shipped compose was
 *                              not copied because `${X:?…}` would fail Start.
 *                              The card names the key to set; the next boot
 *                              retries the refresh.
 *   .crow-compose.image-change [{ service, from, to }]: the shipped compose was
 *                              not copied because it would also change a
 *                              service's image — which may be OLDER than what
 *                              is running, and a downgraded image can migrate
 *                              the data's schema on the next restart. The old
 *                              copy stays until the owner presses "Apply the
 *                              update" on the Fix-it card. Removed by itself
 *                              once the two files name the same images (or the
 *                              repo copy is applied).
 *
 * All of these live inside the installed bundle folder, are never part of
 * `refreshFiles` copying (which only copies repo → installed) and are never
 * synced to a peer. Every write is atomic (temp file beside it, then rename),
 * so a reader never sees a half-written record.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { manifestComposeFile } from "./bundles-config.js";

export const COMPOSE_SHA_FILE = ".crow-compose.sha256";
export const COMPOSE_EDITED_FILE = ".crow-compose.edited";
export const COMPOSE_STATE_FILE = ".crow-compose.state.json";
export const COMPOSE_NEEDS_CONFIG_FILE = ".crow-compose.needs-config";
export const COMPOSE_IMAGE_CHANGE_FILE = ".crow-compose.image-change";

/** The verdicts a state record may carry (anything else is a stale/foreign file). */
export const COMPOSE_VERDICTS = Object.freeze(["match", "edited", "unknown", "needs-config", "image-change"]);

/** How many past commits of the checkout are searched for an unmodified compose. */
export const COMPOSE_HISTORY_COMMITS = 200;

/** Time bound for one git call (never a git process without one). */
export const COMPOSE_GIT_TIMEOUT_MS = 20_000;

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** git's own object id for a blob: sha1("blob <byteLength>\0" + bytes). */
export function gitBlobId(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ""), "utf8");
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

/**
 * Write one small bookkeeping file atomically: a temp file beside it is
 * renamed into place, so a boot or a request that reads it mid-write sees the
 * old content, never a torn line.
 */
export function writeFileAtomic(path, data, mode = 0o600) {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, data, { mode });
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
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
  writeFileAtomic(join(destDir, COMPOSE_SHA_FILE), `${sha}\n`);
  clearComposeEdited(destDir);
  return sha;
}

/** Note that the installed compose was left alone because it carries owner changes. */
export function markComposeEdited(destDir, composeRel) {
  writeFileAtomic(join(destDir, COMPOSE_EDITED_FILE), `${JSON.stringify({ compose: composeRel })}\n`);
}

export function clearComposeEdited(destDir) {
  rmSync(join(destDir, COMPOSE_EDITED_FILE), { force: true });
}

/** The "edited" note for an installed bundle, or null when there is none. */
export function readComposeEdited(destDir) {
  if (!existsSync(join(destDir, COMPOSE_EDITED_FILE))) return null;
  try { return JSON.parse(readFileSync(join(destDir, COMPOSE_EDITED_FILE), "utf8")) || {}; } catch { return {}; }
}

/** The cached verdict for one (installed bytes, repo compose) pair, or null. */
export function readComposeState(destDir) {
  let raw;
  try { raw = JSON.parse(readFileSync(join(destDir, COMPOSE_STATE_FILE), "utf8")); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const str = (v) => (typeof v === "string" && v ? v : null);
  return {
    installedSha: str(raw.installedSha),
    repoComposeSha: str(raw.repoComposeSha),
    verdict: COMPOSE_VERDICTS.includes(raw.verdict) ? raw.verdict : null,
  };
}

export function writeComposeState(destDir, { installedSha, repoComposeSha, verdict }) {
  writeFileAtomic(join(destDir, COMPOSE_STATE_FILE), `${JSON.stringify({ installedSha, repoComposeSha, verdict })}\n`);
}

/** Note the shipped compose was not copied: Start would fail on a blank `${X:?}`. */
export function markComposeNeedsConfig(destDir, { compose, missing }) {
  writeFileAtomic(join(destDir, COMPOSE_NEEDS_CONFIG_FILE), `${JSON.stringify({ compose, missing })}\n`);
}

/** The `{ compose, missing }` note for a skipped refresh, or null. */
export function readComposeNeedsConfig(destDir) {
  let raw;
  try { raw = JSON.parse(readFileSync(join(destDir, COMPOSE_NEEDS_CONFIG_FILE), "utf8")); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const missing = Array.isArray(raw.missing) ? raw.missing.filter((k) => typeof k === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) : [];
  return { compose: typeof raw.compose === "string" ? raw.compose : null, missing };
}

export function clearComposeNeedsConfig(destDir) {
  rmSync(join(destDir, COMPOSE_NEEDS_CONFIG_FILE), { force: true });
}

/**
 * Note that the shipped compose was not copied because it would also change an
 * image: `[{ service, from, to }]`, image names only. Any entry that is not
 * exactly that shape is dropped, so a hand-written file cannot make the card
 * display arbitrary text.
 */
export function markComposeImageChange(destDir, changes) {
  const rows = (Array.isArray(changes) ? changes : [])
    .filter((c) => c && typeof c.service === "string" && c.service)
    .map((c) => ({
      service: c.service,
      from: typeof c.from === "string" ? c.from : null,
      to: typeof c.to === "string" ? c.to : null,
    }));
  writeFileAtomic(join(destDir, COMPOSE_IMAGE_CHANGE_FILE), `${JSON.stringify(rows)}\n`);
}

/** The image-change note for an installed bundle, or null when there is none. */
export function readComposeImageChange(destDir) {
  let raw;
  try { raw = JSON.parse(readFileSync(join(destDir, COMPOSE_IMAGE_CHANGE_FILE), "utf8")); } catch { return null; }
  if (!Array.isArray(raw)) return null;
  const rows = raw
    .filter((c) => c && typeof c.service === "string" && c.service)
    .map((c) => ({
      service: c.service,
      from: typeof c.from === "string" ? c.from : null,
      to: typeof c.to === "string" ? c.to : null,
    }));
  return rows.length > 0 ? rows : null;
}

export function clearComposeImageChange(destDir) {
  rmSync(join(destDir, COMPOSE_IMAGE_CHANGE_FILE), { force: true });
}

/**
 * The blob ids of every past version of a bundle's compose file, from ONE
 * bounded git call: `git log -n<N> --format= --raw --no-abbrev --no-renames`.
 * With `--raw` each commit lists `:<mode> <mode> <src blob> <dst blob> <status>`
 * per changed path; the dst blob is the file's content at that commit (`-n`
 * limits the commits, so the walk is bounded). Renames are split into an add
 * and a delete, so a moved compose cannot hide its content.
 *
 * `null` when git cannot answer (no `.git`, git missing, an unreadable
 * checkout, a timeout): the caller must treat that as "unknown", never as
 * "no match". An answer with no rows means the checkout has no history for the
 * path at all, which IS a definite "not a shipped version".
 *
 * @param {object} o
 * @param {string} o.appRoot    the repo checkout (git -C)
 * @param {string} o.bundleId
 * @param {string} o.composeRel bundle-relative compose path
 * @param {Function} o.runner   (cmd, args, opts) => Promise<{stdout}>
 * @param {number} [o.maxCommits]
 * @param {number} [o.timeoutMs]
 * @returns {Promise<Set<string>|null>}
 */
export async function composeBlobIdsInHistory({ appRoot, bundleId, composeRel, runner, maxCommits = COMPOSE_HISTORY_COMMITS, timeoutMs = COMPOSE_GIT_TIMEOUT_MS }) {
  const rel = `bundles/${bundleId}/${composeRel}`.split("\\").join("/");
  let stdout;
  try {
    ({ stdout } = await runner("git", ["-C", appRoot, "log", `-n${maxCommits}`, "--format=", "--raw", "--no-abbrev", "--no-renames", "--", rel], { timeout: timeoutMs }));
  } catch {
    return null; // no git, or not a checkout: history is unavailable
  }
  const ids = new Set();
  for (const line of String(stdout || "").split("\n")) {
    if (!line.startsWith(":")) continue;
    const m = /^:[0-7]{6} [0-7]{6} ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64})/.exec(line);
    // An all-zero dst blob is a deletion: there is no content to match.
    if (!m || /^0+$/.test(m[2])) continue;
    ids.add(m[2]);
  }
  return ids;
}

/**
 * Whether the installed compose bytes are byte-for-byte a version the checkout
 * shipped (its git blob id is in the path's history), compared on the RAW
 * Buffer — a file is bytes, and decoding it as text first would change its
 * object id. The CRLF→LF spelling of the same bytes counts too: a checkout made
 * on a CRLF host shipped the same compose.
 *
 * @returns {Promise<boolean|null>} true / false, or null when history is
 *   unavailable (see composeBlobIdsInHistory) — never conflated with "edited".
 */
export async function composeInPastCommits({ appRoot, bundleId, composeRel, bytes, runner, maxCommits, timeoutMs }) {
  const ids = await composeBlobIdsInHistory({ appRoot, bundleId, composeRel, runner, maxCommits, timeoutMs });
  if (ids === null) return null;
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ""), "utf8");
  if (ids.has(gitBlobId(buf))) return true;
  const lf = Buffer.from(buf.toString("utf8").split("\r\n").join("\n"), "utf8");
  return ids.has(gitBlobId(lf));
}
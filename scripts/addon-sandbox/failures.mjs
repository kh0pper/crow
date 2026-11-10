/**
 * In-memory records of the add-ons that could not run inside their wall.
 *
 * A record is what makes the owner's "Run without the wall" click safe: the
 * Fix-it card stores only a random `ref`, and the remedy reads the add-on id
 * from the record that ref names, never from the card (crow.db is writable by
 * the eight add-ons that share it). Records live as long as this process, so a
 * card raised before a restart names nothing and unwalls nothing.
 *
 * Pure: node built-ins and memory, no I/O.
 */
import { randomBytes } from "node:crypto";
import { resolve as resolvePath } from "node:path";

/** A ref is 16 random bytes, hex. */
const REF_RE = /^[0-9a-f]{32}$/;
/** The most live records this map holds; the oldest is dropped first. */
export const MAX_WALL_FAILURES = 256;
/** A denial target a card may show: no spaces, nothing a card could reshape. */
const TARGET_RE = /^[A-Za-z0-9.:[\]_-]{1,255}$/;
/** An open(2) failure with its path in single quotes (the newest line wins). */
const OPEN_FAILURE_RE = /\b(EROFS|EACCES|ENOENT|EPERM)\b[^']*'([^']+)'/;

/** The wall itself could not be built here. */
export const REFUSED_REASON = "its wall could not be set up on this computer";
/** A child that went away without an exit code of its own. */
export const NOT_READY_REASON = "stopped before it was ready";
/** Shown when a denial target is not plain host:port text. */
export const HIDDEN_TARGET = "an address";

const records = new Map(); // ref -> { id, reason, at }
const liveRef = new Map(); // id -> ref (at most one live record per add-on)

/**
 * Remember one failure for `id` and return its ref. A newer failure for an
 * add-on drops its older record, so only the latest cards can be answered.
 */
export function recordWallFailure(id, reason) {
  if (typeof id !== "string" || !id) return null;
  const ref = randomBytes(16).toString("hex");
  const older = liveRef.get(id);
  if (older) records.delete(older);
  records.set(ref, { id, reason: typeof reason === "string" ? reason : String(reason ?? ""), at: Date.now() });
  liveRef.set(id, ref);
  while (records.size > MAX_WALL_FAILURES) {
    const oldest = records.keys().next().value;
    const dropped = records.get(oldest);
    records.delete(oldest);
    if (dropped && liveRef.get(dropped.id) === oldest) liveRef.delete(dropped.id);
  }
  return ref;
}

/** The record `ref` names, or null (a ref that is not one of ours names nothing). */
export function wallFailureByRef(ref) {
  if (typeof ref !== "string" || !REF_RE.test(ref)) return null;
  const record = records.get(ref);
  return record ? { id: record.id, reason: record.reason, at: record.at } : null;
}

/** Forget `id`'s live record (it connected walled, or the owner answered it). */
export function clearWallFailures(id) {
  const ref = liveRef.get(id);
  if (!ref) return;
  records.delete(ref);
  liveRef.delete(id);
}

/** Empty both maps (tests, and a simulated restart). */
export function _resetWallFailuresForTest() {
  records.clear();
  liveRef.clear();
}

/** True when the resolved path `p` is `root` itself or under it. */
function isUnder(p, root) {
  const r = resolvePath(root);
  return p === r || p.startsWith(r.endsWith("/") ? r : r + "/");
}

/**
 * The one line a card shows for a failure, first match:
 *  1. the wall could not be built;
 *  2. the relay's last denial — a target only when it is plain host:port text;
 *  3. the newest stderr line naming an open failure — the path only when it
 *     lies in the add-on's own install or data folder, so a card never echoes a
 *     secret path;
 *  4. the exit code.
 */
export function wallFailureReason({ denials, stderrLines, exitCode, installDir, dataDir, refused } = {}) {
  if (refused) return REFUSED_REASON;

  const denied = Array.isArray(denials) ? denials.filter((d) => typeof d === "string" && d) : [];
  const lastDenial = denied.length ? denied[denied.length - 1] : null;
  if (lastDenial) {
    const target = TARGET_RE.test(lastDenial) ? lastDenial : HIDDEN_TARGET;
    return `tried to reach ${target}, which it is not set up for`;
  }

  const lines = Array.isArray(stderrLines) ? stderrLines : [];
  const roots = [installDir, dataDir].filter((r) => typeof r === "string" && r);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (typeof line !== "string") continue;
    const match = OPEN_FAILURE_RE.exec(line);
    if (!match) continue;
    const shown = match[2];
    const resolved = resolvePath(shown);
    return roots.some((root) => isUnder(resolved, root))
      ? `could not open ${shown}`
      : "could not open a file outside its folder";
  }

  if (Number.isInteger(exitCode)) return `stopped with exit code ${exitCode}`;
  return NOT_READY_REASON;
}
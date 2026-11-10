/**
 * In-memory records of the add-ons that could not run inside their wall.
 *
 * A record is what makes the owner's "Run without the wall" click safe: the
 * Fix-it card stores only a random `ref`, and the remedy reads the add-on id
 * from the record that ref names, never from the card (crow.db is writable by
 * the eight add-ons that share it). Records live as long as this process, so a
 * card raised before a restart names nothing and unwalls nothing.
 *
 * A record also remembers the Fix-it item it became (`itemId`, `dedupKey`), so
 * the card the owner sees is bound to the record and the remedy can refuse a
 * copy of a genuine ref on a forged card.
 *
 * Pure: node built-ins and memory, no I/O.
 */
import { randomBytes } from "node:crypto";
import { relative as relativePath, resolve as resolvePath } from "node:path";

/** A ref is 16 random bytes, hex. */
const REF_RE = /^[0-9a-f]{32}$/;
/** The most live records this map holds; the oldest is dropped first. */
export const MAX_WALL_FAILURES = 256;
/** A denial target a card may show: no spaces, nothing a card could reshape. */
const TARGET_RE = /^[A-Za-z0-9.:[\]_-]{1,255}$/;
/** An open(2) failure with its path in single quotes (the newest line wins). */
const OPEN_FAILURE_RE = /\b(EROFS|EACCES|ENOENT|EPERM)\b[^']*'([^']+)'/;
/** The dedupKey of one add-on's card: "addon-wall:<id>". */
export const CARD_DEDUP_PREFIX = "addon-wall:";
/** A relative path a card may show: no spaces, quotes, markup or "~". */
const PLAIN_RELATIVE_RE = /^[A-Za-z0-9._/-]{1,128}$/;

/** The wall itself could not be built here. */
export const REFUSED_REASON = "its wall could not be set up on this computer";
/** A child that went away without an exit code of its own. */
export const NOT_READY_REASON = "stopped before it was ready";
/** Shown when a denial target is not plain host:port text. */
export const HIDDEN_TARGET = "an address";

const records = new Map(); // ref -> { id, reason, at, itemId, dedupKey }
const liveRef = new Map(); // id -> ref (at most one live record per add-on)
const liveItem = new Map(); // Fix-it item id -> ref

/** The copy of a record the callers see (never the live object). */
function recordView(record) {
  return {
    id: record.id,
    reason: record.reason,
    at: record.at,
    itemId: record.itemId,
    dedupKey: record.dedupKey,
  };
}

/** Drop one record and every index entry that points at it. */
function dropRecord(ref) {
  const record = records.get(ref);
  if (!record) return;
  records.delete(ref);
  if (record.itemId != null && liveItem.get(record.itemId) === ref) liveItem.delete(record.itemId);
  if (liveRef.get(record.id) === ref) liveRef.delete(record.id);
}

/**
 * Remember one failure for `id` and return its ref. A newer failure for an
 * add-on drops its older record, so only the latest cards can be answered.
 */
export function recordWallFailure(id, reason) {
  if (typeof id !== "string" || !id) return null;
  const ref = randomBytes(16).toString("hex");
  const older = liveRef.get(id);
  if (older) dropRecord(older);
  records.set(ref, {
    id,
    reason: typeof reason === "string" ? reason : String(reason ?? ""),
    at: Date.now(),
    itemId: null,
    dedupKey: null,
  });
  liveRef.set(id, ref);
  while (records.size > MAX_WALL_FAILURES) {
    const oldest = records.keys().next().value;
    dropRecord(oldest);
  }
  return ref;
}

/**
 * Bind a live record to the Fix-it item it became. Refused (false) for an
 * unknown ref, a non-integer item id, a dedupKey naming another add-on, an item
 * id another live record already owns, or a second, different item id for a
 * record that is already bound — so a writer that copies a ref onto its own
 * card cannot take the record over.
 */
export function bindWallFailureCard(ref, { itemId, dedupKey } = {}) {
  if (typeof ref !== "string" || !REF_RE.test(ref)) return false;
  const record = records.get(ref);
  if (!record) return false;
  if (!Number.isInteger(itemId)) return false;
  if (dedupKey !== CARD_DEDUP_PREFIX + record.id) return false;
  if (record.itemId != null) return record.itemId === itemId;
  const holder = liveItem.get(itemId);
  if (holder && holder !== ref && records.get(holder)?.itemId === itemId) return false;
  record.itemId = itemId;
  record.dedupKey = dedupKey;
  liveItem.set(itemId, ref);
  return true;
}

/** The record `ref` names, or null (a ref that is not one of ours names nothing). */
export function wallFailureByRef(ref) {
  if (typeof ref !== "string" || !REF_RE.test(ref)) return null;
  const record = records.get(ref);
  return record ? recordView(record) : null;
}

/** The live record bound to this Fix-it item id, or null. */
export function wallFailureByItemId(itemId) {
  if (!Number.isInteger(itemId)) return null;
  const ref = liveItem.get(itemId);
  if (!ref) return null;
  const record = records.get(ref);
  if (!record || record.itemId !== itemId) return null;
  return recordView(record);
}

/** Forget `id`'s live record (it connected walled, or the owner answered it). */
export function clearWallFailures(id) {
  const ref = liveRef.get(id);
  if (!ref) return;
  dropRecord(ref);
}

/** Empty every map (tests, and a simulated restart). */
export function _resetWallFailuresForTest() {
  records.clear();
  liveRef.clear();
  liveItem.clear();
}

/** True when the resolved path `p` is `root` itself or under it. */
function isUnder(p, root) {
  const r = resolvePath(root);
  return p === r || p.startsWith(r.endsWith("/") ? r : r + "/");
}

/** True when a path relative to the add-on's folder is plain enough to show. */
function isPlainRelative(rel) {
  if (!PLAIN_RELATIVE_RE.test(rel)) return false;
  if (rel.startsWith("/")) return false;
  return !rel.split("/").includes("..");
}

/**
 * The card line for an open(2) path: the relative path only when it is plain
 * text inside the add-on's own folder, otherwise a fixed phrase. Nothing from
 * the add-on's stderr is ever copied into a card unchecked.
 */
function openFailureText(resolved, roots) {
  for (const root of roots) {
    const r = resolvePath(root);
    if (!isUnder(resolved, r)) continue;
    const rel = relativePath(r, resolved);
    return isPlainRelative(rel) ? `could not open ${rel}` : "could not open a file in its folder";
  }
  return "could not open a file outside its folder";
}

/**
 * The one line a card shows for a failure, first match:
 *  1. the wall could not be built;
 *  2. the relay's last denial — a target only when it is plain host:port text;
 *  3. the newest stderr line naming an open failure — the path relative to the
 *     add-on's own install or data folder, and only when that relative path is
 *     plain text, so a card never echoes a secret path or foreign markup;
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
    return openFailureText(resolvePath(match[2]), roots);
  }

  if (Number.isInteger(exitCode)) return `stopped with exit code ${exitCode}`;
  return NOT_READY_REASON;
}
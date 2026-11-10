/**
 * The ONE reader/writer of `<CROW_HOME>/addon-walls.json` (mode 0600).
 *
 * The file is where Crow keeps the decisions about an add-on's wall that must
 * not live in crow.db (a crow.db add-on could rewrite its own row there):
 *
 *  - `keptData: [{ id, dev, ino, uid }, …]` — data folders Crow itself created,
 *    or kept through an uninstall, so a reinstall over an existing
 *    `<dataDir>/<id>` is allowed. Each record is bound to ONE folder on disk:
 *    the `dev`/`ino` pair (decimal strings from a bigint `lstat`, so two
 *    different folders never collide and a swapped-in folder or a symlink
 *    inherits nothing) plus the uid that owned it. Nothing inside an add-on's
 *    data dir is ever read for that decision: a planted
 *    `<dataDir>/<id>/addon-walls.json` grants nothing.
 *  - A legacy plain-string entry, or a record missing a field, grants nothing
 *    (it is ignored, and dropped on the next write).
 *  - Later tasks add the per-add-on wall override (an owner's "not walled on
 *    this computer" choice) to this same file.
 *
 * A missing, unreadable, unparsable or non-object file reads as `{}`: it grants
 * nothing, so every caller fails closed.
 */

import { chmodSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** An add-on id this file may hold an entry for (`^[a-z0-9][a-z0-9-]*$`). */
const ADDON_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** A decimal string, as `String(st.dev)` / `String(st.ino)` produce. */
const DECIMAL_RE = /^\d+$/;

function isAddonId(id) {
  return typeof id === "string" && ADDON_ID_RE.test(id);
}

/** The wall override file for one Crow home. */
export function addonWallsPath(crowHome) {
  return join(crowHome, "addon-walls.json");
}

/**
 * The whole document. A missing, unreadable or unparsable file, or one whose
 * top level is not an object, is `{}` — it grants nothing.
 */
export function readAddonWalls(crowHome) {
  try {
    const doc = JSON.parse(readFileSync(addonWallsPath(crowHome), "utf8"));
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
  } catch {
    return {};
  }
}

/**
 * Write the document: a sibling temp file at mode 0600, renamed over the real
 * path (never a partial file a reader could parse), then chmod 0600 again in
 * case the rename landed on a file with a wider mode.
 */
export function writeAddonWalls(crowHome, obj) {
  const path = addonWallsPath(crowHome);
  const tmp = `${path}.tmp-${process.pid}`;
  const body = `${JSON.stringify(obj && typeof obj === "object" ? obj : {}, null, 2)}\n`;
  writeFileSync(tmp, body, { mode: 0o600 });
  // `mode` above applies only when the temp file is created: a leftover from a
  // crashed writer keeps its old mode, so pin it before the rename too.
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/** Whether `e` is a complete kept-data record (an id plus the folder it names). */
function isKeptRecord(e) {
  return !!e && typeof e === "object" && !Array.isArray(e)
    && isAddonId(e.id)
    && typeof e.dev === "string" && DECIMAL_RE.test(e.dev)
    && typeof e.ino === "string" && DECIMAL_RE.test(e.ino)
    && typeof e.uid === "number" && Number.isInteger(e.uid);
}

/**
 * Every usable record in a document, in id order. A legacy plain-string entry
 * or a record missing a field is dropped here — it grants nothing anywhere.
 */
function keptRecordsOf(doc) {
  const list = doc?.keptData;
  if (!Array.isArray(list)) return [];
  return list.filter(isKeptRecord).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The kept-data record for `id`, or null (no record, a legacy entry, a broken one). */
export function keptDataRecord(crowHome, id) {
  if (!isAddonId(id)) return null;
  const record = keptRecordsOf(readAddonWalls(crowHome)).find((r) => r.id === id);
  return record ? { id: record.id, dev: record.dev, ino: record.ino, uid: record.uid } : null;
}

/**
 * Record `id`'s data folder as Crow's own kept data, from a bigint `lstat` of
 * the folder (`st.dev`/`st.ino` as decimal strings, `st.uid` as a number), and
 * drop any earlier record for the same id. Returns false for an id this file
 * may not hold.
 */
export function recordKeptData(crowHome, id, st) {
  if (!isAddonId(id) || !st) return false;
  const record = { id, dev: String(st.dev), ino: String(st.ino), uid: Number(st.uid) };
  const doc = readAddonWalls(crowHome);
  doc.keptData = [...keptRecordsOf(doc).filter((r) => r.id !== id), record]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  writeAddonWalls(crowHome, doc);
  return true;
}

/** Forget `id` (Crow created the folder for a fresh install: nothing is being kept). */
export function clearKeptData(crowHome, id) {
  if (!isAddonId(id)) return false;
  const doc = readAddonWalls(crowHome);
  const records = keptRecordsOf(doc);
  if (!records.some((r) => r.id === id)) return false;
  doc.keptData = records.filter((r) => r.id !== id);
  writeAddonWalls(crowHome, doc);
  return true;
}

/**
 * Whether `path` IS the folder `id`'s record names: `lstat` must succeed, the
 * entry must be a plain directory (never a symlink), and its `dev`/`ino` and
 * uid must equal the record's — and the record's uid must be `uid` (Crow's own
 * user). A record for a folder that is gone is cleared instead. Any error, and
 * any legacy or incomplete entry, reads as a mismatch.
 */
export function keptDataMatches(crowHome, id, path, { uid = process.getuid?.() } = {}) {
  try {
    const record = keptDataRecord(crowHome, id);
    if (!record) return false;
    let st;
    try {
      st = lstatSync(path, { bigint: true });
    } catch (err) {
      // The folder is gone: the record is stale, so a later install gets a fresh folder.
      if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
        try { clearKeptData(crowHome, id); } catch {}
      }
      return false;
    }
    if (!st.isDirectory()) return false;
    if (String(st.dev) !== record.dev || String(st.ino) !== record.ino) return false;
    const owner = Number(st.uid);
    return owner === record.uid && owner === uid;
  } catch {
    return false;
  }
}
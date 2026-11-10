/**
 * The ONE reader/writer of `<CROW_HOME>/addon-walls.json` (mode 0600).
 *
 * The file is where Crow keeps the decisions about an add-on's wall that must
 * not live in crow.db (a crow.db add-on could rewrite its own row there):
 *
 *  - `keptData: [<id>, …]` — data folders Crow itself created, or kept through
 *    an uninstall, so a reinstall over an existing `<dataDir>/<id>` is allowed.
 *    Nothing inside an add-on's data dir is ever read for that decision: a
 *    planted `<dataDir>/<id>/addon-walls.json` grants nothing.
 *  - Later tasks add the per-add-on wall override (an owner's "not walled on
 *    this computer" choice) to this same file.
 *
 * A missing, unreadable, unparsable or non-object file reads as `{}`: it grants
 * nothing, so every caller fails closed.
 */

import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** An add-on id this file may hold an entry for (`^[a-z0-9][a-z0-9-]*$`). */
const ADDON_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

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

/** The kept-data ids in a document (a non-array reads as none). */
function keptIdsOf(doc) {
  const list = doc?.keptData;
  return Array.isArray(list) ? list.filter((v) => typeof v === "string") : [];
}

/** Whether `<dataDir>/<id>` is Crow's own kept data (so a reinstall may reuse it). */
export function hasKeptData(crowHome, id) {
  if (!isAddonId(id)) return false;
  return keptIdsOf(readAddonWalls(crowHome)).includes(id);
}

/** Record `id` as Crow's own kept data. Returns false for an id this file may not hold. */
export function markKeptData(crowHome, id) {
  if (!isAddonId(id)) return false;
  const doc = readAddonWalls(crowHome);
  const ids = new Set(keptIdsOf(doc));
  ids.add(id);
  doc.keptData = [...ids].sort();
  writeAddonWalls(crowHome, doc);
  return true;
}

/** Forget `id` (Crow created the folder for a fresh install: nothing is being kept). */
export function clearKeptData(crowHome, id) {
  if (!isAddonId(id)) return false;
  const doc = readAddonWalls(crowHome);
  const ids = keptIdsOf(doc);
  if (!ids.includes(id)) return false;
  doc.keptData = ids.filter((v) => v !== id).sort();
  writeAddonWalls(crowHome, doc);
  return true;
}
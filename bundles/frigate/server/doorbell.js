/**
 * The Frigate add-on's doorbell snapshots: a folder of stills written by a sidecar.
 *
 * A "snapshot camera" is a file `<name>.jpg` directly in the configured folder, optionally
 * accompanied by `<name>.json` carrying `{ timestamp, type }` — the time the picture was taken
 * (epoch seconds) and why (motion, ding, interval, on-demand). Without the json the time comes
 * from the file's own mtime and the reason is unknown. That is the whole contract: any camera
 * that drops stills into the folder is listed, no Frigate API call and no broker needed.
 *
 * Everything here takes its settings as arguments — the folder arrives from the caller, never
 * from the environment — and nothing throws at the caller: a missing folder, an unreadable file
 * or a corrupt sidecar simply means "nothing to list". Names are matched against one strict
 * pattern before a path is built, and every read refuses a symlink and a non-regular file, so a
 * name from a request can only ever reach a plain `.jpg` sitting in that folder.
 */

import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** The only shape a snapshot name may have: lowercase, no dots, no slashes, 64 chars at most. */
export const SNAPSHOT_NAME_RE = /^[a-z0-9_-]{1,64}$/;
/** A still bigger than this is not a still: it is a mistake, and it is not read. */
export const SNAPSHOT_MAX_BYTES = 5 * 1024 * 1024;
/** A sidecar carrying more than this is not ours. */
const SIDECAR_MAX_BYTES = 4 * 1024;
const SNAPSHOT_SUFFIX = ".jpg";
const SIDECAR_SUFFIX = ".json";
const KNOWN_TYPES = new Set(["motion", "ding", "interval", "on-demand"]);

const REASONS = {
  en: { motion: "motion", ding: "doorbell", interval: "scheduled", "on-demand": "on request" },
  es: { motion: "movimiento", ding: "timbre", interval: "programada", "on-demand": "a pedido" },
};
const EN_REASONS = Object.freeze({ ...REASONS.en });
const ES_REASONS = Object.freeze({ ...REASONS.es });
const JUST_NOW = { en: "just now", es: "ahora mismo" };

/** True for a string that is a usable snapshot name. */
export function isSnapshotName(name) {
  return typeof name === "string" && SNAPSHOT_NAME_RE.test(name);
}

/** Why the picture was taken, in `lang`, or null when the sidecar said nothing usable. */
function reasonWord(type, lang) {
  const words = lang === "es" ? ES_REASONS : EN_REASONS;
  return typeof type === "string" && Object.hasOwn(words, type) ? words[type] : null;
}

/** The parsed sidecar for one still, or null. A corrupt, empty or oversized file is ignored. */
async function readSidecar(dir, name) {
  const file = join(dir, name + SIDECAR_SUFFIX);
  let info;
  try {
    info = await lstat(file);
  } catch {
    return null;
  }
  if (!info.isFile() || info.size <= 0 || info.size > SIDECAR_MAX_BYTES) return null;
  let data;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
  return data && typeof data === "object" && !Array.isArray(data) ? data : null;
}

/** The sidecar's time in seconds when it is a finite positive number, else the file's mtime. */
function snapshotTime(sidecar, mtimeMs) {
  const fromSidecar = sidecar ? Number(sidecar.timestamp) : NaN;
  if (Number.isFinite(fromSidecar) && fromSidecar > 0) return fromSidecar;
  const mtime = Number(mtimeMs);
  return Number.isFinite(mtime) && mtime > 0 ? Math.floor(mtime / 1000) : 0;
}

/** The sidecar's reason when it is one of the four known kinds, else null. */
function snapshotType(sidecar) {
  const type = sidecar ? sidecar.type : null;
  return typeof type === "string" && KNOWN_TYPES.has(type) ? type : null;
}

/**
 * Every snapshot camera in `dir`, sorted by name. A folder that is missing, unreadable or not a
 * string simply has none. Entries that are not a plain non-empty `.jpg` of a sane size are left
 * out — a symlink, a directory, an empty file and an oversized one all fail that test.
 */
export async function listSnapshotCameras(dir) {
  if (typeof dir !== "string" || !dir) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const fileName = entry && typeof entry.name === "string" ? entry.name : "";
    if (!fileName.endsWith(SNAPSHOT_SUFFIX)) continue;
    const name = fileName.slice(0, -SNAPSHOT_SUFFIX.length);
    if (!isSnapshotName(name)) continue;
    let info;
    try {
      info = await lstat(join(dir, fileName));
    } catch {
      continue;
    }
    if (!info.isFile() || info.size <= 0 || info.size > SNAPSHOT_MAX_BYTES) continue;
    const sidecar = await readSidecar(dir, name);
    found.push({
      name,
      mtimeMs: info.mtimeMs,
      timestamp: snapshotTime(sidecar, info.mtimeMs),
      type: snapshotType(sidecar),
    });
  }
  found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return found;
}

/**
 * One still's bytes, or null. The name is matched before a path is built, and the file is
 * lstat'ed — a symlink, a missing file, an empty one and an oversized one all answer null, so a
 * name arriving from a request can never be pointed at something else on the disk.
 */
export async function readSnapshot(dir, name) {
  if (typeof dir !== "string" || !dir) return null;
  if (!isSnapshotName(name)) return null;
  const file = join(dir, name + SNAPSHOT_SUFFIX);
  let info;
  try {
    info = await lstat(file);
  } catch {
    return null;
  }
  if (!info.isFile() || info.size <= 0 || info.size > SNAPSHOT_MAX_BYTES) return null;
  try {
    const bytes = await readFile(file);
    if (bytes.length === 0 || bytes.length > SNAPSHOT_MAX_BYTES) return null;
    return { bytes };
  } catch {
    return null;
  }
}

/** Seconds between a still's timestamp and now, never negative (a future time reads as now). */
function secondsAgo(timestamp, nowMs) {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  const now = Number(nowMs);
  const nowSec = Number.isFinite(now) ? now / 1000 : Date.now() / 1000;
  return Math.max(0, Math.floor(nowSec - timestamp));
}

/** "just now" / "hace 3 min" / "2 h ago" / "1 d ago", from seconds elapsed. */
function relativeText(elapsedSec, lang) {
  const spanish = lang === "es";
  if (elapsedSec < 45) return JUST_NOW[spanish ? "es" : "en"];
  if (elapsedSec < 60) return spanish ? `hace ${elapsedSec} s` : `${elapsedSec} s ago`;
  const minutes = Math.floor(elapsedSec / 60);
  if (minutes < 60) return spanish ? `hace ${minutes} min` : `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return spanish ? `hace ${hours} h` : `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return spanish ? `hace ${days} d` : `${days} d ago`;
}

/**
 * A short one-line label for a still: "<reason> - <time>", or just the time when the sidecar
 * carried no usable reason. `snapshot` is `{ type, timestamp }` as `listSnapshotCameras` returns
 * it; `nowMs` is the caller's clock, so the text is a function of its arguments alone.
 */
export function snapshotLabel(snapshot, nowMs, lang) {
  const snapshotInfo = snapshot && typeof snapshot === "object" ? snapshot : {};
  const language = lang === "es" ? "es" : "en";
  const reason = reasonWord(snapshotInfo.type, language);
  const elapsed = secondsAgo(snapshotInfo.timestamp, nowMs);
  const time = elapsed === null ? "" : relativeText(elapsed, language);
  if (reason && time) return `${reason} - ${time}`;
  return reason || time;
}
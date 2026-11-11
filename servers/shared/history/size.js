/**
 * The size line: how much disk History uses, in all three places it keeps data,
 * and whether that is enough to warn about (the version history design §6: "a
 * visible size line and the retention setting, not silent growth").
 *
 *   1. crow.db `item_versions`   memories, posts, notes, bots, context, ...
 *   2. tasks.db `item_versions`  board cards (a trigger cannot write across
 *                                databases, so cards keep their own table)
 *   3. `<data>/history/workspaces/*.git`  every project's file history
 *
 * Each part degrades alone: a missing table or folder is zero, and a part that
 * cannot be read (a failed or too-slow folder walk) is `null` = "unknown". The
 * page never fails because of this module, and a part that is unknown is not
 * guessed at.
 *
 * THE WARNING THRESHOLD is a controller default, NOT a product setting (the
 * design names no number): warn when History, all three parts together, is more
 * than WARN_SHARE_OF_FREE (10%) of the space still free on the data volume. A
 * share of FREE space rather than of the whole disk is deliberate: it tightens by
 * itself as the disk fills, so a Raspberry Pi with a few GB left is warned early
 * while a large NVMe with a big history is left alone. It needs no "small
 * machine" detection and no second number.
 */
import { existsSync, lstatSync, readdirSync, statfsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { tasksDbPath as defaultTasksDbPath } from "../../../scripts/pi-bots/instance-paths.mjs";
import { historySize } from "./api.js";
import { historyDataDir } from "./workspace-history.js";

/** Warn when History is over this share of the free space on the data volume. */
export const WARN_SHARE_OF_FREE = 0.1;
/** The folder walk gives up (unknown) past this many entries or milliseconds. */
export const WALK_MAX_ENTRIES = 200_000;
export const WALK_MAX_MS = 1500;

/**
 * Bytes under a folder: a bounded, iterative walk with lstat, never following a
 * symlink (a link counts as its own small entry and is not entered). A missing
 * folder is 0; a failure or the entry/time cap is null.
 *
 * @returns {number|null}
 */
export function folderBytes(root, { maxEntries = WALK_MAX_ENTRIES, maxMs = WALK_MAX_MS, now = Date.now } = {}) {
  try {
    const top = lstatSync(root, { throwIfNoEntry: false });
    if (!top) return 0;
    if (!top.isDirectory()) return null;
    const deadline = now() + maxMs;
    const stack = [root];
    let total = 0;
    let seen = 0;
    while (stack.length) {
      const dir = stack.pop();
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (++seen > maxEntries || now() > deadline) return null;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(path);
        } else {
          // lstat: a symlink reports its own size, never its target's.
          const st = lstatSync(path, { throwIfNoEntry: false });
          if (st) total += st.size;
        }
      }
    }
    return total;
  } catch {
    return null;
  }
}

/**
 * historySize() hides every failure as zeros, which is right for crow.db but
 * would make an unreadable tasks.db look like "no card history". Here only a
 * missing table is zero; any other failure is null (unknown).
 */
async function strictSize(db) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT COUNT(*) AS versions, COALESCE(SUM(LENGTH(snapshot_json)), 0) AS bytes FROM item_versions",
      args: [],
    });
    return { versions: Number(rows[0]?.versions) || 0, bytes: Number(rows[0]?.bytes) || 0 };
  } catch (err) {
    return /no such table/i.test(String(err && err.message)) ? { versions: 0, bytes: 0 } : null;
  }
}

/**
 * The card history in tasks.db: {versions, bytes}, zeros when absent, null when
 * unreadable. A path is opened READ-ONLY and never created (the Settings page
 * must not write to a live store just to count rows).
 */
async function cardHistory({ tasksDb, tasksDbPath }) {
  if (tasksDb) return strictSize(tasksDb);
  const path = tasksDbPath || defaultTasksDbPath();
  if (!existsSync(path)) return { versions: 0, bytes: 0 };
  let raw = null;
  try {
    raw = new Database(path, { readonly: true, fileMustExist: true });
    const row = raw.prepare("SELECT COUNT(*) AS versions, COALESCE(SUM(LENGTH(snapshot_json)), 0) AS bytes FROM item_versions").get();
    return { versions: Number(row?.versions) || 0, bytes: Number(row?.bytes) || 0 };
  } catch (err) {
    return /no such table/i.test(String(err && err.message)) ? { versions: 0, bytes: 0 } : null;
  } finally {
    try { raw?.close(); } catch { /* already closed */ }
  }
}

/** Free bytes for an unprivileged writer on the volume holding `path`, or null. */
function freeBytes(path) {
  try {
    const s = statfsSync(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * Everything the size line needs.
 *
 * @param {object} db  crow.db client
 * @param {{tasksDb?: object, tasksDbPath?: string, dataDir?: string, free?: number|null}} [opts]
 * @returns {Promise<{
 *   versions: number, bytes: number,
 *   cards: {versions: number, bytes: number}|null,
 *   workspaceBytes: number|null,
 *   totalBytes: number, partial: boolean,
 *   freeBytes: number|null, warn: boolean,
 * }>}
 */
export async function historyFootprint(db, opts = {}) {
  const own = await historySize(db);
  const cards = await cardHistory(opts);
  const dataDir = opts.dataDir || historyDataDir();
  const workspaceBytes = folderBytes(join(dataDir, "history", "workspaces"));
  const free = opts.free !== undefined ? opts.free : freeBytes(existsSync(dataDir) ? dataDir : join(dataDir, ".."));

  const totalBytes = own.bytes + (cards ? cards.bytes : 0) + (workspaceBytes || 0);
  const partial = cards === null || workspaceBytes === null;
  const warn = Number.isFinite(free) && free !== null && totalBytes > free * WARN_SHARE_OF_FREE;
  return { versions: own.versions, bytes: own.bytes, cards, workspaceBytes, totalBytes, partial, freeBytes: free, warn };
}

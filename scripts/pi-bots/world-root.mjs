/**
 * A bot's WORLD ROOT — where its pi session files, per-session outputs and
 * uploads, and its .mcp.json live — and carrying that world over when the
 * root moves.
 *
 * worldRootFor() is the one resolution: buildBotWorld (bot-world.mjs) calls
 * it every turn, and the Bot Builder's "Turn on a board" calls it to know
 * where a bot's world is before and after a project is linked.
 *
 * Linking a project moves the root from def.session_dir (or
 * <crowHome>/pi-bots/<id>) to <workspace>/bots/<id>. Resume reads
 * <root>/sessions (bridge.mjs passes --session-dir; perch-interactive's
 * dead-transcript preflight lists it), so without a carry-over every waiting
 * chat would wake fresh. planCarryOver/applyCarryOver symlink the old
 * entries into the new root — only where the new path is free. Nothing is
 * ever overwritten, moved or deleted.
 */
import { join } from "node:path";
import { lstatSync, readlinkSync, mkdirSync, symlinkSync } from "node:fs";

/** Same rule bot-world.mjs has always used, now in one place. */
export function worldRootFor({ workspaceDir, def, crowHome, botId }) {
  return workspaceDir
    ? (workspaceDir + "/bots/" + botId)
    : ((def && def.session_dir) || join(crowHome, "pi-bots", botId));
}

/** What a turn reads or writes at its world root (bot-world.mjs, perch-interactive.js). */
export const CARRIED_ENTRIES = Object.freeze(["sessions", "outputs", ".pi", ".mcp.json"]);

function lstatOrNull(p) {
  try { return lstatSync(p); } catch { return null; }
}

/**
 * Work out the carry-over without touching anything.
 * @returns {{links: {name, from, to}[], already: string[], conflicts: {name, path}[]}}
 */
export function planCarryOver(oldRoot, newRoot) {
  const out = { links: [], already: [], conflicts: [] };
  if (!oldRoot || !newRoot || oldRoot === newRoot) return out;
  for (const name of CARRIED_ENTRIES) {
    const from = join(oldRoot, name), to = join(newRoot, name);
    if (!lstatOrNull(from)) continue;
    const there = lstatOrNull(to);
    if (!there) { out.links.push({ name, from, to }); continue; }
    let same = false;
    if (there.isSymbolicLink()) { try { same = readlinkSync(to) === from; } catch { same = false; } }
    if (same) out.already.push(name);
    else out.conflicts.push({ name, path: to });
  }
  return out;
}

/**
 * Make the links a conflict-free plan named. symlinkSync refuses an existing
 * path (EEXIST), so a race can only make this fail, never overwrite.
 * @returns {string[]} the entry names linked
 */
export function applyCarryOver(plan, newRoot) {
  if (!plan.links.length) return [];
  mkdirSync(newRoot, { recursive: true });
  const done = [];
  for (const l of plan.links) {
    symlinkSync(l.from, l.to);
    done.push(l.name);
  }
  return done;
}

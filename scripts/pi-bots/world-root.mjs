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
 * chat would wake fresh. Nothing is ever overwritten, moved or deleted.
 *
 * pi-lab's read gate REALPATHS a target and its roots (bot-paths.ts realish /
 * underRealRoots), so the carry-over must keep every path the bot uses
 * resolving into a root:
 *   - "root" (the normal case: a fresh project has no bots/<id> yet): the
 *     WHOLE new root is one symlink to the old root. cwd, dirname(.mcp.json)
 *     and every target then realpath to the old root alike.
 *   - "entries" (fallback: the new root already exists): each entry is linked
 *     on its own where the path is free. Those targets realpath into the old
 *     root, which is not one of the bot's roots, so carriedReadRoots() hands
 *     the old root to the spawn as an extra read root.
 *   - "none": there is no old world to carry.
 */
import { join, dirname } from "node:path";
import { lstatSync, statSync, readlinkSync, mkdirSync, symlinkSync, unlinkSync, rmdirSync, realpathSync } from "node:fs";

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
 * @returns {{mode: "none"|"root"|"entries", reason: string|null,
 *   links: {name, from, to}[], already: string[], conflicts: {name, path}[], entries: string[]}}
 *   entries — the CARRIED_ENTRIES the old root holds (what "root" mode carries).
 */
export function planCarryOver(oldRoot, newRoot) {
  const out = { mode: "none", reason: null, links: [], already: [], conflicts: [], entries: [] };
  if (!oldRoot || !newRoot || oldRoot === newRoot) { out.reason = "same_root"; return out; }
  const old = lstatOrNull(oldRoot);
  if (!old) { out.reason = "no_old_root"; return out; }
  out.entries = CARRIED_ENTRIES.filter((name) => lstatOrNull(join(oldRoot, name)));
  const there = lstatOrNull(newRoot);
  if (!there) {
    out.mode = "root";
    out.links.push({ name: ".", from: oldRoot, to: newRoot });
    return out;
  }
  if (there.isSymbolicLink()) {
    let same = false;
    try { same = readlinkSync(newRoot) === oldRoot; } catch { same = false; }
    if (same) { out.mode = "root"; out.already = out.entries.slice(); return out; }
  }
  out.mode = "entries";
  for (const name of out.entries) {
    const from = join(oldRoot, name), to = join(newRoot, name);
    const at = lstatOrNull(to);
    if (!at) { out.links.push({ name, from, to }); continue; }
    let same = false;
    if (at.isSymbolicLink()) { try { same = readlinkSync(to) === from; } catch { same = false; } }
    if (same) out.already.push(name);
    else out.conflicts.push({ name, path: to });
  }
  return out;
}

function realOrNull(p) {
  try { return realpathSync(p); } catch { return null; }
}

/**
 * planCarryOver for a MOVE between projects ("Move a bot here"), where the
 * old root may itself be a carried link (A/bots/<id> -> the legacy root).
 * The carry source is the bot's REAL world, so A -> B -> C never chains links
 * and moving back to where the world really lives carries nothing:
 *   - the source is realpath(oldRoot), except that when it is the realpath of
 *     the bot's own pre-project root (legacyRoot) the legacyRoot path itself
 *     is used, so the links are exactly the ones "Turn on a board" makes and
 *     carriedReadRoots (exact-target check) still recognises them;
 *   - realpath(newRoot) === the real source: mode "none", reason "same_world";
 *   - "entries" mode from a source that is NOT the legacy root is refused as a
 *     conflict on newRoot: carriedReadRoots only grants the legacy root as an
 *     extra read root, so pi-lab's realpath read gate would deny those files.
 * Planning only, nothing is touched. Same result shape as planCarryOver.
 */
export function planMoveCarryOver(oldRoot, newRoot, { legacyRoot = null } = {}) {
  if (!oldRoot || !newRoot || oldRoot === newRoot) return planCarryOver(oldRoot, newRoot);
  if (!lstatOrNull(oldRoot)) return planCarryOver(oldRoot, newRoot); // no_old_root
  const real = realOrNull(oldRoot);
  if (!real) {
    // A dangling old root: there is no world to carry (buildBotWorld names
    // the broken link if the bot ever runs from it again).
    return { mode: "none", reason: "no_old_root", links: [], already: [], conflicts: [], entries: [] };
  }
  if (realOrNull(newRoot) === real) {
    return { mode: "none", reason: "same_world", links: [], already: [], conflicts: [], entries: [] };
  }
  const fromLegacy = !!legacyRoot && realOrNull(legacyRoot) === real;
  const source = fromLegacy ? legacyRoot : real;
  const plan = planCarryOver(source, newRoot);
  if (plan.mode === "entries" && !fromLegacy) {
    plan.links = [];
    plan.conflicts = [{ name: ".", path: newRoot }];
  }
  return plan;
}

/**
 * Make the links a conflict-free plan names. symlinkSync refuses an existing
 * path (EEXIST), so a race can only make this fail, never overwrite. On a
 * failure everything this call made is undone before the error is rethrown.
 * @returns {{carried: string[], created: string[]}} carried — the entry names
 *   now reachable from the new root; created — every path this call made
 *   (links and the directories mkdir made), in the order made, for undoCarryOver.
 */
export function applyCarryOver(plan, newRoot) {
  const created = [];
  const carried = plan.mode === "root" ? plan.entries.slice() : plan.already.slice();
  if (!plan.links.length) return { carried, created };
  try {
    if (plan.mode === "root") {
      // mkdirSync returns the FIRST directory it made; every one between it
      // and the parent is new too.
      const parent = dirname(newRoot);
      const first = mkdirSync(parent, { recursive: true });
      if (first) {
        const made = [];
        for (let d = parent; ; d = dirname(d)) { made.unshift(d); if (d === first || d === dirname(d)) break; }
        created.push(...made);
      }
      symlinkSync(plan.links[0].from, newRoot);
      created.push(newRoot);
    } else {
      for (const l of plan.links) {
        symlinkSync(l.from, l.to);
        created.push(l.to);
        carried.push(l.name);
      }
    }
  } catch (e) {
    undoCarryOver(created);
    throw e;
  }
  return { carried, created };
}

/**
 * Undo applyCarryOver: unlink the links it made and remove the directories it
 * made once they are empty. Best effort; never recursive, never follows a
 * link (unlink removes the link itself; rmdir refuses a non-empty dir).
 */
export function undoCarryOver(created) {
  for (const p of (created || []).slice().reverse()) {
    const st = lstatOrNull(p);
    if (!st) continue;
    try {
      if (st.isSymbolicLink()) unlinkSync(p);
      else if (st.isDirectory()) rmdirSync(p);
    } catch { /* not empty, or gone: leave it */ }
  }
}

/**
 * Extra read roots for a spawn ("entries" fallback). When the world root is
 * not the bot's own pre-project root (legacyRoot) and one of its carried
 * entries is exactly the link applyCarryOver makes (it reads
 * <legacyRoot>/<name>) and resolves into legacyRoot, the realpath of legacyRoot
 * is returned so pi-lab's realpath read gate accepts carried files. Only the
 * bot's OWN old root ever qualifies (worldRootFor without a workspace) — a
 * link pointing anywhere else adds nothing.
 * @returns {string[]}
 */
export function carriedReadRoots({ worldRoot, legacyRoot }) {
  if (!worldRoot || !legacyRoot || worldRoot === legacyRoot) return [];
  let realLegacy, realWorld;
  try { realLegacy = realpathSync(legacyRoot); realWorld = realpathSync(worldRoot); } catch { return []; }
  if (realWorld === realLegacy) return [];
  const under = (p, r) => p === r || p.startsWith(r.endsWith("/") ? r : r + "/");
  for (const name of CARRIED_ENTRIES) {
    const p = join(worldRoot, name);
    const st = lstatOrNull(p);
    if (!st || !st.isSymbolicLink()) continue;
    // Exactly the link applyCarryOver makes (<legacyRoot>/<name> at
    // <worldRoot>/<name>); a bot-planted `ln -s <old root> outputs`, or a
    // link under another name, is not a carried entry.
    let target, real;
    try { target = readlinkSync(p); real = realpathSync(p); } catch { continue; }
    if (target !== join(legacyRoot, name)) continue;
    if (under(real, realLegacy)) return [realLegacy];
  }
  return [];
}

/**
 * A carried-over link at the world root (the root itself, or its sessions/)
 * whose target is gone. mkdir through it fails with an opaque EEXIST every
 * turn, so buildBotWorld names it instead.
 * @returns {{path: string, target: string}|null}
 */
export function brokenWorldLink(worldRoot) {
  for (const p of [worldRoot, join(worldRoot, "sessions")]) {
    const st = lstatOrNull(p);
    if (!st || !st.isSymbolicLink()) continue;
    try { statSync(p); } catch {
      let target = "";
      try { target = readlinkSync(p); } catch {}
      return { path: p, target };
    }
  }
  return null;
}

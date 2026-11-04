/**
 * The secrets dir's ancestor invariant (bot containment Phase 1, Task 9).
 *
 * `<CROW_HOME>/secrets` is a 0700 dir owned by this user, and `anchorSecretsDir`
 * (secret-values.js) records its (dev, ino) the first time a process uses it.
 * That anchor only helps against a dir planted at the path AFTER the anchor:
 * whatever dir sits there at the FIRST use is anchored. So the dir's ancestors
 * matter. Their permissions decide whether a process that is not this user —
 * Phase 3's bot uid, or any member of a shared group — could rename an ancestor
 * and leave a dir of its own at the secrets path before the gateway starts.
 *
 * The walk is `dirname(secretsDir)` up to and including `/`, every path
 * realpath'ed first (a symlinked home is judged where it really is), each
 * ancestor `lstat`'ed through the `stat` seam.
 *
 * Findings (one per path, the first that applies):
 *   world-writable without sticky   anyone can rename what is inside
 *   writable by the bot uid         the bot owns the ancestor and can chmod it
 *   owned by another user           the owner can chmod it (and its mode is
 *                                   then not worth trusting); more specific
 *                                   bot-uid rule wins, root-owned is fine
 *   group-writable by the bot's group   the bot uid is in the writing group
 *   group-writable by a group with other members   another member of this
 *                                   user's own group can write it
 *   cannot stat                     the ancestor cannot be judged at all
 *
 * A sticky ancestor is not a finding for the world or group rules: Linux
 * refuses rename/unlink of an entry the writer does not own there, so the
 * secrets dir's ancestors cannot be swapped even though the ancestor itself is
 * writable (/tmp is the everyday case).
 *
 * Phase 1 (no CROW_BOT_UID) is WARN: the boot line counts findings and the
 * Bot Runtime status lists them. With CROW_BOT_UID set (Phase 3's launcher) a
 * finding is a REFUSAL: `anchorSecretsDir` returns null and every caller fails
 * closed. An unreadable `/etc/group` is not a finding: no member list means no
 * "other member" can be shown, and the world/bot rules still apply.
 */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";

/** The `why` values, exact (they reach the boot line and the status page). */
export const WHY_WORLD_WRITABLE = "world-writable without sticky";
export const WHY_BOT_UID = "writable by the bot uid";
export const WHY_BOT_GROUP = "group-writable by the bot's group";
export const WHY_SHARED_GROUP = "group-writable by a group with other members";
export const WHY_OTHER_OWNER = "owned by another user";
export const WHY_CANNOT_STAT = "cannot stat";

const STICKY = 0o1000;

/** The checking user's name, for "a group with OTHER members" ("" if unknown). */
function currentUserName() {
  try { return userInfo().username || ""; } catch { return ""; }
}

/**
 * The members of gid: the group line's member list, plus every /etc/passwd
 * account whose PRIMARY gid is gid (Linux counts those as members too, and they
 * are exactly the accounts a shared group is shared with on a home box).
 * Namen only; never a value.
 */
export function groupMembersFromFiles(gid) {
  const want = Number(gid);
  if (!Number.isInteger(want)) return [];
  const names = [];
  let group = "";
  try { group = readFileSync("/etc/group", "utf8"); } catch { /* no /etc/group: members unknown */ }
  for (const line of group.split("\n")) {
    const parts = line.split(":");
    if (parts.length < 4 || Number(parts[2]) !== want) continue;
    for (const n of parts[3].split(",")) {
      const name = n.trim();
      if (name) names.push(name);
    }
  }
  let passwd = "";
  try { passwd = readFileSync("/etc/passwd", "utf8"); } catch { /* members unknown */ }
  for (const line of passwd.split("\n")) {
    const parts = line.split(":");
    if (parts.length < 7 || !parts[0] || Number(parts[3]) !== want) continue;
    names.push(parts[0]);
  }
  return [...new Set(names)];
}

/**
 * Walk the ancestors of a secrets dir and report every path another principal
 * could rename. Never throws: a path that cannot be stat'ed is a finding.
 *
 * Every ancestor is expected to EXIST: `anchorSecretsDir` creates the secrets
 * dir first and checks afterwards, so an ENOENT here is a real `cannot stat`
 * (a path that vanished under us), not "nothing there yet".
 *
 * @param {object} a
 * @param {string} a.secretsDir              `<CROW_HOME>/secrets`
 * @param {number|null} [a.botUid]           Phase 3's bot uid (CROW_BOT_UID)
 * @param {number[]} [a.botGids]             groups the bot uid writes with
 * @param {number|null} [a.ownerUid]         the checking user (default process.getuid())
 * @param {(p: string) => {uid: number, gid: number, mode: number}} [a.stat]  test seam
 * @param {(gid: number) => string[]} [a.groupMembers]                        test seam
 * @param {string} [a.ownerName]             the checking user (ignored in "other members")
 * @returns {{ok: boolean, findings: Array<{path: string, why: string}>}}
 */
export function checkSecretsAncestors({
  secretsDir, botUid = null, botGids = [], stat, groupMembers, ownerName, ownerUid,
} = {}) {
  const findings = [];
  if (typeof secretsDir !== "string" || !secretsDir) return { ok: true, findings };
  // Resolve first: a symlinked home holds the real dir somewhere else, and the
  // ancestors that matter are the real ones.
  let start;
  try { start = realpathSync(secretsDir); } catch { start = resolve(secretsDir); }
  const statOf = typeof stat === "function" ? stat : (p) => lstatSync(p);
  const membersOf = typeof groupMembers === "function" ? groupMembers : groupMembersFromFiles;
  const owner = typeof ownerName === "string" && ownerName ? ownerName : currentUserName();
  const uid = Number.isInteger(botUid) ? botUid : null;
  const gids = Array.isArray(botGids) ? botGids.map(Number).filter(Number.isInteger) : [];
  const me = Number.isInteger(ownerUid) ? ownerUid : (typeof process.getuid === "function" ? process.getuid() : null);

  for (let p = dirname(start); ; p = dirname(p)) {
    let st;
    try { st = statOf(p); } catch { st = null; }
    if (!st || !Number.isFinite(Number(st.mode)) || !Number.isFinite(Number(st.uid))) {
      findings.push({ path: p, why: WHY_CANNOT_STAT });
    } else {
      const mode = Number(st.mode);
      const sticky = (mode & STICKY) !== 0;
      const groupWritable = (mode & 0o020) !== 0;
      if ((mode & 0o002) !== 0 && !sticky) {
        findings.push({ path: p, why: WHY_WORLD_WRITABLE });
      } else if (uid !== null && Number(st.uid) === uid) {
        findings.push({ path: p, why: WHY_BOT_UID });
      } else if (me !== null && Number(st.uid) !== 0 && Number(st.uid) !== me) {
        // Another user owns the ancestor: the owner can chmod it whatever its
        // mode says, so neither the mode nor the group rules below can be
        // trusted. Root-owned is the ordinary case and is fine.
        findings.push({ path: p, why: WHY_OTHER_OWNER });
      } else if (groupWritable && gids.includes(Number(st.gid))) {
        findings.push({ path: p, why: WHY_BOT_GROUP });
      } else if (groupWritable && !sticky) {
        let list = [];
        try { list = membersOf(Number(st.gid)) || []; } catch { list = null; }
        if (list === null) findings.push({ path: p, why: WHY_CANNOT_STAT });
        else if (list.some((n) => n && n !== owner)) findings.push({ path: p, why: WHY_SHARED_GROUP });
      }
    }
    if (p === dirname(p)) break;   // reached /
  }
  return { ok: findings.length === 0, findings };
}

const posInt = (v) => {
  const s = String(v == null ? "" : v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

/** Phase 3's bot uid from the spawner's env (CROW_BOT_UID), or null. */
export function botUidFromEnv(env = process.env) {
  return posInt(env && env.CROW_BOT_UID);
}

/** The bot uid's groups, when the launcher names them (CROW_BOT_GIDS=a,b), else []. */
export function botGidsFromEnv(env = process.env) {
  const raw = env && env.CROW_BOT_GIDS;
  if (raw == null) return [];
  return String(raw).split(",").map(posInt).filter((n) => n !== null);
}

/**
 * The check as the boot line, `anchorSecretsDir` and the Bot Runtime status all
 * want it: the env decides whether a finding is a warning or a refusal, and
 * the seams pass straight through.
 *
 * @returns {{ok: boolean, findings: Array<{path: string, why: string}>, refused: boolean, botUid: number|null}}
 */
export function secretsAncestorsReport({ env = process.env, secretsDir, stat, groupMembers, ownerName, ownerUid } = {}) {
  const botUid = botUidFromEnv(env);
  const botGids = botGidsFromEnv(env);
  const r = checkSecretsAncestors({ secretsDir, botUid, botGids, stat, groupMembers, ownerName, ownerUid });
  return { ...r, refused: botUid !== null && !r.ok, botUid };
}
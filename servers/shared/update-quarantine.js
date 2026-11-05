/**
 * update-quarantine.js — the update quarantine marker (audit N1c-3, Layer 0).
 *
 * `<git-dir>/crow-update-quarantine.json` records a commit this host ALREADY
 * rolled back, so the updater never pulls it again. It lives in the git dir,
 * next to the checkout lock, for three reasons:
 *   - co-hosted instances share one checkout, so one rollback must stop all of
 *     them from re-pulling the same sha;
 *   - `git reset` / `git clean` cannot move or delete it, unlike a worktree file
 *     (a rollback happens with the marker already in place);
 *   - it is never synced to another instance.
 *
 * Format v1: { v, sha, previous, reason, at, by, expires_at?, held? }. Both
 * shas are FULL 40-hex: a prefix would also match a different commit, so a
 * marker whose sha is not a full sha is ignored by every reader.
 *
 * A rollback that a machine merely got wrong (a timeout, a busy DB) must not
 * pause updates forever, so those reasons carry a 6 h TTL. A sha whose CODE
 * does not load has no TTL: it waits for the next commit on main. Neither does
 * a sha a BLOCKED rollback left checked out, whatever its reason (`persist`
 * writes `held: true`) — a checkout still sitting on the refused commit must
 * never time out into "Up to date". That last exemption lasts only while the
 * commit really is checked out: once local HEAD is no longer the marker's sha
 * (the operator moved main back), a transient reason gets its TTL back, counted
 * from `at` (see `markerDeadline`).
 *
 * `held` is what makes those held-at-HEAD rules apply, and only a blocked
 * rollback writes it. An OLD marker without the field — and any marker from a
 * rollback that really did move the tree back — is ordinary: if it happens to
 * name HEAD, that means the operator put that commit on main on purpose (a
 * manual `git pull --ff-only` after fixing the registry), so the TTL and "main
 * moved" rules still apply and the freeze must not outlive the rollback.
 *
 * The mirror-image rule for a HELD marker: while local HEAD IS the marker's sha,
 * the marker is never deleted and never ignored, whatever its expiry and
 * wherever main has moved to. The refused commit is still checked out, so the
 * next restart, reboot or bundle install boots it, and a co-hosted peer's
 * convergence would migrate and restart into it. Only `blocked`, `heldAtHead`
 * and an always-active marker are possible in that state (see
 * `heldNamesLocalHead`); expiry and "main moved" apply once the checkout is off
 * the sha.
 *
 * Nothing here throws: this runs inside a tick that must still record a result.
 */
import { closeSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export const UPDATE_QUARANTINE_FILE = "crow-update-quarantine.json";
export const UPDATE_QUARANTINE_FORMAT = 1;
/** Full shas only — see the header. */
export const FULL_SHA_RE = /^[0-9a-f]{40}$/;
/** The reader's ceiling: the real record is a few hundred bytes. */
export const UPDATE_QUARANTINE_MAX_BYTES = 64 * 1024;

/** Transient reasons: how long a rollback for one of them holds before main is
 *  retried with no new commit. Anything not listed waits for main to move.
 *
 *  `deps-failed`: `npm install` itself exited non-zero during the update, so the
 *  pulled sha never got as far as its import check or its init-db. That says
 *  nothing about the commit (a registry outage is not a bad sha), so a rollback
 *  that moved the checkout back expires and main is retried with no new commit.
 *  A BLOCKED rollback for the same reason is written with `persist` instead
 *  (`held: true`), and regains this TTL once HEAD is no longer its sha —
 *  otherwise a registry outage the operator already reset by hand would pause
 *  updates until main moved. */
export const TRANSIENT_QUARANTINE_MS = Object.freeze({
  "import-timeout": 6 * 60 * 60 * 1000,
  "init-db-failed": 6 * 60 * 60 * 1000,
  "deps-failed": 6 * 60 * 60 * 1000,
});

export function quarantinePath(gitDir) {
  return join(gitDir, UPDATE_QUARANTINE_FILE);
}

/** Atomic, symlink-safe write: temp + rename, "wx" so a planted file or link at
 *  the temp name is never followed. */
function writeAtomic(path, record) {
  const tmp = `${path}.tmp.${process.pid}`;
  let fd = null;
  try {
    try {
      fd = openSync(tmp, "wx", 0o600);
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try { unlinkSync(tmp); } catch {}
      fd = openSync(tmp, "wx", 0o600);
    }
    writeSync(fd, JSON.stringify(record, null, 2));
    closeSync(fd);
    fd = null;
    renameSync(tmp, path); // rename replaces a planted symlink, never follows it
    return record;
  } catch {
    if (fd !== null) { try { closeSync(fd); } catch {} }
    try { unlinkSync(tmp); } catch {}
    return null;
  }
}

/**
 * The marker as recorded — no expiry filter (callers decide, so an expired
 * marker can still be REPORTED instead of vanishing silently).
 *
 * @returns {null|{v:number, sha:string, previous:string|null, reason:string,
 *   at:string, by:string, expires_at?:string, held?:true}}
 */
export function readUpdateQuarantine({ gitDir, readFile = readFileSync, lstat = lstatSync } = {}) {
  if (!gitDir) return null;
  const path = quarantinePath(gitDir);
  // lstat, never stat: a symlink planted at the marker path must not be
  // followed (PR 2's boot guard reads the same file with the same rule), and
  // neither must a fifo, a device or a directory. Size-capped so a huge file
  // cannot be parsed into memory.
  try {
    const st = lstat(path);
    if (!st || st.isSymbolicLink() || !st.isFile() || st.size > UPDATE_QUARANTINE_MAX_BYTES) return null;
  } catch { return null; }
  let raw;
  try { raw = readFile(path, "utf8"); } catch { return null; }
  let m;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || typeof m !== "object") return null;
  if (m.v !== UPDATE_QUARANTINE_FORMAT) return null;
  if (typeof m.sha !== "string" || !FULL_SHA_RE.test(m.sha)) return null;
  if (typeof m.reason !== "string" || !m.reason.trim()) return null;
  if (!Number.isFinite(Date.parse(m.at))) return null;
  return {
    v: m.v,
    sha: m.sha,
    previous: typeof m.previous === "string" && FULL_SHA_RE.test(m.previous) ? m.previous : null,
    reason: m.reason,
    at: m.at,
    by: typeof m.by === "string" ? m.by : "unknown",
    ...(typeof m.expires_at === "string" && Number.isFinite(Date.parse(m.expires_at))
      ? { expires_at: m.expires_at } : {}),
    // Only a blocked rollback writes this. A marker from an older release (or
    // from a rollback that moved the tree back) has no field and stays valid.
    ...(m.held === true ? { held: true } : {}),
  };
}

/** Written when a rollback starts, so it exists BEFORE the checkout moves. A
 *  crash between the two must still leave the record that stops a re-pull.
 *
 *  `persist:true` is the BLOCKED-rollback write: it sets `held: true` and writes
 *  the record WITHOUT `expires_at`, whatever the reason. The caller could not
 *  reset the checkout, so the sha really is still there and an expiry would only
 *  turn it into a silent "Up to date" later. `held` is what carries that rule —
 *  an unflagged marker that happens to name HEAD is an ordinary one. */
export function writeUpdateQuarantine({
  gitDir, sha, previous = null, reason, by = "gateway", now = Date.now(), persist = false,
} = {}) {
  if (!gitDir || typeof sha !== "string" || !FULL_SHA_RE.test(sha)) return null;
  if (typeof reason !== "string" || !reason.trim()) return null;
  const held = persist === true;
  const ttl = held ? 0 : TRANSIENT_QUARANTINE_MS[reason];
  const record = {
    v: UPDATE_QUARANTINE_FORMAT,
    sha,
    previous: typeof previous === "string" && FULL_SHA_RE.test(previous) ? previous : null,
    reason,
    at: new Date(now).toISOString(),
    by,
    ...(ttl ? { expires_at: new Date(now + ttl).toISOString() } : {}),
    ...(held ? { held: true } : {}),
  };
  return writeAtomic(quarantinePath(gitDir), record);
}

export function clearUpdateQuarantine({ gitDir } = {}) {
  if (!gitDir) return false;
  try { unlinkSync(quarantinePath(gitDir)); return true; } catch { return false; }
}

/**
 * The moment a marker stops holding, or `null` when it waits for main instead.
 *
 * A HELD marker (a blocked rollback) has NO deadline at all while the checkout
 * still holds the sha it names — the refusal is about the tree, not the clock.
 * Once local HEAD has moved off it (the operator put main back by hand), a
 * transient reason gets its TTL back, counted from the marker's `at`, so a
 * machine-side failure — a registry outage is not a bad commit — is retried even
 * though main never moves. An unreadable local HEAD means "assume still checked
 * out": never time a held marker out on a guess.
 *
 * Any other marker is ordinary: an `expires_at` the writer recorded wins, and an
 * expiry-less one with a transient reason gets its TTL from `at` — a successful
 * rollback's marker must not pause updates forever, even if the operator later
 * puts that same commit on main by hand. A reason that is not transient keeps
 * waiting for main either way.
 */
function markerDeadline(marker, localHeadSha = "") {
  if (heldNamesLocalHead(marker, localHeadSha)) return null;
  if (marker?.expires_at) return Date.parse(marker.expires_at);
  if (!Object.hasOwn(TRANSIENT_QUARANTINE_MS, marker?.reason)) return null;
  return Date.parse(marker.at) + TRANSIENT_QUARANTINE_MS[marker.reason];
}

/** `localHeadSha` decides only the held-marker case above: without it a held
 *  marker is treated as still checked out and never expires. */
export function quarantineExpired(marker, now = Date.now(), localHeadSha = "") {
  const deadline = markerDeadline(marker, localHeadSha);
  return deadline !== null && deadline <= now;
}

/**
 * Is a HELD marker naming the commit the checkout HOLDS?
 *
 * Only a marker a BLOCKED rollback left behind (`held: true`) is protected this
 * way. An unflagged marker that happens to name HEAD is ordinary: the operator
 * chose that commit (a manual pull after fixing the registry), so the TTL and
 * "main moved" rules apply and the freeze does not outlive the rollback.
 *
 * An unreadable local HEAD counts as "may still be checked out": deleting the
 * record, or timing it out, on a guess would let the refused sha be pulled again
 * (or booted by a peer) with nothing left to refuse it.
 */
function heldNamesLocalHead(marker, localHeadSha) {
  if (marker?.held !== true) return false;
  const head = String(localHeadSha || "").trim();
  if (!FULL_SHA_RE.test(head)) return true;
  return head === marker.sha;
}

/** The HELD marker naming exactly the commit the checkout holds, whatever its
 *  expiry — the refusal a convergence gate honors: a commit a blocked rollback
 *  left checked out must not be migrated into or restarted into by anybody. */
export function updateQuarantineHeldAtHead({ gitDir, localHeadSha = "" } = {}) {
  const marker = readUpdateQuarantine({ gitDir });
  if (!marker || !heldNamesLocalHead(marker, localHeadSha)) return null;
  return marker;
}

/** The marker while it still holds. A HELD one naming the commit the checkout
 *  HOLDS is active whatever its expiry; an expired ordinary one is ignored (not
 *  deleted here — the updater's evaluate() owns cleanup). */
export function activeUpdateQuarantine({ gitDir, localHeadSha = "", now = Date.now() } = {}) {
  const marker = readUpdateQuarantine({ gitDir });
  if (!marker) return null;
  if (heldNamesLocalHead(marker, localHeadSha)) return marker;
  if (quarantineExpired(marker, now, localHeadSha)) return null;
  return marker;
}

/**
 * The puller's under-lock decision, called with origin/main's fresh head.
 *
 * Blocks ONLY when the full origin head equals the marker's sha (a prefix is
 * never enough) and the marker has not expired. When main has moved past it the
 * record is spent and is deleted — UNLESS it is HELD and local HEAD still IS its
 * sha: a refusal a blocked rollback left checked out stays refused, so the marker
 * survives and the caller is told the commit is still there (`heldAtHead`). The
 * same holds for an expired held marker. An ordinary (unflagged) marker that
 * names HEAD is not protected that way: it expires and clears like any other, so
 * the operator's manual pull of a commit this host rolled back successfully does
 * not wedge updates.
 *
 * @returns {{blocked:boolean, marker?:object, heldAtHead?:true, cleared?:boolean,
 *   expired?:boolean}} `heldAtHead` marks a HELD marker naming the commit the
 *   checkout still holds (an unreadable local HEAD counts as held).
 */
export function evaluateUpdateQuarantine({
  gitDir, originHeadSha = "", localHeadSha = "", now = Date.now(),
} = {}) {
  const marker = readUpdateQuarantine({ gitDir });
  if (!marker) return { blocked: false };
  // A HELD marker is never deleted while its commit is still checked out — see
  // the header. (An ordinary one naming HEAD is not held: the operator chose it.)
  const heldAtHead = heldNamesLocalHead(marker, localHeadSha);
  if (quarantineExpired(marker, now, localHeadSha)) {
    if (heldAtHead) return { blocked: false, heldAtHead: true, expired: true, marker };
    clearUpdateQuarantine({ gitDir });
    return { blocked: false, expired: true, marker };
  }
  const head = String(originHeadSha || "").trim();
  if (FULL_SHA_RE.test(head) && head === marker.sha) {
    return heldAtHead ? { blocked: true, heldAtHead: true, marker } : { blocked: true, marker };
  }
  if (FULL_SHA_RE.test(head)) {
    if (heldAtHead) return { blocked: false, heldAtHead: true, marker };
    clearUpdateQuarantine({ gitDir });
    return { blocked: false, cleared: true, marker };
  }
  // origin/main unreadable: neither block nor clear — a fetch failure reports
  // its own result, and deleting the record on a guess would re-pull a bad sha.
  return heldAtHead ? { blocked: false, heldAtHead: true, marker } : { blocked: false, marker };
}
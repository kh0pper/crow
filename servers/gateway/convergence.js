// servers/gateway/convergence.js
//
// An instance's job is to converge to the tree, not to pull.
//
// Three gateways (primary, MPA, r4) run from ONE shared ~/crow checkout with
// three separate data dirs. Pulling is a TREE operation — exactly one winner,
// guarded by the checkout-scoped lock in auto-update.js. Migrating and
// restarting are INSTANCE operations that every gateway must perform with its
// own env. Conflating the two is why the lock loser used to skip everything:
// its own migrations and its own restart-into-new-code, forever, because
// co-hosted gateways restart together and their 6h timers are phase-locked.

/**
 * A REGRESSION check, not an absolute one.
 *
 * "Every addon connected" would quarantine a perfectly good sha on any host
 * that already had a broken addon — precisely crow's state Aug 3-5 2026, when
 * `tasks` and `bots-sql-mcp` were down for an unrelated native-ABI reason. The
 * gate must answer "did this update break something?", not "is everything
 * perfect?".
 *
 * An addon that was already unhealthy is ignored. An addon that has vanished
 * from the snapshot entirely counts as `missing`, which IS a regression when it
 * was previously connected.
 *
 * @param {Record<string,string>|null} before pre-convergence snapshot
 * @param {Record<string,string>|null} after  post-restart snapshot
 * @returns {{ok: boolean, regressions: Array<{id: string, was: string, now: string}>}}
 */
export function compareHealth(before, after) {
  const regressions = [];
  for (const [id, was] of Object.entries(before || {})) {
    if (was !== "connected") continue; // already unhealthy — not ours to blame
    const now = (after || {})[id] ?? "missing";
    if (now !== "connected") regressions.push({ id, was, now });
  }
  return { ok: regressions.length === 0, regressions };
}

import { readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";

/** How long a convergence has to boot and verify before we call it failed.
 *  Must exceed the worst realistic boot: a guarded SCHEMA_GENERATION migration
 *  plus a full SEQUENTIAL addon-connect pass (60s per addon, unbounded in
 *  count). Too short quarantines healthy slow boots. */
export const PENDING_TTL_MS = 15 * 60 * 1000;

/** Hard expiry on a convergence quarantine. No failure mode may end in a state
 *  recoverable only by deleting files by hand. */
export const QUARANTINE_TTL_MS = 24 * 60 * 60 * 1000;

const PENDING_FILE = "convergence-pending.json";
const QUARANTINE_FILE = ".crow-convergence-quarantine.json";

/**
 * Atomic write. Two properties matter:
 *  - rename(2) is atomic, so a crash mid-write cannot leave torn JSON that
 *    readPending would silently swallow as "nothing pending";
 *  - the tmp path is PER-PROCESS. The repo-root quarantine marker has three
 *    writers (one per co-hosted gateway). With a shared `${path}.tmp`, P2's
 *    O_TRUNC can land in the middle of P1's write and P1 then renames the
 *    resulting byte-salad into place atomically — every peer's JSON.parse
 *    throws, readConvQuarantine returns null, and the canary's failure is
 *    silently discarded.
 */
function writeAtomic(path, obj) {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

/* ------------------------------------------------------------- boot cookie */

export function writePending(dataDir, { sha, baseline, now = Date.now() }) {
  const rec = { sha, baseline: baseline || {}, deadline: new Date(now + PENDING_TTL_MS).toISOString() };
  writeAtomic(join(dataDir, PENDING_FILE), rec);
  return rec;
}

export function readPending(dataDir) {
  return readJson(join(dataDir, PENDING_FILE));
}

export function clearPending(dataDir) {
  try { unlinkSync(join(dataDir, PENDING_FILE)); } catch {}
}

/**
 * What a booting process should do about the cookie it finds.
 *
 *   none   — nothing pending.
 *   verify — we ARE the boot this cookie was written for, with time left:
 *            wait for addons to settle, snapshot, compare.
 *   failed — the deadline passed with the cookie uncleared. Either the target
 *            never booted, or it booted and died before verifying. Both mean
 *            the convergence did not prove itself.
 *   stale  — a live cookie for a sha we are not running; unrelated, discard.
 *
 * The deadline is checked FIRST and inclusively: a crash-looping gateway boots
 * the target sha repeatedly, so "same sha" alone cannot distinguish healthy
 * from wedged.
 */
export function classifyPending(pending, bootSha, now = Date.now()) {
  if (!pending) return "none";
  if (Date.parse(pending.deadline) <= now) return "failed";
  return pending.sha === bootSha ? "verify" : "stale";
}

/* ------------------------------------------------------ convergence quarantine */

/**
 * Convergence quarantine — its OWN namespace, deliberately NOT the markers in
 * servers/shared/migration-guard.js.
 *
 * Two existing readers consume those with no knowledge of why they were
 * written: the boot guard in index.js would boot the gateway SKIPPING init-db
 * (on an empty database, that means serving with no tables at all), and
 * auto-update.js would block updates host-wide while printing
 * `gen undefined->undefined` at the operator. An addon flapping must not be
 * able to disable schema initialization.
 *
 * Written at BOTH repo and data level: the repo-level file is what co-hosted
 * peers sharing the checkout read.
 */
export function writeConvQuarantine({ appRoot, dataDir, sha, regressions = [], why = "", now = Date.now() }) {
  const marker = { sha, why, regressions, at: new Date(now).toISOString() };
  for (const p of [join(appRoot, QUARANTINE_FILE), join(dataDir, QUARANTINE_FILE)]) {
    try { writeAtomic(p, marker); } catch {}
  }
  return marker;
}

/** The active marker, or null. Anything past QUARANTINE_TTL_MS is ignored, so
 *  no failure mode wedges the host permanently. */
export function readConvQuarantine({ appRoot, dataDir, now = Date.now() }) {
  for (const p of [join(appRoot, QUARANTINE_FILE), join(dataDir, QUARANTINE_FILE)]) {
    const m = readJson(p);
    if (!m) continue;
    if (now - Date.parse(m.at) > QUARANTINE_TTL_MS) continue;
    return m;
  }
  return null;
}

export function clearConvQuarantine({ appRoot, dataDir }) {
  for (const p of [join(appRoot, QUARANTINE_FILE), join(dataDir, QUARANTINE_FILE)]) {
    try { unlinkSync(p); } catch {}
  }
}

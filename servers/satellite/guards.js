/**
 * Satellite agent start guards (SAT-3, spec §6.1, §11.1). The agent refuses to start (exit 78,
 * one plain line) on a box that still looks like a full Crow or that would expose it wrongly:
 *
 *   - a seed-bearing `identity.json` / `identity.json.*` (any file of that name with a "seed"
 *     key) in CROW_DATA_DIR, in any ~/.crow* directory (and its direct subdirectories, where a
 *     full Crow keeps data/identity.json), or in SAT_HOME. A satellite never holds the master seed;
 *   - CROW_TRUSTED_PROXIES set: the agent never trusts a local proxy, Serve is the only door;
 *   - CROW_DASHBOARD_PUBLIC set: a full-Crow setting with no meaning here, refused so a copied
 *     gateway env is caught;
 *   - a bind address of 0.0.0.0 or :: (any all-zero spelling): the agent is loopback-only.
 *
 * Pure: reads the filesystem, never writes. Node built-ins only.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const GUARD_EXIT_CODE = 78;
const SKIP = new Set(["node_modules", ".git", "app"]);
const MAX_IDENTITY_BYTES = 1024 * 1024;
const SEED_RE = /"seed"\s*:/;

const isIdentityName = (n) => n === "identity.json" || n.startsWith("identity.json.");

function isDir(p) {
  try { const st = lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; }
}

function seedFileIn(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  for (const n of names) {
    if (!isIdentityName(n)) continue;
    const p = join(dir, n);
    try {
      const st = lstatSync(p);
      if (!st.isFile()) continue;
      const text = st.size > MAX_IDENTITY_BYTES ? "" : readFileSync(p, "utf8");
      // Too big to be an identity, or unreadable: refuse rather than guess.
      if (st.size > MAX_IDENTITY_BYTES || SEED_RE.test(text)) return p;
    } catch {
      return p;
    }
  }
  return null;
}

/** `dir` and, to `depth` levels, its subdirectories (symlinks not followed). */
function seedFileUnder(dir, depth) {
  if (!isDir(dir)) return null;
  const hit = seedFileIn(dir);
  if (hit || depth <= 0) return hit;
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  for (const n of names) {
    if (SKIP.has(n)) continue;
    const sub = join(dir, n);
    if (!isDir(sub)) continue;
    const h = seedFileUnder(sub, depth - 1);
    if (h) return h;
  }
  return null;
}

/** The first seed-bearing identity file the agent must not run beside, or null. */
export function findSeedIdentity({ env = process.env, satHome, home = homedir() } = {}) {
  const roots = [];
  if (env.CROW_DATA_DIR) roots.push([resolve(env.CROW_DATA_DIR), 0]);
  let entries = [];
  try { entries = readdirSync(home); } catch { /* no home: nothing to scan */ }
  for (const n of entries) if (n.startsWith(".crow")) roots.push([join(home, n), 1]);
  if (satHome) roots.push([resolve(satHome), 1]);
  for (const [dir, depth] of roots) {
    const hit = seedFileUnder(dir, depth);
    if (hit) return hit;
  }
  return null;
}

/** True for 0.0.0.0, ::, [::], ::0, 0:0:0:0:0:0:0:0 and the like. */
export function isWildcardHost(h) {
  const s = String(h ?? "").trim().replace(/^\[(.*)\]$/, "$1");
  const fam = isIP(s);
  if (fam === 4) return s.split(".").every((o) => Number(o) === 0);
  if (fam === 6) return /^[0:]+$/.test(s);
  return false;
}

const present = (v) => v != null && String(v).trim() !== "";

/** → the one-line refusal message, or null when the agent may start. */
export function bootGuardMessage({ env = process.env, satHome, host, home = homedir() } = {}) {
  if (present(env.CROW_TRUSTED_PROXIES)) {
    return "refusing to start: CROW_TRUSTED_PROXIES is set; the satellite agent never trusts a local proxy (Tailscale Serve is its only door)";
  }
  if (present(env.CROW_DASHBOARD_PUBLIC)) {
    return "refusing to start: CROW_DASHBOARD_PUBLIC is set; that is a full Crow setting, unset it on a satellite";
  }
  if (isWildcardHost(host)) {
    return `refusing to start: bind address ${host} would listen on every interface; the satellite agent binds loopback only (CROW_SATELLITE_HOST)`;
  }
  const seed = findSeedIdentity({ env, satHome, home });
  if (seed) {
    return `refusing to start: ${seed} holds a Crow identity seed; a satellite never holds one (move it off this box, see the satellite step 0 runbook)`;
  }
  return null;
}


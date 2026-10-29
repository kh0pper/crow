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
 *   - CROW_SERVE_PEER_UIDS=off: Serve's headers would be trusted on their shape alone, so any
 *     local process could pose as Serve (a numeric uid list, including a test's own uid, is fine);
 *   - a bind address that is not loopback (127.0.0.0/8, ::1, localhost): an allowlist, because
 *     "0", "0.0", "00.0.0.0", "::ffff:0.0.0.0" and the like all bind every interface, and a
 *     tailnet address would skip Serve.
 *
 * Root dirs and identity files are followed through symlinks; recursion below a root is not.
 * Pure: reads the filesystem, never writes.
 */
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isLoopbackAddr } from "../shared/peer-class.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const GUARD_EXIT_CODE = 78;
const SKIP = new Set(["node_modules", ".git", "app"]);
const MAX_IDENTITY_BYTES = 1024 * 1024;
const SEED_RE = /"seed"\s*:/;

const isIdentityName = (n) => n === "identity.json" || n.startsWith("identity.json.");

/** A real (not symlinked) directory: used for recursion below a root. */
function isDir(p) {
  try { const st = lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; }
}
/** A directory, following symlinks: used for the roots themselves. */
function isDirFollow(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function seedFileIn(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  for (const n of names) {
    if (!isIdentityName(n)) continue;
    const p = join(dir, n);
    try {
      const st = statSync(p); // follows a symlinked identity file
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

/** `dir` and, to `depth` levels, its real subdirectories (symlinked subdirs not followed). */
function seedFileUnder(dir, depth, root = true) {
  if (!(root ? isDirFollow(dir) : isDir(dir))) return null;
  const hit = seedFileIn(dir);
  if (hit || depth <= 0) return hit;
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  for (const n of names) {
    if (SKIP.has(n)) continue;
    const sub = join(dir, n);
    if (!isDir(sub)) continue;
    const h = seedFileUnder(sub, depth - 1, false);
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

/** Only loopback binds are allowed: 127.0.0.0/8, ::1 (any spelling), localhost. */
export function isAllowedBindHost(h) {
  const s = String(h ?? "").trim().replace(/^\[(.*)\]$/, "$1");
  return s !== "" && isLoopbackAddr(s);
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
  if (String(env.CROW_SERVE_PEER_UIDS ?? "").trim().toLowerCase() === "off") {
    return "refusing to start: CROW_SERVE_PEER_UIDS=off would accept Serve's headers without checking the socket owner; leave it unset (tailscaled's uid 0)";
  }
  if (!isAllowedBindHost(host)) {
    return `refusing to start: bind address ${host} is not loopback; the satellite agent binds 127.0.0.1 only and is reached through Tailscale Serve (CROW_SATELLITE_HOST)`;
  }
  const seed = findSeedIdentity({ env, satHome, home });
  if (seed) {
    return `refusing to start: ${seed} holds a Crow identity seed; a satellite never holds one (move it off this box, see the satellite step 0 runbook)`;
  }
  return null;
}


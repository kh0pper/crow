/**
 * The secret FILES a bot's default-tier sandbox masks with --ro-bind /dev/null
 * (pi_sandbox.mjs hideFiles). Built here, per spawn, from the instance's Crow
 * home and the repo checkout.
 */
import { readdirSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * Bundles whose tool servers read their OWN .env inside the bot's sandbox at
 * run time: bundles/browser/server/instance.js and
 * bundles/workspace/server/config.js. Their .env stays readable until the
 * Phase 2 browser door replaces the file-based CDP token. Every other
 * bundle's .env has no reader inside the sandbox.
 */
export const BUNDLE_ENV_READABLE = ["browser", "workspace"];

/**
 * Root files the gateway side reads and hands the bot in its MCP block
 * headers (scripts/pi-bots/crow-server-catalog.mjs), so a bot never needs the
 * file itself.
 *
 * Deliberately NOT masked, and the reader inside the sandbox:
 *  - models-token: pi-lab's local-models extension.
 *  - llm-cloud-token: pi runs `cat` on it as a provider apiKey.
 *  - kiosk-announce-token: the kiosk MCP server reads it on each call
 *    (bundles/kiosk/server/server.js).
 *  - studio-agent-token: the studio MCP server reads it on each call
 *    (bundles/studio/server/hub-client.js).
 */
export const ROOT_SECRET_FILES = [".env", ".keystore-env", "board-token", "phone-token", "artifacts-token"];

/** A secrets-bearing env file name in a bundle dir: `.env` or `.env.<anything>` (a .env.bak-2026... too). */
export const BUNDLE_ENV_NAME_RE = /^\.env(\..*)?$/;

/**
 * Absolute paths of the secret files to mask, for one Crow home (and the
 * repo checkout at appRoot, when given). Pass REAL paths (the caller resolves
 * its roots first). Existence is not checked for the plain candidates:
 * wrapPiSpawn skips a file it cannot stat.
 *
 * Bundles are enumerated in `<crowHome>/bundles` and `<appRoot>/bundles`: every
 * regular file named `.env` or `.env.*` in a bundle dir, except the bundles
 * whose server reads its own. A bundle entry that is a symlink is resolved:
 * landing under a trusted root (crowHome or appRoot) its `.env*` files are
 * listed at their real path (the other root's enumeration covers the same
 * files); landing outside every root with an `.env*` behind it, the files are
 * listed under the link's own path, which wrapPiSpawn never follows, so the
 * caller refuses the spawn. A symlink with nothing behind it, and anything
 * that is not a dir, is ignored.
 * A `.env*` entry that is itself a symlink to a regular file under a root is
 * listed at the file's real path (masking the target hides the link's content
 * too); one whose target sits under a dir in `hiddenDirs` (hidden whole, like
 * env/) is already hidden and is not listed; a dangling one is ignored; any
 * other is listed under its own name so the caller refuses.
 * @param {{crowHome:string, appRoot?:string, hiddenDirs?:string[], readdir?:Function}} opts
 * @returns {string[]}
 */
export function secretFilesFor({ crowHome, appRoot, hiddenDirs = [], readdir = readdirSync }) {
  const out = [];
  const add = (p) => { if (!out.includes(p)) out.push(p); };
  for (const n of ROOT_SECRET_FILES) add(join(crowHome, n));
  if (appRoot) add(join(appRoot, ".env"));
  const roots = [crowHome, appRoot].filter(Boolean);
  const underRoot = (p) => roots.some((r) => p === r || p.startsWith(r + "/"));
  const under = (p, dirs) => dirs.some((d) => p === d || p.startsWith(d + "/"));
  const addEnv = (dir, n) => {
    const f = join(dir, n);
    if (entryKind(f) !== "link") { add(f); return; }
    let t; try { t = realpathSync(f); } catch { return; }              // dangling: nothing to hide
    if (under(t, hiddenDirs)) return;                                    // already behind a hidden dir
    let isFile = false; try { isFile = lstatSync(t).isFile(); } catch { /* gone */ }
    if (isFile && underRoot(t)) add(t); else add(f);
  };
  // Every bundle dir, including a stale copy (x.migrated-...): its .env files
  // are secrets too. A missing bundles dir means none.
  for (const root of roots) {
    for (const id of bundleIds(root, readdir)) {
      if (BUNDLE_ENV_READABLE.includes(id)) continue;
      const dir = join(root, "bundles", id);
      const kind = entryKind(dir);
      if (kind === "dir") { for (const n of envNamesIn(dir, readdir)) addEnv(dir, n); continue; }
      if (kind !== "link") continue;
      let real;
      try { real = realpathSync(dir); } catch { continue; }
      if (entryKind(real) !== "dir") continue;
      if (underRoot(real)) { for (const n of envNamesIn(real, readdir)) addEnv(real, n); }
      else { for (const n of envNamesIn(real, readdir)) add(join(dir, n)); }
    }
  }
  return out;
}

/**
 * The dirs wrapPiSpawn pins (hidePinDirs) so a bot cannot swap one for a
 * symlink or rename it between the listing and the mount: `<root>/bundles` and
 * every bundle dir that is a real dir, with or without a `.env` — for the Crow
 * home AND the repo checkout at appRoot, since both are enumerated and masked.
 * Deduped, so a root listed twice (or one that is the other) is pinned once.
 */
export function secretPinDirsFor({ crowHome, appRoot, readdir = readdirSync }) {
  const out = [];
  for (const root of [crowHome, appRoot].filter(Boolean)) {
    const bundles = join(root, "bundles");
    if (entryKind(bundles) !== "dir") continue;
    if (!out.includes(bundles)) out.push(bundles);
    for (const id of bundleIds(root, readdir)) {
      const dir = join(bundles, id);
      if (entryKind(dir) === "dir" && !out.includes(dir)) out.push(dir);
    }
  }
  return out;
}

/**
 * The refusal shown on a failed turn when a secret file exists but the default
 * tier could not mask it: one sentence, naming the path below its trusted root
 * and never any content. `cause` is what the caller measured:
 *  - "hardlink": another name on disk (masking one leaves the other readable);
 *  - "outside": the path sits under none of the trusted roots;
 *  - "hidden-dir": the path — or the link it is listed through — lands in a
 *    folder already hidden whole (a secrets dir, env/, android-keystore/), so
 *    the link itself is the problem;
 *  - "link-out": the first link on the way up leads outside every root;
 *  - "link-inside": a link, or a path through one, that stays inside the roots.
 * An unknown cause falls back to "link-inside" (the vaguer link sentence).
 */
export function unmaskableRefusal(rel, cause) {
  const start = "A bot could not start: " + rel;
  if (cause === "hardlink") return start + " has another name on disk, so Crow can't hide it. Remove the extra link.";
  if (cause === "outside") return start + " is outside the Crow folders, so Crow can't hide it.";
  if (cause === "hidden-dir") return start + " is a link into a hidden folder, so Crow can't hide it. Remove the link.";
  if (cause === "link-out") return start + " is a link that leads outside the Crow folders, so Crow can't hide it. Remove the link.";
  return start + " is a link or sits behind one, so Crow can't hide it. Remove the link.";
}

/** The refusal when ~/.ssh could not be masked at all (it is hidden whole on
 *  every default-tier spawn). */
export const SSH_NOT_HIDDEN_REFUSAL = "A bot could not start: Crow could not hide ~/.ssh.";

function bundleIds(root, readdir) {
  try { return readdir(join(root, "bundles")); } catch { return []; }
}
/** Names of the `.env*` files directly in dir: regular files, and symlinks too (never masked, so the caller refuses the spawn). */
function envNamesIn(dir, readdir) {
  let names;
  try { names = readdir(dir); } catch { return []; }
  return names.filter((n) => BUNDLE_ENV_NAME_RE.test(n) && (() => { try { const st = lstatSync(join(dir, n)); return st.isFile() || st.isSymbolicLink(); } catch { return false; } })());
}
function entryKind(p) {
  try { const st = lstatSync(p); return st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "other"; } catch { return "none"; }
}

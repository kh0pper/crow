/**
 * Instant Fix-it remedy: put Crow's compose file back, keeping the owner's copy.
 *
 * The "compose file has local changes" card exists because Crow never overwrites
 * an edit: the installed `~/.crow/bundles/<id>/<composefile>` stays as the owner
 * left it, so a tightened port bind never reaches that install. Owner-specific
 * settings belong in `docker-compose.override.yml`, which Crow never writes — so
 * the honest fix is: keep my file, and let Crow's copy back in.
 *
 * This action does exactly that, in this order:
 *   1. the CURRENT installed compose is written beside it as `<composefile>.bak`
 *      (atomic: temp file, then rename) — nothing the owner wrote is lost;
 *   2. the repo checkout's compose is copied over the installed one (atomic too);
 *   3. the install record follows (`recordInstalledCompose` + the state record),
 *      so the next boot sees Crow's own bytes and the card resolves.
 *
 * OWNER ONLY: this writes inside the installed bundle, so it refuses unless the
 * request is the owner's own password session at this instance
 * (`isLocalPasswordSessionOn`). A peer sign-in, a signed peer request, or a call
 * with no request at all changes nothing. It never restarts a container: the
 * "restart to apply" card does that job, in the owner's hands.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_BUNDLES, BUNDLES_DIR, manifestComposeFile } from "../../bundles-config.js";
import {
  COMPOSE_SHA_FILE,
  clearComposeEdited,
  clearComposeNeedsConfig,
  sha256,
  writeComposeState,
  writeFileAtomic,
} from "../../bundle-compose-state.js";
import { BUNDLE_ID_RE } from "../../satellites/installs.js";
import { isLocalPasswordSessionOn } from "../../dashboard/local-session.js";

export const ACTION_ID = "restore-bundle-compose";
export const LABEL = "Restore Crow's compose";

const NOT_OWNER = "Only the owner at this Crow's own dashboard can restore a compose file. Nothing was changed.";
const GONE = "Crow's copy of this compose file is not in this install, so nothing was changed.";

// Test-only: replace the owner rule (the real one needs a password session in crow.db).
let _ownerCheckForTest = null;
export function _setOwnerCheckForTest(fn) { _ownerCheckForTest = fn || null; }

async function isOwner(db, req) {
  if (_ownerCheckForTest) return (await _ownerCheckForTest(db, req)) === true;
  return (await isLocalPasswordSessionOn(db, req)) === true;
}

/** The repo manifest's compose path, falling back to the installed copy's. */
function composeRelFor(bundleDir, bundleId) {
  let rel = null;
  try { rel = manifestComposeFile(JSON.parse(readFileSync(join(APP_BUNDLES, bundleId, "manifest.json"), "utf8"))); } catch { /* fall back */ }
  if (rel) return rel;
  try { return manifestComposeFile(JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8"))); } catch { return "docker-compose.yml"; }
}

export default async function restoreBundleCompose(args, ctx) {
  const bundleId = args && typeof args.bundle === "string" ? args.bundle.trim() : "";
  if (!BUNDLE_ID_RE.test(bundleId)) return { resolved: false, message: "This card does not name a bundle, so nothing was changed." };

  let owner = false;
  try { owner = await isOwner(ctx?.db, ctx?.req); } catch { owner = false; }
  if (!owner) return { resolved: false, message: NOT_OWNER };

  const bundleDir = join(BUNDLES_DIR, bundleId);
  const composeRel = composeRelFor(bundleDir, bundleId);
  if (!composeRel) return { resolved: false, message: GONE };
  const src = join(APP_BUNDLES, bundleId, composeRel);
  const dst = join(bundleDir, composeRel);
  if (!existsSync(src)) return { resolved: false, message: GONE };

  let repoSha;
  try {
    const repoBytes = readFileSync(src);
    repoSha = sha256(repoBytes);
    if (existsSync(dst)) {
      // The owner's copy survives as <composefile>.bak, written atomically so a
      // failure below leaves either the old backup or the new one, never a torn file.
      writeFileAtomic(join(bundleDir, `${composeRel}.bak`), readFileSync(dst));
    }
    writeFileAtomic(dst, repoBytes);
  } catch {
    return { resolved: false, message: "Could not write the compose file, so nothing was changed." };
  }

  // The record is what the next boot reads to know these bytes are Crow's own. It
  // names the file this action wrote, not whatever the installed manifest says.
  writeFileAtomic(join(bundleDir, COMPOSE_SHA_FILE), `${repoSha}\n`);
  writeComposeState(bundleDir, { installedSha: repoSha, repoComposeSha: repoSha, verdict: "match" });
  clearComposeEdited(bundleDir);
  clearComposeNeedsConfig(bundleDir);
  console.log(`[fix-it] restored Crow's ${composeRel} for bundle ${bundleId} (the previous copy is ${composeRel}.bak)`);
  return { resolved: true };
}
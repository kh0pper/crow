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
 *   1. the shipped compose goes through the boot catch-up's own required-keys
 *      rule — never copy a file whose `${X:?…}` the installed .env cannot fill,
 *      because Start would fail on it. Missing → refused, naming the key,
 *      nothing written;
 *   2. the CURRENT installed compose is written beside it as `<composefile>.bak`
 *      (atomic: temp file, then rename) — nothing the owner wrote is lost;
 *   3. the repo checkout's compose is copied over the installed one (atomic too),
 *      with the mode the installed file had;
 *   4. the install record follows (`recordInstalledCompose` + the state record),
 *      so the next boot sees Crow's own bytes and the card resolves.
 *
 * OWNER ONLY: this writes inside the installed bundle, so it refuses unless the
 * request is the owner's own password session at this instance
 * (`isLocalPasswordSessionOn`). A peer sign-in, a signed peer request, or a call
 * with no request at all changes nothing and answers with the `fixit_owner_only`
 * flash. It never restarts a container: the "restart to apply" card does that
 * job, in the owner's hands.
 *
 * The same machinery answers the image-change hold's "Apply the update"
 * (APPLY_UPDATE_ACTION_ID): the shipped compose is applied exactly as above —
 * previous copy kept as `<composefile>.bak`, install record written, every note
 * cleared — and the restart card then appears as usual.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { APP_BUNDLES, BUNDLES_DIR, manifestComposeFile } from "../../bundles-config.js";
import {
  COMPOSE_SHA_FILE,
  clearComposeEdited,
  clearComposeImageChange,
  clearComposeNeedsConfig,
  sha256,
  writeComposeState,
  writeFileAtomic,
} from "../../bundle-compose-state.js";
import { missingRequiredComposeVars, parseDotEnv } from "../../compose-guard.js";
import { BUNDLE_ID_RE } from "../../satellites/installs.js";
import { isLocalPasswordSessionOn } from "../../dashboard/local-session.js";

export const ACTION_ID = "restore-bundle-compose";
export const LABEL = "Restore Crow's compose";
/** The image-change card's action: apply the shipped compose the owner held back. */
export const APPLY_UPDATE_ACTION_ID = "apply-bundle-compose-update";

/** The flash the Nest renders when the click was not the owner's own session. */
export const OWNER_ONLY_FLASH = "fixit_owner_only";
/** What the owner is told when someone else (a peer sign-in, no session) clicked. */
export const OWNER_ONLY_MESSAGE = "Only the owner, signed in on this Crow, can do that.";
/** The flash the Nest renders when the shipped compose needs a key set first. */
export const NEEDS_KEY_FLASH = "fixit_compose_needs_key";
/** The sentence for the key a flash may name (a query value, validated here). */
export const NEEDS_KEY_MESSAGE = "set the key on the Extensions card first";
/** A key name a flash may name: one environment key, never anything else. */
export const FLASH_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `set <KEY> on the Extensions card first`, for a key name a flash may show. */
export function needsKeyMessage(key) {
  return typeof key === "string" && FLASH_KEY_RE.test(key)
    ? `set ${key} on the Extensions card first`
    : NEEDS_KEY_MESSAGE;
}

const GONE = "Crow's copy of this compose file is not in this install, so nothing was changed.";
const WRITE_FAILED = "Could not write the compose file, so nothing was changed.";

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

/** The installed compose's permission bits, or null when there is no file yet. */
function installedMode(path) {
  try { return statSync(path).mode & 0o777; } catch { return null; }
}

export default async function restoreBundleCompose(args, ctx) {
  const bundleId = args && typeof args.bundle === "string" ? args.bundle.trim() : "";
  if (!BUNDLE_ID_RE.test(bundleId)) return { resolved: false, message: "This card does not name a bundle, so nothing was changed." };

  let owner = false;
  try { owner = await isOwner(ctx?.db, ctx?.req); } catch { owner = false; }
  if (!owner) return { resolved: false, flash: OWNER_ONLY_FLASH, message: OWNER_ONLY_MESSAGE };

  const bundleDir = join(BUNDLES_DIR, bundleId);
  const composeRel = composeRelFor(bundleDir, bundleId);
  if (!composeRel) return { resolved: false, message: GONE };
  const src = join(APP_BUNDLES, bundleId, composeRel);
  const dst = join(bundleDir, composeRel);
  if (!existsSync(src)) return { resolved: false, message: GONE };

  let repoBytes;
  try {
    repoBytes = readFileSync(src);
  } catch {
    return { resolved: false, message: GONE };
  }

  // The same check the boot catch-up runs before it copies: a `${X:?…}` the
  // installed .env cannot fill would break the bundle's next Start, so the old
  // copy stays and the owner is told which key to set first.
  const missing = missingRequiredComposeVars(repoBytes.toString("utf8"), {
    dotEnv: parseDotEnv(join(bundleDir, ".env")),
    env: process.env,
  });
  if (missing.length > 0) {
    return { resolved: false, flash: NEEDS_KEY_FLASH, flashParams: { key: missing[0] }, message: needsKeyMessage(missing[0]) };
  }

  const mode = installedMode(dst);
  const repoSha = sha256(repoBytes);
  try {
    if (existsSync(dst)) {
      // The owner's copy survives as <composefile>.bak, written atomically so a
      // failure below leaves either the old backup or the new one, never a torn
      // file. It keeps the mode the owner's file had.
      writeFileAtomic(join(bundleDir, `${composeRel}.bak`), readFileSync(dst), mode ?? undefined);
    }
    writeFileAtomic(dst, repoBytes, mode ?? undefined);
  } catch {
    return { resolved: false, message: WRITE_FAILED };
  }

  // The record is what the next boot reads to know these bytes are Crow's own. It
  // names the file this action wrote, not whatever the installed manifest says.
  writeFileAtomic(join(bundleDir, COMPOSE_SHA_FILE), `${repoSha}\n`);
  writeComposeState(bundleDir, { installedSha: repoSha, repoComposeSha: repoSha, verdict: "match" });
  clearComposeEdited(bundleDir);
  clearComposeNeedsConfig(bundleDir);
  clearComposeImageChange(bundleDir);
  console.log(`[fix-it] restored Crow's ${composeRel} for bundle ${bundleId} (the previous copy is ${composeRel}.bak)`);
  return { resolved: true };
}
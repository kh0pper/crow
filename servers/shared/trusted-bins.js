/**
 * The requires-bins gate: the `requires.bins` entries of a bundle manifest
 * that would NOT resolve under resolve-command.js's trusted rules (node and
 * its npm/npx, or a root-owned binary in the system directories), so an
 * add-on that names them bare would be refused at spawn.
 *
 * A bin in ~/.local/bin (where uv installs uvx) is not trusted, so an
 * Extensions install of such a bundle would write an entry that never
 * starts. The store disables Install and validateInstall refuses it until
 * the bin is installed system-wide. Then the gate lifts by itself.
 *
 * It uses resolveAddonCommand unchanged and never searches the PATH or a
 * user directory. Read-only.
 */
import { resolveAddonCommand } from "./resolve-command.js";

let _resolveForTest = null;

/** Test hook: replace the resolver (null restores resolveAddonCommand). */
export function _setTrustedBinResolveForTest(fn) { _resolveForTest = fn || null; }

/** @returns {string[]} the bare bin names that do not resolve as trusted */
export function trustedBinsMissing(manifest, { resolve } = {}) {
  const bins = manifest?.requires?.bins;
  if (!Array.isArray(bins) || bins.length === 0) return [];
  const r = resolve || _resolveForTest || resolveAddonCommand;
  const missing = [];
  for (const b of bins) {
    // A bin name is a bare command; anything else never counts as trusted here.
    if (typeof b !== "string" || !/^[A-Za-z0-9._+-]+$/.test(b)) { missing.push(String(b)); continue; }
    const rc = r(b, {});
    if (!rc || rc.missing !== false) missing.push(b);
  }
  return missing;
}

/**
 * Fix-it remedy (instant): run one add-on without its wall, by the owner's
 * choice, for this computer.
 *
 * The add-on's id comes ONLY from the in-memory failure record that the card's
 * `ref` names. Anything else in the card (args, context, a name, a path) is
 * ignored: `fix_it_items` is a crow.db column, and the eight add-ons that share
 * crow.db can write it, so a stored id would let one add-on free another.
 *
 * With no live record for that ref (a forged card, or one raised before Crow
 * last restarted) nothing is written and the owner is told to start the add-on
 * again. With a record: `addon-walls.json[<id>] = "unwalled"` through the one
 * walls store, the record is dropped, and the add-on is connected now.
 */
import { resolveCrowHome } from "../../../shared/crow-home.js";
import { setWallMode } from "../../../shared/addon-walls-file.js";
import { clearWallFailures, wallFailureByRef } from "../../../../scripts/addon-sandbox/failures.mjs";

/** The flash the Nest page renders when the click answered nothing. */
export const STALE_FLASH = "fixit_addon_stale";
/** What the owner is told when the failure record is gone. */
export const STALE_MESSAGE = "This failure is from before Crow last restarted; start the add-on again to see whether it still fails";
/** The flash the Nest page renders after the owner unwalled an add-on. */
export const UNWALLED_FLASH = "fixit_addon_unwalled";
export const UNWALLED_MESSAGE = "Done. That add-on now runs without its wall on this computer. You can wall it again on its page under Extensions.";
/** Shown when the choice could not be saved. */
export const SAVE_FAILED_MESSAGE = "Crow could not save that choice, so nothing was changed.";

// Test seam: a test swaps where the choice is written and what a reconnect is.
let _testDeps = null;
export function _setAddonUnwallDepsForTest(deps) { _testDeps = deps || null; }

function crowHomeNow() {
  const given = _testDeps?.crowHome;
  if (typeof given === "function") return given();
  if (typeof given === "string" && given) return given;
  return resolveCrowHome();
}

function writeMode() {
  return typeof _testDeps?.setWallMode === "function" ? _testDeps.setWallMode : setWallMode;
}

function reconnectNow() {
  if (typeof _testDeps?.reconnect === "function") return _testDeps.reconnect;
  return (id) => import("../../proxy.js").then((m) => m.reconnectAddonServer(id));
}

export default async function addonUnwall(args) {
  const ref = args && typeof args.ref === "string" ? args.ref : "";
  const record = wallFailureByRef(ref);
  if (!record) return { resolved: false, flash: STALE_FLASH, message: STALE_MESSAGE };

  let written = false;
  try {
    written = writeMode()(crowHomeNow(), record.id, "unwalled") !== false;
  } catch (err) {
    console.warn(`[fix-it] add-on ${record.id}: the wall choice could not be saved — ${err?.message || err}`);
  }
  if (!written) return { resolved: false, message: SAVE_FAILED_MESSAGE };

  clearWallFailures(record.id);

  // The owner's choice is recorded; a reconnect that fails changes the add-on's
  // own status, not the answer to the click.
  let status = null;
  try {
    const result = await reconnectNow()(record.id);
    status = result && typeof result.status === "string" ? result.status : null;
  } catch (err) {
    console.warn(`[fix-it] add-on ${record.id}: the reconnect did not run — ${err?.message || err}`);
  }
  return { resolved: true, status, flash: UNWALLED_FLASH };
}

/** "Keep it off": answer the card and change nothing else. */
export function keepOffRemedy() {
  return { resolved: true };
}
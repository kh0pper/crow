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
 * again. The record must also be bound to the very item the owner clicked:
 * `ref` is a crow.db value too, so a writer can copy a genuine ref onto its own
 * card, and only the binding says which card the record belongs to.
 * With a record: `addon-walls.json[<id>] = "unwalled"` through the one
 * walls store, the record is dropped, and the add-on is connected now.
 */
import { resolveCrowHome } from "../../../shared/crow-home.js";
import { setWallMode } from "../../../shared/addon-walls-file.js";
import {
  CARD_DEDUP_PREFIX,
  clearWallFailures,
  wallFailureByItemId,
} from "../../../../scripts/addon-sandbox/failures.mjs";

/** The action ids this detector's cards carry. */
export const UNWALL_ACTION = "addon-unwall";
export const KEEP_OFF_ACTION = "addon-keep-off";

/** The "Keep it off" button's label (code-held, never the stored one). */
export const KEEP_OFF_LABEL = "Keep it off";

/** "Run <id> without the wall" — built from the live record only. */
export function unwallLabel(id) {
  return `Run ${id} without the wall`;
}

/** The flash the Nest page renders when the click answered nothing. */
export const STALE_FLASH = "fixit_addon_stale";
/** What the owner is told when the failure record is gone. */
export const STALE_MESSAGE = "This failure is from before Crow last restarted; start the add-on again to see whether it still fails";
/** The flash the Nest page renders after the owner unwalled an add-on. */
export const UNWALLED_FLASH = "fixit_addon_unwalled";
export const UNWALLED_MESSAGE = "Done. That add-on now runs without its wall on this computer. You can wall it again on its page under Extensions.";
/** An add-on id a flash may name: one lowercase slug. */
export const FLASH_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The unwall flash text: the add-on's id when the caller names one it may show,
 * else the generic line. The id is a query value, so it is re-checked here.
 */
export function unwalledMessageFor(id) {
  return typeof id === "string" && FLASH_ID_RE.test(id)
    ? `Done. ${id} now runs without its wall on this computer. You can wall it again on its page under Extensions.`
    : UNWALLED_MESSAGE;
}
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

export default async function addonUnwall(args, ctx) {
  // The record is found by the card the owner clicked (the binding made when the
  // card was stored), never by the stored args: `args.ref` is crow.db data, and a
  // late, out-of-order write can leave an older ref there. A card that copied a
  // ref, or one from another source, answers with the same stale line.
  const item = ctx?.item;
  const itemId = Number(item?.id);
  const record = Number.isInteger(itemId) ? wallFailureByItemId(itemId) : null;
  const bound = !!record
    && record.itemId === itemId
    && record.dedupKey === CARD_DEDUP_PREFIX + record.id;
  if (!record || !bound) return { resolved: false, flash: STALE_FLASH, message: STALE_MESSAGE };
  if (item?.source !== "addon-wall" || item?.dedupKey !== record.dedupKey) {
    return { resolved: false, flash: STALE_FLASH, message: STALE_MESSAGE };
  }

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
  return { resolved: true, status, flash: UNWALLED_FLASH, flashParams: { addon: record.id } };
}

/** "Keep it off": answer the card and change nothing else. */
export function keepOffRemedy(_args, ctx) {
  // The owner answered: drop the record too, so a card a crow.db writer sets
  // back to pending can never offer a working unwall again.
  const itemId = Number(ctx?.item?.id);
  const record = Number.isInteger(itemId) && ctx?.item?.source === "addon-wall" ? wallFailureByItemId(itemId) : null;
  if (record) clearWallFailures(record.id);
  return { resolved: true };
}
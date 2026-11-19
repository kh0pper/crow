/**
 * Fix-it remedy: remove a bundle Crow RETIRED (the AI Companion), through the product's
 * own uninstall path.
 *
 * The card carries only the bundle id it names (`args.bundle`); the id is re-checked here
 * against the code-held retired set, so a stored or hand-edited card can remove nothing
 * else. `delete_data` is never offered: uninstall keeps the add-on's own data folder, and
 * that is the whole of what stays behind.
 *
 * The work itself is `uninstallRetiredBundle()` in routes/bundles.js: the SAME handler the
 * Extensions page's Remove button posts to (job, log, skill/env/port/Serve cleanup via the
 * retired-bundle stub manifest, notification, gateway restart), and it also covers a
 * RECORD-only install — an `installed.json` entry whose folder is already gone — so the
 * card cannot answer `fixit_error` on a click that has nothing left to delete but the
 * record. Imported lazily: the bundles router is a big graph and this module is loaded at
 * boot with the other remedies.
 *
 * OWNER ONLY: the uninstall stops containers, closes firewall ports and rewrites
 * `installed.json`, and the Extensions route that does it is an owner action (a peer
 * instance cannot reach it). Calling the handler straight from the card would step around
 * that, so this refuses unless the request is the owner's own password session at this
 * instance (`isLocalPasswordSessionOn` — the same gate restore-bundle-compose.js uses). A
 * peer sign-in, an SSO session, a login made on this box, or a call with no session at all
 * changes nothing and answers with the `fixit_owner_only` flash.
 *
 * The flash tells the truth about WHEN: the uninstall runs as a job, so this waits for it.
 * A finished job answers `fixit_retired_removed` and resolves the card; one that has not
 * finished inside the wait answers `fixit_retired_removing` ("removal started") and leaves
 * the card up for the boot check that answers it once the bundle is really gone; a failed
 * job answers `fixit_error`.
 */
import { isRetiredBundle } from "../../retired-bundles.js";
import { isLocalPasswordSessionOn } from "../../dashboard/local-session.js";
import { t as i18nT } from "../../dashboard/shared/i18n.js";
import { OWNER_ONLY_FLASH, OWNER_ONLY_MESSAGE } from "./restore-bundle-compose.js";

export const ACTION_ID = "remove-retired-bundle";
/** The one i18n key the button's label comes from (en/es). The stored card row keeps the
 *  English LABEL below as a language-neutral default; the rendered card never shows it. */
export const LABEL_KEY = "health.retiredRemove";
/** The stored row's label: English, the dashboard's default language. Rendered localized
 *  from `label(lang)` — the card never shows this stored copy (fix-it/index.js). */
export const LABEL = i18nT(LABEL_KEY, "en");
/** The flash the nest renders once the uninstall job has finished (fix-it/index.js REMEDY_FLASHES). */
export const FLASH = "fixit_retired_removed";
/** The flash it renders while that job is still running. */
export const STARTED_FLASH = "fixit_retired_removing";

/** How long a click waits for the uninstall job before it says "removal started". */
export const JOB_WAIT_MS = 10_000;

/** The button's label in the dashboard's language (i18n `health.retiredRemove`) — the body's
 *  instruction names the same words (`cardWhy` in fix-it/detectors/retired-bundle.js). */
export function label(lang) {
  return i18nT(LABEL_KEY, lang === "es" ? "es" : "en");
}

// Test-only: replace the owner rule (the real one needs a password session in crow.db).
let _ownerCheckForTest = null;
export function _setOwnerCheckForTest(fn) { _ownerCheckForTest = fn || null; }

async function isOwner(db, req) {
  if (_ownerCheckForTest) return (await _ownerCheckForTest(db, req)) === true;
  return (await isLocalPasswordSessionOn(db, req)) === true;
}

export default async function removeRetiredBundle(args = {}, { item, db, req } = {}) {
  const fromArgs = typeof args?.bundle === "string" ? args.bundle : "";
  const fromCard = typeof item?.context?.bundle === "string" ? item.context.bundle : "";
  const bundleId = fromArgs || fromCard;
  if (!isRetiredBundle(bundleId)) return { resolved: false, flash: "fixit_error" };

  let owner = false;
  try { owner = await isOwner(db, req); } catch { owner = false; }
  if (!owner) return { resolved: false, flash: OWNER_ONLY_FLASH, message: OWNER_ONLY_MESSAGE };

  const { uninstallRetiredBundle, waitForJob } = await import("../../routes/bundles.js");
  const answer = await uninstallRetiredBundle(bundleId, { deleteData: false });
  // Never "removed" until the job says so: the route answers with a job id, and the
  // uninstall's own steps (containers, ports, Serve, the record) run after that answer.
  const job = answer?.job_id ? await waitForJob(answer.job_id, { timeoutMs: JOB_WAIT_MS }) : null;
  if (job && job.status === "failed") return { resolved: false, flash: "fixit_error" };
  if (job && typeof job.status === "string" && job.status.startsWith("complete")) {
    return { resolved: true, flash: FLASH };
  }
  // Still running (or already evicted): the card stays up and the boot check answers it.
  return { resolved: false, flash: STARTED_FLASH };
}
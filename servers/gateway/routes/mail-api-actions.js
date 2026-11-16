/**
 * Crow Mail's message actions: read/unread, archive, delete to Trash, and move to another folder, as
 * one route — `POST /dashboard/mail/api/messages/:id/actions {action, folderId?}`.
 *
 * These are plan 1's guards, helpers and error shape, used rather than rebuilt: `mail-api.js` mounts
 * the flag, owner and body-parser chain on this router's prefix before this function registers
 * anything, so every action answers 404 while `CROW_MAIL` is unset, 403 `{error:"owner_only"}` for any
 * session that is not this machine's own password session, and the dashboard's CSRF middleware guards
 * the POST like every other unsafe method on this mount. `ctx.route` opens one database client per
 * request and closes it in `finally`; a failure is logged by code only and answers its MailError code's
 * fixed sentence.
 *
 * Exchange first, local store second — that order is the whole design. The adapter is reached through
 * the supervisor's `withAdapter` (one call at a time per account, a hard per-call deadline, refused
 * without connecting for a claimed or signed-out account), and the caller tells it the UIDVALIDITY it
 * believes the folder has: the folder's STORED `uid_validity` (`expectedUidValidity`). The adapter
 * takes the mailbox lock and compares before any STORE or MOVE, so an action never touches a UID whose
 * folder was reset — whatever message holds that UID now is not the one the person asked about. A
 * mismatch (`CHANGED`) or a count of 0 (the UID is gone) changes nothing locally: the answer is the
 * fixed `changed_on_server` sentence and a full sync, so the reader is rebuilt from what the server
 * really holds.
 *
 * Only after the server agreed does the local store move: read/unread flips every copy row (the same
 * Message-ID, sender and date in another folder — plan 1's `copyRows`, one `setFlags` per folder with
 * that folder's own stored UIDVALIDITY) through `setReadForCopies`, then tells the supervisor that
 * local mail changed, so a sync that is already running does one more pass instead of writing its older
 * flag snapshot back over the change. Archive, delete and move remove the row (`deleteMessageRow`) and
 * ask for the destination folder to be synced — the one folder that must be re-read so the message
 * appears there with the UID the server gave it. A destination the sync engine never syncs (the
 * virtual `\All`, `\Flagged`, `\Important` views) asks for nothing, because there is nothing to ask
 * for.
 *
 * Archive goes to the account's `archive`-role folder, else its `\All` folder, else it refuses — Crow
 * never guesses a folder. Delete goes to Trash, and only to Trash: it is a move, so nothing is ever
 * expunged. A message id from a link is transient here — the row is resolved through Task 1's
 * `resolveMessageRef`, and no id of a stored row appears in an answer.
 */
import { MAIL_ERROR_TEXT, MailError, toMailError } from "../mail/errors.js";
import { getAccount } from "../mail/store/accounts.js";
import {
  copyRows,
  deleteMessageRow,
  folderRole,
  getFolder,
  getMessage,
  listFolders,
  setReadForCopies,
} from "../mail/store/messages.js";
import { resolveMessageRef } from "../mail/store/reader-queries.js";
import { SKIP_SPECIAL_USE } from "../mail/sync/engine.js";
import { withoutWriteContext } from "../../shared/history/write-context.js";
// The mount point plan 1's mail-api.js sets on this same router. It is read when routes are
// registered (that module has finished evaluating by then), never at module load: the two files
// import each other.
import { MAIL_API_PREFIX } from "./mail-api.js";

/** The actions this route performs. Anything else is the caller's input, not a fault. */
const ACTIONS = Object.freeze(["read", "unread", "archive", "delete", "move"]);

/** The one flag Crow owns. A message's other flags are the server's business. */
const SEEN = "\\Seen";

/** One action names at most this many UIDs per adapter call (the adapter contract's own bound). */
const MAX_UIDS_PER_CALL = 100;

/**
 * The two refusals a folder lookup can end in. The plan names the codes; the panel shows its own
 * translated sentence for each (`mail.error.no_archive_folder` / `mail.error.no_trash_folder`), so the
 * `message` here is the API's fixed sentence and never text a person is meant to read.
 */
const NO_ARCHIVE_TEXT = "This account has no folder to archive mail in.";
const NO_TRASH_TEXT = "This account has no folder to delete mail to.";

const SKIPPED_SPECIAL_USE = new Set(SKIP_SPECIAL_USE.map((flag) => flag.toLowerCase()));

/**
 * The action body, or null. `action` is one of the five; `folderId` is a stored folder id, and a move
 * without one is not a move.
 *
 * @param {object|undefined} body
 * @returns {{action: string, folderId: number|null}|null}
 */
function readActionBody(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) return null;
  const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
  if (!ACTIONS.includes(action)) return null;

  let folderId = null;
  if (body.folderId !== undefined && body.folderId !== null && body.folderId !== "") {
    const n = Number(body.folderId);
    if (!Number.isInteger(n) || n <= 0) return null;
    folderId = n;
  }
  if (action === "move" && folderId === null) return null;
  return { action, folderId };
}

/** A stored UIDVALIDITY an adapter may be asked to confirm: a positive integer, or nothing usable. */
function storedValidity(folder) {
  const value = Number(folder?.uidValidity);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** A folder's special-use flags, lower-cased, split on whitespace. */
function specialUseTokens(folder) {
  const text = typeof folder?.specialUse === "string" ? folder.specialUse : "";
  return text.split(/\s+/).map((token) => token.trim().toLowerCase()).filter((token) => token !== "");
}

/** Whether this folder is one the sync engine never syncs (a server's virtual view of real mail). */
function isSkippedFolder(folder) {
  return specialUseTokens(folder).some((token) => SKIPPED_SPECIAL_USE.has(token));
}

/** Whether this folder is the account's `\All` folder (Gmail's All Mail, and its lookalikes). */
function isAllMailFolder(folder) {
  return specialUseTokens(folder).includes("\\all");
}

/** UIDs in batches the adapter contract accepts. */
function uidBatches(uids) {
  const out = [];
  for (let i = 0; i < uids.length; i += MAX_UIDS_PER_CALL) out.push(uids.slice(i, i + MAX_UIDS_PER_CALL));
  return out;
}

/**
 * The stored rows of one message grouped by folder, each group carrying its folder, or null when a
 * folder's stored UIDVALIDITY is not known: an action cannot name a UIDVALIDITY it does not have, and
 * guessing one would be exactly the mistake RF7 forbids. null is the caller's `changed_on_server`.
 *
 * @param {object} db
 * @param {object} row the opened row
 * @returns {Promise<{folder: object, rows: object[]}[]|null>} the row's own group first
 */
async function copiesByFolder(db, row) {
  const copies = await copyRows(db, row);
  if (!copies.length) return null;
  const groups = new Map();
  for (const copy of copies) {
    const folderId = Number(copy.folderId);
    if (groups.has(folderId)) groups.get(folderId).rows.push(copy);
    else groups.set(folderId, { folder: null, rows: [copy] });
  }
  for (const group of groups.values()) {
    const folder = await getFolder(db, group.rows[0].folderId);
    if (!folder || storedValidity(folder) === null) return null;
    group.folder = folder;
  }
  return [...groups.values()];
}

/**
 * Ask for a sync without holding the answer open: a refresh outlives the request that asked for it, so
 * it is opened with no write context and its failure is the supervisor's to report.
 */
function requestSyncInBackground(supervisor, accountId, folderIds, logCode, label) {
  if (!supervisor || typeof supervisor.requestSync !== "function") return;
  const plan = Array.isArray(folderIds) ? { folderIds } : undefined;
  withoutWriteContext(() => {
    Promise.resolve()
      .then(() => supervisor.requestSync(accountId, plan))
      .catch((err) => logCode(label, err));
  });
}

/** Report a local change to the supervisor, if it has anything to tell: a no-op with no sync running. */
function noteChangeQuietly(supervisor, accountId, logCode, label) {
  if (!supervisor || typeof supervisor.noteChange !== "function") return;
  try {
    supervisor.noteChange(accountId);
  } catch (err) {
    logCode(label, err);
  }
}

/**
 * Crow Mail's message action route, registered on the router `mail-api.js` already guards.
 *
 * @param {import("express").Router} router the mail API router (prefix `/dashboard/mail/api`)
 * @param {object} ctx the guards and per-request helpers, as mail-api.js builds them: `{route,
 *   sendError, logCode, supervisor}` — `supervisor()` answers the running supervisor, or null.
 */
export function registerActionRoutes(router, ctx) {
  const { route, sendError } = ctx;
  const logCode = typeof ctx.logCode === "function" ? ctx.logCode : () => {};
  const base = MAIL_API_PREFIX;
  const label = "POST /messages/:id/actions";

  /** The running supervisor, or null when boot started no sync in this process. */
  const supervisorNow = () => {
    const supervisor = typeof ctx.supervisor === "function" ? ctx.supervisor() : null;
    return supervisor && typeof supervisor.withAdapter === "function" ? supervisor : null;
  };

  router.post(`${base}/messages/:id/actions`, route(label, async (db, req, res) => {
    const input = readActionBody(req.body);
    if (!input) return sendError(res, 400, "bad_input");

    const rowId = Number(req.params.id);
    if (!Number.isInteger(rowId) || rowId <= 0) return sendError(res, 404, "not_found");
    // The account the row belongs to, then the row itself through the reader's own reference rule, so
    // an action can only ever land on a row of the account that row is stored under.
    const anchor = await getMessage(db, rowId);
    if (!anchor) return sendError(res, 404, "not_found");
    const account = await getAccount(db, anchor.accountId);
    if (!account) return sendError(res, 404, "not_found");
    const row = await resolveMessageRef(db, { accountId: account.id, row: rowId });
    if (!row) return sendError(res, 404, "not_found");
    const sourceFolder = await getFolder(db, row.folderId);
    if (!sourceFolder || sourceFolder.accountId !== account.id) return sendError(res, 404, "not_found");

    const supervisor = supervisorNow();
    if (!supervisor) return sendError(res, 503, "unavailable");

    /**
     * The mailbox moved under us: nothing was written locally, and the reader is rebuilt from the
     * server. The sentence is the one the attachment route already answers with for the same fault.
     */
    const changedOnServer = () => {
      requestSyncInBackground(supervisor, account.id, null, logCode, label);
      return sendError(res, 409, "changed_on_server", MAIL_ERROR_TEXT.CHANGED);
    };

    /**
     * One adapter call through the borrowed connection. True when the server agreed; false when it
     * says the message is not what the row thought (a changed mailbox, or a UID that is gone).
     */
    const withActionAdapter = async (work) => {
      try {
        await supervisor.withAdapter(account.id, (adapter) => work(adapter));
        return true;
      } catch (err) {
        const mailErr = toMailError(err);
        if (mailErr.code === "CHANGED") return false;
        throw mailErr;
      }
    };

    /* ------------------------------------------------------------ read, unread */

    if (input.action === "read" || input.action === "unread") {
      const isRead = input.action === "read";
      // The copies are read before anything is sent: a folder whose stored UIDVALIDITY is unknown
      // makes the whole action the changed answer, with no adapter call at all.
      const groups = await copiesByFolder(db, row);
      if (groups === null) return changedOnServer();

      const agreed = await withActionAdapter(async (adapter) => {
        for (const group of groups) {
          for (const uids of uidBatches(group.rows.map((copy) => Number(copy.uid)))) {
            const answer = await adapter.setFlags(group.folder.path, uids, {
              ...(isRead ? { add: [SEEN] } : { remove: [SEEN] }),
              expectedUidValidity: storedValidity(group.folder),
            });
            // Nothing there is the message being gone, not a flag change: the caller reads it as
            // changed on the server.
            if (Number(answer?.updated) === 0) throw new MailError("CHANGED", "uid");
          }
        }
      });
      if (!agreed) return changedOnServer();

      await setReadForCopies(db, row, isRead);
      noteChangeQuietly(supervisor, account.id, logCode, label);
      return res.json({ ok: true, isRead });
    }

    /* ------------------------------------------------- archive, delete, move */

    let destinationFolder = null;
    if (input.action === "archive") {
      const folders = await listFolders(db, account.id);
      destinationFolder = folders.find((folder) => folderRole(folder) === "archive")
        ?? folders.find((folder) => isAllMailFolder(folder))
        ?? null;
      if (!destinationFolder) return sendError(res, 409, "no_archive_folder", NO_ARCHIVE_TEXT);
    } else if (input.action === "delete") {
      const folders = await listFolders(db, account.id);
      destinationFolder = folders.find((folder) => folderRole(folder) === "trash") ?? null;
      if (!destinationFolder) return sendError(res, 409, "no_trash_folder", NO_TRASH_TEXT);
    } else {
      destinationFolder = await getFolder(db, input.folderId);
      if (!destinationFolder || destinationFolder.accountId !== account.id) return sendError(res, 400, "bad_input");
    }
    // A move onto the folder the message is already in is not a move, and the adapter's answer to it
    // would be a UID nobody asked about.
    if (destinationFolder.id === sourceFolder.id) return sendError(res, 400, "bad_input");
    // A source folder whose UIDVALIDITY the store does not hold cannot be acted on: the UID means
    // nothing without it.
    if (storedValidity(sourceFolder) === null) return changedOnServer();

    const agreed = await withActionAdapter(async (adapter) => {
      const answer = await adapter.move(sourceFolder.path, [Number(row.uid)], destinationFolder.path, {
        expectedUidValidity: storedValidity(sourceFolder),
      });
      if (Number(answer?.moved) === 0) throw new MailError("CHANGED", "uid");
    });
    if (!agreed) return changedOnServer();

    await deleteMessageRow(db, row.id);
    if (!isSkippedFolder(destinationFolder)) {
      requestSyncInBackground(supervisor, account.id, [destinationFolder.id], logCode, label);
    }
    res.json({ ok: true, movedTo: destinationFolder.id });
  }));
}

export default registerActionRoutes;
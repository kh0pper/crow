/**
 * The two attachment readers a draft's preflight needs: one message's raw bytes, fetched from the
 * account's own server through the supervisor's borrowed connection, and one Crow storage file's
 * bytes.
 *
 * The thread reader is the reader route's own fetch, moved here so the send service, the schedule
 * service and the hook all read a message the same way: the stored row names a folder and a UID, the
 * folder must belong to the account the draft is written from, and only that UID is asked for. The
 * adapter answers an empty Buffer for a message over its own raw-size limit, so an empty answer is
 * "not readable here" (null) rather than an empty file. A library failure is classified with
 * `toMailError`, exactly as the reader route does, so a caller sees one of the mail codes and never a
 * server's text.
 *
 * The storage reader answers null: Crow's storage has no owner-checked read-by-file-id helper — the
 * HTTP surface signs a download for a key it is handed, and `storage_files` rows are scoped to a
 * project (or to nothing), not to a person. A file reference therefore cannot be resolved to bytes
 * safely from here, and preflight refuses a revision that carries one instead of sending the message
 * short.
 */
import { toMailError } from "../errors.js";
import { getFolder } from "../store/messages.js";

/** The bytes a UID fetch handed back, whatever binary flavour the adapter used, or null. */
function rawBufferOf(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/**
 * The two readers, bound to one database client and (when this process runs one) the mail
 * supervisor.
 *
 * @param {{db: object, supervisor?: object|null}} options
 *   `supervisor` is the running supervisor's `withAdapter` host; without one neither reader can reach
 *   a mailbox, so a thread attachment reads as absent.
 * @returns {{readMessageRaw: (ref: {accountId?: string, mid?: string|null, row?: object|null})
 *   => Promise<Buffer|null>, readStorageFile: (fileId: string) => Promise<null>}}
 */
export function makeDraftReaders({ db, supervisor = null } = {}) {
  const canFetch = supervisor != null && typeof supervisor.withAdapter === "function";

  /**
   * One stored message's raw bytes, or null when it cannot be read: no supervisor, a row that names
   * no UID, a folder that is not this account's, a message the server no longer holds, or one over
   * the adapter's raw-size limit (an empty Buffer).
   */
  async function readMessageRaw({ accountId, mid, row } = {}) {
    if (!canFetch) return null;
    const account = typeof accountId === "string" ? accountId.trim() : "";
    const uid = Number(row?.uid);
    if (!account || !Number.isInteger(uid) || uid <= 0) return null;
    const folder = await getFolder(db, row?.folderId);
    if (!folder || folder.accountId !== account) return null;

    let fetched;
    try {
      fetched = await supervisor.withAdapter(account, (adapter) => adapter.get(folder.path, [uid]));
    } catch (err) {
      throw toMailError(err);
    }
    const items = Array.isArray(fetched) ? fetched : [];
    const item = items.find((entry) => Number(entry?.uid) === uid);
    const raw = rawBufferOf(item?.raw);
    if (!raw || raw.length === 0) return null;
    return raw;
  }

  /** No owner-checked storage read exists (see the module note): a file reference resolves to null. */
  async function readStorageFile() {
    return null;
  }

  return { readMessageRaw, readStorageFile };
}

export default makeDraftReaders;
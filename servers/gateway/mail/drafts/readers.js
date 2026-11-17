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
 * The storage reader takes one thing from its caller: a file id. Crow's storage HTTP surface signs a
 * download for whatever key it is handed, so a caller that could name a key, a path or a URL could
 * read any object in the bucket. This reader therefore accepts only a digits-only id, looks that id
 * up in `storage_files`, and takes the object key from the row — never from the caller. The row must
 * be the instance's own default bucket (a file some other feature filed elsewhere is not an
 * attachment this reader serves) and must be either unscoped or scoped to the project the draft
 * belongs to; a file of another project reads exactly as a file that does not exist. A row whose
 * recorded size is over `MAX_SEND_BYTES` is refused before the object store is touched at all, and a
 * fetched object over the same ceiling is refused too — by the object's own reported size before a
 * byte of it is read, and otherwise by a running count that destroys the stream at the chunk which
 * passes the ceiling — so a stale row with no recorded size cannot slip one past, and no oversized
 * object is ever held in memory whole. A storage that is not configured, a missing object, a broken
 * stream and any other failure all answer null: the reader never throws, so a caller's own refusal
 * stays the one a person sees.
 *
 * Both readers answer `null` for "there is nothing readable here"; `readStorageFile` answers
 * `{content, filename, contentType}` from the row (`original_name` and `mime_type`) when there is,
 * so preflight can name the attachment the way the picker showed it.
 */
import { defaultBucket, getObject, isConfigured } from "../../../storage/s3-client.js";
import { toMailError } from "../errors.js";
import { getFolder } from "../store/messages.js";

/**
 * The largest total an outgoing message may carry, in the attachments' own bytes (base64 is not
 * counted): plan 2's effective ceiling, where an attachment above roughly 18 MB is already refused by
 * the raw-message rule before this one is reached. Preflight re-exports it, so the ceiling a reader
 * refuses and the ceiling a send counts are one number.
 */
export const MAX_SEND_BYTES = 18 * 1024 * 1024;

/** A storage file's id as `storage_files` holds it: decimal digits, and nothing else. */
const FILE_ID_RE = /^[0-9]{1,15}$/;

/** The bytes a UID fetch handed back, whatever binary flavour the adapter used, or null. */
function rawBufferOf(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/** A chunk of a stream as a Buffer, whatever the stream handed over. */
function chunkBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof ArrayBuffer) return Buffer.from(new Uint8Array(chunk));
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  return Buffer.alloc(0);
}

/**
 * The bytes of one object answer, whether the seam handed back `getObject`'s `{stream, stat}`, a
 * stream on its own or the bytes themselves; null when the answer holds nothing readable. A stream
 * that fails part-way is null too, never a short file. The ceiling is enforced twice: the object's
 * own reported size is refused before a byte is pulled, and a running count stops a stream whose
 * real size is larger — a row recorded with no size (a presigned upload) is exactly that case — by
 * destroying the stream at the chunk that passes `MAX_SEND_BYTES`, so the answer is null and never a
 * partial object.
 */
async function objectBytes(answer) {
  if (answer == null) return null;
  const direct = rawBufferOf(answer);
  if (direct) return direct;
  if (typeof answer !== "object") return null;
  const stream = answer.stream ?? answer;
  if (stream == null || typeof stream !== "object") return null;

  const declared = Number(answer.stat?.size);
  if (Number.isFinite(declared) && declared > MAX_SEND_BYTES) return null;

  if (typeof stream[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of stream) {
        const buffer = chunkBuffer(chunk);
        total += buffer.length;
        if (total > MAX_SEND_BYTES) {
          stream.destroy?.();
          return null;
        }
        chunks.push(buffer);
      }
    } catch {
      return null;
    }
    return Buffer.concat(chunks);
  }
  if (typeof stream.on === "function") {
    return new Promise((resolve) => {
      const chunks = [];
      let total = 0;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      stream.on("data", (chunk) => {
        if (settled) return;
        const buffer = chunkBuffer(chunk);
        total += buffer.length;
        if (total > MAX_SEND_BYTES) {
          stream.destroy?.();
          finish(null);
          return;
        }
        chunks.push(buffer);
      });
      stream.on("error", () => finish(null));
      stream.on("end", () => finish(Buffer.concat(chunks)));
      if (typeof stream.resume === "function") stream.resume();
    });
  }
  return null;
}

/**
 * The two readers, bound to one database client and (when this process runs one) the mail
 * supervisor.
 *
 * @param {{db: object, supervisor?: object|null, getObject?: Function, isConfigured?: Function,
 *   defaultBucket?: Function}} [options]
 *   `supervisor` is the running supervisor's `withAdapter` host; without one a thread attachment reads
 *   as absent. The three storage functions are the object-store seam: a caller that does not pass one
 *   gets `servers/storage/s3-client.js`'s own.
 * @returns {{readMessageRaw: (ref: {accountId?: string, mid?: string|null, row?: object|null})
 *   => Promise<Buffer|null>, readStorageFile: (fileId: string, ctx?: {projectId?: number|null})
 *   => Promise<{content: Buffer, filename: string, contentType: string}|null>}}
 */
export function makeDraftReaders({
  db,
  supervisor = null,
  getObject: getObjectOption,
  isConfigured: isConfiguredOption,
  defaultBucket: defaultBucketOption,
} = {}) {
  const canFetch = supervisor != null && typeof supervisor.withAdapter === "function";
  const readObject = typeof getObjectOption === "function" ? getObjectOption : getObject;
  const storageConfigured = typeof isConfiguredOption === "function" ? isConfiguredOption : isConfigured;
  const storageBucket = typeof defaultBucketOption === "function" ? defaultBucketOption : defaultBucket;

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

  /** One `storage_files` row by its numeric id, or null when the store cannot answer. */
  async function storageRow(fileId) {
    try {
      const { rows } = await db.execute({
        sql: `SELECT id, s3_key, original_name, mime_type, size_bytes, bucket, project_id
                FROM storage_files WHERE id = ?`,
        args: [fileId],
      });
      return rows[0] ?? null;
    } catch {
      return null;
    }
  }

  /**
   * One Crow storage file's bytes, for the draft the caller is building: the id must be digits, the
   * row must be the default bucket's and either unscoped or scoped to `ctx.projectId`, and the object
   * is fetched by the row's own key. Anything else is null — a non-configured storage, a missing
   * object, a failed stream, a refused row — and this function never throws.
   *
   * @param {string} fileId the row's id, as the digits-only string the picker hands over
   * @param {{projectId?: number|null}} [ctx] the draft's project: a file of another project is absent
   */
  async function readStorageFile(fileId, ctx = {}) {
    if (typeof fileId !== "string" || !FILE_ID_RE.test(fileId)) return null;
    const projectId = ctx?.projectId == null ? null : Number(ctx.projectId);
    const row = await storageRow(Number(fileId));
    if (!row) return null;

    const bucket = storageBucket();
    if (typeof row.bucket !== "string" || row.bucket !== bucket) return null;
    const rowProject = row.project_id == null ? null : Number(row.project_id);
    if (rowProject != null && rowProject !== projectId) return null;

    // The row's own recorded size is the first ceiling: a file known to be too large is refused
    // before the object store is asked for anything.
    const recorded = row.size_bytes == null ? null : Number(row.size_bytes);
    if (recorded != null && (!Number.isFinite(recorded) || recorded < 0 || recorded > MAX_SEND_BYTES)) return null;
    if (typeof row.s3_key !== "string" || row.s3_key === "") return null;
    if (!storageConfigured()) return null;

    let answer;
    try {
      answer = await readObject(row.s3_key, { bucket });
    } catch {
      return null;
    }
    const content = await objectBytes(answer);
    // An empty answer is "nothing readable here", the same reading the thread reader gives an empty
    // message: a zero-byte attachment is not something a send can carry either.
    if (!content || content.length === 0) return null;
    if (content.length > MAX_SEND_BYTES) return null;

    return {
      content,
      filename: typeof row.original_name === "string" ? row.original_name : "",
      contentType: typeof row.mime_type === "string" ? row.mime_type : "",
    };
  }

  return { readMessageRaw, readStorageFile };
}

export default makeDraftReaders;
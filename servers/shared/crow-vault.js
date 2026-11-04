/**
 * crow-vault/v1 — the encrypted container for the nightly crow.db backup kept off-site
 * (spec §12). Node built-ins only: crypto (AES-256-GCM) + zlib (brotli), so a restore can run
 * with no gateway, no DB and no dependencies.
 *
 * Streaming end to end: a backup is over 100 MB today, so neither encrypt nor decrypt ever holds
 * one in memory. The largest buffer this module builds is one 1 MiB chunk.
 *
 * Binary framing (every integer big-endian):
 *
 *   offset 0    8 bytes   magic "CROWVLT1"
 *   offset 8    4 bytes   header length H (a reader refuses H > 65536 before reading it)
 *   offset 12   H bytes   header JSON (UTF-8, exactly the §12.2 object):
 *                         {v, created_at, backup_date, source_instance_id, crow_id, key_id,
 *                          chunk_size: 1048576, compression: "br"}
 *   then one or more chunks, each:
 *                4 bytes   ciphertext length L
 *               12 bytes   nonce = 8 random bytes (fixed per file) || 4-byte chunk counter
 *                L bytes   AES-256-GCM ciphertext of that slice of the compressed stream
 *               16 bytes   GCM tag
 *
 * AAD = sha256(header JSON) || 4-byte chunk index || 1-byte final flag (1 only on the last
 * chunk). The final flag is not stored in the clear, so a reader tries 0 first and, only when that
 * tag fails, tries 1 — that is how it learns a chunk is the last one without trusting an
 * unauthenticated bit. Between them the AAD, the tag and two cheap format rules (the nonce's
 * counter must equal the chunk index, and every chunk's 8-byte prefix must equal the first
 * chunk's) make truncation, reordering, a flipped bit and a chunk spliced from another file fail
 * the tag rather than decrypt to garbage.
 *
 * An empty input still ends with one (empty) final chunk, so "the file ends with a final chunk"
 * is always a real statement: a reader that runs out of bytes first reports `truncated`.
 *
 * Key: 32 random bytes (the off-site backup key). `key_id` in the header is the first 8 bytes of
 * sha256(key) as hex — 16 characters, enough to name a key without carrying one.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, open as openFile, unlink } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { constants as zlibConstants, createBrotliCompress, createBrotliDecompress } from "node:zlib";

export const MAGIC = Buffer.from("CROWVLT1", "latin1");
export const VAULT_VERSION = 1;
export const CHUNK_SIZE = 1048576;
export const HEADER_MAX = 65536;
export const NONCE_LEN = 12;
export const TAG_LEN = 16;
export const NONCE_PREFIX_LEN = 8;
/** What a reader tolerates before calling a chunk too big (spec: "chunk size plus overhead"). */
export const MAX_CIPHERTEXT = CHUNK_SIZE + NONCE_LEN + TAG_LEN;
/** Brotli quality for the body. Level 11 buys a few percent over 5 on SQLite pages and costs
 * minutes on a 100 MB file; the nightly job has to finish. */
export const BODY_QUALITY = 5;

const DAY_MS = 24 * 60 * 60 * 1000;
const KEY_LEN = 32;

/**
 * The off-site backup key is an ordinary keychain entry with a fixed identity, so the restore CLI
 * can find it inside an export with no DB at all (spec §12.4). `bundleId` is not an installed
 * bundle: it only names the entry.
 */
export const OFFSITE_KEY = Object.freeze({
  bundleId: "offsite-backup",
  envKey: "CROW_OFFSITE_BACKUP_KEY",
  label: "Off-site backup key",
});

/** Every refusal this module can raise. Each has its own code (spec §12.2). */
export const REFUSALS = Object.freeze({
  BAD_MAGIC: "bad_magic",
  BAD_VERSION: "bad_version",
  BAD_HEADER: "bad_header",
  HEADER_TOO_LARGE: "header_too_large",
  BAD_CHUNK_SIZE: "bad_chunk_size",
  KEY_MISMATCH: "key_mismatch",
  CHUNK_TOO_LARGE: "chunk_too_large",
  TAG_FAILURE: "tag_failure",
  TRUNCATED: "truncated",
  TRAILING_DATA: "trailing_data",
  ROLLBACK: "rollback",
  PARTIAL_EXISTS: "partial_exists",
  OUT_EXISTS: "out_exists",
});

export class VaultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

const refuse = (code, message) => new VaultError(code, message);

// --- key handling -----------------------------------------------------------

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LEN) throw new Error(`crow-vault: the key must be ${KEY_LEN} bytes`);
}

/** `key_id` = the first 8 bytes of sha256(key), hex: 16 characters. */
export function keyId(key) {
  assertKey(key);
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** The key as its keychain string form (base64), the only form that is ever stored or exported. */
export function encodeVaultKey(key) {
  assertKey(key);
  return key.toString("base64");
}

/** The 32-byte key from a keychain string: base64 (what Crow writes) or hex (hand-typed). */
export function vaultKeyFromSecret(secret) {
  if (typeof secret !== "string") return null;
  const s = secret.trim();
  let buf = null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) buf = Buffer.from(s, "hex");
  else if (/^[A-Za-z0-9+/]{43}=$/.test(s)) buf = Buffer.from(s, "base64");
  return buf && buf.length === KEY_LEN ? buf : null;
}

/** The off-site key out of decrypted export entries, or null when the export does not hold it. */
export function offsiteKeyFromEntries(entries) {
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.kind !== "extension" || e.bundle_id !== OFFSITE_KEY.bundleId || e.env_key !== OFFSITE_KEY.envKey) continue;
    const key = vaultKeyFromSecret(e.secret);
    if (key) return key;
  }
  return null;
}

// --- header -----------------------------------------------------------------

const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`));
const isText = (s) => typeof s === "string" && s.length > 0 && s.length <= 512;

/** The §12.2 header object, in the documented field order (its bytes are part of every AAD). */
export function buildVaultHeader({ key, backupDate, createdAt = new Date(), sourceInstanceId, crowId } = {}) {
  assertKey(key);
  if (!isDate(backupDate)) throw new Error("crow-vault: backupDate must be YYYY-MM-DD");
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(created.getTime())) throw new Error("crow-vault: createdAt must be a date");
  if (!isText(sourceInstanceId)) throw new Error("crow-vault: sourceInstanceId is required");
  if (!isText(crowId)) throw new Error("crow-vault: crowId is required");
  return {
    v: VAULT_VERSION,
    created_at: created.toISOString(),
    backup_date: backupDate,
    source_instance_id: sourceInstanceId,
    crow_id: crowId,
    key_id: keyId(key),
    chunk_size: CHUNK_SIZE,
    compression: "br",
  };
}

/**
 * sha256 over the header's bytes as they sit in the file: the first field of every chunk's AAD.
 * Accepts the exact bytes (what a reader has) or the header object (what a writer is about to
 * serialise), so both sides digest the same thing. Never re-serialise bytes that were read: a
 * differently formatted header from another writer must still verify.
 */
function headerDigest(headerOrBytes) {
  const bytes = Buffer.isBuffer(headerOrBytes) ? headerOrBytes : Buffer.from(JSON.stringify(headerOrBytes), "utf8");
  return createHash("sha256").update(bytes).digest();
}

// --- framing primitives -----------------------------------------------------

const u32 = (n) => {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};

/** AAD = sha256(header) || chunk index (4 BE) || final flag (1 byte). */
function aad(digest, index, final) {
  const b = Buffer.allocUnsafe(digest.length + 5);
  digest.copy(b, 0);
  b.writeUInt32BE(index >>> 0, digest.length);
  b[digest.length + 4] = final ? 1 : 0;
  return b;
}

/** Resolves once the chunk reached the sink; a stream error rejects (never a silent partial). */
function writeBuf(stream, buf) {
  return new Promise((resolve, reject) => {
    stream.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Byte-exact reader over an async iterable of Buffers (a file stream, or `Readable.from`). Reads
 * spanning several source chunks are joined; nothing bigger than the requested size is buffered.
 */
export class ByteSource {
  constructor(source) {
    const iterable = typeof source?.[Symbol.asyncIterator] === "function" ? source : Readable.from(source);
    this.it = iterable[Symbol.asyncIterator]();
    this.buf = null;
    this.off = 0;
  }

  async readExactly(n) {
    if (n === 0) return Buffer.alloc(0);
    const parts = [];
    let need = n;
    while (need > 0) {
      if (!this.buf || this.off >= this.buf.length) {
        const r = await this.it.next();
        if (r.done) throw refuse(REFUSALS.TRUNCATED, `the file ends ${n - need} bytes into a ${n}-byte field`);
        this.buf = Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value);
        this.off = 0;
        continue;
      }
      const take = Math.min(need, this.buf.length - this.off);
      parts.push(this.buf.subarray(this.off, this.off + take));
      this.off += take;
      need -= take;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, n);
  }

  /** True only when nothing at all is left in the source. */
  async atEnd() {
    if (this.buf && this.off < this.buf.length) return false;
    for (;;) {
      const r = await this.it.next();
      if (r.done) return true;
      const b = Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value);
      if (b.length) {
        this.buf = b;
        this.off = 0;
        return false;
      }
    }
  }
}

// --- body: brotli-compressed bytes in, AES-256-GCM chunks out (and back) ----

/** Writes the framed, encrypted body. Export is a seam: it is testable without depending on
 * brotli's exact output size (see tests/crow-vault-format.test.js). `header` is the header object
 * or, better, the exact bytes that were written to the file. */
export class VaultBodyWriter {
  constructor({ key, header, write, nonceBase = null, onChunk = null } = {}) {
    assertKey(key);
    if (!header || typeof header !== "object") throw new Error("crow-vault: a header is required");
    if (typeof write !== "function") throw new Error("crow-vault: a write function is required");
    this.key = key;
    this.digest = headerDigest(header);
    this.write = write;
    this.nonceBase = nonceBase || randomBytes(NONCE_PREFIX_LEN);
    if (!Buffer.isBuffer(this.nonceBase) || this.nonceBase.length !== NONCE_PREFIX_LEN) throw new Error(`crow-vault: nonceBase must be ${NONCE_PREFIX_LEN} bytes`);
    this.onChunk = onChunk;
    this.buf = Buffer.allocUnsafe(CHUNK_SIZE);
    this.fill = 0;
    this.index = 0;
    this.ended = false;
  }

  async #emit(final) {
    // 32-bit counters cap one file at 4 GiB of compressed body; a bigger backup splits by date.
    if (this.index > 0xffffffff) throw new Error("crow-vault: too many chunks for one file");
    const nonce = Buffer.allocUnsafe(NONCE_LEN);
    this.nonceBase.copy(nonce, 0);
    nonce.writeUInt32BE(this.index, NONCE_PREFIX_LEN);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce, { authTagLength: TAG_LEN });
    cipher.setAAD(aad(this.digest, this.index, final));
    const head = cipher.update(this.buf.subarray(0, this.fill));
    const tail = cipher.final();
    const tag = cipher.getAuthTag();
    const length = head.length + tail.length;
    await this.write(u32(length));
    await this.write(nonce);
    if (head.length) await this.write(head);
    if (tail.length) await this.write(tail);
    await this.write(tag);
    if (typeof this.onChunk === "function") this.onChunk({ index: this.index, length, final });
    this.index += 1;
    this.fill = 0;
  }

  /** Accept any size; emits a chunk each time 1 MiB has accumulated. */
  async push(chunk) {
    if (this.ended) throw new Error("crow-vault: push after end");
    if (!chunk || chunk.length === 0) return;
    let off = 0;
    while (off < chunk.length) {
      const take = Math.min(CHUNK_SIZE - this.fill, chunk.length - off);
      chunk.copy(this.buf, this.fill, off, off + take);
      this.fill += take;
      off += take;
      if (this.fill === CHUNK_SIZE) await this.#emit(false);
    }
  }

  /** Always writes one final-flagged chunk, empty when the stream ended on a boundary. */
  async end() {
    if (this.ended) return;
    this.ended = true;
    await this.#emit(true);
  }
}

/** Reads and verifies the framed body, yielding plaintext (still brotli-compressed) chunks. */
export class VaultBodyReader {
  constructor({ source, key, header = null, digest = null, onChunk = null } = {}) {
    assertKey(key);
    if (!source || typeof source.readExactly !== "function") throw new Error("crow-vault: a ByteSource is required");
    if (!digest && !header) throw new Error("crow-vault: the header bytes (or the header) are required");
    this.source = source;
    this.key = key;
    this.digest = digest || headerDigest(header);
    this.onChunk = onChunk;
    this.index = 0;
    this.prefix = null;
  }

  #open(nonce, ct, tag, final) {
    try {
      const d = createDecipheriv("aes-256-gcm", this.key, nonce, { authTagLength: TAG_LEN });
      d.setAAD(aad(this.digest, this.index, final));
      d.setAuthTag(tag);
      const head = d.update(ct);
      const tail = d.final();
      return tail.length ? Buffer.concat([head, tail]) : head;
    } catch {
      return null; // tag failure: indistinguishable from a wrong key, by design
    }
  }

  async *plaintext() {
    for (;;) {
      const lenBuf = await this.source.readExactly(4);
      const length = lenBuf.readUInt32BE(0);
      if (length > MAX_CIPHERTEXT) {
        throw refuse(REFUSALS.CHUNK_TOO_LARGE, `chunk ${this.index} claims ${length} bytes; the most a chunk may hold is ${MAX_CIPHERTEXT}`);
      }
      const nonce = await this.source.readExactly(NONCE_LEN);
      if (nonce.readUInt32BE(NONCE_PREFIX_LEN) !== this.index) {
        throw refuse(REFUSALS.TAG_FAILURE, `chunk ${this.index} carries the nonce of another chunk (reordered or spliced file)`);
      }
      const prefix = nonce.subarray(0, NONCE_PREFIX_LEN);
      if (this.prefix === null) this.prefix = Buffer.from(prefix);
      else if (!prefix.equals(this.prefix)) throw refuse(REFUSALS.TAG_FAILURE, `chunk ${this.index} was sealed for a different file`);
      const ct = length ? await this.source.readExactly(length) : Buffer.alloc(0);
      const tag = await this.source.readExactly(TAG_LEN);
      // The final flag is authenticated but not stored: try "not last" first, then "last".
      let pt = this.#open(nonce, ct, tag, false);
      let final = false;
      if (pt === null) {
        pt = this.#open(nonce, ct, tag, true);
        final = pt !== null;
      }
      if (pt === null) throw refuse(REFUSALS.TAG_FAILURE, `chunk ${this.index} does not authenticate (wrong key, damage, or a chunk from another file)`);
      const index = this.index;
      this.index += 1;
      if (typeof this.onChunk === "function") this.onChunk({ index, length, final, plaintext_length: pt.length });
      if (pt.length) yield pt;
      if (final) {
        if (!(await this.source.atEnd())) throw refuse(REFUSALS.TRAILING_DATA, "the file continues past its final chunk");
        return;
      }
    }
  }
}

// --- preamble ---------------------------------------------------------------

/**
 * Reads and validates magic, header length, header JSON, chunk_size, version, key_id and the
 * rollback window — in that order, because `chunk_size` must be settled before anything else in
 * the header is believed (spec §12.2).
 */
async function readPreamble(source, { key = null, date = null } = {}) {
  const magic = await source.readExactly(MAGIC.length);
  if (!magic.equals(MAGIC)) throw refuse(REFUSALS.BAD_MAGIC, "this is not a crow-vault file");

  const hlen = (await source.readExactly(4)).readUInt32BE(0);
  if (hlen > HEADER_MAX) throw refuse(REFUSALS.HEADER_TOO_LARGE, `the header claims ${hlen} bytes; the limit is ${HEADER_MAX}`);

  const bytes = await source.readExactly(hlen);
  let header;
  try {
    header = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw refuse(REFUSALS.BAD_HEADER, "the header is not JSON");
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) throw refuse(REFUSALS.BAD_HEADER, "the header is not an object");

  if (header.chunk_size !== CHUNK_SIZE) throw refuse(REFUSALS.BAD_CHUNK_SIZE, `chunk_size ${header.chunk_size} is not ${CHUNK_SIZE}`);
  if (header.v !== VAULT_VERSION) throw refuse(REFUSALS.BAD_VERSION, `version ${header.v} is not ${VAULT_VERSION}`);
  if (header.compression !== "br") throw refuse(REFUSALS.BAD_HEADER, `compression "${header.compression}" is not "br"`);
  if (typeof header.key_id !== "string" || !/^[0-9a-f]{16}$/.test(header.key_id)) throw refuse(REFUSALS.BAD_HEADER, "the header carries no usable key_id");
  if (!isText(header.source_instance_id) || !isText(header.crow_id)) throw refuse(REFUSALS.BAD_HEADER, "the header names no source instance or Crow ID");

  if (key) {
    const want = keyId(key);
    if (header.key_id !== want) throw refuse(REFUSALS.KEY_MISMATCH, `this file was sealed with key ${header.key_id}, not ${want}`);
  }
  if (date) checkRollback(header, date);
  // The body's AAD starts from the digest of THESE bytes, never of a re-serialised header.
  return { header, digest: headerDigest(bytes) };
}

/**
 * The rollback window (spec §12.2): the header's backup_date must be the requested date, and
 * created_at must fall inside that date ± 1 day. A satellite cannot then serve an older file
 * under a newer name.
 */
function checkRollback(header, date) {
  if (!isDate(date)) throw new Error("crow-vault: date must be YYYY-MM-DD");
  if (header.backup_date !== date) throw refuse(REFUSALS.ROLLBACK, `the file holds the backup for ${header.backup_date}, not ${date}`);
  const created = Date.parse(header.created_at);
  if (!Number.isFinite(created)) throw refuse(REFUSALS.BAD_HEADER, "the header's created_at is not a date");
  const dayStart = Date.parse(`${date}T00:00:00Z`);
  if (created < dayStart - DAY_MS || created >= dayStart + 2 * DAY_MS) {
    throw refuse(REFUSALS.ROLLBACK, `the file was created at ${header.created_at}, outside ${date} ± 1 day`);
  }
}

/** The header alone, with every check that needs no body. `key` and `date` are optional. */
export async function readVaultHeader({ file, key = null, date = null } = {}) {
  if (typeof file !== "string" || !file) throw new Error("crow-vault: file is required");
  const stream = createReadStream(file);
  try {
    return (await readPreamble(new ByteSource(stream), { key, date })).header;
  } finally {
    stream.destroy();
  }
}

// --- encrypt / decrypt ------------------------------------------------------

/**
 * Encrypt `input` (a path, a Buffer, or a Readable) into `output` (a path or a Writable).
 * Returns the header that was written. `onChunk({index,length,final})` is the streaming seam.
 */
export async function encryptVault({
  input, output, key, backupDate, createdAt = new Date(), sourceInstanceId, crowId,
  onChunk = null, quality = BODY_QUALITY,
} = {}) {
  assertKey(key);
  const header = buildVaultHeader({ key, backupDate, createdAt, sourceInstanceId, crowId });
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  if (headerBytes.length > HEADER_MAX) throw new Error("crow-vault: the header is too large");

  const toPath = typeof output === "string";
  const out = toPath ? createWriteStream(output, { flags: "wx", mode: 0o600 }) : output; // O_EXCL: never write into a file someone else made
  if (!out || typeof out.write !== "function") throw new Error("crow-vault: output must be a path or a Writable");
  const source = typeof input === "string" ? createReadStream(input) : Buffer.isBuffer(input) ? Readable.from([input]) : input;
  if (!source || typeof source[Symbol.asyncIterator] !== "function") throw new Error("crow-vault: input must be a path, a Buffer or a Readable");

  const body = new VaultBodyWriter({ key, header: headerBytes, write: (buf) => writeBuf(out, buf), onChunk });
  try {
    await writeBuf(out, Buffer.concat([MAGIC, u32(headerBytes.length), headerBytes]));
    const brotli = createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: quality } });
    const sink = new Writable({
      write(chunk, _enc, cb) { body.push(chunk).then(() => cb(), cb); },
      final(cb) { body.end().then(() => cb(), cb); },
    });
    await pipeline(source, brotli, sink);
    out.end();
    await finished(out);
    return header;
  } catch (err) {
    out.destroy();
    await finished(out).catch(() => {});
    if (toPath) await unlink(output).catch(() => {});
    throw err;
  }
}

/**
 * Decrypt `file` to `out`. Plaintext goes to `<out>.partial` and is renamed only after the final
 * chunk verifies, so a half-written file never sits at `out` looking complete. `date` is the
 * requested backup date for the rollback check. Returns the header.
 */
export async function decryptVault({ file, out, key, date, onChunk = null } = {}) {
  assertKey(key);
  if (typeof file !== "string" || !file) throw new Error("crow-vault: file is required");
  if (typeof out !== "string" || !out) throw new Error("crow-vault: out is required");
  if (!isDate(date)) throw new Error("crow-vault: date must be YYYY-MM-DD");

  const partial = `${out}.partial`;
  const stream = createReadStream(file);
  const source = new ByteSource(stream);
  let preamble;
  try {
    preamble = await readPreamble(source, { key, date });
  } catch (err) {
    stream.destroy();
    throw err;
  }

  const reader = new VaultBodyReader({ source, key, digest: preamble.digest, onChunk });
  // O_EXCL ("wx"): the partial must be a file THIS run creates (so 0600 really applies and
  // nobody else's file or link receives the decrypted database). An existing partial refuses.
  let handle;
  try {
    handle = await openFile(partial, "wx", 0o600);
  } catch (err) {
    stream.destroy();
    throw refuse("partial_exists", `cannot create ${partial} (it exists or the directory is not writable)`);
  }
  const dest = handle.createWriteStream();
  try {
    await pipeline(Readable.from(reader.plaintext()), createBrotliDecompress(), dest);
  } catch (err) {
    await finished(dest).catch(() => {});
    await unlink(partial).catch(() => {}); // ours: created above with O_EXCL
    throw err;
  } finally {
    stream.destroy();
  }
  // link() fails with EEXIST instead of replacing: a file that appeared at `out` meanwhile wins.
  try {
    await link(partial, out);
  } catch (err) {
    await unlink(partial).catch(() => {});
    throw refuse("out_exists", `refusing to overwrite ${out}`);
  }
  await unlink(partial).catch(() => {});
  return preamble.header;
}
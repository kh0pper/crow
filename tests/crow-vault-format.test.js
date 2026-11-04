/**
 * crow-vault/v1 (SAT-8 part A): round trips at several sizes, the streaming seam (no buffer
 * anywhere near a whole backup), and every reader refusal with its own code — each one also
 * proven to leave no output file behind.
 *
 * The format's chunk layer is exercised directly for the exact-1-MiB case: brotli's output size
 * cannot be chosen, so "a compressed stream that lands exactly on the chunk boundary" is built
 * through the exported VaultBodyWriter/VaultBodyReader seam instead of guessed at.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { rmScratch } from "./helpers/safe-rm.js";

const V = await import("../servers/shared/crow-vault.js");

const DIR = mkdtempSync(join(tmpdir(), "crow-vault-fmt-"));
after(() => rmScratch(DIR));

const DATE = "2026-10-30";
const CREATED = "2026-10-30T02:30:00.000Z";
const KEY = randomBytes(32);

let seq = 0;
const tmpPath = (ext) => join(DIR, `f${seq++}.${ext}`);

async function makeVault(data, { key = KEY, date = DATE, createdAt = CREATED, onChunk = null } = {}) {
  const file = tmpPath("vault");
  const header = await V.encryptVault({
    input: data, output: file, key, backupDate: date, createdAt,
    sourceInstanceId: "inst-test", crowId: "crow:test", onChunk,
  });
  return { file, key, date, header };
}

const bytesOf = (file) => readFileSync(file);
const u32 = (n) => { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(n >>> 0, 0); return b; };

/** The framing, so a test can aim a mutation at one field. */
function layout(bytes) {
  const hlen = bytes.readUInt32BE(8);
  const header = JSON.parse(bytes.subarray(12, 12 + hlen).toString("utf8"));
  const chunks = [];
  let off = 12 + hlen;
  while (off + 4 <= bytes.length) {
    const length = bytes.readUInt32BE(off);
    const total = 4 + V.NONCE_LEN + length + V.TAG_LEN;
    chunks.push({ off, length, total });
    off += total;
  }
  return { hlen, headerEnd: 12 + hlen, header, chunks, end: off };
}

function rewriteHeader(bytes, mutate) {
  const { headerEnd } = layout(bytes);
  const header = JSON.parse(bytes.subarray(12, headerEnd).toString("utf8"));
  mutate(header);
  const json = Buffer.from(JSON.stringify(header), "utf8");
  return Buffer.concat([bytes.subarray(0, 8), u32(json.length), json, bytes.subarray(headerEnd)]);
}

async function refuses(file, { key = KEY, date = DATE, code }) {
  const out = tmpPath("db");
  await assert.rejects(
    () => V.decryptVault({ file, out, key, date }),
    (err) => {
      assert.ok(err instanceof V.VaultError, `expected a VaultError, got ${err?.name}: ${err?.message}`);
      assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
      return true;
    },
  );
  assert.equal(existsSync(out), false, "no output file was left behind");
  assert.equal(existsSync(`${out}.partial`), false, "the .partial file was removed too");
}

const write = (bytes, ext = "vault") => { const p = tmpPath(ext); writeFileSync(p, bytes); return p; };

// --- round trip -------------------------------------------------------------

test("round trip: 0 bytes, 1 byte, 1 MiB and several MiB of incompressible data", async () => {
  const cases = [
    ["empty", Buffer.alloc(0)],
    ["one byte", Buffer.from([0x7f])],
    ["1 MiB of random data", randomBytes(1048576)],
    ["3 MiB of random data", randomBytes(3 * 1048576)],
  ];
  for (const [name, data] of cases) {
    const { file, key, header } = await makeVault(data);
    const out = tmpPath("db");
    const got = await V.decryptVault({ file, out, key, date: DATE });
    assert.deepEqual(bytesOf(out), data, name);
    assert.deepEqual(got, header, "the header round trips");
    assert.equal(header.v, 1);
    assert.equal(header.chunk_size, V.CHUNK_SIZE);
    assert.equal(header.compression, "br");
    assert.equal(header.backup_date, DATE);
    assert.equal(header.created_at, CREATED);
    assert.equal(header.key_id, V.keyId(key));
    assert.equal(header.source_instance_id, "inst-test");
    assert.equal(header.crow_id, "crow:test");
  }
});

test("key_id is 16 hex chars, stable, and carried by the header", async () => {
  const id = V.keyId(KEY);
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(V.keyId(Buffer.from(KEY)), id, "the same key always names the same id");
  assert.notEqual(V.keyId(randomBytes(32)), id);
  const { header } = await makeVault(Buffer.from("hi"));
  assert.equal(header.key_id, id);
  const header_ = await V.readVaultHeader({ file: (await makeVault(Buffer.from("hi"))).file });
  assert.equal(header_.key_id, id);
});

test("the header's bytes survive a parse round trip (every chunk's AAD depends on them)", async () => {
  const { file } = await makeVault(Buffer.from("hello"));
  const bytes = bytesOf(file);
  const { hlen, headerEnd } = layout(bytes);
  assert.equal(hlen, headerEnd - 12);
  const original = bytes.subarray(12, headerEnd).toString("utf8");
  assert.equal(JSON.stringify(JSON.parse(original)), original, "re-serialising the header changes no byte");
});

// --- streaming seam ---------------------------------------------------------

test("streaming: every frame is at most one chunk, full chunks are exactly 1 MiB, one final flag", async () => {
  const data = randomBytes(3 * 1024 * 1024);
  const wrote = [];
  const { file, key } = await makeVault(data, { onChunk: (c) => wrote.push(c) });
  assert.ok(wrote.length >= 3, `expected several chunks, got ${wrote.length}`);
  for (const c of wrote) assert.ok(c.length <= V.CHUNK_SIZE, `chunk ${c.index} is ${c.length} bytes`);
  assert.equal(wrote.filter((c) => c.final).length, 1, "exactly one chunk is final");
  assert.equal(wrote[wrote.length - 1].final, true, "and it is the last one");
  assert.ok(wrote.slice(0, -1).every((c) => c.length === V.CHUNK_SIZE), "every chunk but the last is full");
  assert.deepEqual(wrote.map((c) => c.index), wrote.map((_, i) => i));

  const read = [];
  const out = tmpPath("db");
  await V.decryptVault({ file, out, key, date: DATE, onChunk: (c) => read.push(c) });
  assert.deepEqual(read.map((c) => c.length), wrote.map((c) => c.length));
  assert.deepEqual(read.map((c) => c.final), wrote.map((c) => c.final));
  assert.ok(read.every((c) => c.plaintext_length <= V.CHUNK_SIZE));
  assert.deepEqual(bytesOf(out), data);
});

test("the chunk layer lands exactly on 1 MiB, in both directions (no brotli involved)", async () => {
  const key = randomBytes(32);
  const header = V.buildVaultHeader({ key, backupDate: DATE, createdAt: CREATED, sourceInstanceId: "i", crowId: "c" });
  const frames = [];
  const wrote = [];
  const writer = new V.VaultBodyWriter({
    key, header, nonceBase: Buffer.alloc(V.NONCE_PREFIX_LEN, 1), onChunk: (c) => wrote.push(c),
    write: async (b) => { frames.push(Buffer.from(b)); },
  });
  await writer.push(Buffer.alloc(V.CHUNK_SIZE, 7));
  await writer.push(Buffer.alloc(V.CHUNK_SIZE, 9));
  await writer.end();
  assert.deepEqual(wrote.map((c) => [c.length, c.final]), [[V.CHUNK_SIZE, false], [V.CHUNK_SIZE, false], [0, true]]);
  // The sink seam never sees a buffer bigger than one chunk (the whole point of the framing).
  assert.equal(Math.max(...frames.map((f) => f.length)), V.CHUNK_SIZE);
  assert.ok(frames.every((f) => f.length <= V.CHUNK_SIZE));

  const read = [];
  const back = [];
  const reader = new V.VaultBodyReader({ source: new V.ByteSource(Readable.from(frames)), key, header, onChunk: (c) => read.push(c) });
  for await (const pt of reader.plaintext()) back.push(pt);
  assert.equal(Buffer.concat(back).length, 2 * V.CHUNK_SIZE, "exactly the two chunks come back");
  assert.deepEqual(read.map((c) => [c.length, c.final]), [[V.CHUNK_SIZE, false], [V.CHUNK_SIZE, false], [0, true]]);
});

test("the AAD covers the header BYTES: a differently formatted header still decrypts", async () => {
  const data = Buffer.from("a backup that will be re-framed");
  const { file } = await makeVault(data);
  const bytes = bytesOf(file);
  const { headerEnd, header } = layout(bytes);

  // Unwrap the compressed plaintext with the header as written, then re-frame it under a
  // pretty-printed header. A reader that digested a re-serialised header would fail here.
  const plain = [];
  const reader = new V.VaultBodyReader({ source: new V.ByteSource(Readable.from([bytes.subarray(headerEnd)])), key: KEY, header });
  for await (const pt of reader.plaintext()) plain.push(pt);
  const pretty = Buffer.from(JSON.stringify(header, null, 2), "utf8");
  const frames = [];
  const writer = new V.VaultBodyWriter({ key: KEY, header: pretty, write: async (b) => { frames.push(Buffer.from(b)); } });
  await writer.push(Buffer.concat(plain));
  await writer.end();

  const reframed = write(Buffer.concat([V.MAGIC, u32(pretty.length), pretty, ...frames]));
  const out = tmpPath("db");
  await V.decryptVault({ file: reframed, out, key: KEY, date: DATE });
  assert.deepEqual(bytesOf(out), data);
});

// --- refusals ---------------------------------------------------------------

test("bad_magic: a flipped magic byte, and a file that is not a vault at all", async () => {
  const { file } = await makeVault(Buffer.from("hello"));
  const bytes = bytesOf(file);
  bytes[0] ^= 0xff;
  await refuses(write(bytes), { code: "bad_magic" });
  await refuses(write(Buffer.from("SQLite format 3\0")), { code: "bad_magic" });
});

test("bad_version: a header that claims v2", async () => {
  const { file } = await makeVault(Buffer.from("hello"));
  await refuses(write(rewriteHeader(bytesOf(file), (h) => { h.v = 2; })), { code: "bad_version" });
});

test("bad_chunk_size wins over every other header field (checked before anything else is parsed)", async () => {
  const { file } = await makeVault(Buffer.from("hello"));
  const bytes = bytesOf(file);
  await refuses(write(rewriteHeader(bytes, (h) => { h.chunk_size = V.CHUNK_SIZE + 1; })), { code: "bad_chunk_size" });
  // wrong version AND wrong chunk_size: the chunk size is the one that is reported
  await refuses(write(rewriteHeader(bytes, (h) => { h.v = 2; h.chunk_size = 4096; })), { code: "bad_chunk_size" });
});

test("header_too_large: a header length over 64 KiB is refused before it is read", async () => {
  const { file } = await makeVault(Buffer.from("hello"));
  const bytes = Buffer.from(bytesOf(file));
  u32(V.HEADER_MAX + 1).copy(bytes, 8);
  await refuses(write(bytes), { code: "header_too_large" });
});

test("key_mismatch: a different key is named in the header and refused before the body", async () => {
  const { file } = await makeVault(Buffer.from("hello"));
  await refuses(file, { key: randomBytes(32), code: "key_mismatch" });
});

test("chunk_too_large: a length field over chunk size + overhead", async () => {
  const { file } = await makeVault(Buffer.from("hello"));
  const bytes = Buffer.from(bytesOf(file));
  const { chunks } = layout(bytes);
  u32(V.MAX_CIPHERTEXT + 1).copy(bytes, chunks[0].off);
  await refuses(write(bytes), { code: "chunk_too_large" });
});

test("tag_failure: a flipped ciphertext bit, a flipped tag bit, a flipped header byte", async () => {
  const { file } = await makeVault(Buffer.from("hello hello hello"));
  const { chunks, headerEnd, hlen } = layout(bytesOf(file));

  const ct = Buffer.from(bytesOf(file));
  ct[chunks[0].off + 4 + V.NONCE_LEN] ^= 0x01;
  await refuses(write(ct), { code: "tag_failure" });

  const tag = Buffer.from(bytesOf(file));
  tag[chunks[0].off + chunks[0].total - 1] ^= 0x80;
  await refuses(write(tag), { code: "tag_failure" });

  // A header byte is part of every AAD, so the header cannot be edited behind the body's back.
  const hdr = Buffer.from(bytesOf(file));
  const at = 12 + Buffer.from(bytesOf(file).subarray(12, headerEnd)).indexOf(Buffer.from("crow:test"));
  assert.ok(at > 12 && at < headerEnd, "found the crow_id in the header");
  hdr[at + Buffer.from("crow:").length] = "X".charCodeAt(0);
  assert.equal(layout(hdr).hlen, hlen, "the header stayed the same length");
  await refuses(write(hdr), { code: "tag_failure" });
});

test("tag_failure: two chunks swapped, and a chunk spliced in from another file under the same key", async () => {
  const data = randomBytes(2 * 1024 * 1024);
  const { file } = await makeVault(data);
  const bytes = bytesOf(file);
  const { chunks } = layout(bytes);
  assert.ok(chunks.length >= 2 && chunks[0].length === V.CHUNK_SIZE && chunks[1].length === V.CHUNK_SIZE, "two full chunks to play with");

  // swap chunk 0 and chunk 1
  const swapped = Buffer.concat([
    bytes.subarray(0, chunks[0].off),
    bytes.subarray(chunks[1].off, chunks[1].off + chunks[1].total),
    bytes.subarray(chunks[0].off, chunks[0].off + chunks[0].total),
    bytes.subarray(chunks[1].off + chunks[1].total),
  ]);
  await refuses(write(swapped), { code: "tag_failure" });

  // splice: chunk 0 of a second file (same key, same chunk size) into this one
  const other = await makeVault(randomBytes(2 * 1024 * 1024), { createdAt: "2026-10-30T03:30:00.000Z" });
  const otherBytes = bytesOf(other.file);
  const otherChunk0 = otherBytes.subarray(layout(otherBytes).chunks[0].off, layout(otherBytes).chunks[0].off + chunks[0].total);
  const spliced = Buffer.concat([bytes.subarray(0, chunks[0].off), otherChunk0, bytes.subarray(chunks[0].off + chunks[0].total)]);
  await refuses(write(spliced), { code: "tag_failure" });
});

test("truncated: the final chunk dropped, and a cut through the middle of a chunk", async () => {
  // 2 MiB of random data does not fit one chunk, so the last chunk is not the only one.
  const { file } = await makeVault(randomBytes(2 * 1024 * 1024));
  const bytes = bytesOf(file);
  const { chunks } = layout(bytes);
  assert.ok(chunks.length >= 2, `expected several chunks, got ${chunks.length}`);
  await refuses(write(bytes.subarray(0, bytes.length - chunks[chunks.length - 1].total)), { code: "truncated" });
  await refuses(write(bytes.subarray(0, chunks[0].off + 10)), { code: "truncated" });
  // A file that is only a header has no final chunk either.
  await refuses(write(bytes.subarray(0, 12 + layout(bytes).hlen)), { code: "truncated" });
});

test("trailing_data: bytes after the final chunk", async () => {
  const { file } = await makeVault(Buffer.from("hello"));
  const bytes = bytesOf(file);
  await refuses(write(Buffer.concat([bytes, Buffer.from("more")])), { code: "trailing_data" });
  // a whole extra well-formed empty chunk after the final one is trailing data too
  const { chunks } = layout(bytes);
  const extra = bytes.subarray(chunks[chunks.length - 1].off);
  await refuses(write(Buffer.concat([bytes, extra])), { code: "trailing_data" });
});

test("rollback: a wrong date, and a created_at outside the date ± 1 day", async () => {
  const { file } = await makeVault(Buffer.from("hello"));
  await refuses(file, { date: "2026-10-29", code: "rollback" });
  // The creation time is authenticated (it is part of the header digest), so the window is tested
  // with files really created at those times, never by editing a header in place.
  for (const [createdAt, code] of [
    ["2026-10-28T23:00:00.000Z", "rollback"],
    ["2026-11-01T00:00:00.000Z", "rollback"],
  ]) {
    const v = await makeVault(Buffer.from("hello"), { createdAt });
    await refuses(v.file, { code });
  }
  for (const createdAt of ["2026-10-29T02:30:00.000Z", "2026-10-31T23:00:00.000Z"]) {
    const v = await makeVault(Buffer.from("hello"), { createdAt });
    const out = tmpPath("db");
    await V.decryptVault({ file: v.file, out, key: KEY, date: DATE });
    assert.deepEqual(bytesOf(out), Buffer.from("hello"), `${createdAt} is still inside ${DATE} ± 1 day`);
  }
});

test("the off-site key's stored form is base64, and hex is accepted too", () => {
  const stored = V.encodeVaultKey(KEY);
  assert.match(stored, /^[A-Za-z0-9+/]{43}=$/);
  assert.deepEqual(V.vaultKeyFromSecret(stored), KEY);
  assert.deepEqual(V.vaultKeyFromSecret(KEY.toString("hex")), KEY);
  assert.equal(V.vaultKeyFromSecret("not a key"), null);
  assert.equal(V.vaultKeyFromSecret(Buffer.alloc(31).toString("base64")), null);
  assert.equal(V.offsiteKeyFromEntries([]), null);
  assert.deepEqual(V.offsiteKeyFromEntries([
    { kind: "manual", label: "something", secret: "x" },
    { kind: "extension", bundle_id: V.OFFSITE_KEY.bundleId, env_key: V.OFFSITE_KEY.envKey, secret: stored },
  ]), KEY);
});
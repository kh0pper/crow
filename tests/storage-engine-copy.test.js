// Storage engine copier + verifier (servers/storage/engine-copy.js): pure
// logic against two in-memory S3 endpoints. Covers multipart bodies,
// metadata carry + colliding-metadata refusal, resume, delta, deletes and
// their guard, the reverse copy by dest_etag, an early-ending stream, the
// ETag rule across part-count changes, and a verify that cannot false-pass
// (corrupted / missing / extra / size / metadata / stale state / checksums).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  copyAll, reverseAll, verifyAll, abortOpenUploads, StateLog, UploadLog, readJsonl, carriedHeaders,
  parseChecksums, deleteLimit, checkContentAddressedDir, MIN_PART_SIZE, PART_SIZE, DEFAULT_CONCURRENCY, isMultipartEtag,
} from "../servers/storage/engine-copy.js";
import { parseArgs, main, isMainModule } from "../scripts/ops/storage-engine-copy.mjs";
import { spawnSync } from "node:child_process";
import { symlinkSync, realpathSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { makeFakeEndpoint } from "./helpers/fake-s3-endpoint.mjs";

const PS = MIN_PART_SIZE; // 5 MiB parts keep the fixtures small
const sha = (b) => createHash("sha256").update(b).digest("hex");
const bytes = (n, seed = 1) => { const b = Buffer.allocUnsafe(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff; return b; };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "engine-copy-"));
  const src = makeFakeEndpoint("minio:9000");
  const dst = makeFakeEndpoint("garage:3900");
  const statePath = join(dir, "copy-state.jsonl");
  const run = (o = {}) => {
    const state = new StateLog(statePath);
    const uploads = new UploadLog(`${statePath}.uploads.jsonl`);
    return copyAll({ src, dst, state, uploads, partSize: PS, retryDelayMs: 1, ...o }).finally(() => { state.close(); uploads.closeFd(); });
  };
  const verify = (o = {}) => verifyAll({ src, dst, state: new StateLog(statePath, { readOnly: true }), ...o });
  return { dir, src, dst, statePath, run, verify, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("constants: the memory cap is a number in the code (8 x 64 MiB)", () => {
  assert.equal(PART_SIZE, 64 * 1024 * 1024);
  assert.equal(DEFAULT_CONCURRENCY, 8);
});

test("full copy: exact keys, bytes, metadata; multipart above the part size; verify passes", async () => {
  const t = setup();
  try {
    const big = bytes(PS * 2 + 12345, 7);
    t.src.seed("music", "tracks/0d/ab/01 – Ünïcode +%#?.mp3", bytes(1000), { "Content-Type": "audio/mpeg", "Cache-Control": "max-age=60", "Content-Disposition": "inline", "Content-Language": "es", "Content-Encoding": "identity", "x-amz-meta-sha256": sha(bytes(1000)) });
    t.src.seed("music", "big.flac", big, { "content-type": "audio/flac", "x-amz-meta-origin": "upload" });
    t.src.seed("music", "empty", Buffer.alloc(0), { "content-type": "text/plain" });
    t.src.seed("music", "dir/", Buffer.from("x"));
    t.src.seed("capstone", "a.json", Buffer.from("{}"), { "content-type": "application/json", "x-amz-meta-sha256": sha(Buffer.from("{}")) });
    const s = await t.run();
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(s.buckets.music.copied, 4);
    assert.deepEqual([...t.dst.buckets.get("music").keys()].sort(), [...t.src.buckets.get("music").keys()].sort());
    for (const [k, o] of t.src.buckets.get("music")) assert.ok(t.dst.object("music", k).data.equals(o.data), k);
    const d = t.dst.object("music", "tracks/0d/ab/01 – Ünïcode +%#?.mp3");
    assert.deepEqual(d.headers, { "content-type": "audio/mpeg", "cache-control": "max-age=60", "content-disposition": "inline", "content-language": "es", "content-encoding": "identity", "x-amz-meta-sha256": sha(bytes(1000)) });
    assert.equal(t.dst.object("music", "big.flac").headers["x-amz-meta-origin"], "upload");
    assert.match(t.dst.object("music", "big.flac").etag, /-3$/, "sent as 3 parts");
    const rec = new StateLog(t.statePath).get("music", "big.flac");
    for (const f of ["key", "size", "src_etag", "sha256", "bytes_hashed", "dest_etag", "dest_last_modified", "done"]) assert.ok(f in rec, f);
    assert.equal(rec.sha256, sha(big));
    assert.equal(rec.bytes_hashed, big.length);
    assert.equal(rec.dest_etag, t.dst.object("music", "big.flac").etag);
    assert.equal(t.dst.uploads.size, 0, "no multipart upload left open");
    const v = await t.verify();
    assert.equal(v.ok, true, JSON.stringify(v.buckets, null, 1));
    assert.equal(v.totals.hashed, 5);
    assert.equal(v.buckets.music.etag_skipped_multipart, 1);
  } finally { t.cleanup(); }
});

test("ETag rule: part counts change in the copy and verify does not compare them", async () => {
  const t = setup();
  try {
    t.src.seed("b", "single-but-large", bytes(PS + 10));          // md5 ETag -> dest "-2"
    t.src.seedMultipart("b", "multi-but-small", bytes(PS - 10), 1024 * 1024); // "-5" -> dest single md5
    t.src.seed("b", "small", bytes(10));
    assert.equal((await t.run()).ok, true);
    assert.ok(isMultipartEtag(t.dst.object("b", "single-but-large").etag));
    assert.ok(!isMultipartEtag(t.dst.object("b", "multi-but-small").etag));
    const v = await t.verify();
    assert.equal(v.ok, true, JSON.stringify(v.buckets.b));
    assert.equal(v.buckets.b.etag_compared, 1);
    assert.equal(v.buckets.b.etag_skipped_multipart, 2);
  } finally { t.cleanup(); }
});

test("metadata that cannot be carried exactly is refused, never rewritten or dropped", async () => {
  assert.throws(() => carriedHeaders({ "x-amz-meta-content-type": "a/b" }), /colliding_metadata/);
  assert.throws(() => carriedHeaders({ "x-amz-meta-x-amz-acl": "public-read" }), /colliding_metadata/);
  assert.throws(() => carriedHeaders({ expires: "Thu, 01 Jan 2099 00:00:00 GMT" }), /unsupported_attribute:expires/);
  assert.throws(() => carriedHeaders({ "x-amz-tagging-count": "2" }), /unsupported_attribute/);
  assert.throws(() => carriedHeaders({ "x-amz-storage-class": "GLACIER" }), /storage-class/);
  assert.deepEqual(carriedHeaders({ "x-amz-storage-class": "STANDARD", "content-type": "a/b", server: "MinIO", "x-amz-request-id": "1" }), { "content-type": "a/b" });
  const t = setup();
  try {
    t.src.seed("b", "bad", Buffer.from("x"), { "x-amz-meta-content-type": "text/html" });
    t.src.seed("b", "good", Buffer.from("y"));
    const s = await t.run();
    assert.equal(s.ok, false);
    assert.deepEqual(s.buckets.b.refused.map((r) => r.key), ["bad"]);
    assert.equal(t.dst.object("b", "bad"), null);
    assert.ok(t.dst.object("b", "good"));
  } finally { t.cleanup(); }
});

test("a failed multipart object is aborted by its uploadId, and a resumed run copies only what is left", async () => {
  const t = setup();
  try {
    for (let i = 0; i < 6; i++) t.src.seed("b", `k${i}`, bytes(100 + i));
    t.src.seed("b", "big", bytes(PS * 2 + 1));
    t.dst.faults.failPart = (b, k, n) => k === "big" && n === 2;
    const s1 = await t.run({ retries: 1 });
    assert.equal(s1.ok, false);
    assert.deepEqual(s1.buckets.b.failed.map((f) => f.key), ["big"]);
    assert.equal(t.dst.uploads.size, 0, "aborted, not left on the target disk");
    assert.equal(t.dst.calls.filter((c) => c[0] === "mpAbort").length, 2, "one abort per attempt");
    assert.deepEqual(new UploadLog(`${t.statePath}.uploads.jsonl`).openUploads(), []);
    // A crash mid-append leaves a torn last line: it is ignored on resume.
    appendFileSync(t.statePath, '{"bucket":"b","key":"k0","si');
    t.dst.faults.failPart = null;
    assert.equal(new StateLog(t.statePath).size, 6, "the torn record is not read");
    const before = t.src.calls.filter((c) => c[0] === "get").length;
    const s2 = await t.run();
    assert.equal(s2.ok, true);
    assert.equal(s2.buckets.b.copied, 1);
    assert.equal(s2.buckets.b.skipped, 6);
    assert.equal(t.src.calls.filter((c) => c[0] === "get").length - before, 1, "only the failed key is read again");
    assert.equal((await t.verify()).ok, true);
    assert.equal(readJsonl(t.statePath).length, 7, "the torn tail was cut before appending, the log parses cleanly");
  } finally { t.cleanup(); }
});

test("resume also re-copies a key whose destination copy vanished or changed", async () => {
  const t = setup();
  try {
    t.src.seed("b", "x", bytes(50));
    t.src.seed("b", "y", bytes(60));
    await t.run();
    t.dst.buckets.get("b").delete("x");
    t.dst.seed("b", "y", bytes(60, 9));
    const s = await t.run();
    assert.equal(s.buckets.b.copied, 2);
    assert.equal((await t.verify()).ok, true);
  } finally { t.cleanup(); }
});

test("--delta: refused on an empty state; copies only new and changed keys", async () => {
  const t = setup();
  try {
    await assert.rejects(t.run({ delta: true }), /--delta refused/);
    for (let i = 0; i < 10; i++) t.src.seed("b", `k${i}`, bytes(10 + i));
    await t.run();
    t.src.seed("b", "k3", bytes(13, 5)); // same size, new content -> new ETag
    t.src.seed("b", "new", bytes(5));
    const s = await t.run({ delta: true });
    assert.equal(s.buckets.b.copied, 2);
    assert.equal(s.buckets.b.skipped, 9);
    assert.ok(t.dst.object("b", "k3").data.equals(bytes(13, 5)));
    assert.equal((await t.verify()).ok, true);
  } finally { t.cleanup(); }
});

test("--propagate-deletes carries deletes, guarded per bucket", async () => {
  const t = setup();
  try {
    await assert.rejects(t.run({ propagateDeletes: true }), /needs --delta/);
    for (let i = 0; i < 200; i++) t.src.seed("b", `k${String(i).padStart(3, "0")}`, bytes(8, i));
    await t.run();
    assert.equal(deleteLimit(200), 2);
    // 1 delete: within 1 % of 200.
    t.src.buckets.get("b").delete("k000");
    let s = await t.run({ delta: true, propagateDeletes: true });
    assert.equal(s.ok, true);
    assert.equal(s.buckets.b.deleted, 1);
    assert.equal(t.dst.object("b", "k000"), null);
    // 5 deletes on 199: over the limit, nothing deleted, run not ok.
    for (let i = 1; i <= 5; i++) t.src.buckets.get("b").delete(`k00${i}`);
    s = await t.run({ delta: true, propagateDeletes: true });
    assert.equal(s.ok, false);
    assert.equal(s.buckets.b.delete_refused.would_delete, 5);
    assert.equal(s.buckets.b.deleted, 0);
    assert.ok(t.dst.object("b", "k001"));
    const v = await t.verify();
    assert.equal(v.ok, false);
    assert.equal(v.buckets.b.extra_count, 5);
    // Explicit override.
    s = await t.run({ delta: true, propagateDeletes: true, maxDeletePct: 100, maxDeleteKeys: 10 });
    assert.equal(s.ok, true);
    assert.equal(s.buckets.b.deleted, 5);
    assert.equal((await t.verify()).ok, true);
    assert.equal(deleteLimit(30), 1, "a small bucket may always lose one key");
    assert.equal(deleteLimit(0), 1);
    assert.equal(deleteLimit(30, { maxDeleteKeys: 0 }), 0, "an explicit key cap of 0 still wins");
    assert.equal(deleteLimit(1_000_000), 100, "and never more than 100 keys by default");
  } finally { t.cleanup(); }
});

test("reverse copy goes by the recorded dest_etag and carries deletes back", async () => {
  const t = setup();
  try {
    for (let i = 0; i < 150; i++) t.src.seed("b", `k${String(i).padStart(3, "0")}`, bytes(20, i));
    t.src.seed("b", "big", bytes(PS * 2 + 3));
    t.src.seedMultipart("b", "mp", bytes(PS + 7, 3), PS);
    await t.run();
    // Life on Garage after the cutover: one change, one new key, one delete.
    t.dst.seed("b", "k010", bytes(20, 99));
    t.dst.seed("b", "after-cutover", bytes(33));
    t.dst.buckets.get("b").delete("k020");
    const revPath = join(t.dir, "reverse-state.jsonl");
    const state = new StateLog(revPath);
    const getsBefore = t.dst.calls.filter((c) => c[0] === "get").length;
    const s = await reverseAll({ src: t.dst, dst: t.src, forwardState: new StateLog(t.statePath, { readOnly: true }), state, partSize: PS });
    state.close();
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(s.buckets.b.copied, 2, "multipart objects whose Garage ETag differs from MinIO's are NOT re-copied");
    assert.equal(t.dst.calls.filter((c) => c[0] === "get").length - getsBefore, 2);
    assert.equal(s.buckets.b.deleted, 1);
    assert.ok(t.src.object("b", "k010").data.equals(bytes(20, 99)));
    assert.ok(t.src.object("b", "after-cutover"));
    assert.equal(t.src.object("b", "k020"), null);
    const v = await verifyAll({ src: t.dst, dst: t.src, state: new StateLog(t.statePath, { readOnly: true }) });
    assert.equal(v.buckets.b.no_state_count + v.buckets.b.stale_state_count > 0, true, "the forward state does not describe a reverse copy");
    await assert.rejects(reverseAll({ src: t.dst, dst: t.src, forwardState: new StateLog(join(t.dir, "nope.jsonl")), state: new StateLog(revPath) }), /forward state/);
  } finally { t.cleanup(); }
});

test("a source stream that ends early (or runs long) never becomes an object", async () => {
  const t = setup();
  try {
    t.src.seed("b", "short-small", bytes(1000));
    t.src.seed("b", "short-big", bytes(PS * 3));
    t.src.seed("b", "long", bytes(500));
    t.src.faults.truncateGet = (b, k) => k.startsWith("short");
    t.src.faults.extraGetBytes = (b, k) => k === "long";
    const s = await t.run({ retries: 0 });
    assert.equal(s.ok, false);
    assert.deepEqual(s.buckets.b.failed.map((f) => f.key).sort(), ["long", "short-big", "short-small"]);
    for (const f of s.buckets.b.failed) assert.match(f.error, /short read|more than/);
    assert.equal(t.dst.buckets.get("b").size, 0);
    assert.equal(t.dst.uploads.size, 0);
    // And a state record that claims fewer hashed bytes than the listed size fails verify.
    t.src.faults.truncateGet = null; t.src.faults.extraGetBytes = null;
    await t.run();
    const rec = new StateLog(t.statePath).get("b", "long");
    appendFileSync(t.statePath, JSON.stringify({ ...rec, bytes_hashed: 250 }) + "\n");
    const v = await t.verify();
    assert.equal(v.ok, false);
    assert.deepEqual(v.buckets.b.bytes_mismatch.map((x) => x.key), ["long"]);
  } finally { t.cleanup(); }
});

test("verify catches a corrupted target object, a missing one, an extra one, a size and a metadata change", async () => {
  const t = setup();
  try {
    for (let i = 0; i < 8; i++) t.src.seed("b", `k${i}`, bytes(64, i), { "content-type": "audio/mpeg" });
    await t.run();
    assert.equal((await t.verify()).ok, true);
    const o = t.dst.object("b", "k1"); o.data = Buffer.from(o.data); o.data[10] ^= 0xff; // same size, same listed ETag
    t.dst.buckets.get("b").delete("k2");
    t.dst.seed("b", "stray", Buffer.from("s"));
    t.dst.seed("b", "k3", bytes(65, 3), { "content-type": "audio/mpeg" });
    t.dst.object("b", "k4").headers["content-type"] = "application/octet-stream";
    const v = await t.verify();
    assert.equal(v.ok, false);
    const b = v.buckets.b;
    assert.deepEqual(b.content_mismatch.map((x) => x.key), ["k1", "k3"]);
    assert.deepEqual(b.missing, ["k2"]);
    assert.deepEqual(b.extra, ["stray"]);
    assert.deepEqual(b.size_mismatch.map((x) => x.key), ["k3"]);
    assert.deepEqual(b.metadata_mismatch.map((x) => x.key), ["k4"]);
    assert.equal(b.missing_count, 1);
  } finally { t.cleanup(); }
});

test("verify fails on a source that changed after the copy, on no state, and on an empty run", async () => {
  const t = setup();
  try {
    t.src.seed("b", "a", bytes(10));
    t.src.seed("b", "b", bytes(11));
    await t.run();
    t.src.seed("b", "a", bytes(10, 4));
    t.src.seed("b", "c", bytes(12));
    t.dst.seed("b", "c", bytes(12)); // present on both, but never copied by us
    const v = await t.verify();
    assert.equal(v.ok, false);
    assert.deepEqual(v.buckets.b.stale_state.map((x) => x.key), ["a"]);
    assert.deepEqual(v.buckets.b.no_state, ["c"]);
    const e = await verifyAll({ src: makeFakeEndpoint(), dst: makeFakeEndpoint(), state: new StateLog(t.statePath) });
    assert.equal(e.ok, false, "zero buckets verified is not a pass");
    const x = await t.verify({ buckets: ["b"], checksums: { other: new Map([["k", "0".repeat(64)]]) } });
    assert.equal(x.ok, false, "a checksum list for a bucket that was not verified is not silently ignored");
  } finally { t.cleanup(); }
});

test("independent hashes: the DB checksum list and x-amz-meta-sha256", async () => {
  const t = setup();
  try {
    const f1 = bytes(300, 1), f2 = bytes(301, 2);
    t.src.seed("fw", "tracks/a.mp3", f1);
    t.src.seed("fw", "tracks/b.mp3", f2);
    t.src.seed("fw", "__sized__/cover.jpg", bytes(5));
    t.src.seed("cap", "doc", f1, { "x-amz-meta-sha256": sha(f1) });
    t.src.seed("cap", "wrongmeta", f2, { "x-amz-meta-sha256": sha(f1) });
    await t.run();
    const good = parseChecksums(`tracks/a.mp3\tsha256:${sha(f1)}\ntracks/b.mp3\t${sha(f2)}\n`);
    let v = await t.verify({ checksums: { fw: good } });
    assert.equal(v.buckets.fw.ok, true);
    assert.equal(v.buckets.fw.checksum_covered, 2);
    assert.equal(v.buckets.fw.checksum_unreferenced, 1, "the unreferenced rendition is reported as stream-hash-only");
    assert.deepEqual(v.buckets.cap.meta_sha256_mismatch.map((x) => x.key), ["wrongmeta"]);
    const bad = parseChecksums(`tracks/a.mp3\tsha256:${sha(f2)}\ntracks/gone.mp3\t${sha(f2)}\n`);
    v = await t.verify({ checksums: { fw: bad } });
    assert.deepEqual(v.buckets.fw.checksum_mismatch.map((x) => x.key), ["tracks/a.mp3"]);
    assert.deepEqual(v.buckets.fw.checksum_missing, ["tracks/gone.mp3"]);
    assert.throws(() => parseChecksums(""), /no entries/);
    assert.throws(() => parseChecksums("k\tnothex"), /not sha256/);
    assert.throws(() => parseChecksums(`k\t${sha(f1)}\nk\t${sha(f2)}`), /two different/);
  } finally { t.cleanup(); }
});

test("--reread-source re-hashes the source too", async () => {
  const t = setup();
  try {
    t.src.seed("b", "a", bytes(100));
    await t.run();
    // Corrupt the destination AND rewrite the state hash to match it: only a
    // source re-read can still see the difference.
    const o = t.dst.object("b", "a"); o.data = Buffer.from(o.data); o.data[0] ^= 1;
    const rec = new StateLog(t.statePath).get("b", "a");
    appendFileSync(t.statePath, JSON.stringify({ ...rec, sha256: sha(o.data) }) + "\n");
    assert.equal((await t.verify()).ok, true, "state-only evidence is fooled by a forged state");
    const v = await t.verify({ rereadSource: true });
    assert.equal(v.ok, false);
    assert.deepEqual(v.buckets.b.source_mismatch.map((x) => x.key), ["a"]);
  } finally { t.cleanup(); }
});

test("abortOpenUploads aborts exactly the uploads this tool left open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "engine-copy-ab-"));
  try {
    const ep = makeFakeEndpoint("garage:3900");
    ep.seed("b", "seed", "x");
    const log = new UploadLog(join(dir, "s.uploads.jsonl"));
    const a = await ep.mpInit("b", "left-open", {}); log.open(ep.id, "b", "left-open", a);
    const c = await ep.mpInit("b", "completed", {}); log.open(ep.id, "b", "completed", c); log.close(ep.id, "b", "completed", c, "completed");
    const other = await ep.mpInit("b", "someone-else", {});
    log.open("elsewhere:1", "b", "x", "up-x");
    const r = await abortOpenUploads({ uploads: log, endpoints: [ep] });
    log.closeFd();
    assert.deepEqual(r.aborted.map((u) => u.uploadId), [a]);
    assert.equal(r.skipped_unknown_endpoint.length, 1);
    assert.ok(ep.uploads.has(other), "an upload this tool did not open is left alone");
    assert.deepEqual(new UploadLog(join(dir, "s.uploads.jsonl")).openUploads().map((u) => u.uploadId), ["up-x"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readJsonl: a torn last line is ignored, a corrupt middle line throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "engine-copy-j-"));
  try {
    const p = join(dir, "s.jsonl");
    writeFileSync(p, '{"bucket":"b","key":"a"}\n{"bucket":"b","key":"b"}\n{"bucket":"b","ke');
    assert.equal(readJsonl(p).length, 2);
    writeFileSync(p, '{"bucket":"b","key":"a"}\n{oops\n{"bucket":"b","key":"b"}\n');
    assert.throws(() => readJsonl(p), /corrupt line 2/);
    assert.deepEqual(readJsonl(join(dir, "none.jsonl")), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("checkContentAddressedDir: names must be the sha256 of the content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "engine-copy-cad-"));
  try {
    const a = Buffer.from("artifact one");
    writeFileSync(join(dir, sha(a)), a);
    let r = await checkContentAddressedDir(dir);
    assert.equal(r.ok, true);
    writeFileSync(join(dir, sha(Buffer.from("x"))), "not x");
    mkdirSync(join(dir, "sub"));
    r = await checkContentAddressedDir(dir);
    assert.equal(r.ok, false);
    assert.equal(r.bad.length, 1);
    assert.deepEqual(r.skipped, ["sub"]);
    const empty = mkdtempSync(join(tmpdir(), "engine-copy-cad0-"));
    assert.equal((await checkContentAddressedDir(empty)).ok, false, "an empty store proves nothing");
    rmSync(empty, { recursive: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI: argument parsing, usage errors, check-dir", async () => {
  const a = parseArgs(["verify", "--from", "http://127.0.0.1:1", "--all", "--checksums", "a=f1", "--checksums", "b=f2", "--reread-source"]);
  assert.equal(a.cmd, "verify");
  assert.equal(a.all, true);
  assert.deepEqual(a.checksums, ["a=f1", "b=f2"]);
  assert.throws(() => parseArgs(["copy", "--state"]), /needs a value/);
  const errs = [];
  const orig = console.error; const origLog = console.log;
  console.error = (m) => errs.push(String(m)); console.log = () => {};
  try {
    assert.equal(await main([]), 2);
    assert.equal(await main(["copy", "--from", "http://127.0.0.1:1", "--to", "http://127.0.0.1:2", "--all"]), 2, "--state is required");
    const dir = mkdtempSync(join(tmpdir(), "engine-copy-cli-"));
    writeFileSync(join(dir, sha(Buffer.from("z"))), "z");
    assert.equal(await main(["check-dir", dir]), 0);
    rmSync(dir, { recursive: true });
  } finally { console.error = orig; console.log = origLog; }
  assert.ok(errs.some((e) => /--state FILE is required/.test(e)));
});

test("a part upload slower than the idle timeout does not kill the source stream", async () => {
  const t = setup();
  try {
    t.src.seed("b", "slow", bytes(PS * 2 + 5));
    const orig = t.dst.mpPart;
    t.dst.mpPart = async (...a) => { await new Promise((r) => setTimeout(r, 150)); return orig(...a); };
    const s = await t.run({ idleMs: 50, retries: 0 });
    assert.equal(s.ok, true, JSON.stringify(s.buckets.b.failed));
    assert.ok(t.dst.object("b", "slow").data.equals(bytes(PS * 2 + 5)));
    // A source that really stalls still trips it.
    t.src.seed("b", "stall", bytes(100));
    const get = t.src.get;
    t.src.get = async (b, k) => {
      const r = await get(b, k);
      if (k !== "stall") return r;
      const { Readable } = await import("node:stream");
      return { headers: r.headers, body: new Readable({ read() {} }) };
    };
    const s2 = await t.run({ idleMs: 50, retries: 0 });
    assert.match(s2.buckets.b.failed[0].error, /idle/);
  } finally { t.cleanup(); }
});

test("CLI main guard: runs through a symlink and through a path that needs URL-encoding", () => {
  const cli = fileURLToPath(new URL("../scripts/ops/storage-engine-copy.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "engine copy %cli-"));
  try {
    const link = join(dir, "copy tool #1.mjs");
    symlinkSync(cli, link);
    assert.equal(isMainModule(pathToFileURL(realpathSync(cli)).href, link), true);
    assert.equal(isMainModule(pathToFileURL(realpathSync(cli)).href, join(dir, "nope.mjs")), false);
    const r = spawnSync(process.execPath, [link, "help"], { encoding: "utf8", timeout: 30_000 });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Commands:/, "the CLI ran instead of exiting silently");
    assert.match(r.stdout, /reverse ALWAYS carries deletes/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

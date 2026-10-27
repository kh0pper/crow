// In-memory S3 endpoint with the same surface as makeMinioEndpoint() in
// servers/storage/engine-copy.js (list/get/head/putSingle/mp*/remove).
// ETags follow S3: md5 hex for a single PUT, md5(concat part md5s)-N for a
// multipart upload. Fault hooks let a test truncate a GET, fail a part, etc.
// No network, no container.
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

const md5 = (b) => createHash("md5").update(b).digest();

export function makeFakeEndpoint(id = "fake:1") {
  const buckets = new Map(); // bucket -> Map(key -> { data, headers, etag, lastModified })
  const uploads = new Map(); // uploadId -> { bucket, key, headers, parts: Map(n -> buf) }
  let seq = 0;
  const notFound = () => Object.assign(new Error("Not Found"), { code: "NoSuchKey" });
  const ep = {
    id,
    buckets,
    uploads,
    calls: [],
    faults: { truncateGet: null, failPart: null, chunk: 1024 * 1024, extraGetBytes: null },
    // --- test helpers ---
    seed(bucket, key, data, headers = {}) {
      if (!buckets.has(bucket)) buckets.set(bucket, new Map());
      const buf = Buffer.from(data);
      buckets.get(bucket).set(key, { data: buf, headers: lower(headers), etag: md5(buf).toString("hex"), lastModified: new Date() });
    },
    seedMultipart(bucket, key, data, partSize, headers = {}) {
      if (!buckets.has(bucket)) buckets.set(bucket, new Map());
      const buf = Buffer.from(data);
      const mds = [];
      for (let o = 0; o < buf.length; o += partSize) mds.push(md5(buf.subarray(o, o + partSize)));
      buckets.get(bucket).set(key, { data: buf, headers: lower(headers), etag: `${md5(Buffer.concat(mds)).toString("hex")}-${mds.length}`, lastModified: new Date() });
    },
    object(bucket, key) { return buckets.get(bucket)?.get(key) || null; },
    // --- endpoint surface ---
    async listBuckets() { return [...buckets.keys()].sort(); },
    async ensureBucket(b) { if (buckets.has(b)) return false; buckets.set(b, new Map()); return true; },
    async list(b) {
      ep.calls.push(["list", b]);
      if (!buckets.has(b)) throw Object.assign(new Error("NoSuchBucket"), { code: "NoSuchBucket" });
      const out = new Map();
      for (const k of [...buckets.get(b).keys()].sort()) { const o = buckets.get(b).get(k); out.set(k, { size: o.data.length, etag: o.etag }); }
      return out;
    },
    async get(b, k) {
      ep.calls.push(["get", b, k]);
      const o = buckets.get(b)?.get(k);
      if (!o) throw notFound();
      let data = o.data;
      if (ep.faults.truncateGet && ep.faults.truncateGet(b, k)) data = data.subarray(0, Math.floor(data.length / 2));
      if (ep.faults.extraGetBytes && ep.faults.extraGetBytes(b, k)) data = Buffer.concat([data, Buffer.from("xx")]);
      const step = ep.faults.chunk;
      const chunks = [];
      for (let i = 0; i < data.length; i += step) chunks.push(data.subarray(i, i + step));
      return { headers: headersOf(o), body: Readable.from(chunks, { objectMode: false }) };
    },
    async head(b, k) {
      const o = buckets.get(b)?.get(k);
      if (!o) throw notFound();
      return headersOf(o);
    },
    async putSingle(b, k, buf, headers) {
      ep.calls.push(["putSingle", b, k, buf.length]);
      if (!buckets.has(b)) throw new Error("NoSuchBucket");
      const data = Buffer.from(buf); // copy: the caller reuses its buffer
      buckets.get(b).set(k, { data, headers: lower(headers), etag: md5(data).toString("hex"), lastModified: new Date() });
      return { etag: md5(data).toString("hex") };
    },
    async mpInit(b, k, headers) {
      const id = `up-${++seq}`;
      uploads.set(id, { bucket: b, key: k, headers: lower(headers), parts: new Map() });
      ep.calls.push(["mpInit", b, k, id]);
      return id;
    },
    async mpPart(b, k, id, n, buf) {
      if (ep.faults.failPart && ep.faults.failPart(b, k, n)) throw new Error(`injected part failure ${n}`);
      const u = uploads.get(id);
      if (!u) throw Object.assign(new Error("NoSuchUpload"), { code: "NoSuchUpload" });
      u.parts.set(n, Buffer.from(buf));
      return { part: n, etag: md5(buf).toString("hex") };
    },
    async mpComplete(b, k, id, parts) {
      const u = uploads.get(id);
      if (!u) throw Object.assign(new Error("NoSuchUpload"), { code: "NoSuchUpload" });
      const bufs = parts.map((p) => u.parts.get(p.part));
      const data = Buffer.concat(bufs);
      const etag = `${md5(Buffer.concat(bufs.map(md5))).toString("hex")}-${bufs.length}`;
      buckets.get(b).set(k, { data, headers: u.headers, etag, lastModified: new Date() });
      uploads.delete(id);
      ep.calls.push(["mpComplete", b, k, id]);
      return { etag };
    },
    async mpAbort(b, k, id) { ep.calls.push(["mpAbort", b, k, id]); uploads.delete(id); },
    async remove(b, k) { ep.calls.push(["remove", b, k]); buckets.get(b)?.delete(k); },
  };
  return ep;
}

function lower(h) { return Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), String(v)])); }
function headersOf(o) {
  return { ...o.headers, "content-length": String(o.data.length), etag: `"${o.etag}"`, "last-modified": o.lastModified.toUTCString() };
}

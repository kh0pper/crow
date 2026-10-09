// In-memory stand-in for servers/storage/s3-client.js's object functions
// (pattern: tests/helpers/workspace-fake-nextcloud.js). One shared `objects`
// map can back several stores — that is how the per-prefix isolation test
// shares one bucket. No network, no container.
export function makeFakeS3() {
  const objects = new Map();   // key -> { data: Buffer, lastModified: Date }
  const s3 = {
    objects,
    calls: [],
    hang: null,               // set a label ("put"/"get") to never resolve it
    fail: null,               // set a label to reject with a plain Error
    async ensureBucket(bucket) { s3.calls.push(["ensureBucket", bucket]); },
    async uploadObject(key, data, opts) {
      s3.calls.push(["uploadObject", key, opts?.bucket]);
      if (s3.hang === "put") return new Promise(() => {});
      if (s3.fail === "put") throw new Error("s3 down");
      objects.set(key, { data: Buffer.from(data), lastModified: new Date() });
    },
    async getObject(key) {
      s3.calls.push(["getObject", key]);
      if (s3.hang === "get") return new Promise(() => {});
      const o = objects.get(key);
      if (!o) throw Object.assign(new Error("Object not found"), { code: "NotFound" });
      const stream = (async function* () { yield o.data; })();
      return { stream, stat: { size: o.data.length, lastModified: o.lastModified } };
    },
    async deleteObject(key, bucket) { s3.calls.push(["deleteObject", key, bucket]); objects.delete(key); },
    async listObjects({ prefix }) {
      s3.calls.push(["listObjects", prefix]);
      return [...objects.entries()]
        .filter(([k]) => k.startsWith(prefix || ""))
        .map(([k, v]) => ({ name: k, size: v.data.length, lastModified: v.lastModified }));
    },
  };
  return s3;
}

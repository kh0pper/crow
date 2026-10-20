/**
 * sunvox-studio outputs — saving renders/projects to Crow storage, the
 * Funkwhale push and the done-notification. Pure modules with injected
 * fakes: these run everywhere (no MinIO, no Funkwhale, no native engine).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(ROOT, "bundles", "sunvox-studio");
const outputs = await import(pathToFileURL(path.join(BUNDLE, "server", "outputs.js")).href);
const fw = await import(pathToFileURL(path.join(BUNDLE, "server", "funkwhale-push.js")).href);

function fakeS3({ stats = 0, failUpload = false, failPresign = false } = {}) {
  const calls = [];
  return {
    calls,
    defaultBucket: () => "crow-files",
    getBucketStats: async () => ({ fileCount: 0, totalSizeBytes: stats }),
    uploadObject: async (key, data, opts) => { calls.push(["put", key, data.length, opts]); if (failUpload) throw new Error("put failed"); },
    deleteObject: async (key, bucket) => { calls.push(["del", key, bucket]); },
    getPresignedUrl: async (key, opts) => { if (failPresign) throw new Error("no presign"); calls.push(["presign", key, opts]); return `http://storage.example/crow-files/${key}?sig=1`; },
  };
}
function fakeDb({ failInsert = false } = {}) {
  const rows = [];
  return {
    rows,
    execute: async ({ sql, args }) => {
      if (/INSERT INTO storage_files/.test(sql)) {
        if (failInsert) throw new Error("db locked");
        rows.push(args);
      }
      return { rows: [], rowsAffected: 1 };
    },
  };
}

test("saveToStorage: uploads under a sunvox-studio key, records storage_files, returns a presigned URL", async () => {
  const s3 = fakeS3(); const db = fakeDb();
  const r = await outputs.saveToStorage({ s3, db, buf: Buffer.alloc(1000), fileName: "my song!.mp3", mimeType: "audio/mpeg", kind: "renders", now: 1700000000000, rand: () => "ab12cd34" });
  assert.equal(r.storage_key, "sunvox-studio/renders/1700000000000-ab12cd34-my_song_.mp3");
  assert.equal(r.bucket, "crow-files");
  assert.match(r.url, /^http:\/\/storage\.example\//);
  assert.equal(r.url_expires_in_s, 3600);
  assert.equal(r.media_path, undefined, "not public unless reference_type is blog_post");
  assert.equal(r.gateway_path, `/storage/file/${r.storage_key}`);
  const put = s3.calls.find((c) => c[0] === "put");
  assert.deepEqual(put.slice(1, 3), [r.storage_key, 1000]);
  assert.equal(put[3].contentType, "audio/mpeg");
  assert.equal(db.rows.length, 1);
  const [key, name, mime, size, bucket, refType, refId] = db.rows[0];
  assert.deepEqual([key, name, mime, size, bucket, refType, refId], [r.storage_key, "my song!.mp3", "audio/mpeg", 1000, "crow-files", null, null]);
});

test("saveToStorage: keys carry a random part by default", async () => {
  const a = await outputs.saveToStorage({ s3: fakeS3(), db: fakeDb(), buf: Buffer.alloc(1), fileName: "a.wav", mimeType: "audio/wav", kind: "renders", now: 1 });
  const b = await outputs.saveToStorage({ s3: fakeS3(), db: fakeDb(), buf: Buffer.alloc(1), fileName: "a.wav", mimeType: "audio/wav", kind: "renders", now: 1 });
  assert.match(a.storage_key, /^sunvox-studio\/renders\/1-[0-9a-f]{32}-a\.wav$/, "128 random bits: blog_post files are public by key");
  assert.notEqual(a.storage_key, b.storage_key);
});

test("saveToStorage: blog_post reference makes a /blog/media path", async () => {
  const r = await outputs.saveToStorage({ s3: fakeS3(), db: fakeDb(), buf: Buffer.alloc(10), fileName: "a.sunvox", mimeType: "application/octet-stream", kind: "projects", referenceType: "blog_post", now: 1, rand: () => "00ff00ff" });
  assert.equal(r.media_path, "/blog/media/sunvox-studio/projects/1-00ff00ff-a.sunvox");
  assert.equal(r.gateway_path, undefined);
});

test("saveToStorage: refuses unknown reference types (other types carry project ACL checks)", async () => {
  await assert.rejects(() => outputs.saveToStorage({ s3: fakeS3(), db: fakeDb(), buf: Buffer.alloc(10), fileName: "a.wav", mimeType: "audio/wav", kind: "renders", referenceType: "research_note" }), /reference_type/);
});

test("saveToStorage: a failed row insert removes the uploaded object", async () => {
  const s3 = fakeS3();
  await assert.rejects(() => outputs.saveToStorage({ s3, db: fakeDb({ failInsert: true }), buf: Buffer.alloc(10), fileName: "a.wav", mimeType: "audio/wav", kind: "renders", now: 5, rand: () => "r" }), /db locked/);
  assert.ok(s3.calls.some((c) => c[0] === "del" && c[1] === "sunvox-studio/renders/5-r-a.wav" && c[2] === "crow-files"));
});

test("saveToStorage: size and quota limits are checked before any upload", async () => {
  const s3 = fakeS3();
  await assert.rejects(() => outputs.saveToStorage({ s3, db: fakeDb(), buf: Buffer.alloc(11), fileName: "a.wav", mimeType: "audio/wav", kind: "renders", maxBytes: 10 }), /larger than the storage upload limit.*mp3 or ogg/);
  const full = fakeS3({ stats: 5 * 1024 * 1024 });
  await assert.rejects(() => outputs.saveToStorage({ s3: full, db: fakeDb(), buf: Buffer.alloc(10), fileName: "a.wav", mimeType: "audio/wav", kind: "renders", quotaBytes: 5 * 1024 * 1024 }), /quota/);
  await assert.rejects(() => outputs.saveToStorage({ s3: fakeS3({ stats: 100 }), db: fakeDb(), buf: Buffer.alloc(10), fileName: "a.wav", mimeType: "audio/wav", kind: "renders", quotaBytes: 105 }), /quota/, "an object that would cross the quota is refused too");
  assert.equal(s3.calls.length + full.calls.length, 0, "nothing uploaded");
});

test("saveToStorage: a presign failure is not fatal", async () => {
  const r = await outputs.saveToStorage({ s3: fakeS3({ failPresign: true }), db: fakeDb(), buf: Buffer.alloc(10), fileName: "a.wav", mimeType: "audio/wav", kind: "renders" });
  assert.equal(r.url, null);
  assert.ok(r.storage_key);
});

test("storageMode: auto saves when available, explicit true needs storage, false never saves", () => {
  assert.equal(outputs.storageMode(undefined, true), "save");
  assert.equal(outputs.storageMode(undefined, false), "skip-unavailable");
  assert.equal(outputs.storageMode(true, true), "save");
  assert.throws(() => outputs.storageMode(true, false), /storage is not available/);
  assert.equal(outputs.storageMode(false, true), "off");
});

test("notifyDone: writes a media notification through createNotification and never throws", async () => {
  const seen = [];
  const ok = await outputs.notifyDone({ createNotification: async (db, o) => { seen.push(o); return { id: 7 }; }, db: {} }, { name: "beat", format: "mp3", duration_s: 12.5, storage_key: "k" });
  assert.equal(ok.notified, true);
  assert.equal(seen[0].type, "media");
  assert.equal(seen[0].source, "sunvox-studio");
  assert.match(seen[0].title, /beat/);
  assert.match(seen[0].body, /12\.5 s mp3/);
  const bad = await outputs.notifyDone({ createNotification: async () => { throw new Error("db gone"); }, db: {} }, { name: "x", format: "wav", duration_s: 1 });
  assert.equal(bad.notified, false);
  assert.match(bad.error, /db gone/);
  const off = await outputs.notifyDone({ createNotification: async () => null, db: {} }, { name: "x", format: "wav", duration_s: 1 });
  assert.equal(off.notified, false, "a type disabled in notification prefs reports not notified");
});

// --- Funkwhale push ---------------------------------------------------------

const LIB = "0f8a6c1e-1111-4222-8333-444455556666";
const UP = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = new URL(String(url));
    const h = routes[`${init.method || "GET"} ${u.pathname}`];
    if (!h) return new Response("not found", { status: 404 });
    const out = await h(u, init);
    return new Response(JSON.stringify(out.body ?? out), { status: out.status || 200, headers: { "content-type": "application/json" } });
  };
  f.calls = calls;
  return f;
}
const CFG = { origin: "http://127.0.0.1:5999", token: "secret-token" };

test("funkwhale: not configured gives a clear error", async () => {
  await assert.rejects(() => fw.pushToFunkwhale({ cfg: null, buf: Buffer.alloc(4), fileName: "a.mp3", library: LIB, fetchImpl: fakeFetch({}) }), /Funkwhale add-on is not installed or not configured/);
});

test("funkwhale: uploads to a library by UUID, bearer only to the configured origin, redirects refused, polls the import", async () => {
  let polls = 0;
  const f = fakeFetch({
    "POST /api/v1/uploads/": () => ({ status: 201, body: { uuid: UP, import_status: "pending" } }),
    [`GET /api/v1/uploads/${UP}/`]: () => ({ uuid: UP, import_status: ++polls >= 2 ? "finished" : "pending", track: { id: 42 } }),
  });
  const r = await fw.pushToFunkwhale({ cfg: CFG, buf: Buffer.from("ID3"), fileName: "beat.mp3", library: LIB, fetchImpl: f, pollMs: 1, pollTimeoutMs: 500 });
  assert.equal(r.funkwhale_upload_uuid, UP);
  assert.equal(r.import_status, "finished");
  assert.equal(r.funkwhale_track_id, 42);
  for (const c of f.calls) {
    assert.ok(c.url.startsWith(CFG.origin + "/api/v1/"), c.url);
    assert.equal(c.init.redirect, "error", "redirects are never followed with the token");
    assert.equal(c.init.headers.Authorization, "Bearer secret-token");
  }
  const form = f.calls[0].init.body;
  assert.equal(form.get("library"), LIB);
  assert.equal(form.get("audio_file").name, "beat.mp3");
  assert.match(form.get("import_reference"), /^sunvox-studio-[0-9a-f]{16}$/, "content hash: a retry carries the same reference");
});

test("funkwhale: by default the import is checked briefly, and a pending import comes back with a hint", async () => {
  const f = fakeFetch({
    "POST /api/v1/uploads/": () => ({ uuid: UP, import_status: "pending" }),
    [`GET /api/v1/uploads/${UP}/`]: () => ({ uuid: UP, import_status: "pending" }),
  });
  const t0 = Date.now();
  const r = await fw.pushToFunkwhale({ cfg: CFG, buf: Buffer.alloc(4), fileName: "a.mp3", library: LIB, fetchImpl: f, pollMs: 50, pollTimeoutMs: 200 });
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(f.calls.length <= 5, `a bounded number of checks (${f.calls.length})`);
  assert.equal(r.import_status, "pending");
  assert.match(r.note, /fw_search/);
  const err = fakeFetch({
    "POST /api/v1/uploads/": () => ({ uuid: UP, import_status: "errored", import_details: { error_code: "track_uuid_not_found" } }),
  });
  const e = await fw.pushToFunkwhale({ cfg: CFG, buf: Buffer.alloc(4), fileName: "a.mp3", library: LIB, fetchImpl: err, pollMs: 50, pollTimeoutMs: 200 });
  assert.equal(e.import_status, "errored");
  assert.match(e.import_error, /track_uuid_not_found/);
});

test("funkwhale: a library name resolves to its UUID among the user's own libraries", async () => {
  const f = fakeFetch({
    "GET /api/v1/libraries/": (u) => { assert.equal(u.searchParams.get("scope"), "me"); return { results: [{ uuid: "11111111-2222-4333-8444-555555555555", name: "Other" }, { uuid: LIB, name: "Crow Renders" }] }; },
    "POST /api/v1/uploads/": (u, init) => { assert.equal(init.body.get("library"), LIB); return { uuid: UP, import_status: "finished" }; },
  });
  const r = await fw.pushToFunkwhale({ cfg: CFG, buf: Buffer.alloc(4), fileName: "a.ogg", library: "crow renders", fetchImpl: f, pollMs: 1, pollTimeoutMs: 1 });
  assert.equal(r.funkwhale_library_uuid, LIB);
  const none = fakeFetch({ "GET /api/v1/libraries/": () => ({ results: [{ uuid: LIB, name: "Crow Renders" }] }) });
  await assert.rejects(() => fw.pushToFunkwhale({ cfg: CFG, buf: Buffer.alloc(4), fileName: "a.mp3", library: "Nope", fetchImpl: none }), /no Funkwhale library named "Nope".*Crow Renders/);
});

test("funkwhale: refuses wav, a non-http origin and an origin with credentials", async () => {
  const f = fakeFetch({});
  await assert.rejects(() => fw.pushToFunkwhale({ cfg: CFG, buf: Buffer.alloc(4), fileName: "a.wav", library: LIB, fetchImpl: f }), /mp3 or ogg/);
  await assert.rejects(() => fw.pushToFunkwhale({ cfg: { origin: "file:///etc", token: "t" }, buf: Buffer.alloc(4), fileName: "a.mp3", library: LIB, fetchImpl: f }), /not an http\(s\) origin/);
  await assert.rejects(() => fw.pushToFunkwhale({ cfg: { origin: "http://u:p@127.0.0.1:1", token: "t" }, buf: Buffer.alloc(4), fileName: "a.mp3", library: LIB, fetchImpl: f }), /not an http\(s\) origin/);
  assert.equal(f.calls.length, 0);
});

test("funkwhale: an upload answer with a malformed uuid is not polled", async () => {
  const f = fakeFetch({ "POST /api/v1/uploads/": () => ({ uuid: "../../users/me", import_status: "pending" }) });
  const r = await fw.pushToFunkwhale({ cfg: CFG, buf: Buffer.alloc(4), fileName: "a.mp3", library: LIB, fetchImpl: f, pollMs: 1, pollTimeoutMs: 50 });
  assert.equal(r.funkwhale_upload_uuid, null);
  assert.equal(f.calls.length, 1);
});

test("funkwhale: the rate limit refuses before any request", async () => {
  const f = fakeFetch({});
  const consume = async () => ({ allowed: false, retry_after: 120 });
  await assert.rejects(() => fw.pushToFunkwhale({ cfg: CFG, buf: Buffer.alloc(4), fileName: "a.mp3", library: LIB, fetchImpl: f, consumeToken: consume, db: {} }), /rate limit.*120 s/);
  assert.equal(f.calls.length, 0);
});

test("funkwhale: one overall deadline caps every request, including a server that never answers", async () => {
  const hang = async (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const t0 = Date.now();
  await assert.rejects(() => fw.pushToFunkwhale({ cfg: CFG, buf: Buffer.alloc(4), fileName: "a.mp3", library: "Some Library", fetchImpl: hang, totalMs: 300 }), /timed out/);
  assert.ok(Date.now() - t0 < 1500, "the lookup stopped at the overall deadline, not its own 10 s timeout");
  // Defaults: the whole push stays inside a 60 s tool call with room for the render.
  const src = (await import("node:fs")).readFileSync(path.join(BUNDLE, "server", "funkwhale-push.js"), "utf8");
  assert.match(src, /totalMs = 35_000/);
});

test("funkwhale: with a rate limiter but no database the upload is refused, not unmetered", async () => {
  const f = fakeFetch({});
  await assert.rejects(() => fw.pushToFunkwhale({ cfg: CFG, buf: Buffer.alloc(4), fileName: "a.mp3", library: LIB, fetchImpl: f, consumeToken: async () => ({ allowed: true }), db: null }), /needs the Crow database/);
  assert.equal(f.calls.length, 0);
});

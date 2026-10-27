// Live check of the storage engine copier against REAL servers: a scratch
// MinIO (source) and a scratch Garage v2.4.1 pinned by digest (target), both
// published on 127.0.0.1 only, data on container tmpfs, removed afterwards.
//
// Self-skips unless docker answers AND both images are already present
// locally (the test never pulls: the MinIO image is no longer on Docker Hub),
// and always under GitHub Actions. The same logic is covered without
// containers by tests/storage-engine-copy.test.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { randomBytes, createHash } from "node:crypto";
import * as Minio from "minio";
import { makeMinioEndpoint, copyAll, StateLog, UploadLog, MIN_PART_SIZE } from "../servers/storage/engine-copy.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "scripts/ops/storage-engine-copy.mjs");
const MINIO_IMAGE = "minio/minio:latest";
const GARAGE_IMAGE = "dxflrs/garage:v2.4.1@sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020";
const LABEL = "crow-test=storage-engine-copy";

function docker(args, opts = {}) { return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, ...opts }); }
function skipReason() {
  if (process.env.GITHUB_ACTIONS === "true") return "CI: no local MinIO image";
  try { docker(["version", "--format", "{{.Server.Version}}"], { timeout: 10_000 }); } catch { return "docker unavailable"; }
  for (const img of [MINIO_IMAGE, GARAGE_IMAGE]) {
    try { docker(["image", "inspect", img, "--format", "{{.Id}}"], { timeout: 10_000 }); } catch { return `image not present locally (never pulled by tests): ${img}`; }
  }
  return null;
}
const SKIP = skipReason();

function freePort() {
  return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
const blob = (n, seed) => { const b = Buffer.allocUnsafe(n); let x = seed >>> 0 || 1; for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b[i] = x & 0xff; } return b; };

let ctx = null;

async function waitReady(client, ms = 60_000) {
  const t0 = Date.now();
  for (;;) {
    try { await client.listBuckets(); return; } catch (e) {
      if (Date.now() - t0 > ms) throw new Error(`server not ready: ${e.message}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

function runCli(args, env) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => res({ code, out, err }));
  });
}

before(async () => {
  if (SKIP) return;
  // Containers from an earlier run that was killed before its after() hook.
  try { const stale = docker(["ps", "-aq", "--filter", `label=${LABEL}`]).trim(); if (stale) docker(["rm", "-fv", ...stale.split(/\s+/)]); } catch {}
  const dir = mkdtempSync(join(tmpdir(), "engine-copy-live-"));
  const tag = `${process.pid}-${randomBytes(3).toString("hex")}`;
  const mPort = await freePort();
  const gPort = await freePort();
  const minioUser = `test${randomBytes(4).toString("hex")}`;
  const minioPass = randomBytes(16).toString("hex");
  const gKey = `GK${randomBytes(12).toString("hex")}`;
  const gSecret = randomBytes(32).toString("hex");
  writeFileSync(join(dir, "garage.toml"), [
    'metadata_dir = "/var/lib/garage/meta"', 'data_dir = "/var/lib/garage/data"', 'db_engine = "sqlite"',
    "replication_factor = 1", 'rpc_bind_addr = "[::]:3901"', 'rpc_public_addr = "127.0.0.1:3901"',
    `rpc_secret = "${randomBytes(32).toString("hex")}"`, "metadata_fsync = true", "data_fsync = true", 'compression_level = "none"',
    "[s3_api]", 's3_region = "us-east-1"', 'api_bind_addr = "[::]:3900"', "",
  ].join("\n"), { mode: 0o644 });
  const names = { minio: `crow-test-s3copy-minio-${tag}`, garage: `crow-test-s3copy-garage-${tag}` };
  docker(["run", "-d", "--rm", "--name", names.minio, "--label", LABEL, "-p", `127.0.0.1:${mPort}:9000`, "--tmpfs", "/data",
    "-e", `MINIO_ROOT_USER=${minioUser}`, "-e", `MINIO_ROOT_PASSWORD=${minioPass}`, MINIO_IMAGE, "server", "/data"]);
  docker(["run", "-d", "--rm", "--name", names.garage, "--label", LABEL, "-p", `127.0.0.1:${gPort}:3900`, "--tmpfs", "/var/lib/garage",
    "-v", `${join(dir, "garage.toml")}:/etc/garage.toml:ro`, "-e", `GARAGE_DEFAULT_ACCESS_KEY=${gKey}`, "-e", `GARAGE_DEFAULT_SECRET_KEY=${gSecret}`,
    GARAGE_IMAGE, "/garage", "server", "--single-node", "--default-access-key"]);
  const mk = (port, accessKey, secretKey) => new Minio.Client({ endPoint: "127.0.0.1", port, useSSL: false, accessKey, secretKey, region: "us-east-1", partSize: MIN_PART_SIZE });
  ctx = {
    dir, names,
    minio: mk(mPort, minioUser, minioPass), garage: mk(gPort, gKey, gSecret),
    from: `http://127.0.0.1:${mPort}`, to: `http://127.0.0.1:${gPort}`,
    env: { COPY_FROM_ACCESS_KEY: minioUser, COPY_FROM_SECRET_KEY: minioPass, COPY_TO_ACCESS_KEY: gKey, COPY_TO_SECRET_KEY: gSecret },
    revEnv: { COPY_FROM_ACCESS_KEY: gKey, COPY_FROM_SECRET_KEY: gSecret, COPY_TO_ACCESS_KEY: minioUser, COPY_TO_SECRET_KEY: minioPass },
    ep: {
      minio: makeMinioEndpoint({ url: `http://127.0.0.1:${mPort}`, accessKey: minioUser, secretKey: minioPass }),
      garage: makeMinioEndpoint({ url: `http://127.0.0.1:${gPort}`, accessKey: gKey, secretKey: gSecret }),
    },
  };
  await waitReady(ctx.minio);
  await waitReady(ctx.garage);
});

after(() => {
  if (!ctx) return;
  for (const n of Object.values(ctx.names)) { try { docker(["rm", "-fv", n]); } catch {} }
  rmSync(ctx.dir, { recursive: true, force: true });
});

const KEYS = {
  small: "tracks/0d/ab/54/01 – Ünïcode + sp ace %25 #?.mp3",
  sourceMultipart: "tracks/big/source-multipart.flac", // uploaded as 5 MiB parts at the source
  overPart: "tracks/big/over-64MiB.flac",               // single object > 64 MiB: becomes multipart in Garage
  empty: "empty.txt",
  capstone: "responses/2026/r1.json",
};

test("live: copy MinIO -> Garage, verify, catch a corrupted and a missing object, deletes, resume, reverse", { skip: SKIP || false, timeout: 600_000 }, async () => {
  const { minio, garage, dir, env, revEnv, from, to } = ctx;
  const small = blob(200_000, 1), mp = blob(12 * 1024 * 1024 + 333, 2), over = blob(70 * 1024 * 1024, 3), cap = Buffer.from('{"answer":42}');
  await minio.makeBucket("crow-funkwhale", "us-east-1");
  await minio.makeBucket("capstone-research", "us-east-1");
  await minio.putObject("crow-funkwhale", KEYS.small, small, small.length, { "Content-Type": "audio/mpeg", "Cache-Control": "max-age=3600", "Content-Disposition": "inline", "Content-Language": "es" });
  await minio.putObject("crow-funkwhale", KEYS.sourceMultipart, mp, mp.length, { "Content-Type": "audio/flac" });
  // A single-part source object over 64 MiB (a client with 128 MiB parts sends it as one PUT).
  const bigPartClient = new Minio.Client({ endPoint: "127.0.0.1", port: Number(new URL(from).port), useSSL: false, accessKey: env.COPY_FROM_ACCESS_KEY, secretKey: env.COPY_FROM_SECRET_KEY, region: "us-east-1", partSize: 128 * 1024 * 1024 });
  await bigPartClient.putObject("crow-funkwhale", KEYS.overPart, over, over.length, { "Content-Type": "audio/flac" });
  await minio.putObject("crow-funkwhale", KEYS.empty, Buffer.alloc(0), 0, { "Content-Type": "text/plain" });
  await minio.putObject("capstone-research", KEYS.capstone, cap, cap.length, { "Content-Type": "application/json", "x-amz-meta-sha256": sha(cap) });
  for (let i = 0; i < 40; i++) { const b = blob(1000 + i, 100 + i); await minio.putObject("capstone-research", `bulk/${i}.txt`, b, b.length, { "x-amz-meta-sha256": sha(b) }); }

  const state = join(dir, "copy-state.jsonl");
  const report = join(dir, "verify-report.json");
  // Resume: the first run (engine API) fails one multipart object on its 2nd part.
  {
    const g = ctx.ep.garage;
    const failing = { ...g, async mpPart(b, k, id, n, buf) { if (k === KEYS.overPart && n === 2) throw new Error("injected"); return g.mpPart(b, k, id, n, buf); } };
    const st = new StateLog(state); const up = new UploadLog(`${state}.uploads.jsonl`);
    const s = await copyAll({ src: ctx.ep.minio, dst: failing, state: st, uploads: up, retries: 0 }); // the CLI's 64 MiB parts
    st.close(); up.closeFd();
    assert.equal(s.ok, false);
    assert.deepEqual(s.buckets["crow-funkwhale"].failed.map((f) => f.key), [KEYS.overPart]);
    const open = []; for await (const u of garage.listIncompleteUploads("crow-funkwhale", "", true)) open.push(u);
    assert.deepEqual(open, [], "the failed upload was aborted on Garage");
  }
  let r = await runCli(["copy", "--from", from, "--to", to, "--all", "--state", state], env);
  assert.equal(r.code, 0, r.err + r.out);
  const sum = JSON.parse(r.out);
  assert.equal(sum.buckets["crow-funkwhale"].copied, 1, "the resumed run copies only the failed object");

  // Exact bytes + metadata on Garage.
  const h = await garage.makeRequestAsyncOmit({ method: "HEAD", bucketName: "crow-funkwhale", objectName: KEYS.small });
  assert.equal(h.headers["content-type"], "audio/mpeg");
  assert.equal(h.headers["cache-control"], "max-age=3600");
  assert.equal(h.headers["content-language"], "es");
  const hc = await garage.statObject("capstone-research", KEYS.capstone);
  assert.equal(hc.metaData.sha256, sha(cap), "Capstone's sha256 meta round-trips");
  const oh = await garage.statObject("crow-funkwhale", KEYS.overPart);
  assert.match(oh.etag, /-2$/, "the >64 MiB single-part source became a 2-part object");

  // Verify passes, with the independent checksum list (Funkwhale DB form).
  const ck = join(dir, "fw-checksums.tsv");
  writeFileSync(ck, `${KEYS.small}\tsha256:${sha(small)}\n${KEYS.sourceMultipart}\tsha256:${sha(mp)}\n${KEYS.overPart}\tsha256:${sha(over)}\n`);
  r = await runCli(["verify", "--from", from, "--to", to, "--all", "--state", state, "--report", report, "--checksums", `crow-funkwhale=${ck}`], env);
  assert.equal(r.code, 0, r.err);
  let rep = JSON.parse(readFileSync(report, "utf8"));
  assert.equal(rep.ok, true);
  assert.equal(rep.buckets["crow-funkwhale"].checksum_covered, 3);
  assert.equal(rep.totals.hashed, 45);

  // A corrupted target object (same size) and a missing one are detected.
  const bad = Buffer.from(small); bad[1000] ^= 0xff;
  await garage.putObject("crow-funkwhale", KEYS.small, bad, bad.length, { "Content-Type": "audio/mpeg", "Cache-Control": "max-age=3600", "Content-Disposition": "inline", "Content-Language": "es" });
  await garage.removeObject("capstone-research", "bulk/7.txt");
  r = await runCli(["verify", "--from", from, "--to", to, "--all", "--state", state, "--report", report, "--checksums", `crow-funkwhale=${ck}`], env);
  assert.equal(r.code, 1);
  rep = JSON.parse(readFileSync(report, "utf8"));
  assert.equal(rep.ok, false);
  assert.deepEqual(rep.buckets["crow-funkwhale"].content_mismatch.map((x) => x.key), [KEYS.small]);
  assert.deepEqual(rep.buckets["crow-funkwhale"].checksum_mismatch.map((x) => x.key), [KEYS.small]);
  assert.deepEqual(rep.buckets["capstone-research"].missing, ["bulk/7.txt"]);

  // Delta repairs both; then a source delete is carried (guarded: 1 of 41 needs the override).
  r = await runCli(["copy", "--from", from, "--to", to, "--all", "--state", state, "--delta"], env);
  assert.equal(r.code, 0, r.err);
  await minio.removeObject("capstone-research", "bulk/3.txt");
  await minio.removeObject("capstone-research", "bulk/4.txt");
  r = await runCli(["copy", "--from", from, "--to", to, "--all", "--state", state, "--delta", "--propagate-deletes"], env);
  assert.equal(r.code, 1, "2 deletes on 41 objects exceed the 1-key floor: refused without the override");
  assert.ok(await garage.statObject("capstone-research", "bulk/3.txt"));
  r = await runCli(["copy", "--from", from, "--to", to, "--all", "--state", state, "--delta", "--propagate-deletes", "--max-delete-pct", "100", "--max-delete-keys", "2"], env);
  assert.equal(r.code, 0, r.err);
  await assert.rejects(garage.statObject("capstone-research", "bulk/3.txt"), /Not Found|NotFound|NoSuchKey/);
  r = await runCli(["verify", "--from", from, "--to", to, "--all", "--state", state, "--report", report, "--reread-source"], env);
  assert.equal(r.code, 0, r.err);

  // Rollback: a change made on Garage after the cutover goes back to MinIO; nothing else is re-copied.
  const changed = Buffer.from('{"answer":43}');
  await garage.putObject("capstone-research", KEYS.capstone, changed, changed.length, { "Content-Type": "application/json", "x-amz-meta-sha256": sha(changed) });
  r = await runCli(["reverse", "--from", to, "--to", from, "--all", "--state", state, "--reverse-state", join(dir, "reverse.jsonl"), "--max-delete-pct", "100", "--max-delete-keys", "1"], revEnv);
  assert.equal(r.code, 0, r.err);
  const rs = JSON.parse(r.out);
  assert.equal(rs.buckets["capstone-research"].copied, 1);
  assert.equal(rs.buckets["crow-funkwhale"].copied, 0, "multipart objects are not re-copied: Garage ETags are compared to the recorded dest_etag");
  const back = await minio.getObject("capstone-research", KEYS.capstone);
  const chunks = []; for await (const c of back) chunks.push(c);
  assert.equal(Buffer.concat(chunks).toString(), '{"answer":43}');
  assert.equal((await minio.statObject("capstone-research", KEYS.capstone)).metaData.sha256, sha(changed));
});

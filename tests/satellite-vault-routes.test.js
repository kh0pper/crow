// The satellite's vault (SAT-8, spec §12.3, §5.2): signed routes for crow's encrypted crow.db
// copies. The agent runs in-process on a real loopback socket with Serve's headers (fixtures/
// serve-peer.mjs); the streamed PUT is signed exactly as crow signs it — the body's hash is
// declared in X-Crow-Sat-Body-Sha256 and the request is signed over that value, because a 100 MB
// backup cannot be buffered for a signature. No network beyond 127.0.0.1.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";

const CROW_HOME = mkdtempSync(join(tmpdir(), "satvault-crow-"));
process.env.CROW_HOME = CROW_HOME;
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "satvault-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
actAsServe();

const P = await import("../servers/shared/satellite-protocol.js");
const { satelliteFetch } = await import("../servers/gateway/satellites/client.js");
const { issueCert } = await import("../servers/gateway/satellites/certs.js");
const { fakeIdentity } = await import("./helpers/fake-satellite.js");
const { startAgent } = await import("../servers/satellite/agent.js");
const { ensureSatelliteKey, writeCert, writePinned } = await import("../servers/satellite/keys.js");
const V = await import("../servers/satellite/vault.js");
// crow's own client: the streamed PUT is exercised over a real socket, not through a fake fetch.
const O = await import("../servers/gateway/satellites/offsite.js");

const dirs = [CROW_HOME, process.env.CROW_DATA_DIR];
const agents = [];
after(async () => {
  for (const a of agents) await a.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const identity = fakeIdentity();
const HOST = "satellite.example.ts.net";
const DAY = "2026-11-02";
const NAME = `crow-db-${DAY.replaceAll("-", "")}.vault`;
const sha = (b) => createHash("sha256").update(b).digest("hex");

/** A paired SAT_HOME (pinned.json then cert.json, as pairing writes them). */
function pairedHome() {
  const home = tmp("satvault-home-");
  const key = ensureSatelliteKey(home);
  const mgmt = P.generateKeypair();
  const cert = issueCert({
    identity, instanceId: "inst-primary", primaryUrl: "https://crow.example.ts.net:8444",
    satellite_id: key.satellite_id, satellite_pubkey: key.ed25519_pub, mgmt_pubkey: mgmt.pubHex, now: Date.now(),
  });
  writePinned(home, {
    crow_id: cert.payload.crow_id, root_pubkey: cert.payload.root_pubkey, mgmt_pubkey: cert.payload.mgmt_pubkey,
    primary_url: cert.payload.primary_url, primary_instance_id: cert.payload.primary_instance_id, target_sha: null,
  });
  writeCert(home, cert);
  return { home, key, mgmt, cert };
}

async function boot({ setup, vaultOptions } = {}) {
  const s = pairedHome();
  if (setup) setup(s.home);
  const a = await startAgent({
    env: { CROW_HOME: s.home, CROW_SATELLITE_PORT: "0" }, out: () => {}, authLog: () => {}, sha: "a".repeat(40),
    ...(vaultOptions ? { vaultOptions } : {}),
  });
  agents.push(a);
  return { ...s, a, crowId: s.cert.payload.crow_id };
}

const serveFetch = (port) => async (url, init = {}) => {
  const u = new URL(url);
  return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { ...init, headers: { ...init.headers, ...serveHeaders(null, "100.64.20.5") } });
};
const call = (t, method, path, body) => satelliteFetch(
  { id: t.a.satelliteId, tailnet_host: HOST, satellite_pubkey: t.a.key.ed25519_pub },
  { method, path: `/satellite/v1/${path}`, body, caller: "owner-local", maxBytes: 4 * 1024 * 1024, fetchImpl: serveFetch(t.a.port), mgmtKey: { ed25519_priv: t.mgmt.privHex } },
);

const vaultDir = (t) => join(t.home, "vault", V.vaultDirHash(t.crowId));
const entries = (t) => { try { return readdirSync(vaultDir(t)); } catch { return []; } };

/**
 * The signed streamed PUT, exactly as crow builds it: the signature covers sha256(body) given up
 * front. `shaSent` may differ from the real hash (that is the tamper case).
 */
async function put(t, { name = NAME, body, shaSent = sha(body), headers: extra = {}, caller = "owner-local", path = null, method = "PUT", ts, nonce } = {}) {
  const p = path || `/satellite/v1/vault/${encodeURIComponent(name)}`;
  const tss = ts || String(Date.now());
  const n = nonce || randomBytes(16).toString("hex");
  const str = P.requestSigningString({ method, pathQuery: p, bodySha256: shaSent, ts: tss, nonce: n, satelliteId: t.a.satelliteId, caller });
  const headers = {
    "content-type": "application/octet-stream",
    "content-length": String(body.length),
    "X-Crow-Sat-Body-Sha256": shaSent,
    "X-Crow-Sat-Sig": P.signBytes(t.mgmt.privHex, Buffer.from(str, "utf8")),
    "X-Crow-Sat-Ts": tss,
    "X-Crow-Sat-Nonce": n,
    "X-Crow-Sat-Caller": caller,
    ...extra,
  };
  const r = await fetch(`http://127.0.0.1:${t.a.port}${p}`, { method, body, headers: { ...headers, ...serveHeaders(null, "100.64.20.5") } });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString("utf8")); } catch { /* a stream */ }
  const sig = r.headers.get("x-crow-sat-resp-sig");
  const sigOk = !!sig && P.verifyResponse(t.a.key.ed25519_pub, { requestNonce: n, status: r.status, bodySha256: P.sha256Hex(buf) }, sig);
  return { status: r.status, json, buf, sigOk, headers };
}

// ── the happy path ──────────────────────────────────────────────────────────

test("a signed PUT stores the file at 0600 in a 0700 dir; list, get and delete work", async () => {
  const t = await boot();
  const body = randomBytes(4096);
  const put1 = await put(t, { body });
  assert.equal(put1.status, 200, JSON.stringify(put1.json));
  assert.deepEqual(put1.json, { ok: true, name: NAME, size: body.length, sha256: sha(body) });
  assert.ok(put1.sigOk, "the answer is signed");

  // $SAT_HOME/vault/<first 16 hex of sha256(crow_id)>/<name>, dirs 0700, file 0600.
  assert.match(V.vaultDirHash(t.crowId), /^[0-9a-f]{16}$/);
  const dir = vaultDir(t);
  assert.equal(statSync(join(t.home, "vault")).mode & 0o777, 0o700);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, NAME)).mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(join(dir, NAME)), body);
  assert.deepEqual(entries(t), [NAME], "no temp file left behind");

  const list = await call(t, "GET", "vault");
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json), "the manifest is the list itself (the bundle-backup pattern)");
  assert.equal(list.json.length, 1);
  const e = list.json[0];
  assert.deepEqual(Object.keys(e).sort(), ["mtime", "name", "sha256", "size"]);
  assert.equal(e.name, NAME);
  assert.equal(e.size, body.length);
  assert.equal(e.sha256, sha(body));
  assert.ok(Number.isFinite(Date.parse(e.mtime)));

  // The download is the plain stream (no per-file signature: the signed manifest covers it).
  const p = `/satellite/v1/vault/${NAME}`;
  const headers = P.signRequest(t.mgmt.privHex, { method: "GET", pathQuery: p, body: "", satelliteId: t.a.satelliteId, caller: "owner-local" });
  const res = await fetch(`http://127.0.0.1:${t.a.port}${p}`, { headers: { ...headers, ...serveHeaders(null, "100.64.20.5") } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  assert.equal(res.headers.get("content-length"), String(body.length));
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), body);

  const del = await call(t, "DELETE", `vault/${NAME}`);
  assert.equal(del.status, 200);
  assert.deepEqual(del.json, { ok: true, name: NAME });
  assert.deepEqual(entries(t), []);
  assert.deepEqual((await call(t, "GET", "vault")).json, []);
  assert.equal((await call(t, "DELETE", `vault/${NAME}`)).json.error, "not_found");

  // Audited under the vault routes, with the caller.
  const rows = t.a.db.prepare("SELECT route, caller, result FROM audit ORDER BY id").all();
  assert.deepEqual(rows[0], { route: `vault/${NAME}`, caller: "owner-local", result: "ok" });
  assert.ok(rows.some((r) => r.route === "vault" && r.result === "ok"));
});

test("a bigger streamed body stores byte-exactly (a backup-sized file, not a JSON body)", async () => {
  const t = await boot();
  const body = randomBytes(3 * 1024 * 1024);
  const r = await put(t, { body });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.size, body.length);
  assert.equal(sha(readFileSync(join(vaultDir(t), NAME))), sha(body));
});

// ── refusals ────────────────────────────────────────────────────────────────

test("a wrong X-Crow-Sat-Body-Sha256 → 400 hash_mismatch, and no file remains", async () => {
  const t = await boot();
  const body = Buffer.from("this is not what the signature says");
  const r = await put(t, { body, shaSent: sha(Buffer.from("other bytes")) });
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error: "hash_mismatch" });
  assert.ok(r.sigOk);
  assert.deepEqual(entries(t), [], "the temp file was unlinked");
});

test("an unsigned PUT is refused before any byte is written; a replayed one too", async () => {
  const t = await boot();
  const body = randomBytes(1024);

  // No signature headers at all, but a well-formed declared hash: refused by auth.
  const bare = await fetch(`http://127.0.0.1:${t.a.port}/satellite/v1/vault/${NAME}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", "content-length": String(body.length), "X-Crow-Sat-Body-Sha256": sha(body), ...serveHeaders(null, "100.64.20.5") },
    body,
  });
  assert.equal(bare.status, 401);
  assert.deepEqual(entries(t), []);

  // No declared hash either: refused by the pre-parser, still no bytes.
  const noHash = await fetch(`http://127.0.0.1:${t.a.port}/satellite/v1/vault/${NAME}`, {
    method: "PUT", headers: { "content-type": "application/octet-stream", "content-length": String(body.length), ...serveHeaders(null, "100.64.20.5") }, body,
  });
  assert.equal(noHash.status, 400);
  assert.deepEqual(await noHash.json(), { error: "bad_body_hash" });
  assert.deepEqual(entries(t), []);

  // A good PUT, then the same signed headers again: a replay, refused, and the stored file only
  // the one the first request wrote.
  const first = await put(t, { body });
  assert.equal(first.status, 200);
  const replay = await put(t, { body, headers: { "X-Crow-Sat-Sig": first.headers["X-Crow-Sat-Sig"], "X-Crow-Sat-Ts": first.headers["X-Crow-Sat-Ts"], "X-Crow-Sat-Nonce": first.headers["X-Crow-Sat-Nonce"] } });
  assert.equal(replay.status, 401);
  assert.deepEqual(replay.json, { error: "replay" });
  assert.deepEqual(entries(t), [NAME]);
  assert.equal(sha(readFileSync(join(vaultDir(t), NAME))), sha(body));
});

test("a body longer than the signed Content-Length is refused and nothing is kept", async () => {
  // Through the store directly: HTTP itself ends the body at Content-Length, so the extra-bytes
  // path is a defence-in-depth check that a real request cannot reach.
  const t = await boot();
  const store = V.createVaultStore({ satHome: t.home, getCrowId: () => t.crowId });
  const body = Buffer.from("0123456789");
  const r = await store.put({ name: NAME, declaredLength: 5, declaredSha256: sha(body), stream: Readable.from([body]) });
  assert.deepEqual(r, { ok: false, status: 400, code: "bad_length" });
  assert.deepEqual(entries(t), []);
  // A short body (fewer bytes than declared) is refused the same way.
  const short = await store.put({ name: NAME, declaredLength: 20, declaredSha256: sha(body), stream: Readable.from([body]) });
  assert.equal(short.code, "bad_length");
  assert.deepEqual(entries(t), []);
});

test("over the 2 GB quota → 413 quota before a byte is written (the incoming length counts)", async () => {
  const t = await boot({ vaultOptions: { quotaBytes: 1000 } });
  const big = randomBytes(1200);
  const r = await put(t, { body: big });
  assert.equal(r.status, 413);
  assert.deepEqual(r.json, { error: "quota" });
  assert.ok(r.sigOk);
  assert.deepEqual(entries(t), [], "no bytes, not even a temp file");

  // What is already stored counts too.
  const ok1 = await put(t, { body: randomBytes(700) });
  assert.equal(ok1.status, 200);
  const over = await put(t, { name: "crow-db-20261103.vault", body: randomBytes(400) });
  assert.equal(over.status, 413);
  assert.deepEqual(entries(t), [NAME]);
});

test("bad names are refused: a path, no date, another suffix, an impossible day", async () => {
  const t = await boot();
  const body = randomBytes(64);
  const bad = [
    ["../x", `/satellite/v1/vault/..%2Fx`],
    ["crow-db-1.vault", null],
    ["x.vault", null],
    ["crow-db-20260230.vault", null],
    ["crow-db-20261102.vault.tmp", null],
  ];
  for (const [name, path] of bad) {
    const r = await put(t, { name, path, body });
    assert.equal(r.status, 400, name);
    assert.equal(r.json.error, "bad_name", name);
  }
  assert.deepEqual(entries(t), []);
  assert.equal((await call(t, "GET", "vault/..%2Fx")).json.error, "bad_name");
  assert.equal((await call(t, "GET", "vault/x.vault")).json.error, "bad_name");
});

test("a symlinked vault dir is refused, and nothing is written through it", async () => {
  const outside = tmp("satvault-outside-");
  const t = await boot({ setup: (home) => symlinkSync(outside, join(home, "vault")) });
  const r = await put(t, { body: randomBytes(128) });
  assert.equal(r.status, 500);
  assert.equal(r.json.error, "unsafe_vault_dir");
  assert.equal((await call(t, "GET", "vault")).json.error, "unsafe_vault_dir");
  assert.deepEqual(readdirSync(outside), []);

  // A symlink at the crow_id level (vault/ itself is real) is refused as well.
  const outside2 = tmp("satvault-outside2-");
  const t2 = await boot({ setup: (home) => { mkdirSync(join(home, "vault"), { recursive: true }); } });
  symlinkSync(outside2, vaultDir(t2));
  const r2 = await put(t2, { body: randomBytes(128) });
  assert.equal(r2.status, 500);
  assert.equal(r2.json.error, "unsafe_vault_dir");
  assert.deepEqual(readdirSync(outside2), []);
});

test("a symlink sitting at a vault name is not followed by the download, and is never unlinked as an object", async () => {
  const t = await boot();
  assert.equal((await put(t, { body: randomBytes(64) })).status, 200);
  const outsideFile = join(t.home, "outside.bin");
  writeFileSync(outsideFile, "not a vault object");
  const name = "crow-db-20261103.vault";
  symlinkSync(outsideFile, join(vaultDir(t), name));
  const p = `/satellite/v1/vault/${name}`;
  const headers = P.signRequest(t.mgmt.privHex, { method: "GET", pathQuery: p, body: "", satelliteId: t.a.satelliteId, caller: "owner-local" });
  const res = await fetch(`http://127.0.0.1:${t.a.port}${p}`, { headers: { ...headers, ...serveHeaders(null, "100.64.20.5") } });
  assert.equal(res.status, 404);
  assert.equal(readFileSync(outsideFile, "utf8"), "not a vault object", "the link target was never sent");
  assert.equal((await call(t, "DELETE", `vault/${name}`)).json.error, "not_found");
  assert.equal(readFileSync(outsideFile, "utf8"), "not a vault object");
});

test("only owner callers may touch the vault: a bot is refused", async () => {
  const t = await boot();
  const body = randomBytes(64);
  const r = await put(t, { body, caller: "bot:b1" });
  assert.equal(r.status, 403);
  assert.deepEqual(r.json, { error: "owner_only" });
  assert.deepEqual(entries(t), []);
  const list = await satelliteFetch(
    { id: t.a.satelliteId, tailnet_host: HOST, satellite_pubkey: t.a.key.ed25519_pub },
    { path: "/satellite/v1/vault", caller: "bot:b1", fetchImpl: serveFetch(t.a.port), mgmtKey: { ed25519_priv: t.mgmt.privHex } },
  );
  assert.equal(list.status, 403);
  assert.equal(list.json.error, "owner_only");
});

test("unpair keeps the vault (spec §12.4)", async () => {
  const t = await boot();
  const body = randomBytes(256);
  assert.equal((await put(t, { body })).status, 200);
  const r = await call(t, "POST", "unpair", { reason: "test" });
  assert.equal(r.status, 200);
  assert.equal(readFileSync(join(vaultDir(t), NAME)).length, body.length, "the vault survived the unpair");
  // And the routes are off while unpaired.
  assert.equal((await put(t, { body })).status, 403);
  assert.equal((await put(t, { body })).json.error, "not_paired");
});

test("a temp file left by an upload that died is swept after a day, so it cannot hold the quota for ever", async () => {
  const t = await boot({ vaultOptions: { quotaBytes: 1000 } });
  mkdirSync(vaultDir(t), { recursive: true, mode: 0o700 });
  const stale = join(vaultDir(t), `${NAME}.deadbeef.tmp`);
  const fresh = join(vaultDir(t), `${NAME}.cafe0000.tmp`);
  writeFileSync(stale, Buffer.alloc(900));
  writeFileSync(fresh, Buffer.alloc(700));
  const old = new Date(Date.now() - 25 * 3600 * 1000);
  utimesSync(stale, old, old);
  // Without the sweep: 900 + 700 already over the 1000-byte quota.
  const r = await put(t, { body: Buffer.alloc(200, 7) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(entries(t).sort(), [`${NAME}.cafe0000.tmp`, NAME].sort(), "the stale temp file is gone, the live one is untouched");
});

test("the vault dir is created on first use only, and the hash names the pinned crow_id", async () => {
  const t = await boot();
  assert.deepEqual(entries(t), [], "nothing exists before the first upload");
  assert.equal((await put(t, { body: randomBytes(32) })).status, 200);
  assert.ok(readdirSync(join(t.home, "vault")).includes(V.vaultDirHash(t.crowId)));
  // A different Crow ID (another pin) would be a different directory, never this one.
  assert.notEqual(V.vaultDirHash(t.crowId), V.vaultDirHash("crow:someone-else"));
});

// ── crow's real upload client, over a real socket ───────────────────────────

test("crow's putVaultFile streams a file through real fetch into the agent: the bytes land and the hash matches", async () => {
  const t = await boot();
  const body = randomBytes(2 * 1024 * 1024 + 123); // several TCP segments, not one buffer
  const file = join(tmp("satvault-put-"), NAME);
  writeFileSync(file, body);
  const r = await O.putVaultFile({
    sat: { id: t.a.satelliteId, tailnet_host: HOST, satellite_pubkey: t.a.key.ed25519_pub },
    file, size: body.length, sha256: sha(body),
    mgmtKey: { ed25519_priv: t.mgmt.privHex },
    fetchImpl: serveFetch(t.a.port),
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json, { ok: true, name: NAME, size: body.length, sha256: sha(body) });
  // The vault holds exactly those bytes, and its signed manifest agrees.
  assert.equal(sha(readFileSync(join(vaultDir(t), NAME))), sha(body));
  const list = await call(t, "GET", "vault");
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.map((e) => [e.name, e.size, e.sha256]), [[NAME, body.length, sha(body)]]);
});

// ── a download the client walks away from ───────────────────────────────────

/** Open fds of this process that point at `path` (both sides run in this process). */
function openFdsFor(path) {
  try {
    return readdirSync("/proc/self/fd").filter((n) => {
      try { return readlinkSync(`/proc/self/fd/${n}`) === path; } catch { return false; }
    });
  } catch { return null; } // no /proc (not Linux): the fd assertion is skipped
}

test("a download the client abandons mid-stream releases the file, and the agent keeps serving", async () => {
  const t = await boot();
  const body = randomBytes(8 * 1024 * 1024);
  assert.equal((await put(t, { body })).status, 200);
  const filePath = join(vaultDir(t), NAME);

  const p = `/satellite/v1/vault/${NAME}`;
  const signed = () => ({ ...P.signRequest(t.mgmt.privHex, { method: "GET", pathQuery: p, body: "", satelliteId: t.a.satelliteId, caller: "owner-local" }), ...serveHeaders(null, "100.64.20.5") });
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${t.a.port}${p}`, { headers: signed(), signal: ac.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const first = await reader.read();
  assert.ok(first.value?.length > 0, "the download had started");
  const openWhileStreaming = openFdsFor(filePath);
  assert.ok(openWhileStreaming === null || openWhileStreaming.length >= 1, "the agent holds the file open while it streams");
  ac.abort();
  try { await reader.cancel(); } catch { /* aborted */ }

  // The file handle is closed when the client goes away (pipeline, not .pipe with a bare destroy).
  if (openWhileStreaming !== null) {
    let left = openFdsFor(filePath);
    for (let i = 0; i < 100 && left.length; i++) {
      await new Promise((ok) => setTimeout(ok, 50));
      left = openFdsFor(filePath);
    }
    assert.deepEqual(left, [], "no file descriptor is left open");
  }

  // And the agent is still healthy: the manifest and a complete download both work.
  const list = await call(t, "GET", "vault");
  assert.equal(list.status, 200);
  assert.equal(list.json[0].sha256, sha(body));
  const again = await fetch(`http://127.0.0.1:${t.a.port}${p}`, { headers: signed() });
  assert.equal(again.status, 200);
  assert.equal(sha(Buffer.from(await again.arrayBuffer())), sha(body));
});
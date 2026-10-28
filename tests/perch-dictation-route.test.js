/**
 * Perch composer dictation, the server half: routes/perch-dictation.js.
 *
 * Harness: a real init-db'd scratch crow.db (CROW_DATA_DIR, so nothing can
 * touch the operator's ~/.crow) with `stt_profiles` seeded per case, an
 * ephemeral express app per case, and two FAKE upstreams on loopback — a
 * "local whisper" (faster-whisper-server shaped: /health, /api/ps,
 * /v1/audio/transcriptions) and a "cloud" stand-in for Groq. No test here
 * ever reaches a real speech-to-text server.
 *
 * The cloud fake also listens on 127.0.0.1, which the strict local-URL rule
 * would call local; the router's `isLocalUrl` seam marks that one port as
 * cloud. isLocalSttUrl itself is unit-tested on its own below.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import http from "node:http";
import Database from "better-sqlite3";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
actAsServe(); // this process's HTTP client stands in for tailscaled (the Serve socket owner)

const dir = mkdtempSync(join(tmpdir(), "perch-dictation-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
delete process.env.CROW_DASHBOARD_PUBLIC;
delete process.env.GATEWAY_FUNNEL_PUBLIC_PREFIXES;

const DB_FILE = join(dir, "crow.db");
const REPO = new URL("..", import.meta.url).pathname;
const TURBO = "deepdml/faster-whisper-large-v3-turbo-ct2";
const LARGE = "Systran/faster-whisper-large-v3";

let mod, express;

// ---------------------------------------------------------------------------
// fake upstreams
// ---------------------------------------------------------------------------

/** A faster-whisper-server-shaped fake. `mode`: ok | fail | hang. A hung
 *  request is parked until release(); `aborted` counts requests whose socket
 *  closed before the fake answered (the gateway aborted upstream). */
function makeFake({ name }) {
  const f = {
    name, mode: "ok", ps: [LARGE], psStatus: 200, text: "hello from the fake",
    hits: { health: 0, ps: 0, transcribe: 0 }, last: null, aborted: 0, parked: [],
    port: 0, server: null,
    release() { const p = f.parked.splice(0); for (const fn of p) fn(); },
    total() { return f.hits.health + f.hits.ps + f.hits.transcribe; },
    reset() { f.mode = "ok"; f.ps = [LARGE]; f.psStatus = 200; f.hits = { health: 0, ps: 0, transcribe: 0 }; f.last = null; f.aborted = 0; f.parked = []; },
  };
  f.server = http.createServer(async (req, res) => {
    const url = req.url.split("?")[0];
    if (req.method === "GET" && url === "/health") { f.hits.health++; res.writeHead(200); return res.end("OK"); }
    if (req.method === "GET" && url === "/api/ps") {
      f.hits.ps++;
      if (f.psStatus !== 200) { res.writeHead(f.psStatus); return res.end("nope"); }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ models: f.ps }));
    }
    if (req.method === "POST" && url.endsWith("/audio/transcriptions")) {
      f.hits.transcribe++;
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks);
      const form = await new Response(raw, { headers: { "content-type": req.headers["content-type"] } }).formData();
      const file = form.get("file");
      f.last = {
        model: form.get("model"),
        language: form.has("language") ? form.get("language") : null,
        fileType: file && file.type,
        fileName: file && file.name,
        fileBytes: file ? Buffer.from(await file.arrayBuffer()) : null,
        auth: req.headers.authorization || null,
      };
      let answered = false;
      res.on("close", () => { if (!answered) f.aborted++; });
      const answer = () => {
        answered = true;
        if (f.mode === "fail") { res.writeHead(500); return res.end("SECRET-UPSTREAM-DETAIL at http://10.9.9.9/internal"); }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: f.text, language: "en", duration: 1.5 }));
      };
      if (f.mode === "hang") { f.parked.push(() => { if (!res.destroyed) answer(); else answered = true; }); return; }
      return answer();
    }
    res.writeHead(404); res.end();
  });
  return f;
}

const local = makeFake({ name: "local" });
const cloud = makeFake({ name: "cloud" });
const other = makeFake({ name: "other" });   // a second local box, for "no profile id from the client"
let closedPort = 0;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO,
  });
  for (const f of [local, cloud, other]) {
    await new Promise((r) => f.server.listen(0, "127.0.0.1", r));
    f.port = f.server.address().port;
  }
  // A port nothing listens on: bind, read, close.
  const tmp = http.createServer();
  await new Promise((r) => tmp.listen(0, "127.0.0.1", r));
  closedPort = tmp.address().port;
  await new Promise((r) => tmp.close(r));

  mod = await import("../servers/gateway/routes/perch-dictation.js");
  ({ default: express } = await import("express"));
});

after(() => {
  for (const f of [local, cloud, other]) { f.release(); f.server.close(); }
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// profiles
// ---------------------------------------------------------------------------

const P_LOCAL = () => ({ id: "p-local", name: "Local Whisper Box", provider: "fasterwhisper",
  baseUrl: `http://127.0.0.1:${local.port}/v1`, defaultModel: LARGE, language: "", isDefault: true });
const P_OTHER = () => ({ id: "p-other", name: "Other Box", provider: "fasterwhisper",
  baseUrl: `http://127.0.0.1:${other.port}/v1`, defaultModel: LARGE, language: "", isDefault: false });
const P_GROQ = (isDefault = false, apiKey = "fake-test-key-123") => ({ id: "p-groq", name: "Groq Whisper", provider: "groq",
  baseUrl: `http://127.0.0.1:${cloud.port}/openai/v1`, defaultModel: "whisper-large-v3-turbo", language: "",
  apiKey, isDefault });

function seed(profiles) {
  const c = new Database(DB_FILE);
  if (profiles == null) c.prepare("DELETE FROM dashboard_settings WHERE key='stt_profiles'").run();
  else c.prepare("INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES ('stt_profiles', ?)").run(JSON.stringify(profiles));
  c.close();
}

function resetFakes() { local.reset(); cloud.reset(); other.reset(); }

// ---------------------------------------------------------------------------
// app factory
// ---------------------------------------------------------------------------

/** One app per case so caches, limiter and locks never leak between cases.
 *  The stub auth stands in for dashboardAuth: it sets req.dashboardSession
 *  from a test header (the real middleware is exercised in "Rails" below). */
async function mkApp(opts = {}) {
  const app = express();
  app.use(express.json());                      // the gateway's global parser: must not touch audio
  const stubAuth = (req, res, next) => { req.dashboardSession = req.headers["x-test-session"] || "session-a"; next(); };
  const router = mod.default(stubAuth, {
    isLocalUrl: (u) => { try { if (new URL(u).port === String(cloud.port)) return false; } catch {} return mod.isLocalSttUrl(u); },
    log: () => {},
    ...opts,
  });
  app.use(router);
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = "http://127.0.0.1:" + srv.address().port + "/dashboard/perch-api/dictation";
  return { srv, base, router, port: srv.address().port, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}

const probe = async (a, headers = {}) => {
  const r = await fetch(a.base, { headers });
  return { status: r.status, body: await r.json() };
};

const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(300, 7)]);
const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(300, 5)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(300, 3)]);

async function post(a, { body = WEBM, type = "audio/webm;codecs=opus", tag, session = "session-a", headers = {}, query = "" } = {}) {
  const h = { "content-type": type, "x-test-session": session, ...headers };
  if (tag !== null) h["x-crow-dictation-profile"] = tag === undefined ? (await probe(a)).body.profileTag : tag;
  const r = await fetch(a.base + query, { method: "POST", headers: h, body });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json, text, type: r.headers.get("content-type") || "" };
}

/** A raw http POST we can cut off: resolves once the fake has the request,
 *  then the caller destroys the socket. */
function rawPost(a, { body = WEBM, tag, session = "session-a", contentLength } = {}) {
  const req = http.request({ host: "127.0.0.1", port: a.port, method: "POST", path: "/dashboard/perch-api/dictation",
    headers: { "content-type": "audio/webm", "x-test-session": session, "x-crow-dictation-profile": tag,
      "content-length": contentLength ?? body.length } });
  req.on("error", () => {});
  return req;
}

const until = async (cond, what, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, 15));
  }
};

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test("isLocalSttUrl: loopback, RFC1918, CGNAT and ULA are local; everything else (incl. lookalikes) is not", () => {
  const L = mod.isLocalSttUrl;
  for (const u of ["http://localhost:8004/v1", "http://127.0.0.1:9000", "http://127.9.9.9", "http://[::1]:8004",
    "http://10.1.2.3:8000/v1", "http://172.16.0.1", "http://172.31.255.255", "http://192.168.1.5:8004",
    "http://100.64.0.1", "http://100.127.255.254", "http://[fd12:3456::1]:8000", "http://[fc00::1]"]) {
    assert.equal(L(u), true, u);
  }
  for (const u of ["https://api.groq.com/openai/v1", "http://172.32.0.1", "http://100.128.0.1", "http://8.8.8.8",
    "http://localhost.example.com", "http://[2001:db8::1]", "not a url", "", null]) {
    assert.equal(L(u), false, String(u));
  }
});

test("isLocalSttUrl never consults CROW_ALLOWED_IPS", () => {
  const prev = process.env.CROW_ALLOWED_IPS;
  process.env.CROW_ALLOWED_IPS = "8.8.8.8,203.0.113.7";
  try {
    assert.equal(mod.isLocalSttUrl("http://8.8.8.8/v1"), false);
    assert.equal(mod.isLocalSttUrl("http://203.0.113.7/v1"), false);
  } finally {
    if (prev === undefined) delete process.env.CROW_ALLOWED_IPS; else process.env.CROW_ALLOWED_IPS = prev;
  }
});

test("pickDictationModel: turbo only when listed, else large-v3 when listed, else the profile's own", () => {
  const pick = mod.pickDictationModel;
  const fw = { provider: "fasterwhisper", defaultModel: "Systran/faster-distil-whisper-small.en" };
  assert.equal(pick(fw, [LARGE, TURBO]), TURBO);
  assert.equal(pick(fw, ["dropbox-dash/faster-whisper-large-v3-turbo", LARGE]), "dropbox-dash/faster-whisper-large-v3-turbo");
  assert.equal(pick(fw, [LARGE, "Systran/faster-whisper-tiny.en"]), LARGE);
  assert.equal(pick(fw, ["Systran/faster-whisper-tiny.en"]), fw.defaultModel, "never a model /api/ps did not list");
  assert.equal(pick(fw, null), fw.defaultModel, "/api/ps unavailable → the profile's model");
  assert.equal(pick({ provider: "groq", defaultModel: "whisper-large-v3-turbo" }, [TURBO]), "whisper-large-v3-turbo");
  assert.equal(pick({ provider: "whispercpp", defaultModel: "" }, [TURBO]), "");
});

test("profileTag is opaque: 16 hex, changes with provider/url/model and the model dictation picked, never echoes the url", () => {
  const a = mod.profileTagFor("fasterwhisper", "http://localhost:8004/v1", LARGE, LARGE);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, mod.profileTagFor("fasterwhisper", "http://localhost:8004/v1", TURBO, LARGE));
  assert.notEqual(a, mod.profileTagFor("groq", "http://localhost:8004/v1", LARGE, LARGE));
  assert.notEqual(a, mod.profileTagFor("fasterwhisper", "http://localhost:8004/v1", LARGE, TURBO), "a turbo appearing changes the tag");
  assert.equal(a, createHash("sha256").update("fasterwhisper|http://localhost:8004/v1|" + LARGE + "|" + LARGE).digest("hex").slice(0, 16));
});

test("isLocalSttUrl: a server addressed by NAME is treated as cloud (errs toward privacy; documented)", () => {
  assert.equal(mod.isLocalSttUrl("http://faster-whisper:8000/v1"), false);
  assert.equal(mod.isLocalSttUrl("http://whisper-box.example.ts.net:8004/v1"), false);
  const src = readFileSync(join(REPO, "servers/gateway/routes/perch-dictation.js"), "utf8");
  assert.match(src, /addressed by name/i, "the name-is-cloud rule is written down beside the function");
});

test("sniffMatches: magic bytes must match the declared type", () => {
  const s = mod.sniffMatches;
  assert.equal(s("audio/webm", WEBM), true);
  assert.equal(s("audio/ogg", OGG), true);
  assert.equal(s("audio/mp4", MP4), true);
  assert.equal(s("audio/x-m4a", MP4), true);
  assert.equal(s("audio/webm", OGG), false);
  assert.equal(s("audio/ogg", WEBM), false);
  assert.equal(s("audio/mp4", Buffer.from("tiny")), false);
});

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

test("probe, local default: available, not cloud, and nothing identifying leaks", async () => {
  resetFakes(); seed([P_LOCAL(), P_GROQ(false)]);
  const a = await mkApp();
  try {
    const { status, body } = await probe(a);
    assert.equal(status, 200);
    assert.equal(body.available, true);
    assert.equal(body.cloud, false);
    assert.equal(body.provider, undefined, "the provider name is sent only for a cloud profile");
    assert.match(body.profileTag, /^[0-9a-f]{16}$/);
    assert.equal(body.maxSeconds, 60, "large-v3 only → 60 s");
    const s = JSON.stringify(body);
    for (const leak of [String(local.port), "127.0.0.1", "p-local", "Local Whisper Box", "fake-test-key", "baseUrl"]) {
      assert.equal(s.includes(leak), false, "probe leaked " + leak);
    }
    assert.equal(cloud.total(), 0, "a non-default cloud profile is never contacted");
  } finally { await a.close(); }
});

test("probe, Groq default with a key: available + cloud + provider name, and the cloud got ZERO requests", async () => {
  resetFakes(); seed([{ ...P_LOCAL(), isDefault: false }, P_GROQ(true)]);
  const a = await mkApp();
  try {
    const { body } = await probe(a);
    assert.equal(body.available, true);
    assert.equal(body.cloud, true);
    assert.equal(body.provider, "Groq Whisper");
    assert.equal(body.maxSeconds, 120);
    assert.equal(cloud.total(), 0, "the probe never contacts a cloud endpoint");
    assert.equal(local.total(), 0, "nor the non-default local one");
    assert.equal(JSON.stringify(body).includes("fake-test-key"), false);
  } finally { await a.close(); }
});

test("probe: Groq default without a key → missing_key; no profiles → no_profile; unknown provider → unknown_provider", async () => {
  resetFakes();
  seed([P_GROQ(true, "")]);
  let a = await mkApp();
  try { const { body } = await probe(a); assert.equal(body.available, false); assert.equal(body.reason, "missing_key"); }
  finally { await a.close(); }
  seed(null);
  a = await mkApp();
  try { const { body } = await probe(a); assert.equal(body.available, false); assert.equal(body.reason, "no_profile"); }
  finally { await a.close(); }
  seed([{ id: "x", name: "x", provider: "mystery", isDefault: true }]);
  a = await mkApp();
  try { const { body } = await probe(a); assert.equal(body.reason, "unknown_provider"); }
  finally { await a.close(); }
  assert.equal(cloud.total(), 0);
});

test("probe: local default on a closed port reads unreachable — and Groq, also configured, is NOT tried", async () => {
  resetFakes(); seed([{ ...P_LOCAL(), baseUrl: `http://127.0.0.1:${closedPort}/v1` }, P_GROQ(false)]);
  const a = await mkApp();
  try {
    const { body } = await probe(a);
    assert.equal(body.available, false);
    assert.equal(body.reason, "unreachable");
    assert.equal(cloud.total(), 0, "no surprise fallback to another provider");
    const p = await post(a, { tag: "0000000000000000" });
    assert.equal(p.status, 503);
    assert.equal(p.body.error, "unreachable");
    assert.equal(cloud.total(), 0, "the POST does not fall back either");
  } finally { await a.close(); }
});

test("probe maxSeconds: 120 when /api/ps lists turbo, 60 when only large-v3", async () => {
  resetFakes(); seed([P_LOCAL()]);
  local.ps = [LARGE, TURBO];
  let a = await mkApp();
  try { assert.equal((await probe(a)).body.maxSeconds, 120); } finally { await a.close(); }
  local.ps = [LARGE];
  a = await mkApp();
  try { assert.equal((await probe(a)).body.maxSeconds, 60); } finally { await a.close(); }
});

test("probe cache: no re-hit within 30 s, re-hit after; a changed profile re-probes at once", async () => {
  resetFakes(); seed([P_LOCAL()]);
  let t = 1_000_000;
  const a = await mkApp({ now: () => t });
  try {
    await probe(a);
    assert.equal(local.hits.health, 1);
    t += 29_000; await probe(a);
    assert.equal(local.hits.health, 1, "cached for 30 s");
    t += 2_000; await probe(a);
    assert.equal(local.hits.health, 2, "re-probed after 30 s");
    seed([{ ...P_LOCAL(), defaultModel: "Systran/faster-whisper-tiny.en" }]);
    const b = await probe(a);
    assert.equal(local.hits.health, 3, "a new profile tag is never served stale");
    assert.equal(b.body.available, true);
  } finally { await a.close(); }
});

test("probe: an unusable answer is cached only 10 s", async () => {
  resetFakes(); seed([{ ...P_LOCAL(), baseUrl: `http://127.0.0.1:${closedPort}/v1` }]);
  let t = 5_000_000, calls = 0;
  const a = await mkApp({ now: () => t, healthCheck: async () => { calls++; return false; } });
  try {
    await probe(a); t += 9_000; await probe(a);
    assert.equal(calls, 1);
    t += 2_000; await probe(a);
    assert.equal(calls, 2);
  } finally { await a.close(); }
});

test("a turbo model appearing changes the tag: an upload made against the old one gets 409, not a mismatched cap", async () => {
  resetFakes(); seed([P_LOCAL()]);
  let t = 9_000_000;
  const a = await mkApp({ now: () => t });
  try {
    const before = (await probe(a)).body;
    assert.equal(before.maxSeconds, 60);
    local.ps = [LARGE, TURBO];
    t += 31_000;
    const after = (await probe(a)).body;
    assert.equal(after.maxSeconds, 120);
    assert.notEqual(after.profileTag, before.profileTag);
    const r = await post(a, { tag: before.profileTag });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "profile_changed");
    assert.equal(local.hits.transcribe, 0);
    assert.equal((await post(a, { tag: after.profileTag })).status, 200);
    assert.equal(local.last.model, TURBO);
  } finally { await a.close(); }
});

test("30 GETs in a row are never rate limited", async () => {
  resetFakes(); seed([P_LOCAL()]);
  const a = await mkApp();
  try {
    for (let i = 0; i < 30; i++) assert.equal((await probe(a)).status, 200, "GET #" + (i + 1));
  } finally { await a.close(); }
});

// ---------------------------------------------------------------------------
// model choice, through the route
// ---------------------------------------------------------------------------

test("model sent upstream: turbo when listed, large-v3 when only it is listed, the profile's when /api/ps fails", async () => {
  resetFakes(); seed([P_LOCAL()]);
  local.ps = [LARGE, TURBO];
  let a = await mkApp();
  try { assert.equal((await post(a)).status, 200); assert.equal(local.last.model, TURBO); } finally { await a.close(); }

  resetFakes(); local.ps = [LARGE, "Systran/faster-whisper-tiny.en"];
  a = await mkApp();
  try { await post(a); assert.equal(local.last.model, LARGE); } finally { await a.close(); }

  resetFakes(); local.psStatus = 404;
  seed([{ ...P_LOCAL(), defaultModel: "Systran/faster-distil-whisper-small.en" }]);
  a = await mkApp();
  try {
    assert.equal((await post(a)).status, 200);
    assert.equal(local.last.model, "Systran/faster-distil-whisper-small.en", "the profile's own model, nothing unlisted");
  } finally { await a.close(); }

  resetFakes(); local.ps = ["Systran/faster-whisper-tiny.en"];
  seed([{ ...P_LOCAL(), defaultModel: "Systran/faster-distil-whisper-small.en" }]);
  a = await mkApp();
  try {
    await post(a);
    assert.equal(local.last.model, "Systran/faster-distil-whisper-small.en", "never a model id /api/ps did not list, except the profile's own");
  } finally { await a.close(); }
});

// ---------------------------------------------------------------------------
// transcribe
// ---------------------------------------------------------------------------

test("happy path for webm, mp4 and ogg → {text}, and the upstream request was NOT aborted", async () => {
  resetFakes(); seed([P_LOCAL()]);
  const a = await mkApp();
  try {
    for (const [type, body, ext] of [["audio/webm;codecs=opus", WEBM, "webm"], ["audio/mp4", MP4, "mp4"], ["audio/ogg;codecs=opus", OGG, "ogg"]]) {
      const r = await post(a, { type, body });
      assert.equal(r.status, 200, type + ": " + r.text);
      assert.equal(r.body.text, "hello from the fake");
      assert.equal(r.body.language, "en");
      assert.equal(local.last.fileType, type.split(";")[0]);
      assert.equal(local.last.fileName, "dictation." + ext);
      assert.deepEqual(local.last.fileBytes, body, "the clip reaches the whisper box byte for byte");
    }
    assert.equal(local.aborted, 0, "a res.on('close') rail: the happy path must never abort upstream");
  } finally { await a.close(); }
});

test("language is sent iff the profile has one", async () => {
  resetFakes(); seed([P_LOCAL()]);
  let a = await mkApp();
  try { await post(a); assert.equal(local.last.language, null); } finally { await a.close(); }
  seed([{ ...P_LOCAL(), language: "es" }]);
  a = await mkApp();
  try { await post(a); assert.equal(local.last.language, "es"); } finally { await a.close(); }
});

test("415: text/plain, any Content-Encoding, audio/wav, and webm carrying OggS bytes", async () => {
  resetFakes(); seed([P_LOCAL()]);
  const a = await mkApp();
  try {
    assert.equal((await post(a, { type: "text/plain" })).status, 415);
    assert.equal((await post(a, { headers: { "content-encoding": "gzip" } })).status, 415);
    assert.equal((await post(a, { type: "audio/wav" })).status, 415);
    const sniff = await post(a, { type: "audio/webm", body: OGG });
    assert.equal(sniff.status, 415);
    assert.equal(local.hits.transcribe, 0);
  } finally { await a.close(); }
});

test("413 is JSON (not finalhandler HTML) over 1,000,000 bytes; 400 for an empty body", async () => {
  resetFakes(); seed([P_LOCAL()]);
  const a = await mkApp();
  try {
    const big = await post(a, { body: Buffer.concat([WEBM, Buffer.alloc(1_000_001)]) });
    assert.equal(big.status, 413);
    assert.match(big.type, /application\/json/);
    assert.equal(big.text.includes("<"), false, "no HTML, no stack trace");
    const empty = await post(a, { body: Buffer.alloc(0) });
    assert.equal(empty.status, 400);
    assert.match(empty.type, /application\/json/);
    assert.equal(local.hits.transcribe, 0);
  } finally { await a.close(); }
});

test("429 on the 11th POST in a minute; the limiter key is a hash, never the raw session token", async () => {
  resetFakes(); seed([P_LOCAL()]);
  const a = await mkApp();
  try {
    const tag = (await probe(a)).body.profileTag;
    for (let i = 0; i < 10; i++) assert.equal((await post(a, { tag, session: "tok-secret-1" })).status, 200, "POST #" + (i + 1));
    const r = await post(a, { tag, session: "tok-secret-1" });
    assert.equal(r.status, 429);
    assert.equal((await post(a, { tag, session: "tok-secret-2" })).status, 200, "another operator has their own budget");
    const keys = [...a.router._dictation.limiter._buckets.keys()];
    assert.ok(keys.length >= 2);
    for (const k of keys) assert.equal(k.includes("tok-secret"), false, "raw token used as a Map key");
    assert.ok(keys.includes(createHash("sha256").update("tok-secret-1").digest("hex")));
  } finally { await a.close(); }
});

test("409 profile_changed when the tag differs or is missing, and the upstream got ZERO requests", async () => {
  resetFakes(); seed([P_LOCAL()]);
  const a = await mkApp();
  try {
    const wrong = await post(a, { tag: "ffffffffffffffff" });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.error, "profile_changed");
    const none = await post(a, { tag: null });
    assert.equal(none.status, 409);
    assert.equal(none.body.error, "profile_changed");
    assert.equal(local.hits.transcribe, 0);
  } finally { await a.close(); }
});

test("cloud profile: the fake cloud receives the clip ONLY when it is the configured profile", async () => {
  resetFakes();
  // Local is the default; Groq is configured but not default.
  seed([P_LOCAL(), P_GROQ(false)]);
  const a = await mkApp();
  try {
    const r1 = await post(a, { body: WEBM });
    assert.equal(r1.status, 200);
    assert.equal(local.hits.transcribe, 1);
    assert.equal(cloud.total(), 0, "a non-default cloud profile never receives the clip");

    // A probe made while local, then the operator switches the default to
    // Groq: the old tag is refused before anything leaves the box.
    const staleTag = (await probe(a)).body.profileTag;
    seed([{ ...P_LOCAL(), isDefault: false }, P_GROQ(true)]);
    const stale = await post(a, { tag: staleTag });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "profile_changed");
    assert.equal(cloud.total(), 0, "profile_changed is answered before any upstream request");

    // Re-probed (the client shows "Transcribed by Groq Whisper"), it goes.
    const p = await probe(a);
    assert.equal(p.body.cloud, true);
    const r2 = await post(a, { tag: p.body.profileTag, body: OGG, type: "audio/ogg" });
    assert.equal(r2.status, 200, r2.text);
    assert.equal(cloud.hits.transcribe, 1);
    assert.deepEqual(cloud.last.fileBytes, OGG);
    assert.equal(cloud.last.model, "whisper-large-v3-turbo", "a cloud profile keeps its own model");
    assert.equal(cloud.last.auth, "Bearer fake-test-key-123");
    assert.equal(local.hits.transcribe, 1, "and the local box got nothing more");
  } finally { await a.close(); }
});

test("lock (C2): after a 413, a 400 and a mid-upload abort, the next valid POST is 200, not 409", async () => {
  resetFakes(); seed([P_LOCAL()]);
  const a = await mkApp();
  try {
    const tag = (await probe(a)).body.profileTag;
    assert.equal((await post(a, { tag, body: Buffer.concat([WEBM, Buffer.alloc(1_000_001)]) })).status, 413);
    assert.equal((await post(a, { tag, body: Buffer.alloc(0) })).status, 400);
    const req = rawPost(a, { tag, contentLength: 5000 });
    req.write(WEBM.subarray(0, 100));
    await new Promise((r) => setTimeout(r, 50));
    req.destroy();
    await new Promise((r) => setTimeout(r, 50));
    const ok = await post(a, { tag });
    assert.equal(ok.status, 200, ok.text);
  } finally { await a.close(); }
});

test("lock (I1), local: one dictation at a time across ALL operators (process-wide)", async () => {
  resetFakes(); seed([P_LOCAL()]);
  const a = await mkApp();
  try {
    const tag = (await probe(a)).body.profileTag;
    local.mode = "hang";
    const first = post(a, { tag, session: "alice-session" });
    await until(() => local.parked.length === 1, "the first upload to reach the fake");
    const second = await post(a, { tag, session: "second-user-session" });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, "dictation_busy");
    local.release();
    assert.equal((await first).status, 200);
    local.mode = "ok";
    assert.equal((await post(a, { tag, session: "second-user-session" })).status, 200, "released after it settled");
  } finally { local.release(); await a.close(); }
});

test("lock (I1), cloud: two sessions run concurrently; the same session gets 409", async () => {
  resetFakes(); seed([P_GROQ(true)]);
  const a = await mkApp();
  try {
    const tag = (await probe(a)).body.profileTag;
    cloud.mode = "hang";
    const one = post(a, { tag, session: "s-one" });
    const two = post(a, { tag, session: "s-two" });
    await until(() => cloud.parked.length === 2, "both sessions to reach the cloud fake");
    const dup = await post(a, { tag, session: "s-one" });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, "dictation_busy");
    cloud.release();
    assert.equal((await one).status, 200);
    assert.equal((await two).status, 200);
  } finally { cloud.release(); await a.close(); }
});

test("abort, cloud: a client disconnect after the body was sent aborts the cloud request", async () => {
  resetFakes(); seed([P_GROQ(true)]);
  const a = await mkApp();
  try {
    const tag = (await probe(a)).body.profileTag;
    cloud.mode = "hang";
    const req = rawPost(a, { tag });
    req.end(WEBM);
    await until(() => cloud.parked.length === 1, "the cloud fake to hold the request");
    req.destroy();
    await until(() => cloud.aborted === 1, "the cloud fake to see its socket close");
    cloud.mode = "ok";
    cloud.parked = [];
    assert.equal((await post(a, { tag })).status, 200, "the per-session lock was released");
  } finally { cloud.release(); await a.close(); }
});

test("abort, local: a client disconnect does NOT abort the local job; the lock holds until it settles", async () => {
  resetFakes(); seed([P_LOCAL()]);
  const a = await mkApp();
  try {
    const tag = (await probe(a)).body.profileTag;
    local.mode = "hang";
    const req = rawPost(a, { tag });
    req.end(WEBM);
    await until(() => local.parked.length === 1, "the local fake to hold the request");
    req.destroy();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(local.aborted, 0, "the sync whisper job keeps running anyway; the gateway must not pretend otherwise");
    const between = await post(a, { tag, session: "session-b" });
    assert.equal(between.status, 409, "no second full-length job stacked behind the first");
    assert.equal(between.body.error, "dictation_busy");
    local.mode = "ok";
    local.release();
    await until(() => local.parked.length === 0, "release");
    let after;
    for (let i = 0; i < 20; i++) { after = await post(a, { tag, session: "session-c" }); if (after.status !== 409) break; await new Promise((r) => setTimeout(r, 20)); }
    assert.equal(after.status, 200, "released once the upstream answered");
  } finally { local.release(); await a.close(); }
});

test("timeout: a hung upstream → 504 stt_timeout; for local the lock is still held until the fake settles", async () => {
  resetFakes(); seed([P_LOCAL()]);
  const a = await mkApp({ timeoutMs: () => 200 });
  try {
    const tag = (await probe(a)).body.profileTag;
    local.mode = "hang";
    const r = await post(a, { tag });
    assert.equal(r.status, 504);
    assert.equal(r.body.error, "stt_timeout");
    assert.equal(local.aborted, 0);
    const busy = await post(a, { tag });
    assert.equal(busy.status, 409, "the whisper job is still running: the lock must not be free");
    local.mode = "ok";
    local.release();
    let ok;
    for (let i = 0; i < 20; i++) { ok = await post(a, { tag }); if (ok.status !== 409) break; await new Promise((r) => setTimeout(r, 20)); }
    assert.equal(ok.status, 200);
  } finally { local.release(); await a.close(); }
});

test("timeout: the hard ceiling frees a local lock even if the upstream never answers", async () => {
  resetFakes(); seed([P_LOCAL()]);
  const a = await mkApp({ timeoutMs: () => 100, ceilingMs: 300 });
  try {
    const tag = (await probe(a)).body.profileTag;
    local.mode = "hang";
    assert.equal((await post(a, { tag })).status, 504);
    await until(() => local.aborted === 1, "the ceiling to abort the upstream", 3000);
    local.mode = "ok"; local.parked = [];
    assert.equal((await post(a, { tag })).status, 200);
  } finally { local.release(); await a.close(); }
});

test("timeout, cloud: T aborts the cloud request too", async () => {
  resetFakes(); seed([P_GROQ(true)]);
  const a = await mkApp({ timeoutMs: () => 200 });
  try {
    const tag = (await probe(a)).body.profileTag;
    cloud.mode = "hang";
    const r = await post(a, { tag });
    assert.equal(r.status, 504);
    assert.equal(r.body.error, "stt_timeout");
    await until(() => cloud.aborted === 1, "the cloud request to be aborted");
  } finally { cloud.release(); await a.close(); }
});

test("502 stt_failed with no upstream text when the fake returns 500", async () => {
  resetFakes(); seed([P_LOCAL()]);
  const a = await mkApp();
  try {
    local.mode = "fail";
    const r = await post(a);
    assert.equal(r.status, 502);
    assert.equal(r.body.error, "stt_failed");
    assert.equal(r.text.includes("SECRET"), false);
    assert.equal(r.text.includes("10.9.9.9"), false);
    assert.equal(r.text.includes(String(local.port)), false, "no baseUrl either");
  } finally { await a.close(); }
});

test("a profile id in the query is ignored: the default profile is used", async () => {
  resetFakes(); seed([P_LOCAL(), P_OTHER()]);
  const a = await mkApp();
  try {
    const r = await post(a, { query: "?profile=p-other&profileId=p-other&id=p-other" });
    assert.equal(r.status, 200);
    assert.equal(local.hits.transcribe, 1);
    assert.equal(other.total(), 0);
  } finally { await a.close(); }
});

test("the gateway never logs transcript text or audio: one bytes/elapsed/status/cloud line", async () => {
  resetFakes(); seed([P_LOCAL()]);
  const lines = [];
  const a = await mkApp({ log: (l) => lines.push(String(l)) });
  try {
    local.text = "my very private sentence";
    await post(a);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /bytes=\d+/);
    assert.match(lines[0], /elapsed=\d+/);
    assert.match(lines[0], /status=200/);
    assert.match(lines[0], /cloud=false/);
    assert.equal(lines.join("\n").includes("private sentence"), false);
  } finally { local.text = "hello from the fake"; await a.close(); }
});

// ---------------------------------------------------------------------------
// rails: the REAL dashboardAuth, csrfMiddleware and Funnel middleware
// ---------------------------------------------------------------------------

async function realRailsApp() {
  const { dashboardAuth } = await import("../servers/gateway/dashboard/auth.js");
  const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
  const { rejectFunneledMiddleware } = await import("../servers/gateway/funnel.js");
  const app = express();
  app.use(rejectFunneledMiddleware());                     // layer 1, as index.js
  app.use(express.json());
  app.use((req, res, next) => { res.redirectAfterPost = (url) => res.redirect(303, url); next(); });
  const r = express.Router();
  r.use("/dashboard", dashboardAuth);                      // as dashboard/index.js
  r.use("/dashboard", csrfMiddleware);
  r.use(mod.default(dashboardAuth, { log: () => {} }));
  app.use(r);
  const srv = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
  return { srv, base: "http://127.0.0.1:" + srv.address().port + "/dashboard/perch-api/dictation" };
}

test("rails: no session → refused; session without X-Crow-Csrf → 403; with it → through", async () => {
  resetFakes(); seed([P_LOCAL()]);
  const { mintSsoSession } = await import("../servers/gateway/dashboard/auth.js");
  await (await import("./fixtures/sso-source.mjs")).trustedSsoSource("test");
  const { token } = await mintSsoSession("test");
  const { srv, base } = await realRailsApp();
  const net = { ...serveHeaders("someone@example.com") };
  try {
    const anonGet = await fetch(base, { headers: net, redirect: "manual" });
    assert.equal(anonGet.status, 303, "no session → login");
    const anonPost = await fetch(base, { method: "POST", headers: { ...net, "content-type": "audio/webm" }, body: WEBM, redirect: "manual" });
    assert.equal(anonPost.status, 303);
    const cookie = `crow_session=${token}; crow_csrf=csrf-abc`;
    const probeR = await fetch(base, { headers: { ...net, cookie } });
    assert.equal(probeR.status, 200);
    const tag = (await probeR.json()).profileTag;
    const noCsrf = await fetch(base, { method: "POST", headers: { ...net, cookie, "content-type": "audio/webm", "x-crow-dictation-profile": tag }, body: WEBM });
    assert.equal(noCsrf.status, 403);
    assert.equal(local.hits.transcribe, 0);
    const ok = await fetch(base, { method: "POST", headers: { ...net, cookie, "x-crow-csrf": "csrf-abc", "content-type": "audio/webm", "x-crow-dictation-profile": tag }, body: WEBM });
    assert.equal(ok.status, 200);
  } finally { srv.close(); }
});

test("rails: a Funnel request is refused on both verbs, by layer 1 and by layer 2", async () => {
  resetFakes(); seed([P_LOCAL()]);
  assert.equal(process.env.CROW_DASHBOARD_PUBLIC, undefined);
  const { PUBLIC_FUNNEL_PREFIXES } = await import("../servers/gateway/funnel.js");
  assert.equal(PUBLIC_FUNNEL_PREFIXES.some((p) => p.startsWith("/dashboard")), false);
  const { mintSsoSession, dashboardAuth } = await import("../servers/gateway/dashboard/auth.js");
  await (await import("./fixtures/sso-source.mjs")).trustedSsoSource("test");
  const { token } = await mintSsoSession("test");
  const cookie = `crow_session=${token}; crow_csrf=c1`;
  const funnel = { "tailscale-funnel-request": "?1", "tailscale-user-login": "someone@example.com", cookie, "x-crow-csrf": "c1" };
  // Layer 1 + 2 together.
  const { srv, base } = await realRailsApp();
  try {
    assert.equal((await fetch(base, { headers: funnel })).status, 403);
    assert.equal((await fetch(base, { method: "POST", headers: { ...funnel, "content-type": "audio/webm" }, body: WEBM })).status, 403);
  } finally { srv.close(); }
  // Layer 2 alone: the router's own dashboardAuth (isAllowedNetwork).
  const app = express();
  app.use(mod.default(dashboardAuth, { log: () => {} }));
  const s2 = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
  const b2 = "http://127.0.0.1:" + s2.address().port + "/dashboard/perch-api/dictation";
  try {
    assert.equal((await fetch(b2, { headers: funnel })).status, 403);
    assert.equal((await fetch(b2, { method: "POST", headers: { ...funnel, "content-type": "audio/webm" }, body: WEBM })).status, 403);
  } finally { s2.close(); }
  assert.equal(local.hits.transcribe, 0);
});

test("dashboard/index.js mounts the dictation router after csrfMiddleware, not at app root", () => {
  const src = readFileSync(join(REPO, "servers/gateway/dashboard/index.js"), "utf8");
  const csrf = src.indexOf('router.use("/dashboard", csrfMiddleware)');
  const mount = src.indexOf("perchDictationRouter(dashboardAuth)");
  const interactive = src.indexOf("perchInteractiveApiRouter(dashboardAuth)");
  assert.ok(csrf > 0 && mount > 0);
  assert.ok(mount > csrf, "after the CSRF rail");
  assert.ok(mount > interactive, "right after the interactive API mount");
  const boot = readFileSync(join(REPO, "servers/gateway/boot/feature-mounts.js"), "utf8");
  assert.equal(boot.includes("perch-dictation"), false);
});

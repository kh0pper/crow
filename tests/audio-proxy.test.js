import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import audioProxyRouter, { validateAudioParams } from "../servers/gateway/routes/audio-proxy.js";

// Spin up a throwaway express app with the audio-proxy router mounted, plus a
// header-driven req.instanceAuth shim (mirrors instanceAuthMiddleware). All deps
// injected → fully offline, no prod services booted.
async function withApp({ exposed = new Set(["funkwhale"]), fw = { url: "http://fw", token: "T" }, fetchImpl } = {}, run) {
  const app = express();
  app.use((req, _res, next) => { if (req.headers["x-peer"]) req.instanceAuth = { instance: { id: req.headers["x-peer"] } }; next(); });
  app.use(audioProxyRouter({
    createDbClient: () => ({ close() {} }),
    getExposed: async () => exposed,
    fwEnv: () => fw,
    fetchImpl: fetchImpl || (async () => ({ ok: true, status: 200, body: null, headers: new Map() })),
  }));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;
  const get = (qs, headers = {}) => fetch(`http://localhost:${port}/audio/stream${qs}`, { headers });
  try { return await run({ port, get }); } finally { server.close(); }
}

const OK_QS = "?cap=funkwhale&id=abc12345-dead-beef-cafe-0123456789ab&codec=opus";

test("GET /audio/stream: 401 without peer auth", async () => {
  await withApp({}, async ({ get }) => {
    assert.equal((await get(OK_QS)).status, 401);
  });
});

test("GET /audio/stream: 400 on bad params (with peer auth)", async () => {
  await withApp({}, async ({ get }) => {
    assert.equal((await get("?cap=evil&id=abc12345&codec=opus", { "x-peer": "p1" })).status, 400);
    assert.equal((await get("?cap=funkwhale&id=abc12345&codec=wav", { "x-peer": "p1" })).status, 400);
  });
});

test("GET /audio/stream: 403 when funkwhale not exposed", async () => {
  await withApp({ exposed: new Set() }, async ({ get }) => {
    assert.equal((await get(OK_QS, { "x-peer": "p1" })).status, 403);
  });
});

test("GET /audio/stream: 503 when funkwhale not configured", async () => {
  await withApp({ fw: null }, async ({ get }) => {
    assert.equal((await get(OK_QS, { "x-peer": "p1" })).status, 503);
  });
});

test("GET /audio/stream: 200 streams upstream bytes; fetches the reconstructed listen URL with the local token", async () => {
  let fetchedUrl = null, fetchedAuth = null;
  const bytes = Buffer.from("AUDIODATA");
  const fetchImpl = async (url, opts) => {
    fetchedUrl = url; fetchedAuth = opts?.headers?.Authorization;
    return {
      ok: true, status: 200,
      headers: new Map([["content-type", "audio/ogg"], ["content-length", String(bytes.length)]]),
      body: { getReader() { let done = false; return { read: async () => done ? { done: true } : (done = true, { value: bytes, done: false }), cancel() {} }; } },
    };
  };
  await withApp({ fetchImpl }, async ({ get }) => {
    const resp = await get(OK_QS, { "x-peer": "p1" });
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get("content-type"), "audio/ogg");
    assert.equal(await resp.text(), "AUDIODATA");
    assert.equal(fetchedUrl, "http://fw/api/v1/listen/abc12345-dead-beef-cafe-0123456789ab/?to=opus");
    assert.equal(fetchedAuth, "Bearer T"); // local funkwhale token, never the peer's
  });
});

test("validateAudioParams accepts a funkwhale listen request", () => {
  const v = validateAudioParams({ cap: "funkwhale", id: "abc12345-dead-beef-cafe-0123456789ab", codec: "opus" });
  assert.equal(v.ok, true);
  assert.equal(v.id, "abc12345-dead-beef-cafe-0123456789ab");
  assert.equal(v.codec, "opus");
});

test("validateAudioParams rejects bad cap / id / codec", () => {
  assert.equal(validateAudioParams({ cap: "evil", id: "abc12345", codec: "opus" }).ok, false);
  assert.equal(validateAudioParams({ cap: "funkwhale", id: "../etc/passwd", codec: "opus" }).ok, false);
  assert.equal(validateAudioParams({ cap: "funkwhale", id: "abc12345", codec: "wav" }).ok, false);
  assert.equal(validateAudioParams({ cap: "funkwhale", id: "", codec: "opus" }).ok, false);
});

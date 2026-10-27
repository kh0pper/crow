/**
 * The preview renderer's CDP client over a pipe (servers/gateway/preview/cdp-pipe.js):
 * NUL-terminated JSON frames both ways (Chromium's --remote-debugging-pipe framing). A
 * frame that isn't JSON, or one past maxFrameBytes, closes the client with bad_frame.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createPipeCdp } from "../servers/gateway/preview/cdp-pipe.js";

/** A client wired to two PassThroughs, plus a reader of what it wrote. */
function pair(opts = {}) {
  const input = new PassThrough();   // client → "browser"
  const output = new PassThrough();  // "browser" → client
  const cdp = createPipeCdp({ input, output, ...opts });
  let buf = Buffer.alloc(0);
  const frames = [];
  const waiters = [];
  input.on("data", (c) => {
    buf = Buffer.concat([buf, c]);
    for (let i; (i = buf.indexOf(0)) !== -1;) {
      frames.push(buf.subarray(0, i).toString("utf8"));
      buf = buf.subarray(i + 1);
      while (waiters.length && waiters[0].n <= frames.length) waiters.shift().resolve();
    }
  });
  const written = (n) => (frames.length >= n ? Promise.resolve() : new Promise((resolve) => waiters.push({ n, resolve })));
  return { cdp, input, output, frames, written };
}

test("frames are NUL-delimited JSON both ways", async () => {
  const { cdp, output, frames, written } = pair();
  const a = cdp.send("Browser.getVersion");
  const b = cdp.send("Target.getTargets", { x: 1 });
  await written(2);
  const [fa, fb] = frames.map((f) => JSON.parse(f));
  assert.equal(fa.method, "Browser.getVersion");
  assert.deepEqual(fa.params, {});
  assert.deepEqual(fb.params, { x: 1 });
  // Two answers in one chunk.
  output.write(JSON.stringify({ id: fa.id, result: { product: "A" } }) + "\0" + JSON.stringify({ id: fb.id, result: { n: 2 } }) + "\0");
  assert.deepEqual(await a, { product: "A" });
  assert.deepEqual(await b, { n: 2 });

  // One answer split across three chunks.
  const c = cdp.send("Page.navigate", { url: "about:blank" }, "S1");
  await written(3);
  const fc = JSON.parse(frames[2]);
  assert.equal(fc.sessionId, "S1");
  const text = JSON.stringify({ id: fc.id, result: { frameId: "F" } }) + "\0";
  output.write(text.slice(0, 5));
  output.write(text.slice(5, 12));
  output.write(text.slice(12));
  assert.deepEqual(await c, { frameId: "F" });

  // Events reach on() listeners; off() removes them.
  const seen = [];
  const fn = (params) => seen.push(params);
  cdp.on("Fetch.requestPaused", fn);
  output.write(JSON.stringify({ method: "Fetch.requestPaused", params: { requestId: "r1" } }) + "\0");
  await new Promise((r) => setImmediate(r));
  cdp.off("Fetch.requestPaused", fn);
  output.write(JSON.stringify({ method: "Fetch.requestPaused", params: { requestId: "r2" } }) + "\0");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, [{ requestId: "r1" }]);

  // A CDP error rejects that send only.
  const d = cdp.send("Nope.nope");
  await written(4);
  output.write(JSON.stringify({ id: JSON.parse(frames[3]).id, error: { code: -32601, message: "not found" } }) + "\0");
  await assert.rejects(d, /not found/);
  cdp.close();
  assert.deepEqual(await cdp.closed, { reason: "closed" });
});

test("a non-JSON frame closes with bad_frame", async () => {
  const { cdp, output, written } = pair();
  const pending = cdp.send("Browser.getVersion");
  await written(1);
  output.write("hello\0");
  assert.deepEqual(await cdp.closed, { reason: "bad_frame" });
  await assert.rejects(pending, /bad_frame/);
  await assert.rejects(cdp.send("Browser.getVersion"), /closed/);
});

test("an oversize frame closes with bad_frame", async () => {
  const { cdp, output } = pair();
  const pending = cdp.send("Browser.getVersion");
  const big = Buffer.alloc(16 * 1024 * 1024 + 1, 0x7b); // "{{{…", never terminated
  output.write(big.subarray(0, 1024 * 1024));
  output.write(big.subarray(1024 * 1024));
  assert.deepEqual(await cdp.closed, { reason: "bad_frame" });
  await assert.rejects(pending, /bad_frame/);
});

test("stdout that does not start a JSON object is bad_frame at once", async () => {
  // A compose CLI that prints progress on stdout ("Creating…") must fail fast, not wait
  // for a NUL that never comes.
  const { cdp, output } = pair();
  output.write("Creating…\n");
  assert.deepEqual(await cdp.closed, { reason: "bad_frame" });
});

test("EOF closes with eof", async () => {
  const { cdp, output } = pair();
  const pending = cdp.send("Browser.getVersion");
  output.end();
  assert.deepEqual(await cdp.closed, { reason: "eof" });
  await assert.rejects(pending, /eof/);
});

test("an 8 MB body fits", async () => {
  const { cdp, output, frames, written } = pair();
  const body = Buffer.alloc(8 * 1024 * 1024, 0x61).toString("base64"); // ~10.7 MB
  assert.ok(body.length > 11 * 1000 * 1000);
  const p = cdp.send("Fetch.fulfillRequest", { requestId: "r", responseCode: 200, body });
  await written(1);
  const f = JSON.parse(frames[0]);
  assert.equal(f.method, "Fetch.fulfillRequest");
  assert.equal(f.params.body.length, body.length);
  assert.equal(f.params.body, body);
  output.write(JSON.stringify({ id: f.id, result: {} }) + "\0");
  assert.deepEqual(await p, {});
});

/**
 * Tests for W4-4 commit 3: SSE connection cap.
 *
 * Verifies:
 *   1. openStream returns a valid stream object when under cap.
 *   2. When the cap is exactly reached, the next call gets 503 + null.
 *   3. After closing one stream, the next openStream succeeds again.
 *   4. The counter decrements correctly on close (idempotent close guard).
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openStream, _resetStreamCount, _getStreamCount } from "../servers/gateway/streams/sse.js";

// Stub res object that records writeHead calls and end invocations.
function stubRes() {
  let status = null;
  let headers = null;
  let ended = false;
  let writes = [];
  return {
    get writableEnded() { return ended; },
    get headersSent() { return status !== null; },
    get _status() { return status; },
    get _headers() { return headers; },
    get _writes() { return writes; },
    writeHead(s, h) { status = s; headers = h || {}; },
    flushHeaders() {},
    write(data) { writes.push(data); },
    end() { ended = true; },
    on() {},
  };
}

after(() => {
  _resetStreamCount();
});

test("sse-cap: openStream returns stream object when under cap", () => {
  _resetStreamCount();
  const res = stubRes();
  const stream = openStream(res, { heartbeatMs: 1e9 });
  assert.ok(stream, "stream should not be null under cap");
  assert.equal(typeof stream.send, "function");
  assert.equal(typeof stream.close, "function");
  stream.close();
  _resetStreamCount();
});

test("sse-cap: over-cap returns null + sends 503 Retry-After:5", () => {
  _resetStreamCount();

  // Fill to CROW_SSE_MAX (default 200) with mock streams. We override the env
  // default for this test to a small number so we don't have to hold 200 stubs.
  // Instead we directly manipulate _openStreamCount via _resetStreamCount and
  // then set it to just below max by opening real streams.
  //
  // Approach: use CROW_SSE_MAX=3 for this test module. Unfortunately the env
  // variable is read at module load time. The module sets SSE_MAX = parseInt(
  // CROW_SSE_MAX || '200'). We can't change it post-import. So we fill 200
  // real stubs — that's the designed test path. We use minimal stubs with no
  // real timers (heartbeatMs = infinity).

  // Reset and fill to SSE_MAX - 1.
  _resetStreamCount();
  const MAX = parseInt(process.env.CROW_SSE_MAX || "200", 10);

  const openStreams = [];
  for (let i = 0; i < MAX; i++) {
    const r = stubRes();
    const s = openStream(r, { heartbeatMs: 1e9 });
    assert.ok(s, `stream ${i + 1} should open (under cap)`);
    openStreams.push({ res: r, stream: s });
  }

  assert.equal(_getStreamCount(), MAX, "count should equal MAX after filling");

  // Now one more — should get 503 + null.
  const overRes = stubRes();
  const overStream = openStream(overRes, { heartbeatMs: 1e9 });
  assert.equal(overStream, null, "over-cap must return null");
  assert.equal(overRes._status, 503, "over-cap response status must be 503");
  assert.ok(
    overRes._headers?.["Retry-After"] === "5",
    `Retry-After header must be "5", got: ${JSON.stringify(overRes._headers)}`,
  );
  assert.equal(overRes.writableEnded, true, "over-cap response must be ended");

  // Count must NOT have incremented for the rejected stream.
  assert.equal(_getStreamCount(), MAX, "count must remain at MAX after rejection");

  // Close one stream — count decrements.
  openStreams[0].stream.close();
  assert.equal(_getStreamCount(), MAX - 1, "count decrements when stream closes");

  // Now a new stream should succeed.
  const recoveryRes = stubRes();
  const recoveryStream = openStream(recoveryRes, { heartbeatMs: 1e9 });
  assert.ok(recoveryStream, "stream after release must succeed");
  recoveryStream.close();

  // Clean up all remaining streams.
  for (let i = 1; i < openStreams.length; i++) {
    openStreams[i].stream.close();
  }
  assert.equal(_getStreamCount(), 0, "count returns to 0 after all closes");
  _resetStreamCount();
});

test("sse-cap: idempotent close does not double-decrement counter", () => {
  _resetStreamCount();
  const res = stubRes();
  const stream = openStream(res, { heartbeatMs: 1e9 });
  assert.ok(stream);
  assert.equal(_getStreamCount(), 1);

  stream.close();
  assert.equal(_getStreamCount(), 0, "first close decrements");

  stream.close(); // second call — idempotent guard must fire
  assert.equal(_getStreamCount(), 0, "second close must not double-decrement");
  _resetStreamCount();
});

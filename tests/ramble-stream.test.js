/**
 * ramble-stream — Task 13 (Live nearby stream).
 *
 * servers/gateway/boot/ramble-transport.js emits `bus.emit("ramble:nearby",
 * { geohash, mark_id, kind })` whenever a NEW remote mark/caw lands from the
 * relays. This test proves the /dashboard/streams/ramble-nearby route wires
 * that event to an SSE frame: one `event: ramble-nearby` frame per emit,
 * `data:` JSON restricted to exactly {geohash, mark_id, kind} (never
 * arbitrary extra payload fields), missing fields coerced to null (never a
 * throw), unsubscribe-on-close (bus.listenerCount back to its prior value,
 * and a post-close emit writes nothing), and subscriber isolation (a
 * throwing `res.write` must not propagate out of bus.emit).
 *
 * Harness mirrors tests/messages-stream-events.test.js: the bus handler is
 * registered PER REQUEST inside the route handler (not at module load), so
 * the route handler must be invoked with a fake authed req/res exactly like
 * that file does — a bare spy on bus.on at module scope would see nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import bus from "../servers/shared/event-bus.js";
import streamsRouter from "../servers/gateway/routes/streams.js";

// --- fake res: full openStream/openAuthedStream surface (mirrors
// tests/messages-stream-events.test.js's fakeRes exactly) ---
function fakeRes() {
  let headersSent = false;
  let ended = false;
  const chunks = [];
  const listeners = { close: [], error: [] };
  let writeImpl = (data) => { chunks.push(data); return true; };
  const res = {
    get headersSent() { return headersSent; },
    get writableEnded() { return ended; },
    writeHead() { headersSent = true; },
    flushHeaders() {},
    write(data) { return writeImpl(data); },
    end() { ended = true; },
    on(event, listener) {
      if (listeners[event]) listeners[event].push(listener);
    },
  };
  return {
    res,
    chunks,
    fireClose() { for (const l of listeners.close) l(); },
    fireError() { for (const l of listeners.error) l(); },
    throwOnNextWrite() {
      const prev = writeImpl;
      writeImpl = () => { writeImpl = prev; throw new Error("boom"); };
    },
  };
}

function getRambleNearbyHandler() {
  // dashboardAuth is only wired via router.use(); we call the route handler
  // directly (bypassing the Express dispatch stack), so a no-op stub is fine.
  const router = streamsRouter((req, res, next) => next());
  const layer = router.stack.find((l) => l.route && l.route.path === "/dashboard/streams/ramble-nearby");
  assert.ok(layer, "route /dashboard/streams/ramble-nearby must be registered");
  return layer.route.stack[0].handle;
}

test("ramble-nearby stream emits one SSE frame per ramble:nearby with only the allowed keys", () => {
  const handler = getRambleNearbyHandler();
  const { res, chunks, fireClose } = fakeRes();
  const req = { dashboardSession: "tok-1" };
  handler(req, res);

  try {
    const before = chunks.length;
    bus.emit("ramble:nearby", { geohash: "9v6", mark_id: "m1", kind: "mark", extra: "nope" });

    const emitted = chunks.slice(before).join("");
    const frames = emitted.split("\n\n").filter((f) => f.includes("event: ramble-nearby"));
    assert.equal(frames.length, 1, "expected exactly one ramble-nearby frame");

    const match = emitted.match(/event: ramble-nearby\ndata: (.+)\n\n/);
    assert.ok(match, "frame must carry a data: JSON payload");
    const payload = JSON.parse(match[1]);
    assert.deepEqual(Object.keys(payload).sort(), ["geohash", "kind", "mark_id"]);
    assert.equal(payload.geohash, "9v6");
    assert.equal(payload.mark_id, "m1");
    assert.equal(payload.kind, "mark");
    assert.ok(!("extra" in payload), "must not echo arbitrary payload fields");
  } finally {
    fireClose();
  }
});

test("ramble-nearby stream coerces missing fields to null instead of throwing", () => {
  const handler = getRambleNearbyHandler();
  const { res, chunks, fireClose } = fakeRes();
  const req = { dashboardSession: "tok-2" };
  handler(req, res);

  try {
    const before = chunks.length;
    assert.doesNotThrow(() => bus.emit("ramble:nearby", {}));

    const emitted = chunks.slice(before).join("");
    const match = emitted.match(/event: ramble-nearby\ndata: (.+)\n\n/);
    assert.ok(match, "frame must still be sent for a sparse payload");
    const payload = JSON.parse(match[1]);
    assert.deepEqual(payload, { geohash: null, mark_id: null, kind: null });
  } finally {
    fireClose();
  }
});

test("ramble-nearby stream unsubscribes on close: listener count restored, no further writes", () => {
  const priorCount = bus.listenerCount("ramble:nearby");

  const handler = getRambleNearbyHandler();
  const { res, chunks, fireClose } = fakeRes();
  const req = { dashboardSession: "tok-3" };
  handler(req, res);

  assert.equal(bus.listenerCount("ramble:nearby"), priorCount + 1);

  fireClose();
  assert.equal(bus.listenerCount("ramble:nearby"), priorCount);

  const before = chunks.length;
  bus.emit("ramble:nearby", { geohash: "9v6", mark_id: "m1", kind: "mark" });
  assert.equal(chunks.length, before, "no frame should be written after close");
});

test("ramble-nearby stream unsubscribes on error too", () => {
  const priorCount = bus.listenerCount("ramble:nearby");

  const handler = getRambleNearbyHandler();
  const { res, fireError } = fakeRes();
  const req = { dashboardSession: "tok-4" };
  handler(req, res);

  assert.equal(bus.listenerCount("ramble:nearby"), priorCount + 1);

  fireError();
  assert.equal(bus.listenerCount("ramble:nearby"), priorCount);
});

test("ramble-nearby stream: a throwing write does not propagate (subscriber isolation)", () => {
  const handler = getRambleNearbyHandler();
  const { res, fireClose, throwOnNextWrite } = fakeRes();
  const req = { dashboardSession: "tok-5" };
  handler(req, res);

  try {
    throwOnNextWrite();
    assert.doesNotThrow(() => bus.emit("ramble:nearby", { geohash: "9v6", mark_id: "m1", kind: "mark" }));
  } finally {
    fireClose();
  }
});

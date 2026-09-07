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
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import bus from "../servers/shared/event-bus.js";
import streamsRouter from "../servers/gateway/routes/streams.js";

const __repo = join(dirname(fileURLToPath(import.meta.url)), "..");

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

// Cross-seam guard. The route sends a NAMED frame ("event: ramble-nearby"),
// and EventSource.onmessage fires ONLY for unnamed ("message") frames — so a
// client wired with `stream.onmessage` never sees a single update while every
// server-side test above passes. That defect shipped through 14 task reviews
// precisely because no test looked at both sides at once. This one does: it
// reads the client as text and pins it to the frame name the server emits.
test("the panel client listens for the SERVER'S named frame, not onmessage", () => {
  const client = readFileSync(join(__repo, "bundles/ramble/panel/static/ramble.js"), "utf8");
  assert.ok(
    client.includes('addEventListener("ramble-nearby"'),
    "client must subscribe to the named ramble-nearby event"
  );
  assert.ok(
    !client.includes("stream.onmessage"),
    "onmessage never fires for a named SSE frame — the live map would silently never refresh"
  );
});

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

// --------------------------------------------------------- hatched (Task 10)
//
// The SAME route also carries `ramble:hatched`, emitted by the panel routes'
// `onHatch` hook whenever a warmth credit tips the incubating egg over
// `hatch_at`. The panel needs to know a bird arrived without polling, and the
// payload is allow-listed to exactly {egg_id, species, seed} — the full egg
// row (status, warmth, timestamps) never reaches the client.

test("ramble-hatched frame carries exactly egg_id, species and seed", () => {
  const handler = getRambleNearbyHandler();
  const { res, chunks, fireClose } = fakeRes();
  handler({ dashboardSession: "tok-h1" }, res);

  try {
    const before = chunks.length;
    bus.emit("ramble:hatched", { egg_id: "e1", species: "grackle", seed: 42, warmth: 100, status: "hatched" });

    const emitted = chunks.slice(before).join("");
    const frames = emitted.split("\n\n").filter((f) => f.includes("event: ramble-hatched"));
    assert.equal(frames.length, 1, "expected exactly one ramble-hatched frame");

    const match = emitted.match(/event: ramble-hatched\ndata: (.+)\n\n/);
    assert.ok(match, "frame must carry a data: JSON payload");
    const payload = JSON.parse(match[1]);
    assert.deepEqual(Object.keys(payload).sort(), ["egg_id", "seed", "species"]);
    assert.equal(payload.egg_id, "e1");
    assert.equal(payload.species, "grackle");
    assert.equal(payload.seed, 42);
    assert.ok(!("warmth" in payload), "must not echo arbitrary egg-row fields");
    assert.ok(!("status" in payload), "must not echo arbitrary egg-row fields");
  } finally {
    fireClose();
  }
});

test("ramble-hatched coerces missing fields to null instead of throwing", () => {
  const handler = getRambleNearbyHandler();
  const { res, chunks, fireClose } = fakeRes();
  handler({ dashboardSession: "tok-h2" }, res);

  try {
    const before = chunks.length;
    assert.doesNotThrow(() => bus.emit("ramble:hatched", {}));

    const emitted = chunks.slice(before).join("");
    const match = emitted.match(/event: ramble-hatched\ndata: (.+)\n\n/);
    assert.ok(match, "frame must still be sent for a sparse payload");
    assert.deepEqual(JSON.parse(match[1]), { egg_id: null, species: null, seed: null });
  } finally {
    fireClose();
  }
});

test("closing the stream unsubscribes BOTH the nearby and the hatched listener", () => {
  const priorNearby = bus.listenerCount("ramble:nearby");
  const priorHatched = bus.listenerCount("ramble:hatched");
  const priorClaimed = bus.listenerCount("ramble:nest-claimed");

  const handler = getRambleNearbyHandler();
  const { res, chunks, fireClose } = fakeRes();
  handler({ dashboardSession: "tok-h3" }, res);

  assert.equal(bus.listenerCount("ramble:nearby"), priorNearby + 1);
  assert.equal(bus.listenerCount("ramble:hatched"), priorHatched + 1);
  assert.equal(bus.listenerCount("ramble:nest-claimed"), priorClaimed + 1);

  fireClose();
  assert.equal(bus.listenerCount("ramble:nearby"), priorNearby);
  assert.equal(bus.listenerCount("ramble:hatched"), priorHatched, "a leaked hatched listener writes to a dead response");
  assert.equal(bus.listenerCount("ramble:nest-claimed"), priorClaimed);

  const before = chunks.length;
  bus.emit("ramble:hatched", { egg_id: "e2", species: "crow", seed: 1 });
  assert.equal(chunks.length, before, "no frame should be written after close");
});

test("erroring the stream unsubscribes the hatched listener too", () => {
  const priorHatched = bus.listenerCount("ramble:hatched");

  const handler = getRambleNearbyHandler();
  const { res, fireError } = fakeRes();
  handler({ dashboardSession: "tok-h4" }, res);

  assert.equal(bus.listenerCount("ramble:hatched"), priorHatched + 1);
  fireError();
  assert.equal(bus.listenerCount("ramble:hatched"), priorHatched);
});

// --------------------------------------------------- nest claimed (phase 2)

test("ramble-nest-claimed frame carries exactly egg_id and cell", () => {
  const handler = getRambleNearbyHandler();
  const { res, chunks, fireClose } = fakeRes();
  handler({ dashboardSession: "tok-n1" }, res);
  try {
    const before = chunks.length;
    bus.emit("ramble:nest-claimed", { egg_id: "e9", cell: "9v6m21h", warmth: 0, found_week: "2026-W37" });
    const emitted = chunks.slice(before).join("");
    const match = emitted.match(/event: ramble-nest-claimed\ndata: (.+)\n\n/);
    assert.ok(match, "frame must carry a data: JSON payload");
    assert.deepEqual(JSON.parse(match[1]), { egg_id: "e9", cell: "9v6m21h" });
    assert.doesNotThrow(() => bus.emit("ramble:nest-claimed", {}));
    const sparse = chunks.slice(before).join("").match(/event: ramble-nest-claimed\ndata: (.+)\n\n/g);
    assert.equal(sparse.length, 2);
  } finally {
    fireClose();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTicketStore, TICKET_ID, MAX_PER_DEVICE, MAX_CONCURRENT } from "../bundles/kiosk/server/tickets.js";

function store(over = {}) {
  const c = { t: 1000 }, timers = [];
  const s = createTicketStore({ now: () => c.t, setTimer: (fn, ms) => { const t = { fn, ms, on: true }; timers.push(t); return t; }, clearTimer: (t) => { if (t) t.on = false; }, ...over });
  return { c, s, timers };
}
const mint = (s, deviceId = "kiosk-a", ttlMs = 60_000) => s.mint({ deviceId, kind: "stream", resource: { url: "https://stream.example.invalid/live.mp3" }, ttlMs });

test("a ticket is 128 random bits in a path; it resolves to its one device and resource, and nothing else does", () => {
  const { s } = store();
  const a = mint(s), b = mint(s);
  assert.match(a.id, TICKET_ID);
  assert.equal(a.id.length, 22);
  assert.notEqual(a.id, b.id);
  assert.equal(a.path, `/display/t/${a.id}/stream`);
  const t = s.get(a.id);
  assert.deepEqual([t.deviceId, t.kind, t.resource.url], ["kiosk-a", "stream", "https://stream.example.invalid/live.mp3"]);
  for (const bad of ["", "x", a.id.slice(0, 21), a.id + "A", a.id.replace(/.$/, "!"), "../../etc/passwd", null, 42, "A".repeat(5000), ["a"], { id: a.id }]) assert.equal(s.get(bad), null, String(bad).slice(0, 20));
});

test("the store keeps only a hash: the id is nowhere in its state", () => {
  const { s } = store();
  const a = mint(s);
  assert.ok(!JSON.stringify(s.debugState()).includes(a.id));
});

test("lifetime: gone at its expiry, on revoke, and for the whole device on revokeDevice; each of them cuts the requests still open on it", () => {
  const { s, c } = store();
  const a = mint(s, "kiosk-a", 1000), b = mint(s), other = mint(s, "kiosk-b");
  const tb = s.get(b.id);
  let aborted = false;
  tb.abort.signal.addEventListener("abort", () => { aborted = true; });
  c.t += 1000;
  assert.equal(s.get(a.id), null, "expired");
  s.revoke(b.id);
  assert.equal(s.get(b.id), null);
  assert.equal(aborted, true);
  const to = s.get(other.id);
  s.revokeDevice("kiosk-b");
  assert.deepEqual([s.get(other.id), to.abort.signal.aborted, s.size()], [null, true, 0]);
  s.revoke(b.id);                       // twice is harmless
});

test("the lifetime is a timer: at expiry an open request is cut even if nobody asks for the ticket again; a revoked ticket's timer is cleared", () => {
  const { s, timers } = store();
  const a = mint(s, "kiosk-a", 12 * 3600 * 1000);
  const t = s.get(a.id);
  assert.equal(s.enter(t), true);
  assert.deepEqual([timers.length, timers[0].ms, t.abort.signal.aborted], [1, 12 * 3600 * 1000, false]);
  timers[0].fn();                       // the clock in `now` has not moved: only the timer fired
  assert.deepEqual([t.abort.signal.aborted, s.size()], [true, 0], "the open request is aborted at expiry");
  const b = mint(s);
  s.revoke(b.id);
  assert.equal(timers[1].on, false);
  // With real timers the store does not hold the process open.
  const real = createTicketStore();
  real.mint({ deviceId: "d", kind: "stream", resource: {}, ttlMs: 3_600_000 });
});

test("limits: at most 8 live tickets per device (the oldest goes), at most two requests at once per ticket", () => {
  const { s } = store();
  const ids = Array.from({ length: MAX_PER_DEVICE + 2 }, () => mint(s).id);
  assert.equal(s.get(ids[0]), null);
  assert.equal(s.get(ids[1]), null);
  assert.ok(s.get(ids[2]));
  assert.ok(mint(s, "kiosk-b").id, "another device has its own eight");
  assert.ok(s.get(ids[2]));
  const t = s.get(ids.at(-1));
  assert.equal(MAX_CONCURRENT, 2);
  for (let i = 0; i < MAX_CONCURRENT; i++) assert.equal(s.enter(t), true);
  assert.equal(s.enter(t), false);
  s.leave(t);
  assert.equal(s.enter(t), true);
});

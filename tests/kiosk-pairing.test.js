import { test } from "node:test";
import assert from "node:assert/strict";
import * as P from "../bundles/kiosk/server/pairing.js";

function mk() {
  let t = 1_000_000;
  let n = 0;
  const codes = [123456, 654321, 111111, 222222, 333333, 444444, 555555];
  const s = P.createPairingStore({ now: () => t, randomInt: () => codes[n++ % codes.length] });
  return { s, adv: (ms) => { t += ms; } };
}
const start = (s, ip = "100.64.0.9") => s.start({ ip, ua: "Mozilla/5.0 Phone", login: "kevin@example.com", nameHint: "Phone" });

test("start → 6-digit code, 64-hex poll secret; the listing never shows the code or the secret", () => {
  const { s } = mk();
  const r = start(s);
  assert.match(r.code, /^\d{6}$/);
  assert.match(r.poll_secret, /^[0-9a-f]{64}$/);
  assert.match(r.pair_id, /^[0-9a-f]{32}$/);
  const l = s.listPending();
  assert.equal(l.length, 1);
  assert.equal(l[0].ip, "100.64.0.9"); assert.equal(l[0].login, "kevin@example.com");
  assert.ok(!JSON.stringify(l).includes(r.code)); assert.ok(!JSON.stringify(l).includes(r.poll_secret));
});

test("status needs the poll secret; approved token is delivered exactly once", () => {
  const { s } = mk();
  const r = start(s);
  assert.equal(s.status(r.pair_id, "nope").status, 403);
  assert.deepEqual(s.status(r.pair_id, r.poll_secret), { status: 200, body: { state: "pending" } });
  const c = s.claim(r.code);
  assert.equal(c.pending.pair_id, r.pair_id);
  assert.equal(s.complete(r.pair_id, { device_id: "kiosk-1", token: "t".repeat(64) }), true);
  assert.deepEqual(s.status(r.pair_id, r.poll_secret), { status: 200, body: { state: "approved", device_id: "kiosk-1", token: "t".repeat(64) } });
  assert.equal(s.status(r.pair_id, r.poll_secret).status, 404, "second pickup is gone");
});

test("a claimed code cannot be claimed twice; release puts it back", () => {
  const { s } = mk();
  const r = start(s);
  assert.ok(s.claim(r.code).pending);
  assert.equal(s.claim(r.code).error, "bad_code");
  s.release(r.pair_id);
  assert.ok(s.claim(r.code).pending);
});

test("5 wrong codes in 10 min lock approval for 10 min (even the right code), then unlock", () => {
  const { s, adv } = mk();
  const r = start(s);
  for (let i = 0; i < 5; i++) assert.equal(s.claim("000000").error, "bad_code");
  const locked = s.claim(r.code);
  assert.equal(locked.error, "locked"); assert.equal(locked.status, 429); assert.ok(locked.retry_after_s > 0);
  adv(10 * 60 * 1000);
  assert.equal(s.claim(r.code).error, "bad_code", "the code itself expired meanwhile");
});

test("wrong codes outside the 10-min window do not accumulate; malformed codes count", () => {
  const { s, adv } = mk();
  start(s);
  for (let i = 0; i < 4; i++) s.claim("12345x");
  adv(10 * 60 * 1000 + 1);
  start(s);
  assert.equal(s.claim("999999").error, "bad_code");
  assert.notEqual(s.claim("999998").error, "locked");
});

test("expiry: 10 min unapproved → gone; an approved entry gets 2 min for pickup", () => {
  const { s, adv } = mk();
  const r = start(s);
  adv(P.PAIR_TTL_MS);
  assert.equal(s.status(r.pair_id, r.poll_secret).status, 404);
  const r2 = start(s);
  adv(P.PAIR_TTL_MS - 1000);
  s.claim(r2.code); s.complete(r2.pair_id, { device_id: "k", token: "x" });
  adv(60 * 1000);
  assert.equal(s.status(r2.pair_id, r2.poll_secret).body.state, "approved");
});

test("pending cap 3, then rate limit 5 starts/min (keyed on the Tailscale login)", () => {
  const { s, adv } = mk();
  for (let i = 0; i < 3; i++) assert.ok(start(s).code);
  assert.deepEqual(start(s), { error: "too_many_pending", status: 429 });
  assert.equal(start(s).error, "too_many_pending");
  assert.deepEqual(start(s), { error: "rate_limited", status: 429 }, "6th start this minute for this login");
  adv(P.PAIR_TTL_MS);
  assert.ok(start(s, "100.64.0.10").code, "after the pending ones expired and the window passed");
});

test("rate limit keys on the Tailscale login first: same login from a different IP is still limited", () => {
  const { s } = mk();
  for (let i = 0; i < 5; i++) s.start({ ip: "100.64.0.1", ua: "x", login: "kevin@example.com" });
  assert.deepEqual(s.start({ ip: "100.64.0.77", ua: "x", login: "kevin@example.com" }), { error: "rate_limited", status: 429 });
});

test("rate limit with no login falls back to per-IP; different IPs are independent", () => {
  const { s } = mk();
  const go = (ip) => s.start({ ip, ua: "x", login: null });
  const free = (r) => { s.claim(r.code); s.complete(r.pair_id, { device_id: "d", token: "t" }); s.status(r.pair_id, r.poll_secret); };
  for (let i = 0; i < 5; i++) free(go("100.64.0.1"));
  assert.deepEqual(go("100.64.0.1"), { error: "rate_limited", status: 429 });
  assert.ok(go("100.64.0.2").code, "a different IP has its own budget");
});

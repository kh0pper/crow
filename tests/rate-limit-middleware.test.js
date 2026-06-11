import { test } from "node:test";
import assert from "node:assert/strict";
import { fixedWindowLimit, tieredRateLimit, pickTier } from "../servers/gateway/middleware/rate-limit.js";

function mkRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

test("fixedWindowLimit.check: allows max requests, blocks max+1", () => {
  let t = 1_000_000;
  const limiter = fixedWindowLimit({ max: 3, windowMs: 60_000, now: () => t, pruneIntervalMs: 0 });
  assert.equal(limiter.check("k"), true);
  assert.equal(limiter.check("k"), true);
  assert.equal(limiter.check("k"), true);
  assert.equal(limiter.check("k"), false); // 4th in window → blocked
});

test("fixedWindowLimit.check: resets only when strictly past the window (legacy semantics)", () => {
  let t = 0;
  const limiter = fixedWindowLimit({ max: 1, windowMs: 60_000, now: () => t, pruneIntervalMs: 0 });
  assert.equal(limiter.check("k"), true);
  assert.equal(limiter.check("k"), false);
  t = 60_000; // (now - windowStart) === windowMs → NOT reset (legacy used strict >)
  assert.equal(limiter.check("k"), false);
  t = 60_001; // strictly past → fresh window
  assert.equal(limiter.check("k"), true);
});

test("fixedWindowLimit.check: keys are independent", () => {
  let t = 5_000;
  const limiter = fixedWindowLimit({ max: 1, windowMs: 60_000, now: () => t, pruneIntervalMs: 0 });
  assert.equal(limiter.check("a"), true);
  assert.equal(limiter.check("a"), false);
  assert.equal(limiter.check("b"), true); // different key unaffected
});

test("fixedWindowLimit middleware: 429 with the configured body when over limit", () => {
  let t = 0;
  const message = { error: "Rate limited — max 10 messages per minute" };
  const mw = fixedWindowLimit({
    max: 1, windowMs: 60_000, keyGenerator: (req) => req.ip || "unknown",
    message, now: () => t, pruneIntervalMs: 0,
  });
  const req = { ip: "100.64.0.9" };

  let nexted = false;
  const res1 = mkRes();
  mw(req, res1, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(res1.statusCode, null);

  nexted = false;
  const res2 = mkRes();
  mw(req, res2, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res2.statusCode, 429);
  assert.deepEqual(res2.body, message);
});

test("fixedWindowLimit.prune: drops expired buckets", () => {
  let t = 0;
  const limiter = fixedWindowLimit({ max: 5, windowMs: 60_000, now: () => t, pruneIntervalMs: 0 });
  limiter.check("stale");
  t = 120_000;
  limiter.check("fresh");
  limiter.prune();
  assert.equal(limiter._buckets.has("stale"), false);
  assert.equal(limiter._buckets.has("fresh"), true);
});

test("pickTier: blog-embed tier selection and keys", () => {
  const tiers = [
    {
      match: (req) => !!req.headers["tailscale-user-login"],
      key: (req) => `tsuser:${String(req.headers["tailscale-user-login"]).toLowerCase()}`,
      max: 600,
    },
    {
      match: (req) => !!req.headers["tailscale-funnel-request"],
      key: () => "funnel:shared",
      max: 200,
    },
    { key: (req) => `ip:${req.ip || ""}`, max: 1200 },
  ];

  const tsReq = { headers: { "tailscale-user-login": "Alice@Example.com" } };
  assert.equal(pickTier(tiers, tsReq).max, 600);
  assert.equal(pickTier(tiers, tsReq).key(tsReq), "tsuser:alice@example.com");

  const funnelReq = { headers: { "tailscale-funnel-request": "?1" } };
  assert.equal(pickTier(tiers, funnelReq).max, 200);
  assert.equal(pickTier(tiers, funnelReq).key(funnelReq), "funnel:shared");

  const lanReq = { headers: {}, ip: "192.168.1.20" };
  assert.equal(pickTier(tiers, lanReq).max, 1200);
  assert.equal(pickTier(tiers, lanReq).key(lanReq), "ip:192.168.1.20");

  // tieredRateLimit constructs a real middleware from the same tiers
  const mw = tieredRateLimit({ windowMs: 60_000, tiers, message: { error: "Too many requests" } });
  assert.equal(typeof mw, "function");
});

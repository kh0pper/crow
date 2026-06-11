/**
 * Shared rate-limit factories for gateway routes (W2-1).
 *
 * Two flavors:
 *   - tieredRateLimit: wraps express-rate-limit v8 with an ordered tier
 *     list (first matching tier wins) — extracted from blog-embed-api.js.
 *   - fixedWindowLimit: in-process Map-based fixed window with lazy reset —
 *     formalizes the hand-rolled limiters previously in chat.js/bot-chat.js.
 *     Exact legacy semantics preserved: window resets when
 *     (now - windowStart) > windowMs (strictly greater), and the check is
 *     increment-then-compare (count <= max).
 *
 * Both accept an injectable `now` for tests (fixedWindowLimit) / pure
 * tier-picking (pickTier) so no fake timers are needed.
 */

import rateLimit from "express-rate-limit";

/**
 * Pick the first tier whose match(req) is truthy; a tier without `match`
 * always matches (use as the final fallback). Exported for tests.
 *
 * @param {Array<{match?: (req)=>boolean, key: (req)=>string, max: number}>} tiers
 * @param {object} req
 */
export function pickTier(tiers, req) {
  for (const t of tiers) {
    if (!t.match || t.match(req)) return t;
  }
  return tiers[tiers.length - 1];
}

/**
 * Tiered express-rate-limit middleware. Behavior-identical wrapper: the
 * picked tier supplies both the per-window max and the bucket key.
 *
 * @param {object} opts
 * @param {number} [opts.windowMs=60000]
 * @param {Array<{match?: (req)=>boolean, key: (req)=>string, max: number}>} opts.tiers
 * @param {object} [opts.message={ error: "Too many requests" }]  429 body
 */
export function tieredRateLimit({ windowMs = 60 * 1000, tiers, message = { error: "Too many requests" } }) {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new Error("tieredRateLimit requires a non-empty tiers array");
  }
  return rateLimit({
    windowMs,
    max: (req) => pickTier(tiers, req).max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => pickTier(tiers, req).key(req),
    message,
  });
}

/**
 * Fixed-window in-process limiter.
 *
 * Returns an Express middleware function that also exposes:
 *   .check(key)  — raw check for handlers that gate mid-route (chat,
 *                  bot-chat keep their original response ordering: 404/409
 *                  checks still run before the 429).
 *   .prune()     — drop expired buckets (also runs on an interval unless
 *                  pruneIntervalMs is 0).
 *
 * @param {object} opts
 * @param {number} opts.max               requests per window
 * @param {number} opts.windowMs          window length in ms
 * @param {(req)=>string} [opts.keyGenerator]  middleware key (default req.ip || "unknown")
 * @param {object} [opts.message={ error: "Too many requests" }]  middleware 429 body
 * @param {()=>number} [opts.now=Date.now]  injectable clock for tests
 * @param {number} [opts.pruneIntervalMs=300000]  0 disables the interval
 */
export function fixedWindowLimit({
  max,
  windowMs,
  keyGenerator = (req) => req.ip || "unknown",
  message = { error: "Too many requests" },
  now = Date.now,
  pruneIntervalMs = 5 * 60 * 1000,
}) {
  /** key → { count, windowStart } */
  const buckets = new Map();

  function check(key) {
    const t = now();
    let entry = buckets.get(key);
    if (!entry || (t - entry.windowStart) > windowMs) {
      entry = { count: 0, windowStart: t };
      buckets.set(key, entry);
    }
    entry.count++;
    return entry.count <= max;
  }

  function prune() {
    const t = now();
    for (const [key, entry] of buckets) {
      if ((t - entry.windowStart) > windowMs) buckets.delete(key);
    }
  }

  if (pruneIntervalMs > 0) {
    const timer = setInterval(prune, pruneIntervalMs);
    timer.unref?.();
  }

  function middleware(req, res, next) {
    if (!check(keyGenerator(req))) {
      return res.status(429).json(message);
    }
    next();
  }
  middleware.check = check;
  middleware.prune = prune;
  middleware._buckets = buckets; // test introspection only
  return middleware;
}

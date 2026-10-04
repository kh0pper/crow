/**
 * Fixed-window rate limiter with a BOUNDED key set (T13 fix C3): keys are kept in least-recently-used order and the
 * oldest is evicted past `maxKeys`, so a flood of distinct keys costs bounded memory and never resets everyone's
 * counters at once. `hit(key)` → true when the request is allowed.
 */
export function windowLimiter({ max, windowMs = 60000, maxKeys = 1000, now = Date.now }) {
  const buckets = new Map(); // key → {start, count}, LRU order (oldest first)
  function hit(key) {
    const t = now();
    let b = buckets.get(key);
    if (b) buckets.delete(key);
    if (!b || t - b.start >= windowMs) b = { start: t, count: 0 };
    b.count += 1;
    buckets.set(key, b);
    while (buckets.size > maxKeys) buckets.delete(buckets.keys().next().value);
    return b.count <= max;
  }
  return { hit, size: () => buckets.size, has: (k) => buckets.has(k) };
}

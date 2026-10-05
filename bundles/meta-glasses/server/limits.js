/**
 * A small fixed-window counter for the routes a device token (not a dashboard session) reaches.
 * Those routes are outside the gateway's general limiter, so they carry their own.
 * take(key) counts one and says whether it was within the limit; blocked(key) only looks.
 */
export function createLimiter({ max, windowMs, now = Date.now, maxKeys = 5000 }) {
  const hits = new Map();   // key → { start, n }
  function slot(key) {
    const t = now();
    let s = hits.get(key);
    if (!s || t - s.start >= windowMs) {
      s = { start: t, n: 0 };
      hits.delete(key);
      hits.set(key, s);
      // Bounded: the oldest key goes first (Map keeps insertion order).
      while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
    }
    return s;
  }
  return {
    take(key) { const s = slot(String(key)); s.n += 1; return s.n <= max; },
    blocked(key) { const s = hits.get(String(key)); return !!s && now() - s.start < windowMs && s.n >= max; },
    size() { return hits.size; },
  };
}

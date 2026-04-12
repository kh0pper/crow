/**
 * CrowdSec Gateway Middleware (Bouncer)
 *
 * Synchronous LAPI lookup with strict 200ms timeout and fail-open semantics.
 * Caches decisions in `crowdsec_decisions_cache` (SQLite) so they're visible
 * across all gateway processes (3002, 3004) and bouncer instances.
 *
 * Behavior:
 *   - If CROW_CROWDSEC_BOUNCER_KEY env is unset → no-op (graceful degradation)
 *   - Cache hit (still valid) → enforce decision instantly (block if 'ban', else pass)
 *   - Cache miss → query LAPI with 200ms AbortSignal timeout
 *       - LAPI returns 'ban' → block with 403, cache for 60s
 *       - LAPI returns nothing → pass, cache 'allow' for 60s
 *       - LAPI timeout / network error → pass (fail-open), increment timeout counter
 *   - Circuit breaker: 3 consecutive LAPI failures within 60s → bypass LAPI for 60s
 *
 * Metrics (exposed via /metrics on gateway, see metrics() export):
 *   middleware_crowdsec_allowed_total
 *   middleware_crowdsec_blocked_total
 *   middleware_crowdsec_timeout_total
 *   middleware_crowdsec_cache_hit_total
 *   middleware_crowdsec_cache_miss_total
 *   middleware_crowdsec_circuit_open_total
 */

const LAPI_TIMEOUT_MS = 200;
const CACHE_TTL_SECONDS = 60;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_DURATION_MS = 60_000;

const counters = {
  allowed: 0,
  blocked: 0,
  timeout: 0,
  cache_hit: 0,
  cache_miss: 0,
  circuit_open: 0,
};

const circuitState = {
  consecutiveFailures: 0,
  openedAt: 0,
  isOpen() {
    return this.openedAt > 0 && Date.now() - this.openedAt < CIRCUIT_OPEN_DURATION_MS;
  },
  recordFailure() {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      this.openedAt = Date.now();
      counters.circuit_open++;
    }
  },
  recordSuccess() {
    this.consecutiveFailures = 0;
    this.openedAt = 0;
  },
};

/**
 * Look up a cached decision. Returns the decision string ('ban', 'allow', etc.)
 * if a non-expired cache row exists, otherwise null.
 */
async function getCachedDecision(db, ip) {
  const now = Math.floor(Date.now() / 1000);
  const result = await db.execute({
    sql: "SELECT decision, expires_at FROM crowdsec_decisions_cache WHERE ip = ?",
    args: [ip],
  });
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (row.expires_at < now) {
    // Stale — clean up opportunistically; not awaited critically
    db.execute({
      sql: "DELETE FROM crowdsec_decisions_cache WHERE ip = ?",
      args: [ip],
    }).catch(() => {});
    return null;
  }
  return row.decision;
}

async function setCachedDecision(db, ip, decision, ttlSeconds = CACHE_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  await db.execute({
    sql: `INSERT INTO crowdsec_decisions_cache (ip, decision, cached_at, expires_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(ip) DO UPDATE SET
            decision = excluded.decision,
            cached_at = excluded.cached_at,
            expires_at = excluded.expires_at`,
    args: [ip, decision, now, now + ttlSeconds],
  });
}

/**
 * Invalidate a cached decision (called by ban_ip / unban_ip MCP tool handlers).
 */
export async function invalidateCachedDecision(db, ip) {
  await db.execute({
    sql: "DELETE FROM crowdsec_decisions_cache WHERE ip = ?",
    args: [ip],
  });
}

/**
 * Query CrowdSec LAPI for a decision on this IP.
 * Throws on timeout or network error. Returns decision string or null.
 */
async function queryLapi(lapiUrl, bouncerKey, ip) {
  const url = `${lapiUrl.replace(/\/$/, "")}/v1/decisions?ip=${encodeURIComponent(ip)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "X-Api-Key": bouncerKey,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(LAPI_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`LAPI returned ${res.status}`);
  }
  const data = await res.json();
  // CrowdSec returns null when no decision matches, or an array of decisions
  if (!data || (Array.isArray(data) && data.length === 0)) return null;
  // Take the first (most specific) decision type — typically "ban"
  if (Array.isArray(data) && data[0]?.type) return data[0].type;
  return null;
}

/**
 * Build the Express middleware. Returns a no-op middleware if the env is unset.
 *
 * @param {object} opts
 * @param {object} opts.db - libsql client for the crowdsec_decisions_cache table
 * @param {string} [opts.bouncerKey] - CROW_CROWDSEC_BOUNCER_KEY (defaults to env)
 * @param {string} [opts.lapiUrl] - CROW_CROWDSEC_LAPI_URL (defaults to env or http://127.0.0.1:8091)
 * @returns {Function} Express middleware (req, res, next)
 */
export function crowdsecMiddleware({ db, bouncerKey, lapiUrl } = {}) {
  const key = bouncerKey ?? process.env.CROW_CROWDSEC_BOUNCER_KEY;
  const url = lapiUrl ?? process.env.CROW_CROWDSEC_LAPI_URL ?? "http://127.0.0.1:8091";

  if (!key) {
    // Graceful no-op: CrowdSec not installed/configured
    return (_req, _res, next) => next();
  }
  if (!db) {
    throw new Error("crowdsecMiddleware: db client is required");
  }

  return async function crowdsecBouncer(req, res, next) {
    const ip = req.ip;
    if (!ip) {
      counters.allowed++;
      return next();
    }

    try {
      // 1. Cache check
      const cached = await getCachedDecision(db, ip);
      if (cached !== null) {
        counters.cache_hit++;
        if (cached === "ban") {
          counters.blocked++;
          return res.status(403).json({ error: "blocked by CrowdSec" });
        }
        counters.allowed++;
        return next();
      }
      counters.cache_miss++;

      // 2. Circuit breaker check
      if (circuitState.isOpen()) {
        counters.allowed++;
        return next();
      }

      // 3. LAPI lookup with 200ms timeout
      let decision;
      try {
        decision = await queryLapi(url, key, ip);
        circuitState.recordSuccess();
      } catch (err) {
        // Timeout or network error → fail-open
        circuitState.recordFailure();
        if (err.name === "TimeoutError" || err.name === "AbortError") {
          counters.timeout++;
        }
        counters.allowed++;
        return next();
      }

      // 4. Cache and enforce
      if (decision === "ban") {
        await setCachedDecision(db, ip, "ban");
        counters.blocked++;
        return res.status(403).json({ error: "blocked by CrowdSec" });
      }
      // No decision → cache 'allow' so we don't hit LAPI again for 60s
      await setCachedDecision(db, ip, "allow");
      counters.allowed++;
      return next();
    } catch (err) {
      // Any unexpected error → fail-open, log
      console.error("[crowdsec middleware]", err.message);
      counters.allowed++;
      return next();
    }
  };
}

/**
 * Snapshot of metric counters for /metrics endpoint or debugging.
 */
export function metrics() {
  return {
    middleware_crowdsec_allowed_total: counters.allowed,
    middleware_crowdsec_blocked_total: counters.blocked,
    middleware_crowdsec_timeout_total: counters.timeout,
    middleware_crowdsec_cache_hit_total: counters.cache_hit,
    middleware_crowdsec_cache_miss_total: counters.cache_miss,
    middleware_crowdsec_circuit_open_total: counters.circuit_open,
    middleware_crowdsec_circuit_state: circuitState.isOpen() ? "open" : "closed",
  };
}

/**
 * Reset state — useful for tests.
 */
export function _reset() {
  counters.allowed = 0;
  counters.blocked = 0;
  counters.timeout = 0;
  counters.cache_hit = 0;
  counters.cache_miss = 0;
  counters.circuit_open = 0;
  circuitState.consecutiveFailures = 0;
  circuitState.openedAt = 0;
}

/**
 * Bind-time fit of an assistant on a display: can its voice prompt fit the quick
 * voice model? The answer comes from the voice turn's own ladder (the runner's
 * assessBot — one estimator, servers/gateway/voice/prompt-fit.js); this file only
 * caches it, because the panel polls its listing every few seconds and a fit
 * check reads every skill file of the bot.
 */
export const FIT_TTL_MS = 30_000;

/**
 * assess(db, botId, memoryOn) → the runner's assessBot result (or null).
 * Returns botFit(db, botId, memoryOn, { fresh }) → "full" | "no_skills" | "too_large",
 * or null when it cannot be known (no estimator, unknown model context, unknown bot,
 * a failed check) — callers treat null as "no status", never as a refusal.
 */
export function createBotFit({ assess, now = Date.now, log = () => {}, ttlMs = FIT_TTL_MS }) {
  const cache = new Map();
  return async function botFit(db, botId, memoryOn = false, { fresh = false } = {}) {
    const key = `${botId}|${memoryOn ? 1 : 0}`;
    const hit = cache.get(key);
    if (!fresh && hit && now() - hit.at < ttlMs) return hit.level;
    let level = null;
    try {
      const fit = await assess(db, botId, !!memoryOn);
      if (fit && fit.ctx) level = fit.level;
    } catch (err) { log(`[kiosk] fit check for ${botId} failed: ${err.message}`); }
    cache.set(key, { level, at: now() });
    return level;
  };
}

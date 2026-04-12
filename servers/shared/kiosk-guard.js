/**
 * Kiosk-active guard.
 *
 * When any Maker Lab session is active (`state != 'revoked' AND expires_at > now()`),
 * peer-sharing MCP surfaces refuse to run. Defense-in-depth for the plan rule
 * "no peer-sharing ever initiated from inside a kid session."
 *
 * Safe on installs without maker-lab — returns `false` silently if the
 * `maker_sessions` table doesn't exist.
 */

let _cache = { at: 0, value: false };
const CACHE_MS = 1000;

export async function isKioskActive(db) {
  const now = Date.now();
  if (now - _cache.at < CACHE_MS) return _cache.value;
  try {
    const r = await db.execute({
      sql: `SELECT 1 FROM maker_sessions
            WHERE state != 'revoked' AND expires_at > datetime('now')
            LIMIT 1`,
      args: [],
    });
    const active = r.rows.length > 0;
    _cache = { at: now, value: active };
    return active;
  } catch {
    _cache = { at: now, value: false };
    return false;
  }
}

/**
 * Return a McpServer-style error content payload explaining the refusal.
 * Tools call this inside their handler when isKioskActive() is true.
 */
export function kioskBlockedResponse(toolName) {
  return {
    content: [
      {
        type: "text",
        text: `Refusing to run ${toolName}: a Maker Lab kiosk session is active. Peer-sharing is disabled while a learner is in a tutor session. End the session from the Maker Lab panel and try again.`,
      },
    ],
    isError: true,
  };
}

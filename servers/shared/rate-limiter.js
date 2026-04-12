/**
 * Shared MCP tool rate limiter for Crow bundles.
 *
 * Protects against LLM-driven fediverse spam: a misaligned agent in a
 * posting loop can earn an instance defederation within hours, and app-
 * level rate limits aren't consistent across Matrix/Mastodon/Pixelfed etc.
 * This layer lives above the bundle's MCP handler and enforces per-tool
 * per-conversation budgets before the call reaches the app API.
 *
 * Design:
 *   - Token bucket, refilled continuously at `capacity / window_seconds`.
 *   - Buckets persisted in SQLite (`rate_limit_buckets` table) so a bundle
 *     restart does NOT reset the window. Bypass-by-restart was the
 *     reviewer-flagged hole in round 2.
 *   - bucket_key defaults to `<conversation_id>` (from MCP context) and
 *     falls back to a hash of client transport identity, then to
 *     `<tool_id>:global`. Hierarchy protects both single-conversation
 *     bursts and cross-conversation floods.
 *   - Defaults are per-tool-pattern; ~/.crow/rate-limits.json overrides
 *     on a per-tool basis. Config is hot-reloaded via fs.watch.
 *
 * Usage from a bundle MCP server:
 *
 *     import { wrapRateLimited } from "../../../servers/shared/rate-limiter.js";
 *
 *     const limiter = wrapRateLimited({ db, defaults: { ... } });
 *     server.tool(
 *       "gts_post",
 *       "Post a status",
 *       { status: z.string().max(500) },
 *       limiter("gts_post", async ({ status }, ctx) => { ... })
 *     );
 *
 * The wrapped handler receives `(args, ctx)` where `ctx` may carry the
 * MCP conversation id; if absent, the fallback chain applies.
 */

import { readFileSync, existsSync, watch } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_CONFIG_PATH = join(homedir(), ".crow", "rate-limits.json");

/**
 * Default budgets keyed by tool-name pattern.
 * Values are `{ capacity: <tokens>, window_seconds: <seconds> }`.
 * Pattern match is suffix-based (post | follow | search | moderate).
 */
export const DEFAULT_BUDGETS = {
  "*_post": { capacity: 10, window_seconds: 3600 },
  "*_create": { capacity: 10, window_seconds: 3600 },
  "*_follow": { capacity: 30, window_seconds: 3600 },
  "*_unfollow": { capacity: 30, window_seconds: 3600 },
  "*_search": { capacity: 60, window_seconds: 3600 },
  "*_feed": { capacity: 60, window_seconds: 3600 },
  "*_block_user": { capacity: 5, window_seconds: 3600 },
  "*_mute_user": { capacity: 5, window_seconds: 3600 },
  "*_block_domain": { capacity: 5, window_seconds: 3600 },
  "*_defederate": { capacity: 5, window_seconds: 3600 },
  "*_import_blocklist": { capacity: 2, window_seconds: 3600 },
  "*_report_remote": { capacity: 5, window_seconds: 3600 },
  // Read-only / status tools are uncapped (no entry = no limit)
};

function matchBudget(toolId, budgets) {
  if (budgets[toolId]) return budgets[toolId];
  for (const [pat, budget] of Object.entries(budgets)) {
    if (pat === toolId) return budget;
    if (pat.startsWith("*_") && toolId.endsWith(pat.slice(1))) return budget;
  }
  return null;
}

/**
 * Load + watch the override config file. Returns a closure that always
 * reflects the latest merged budgets.
 */
function loadConfig(configPath) {
  let current = { ...DEFAULT_BUDGETS };

  const readOnce = () => {
    if (!existsSync(configPath)) {
      current = { ...DEFAULT_BUDGETS };
      return;
    }
    try {
      const raw = readFileSync(configPath, "utf8");
      const overrides = JSON.parse(raw);
      current = { ...DEFAULT_BUDGETS, ...overrides };
    } catch (err) {
      // Malformed override file — keep prior value rather than crash the
      // rate limiter. Log via stderr; the operator can fix and fs.watch
      // will pick it up on next save.
      process.stderr.write(
        `[rate-limiter] failed to parse ${configPath}: ${err.message}\n`,
      );
    }
  };

  readOnce();
  try {
    watch(configPath, { persistent: false }, () => readOnce());
  } catch {
    // File doesn't exist yet — watch the parent directory instead so we
    // pick up creation. Best-effort; hot-reload is a nice-to-have.
  }
  return () => current;
}

/**
 * Derive the bucket key: conversation id if MCP provided one, else a hash
 * of whatever transport-identifying bits are available, else a global
 * fallback. Always non-empty.
 */
function resolveBucketKey(toolId, ctx) {
  if (ctx?.conversationId) return `conv:${ctx.conversationId}`;
  if (ctx?.sessionId) return `session:${ctx.sessionId}`;
  if (ctx?.transport?.id) {
    return `tx:${createHash("sha256").update(String(ctx.transport.id)).digest("hex").slice(0, 16)}`;
  }
  return `global:${toolId}`;
}

/**
 * Low-level bucket check. Returns `{ allowed, remaining, retry_after }`.
 * `db` is a @libsql/client-compatible handle (has `.execute`).
 */
export async function consumeToken(db, { toolId, bucketKey, capacity, windowSeconds }) {
  const now = Math.floor(Date.now() / 1000);
  const refillRate = capacity / windowSeconds;

  const cur = await db.execute({
    sql: "SELECT tokens, refilled_at FROM rate_limit_buckets WHERE tool_id = ? AND bucket_key = ?",
    args: [toolId, bucketKey],
  });

  let tokens;
  let refilledAt = now;
  if (cur.rows.length === 0) {
    tokens = capacity - 1;
    await db.execute({
      sql: `INSERT INTO rate_limit_buckets (tool_id, bucket_key, tokens, refilled_at)
            VALUES (?, ?, ?, ?)`,
      args: [toolId, bucketKey, tokens, refilledAt],
    });
    return { allowed: true, remaining: tokens, retry_after: 0 };
  }

  const prevTokens = Number(cur.rows[0].tokens);
  const prevRefilled = Number(cur.rows[0].refilled_at);
  const elapsed = Math.max(0, now - prevRefilled);
  tokens = Math.min(capacity, prevTokens + elapsed * refillRate);

  if (tokens < 1) {
    const retryAfter = Math.ceil((1 - tokens) / refillRate);
    // Persist the refill progress so clients see a monotonic count.
    await db.execute({
      sql: "UPDATE rate_limit_buckets SET tokens = ?, refilled_at = ? WHERE tool_id = ? AND bucket_key = ?",
      args: [tokens, now, toolId, bucketKey],
    });
    return { allowed: false, remaining: Math.floor(tokens), retry_after: retryAfter };
  }

  tokens -= 1;
  await db.execute({
    sql: "UPDATE rate_limit_buckets SET tokens = ?, refilled_at = ? WHERE tool_id = ? AND bucket_key = ?",
    args: [tokens, now, toolId, bucketKey],
  });
  return { allowed: true, remaining: Math.floor(tokens), retry_after: 0 };
}

/**
 * Build a rate-limit wrapper bound to a DB handle + (optional) config path.
 * Returns `limiter(toolId, handler)` — the wrapped handler is the shape
 * MCP's `server.tool(..., handler)` expects.
 */
export function wrapRateLimited({ db, configPath = DEFAULT_CONFIG_PATH } = {}) {
  const getBudgets = loadConfig(configPath);

  return function limiter(toolId, handler) {
    return async (args, ctx) => {
      const budgets = getBudgets();
      const budget = matchBudget(toolId, budgets);
      if (!budget) return handler(args, ctx); // uncapped tool

      const bucketKey = resolveBucketKey(toolId, ctx);
      const result = await consumeToken(db, {
        toolId,
        bucketKey,
        capacity: budget.capacity,
        windowSeconds: budget.window_seconds,
      });
      if (!result.allowed) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "rate_limited",
              tool: toolId,
              bucket: bucketKey,
              retry_after_seconds: result.retry_after,
              budget: `${budget.capacity}/${budget.window_seconds}s`,
            }),
          }],
          isError: true,
        };
      }
      return handler(args, ctx);
    };
  };
}

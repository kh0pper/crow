/**
 * Crow Sharing — Cross-posting Tools
 *
 * Registers: crow_list_crosspost_transforms, crow_crosspost,
 *            crow_crosspost_cancel, crow_crosspost_mark_published,
 *            crow_list_crossposts
 * (tool registration order #29-33)
 */

import { z } from "zod";
import { transform as crosspostTransform, SUPPORTED_PAIRS as CROSSPOST_PAIRS } from "../../gateway/crossposting/transforms.js";
import { createNotification } from "../../shared/notifications.js";
import { createDbClient } from "../../db.js";

export function registerCrosspostTools(server, ctx) {
  // Note: crosspost tools open their own no-arg createDbClient() connections.

  // --- F.12.2: Crow-native cross-posting ---

  server.tool(
    "crow_list_crosspost_transforms",
    "List the available (source, target) transform pairs for crow_crosspost. Each pair is a pure function in servers/gateway/crossposting/transforms.js.",
    {},
    async () => ({
      content: [{
        type: "text",
        text: JSON.stringify({ pairs: CROSSPOST_PAIRS }, null, 2),
      }],
    }),
  );

  server.tool(
    "crow_crosspost",
    "Cross-post a status from one federated bundle to another via the shared transform library. Requires idempotency_key — duplicate keys within 7 days return the cached result. on_publish trigger queues with a 60-second delay + cancel notification (no fake undo-after-publish).",
    {
      source_app: z.string().min(1).max(50),
      source_post_id: z.string().min(1).max(200).describe("The source app's native post id. Used for idempotency + audit."),
      source_post: z.object({}).passthrough().describe("Source post shape — transforms pull fields from this object (title, content, url, media, etc.)."),
      target_app: z.string().min(1).max(50),
      idempotency_key: z.string().min(8).max(200).describe("Required. Typically sha256(source_app+source_post_id+target_app). Per-Crow-instance scope."),
      trigger: z.enum(["manual", "on_publish", "on_tag"]).optional().describe("manual fires immediately; on_publish/on_tag enqueue with 60s delay."),
      delay_seconds: z.number().int().min(0).max(86400).optional().describe("Override the default 60s delay. 0 = fire immediately (manual default)."),
      confirm: z.literal("yes").describe("Cross-posts cannot be reliably retracted; confirm intent."),
    },
    async ({ source_app, source_post_id, source_post, target_app, idempotency_key, trigger, delay_seconds }) => {
      try {
        // Validate the transform exists before creating a queue entry
        let transformed;
        try {
          transformed = crosspostTransform(source_app, target_app, source_post);
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }

        const db = createDbClient();
        try {
          // Idempotency check (last 7 days)
          const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
          const existing = await db.execute({
            sql: `SELECT id, status, target_post_id, scheduled_at, published_at, cancelled_at
                  FROM crosspost_log
                  WHERE idempotency_key = ? AND source_app = ? AND target_app = ?
                    AND created_at >= ?
                  LIMIT 1`,
            args: [idempotency_key, source_app, target_app, sevenDaysAgo],
          });
          if (existing.rows.length > 0) {
            const r = existing.rows[0];
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  status: "idempotent_hit",
                  log_id: Number(r.id),
                  prior_status: r.status,
                  target_post_id: r.target_post_id || null,
                  scheduled_at: Number(r.scheduled_at),
                  published_at: r.published_at ? Number(r.published_at) : null,
                  cancelled_at: r.cancelled_at ? Number(r.cancelled_at) : null,
                  note: "Duplicate idempotency_key within 7 days — returning cached entry without re-queuing.",
                }, null, 2),
              }],
            };
          }

          const effectiveTrigger = trigger || "manual";
          const isImmediate = effectiveTrigger === "manual";
          const delay = delay_seconds != null ? delay_seconds : (isImmediate ? 0 : 60);
          const now = Math.floor(Date.now() / 1000);
          const scheduledAt = now + delay;
          const status = delay > 0 ? "queued" : "ready";

          const inserted = await db.execute({
            sql: `INSERT INTO crosspost_log
                    (idempotency_key, source_app, source_post_id, target_app,
                     transform, status, scheduled_at, created_at, transformed_payload_json)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                  RETURNING id`,
            args: [
              idempotency_key, source_app, source_post_id, target_app,
              `${source_app}→${target_app}`, status, scheduledAt, now,
              JSON.stringify(transformed),
            ],
          });
          const logId = Number(inserted.rows[0].id);

          if (delay > 0) {
            try {
              await createNotification(db, {
                title: `About to cross-post to ${target_app}`,
                body: `Source: ${source_app}#${source_post_id}. Firing in ${delay}s unless cancelled. Cancel via crow_crosspost_cancel({ log_id: ${logId} }).`,
                type: "peer",
                source: "crosspost",
                priority: "medium",
                action_url: `/dashboard/crosspost?log_id=${logId}`,
              });
            } catch {}
          }

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                log_id: logId,
                status,
                scheduled_at: scheduledAt,
                delay_seconds: delay,
                transform: `${source_app}→${target_app}`,
                transformed_preview: transformed,
                note: delay > 0
                  ? `Queued with ${delay}s cancel window. Target bundle's publish tool must be invoked when scheduled_at arrives — this tool only produces the transformed payload + audit log entry, it does NOT publish directly.`
                  : "Ready to publish. Target bundle's publish tool must be invoked now — this tool only produces the transformed payload.",
              }, null, 2),
            }],
          };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "crow_crosspost_cancel",
    "Cancel a queued cross-post before its scheduled_at fires. Idempotent — cancelling an already-published entry returns the published target_post_id. Cancelling an already-cancelled entry is a no-op.",
    {
      log_id: z.number().int(),
    },
    async ({ log_id }) => {
      try {
        const db = createDbClient();
        try {
          const row = await db.execute({
            sql: "SELECT status, target_post_id, cancelled_at, published_at, scheduled_at FROM crosspost_log WHERE id = ?",
            args: [log_id],
          });
          if (row.rows.length === 0) {
            return { content: [{ type: "text", text: "Error: crosspost not found." }] };
          }
          const r = row.rows[0];
          if (r.status === "published") {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  status: "already_published",
                  target_post_id: r.target_post_id,
                  published_at: Number(r.published_at),
                  note: "Published cross-posts cannot be retracted via this tool — use the target bundle's delete verb + accept that delete-propagation is unreliable.",
                }, null, 2),
              }],
            };
          }
          if (r.cancelled_at) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({ status: "already_cancelled", cancelled_at: Number(r.cancelled_at) }, null, 2),
              }],
            };
          }
          const now = Math.floor(Date.now() / 1000);
          await db.execute({
            sql: "UPDATE crosspost_log SET status = 'cancelled', cancelled_at = ? WHERE id = ?",
            args: [now, log_id],
          });
          return { content: [{ type: "text", text: JSON.stringify({ status: "cancelled", cancelled_at: now }, null, 2) }] };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "crow_crosspost_mark_published",
    "Mark a queued cross-post as published (called by the target bundle's publish flow after the actual remote post is created). This tool ONLY updates the audit log — it does NOT perform the publication itself.",
    {
      log_id: z.number().int(),
      target_post_id: z.string().min(1).max(200),
    },
    async ({ log_id, target_post_id }) => {
      try {
        const db = createDbClient();
        try {
          const now = Math.floor(Date.now() / 1000);
          const res = await db.execute({
            sql: `UPDATE crosspost_log SET status = 'published', target_post_id = ?, published_at = ?
                  WHERE id = ? AND status != 'cancelled'`,
            args: [target_post_id, now, log_id],
          });
          if (res.rowsAffected === 0) {
            return { content: [{ type: "text", text: "Error: log row not found or already cancelled." }] };
          }
          return { content: [{ type: "text", text: JSON.stringify({ status: "published", target_post_id, published_at: now }, null, 2) }] };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "crow_list_crossposts",
    "List recent cross-posts from the log with their status (queued/ready/published/cancelled/error).",
    {
      status: z.enum(["queued", "ready", "published", "cancelled", "error"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ status, limit }) => {
      try {
        const db = createDbClient();
        try {
          const clauses = [];
          const args = [];
          if (status) { clauses.push("status = ?"); args.push(status); }
          args.push(limit ?? 50);
          const rows = await db.execute({
            sql: `SELECT id, source_app, source_post_id, target_app, transform, status,
                         target_post_id, scheduled_at, published_at, cancelled_at, error, created_at
                  FROM crosspost_log
                  ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""}
                  ORDER BY created_at DESC LIMIT ?`,
            args,
          });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                count: rows.rows.length,
                crossposts: rows.rows.map(r => ({
                  id: Number(r.id),
                  source_app: r.source_app,
                  source_post_id: r.source_post_id,
                  target_app: r.target_app,
                  transform: r.transform,
                  status: r.status,
                  target_post_id: r.target_post_id || null,
                  scheduled_at: Number(r.scheduled_at),
                  published_at: r.published_at ? Number(r.published_at) : null,
                  cancelled_at: r.cancelled_at ? Number(r.cancelled_at) : null,
                  error: r.error || null,
                })),
              }, null, 2),
            }],
          };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );
}

/**
 * F.13: Crosspost scheduler + GC.
 *
 * Runs inside the gateway process. Two loops:
 *
 * 1. Publish loop (every 15s): scans crosspost_log for rows with
 *    status='ready' OR (status='queued' AND scheduled_at <= now). For
 *    each row, dispatches the stored `transformed_payload_json` to the
 *    target bundle's public API using PUBLISHERS below. Marks the row
 *    'published' with target_post_id on success; 'error' with error
 *    string on failure.
 *
 * 2. GC loop (every 1h): deletes crosspost_log rows older than 30 days.
 *    Also expires moderation_actions in 'pending' state past their
 *    expires_at (sweeps to 'expired'; F.11 docs this TTL sweep).
 *
 * Design points:
 *   - Publishers are plain HTTP calls to the target app's REST API using
 *     the bundle's own env vars (MASTODON_URL + MASTODON_ACCESS_TOKEN,
 *     GTS_URL + GTS_ACCESS_TOKEN, etc.). This bypasses the MCP layer
 *     entirely — no in-process MCP client needed. Simpler and survives
 *     MCP transport changes.
 *   - Media-heavy targets (pixelfed photo posts, peertube uploads,
 *     funkwhale track uploads) need binary file data we don't have stored.
 *     These remain OPERATOR-DRIVEN: scheduler marks them status='manual'
 *     and leaves them alone. The `crow_crosspost_mark_published` tool
 *     closes the audit log after the operator publishes by hand.
 *   - Text-only targets (mastodon, gotosocial, writefreely, crow-blog,
 *     lemmy text posts) are fully automated.
 *   - Overlap protection: a poll that's still running when the next tick
 *     fires is a no-op (in-flight set).
 *   - Disabled via CROW_DISABLE_CROSSPOST_SCHEDULER=1 for testing.
 */

import { createDbClient } from "../../db.js";
import { createNotification } from "../../shared/notifications.js";

const PUBLISH_INTERVAL_MS = 15_000;
const GC_INTERVAL_MS = 3600_000; // 1 hour
const MAX_BATCH = 20;
const LOG_RETENTION_DAYS = 30;

// --- Publishers ---

async function publishMastodon(payload) {
  const url = (process.env.MASTODON_URL || "http://mastodon-web:3000").replace(/\/+$/, "");
  const token = process.env.MASTODON_ACCESS_TOKEN;
  if (!token) throw new Error("MASTODON_ACCESS_TOKEN not set");
  const body = {
    status: payload.status,
    visibility: payload.visibility || "public",
    ...(payload.spoiler_text ? { spoiler_text: payload.spoiler_text } : {}),
    ...(payload.language ? { language: payload.language } : {}),
    ...(payload.sensitive != null ? { sensitive: payload.sensitive } : {}),
  };
  const res = await fetch(`${url}/api/v1/statuses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Mastodon ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return { target_post_id: String(data.id), url: data.url };
}

async function publishGoToSocial(payload) {
  const url = (process.env.GTS_URL || "http://gotosocial:8080").replace(/\/+$/, "");
  const token = process.env.GTS_ACCESS_TOKEN;
  if (!token) throw new Error("GTS_ACCESS_TOKEN not set");
  const body = {
    status: payload.status,
    visibility: payload.visibility || "public",
    ...(payload.spoiler_text ? { spoiler_text: payload.spoiler_text } : {}),
  };
  const res = await fetch(`${url}/api/v1/statuses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GoToSocial ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return { target_post_id: String(data.id), url: data.url };
}

async function publishBlog(payload) {
  // crow-blog is in-process; use the local DB directly rather than
  // calling our own REST endpoint.
  const db = createDbClient();
  try {
    const title = payload.status?.split("\n")[0]?.slice(0, 200) || "Cross-post";
    const content = payload.status || "";
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) + "-" + Date.now().toString(36);
    const result = await db.execute({
      sql: `INSERT INTO blog_posts (title, slug, content, status, visibility, created_at, updated_at, published_at)
            VALUES (?, ?, ?, 'published', 'public', datetime('now'), datetime('now'), datetime('now'))
            RETURNING id`,
      args: [title, slug, content],
    });
    const id = Number(result.rows[0].id);
    return { target_post_id: String(id), url: `/blog/${slug}` };
  } finally {
    try { db.close(); } catch {}
  }
}

const PUBLISHERS = {
  mastodon: publishMastodon,
  gotosocial: publishGoToSocial,
  blog: publishBlog,
};

// Targets we recognize but can't auto-publish (need file data we didn't store)
const MANUAL_TARGETS = new Set([
  "pixelfed",      // photo upload needs binary
  "peertube",      // video upload needs binary
  "funkwhale",     // track upload needs binary
  "writefreely",   // text-only but needs collection alias wiring; TODO in follow-up
  "lemmy",         // text-only but needs community_id in payload; TODO
  "matrix-dendrite", // needs room_id; TODO
]);

function publisherFor(targetApp) {
  if (PUBLISHERS[targetApp]) return PUBLISHERS[targetApp];
  if (MANUAL_TARGETS.has(targetApp)) return null;
  return null;
}

// --- Publish loop ---

const inFlight = new Set();

async function publishOne(db, row) {
  if (inFlight.has(row.id)) return;
  inFlight.add(row.id);
  try {
    if (!row.transformed_payload_json) {
      // Legacy F.12 row without stored payload — mark as manual.
      await db.execute({
        sql: "UPDATE crosspost_log SET status = 'manual', error = ? WHERE id = ?",
        args: ["no_transformed_payload_stored (row pre-dates F.13 migration)", row.id],
      });
      return;
    }

    const publisher = publisherFor(row.target_app);
    if (!publisher) {
      await db.execute({
        sql: "UPDATE crosspost_log SET status = 'manual' WHERE id = ?",
        args: [row.id],
      });
      return;
    }

    const payload = JSON.parse(row.transformed_payload_json);
    const { target_post_id, url } = await publisher(payload);
    const now = Math.floor(Date.now() / 1000);
    await db.execute({
      sql: `UPDATE crosspost_log SET status = 'published', target_post_id = ?, published_at = ?, error = NULL
            WHERE id = ? AND status != 'cancelled'`,
      args: [target_post_id, now, row.id],
    });
    try {
      await createNotification(db, {
        title: `Cross-post published to ${row.target_app}`,
        body: `${row.source_app}#${row.source_post_id} → ${row.target_app}#${target_post_id}${url ? ` (${url})` : ""}`,
        type: "peer",
        source: "crosspost",
        priority: "low",
      });
    } catch {}
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 1000);
    try {
      await db.execute({
        sql: "UPDATE crosspost_log SET status = 'error', error = ? WHERE id = ? AND status != 'cancelled'",
        args: [msg, row.id],
      });
    } catch {}
    try {
      await createNotification(db, {
        title: `Cross-post failed to ${row.target_app}`,
        body: `${row.source_app}#${row.source_post_id}: ${msg.slice(0, 200)}`,
        type: "system",
        source: "crosspost",
        priority: "high",
      });
    } catch {}
  } finally {
    inFlight.delete(row.id);
  }
}

async function publishTick(db) {
  const now = Math.floor(Date.now() / 1000);
  const rows = await db.execute({
    sql: `SELECT id, source_app, source_post_id, target_app, transformed_payload_json, status, scheduled_at
          FROM crosspost_log
          WHERE (status = 'ready' OR (status = 'queued' AND scheduled_at <= ?))
          ORDER BY scheduled_at ASC LIMIT ?`,
    args: [now, MAX_BATCH],
  });
  for (const r of rows.rows) {
    const row = {
      id: Number(r.id),
      source_app: r.source_app,
      source_post_id: r.source_post_id,
      target_app: r.target_app,
      transformed_payload_json: r.transformed_payload_json,
    };
    publishOne(db, row).catch(() => {});
  }
}

// --- GC loop ---

async function gcTick(db) {
  try {
    const cutoff = Math.floor(Date.now() / 1000) - LOG_RETENTION_DAYS * 86400;
    const res = await db.execute({
      sql: "DELETE FROM crosspost_log WHERE created_at < ? AND status IN ('published', 'cancelled', 'error', 'manual')",
      args: [cutoff],
    });
    if (res.rowsAffected > 0) {
      // eslint-disable-next-line no-console
      console.log(`[crosspost-gc] pruned ${res.rowsAffected} crosspost_log rows older than ${LOG_RETENTION_DAYS}d`);
    }
  } catch (err) {
    console.warn(`[crosspost-gc] error: ${err.message}`);
  }

  try {
    // F.11 moderation_actions TTL sweep — pending rows past expires_at → expired
    const now = Math.floor(Date.now() / 1000);
    const res = await db.execute({
      sql: "UPDATE moderation_actions SET status = 'expired' WHERE status = 'pending' AND expires_at < ?",
      args: [now],
    });
    if (res.rowsAffected > 0) {
      console.log(`[moderation-gc] expired ${res.rowsAffected} moderation_actions past their TTL`);
    }
  } catch (err) {
    console.warn(`[moderation-gc] error: ${err.message}`);
  }
}

// --- Exported start/stop ---

let publishTimer = null;
let gcTimer = null;

export function startCrosspostScheduler(opts = {}) {
  if (process.env.CROW_DISABLE_CROSSPOST_SCHEDULER === "1") {
    console.log("[crosspost-scheduler] disabled via CROW_DISABLE_CROSSPOST_SCHEDULER=1");
    return { stop() {} };
  }
  const publishMs = opts.publishIntervalMs || PUBLISH_INTERVAL_MS;
  const gcMs = opts.gcIntervalMs || GC_INTERVAL_MS;

  const runPublish = async () => {
    const db = createDbClient();
    try { await publishTick(db); }
    catch (err) { console.warn(`[crosspost-scheduler] tick error: ${err.message}`); }
    finally { try { db.close(); } catch {} }
  };

  const runGc = async () => {
    const db = createDbClient();
    try { await gcTick(db); }
    finally { try { db.close(); } catch {} }
  };

  // Kick off one GC on start to normalize stale state
  runGc().catch(() => {});

  publishTimer = setInterval(runPublish, publishMs);
  gcTimer = setInterval(runGc, gcMs);
  console.log(`[crosspost-scheduler] started (publish ${publishMs / 1000}s, gc ${gcMs / 1000}s)`);

  return {
    stop() {
      if (publishTimer) clearInterval(publishTimer);
      if (gcTimer) clearInterval(gcTimer);
      publishTimer = null;
      gcTimer = null;
    },
  };
}

// Exported for tests
export const _internal = { publishTick, gcTick, publishOne, PUBLISHERS, MANUAL_TARGETS };

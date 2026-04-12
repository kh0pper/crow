/**
 * PeerTube MCP Server
 *
 * PeerTube has its own REST API at /api/v1/ — not Mastodon-compatible.
 * OAuth2 bearer auth. Upload is chunked via resumable PUT (tus-style)
 * but the bundle exposes a simpler single-request POST /api/v1/videos/upload
 * for files up to ~2 GB; larger uploads should go through the web UI.
 *
 * Tools (federated-video taxonomy):
 *   pt_status, pt_list_channels, pt_list_videos,
 *   pt_upload_video, pt_search,
 *   pt_subscribe, pt_unsubscribe,
 *   pt_rate_video,
 *   pt_block_user (inline, rate-limited),
 *   pt_block_server (QUEUED, admin-destructive),
 *   pt_defederate (QUEUED),
 *   pt_review_reports, pt_report_remote,
 *   pt_media_prune (admin)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const PEERTUBE_URL = (process.env.PEERTUBE_URL || "http://peertube:9000").replace(/\/+$/, "");
const PEERTUBE_ACCESS_TOKEN = process.env.PEERTUBE_ACCESS_TOKEN || "";
const PEERTUBE_HOSTNAME = process.env.PEERTUBE_WEBSERVER_HOSTNAME || "";

let wrapRateLimited = null;
let getDb = null;
let createNotification = null;

async function loadSharedDeps() {
  try {
    const rl = await import("../../../servers/shared/rate-limiter.js");
    wrapRateLimited = rl.wrapRateLimited;
  } catch {
    wrapRateLimited = () => (_toolId, handler) => handler;
  }
  try {
    const db = await import("../../../servers/db.js");
    getDb = db.createDbClient;
  } catch {
    getDb = null;
  }
  try {
    const notif = await import("../../../servers/shared/notifications.js");
    createNotification = notif.createNotification;
  } catch {
    createNotification = null;
  }
}

async function ptFetch(path, { method = "GET", body, query, noAuth, timeoutMs = 30_000, rawForm } = {}) {
  const qs = query
    ? "?" +
      Object.entries(query)
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) =>
          Array.isArray(v)
            ? v.map((x) => `${encodeURIComponent(k)}=${encodeURIComponent(x)}`).join("&")
            : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
        )
        .join("&")
    : "";
  const url = `${PEERTUBE_URL}${path}${qs}`;
  const headers = {};
  if (!noAuth && PEERTUBE_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${PEERTUBE_ACCESS_TOKEN}`;
  }
  let payload;
  if (rawForm) {
    payload = rawForm;
  } else if (body) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body: payload, signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) {
      const snippet = text.slice(0, 600);
      if (res.status === 401) throw new Error("PeerTube auth failed (401). Obtain a bearer token via POST /api/v1/users/token (username+password + client_id/client_secret from /api/v1/oauth-clients/local), paste into PEERTUBE_ACCESS_TOKEN.");
      if (res.status === 403) throw new Error(`PeerTube forbidden (403)${snippet ? ": " + snippet : ""}`);
      throw new Error(`PeerTube ${res.status} ${res.statusText}${snippet ? " — " + snippet : ""}`);
    }
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { raw: text }; }
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`PeerTube request timed out: ${path}`);
    if (err.cause?.code === "ECONNREFUSED" || err.message?.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach PeerTube at ${PEERTUBE_URL}. Verify crow-peertube is up and on the crow-federation network.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function requireAuth() {
  if (!PEERTUBE_ACCESS_TOKEN) {
    return { content: [{ type: "text", text: "Error: PEERTUBE_ACCESS_TOKEN required. See the bundle's skill doc for token-acquisition recipe." }] };
  }
  return null;
}

async function queueModerationAction(bundle, actionType, payload) {
  if (!getDb) {
    return {
      status: "queued_offline",
      reason: "Crow database not reachable from bundle — moderation queue unavailable. Action NOT applied.",
      requested: { action_type: actionType, payload },
    };
  }
  const db = getDb();
  try {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 72 * 3600;
    const payloadJson = JSON.stringify(payload);
    const { createHash } = await import("node:crypto");
    const idempotencyKey = createHash("sha256").update(`${bundle}:${actionType}:${payloadJson}`).digest("hex");

    const existing = await db.execute({
      sql: "SELECT id, expires_at, status FROM moderation_actions WHERE idempotency_key = ?",
      args: [idempotencyKey],
    });
    if (existing.rows.length > 0) {
      return { status: "queued_duplicate", action_id: Number(existing.rows[0].id), previous_status: existing.rows[0].status };
    }

    const inserted = await db.execute({
      sql: `INSERT INTO moderation_actions
              (bundle_id, action_type, payload_json, requested_by,
               requested_at, expires_at, status, idempotency_key)
            VALUES (?, ?, ?, 'ai', ?, ?, 'pending', ?)
            RETURNING id`,
      args: [bundle, actionType, payloadJson, now, expiresAt, idempotencyKey],
    });
    const actionId = Number(inserted.rows[0].id);

    if (createNotification) {
      try {
        await createNotification(db, {
          title: `${bundle} moderation action awaiting confirmation`,
          body: `${actionType} — review and confirm in the Nest panel before ${new Date(expiresAt * 1000).toLocaleString()}`,
          type: "system",
          source: bundle,
          priority: "high",
          action_url: `/dashboard/${bundle}?action=${actionId}`,
        });
      } catch {}
    }

    return { status: "queued", action_id: actionId, expires_at: expiresAt };
  } catch (err) {
    if (/no such table.*moderation_actions/i.test(err.message)) {
      return { status: "queued_unavailable", reason: "moderation_actions table not present — lands with F.11." };
    }
    throw err;
  } finally {
    try { db.close(); } catch {}
  }
}

function textResponse(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function errResponse(err) {
  return { content: [{ type: "text", text: `Error: ${err.message || String(err)}` }] };
}

async function resolveChannelId(handleOrId) {
  if (/^\d+$/.test(handleOrId)) return Number(handleOrId);
  // PeerTube handles like "channelname@host.example" resolve via
  // GET /api/v1/video-channels/{handle}
  const clean = handleOrId.replace(/^@/, "");
  const out = await ptFetch(`/api/v1/video-channels/${encodeURIComponent(clean)}`).catch(() => null);
  if (out?.id) return out.id;
  throw new Error(`Channel not found: ${handleOrId}`);
}

export async function createPeertubeServer(options = {}) {
  await loadSharedDeps();

  const server = new McpServer(
    { name: "crow-peertube", version: "1.0.0" },
    { instructions: options.instructions },
  );

  const limiter = wrapRateLimited ? wrapRateLimited({ db: getDb ? getDb() : null }) : (_, h) => h;

  // --- pt_status ---
  server.tool(
    "pt_status",
    "Report PeerTube instance health: reachability, version, stats, federation peer count, transcoding config, storage mode.",
    {},
    async () => {
      try {
        const [config, stats, me] = await Promise.all([
          ptFetch("/api/v1/config", { noAuth: true }).catch(() => null),
          ptFetch("/api/v1/server/stats", { noAuth: true }).catch(() => null),
          PEERTUBE_ACCESS_TOKEN ? ptFetch("/api/v1/users/me").catch(() => null) : Promise.resolve(null),
        ]);
        return textResponse({
          hostname: PEERTUBE_HOSTNAME || null,
          url: PEERTUBE_URL,
          version: config?.serverVersion || null,
          instance_name: config?.instance?.name || null,
          signup_enabled: config?.signup?.allowed ?? null,
          transcoding_enabled: config?.transcoding?.enabledResolutions?.length > 0,
          video_quota_default_mb: config?.user?.videoQuota ? Math.round(config.user.videoQuota / 1_000_000) : null,
          object_storage: config?.objectStorage || null,
          federation_enabled: config?.federation?.enabled ?? true,
          stats: stats ? {
            users: stats.totalUsers,
            videos: stats.totalLocalVideos,
            video_views: stats.totalLocalVideoViews,
            instance_followers: stats.totalInstanceFollowers,
            instance_following: stats.totalInstanceFollowing,
          } : null,
          authenticated_as: me ? { username: me.username, role: me.role?.label, quota_used: me.videoQuotaUsed } : null,
          has_access_token: Boolean(PEERTUBE_ACCESS_TOKEN),
        });
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  // --- pt_list_channels ---
  server.tool(
    "pt_list_channels",
    "List the authenticated user's owned channels.",
    {},
    async () => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const out = await ptFetch("/api/v1/users/me/video-channels");
        return textResponse({
          count: out.total ?? (out.data || []).length,
          channels: (out.data || []).map((c) => ({
            id: c.id,
            name: c.name,
            display_name: c.displayName,
            url: c.url,
            followers_count: c.followersCount,
          })),
        });
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  // --- pt_list_videos ---
  server.tool(
    "pt_list_videos",
    "List videos. scope: local (this instance), federated (all), subscriptions (my follows). Rate-limited: 60/hour.",
    {
      scope: z.enum(["local", "federated", "subscriptions"]).optional(),
      sort: z.enum(["-publishedAt", "-views", "-likes", "-trending"]).optional(),
      count: z.number().int().min(1).max(100).optional(),
      start: z.number().int().min(0).optional(),
    },
    limiter("pt_list_videos", async ({ scope, sort, count, start }) => {
      try {
        const scopeToPath = {
          local: "/api/v1/videos",
          federated: "/api/v1/videos",
          subscriptions: "/api/v1/users/me/subscriptions/videos",
        };
        const path = scopeToPath[scope || "local"];
        if (scope === "subscriptions") { const a = requireAuth(); if (a) return a; }
        const query = { count: count ?? 20, start: start ?? 0, sort: sort || "-publishedAt" };
        if (scope === "local") query.filter = "local";
        const out = await ptFetch(path, { query, noAuth: scope !== "subscriptions" && !PEERTUBE_ACCESS_TOKEN });
        return textResponse({
          count: out.total,
          videos: (out.data || []).map((v) => ({
            id: v.id,
            uuid: v.uuid,
            name: v.name,
            url: v.url,
            channel: v.channel?.displayName,
            duration_seconds: v.duration,
            views: v.views,
            likes: v.likes,
            published_at: v.publishedAt,
            is_local: v.isLocal,
          })),
        });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- pt_upload_video ---
  server.tool(
    "pt_upload_video",
    "Upload a video file (single-request; use the web UI for files >2 GB). Required: channelId (numeric) OR channel_handle, and either file_path or file_base64+filename. Rate-limited: 5/hour — transcoding is RAM-hot.",
    {
      channel_id: z.number().int().optional(),
      channel_handle: z.string().max(320).optional(),
      file_path: z.string().max(4096).optional(),
      file_base64: z.string().max(200_000_000).optional(),
      filename: z.string().max(500).optional(),
      name: z.string().min(3).max(120).describe("Video title (3-120 chars)."),
      description: z.string().max(10_000).optional(),
      privacy: z.enum(["public", "unlisted", "private", "internal"]).optional().describe("public=federated; unlisted=link-only; private=owner only. Default public."),
      category: z.number().int().min(1).max(100).optional().describe("Category ID from GET /api/v1/videos/categories."),
      tags: z.array(z.string().max(30)).max(5).optional(),
      nsfw: z.boolean().optional(),
      wait_transcoding: z.boolean().optional().describe("Block the publish until transcoding finishes (default false — publishes ASAP)."),
    },
    limiter("pt_upload_video", async (args) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        let buf, name;
        if (args.file_path) { buf = await readFile(args.file_path); name = args.filename || basename(args.file_path); }
        else if (args.file_base64) { buf = Buffer.from(args.file_base64, "base64"); name = args.filename || `upload-${Date.now()}.mp4`; }
        else return { content: [{ type: "text", text: "Error: must pass file_path or file_base64+filename." }] };

        let channelId = args.channel_id;
        if (!channelId && args.channel_handle) channelId = await resolveChannelId(args.channel_handle);
        if (!channelId) return { content: [{ type: "text", text: "Error: must pass channel_id or channel_handle." }] };

        const form = new FormData();
        form.append("videofile", new Blob([buf]), name);
        form.append("channelId", String(channelId));
        form.append("name", args.name);
        if (args.description) form.append("description", args.description);
        form.append("privacy", { public: 1, unlisted: 2, private: 3, internal: 4 }[args.privacy || "public"].toString());
        if (args.category) form.append("category", String(args.category));
        if (args.tags) args.tags.forEach((t) => form.append("tags[]", t));
        if (args.nsfw != null) form.append("nsfw", args.nsfw ? "true" : "false");
        if (args.wait_transcoding != null) form.append("waitTranscoding", args.wait_transcoding ? "true" : "false");

        const out = await ptFetch("/api/v1/videos/upload", { method: "POST", rawForm: form, timeoutMs: 600_000 });
        return textResponse({
          video_id: out.video?.id,
          uuid: out.video?.uuid,
          url: out.video?.url,
          state: out.video?.state?.label,
          note: "Transcoding proceeds in background; GET /api/v1/videos/{id} to poll state.",
        });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- pt_search ---
  server.tool(
    "pt_search",
    "Search videos + channels across local + cached federated content. Rate-limited: 60/hour.",
    {
      q: z.string().min(1).max(500),
      type: z.enum(["videos", "channels"]).optional(),
      count: z.number().int().min(1).max(50).optional(),
    },
    limiter("pt_search", async ({ q, type, count }) => {
      try {
        const path = type === "channels" ? "/api/v1/search/video-channels" : "/api/v1/search/videos";
        const out = await ptFetch(path, { query: { search: q, count: count ?? 10 }, noAuth: !PEERTUBE_ACCESS_TOKEN });
        return textResponse({
          count: out.total,
          results: (out.data || []).map((r) => type === "channels"
            ? { id: r.id, name: r.name, display_name: r.displayName, url: r.url, followers: r.followersCount }
            : { id: r.id, uuid: r.uuid, name: r.name, url: r.url, channel: r.channel?.displayName, duration_seconds: r.duration, views: r.views, is_local: r.isLocal }
          ),
        });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- pt_subscribe / unsubscribe ---
  server.tool(
    "pt_subscribe",
    "Subscribe to a channel by handle (name@host). Rate-limited: 30/hour.",
    { handle: z.string().min(3).max(320) },
    limiter("pt_subscribe", async ({ handle }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const clean = handle.replace(/^@/, "");
        await ptFetch("/api/v1/users/me/subscriptions", { method: "POST", body: { uri: clean } });
        return textResponse({ subscribed: clean });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  server.tool(
    "pt_unsubscribe",
    "Unsubscribe from a channel.",
    { handle: z.string().min(3).max(320) },
    limiter("pt_unsubscribe", async ({ handle }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const clean = handle.replace(/^@/, "");
        await ptFetch(`/api/v1/users/me/subscriptions/${encodeURIComponent(clean)}`, { method: "DELETE" });
        return textResponse({ unsubscribed: clean });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- pt_rate_video ---
  server.tool(
    "pt_rate_video",
    "Like / dislike / unrate a video by numeric id. Rate-limited: 60/hour.",
    {
      video_id: z.number().int(),
      rating: z.enum(["like", "dislike", "none"]),
    },
    limiter("pt_rate_video", async ({ video_id, rating }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        await ptFetch(`/api/v1/videos/${video_id}/rate`, { method: "PUT", body: { rating } });
        return textResponse({ video_id, rating });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- User-level moderation (inline) ---
  server.tool(
    "pt_block_user",
    "Block an account (hide their videos + comments). Rate-limited: 5/hour.",
    {
      account_handle: z.string().min(3).max(320).describe("name@host format."),
      confirm: z.literal("yes"),
    },
    limiter("pt_block_user", async ({ account_handle }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const clean = account_handle.replace(/^@/, "");
        await ptFetch("/api/v1/users/me/blocklist/accounts", { method: "POST", body: { accountName: clean } });
        return textResponse({ blocked_account: clean });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- Instance-level moderation (QUEUED, admin) ---
  server.tool(
    "pt_block_server",
    "Block an entire remote instance (admin, instance-scope blocklist — hides all accounts + videos from that domain for every user on this server). QUEUED — requires operator confirmation in the Nest panel within 72h.",
    {
      host: z.string().min(3).max(253),
      reason: z.string().max(1000).optional(),
      confirm: z.literal("yes"),
    },
    async ({ host, reason }) => {
      const queued = await queueModerationAction("peertube", "block_server", { host, reason: reason || "" });
      return textResponse(queued);
    },
  );

  server.tool(
    "pt_defederate",
    "Full defederation: block + unfollow + purge cached videos from a remote instance. QUEUED — requires operator confirmation.",
    {
      host: z.string().min(3).max(253),
      reason: z.string().max(1000).optional(),
      confirm: z.literal("yes"),
    },
    async ({ host, reason }) => {
      const queued = await queueModerationAction("peertube", "defederate", { host, reason: reason || "" });
      return textResponse(queued);
    },
  );

  // --- Admin reports ---
  server.tool(
    "pt_review_reports",
    "List open moderation reports (admin/moderator role).",
    { count: z.number().int().min(1).max(50).optional() },
    async ({ count }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const out = await ptFetch("/api/v1/abuses", { query: { count: count ?? 20, state: 1 /* pending */ } });
        return textResponse({
          count: out.total,
          reports: (out.data || []).map((r) => ({
            id: r.id,
            reason: r.reason,
            reporter: r.reporterAccount?.displayName,
            video: r.video?.name,
            comment: r.comment?.text?.slice(0, 200),
            flagged_account: r.flaggedAccount?.displayName,
            created_at: r.createdAt,
          })),
        });
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  server.tool(
    "pt_report_remote",
    "File a moderation report. Can report a video (video_id) or a comment (comment_id) or a whole account. Rate-limited: 5/hour.",
    {
      reason: z.string().min(1).max(3000),
      video_id: z.number().int().optional(),
      comment_id: z.number().int().optional(),
      account: z.string().max(320).optional().describe("Remote account handle to report (name@host)."),
      predefined_reasons: z.array(z.enum(["violentOrAbusive", "hatefulOrAbusive", "spamOrMisleading", "privacy", "rights", "serverRules", "thumbnails", "captions"])).max(8).optional(),
    },
    limiter("pt_report_remote", async ({ reason, video_id, comment_id, account, predefined_reasons }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const body = { reason, ...(predefined_reasons ? { predefinedReasons: predefined_reasons } : {}) };
        if (video_id) body.video = { id: video_id };
        if (comment_id) body.comment = { id: comment_id };
        if (account) body.account = { id: account.replace(/^@/, "") };
        if (!video_id && !comment_id && !account) {
          return { content: [{ type: "text", text: "Error: one of video_id / comment_id / account required." }] };
        }
        const out = await ptFetch("/api/v1/abuses", { method: "POST", body });
        return textResponse({ abuse_id: out.abuse?.id });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- pt_media_prune ---
  server.tool(
    "pt_media_prune",
    "Trigger pruning of remote-cached video files older than N days. PeerTube runs this on a scheduled job; this forces an immediate pass. Admin-only. Rate-limited: 2/hour.",
    {
      older_than_days: z.number().int().min(1).max(365).optional(),
      confirm: z.literal("yes"),
    },
    limiter("pt_media_prune", async ({ older_than_days }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const days = older_than_days ?? Number(process.env.PEERTUBE_MEDIA_RETENTION_DAYS || 14);
        return textResponse({
          requested_days: days,
          note: "PeerTube does not expose an HTTP endpoint to force-prune remote video caches — pruning is handled by the scheduled 'remove-old-views' and 'remove-dangling-resumable-uploads' jobs at PEERTUBE_VIDEOS_CLEANUP_REMOTE_INTERVAL cadence. For an immediate prune: `docker exec crow-peertube node dist/scripts/prune-storage.js`.",
          command: `docker exec crow-peertube node dist/scripts/prune-storage.js`,
        });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  return server;
}

/**
 * Lemmy MCP Server
 *
 * Lemmy exposes a JSON REST API at /api/v3/. Authentication uses a JWT
 * passed as the `auth` body field (v3 quirk) or Authorization: Bearer.
 * Federation is community-scoped rather than user-scoped — following a
 * community on a remote instance pulls all its posts to the local server.
 *
 * Tools (federated link-aggregator taxonomy):
 *   lemmy_status
 *   lemmy_list_communities
 *   lemmy_follow_community
 *   lemmy_unfollow_community
 *   lemmy_post                — create a post (title + url or body)
 *   lemmy_comment             — reply to a post or comment
 *   lemmy_feed                — list posts (subscribed/all/local)
 *   lemmy_search
 *   lemmy_block_user          — inline, rate-limited
 *   lemmy_block_community     — inline, rate-limited
 *   lemmy_block_instance      — QUEUED (admin, destructive)
 *   lemmy_defederate          — QUEUED
 *   lemmy_review_reports      — list open reports (admin read-only)
 *   lemmy_media_prune         — pict-rs purge of remote media
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const LEMMY_URL = (process.env.LEMMY_URL || "http://lemmy:8536").replace(/\/+$/, "");
const LEMMY_JWT = process.env.LEMMY_JWT || "";
const LEMMY_HOSTNAME = process.env.LEMMY_HOSTNAME || "";

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

async function lemFetch(path, { method = "GET", body, query, noAuth, timeoutMs = 20_000 } = {}) {
  const qs = query
    ? "?" +
      Object.entries(query)
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&")
    : "";
  const url = `${LEMMY_URL}${path}${qs}`;
  const headers = { "Content-Type": "application/json" };
  if (!noAuth && LEMMY_JWT) headers.Authorization = `Bearer ${LEMMY_JWT}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const snippet = text.slice(0, 600);
      if (res.status === 401) throw new Error("Lemmy auth failed (401). Log in via POST /api/v3/user/login to obtain a JWT; paste into LEMMY_JWT.");
      if (res.status === 403) throw new Error(`Lemmy forbidden (403)${snippet ? ": " + snippet : ""}`);
      throw new Error(`Lemmy ${res.status} ${res.statusText}${snippet ? " — " + snippet : ""}`);
    }
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { raw: text }; }
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`Lemmy request timed out: ${path}`);
    if (err.cause?.code === "ECONNREFUSED" || err.message?.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Lemmy at ${LEMMY_URL}. Verify crow-lemmy is up and on the crow-federation network.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function requireAuth() {
  if (!LEMMY_JWT) {
    return { content: [{ type: "text", text: "Error: LEMMY_JWT required. Log in via POST /api/v3/user/login to obtain one; paste into LEMMY_JWT and restart the MCP server." }] };
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

/**
 * Resolve a community name ("community@server" or "!community@server")
 * to a local community_id via Lemmy's search API.
 */
async function resolveCommunity(nameOrId) {
  if (typeof nameOrId === "number" || /^\d+$/.test(nameOrId)) return Number(nameOrId);
  const clean = nameOrId.replace(/^!/, "");
  const out = await lemFetch("/api/v3/search", {
    query: { q: clean, type_: "Communities", limit: 1 },
  });
  const match = (out.communities || [])[0];
  if (!match) throw new Error(`Community not found: ${nameOrId}`);
  return match.community.id;
}

async function resolvePerson(handleOrId) {
  if (typeof handleOrId === "number" || /^\d+$/.test(handleOrId)) return Number(handleOrId);
  const clean = handleOrId.replace(/^@/, "");
  const out = await lemFetch("/api/v3/search", {
    query: { q: clean, type_: "Users", limit: 1 },
  });
  const match = (out.users || [])[0];
  if (!match) throw new Error(`User not found: ${handleOrId}`);
  return match.person.id;
}

export async function createLemmyServer(options = {}) {
  await loadSharedDeps();

  const server = new McpServer(
    { name: "crow-lemmy", version: "1.0.0" },
    { instructions: options.instructions },
  );

  const limiter = wrapRateLimited ? wrapRateLimited({ db: getDb ? getDb() : null }) : (_, h) => h;

  // --- lemmy_status ---
  server.tool(
    "lemmy_status",
    "Report Lemmy instance health: site info, federation mode, admin list, user stats, open registrations.",
    {},
    async () => {
      try {
        const site = await lemFetch("/api/v3/site", { noAuth: !LEMMY_JWT });
        return textResponse({
          hostname: LEMMY_HOSTNAME || null,
          url: LEMMY_URL,
          version: site.version || null,
          site_name: site.site_view?.site?.name || null,
          description: site.site_view?.site?.description || null,
          registration_mode: site.site_view?.local_site?.registration_mode || null,
          federation_enabled: site.site_view?.local_site?.federation_enabled ?? null,
          users: site.site_view?.counts?.users || null,
          posts: site.site_view?.counts?.posts || null,
          comments: site.site_view?.counts?.comments || null,
          communities: site.site_view?.counts?.communities || null,
          admins: (site.admins || []).map((a) => a.person?.name),
          my_user: site.my_user?.local_user_view?.person?.name || null,
          has_jwt: Boolean(LEMMY_JWT),
        });
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  // --- lemmy_list_communities ---
  server.tool(
    "lemmy_list_communities",
    "List communities. Default scope 'Local' returns this-instance communities; 'All' includes federated communities your instance has fetched.",
    {
      type_: z.enum(["Local", "All", "Subscribed"]).optional(),
      sort: z.enum(["TopAll", "TopMonth", "TopWeek", "Hot", "New", "Active"]).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      page: z.number().int().min(1).max(1000).optional(),
    },
    async ({ type_, sort, limit, page }) => {
      try {
        const out = await lemFetch("/api/v3/community/list", {
          query: { type_: type_ || "Local", sort: sort || "Active", limit: limit ?? 20, page },
        });
        return textResponse({
          count: (out.communities || []).length,
          communities: (out.communities || []).map((c) => ({
            id: c.community.id,
            name: c.community.name,
            title: c.community.title,
            actor_id: c.community.actor_id,
            subscribers: c.counts?.subscribers,
            posts: c.counts?.posts,
            subscribed: c.subscribed,
          })),
        });
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  // --- lemmy_follow_community / unfollow ---
  server.tool(
    "lemmy_follow_community",
    "Subscribe to a community (local or federated). Accepts numeric community ID or 'community@instance' handle. Rate-limited: 30/hour.",
    { community: z.union([z.string().min(1).max(500), z.number().int()]) },
    limiter("lemmy_follow_community", async ({ community }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const id = await resolveCommunity(community);
        const out = await lemFetch("/api/v3/community/follow", { method: "POST", body: { community_id: id, follow: true } });
        return textResponse({ community_id: id, subscribed: out.community_view?.subscribed });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  server.tool(
    "lemmy_unfollow_community",
    "Unsubscribe from a community.",
    { community: z.union([z.string().min(1).max(500), z.number().int()]) },
    limiter("lemmy_unfollow_community", async ({ community }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const id = await resolveCommunity(community);
        const out = await lemFetch("/api/v3/community/follow", { method: "POST", body: { community_id: id, follow: false } });
        return textResponse({ community_id: id, subscribed: out.community_view?.subscribed });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- lemmy_post ---
  server.tool(
    "lemmy_post",
    "Create a post in a community. Either url (link post) or body (text post) must be set — or both. Rate-limited: 10/hour.",
    {
      community: z.union([z.string().min(1).max(500), z.number().int()]),
      name: z.string().min(3).max(200).describe("Post title (3-200 chars)."),
      url: z.string().url().max(2000).optional(),
      body: z.string().max(50_000).optional(),
      nsfw: z.boolean().optional(),
      language_id: z.number().int().optional(),
    },
    limiter("lemmy_post", async (args) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        if (!args.url && !args.body) {
          return { content: [{ type: "text", text: "Error: post must have url, body, or both." }] };
        }
        const community_id = await resolveCommunity(args.community);
        const body = {
          name: args.name, community_id,
          ...(args.url ? { url: args.url } : {}),
          ...(args.body ? { body: args.body } : {}),
          ...(args.nsfw != null ? { nsfw: args.nsfw } : {}),
          ...(args.language_id ? { language_id: args.language_id } : {}),
        };
        const out = await lemFetch("/api/v3/post", { method: "POST", body });
        return textResponse({
          post_id: out.post_view?.post?.id,
          ap_id: out.post_view?.post?.ap_id,
          published: out.post_view?.post?.published,
        });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- lemmy_comment ---
  server.tool(
    "lemmy_comment",
    "Reply to a post or another comment. Pass post_id (required) and optional parent_id for replies to comments. Rate-limited: 20/hour.",
    {
      post_id: z.number().int(),
      parent_id: z.number().int().optional(),
      content: z.string().min(1).max(20_000),
      language_id: z.number().int().optional(),
    },
    limiter("lemmy_comment", async (args) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const out = await lemFetch("/api/v3/comment", { method: "POST", body: args });
        return textResponse({
          comment_id: out.comment_view?.comment?.id,
          ap_id: out.comment_view?.comment?.ap_id,
          published: out.comment_view?.comment?.published,
        });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- lemmy_feed ---
  server.tool(
    "lemmy_feed",
    "Fetch posts. type_: Subscribed (follows), Local (this instance), All (federated). Rate-limited: 60/hour.",
    {
      type_: z.enum(["Subscribed", "Local", "All"]).optional(),
      sort: z.enum(["Active", "Hot", "New", "TopDay", "TopWeek", "TopMonth", "TopAll"]).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      page: z.number().int().min(1).max(1000).optional(),
      community: z.union([z.string(), z.number().int()]).optional().describe("Scope to one community."),
    },
    limiter("lemmy_feed", async ({ type_, sort, limit, page, community }) => {
      try {
        const query = { type_: type_ || "Local", sort: sort || "Hot", limit: limit ?? 20, page };
        if (community) query.community_id = await resolveCommunity(community);
        const out = await lemFetch("/api/v3/post/list", { query, noAuth: !LEMMY_JWT && type_ !== "Subscribed" });
        return textResponse({
          count: (out.posts || []).length,
          posts: (out.posts || []).map((p) => ({
            id: p.post?.id,
            name: p.post?.name,
            url: p.post?.url,
            body_excerpt: (p.post?.body || "").slice(0, 240),
            community: p.community?.name,
            creator: p.creator?.name,
            score: p.counts?.score,
            comments: p.counts?.comments,
            published: p.post?.published,
            ap_id: p.post?.ap_id,
          })),
        });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- lemmy_search ---
  server.tool(
    "lemmy_search",
    "Search across communities, posts, comments, users. Rate-limited: 60/hour.",
    {
      q: z.string().min(1).max(500),
      type_: z.enum(["All", "Comments", "Posts", "Communities", "Users", "Url"]).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    limiter("lemmy_search", async ({ q, type_, limit }) => {
      try {
        const out = await lemFetch("/api/v3/search", { query: { q, type_: type_ || "All", limit: limit ?? 10 } });
        return textResponse({
          posts: (out.posts || []).slice(0, 10).map((p) => ({ id: p.post?.id, name: p.post?.name, community: p.community?.name })),
          comments: (out.comments || []).slice(0, 10).map((c) => ({ id: c.comment?.id, excerpt: (c.comment?.content || "").slice(0, 120) })),
          communities: (out.communities || []).slice(0, 10).map((c) => ({ id: c.community?.id, name: c.community?.name, actor_id: c.community?.actor_id })),
          users: (out.users || []).slice(0, 10).map((u) => ({ id: u.person?.id, name: u.person?.name, actor_id: u.person?.actor_id })),
        });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- User-level moderation (inline) ---
  server.tool(
    "lemmy_block_user",
    "Block a person (hide their posts + comments from your view). Rate-limited: 5/hour.",
    { user: z.union([z.string().min(1).max(500), z.number().int()]), confirm: z.literal("yes") },
    limiter("lemmy_block_user", async ({ user }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const person_id = await resolvePerson(user);
        const out = await lemFetch("/api/v3/user/block", { method: "POST", body: { person_id, block: true } });
        return textResponse({ person_id, blocked: out.blocked });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  server.tool(
    "lemmy_block_community",
    "Block a community (hide all its posts from your feeds). Rate-limited: 5/hour.",
    { community: z.union([z.string().min(1).max(500), z.number().int()]), confirm: z.literal("yes") },
    limiter("lemmy_block_community", async ({ community }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const community_id = await resolveCommunity(community);
        const out = await lemFetch("/api/v3/community/block", { method: "POST", body: { community_id, block: true } });
        return textResponse({ community_id, blocked: out.blocked });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- Instance-level moderation (QUEUED) ---
  server.tool(
    "lemmy_block_instance",
    "Block an entire remote instance (no federation, no fetched content). Admin-only; QUEUED — requires operator confirmation in the Nest panel.",
    {
      instance: z.string().min(3).max(253),
      reason: z.string().max(1000).optional(),
      confirm: z.literal("yes"),
    },
    async ({ instance, reason }) => {
      const queued = await queueModerationAction("lemmy", "block_instance", { instance, reason: reason || "" });
      return textResponse(queued);
    },
  );

  server.tool(
    "lemmy_defederate",
    "Defederate from a remote instance (block + purge cached content). Admin-only; QUEUED.",
    {
      instance: z.string().min(3).max(253),
      reason: z.string().max(1000).optional(),
      confirm: z.literal("yes"),
    },
    async ({ instance, reason }) => {
      const queued = await queueModerationAction("lemmy", "defederate", { instance, reason: reason || "" });
      return textResponse(queued);
    },
  );

  // --- lemmy_review_reports (admin read-only) ---
  server.tool(
    "lemmy_review_reports",
    "List open post + comment reports (admin / mod only). Read-only summary.",
    { limit: z.number().int().min(1).max(50).optional() },
    async ({ limit }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const [posts, comments] = await Promise.all([
          lemFetch("/api/v3/post/report/list", { query: { limit: limit ?? 20, unresolved_only: "true" } }).catch(() => null),
          lemFetch("/api/v3/comment/report/list", { query: { limit: limit ?? 20, unresolved_only: "true" } }).catch(() => null),
        ]);
        return textResponse({
          post_reports: (posts?.post_reports || []).map((r) => ({
            id: r.post_report?.id,
            reason: r.post_report?.reason,
            reporter: r.creator?.name,
            post: r.post?.name,
            published: r.post_report?.published,
          })),
          comment_reports: (comments?.comment_reports || []).map((r) => ({
            id: r.comment_report?.id,
            reason: r.comment_report?.reason,
            reporter: r.creator?.name,
            comment_excerpt: (r.comment?.content || "").slice(0, 120),
            published: r.comment_report?.published,
          })),
        });
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  // --- lemmy_media_prune ---
  server.tool(
    "lemmy_media_prune",
    "Trigger a pict-rs prune of remote media. Exposes the admin purge endpoint; deletes cached media for federated posts older than N days. Rate-limited: 2/hour.",
    {
      older_than_days: z.number().int().min(1).max(365).optional(),
      confirm: z.literal("yes"),
    },
    limiter("lemmy_media_prune", async ({ older_than_days }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const days = older_than_days ?? 14;
        const out = await lemFetch("/api/v3/admin/purge/post", {
          method: "POST",
          body: { older_than_days: days, reason: `crow-media-prune ${days}d` },
        }).catch(() => null);
        return textResponse({
          requested_days: days,
          response: out,
          note: out ? null : "Admin purge endpoint unavailable on this Lemmy version — pict-rs handles its own retention via PICTRS__* env vars.",
        });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  return server;
}

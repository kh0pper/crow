/**
 * GoToSocial MCP Server
 *
 * Exposes the fediverse surface — post statuses, browse timelines, search,
 * follow remote actors, moderate — through Crow's MCP layer. Talks to
 * GoToSocial via its Mastodon-compatible REST API so the same patterns
 * transfer to the Mastodon bundle in F.7.
 *
 * Tool shape matches the plan's "consistent verbs across apps":
 *   gts_status, gts_post, gts_feed, gts_search, gts_follow, gts_unfollow,
 *   gts_block_user, gts_mute_user, gts_block_domain, gts_defederate,
 *   gts_review_reports, gts_report_remote, gts_import_blocklist,
 *   gts_media_prune
 *
 * Rate limiting:
 *   Content-producing and moderation tools are wrapped with the shared
 *   token-bucket limiter (servers/shared/rate-limiter.js). In "installed
 *   to ~/.crow/bundles/" mode the shared module may not resolve — in
 *   that case the wrapper falls back to pass-through, matching the
 *   knowledge-base / media bundle convention. Crow's main MCP
 *   installation (first-party monorepo mode) gets real rate limiting.
 *
 * Human-in-the-loop moderation:
 *   *_defederate and *_import_blocklist don't fire inline. They INSERT a
 *   pending row in moderation_actions + raise a Crow notification, and
 *   the operator confirms from the Nest panel. Implementation note: in
 *   F.1 we log a "queued" response and store the action against Crow's
 *   main DB when available. The Nest-panel confirmation UI lands with
 *   F.11 / F.12; until then the moderation queue accumulates pending
 *   rows an operator applies manually.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const GTS_URL = (process.env.GTS_URL || "http://gotosocial:8080").replace(/\/+$/, "");
const GTS_ACCESS_TOKEN = process.env.GTS_ACCESS_TOKEN || "";

// --- Lazy shared-dep imports (pattern borrowed from knowledge-base) ---

let wrapRateLimited = null;
let getDb = null;
let createNotification = null;

async function loadSharedDeps() {
  try {
    const rl = await import("../../../servers/shared/rate-limiter.js");
    wrapRateLimited = rl.wrapRateLimited;
  } catch {
    // Installed-mode fallback: no-op wrapper
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

// --- HTTP helper (Mastodon-compatible API) ---

async function gtsFetch(path, { method = "GET", body, query, noAuth } = {}) {
  const qs = query
    ? "?" +
      Object.entries(query)
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) =>
          Array.isArray(v)
            ? v.map((x) => `${encodeURIComponent(k + "[]")}=${encodeURIComponent(x)}`).join("&")
            : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
        )
        .join("&")
    : "";
  const url = `${GTS_URL}${path}${qs}`;

  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (!noAuth && GTS_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${GTS_ACCESS_TOKEN}`;
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const snippet = text.slice(0, 500);
      if (res.status === 401) {
        throw new Error(
          `GoToSocial auth failed (401). Set GTS_ACCESS_TOKEN (generate via: docker exec crow-gotosocial ./gotosocial admin account create-token).`,
        );
      }
      throw new Error(`GoToSocial ${res.status} ${res.statusText}${snippet ? " — " + snippet : ""}`);
    }
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`GoToSocial request timed out: ${path}`);
    if (err.cause?.code === "ECONNREFUSED" || err.message?.includes("ECONNREFUSED")) {
      throw new Error(
        `Cannot reach GoToSocial at ${GTS_URL}. Verify the container is on the crow-federation network and running (docker ps | grep crow-gotosocial).`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Queue a destructive moderation action (defederate / import_blocklist).
 * Writes to moderation_actions + creates a Crow notification when a DB
 * handle is available. Returns a structured "queued" response.
 */
async function queueModerationAction(bundle, actionType, payload) {
  if (!getDb) {
    return {
      status: "queued_offline",
      reason:
        "Crow database not reachable from bundle — moderation queue unavailable. Action NOT applied. Install Crow in monorepo mode or wait for F.11 bundle-connection work.",
      requested: { action_type: actionType, payload },
    };
  }
  const db = getDb();
  try {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 72 * 3600;
    const payloadJson = JSON.stringify(payload);
    const { createHash } = await import("node:crypto");
    const idempotencyKey = createHash("sha256")
      .update(`${bundle}:${actionType}:${payloadJson}`)
      .digest("hex");

    // Check for existing pending row (idempotency)
    const existing = await db.execute({
      sql: "SELECT id, expires_at, status FROM moderation_actions WHERE idempotency_key = ?",
      args: [idempotencyKey],
    });
    if (existing.rows.length > 0) {
      return {
        status: "queued_duplicate",
        action_id: Number(existing.rows[0].id),
        previous_status: existing.rows[0].status,
      };
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
          body: `${actionType} — review and confirm in the Nest panel before ${new Date(
            expiresAt * 1000,
          ).toLocaleString()}`,
          type: "system",
          source: bundle,
          priority: "high",
          action_url: `/dashboard/${bundle}?action=${actionId}`,
        });
      } catch {
        // Notification schema may be different across versions; don't let
        // notification failure block queuing
      }
    }

    return { status: "queued", action_id: actionId, expires_at: expiresAt };
  } catch (err) {
    if (/no such table.*moderation_actions/i.test(err.message)) {
      return {
        status: "queued_unavailable",
        reason:
          "moderation_actions table not present — queued action could not be persisted. This table lands with F.11; until then, destructive moderation verbs are unavailable.",
      };
    }
    throw err;
  } finally {
    try { db.close(); } catch {}
  }
}

export async function createGotosocialServer(options = {}) {
  await loadSharedDeps();

  const server = new McpServer(
    { name: "crow-gotosocial", version: "1.0.0" },
    { instructions: options.instructions },
  );

  const limiter = wrapRateLimited
    ? wrapRateLimited({ db: getDb ? getDb() : null })
    : (_, h) => h;

  // --- gts_status ---
  server.tool(
    "gts_status",
    "Report GoToSocial instance health: reachability, admin account status, federation peer count, pending notifications, disk usage of the local media cache.",
    {},
    async () => {
      try {
        const [instance, peers, account] = await Promise.all([
          gtsFetch("/api/v1/instance"),
          gtsFetch("/api/v1/instance/peers").catch(() => []),
          GTS_ACCESS_TOKEN ? gtsFetch("/api/v1/accounts/verify_credentials").catch(() => null) : Promise.resolve(null),
        ]);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              instance: {
                uri: instance.uri,
                title: instance.title,
                version: instance.version,
                registrations: instance.registrations,
                stats: instance.stats,
              },
              authenticated_as: account ? { id: account.id, acct: account.acct, display_name: account.display_name } : null,
              federated_peers: Array.isArray(peers) ? peers.length : null,
              has_access_token: Boolean(GTS_ACCESS_TOKEN),
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  // --- gts_post ---
  server.tool(
    "gts_post",
    "Publish a status (toot) to the fediverse. Content is public by default unless visibility is narrowed. Rate-limited: 10/hour per conversation.",
    {
      status: z.string().min(1).max(5000).describe("Post body (GoToSocial accepts up to 5000 chars; remote servers may truncate)."),
      visibility: z.enum(["public", "unlisted", "private", "direct"]).optional().describe("public = federated + on public timelines; unlisted = federated but not on public timelines; private = followers only; direct = DM-like. Default public."),
      spoiler_text: z.string().max(500).optional().describe("Content warning shown before the body."),
      in_reply_to_id: z.string().max(50).optional().describe("Status ID to reply to."),
      language: z.string().length(2).optional().describe("ISO 639-1 language code (e.g., en)."),
    },
    limiter("gts_post", async (args) => {
      try {
        if (!GTS_ACCESS_TOKEN) {
          return { content: [{ type: "text", text: "Error: GTS_ACCESS_TOKEN not set — cannot post." }] };
        }
        const body = {
          status: args.status,
          visibility: args.visibility || "public",
          ...(args.spoiler_text ? { spoiler_text: args.spoiler_text } : {}),
          ...(args.in_reply_to_id ? { in_reply_to_id: args.in_reply_to_id } : {}),
          ...(args.language ? { language: args.language } : {}),
        };
        const status = await gtsFetch("/api/v1/statuses", { method: "POST", body });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              id: status.id,
              url: status.url,
              uri: status.uri,
              visibility: status.visibility,
              created_at: status.created_at,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }),
  );

  // --- gts_feed ---
  server.tool(
    "gts_feed",
    "Fetch a timeline. Choices: home (authenticated user's follows), public (local+federated), local (this instance only), notifications (mentions/replies/reblogs/follows targeting the authenticated user).",
    {
      source: z.enum(["home", "public", "local", "notifications"]).describe("Which timeline."),
      limit: z.number().int().min(1).max(40).optional().describe("Max items to return (default 20)."),
      since_id: z.string().max(50).optional().describe("Return items newer than this ID."),
      max_id: z.string().max(50).optional().describe("Return items older than this ID."),
    },
    limiter("gts_feed", async ({ source, limit, since_id, max_id }) => {
      try {
        if (source !== "public" && !GTS_ACCESS_TOKEN) {
          return { content: [{ type: "text", text: "Error: non-public timelines require GTS_ACCESS_TOKEN." }] };
        }
        const path =
          source === "home" ? "/api/v1/timelines/home"
          : source === "public" ? "/api/v1/timelines/public"
          : source === "local" ? "/api/v1/timelines/public"
          : "/api/v1/notifications";
        const query = { limit: limit ?? 20, since_id, max_id };
        if (source === "local") query.local = "true";
        const items = await gtsFetch(path, { query, noAuth: source === "public" && !GTS_ACCESS_TOKEN });
        const summary = (Array.isArray(items) ? items : []).map((it) =>
          source === "notifications"
            ? { id: it.id, type: it.type, account: it.account?.acct, status_id: it.status?.id, created_at: it.created_at }
            : { id: it.id, acct: it.account?.acct, url: it.url, content_excerpt: (it.content || "").replace(/<[^>]+>/g, "").slice(0, 240), created_at: it.created_at, visibility: it.visibility, reblogs: it.reblogs_count, favs: it.favourites_count },
        );
        return { content: [{ type: "text", text: JSON.stringify({ count: summary.length, items: summary }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }),
  );

  // --- gts_search ---
  server.tool(
    "gts_search",
    "Search accounts / hashtags / statuses across the fediverse. Remote queries resolve via WebFinger. Rate-limited: 60/hour.",
    {
      query: z.string().min(1).max(500).describe("Search string. Prefix with @ for accounts, # for tags, or a full URL to resolve a remote status."),
      type: z.enum(["accounts", "hashtags", "statuses"]).optional().describe("Narrow to one result kind."),
      limit: z.number().int().min(1).max(40).optional().describe("Max results per category."),
      resolve: z.boolean().optional().describe("If true, hit WebFinger to resolve remote handles."),
    },
    limiter("gts_search", async ({ query, type, limit, resolve }) => {
      try {
        const out = await gtsFetch("/api/v2/search", {
          query: { q: query, type, limit: limit ?? 10, resolve: resolve ? "true" : undefined },
        });
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }),
  );

  // --- gts_follow / gts_unfollow ---
  server.tool(
    "gts_follow",
    "Follow an account by handle (@user@domain) or local account ID. Rate-limited: 30/hour.",
    { handle: z.string().min(1).max(320).describe("Handle (@user@example.com) or account ID.") },
    limiter("gts_follow", async ({ handle }) => {
      try {
        let accountId = handle;
        if (handle.startsWith("@") || handle.includes("@")) {
          const search = await gtsFetch("/api/v2/search", { query: { q: handle.replace(/^@/, ""), type: "accounts", resolve: "true", limit: 1 } });
          const match = (search.accounts || [])[0];
          if (!match) return { content: [{ type: "text", text: `No account found for ${handle}` }] };
          accountId = match.id;
        }
        const rel = await gtsFetch(`/api/v1/accounts/${encodeURIComponent(accountId)}/follow`, { method: "POST" });
        return { content: [{ type: "text", text: JSON.stringify({ following: rel.following, requested: rel.requested, showing_reblogs: rel.showing_reblogs }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }),
  );

  server.tool(
    "gts_unfollow",
    "Unfollow an account.",
    { handle: z.string().min(1).max(320) },
    limiter("gts_unfollow", async ({ handle }) => {
      try {
        let accountId = handle;
        if (handle.startsWith("@") || handle.includes("@")) {
          const search = await gtsFetch("/api/v2/search", { query: { q: handle.replace(/^@/, ""), type: "accounts", resolve: "true", limit: 1 } });
          const match = (search.accounts || [])[0];
          if (!match) return { content: [{ type: "text", text: `No account found for ${handle}` }] };
          accountId = match.id;
        }
        const rel = await gtsFetch(`/api/v1/accounts/${encodeURIComponent(accountId)}/unfollow`, { method: "POST" });
        return { content: [{ type: "text", text: JSON.stringify({ following: rel.following }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }),
  );

  // --- User-level moderation (inline, rate-limited) ---
  server.tool(
    "gts_block_user",
    "Block an account system-wide (the authenticated user no longer sees their posts and vice versa). Rate-limited: 5/hour.",
    {
      handle: z.string().min(1).max(320),
      confirm: z.literal("yes").describe('Must be "yes" — advisory only; rate limiter is the real gate for user-level blocks.'),
    },
    limiter("gts_block_user", async ({ handle }) => {
      try {
        const search = await gtsFetch("/api/v2/search", { query: { q: handle.replace(/^@/, ""), type: "accounts", resolve: "true", limit: 1 } });
        const match = (search.accounts || [])[0];
        if (!match) return { content: [{ type: "text", text: `No account found for ${handle}` }] };
        const rel = await gtsFetch(`/api/v1/accounts/${match.id}/block`, { method: "POST" });
        return { content: [{ type: "text", text: JSON.stringify({ blocking: rel.blocking }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }),
  );

  server.tool(
    "gts_mute_user",
    "Mute an account (hide posts but still federate). Rate-limited: 5/hour.",
    { handle: z.string().min(1).max(320), confirm: z.literal("yes") },
    limiter("gts_mute_user", async ({ handle }) => {
      try {
        const search = await gtsFetch("/api/v2/search", { query: { q: handle.replace(/^@/, ""), type: "accounts", resolve: "true", limit: 1 } });
        const match = (search.accounts || [])[0];
        if (!match) return { content: [{ type: "text", text: `No account found for ${handle}` }] };
        const rel = await gtsFetch(`/api/v1/accounts/${match.id}/mute`, { method: "POST" });
        return { content: [{ type: "text", text: JSON.stringify({ muting: rel.muting }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }),
  );

  // --- Instance-level moderation (queued: destructive, requires Nest click) ---
  server.tool(
    "gts_block_domain",
    "Block an entire remote domain (no federation, no media fetch). QUEUED — requires operator confirmation in the Nest panel before firing.",
    {
      domain: z.string().min(1).max(253),
      reason: z.string().max(500).optional(),
      confirm: z.literal("yes"),
    },
    async ({ domain, reason }) => {
      const queued = await queueModerationAction("gotosocial", "block_domain", { domain, reason: reason || "" });
      return { content: [{ type: "text", text: JSON.stringify(queued, null, 2) }] };
    },
  );

  server.tool(
    "gts_defederate",
    "Defederate from a remote domain (stop all ActivityPub interaction). Stronger than block_domain — existing follow relationships are severed. QUEUED — requires operator confirmation.",
    {
      domain: z.string().min(1).max(253),
      reason: z.string().max(500).optional(),
      confirm: z.literal("yes"),
    },
    async ({ domain, reason }) => {
      const queued = await queueModerationAction("gotosocial", "defederate", { domain, reason: reason || "" });
      return { content: [{ type: "text", text: JSON.stringify(queued, null, 2) }] };
    },
  );

  server.tool(
    "gts_review_reports",
    "List pending moderation reports (local + federated). Read-only.",
    { limit: z.number().int().min(1).max(100).optional() },
    async ({ limit }) => {
      try {
        const reports = await gtsFetch("/api/v1/admin/reports", { query: { limit: limit ?? 20, resolved: "false" } });
        const summary = (Array.isArray(reports) ? reports : []).map((r) => ({
          id: r.id,
          account: r.account?.acct,
          target_account: r.target_account?.acct,
          reason: r.category || r.comment,
          created_at: r.created_at,
        }));
        return { content: [{ type: "text", text: JSON.stringify({ count: summary.length, reports: summary }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "gts_report_remote",
    "Send a moderation report to a remote server about one of their accounts.",
    {
      handle: z.string().min(1).max(320),
      reason: z.string().min(1).max(1000),
      forward: z.boolean().optional().describe("Forward the report to the remote's moderators."),
    },
    limiter("gts_report_remote", async ({ handle, reason, forward }) => {
      try {
        const search = await gtsFetch("/api/v2/search", { query: { q: handle.replace(/^@/, ""), type: "accounts", resolve: "true", limit: 1 } });
        const match = (search.accounts || [])[0];
        if (!match) return { content: [{ type: "text", text: `No account found for ${handle}` }] };
        const body = { account_id: match.id, comment: reason, forward: forward !== false };
        const out = await gtsFetch("/api/v1/reports", { method: "POST", body });
        return { content: [{ type: "text", text: JSON.stringify({ report_id: out.id, forwarded: body.forward }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }),
  );

  server.tool(
    "gts_import_blocklist",
    "Import a domain blocklist (IFTAS / The Bad Space / custom URL, one domain per line). QUEUED — requires operator confirmation before any domains are blocked. Rate-limited: 2/hour.",
    {
      source: z.string().min(1).max(500).describe("URL or 'iftas' / 'bad-space' for canonical sources."),
      confirm: z.literal("yes"),
    },
    limiter("gts_import_blocklist", async ({ source }) => {
      const canonical = {
        iftas: "https://connect.iftas.org/library/iftas-documentation/iftas-do-not-interact-list/",
        "bad-space": "https://badspace.org/domain-block.csv",
      };
      const url = canonical[source] || source;
      const queued = await queueModerationAction("gotosocial", "import_blocklist", { source: url });
      return { content: [{ type: "text", text: JSON.stringify(queued, null, 2) }] };
    }),
  );

  // --- Disk / media management ---
  server.tool(
    "gts_media_prune",
    "Manually trigger pruning of remote media older than N days. The scheduled cron (scripts/media-prune.sh) runs daily; this lets operators force an aggressive prune.",
    { older_than_days: z.number().int().min(1).max(365).optional().describe("Default 14 (or 7 on Pi-class hosts).") },
    async ({ older_than_days }) => {
      try {
        if (!GTS_ACCESS_TOKEN) {
          return { content: [{ type: "text", text: "Error: GTS_ACCESS_TOKEN required to invoke admin media prune." }] };
        }
        const days = older_than_days ?? Number(process.env.GTS_MEDIA_RETENTION_DAYS || 14);
        const out = await gtsFetch("/api/v1/admin/media_cleanup", {
          method: "POST",
          body: { remote_cache_days: days },
        });
        return { content: [{ type: "text", text: JSON.stringify({ pruned_days: days, response: out }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  return server;
}

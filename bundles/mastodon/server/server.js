/**
 * Mastodon MCP Server
 *
 * Mastodon is the reference implementation of the v1/v2 Mastodon API.
 * F.1 (GoToSocial) and F.5 (Pixelfed) mirror this surface — this bundle
 * exposes the same verb taxonomy against the real thing, adding admin
 * endpoints that GTS/PF implement only partially (tootctl-style
 * moderation, federation_relationships).
 *
 * Tools (federated-social verb taxonomy):
 *   mastodon_status, mastodon_post, mastodon_post_with_media,
 *   mastodon_feed, mastodon_search,
 *   mastodon_follow, mastodon_unfollow,
 *   mastodon_block_user, mastodon_mute_user (inline, rate-limited),
 *   mastodon_block_domain, mastodon_defederate,
 *   mastodon_import_blocklist (QUEUED, admin-destructive),
 *   mastodon_review_reports, mastodon_report_remote,
 *   mastodon_media_prune
 *
 * Rate limiting + moderation queue: same pattern as F.1/F.5/F.6.
 *
 * Deduplication note:
 *   resolveAccount(), queueModerationAction(), and the request helpers
 *   are deliberately duplicated from F.1/F.5 rather than extracted to
 *   servers/shared/. The three copies stay local so each bundle remains
 *   installable-standalone without a shared-helper dependency. When a
 *   fourth Mastodon-compatible bundle lands (Akkoma? Iceshrimp?), hoist.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const MASTODON_URL = (process.env.MASTODON_URL || "http://mastodon-web:3000").replace(/\/+$/, "");
const MASTODON_ACCESS_TOKEN = process.env.MASTODON_ACCESS_TOKEN || "";
const MASTODON_LOCAL_DOMAIN = process.env.MASTODON_LOCAL_DOMAIN || "";

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

async function mdFetch(path, { method = "GET", body, query, noAuth, timeoutMs = 20_000, rawForm } = {}) {
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
  const url = `${MASTODON_URL}${path}${qs}`;
  const headers = {};
  if (!noAuth && MASTODON_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${MASTODON_ACCESS_TOKEN}`;
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
      if (res.status === 401) throw new Error("Mastodon auth failed (401). Create an OAuth PAT in Settings → Development and paste into MASTODON_ACCESS_TOKEN.");
      if (res.status === 403) throw new Error(`Mastodon forbidden (403)${snippet ? ": " + snippet : ""}`);
      throw new Error(`Mastodon ${res.status} ${res.statusText}${snippet ? " — " + snippet : ""}`);
    }
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { raw: text }; }
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`Mastodon request timed out: ${path}`);
    if (err.cause?.code === "ECONNREFUSED" || err.message?.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Mastodon at ${MASTODON_URL}. Verify crow-mastodon-web is up and on the crow-federation network.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function requireAuth() {
  if (!MASTODON_ACCESS_TOKEN) {
    return { content: [{ type: "text", text: "Error: MASTODON_ACCESS_TOKEN required. Create an OAuth PAT in Settings → Development with scopes read/write (admin tools also need admin:read/admin:write)." }] };
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

async function resolveAccount(handleOrId) {
  if (/^\d+$/.test(handleOrId)) return { id: handleOrId };
  const out = await mdFetch("/api/v2/search", {
    query: { q: handleOrId.replace(/^@/, ""), type: "accounts", resolve: "true", limit: 1 },
  });
  return (out.accounts || [])[0] || null;
}

export async function createMastodonServer(options = {}) {
  await loadSharedDeps();

  const server = new McpServer(
    { name: "crow-mastodon", version: "1.0.0" },
    { instructions: options.instructions },
  );

  const limiter = wrapRateLimited ? wrapRateLimited({ db: getDb ? getDb() : null }) : (_, h) => h;

  // --- mastodon_status ---
  server.tool(
    "mastodon_status",
    "Report Mastodon instance health: reachability, version, user/post/domain stats, admin account, federation peer count, media cache retention setting.",
    {},
    async () => {
      try {
        const [instance, peers, account] = await Promise.all([
          mdFetch("/api/v2/instance", { noAuth: true }).catch(() => mdFetch("/api/v1/instance", { noAuth: true }).catch(() => null)),
          mdFetch("/api/v1/instance/peers").catch(() => []),
          MASTODON_ACCESS_TOKEN ? mdFetch("/api/v1/accounts/verify_credentials").catch(() => null) : Promise.resolve(null),
        ]);
        return textResponse({
          local_domain: MASTODON_LOCAL_DOMAIN || null,
          url: MASTODON_URL,
          title: instance?.title || null,
          version: instance?.version || null,
          users: instance?.usage?.users?.active_month ?? instance?.stats?.user_count ?? null,
          statuses: instance?.stats?.status_count ?? null,
          domains: instance?.stats?.domain_count ?? null,
          federated_peers: Array.isArray(peers) ? peers.length : null,
          registrations_open: instance?.registrations?.enabled ?? instance?.registrations ?? null,
          authenticated_as: account ? { id: account.id, acct: account.acct, display_name: account.display_name } : null,
          has_access_token: Boolean(MASTODON_ACCESS_TOKEN),
        });
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  // --- mastodon_post ---
  server.tool(
    "mastodon_post",
    "Publish a status (toot). Content is public by default unless visibility is narrowed. Rate-limited: 10/hour per conversation.",
    {
      status: z.string().min(1).max(5000).describe("Status body. Mastodon enforces a 500-char default; admins can raise it. Remote servers may truncate."),
      visibility: z.enum(["public", "unlisted", "private", "direct"]).optional(),
      spoiler_text: z.string().max(500).optional(),
      in_reply_to_id: z.string().max(50).optional(),
      language: z.string().length(2).optional(),
      sensitive: z.boolean().optional(),
    },
    limiter("mastodon_post", async (args) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const body = {
          status: args.status,
          visibility: args.visibility || "public",
          ...(args.spoiler_text ? { spoiler_text: args.spoiler_text } : {}),
          ...(args.in_reply_to_id ? { in_reply_to_id: args.in_reply_to_id } : {}),
          ...(args.language ? { language: args.language } : {}),
          ...(args.sensitive != null ? { sensitive: args.sensitive } : {}),
        };
        const out = await mdFetch("/api/v1/statuses", { method: "POST", body });
        return textResponse({ id: out.id, url: out.url, uri: out.uri, visibility: out.visibility, created_at: out.created_at });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- mastodon_post_with_media ---
  server.tool(
    "mastodon_post_with_media",
    "Upload an image/video and publish it as a status. Uploads via POST /api/v2/media (async processing) then POST /api/v1/statuses. Pass file_path OR file_base64+filename. Rate-limited: 10/hour.",
    {
      file_path: z.string().max(4096).optional(),
      file_base64: z.string().max(50_000_000).optional(),
      filename: z.string().max(500).optional(),
      caption: z.string().max(5000).optional(),
      alt_text: z.string().max(1500).optional().describe("Media alt text (strongly recommended)."),
      visibility: z.enum(["public", "unlisted", "private", "direct"]).optional(),
      spoiler_text: z.string().max(500).optional(),
      sensitive: z.boolean().optional(),
    },
    limiter("mastodon_post_with_media", async (args) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        let buf, name;
        if (args.file_path) {
          buf = await readFile(args.file_path);
          name = args.filename || basename(args.file_path);
        } else if (args.file_base64) {
          buf = Buffer.from(args.file_base64, "base64");
          name = args.filename || `upload-${Date.now()}.jpg`;
        } else {
          return { content: [{ type: "text", text: "Error: must pass file_path or file_base64+filename." }] };
        }
        const form = new FormData();
        form.append("file", new Blob([buf]), name);
        if (args.alt_text) form.append("description", args.alt_text);
        // Mastodon 4.x uses /api/v2/media for async upload. Endpoint returns 202 with id
        // when processing is not yet complete; we poll briefly for 'processed' state.
        let media = await mdFetch("/api/v2/media", { method: "POST", rawForm: form, timeoutMs: 180_000 });
        if (media?.id && media?.url == null) {
          // Still processing — poll for up to 30s
          for (let i = 0; i < 15; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            const check = await mdFetch(`/api/v1/media/${media.id}`).catch(() => null);
            if (check?.url) { media = check; break; }
          }
        }
        const body = {
          status: args.caption || "",
          media_ids: [media.id],
          visibility: args.visibility || "public",
          ...(args.spoiler_text ? { spoiler_text: args.spoiler_text } : {}),
          ...(args.sensitive != null ? { sensitive: args.sensitive } : {}),
        };
        const status = await mdFetch("/api/v1/statuses", { method: "POST", body });
        return textResponse({ id: status.id, url: status.url, visibility: status.visibility, media_id: media.id, media_url: media.url });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- mastodon_feed ---
  server.tool(
    "mastodon_feed",
    "Fetch a timeline. home = follows; public = local+federated; local = this instance; notifications = mentions/favs/boosts/follows. Rate-limited: 60/hour.",
    {
      source: z.enum(["home", "public", "local", "notifications"]),
      limit: z.number().int().min(1).max(40).optional(),
      since_id: z.string().max(50).optional(),
      max_id: z.string().max(50).optional(),
    },
    limiter("mastodon_feed", async ({ source, limit, since_id, max_id }) => {
      try {
        if (source !== "public" && !MASTODON_ACCESS_TOKEN) {
          return { content: [{ type: "text", text: "Error: non-public timelines require MASTODON_ACCESS_TOKEN." }] };
        }
        const path =
          source === "home" ? "/api/v1/timelines/home"
          : source === "public" ? "/api/v1/timelines/public"
          : source === "local" ? "/api/v1/timelines/public"
          : "/api/v1/notifications";
        const query = { limit: limit ?? 20, since_id, max_id };
        if (source === "local") query.local = "true";
        const items = await mdFetch(path, { query, noAuth: source === "public" && !MASTODON_ACCESS_TOKEN });
        const summary = (Array.isArray(items) ? items : []).map((it) =>
          source === "notifications"
            ? { id: it.id, type: it.type, account: it.account?.acct, status_id: it.status?.id, created_at: it.created_at }
            : {
                id: it.id, acct: it.account?.acct, url: it.url,
                content_excerpt: (it.content || "").replace(/<[^>]+>/g, "").slice(0, 240),
                media_count: (it.media_attachments || []).length,
                created_at: it.created_at, visibility: it.visibility,
                favs: it.favourites_count, replies: it.replies_count, reblogs: it.reblogs_count,
              },
        );
        return textResponse({ count: summary.length, items: summary });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- mastodon_search ---
  server.tool(
    "mastodon_search",
    "Search accounts/hashtags/statuses. Remote queries resolve via WebFinger when resolve=true. Rate-limited: 60/hour.",
    {
      query: z.string().min(1).max(500),
      type: z.enum(["accounts", "hashtags", "statuses"]).optional(),
      limit: z.number().int().min(1).max(40).optional(),
      resolve: z.boolean().optional(),
    },
    limiter("mastodon_search", async ({ query, type, limit, resolve }) => {
      try {
        const out = await mdFetch("/api/v2/search", {
          query: { q: query, type, limit: limit ?? 10, resolve: resolve ? "true" : undefined },
        });
        return textResponse(out);
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- mastodon_follow / unfollow ---
  server.tool(
    "mastodon_follow",
    "Follow an account by handle (@user@domain) or local account ID. Rate-limited: 30/hour.",
    { handle: z.string().min(1).max(320) },
    limiter("mastodon_follow", async ({ handle }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const acct = await resolveAccount(handle);
        if (!acct) return { content: [{ type: "text", text: `No account found for ${handle}` }] };
        const rel = await mdFetch(`/api/v1/accounts/${encodeURIComponent(acct.id)}/follow`, { method: "POST" });
        return textResponse({ following: rel.following, requested: rel.requested, showing_reblogs: rel.showing_reblogs });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  server.tool(
    "mastodon_unfollow",
    "Unfollow an account.",
    { handle: z.string().min(1).max(320) },
    limiter("mastodon_unfollow", async ({ handle }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const acct = await resolveAccount(handle);
        if (!acct) return { content: [{ type: "text", text: `No account found for ${handle}` }] };
        const rel = await mdFetch(`/api/v1/accounts/${encodeURIComponent(acct.id)}/unfollow`, { method: "POST" });
        return textResponse({ following: rel.following });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- User-level moderation (inline, rate-limited) ---
  server.tool(
    "mastodon_block_user",
    "Block an account (hide their posts + block DMs from them). Rate-limited: 5/hour.",
    { handle: z.string().min(1).max(320), confirm: z.literal("yes") },
    limiter("mastodon_block_user", async ({ handle }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const acct = await resolveAccount(handle);
        if (!acct) return { content: [{ type: "text", text: `No account found for ${handle}` }] };
        const rel = await mdFetch(`/api/v1/accounts/${acct.id}/block`, { method: "POST" });
        return textResponse({ blocking: rel.blocking });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  server.tool(
    "mastodon_mute_user",
    "Mute an account (hide posts but still federate). Rate-limited: 5/hour.",
    {
      handle: z.string().min(1).max(320),
      notifications: z.boolean().optional().describe("Also mute notifications from this user (default true)."),
      duration_seconds: z.number().int().min(0).max(86400 * 365).optional().describe("Temporary mute duration; 0 = permanent."),
      confirm: z.literal("yes"),
    },
    limiter("mastodon_mute_user", async ({ handle, notifications, duration_seconds }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const acct = await resolveAccount(handle);
        if (!acct) return { content: [{ type: "text", text: `No account found for ${handle}` }] };
        const body = {
          ...(notifications != null ? { notifications } : {}),
          ...(duration_seconds != null ? { duration: duration_seconds } : {}),
        };
        const rel = await mdFetch(`/api/v1/accounts/${acct.id}/mute`, { method: "POST", body });
        return textResponse({ muting: rel.muting, muting_notifications: rel.muting_notifications });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- Instance-level moderation (QUEUED) ---
  server.tool(
    "mastodon_block_domain",
    "Block a remote domain at the user level (hide all accounts from that domain for the authenticated user). For instance-wide defederation use mastodon_defederate. Rate-limited: 5/hour.",
    { domain: z.string().min(3).max(253), confirm: z.literal("yes") },
    limiter("mastodon_block_domain", async ({ domain }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const out = await mdFetch(`/api/v1/domain_blocks?domain=${encodeURIComponent(domain)}`, { method: "POST" });
        return textResponse({ blocked_domain: domain, response: out });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  server.tool(
    "mastodon_defederate",
    "Instance-wide defederation — admin-only. Uses the admin/domain_blocks endpoint with severity=suspend. QUEUED — requires operator confirmation in the Nest panel before firing.",
    {
      domain: z.string().min(3).max(253),
      reason: z.string().max(1000).optional(),
      severity: z.enum(["silence", "suspend", "noop"]).optional().describe("silence = hide from timelines; suspend = full defederation; default suspend."),
      reject_media: z.boolean().optional(),
      reject_reports: z.boolean().optional(),
      confirm: z.literal("yes"),
    },
    async ({ domain, reason, severity, reject_media, reject_reports }) => {
      const queued = await queueModerationAction("mastodon", "defederate", {
        domain,
        reason: reason || "",
        severity: severity || "suspend",
        reject_media: reject_media ?? true,
        reject_reports: reject_reports ?? true,
      });
      return textResponse(queued);
    },
  );

  server.tool(
    "mastodon_import_blocklist",
    "Import a domain blocklist (IFTAS / Bad Space / custom URL). QUEUED — requires operator confirmation. Rate-limited: 2/hour.",
    { source: z.string().min(1).max(500), confirm: z.literal("yes") },
    limiter("mastodon_import_blocklist", async ({ source }) => {
      const canonical = {
        iftas: "https://connect.iftas.org/library/iftas-documentation/iftas-do-not-interact-list/",
        "bad-space": "https://badspace.org/domain-block.csv",
      };
      const url = canonical[source] || source;
      const queued = await queueModerationAction("mastodon", "import_blocklist", { source: url });
      return textResponse(queued);
    }),
  );

  // --- Admin reports ---
  server.tool(
    "mastodon_review_reports",
    "List pending moderation reports (admin-only). Read-only summary.",
    { limit: z.number().int().min(1).max(100).optional() },
    async ({ limit }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const reports = await mdFetch("/api/v1/admin/reports", { query: { limit: limit ?? 20, resolved: "false" } });
        const summary = (Array.isArray(reports) ? reports : []).map((r) => ({
          id: r.id,
          account: r.account?.username,
          target_account: r.target_account?.username,
          category: r.category,
          comment: r.comment,
          forwarded: r.forwarded,
          created_at: r.created_at,
        }));
        return textResponse({ count: summary.length, reports: summary });
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  server.tool(
    "mastodon_report_remote",
    "File a moderation report to a remote server about an account. Rate-limited: 5/hour.",
    {
      handle: z.string().min(1).max(320),
      reason: z.string().min(1).max(1000),
      status_ids: z.array(z.string().max(50)).max(10).optional().describe("Specific status IDs to attach to the report."),
      forward: z.boolean().optional(),
      category: z.enum(["spam", "legal", "violation", "other"]).optional(),
    },
    limiter("mastodon_report_remote", async ({ handle, reason, status_ids, forward, category }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const acct = await resolveAccount(handle);
        if (!acct) return { content: [{ type: "text", text: `No account found for ${handle}` }] };
        const body = {
          account_id: acct.id,
          comment: reason,
          forward: forward !== false,
          ...(status_ids ? { status_ids } : {}),
          ...(category ? { category } : {}),
        };
        const out = await mdFetch("/api/v1/reports", { method: "POST", body });
        return textResponse({ report_id: out.id, forwarded: body.forward });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- mastodon_media_prune ---
  server.tool(
    "mastodon_media_prune",
    "Manually trigger pruning of cached remote media older than N days. The sidekiq scheduler handles this on a recurring cadence (MEDIA_CACHE_RETENTION_PERIOD env); this lets operators force an aggressive pass. Rate-limited: 2/hour.",
    {
      older_than_days: z.number().int().min(1).max(365).optional(),
      confirm: z.literal("yes"),
    },
    limiter("mastodon_media_prune", async ({ older_than_days }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const days = older_than_days ?? Number(process.env.MASTODON_MEDIA_RETENTION_DAYS || 14);
        // Mastodon has no HTTP API for media prune — surface the tootctl
        // invocation the operator should run. Return structured so the
        // caller knows to exec it.
        return textResponse({
          requested_days: days,
          next_steps: [
            `docker exec crow-mastodon-web bin/tootctl media remove --days ${days}`,
            "(optional, more aggressive) --prune-profiles to drop cached remote avatars",
            "Scheduled sidekiq job 'Scheduler::MediaCleanupScheduler' handles this automatically at MEDIA_CACHE_RETENTION_PERIOD cadence.",
          ],
          note: "Mastodon deliberately keeps media prune as a CLI rather than an HTTP admin endpoint to prevent accidental mass-deletion via API. The scheduler is the normal path; this tool surfaces the manual escape hatch.",
        });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  return server;
}

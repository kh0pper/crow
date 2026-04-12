/**
 * Pixelfed MCP Server
 *
 * Pixelfed implements Mastodon's v1/v2 REST API so most verbs are
 * cross-compatible with the GoToSocial bundle (F.1). The tools here
 * mirror GTS's surface with Pixelfed-specific additions for media
 * posting (pf_post_photo — upload + status in one call).
 *
 * Tools (per plan's federated-media verb taxonomy):
 *   pf_status, pf_post_photo, pf_feed, pf_search,
 *   pf_follow, pf_unfollow,
 *   pf_block_user, pf_mute_user (inline, rate-limited),
 *   pf_block_domain, pf_defederate, pf_import_blocklist (QUEUED),
 *   pf_review_reports, pf_report_remote,
 *   pf_media_prune
 *
 * Rate limiting + moderation queue: same pattern as F.1 GoToSocial.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const PIXELFED_URL = (process.env.PIXELFED_URL || "http://pixelfed:80").replace(/\/+$/, "");
const PIXELFED_ACCESS_TOKEN = process.env.PIXELFED_ACCESS_TOKEN || "";
const PIXELFED_HOSTNAME = process.env.PIXELFED_HOSTNAME || "";

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

async function pfFetch(path, { method = "GET", body, query, noAuth, timeoutMs = 20_000, rawForm } = {}) {
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
  const url = `${PIXELFED_URL}${path}${qs}`;
  const headers = {};
  if (!noAuth && PIXELFED_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${PIXELFED_ACCESS_TOKEN}`;
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
      if (res.status === 401) throw new Error("Pixelfed auth failed (401). Create an OAuth PAT in Settings → Development, paste into PIXELFED_ACCESS_TOKEN.");
      if (res.status === 403) throw new Error(`Pixelfed forbidden (403)${snippet ? ": " + snippet : ""}`);
      throw new Error(`Pixelfed ${res.status} ${res.statusText}${snippet ? " — " + snippet : ""}`);
    }
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { raw: text }; }
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`Pixelfed request timed out: ${path}`);
    if (err.cause?.code === "ECONNREFUSED" || err.message?.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Pixelfed at ${PIXELFED_URL}. Verify crow-pixelfed is up and on the crow-federation network.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function requireAuth() {
  if (!PIXELFED_ACCESS_TOKEN) {
    return { content: [{ type: "text", text: "Error: PIXELFED_ACCESS_TOKEN required. Generate an OAuth PAT from Settings → Development in the Pixelfed web UI." }] };
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
  if (/^\d+$/.test(handleOrId)) return { id: handleOrId, acct: null };
  const out = await pfFetch("/api/v2/search", {
    query: { q: handleOrId.replace(/^@/, ""), type: "accounts", resolve: "true", limit: 1 },
  });
  return (out.accounts || [])[0] || null;
}

export async function createPixelfedServer(options = {}) {
  await loadSharedDeps();

  const server = new McpServer(
    { name: "crow-pixelfed", version: "1.0.0" },
    { instructions: options.instructions },
  );

  const limiter = wrapRateLimited ? wrapRateLimited({ db: getDb ? getDb() : null }) : (_, h) => h;

  // --- pf_status ---
  server.tool(
    "pf_status",
    "Report Pixelfed instance health: reachability, version, stats, federation peer count, authenticated account.",
    {},
    async () => {
      try {
        const [instance, peers, account] = await Promise.all([
          pfFetch("/api/v1/instance").catch(() => null),
          pfFetch("/api/v1/instance/peers").catch(() => []),
          PIXELFED_ACCESS_TOKEN ? pfFetch("/api/v1/accounts/verify_credentials").catch(() => null) : Promise.resolve(null),
        ]);
        return textResponse({
          instance: instance ? {
            uri: instance.uri, title: instance.title, version: instance.version,
            registrations: instance.registrations, stats: instance.stats,
          } : null,
          hostname: PIXELFED_HOSTNAME || null,
          authenticated_as: account ? { id: account.id, acct: account.acct, display_name: account.display_name } : null,
          federated_peers: Array.isArray(peers) ? peers.length : null,
          has_access_token: Boolean(PIXELFED_ACCESS_TOKEN),
        });
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  // --- pf_post_photo ---
  server.tool(
    "pf_post_photo",
    "Upload a photo and publish it as a status. Uploads via POST /api/v1/media then POST /api/v1/statuses. Pass file_path OR file_base64+filename. Rate-limited: 10/hour.",
    {
      file_path: z.string().max(4096).optional(),
      file_base64: z.string().max(50_000_000).optional(),
      filename: z.string().max(500).optional(),
      caption: z.string().max(5000).optional().describe("Status body (shown below the image)."),
      alt_text: z.string().max(1500).optional().describe("Media alt text for screen readers. Strongly recommended."),
      visibility: z.enum(["public", "unlisted", "private", "direct"]).optional(),
      spoiler_text: z.string().max(500).optional().describe("Content warning shown before the image."),
      sensitive: z.boolean().optional().describe("Hide image behind a 'sensitive content' tap-to-reveal."),
    },
    limiter("pf_post_photo", async (args) => {
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
        const media = await pfFetch("/api/v1/media", { method: "POST", rawForm: form, timeoutMs: 120_000 });
        const body = {
          status: args.caption || "",
          media_ids: [media.id],
          visibility: args.visibility || "public",
          ...(args.spoiler_text ? { spoiler_text: args.spoiler_text } : {}),
          ...(args.sensitive != null ? { sensitive: args.sensitive } : {}),
        };
        const status = await pfFetch("/api/v1/statuses", { method: "POST", body });
        return textResponse({
          id: status.id, url: status.url, visibility: status.visibility,
          media_id: media.id, media_url: media.url, created_at: status.created_at,
        });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- pf_feed ---
  server.tool(
    "pf_feed",
    "Fetch a timeline. home = follows; public = local+federated; local = this instance; notifications = mentions/likes/follows. Rate-limited: 60/hour.",
    {
      source: z.enum(["home", "public", "local", "notifications"]),
      limit: z.number().int().min(1).max(40).optional(),
      since_id: z.string().max(50).optional(),
      max_id: z.string().max(50).optional(),
    },
    limiter("pf_feed", async ({ source, limit, since_id, max_id }) => {
      try {
        if (source !== "public" && !PIXELFED_ACCESS_TOKEN) {
          return { content: [{ type: "text", text: "Error: non-public timelines require PIXELFED_ACCESS_TOKEN." }] };
        }
        const path =
          source === "home" ? "/api/v1/timelines/home"
          : source === "public" ? "/api/v1/timelines/public"
          : source === "local" ? "/api/v1/timelines/public"
          : "/api/v1/notifications";
        const query = { limit: limit ?? 20, since_id, max_id };
        if (source === "local") query.local = "true";
        const items = await pfFetch(path, { query, noAuth: source === "public" && !PIXELFED_ACCESS_TOKEN });
        const summary = (Array.isArray(items) ? items : []).map((it) =>
          source === "notifications"
            ? { id: it.id, type: it.type, account: it.account?.acct, status_id: it.status?.id, created_at: it.created_at }
            : {
                id: it.id, acct: it.account?.acct, url: it.url,
                media_count: (it.media_attachments || []).length,
                media_urls: (it.media_attachments || []).map((m) => m.url).slice(0, 4),
                content_excerpt: (it.content || "").replace(/<[^>]+>/g, "").slice(0, 240),
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

  // --- pf_search ---
  server.tool(
    "pf_search",
    "Search accounts / hashtags / statuses. Remote queries resolve via WebFinger. Rate-limited: 60/hour.",
    {
      query: z.string().min(1).max(500),
      type: z.enum(["accounts", "hashtags", "statuses"]).optional(),
      limit: z.number().int().min(1).max(40).optional(),
      resolve: z.boolean().optional(),
    },
    limiter("pf_search", async ({ query, type, limit, resolve }) => {
      try {
        const out = await pfFetch("/api/v2/search", {
          query: { q: query, type, limit: limit ?? 10, resolve: resolve ? "true" : undefined },
        });
        return textResponse(out);
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- pf_follow / pf_unfollow ---
  server.tool(
    "pf_follow",
    "Follow an account by handle (@user@domain) or local account ID. Rate-limited: 30/hour.",
    { handle: z.string().min(1).max(320) },
    limiter("pf_follow", async ({ handle }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const acct = await resolveAccount(handle);
        if (!acct) return { content: [{ type: "text", text: `No account found for ${handle}` }] };
        const rel = await pfFetch(`/api/v1/accounts/${encodeURIComponent(acct.id)}/follow`, { method: "POST" });
        return textResponse({ following: rel.following, requested: rel.requested });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  server.tool(
    "pf_unfollow",
    "Unfollow an account.",
    { handle: z.string().min(1).max(320) },
    limiter("pf_unfollow", async ({ handle }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const acct = await resolveAccount(handle);
        if (!acct) return { content: [{ type: "text", text: `No account found for ${handle}` }] };
        const rel = await pfFetch(`/api/v1/accounts/${encodeURIComponent(acct.id)}/unfollow`, { method: "POST" });
        return textResponse({ following: rel.following });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- User-level moderation (inline) ---
  server.tool(
    "pf_block_user",
    "Block an account system-wide (the authenticated user no longer sees their posts). Rate-limited: 5/hour.",
    { handle: z.string().min(1).max(320), confirm: z.literal("yes") },
    limiter("pf_block_user", async ({ handle }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const acct = await resolveAccount(handle);
        if (!acct) return { content: [{ type: "text", text: `No account found for ${handle}` }] };
        const rel = await pfFetch(`/api/v1/accounts/${acct.id}/block`, { method: "POST" });
        return textResponse({ blocking: rel.blocking });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  server.tool(
    "pf_mute_user",
    "Mute an account (hide posts but still federate). Rate-limited: 5/hour.",
    { handle: z.string().min(1).max(320), confirm: z.literal("yes") },
    limiter("pf_mute_user", async ({ handle }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const acct = await resolveAccount(handle);
        if (!acct) return { content: [{ type: "text", text: `No account found for ${handle}` }] };
        const rel = await pfFetch(`/api/v1/accounts/${acct.id}/mute`, { method: "POST" });
        return textResponse({ muting: rel.muting });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- Instance-level moderation (QUEUED) ---
  server.tool(
    "pf_block_domain",
    "Block an entire remote domain (no federation, no media fetch). QUEUED — requires operator confirmation in the Nest panel.",
    { domain: z.string().min(1).max(253), reason: z.string().max(500).optional(), confirm: z.literal("yes") },
    async ({ domain, reason }) => {
      const queued = await queueModerationAction("pixelfed", "block_domain", { domain, reason: reason || "" });
      return textResponse(queued);
    },
  );

  server.tool(
    "pf_defederate",
    "Defederate from a remote domain (block + purge cached content + sever follows). QUEUED — requires operator confirmation.",
    { domain: z.string().min(1).max(253), reason: z.string().max(500).optional(), confirm: z.literal("yes") },
    async ({ domain, reason }) => {
      const queued = await queueModerationAction("pixelfed", "defederate", { domain, reason: reason || "" });
      return textResponse(queued);
    },
  );

  server.tool(
    "pf_review_reports",
    "List pending moderation reports (admin-only).",
    { limit: z.number().int().min(1).max(100).optional() },
    async ({ limit }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const reports = await pfFetch("/api/v1/admin/reports", { query: { limit: limit ?? 20, resolved: "false" } });
        const summary = (Array.isArray(reports) ? reports : []).map((r) => ({
          id: r.id, account: r.account?.acct, target_account: r.target_account?.acct,
          reason: r.category || r.comment, created_at: r.created_at,
        }));
        return textResponse({ count: summary.length, reports: summary });
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  server.tool(
    "pf_report_remote",
    "File a moderation report to a remote server about an account. Rate-limited: 5/hour.",
    {
      handle: z.string().min(1).max(320),
      reason: z.string().min(1).max(1000),
      forward: z.boolean().optional(),
    },
    limiter("pf_report_remote", async ({ handle, reason, forward }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const acct = await resolveAccount(handle);
        if (!acct) return { content: [{ type: "text", text: `No account found for ${handle}` }] };
        const out = await pfFetch("/api/v1/reports", { method: "POST", body: { account_id: acct.id, comment: reason, forward: forward !== false } });
        return textResponse({ report_id: out.id, forwarded: forward !== false });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  server.tool(
    "pf_import_blocklist",
    "Import a domain blocklist (IFTAS / Bad Space / custom URL). QUEUED — requires operator confirmation. Rate-limited: 2/hour.",
    { source: z.string().min(1).max(500), confirm: z.literal("yes") },
    limiter("pf_import_blocklist", async ({ source }) => {
      const canonical = {
        iftas: "https://connect.iftas.org/library/iftas-documentation/iftas-do-not-interact-list/",
        "bad-space": "https://badspace.org/domain-block.csv",
      };
      const url = canonical[source] || source;
      const queued = await queueModerationAction("pixelfed", "import_blocklist", { source: url });
      return textResponse(queued);
    }),
  );

  // --- pf_media_prune ---
  server.tool(
    "pf_media_prune",
    "Manually trigger a prune of remote media older than N days. The scheduled horizon job handles this on a recurring cadence; this lets operators force an aggressive pass. Rate-limited: 2/hour.",
    {
      older_than_days: z.number().int().min(1).max(365).optional(),
      confirm: z.literal("yes"),
    },
    limiter("pf_media_prune", async ({ older_than_days }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const days = older_than_days ?? Number(process.env.PIXELFED_MEDIA_RETENTION_DAYS || 14);
        const out = await pfFetch("/api/v1/admin/media/prune", { method: "POST", body: { older_than_days: days } }).catch(() => null);
        return textResponse({
          requested_days: days,
          response: out,
          note: out ? null : "Admin endpoint unavailable on this Pixelfed version — scheduled horizon job still handles pruning on the PIXELFED_MEDIA_RETENTION_DAYS cadence.",
        });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  return server;
}

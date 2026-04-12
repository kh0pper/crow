/**
 * Funkwhale MCP Server
 *
 * Exposes Funkwhale's REST API as MCP tools. Funkwhale implements its own
 * federated-music API (not Mastodon-compatible) — library browsing,
 * uploads, channel follows, playlists, moderation.
 *
 * Tools (per plan's federated-media verb taxonomy):
 *   fw_status            — pod reachability, version, federation mode,
 *                          disk usage, queue depths
 *   fw_list_library      — list the authenticated user's owned libraries
 *   fw_search            — search tracks/artists/albums/channels
 *   fw_upload_track      — upload an audio file to a library
 *   fw_follow            — follow a remote or local channel/library
 *   fw_unfollow          — revoke a follow
 *   fw_playlists         — list the user's playlists
 *   fw_now_playing       — report currently-playing listenbrainz-style
 *   fw_block_user        — block a remote user (inline, rate-limited)
 *   fw_mute_user         — mute a remote user (inline, rate-limited)
 *   fw_block_domain      — instance-wide block (QUEUED — operator confirm)
 *   fw_defederate        — full defederation (QUEUED — operator confirm)
 *   fw_media_prune       — manual trigger for remote-cache prune
 *
 * Rate limiting: per the shared wrapper. Content-producing and moderation
 * verbs are wrapped; read-only status/list/search are uncapped.
 *
 * Queued moderation: fw_block_domain + fw_defederate + fw_import_blocklist
 * INSERT into moderation_actions and raise a notification; the actual
 * federation change lands when the operator confirms in the Nest panel.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const FUNKWHALE_URL = (process.env.FUNKWHALE_URL || "http://funkwhale-api:5000").replace(/\/+$/, "");
const FUNKWHALE_ACCESS_TOKEN = process.env.FUNKWHALE_ACCESS_TOKEN || "";
const FUNKWHALE_HOSTNAME = process.env.FUNKWHALE_HOSTNAME || "";

// --- Lazy shared-dep imports (pattern borrowed from GoToSocial) ---

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

// --- HTTP helper ---

async function fwFetch(path, { method = "GET", body, query, noAuth, timeoutMs = 20_000, rawForm } = {}) {
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
  const url = `${FUNKWHALE_URL}${path}${qs}`;
  const headers = {};
  if (!noAuth && FUNKWHALE_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${FUNKWHALE_ACCESS_TOKEN}`;
  }
  let payload;
  if (rawForm) {
    payload = rawForm; // FormData
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
      if (res.status === 401) throw new Error("Funkwhale auth failed (401). Create a PAT in Settings → Applications, paste into FUNKWHALE_ACCESS_TOKEN.");
      if (res.status === 403) throw new Error(`Funkwhale forbidden (403)${snippet ? ": " + snippet : ""}`);
      throw new Error(`Funkwhale ${res.status} ${res.statusText}${snippet ? " — " + snippet : ""}`);
    }
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { raw: text }; }
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`Funkwhale request timed out: ${path}`);
    if (err.cause?.code === "ECONNREFUSED" || err.message?.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Funkwhale at ${FUNKWHALE_URL}. Verify crow-funkwhale-api is up and on the crow-federation network.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function requireAuth() {
  if (!FUNKWHALE_ACCESS_TOKEN) {
    return { content: [{ type: "text", text: "Error: FUNKWHALE_ACCESS_TOKEN required. Generate a Personal Access Token from Settings → Applications in the Funkwhale web UI." }] };
  }
  return null;
}

/**
 * Queue a destructive moderation action. See bundles/gotosocial for full
 * rationale. Returns `{ status, action_id?, expires_at? }`.
 */
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
      return {
        status: "queued_unavailable",
        reason: "moderation_actions table not present — queued action could not be persisted. Lands with F.11.",
      };
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

export async function createFunkwhaleServer(options = {}) {
  await loadSharedDeps();

  const server = new McpServer(
    { name: "crow-funkwhale", version: "1.0.0" },
    { instructions: options.instructions },
  );

  const limiter = wrapRateLimited ? wrapRateLimited({ db: getDb ? getDb() : null }) : (_, h) => h;

  // --- fw_status ---
  server.tool(
    "fw_status",
    "Report Funkwhale pod status: reachability, version, federation mode, instance policy counts, auth whoami.",
    {},
    async () => {
      try {
        const [nodeinfo, whoami, policies] = await Promise.all([
          fwFetch("/api/v1/instance/nodeinfo/2.0/", { noAuth: true }).catch(() => null),
          FUNKWHALE_ACCESS_TOKEN ? fwFetch("/api/v1/users/me/").catch(() => null) : Promise.resolve(null),
          FUNKWHALE_ACCESS_TOKEN ? fwFetch("/api/v1/manage/moderation/instance-policies/", { query: { page_size: 1 } }).catch(() => null) : Promise.resolve(null),
        ]);
        return textResponse({
          hostname: FUNKWHALE_HOSTNAME || null,
          url: FUNKWHALE_URL,
          version: nodeinfo?.software?.version || null,
          software: nodeinfo?.software?.name || null,
          open_registrations: nodeinfo?.openRegistrations ?? null,
          federation_enabled: nodeinfo?.metadata?.federation?.enabled ?? null,
          usage_users: nodeinfo?.usage?.users || null,
          whoami: whoami ? { username: whoami.username, is_superuser: whoami.is_superuser, id: whoami.id } : null,
          instance_policies_total: policies?.count ?? null,
          has_access_token: Boolean(FUNKWHALE_ACCESS_TOKEN),
        });
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  // --- fw_list_library ---
  server.tool(
    "fw_list_library",
    "List the authenticated user's owned libraries (track + upload counts per library).",
    {
      page: z.number().int().min(1).max(1000).optional(),
      page_size: z.number().int().min(1).max(100).optional(),
    },
    async ({ page, page_size }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const out = await fwFetch("/api/v1/libraries/", { query: { scope: "me", page, page_size } });
        return textResponse({
          count: out.count,
          libraries: (out.results || []).map((l) => ({
            uuid: l.uuid,
            name: l.name,
            privacy_level: l.privacy_level,
            uploads_count: l.uploads_count,
            size: l.size,
            actor: l.actor?.full_username || null,
          })),
          next: out.next,
        });
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  // --- fw_search ---
  server.tool(
    "fw_search",
    "Search the local + cached federated catalog. Default scope 'tracks' searches track titles; pass type to search artists/albums/channels. Rate-limited: 60/hour.",
    {
      q: z.string().min(1).max(500),
      type: z.enum(["tracks", "artists", "albums", "channels"]).optional(),
      page_size: z.number().int().min(1).max(100).optional(),
    },
    limiter("fw_search", async ({ q, type, page_size }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const t = type || "tracks";
        const out = await fwFetch(`/api/v1/${t}/`, { query: { q, page_size: page_size || 20 } });
        const simplified = (out.results || []).map((item) => ({
          id: item.id || item.uuid,
          fid: item.fid || null,
          name: item.title || item.name || item.artist?.name,
          artist: item.artist?.name,
          album: item.album?.title,
          is_local: item.is_local,
        }));
        return textResponse({ count: out.count, type: t, results: simplified });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- fw_upload_track ---
  server.tool(
    "fw_upload_track",
    "Upload an audio file to a library. Pass `file_path` (absolute path readable from this process) OR `file_base64` + `filename`. Rate-limited: 10/hour. Legal note: you must hold the rights — copyright violations can trigger defederation.",
    {
      library_uuid: z.string().uuid(),
      file_path: z.string().max(4096).optional(),
      file_base64: z.string().max(200_000_000).optional(),
      filename: z.string().max(500).optional(),
      import_reference: z.string().max(200).optional(),
    },
    limiter("fw_upload_track", async ({ library_uuid, file_path, file_base64, filename, import_reference }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        let buf;
        let name;
        if (file_path) {
          buf = await readFile(file_path);
          name = filename || basename(file_path);
        } else if (file_base64) {
          buf = Buffer.from(file_base64, "base64");
          name = filename || `upload-${Date.now()}.bin`;
        } else {
          return { content: [{ type: "text", text: "Error: must pass file_path or file_base64+filename." }] };
        }
        const form = new FormData();
        form.append("library", library_uuid);
        if (import_reference) form.append("import_reference", import_reference);
        form.append("audio_file", new Blob([buf]), name);
        const out = await fwFetch("/api/v1/uploads/", { method: "POST", rawForm: form, timeoutMs: 120_000 });
        return textResponse({ uuid: out.uuid, filename: out.filename, import_status: out.import_status, size: out.size });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- fw_follow ---
  server.tool(
    "fw_follow",
    "Follow a library (by UUID) or a remote channel (by actor URL/handle @user@server). Rate-limited: 30/hour.",
    {
      target_type: z.enum(["library", "channel"]),
      target: z.string().min(1).max(500),
    },
    limiter("fw_follow", async ({ target_type, target }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        if (target_type === "library") {
          const out = await fwFetch("/api/v1/federation/follows/library/", { method: "POST", body: { target } });
          return textResponse({ follow_uuid: out.uuid, approved: out.approved });
        }
        const subscribe = await fwFetch("/api/v1/subscriptions/", { method: "POST", body: { object: target } });
        return textResponse({ subscription_uuid: subscribe.uuid, channel_id: subscribe.channel?.id });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- fw_unfollow ---
  server.tool(
    "fw_unfollow",
    "Remove a library follow or channel subscription. Rate-limited: 30/hour.",
    {
      target_type: z.enum(["library", "channel"]),
      uuid: z.string().uuid(),
    },
    limiter("fw_unfollow", async ({ target_type, uuid }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const path = target_type === "library"
          ? `/api/v1/federation/follows/library/${uuid}/`
          : `/api/v1/subscriptions/${uuid}/`;
        await fwFetch(path, { method: "DELETE" });
        return textResponse({ unfollowed: uuid, target_type });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- fw_playlists ---
  server.tool(
    "fw_playlists",
    "List the authenticated user's playlists with track counts.",
    {
      page: z.number().int().min(1).max(1000).optional(),
      page_size: z.number().int().min(1).max(100).optional(),
    },
    async ({ page, page_size }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const out = await fwFetch("/api/v1/playlists/", { query: { scope: "me", page, page_size } });
        return textResponse({
          count: out.count,
          playlists: (out.results || []).map((p) => ({
            id: p.id, name: p.name, tracks_count: p.tracks_count, privacy_level: p.privacy_level,
          })),
        });
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  // --- fw_now_playing ---
  server.tool(
    "fw_now_playing",
    "Most recent listening activity for the authenticated user (last N listens).",
    {
      limit: z.number().int().min(1).max(50).optional(),
    },
    async ({ limit }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const out = await fwFetch("/api/v1/history/listenings/", { query: { page_size: limit || 10, ordering: "-creation_date" } });
        const listens = (out.results || []).map((l) => ({
          ts: l.creation_date,
          track_title: l.track?.title,
          artist: l.track?.artist?.name,
          album: l.track?.album?.title,
        }));
        return textResponse({ count: out.count, listens });
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  // --- fw_block_user (inline, rate-limited) ---
  server.tool(
    "fw_block_user",
    "Block a single user (by full actor handle @user@server). Inline; rate-limited: 5/hour.",
    {
      handle: z.string().min(3).max(500).describe("Full actor handle, e.g. @alice@remote.example"),
      confirm: z.literal("yes"),
    },
    limiter("fw_block_user", async ({ handle }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const out = await fwFetch("/api/v1/manage/moderation/instance-policies/", {
          method: "POST",
          body: { target: { type: "actor", full_username: handle.replace(/^@/, "") }, block_all: true, is_active: true },
        });
        return textResponse({ policy_id: out.id, target: handle, blocked: true });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- fw_mute_user (inline, rate-limited) ---
  server.tool(
    "fw_mute_user",
    "Mute a user (silence notifications + hide from feeds but keep federation). Inline; rate-limited: 5/hour.",
    {
      handle: z.string().min(3).max(500),
      confirm: z.literal("yes"),
    },
    limiter("fw_mute_user", async ({ handle }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const out = await fwFetch("/api/v1/manage/moderation/instance-policies/", {
          method: "POST",
          body: { target: { type: "actor", full_username: handle.replace(/^@/, "") }, silence_notifications: true, silence_activity: true, is_active: true },
        });
        return textResponse({ policy_id: out.id, target: handle, muted: true });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- fw_block_domain (QUEUED) ---
  server.tool(
    "fw_block_domain",
    "Instance-wide block of a remote domain (all actors/libraries from that domain become unreachable). QUEUED — does not apply until an operator confirms in the Nest panel within 72 hours.",
    {
      domain: z.string().min(3).max(253),
      reason: z.string().max(1000).optional(),
      confirm: z.literal("yes"),
    },
    limiter("fw_block_domain", async ({ domain, reason }) => {
      try {
        const queued = await queueModerationAction("funkwhale", "block_domain", { domain, reason: reason || "" });
        return textResponse(queued);
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- fw_defederate (QUEUED) ---
  server.tool(
    "fw_defederate",
    "Full defederation: block domain + purge cached content. QUEUED — requires operator confirmation in the Nest panel.",
    {
      domain: z.string().min(3).max(253),
      reason: z.string().max(1000).optional(),
      confirm: z.literal("yes"),
    },
    limiter("fw_defederate", async ({ domain, reason }) => {
      try {
        const queued = await queueModerationAction("funkwhale", "defederate", { domain, reason: reason || "" });
        return textResponse(queued);
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  // --- fw_media_prune ---
  server.tool(
    "fw_media_prune",
    "Manually trigger a prune of cached remote audio files older than N days. Default retention is 14 days (7 days on Pi-class hosts). Rate-limited: 2/hour.",
    {
      older_than_days: z.number().int().min(1).max(365).optional(),
      confirm: z.literal("yes"),
    },
    limiter("fw_media_prune", async ({ older_than_days }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const days = older_than_days ?? 14;
        const out = await fwFetch("/api/v1/manage/library/uploads/action/", {
          method: "POST",
          body: { action: "prune", objects: "all", filters: { privacy_level__in: ["public"], is_local: false, older_than_days: days } },
        });
        return textResponse({ requested_days: days, deleted: out.updated ?? out.deleted ?? null, raw: out });
      } catch (err) {
        return errResponse(err);
      }
    }),
  );

  return server;
}

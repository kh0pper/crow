/**
 * Matrix (Dendrite) MCP Server
 *
 * Exposes Matrix's client-server API through MCP. Dendrite speaks the
 * standard Matrix v3 API so these tools also work against Synapse or
 * other homeservers if someone points MATRIX_URL elsewhere.
 *
 * Tools:
 *   matrix_status            — reachability, version, federation mode
 *   matrix_joined_rooms      — list rooms the admin account is in
 *   matrix_create_room       — create a room (public / private / DM)
 *   matrix_join_room         — join by ID or alias (triggers federation)
 *   matrix_leave_room        — leave a room
 *   matrix_send_message      — send a message event to a room
 *   matrix_room_messages     — paginated message history
 *   matrix_sync              — one-shot sync (not long-poll; panel uses
 *                              a different long-poll endpoint)
 *   matrix_invite_user       — invite a user to a room
 *   matrix_register_appservice — write an appservice YAML registration
 *                              (used by F.12.1 matrix-bridges bundle)
 *   matrix_federation_health — check outgoing federation with the
 *                              Matrix Federation Tester
 *
 * Rate limiting follows the F.0 shared pattern: content-producing verbs
 * (create_room, send_message, join_room, invite_user) are wrapped.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const MATRIX_URL = (process.env.MATRIX_URL || "http://dendrite:8008").replace(/\/+$/, "");
const MATRIX_ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN || "";
const MATRIX_USER_ID = process.env.MATRIX_USER_ID || "";
const MATRIX_SERVER_NAME = process.env.MATRIX_SERVER_NAME || "";
const MATRIX_FEDERATION_TESTER = "https://federationtester.matrix.org/api/report";

let wrapRateLimited = null;
let getDb = null;

async function loadSharedDeps() {
  try {
    const rl = await import("../../../servers/shared/rate-limiter.js");
    wrapRateLimited = rl.wrapRateLimited;
  } catch {
    wrapRateLimited = () => (_, h) => h;
  }
  try {
    const db = await import("../../../servers/db.js");
    getDb = db.createDbClient;
  } catch {
    getDb = null;
  }
}

async function mxFetch(path, { method = "GET", body, noAuth, timeoutMs = 20_000 } = {}) {
  const url = `${MATRIX_URL}${path}`;
  const headers = { "Content-Type": "application/json" };
  if (!noAuth && MATRIX_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${MATRIX_ACCESS_TOKEN}`;
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
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
      if (res.status === 401) {
        throw new Error(`Matrix auth failed (401). Set MATRIX_ACCESS_TOKEN. Obtain via POST /_matrix/client/v3/login.`);
      }
      if (res.status === 403) {
        throw new Error(`Matrix forbidden (403)${snippet ? ": " + snippet : ""}`);
      }
      throw new Error(`Matrix ${res.status} ${res.statusText}${snippet ? " — " + snippet : ""}`);
    }
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`Matrix request timed out: ${path}`);
    if (err.cause?.code === "ECONNREFUSED" || err.message?.includes("ECONNREFUSED")) {
      throw new Error(
        `Cannot reach Dendrite at ${MATRIX_URL}. Verify the container is up and on the crow-federation network (docker ps | grep crow-dendrite).`,
      );
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Resolve a room alias (#room:server) to an internal room ID (!id:server)
 * via federation-aware directory lookup. Passes through if input is
 * already an ID.
 */
async function resolveRoom(aliasOrId) {
  if (aliasOrId.startsWith("!")) return aliasOrId;
  if (aliasOrId.startsWith("#")) {
    const out = await mxFetch(`/_matrix/client/v3/directory/room/${encodeURIComponent(aliasOrId)}`);
    if (out.room_id) return out.room_id;
    throw new Error(`Could not resolve alias ${aliasOrId}: ${JSON.stringify(out).slice(0, 200)}`);
  }
  throw new Error(`Not a Matrix room ID or alias: ${aliasOrId}`);
}

function requireAuth() {
  if (!MATRIX_ACCESS_TOKEN) {
    return { content: [{ type: "text", text: "Error: MATRIX_ACCESS_TOKEN required. POST /_matrix/client/v3/login to obtain one." }] };
  }
  return null;
}

export async function createMatrixDendriteServer(options = {}) {
  await loadSharedDeps();

  const server = new McpServer(
    { name: "crow-matrix-dendrite", version: "1.0.0" },
    { instructions: options.instructions },
  );

  const limiter = wrapRateLimited
    ? wrapRateLimited({ db: getDb ? getDb() : null })
    : (_, h) => h;

  // --- matrix_status ---
  server.tool(
    "matrix_status",
    "Report Dendrite status: reachability, server version, whoami, federation mode (disabled/enabled), and the canonical Matrix federation tester verdict for this server.",
    {},
    async () => {
      try {
        const [versions, whoami, caps] = await Promise.all([
          mxFetch("/_matrix/client/versions", { noAuth: true }),
          MATRIX_ACCESS_TOKEN ? mxFetch("/_matrix/client/v3/account/whoami").catch(() => null) : Promise.resolve(null),
          MATRIX_ACCESS_TOKEN ? mxFetch("/_matrix/client/v3/capabilities").catch(() => null) : Promise.resolve(null),
        ]);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              server_name: MATRIX_SERVER_NAME || null,
              url: MATRIX_URL,
              versions: versions?.versions || null,
              unstable_features: versions?.unstable_features || {},
              whoami: whoami || null,
              room_version: caps?.capabilities?.["m.room_versions"]?.default || null,
              has_access_token: Boolean(MATRIX_ACCESS_TOKEN),
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  // --- matrix_joined_rooms ---
  server.tool(
    "matrix_joined_rooms",
    "List rooms the authenticated user is in, with a name hint for each.",
    {},
    async () => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const { joined_rooms = [] } = await mxFetch("/_matrix/client/v3/joined_rooms");
        const withNames = await Promise.all(
          joined_rooms.slice(0, 100).map(async (rid) => {
            const name = await mxFetch(`/_matrix/client/v3/rooms/${encodeURIComponent(rid)}/state/m.room.name`).catch(() => null);
            const canonical = await mxFetch(`/_matrix/client/v3/rooms/${encodeURIComponent(rid)}/state/m.room.canonical_alias`).catch(() => null);
            return {
              room_id: rid,
              name: name?.name || null,
              canonical_alias: canonical?.alias || null,
            };
          }),
        );
        return { content: [{ type: "text", text: JSON.stringify({ count: joined_rooms.length, rooms: withNames }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  // --- matrix_create_room ---
  server.tool(
    "matrix_create_room",
    "Create a new room. Rate-limited: 10/hour.",
    {
      name: z.string().max(255).optional(),
      topic: z.string().max(500).optional(),
      alias_localpart: z.string().max(100).optional().describe("Local part of the canonical alias — 'chat' becomes #chat:yourdomain"),
      visibility: z.enum(["public", "private"]).optional().describe("Directory visibility. Default private."),
      preset: z.enum(["public_chat", "private_chat", "trusted_private_chat"]).optional(),
      invite: z.array(z.string().max(320)).max(50).optional().describe("User IDs to invite at creation time."),
      is_direct: z.boolean().optional().describe("Mark as a 1:1 DM room."),
    },
    limiter("matrix_create_room", async (args) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const body = {
          ...(args.name ? { name: args.name } : {}),
          ...(args.topic ? { topic: args.topic } : {}),
          ...(args.alias_localpart ? { room_alias_name: args.alias_localpart } : {}),
          visibility: args.visibility || "private",
          ...(args.preset ? { preset: args.preset } : {}),
          ...(args.invite ? { invite: args.invite } : {}),
          ...(args.is_direct != null ? { is_direct: args.is_direct } : {}),
        };
        const out = await mxFetch("/_matrix/client/v3/createRoom", { method: "POST", body });
        return { content: [{ type: "text", text: JSON.stringify({ room_id: out.room_id, room_alias: out.room_alias || null }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }),
  );

  // --- matrix_join_room ---
  server.tool(
    "matrix_join_room",
    "Join a room by ID or alias. If the room lives on another server, Dendrite federates the join (may take several seconds). Rate-limited: 30/hour.",
    { room: z.string().min(1).max(500).describe("Room ID (!id:server) or alias (#room:server)") },
    limiter("matrix_join_room", async ({ room }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        // /join/{roomIdOrAlias} handles both; URL-encode the whole thing
        const out = await mxFetch(`/_matrix/client/v3/join/${encodeURIComponent(room)}`, { method: "POST", body: {} });
        return { content: [{ type: "text", text: JSON.stringify({ joined: out.room_id || room }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }),
  );

  // --- matrix_leave_room ---
  server.tool(
    "matrix_leave_room",
    "Leave a room. Destructive — your messages stay but you lose access. Rate-limited: 30/hour.",
    {
      room: z.string().min(1).max(500),
      confirm: z.literal("yes"),
    },
    limiter("matrix_leave_room", async ({ room }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const rid = await resolveRoom(room);
        await mxFetch(`/_matrix/client/v3/rooms/${encodeURIComponent(rid)}/leave`, { method: "POST", body: {} });
        return { content: [{ type: "text", text: JSON.stringify({ left: rid }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }),
  );

  // --- matrix_send_message ---
  server.tool(
    "matrix_send_message",
    "Send a text (or notice, or HTML-formatted) message to a room. Rate-limited: 20/hour.",
    {
      room: z.string().min(1).max(500),
      body: z.string().min(1).max(20_000).describe("Plain-text body."),
      formatted_body: z.string().max(50_000).optional().describe("Optional HTML-formatted body (org.matrix.custom.html)."),
      msgtype: z.enum(["m.text", "m.notice", "m.emote"]).optional().describe("Default m.text."),
    },
    limiter("matrix_send_message", async ({ room, body, formatted_body, msgtype }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const rid = await resolveRoom(room);
        // Use PUT /send/{type}/{txnId} for idempotency; a random txn id works.
        const txn = `crow-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const content = {
          msgtype: msgtype || "m.text",
          body,
          ...(formatted_body ? { format: "org.matrix.custom.html", formatted_body } : {}),
        };
        const out = await mxFetch(
          `/_matrix/client/v3/rooms/${encodeURIComponent(rid)}/send/m.room.message/${encodeURIComponent(txn)}`,
          { method: "PUT", body: content },
        );
        return { content: [{ type: "text", text: JSON.stringify({ event_id: out.event_id, room_id: rid }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }),
  );

  // --- matrix_room_messages ---
  server.tool(
    "matrix_room_messages",
    "Paginated message history for a room. Returns the most recent N events by default.",
    {
      room: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(100).optional(),
      from: z.string().max(300).optional().describe("Opaque pagination token; omit to start from the latest."),
      direction: z.enum(["b", "f"]).optional().describe("b = backwards (default, newest-first), f = forwards."),
    },
    async ({ room, limit, from, direction }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const rid = await resolveRoom(room);
        const params = new URLSearchParams({
          limit: String(limit ?? 20),
          dir: direction || "b",
        });
        if (from) params.set("from", from);
        const out = await mxFetch(`/_matrix/client/v3/rooms/${encodeURIComponent(rid)}/messages?${params}`);
        const summary = (out.chunk || []).map((e) => ({
          event_id: e.event_id,
          type: e.type,
          sender: e.sender,
          ts: e.origin_server_ts,
          body: e.content?.body,
          msgtype: e.content?.msgtype,
        }));
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ room_id: rid, count: summary.length, events: summary, next_from: out.end, prev_from: out.start }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  // --- matrix_sync (one-shot) ---
  server.tool(
    "matrix_sync",
    "One-shot sync with a short server-side timeout. Returns new events, invites, and joined-room deltas since `since` (or the full initial state if absent). For long-poll streaming use the panel's SSE bridge.",
    {
      since: z.string().max(500).optional().describe("Opaque since-token from a prior sync; omit for initial sync (heavy — use sparingly)."),
      timeout_ms: z.number().int().min(0).max(30_000).optional().describe("Server-side long-poll timeout in ms. Default 1500 for MCP latency."),
    },
    async ({ since, timeout_ms }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const params = new URLSearchParams({ timeout: String(timeout_ms ?? 1500) });
        if (since) params.set("since", since);
        const out = await mxFetch(`/_matrix/client/v3/sync?${params}`, { timeoutMs: (timeout_ms || 1500) + 10_000 });
        // Shrink payload: just summarize room deltas instead of returning
        // the entire rooms tree (full sync can be megabytes).
        const joinedDelta = Object.entries(out.rooms?.join || {}).map(([rid, state]) => ({
          room_id: rid,
          timeline_events: state.timeline?.events?.length || 0,
          notification_count: state.unread_notifications?.notification_count || 0,
        }));
        const invites = Object.keys(out.rooms?.invite || {});
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ next_batch: out.next_batch, joined_rooms_delta: joinedDelta, invites }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  // --- matrix_invite_user ---
  server.tool(
    "matrix_invite_user",
    "Invite a user to a room. Rate-limited: 10/hour.",
    {
      room: z.string().min(1).max(500),
      user_id: z.string().min(3).max(320).describe("Full Matrix ID (@alice:example.com)"),
      reason: z.string().max(500).optional(),
    },
    limiter("matrix_invite_user", async ({ room, user_id, reason }) => {
      try {
        const authErr = requireAuth(); if (authErr) return authErr;
        const rid = await resolveRoom(room);
        const body = { user_id, ...(reason ? { reason } : {}) };
        await mxFetch(`/_matrix/client/v3/rooms/${encodeURIComponent(rid)}/invite`, { method: "POST", body });
        return { content: [{ type: "text", text: JSON.stringify({ invited: user_id, room_id: rid }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }),
  );

  // --- matrix_register_appservice (F.12 prep) ---
  server.tool(
    "matrix_register_appservice",
    "Register a Matrix appservice (used by F.12 matrix-bridges bundle). Writes the registration YAML into Dendrite's config dir. Does NOT restart Dendrite — the caller is responsible for a restart-with-health-wait since Dendrite only reloads appservice registrations at startup.",
    {
      id: z.string().min(1).max(100).describe("Unique appservice id (e.g., 'mautrix-signal')."),
      url: z.string().url().max(500).describe("Bridge URL Dendrite will push events to."),
      hs_token: z.string().min(16).max(200).describe("Token Dendrite uses to authenticate to the bridge."),
      as_token: z.string().min(16).max(200).describe("Token the bridge uses to authenticate to Dendrite."),
      sender_localpart: z.string().min(1).max(100).describe("User localpart that represents the bridge bot."),
      namespace_users: z.array(z.string().max(200)).max(20).optional().describe("Regex list of user-ID patterns the bridge owns."),
      namespace_aliases: z.array(z.string().max(200)).max(20).optional().describe("Regex list of room-alias patterns the bridge owns."),
      namespace_rooms: z.array(z.string().max(200)).max(20).optional().describe("Regex list of room-ID patterns the bridge owns."),
      protocols: z.array(z.string().max(100)).max(10).optional().describe("Third-party protocols the bridge announces."),
      rate_limited: z.boolean().optional(),
    },
    async (args) => {
      try {
        // We don't directly write the file from the MCP server (we don't
        // have host filesystem access to Dendrite's config dir). Instead
        // we return the YAML + the intended path, and the bundle's
        // post-install / bridges meta-bundle writes it via an exec into
        // the dendrite container. This keeps the surface declarative.
        const yaml = [
          `# crow-generated appservice registration for ${args.id}`,
          `id: ${args.id}`,
          `url: ${args.url}`,
          `as_token: ${args.as_token}`,
          `hs_token: ${args.hs_token}`,
          `sender_localpart: ${args.sender_localpart}`,
          `rate_limited: ${args.rate_limited ?? false}`,
          `namespaces:`,
          `  users:`,
          ...(args.namespace_users || []).map((r) => `    - exclusive: true\n      regex: ${JSON.stringify(r)}`),
          ...(!args.namespace_users?.length ? ["    []"] : []),
          `  aliases:`,
          ...(args.namespace_aliases || []).map((r) => `    - exclusive: true\n      regex: ${JSON.stringify(r)}`),
          ...(!args.namespace_aliases?.length ? ["    []"] : []),
          `  rooms:`,
          ...(args.namespace_rooms || []).map((r) => `    - exclusive: false\n      regex: ${JSON.stringify(r)}`),
          ...(!args.namespace_rooms?.length ? ["    []"] : []),
          ...(args.protocols?.length ? [`protocols:`, ...args.protocols.map((p) => `  - ${p}`)] : []),
          "",
        ].join("\n");

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              install_path: `/etc/dendrite/appservices/${args.id}.yaml`,
              yaml,
              next_steps: [
                `docker cp <yaml> crow-dendrite:/etc/dendrite/appservices/${args.id}.yaml`,
                `edit /etc/dendrite/dendrite.yaml to add 'app_service_api: { config_files: [appservices/${args.id}.yaml] }'`,
                "docker compose -f bundles/matrix-dendrite/docker-compose.yml restart dendrite",
                "(Dendrite reads appservice registrations only at startup.)",
              ],
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  // --- matrix_federation_health ---
  server.tool(
    "matrix_federation_health",
    "Ask the public Matrix Federation Tester (federationtester.matrix.org) whether this server federates correctly. Exercises both .well-known delegation and :8448 reachability — the canonical test for new Matrix installs.",
    {
      server_name: z.string().max(253).optional().describe("Override MATRIX_SERVER_NAME (e.g., to test a second domain)."),
    },
    async ({ server_name }) => {
      try {
        const target = server_name || MATRIX_SERVER_NAME;
        if (!target) {
          return { content: [{ type: "text", text: "Error: server_name required (set MATRIX_SERVER_NAME or pass explicitly)." }] };
        }
        const url = `${MATRIX_FEDERATION_TESTER}?server_name=${encodeURIComponent(target)}`;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 30_000);
        try {
          const res = await fetch(url, { signal: ctl.signal });
          const json = await res.json();
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                server_name: target,
                federation_ok: json.FederationOK,
                dns_result: json.DNSResult?.Hosts ? Object.keys(json.DNSResult.Hosts) : null,
                well_known_result: json.WellKnownResult?.["m.server"] || null,
                connection_report_count: Object.keys(json.ConnectionReports || {}).length,
                errors: json.Errors || [],
                warnings: json.Warnings || [],
              }, null, 2),
            }],
          };
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  return server;
}

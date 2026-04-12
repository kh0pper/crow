/**
 * WriteFreely MCP Server
 *
 * WriteFreely is a publish-oriented ActivityPub server — the tool
 * surface is intentionally narrower than GoToSocial's. WriteFreely does
 * not moderate remote content (inbound federation is limited to follow
 * events), so the block_domain / defederate / import_blocklist verbs
 * in the plan's moderation taxonomy are omitted here. Outbound
 * federation is governed by the federation.* fields in config.ini which
 * operators edit directly.
 *
 * Tools:
 *   wf_status            — health, site config, authenticated user
 *   wf_list_collections  — blogs owned by the authenticated user
 *   wf_create_post       — draft or published, optional collection
 *   wf_update_post       — edit an existing post
 *   wf_publish_post      — move a draft into a collection (public)
 *   wf_unpublish_post    — move a collection post back to drafts
 *   wf_delete_post       — destroy a post (destructive, confirmed)
 *   wf_list_posts        — list posts in a collection
 *   wf_get_post          — fetch a single post
 *   wf_export_posts      — dump authenticated user's posts as JSON
 *
 * Rate limiting: content-producing verbs are wrapped with the shared
 * token bucket (matches F.1 pattern, with installed-mode fallback).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const WF_URL = (process.env.WF_URL || "http://writefreely:8080").replace(/\/+$/, "");
const WF_ACCESS_TOKEN = process.env.WF_ACCESS_TOKEN || "";
const WF_COLLECTION_ALIAS = process.env.WF_COLLECTION_ALIAS || "";

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

async function wfFetch(path, { method = "GET", body, noAuth } = {}) {
  const url = `${WF_URL}${path}`;
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (!noAuth && WF_ACCESS_TOKEN) {
    // WriteFreely accepts Bearer OR Authorization: Token. Bearer is newer
    // and works with 0.14+.
    headers.Authorization = `Token ${WF_ACCESS_TOKEN}`;
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
          `WriteFreely auth failed (401). Set WF_ACCESS_TOKEN (obtain via POST /api/auth/login).`,
        );
      }
      if (res.status === 404) {
        throw new Error(`WriteFreely 404: ${path}${snippet ? " — " + snippet : ""}`);
      }
      throw new Error(`WriteFreely ${res.status} ${res.statusText}${snippet ? " — " + snippet : ""}`);
    }
    if (!text) return {};
    try {
      const parsed = JSON.parse(text);
      // WriteFreely wraps responses in { code, data } — unwrap when present
      return parsed?.data !== undefined && parsed?.code ? parsed.data : parsed;
    } catch {
      return { raw: text };
    }
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`WriteFreely request timed out: ${path}`);
    if (err.cause?.code === "ECONNREFUSED" || err.message?.includes("ECONNREFUSED")) {
      throw new Error(
        `Cannot reach WriteFreely at ${WF_URL}. Verify the container is on the crow-federation network (docker ps | grep crow-writefreely).`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function resolveCollection(alias) {
  return alias || WF_COLLECTION_ALIAS || null;
}

export async function createWritefreelyServer(options = {}) {
  await loadSharedDeps();

  const server = new McpServer(
    { name: "crow-writefreely", version: "1.0.0" },
    { instructions: options.instructions },
  );

  const limiter = wrapRateLimited
    ? wrapRateLimited({ db: getDb ? getDb() : null })
    : (_, h) => h;

  // --- wf_status ---
  server.tool(
    "wf_status",
    "Report WriteFreely instance health: reachability, federation status, authenticated user, collection count.",
    {},
    async () => {
      try {
        // Unauthenticated sanity check — GET / returns HTML; we hit a
        // known JSON endpoint instead.
        const me = WF_ACCESS_TOKEN ? await wfFetch("/api/me").catch(() => null) : null;
        const colls = WF_ACCESS_TOKEN
          ? await wfFetch("/api/me/collections").catch(() => [])
          : [];
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              instance_url: WF_URL,
              has_access_token: Boolean(WF_ACCESS_TOKEN),
              authenticated_as: me?.username || null,
              collections: Array.isArray(colls)
                ? colls.map((c) => ({ alias: c.alias, title: c.title, visibility: c.visibility }))
                : [],
              default_collection: WF_COLLECTION_ALIAS || null,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  // --- wf_list_collections ---
  server.tool(
    "wf_list_collections",
    "List blog collections owned by the authenticated user.",
    {},
    async () => {
      try {
        if (!WF_ACCESS_TOKEN) {
          return { content: [{ type: "text", text: "Error: WF_ACCESS_TOKEN required." }] };
        }
        const colls = await wfFetch("/api/me/collections");
        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              (colls || []).map((c) => ({
                alias: c.alias,
                title: c.title,
                description: c.description,
                visibility: c.visibility,
                views: c.views,
                post_count: c.total_posts,
              })),
              null, 2,
            ),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  // --- wf_create_post ---
  server.tool(
    "wf_create_post",
    "Create a post. If collection is omitted, the post is a draft (anonymous post, not federated until published to a collection). Rate-limited: 10/hour.",
    {
      title: z.string().max(500).optional().describe("Post title (shown at top; WriteFreely also extracts from first # heading if omitted)."),
      body: z.string().min(1).max(500_000).describe("Post body in Markdown. WriteFreely renders with its own extensions."),
      collection: z.string().max(200).optional().describe("Collection alias (blog) to publish to. If absent, post is a private draft."),
      font: z.enum(["norm", "serif", "sans", "mono", "wrap", "code"]).optional().describe("WriteFreely typography preset."),
      language: z.string().length(2).optional().describe("ISO 639-1 language code."),
      rtl: z.boolean().optional().describe("Right-to-left layout."),
      created: z.string().max(30).optional().describe("ISO timestamp override (useful for imports)."),
    },
    limiter("wf_create_post", async (args) => {
      try {
        if (!WF_ACCESS_TOKEN) {
          return { content: [{ type: "text", text: "Error: WF_ACCESS_TOKEN required to create posts." }] };
        }
        const body = {
          body: args.body,
          ...(args.title ? { title: args.title } : {}),
          ...(args.font ? { font: args.font } : {}),
          ...(args.language ? { lang: args.language } : {}),
          ...(args.rtl != null ? { rtl: args.rtl } : {}),
          ...(args.created ? { created: args.created } : {}),
        };
        const coll = resolveCollection(args.collection);
        const path = coll ? `/api/collections/${encodeURIComponent(coll)}/posts` : "/api/posts";
        const post = await wfFetch(path, { method: "POST", body });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              id: post.id,
              slug: post.slug,
              collection: coll,
              url: coll ? `${WF_URL}/${coll}/${post.slug}` : `${WF_URL}/${post.id}`,
              token: post.token,
              created: post.created,
              published: Boolean(coll),
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }),
  );

  // --- wf_update_post ---
  server.tool(
    "wf_update_post",
    "Edit an existing post by ID. Rate-limited: 20/hour.",
    {
      post_id: z.string().min(1).max(50),
      title: z.string().max(500).optional(),
      body: z.string().max(500_000).optional(),
      font: z.enum(["norm", "serif", "sans", "mono", "wrap", "code"]).optional(),
      language: z.string().length(2).optional(),
      rtl: z.boolean().optional(),
    },
    limiter("wf_update_post", async ({ post_id, ...rest }) => {
      try {
        if (!WF_ACCESS_TOKEN) {
          return { content: [{ type: "text", text: "Error: WF_ACCESS_TOKEN required." }] };
        }
        const body = {};
        for (const [k, v] of Object.entries(rest)) {
          if (v !== undefined) body[k === "language" ? "lang" : k] = v;
        }
        const post = await wfFetch(`/api/posts/${encodeURIComponent(post_id)}`, { method: "POST", body });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ id: post.id, slug: post.slug, updated: post.updated }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }),
  );

  // --- wf_publish_post ---
  server.tool(
    "wf_publish_post",
    "Move a draft post into a collection (blog), making it public and federated over ActivityPub. Rate-limited: 10/hour.",
    {
      post_id: z.string().min(1).max(50),
      collection: z.string().min(1).max(200).describe("Collection alias to publish to."),
    },
    limiter("wf_publish_post", async ({ post_id, collection }) => {
      try {
        if (!WF_ACCESS_TOKEN) {
          return { content: [{ type: "text", text: "Error: WF_ACCESS_TOKEN required." }] };
        }
        // WriteFreely publishes by POSTing a { id } into the collection
        const res = await wfFetch(`/api/collections/${encodeURIComponent(collection)}/collect`, {
          method: "POST",
          body: [{ id: post_id }],
        });
        return { content: [{ type: "text", text: JSON.stringify({ published: true, collection, post_id, response: res }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }),
  );

  // --- wf_unpublish_post ---
  server.tool(
    "wf_unpublish_post",
    "Move a collection post back to drafts (removes it from the public blog and federation). The post is NOT deleted.",
    { post_id: z.string().min(1).max(50) },
    limiter("wf_unpublish_post", async ({ post_id }) => {
      try {
        if (!WF_ACCESS_TOKEN) {
          return { content: [{ type: "text", text: "Error: WF_ACCESS_TOKEN required." }] };
        }
        // Unpublish = update post with collection: null
        const res = await wfFetch(`/api/posts/${encodeURIComponent(post_id)}`, {
          method: "POST",
          body: { crosspost: false, collection: null },
        });
        return { content: [{ type: "text", text: JSON.stringify({ unpublished: true, post_id, response: res }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }),
  );

  // --- wf_delete_post ---
  server.tool(
    "wf_delete_post",
    "Permanently delete a post. Destructive — the post is gone from the local instance; federated copies on remote servers may persist.",
    {
      post_id: z.string().min(1).max(50),
      confirm: z.literal("yes"),
    },
    limiter("wf_delete_post", async ({ post_id }) => {
      try {
        if (!WF_ACCESS_TOKEN) {
          return { content: [{ type: "text", text: "Error: WF_ACCESS_TOKEN required." }] };
        }
        await wfFetch(`/api/posts/${encodeURIComponent(post_id)}`, { method: "DELETE" });
        return { content: [{ type: "text", text: JSON.stringify({ deleted: true, post_id }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }),
  );

  // --- wf_list_posts ---
  server.tool(
    "wf_list_posts",
    "List posts in a collection (public endpoint — no auth required). Paginated.",
    {
      collection: z.string().max(200).optional().describe("Collection alias. Defaults to WF_COLLECTION_ALIAS."),
      page: z.number().int().min(1).max(1000).optional(),
    },
    async ({ collection, page }) => {
      try {
        const coll = resolveCollection(collection);
        if (!coll) {
          return { content: [{ type: "text", text: "Error: collection alias required (set WF_COLLECTION_ALIAS or pass explicitly)." }] };
        }
        const res = await wfFetch(
          `/api/collections/${encodeURIComponent(coll)}/posts?page=${page ?? 1}`,
          { noAuth: true },
        );
        const posts = res?.posts || res || [];
        const summary = (Array.isArray(posts) ? posts : []).map((p) => ({
          id: p.id,
          slug: p.slug,
          title: p.title,
          created: p.created,
          url: `${WF_URL}/${coll}/${p.slug}`,
          views: p.views,
        }));
        return { content: [{ type: "text", text: JSON.stringify({ collection: coll, count: summary.length, posts: summary }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  // --- wf_get_post ---
  server.tool(
    "wf_get_post",
    "Fetch a single post's full body + metadata. Works for public posts without auth.",
    {
      post_id: z.string().max(50).optional(),
      collection: z.string().max(200).optional(),
      slug: z.string().max(200).optional(),
    },
    async ({ post_id, collection, slug }) => {
      try {
        let path;
        if (post_id) {
          path = `/api/posts/${encodeURIComponent(post_id)}`;
        } else if (collection && slug) {
          path = `/api/collections/${encodeURIComponent(collection)}/posts/${encodeURIComponent(slug)}`;
        } else {
          return { content: [{ type: "text", text: "Error: provide either post_id OR (collection + slug)." }] };
        }
        const post = await wfFetch(path, { noAuth: !WF_ACCESS_TOKEN });
        return { content: [{ type: "text", text: JSON.stringify(post, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  // --- wf_export_posts ---
  server.tool(
    "wf_export_posts",
    "Export all posts owned by the authenticated user as JSON. Useful for migration and backup.",
    { format: z.enum(["json", "csv"]).optional().describe("Default json. csv includes title/body/collection/created.") },
    async ({ format }) => {
      try {
        if (!WF_ACCESS_TOKEN) {
          return { content: [{ type: "text", text: "Error: WF_ACCESS_TOKEN required." }] };
        }
        const path = `/api/me/posts${format === "csv" ? "?format=csv" : ""}`;
        const data = await wfFetch(path);
        if (format === "csv") {
          return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
        }
        const summary = Array.isArray(data)
          ? data.map((p) => ({ id: p.id, slug: p.slug, title: p.title, collection: p.collection?.alias, created: p.created, views: p.views }))
          : data;
        return { content: [{ type: "text", text: JSON.stringify({ count: Array.isArray(data) ? data.length : null, posts: summary }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  return server;
}

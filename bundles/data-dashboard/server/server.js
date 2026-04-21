/**
 * Data Dashboard — MCP Server Factory
 *
 * 10 MCP tools for data exploration, query execution, visualization,
 * and case study management. Operates on user-owned secondary databases,
 * never the core crow.db.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDbClient } from "../../../servers/db.js";
import { initDataDashboardTables } from "./init-tables.js";
import {
  executeReadQuery,
  executeWriteQuery,
  getSchema,
  getProjectDbDir,
  isPathSafe,
} from "./query-engine.js";
import { resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import {
  renderChart,
  renderMap,
  cacheKey,
  s3KeyFor,
} from "../../../servers/blog/figure-renderer.js";
import { uploadObject, getClient as getStorageClient } from "../../../servers/storage/s3-client.js";

const FIGURES_BUCKET = "capstone-research";
const GATEWAY_INTERNAL_URL = process.env.BLOG_FIGURE_GATEWAY_URL || "http://127.0.0.1:3002";

let _tablesInitialized = false;

export function createDataDashboardServer(dbPath, options = {}) {
  const db = createDbClient(dbPath);

  // Initialize bundle tables on first use
  if (!_tablesInitialized) {
    _tablesInitialized = true;
    initDataDashboardTables(db).catch(err => {
      console.warn("[data-dashboard] Table init failed:", err.message);
    });
  }

  const server = new McpServer(
    { name: "crow-data-dashboard", version: "1.0.0" },
    options.instructions ? { instructions: options.instructions } : undefined
  );

  // --- Helper: resolve database path from backend_id ---
  async function resolveDbPath(backendId) {
    const { rows } = await db.execute({
      sql: "SELECT connection_ref FROM data_backends WHERE id = ? AND backend_type = 'sqlite'",
      args: [backendId],
    });
    if (rows.length === 0) throw new Error(`Backend #${backendId} not found or not a SQLite backend.`);
    const ref = JSON.parse(rows[0].connection_ref);
    return ref.path;
  }

  // --- Tool: crow_data_list_databases ---
  server.tool(
    "crow_data_list_databases",
    "List all SQLite databases registered as data backends. Optionally filter by project.",
    {
      project_id: z.number().optional().describe("Filter by project ID"),
    },
    async ({ project_id }) => {
      let sql = "SELECT db.*, p.name as project_name FROM data_backends db LEFT JOIN research_projects p ON db.project_id = p.id WHERE db.backend_type = 'sqlite'";
      const args = [];
      if (project_id) {
        sql += " AND db.project_id = ?";
        args.push(project_id);
      }
      sql += " ORDER BY db.updated_at DESC";

      const { rows } = await db.execute({ sql, args });

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No SQLite databases registered. Use crow_data_create_database to create one." }] };
      }

      const formatted = rows.map(r => {
        const ref = JSON.parse(r.connection_ref || "{}");
        return `• ${r.name} (backend #${r.id})\n  Project: ${r.project_name || "none"} | Status: ${r.status}\n  Path: ${ref.path || "unknown"}`;
      }).join("\n\n");

      return { content: [{ type: "text", text: `SQLite databases (${rows.length}):\n\n${formatted}` }] };
    }
  );

  // --- Tool: crow_data_schema ---
  server.tool(
    "crow_data_schema",
    "Get the schema (tables, columns, types, row counts, indexes) for a registered SQLite database.",
    {
      backend_id: z.number().describe("Data backend ID"),
    },
    async ({ backend_id }) => {
      const dbPath = await resolveDbPath(backend_id);
      const schema = await getSchema(dbPath);

      const formatted = schema.tables.map(t => {
        const cols = t.columns.map(c =>
          `    ${c.name} ${c.type}${c.pk ? " PK" : ""}${c.notnull ? " NOT NULL" : ""}${c.default_value ? ` DEFAULT ${c.default_value}` : ""}`
        ).join("\n");
        return `${t.name} (${t.rowCount} rows)\n${cols}${t.indexes.length > 0 ? `\n    Indexes: ${t.indexes.join(", ")}` : ""}`;
      }).join("\n\n");

      return { content: [{ type: "text", text: `Schema for backend #${backend_id}:\n\n${formatted}` }] };
    }
  );

  // --- Tool: crow_data_query ---
  server.tool(
    "crow_data_query",
    "Execute a read-only SQL query on a user-owned SQLite database. Only SELECT, EXPLAIN, PRAGMA, and WITH are allowed. Max 5000 rows, 10s timeout.",
    {
      backend_id: z.number().describe("Data backend ID"),
      sql: z.string().max(10000).describe("SQL query (SELECT/EXPLAIN/PRAGMA/WITH only)"),
      limit: z.number().max(5000).default(100).describe("Max rows to return"),
    },
    async ({ backend_id, sql: query, limit }) => {
      const dbPath = await resolveDbPath(backend_id);
      const result = await executeReadQuery(dbPath, query, limit);

      if (result.rowCount === 0) {
        return { content: [{ type: "text", text: `Query returned 0 rows (${result.executionMs}ms)` }] };
      }

      // Format as text table
      const cols = result.columns;
      const rows = result.rows.map(r =>
        cols.map(c => String(r[c] ?? "NULL")).join(" | ")
      );
      const header = cols.join(" | ");
      const separator = cols.map(() => "---").join(" | ");

      return {
        content: [{
          type: "text",
          text: `${result.rowCount} rows (${result.executionMs}ms)\n\n${header}\n${separator}\n${rows.join("\n")}`,
        }],
      };
    }
  );

  // --- Tool: crow_data_preview ---
  server.tool(
    "crow_data_preview",
    "Quick preview of a table's first N rows.",
    {
      backend_id: z.number().describe("Data backend ID"),
      table: z.string().max(200).describe("Table name"),
      limit: z.number().max(100).default(10).describe("Number of rows"),
    },
    async ({ backend_id, table, limit }) => {
      const dbPath = await resolveDbPath(backend_id);
      // Sanitize table name (alphanumeric + underscore only)
      const safeTable = table.replace(/[^a-zA-Z0-9_]/g, "");
      const result = await executeReadQuery(dbPath, `SELECT * FROM "${safeTable}"`, limit);

      if (result.rowCount === 0) {
        return { content: [{ type: "text", text: `Table "${safeTable}" is empty.` }] };
      }

      const cols = result.columns;
      const rows = result.rows.map(r =>
        cols.map(c => {
          const val = String(r[c] ?? "NULL");
          return val.length > 50 ? val.substring(0, 47) + "..." : val;
        }).join(" | ")
      );

      return {
        content: [{
          type: "text",
          text: `${safeTable} (${result.rowCount} rows shown):\n\n${cols.join(" | ")}\n${cols.map(() => "---").join(" | ")}\n${rows.join("\n")}`,
        }],
      };
    }
  );

  // --- Tool: crow_data_create_database ---
  server.tool(
    "crow_data_create_database",
    "Create a new empty SQLite database and register it as a project data backend.",
    {
      project_id: z.number().describe("Project ID to associate with"),
      name: z.string().max(200).describe("Database name (e.g., 'survey-results')"),
    },
    async ({ project_id, name }) => {
      const dir = getProjectDbDir(project_id);
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
      const dbPath = resolve(dir, `${safeName}.db`);

      if (existsSync(dbPath)) {
        return { content: [{ type: "text", text: `Database already exists: ${dbPath}` }], isError: true };
      }

      // Create empty database (libsql creates on first connect)
      const userDb = (await import("@libsql/client")).createClient({ url: `file:${dbPath}` });
      await userDb.execute("SELECT 1"); // Force creation
      userDb.close();

      // Register as backend
      const connRef = JSON.stringify({ path: dbPath });
      const result = await db.execute({
        sql: "INSERT INTO data_backends (project_id, name, backend_type, connection_ref, status) VALUES (?, ?, 'sqlite', ?, 'connected')",
        args: [project_id, name, connRef],
      });

      const backendId = Number(result.lastInsertRowid);
      return {
        content: [{
          type: "text",
          text: `Database created and registered.\n\nName: ${name}\nBackend ID: ${backendId}\nPath: ${dbPath}\n\nUse crow_data_write to create tables and insert data.`,
        }],
      };
    }
  );

  // --- Tool: crow_data_write ---
  server.tool(
    "crow_data_write",
    "Execute a write SQL statement (INSERT, CREATE TABLE, UPDATE, DELETE) on a user-owned database. Separate from read-only queries for safety.",
    {
      backend_id: z.number().describe("Data backend ID"),
      sql: z.string().max(50000).describe("SQL statement (INSERT/CREATE/UPDATE/DELETE/ALTER/DROP)"),
    },
    async ({ backend_id, sql: statement }) => {
      const dbPath = await resolveDbPath(backend_id);
      const result = await executeWriteQuery(dbPath, statement);

      return {
        content: [{
          type: "text",
          text: `Write executed (${result.executionMs}ms). Rows affected: ${result.rowsAffected}`,
        }],
      };
    }
  );

  // --- Tool: crow_data_save_query ---
  server.tool(
    "crow_data_save_query",
    "Save a named query or chart configuration for reuse.",
    {
      backend_id: z.number().describe("Data backend ID"),
      project_id: z.number().optional().describe("Project ID"),
      name: z.string().max(200).describe("Name for this saved item"),
      item_type: z.enum(["query", "chart"]).describe("Type: query or chart"),
      sql: z.string().max(10000).optional().describe("SQL query"),
      config: z.string().max(10000).optional().describe("JSON config (chart type, axes, filters)"),
      description: z.string().max(1000).optional().describe("Description"),
    },
    async ({ backend_id, project_id, name, item_type, sql: query, config, description }) => {
      const result = await db.execute({
        sql: "INSERT INTO data_dashboard_items (project_id, backend_id, name, item_type, sql, config, description) VALUES (?, ?, ?, ?, ?, ?, ?)",
        args: [project_id ?? null, backend_id, name, item_type, query ?? null, config ?? null, description ?? null],
      });

      return {
        content: [{ type: "text", text: `Saved ${item_type} "${name}" (id: ${Number(result.lastInsertRowid)})` }],
      };
    }
  );

  // --- Tool: crow_data_list_saved ---
  server.tool(
    "crow_data_list_saved",
    "List saved queries, charts, and case studies.",
    {
      project_id: z.number().optional().describe("Filter by project ID"),
      item_type: z.enum(["query", "chart"]).optional().describe("Filter by type"),
    },
    async ({ project_id, item_type }) => {
      // Saved items
      let itemSql = "SELECT * FROM data_dashboard_items WHERE 1=1";
      const itemArgs = [];
      if (project_id) { itemSql += " AND project_id = ?"; itemArgs.push(project_id); }
      if (item_type) { itemSql += " AND item_type = ?"; itemArgs.push(item_type); }
      itemSql += " ORDER BY updated_at DESC LIMIT 50";
      const { rows: items } = await db.execute({ sql: itemSql, args: itemArgs });

      // Case studies
      let csSql = "SELECT * FROM data_case_studies WHERE 1=1";
      const csArgs = [];
      if (project_id) { csSql += " AND project_id = ?"; csArgs.push(project_id); }
      csSql += " ORDER BY updated_at DESC LIMIT 20";
      const { rows: studies } = await db.execute({ sql: csSql, args: csArgs });

      const parts = [];
      if (items.length > 0) {
        parts.push(`Saved items (${items.length}):\n${items.map(i => `  • [${i.item_type}] ${i.name} (id: ${i.id})${i.description ? ` — ${i.description}` : ""}`).join("\n")}`);
      }
      if (studies.length > 0) {
        parts.push(`Case studies (${studies.length}):\n${studies.map(s => `  • ${s.title} (id: ${s.id})${s.blog_post_id ? " [published]" : ""}`).join("\n")}`);
      }

      if (parts.length === 0) {
        return { content: [{ type: "text", text: "No saved items or case studies yet." }] };
      }

      return { content: [{ type: "text", text: parts.join("\n\n") }] };
    }
  );

  // --- Tool: crow_data_case_study_create ---
  server.tool(
    "crow_data_case_study_create",
    "Create a case study with text, chart, or map sections. Case studies can be published to the Crow blog.",
    {
      project_id: z.number().optional().describe("Associated project ID"),
      title: z.string().max(500).describe("Case study title"),
      description: z.string().max(2000).optional().describe("Brief description"),
      sections: z.array(z.object({
        section_type: z.enum(["text", "chart", "map"]),
        title: z.string().max(500).optional(),
        content: z.string().max(50000).optional().describe("Markdown content (text sections)"),
        sql: z.string().max(10000).optional().describe("SQL query (chart/map sections)"),
        config: z.string().max(10000).optional().describe("JSON config (chart type, axes, map settings)"),
      })).optional().describe("Sections to add"),
    },
    async ({ project_id, title, description, sections }) => {
      const result = await db.execute({
        sql: "INSERT INTO data_case_studies (project_id, title, description) VALUES (?, ?, ?)",
        args: [project_id ?? null, title, description ?? null],
      });
      const caseStudyId = Number(result.lastInsertRowid);

      // Add sections
      if (sections && sections.length > 0) {
        for (let i = 0; i < sections.length; i++) {
          const s = sections[i];
          await db.execute({
            sql: "INSERT INTO data_case_study_sections (case_study_id, section_type, sort_order, title, content, sql, config) VALUES (?, ?, ?, ?, ?, ?, ?)",
            args: [caseStudyId, s.section_type, i, s.title ?? null, s.content ?? null, s.sql ?? null, s.config ?? null],
          });
        }
      }

      return {
        content: [{
          type: "text",
          text: `Case study created: "${title}" (id: ${caseStudyId})${sections ? ` with ${sections.length} section(s)` : ""}`,
        }],
      };
    }
  );

  // --- Tool: crow_data_case_study_publish ---
  server.tool(
    "crow_data_case_study_publish",
    "Publish a case study as a Crow blog post. Emits <figure> HTML with static PNG fallbacks for charts and maps; the interactive hydration layer (blog-hydrate) swaps in live widgets client-side.",
    {
      case_study_id: z.number().describe("Case study ID to publish"),
      overwrite: z.boolean().optional().describe(
        "Re-emit content for an already-published post. If false (default) and blog_post_id is set, returns early without changes. If true and blog_post_id is set, UPDATE the existing row (content + updated_at); blog_post_id stays stable. If true and blog_post_id is NULL, INSERT as usual (idempotent)."
      ),
    },
    async ({ case_study_id, overwrite }) => {
      const { rows: studies } = await db.execute({
        sql: "SELECT * FROM data_case_studies WHERE id = ?",
        args: [case_study_id],
      });
      if (studies.length === 0) {
        return { content: [{ type: "text", text: `Case study #${case_study_id} not found.` }], isError: true };
      }

      const study = studies[0];
      const alreadyPublished = study.blog_post_id != null;
      if (alreadyPublished && !overwrite) {
        return { content: [{ type: "text", text: `Already published as blog post #${study.blog_post_id}. Pass overwrite=true to re-emit content.` }] };
      }

      const { rows: sections } = await db.execute({
        sql: "SELECT * FROM data_case_study_sections WHERE case_study_id = ? ORDER BY sort_order",
        args: [case_study_id],
      });

      const articleParts = [`<article itemscope itemtype="https://schema.org/Article">`];
      articleParts.push(`<h1 itemprop="headline">${escapeHtml(study.title)}</h1>`);
      if (study.description) {
        articleParts.push(`<p itemprop="description">${escapeHtml(study.description)}</p>`);
      }

      let figuresRendered = 0;
      const failures = [];

      for (const s of sections) {
        const titleHtml = s.title ? `<h2>${escapeHtml(s.title)}</h2>` : "";
        articleParts.push(titleHtml);

        if (s.section_type === "text") {
          if (s.content) articleParts.push(s.content);
        } else if (s.section_type === "chart" || s.section_type === "map") {
          try {
            const result = await renderSectionFigure(s, study, { skipIfCached: true });
            articleParts.push(result.html);
            figuresRendered += 1;
          } catch (err) {
            failures.push(`section #${s.id} (${s.section_type}): ${err.message}`);
            articleParts.push(`<figure class="crow-${s.section_type}"><figcaption>${escapeHtml(s.title || s.section_type)} — render failed</figcaption></figure>`);
          }
        }
      }

      articleParts.push(`</article>`);

      if (failures.length > 0) {
        return {
          content: [{
            type: "text",
            text: `Publish aborted — ${failures.length} figure(s) failed to render:\n${failures.join("\n")}`,
          }],
          isError: true,
        };
      }

      const content = articleParts.join("\n\n");
      const slug = study.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

      let postId;
      let action;
      if (alreadyPublished && overwrite) {
        await db.execute({
          sql: "UPDATE blog_posts SET title = ?, slug = ?, content = ?, updated_at = datetime('now') WHERE id = ?",
          args: [study.title, slug, content, study.blog_post_id],
        });
        postId = study.blog_post_id;
        action = "updated";
      } else {
        const postResult = await db.execute({
          sql: "INSERT INTO blog_posts (title, slug, content, status, visibility, tags) VALUES (?, ?, ?, 'draft', 'public', 'case-study')",
          args: [study.title, slug, content],
        });
        postId = Number(postResult.lastInsertRowid);
        await db.execute({
          sql: "UPDATE data_case_studies SET blog_post_id = ?, updated_at = datetime('now') WHERE id = ?",
          args: [postId, case_study_id],
        });
        action = "inserted";
      }

      return {
        content: [{
          type: "text",
          text: `Blog post #${postId} (draft) ${action}.\n\nTitle: ${study.title}\nSlug: ${slug}\nSections: ${sections.length}\nFigures rendered: ${figuresRendered}\n\nStatus stays 'draft' until crow_publish_post flips it. Visibility stays 'public' by default.`,
        }],
      };
    }
  );

  // --- Tool: crow_data_case_study_rerender_figures ---
  // Re-renders the PNG fallbacks for a case study without touching the
  // blog post's markdown content. Used when tea_data.db is refreshed and
  // the static images need to reflect new data.
  server.tool(
    "crow_data_case_study_rerender_figures",
    "Re-render PNG fallbacks for a case study's chart and map sections. Does not modify the published markdown (which carries stable /blog/figures/... URLs); the next page load reflects new PNGs via cache-busted filenames. Honors figure_cache_key so unchanged data skips by default.",
    {
      case_study_id: z.number().int().positive().describe("data_case_studies.id"),
      force: z.boolean().optional().describe(
        "Force re-render even when the cache key matches an existing MinIO object. Default false."
      ),
    },
    async ({ case_study_id, force }) => {
      const { rows: studies } = await db.execute({
        sql: "SELECT * FROM data_case_studies WHERE id = ?",
        args: [case_study_id],
      });
      if (studies.length === 0) {
        return { content: [{ type: "text", text: `Case study #${case_study_id} not found.` }], isError: true };
      }
      const study = studies[0];

      const { rows: sections } = await db.execute({
        sql: "SELECT * FROM data_case_study_sections WHERE case_study_id = ? AND section_type IN ('chart','map') ORDER BY sort_order",
        args: [case_study_id],
      });

      let rendered = 0, cached = 0;
      const failures = [];
      const details = [];

      for (const s of sections) {
        try {
          const outcome = await renderSectionFigure(s, study, { skipIfCached: !force });
          if (outcome.cached) {
            cached += 1;
            details.push(`#${s.id} (${s.section_type}) cached → ${outcome.s3Key}`);
          } else {
            rendered += 1;
            details.push(`#${s.id} (${s.section_type}) rendered → ${outcome.s3Key}`);
          }
        } catch (err) {
          failures.push(`#${s.id} (${s.section_type}): ${err.message}`);
        }
      }

      // Bump updated_at on the linked post so RSS readers re-fetch.
      if (rendered > 0 && study.blog_post_id) {
        await db.execute({
          sql: "UPDATE blog_posts SET updated_at = datetime('now') WHERE id = ?",
          args: [study.blog_post_id],
        });
      }

      const summary = [
        `Case study #${case_study_id}: ${study.title}`,
        `Chart/map sections: ${sections.length}`,
        `Rendered: ${rendered} · Cached (unchanged): ${cached} · Failed: ${failures.length}`,
        failures.length > 0 ? `\nFailures:\n${failures.join("\n")}` : "",
        `\n${details.join("\n")}`,
      ].filter(Boolean).join("\n");

      return {
        content: [{ type: "text", text: summary }],
        isError: failures.length > 0,
      };
    }
  );

  return server;

  // ── Helpers scoped to the publish transform ──────────────────────

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  /**
   * Compute the cache key for a chart/map section, skip upload if the
   * cache-keyed object already exists (when opts.skipIfCached), else
   * render the PNG and upload to MinIO. Always returns the <figure>
   * HTML + s3 key + whether a cache hit was taken.
   */
  async function renderSectionFigure(section, study, opts = {}) {
    const skipIfCached = opts.skipIfCached === true;
    const config = section.config ? JSON.parse(section.config) : {};
    const backendId = config.backend_id ?? null;

    let digestInput, geojson, rows;
    if (section.section_type === "chart") {
      if (!section.sql) throw new Error("chart section missing sql");
      if (!backendId) throw new Error("chart section missing config.backend_id");
      const dbPath = await resolveDbPath(backendId);
      const result = await executeReadQuery(dbPath, section.sql);
      rows = result.rows;
      digestInput = rows;
    } else if (section.section_type === "map") {
      geojson = await fetchGeojsonForSection(config);
      digestInput = (geojson.features || []).map((f) => f.properties?.metric_data ?? null);
    } else {
      throw new Error(`unsupported section_type ${section.section_type}`);
    }

    const key = cacheKey({
      sectionId: section.id,
      config,
      sql: section.sql || "",
      dataDigestInput: digestInput,
    });
    const s3Key = s3KeyFor(section.id, key);

    let cached = false;
    if (skipIfCached && (await figureObjectExists(s3Key))) {
      cached = true;
    } else {
      const buffer = section.section_type === "chart"
        ? await renderChart({ config: { ...config, title: section.title }, rows })
        : await renderMap({ config: { ...config, title: section.title }, title: section.title || "", geojson });
      await uploadObject(s3Key, buffer, {
        bucket: FIGURES_BUCKET,
        contentType: "image/png",
      });
    }

    const html = buildFigureHtml(section, config, backendId, s3Key);
    return { s3Key, cached, html };
  }

  async function figureObjectExists(s3Key) {
    try {
      const client = getStorageClient();
      if (!client) return false;
      await client.statObject(FIGURES_BUCKET, s3Key);
      return true;
    } catch {
      return false;
    }
  }

  function buildFigureHtml(section, config, backendId, s3Key) {
    const cls = section.section_type === "chart" ? "crow-chart" : "crow-map";
    const imgUrl = `/blog/${s3Key}`;
    const dataBackend = backendId ? ` data-backend-id="${backendId}"` : "";
    let mapData = "";
    if (section.section_type === "map") {
      if (config.metric) mapData += ` data-metric="${escapeHtml(config.metric)}"`;
      if (config.field) mapData += ` data-field="${escapeHtml(config.field)}"`;
    }
    const caption = section.caption || "";
    const figcaption = [section.title, caption].filter(Boolean).map(escapeHtml).join(". ");

    return [
      `<figure class="${cls}" data-section-id="${section.id}"${dataBackend}${mapData}>`,
      `  <img src="${imgUrl}" alt="${escapeHtml(section.title || section.section_type)}" loading="lazy" width="1200" height="800">`,
      figcaption ? `  <figcaption>${figcaption}</figcaption>` : "",
      `</figure>`,
    ].filter(Boolean).join("\n");
  }

  async function fetchGeojsonForSection(config) {
    const params = new URLSearchParams();
    if (config.backend_id != null) params.set("backend_id", String(config.backend_id));
    if (config.metric) params.set("metric", config.metric);
    if (config.year) params.set("year", config.year);
    if (config.region) params.set("region", String(config.region));
    if (config.county) params.set("county", config.county);
    const url = `${GATEWAY_INTERNAL_URL}/bundles/tea-maps/api/geojson?${params.toString()}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`tea-maps geojson fetch failed: ${resp.status} ${resp.statusText}`);
    return resp.json();
  }
}

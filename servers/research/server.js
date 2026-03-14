/**
 * Crow Project Server — Server Factory
 *
 * Creates a configured McpServer with all project management tools registered.
 * Supports research projects (default), data connector projects, and extensible types.
 * Transport-agnostic: used by both stdio (index.js) and HTTP (gateway).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDbClient, sanitizeFtsQuery, escapeLikePattern } from "../db.js";

const SOURCE_TYPES = [
  "web_article", "academic_paper", "book", "interview",
  "web_search", "web_scrape", "api_data", "document",
  "video", "podcast", "social_media", "government_doc",
  "dataset", "other",
];

function generateAPA({ authors, title, publication_date, publisher, url, source_type, doi }) {
  const authorStr = authors || "Unknown Author";
  const year = publication_date
    ? `(${new Date(publication_date).getFullYear()})`
    : "(n.d.)";
  const titleStr = title || "Untitled";

  switch (source_type) {
    case "academic_paper":
      return `${authorStr} ${year}. ${titleStr}.${publisher ? ` ${publisher}.` : ""}${doi ? ` https://doi.org/${doi}` : url ? ` ${url}` : ""}`;
    case "book":
      return `${authorStr} ${year}. *${titleStr}*.${publisher ? ` ${publisher}.` : ""}`;
    case "web_article":
    case "web_search":
    case "web_scrape":
      return `${authorStr} ${year}. ${titleStr}.${publisher ? ` ${publisher}.` : ""} Retrieved from ${url || "unknown URL"}`;
    case "video":
      return `${authorStr} ${year}. ${titleStr} [Video].${publisher ? ` ${publisher}.` : ""} ${url || ""}`;
    case "podcast":
      return `${authorStr} ${year}. ${titleStr} [Audio podcast episode].${publisher ? ` ${publisher}.` : ""} ${url || ""}`;
    case "interview":
      return `${authorStr} ${year}. ${titleStr} [Interview].`;
    default:
      return `${authorStr} ${year}. ${titleStr}.${url ? ` ${url}` : ""}`;
  }
}

function generateMLA({ authors, title, publication_date, publisher, url, source_type }) {
  const authorStr = authors || "Unknown Author";
  const titleStr = title || "Untitled";
  const pubDate = publication_date
    ? new Date(publication_date).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : "n.d.";

  switch (source_type) {
    case "book":
      return `${authorStr}. *${titleStr}*.${publisher ? ` ${publisher},` : ""} ${pubDate}.`;
    case "academic_paper":
      return `${authorStr}. "${titleStr}."${publisher ? ` *${publisher}*,` : ""} ${pubDate}.${url ? ` ${url}.` : ""}`;
    case "web_article":
    case "web_search":
    case "web_scrape":
      return `${authorStr}. "${titleStr}."${publisher ? ` *${publisher}*,` : ""} ${pubDate}.${url ? ` ${url}.` : ""}`;
    case "video":
      return `"${titleStr}." Online video.${publisher ? ` ${publisher},` : ""} ${pubDate}.${url ? ` ${url}.` : ""}`;
    case "podcast":
      return `"${titleStr}." Audio podcast episode.${publisher ? ` ${publisher},` : ""} ${pubDate}.${url ? ` ${url}.` : ""}`;
    case "interview":
      return `${authorStr}. Personal interview. ${pubDate}.`;
    default:
      return `${authorStr}. "${titleStr}."${publisher ? ` ${publisher},` : ""} ${pubDate}.${url ? ` ${url}.` : ""}`;
  }
}

function generateChicago({ authors, title, publication_date, publisher, url, source_type, doi }) {
  const authorStr = authors || "Unknown Author";
  const titleStr = title || "Untitled";
  const pubDate = publication_date
    ? new Date(publication_date).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : "n.d.";
  const year = publication_date
    ? new Date(publication_date).getFullYear()
    : "n.d.";

  switch (source_type) {
    case "book":
      return `${authorStr}. *${titleStr}*.${publisher ? ` ${publisher},` : ""} ${year}.`;
    case "academic_paper":
      return `${authorStr}. "${titleStr}."${publisher ? ` ${publisher}` : ""} (${year}).${doi ? ` https://doi.org/${doi}.` : url ? ` ${url}.` : ""}`;
    case "web_article":
    case "web_search":
    case "web_scrape":
      return `${authorStr}. "${titleStr}."${publisher ? ` ${publisher}.` : ""} ${pubDate}.${url ? ` ${url}.` : ""}`;
    case "video":
      return `${authorStr}. "${titleStr}." Video.${publisher ? ` ${publisher},` : ""} ${pubDate}.${url ? ` ${url}.` : ""}`;
    case "podcast":
      return `${authorStr}. "${titleStr}." Podcast audio.${publisher ? ` ${publisher},` : ""} ${pubDate}.${url ? ` ${url}.` : ""}`;
    case "interview":
      return `${authorStr}. Interview by author. ${pubDate}.`;
    default:
      return `${authorStr}. "${titleStr}."${publisher ? ` ${publisher},` : ""} ${pubDate}.${url ? ` ${url}.` : ""}`;
  }
}

function generateWebCitation({ title, url, publication_date, retrieval_method }) {
  const titleStr = title || "Untitled";
  const accessDate = new Date().toISOString().split("T")[0];
  const aiNote = retrieval_method ? ` [Found via ${retrieval_method}]` : "";
  return `${titleStr}. ${url || "No URL"}. Accessed ${accessDate}.${aiNote}`;
}

const CITATION_GENERATORS = {
  apa: generateAPA,
  mla: generateMLA,
  chicago: generateChicago,
  web: generateWebCitation,
};

function generateAllCitations(source) {
  return {
    apa: generateAPA(source),
    mla: generateMLA(source),
    chicago: generateChicago(source),
    web: generateWebCitation(source),
  };
}

export function createProjectServer(dbPath, options = {}) {
  const db = createDbClient(dbPath);

  const server = new McpServer(
    { name: "crow-projects", version: "0.1.0" },
    options.instructions ? { instructions: options.instructions } : undefined
  );

  // --- Project Tools ---

  server.tool(
    "crow_create_project",
    "Create a new project to organize sources, notes, and data backends under.",
    {
      name: z.string().max(500).describe("Project name"),
      description: z.string().max(50000).optional().describe("Project description and goals"),
      type: z.string().max(100).default("research").describe("Project type: 'research' (default), 'data_connector', or custom"),
      tags: z.string().max(500).optional().describe("Comma-separated tags"),
    },
    async ({ name, description, type, tags }) => {
      const result = await db.execute({
        sql: "INSERT INTO research_projects (name, description, type, tags) VALUES (?, ?, ?, ?)",
        args: [name, description ?? null, type, tags ?? null],
      });
      const projectId = Number(result.lastInsertRowid);
      let text = `Project created: "${name}" (id: ${projectId}, type: ${type})`;
      if (type === "data_connector") {
        text += `\n\nNext step: Use crow_register_backend to connect an external MCP server to this project.`;
      }
      return {
        content: [{ type: "text", text }],
      };
    }
  );

  server.tool(
    "crow_list_projects",
    "List all projects with their status, type, and source counts.",
    {
      status: z.enum(["active", "paused", "completed", "archived"]).optional().describe("Filter by status"),
      type: z.string().max(100).optional().describe("Filter by project type (research, data_connector, etc.)"),
      limit: z.number().max(100).default(20).describe("Maximum results to return"),
      offset: z.number().default(0).describe("Number of results to skip"),
    },
    async ({ status, type, limit, offset }) => {
      let sql = `
        SELECT p.*, COUNT(s.id) as source_count,
               (SELECT COUNT(*) FROM research_notes n WHERE n.project_id = p.id) as note_count
        FROM research_projects p
        LEFT JOIN research_sources s ON s.project_id = p.id
      `;
      const params = [];
      const conditions = [];
      if (status) {
        conditions.push("p.status = ?");
        params.push(status);
      }
      if (type) {
        conditions.push("p.type = ?");
        params.push(type);
      }
      if (conditions.length > 0) {
        sql += " WHERE " + conditions.join(" AND ");
      }
      sql += " GROUP BY p.id ORDER BY p.updated_at DESC LIMIT ? OFFSET ?";
      params.push(limit, offset);

      const { rows } = await db.execute({ sql, args: params });
      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No projects found." }] };
      }

      const formatted = rows
        .map(
          (r) =>
            `[#${r.id}] ${r.name} (${r.type || "research"}, ${r.status}) - ${r.source_count} sources, ${r.note_count} notes\n  ${r.description || "No description"}${r.tags ? `\n  Tags: ${r.tags}` : ""}`
        )
        .join("\n\n");

      return { content: [{ type: "text", text: formatted }] };
    }
  );

  server.tool(
    "crow_update_project",
    "Update a project's name, description, status, type, or tags.",
    {
      id: z.number().describe("Project ID"),
      name: z.string().max(500).optional(),
      description: z.string().max(50000).optional(),
      status: z.enum(["active", "paused", "completed", "archived"]).optional(),
      type: z.string().max(100).optional().describe("Project type"),
      tags: z.string().max(500).optional(),
    },
    async ({ id, name, description, status, type, tags }) => {
      const updates = [];
      const params = [];
      if (name !== undefined) { updates.push("name = ?"); params.push(name); }
      if (description !== undefined) { updates.push("description = ?"); params.push(description); }
      if (status !== undefined) { updates.push("status = ?"); params.push(status); }
      if (type !== undefined) { updates.push("type = ?"); params.push(type); }
      if (tags !== undefined) { updates.push("tags = ?"); params.push(tags); }

      if (updates.length === 0) {
        return { content: [{ type: "text", text: "No updates provided." }] };
      }

      updates.push("updated_at = datetime('now')");
      params.push(id);
      await db.execute({ sql: `UPDATE research_projects SET ${updates.join(", ")} WHERE id = ?`, args: params });
      return { content: [{ type: "text", text: `Project #${id} updated.` }] };
    }
  );

  // --- Source Tools ---

  server.tool(
    "crow_add_source",
    "Add a source with full metadata and automatic citation generation (APA, MLA, Chicago, web).",
    {
      title: z.string().max(500).describe("Title of the source"),
      source_type: z.enum(SOURCE_TYPES).describe("Type of source"),
      project_id: z.number().optional().describe("Associate with a project"),
      backend_id: z.number().optional().describe("Associate with a data backend"),
      url: z.string().max(2000).optional().describe("URL where the source was found"),
      authors: z.string().max(1000).optional().describe("Author(s) - 'Last, F. M.' format, separate multiple with '&'"),
      publication_date: z.string().max(20).optional().describe("Publication date (YYYY-MM-DD or YYYY)"),
      publisher: z.string().max(1000).optional().describe("Publisher or website name"),
      doi: z.string().max(500).optional().describe("DOI (for academic papers)"),
      isbn: z.string().max(500).optional().describe("ISBN (for books)"),
      abstract: z.string().max(50000).optional().describe("Abstract or brief description"),
      content_summary: z.string().max(50000).optional().describe("Summary of key points and findings"),
      full_text: z.string().max(50000).optional().describe("Full text content if available"),
      citation_apa: z.string().max(1000).optional().describe("Manual APA citation (auto-generated if not provided)"),
      citation_format: z.enum(["apa", "mla", "chicago", "web"]).default("apa").describe("Primary citation format to store (all formats available at query time)"),
      retrieval_method: z.string().max(500).optional().describe("How the source was obtained (e.g., 'AI search via Claude', 'direct URL', 'library database')"),
      tags: z.string().max(500).optional().describe("Comma-separated tags"),
      relevance_score: z.number().min(1).max(10).default(5).describe("How relevant to the project (1-10)"),
    },
    async (params) => {
      const generator = CITATION_GENERATORS[params.citation_format] || generateAPA;
      const primaryCitation = params.citation_apa || generator(params);

      const result = await db.execute({
        sql: `
          INSERT INTO research_sources
            (title, source_type, project_id, backend_id, url, authors, publication_date, publisher,
             doi, isbn, abstract, content_summary, full_text, citation_apa,
             retrieval_method, tags, relevance_score)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          params.title, params.source_type, params.project_id ?? null, params.backend_id ?? null,
          params.url ?? null, params.authors ?? null, params.publication_date ?? null, params.publisher ?? null,
          params.doi ?? null, params.isbn ?? null, params.abstract ?? null, params.content_summary ?? null,
          params.full_text ?? null, primaryCitation, params.retrieval_method ?? null, params.tags ?? null,
          params.relevance_score,
        ],
      });

      return {
        content: [
          {
            type: "text",
            text: `Source added (id: ${Number(result.lastInsertRowid)}):\n  Title: ${params.title}\n  Type: ${params.source_type}\n  Citation (${params.citation_format}): ${primaryCitation}`,
          },
        ],
      };
    }
  );

  server.tool(
    "crow_search_sources",
    "Full-text search across all sources.",
    {
      query: z.string().max(500).describe("Search query"),
      project_id: z.number().optional().describe("Filter to specific project"),
      source_type: z.enum(SOURCE_TYPES).optional().describe("Filter by source type"),
      verified_only: z.boolean().default(false).describe("Only return verified sources"),
      limit: z.number().max(100).default(10).describe("Max results"),
    },
    async ({ query, project_id, source_type, verified_only, limit }) => {
      const sanitized = sanitizeFtsQuery(query);
      if (!sanitized) {
        return { content: [{ type: "text", text: "No sources found." }] };
      }

      let sql = `
        SELECT s.*, rank FROM sources_fts fts
        JOIN research_sources s ON s.id = fts.rowid
        WHERE sources_fts MATCH ?
      `;
      const params = [sanitized];

      if (project_id) { sql += " AND s.project_id = ?"; params.push(project_id); }
      if (source_type) { sql += " AND s.source_type = ?"; params.push(source_type); }
      if (verified_only) { sql += " AND s.verified = 1"; }

      sql += " ORDER BY rank LIMIT ?";
      params.push(limit);

      const { rows } = await db.execute({ sql, args: params });

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No sources found." }] };
      }

      const formatted = rows
        .map(
          (r) =>
            `[#${r.id}] ${r.verified ? "[VERIFIED] " : ""}${r.title}\n  Type: ${r.source_type} | Relevance: ${r.relevance_score}/10\n  APA: ${r.citation_apa}${r.url ? `\n  URL: ${r.url}` : ""}${r.content_summary ? `\n  --- stored content ---\n  ${r.content_summary.substring(0, 200)}...\n  --- end stored content ---` : ""}`
        )
        .join("\n\n");

      return { content: [{ type: "text", text: `${rows.length} sources found:\n\n${formatted}` }] };
    }
  );

  server.tool(
    "crow_get_source",
    "Get full details of a specific source by ID.",
    { id: z.number().describe("Source ID") },
    async ({ id }) => {
      const { rows: sourceRows } = await db.execute({ sql: "SELECT * FROM research_sources WHERE id = ?", args: [id] });
      if (sourceRows.length === 0) {
        return { content: [{ type: "text", text: `Source #${id} not found.` }] };
      }
      const source = sourceRows[0];

      const { rows: notes } = await db.execute({
        sql: "SELECT * FROM research_notes WHERE source_id = ? ORDER BY created_at DESC",
        args: [id],
      });

      let text = `Source #${source.id}: ${source.title}\n`;
      text += `${"─".repeat(60)}\n`;
      text += `Type: ${source.source_type}\n`;
      text += `Authors: ${source.authors || "N/A"}\n`;
      text += `Published: ${source.publication_date || "N/A"}\n`;
      text += `Publisher: ${source.publisher || "N/A"}\n`;
      text += `URL: ${source.url || "N/A"}\n`;
      text += `DOI: ${source.doi || "N/A"}\n`;
      text += `Retrieved: ${source.retrieval_date} via ${source.retrieval_method || "unknown"}\n`;
      text += `Verified: ${source.verified ? "Yes" : "No"}${source.verification_notes ? ` - ${source.verification_notes}` : ""}\n`;
      text += `Relevance: ${source.relevance_score}/10\n`;
      text += `Tags: ${source.tags || "none"}\n`;
      if (source.backend_id) text += `Backend: #${source.backend_id}\n`;
      const citations = generateAllCitations(source);
      text += `\nCitations:\n  APA:     ${citations.apa}\n  MLA:     ${citations.mla}\n  Chicago: ${citations.chicago}\n  Web:     ${citations.web}\n`;
      if (source.abstract) text += `\nAbstract:\n--- stored content ---\n${source.abstract}\n--- end stored content ---\n`;
      if (source.content_summary) text += `\nSummary:\n--- stored content ---\n${source.content_summary}\n--- end stored content ---\n`;
      if (notes.length > 0) {
        text += `\nNotes (${notes.length}):\n`;
        text += notes.map((n) => `  [${n.note_type}]\n  --- stored content ---\n  ${n.content.substring(0, 150)}\n  --- end stored content ---`).join("\n");
      }

      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "crow_verify_source",
    "Mark a source as verified or unverified.",
    {
      id: z.number().describe("Source ID"),
      verified: z.boolean().describe("Whether the source is verified"),
      notes: z.string().max(50000).optional().describe("Verification notes"),
    },
    async ({ id, verified, notes }) => {
      await db.execute({
        sql: "UPDATE research_sources SET verified = ?, verification_notes = ? WHERE id = ?",
        args: [verified ? 1 : 0, notes ?? null, id],
      });
      return { content: [{ type: "text", text: `Source #${id} marked as ${verified ? "verified" : "unverified"}.` }] };
    }
  );

  server.tool(
    "crow_list_sources",
    "List sources with filtering options.",
    {
      project_id: z.number().optional().describe("Filter by project"),
      backend_id: z.number().optional().describe("Filter by data backend"),
      source_type: z.enum(SOURCE_TYPES).optional(),
      verified_only: z.boolean().default(false),
      sort_by: z.enum(["recent", "relevance", "title"]).default("recent"),
      limit: z.number().max(100).default(20),
    },
    async ({ project_id, backend_id, source_type, verified_only, sort_by, limit }) => {
      let sql = "SELECT * FROM research_sources WHERE 1=1";
      const params = [];

      if (project_id) { sql += " AND project_id = ?"; params.push(project_id); }
      if (backend_id) { sql += " AND backend_id = ?"; params.push(backend_id); }
      if (source_type) { sql += " AND source_type = ?"; params.push(source_type); }
      if (verified_only) { sql += " AND verified = 1"; }

      const sortMap = {
        recent: "created_at DESC",
        relevance: "relevance_score DESC",
        title: "title ASC",
      };
      sql += ` ORDER BY ${sortMap[sort_by]} LIMIT ?`;
      params.push(limit);

      const { rows } = await db.execute({ sql, args: params });
      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No sources found." }] };
      }

      const formatted = rows
        .map(
          (r) =>
            `[#${r.id}] ${r.verified ? "[V] " : ""}${r.title} (${r.source_type})\n  APA: ${r.citation_apa}`
        )
        .join("\n\n");

      return { content: [{ type: "text", text: `${rows.length} sources:\n\n${formatted}` }] };
    }
  );

  // --- Notes Tools ---

  server.tool(
    "crow_add_note",
    "Add a note - can be attached to a project, a source, or both.",
    {
      content: z.string().max(50000).describe("Note content"),
      note_type: z.enum(["note", "quote", "summary", "analysis", "question", "insight"]).default("note"),
      project_id: z.number().optional().describe("Associated project"),
      source_id: z.number().optional().describe("Associated source"),
      title: z.string().max(500).optional().describe("Note title"),
      tags: z.string().max(500).optional().describe("Comma-separated tags"),
    },
    async ({ content, note_type, project_id, source_id, title, tags }) => {
      const result = await db.execute({
        sql: "INSERT INTO research_notes (content, note_type, project_id, source_id, title, tags) VALUES (?, ?, ?, ?, ?, ?)",
        args: [content, note_type, project_id ?? null, source_id ?? null, title ?? null, tags ?? null],
      });
      return {
        content: [{ type: "text", text: `Note added (id: ${Number(result.lastInsertRowid)}, type: ${note_type})` }],
      };
    }
  );

  server.tool(
    "crow_search_notes",
    "Search notes by content.",
    {
      query: z.string().max(500).describe("Search terms"),
      project_id: z.number().optional(),
      note_type: z.enum(["note", "quote", "summary", "analysis", "question", "insight"]).optional(),
      limit: z.number().max(100).default(10),
    },
    async ({ query, project_id, note_type, limit }) => {
      const escaped = escapeLikePattern(query);
      let sql = "SELECT * FROM research_notes WHERE content LIKE ? ESCAPE '\\'";
      const params = [`%${escaped}%`];

      if (project_id) { sql += " AND project_id = ?"; params.push(project_id); }
      if (note_type) { sql += " AND note_type = ?"; params.push(note_type); }
      sql += " ORDER BY created_at DESC LIMIT ?";
      params.push(limit);

      const { rows } = await db.execute({ sql, args: params });
      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No notes found." }] };
      }

      const formatted = rows
        .map((r) => `[#${r.id}] (${r.note_type}) ${r.title || ""}\n  ${r.content.substring(0, 200)}`)
        .join("\n\n");

      return { content: [{ type: "text", text: `${rows.length} notes:\n\n${formatted}` }] };
    }
  );

  // --- Bibliography Tool ---

  server.tool(
    "crow_generate_bibliography",
    "Generate a formatted bibliography in APA, MLA, Chicago, or web citation format.",
    {
      project_id: z.number().optional().describe("Generate bibliography for this project"),
      tag: z.string().max(500).optional().describe("Filter by tag"),
      verified_only: z.boolean().default(false),
      format: z.enum(["apa", "mla", "chicago", "web", "all"]).default("apa").describe("Citation format (or 'all' for every format)"),
    },
    async ({ project_id, tag, verified_only, format }) => {
      let sql = "SELECT * FROM research_sources WHERE 1=1";
      const params = [];

      if (project_id) { sql += " AND project_id = ?"; params.push(project_id); }
      if (tag) { sql += " AND tags LIKE ? ESCAPE '\\'"; params.push(`%${escapeLikePattern(tag)}%`); }
      if (verified_only) { sql += " AND verified = 1"; }
      sql += " ORDER BY authors ASC, title ASC";

      const { rows } = await db.execute({ sql, args: params });
      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No sources found for bibliography." }] };
      }

      if (format === "all") {
        const sections = ["apa", "mla", "chicago", "web"].map((fmt) => {
          const generator = CITATION_GENERATORS[fmt];
          const entries = rows.map((r) => generator(r)).join("\n\n");
          return `## ${fmt.toUpperCase()} Format\n\n${entries}`;
        });
        return {
          content: [{ type: "text", text: `References (${rows.length} sources):\n\n${sections.join("\n\n---\n\n")}` }],
        };
      }

      const generator = CITATION_GENERATORS[format] || generateAPA;
      const bib = rows.map((r) => generator(r)).join("\n\n");
      const label = format.toUpperCase();
      return {
        content: [{ type: "text", text: `References — ${label} (${rows.length} sources):\n\n${bib}` }],
      };
    }
  );

  // --- Stats Tool ---

  server.tool(
    "crow_project_stats",
    "Get statistics about the project database.",
    {},
    async () => {
      const projects = (await db.execute("SELECT COUNT(*) as count FROM research_projects")).rows[0];
      const sources = (await db.execute("SELECT COUNT(*) as count FROM research_sources")).rows[0];
      const verified = (await db.execute("SELECT COUNT(*) as count FROM research_sources WHERE verified = 1")).rows[0];
      const byType = (await db.execute("SELECT source_type, COUNT(*) as count FROM research_sources GROUP BY source_type ORDER BY count DESC")).rows;
      const notes = (await db.execute("SELECT COUNT(*) as count FROM research_notes")).rows[0];
      const byNoteType = (await db.execute("SELECT note_type, COUNT(*) as count FROM research_notes GROUP BY note_type ORDER BY count DESC")).rows;
      const byProjectType = (await db.execute("SELECT COALESCE(type, 'research') as type, COUNT(*) as count FROM research_projects GROUP BY type ORDER BY count DESC")).rows;

      let backends = { count: 0 };
      let connectedBackends = { count: 0 };
      try {
        backends = (await db.execute("SELECT COUNT(*) as count FROM data_backends")).rows[0];
        connectedBackends = (await db.execute("SELECT COUNT(*) as count FROM data_backends WHERE status = 'connected'")).rows[0];
      } catch {
        // data_backends table may not exist yet
      }

      let text = `Project Database Statistics:\n`;
      text += `  Projects: ${projects.count}\n`;
      text += `  Sources: ${sources.count} (${verified.count} verified)\n`;
      text += `  Notes: ${notes.count}\n`;
      text += `  Data Backends: ${backends.count} (${connectedBackends.count} connected)\n\n`;
      text += `Projects by Type:\n${byProjectType.map((r) => `  ${r.type}: ${r.count}`).join("\n")}\n\n`;
      text += `Sources by Type:\n${byType.map((r) => `  ${r.source_type}: ${r.count}`).join("\n")}\n\n`;
      text += `Notes by Type:\n${byNoteType.map((r) => `  ${r.note_type}: ${r.count}`).join("\n")}`;

      return { content: [{ type: "text", text }] };
    }
  );

  // --- Data Backend Tools ---

  server.tool(
    "crow_register_backend",
    "Register an external MCP server as a data backend. Creates a data_connector project if project_id is not provided. Credentials are never stored — only env var names are saved.",
    {
      name: z.string().max(500).describe("Display name for this backend (e.g., 'Production Postgres')"),
      backend_type: z.string().max(100).default("mcp_server").describe("Backend type (currently only 'mcp_server')"),
      project_id: z.number().optional().describe("Existing project to attach to (auto-creates if not provided)"),
      connection_ref: z.string().max(5000).describe("JSON connection reference: {\"command\":\"npx\",\"args\":[\"-y\",\"mcp-server-postgres\"],\"envVars\":[\"POSTGRES_URL\"]}"),
      tags: z.string().max(500).optional().describe("Comma-separated tags"),
    },
    async ({ name, backend_type, project_id, connection_ref, tags }) => {
      // Validate connection_ref is valid JSON
      let connRef;
      try {
        connRef = JSON.parse(connection_ref);
      } catch {
        return {
          content: [{ type: "text", text: "Error: connection_ref must be valid JSON. Example: {\"command\":\"npx\",\"args\":[\"-y\",\"mcp-server-postgres\"],\"envVars\":[\"POSTGRES_URL\"]}" }],
          isError: true,
        };
      }

      // Validate required fields in connection_ref
      if (!connRef.command) {
        return {
          content: [{ type: "text", text: "Error: connection_ref must include a 'command' field (e.g., 'npx', 'uvx', 'node')." }],
          isError: true,
        };
      }

      // Auto-create project if not provided
      let actualProjectId = project_id;
      if (!actualProjectId) {
        const projectResult = await db.execute({
          sql: "INSERT INTO research_projects (name, description, type, tags) VALUES (?, ?, 'data_connector', ?)",
          args: [name, `Data backend: ${name}`, tags ?? null],
        });
        actualProjectId = Number(projectResult.lastInsertRowid);
      }

      const result = await db.execute({
        sql: `INSERT INTO data_backends (project_id, name, backend_type, connection_ref, tags) VALUES (?, ?, ?, ?, ?)`,
        args: [actualProjectId, name, backend_type, connection_ref, tags ?? null],
      });

      const backendId = Number(result.lastInsertRowid);
      let text = `Backend registered: "${name}" (id: ${backendId}, project: #${actualProjectId})\n`;
      text += `Type: ${backend_type}\n`;
      text += `Status: disconnected (restart gateway or call reload to connect)\n`;
      if (connRef.envVars && connRef.envVars.length > 0) {
        text += `\nRequired env vars (must be set in .env): ${connRef.envVars.join(", ")}`;
      }

      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "crow_list_backends",
    "List registered data backends with their connection status.",
    {
      project_id: z.number().optional().describe("Filter by project"),
      status: z.string().max(100).optional().describe("Filter by status: connected, disconnected, error"),
    },
    async ({ project_id, status }) => {
      let sql = `
        SELECT b.*, p.name as project_name
        FROM data_backends b
        JOIN research_projects p ON p.id = b.project_id
        WHERE 1=1
      `;
      const params = [];
      if (project_id) { sql += " AND b.project_id = ?"; params.push(project_id); }
      if (status) { sql += " AND b.status = ?"; params.push(status); }
      sql += " ORDER BY b.updated_at DESC";

      const { rows } = await db.execute({ sql, args: params });
      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No data backends registered." }] };
      }

      const formatted = rows.map((r) => {
        let connRef;
        try { connRef = JSON.parse(r.connection_ref); } catch { connRef = {}; }
        return `[#${r.id}] ${r.name} (${r.status})\n  Project: ${r.project_name} (#${r.project_id})\n  Type: ${r.backend_type}\n  Command: ${connRef.command || "N/A"} ${(connRef.args || []).join(" ")}\n  Env vars: ${(connRef.envVars || []).join(", ") || "none"}${r.last_error ? `\n  Last error: ${r.last_error}` : ""}${r.last_connected_at ? `\n  Last connected: ${r.last_connected_at}` : ""}`;
      }).join("\n\n");

      return { content: [{ type: "text", text: `${rows.length} data backend(s):\n\n${formatted}` }] };
    }
  );

  server.tool(
    "crow_remove_backend",
    "Remove a data backend registration.",
    {
      id: z.number().describe("Backend ID to remove"),
    },
    async ({ id }) => {
      const { rows } = await db.execute({ sql: "SELECT name FROM data_backends WHERE id = ?", args: [id] });
      if (rows.length === 0) {
        return { content: [{ type: "text", text: `Backend #${id} not found.` }] };
      }
      await db.execute({ sql: "DELETE FROM data_backends WHERE id = ?", args: [id] });
      return { content: [{ type: "text", text: `Backend "${rows[0].name}" (#${id}) removed.` }] };
    }
  );

  server.tool(
    "crow_backend_schema",
    "Show discovered tools and schema for a data backend.",
    {
      id: z.number().describe("Backend ID"),
    },
    async ({ id }) => {
      const { rows } = await db.execute({ sql: "SELECT * FROM data_backends WHERE id = ?", args: [id] });
      if (rows.length === 0) {
        return { content: [{ type: "text", text: `Backend #${id} not found.` }] };
      }

      const backend = rows[0];
      let text = `Backend #${id}: ${backend.name} (${backend.status})\n`;

      if (backend.schema_info) {
        try {
          const schema = JSON.parse(backend.schema_info);
          if (Array.isArray(schema) && schema.length > 0) {
            text += `\nDiscovered tools (${schema.length}):\n`;
            text += schema.map((t) => `  - ${t.name}: ${t.description || "No description"}`).join("\n");
          } else {
            text += "\nNo tools discovered yet. Backend may need to be connected first.";
          }
        } catch {
          text += "\nSchema info is corrupted.";
        }
      } else {
        text += "\nNo schema info available. Connect the backend first (restart gateway or call reload).";
      }

      return { content: [{ type: "text", text }] };
    }
  );

  // --- Resources ---

  server.resource("projects", "projects://list", async (uri) => {
    const { rows: projects } = await db.execute(
      "SELECT id, name, type, status, description FROM research_projects ORDER BY updated_at DESC"
    );
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(projects, null, 2),
        },
      ],
    };
  });

  // --- Prompts ---

  server.prompt(
    "project-guide",
    "Project workflow guidance — project creation, source management, data backends, citations, and bibliography",
    async () => {
      const text = `Crow Project Workflow Guide

1. Project Creation
   - Use crow_create_project to start a new project with a name, description, and type
   - Project types: 'research' (default — sources, notes, bibliography), 'data_connector' (external data backends)
   - Projects organize sources, notes, and data backends under a single topic

2. Data Backends
   - Use crow_register_backend to connect external MCP servers (Postgres, APIs, etc.)
   - Backends store env var NAMES (not secrets) — credentials stay in .env
   - Use crow_list_backends and crow_backend_schema to inspect connected backends
   - Query data through crow_tools (router) or the external server's tools directly

3. Source Management
   - Add sources with crow_add_source — provide URL, title, authors, publication date, source type
   - Crow auto-generates APA citations from source metadata
   - Source types: web_article, academic_paper, book, interview, document, dataset, government_doc, video, podcast, social_media, other
   - Use crow_verify_source to check URL accessibility and update verification status
   - Search across sources with crow_search_sources (full-text search)
   - Link sources to backends with backend_id to track data provenance

4. Notes
   - Attach notes to sources or projects with crow_add_note
   - Notes support content, tags, and note_type (summary, quote, analysis, methodology, finding, question)
   - Search notes with crow_search_notes

5. Citations & Bibliography
   - crow_generate_bibliography produces formatted reference lists in APA, MLA, Chicago, or web citation format
   - Use format parameter: 'apa' (default), 'mla', 'chicago', 'web', or 'all' for every format
   - Web citation includes access date and AI retrieval method note
   - crow_get_source shows all citation formats for any source
   - Filter by project to generate project-specific bibliographies

6. Best Practices
   - Always attach sources to a project for organization
   - Include DOI when available for academic papers
   - Verify sources before marking as verified
   - Use descriptive tags on notes for easier retrieval later
   - When querying external data backends, capture significant results as sources for the knowledge graph`;

      return { messages: [{ role: "user", content: { type: "text", text } }] };
    }
  );

  return server;
}

// Backward compatibility alias
export { createProjectServer as createResearchServer };

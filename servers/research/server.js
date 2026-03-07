/**
 * Crow Research Pipeline — Server Factory
 *
 * Creates a configured McpServer with all research tools registered.
 * Transport-agnostic: used by both stdio (index.js) and HTTP (gateway).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDbClient } from "../db.js";

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

export function createResearchServer(dbPath) {
  const db = createDbClient(dbPath);

  const server = new McpServer({
    name: "crow-research",
    version: "0.1.0",
  });

  // --- Project Tools ---

  server.tool(
    "crow_create_project",
    "Create a new research project to organize sources and notes under.",
    {
      name: z.string().describe("Project name"),
      description: z.string().optional().describe("Project description and goals"),
      tags: z.string().optional().describe("Comma-separated tags"),
    },
    async ({ name, description, tags }) => {
      const result = await db.execute({
        sql: "INSERT INTO research_projects (name, description, tags) VALUES (?, ?, ?)",
        args: [name, description ?? null, tags ?? null],
      });
      return {
        content: [{ type: "text", text: `Project created: "${name}" (id: ${Number(result.lastInsertRowid)})` }],
      };
    }
  );

  server.tool(
    "crow_list_projects",
    "List all research projects with their status and source counts.",
    {
      status: z.enum(["active", "paused", "completed", "archived"]).optional().describe("Filter by status"),
    },
    async ({ status }) => {
      let sql = `
        SELECT p.*, COUNT(s.id) as source_count,
               (SELECT COUNT(*) FROM research_notes n WHERE n.project_id = p.id) as note_count
        FROM research_projects p
        LEFT JOIN research_sources s ON s.project_id = p.id
      `;
      const params = [];
      if (status) {
        sql += " WHERE p.status = ?";
        params.push(status);
      }
      sql += " GROUP BY p.id ORDER BY p.updated_at DESC";

      const { rows } = await db.execute({ sql, args: params });
      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No projects found." }] };
      }

      const formatted = rows
        .map(
          (r) =>
            `[#${r.id}] ${r.name} (${r.status}) - ${r.source_count} sources, ${r.note_count} notes\n  ${r.description || "No description"}${r.tags ? `\n  Tags: ${r.tags}` : ""}`
        )
        .join("\n\n");

      return { content: [{ type: "text", text: formatted }] };
    }
  );

  server.tool(
    "crow_update_project",
    "Update a research project's name, description, status, or tags.",
    {
      id: z.number().describe("Project ID"),
      name: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(["active", "paused", "completed", "archived"]).optional(),
      tags: z.string().optional(),
    },
    async ({ id, name, description, status, tags }) => {
      const updates = [];
      const params = [];
      if (name !== undefined) { updates.push("name = ?"); params.push(name); }
      if (description !== undefined) { updates.push("description = ?"); params.push(description); }
      if (status !== undefined) { updates.push("status = ?"); params.push(status); }
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
    "Add a research source with full metadata and automatic APA citation generation.",
    {
      title: z.string().describe("Title of the source"),
      source_type: z.enum(SOURCE_TYPES).describe("Type of source"),
      project_id: z.number().optional().describe("Associate with a research project"),
      url: z.string().optional().describe("URL where the source was found"),
      authors: z.string().optional().describe("Author(s) - 'Last, F. M.' format, separate multiple with '&'"),
      publication_date: z.string().optional().describe("Publication date (YYYY-MM-DD or YYYY)"),
      publisher: z.string().optional().describe("Publisher or website name"),
      doi: z.string().optional().describe("DOI (for academic papers)"),
      isbn: z.string().optional().describe("ISBN (for books)"),
      abstract: z.string().optional().describe("Abstract or brief description"),
      content_summary: z.string().optional().describe("Summary of key points and findings"),
      full_text: z.string().optional().describe("Full text content if available"),
      citation_apa: z.string().optional().describe("Manual APA citation (auto-generated if not provided)"),
      retrieval_method: z.string().optional().describe("How the source was obtained"),
      tags: z.string().optional().describe("Comma-separated tags"),
      relevance_score: z.number().min(1).max(10).default(5).describe("How relevant to the project (1-10)"),
    },
    async (params) => {
      const apa = params.citation_apa || generateAPA(params);

      const result = await db.execute({
        sql: `
          INSERT INTO research_sources
            (title, source_type, project_id, url, authors, publication_date, publisher,
             doi, isbn, abstract, content_summary, full_text, citation_apa,
             retrieval_method, tags, relevance_score)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          params.title, params.source_type, params.project_id ?? null, params.url ?? null,
          params.authors ?? null, params.publication_date ?? null, params.publisher ?? null,
          params.doi ?? null, params.isbn ?? null, params.abstract ?? null, params.content_summary ?? null,
          params.full_text ?? null, apa, params.retrieval_method ?? null, params.tags ?? null,
          params.relevance_score,
        ],
      });

      return {
        content: [
          {
            type: "text",
            text: `Source added (id: ${Number(result.lastInsertRowid)}):\n  Title: ${params.title}\n  Type: ${params.source_type}\n  APA: ${apa}`,
          },
        ],
      };
    }
  );

  server.tool(
    "crow_search_sources",
    "Full-text search across all research sources.",
    {
      query: z.string().describe("Search query (FTS5 syntax supported)"),
      project_id: z.number().optional().describe("Filter to specific project"),
      source_type: z.enum(SOURCE_TYPES).optional().describe("Filter by source type"),
      verified_only: z.boolean().default(false).describe("Only return verified sources"),
      limit: z.number().default(10).describe("Max results"),
    },
    async ({ query, project_id, source_type, verified_only, limit }) => {
      let sql = `
        SELECT s.*, rank FROM sources_fts fts
        JOIN research_sources s ON s.id = fts.rowid
        WHERE sources_fts MATCH ?
      `;
      const params = [query];

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
            `[#${r.id}] ${r.verified ? "[VERIFIED] " : ""}${r.title}\n  Type: ${r.source_type} | Relevance: ${r.relevance_score}/10\n  APA: ${r.citation_apa}${r.url ? `\n  URL: ${r.url}` : ""}${r.content_summary ? `\n  Summary: ${r.content_summary.substring(0, 200)}...` : ""}`
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
      text += `\nAPA Citation:\n  ${source.citation_apa}\n`;
      if (source.abstract) text += `\nAbstract:\n  ${source.abstract}\n`;
      if (source.content_summary) text += `\nSummary:\n  ${source.content_summary}\n`;
      if (notes.length > 0) {
        text += `\nNotes (${notes.length}):\n`;
        text += notes.map((n) => `  [${n.note_type}] ${n.content.substring(0, 150)}`).join("\n");
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
      notes: z.string().optional().describe("Verification notes"),
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
      source_type: z.enum(SOURCE_TYPES).optional(),
      verified_only: z.boolean().default(false),
      sort_by: z.enum(["recent", "relevance", "title"]).default("recent"),
      limit: z.number().default(20),
    },
    async ({ project_id, source_type, verified_only, sort_by, limit }) => {
      let sql = "SELECT * FROM research_sources WHERE 1=1";
      const params = [];

      if (project_id) { sql += " AND project_id = ?"; params.push(project_id); }
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
    "Add a research note - can be attached to a project, a source, or both.",
    {
      content: z.string().describe("Note content"),
      note_type: z.enum(["note", "quote", "summary", "analysis", "question", "insight"]).default("note"),
      project_id: z.number().optional().describe("Associated project"),
      source_id: z.number().optional().describe("Associated source"),
      title: z.string().optional().describe("Note title"),
      tags: z.string().optional().describe("Comma-separated tags"),
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
    "Search research notes by content.",
    {
      query: z.string().describe("Search terms"),
      project_id: z.number().optional(),
      note_type: z.enum(["note", "quote", "summary", "analysis", "question", "insight"]).optional(),
      limit: z.number().default(10),
    },
    async ({ query, project_id, note_type, limit }) => {
      let sql = "SELECT * FROM research_notes WHERE content LIKE ?";
      const params = [`%${query}%`];

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
    "Generate a formatted APA bibliography for a project or for all sources matching a filter.",
    {
      project_id: z.number().optional().describe("Generate bibliography for this project"),
      tag: z.string().optional().describe("Filter by tag"),
      verified_only: z.boolean().default(false),
    },
    async ({ project_id, tag, verified_only }) => {
      let sql = "SELECT citation_apa FROM research_sources WHERE 1=1";
      const params = [];

      if (project_id) { sql += " AND project_id = ?"; params.push(project_id); }
      if (tag) { sql += " AND tags LIKE ?"; params.push(`%${tag}%`); }
      if (verified_only) { sql += " AND verified = 1"; }
      sql += " ORDER BY citation_apa ASC";

      const { rows } = await db.execute({ sql, args: params });
      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No sources found for bibliography." }] };
      }

      const bib = rows.map((r) => r.citation_apa).join("\n\n");
      return {
        content: [{ type: "text", text: `References (${rows.length} sources):\n\n${bib}` }],
      };
    }
  );

  // --- Stats Tool ---

  server.tool(
    "crow_research_stats",
    "Get statistics about the research database.",
    {},
    async () => {
      const projects = (await db.execute("SELECT COUNT(*) as count FROM research_projects")).rows[0];
      const sources = (await db.execute("SELECT COUNT(*) as count FROM research_sources")).rows[0];
      const verified = (await db.execute("SELECT COUNT(*) as count FROM research_sources WHERE verified = 1")).rows[0];
      const byType = (await db.execute("SELECT source_type, COUNT(*) as count FROM research_sources GROUP BY source_type ORDER BY count DESC")).rows;
      const notes = (await db.execute("SELECT COUNT(*) as count FROM research_notes")).rows[0];
      const byNoteType = (await db.execute("SELECT note_type, COUNT(*) as count FROM research_notes GROUP BY note_type ORDER BY count DESC")).rows;

      let text = `Research Database Statistics:\n`;
      text += `  Projects: ${projects.count}\n`;
      text += `  Sources: ${sources.count} (${verified.count} verified)\n`;
      text += `  Notes: ${notes.count}\n\n`;
      text += `Sources by Type:\n${byType.map((r) => `  ${r.source_type}: ${r.count}`).join("\n")}\n\n`;
      text += `Notes by Type:\n${byNoteType.map((r) => `  ${r.note_type}: ${r.count}`).join("\n")}`;

      return { content: [{ type: "text", text }] };
    }
  );

  // --- Resources ---

  server.resource("research-projects", "research://projects", async (uri) => {
    const { rows: projects } = await db.execute(
      "SELECT id, name, status, description FROM research_projects ORDER BY updated_at DESC"
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

  return server;
}

/** Reader — read-side queries shared by MCP tools and the panel. */
import { sanitizeFtsQuery, escapeLikePattern } from "./db.js";

export async function listDocuments(db, { query = null, tag = null, limit = 50 } = {}) {
  const args = [];
  let where = "1=1";
  if (query) {
    const fts = sanitizeFtsQuery(query);
    if (fts) {
      where = `d.id IN (SELECT rowid FROM reader_documents_fts WHERE reader_documents_fts MATCH ?)`;
      args.push(fts);
    }
  }
  if (tag) {
    where += " AND (',' || COALESCE(d.tags,'') || ',') LIKE ? ESCAPE '\\'";
    args.push(`%,${escapeLikePattern(tag)},%`);
  }
  args.push(limit);
  const { rows } = await db.execute({
    sql: `SELECT d.id, d.title, d.source_type, d.source_ref, d.extraction_status,
                 d.tags, d.updated_at,
                 (SELECT COUNT(*) FROM reader_sections s WHERE s.document_id = d.id) AS section_count,
                 p.paragraph AS progress_paragraph, p.total_paragraphs
          FROM reader_documents d
          LEFT JOIN reader_progress p ON p.document_id = d.id AND p.section_number = 1
          WHERE ${where}
          ORDER BY d.updated_at DESC, d.id DESC
          LIMIT ?`,
    args,
  });
  return rows;
}

export async function getDocument(db, id) {
  const doc = await db.execute({
    sql: "SELECT * FROM reader_documents WHERE id = ?", args: [id] });
  if (doc.rows.length === 0) return null;
  const secs = await db.execute({
    sql: `SELECT id, section_number, title, paragraphs_json
          FROM reader_sections WHERE document_id = ? ORDER BY section_number`,
    args: [id],
  });
  return {
    document: doc.rows[0],
    sections: secs.rows.map((s) => ({
      id: Number(s.id),
      section_number: Number(s.section_number),
      title: s.title,
      paragraph_count: JSON.parse(String(s.paragraphs_json)).length,
    })),
  };
}

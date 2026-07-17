/**
 * PM Workspace — note CRUD + FTS search.
 *
 * Drawing notes carry strokes_json (the editor's canvas serialization)
 * and, on save, a PNG snapshot (data URL) that is decoded and written to
 * $CROW_DATA_DIR/pm-workspace/notes/<id>.png; the file path is stored in
 * image_path so OCR can post it later.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir, sanitizeFtsQuery } from "./db.js";

export function notesDir() {
  return join(resolveDataDir(), "pm-workspace", "notes");
}

/** Decode a data:image/png;base64,... URL into a Buffer, or null. */
export function decodePngDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const m = dataUrl.match(/^data:image\/png;base64,(.+)$/s);
  if (!m) return null;
  try {
    return Buffer.from(m[1], "base64");
  } catch {
    return null;
  }
}

/**
 * Create a note.
 * @param {object} db
 * @param {{title?, kind, content_md?, strokes_json?, image_data_url?, tags?, board_ref?}} input
 */
export async function createNote(db, input) {
  const kind = input.kind === "drawing" ? "drawing" : "markdown";
  const result = await db.execute({
    sql: `INSERT INTO pm_notes (title, kind, content_md, strokes_json, tags, board_ref, ocr_status)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.title || "Untitled",
      kind,
      input.content_md || null,
      input.strokes_json || null,
      input.tags || null,
      input.board_ref || null,
      kind === "drawing" ? "pending" : "n/a",
    ],
  });
  const id = Number(result.lastInsertRowid);

  if (kind === "drawing" && input.image_data_url) {
    await saveNoteImage(db, id, input.image_data_url);
  }
  return getNote(db, id);
}

/** Persist the PNG snapshot for a drawing note and record image_path. */
export async function saveNoteImage(db, id, imageDataUrl) {
  const buf = decodePngDataUrl(imageDataUrl);
  if (!buf) return null;
  const dir = notesDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.png`);
  writeFileSync(path, buf);
  await db.execute({
    sql: "UPDATE pm_notes SET image_path = ?, updated_at = datetime('now') WHERE id = ?",
    args: [path, id],
  });
  return path;
}

/** Update a note (partial). */
export async function updateNote(db, id, input) {
  const sets = [];
  const args = [];
  if (input.title !== undefined) { sets.push("title = ?"); args.push(input.title); }
  if (input.content_md !== undefined) { sets.push("content_md = ?"); args.push(input.content_md); }
  if (input.strokes_json !== undefined) { sets.push("strokes_json = ?"); args.push(input.strokes_json); }
  if (input.tags !== undefined) { sets.push("tags = ?"); args.push(input.tags); }
  if (input.board_ref !== undefined) { sets.push("board_ref = ?"); args.push(input.board_ref); }
  if (input.ocr_text !== undefined) { sets.push("ocr_text = ?"); args.push(input.ocr_text); }
  if (input.ocr_status !== undefined) { sets.push("ocr_status = ?"); args.push(input.ocr_status); }
  if (input.memory_id !== undefined) { sets.push("memory_id = ?"); args.push(input.memory_id); }
  if (sets.length > 0) {
    sets.push("updated_at = datetime('now')");
    args.push(id);
    await db.execute({ sql: `UPDATE pm_notes SET ${sets.join(", ")} WHERE id = ?`, args });
  }
  if (input.image_data_url) {
    await saveNoteImage(db, id, input.image_data_url);
    // A fresh drawing snapshot invalidates prior OCR.
    await db.execute({
      sql: "UPDATE pm_notes SET ocr_status = 'pending' WHERE id = ? AND kind = 'drawing'",
      args: [id],
    });
  }
  return getNote(db, id);
}

export async function getNote(db, id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM pm_notes WHERE id = ?", args: [Number(id)] });
  return rows[0] || null;
}

export async function listNotes(db, { kind, tag, limit = 50, offset = 0 } = {}) {
  let sql = `SELECT id, title, kind, ocr_status, board_ref, tags, created_at, updated_at,
             substr(coalesce(content_md, ocr_text, ''), 1, 200) AS excerpt
             FROM pm_notes WHERE 1=1`;
  const args = [];
  if (kind) { sql += " AND kind = ?"; args.push(kind); }
  if (tag) { sql += " AND tags LIKE ?"; args.push(`%${tag}%`); }
  sql += " ORDER BY updated_at DESC LIMIT ? OFFSET ?";
  args.push(Number(limit), Number(offset));
  const { rows } = await db.execute({ sql, args });
  return rows;
}

/** FTS5 search over title/content_md/ocr_text/tags. */
export async function searchNotes(db, query, { limit = 20 } = {}) {
  const fts = sanitizeFtsQuery(query);
  if (!fts) return [];
  const { rows } = await db.execute({
    sql: `SELECT n.id, n.title, n.kind, n.tags, n.updated_at,
          snippet(pm_notes_fts, 1, '[', ']', '…', 20) AS snippet_md,
          snippet(pm_notes_fts, 2, '[', ']', '…', 20) AS snippet_ocr
          FROM pm_notes_fts f
          JOIN pm_notes n ON n.id = f.rowid
          WHERE pm_notes_fts MATCH ?
          ORDER BY rank LIMIT ?`,
    args: [fts, Number(limit)],
  });
  return rows;
}

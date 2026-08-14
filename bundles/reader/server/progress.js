/** Reader — server-authoritative reading progress (forward-only). */
export async function saveProgress(db, { document_id, section_number = 1, paragraph,
  total_paragraphs = null, audio_time = null }) {
  if (!Number.isInteger(total_paragraphs) || total_paragraphs <= 0) total_paragraphs = null;
  await db.execute({
    sql: `INSERT INTO reader_progress (document_id, section_number, paragraph, total_paragraphs, audio_time)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(document_id, section_number) DO UPDATE SET
            paragraph = MAX(reader_progress.paragraph, excluded.paragraph),
            total_paragraphs = COALESCE(excluded.total_paragraphs, reader_progress.total_paragraphs),
            audio_time = excluded.audio_time,
            updated_at = datetime('now')`,
    args: [document_id, section_number, paragraph, total_paragraphs, audio_time],
  });
  const row = await getProgress(db, document_id, section_number);
  return { paragraph: Number(row.paragraph) };
}

export async function getProgress(db, documentId, sectionNumber) {
  const { rows } = await db.execute({
    sql: `SELECT * FROM reader_progress WHERE document_id = ? AND section_number = ?`,
    args: [documentId, sectionNumber],
  });
  return rows[0] || null;
}

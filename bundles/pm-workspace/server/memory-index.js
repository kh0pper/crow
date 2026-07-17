/**
 * PM Workspace — memory indexing for notes.
 *
 * Upserts a `memories` row per note (category 'project', source
 * 'pm-workspace:note:<id>') so notes surface in crow's memory search,
 * then best-effort embeds via $PM_EMBED_URL/embeddings and writes
 * memory_embeddings_blob exactly the way servers/memory/embeddings.js
 * does (Float32Array little-endian buffer, model + dim columns,
 * ON CONFLICT(memory_id) upsert).
 *
 * Embedding failures are logged and non-fatal: FTS still works and the
 * memory backfill sweep can embed later.
 */

const EMBED_TIMEOUT_MS = 30_000;
const EXCERPT_CHARS = 2000;

/** Serialize a Float32Array into a Buffer (BLOB) — matches servers/memory/embeddings.js. */
export function vecToBlob(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function noteContent(note) {
  const text = note.ocr_text || note.content_md || "";
  const body = text.trim().slice(0, EXCERPT_CHARS);
  const title = note.title ? `${note.title}\n\n` : "";
  return (title + body).trim();
}

/**
 * Upsert the memories row for a note. Returns the memory id, or null if
 * the note has no indexable content or the memories table is absent.
 */
export async function indexNoteMemory(db, note) {
  const content = noteContent(note);
  if (!content) return null;
  const source = `pm-workspace:note:${note.id}`;

  try {
    const existing = await db.execute({
      sql: "SELECT id FROM memories WHERE source = ? LIMIT 1",
      args: [source],
    });

    let memoryId;
    if (existing.rows.length > 0) {
      memoryId = Number(existing.rows[0].id);
      await db.execute({
        sql: "UPDATE memories SET content = ?, tags = ?, updated_at = datetime('now') WHERE id = ?",
        args: [content, note.tags || null, memoryId],
      });
    } else {
      const result = await db.execute({
        sql: `INSERT INTO memories (category, content, context, tags, source, importance)
              VALUES ('project', ?, ?, ?, ?, 5)`,
        args: [content, `PM Workspace note: ${note.title || "Untitled"}`, note.tags || null, source],
      });
      memoryId = Number(result.lastInsertRowid);
    }

    await db.execute({
      sql: "UPDATE pm_notes SET memory_id = ? WHERE id = ?",
      args: [memoryId, note.id],
    });
    return memoryId;
  } catch (err) {
    // memories table may not exist on a stripped-down instance — non-fatal.
    console.warn(`[pm-workspace] memory index skipped for note ${note.id}: ${err.message}`);
    return null;
  }
}

/**
 * Best-effort embed of a memory row's content into memory_embeddings_blob.
 * Never throws; returns {ok, model?, dim?, error?}.
 */
export async function embedMemory(db, memoryId, content, config) {
  if (!config.PM_EMBED_URL || !config.PM_EMBED_MODEL) {
    return { ok: false, error: "PM_EMBED_URL/PM_EMBED_MODEL not configured" };
  }
  try {
    const res = await fetch(config.PM_EMBED_URL.replace(/\/+$/, "") + "/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.PM_EMBED_MODEL, input: [content] }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `embed HTTP ${res.status}` };
    const json = await res.json();
    const embedding = json?.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      return { ok: false, error: "embed endpoint returned no vector" };
    }
    const vec = Float32Array.from(embedding);
    await db.execute({
      sql: `INSERT INTO memory_embeddings_blob (memory_id, model, dim, vec)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(memory_id) DO UPDATE SET
              model = excluded.model,
              dim = excluded.dim,
              vec = excluded.vec,
              created_at = datetime('now')`,
      args: [memoryId, config.PM_EMBED_MODEL, vec.length, vecToBlob(vec)],
    });
    return { ok: true, model: config.PM_EMBED_MODEL, dim: vec.length };
  } catch (err) {
    console.warn(`[pm-workspace] embed skipped for memory ${memoryId}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Full pipeline for a note: memories upsert, then best-effort embedding.
 * Returns {memory_id, embedded}.
 */
export async function indexNote(db, note, config) {
  const memoryId = await indexNoteMemory(db, note);
  if (!memoryId) return { memory_id: null, embedded: false };
  const embed = await embedMemory(db, memoryId, noteContent(note), config);
  return { memory_id: memoryId, embedded: embed.ok, embed_error: embed.ok ? null : embed.error };
}

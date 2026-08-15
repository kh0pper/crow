import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initReaderTables } from "../server/init-tables.js";

let db;
before(async () => {
  db = createClient({ url: "file::memory:" });
  await initReaderTables(db);
  await initReaderTables(db); // idempotent
});

test("all reader tables exist", async () => {
  const { rows } = await db.execute(
    "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name");
  const names = rows.map((r) => r.name);
  for (const t of ["reader_documents", "reader_sections", "reader_annotations",
    "reader_progress", "reader_chunks", "reader_chunk_embeddings",
    "reader_documents_fts", "reader_annotations_fts"]) {
    assert.ok(names.includes(t), `missing ${t}`);
  }
});

test("documents FTS triggers sync on insert/update/delete", async () => {
  await db.execute({
    sql: "INSERT INTO reader_documents (title, source_type, tags) VALUES (?, 'upload', ?)",
    args: ["Field Guide to Design", "design,hcd"],
  });
  let hits = await db.execute(
    "SELECT rowid FROM reader_documents_fts WHERE reader_documents_fts MATCH '\"design\"'");
  assert.equal(hits.rows.length, 1);
  await db.execute("UPDATE reader_documents SET title = 'Renamed' WHERE id = 1");
  hits = await db.execute(
    "SELECT rowid FROM reader_documents_fts WHERE reader_documents_fts MATCH '\"renamed\"'");
  assert.equal(hits.rows.length, 1);
  await db.execute("DELETE FROM reader_documents WHERE id = 1");
  hits = await db.execute(
    "SELECT rowid FROM reader_documents_fts WHERE reader_documents_fts MATCH '\"renamed\"'");
  assert.equal(hits.rows.length, 0);
});

test("progress upsert key is (document_id, section_number)", async () => {
  await db.execute({
    sql: `INSERT INTO reader_progress (document_id, section_number, paragraph)
          VALUES (1, 1, 5)
          ON CONFLICT(document_id, section_number) DO UPDATE SET paragraph = excluded.paragraph`,
    args: [],
  });
  const { rows } = await db.execute("SELECT paragraph FROM reader_progress WHERE document_id = 1");
  assert.equal(Number(rows[0].paragraph), 5);
});

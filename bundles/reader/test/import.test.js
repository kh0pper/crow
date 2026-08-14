import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initReaderTables } from "../server/init-tables.js";
import { ingestDocument, splitLongParagraphJs } from "../server/import.js";

let db, config;
before(async () => {
  db = createClient({ url: "file::memory:" });
  await initReaderTables(db);
  config = { CROW_DATA_DIR: mkdtempSync(join(tmpdir(), "reader-data-")) };
});

test("splitLongParagraphJs splits at sentence boundaries under the cap", () => {
  const sentence = "This sentence has exactly eight words in it. ";
  const long = sentence.repeat(90); // 720 words
  const parts = splitLongParagraphJs(long, 500);
  assert.ok(parts.length >= 2);
  for (const p of parts) {
    assert.ok(p.split(/\s+/).length <= 500);
    assert.match(p.trim(), /\.$/);
  }
});

test("txt upload ingests without the Python extractor", async () => {
  const buffer = Buffer.from("First paragraph.\n\nSecond paragraph.", "utf8");
  const { id, extraction_status } = await ingestDocument(db, config, {
    sourceType: "upload", buffer, filename: "notes.txt", title: "My Notes", tags: "test",
  });
  assert.equal(extraction_status, "ok");
  const doc = (await db.execute({
    sql: "SELECT * FROM reader_documents WHERE id = ?", args: [id] })).rows[0];
  assert.equal(doc.title, "My Notes");
  assert.ok(existsSync(String(doc.original_path)), "original not stored");
  const sec = (await db.execute({
    sql: "SELECT paragraphs_json FROM reader_sections WHERE document_id = ?", args: [id] })).rows[0];
  assert.deepEqual(JSON.parse(String(sec.paragraphs_json)),
    ["First paragraph.", "Second paragraph."]);
});

test("pdf upload routes through the extractor and records diagnostics", async () => {
  const extractImpl = async () => ({
    ok: true,
    sections: [{ title: null, paragraphs: ["From the extractor."] }],
    diagnostics: { pages: 3, empty_pages: 0, used_ocr: false },
  });
  const { id, extraction_status } = await ingestDocument(db, config, {
    sourceType: "upload", buffer: Buffer.from("%PDF-1.4 fake"), filename: "guide.pdf",
  }, { extractImpl });
  assert.equal(extraction_status, "ok");
  const doc = (await db.execute({
    sql: "SELECT extraction_diagnostics, original_mime FROM reader_documents WHERE id = ?",
    args: [id] })).rows[0];
  assert.equal(doc.original_mime, "application/pdf");
  assert.equal(JSON.parse(String(doc.extraction_diagnostics)).pages, 3);
});

test("extractor failure leaves the document with status failed, row intact", async () => {
  const extractImpl = async () => ({ ok: false, error: "kaboom" });
  const { id, extraction_status } = await ingestDocument(db, config, {
    sourceType: "upload", buffer: Buffer.from("%PDF-1.4 fake"), filename: "bad.pdf",
  }, { extractImpl });
  assert.equal(extraction_status, "failed");
  const doc = (await db.execute({
    sql: "SELECT extraction_status FROM reader_documents WHERE id = ?", args: [id] })).rows[0];
  assert.equal(doc.extraction_status, "failed");
});

test("assertPublicHost rejects loopback, honors the opt-out", async () => {
  const { assertPublicHost } = await import("../server/import.js");
  await assert.rejects(assertPublicHost("http://127.0.0.1/x", {}), /private address/);
  await assert.rejects(assertPublicHost("http://[::1]/x", {}), /private address/);
  await assertPublicHost("http://127.0.0.1/x", { READER_ALLOW_PRIVATE_URLS: "1" });
});

test("url html import archives the raw page and extracts readable text", async () => {
  const html = `<html><head><title>Method Card</title></head><body>
    <article><h1>Journey Mapping</h1>
    <p>${"Map the steps a person takes through a service. ".repeat(12)}</p>
    <p>${"Each step reveals a moment that matters to them. ".repeat(12)}</p>
    </article></body></html>`;
  const fetchImpl = async () => new Response(html, {
    status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  const { id, extraction_status } = await ingestDocument(db, config, {
    sourceType: "url", url: "https://example.test/methods/journey",
  }, { fetchImpl });
  assert.equal(extraction_status, "ok");
  const doc = (await db.execute({
    sql: "SELECT title, archived_html_path, source_ref FROM reader_documents WHERE id = ?",
    args: [id] })).rows[0];
  assert.ok(existsSync(String(doc.archived_html_path)), "raw HTML not archived");
  assert.ok(readFileSync(String(doc.archived_html_path), "utf8").includes("Journey Mapping"));
  assert.equal(doc.source_ref, "https://example.test/methods/journey");
  const paras = JSON.parse(String((await db.execute({
    sql: "SELECT paragraphs_json FROM reader_sections WHERE document_id = ?", args: [id] }))
    .rows[0].paragraphs_json));
  assert.ok(paras.some((p) => p.includes("moment that matters")));
});

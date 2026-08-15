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
  // IPv6 unspecified — connects to localhost; both literal spellings
  // canonicalize to "::" in the URL parser.
  await assert.rejects(assertPublicHost("http://[::]/x", {}), /private address/);
  await assert.rejects(assertPublicHost("http://[0:0:0:0:0:0:0:0]/x", {}), /private address/);
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

test("assertPublicHost rejects an IPv4-mapped IPv6 loopback literal", async () => {
  const { assertPublicHost } = await import("../server/import.js");
  await assert.rejects(assertPublicHost("http://[::ffff:127.0.0.1]/x", {}), /private address/);
});

test("assertPublicHost rejects CGNAT/Tailscale range 100.64/10", async () => {
  const { assertPublicHost } = await import("../server/import.js");
  await assert.rejects(assertPublicHost("http://100.121.254.89/x", {}), /private address/);
  await assert.rejects(assertPublicHost("http://100.127.255.255/x", {}), /private address/);
  // Just below the CGNAT range: must pass WITHOUT the opt-out, or the
  // boundary assertion is vacuous (the opt-out short-circuits the guard).
  await assertPublicHost("http://100.63.0.1/x", {});
});

test("ingestDocument rejects a non-http(s) URL scheme", async () => {
  const fetchImpl = async () => { throw new Error("fetchImpl should not be called"); };
  const { id, extraction_status } = await ingestDocument(db, config, {
    sourceType: "url", url: "ftp://example.test/a.pdf",
  }, { fetchImpl });
  assert.equal(extraction_status, "failed");
  const doc = (await db.execute({
    sql: "SELECT extraction_diagnostics FROM reader_documents WHERE id = ?", args: [id] })).rows[0];
  assert.match(JSON.parse(String(doc.extraction_diagnostics)).error, /scheme/);
});

test("ingestDocument fails with too-many-redirects past the redirect cap", async () => {
  const fetchImpl = async () => new Response(null, {
    status: 302, headers: { location: "https://example.test/next" } });
  const { id, extraction_status } = await ingestDocument(db, config, {
    sourceType: "url", url: "https://example.test/start",
  }, { fetchImpl });
  assert.equal(extraction_status, "failed");
  const doc = (await db.execute({
    sql: "SELECT extraction_diagnostics FROM reader_documents WHERE id = ?", args: [id] })).rows[0];
  assert.match(JSON.parse(String(doc.extraction_diagnostics)).error, /too many redirects/);
});

test("ingestDocument fails with a distinct message for a redirect with no location", async () => {
  const fetchImpl = async () => new Response(null, { status: 302, headers: {} });
  const { id, extraction_status } = await ingestDocument(db, config, {
    sourceType: "url", url: "https://example.test/nowhere",
  }, { fetchImpl });
  assert.equal(extraction_status, "failed");
  const doc = (await db.execute({
    sql: "SELECT extraction_diagnostics FROM reader_documents WHERE id = ?", args: [id] })).rows[0];
  assert.match(JSON.parse(String(doc.extraction_diagnostics)).error, /redirect without location/);
});

test("ingestDocument fails when declared content-length exceeds the byte cap", async () => {
  const capConfig = { ...config, READER_MAX_UPLOAD_MB: "1" };
  const fetchImpl = async () => new Response(null, {
    status: 200, headers: { "content-type": "text/html", "content-length": "2097153" } });
  const { id, extraction_status } = await ingestDocument(db, capConfig, {
    sourceType: "url", url: "https://example.test/big",
  }, { fetchImpl });
  assert.equal(extraction_status, "failed");
  const doc = (await db.execute({
    sql: "SELECT extraction_diagnostics FROM reader_documents WHERE id = ?", args: [id] })).rows[0];
  assert.match(JSON.parse(String(doc.extraction_diagnostics)).error, /byte cap/);
});

test("ingestDocument fails when a streamed body exceeds the byte cap despite no honest content-length", async () => {
  const capConfig = { ...config, READER_MAX_UPLOAD_MB: "1" };
  const oversized = Buffer.alloc(1_200_000, 65); // 1.2 MB, over the 1 MB cap
  const fetchImpl = async () => new Response(new Blob([oversized]), {
    status: 200, headers: { "content-type": "text/html" } });
  const { id, extraction_status } = await ingestDocument(db, capConfig, {
    sourceType: "url", url: "https://example.test/stream-big",
  }, { fetchImpl });
  assert.equal(extraction_status, "failed");
  const doc = (await db.execute({
    sql: "SELECT extraction_diagnostics FROM reader_documents WHERE id = ?", args: [id] })).rows[0];
  assert.match(JSON.parse(String(doc.extraction_diagnostics)).error, /byte cap/);
});

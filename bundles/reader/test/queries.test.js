import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initReaderTables } from "../server/init-tables.js";
import { ingestDocument } from "../server/import.js";
import { listDocuments, getDocument } from "../server/queries.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let db, config;
before(async () => {
  db = createClient({ url: "file::memory:" });
  await initReaderTables(db);
  config = { CROW_DATA_DIR: mkdtempSync(join(tmpdir(), "reader-q-")) };
  await ingestDocument(db, config, {
    sourceType: "upload", buffer: Buffer.from("Alpha paragraph.\n\nBeta paragraph."),
    filename: "alpha.txt", title: "Alpha Doc", tags: "hcd",
  });
  await ingestDocument(db, config, {
    sourceType: "upload", buffer: Buffer.from("Gamma."), filename: "gamma.md", title: "Gamma Doc",
  });
});

test("listDocuments returns both, newest first, with section counts", async () => {
  const rows = await listDocuments(db, {});
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, "Gamma Doc");
  assert.equal(Number(rows[0].section_count), 1);
});

test("listDocuments filters by FTS query", async () => {
  const rows = await listDocuments(db, { query: "alpha" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Alpha Doc");
});

test("getDocument returns sections with paragraph counts, null for missing id", async () => {
  const rows = await listDocuments(db, { query: "alpha" });
  const got = await getDocument(db, Number(rows[0].id));
  assert.equal(got.document.title, "Alpha Doc");
  assert.equal(got.sections.length, 1);
  assert.equal(got.sections[0].paragraph_count, 2);
  assert.equal(await getDocument(db, 9999), null);
});

test("listDocuments escapes LIKE wildcards in the tag filter", async () => {
  const localDb = createClient({ url: "file::memory:" });
  await initReaderTables(localDb);
  const localConfig = { CROW_DATA_DIR: mkdtempSync(join(tmpdir(), "reader-q-tag-")) };
  await ingestDocument(localDb, localConfig, {
    sourceType: "upload", buffer: Buffer.from("Delta paragraph."),
    filename: "delta.txt", title: "Delta Doc", tags: "a_b",
  });

  const exact = await listDocuments(localDb, { tag: "a_b" });
  assert.equal(exact.length, 1);
  assert.equal(exact[0].title, "Delta Doc");

  // "___" would match "a_b" via unescaped SQL LIKE wildcards (three
  // single-char wildcards); it must not match once "_" is escaped.
  const wildcard = await listDocuments(localDb, { tag: "___" });
  assert.equal(wildcard.length, 0);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initReaderTables } from "../bundles/reader/server/init-tables.js";
import { ingestDocument } from "../bundles/reader/server/import.js";

test("the reader's live path uses the shared guarded request and the manifest is bumped", () => {
  const src = readFileSync(new URL("../bundles/reader/server/import.js", import.meta.url), "utf8");
  assert.match(src, /guardedRequest\(/);
  const manifest = JSON.parse(readFileSync(new URL("../bundles/reader/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.version, "0.1.4");
});

test("a loopback URL with no fetchImpl is refused before any connect", async () => {
  const db = createClient({ url: "file::memory:" });
  await initReaderTables(db);
  const config = { CROW_DATA_DIR: mkdtempSync(join(tmpdir(), "reader-gf-")) };
  const { id, extraction_status } = await ingestDocument(db, config, { sourceType: "url", url: "http://127.0.0.1:9/x" });
  assert.equal(extraction_status, "failed");
  const row = (await db.execute({ sql: "SELECT extraction_diagnostics FROM reader_documents WHERE id = ?", args: [id] })).rows[0];
  assert.match(JSON.parse(String(row.extraction_diagnostics)).error, /non-public address/);
});

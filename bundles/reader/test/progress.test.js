import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initReaderTables } from "../server/init-tables.js";
import { saveProgress, getProgress } from "../server/progress.js";

let db;
before(async () => {
  db = createClient({ url: "file::memory:" });
  await initReaderTables(db);
});

test("progress only moves forward", async () => {
  await saveProgress(db, { document_id: 1, section_number: 1, paragraph: 10, total_paragraphs: 40 });
  await saveProgress(db, { document_id: 1, section_number: 1, paragraph: 4 });
  const row = await getProgress(db, 1, 1);
  assert.equal(Number(row.paragraph), 10);
  await saveProgress(db, { document_id: 1, section_number: 1, paragraph: 22 });
  assert.equal(Number((await getProgress(db, 1, 1)).paragraph), 22);
});

test("sections track independently; missing returns null", async () => {
  await saveProgress(db, { document_id: 1, section_number: 2, paragraph: 3 });
  assert.equal(Number((await getProgress(db, 1, 2)).paragraph), 3);
  assert.equal(await getProgress(db, 99, 1), null);
});

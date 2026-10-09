/**
 * Child process for the off-process dataset helpers in
 * servers/shared/sqlite-datasets.js: runs one read-only query (or schema
 * read) with every check of the synchronous path (path rules, read-only
 * connection, one statement, row and byte caps) and sends the result back
 * over IPC. A separate process, not a worker thread, because a single long
 * SQLite step never returns to JavaScript and a thread cannot be stopped
 * mid-step; the parent SIGKILLs this process at its wall-clock limit.
 * SQLite's heap here is capped (PRAGMA hard_heap_limit), so one huge value
 * fails as out-of-memory inside this process instead of growing it.
 */
import Database from "better-sqlite3";
import { runReadOnlyQuery, readDatasetSchema } from "./sqlite-datasets.js";

const heap = Number(process.env.CROW_DATASET_CHILD_HEAP) || 128 * 1024 * 1024;
// hard_heap_limit is process-wide: setting it on any connection caps them all.
{ const d = new Database(":memory:"); d.pragma(`hard_heap_limit = ${Math.floor(heap)}`); d.close(); }

process.once("message", (job) => {
  let reply;
  try {
    const result = job && job.op === "schema"
      ? readDatasetSchema(job.path)
      : runReadOnlyQuery(job.path, job.sql, { maxRows: job.maxRows, maxBytes: job.maxBytes });
    reply = { ok: true, result };
  } catch (err) {
    reply = { ok: false, error: err && err.message ? err.message : String(err) };
  }
  process.send(reply, () => process.exit(0));
});

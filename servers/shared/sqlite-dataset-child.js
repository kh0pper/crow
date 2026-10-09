/**
 * Child process for the off-process dataset helpers in
 * servers/shared/sqlite-datasets.js: runs one read-only query (or schema
 * read) with every check of the synchronous path (path rules, read-only
 * connection, one statement, row and byte caps) and sends the result back
 * over IPC. A separate process, not a worker thread, because a single long
 * SQLite step never returns to JavaScript and a thread cannot be stopped
 * mid-step; the parent SIGKILLs this process at its wall-clock limit.
 * On Linux the parent starts this process under a data-segment limit
 * (prlimit), so one huge value fails here (possibly aborting this process)
 * instead of growing it.
 */
import { runReadOnlyQuery, readDatasetSchema } from "./sqlite-datasets.js";

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

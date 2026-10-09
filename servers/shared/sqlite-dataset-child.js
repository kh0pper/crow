/**
 * Child process for runReadOnlyQueryAsync (servers/shared/sqlite-datasets.js):
 * runs one read-only dataset query with every check of the synchronous path
 * (path rules, read-only connection, one statement, row and byte caps) and
 * sends the result back over IPC. A separate process, not a worker thread,
 * because a single long SQLite step never returns to JavaScript and a thread
 * cannot be stopped mid-step; the parent SIGKILLs this process at its
 * wall-clock limit.
 */
import { runReadOnlyQuery } from "./sqlite-datasets.js";

process.once("message", (job) => {
  let reply;
  try {
    reply = { ok: true, result: runReadOnlyQuery(job.path, job.sql, { maxRows: job.maxRows, maxBytes: job.maxBytes }) };
  } catch (err) {
    reply = { ok: false, error: err && err.message ? err.message : String(err) };
  }
  process.send(reply, () => process.exit(0));
});

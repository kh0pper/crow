/**
 * Worker-thread fixture for tests/sync-stamp.test.js's "the reader never sees an
 * empty instance id" tests.
 *
 * getOrCreateLocalInstanceId() is synchronous, so the only way to hand it a file
 * that is EMPTY for its first read and COMPLETE a moment later is to write from
 * another thread. This worker arms (posts "armed"), waits for the "go" message,
 * waits workerData.delayMs, then writes workerData.id into workerData.idPath.
 *
 * The delay is a few milliseconds, which keeps the suite quick and low-flake: the
 * reader starts microseconds after "go", so its first read normally lands inside the
 * empty window, and the write lands well inside the reader's ~200 ms retry budget. If
 * the write lands BEFORE the first read the test still passes (it then proves the id
 * is returned, just not via the retry).
 */
import { parentPort, workerData } from "node:worker_threads";
import { writeFileSync } from "node:fs";

parentPort.postMessage("armed");
parentPort.on("message", (msg) => {
  if (msg !== "go") return;
  setTimeout(() => {
    try {
      writeFileSync(workerData.idPath, workerData.id, "utf-8");
      parentPort.postMessage("written");
    } catch (err) {
      parentPort.postMessage(`write failed: ${err.message}`);
    }
  }, workerData.delayMs);
});
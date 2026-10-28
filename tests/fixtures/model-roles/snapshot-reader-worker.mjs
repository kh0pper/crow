/**
 * Worker for tests/model-roles-snapshot.test.js: posts {ready:true}, then
 * reads JSON.parse(readFileSync(path)) in a tight loop for durationMs and
 * posts the counts. Only whole files may parse.
 */
import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";

const { path, durationMs = 1000 } = workerData;
const counts = { reads: 0, parseFailures: 0, shortReads: 0, enoent: 0 };

parentPort.postMessage({ ready: true });
const until = Date.now() + durationMs;
while (Date.now() < until) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") counts.enoent++;
    else counts.parseFailures++;
    continue;
  }
  counts.reads++;
  if (raw.length === 0) { counts.shortReads++; continue; }
  try {
    const j = JSON.parse(raw);
    if (!j || j.version !== 1 || !j.roles) counts.shortReads++;
  } catch {
    counts.parseFailures++;
  }
}
parentPort.postMessage({ done: true, ...counts });

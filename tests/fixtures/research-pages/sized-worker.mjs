// Fixture extractor: the page body says how long the readable and full-body parts are
// ("R=<n>;B=<m>"), so a test can land the text cap at an exact spot.
import { parentPort, workerData } from "node:worker_threads";
const m = /R=(\d+);B=(\d+)/.exec(workerData.html) || [];
parentPort.postMessage({ readable: "r".repeat(Number(m[1] || 0)), body: "b".repeat(Number(m[2] || 0)) });

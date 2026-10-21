/**
 * Side-effect module: applies the checkout .env and runs the instance-path
 * gate (./instance-paths-gate.js). servers/gateway/index.js imports this
 * FIRST — keep it first, so every other module is evaluated after it.
 *
 * Then one [isolation] line (queue item 19): which other instance homes and
 * key dirs this process can open, and whether it can open sibling Crow
 * processes' /proc root/environ. Open-and-close probes only; nothing is read.
 * CROW_ISOLATION_CHECK=0 turns the line off.
 */
import { runInstancePathsGate } from "./instance-paths-gate.js";
import { isolationReport, formatIsolationLine, defaultSensitivePaths } from "../../shared/isolation-check.js";

runInstancePathsGate();

if (process.env.CROW_ISOLATION_CHECK !== "0") {
  try {
    console.log(formatIsolationLine(isolationReport({ sensitivePaths: defaultSensitivePaths() })));
  } catch (err) {
    console.warn(`[isolation] self-check failed: ${err.message}`);
  }
}

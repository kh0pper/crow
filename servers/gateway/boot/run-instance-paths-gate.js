/**
 * Side-effect module: applies the checkout .env and runs the instance-path
 * gate (./instance-paths-gate.js). servers/gateway/index.js imports this
 * FIRST — keep it first, so every other module is evaluated after it.
 *
 * Then one [isolation] line (queue item 19): which other instance homes and
 * key dirs this process can open, and whether it can open sibling Crow
 * processes' /proc root/environ. Open-and-close probes only; nothing is read.
 * CROW_ISOLATION_CHECK=0 turns the line off.
 *
 * And one [isolation] line for the hidden secrets dir's ancestors (bot
 * containment Phase 1, Task 9): whether another principal could rename an
 * ancestor and leave a dir of its own at <CROW_HOME>/secrets before the next
 * boot. A finding WARNs here in Phase 1; with CROW_BOT_UID set it also refuses
 * the anchor (secret-values.js) and the line says so.
 */
// A satellite host (CROW_PROFILE=satellite) is refused (exit 78) before the .env or the gate.
import "./satellite-profile-guard.js";
import { mkdirSync } from "node:fs";
import { runInstancePathsGate } from "./instance-paths-gate.js";
import { isolationReport, formatIsolationLine, defaultSensitivePaths, formatSecretsAncestorsLine } from "../../shared/isolation-check.js";
import { secretsAncestorsReport } from "../../shared/secrets-ancestors.js";
import { secretsDir } from "../../shared/secret-values.js";

runInstancePathsGate();

if (process.env.CROW_ISOLATION_CHECK !== "0") {
  try {
    console.log(formatIsolationLine(isolationReport({ sensitivePaths: defaultSensitivePaths() })));
  } catch (err) {
    console.warn(`[isolation] self-check failed: ${err.message}`);
  }
  // Never fatal: a check that cannot run must not stop a gateway boot.
  try {
    // The check judges the ancestors of a path that exists (anchorSecretsDir
    // creates the dir before it checks). Create it here too, so a first boot
    // reports the real tree instead of `cannot stat` for a dir not made yet.
    try { mkdirSync(secretsDir(), { recursive: true, mode: 0o700 }); } catch { /* the check reports it */ }
    console.log(formatSecretsAncestorsLine(secretsAncestorsReport({ secretsDir: secretsDir() })));
  } catch (err) {
    console.warn(`[isolation] secrets dir ancestors: check failed: ${err.message}`);
  }
}
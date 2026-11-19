/**
 * The gateway process's own run id.
 *
 * A run claims itself with this id (`report_runs.gateway_run_id`) so a later boot can tell "the process
 * that started this run is gone" from "this run is still being worked on". It has to be minted fresh
 * by EVERY gateway process, including one that started without a reboot: an auto-update restart is
 * exactly the case a stale `queued` or `running` row must be swept after, and the only boot id in the
 * tree is the kernel's (`/proc/sys/kernel/random/boot_id`, read in servers/shared/peer-credentials.js),
 * which does NOT change when a process restarts. Using it would leave every run the previous gateway
 * still had in flight looking current forever.
 *
 * So: 128 random bits, minted once per process at the first call, held in this module and never
 * written anywhere. Restarting the gateway necessarily produces a different id (a new id cannot collide
 * with 2^128), and nothing depends on it surviving the process it names.
 */
import { randomBytes } from "node:crypto";

let runId = null;

/**
 * This process's run id: 32 lowercase hex characters, the same value on every call.
 *
 * @returns {string}
 */
export function gatewayRunId() {
  if (runId === null) runId = randomBytes(16).toString("hex");
  return runId;
}

/**
 * TEST ONLY: forget the id this process minted, so the next `gatewayRunId()` call mints a fresh one.
 * Nothing in production calls this (a process's id must not move under it).
 */
export function _resetGatewayRunIdForTests() {
  runId = null;
}
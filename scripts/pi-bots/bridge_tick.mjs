#!/usr/bin/env node
/**
 * Crow Bot Builder — unattended bridge tick CLI entrypoint (Phase 1).
 *
 * Thin wrapper: ALL logic (lock, flag check, reap preflight, gmail scan,
 * handleInbound, job drain) lives in bridge_tick_lib.mjs so the gateway can
 * run the exact same tick in-process (C4 Task 6) without a child process per
 * poll. Run by pibot-bridge.timer every ~1 min, mirroring mpa-router.
 * Systemd behavior is unchanged: exits 0 even on a skip (locked / runtime
 * off / engine missing) — the timer keeps firing regardless. The lib itself
 * unlinks its lock file in `finally` on every path (including a thrown tick
 * body), so this wrapper's crash catch only needs to log + exit(1); by the
 * time a throw reaches here the lib has already cleaned up after itself.
 */
import { runBridgeTick } from "./bridge_tick_lib.mjs";

(async () => {
  const r = await runBridgeTick();
  if (r && r.skipped) console.log(`[tick] skipped: ${r.skipped}`);
  process.exit(0);
})().catch((e) => {
  console.error("[tick] CRASH " + (e && e.stack || e));
  process.exit(1);
});

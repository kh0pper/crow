/**
 * boot/post-listen.js — the listen-callback body.
 *
 * Called FIRE-AND-FORGET from the app.listen() callback (S2). Every internal
 * .then/IIFE/.catch construct is verbatim. initProxyServers/loadRemoteInstances/
 * startAutoUpdate/startScheduler/createDbClient are imported
 * here; this module does NOT receive authMiddleware/sessionManager/instructions/
 * dashboardAuth/relayDb.
 *
 * deps EXACTLY: { setupCallsSignaling, setupCompanionProxy, extensionProxyWsSetup,
 *                 PORT, BIND, noAuth }
 * params: server, app (app used once for companion proxy)
 *
 * Internal relative specifiers re-anchored for boot/ (one level deeper).
 */

import { initProxyServers, loadRemoteInstances } from "../proxy.js";
import { startAutoUpdate } from "../auto-update.js";
import { startScheduler } from "../scheduler.js";
import { createDbClient } from "../../db.js";

// QW1 (Crow Messages usability arc, Phase 0): a gateway started with
// --no-auth (e.g. grackle's loopback companion MCP bridge) is never the
// primary dashboard and must never run the W2 health monitor — otherwise it
// evaluates its own --no-auth flag as an exposure warn and pushes "the
// password requirement is turned off" notifications every dedupe cycle.
export function shouldRunHealthMonitor({ env, noAuth }) {
  if (noAuth) return false;
  return env.CROW_DISABLE_HEALTH_MONITOR !== "1";
}

/**
 * Run one cross_host_calls audit-retention cycle: prune rows older than the
 * default 14-day window, then best-effort WAL-checkpoint. Opens a fresh db
 * client via the injected factory (defaults to createDbClient) and always
 * closes it. NEVER throws — a failure here must not cascade into an outage.
 * Exported so the boot timer and tests share one code path.
 *
 * @param {() => {execute: Function, close?: Function}} [dbFactory]
 * @returns {Promise<{deleted:number, checkpointed:boolean}>}
 */
export async function runCrossHostAuditPrune(dbFactory = createDbClient) {
  try {
    const { pruneCrossHostAudit } = await import("../../shared/cross-host-audit-retention.js");
    const db = dbFactory();
    try {
      const { deleted, checkpointed } = await pruneCrossHostAudit(db);
      if (deleted > 0) {
        console.log(`[xhost-audit-retention] pruned ${deleted} row(s) from cross_host_calls (checkpointed=${checkpointed})`);
      }
      return { deleted, checkpointed };
    } finally {
      try { db.close?.(); } catch {}
    }
  } catch (err) {
    console.warn("[xhost-audit-retention] cycle error:", err?.message || err);
    return { deleted: 0, checkpointed: false };
  }
}

export async function runPostListenSetup(server, app, deps) {
  const { setupCallsSignaling, setupCompanionProxy, extensionProxyWsSetup, PORT, BIND, noAuth } = deps;

  // Wire up calls WebSocket signaling (MUST be before extension and companion)
  if (setupCallsSignaling) {
    setupCallsSignaling(server);
  }

  // Tailnet-transport instance-sync — for paired Crow instances of the same
  // user we run feed-key-exchange + Hypercore replication over an authenticated
  // WebSocket on tailnet. Hyperswarm stays in place for contact-peer traffic
  // and as a fallback for instances that don't have a known gateway_url.
  (async () => {
    try {
      const { setupTailnetSyncServer, startTailnetSyncClients } = await import("../../sharing/tailnet-sync.js");
      const { getInstanceSyncManager } = await import("../../sharing/server.js");
      const { loadOrCreateIdentity } = await import("../../sharing/identity.js");
      const ism = getInstanceSyncManager();
      if (!ism) {
        console.warn("[tailnet-sync] InstanceSyncManager not ready; skipping");
        return;
      }
      const ctx = {
        identity: loadOrCreateIdentity(),
        instanceSyncManager: ism,
        db: createDbClient(),
        // Standard Crow gateway port — used only as a fallback when the peer's
        // gateway_url has no usable port (e.g. Funnel URLs). Each Crow may
        // run on a different port (crow:3001, grackle:3002), so we derive
        // each peer's port from THEIR gateway_url, not ours.
        gatewayPort: 3002,
      };
      setupTailnetSyncServer(server, ctx);
      await startTailnetSyncClients(ctx);
    } catch (err) {
      console.warn("[tailnet-sync] setup failed:", err.message);
    }
  })();

  // Wire up WebSocket upgrade for extension proxies (needs server instance)
  if (extensionProxyWsSetup) {
    extensionProxyWsSetup(server);
  }

  // Wire up companion proxy (needs server instance for WebSocket upgrade)
  if (setupCompanionProxy) {
    setupCompanionProxy(app, server);
  }

  // Wire up any panel-registered WebSocket setups (e.g. meta-glasses /session)
  import("../dashboard/panel-registry.js")
    .then(({ getPanelWebSocketSetups }) => {
      for (const [id, setupFn] of getPanelWebSocketSetups()) {
        try {
          setupFn(server);
          console.log(`  [panel] ${id} WebSocket handler mounted`);
        } catch (err) {
          console.warn(`  [panel] ${id} WebSocket setup failed:`, err.message);
        }
      }
    })
    .catch((err) => console.warn("[panel-ws] setup skipped:", err.message));
  // Graceful shutdown: close listening socket so systemd restart doesn't hit EADDRINUSE
  process.on("crow:shutdown", () => {
    console.log("[gateway] Closing server for restart...");
    server.close();
  });

  console.log(`Crow Gateway listening on http://${BIND}:${PORT}`);
  console.log(`  Streamable HTTP (2025-03-26):`);
  console.log(`    Memory:   POST ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/memory/mcp`);
  console.log(`    Projects: POST ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/projects/mcp`);
  console.log(`    Sharing:  POST ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/sharing/mcp`);
  console.log(`    Tools:    POST ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/tools/mcp`);
  if (process.env.CROW_DISABLE_ROUTER !== "1") {
    console.log(`    Router:   POST ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/router/mcp  (category tools, recommended)`);
  }
  console.log(`  SSE (2024-11-05):`);
  console.log(`    Memory:   GET  ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/memory/sse`);
  console.log(`    Projects: GET  ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/projects/sse`);
  console.log(`    Sharing:  GET  ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/sharing/sse`);
  console.log(`    Tools:    GET  ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/tools/sse`);
  console.log(`  Relay:`);
  console.log(`    Store:  POST ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/relay/store`);
  console.log(`    Fetch:  GET  ${noAuth ? "" : "[auth] "}http://localhost:${PORT}/relay/fetch`);
  console.log(`  Setup:    GET  http://localhost:${PORT}/setup`);
  console.log(`  Health:   GET  http://localhost:${PORT}/health`);
  // Detect Tailscale hostname for convenience logging
  import("child_process").then(({ execFileSync }) => {
    try {
      const tsJson = execFileSync("tailscale", ["status", "--json"], { timeout: 3000, stdio: "pipe" });
      const tsStatus = JSON.parse(tsJson);
      const tsHostname = tsStatus.Self?.HostName;
      const tsIp = tsStatus.Self?.TailscaleIPs?.[0];
      if (tsHostname) {
        console.log(`  Tailscale:  http://${tsHostname}:${PORT}${tsHostname === "crow" ? `  (or http://crow/)` : ""}`);
      }
      if (tsIp) {
        console.log(`  Tailnet IP: http://${tsIp}:${PORT}`);
      }
    } catch {
      // Tailscale not installed or not authenticated — skip
    }
  }).catch(() => {});
  console.log(`\n  First time? Visit http://localhost:${PORT}/setup for integration status and next steps.`);

  // Initialize external server proxy AFTER listening (so health checks pass during startup).
  initProxyServers().catch((err) => {
    console.error("[proxy] Failed to initialize:", err.message);
  });

  // Probe and connect to remote Crow instances (federation). Run once at
  // startup, then every 60s — the re-probe refreshes each instance's
  // `last_seen_at` and heals stale-session cases after a peer restarts
  // (cached mcp-session-id becomes invalid on the other side). For
  // already-connected instances loadRemoteInstances is effectively a
  // no-op (the status='connected' guard in the loop short-circuits it),
  // so re-running is cheap.
  const runRemoteProbe = () => loadRemoteInstances().catch((err) => {
    console.warn("[proxy] Remote instance loading:", err.message);
  });
  runRemoteProbe();
  setInterval(runRemoteProbe, 60_000).unref();

  // Start auto-update checker
  startAutoUpdate(createDbClient(), { noAuth }).catch((err) => {
    console.error("[auto-update] Failed to start:", err.message);
  });

  // Bring up alwaysResident vLLM bundles (embed, etc.) via gpu-orchestrator.
  // Non-fatal — if docker isn't available the gateway still runs; bundles
  // just have to be started manually.
  import("../gpu-orchestrator.js").then(({ initOrchestrator }) => {
    initOrchestrator().catch((err) => {
      console.warn(`[gpu-orchestrator] init failed: ${err.message}`);
    });
  });

  // Start schedule executor
  startScheduler(createDbClient()).catch((err) => {
    console.error("[scheduler] Failed to start:", err.message);
  });

  // W3-3: Health monitor — 15-min interval, first run after 2-min boot delay.
  // Kill switch: CROW_DISABLE_HEALTH_MONITOR=1. Never throws; each cycle is
  // fully try/caught. Notifies (dashboard+ntfy path) for newly-degraded warn
  // signals, using 24h dedupe persisted in dashboard_settings.
  // QW1: also never runs under --no-auth (see shouldRunHealthMonitor above) —
  // a no-auth gateway is never the primary dashboard.
  if (shouldRunHealthMonitor({ env: process.env, noAuth })) {
    const HEALTH_MONITOR_BOOT_DELAY_MS = 2 * 60 * 1000;   // 2 min
    const HEALTH_MONITOR_INTERVAL_MS   = 15 * 60 * 1000;  // 15 min
    const runHealthMonitorCycle = async () => {
      try {
        const { collectHealthSignals, shouldNotify, invalidateHealthCache, pruneResolved } =
          await import("../dashboard/panels/nest/health-signals.js");
        const { createNotification } = await import("../../shared/notifications.js");
        const { readSetting } = await import("../dashboard/settings/registry.js");
        const { t } = await import("../dashboard/shared/i18n.js");

        // Force fresh signals on each monitor cycle (bypass the render cache)
        invalidateHealthCache();
        const db = createDbClient();
        try {
          const signals = await collectHealthSignals(db);

          // Load dedupe map
          let lastMap = {};
          try {
            const raw = await readSetting(db, "health_last_notified");
            if (raw) lastMap = JSON.parse(raw);
          } catch {}

          const nowMs = Date.now();
          let mapDirty = false;

          for (const issue of signals.issues) {
            if (issue.severity !== "warn") continue; // info issues stay strip-only
            if (!shouldNotify(lastMap, issue.id, nowMs)) continue;

            try {
              await createNotification(db, {
                type: "system",
                source: `health-monitor:${issue.id}`,
                priority: "high",
                title: issue.label,
                body: issue.actionLabel ? `${issue.actionLabel} →` : undefined,
                action_url: "/dashboard/nest",
              });
              lastMap[issue.id] = nowMs;
              mapDirty = true;
            } catch (notifErr) {
              console.warn(`[health-monitor] notification failed for ${issue.id}:`, notifErr.message);
            }
          }

          // Incident-scoped dedupe: drop markers for issues no longer present
          // (warn OR info), so a resolved-then-recurring issue notifies again
          // instead of staying silent under the 24h window. A warn→info
          // downgrade keeps the marker (id still active = same incident).
          const activeIds = signals.issues.map(i => i.id);
          const pruned = pruneResolved(lastMap, activeIds);
          if (Object.keys(pruned).length !== Object.keys(lastMap).length) {
            lastMap = pruned;
            mapDirty = true;
          }

          if (mapDirty) {
            try {
              const serialized = JSON.stringify(lastMap);
              await db.execute({
                sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('health_last_notified', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
                args: [serialized, serialized],
              });
            } catch (persistErr) {
              console.warn("[health-monitor] failed to persist lastMap:", persistErr.message);
            }
          }
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        console.warn("[health-monitor] cycle error:", err.message);
      }
    };

    // Delay first run to avoid firing during startup churn
    setTimeout(() => {
      runHealthMonitorCycle();
      const interval = setInterval(runHealthMonitorCycle, HEALTH_MONITOR_INTERVAL_MS);
      interval.unref();
    }, HEALTH_MONITOR_BOOT_DELAY_MS);

    console.log("[health-monitor] armed (15-min interval, first run in 2 min)");
  } else if (noAuth) {
    console.log("[health-monitor] skipped: --no-auth gateway is never the primary dashboard");
  }

  // cross_host_calls audit-retention (2026-07-02 corruption-hardening plan,
  // Task 1): cross_host_calls is an unbounded append-only high-write table
  // that has corrupted crow's DB twice. Prune rows older than 14 days
  // (default — see cross-host-audit-retention.js for why 14, not 7) then
  // best-effort WAL-checkpoint. First run ~5 min after boot, then every 24h.
  //
  // Runs UNCONDITIONALLY on every instance — deliberately NOT gated to the
  // home/primary instance. cross_host_calls is written per-instance by
  // auditCrossHostCall into each instance's OWN local crow.db; there is no
  // shared/central audit table. Gating on is_home would leave non-home peers
  // (grackle, black-swan) never pruning their own table → unbounded growth →
  // the exact corruption this fix exists to prevent. Same-host multi-process
  // gateways use SEPARATE data dirs (crow-mpa → CROW_DATA_DIR=~/.crow-mpa/data),
  // so there is no shared-file contention to avoid; and if two processes ever
  // did share one file, concurrent DELETE+checkpoint just serialize harmlessly
  // on busy_timeout. Also runs regardless of --no-auth (harmless — a --no-auth
  // box may point at a throwaway DB). Fully try/caught; never throws.
  {
    const XHOST_AUDIT_PRUNE_BOOT_DELAY_MS = 5 * 60 * 1000;    // 5 min
    const XHOST_AUDIT_PRUNE_INTERVAL_MS   = 24 * 60 * 60 * 1000; // 24h

    setTimeout(() => {
      runCrossHostAuditPrune(createDbClient);
      setInterval(() => runCrossHostAuditPrune(createDbClient), XHOST_AUDIT_PRUNE_INTERVAL_MS).unref();
    }, XHOST_AUDIT_PRUNE_BOOT_DELAY_MS).unref();

    console.log("[xhost-audit-retention] armed (24h interval, first run in 5 min)");
  }

  // F.13: crosspost publish/GC scheduler (no-ops on an empty crosspost_log;
  // kill switch CROW_DISABLE_CROSSPOST_SCHEDULER=1). Lazy import keeps boot
  // resilient if the crossposting module is absent.
  import("../crossposting/scheduler.js")
    .then(({ startCrosspostScheduler }) => startCrosspostScheduler())
    .catch((err) => console.warn("[crosspost-scheduler] not started:", err.message));

  // Register this instance in the instance registry
  import("../instance-registry.js").then(async ({ ensureLocalInstanceRegistered }) => {
    try {
      const { loadOrCreateIdentity } = await import("../../sharing/identity.js");
      const identity = loadOrCreateIdentity();

      // Prefer Tailscale HTTPS serve URL, fall back to Tailscale IP, then localhost
      let gatewayUrl = `http://localhost:${PORT}`;
      try {
        const { execFileSync } = await import("child_process");
        // Check if Tailscale serve is configured (provides HTTPS URLs)
        const serveStatus = execFileSync("tailscale", ["serve", "status"], { timeout: 3000, stdio: "pipe" }).toString();
        const serveMatch = serveStatus.match(/https:\/\/[\w.-]+\.ts\.net(?::\d+)?/);
        if (serveMatch) {
          // Find the serve entry that proxies to our port
          const lines = serveStatus.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const urlMatch = lines[i].match(/(https:\/\/[\w.-]+\.ts\.net(?::\d+)?)/);
            if (urlMatch && lines[i + 1]?.includes(`localhost:${PORT}`)) {
              gatewayUrl = urlMatch[1];
              break;
            }
          }
          // If no port-specific match, use the first HTTPS URL
          if (gatewayUrl.startsWith("http://") && serveMatch) {
            gatewayUrl = serveMatch[0];
          }
        }
        // Fall back to Tailscale IP if no serve URL found
        if (gatewayUrl.startsWith("http://localhost")) {
          const tsIp = execFileSync("tailscale", ["ip", "-4"], { timeout: 3000, stdio: "pipe" }).toString().trim();
          if (tsIp) gatewayUrl = `http://${tsIp}:${PORT}`;
        }
      } catch {}

      await ensureLocalInstanceRegistered(createDbClient(), {
        crowId: identity.crowId,
        gatewayUrl,
      });
    } catch (err) {
      // Non-fatal — instance registry is optional for basic operation
      console.warn("[instance-registry] Auto-registration skipped:", err.message);
    }
  }).catch(() => {});
}

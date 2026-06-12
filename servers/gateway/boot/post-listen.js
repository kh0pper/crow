/**
 * boot/post-listen.js — the listen-callback body.
 *
 * Called FIRE-AND-FORGET from the app.listen() callback (S2). Every internal
 * .then/IIFE/.catch construct is verbatim. initProxyServers/loadRemoteInstances/
 * startAutoUpdate/startScheduler/connectedServers/createDbClient are imported
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
import { connectedServers } from "../proxy.js";
import { createDbClient } from "../../db.js";

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
  startAutoUpdate(createDbClient()).catch((err) => {
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
  if (process.env.CROW_DISABLE_HEALTH_MONITOR !== "1") {
    const HEALTH_MONITOR_BOOT_DELAY_MS = 2 * 60 * 1000;   // 2 min
    const HEALTH_MONITOR_INTERVAL_MS   = 15 * 60 * 1000;  // 15 min
    const runHealthMonitorCycle = async () => {
      try {
        const { collectHealthSignals, shouldNotify, invalidateHealthCache } =
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
  }

  // F.13: crosspost publish/GC scheduler (no-ops on an empty crosspost_log;
  // kill switch CROW_DISABLE_CROSSPOST_SCHEDULER=1). Lazy import keeps boot
  // resilient if the crossposting module is absent.
  import("../crossposting/scheduler.js")
    .then(({ startCrosspostScheduler }) => startCrosspostScheduler())
    .catch((err) => console.warn("[crosspost-scheduler] not started:", err.message));

  // Start orchestrator pipeline runner (polls for pipeline: schedules).
  // Lazy import so deployments without the open-multi-agent sibling repo
  // (e.g. hosted relays) keep running.
  import("../../orchestrator/server.js")
    .then(({ startOrchestratorPipelines }) => {
      startOrchestratorPipelines(createDbClient(), { connectedServers });
    })
    .catch((err) => {
      if (err.code === "ERR_MODULE_NOT_FOUND") {
        console.warn("[pipeline-runner] Orchestrator unavailable (open-multi-agent not installed). Skipping.");
      } else {
        console.error("[pipeline-runner] Failed to start:", err.message);
      }
    });

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

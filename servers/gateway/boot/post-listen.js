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

/**
 * Create the reserved Crow voice bot once (servers/shared/voice-bot.js
 * ensureVoiceBot). Skipped on a --no-auth gateway: a loopback secondary
 * gateway is never the operator's dashboard. Opens a fresh db client via the
 * injected factory and always closes it. NEVER throws.
 */
export async function ensureVoiceBotAtBoot({ noAuth, dbFactory = createDbClient } = {}) {
  if (noAuth) return { skipped: true };
  try {
    const { ensureCrowVoiceBot } = await import("../voice/ensure-voice-bot.js");
    const db = dbFactory();
    try {
      return await ensureCrowVoiceBot(db, { log: (m) => console.log(m) });
    } finally {
      try { db.close?.(); } catch {}
    }
  } catch (err) {
    console.warn("[voice] Crow voice bot not created:", err?.message || err);
    return { created: false, error: err?.message || String(err) };
  }
}

export async function runPostListenSetup(server, app, deps) {
  const { setupCallsSignaling, setupCompanionProxy, extensionProxyWsSetup, PORT, BIND, noAuth } = deps;

  // PT-1 peer-trust sweeper: the boot reconcile of peer-tokens.json (the
  // one-time pre-PT-1 snapshot, then delete revoked peers' keys minted before
  // their revoke), then every 10 s and on every crow_instances row change:
  // tear down what a revoked / paused / untrusted peer still has open here.
  (async () => {
    try {
      const { startPeerTrustSweeper } = await import("../peer-trust-sweeper.js");
      const { getOrCreateLocalInstanceId } = await import("../instance-registry.js");
      const { getInstanceSyncManager } = await import("../../sharing/server.js");
      startPeerTrustSweeper({
        db: createDbClient(),
        getInstanceSyncManager: () => { try { return getInstanceSyncManager(); } catch { return null; } },
        localInstanceId: getOrCreateLocalInstanceId(),
      });
    } catch (err) {
      console.warn("[peer-trust] sweeper setup failed:", err.message);
    }
  })();

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
      const { defaultPairKey, pairBindingMode } = await import("../../shared/sync-pair-binding.js");
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
        // This gateway's own backend port, advertised (signed) in the
        // handshake so a peer that learns our tailscale_ip dials it directly.
        syncPort: Number(PORT) || null,
        // PT-2a pair binding: the pair's signing_key from the PT-1 store
        // (re-read on every handshake) and CROW_SYNC_PAIR_BINDING (auto|require).
        pairKeyLookup: defaultPairKey,
        pairBindingMode: pairBindingMode(),
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
  // S6-CROW: the pi-lab minimum (MIN_PI_LAB_REV) is checked at boot, once,
  // on hosts that can run bots at all (a pi CLI resolves) — Perch's
  // interactive engine spawns pi from this process. Never blocks or throws.
  Promise.all([import("../../../scripts/pi-bots/pi_resolver.mjs"), import("../../../scripts/pi-bots/pi-lab-compat.mjs")])
    .then(([{ resolvePiCli }, { warnIfPiLabIncompatible }]) => {
      if (resolvePiCli()) warnIfPiLabIncompatible((m) => console.warn(m));
    })
    .catch((err) => console.warn("[pi-lab] compatibility check skipped:", err.message));

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
  // (cached mcp-session-id becomes invalid on the other side). Already-
  // connected instances keep their MCP client but still get a /health GET
  // (up to 5 s each, feeding the nest peers signal), so a cycle can outlast
  // the interval: the in-flight guard skips a tick rather than overlap.
  let remoteProbeRunning = false;
  const runRemoteProbe = async () => {
    if (remoteProbeRunning) return;
    remoteProbeRunning = true;
    try {
      await loadRemoteInstances();
    } catch (err) {
      console.warn("[proxy] Remote instance loading:", err.message);
    } finally {
      remoteProbeRunning = false;
    }
  };
  runRemoteProbe();
  setInterval(runRemoteProbe, 60_000).unref();

  // Crow voice bot: create the reserved row once (never rewritten after).
  setImmediate(() => { ensureVoiceBotAtBoot({ noAuth }); });

  // Start auto-update checker
  startAutoUpdate(createDbClient(), { noAuth }).catch((err) => {
    console.error("[auto-update] Failed to start:", err.message);
  });

  // Post-settle migration pass + verification of the convergence that caused
  // this restart, if there was one.
  import("../convergence.js").then(async (conv) => {
    const { healthSnapshot, addonsSettled } = await import("../proxy.js");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const inst = await conv.resolveInstance();

    // Wait for addon loading to finish, but never forever: a loader that hangs
    // must not strand the cookie, because the NEXT boot would read an expired
    // cookie and quarantine a sha that was healthy all along. A timeout yields
    // `unknown` (fail open), never `failed`.
    const settledOrTimeout = () =>
      Promise.race([
        addonsSettled().then(() => "settled"),
        new Promise((r) => setTimeout(() => r("timeout"), 10 * 60 * 1000).unref()),
      ]);
    const how = await settledOrTimeout();

    // SECOND registry pass. The boot pass runs before serving, when crow.db's
    // tables exist but bundle-owned stores do NOT — the tasks bundle creates
    // tasks_items only once it starts, which is after boot. A boot-only
    // registry defers tasks_items and then never retries, because a current
    // instance short-circuits its ticks on bootSha === HEAD. Idempotent by
    // construction: applied ids are skipped by record.
    try {
      const { runMigrations } = await import("../../../scripts/migrations/runner.mjs");
      const r2 = await runMigrations({
        migrationsDir: join(appRoot, "scripts", "migrations"),
        dbPath: inst.dbPath,
        tasksDbPath: inst.tasksDbPath,
        log: (m) => console.log(`[migrations:post-settle] ${m}`),
      });
      if (r2.applied.length) console.log(`[migrations:post-settle] applied: ${r2.applied.join(", ")}`);
      if (r2.deferred.length) {
        console.warn(`[migrations:post-settle] still deferred: ${r2.deferred.join(", ")} — the owning bundle may not be installed`);
      }
    } catch (err) {
      console.warn("[migrations:post-settle] skipped:", err.message);
    }

    await conv.verifyPendingConvergence({
      dataDir: inst.dataDir,
      appRoot,
      bootSha: conv.getBootSha(),
      // On timeout the gate cannot know: throwing routes into the fail-open
      // catch rather than comparing against addons that were never attempted.
      snapshot: how === "timeout"
        ? () => { throw new Error("addon loading never settled"); }
        : healthSnapshot,
      settled: async () => {},
      log: (m) => console.log(`[convergence] ${m}`),
    });
  }).catch((err) => console.warn("[convergence] verification skipped:", err.message));

  // Bring up alwaysResident vLLM bundles (embed, etc.) via gpu-orchestrator.
  // Non-fatal — if docker isn't available the gateway still runs; bundles
  // just have to be started manually.
  import("../gpu-orchestrator.js").then(({ initOrchestrator }) => {
    initOrchestrator().catch((err) => {
      console.warn(`[gpu-orchestrator] init failed: ${err.message}`);
    });
  });

  // The preview renderer (preview/renderer.js): sweep containers an earlier process left
  // (by our three labels), then the 30 s idle tick. Skipped under --no-auth. Never throws.
  import("../preview/renderer.js").then(({ startPreviewRendererTimers }) => startPreviewRendererTimers({ noAuth }))
    .catch((err) => console.warn(`[preview] timers not started: ${err.message}`));
  // Make's stored previews (make/previews.js): drop files for deleted, ineligible or
  // superseded versions, at boot and hourly. Skipped under --no-auth. Never throws.
  import("../make/previews.js").then(({ startPreviewSweep }) => startPreviewSweep({ noAuth }))
    .catch((err) => console.warn(`[make] preview sweep not started: ${err.message}`));

  // C4 Task 6: gateway-supervised bot runtime (bridge tick interval + Discord
  // child, both gated on the bot_runtime feature flag via runtimeGate — see
  // bot-runtime.js). Kill switch: CROW_DISABLE_BOT_RUNTIME=1 (forced by
  // run-suite.mjs for every scratch suite gateway). Non-fatal — a failure
  // here must not take down the gateway.
  import("../bot-runtime.js").then(({ initBotRuntime }) => {
    initBotRuntime().catch((err) => {
      console.warn(`[bot-runtime] init failed: ${err.message}`);
    });
  });

  // ntfy autowire (spec 2026-10-03): once, 20 s after listen, give this instance its own
  // login + private push topic when nothing is configured yet and an ntfy server is
  // here (installed by this instance or shared on the host). Kill switch
  // CROW_DISABLE_NTFY_AUTOWIRE=1 (forced by run-suite.mjs). Never throws.
  if (!noAuth && process.env.CROW_DISABLE_NTFY_AUTOWIRE !== "1") {
    setTimeout(() => {
      import("../push/ntfy-provision.js").then(({ autowireAtBoot, installedBundleIds }) =>
        autowireAtBoot({ installedIds: installedBundleIds }),
      ).catch((err) => console.warn(`[ntfy-autowire] boot check failed: ${err.message}`));
    }, 20_000).unref();
  }

  // Backup ownership self-check (co-hosted gateways share ~/backups/crow).
  import("../routes/admin-backup.js").then(({ backupSelfCheck }) => backupSelfCheck())
    .catch((err) => console.warn(`[backup] self-check failed: ${err.message}`));

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
        const { collectHealthSignals, invalidateHealthCache, runHealthNotifyCycle } =
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

          // Push new warn issues (24 h per-id window), then incident-scoped
          // dedupe: markers for ids no longer present (warn OR info) are
          // dropped, so a resolved-then-recurring issue notifies again. A
          // warn→info downgrade keeps the marker (id still active = same
          // incident) — which is exactly why external engines have their OWN id.
          const cycle = await runHealthNotifyCycle({
            issues: signals.issues,
            lastMap,
            nowMs: Date.now(),
            notify: (issue) => createNotification(db, {
              type: "system",
              source: `health-monitor:${issue.id}`,
              priority: "high",
              title: issue.label,
              body: issue.actionLabel ? `${issue.actionLabel} →` : undefined,
              action_url: "/dashboard/nest",
            }),
          });
          lastMap = cycle.lastMap;
          const mapDirty = cycle.dirty;

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

  // Card offers (redesign P5): the recovery sweep, every 10 minutes after the boot pass in
  // index.js. Idempotent; tasks.db is opened only when an accept was left with no card, and a busy
  // store skips the pass. Never throws.
  import("../board/offer-service.js").then(({ runOfferSweep }) => import("../../../scripts/pi-bots/instance-paths.mjs").then(({ tasksDbPath }) => {
    const OFFER_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
    setInterval(() => {
      runOfferSweep(() => createDbClient(), () => createDbClient(tasksDbPath()))
        .then((r) => { if (r.settled || r.reopened) console.log(`[card-offers] sweep: ${JSON.stringify(r)}`); })
        .catch((e) => console.warn("[card-offers] sweep failed:", e.message));
    }, OFFER_SWEEP_INTERVAL_MS).unref();
  })).catch((err) => console.warn("[card-offers] sweep not armed:", err.message));

  // The opt-in one-week voice transcript log (voice/transcript-log.js): an hourly sweep deletes entries past seven days
  // even when nothing is written, and the whole log when the setting is off — also on every bot-definition save, so
  // unticking it deletes the log at once. Files only; never throws.
  Promise.all([import("../voice/transcript-log.js"), import("../../shared/voice-bot.js")]).then(([{ startTranscriptLogSweep, sweepTranscriptLog, voiceTranscriptLog }, { CROW_VOICE_BOT_ID }]) => {
    const readDef = async () => {
      const db = createDbClient();
      try {
        const r = (await db.execute({ sql: "SELECT definition, enabled FROM pi_bot_defs WHERE bot_id = ?", args: [CROW_VOICE_BOT_ID] })).rows[0];
        return r && Number(r.enabled) ? JSON.parse(r.definition) : null;
      } finally { try { db.close(); } catch {} }
    };
    startTranscriptLogSweep(voiceTranscriptLog, readDef);
    import("../../shared/event-bus.js").then(({ default: bus }) => {
      bus.on("pibots:defs-changed", () => { sweepTranscriptLog(voiceTranscriptLog, readDef).catch(() => {}); });
    }).catch(() => {});
  }).catch((err) => console.warn("[voice-transcript-log] sweep not armed:", err.message));

  // F.13: crosspost publish/GC scheduler (no-ops on an empty crosspost_log;
  // kill switch CROW_DISABLE_CROSSPOST_SCHEDULER=1). Lazy import keeps boot
  // resilient if the crossposting module is absent.
  import("../crossposting/scheduler.js")
    .then(({ startCrosspostScheduler }) => startCrosspostScheduler())
    .catch((err) => console.warn("[crosspost-scheduler] not started:", err.message));

  // Register this instance in the instance registry
  import("../instance-registry.js").then(async ({ ensureLocalInstanceRegistered, configuredSelfGatewayUrl }) => {
    try {
      const { loadOrCreateIdentity } = await import("../../sharing/identity.js");
      const identity = loadOrCreateIdentity();

      // An operator-set CROW_PEER_GATEWAY_URL wins (and corrects a drifted
      // self row). Otherwise derive the TAILNET dial address: a private
      // (non-Funnel, non-:443) Serve endpoint proxying to our port, else
      // http://<tailnet ip>:<port>. Never "the first HTTPS URL" in serve
      // status — that picked the :443 door (Funnel on crow, the private
      // :443 Serve on black-swan), which instance sync never dials.
      const configuredUrl = configuredSelfGatewayUrl();
      const { deriveSelfDialAddress } = await import("../../shared/self-dial-address.js");
      const derived = deriveSelfDialAddress({ port: PORT, configuredUrl });
      const gatewayUrl = derived.gateway_url || `http://localhost:${PORT}`;

      await ensureLocalInstanceRegistered(createDbClient(), {
        crowId: identity.crowId,
        gatewayUrl,
        gatewayUrlConfigured: Boolean(configuredUrl),
        tailscaleIp: derived.tailscale_ip,
      });
    } catch (err) {
      // Non-fatal — instance registry is optional for basic operation
      console.warn("[instance-registry] Auto-registration skipped:", err.message);
    }
  }).catch(() => {});
}

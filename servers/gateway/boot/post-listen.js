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

import { initProxyServers, loadRemoteInstances, resolveCrowHome } from "../proxy.js";
import { startAutoUpdate } from "../auto-update.js";
import { startScheduler } from "../scheduler.js";
import { createDbClient } from "../../db.js";
import { tasksDbPath as instanceTasksDbPath } from "../../../scripts/pi-bots/instance-paths.mjs";
import { existsSync } from "node:fs";
import { upgradeLocalMarksAtBoot } from "./admin-api.js";

// QW1 (Crow Messages usability arc, Phase 0): a gateway started with
// --no-auth (e.g. the home server's loopback companion MCP bridge) is never the
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
 * One sync-conflict expiry pass (servers/sharing/sync-conflict-expiry.js):
 * resolve every conflict that auto-expires (winner kept: the winning side was
 * already applied when the row was written), then report it only when it did
 * something. Opens a fresh db client via the injected factory and always
 * closes it. NEVER throws — a boot sweep must not cascade into an outage.
 *
 * @param {() => {execute: Function, close?: Function}} [dbFactory]
 * @returns {Promise<number>} rows expired
 */
export async function runSyncConflictExpirySweep(dbFactory = createDbClient) {
  try {
    const { expireOldConflicts, readExpireDays } = await import("../../sharing/sync-conflict-expiry.js");
    const db = dbFactory();
    try {
      const days = await readExpireDays(db);
      const n = await expireOldConflicts(db, { days });
      if (n > 0) console.log(`[sync] expired ${n} old conflicts (older than ${days} days, winner kept)`);
      return n;
    } finally {
      try { db.close?.(); } catch {}
    }
  } catch (err) {
    console.warn("[sync] conflict expiry failed:", err?.message || err);
    return 0;
  }
}

/**
 * One version-history sweep (servers/shared/history/sweep.js): read the two
 * LOCAL settings (history.trash_days, default 30; history.retention, default
 * "forever" — local-scope, so they never travel to a peer), then redact,
 * coalesce and erase-past-the-Trash-period. NEVER throws: a boot interval must
 * not cascade into an outage, and the next run picks up whatever this one could
 * not finish.
 *
 * TWO STORES, TWO PASSES. Board cards live in the instance-global tasks.db, whose
 * item_versions is its OWN table (a SQLite trigger cannot write across databases),
 * so the card store is swept by a pass against THAT file — with the crow.db client
 * as its `settingsDb`, because the redaction scan mark lives in crow.db's
 * dashboard_settings under its own per-store key (see sweep.js). The same settings
 * drive both passes. The tasks pass is skipped when the file does not exist (a
 * board that never ran) and reports nothing when its item_versions is absent.
 *
 * `db` is passed in by the timer so the sweep keeps ONE handle for the life of
 * the process: its scan cursors live with the handle (sweep.js), and a fresh
 * handle every five minutes would restart the backlog walk from the top. The same
 * goes for `tasksDb`; without it the card pass opens and closes one handle per
 * cycle (still correct — its persisted mark keeps the fresh window small).
 *
 * @param {{db?: object, tasksDb?: object, dbFactory?: (path?: string) => object}} [opts]
 * @returns {Promise<object|null>} the crow sweep's counts (with the card pass's
 *   under `cards`), or null when it failed
 */
export async function runHistorySweep({ db = null, tasksDb = null, dbFactory = createDbClient } = {}) {
  let owned = false;
  let ownedTasks = false;
  // Declared out here so `finally` can close the handle this call opened itself.
  let tdb = tasksDb;
  try {
    const { sweep } = await import("../../shared/history/sweep.js");
    const { STORE_TASKS } = await import("../../shared/history/covered.js");
    const { readSetting } = await import("../dashboard/settings/registry.js");
    if (!db) {
      db = dbFactory();
      owned = true;
    }
    const rawDays = await readSetting(db, "history.trash_days");
    const rawRetention = await readSetting(db, "history.retention");
    const trashDays = rawDays === null || rawDays === undefined || rawDays === "" ? 30 : Number(rawDays);
    const retention = rawRetention === null || rawRetention === undefined || rawRetention === "" ? "forever" : String(rawRetention);
    const result = await sweep(db, { trashDays, retention });
    if (result.redacted > 0 || result.coalesced > 0 || result.erased.length > 0) {
      console.log(
        `[history] sweep: ${result.redacted} version(s) redacted, ${result.coalesced} coalesced, ` +
          `${result.erased.length} Trash item(s) erased (Trash period ${result.trashDays} days)`,
      );
    }

    // The card store. Its own pass, its own types; the crow.db handle keeps the
    // scan marks (one key per store, so the two passes cannot overwrite each other).
    let cardResult = null;
    if (!tdb) {
      const path = instanceTasksDbPath();
      if (existsSync(path)) {
        try {
          tdb = dbFactory(path);
          ownedTasks = true;
        } catch (err) {
          console.warn("[history] card sweep skipped: no tasks.db handle:", err?.message || err);
        }
      }
    }
    if (tdb) {
      // A card-store failure is its own line, not the whole cycle's: the crow.db
      // pass above has already committed its work, and the next tick retries.
      try {
        cardResult = await sweep(tdb, { trashDays, retention, store: STORE_TASKS, settingsDb: db });
      } catch (err) {
        console.warn("[history] card sweep cycle failed:", err?.message || err);
      }
      if (cardResult && (cardResult.redacted > 0 || cardResult.coalesced > 0 || cardResult.erased.length > 0)) {
        console.log(
          `[history] card sweep: ${cardResult.redacted} version(s) redacted, ${cardResult.coalesced} coalesced, ` +
            `${cardResult.erased.length} Trash card(s) erased (Trash period ${cardResult.trashDays} days)`,
        );
      }
    }
    return { ...result, cards: cardResult };
  } catch (err) {
    console.warn("[history] sweep cycle failed:", err?.message || err);
    return null;
  } finally {
    if (ownedTasks) {
      try {
        tdb?.close?.();
      } catch {
        /* a stuck close must not fail the cycle */
      }
    }
    if (owned) {
      try {
        db?.close?.();
      } catch {
        /* a stuck close must not fail the cycle */
      }
    }
  }
}

/**
 * One project-file sweep (servers/shared/history/workspace-history.js): commit
 * what changed in a project's workspace OUTSIDE Crow (a terminal session, a bot
 * running a tool), attributed `unattributed` / `outside-crow`.
 *
 * The SCHEDULED ERASE IS OFF. The Trash period is the same LOCAL setting the
 * version sweep reads (history.trash_days, default 30), but erasing a project's
 * deleted files from the history is behind its own LOCAL setting,
 * `history.workspace_auto_erase` (default off, never synced, no UI yet): while the
 * Trash page does not list workspace files, the history copy is the only copy of
 * a file a bot deleted, and a scheduled erase would destroy it unseeably. On-
 * demand erase and purge-on-delete are unaffected.
 *
 * NEVER throws: a boot interval must not cascade into an outage, and the next
 * pass picks up whatever this one could not finish.
 *
 * `db` is passed in by the timer so the sweep keeps ONE handle for the life of
 * the process: its round-robin cursor lives with the handle, and a fresh handle
 * every ten minutes would restart the walk from the first project.
 *
 * @param {{db?: object, dbFactory?: () => object}} [opts]
 * @returns {Promise<object|null>} the sweep's counts, or null when it failed
 */
export async function runWorkspaceSweep({ db = null, dbFactory = createDbClient } = {}) {
  let owned = false;
  try {
    const { sweepWorkspaces } = await import("../../shared/history/workspace-history.js");
    const { readSetting } = await import("../dashboard/settings/registry.js");
    if (!db) {
      db = dbFactory();
      owned = true;
    }
    const rawDays = await readSetting(db, "history.trash_days");
    const trashDays = rawDays === null || rawDays === undefined || rawDays === "" ? 30 : Number(rawDays);
    const rawAutoErase = await readSetting(db, "history.workspace_auto_erase");
    const autoEraseValue = rawAutoErase === null || rawAutoErase === undefined
      ? ""
      : String(rawAutoErase).trim().toLowerCase();
    const autoErase = autoEraseValue === "true" || autoEraseValue === "1" || autoEraseValue === "on";
    const result = await sweepWorkspaces(db, { trashDays, autoErase });
    if (result.ensured > 0 || result.committed > 0 || result.erased > 0 || result.eraseTimedOut > 0 || result.failed > 0) {
      console.log(
        `[history] project files: ${result.ensured} newly covered, ${result.committed} change(s) recorded, ` +
          `${result.erased} Trash file(s) erased, ${result.eraseTimedOut} erase(s) timed out, ${result.failed} project(s) skipped`,
      );
    }
    return result;
  } catch (err) {
    console.warn("[history] project-file sweep cycle failed:", err?.message || err);
    return null;
  } finally {
    if (owned) {
      try {
        db?.close?.();
      } catch {
        /* a stuck close must not fail the cycle */
      }
    }
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

/**
 * One bell note for an add-on wall settings change Crow did not write. The watch
 * only reports: the new modes apply at the next connect. Lines name each mode
 * that moved, plus one line when something else in the file changed.
 */
function sendAddonWallChangeNote(diff) {
  const changed = Array.isArray(diff?.modesChanged) ? diff.modesChanged : [];
  const otherChanged = diff?.otherChanged === true;
  if (changed.length === 0 && !otherChanged) return;
  let db = null;
  Promise.resolve()
    .then(async () => {
      const [{ createNotification }, { NOTICE, langText }, { noticeLanguage }] = await Promise.all([
        import("../../shared/notifications.js"),
        import("../../../scripts/addon-sandbox/words.mjs"),
        import("../../../scripts/addon-sandbox/notice.mjs"),
      ]);
      db = createDbClient();
      const lang = await noticeLanguage(db);
      const noChoice = langText(NOTICE.noChoice, lang);
      const lines = changed.map((c) => `${c.id}: ${c.from ?? noChoice} -> ${c.to ?? noChoice}`);
      if (otherChanged) lines.push(langText(NOTICE.otherChanged, lang));
      await createNotification(db, {
        title: langText(NOTICE.outsideTitle, lang),
        body: lines.join("\n"),
        source: "addon-walls",
        type: "system",
        priority: "high",
        action_url: "/dashboard/extensions",
      });
    })
    .catch((err) => console.warn("[addon-walls] change notice skipped:", err?.message || err))
    .finally(() => { try { db?.close?.(); } catch {} });
}

export async function runPostListenSetup(server, app, deps) {
  const { setupCallsSignaling, setupCompanionProxy, extensionProxyWsSetup, PORT, BIND, noAuth } = deps;

  // Boot hardening (audit N1c-18): this instance's home, its data dir and
  // crow.db (+ the WAL/SHM SQLite keeps beside it) must be owner-only — they
  // hold the bundle .env secrets, the keychain key, peer tokens and every
  // memory this Crow has. An install made under a permissive umask left them
  // 0755/0644. Same shape as the boot repairs for an existing instances.json
  // (tightenInstancesJsonPermissions) and for installed bundle .env files
  // (repairInstalledBundleAssets) — but one level up, and it NEVER throws.
  // Whatever it cannot fix (another owner, a symlink) is reported by the Nest's
  // Integrity card, which shares this list. Runs before the DB-touching work
  // below so a WAL created from now on inherits the tightened DB's mode.
  try {
    const { tightenCrowHomePermissions } = await import("./tighten-home-permissions.js");
    tightenCrowHomePermissions();
  } catch (err) {
    console.warn("[boot] tightening the Crow home permissions skipped:", err?.message || err);
  }

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
        // run on a different port (crow:3001, server-b:3002), so we derive
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

  // Add-on walls (PR D): the baseline and the settings watch come FIRST, before
  // the add-ons load — loading can take ten minutes, and an edit made while it
  // runs must be reported by the watch, not adopted as this process's baseline.
  // The watch only reports: the new modes apply at the next connect. Skipped on
  // a --no-auth gateway, which is nobody's dashboard. The notices wait for the
  // add-ons below, and run without re-taking that baseline.
  if (!noAuth) {
    try {
      const [{ rememberAddonWalls }, { startAddonWallsWatch }] = await Promise.all([
        import("../../shared/addon-walls-file.js"),
        import("../../../scripts/addon-sandbox/notice.mjs"),
      ]);
      const crowHomeBeforeAddons = resolveCrowHome();
      rememberAddonWalls(crowHomeBeforeAddons);
      startAddonWallsWatch({ crowHome: crowHomeBeforeAddons, onChange: sendAddonWallChangeNote });
    } catch (err) {
      console.warn("[addon-walls] the settings watch did not start:", err?.message || err);
    }
  }

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

  // "This is local" one-time upgrade (DNS with a bounded timeout): after
  // listen, never on the boot path.
  setImmediate(() => { upgradeLocalMarksAtBoot({ noAuth }); });

  // Fix-it boot checks — conditions no request emits an event for. The one
  // that matters for existing installs: a Caddyfile still dialling the
  // gateway over loopback, which turns Caddy's visitors away (the security
  // audit's finding). Skipped on a --no-auth secondary gateway, which has no
  // operator dashboard to show the card on. Own db client, closed here.
  if (!noAuth) {
    setImmediate(async () => {
      let db;
      try {
        const { runBootChecks } = await import("../fix-it/index.js");
        db = createDbClient();
        await runBootChecks(db);
      } catch (err) {
        console.warn("[fix-it] boot checks skipped:", err.message);
      } finally {
        try { db?.close?.(); } catch {}
      }
    });
  }

  // Alert spool (audit N1c-2): a path that must not write crow.db (the
  // migration guard, a migration failure during auto-update) leaves one small
  // JSON file per alert under <CROW_HOME>/alerts/pending. Deliver them to the
  // operator's bell now that the DB is up. Skipped under --no-auth, like the
  // fix-it cards and the health monitor: that gateway is nobody's dashboard.
  if (!noAuth) {
    setImmediate(async () => {
      let db;
      try {
        const { drainAlertSpool } = await import("../../shared/alert-spool.js");
        const { createNotification } = await import("../../shared/notifications.js");
        db = createDbClient();
        await drainAlertSpool(db, { createNotification });
      } catch (err) {
        console.warn("[alerts] spool delivery skipped:", err?.message);
      } finally {
        try { db?.close?.(); } catch {}
      }
    });
  }

  // Redact local-only columns out of stored conflict snapshots (security audit
  // N1b-7, fix round 2). A providers conflict saved before snapshots were
  // stripped holds this device's api_key in winning_data (and possibly an old
  // peer's in losing_data), and the settings page renders both in full. One-time
  // and idempotent: it rewrites only rows that still carry a local-only column.
  // Runs on every gateway, --no-auth included: the secret is in the LOCAL db,
  // whether or not this instance serves a dashboard. Own db client, closed here,
  // never throws, one log line with the count.
  setImmediate(async () => {
    let db;
    try {
      const { redactConflictSnapshotsAtBoot } = await import("../../sharing/sync-conflict-redact.js");
      db = createDbClient();
      await redactConflictSnapshotsAtBoot(db);
    } catch (err) {
      console.warn("[sync-conflicts] key redaction skipped:", err?.message || err);
    } finally {
      try { db?.close?.(); } catch {}
    }
  });

  // Start auto-update checker
  startAutoUpdate(createDbClient(), { noAuth }).catch((err) => {
    console.error("[auto-update] Failed to start:", err.message);
  });

  // Boot guard (security audit N1c-3, Layer 1). This process is the only one that
  // can tell the launcher two things it cannot see: that an exit was planned
  // (markPlanned, wired to crow:shutdown and SIGTERM in index.js), and that a sha
  // has actually been up for ten minutes (markStable — which is also the only
  // moment the installed launcher copy is refreshed). It also reports a rollback
  // the launcher performed before this process started.
  //
  // Runs after startAutoUpdate(): recordUpdateResult() funnels through the same
  // saveSetting() as every tick, so it needs that module's db handle.
  setImmediate(async () => {
    try {
      const bg = await import("../boot-guard-state.js");
      const conv = await import("../convergence.js");
      const bootSha = conv.getBootSha();
      let dbPath = null;
      try { dbPath = (await conv.resolveInstance()).dbPath; } catch { /* paths unresolved: keep the recorded one */ }
      // The result line and its bell belong to the instance's own dashboard, so a
      // --no-auth secondary gateway skips them like every other dashboard surface;
      // the stable mark below is plain instance bookkeeping and always runs.
      if (!noAuth) await bg.recordGuardResult({ log: (m) => console.log(`[boot-guard] ${m}`) });
      bg.scheduleStableMark({
        bootSha,
        dbPath,
        log: (m) => console.log(`[boot-guard] ${m}`),
      });
    } catch (err) {
      console.warn("[boot-guard] bookkeeping skipped:", err?.message || err);
    }
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
      const { runMigrations, readDeferrals } = await import("../../../scripts/migrations/runner.mjs");
      const r2 = await runMigrations({
        migrationsDir: join(appRoot, "scripts", "migrations"),
        dbPath: inst.dbPath,
        tasksDbPath: inst.tasksDbPath,
        log: (m) => console.log(`[migrations:post-settle] ${m}`),
      });
      if (r2.applied.length) console.log(`[migrations:post-settle] applied: ${r2.applied.join(", ")}`);
      // Only NEW deferrals are loud. Both passes run in ONE boot and the boot
      // pass already wrote this instance's deferral rows, so a deferral repeated
      // here is KNOWN unless its reason changed (a different table went absent).
      if (r2.newlyDeferred.length) {
        console.warn(`[migrations:post-settle] still deferred: ${r2.newlyDeferred.join(", ")} — the owning bundle may not be installed`);
      }
      const known = r2.deferred.filter((id) => !r2.newlyDeferred.includes(id));
      if (known.length) {
        // ONE quiet line per boot, so a long-standing wait stays visible without
        // drowning a new deferral in a line per migration.
        const rows = readDeferrals(inst.dbPath).filter((r) => known.includes(r.id));
        const since = rows.map((r) => r.first_deferred_at).sort()[0];
        console.log(`[migrations:post-settle] waiting on absent tables: ${known.join(", ")}${since ? ` (known since ${since})` : ""}`);
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

  // Add-on walls (PR D): once the add-ons have settled, one bell note about the
  // walls that are not up, then the first-walled-boot note. The baseline and the
  // change watch were started before the add-ons loaded, so this pass keeps them
  // (rememberBaseline: false) and an edit made in between stays an outside
  // change. Fire-and-forget: it never delays listen and never throws. Skipped on
  // a --no-auth gateway, which is nobody's dashboard (its add-ons are not the
  // operator's add-ons).
  if (!noAuth) {
    (async () => {
      let db = null;
      try {
        const proxy = await import("../proxy.js");
        await Promise.race([
          proxy.addonsSettled(),
          new Promise((r) => setTimeout(r, 10 * 60 * 1000).unref()),
        ]);
        const { runAddonWallNotices } = await import("../../../scripts/addon-sandbox/notice.mjs");
        const { createNotification } = await import("../../shared/notifications.js");
        const crowHome = proxy.resolveCrowHome();
        const entries = typeof proxy.addonWallEntries === "function" ? proxy.addonWallEntries() : [];
        try {
          db = createDbClient();
          await runAddonWallNotices({ db, crowHome, env: process.env, entries, createNotification, rememberBaseline: false });
        } finally {
          try { db?.close?.(); } catch {}
        }
      } catch (err) {
        console.warn("[addon-walls] notices skipped:", err?.message || err);
      } finally {
        try { db?.close?.(); } catch {}
      }
    })();
  }

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

  // Identity backup nudge (security audit N1c-10): ONCE, ever, when this
  // instance has an identity and the owner has neither been asked nor made the
  // passphrase-encrypted copy. The local nightly backup keeps identity.json on
  // this machine only, so a lost disk loses the identity unless that copy
  // exists. Skipped on a --no-auth gateway (never the operator's dashboard).
  // Own db client, closed inside. Never throws.
  if (!noAuth) {
    setImmediate(() => {
      import("./identity-backup-nudge.js")
        .then(({ runIdentityBackupNudge }) => runIdentityBackupNudge())
        .catch((err) => console.warn(`[identity-backup] nudge skipped: ${err?.message ?? err}`));
    });
  }

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
        const { collectHealthSignals, invalidateHealthCache, runHealthNotifyCycle, healthNotification } =
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
            notify: (issue) => createNotification(db, healthNotification(issue)),
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
  // (the home server, the cloud VM) never pruning their own table → unbounded growth →
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

  // Version history sweep (the version history design, Task 4): redact
  // secret-shaped text out of stored versions, coalesce rapid saves, and erase
  // Trash items past the Trash period. Every five minutes, first run a minute
  // after boot; the interval is unref'd and each cycle is fully try/caught, so a
  // failing sweep can never take the gateway down. Runs on EVERY gateway
  // (--no-auth included): history is local to each instance, so each machine
  // erases on its own clock.
  {
    const HISTORY_SWEEP_FIRST_RUN_MS = 60 * 1000;        // 1 min
    const HISTORY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;      // 5 min
    // One handle for the process: the sweep's scan cursors live with it.
    let sweepDb = null;
    // And one for the card store (tasks.db): its own scan cursor lives with it, so
    // a fresh handle per cycle would restart the card walk from the top. Opened
    // lazily, only when that file exists — the board creates it, not the gateway.
    let sweepTasksDb = null;
    // A tick that lands while a run is still in flight is skipped, not queued:
    // two overlapping passes would fight over the same coalescing cursor and
    // could delete a version the other one just decided to keep.
    let historySweepInFlight = false;
    const historySweepCycle = async () => {
      if (historySweepInFlight) return;
      try {
        if (!sweepDb) sweepDb = createDbClient();
      } catch (err) {
        console.warn("[history] sweep skipped: no database handle:", err?.message || err);
        return;
      }
      if (!sweepTasksDb) {
        try {
          const tasksPath = instanceTasksDbPath();
          if (existsSync(tasksPath)) sweepTasksDb = createDbClient(tasksPath);
        } catch (err) {
          // A busy task store is not fatal: the crow.db pass runs, and the card
          // pass retries on the next tick.
          console.warn("[history] card sweep handle not opened this cycle:", err?.message || err);
        }
      }
      historySweepInFlight = true;
      try {
        await runHistorySweep({ db: sweepDb, tasksDb: sweepTasksDb });
      } catch (err) {
        // runHistorySweep already logs; this only guarantees no unhandled rejection.
        console.warn("[history] sweep cycle failed:", err?.message || err);
      } finally {
        historySweepInFlight = false;
      }
    };
    setTimeout(() => {
      historySweepCycle();
      setInterval(historySweepCycle, HISTORY_SWEEP_INTERVAL_MS).unref();
    }, HISTORY_SWEEP_FIRST_RUN_MS).unref();
    console.log("[history] sweep armed (5-min interval, first run in 1 min)");
  }

  // Project file history (the version history design, Task 6): record what
  // changed in each project's workspace outside Crow, pick up projects that
  // predate the feature (bounded batches), and erase files past the Trash
  // period. Every ten minutes, first run two minutes after boot; the interval is
  // unref'd and each cycle is fully try/caught, so a failing pass can never take
  // the gateway down. Runs on EVERY gateway (--no-auth included): a project's
  // file history is local to the machine that holds the files.
  {
    const WORKSPACE_SWEEP_FIRST_RUN_MS = 2 * 60 * 1000;   // 2 min
    const WORKSPACE_SWEEP_INTERVAL_MS = 10 * 60 * 1000;    // 10 min
    // One handle for the process: the sweep's round-robin cursor lives with it.
    let workspaceSweepDb = null;
    // A tick that lands while a pass is still in flight is skipped, not queued:
    // two overlapping passes would walk the same projects and race for the same
    // index (each project is locked, but the cursor would advance twice).
    let workspaceSweepInFlight = false;
    const workspaceSweepCycle = async () => {
      if (workspaceSweepInFlight) return;
      try {
        if (!workspaceSweepDb) workspaceSweepDb = createDbClient();
      } catch (err) {
        console.warn("[history] project-file sweep skipped: no database handle:", err?.message || err);
        return;
      }
      workspaceSweepInFlight = true;
      try {
        await runWorkspaceSweep({ db: workspaceSweepDb });
      } catch (err) {
        // runWorkspaceSweep already logs; this only guarantees no unhandled rejection.
        console.warn("[history] project-file sweep cycle failed:", err?.message || err);
      } finally {
        workspaceSweepInFlight = false;
      }
    };
    setTimeout(() => {
      workspaceSweepCycle();
      setInterval(workspaceSweepCycle, WORKSPACE_SWEEP_INTERVAL_MS).unref();
    }, WORKSPACE_SWEEP_FIRST_RUN_MS).unref();
    console.log("[history] project-file sweep armed (10-min interval, first run in 2 min)");
  }

  // Old sync conflicts expire on their own (operator ruling): the winner is
  // already applied, so an unresolved row nobody opened is only review noise.
  // Once after listen, then every 6 h. Never throws; logs only when it acted.
  {
    const SYNC_CONFLICT_EXPIRY_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
    setImmediate(() => { runSyncConflictExpirySweep(createDbClient); });
    setInterval(() => { runSyncConflictExpirySweep(createDbClient); }, SYNC_CONFLICT_EXPIRY_INTERVAL_MS).unref();
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

  // The voice hand-off log (voice/handoff.js): a minute sweep expires stale proposals, recovers a start the
  // process lost, retries a pending stop through the engine and scrubs old verbatim speech. Never throws.
  // Then the "voice" result kind is registered (a hand-off card's final report sends the completion notice)
  // and the in-memory claims are warmed from the open rows; the DB fallback covers whatever the warm-up missed.
  import("../voice/handoff.js").then(async ({ startHandoffSweep, registerVoiceResultKind }) => {
    startHandoffSweep();
    registerVoiceResultKind();
    const { restoreResultRequesters } = await import("../board/result-requesters.js");
    const db = createDbClient();
    try { await restoreResultRequesters(db); } finally { try { db.close(); } catch {} }
  }).catch((err) => console.warn("[voice-handoff] sweep or result kind not armed:", err.message));

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
      // :443 Serve on the cloud VM), which instance sync never dials.
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

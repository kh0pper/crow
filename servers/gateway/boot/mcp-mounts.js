/**
 * boot/mcp-mounts.js — core MCP server mounting loop/blocks.
 *
 * Mounts memory, projects, research (legacy), sharing, per-client filtered
 * proxies, tools, root /mcp, and the router server.
 *
 * C2: RETURNS { peerExposureGate } — consumed by module 3's /storage (:756)
 * and /blog-mcp (:773) mounts. A missed return is a silently-unmounted MCP
 * server; the route-stack diff catches it.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createMemoryServer } from "../../memory/server.js";
import { createProjectServer } from "../../research/server.js";
import { createSharingServer, getInstanceSyncManager } from "../../sharing/server.js";
import { createDbClient } from "../../db.js";
import { createProxyServer, resolveCrowHome } from "../proxy.js";
import { createRouterServer } from "../router.js";
import { mountMcpServer } from "../routes/mcp.js";
import { enforcePeerExposure } from "../peer-exposure.js";
import { connectedServers } from "../proxy.js";

export async function mountMcpServers(app, deps) {
  const { authMiddleware, noAuth, instructions, routerInstructions, sessionManager } = deps;

  // Initialize sharing managers eagerly (starts Hyperswarm + Nostr + InstanceSync on boot, not on first request)
  createSharingServer(undefined, { instructions });
  // Get the sync manager so memory server can emit change entries
  const syncManager = getInstanceSyncManager();

  // Phase 5-polish: attach syncManager to providers-db so upsert/disable push
  // to paired peers via emitChange (pull-side already covered by SYNCED_TABLES).
  try {
    const { setProviderSyncManager } = await import("../../shared/providers-db.js");
    setProviderSyncManager(syncManager);
  } catch {}

  // Phase 3 (contacts follow the user): when a contact syncs in from a paired
  // instance, wire it live (subscribe to its DMs / join its topic) so it can
  // receive messages. Guarded; never throws into the apply loop.
  // F-CONTACT-1: onContactDeleted is the mirror of onContactSynced — a synced
  // delete must tear down the wiring a synced insert put up. attachContactSyncHooks
  // sets both together so neither can be forgotten.
  try {
    if (syncManager) {
      const { wireSyncedContact } = await import("../../sharing/contact-promote.js");
      const { unwireContact } = await import("../../sharing/contact-delete.js");
      const { getManagersOrNull } = await import("../../sharing/managers.js");
      const { attachContactSyncHooks } = await import("../../sharing/contact-hooks.js");
      attachContactSyncHooks(syncManager, { wireSyncedContact, unwireContact, getManagers: getManagersOrNull });
    }
  } catch {}

  // CRITICAL: open outFeeds for every paired peer BEFORE any emitChange can
  // fire. Without this, emissions before the first WebSocket handshake land
  // on an empty outFeeds map and are silently dropped while _localCounter
  // still advances — leaving replication permanently ahead of the on-disk
  // feed. See InstanceSyncManager.eagerInitPairedPeers() for the why.
  try {
    if (syncManager?.eagerInitPairedPeers) {
      await syncManager.eagerInitPairedPeers();
    }
  } catch (err) {
    console.warn(`[instance-sync] eagerInitPairedPeers at boot failed: ${err.message}`);
  }

  // 2d C5: reset once-backfill flags whose premise died with a lost out-feed
  // (rotation / restore-from-backup). MUST run BEFORE the once-backfills
  // below so they re-run this same boot (spec §3 C5 / R1 F4 ordering).
  try {
    if (syncManager?.resetBackfillPremiseFlags) {
      await syncManager.resetBackfillPremiseFlags();
    }
  } catch (err) {
    console.warn(`[instance-sync] resetBackfillPremiseFlags failed: ${err.message}`);
  }

  // Scoped-settings sync: wire the registry's writeSetting to emitChange so
  // operator edits on one instance propagate to paired peers. MUST happen
  // BEFORE the heal/re-emit one-shots below (R1 MAJOR-1): the heal promotes
  // via writeSetting, whose emit is a silent no-op — and whose promoted row
  // never gets a lamport stamp — while the manager is unwired.
  try {
    const { setSettingsSyncManager } = await import("../dashboard/settings/registry.js");
    setSettingsSyncManager(syncManager);
  } catch {}

  // Settings-scope coherence D2: one-shot heal — promote instance-scope
  // values stranded in dashboard_settings_overrides by the broken-era
  // upsertSetting downgrade. Deliberately UNGATED (contrast the profile heal
  // below): zero sync side effects, so a --no-auth companion sharing the
  // primary's DB reaches the identical result — and it uses its own
  // createDbClient() so even a null-syncManager boot heals.
  try {
    const { healInstanceScopeOverridesOnce } = await import("../dashboard/settings/instance-scope-heal.js");
    await healInstanceScopeOverridesOnce(createDbClient());
  } catch (err) {
    console.warn(`[settings] healInstanceScopeOverridesOnce failed: ${err.message}`);
  }

  // Cluster B D3: one-shot heal — promote profile values stranded in
  // dashboard_settings_overrides by the broken-era save_profile. Gated on
  // !feedsDisabled: a --no-auth companion shares the primary's DB and must
  // not run it or mark its flag (R2 MAJOR-A). Runs BEFORE the settings
  // re-emit so a promoted value also rides this boot's reconciliation.
  try {
    if (syncManager && !syncManager.feedsDisabled) {
      const { healProfileOverridesOnce } = await import("../dashboard/settings/profile-heal.js");
      await healProfileOverridesOnce(syncManager.db, { feedsDisabled: syncManager.feedsDisabled });
    }
  } catch (err) {
    console.warn(`[settings] healProfileOverridesOnce failed: ${err.message}`);
  }

  // One-shot backfill: re-emit sync-allowlisted dashboard_settings so peers
  // whose pre-fix outFeed silently dropped entries can catch up. Guarded by
  // a flag row; idempotent on subsequent boots.
  try {
    if (syncManager?.reemitSyncableSettingsOnce) {
      await syncManager.reemitSyncableSettingsOnce();
    }
  } catch (err) {
    console.warn(`[instance-sync] reemitSyncableSettingsOnce failed: ${err.message}`);
  }

  // I-4: one-shot re-emit of existing full contacts so a peer can resolve
  // crow_id → local contact_id for contacts that predate PR-A's contact-sync
  // (otherwise every synced message for such a contact is dropped forever).
  // Guarded by a flag row; idempotent on subsequent boots.
  try {
    if (syncManager?.backfillContactsOnce) {
      await syncManager.backfillContactsOnce();
    }
  } catch (err) {
    console.warn(`[instance-sync] backfillContactsOnce failed: ${err.message}`);
  }

  // Phase 3 groups: one-shot re-emit of existing plain groups so peers resolve
  // groups that predate this feature. AFTER contacts backfill so member contacts
  // have a chance to land first. Guarded by a flag row; idempotent on later boots.
  try {
    if (syncManager?.backfillGroupsOnce) {
      await syncManager.backfillGroupsOnce();
    }
  } catch (err) {
    console.warn(`[instance-sync] backfillGroupsOnce failed: ${err.message}`);
  }

  // D7: one-shot providers backfill per NEW peer — per-peer outgoing Hypercores
  // are born empty (no history replay), and D2's no-op suppression removed the
  // accidental per-boot re-emit that used to deliver provider rows to fresh
  // pairings. Guarded by per-peer flag rows; idempotent on later boots.
  try {
    if (syncManager?.backfillProvidersForNewPeers) {
      await syncManager.backfillProvidersForNewPeers();
    }
  } catch (err) {
    console.warn(`[instance-sync] backfillProvidersForNewPeers failed: ${err.message}`);
  }

  // Bundle asset repair: when a bundle is marked installed but its ~/.crow/bundles/<id>/
  // directory is missing user-visible files (settings-section.js, panel/, manifest.json),
  // re-copy them from the app repo. Prevents the Companion migration gap from recurring.
  try {
    const { repairInstalledBundleAssets } = await import("../routes/bundles.js");
    const { repaired, errors } = await repairInstalledBundleAssets();
    if (repaired.length > 0) {
      console.log(`[bundles] Repaired assets: ${repaired.join("; ")}`);
    }
    if (errors.length > 0) {
      console.warn(`[bundles] Asset repair errors:`, errors);
    }
  } catch (err) {
    console.warn("[bundles] Asset repair failed:", err.message);
  }

  // F4a Layer 2a: shared default-deny exposure gate for all peer-instance MCP
  // calls. Bound once; mountMcpServer passes the mount prefix per call.
  const peerExposureGate = async (prefix, req, res) => {
    if (!req.instanceAuth?.instance) return true; // fast path: not a peer call
    const db = createDbClient();
    try {
      return await enforcePeerExposure({ prefix, req, res, db, connectedServers });
    } finally {
      try { db.close(); } catch {}
    }
  };

  mountMcpServer(app, "/memory", () => createMemoryServer(undefined, { instructions, syncManager }), sessionManager, authMiddleware, peerExposureGate);
  const projectServerFactory = () => createProjectServer(undefined, { instructions });
  mountMcpServer(app, "/projects", projectServerFactory, sessionManager, authMiddleware, peerExposureGate);
  // Legacy alias — existing remote clients use /research/mcp
  mountMcpServer(app, "/research", projectServerFactory, sessionManager, authMiddleware, peerExposureGate);
  mountMcpServer(app, "/sharing", () => createSharingServer(undefined, { instructions }), sessionManager, authMiddleware, peerExposureGate);

  // --- Per-client filtered proxy mounts (driven by ~/.crow/clients.json) ---
  // Each entry { name: filter } in clients.json mounts /tools-${name}/mcp with
  // the filter applied by createProxyServer. The unfiltered /tools mount stays
  // for admin / diagnostic use.
  const CLIENT_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
  const CLIENT_NAME_RESERVED = new Set([
    "tools", "memory", "projects", "research", "sharing", "storage", "router", "blog-mcp", "wm",
  ]);
  try {
    const clientsPath = join(resolveCrowHome(), "clients.json");
    if (existsSync(clientsPath)) {
      const clients = JSON.parse(readFileSync(clientsPath, "utf8"));
      for (const [name, filter] of Object.entries(clients)) {
        if (!CLIENT_NAME_RE.test(name)) {
          console.warn(`[gateway] clients.json: skipping invalid name ${JSON.stringify(name)}`);
          continue;
        }
        if (CLIENT_NAME_RESERVED.has(name)) {
          console.warn(`[gateway] clients.json: skipping reserved name ${JSON.stringify(name)}`);
          continue;
        }
        mountMcpServer(app, `/tools-${name}`, () => createProxyServer(filter), sessionManager, authMiddleware, peerExposureGate);
        console.log(`[gateway] mount /tools-${name}/mcp (filter: ${JSON.stringify(filter)})`);
      }
    }
  } catch (err) {
    console.warn(`[gateway] clients.json: load failed: ${err.message}`);
  }

  mountMcpServer(app, "/tools", createProxyServer, sessionManager, authMiddleware, peerExposureGate);

  // Also mount at /mcp for single-server compatibility (uses memory)
  mountMcpServer(app, "", () => createMemoryServer(undefined, { instructions, syncManager }), sessionManager, authMiddleware, peerExposureGate);

  // --- Mount Router (consolidated endpoint, ~75% context reduction) ---
  if (process.env.CROW_DISABLE_ROUTER !== "1") {
    mountMcpServer(app, "/router", () => createRouterServer({ instructions: routerInstructions }), sessionManager, authMiddleware, peerExposureGate);
    console.log("Router server mounted (category tools instead of the full raw tool surface)");
  }

  // C2: return peerExposureGate for module-3's /storage and /blog-mcp mounts
  return { peerExposureGate };
}

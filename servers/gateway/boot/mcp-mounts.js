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
import { OWNER, UNKNOWN } from "../../research/actor.js";
import { createSharingServer, getInstanceSyncManager } from "../../sharing/server.js";
import { createDbClient } from "../../db.js";
import { createProxyServer, resolveCrowHome } from "../proxy.js";
import { createRouterServer } from "../router.js";
import { mountMcpServer } from "../routes/mcp.js";
import { enforcePeerExposure } from "../peer-exposure.js";
import { connectedServers } from "../proxy.js";
import { createBoardMcpServer } from "../board-mcp.js";
import { ensureBoardToken, ensurePhoneToken, ensureModelsToken, ensureArtifactsToken, ensurePeerRelayToken, rotateLlmCloudToken, SERVICES_TOKEN, SATELLITE_TOOLS_TOKEN } from "../local-token.js";
import { peerRelayRouter } from "../routes/peer-relay.js";
import { actorSignRouter } from "../routes/actor-sign.js";
import { initGatewayActorKey, verifyActorSig, verifyBoardActorSig, verifyArtifactsActorSig, verifyBoardThreadActorSig } from "../../../scripts/pi-bots/actor-sig.mjs";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createNotification } from "../../shared/notifications.js";
import { keptSkillNotification } from "../bundle-skill-sync.js";
import { startOutboxDrain } from "../../sharing/sync-outbox-drain.js";

/**
 * Persist the boot's deployment verdict for `emitOrQueue`'s (the stdio
 * door's) db-persisted eligibility gate — see
 * `servers/shared/sync-emit.js` `isDeploymentEligible()`, which reads this
 * same `sync_deployment_enabled` key.
 *
 * OWNER-ONLY (stdio-sync-outbox Task 3): a `--no-auth` companion also
 * constructs a manager on every boot (feedsDisabled=true, `managers.js:37`)
 * but shares the primary's `crow.db` — an unguarded write would clobber the
 * owner's `'1'` with `'0'` on every companion boot, undoing the spec's
 * round-2 fix (spec "The drain", owner-persisted gate). `noAuth` therefore
 * short-circuits before any write.
 *
 * Extracted as its own function (rather than inlined in
 * `mountMcpServers`) so it's directly unit-testable — the full
 * `mountMcpServers` boot needs a live Express app and the process-wide
 * sync-manager singleton, neither of which a focused test should need to
 * stand up just to exercise this matrix.
 * @param {object} db
 * @param {{feedsDisabled: boolean, noAuth: boolean}} opts
 */
export async function persistSyncDeploymentVerdict(db, { feedsDisabled, noAuth }) {
  if (noAuth) return;
  const { writeSetting } = await import("../dashboard/settings/registry.js");
  await writeSetting(db, "sync_deployment_enabled", feedsDisabled ? "0" : "1", { scope: "local" });
}

/**
 * Roles phase 2 Task 14: the cloud-door token (/llm/c) is ROTATED on every
 * boot, not ensured: a fresh value per start. Running pi processes pick it up
 * on their next request (their models.json apiKey command reads the file each
 * time). Best-effort, like the other boot token blocks: a failure is logged
 * (err.message only) and boot continues. Exported with injectable deps so the
 * failure path is unit-testable without standing up mountMcpServers.
 * @returns {Promise<boolean>} true when the token was rotated
 */
export async function rotateCloudDoorTokenAtBoot({
  createDb = createDbClient, rotate = rotateLlmCloudToken, log = console,
} = {}) {
  try {
    const tokenDb = createDb();
    try {
      await rotate(tokenDb);
      log.log("[gateway] cloud-door token rotated");
      return true;
    } finally {
      try { tokenDb.close(); } catch {}
    }
  } catch (err) {
    log.warn(`[gateway] rotateLlmCloudToken failed: ${err.message}`);
    return false;
  }
}

/**
 * Boot step: rotate every loopback-mount family token (pathScopedToken), each
 * with its own DB client. A failed rotation has already deleted that family's
 * stored hash (fail closed: not even the previous boot's token validates), so
 * the log says the family is off until the next boot. Never throws.
 */
export async function rotateFamilyTokensAtBoot({
  createDb = createDbClient, log = console,
  tokens = [[SERVICES_TOKEN, "services-tools"], [SATELLITE_TOOLS_TOKEN, "satellite-tools"]],
} = {}) {
  for (const [tok, label] of tokens) {
    try {
      const tokenDb = createDb();
      try {
        await tok.rotate(tokenDb);
        log.log(`[gateway] ${label} token rotated`);
      } finally {
        try { tokenDb.close(); } catch {}
      }
    } catch (err) {
      log.warn(`[gateway] ${label} token rotation failed: ${err.message}; the ${label} mount refuses every request until the next boot`);
    }
  }
}

export async function mountMcpServers(app, deps) {
  const { authMiddleware, noAuth, instructions, routerInstructions, sessionManager } = deps;

  // Initialize sharing managers eagerly (starts Hyperswarm + Nostr + InstanceSync on boot, not on first request)
  createSharingServer(undefined, { instructions });
  // Get the sync manager so memory server can emit change entries
  const syncManager = getInstanceSyncManager();

  // Persist this boot's deployment verdict — owner-only (see
  // persistSyncDeploymentVerdict's doc comment above).
  try {
    if (syncManager) {
      await persistSyncDeploymentVerdict(syncManager.db, { feedsDisabled: syncManager.feedsDisabled, noAuth });
    }
  } catch (err) {
    console.warn(`[instance-sync] sync_deployment_enabled persist failed: ${err.message}`);
  }

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

  // stdio-sync-outbox Task 4 ("The drain"): drain sync_outbox rows queued by
  // servers/shared/sync-emit.js's emitOrQueue (the stdio door — a
  // memory/research-server process mounted without a live
  // InstanceSyncManager). Runs a boot pass immediately, then every 60s.
  // AFTER eagerInitPairedPeers so the first pass has a real chance at armed
  // feeds instead of parking everything on cold outFeeds. Never blocks
  // boot — startOutboxDrain's own tick() swallows/logs drain failures.
  try {
    if (syncManager) {
      startOutboxDrain(syncManager, syncManager.db);
    }
  } catch (err) {
    console.warn(`[instance-sync] startOutboxDrain failed: ${err.message}`);
  }

  // 2d C5: reset once-backfill flags whose premise died with a lost out-feed
  // (rotation / restore-from-backup). MUST run BEFORE the once-backfills
  // below so they re-run this same boot (spec §3 C5 / R1 F4 ordering).
  // Also MUST precede the settings-scope heal blocks below: once
  // setSettingsSyncManager wires the manager (just below), those heals emit
  // via writeSetting — a post-heal C5 would see that emission and
  // false-negative the exact rotation-boot premise it exists to catch (T9 review).
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
    const { repaired, errors, skillsKept = [] } = await repairInstalledBundleAssets();
    if (repaired.length > 0) {
      console.log(`[bundles] Repaired assets: ${repaired.join("; ")}`);
    }
    if (errors.length > 0) {
      console.warn(`[bundles] Asset repair errors:`, errors);
    }
    // Recovery keys: keys an older install kept only in its .env go into the keychain once.
    try {
      const { backfillBundleKeychain } = await import("../routes/bundles.js");
      await backfillBundleKeychain();
    } catch (err) {
      console.warn(`[keychain] backfill skipped: ${err.message}`);
    }
    // Skill sync: one notification per skill the owner EDITED, once per new
    // shipped version (the record's notifiedFor). Unverified copies are never
    // notified — we cannot tell the owner they edited something we cannot verify.
    // notify is only ever true in mode "on" (bundle-skill-sync.js), so a
    // report-mode gateway never posts this.
    const edited = skillsKept.filter((k) => k.notify && k.reason === "edited");
    if (edited.length) {
      const ndb = createDbClient();
      try {
        for (const k of edited) {
          await createNotification(ndb, keptSkillNotification(k)).catch(() => {});
        }
      } finally { try { ndb.close(); } catch {} }
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

  // Track 1 Task 6 (D-T1.1): mint the board token at boot when absent
  // (idempotent — a live hash + a readable raw file is a no-op on every
  // subsequent boot). Best-effort: a failure here must not block gateway
  // boot — the board mount still works with the full local token even if
  // the board token mint failed.
  try {
    const tokenDb = createDbClient();
    try {
      const { minted } = await ensureBoardToken(tokenDb);
      if (minted) console.log("[gateway] board token minted");
    } finally {
      try { tokenDb.close(); } catch {}
    }
  } catch (err) {
    console.warn(`[gateway] ensureBoardToken failed: ${err.message}`);
  }

  // Models arc plan 2 Task 6: the path-scoped models token for the lifecycle
  // API (/llm/models). Same shape as the board token above; best-effort.
  try {
    const tokenDb = createDbClient();
    try {
      const { minted } = await ensureModelsToken(tokenDb);
      if (minted) console.log("[gateway] models token minted");
    } finally {
      try { tokenDb.close(); } catch {}
    }
  } catch (err) {
    console.warn(`[gateway] ensureModelsToken failed: ${err.message}`);
  }

  // Item 46 PR-B: the peer relay a pi bot's remote proxy calls instead of a
  // peer (routes/peer-relay.js). Its token is minted here, best-effort like the
  // board token; without it the relay refuses every call (bots lose remote
  // tools, nothing else). The router validates its own token and signed actor;
  // no global middleware authenticates /peer-relay/... (the local-token MCP
  // path match is a single segment, and the relay token is in no MCP check).
  try {
    const tokenDb = createDbClient();
    try {
      const { minted } = await ensurePeerRelayToken(tokenDb);
      if (minted) console.log("[gateway] peer relay token minted");
    } finally {
      try { tokenDb.close(); } catch {}
    }
  } catch (err) {
    console.warn(`[gateway] ensurePeerRelayToken failed: ${err.message}`);
  }
  // Loopback-mount family tokens (pathScopedToken): fresh on every boot.
  await rotateFamilyTokensAtBoot();
  app.use(peerRelayRouter({ createDbClient }));
  // Item 46 PR-B: the loopback signing relay for the key-less bot hosts
  // (routes/actor-sign.js). It authenticates the calling process itself (the
  // main process of a live pibot-* unit) and signs with the key minted below;
  // the key never leaves this process.
  app.use(actorSignRouter({ createDbClient }));

  // Roles phase 2 Task 14: rotate the cloud-door token (best-effort).
  await rotateCloudDoorTokenAtBoot();

  // S5: board actor headers count only with a signature from the per-boot
  // in-memory key, so the key must exist before any bot world is built in
  // this process (idempotent; the phone mount below reuses it).
  initGatewayActorKey();
  mountMcpServer(app, "/board", () => createBoardMcpServer({ instructions, verifyActor: verifyBoardActorSig, verifyThread: verifyBoardThreadActorSig }), sessionManager, authMiddleware, peerExposureGate);
  // Phone bundle (plan A): core-mounted like /board, but only when the bundle
  // is installed. The server factory is imported by PATH from the installed
  // copy (ramble-transport precedent). A failure here never blocks boot.
  try {
    const phoneServerDir = join(resolveCrowHome(), "bundles", "phone", "server");
    if (existsSync(join(phoneServerDir, "mcp.js"))) {
      const { createPhoneMcpServer } = await import(pathToFileURL(join(phoneServerDir, "mcp.js")).href);
      const { initPhoneTables } = await import(pathToFileURL(join(phoneServerDir, "init-tables.js")).href);
      const phoneDb = createDbClient();
      await initPhoneTables(phoneDb);
      const { minted } = await ensurePhoneToken(phoneDb);
      if (minted) console.log("[gateway] phone token minted");
      const { readSetting } = await import("../dashboard/settings/registry.js");
      const ownerNumber = async () => (await readSetting(phoneDb, "phone_owner_number")) || null;
      // Spec 2026-10-01 §4.2: the call card in the requesting Perch chat. The
      // engine is looked up per push and never created here; it checks I3 itself.
      let warnedNoEngine = false;
      const notifyCard = async (sid, frame, opts) => {
        const { notifyCardToResident } = await import("../perch-interactive.js");
        const r = await notifyCardToResident(sid, frame, opts);
        if (r && r.reason === "no_engine") { if (!warnedNoEngine) { warnedNoEngine = true; console.warn("[phone] no Perch engine in this process yet: call cards appear when the chat is opened"); } }
        return r;
      };
      // S2: bot actor headers count only with a signature from the per-boot
      // key that lives in this process's memory (scripts/pi-bots/actor-sig.mjs).
      initGatewayActorKey();
      mountMcpServer(app, "/phone", () => createPhoneMcpServer({ db: phoneDb, ownerNumber, McpServer, z, notify: createNotification, notifyCard, verifyActor: verifyActorSig }), sessionManager, authMiddleware, peerExposureGate);
      console.log("[gateway] phone MCP mounted at /phone/mcp");
    }
  } catch (err) {
    console.warn(`[gateway] phone mount skipped: ${err.message}`);
  }
  // Crow Artifacts (spec §3, §7.1): core-mounted like /phone, only when the
  // bundle is installed; the artifact ORIGIN (a separate node:http listener,
  // artifact-origin/server.js) starts only when CROW_ARTIFACT_ORIGIN_PORT is
  // set. Neither failure ever blocks boot.
  try {
    const artDir = join(resolveCrowHome(), "bundles", "artifacts", "server");
    if (existsSync(join(artDir, "mcp.js"))) {
      const imp = (f) => import(pathToFileURL(join(artDir, f)).href);
      const [{ createArtifactsMcpServer }, { initArtifactsTables }, { createBlobStore }, artStore] = await Promise.all(["mcp.js", "init-tables.js", "blob-store-minio.js", "store.js"].map(imp));
      const { resolveDataDir } = await import("../../db.js");
      const { markdownBlocks } = await import("../../blog/renderer.js");
      const artDb = createDbClient();
      await initArtifactsTables(artDb);
      const { minted } = await ensureArtifactsToken(artDb);
      if (minted) console.log("[gateway] artifacts token minted");
      // S2a (review M7): once per instance, defs that grant artifact_update
      // get artifact_find + artifact_attach written in (cap-guarded) — the
      // needs_link recovery path. Off the boot path; never throws.
      setImmediate(async () => {
        try { (await import("../../../scripts/pi-bots/artifacts-companions.mjs")).migrateArtifactsCompanions(artDb, { notify: (n) => createNotification(artDb, n) }).catch(() => {}); }
        catch (e) { console.warn(`[gateway] artifacts companion migration: ${e.message}`); }
      });
      // MinIO when shared storage is available, else local disk (spec §11).
      const blobs = await createBlobStore(artDb, resolveDataDir());
      initGatewayActorKey();
      // R-M3 / Task 3.6: a finished round stops its locked session at once
      // and tells the owner the new version is ready; the sweep below catches
      // timeouts, queued retries and anything missed.
      const { runSweep, roundDoneEffects } = await imp("sweep.js");
      const engineOrNull = async () => { try { return (await import("../perch-interactive.js")).getInteractiveEngine({ createIfMissing: false }); } catch { return null; } };
      const notifyOwner = (n) => createNotification(artDb, n);
      const onRoundDone = async (r) => {
        try { await roundDoneEffects(artDb, r, { engine: await engineOrNull(), notify: notifyOwner }); }
        catch (e) { console.warn(`[gateway] artifacts round-done effects: ${e.message}`); }
      };
      // Chat-first fan-out (spec v1.6 D25): the bundle pushes pointer frames
      // through the engine's resident-only emitExternal hook. Same lookup
      // discipline as the phone card's notifyCard: never creates an engine,
      // never wakes a session — with no engine the frame is dropped and the
      // by-thread history route replays the card on the next open.
      let emitExternalWarned = false;
      const emitExternal = async (threadId, frame, opts) => {
        try { return (await import("../perch-interactive.js")).emitExternalToResident(threadId, frame, opts); }
        catch (e) {
          // L2 (plan review): an import/syntax failure here must not be silent
          // — log it once per process, then degrade to no_engine.
          if (!emitExternalWarned) { emitExternalWarned = true; console.warn(`[gateway] artifacts hub fan-out unavailable: ${(e && e.message) || e}`); }
          return { delivered: false, botId: null, reason: "no_engine" };
        }
      };
      // S2 M5: the needs_link gate lets an owner-made card's session write
      // without a chat link; the bundle cannot open tasks.db, so the gateway
      // answers (fails closed on any error).
      const { cardMadeByOwner } = await import("../board/artifact-card.js");
      // Design kit (spec §4): used only when installed on THIS instance; the
      // installed copy is re-read when its manifest changes (no restart).
      // design.js failing to load degrades to "no kit" (design = null); it
      // never takes the Artifacts mount down (final review M4).
      let design = null;
      try { design = (await imp("design.js")).createDesign({ crowHome: resolveCrowHome(), db: artDb }); }
      catch (e) { console.warn(`[gateway] artifacts: the Design kit seam could not be loaded (${e.message}); saving without the kit`); }
      mountMcpServer(app, "/artifacts", () => createArtifactsMcpServer({ db: artDb, blobs, McpServer, z, verifyActor: verifyArtifactsActorSig, renderDeps: { markdownBlocks, design }, onRoundDone, emitExternal, cardMadeByOwner: (id) => cardMadeByOwner(id) }), sessionManager, authMiddleware, peerExposureGate);
      const { readReservation } = await import("../box-reservation.js");
      const botDefOf = async (botId) => { const r = (await artDb.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id=?", args: [botId] })).rows[0]; try { return r ? JSON.parse(r.definition || "{}") : null; } catch { return null; } };
      // R2-M5/R2-M2: the sweep runs whether or not a Perch engine exists
      // (timeouts and reconciliation need none), once at mount start (off the
      // boot path — it may wait on the write lock, R3-L7), then every 60 s.
      const sweepOnce = async () => {
        try { await runSweep(artDb, { engine: await engineOrNull(), blobs, notify: notifyOwner, reserved: () => readReservation() !== null, botDefOf }); }
        catch (e) { console.warn(`[gateway] artifacts sweep: ${e.message}`); }
      };
      setImmediate(sweepOnce);
      const sweepTimer = setInterval(sweepOnce, 60000);
      sweepTimer.unref?.();
      const { networkFsKind } = await imp("blob-store.js");
      try {
        const kind = await networkFsKind(join(resolveDataDir(), "artifacts"));
        if (kind) { console.warn(`[gateway] artifacts store is on ${kind}: cross-process locking is unreliable there`); createNotification(artDb, { title: "Artifact storage is on a network filesystem", body: `${kind}: keep the Crow data directory on a local disk.`, type: "attention", source: "artifacts" }).catch(() => {}); }
      } catch { /* best effort */ }
      console.log("[gateway] artifacts MCP mounted at /artifacts/mcp");
      // The origin listener has its OWN catch (PR A review L6): a typo in
      // CROW_ARTIFACT_ORIGIN_PORT/URL disables artifact viewing with a named
      // warning — it must never take down the MCP mount or the gateway.
      try {
        const origin = await import("../artifact-origin/runtime.js");
        origin.setContentResolver(artStore.contentResolver(artDb, blobs));
        const srv = await origin.startArtifactOriginFromEnv(process.env);
        if (srv) console.log(`[gateway] artifact origin listening on ${process.env.CROW_ARTIFACT_ORIGIN_BIND || "127.0.0.1"}:${process.env.CROW_ARTIFACT_ORIGIN_PORT}`);
      } catch (err) {
        console.warn(`[gateway] artifact origin NOT started: ${err.message}`);
      }
    }
  } catch (err) {
    console.warn(`[gateway] artifacts mount skipped: ${err.message}`);
  }
  mountMcpServer(app, "/memory", () => createMemoryServer(undefined, { instructions, syncManager }), sessionManager, authMiddleware, peerExposureGate);
  // Who is calling the project tools: an authenticated mount is the owner; a --no-auth mount
  // (routes/mcp.js serves it unauthenticated) is unknown. Peer-instance calls are downgraded per call.
  const mountActor = noAuth ? UNKNOWN : OWNER;
  const projectServerFactory = () => createProjectServer(undefined, { instructions, actor: mountActor });
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
    "tools", "memory", "projects", "research", "sharing", "storage", "router", "blog-mcp", "wm", "board", "phone", "artifacts",
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
    mountMcpServer(app, "/router", () => createRouterServer({ instructions: routerInstructions, actor: mountActor }), sessionManager, authMiddleware, peerExposureGate);
    console.log("Router server mounted (category tools instead of the full raw tool surface)");
  }

  // C2: return peerExposureGate for module-3's /storage and /blog-mcp mounts
  return { peerExposureGate };
}

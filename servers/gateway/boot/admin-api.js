/**
 * boot/admin-api.js — protected API endpoints (behind dashboard auth).
 *
 * /api/health (system stats), provider health matrix, LLM settings migration,
 * provider DB seed, provider DB reconciler (boot + hourly), storage client wiring.
 * Non-route init blocks stay sequential inside.
 * deps: { dashboardAuth, noAuth }
 */

import { createDbClient } from "../../db.js";

// D5: hourly reconcile closes the boot-time tailscale race (own tailnet IP
// absent at boot → own rows look unowned → heals within the hour, because
// syncProvidersFromModelsJson recomputes getOwnAddresses() per run) and the
// owner-never-restarts staleness window. Exported for the env-override test.
export function reconcileIntervalMs(env = process.env) {
  const n = Number(env.CROW_PROVIDERS_RECONCILE_MS);
  return Number.isFinite(n) && n > 0 ? n : 3600_000;
}

export async function mountAdminApi(app, deps) {
  const { dashboardAuth, noAuth } = deps;

  // --- Protected API endpoints (behind dashboard auth) ---
  app.get("/api/health", dashboardAuth, async (req, res) => {
    const os = await import("node:os");
    const { execFileSync } = await import("node:child_process");
    const totalMem = Math.round(os.totalmem() / 1048576);
    const freeMem = Math.round(os.freemem() / 1048576);
    let diskFreeMb = null;
    try {
      const df = execFileSync("df", ["-BM", "--output=avail", "/"], { timeout: 5000 }).toString();
      const lines = df.trim().split("\n");
      if (lines.length > 1) diskFreeMb = parseInt(lines[1], 10) || null;
    } catch {}
    res.json({
      ram_total_mb: totalMem,
      ram_free_mb: freeMem,
      ram_used_mb: totalMem - freeMem,
      disk_free_mb: diskFreeMb,
      uptime_seconds: Math.round(os.uptime()),
      cpus: os.cpus().length,
    });
  });

  // --- Provider health matrix (provider registry liveness) ---
  try {
    const { providersHealthHandler } = await import("../../shared/providers.js");
    app.get("/api/providers/health", dashboardAuth, providersHealthHandler);
    console.log("Provider health matrix mounted at /api/providers/health");
  } catch (err) {
    console.warn("[providers] Failed to mount health matrix:", err.message);
  }

  // --- LLM settings migration (rewrites ai_profiles to pointer mode, folds
  // .env AI_* into a cloud-env-default provider row). Idempotent; runs
  // BEFORE seed/reconciler so subsequent steps see a clean target.
  try {
    const { migrateLlmSettings } = await import("../dashboard/settings/migrations/llm-settings-migration.js");
    const result = await migrateLlmSettings(createDbClient());
    if (result.skipped) {
      // already_migrated — silent unless debugging
    } else {
      console.log(`[llm-migration] profiles=${result.profiles_total} rewrote=${result.profiles_rewrote} providers_created=${result.providers_created} env_default=${result.env_default_migrated}`);
    }
  } catch (err) {
    console.warn("[llm-migration] skipped:", err.message);
  }

  // --- Provider DB seed + reconciler (owner-asserts, spec D1/D5/R2-C1) ---
  // R2-C1 gate: a --no-auth gateway (the crow-mcp-bridge companion) shares
  // the primary's crow.db with feedsDisabled — its upsert writes land but
  // never emit. Under D2 no-op suppression it can win the race to make
  // DB==file, and the PRIMARY then suppresses its own emit → a models.json
  // edit silently never reaches peers. So seed, boot reconcile, AND the
  // hourly interval are all skipped on --no-auth. Precedent: mcp-mounts.js
  // gates healProfileOverridesOnce on !feedsDisabled for the same
  // shared-DB reason. Scratch/CROW_DISABLE_INSTANCE_SYNC gateways with
  // their OWN DB still reconcile (no peers, no hazard).
  if (noAuth) {
    console.log("[providers] Seed/reconcile skipped: --no-auth companion shares the primary's DB and must not write synced provider rows");
  } else {
    // --- Provider DB seed (Phase 5-full: first-boot migration from models.json) ---
    try {
      const { seedProvidersFromModelsJson } = await import("../../shared/providers-db.js");
      const seed = await seedProvidersFromModelsJson(createDbClient());
      if (seed.seeded > 0) {
        console.log(`[providers] Seeded ${seed.seeded} providers from ${seed.source}`);
      }
    } catch (err) {
      console.warn("[providers] First-boot seed skipped:", err.message);
    }

    // --- Provider DB reconciler (owner-asserts sync from models.json) ---
    // Picks up post-boot edits to models.json — but only asserts entries this
    // instance OWNS (baseUrl points at one of its own addresses) or that are
    // absent from the DB; unowned present rows are sync-authoritative (D1).
    // Skips rows marked disabled=1 by unregisterProvidersByBundle so
    // uninstalled bundles don't silently re-enable on the next restart. The
    // "Sync bundle providers" button passes force=true to explicitly re-enable.
    // Never throws out of the timer; quiet when converged.
    const reconcile = async () => {
      try {
        const { syncProvidersFromModelsJson } = await import("../../shared/providers-db.js");
        const res = await syncProvidersFromModelsJson(createDbClient());
        if (res.upserted > 0 || res.reenabled > 0) {
          console.log(`[providers] Reconciled models.json → DB: upserted=${res.upserted} reenabled=${res.reenabled} unchanged=${res.unchanged} skipped_disabled=${res.skipped_disabled} skipped_unowned=${res.skipped_unowned}`);
        }
      } catch (err) {
        console.warn("[providers] Reconciler skipped:", err.message);
      }
    };
    await reconcile();
    // D5: hourly re-run (fresh getOwnAddresses each time) — heals the
    // boot-time tailscale race and owner-never-restarts staleness. D2 makes
    // converged runs free (zero writes, zero emits). unref() so the timer
    // never holds the process open.
    const t = setInterval(reconcile, reconcileIntervalMs());
    t.unref();
  }

  // --- Wire storage client to DB + identity (DB-first precedence over env) ---
  try {
    const { initStorage } = await import("../../storage/s3-client.js");
    const { loadOrCreateIdentity } = await import("../../sharing/identity.js");
    await initStorage({ db: createDbClient(), identity: loadOrCreateIdentity() });
  } catch (err) {
    console.warn("[storage] initStorage failed (env fallback remains active):", err.message);
  }
}

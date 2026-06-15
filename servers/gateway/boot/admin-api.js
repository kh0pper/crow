/**
 * boot/admin-api.js — protected API endpoints (behind dashboard auth).
 *
 * /api/health (system stats), provider health matrix, LLM settings migration,
 * provider DB seed, provider DB reconciler, storage client wiring.
 * Non-route init blocks stay sequential inside.
 * deps: { dashboardAuth }
 */

import { createDbClient } from "../../db.js";

export async function mountAdminApi(app, deps) {
  const { dashboardAuth } = deps;

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

  // --- Provider DB reconciler (LLM-consolidation: continuous sync from models.json) ---
  // Picks up post-boot edits to models.json and upserts them. Skips rows marked
  // disabled=1 by unregisterProvidersByBundle so uninstalled bundles don't
  // silently re-enable on the next restart. The "Sync bundle providers" button
  // in the LLM settings page passes force=true to explicitly re-enable.
  try {
    const { syncProvidersFromModelsJson } = await import("../../shared/providers-db.js");
    const res = await syncProvidersFromModelsJson(createDbClient());
    if (res.upserted > 0 || res.skipped_disabled > 0) {
      console.log(`[providers] Reconciled models.json → DB: upserted=${res.upserted} skipped_disabled=${res.skipped_disabled}`);
    }
  } catch (err) {
    console.warn("[providers] Reconciler skipped:", err.message);
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

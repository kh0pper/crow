/**
 * Settings Scope Routes
 *
 * POST /api/settings/scope — promote/demote a dashboard_settings key between
 *   "global" (synced across paired instances) and "local" (instance-only).
 * GET  /api/settings/scope?key=... — report current scope for a key.
 *
 * Body (POST): { key: string, scope: "global" | "local" }
 *
 * Semantics:
 *   - scope=global → copy the current effective value into the global row,
 *     delete any local override so the global row becomes effective,
 *     emit a sync change so peers pick it up. Key must be in SYNC_ALLOWLIST.
 *   - scope=local  → snapshot current effective value into a local (instance-scoped)
 *     row. Global row (if any) is preserved so other instances keep working.
 */

import { Router } from "express";
import { createDbClient } from "../../db.js";
import {
  readSetting,
  writeSetting,
  deleteLocalSetting,
  getSettingScope,
} from "../dashboard/settings/registry.js";
import { isSyncable } from "../dashboard/settings/sync-allowlist.js";

export default function settingsScopeRouter(authMiddleware) {
  const router = Router();

  router.get("/api/settings/scope", authMiddleware, async (req, res) => {
    const key = String(req.query.key || "");
    if (!key) return res.status(400).json({ error: "key required" });

    const db = createDbClient();
    try {
      const scope = await getSettingScope(db, key);
      const syncable = isSyncable(key);
      res.json({ key, scope, syncable });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      try { db.close(); } catch {}
    }
  });

  router.post("/api/settings/scope", authMiddleware, async (req, res) => {
    const { key, scope } = req.body || {};
    if (!key || !scope) {
      return res.status(400).json({ error: "key and scope required" });
    }
    if (scope !== "global" && scope !== "local") {
      return res.status(400).json({ error: "scope must be 'global' or 'local'" });
    }
    if (scope === "global" && !isSyncable(key)) {
      return res.status(403).json({
        error: `Key "${key}" is not in SYNC_ALLOWLIST; cannot promote to global.`,
        code: "NotSyncable",
      });
    }

    const db = createDbClient();
    try {
      const currentValue = await readSetting(db, key);
      if (currentValue === null) {
        return res.status(404).json({ error: `Setting "${key}" has no value yet.` });
      }

      if (scope === "local") {
        await writeSetting(db, key, currentValue, { scope: "local" });
      } else {
        // Demote any local override, write value at global scope, emit sync
        await deleteLocalSetting(db, key);
        await writeSetting(db, key, currentValue, { scope: "global", allowLocalFallback: false });
      }
      const newScope = await getSettingScope(db, key);
      res.json({ ok: true, key, scope: newScope });
    } catch (err) {
      if (err.code === "NotSyncable") {
        return res.status(403).json({ error: err.message, code: "NotSyncable" });
      }
      res.status(500).json({ error: err.message });
    } finally {
      try { db.close(); } catch {}
    }
  });

  return router;
}

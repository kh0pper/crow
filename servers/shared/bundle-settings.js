/**
 * Bundle Settings — Per-bundle key/value store backed by the shared SQLite database.
 *
 * Used by MCP tool handlers to read safety toggles (e.g., trade-execution enabled,
 * spending enabled, destructive-ops enabled) at tool-call time. This avoids env-var
 * inheritance issues with spawned MCP child processes — flipping a toggle in the
 * Crow's Nest UI takes effect on the very next tool invocation, no restart needed.
 *
 * Storage: the `bundle_settings` table (created by scripts/init-db.js).
 * Schema:  PRIMARY KEY (bundle_id, key); value is TEXT (callers parse as needed).
 */

/**
 * Read a setting for a bundle, returning `fallback` if no row exists.
 *
 * @param {object} db - libsql client (from servers/db.js createDbClient)
 * @param {string} bundleId - bundle id (e.g. "freqtrade", "lnbits")
 * @param {string} key - setting key (e.g. "trading_enabled", "spending_enabled")
 * @param {*} [fallback=null] - returned when the row is missing
 * @returns {Promise<string|*>} the stored TEXT value, or fallback
 */
export async function getBundleSetting(db, bundleId, key, fallback = null) {
  if (!bundleId || !key) {
    throw new Error("getBundleSetting: bundleId and key are required");
  }
  const result = await db.execute({
    sql: "SELECT value FROM bundle_settings WHERE bundle_id = ? AND key = ?",
    args: [bundleId, key],
  });
  if (result.rows.length === 0) return fallback;
  return result.rows[0].value;
}

/**
 * Read a boolean setting. Treats "1", "true", "yes", "on" (case-insensitive) as true.
 * Anything else, including missing, is false (or `fallback` if the row is absent).
 *
 * @param {object} db
 * @param {string} bundleId
 * @param {string} key
 * @param {boolean} [fallback=false]
 * @returns {Promise<boolean>}
 */
export async function getBundleSettingBool(db, bundleId, key, fallback = false) {
  const raw = await getBundleSetting(db, bundleId, key, null);
  if (raw === null) return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

/**
 * Upsert a setting for a bundle. Value is coerced to string for storage.
 *
 * @param {object} db
 * @param {string} bundleId
 * @param {string} key
 * @param {*} value - stored as string (booleans become "true"/"false")
 * @returns {Promise<void>}
 */
export async function setBundleSetting(db, bundleId, key, value) {
  if (!bundleId || !key) {
    throw new Error("setBundleSetting: bundleId and key are required");
  }
  const stored = value === null || value === undefined ? null : String(value);
  await db.execute({
    sql: `INSERT INTO bundle_settings (bundle_id, key, value, updated_at)
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(bundle_id, key)
          DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    args: [bundleId, key, stored],
  });
}

/**
 * Delete a setting (returns to fallback on next read).
 *
 * @param {object} db
 * @param {string} bundleId
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function deleteBundleSetting(db, bundleId, key) {
  await db.execute({
    sql: "DELETE FROM bundle_settings WHERE bundle_id = ? AND key = ?",
    args: [bundleId, key],
  });
}

/**
 * List all settings for a bundle. Returns an object map of key → value.
 *
 * @param {object} db
 * @param {string} bundleId
 * @returns {Promise<Record<string, string>>}
 */
export async function listBundleSettings(db, bundleId) {
  const result = await db.execute({
    sql: "SELECT key, value FROM bundle_settings WHERE bundle_id = ? ORDER BY key",
    args: [bundleId],
  });
  const out = {};
  for (const row of result.rows) {
    out[row.key] = row.value;
  }
  return out;
}

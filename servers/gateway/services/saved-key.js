/**
 * The key the owner already saved for a service, remembered once and reused per project.
 *
 * A "Services add-on" is a registry add-on with a `connect` block. When the owner types a key in
 * the Project Services connect sheet, that value is saved for the project (keychain kind
 * 'service', keyed by the connection uuid, the copy its child is spawned with) AND, the first
 * time, for the whole Crow (kind 'extension', bundle id + env key). The second row is what makes
 * "Use saved key" a one click connect in another project: no retyping, and the saved key is
 * never written to mcp-addons.json or any .env — it is not a Crow-wide key for the server, only
 * a remembered value the owner may reuse.
 *
 * Everything here reads keychain METADATA (kind, bundle_id, env_key, status) except
 * rememberTypedKeys, which is handed the values the owner just typed. Nothing here decrypts a
 * stored row, nothing here answers a client with a value, and nothing here logs one.
 *
 * What changes a saved key and what it reaches:
 *  - Saving a key again (a later connect that types a different one, or the keychain page) never
 *    replaces the saved row while it is active: the first typed key wins, so a per-project
 *    override stays a project-level thing.
 *  - A changed key in Settings > Passwords never touches an existing project's connection: each
 *    connection holds its own sealed copy. A rotated key reaches a project only by disconnecting
 *    and connecting it again (or by typing the new key in that project's sheet).
 *  - A deleted row (or one an uninstall marked extension_removed) hides the one-click button and
 *    answers no_saved_key; the connection that was made from it keeps working.
 */

import { ensureKeychainTable, isSystemBundleId, saveExtensionSecret } from "../keychain/store.js";

/** The label shape of a remembered key: the service, then the field it fills. */
const labelFor = (service, envKey) => `${service.name} - ${envKey}`;

/**
 * Whether a service can even offer the one-click connect: a real connection service (not a
 * Crow-wide toggle), with at least one field, and every field a secret (nothing to configure
 * besides the key). A service with an address or a folder always needs the sheet.
 * @param {object|null} service a service-catalog entry
 * @returns {boolean}
 */
export function isOneClickEligible(service) {
  if (!service || service.crowWide) return false;
  const fields = Array.isArray(service.fields) ? service.fields : [];
  return fields.length > 0 && fields.every((f) => f && f.kind === "secret");
}

/**
 * The service ids that can be connected with one click right now, from metadata only: the
 * service is in the catalog, its extension is installed, it is one-click eligible, and every one
 * of its fields has an ACTIVE keychain extension row for its bundle id. No decrypt, no key
 * needed. A caller computes this for the owner alone, so a non-owner session is never shown the
 * button.
 * @param {object} db
 * @param {Array<object>} catalog serviceCatalog()
 * @param {Set<string>|string[]} installedIds installed bundle ids
 * @returns {Promise<Set<string>>} service ids
 */
export async function savedKeyServiceIds(db, catalog, installedIds) {
  const installed = installedIds instanceof Set ? installedIds : new Set(installedIds || []);
  const out = new Set();
  await ensureKeychainTable(db);
  const { rows } = await db.execute({
    sql: "SELECT bundle_id, env_key FROM crow_keychain WHERE kind = 'extension' AND status = 'active' AND bundle_id IS NOT NULL AND env_key IS NOT NULL",
  });
  const byBundle = new Map();
  for (const r of rows) {
    if (!byBundle.has(r.bundle_id)) byBundle.set(r.bundle_id, new Set());
    byBundle.get(r.bundle_id).add(r.env_key);
  }
  if (byBundle.size === 0) return out;
  for (const service of Array.isArray(catalog) ? catalog : []) {
    if (!isOneClickEligible(service) || isSystemBundleId(service.bundleId) || !installed.has(service.bundleId)) continue;
    const saved = byBundle.get(service.bundleId);
    if (!saved) continue;
    if (service.fields.every((f) => saved.has(f.name))) out.add(service.id);
  }
  return out;
}

/**
 * Remembers the secrets the owner just typed for a service, so another project can connect it
 * with one click. One keychain extension row per declared secret field, origin 'typed', only
 * while no ACTIVE row exists for that bundle + env key ("first typed key wins"): a later connect
 * that types a different key — another account of the same service, a rotated token — leaves the
 * remembered value alone. A row an uninstall left as extension_removed is not active, so the next
 * typed connect after a reinstall saves over it and it becomes active again.
 *
 * Never fatal: a keychain fault here must not fail a connect that already succeeded, so failures
 * are swallowed after one fixed log line (never a value, never an error message).
 * @param {object} db
 * @param {{id:string, seed:Buffer}|null} key the keychain write key (an existing key is fine)
 * @param {object} service a service-catalog entry
 * @param {Record<string,string>} secrets the typed secret values, by field name
 * @param {{now?: Date, save?: Function}} [opts] `save` is a test seam (default saveExtensionSecret)
 */
export async function rememberTypedKeys(db, key, service, secrets, { now, save = saveExtensionSecret } = {}) {
  try {
    if (!service || !key || typeof key.id !== "string" || !Buffer.isBuffer(key.seed)) return;
    const fields = Array.isArray(service.fields) ? service.fields : [];
    if (!fields.some((f) => f && f.kind === "secret")) return;
    await ensureKeychainTable(db);
    for (const f of fields) {
      if (!f || f.kind !== "secret") continue;
      const secret = secrets && Object.hasOwn(secrets, f.name) ? secrets[f.name] : null;
      if (typeof secret !== "string" || secret === "") continue;
      const active = (await db.execute({
        sql: "SELECT 1 FROM crow_keychain WHERE kind = 'extension' AND bundle_id = ? AND env_key = ? AND status = 'active' AND key_id = ? LIMIT 1",
        args: [service.bundleId, f.name, key.id],
      })).rows.length > 0;
      if (active) continue;
      await save(db, key, {
        bundleId: service.bundleId,
        envKey: f.name,
        label: labelFor(service, f.name),
        secret,
        origin: "typed",
        ...(now ? { now } : {}),
      });
    }
  } catch {
    console.warn("[services] saved key not remembered");
  }
}
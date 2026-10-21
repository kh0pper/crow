/**
 * The installer's side of the keychain (spec §5.7).
 *  - generated keychain:true tokens (planGeneratedEnv().minted) are ALWAYS saved, with a
 *    30-minute first-view grant, and they are saved FIRST: if that save fails the caller
 *    aborts before any hash reaches .env or the retained copy (review C5), so a retry
 *    simply mints a new token instead of leaving an unusable hash behind;
 *  - typed fields are saved only when the manifest opts them in (generatable / keychain,
 *    Casey Q1) AND the request is a LOCAL dashboard session that ticked "Save to Crow
 *    keychain" (sanitizeKeychainRequest); a failure there is a job-log line, not a failure;
 *  - the optional vault copy uses the typed vault credentials once, then drops them.
 */
import { createDbClient, auditLog } from "../../db.js";
import { keychainGeneratedKeys, keychainEligibleKeys, expandKeychainTemplate, isReplacedValue } from "../bundle-env-secrets.js";
import { createNotification } from "../../shared/notifications.js";
import { saveExtensionSecret, reactivateBundleEntries, hasExtensionEntry, markBundleRemoved, ensureWriteKey, listEntries, openEntrySecret } from "./store.js";
import { loadKeychainKey } from "./key.js";
import { unexportedCount } from "./reminder.js";
import { readSetting, writeSetting } from "../dashboard/settings/registry.js";
import { vaultwardenStatus, saveToVault, VAULT_REASONS } from "./vault-save.js";

let _override = null;
export function _setKeychainDepsForTest(deps) { _override = deps || null; }
function deps() {
  return {
    openDb: () => createDbClient(),
    // The key to READ with; null when missing or damaged (restore is best-effort).
    readKey: () => { try { return loadKeychainKey(); } catch { return null; } },
    // The key to save with (created on first use; refuses a damaged key while entries exist).
    writeKey: (db) => ensureWriteKey(db, {
      onNewKey: async ({ orphaned }) => {
        await auditLog(db, "keychain_key_created", { details: { orphaned } });
        try { await createNotification(db, { title: "New Crow keychain key created", body: `${orphaned} saved password(s) were sealed with a key that is no longer on this machine. Import an Export file in Settings → Security & passwords → Saved passwords & keys to recover them.`, type: "system", source: "keychain" }); } catch {}
      },
    }),
    vault: { status: vaultwardenStatus, save: saveToVault },
    audit: auditLog,
    ...(_override || {}),
  };
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export function sanitizeKeychainRequest(raw, { localSession }) {
  if (!localSession || !raw || typeof raw !== "object") return { save: [], vault: null };
  const save = Array.isArray(raw.save) ? raw.save.filter((k) => typeof k === "string" && ENV_NAME.test(k)).slice(0, 32) : [];
  let vault = null;
  const v = raw.vault;
  if (v && typeof v === "object" && typeof v.email === "string" && typeof v.password === "string" && v.email.trim() && v.password) {
    vault = { email: v.email.trim().slice(0, 320), password: v.password.slice(0, 1024) };
  }
  return { save, vault };
}

function templateEnv(manifest, env) {
  const out = {};
  for (const v of manifest?.env_vars || []) if (v && v.default !== undefined && v.default !== null) out[v.name] = String(v.default);
  return { ...out, ...(env || {}) };
}

/**
 * @returns {Promise<{ saved: number, firstView: number[], vault: {ok:boolean, reason?:string}|null, mintedSaved: boolean }>}
 * Never throws. `mintedSaved` is false only when a GENERATED token could not be saved —
 * the caller must then abort the install without persisting anything.
 */
export async function recordKeychainForInstall({ bundleId, manifest, env, minted, reusedPlain = {}, keychainReq, log = () => {} }) {
  const d = deps();
  const out = { saved: 0, firstView: [], vault: null, mintedSaved: true };
  const specs = new Map((manifest?.env_vars || []).map((v) => [v.name, v]));
  const eligible = new Set(keychainEligibleKeys(manifest));
  const tEnv = templateEnv(manifest, env);
  const mintedList = Object.entries(minted || {}).map(([k, plain]) => ({ k, plain, origin: "generated", firstView: true }));
  const typedList = (keychainReq?.save || [])
    .filter((k) => eligible.has(k) && typeof env?.[k] === "string" && env[k] !== "")
    .map((k) => ({ k, plain: env[k], origin: "typed", firstView: false }));
  const reused = keychainGeneratedKeys(manifest).filter((k) => !Object.hasOwn(minted || {}, k));
  // A keychain:true value KEPT from an earlier install (typed before the field was generated,
  // or a retained copy) whose keychain entry does not exist: the form no longer shows the
  // field, so the keychain is the only place the user can read it. Saved best-effort.
  // A value that is the old compose's published fallback (origin "legacy") is never saved:
  // the keychain would present a publicly known default as this install's password.
  for (const [k, r] of Object.entries(reusedPlain || {})) {
    if (r?.origin === "legacy") log(`${k} is running on the published default; reinstall with data deletion or rotate it`);
  }
  const keptCandidates = Object.entries(reusedPlain || {})
    .filter(([k, r]) => reused.includes(k) && r && r.origin !== "legacy" && typeof r.plain === "string" && r.plain !== "")
    .map(([k, r]) => ({ k, plain: r.plain, origin: r.origin === "typed" ? "typed" : "generated", firstView: true }));
  if (mintedList.length === 0 && typedList.length === 0 && reused.length === 0) return out;

  let db;
  const saved = [];
  const saveOne = async (key, s) => {
    const spec = specs.get(s.k) || {};
    const label = `${manifest?.name || bundleId} — ${spec.keychain_label || s.k}`;
    const username = expandKeychainTemplate(spec.keychain_username, tEnv);
    const url = expandKeychainTemplate(spec.keychain_url, tEnv);
    const r = await saveExtensionSecret(db, key, { bundleId, envKey: s.k, label, username, url, secret: s.plain, origin: s.origin, firstView: s.firstView });
    out.saved++;
    if (s.firstView) out.firstView.push(r.id);
    saved.push({ id: r.id, label, username, url, plain: s.plain, envKey: s.k });
    await d.audit(db, "keychain_save", { details: { entry_id: r.id, bundle_id: bundleId, env_key: s.k, origin: s.origin } });
  };
  try {
    db = d.openDb();
    if (reused.length) await reactivateBundleEntries(db, bundleId, reused);
    const keptList = [];
    for (const c of keptCandidates) {
      try { if (!(await hasExtensionEntry(db, bundleId, c.k))) keptList.push(c); } catch { /* best-effort */ }
    }
    let key = null;
    try {
      if (mintedList.length || typedList.length || keptList.length) key = await d.writeKey(db);
      for (const s of mintedList) await saveOne(key, s);
    } catch (err) {
      if (mintedList.length) {
        out.mintedSaved = false;
        log(err?.code === "KEYCHAIN_KEY_INVALID"
          ? `Crow keychain key file unreadable at ${err.path}: restore it (or delete the saved passwords in Settings → Security & passwords → Saved passwords & keys), then install again. Nothing was written.`
          : `Could not save the generated password(s) to Crow keychain (${err?.code || err?.name || "error"}); nothing was written, so retrying the install mints a new one`);
        return out;
      }
      log(err?.code === "KEYCHAIN_KEY_INVALID"
        ? `Passwords were not saved to Crow keychain: its key file is unreadable at ${err.path}. The install continues.`
        : `Passwords were not saved to Crow keychain (${err?.code || err?.name || "error"}). The install continues.`);
    }
    for (const s of key ? keptList : []) {
      try { await saveOne(key, s); } catch (err) { log(`Could not save the kept ${s.k} to Crow keychain (${err?.code || err?.name || "error"}); the install continues`); }
    }
    for (const s of key ? typedList : []) {
      try { await saveOne(key, s); } catch (err) { log(`Could not save ${s.k} to Crow keychain (${err?.code || err?.name || "error"}); the install continues`); }
    }
    if (out.saved) log(`Saved ${out.saved} password(s) to Crow keychain (Settings → Security & passwords → Saved passwords & keys)`);
    if (mintedList.length && out.saved) {
      try {
        if (key && (await unexportedCount(db, key.id)) > 0) log("This key exists only on this machine: export your keychain (Settings → Security & passwords → Saved passwords & keys → Export) so it can be recovered if the machine is lost.");
      } catch { /* the reminder never blocks an install */ }
    }

    if (keychainReq?.vault && saved.length) {
      const st = d.vault.status();
      if (!st || !st.installed || !st.cliPath) {
        out.vault = { ok: false, reason: VAULT_REASONS.missingCli };
      } else if (!st.secure) {
        // R-B: the Bitwarden CLI refuses http:// servers; don't even try.
        out.vault = { ok: false, reason: VAULT_REASONS.insecureUrl };
      } else if (st.serverOutdated) {
        out.vault = { ok: false, reason: st.serverOutdated };
      } else {
        out.vault = { ok: true };
        for (const e of saved) {
          const r = await d.vault.save({
            cliPath: st.cliPath, serverUrl: st.serverUrl, email: keychainReq.vault.email, masterPassword: keychainReq.vault.password,
            item: { name: e.label, username: e.username, password: e.plain, url: e.url, notes: `Saved by Crow (${bundleId} / ${e.envKey})` },
          });
          await d.audit(db, "keychain_vault_save", { details: { entry_id: e.id, bundle_id: bundleId, env_key: e.envKey, ok: !!r.ok, reason: r.ok ? null : r.reason } });
          if (!r.ok) { out.vault = { ok: false, reason: r.reason }; break; }
        }
      }
      log(out.vault.ok ? "Vaultwarden: saved to your vault" : `Vaultwarden save did not complete: ${out.vault.reason} The password is in Crow keychain; you can retry from Settings → Security & passwords → Saved passwords & keys.`);
    }
  } catch (err) {
    if (mintedList.length && out.firstView.length < mintedList.length) out.mintedSaved = false;
    log(`Crow keychain save did not complete (${err?.code || err?.name || "error"})`);
  } finally {
    if (keychainReq) keychainReq.vault = null;
    for (const e of saved) e.plain = null;
    try { db?.close(); } catch {}
  }
  return out;
}

/**
 * For planGeneratedEnv's keychain rung: `values` = plaintext of this bundle's keychain:true
 * GENERATED keys that a readable entry holds (any status: an uninstall marks entries
 * extension_removed and keeps them); `unreadable` = such keys whose entry exists but is
 * sealed with a keychain key this machine does not have (or has no key file at all). This
 * is how a rebuilt machine gets its keys back: restore crow.db, import the keychain Export,
 * reinstall. Read-only and best-effort: a failure returns nothing and the install mints as
 * before. Values are never logged and never synced (crow_keychain is LOCAL_ONLY).
 */
export async function keychainRestoreValues(bundleId, manifest) {
  const keys = keychainGeneratedKeys(manifest);
  const out = { values: {}, unreadable: [], failed: false };
  if (keys.length === 0) return out;
  let db;
  try {
    const key = deps().readKey();
    db = deps().openDb();
    for (const e of await listEntries(db, { keyId: key?.id ?? null })) {
      if (e.kind !== "extension" || e.bundle_id !== bundleId || !keys.includes(e.env_key)) continue;
      if (!e.readable || !key) { out.unreadable.push(e.env_key); continue; }
      // A damaged entry counts as unreadable (it is never minted over), not as "none".
      try {
        const plain = await openEntrySecret(db, key, e.id);
        if (typeof plain === "string" && plain !== "") out.values[e.env_key] = plain;
        else out.unreadable.push(e.env_key);
      } catch { out.unreadable.push(e.env_key); }
    }
  } catch {
    // FAIL CLOSED: the keychain could not be read, so the caller must not mint a
    // keychain:true key (a mint would replace an entry this read could not see).
    return { values: {}, unreadable: [], failed: true };
  } finally {
    try { db?.close(); } catch {}
  }
  return out;
}

/**
 * Boot backfill (recovery keys, queue item 30): an installed extension whose manifest now
 * saves a generated key to the keychain (campaigns/tax, mastodon/pixelfed/peertube data
 * keys) but was installed before that has the key only in its .env / retained copy / MCP
 * entry, and the field is no longer shown in Configure. Save each such value once, so it is
 * visible in Settings → Security & passwords → Saved passwords & keys and goes into the user's Export. Never overwrites an
 * entry (any status, readable or not); skips store_as keys (only a hash is on disk). No
 * first view (nothing new was minted). Best-effort; names only in `log`.
 * `values` = { envKey: { plain, origin } } gathered by the caller.
 */
export const BACKFILL_SETTING = "keychain_backfilled_keys";

export async function backfillKeychainEntries(bundleId, manifest, values, { log = () => {} } = {}) {
  const specs = new Map((manifest?.env_vars || []).map((v) => [v.name, v]));
  // Never a publicly known value (replace_values_sha256): the next install replaces it.
  const todo = keychainGeneratedKeys(manifest).filter((k) => !specs.get(k)?.store_as && values?.[k]?.plain && !isReplacedValue(specs.get(k), values[k].plain));
  if (todo.length === 0) return 0;
  let db;
  let saved = 0;
  try {
    db = deps().openDb();
    // Once per bundle+key: a key the user later DELETED in Settings → Security & passwords → Saved passwords & keys is never
    // brought back by a later boot (local setting; never synced).
    let done = {};
    try { done = JSON.parse((await readSetting(db, BACKFILL_SETTING)) || "{}") || {}; } catch { done = {}; }
    const mark = async (ks) => { for (const k of ks) done[`${bundleId}:${k}`] = true; await writeSetting(db, BACKFILL_SETTING, JSON.stringify(done), { scope: "local" }); };
    const missing = [];
    const present = [];
    for (const k of todo) {
      if (done[`${bundleId}:${k}`]) continue;
      if (await hasExtensionEntry(db, bundleId, k)) present.push(k); else missing.push(k);
    }
    if (present.length) await mark(present);
    if (missing.length === 0) return 0;
    const key = await deps().writeKey(db);
    const tEnv = templateEnv(manifest, Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.plain])));
    for (const k of missing) {
      const spec = specs.get(k) || {};
      const label = `${manifest?.name || bundleId} — ${spec.keychain_label || k}`;
      const r = await saveExtensionSecret(db, key, { bundleId, envKey: k, label, username: expandKeychainTemplate(spec.keychain_username, tEnv), url: expandKeychainTemplate(spec.keychain_url, tEnv), secret: values[k].plain, origin: values[k].origin === "generated" ? "generated" : "typed", firstView: false });
      await deps().audit(db, "keychain_save", { details: { entry_id: r.id, bundle_id: bundleId, env_key: k, origin: "kept", backfill: true } });
      saved++;
    }
    await mark(missing);
    log(`${bundleId}: saved ${missing.join(", ")} to Crow keychain (kept from the existing install)`);
  } catch (err) {
    log(`${bundleId}: could not save kept keys to Crow keychain (${err?.code || err?.name || "error"})`);
  } finally {
    try { db?.close(); } catch {}
  }
  return saved;
}

export async function markBundleKeychainRemoved(bundleId) {
  let db;
  try {
    db = deps().openDb();
    return await markBundleRemoved(db, bundleId);
  } catch {
    return 0;
  } finally {
    try { db?.close(); } catch {}
  }
}

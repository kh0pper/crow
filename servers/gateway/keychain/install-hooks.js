/**
 * The installer's side of the keychain (spec §5.7).
 *  - generated keychain:true tokens (planGeneratedEnv().minted) are ALWAYS saved, with a
 *    30-minute first-view grant, and they are saved FIRST: if that save fails the caller
 *    aborts before any hash reaches .env or the retained copy (review C5), so a retry
 *    simply mints a new token instead of leaving an unusable hash behind;
 *  - typed fields are saved only when the manifest opts them in (generatable / keychain,
 *    Kevin Q1) AND the request is a LOCAL dashboard session that ticked "Save to Crow
 *    keychain" (sanitizeKeychainRequest); a failure there is a job-log line, not a failure;
 *  - the optional vault copy uses the typed vault credentials once, then drops them.
 */
import { createDbClient, auditLog } from "../../db.js";
import { keychainGeneratedKeys, keychainEligibleKeys, expandKeychainTemplate } from "../bundle-env-secrets.js";
import { createNotification } from "../../shared/notifications.js";
import { saveExtensionSecret, reactivateBundleEntries, hasExtensionEntry, markBundleRemoved, ensureWriteKey } from "./store.js";
import { vaultwardenStatus, saveToVault, VAULT_REASONS } from "./vault-save.js";

let _override = null;
export function _setKeychainDepsForTest(deps) { _override = deps || null; }
function deps() {
  return {
    openDb: () => createDbClient(),
    // The key to save with (created on first use; refuses a damaged key while entries exist).
    writeKey: (db) => ensureWriteKey(db, {
      onNewKey: async ({ orphaned }) => {
        await auditLog(db, "keychain_key_created", { details: { orphaned } });
        try { await createNotification(db, { title: "New Crow keychain key created", body: `${orphaned} saved password(s) were sealed with a key that is no longer on this machine. Import an Export file in Settings → Passwords to recover them.`, type: "system", source: "keychain" }); } catch {}
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
  const keptCandidates = Object.entries(reusedPlain || {})
    .filter(([k, r]) => reused.includes(k) && r && typeof r.plain === "string" && r.plain !== "")
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
          ? `Crow keychain key file unreadable at ${err.path}: restore it (or delete the saved passwords in Settings → Passwords), then install again. Nothing was written.`
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
    if (out.saved) log(`Saved ${out.saved} password(s) to Crow keychain (Settings → Passwords)`);

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
      log(out.vault.ok ? "Vaultwarden: saved to your vault" : `Vaultwarden save did not complete: ${out.vault.reason} The password is in Crow keychain; you can retry from Settings → Passwords.`);
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

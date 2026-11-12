/**
 * Add-on secrets — sealing a save into the keychain (task 1.4) and the per-add-on lock
 * every sealing writer holds for its whole write section (0.6).
 *
 * sealEntrySecrets turns ONE save's secret values into `crow_keychain` rows (kind
 * ADDON_KEY_KIND, bundle id + env name) and returns a new entry whose `env` no longer holds
 * them and whose `keychainEnv` lists them. Nothing is stripped from the file without a
 * read-back proof through the SAME paths the spawn uses (0.7): the proof reads the row back
 * with the fresh read-only handle readAddonSecretsSync opens, and checks the key file's id
 * is the key the seal wrote with, so a save can never claim a key a child could not get.
 *
 * PR1 ships this with sealing OFF (addonSecretsSealingOn is false unless the operator sets
 * CROW_ADDON_SECRETS_KEYCHAIN=1), so today the only thing a writer does is the opt-out of
 * 0.3 row 4: a listed name whose value was just written plain is un-listed, and the keychain
 * row is kept for the owner to see in Settings.
 *
 * Nothing here logs, returns, audits or throws a secret VALUE. Messages name the add-on id
 * and the env NAMES; errors carry a fixed sentence and a `code`.
 *
 * The lock (withAddonLock) is an in-process keyed promise-chain mutex. It is RE-ENTRANT per
 * add-on id through the AsyncLocalStorage it already uses (review round 2): the install path
 * holds it and calls the first-admin seam, which asks for the same id again — that nested
 * call runs inline instead of deadlocking. A different id, or the same id from an
 * independent async context, queues behind the current holder.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { auditLog, createDbClient } from "../db.js";
import { resolveCrowHome } from "../shared/crow-home.js";
import { upsertItem as upsertFixItItem } from "../shared/fix-it/store.js";
import {
  ADDON_KEYCHAIN_FIELD, AddonKeysUnavailableError, addonSecretsSealingOn, keychainEnvNames,
  readAddonSecretsSync, sealableEnv,
} from "../shared/addon-secrets.js";
import { gatewayKeychainPaths } from "./addon-keys-paths.js";
import { keychainKeyState, loadKeychainKey } from "./keychain/key.js";
import { countEntries, ensureWriteKey, saveExtensionSecret } from "./keychain/store.js";

// ─── the refusal when the key file is gone but rows depend on it (round 2, item 3) ──

/**
 * A save was refused because the keychain key file is missing while `crow_keychain` still
 * holds rows. Minting a new key there would make every saved row unreadable for good, so
 * the owner restores the key file (or imports a keychain export) first.
 */
export const KEY_SAVE_REFUSED =
  "Crow's keychain key is missing, so it did not save this key. Restore the keychain key or import a keychain export first.";

export class AddonKeysSaveRefusedError extends Error {
  constructor(bundleId, names = []) {
    super(KEY_SAVE_REFUSED);
    this.name = "AddonKeysSaveRefusedError";
    this.code = "KEYCHAIN_KEY_MISSING_ROWS";
    this.bundleId = typeof bundleId === "string" ? bundleId : null;
    this.names = (Array.isArray(names) ? names : []).filter((n) => typeof n === "string");
  }
}

/**
 * The Fix-it card the refusal raises. Constants live here so the boot detector (PR3) and
 * this save path collapse into ONE card: same source, same dedupe key.
 */
export const ADDON_KEY_CARD_SOURCE = "addon-keys";
export const ADDON_KEY_CARD_KEY = "addon-keys-unreadable";
export const ADDON_KEY_CARD_TITLE = "Saved add-on keys cannot be read";

/**
 * Raise (or bump) the one add-on-keys card. Best-effort by design: a card that cannot be
 * written must never turn a refusal into a different failure. The context carries the
 * add-on id and env NAMES only — never a value.
 */
export async function raiseAddonKeysUnreadableCard(db, { bundleId = null, names = [] } = {}) {
  return upsertFixItItem(db, {
    source: ADDON_KEY_CARD_SOURCE,
    dedupKey: ADDON_KEY_CARD_KEY,
    title: ADDON_KEY_CARD_TITLE,
    why: KEY_SAVE_REFUSED,
    severity: "warn",
    remedies: [],
    context: { bundle_id: bundleId, names: (Array.isArray(names) ? names : []).filter((n) => typeof n === "string") },
  });
}

// ─── the per-add-on lock (0.6.1) ─────────────────────────────────────────────

/** For each add-on id: the tail promise of its queue (settles when the last holder is done). */
const lockTails = new Map();
/** The ids the CURRENT async context holds (re-entrancy, and isAddonLockHeld). */
const heldIds = new AsyncLocalStorage();

/**
 * Run `fn` with the lock of `bundleId` held — the WHOLE write section of a sealing writer
 * (keychain save, MCP entry write, `.env` write, install record). Calls for one id run
 * strictly in order; calls for different ids overlap.
 *
 * Re-entrant: a nested call for an id this async context already holds runs inline (no
 * deadlock), because the install path holds the lock and calls the first-admin seam, which
 * takes the same one. A throw releases the lock — the holder's `finally` closes its gate
 * and the next caller proceeds.
 *
 * AWAIT EVERYTHING INSIDE `fn`. Async work STARTED inside the lock and still running after
 * `fn` returned keeps this async context's store, so it still sees isAddonLockHeld(id) ===
 * true — and the next caller has already been let in. A fire-and-forget task (a bare
 * `void someWrite()` instead of `await someWrite()`) therefore writes believing it is
 * serialized while another save of the same add-on runs beside it: the lost update the lock
 * exists to prevent, with the guard silent. `fn`'s promise must settle only when its last
 * write does.
 */
export async function withAddonLock(bundleId, fn) {
  if (typeof bundleId !== "string" || bundleId === "") throw new TypeError("withAddonLock: a bundle id is required");
  if (typeof fn !== "function") throw new TypeError("withAddonLock: a function is required");
  const current = heldIds.getStore();
  if (current && current.has(bundleId)) return fn(); // re-entrant: this context already owns it
  const prev = lockTails.get(bundleId) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = prev.then(() => gate);
  lockTails.set(bundleId, tail);
  await prev; // the previous holder's gate; a tail never rejects (release, not a value)
  const next = new Set(current || []);
  next.add(bundleId);
  try {
    return await heldIds.run(next, fn);
  } finally {
    release();
    if (lockTails.get(bundleId) === tail) lockTails.delete(bundleId); // idle: forget the id
  }
}

/**
 * Is `bundleId`'s lock held by the caller's own async context? True only INSIDE the `fn`
 * passed to withAddonLock (the AsyncLocalStorage propagates across its awaits). A writer
 * that must not run un-locked (applyEnvToMcpAddons, 0.6.1) asserts this.
 *
 * It answers for the CONTEXT, not for the lock: an async task started inside `fn` and still
 * running after `fn` returned (or after `withAddonLock` resolved) still sees TRUE, even
 * though the next caller is already inside. See the note on withAddonLock: await every
 * write inside the lock instead of trusting this to mean "no one else is writing".
 */
export function isAddonLockHeld(bundleId) {
  const current = heldIds.getStore();
  return !!(current && current.has(bundleId));
}

// ─── sealing one entry (task 1.4) ───────────────────────────────────────────

/** The dependency seams this path needs; every one defaults to the real thing. */
function resolveDeps(deps = {}) {
  const d = deps || {};
  return {
    // `db` is a handle the CALLER owns and this function never closes; `openDb` is a
    // factory whose handle this function opens and closes.
    db: d.db || null,
    openDb: d.openDb || null,
    audit: d.audit || auditLog,
    paths: d.paths || gatewayKeychainPaths,
    crowHome: d.crowHome || resolveCrowHome,
    raiseCard: d.raiseCard || null, // null → raiseAddonKeysUnreadableCard
    onNewKey: d.onNewKey || null, // null → audit `keychain_key_created` here
  };
}

/** The manifest's `env_vars` by name, for the label, the origin and the store_as skip. */
function specMap(manifest) {
  const specs = new Map();
  for (const v of (manifest && Array.isArray(manifest.env_vars) ? manifest.env_vars : [])) {
    if (v && typeof v.name === "string" && !specs.has(v.name)) specs.set(v.name, v);
  }
  return specs;
}

/** "generated" for a value the manifest produces, else what the caller said (default typed). */
function originFor(name, origins, specs) {
  const given = origins && typeof origins === "object" ? origins[name] : null;
  if (given === "typed" || given === "generated") return given;
  const spec = specs.get(name);
  return spec && spec.generate ? "generated" : "typed";
}

/**
 * The key to save with. Missing key file + rows → REFUSE (never mint; a new key would
 * orphan every saved row) and raise the one card. A damaged key file with rows is
 * KeychainKeyInvalidError from ensureWriteKey (the rows may still be recoverable by
 * restoring the file). Only an EMPTY keychain mints, which is a first save, not a boot.
 */
async function writeKeyFor(db, d, { bundleId, names }) {
  const crowHome = d.crowHome();
  const state = keychainKeyState({ crowHome });
  let audited = false;
  if (state.state === "ok") return state.key;
  if (state.state === "missing" && (await countEntries(db)) > 0) {
    try {
      const raise = d.raiseCard || ((handle, info) => raiseAddonKeysUnreadableCard(handle, info));
      await raise(db, { bundleId, names });
    } catch (err) {
      console.warn(`add-on ${bundleId}: the keychain key card could not be raised (${err?.code || err?.name || "error"})`);
    }
    throw new AddonKeysSaveRefusedError(bundleId, names);
  }
  const onNewKey = d.onNewKey || (async ({ orphaned = 0 } = {}) => {
    audited = true;
    await d.audit(db, "keychain_key_created", { details: { orphaned } });
  });
  const key = await ensureWriteKey(db, { crowHome, onNewKey });
  // ensureWriteKey calls onNewKey only when rows already exist — and a missing key file with
  // rows refuses above — so a mint here is the FIRST save of an empty keychain: no orphans to
  // report, and so no "key that is no longer on this machine" notification.
  if (!audited && !d.onNewKey) await d.audit(db, "keychain_key_created", { details: { orphaned: 0 } });
  return key;
}

/**
 * The key a WRITER outside this module must save with (today: the API-key card's save).
 * It is the seal's own rule, exported so there is exactly one place that decides it: a
 * missing key file while `crow_keychain` holds rows REFUSES (raise the one card, never
 * mint — a new key would orphan every saved row), a damaged key file with rows is
 * KeychainKeyInvalidError from ensureWriteKey, and only an EMPTY table mints (and audits).
 * Calling ensureWriteKey bare instead would mint silently over rows it orphans.
 *
 * @param {object} db  a DB handle the CALLER owns (never closed here)
 * @returns {Promise<{id:string, seed:Buffer}>}
 */
export async function keyForSave(db, { bundleId, names = [], crowHome = null, deps = {} } = {}) {
  const d = resolveDeps({
    ...(deps || {}),
    ...(crowHome ? { crowHome: typeof crowHome === "function" ? crowHome : () => crowHome } : {}),
  });
  return writeKeyFor(db, d, { bundleId, names });
}

/**
 * Seal one save's secrets and return the entry to write.
 *
 * Sealing OFF (0.3 row 4, PR1's only behaviour): a listed name that was just written a
 * plain value is REMOVED from `keychainEnv` so the new plain value is the one used; the
 * keychain row is kept (the owner's key, in Settings). Nothing is opened.
 *
 * Sealing ON: every sealable value of this save becomes a keychain row (overwriting the
 * previous one — the new typed value wins), the entry loses those plain values, and
 * `keychainEnv` becomes the sorted union of the names it listed and the names just sealed.
 * The read-back proof runs through the spawn's own paths; any mismatch throws and the
 * INPUT ENTRY is left untouched (the caller decides what to do with the rows already
 * written — 1.5a's accepted `.env`-write outcome).
 *
 * @param {object} args
 * @param {string} args.bundleId - the mcp-addons entry id
 * @param {object} args.entry - the entry as the caller is about to write it
 * @param {object} [args.manifest] - the bundle manifest (label, `generate`, `store_as`, defaults)
 * @param {Record<string,"typed"|"generated">} [args.origins] - per-name origin from the caller
 * @param {object} [args.deps] - test/caller seams (see resolveDeps)
 * @returns {Promise<object>} the entry to write (the same object when nothing changed)
 */
export async function sealEntrySecrets({ bundleId, entry, manifest = null, origins = {}, deps = {} } = {}) {
  if (typeof bundleId !== "string" || bundleId === "") throw new TypeError("sealEntrySecrets: a bundle id is required");
  if (!entry || typeof entry !== "object") throw new TypeError("sealEntrySecrets: an entry is required");
  const d = resolveDeps(deps);
  const listed = keychainEnvNames(entry);

  // 2. Sealing off: drop the listed names this save wrote a plain value for. Nothing else.
  if (!addonSecretsSealingOn()) {
    const plain = entry.env && typeof entry.env === "object" ? entry.env : {};
    const drop = new Set(listed.filter((name) => typeof plain[name] === "string" && plain[name] !== ""));
    if (drop.size === 0) return entry;
    const kept = listed.filter((name) => !drop.has(name)).sort();
    const out = { ...entry };
    if (kept.length > 0) out[ADDON_KEYCHAIN_FIELD] = kept;
    else delete out[ADDON_KEYCHAIN_FIELD];
    console.log(`add-on ${bundleId}: keychain sealing is off, so ${[...drop].sort().join(", ")} stay(s) plain in mcp-addons.json`);
    return out;
  }

  // 3. What this save may seal (0.2). Nothing → the entry is already as it should be.
  const { seal } = sealableEnv(entry.env || {}, manifest, { listed });
  const names = Object.keys(seal).sort();
  if (names.length === 0) return entry;

  const specs = specMap(manifest);
  const label = (manifest && typeof manifest.name === "string" && manifest.name) || bundleId;
  let db = d.db;
  let ownDb = false;
  try {
    // 4. One DB file for seal, proof and spawn (0.7); durable before the file changes.
    if (!db) {
      db = d.openDb ? await d.openDb() : createDbClient();
      ownDb = true;
    }
    await db.execute("PRAGMA synchronous = FULL");

    // 5. The key (refuses rather than mints when rows already depend on a missing key).
    const key = await writeKeyFor(db, d, { bundleId, names });

    // 6. One row per name, then audit (names and ids only).
    for (const name of names) {
      const origin = originFor(name, origins, specs);
      const row = await saveExtensionSecret(db, key, {
        bundleId,
        envKey: name,
        label: `${label} - ${name}`,
        secret: seal[name],
        origin,
        firstView: false,
      });
      await d.audit(db, "keychain_save", {
        details: { entry_id: row.id, bundle_id: bundleId, env_key: name, origin, sealed_from: "mcp-addons" },
      });
    }

    // 7. Read-back proof through the exact paths the spawn uses, on a fresh read-only handle.
    // A caller that cannot name both paths proves nothing, so it fails closed.
    const paths = d.paths() || {};
    if (typeof paths.dbPath !== "string" || paths.dbPath === "" || typeof paths.keyPath !== "string" || paths.keyPath === "") {
      throw new AddonKeysUnavailableError("ROWS_MISSING", bundleId, names);
    }
    let readBack;
    try {
      readBack = readAddonSecretsSync(bundleId, names, { unsealer: "gateway", dbPath: paths.dbPath, keyPath: paths.keyPath });
    } catch {
      throw new AddonKeysUnavailableError("ROWS_MISSING", bundleId, names);
    }
    const onDisk = loadKeychainKey({ path: paths.keyPath });
    if (!onDisk || onDisk.id !== key.id) throw new AddonKeysUnavailableError("ROWS_MISSING", bundleId, names);
    for (const name of names) {
      if (readBack[name] !== seal[name]) throw new AddonKeysUnavailableError("ROWS_MISSING", bundleId, names);
    }

    // 8. The entry to write: no plain value for a sealed name, the sorted list beside `env`.
    const env = { ...(entry.env && typeof entry.env === "object" ? entry.env : {}) };
    for (const name of names) delete env[name];
    const out = { ...entry };
    if (Object.keys(env).length > 0) out.env = env;
    else delete out.env;
    out[ADDON_KEYCHAIN_FIELD] = [...new Set([...listed, ...names])].sort();
    return out;
  } finally {
    if (ownDb && db) { try { await db.close?.(); } catch { /* already closed */ } }
  }
}
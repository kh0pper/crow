/**
 * The environment a walled add-on starts with, built by the wall itself.
 *
 * Defence in depth on top of the callers' own env hygiene: whatever env a spawn
 * site holds, the wall never spreads it. It uses Phase 0's own rules
 * (servers/gateway/addon-env.js), so there is one source of truth:
 *   1. `addonBaseEnv`: the allowlisted base every add-on child gets;
 *   2. for a bundle add-on only: `declaredPassthrough` (keys its entry in the
 *      tracked registry declares, never a deny-listed gateway secret, never for
 *      a community or unpublished bundle) and `storagePassthrough` (the four
 *      storage-reading bundles' storage env);
 *   3. the add-on's own env (its mcp-addons.json `env` and derived keys, a
 *      service connection's values, a built-in's own vars), which wins.
 * A project-service child never takes a declared key from the gateway env (its
 * credentials are its connection's, never the gateway's token for that service);
 * a built-in's own vars already are its ownEnv.
 *
 * Before any of that, every key the gateway applied from systemd credentials
 * (`credentialKeyNames()`) and `CREDENTIALS_DIRECTORY` are removed from the
 * gateway env the wall reads, and `CREDENTIALS_DIRECTORY` never reaches the child
 * whatever its source.
 */
import { addonBaseEnv, declaredPassthrough, isStorageEnvConsumer, storagePassthrough } from "../../servers/gateway/addon-env.js";
import { credentialKeyNames } from "../../servers/shared/credentials-env.js";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Build the child env.
 * @param {object} o
 * @param {string} o.id                the add-on id
 * @param {"addon"|"service"|"builtin"} [o.kind="addon"]
 * @param {object} [o.baseEnv]         the gateway's env: only read through Phase 0's rules
 * @param {object} [o.ownEnv]          the add-on's own env, used as given
 * @param {string[]} [o.credentialKeys] test seam; default: the names applied from credentials
 * @param {Function} [o.registryFor]   test seam for addon-env.js's registry lookup
 * @returns {object}
 */
export function wallChildEnv({ id, kind = "addon", baseEnv = {}, ownEnv = {}, credentialKeys = credentialKeyNames(), registryFor } = {}) {
  const base = { ...(baseEnv && typeof baseEnv === "object" ? baseEnv : {}) };
  for (const k of Array.isArray(credentialKeys) ? credentialKeys : []) delete base[k];
  delete base.CREDENTIALS_DIRECTORY;
  const own = ownEnv && typeof ownEnv === "object" ? ownEnv : {};
  const opts = typeof registryFor === "function" ? { registryFor } : {};

  const env = { ...addonBaseEnv(base) };
  if (kind === "addon") {
    // storagePassthrough hands the four storage-reading bundles the gateway's
    // ROOT object-storage credentials. Accepted residual LEDGER N1b-13 (Phase 0
    // behaviour; per-bundle scoped credentials come with the Phase 2 door): the
    // wall marks such an add-on with the `storage` residual (wallResiduals) so
    // no status line can call it fully walled.
    Object.assign(env, declaredPassthrough(id, base, opts), storagePassthrough(id, base, opts));
  }
  for (const [k, v] of Object.entries(own)) {
    if (ENV_NAME_RE.test(k) && typeof v === "string") env[k] = v;
  }
  delete env.CREDENTIALS_DIRECTORY;
  return env;
}

/** The residual a storage consumer carries (LEDGER N1b-13): its exact status words live with Task 7. */
export const STORAGE_RESIDUAL = Object.freeze({ kind: "storage", label: "can use all of Crow's storage" });

/**
 * What a walled spawn still reaches beyond its wall, as plain data for status
 * surfaces. Today one entry: a bundle add-on in Phase 0's STORAGE_ENV_CONSUMERS
 * holds the root object-storage credentials (LEDGER N1b-13).
 */
export function wallResiduals({ id, kind = "addon" } = {}) {
  return kind === "addon" && isStorageEnvConsumer(id) ? [{ ...STORAGE_RESIDUAL }] : [];
}

/**
 * The `firstAdmin.invite` handlers Crow ships, as CODE (security audit N3-4
 * phase 2e). A manifest may only NAME one of these
 * (`"firstAdmin": { "mode": "finish-setup", "invite": "vaultwarden" }`): the name
 * selects a handler from this list, and nothing else about the manifest decides
 * what runs. Unknown names are refused by the bundle contract
 * (scripts/lib/bundle-contract.mjs) and ignored at runtime.
 *
 * Why an invite handler exists at all: Vaultwarden can never be given a usable
 * account from the outside (its vault keys are made in the browser), and its
 * admin token's plaintext lives only in Crow's keychain. So Crow asks the app's
 * own admin API to INVITE the owner's email and closes sign-ups to everyone
 * else. That is a gateway job with a secret in hand, not a `via: "setup"` script.
 *
 * PURE DATA — no fs, no db, no fetch — so the dashboard's shared first-admin
 * module and the bundle contract can both import it without pulling in the
 * gateway.
 */
export const INVITE_HANDLERS = Object.freeze({
  vaultwarden: Object.freeze({
    /**
     * Env keys holding the APP's admin-PANEL token. They are never the operator's
     * own login, so a keychain entry saved under one must not hide the "create
     * your account" card (firstAdminSavedKey returns null for them).
     */
    adminTokenEnvKeys: Object.freeze(["VAULTWARDEN_ADMIN_TOKEN"]),
  }),
});

/** Every handler name, in the order they are declared above. */
export const INVITE_HANDLER_NAMES = Object.freeze(Object.keys(INVITE_HANDLERS));

/** Is this a handler Crow really ships? Own-property lookup only. */
export function isInviteHandlerName(name) {
  return typeof name === "string" && Object.hasOwn(INVITE_HANDLERS, name);
}

const ADMIN_TOKEN_ENV_KEYS = new Set(INVITE_HANDLER_NAMES.flatMap((n) => INVITE_HANDLERS[n].adminTokenEnvKeys || []));

/** True when `envKey` is an admin-panel token of any handler (never an operator's login). */
export function isAdminPanelTokenEnvKey(envKey) {
  return typeof envKey === "string" && ADMIN_TOKEN_ENV_KEYS.has(envKey);
}
/**
 * Vaultwarden, invite-only from the moment it is installed (security audit N3-4
 * phase 2e).
 *
 * Why this cannot be a `via: "setup"` script: Crow can never create a usable
 * Vaultwarden account (its vault keys are made in the browser), and the admin
 * token's PLAINTEXT lives only in Crow's keychain while the bundle's `.env` holds
 * an Argon2id hash. So the work runs here, in the gateway, with a code-held
 * handler behind the manifest's `firstAdmin.invite` name:
 *
 *   1. log in once to Vaultwarden's own admin panel (`POST /admin` with the
 *      plaintext token; the cookie is reused for every call of the operation);
 *   2. `POST /admin/invite { email }` — invites the owner's address (works with no
 *      mail server: they create the account in the web UI);
 *   3. `POST /admin/config { signups_allowed: false }` — closes sign-ups to
 *      everyone else, then RE-READS `/admin` to confirm it (a 200 alone proves
 *      nothing: Vaultwarden answers 200 for an unknown key too).
 *
 * Crow only ever talks to `http://127.0.0.1:<port>`. A `.env` whose
 * `VAULTWARDEN_URL` points anywhere else is refused outright ("Crow only talks
 * to a Vaultwarden on this machine"): the admin panel must never be driven over
 * a network.
 *
 * Never logged, never returned: the admin token, the session cookie, or anything
 * Vaultwarden said beyond a fixed status word. Every seam (fetch, keychain
 * reader, clock, sleep) is injectable, so tests need no container and no
 * keychain.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLES_DIR } from "../bundles-config.js";
import { parseEnvText } from "../bundle-env-codec.js";
import { firstAdminOf } from "../dashboard/shared/first-admin.js";
import { isInviteHandlerName } from "./registry.js";

export const VAULTWARDEN_BUNDLE_ID = "vaultwarden";
/** The keychain entry holding the /admin token's plaintext (env_vars name). */
export const ADMIN_TOKEN_ENV_KEY = "VAULTWARDEN_ADMIN_TOKEN";
/** The env var the operator fills in at install with the email they will use. */
export const OWNER_EMAIL_ENV_KEY = "VAULTWARDEN_OWNER_EMAIL";
const DEFAULT_URL = "http://localhost:8097";
/** Refusal for a Vaultwarden that is not on this machine. */
export const NOT_LOCAL = "Crow only talks to a Vaultwarden on this machine";
/** How long one Extensions render trusts a cached read (one admin login each time it expires). */
export const STATE_TTL_MS = 60_000;
/** One HTTP call's budget: a wedged container must never hang a page render. */
const REQUEST_TIMEOUT_MS = 5000;

const defaultFetch = (url, init) => globalThis.fetch(url, init);
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function requestSignal() {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined;
}

/** The installed bundle's `.env` as an object (empty when absent or unreadable). */
export function installedVaultwardenEnv(installDir) {
  if (typeof installDir !== "string" || !installDir) return {};
  const path = join(installDir, ".env");
  if (!existsSync(path)) return {};
  try {
    return parseEnvText(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

const isLoopbackHost = (host) => host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

/**
 * The base URL the handler may talk to, or null when the configured one is not a
 * loopback URL. The port comes from the URL; the host is ALWAYS 127.0.0.1, so a
 * `localhost` that resolves elsewhere, a tailnet name or a container name can
 * never receive this traffic.
 *
 * @param {string|null|undefined} rawUrl the installed `.env`'s VAULTWARDEN_URL
 * @returns {string|null}
 */
export function loopbackBaseUrl(rawUrl) {
  const raw = typeof rawUrl === "string" && rawUrl.trim() ? rawUrl.trim() : DEFAULT_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase();
  if (!isLoopbackHost(host)) return null;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.protocol}//127.0.0.1:${port}`;
}

/** The base URL for an installed bundle dir (refused unless loopback). */
function baseUrlFor(installDir) {
  return loopbackBaseUrl(installedVaultwardenEnv(installDir).VAULTWARDEN_URL);
}

/** Where this instance's Vaultwarden lives on disk. */
export function vaultwardenInstallDir(crowBundlesDir = BUNDLES_DIR) {
  return join(crowBundlesDir, VAULTWARDEN_BUNDLE_ID);
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A simple email shape (the manifest's `pattern` does the same check at install). */
export function isEmailShaped(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 320 && EMAIL_SHAPE.test(trimmed);
}

/**
 * Sign-ups state from Vaultwarden's admin page HTML: `"on" | "off" | "unknown"`.
 * Matches the input whose id is EXACTLY `input_signups_allowed` — the page also
 * carries `input_sso_signups_allowed`, which is always checked and must not be
 * mistaken for this one.
 */
export function parseSignupsAllowed(html) {
  const match = String(html || "").match(/<input\b[^>]*\bid="input_signups_allowed"[^>]*>/iu);
  if (!match) return "unknown";
  return /\bchecked\b/iu.test(match[0]) ? "on" : "off";
}

/** The `VW_ADMIN` pair from a login response's Set-Cookie header(s), or null. */
function adminCookie(res) {
  const headers = res && res.headers;
  if (!headers) return null;
  let list = [];
  if (typeof headers.getSetCookie === "function") {
    list = headers.getSetCookie() || [];
  } else if (typeof headers.get === "function") {
    const single = headers.get("set-cookie");
    if (single) list = [single];
  }
  for (const raw of list) {
    const pair = String(raw).split(";")[0].trim();
    if (pair.startsWith("VW_ADMIN=")) return pair;
  }
  return null;
}

/**
 * The keychain reader for the plaintext /admin token: the same extension entry the
 * install path saved (`bundle_id: vaultwarden`, `env_key: VAULTWARDEN_ADMIN_TOKEN`),
 * opened with the keychain key. Missing, sealed under another key, or unreadable →
 * null (the card then says to add it in Settings → Passwords). Never throws.
 *
 * @param {{db?: object|null}} [o] an existing db client (the Extensions page passes
 *   its own); without one a client is opened and closed here.
 */
export function keychainAdminTokenReader({ db = null } = {}) {
  return async () => {
    const { listEntries, openEntrySecret } = await import("../keychain/store.js");
    const { loadKeychainKey } = await import("../keychain/key.js");
    let client = db;
    try {
      const key = loadKeychainKey();
      if (!key) return null;
      if (!client) {
        const { createDbClient } = await import("../../db.js");
        client = createDbClient();
      }
      for (const entry of await listEntries(client, { keyId: key.id })) {
        if (entry.kind !== "extension" || entry.bundle_id !== VAULTWARDEN_BUNDLE_ID || entry.env_key !== ADMIN_TOKEN_ENV_KEY) continue;
        if (!entry.readable) return null;
        const plain = await openEntrySecret(client, key, entry.id);
        return typeof plain === "string" && plain !== "" ? plain : null;
      }
      return null;
    } catch {
      return null;
    } finally {
      if (!db) {
        try { client?.close?.(); } catch { /* already closed */ }
      }
    }
  };
}

/** One admin login, reused for the rest of the operation. */
async function openAdminSession({ base, token, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(`${base}/admin`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      redirect: "manual",
      signal: requestSignal(),
    });
  } catch {
    return { error: "unreachable" };
  }
  if (!res) return { error: "unreachable" };
  // A wrong token is a 401 with no cookie: the saved token has to be re-added.
  if (res.status === 401) return { error: "no-token" };
  if (res.status !== 200) return { error: "failed" };
  const cookie = adminCookie(res);
  return cookie ? { cookie } : { error: "failed" };
}

/** `GET /admin/users` → the accounts, and whether the read really worked. */
async function readUsers({ base, cookie, fetchImpl }) {
  try {
    const res = await fetchImpl(`${base}/admin/users`, { headers: { cookie }, redirect: "manual", signal: requestSignal() });
    if (!res || res.status !== 200) return { ok: false, users: [] };
    const body = await res.json();
    if (!Array.isArray(body)) return { ok: false, users: [] };
    const users = body
      .map((u) => ({
        email: u && typeof u.email === "string" ? u.email : "",
        // _status 0 = the address finished registering; 1 = invited, no vault key yet.
        registered: Number(u && u._status) === 0,
      }))
      .filter((u) => u.email !== "");
    return { ok: true, users };
  } catch {
    return { ok: false, users: [] };
  }
}

/** `GET /admin` → the current sign-ups state. */
async function readSignups({ base, cookie, fetchImpl }) {
  try {
    const res = await fetchImpl(`${base}/admin`, { headers: { cookie }, redirect: "manual", signal: requestSignal() });
    if (!res || res.status !== 200) return "unknown";
    return parseSignupsAllowed(await res.text());
  } catch {
    return "unknown";
  }
}

/** `POST /admin/config { signups_allowed: false }` → did the app answer 200? */
async function postCloseSignups({ base, cookie, fetchImpl }) {
  try {
    const res = await fetchImpl(`${base}/admin/config`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ signups_allowed: false }),
      redirect: "manual",
      signal: requestSignal(),
    });
    return !!res && res.status === 200;
  } catch {
    return false;
  }
}

/** A 500 whose body says the address is not an email (Vaultwarden's own wording). */
async function isEmailRefusal(res) {
  try {
    const text = await res.text();
    return /not a valid email address/iu.test(String(text || ""));
  } catch {
    return false;
  }
}

/** Resolve the injectable seams of one operation. */
function operationDeps({ fetch: fetchImpl, readAdminToken = null, db = null } = {}) {
  return {
    fetchImpl: typeof fetchImpl === "function" ? fetchImpl : defaultFetch,
    readToken: typeof readAdminToken === "function" ? readAdminToken : keychainAdminTokenReader({ db }),
  };
}

/**
 * Who has an account in this Vaultwarden, and are sign-ups open?
 *
 * ONE admin login per call. Never throws.
 *
 * @param {{installDir?: string, fetch?: Function, readAdminToken?: Function, db?: object|null}} [o]
 * @returns {Promise<{signups: "on"|"off"|"unknown", users: Array<{email: string, registered: boolean}>, reachable: boolean, reason: string|null}>}
 *   `reason` is null when the account list was really read; otherwise one of
 *   "not-local" (the configured URL is not on this machine), "no-token" (nothing
 *   saved, or Vaultwarden refused it), "unreachable" or "unknown".
 */
export async function vaultwardenState({ installDir = vaultwardenInstallDir(), fetch: fetchImpl, readAdminToken = null, db = null } = {}) {
  const failed = (reason, reachable = false) => ({ signups: "unknown", users: [], reachable, reason });
  const base = baseUrlFor(installDir);
  if (!base) return failed("not-local");
  const { fetchImpl: doFetch, readToken } = operationDeps({ fetch: fetchImpl, readAdminToken, db });
  let token = null;
  try { token = await readToken(); } catch { token = null; }
  if (!token) return failed("no-token");
  const session = await openAdminSession({ base, token, fetchImpl: doFetch });
  if (session.error === "unreachable") return failed("unreachable");
  if (session.error) return failed(session.error === "no-token" ? "no-token" : "unknown", true);
  const users = await readUsers({ base, cookie: session.cookie, fetchImpl: doFetch });
  const signups = await readSignups({ base, cookie: session.cookie, fetchImpl: doFetch });
  return { signups, users: users.users, reachable: true, reason: users.ok ? null : "unknown" };
}

// ── The state cache (one admin login per minute, not per Extensions render) ──
const STATE_CACHE = new Map();

/** Forget a cached state (an invite / close just changed it). */
export function clearInviteStateCache(bundleId = null) {
  if (typeof bundleId === "string" && bundleId) STATE_CACHE.delete(bundleId);
  else STATE_CACHE.clear();
}

/**
 * vaultwardenState with a short in-memory cache, keyed by bundle id. Best-effort:
 * a render never waits more than once per TTL, and the failure is cached too
 * (a stopped container must not stall every page load).
 */
export async function cachedInviteState({
  bundleId = VAULTWARDEN_BUNDLE_ID,
  installDir = null,
  ttlMs = STATE_TTL_MS,
  now = Date.now,
  ...deps
} = {}) {
  const key = String(bundleId || VAULTWARDEN_BUNDLE_ID);
  const hit = STATE_CACHE.get(key);
  const at = now();
  if (hit && at - hit.at >= 0 && at - hit.at < ttlMs) return hit.state;
  const state = await vaultwardenState({ installDir: installDir || vaultwardenInstallDir(), ...deps });
  STATE_CACHE.set(key, { at, state });
  return state;
}

/**
 * Invite `email` to this Vaultwarden, then close sign-ups if they are on (SAME
 * cookie, then re-read to confirm). One login for the whole operation.
 *
 * @param {{email?: string, installDir?: string, fetch?: Function, readAdminToken?: Function, db?: object|null}} [o]
 * @returns {Promise<{result: "invited"|"already"|"invalid-email"|"unreachable"|"no-token"|"failed", signups: "on"|"off"|"unknown"|null}>}
 */
export async function inviteOwnerResult({ email, installDir = vaultwardenInstallDir(), fetch: fetchImpl, readAdminToken = null, db = null } = {}) {
  const address = typeof email === "string" ? email.trim() : "";
  if (!isEmailShaped(address)) return { result: "invalid-email", signups: null };
  const base = baseUrlFor(installDir);
  if (!base) return { result: "failed", signups: null };
  const { fetchImpl: doFetch, readToken } = operationDeps({ fetch: fetchImpl, readAdminToken, db });
  let token = null;
  try { token = await readToken(); } catch { token = null; }
  if (!token) return { result: "no-token", signups: null };
  const session = await openAdminSession({ base, token, fetchImpl: doFetch });
  if (session.error === "unreachable") return { result: "unreachable", signups: null };
  if (session.error === "no-token") return { result: "no-token", signups: null };
  if (session.error) return { result: "failed", signups: null };

  let invited;
  try {
    const res = await doFetch(`${base}/admin/invite`, {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: address }),
      redirect: "manual",
      signal: requestSignal(),
    });
    if (!res) invited = "failed";
    else if (res.status === 200) invited = "invited";
    else if (res.status === 409) invited = "already"; // duplicate, or already registered
    else if (res.status === 500) invited = (await isEmailRefusal(res)) ? "invalid-email" : "failed";
    else invited = "failed";
  } catch {
    invited = "unreachable";
  }
  if (invited !== "invited" && invited !== "already") return { result: invited, signups: null };

  // Close sign-ups now, with the cookie that just worked, and confirm by re-reading.
  let signups = await readSignups({ base, cookie: session.cookie, fetchImpl: doFetch });
  if (signups === "on") {
    await postCloseSignups({ base, cookie: session.cookie, fetchImpl: doFetch });
    signups = await readSignups({ base, cookie: session.cookie, fetchImpl: doFetch });
  }
  return { result: invited, signups };
}

/** inviteOwnerResult's result word alone (the manifest-facing API). */
export async function inviteOwner(options = {}) {
  return (await inviteOwnerResult(options)).result;
}

/**
 * Close sign-ups to everyone. One login; the POST's 200 proves nothing on its own
 * (Vaultwarden answers 200 for an unknown key), so the state is re-read.
 *
 * @returns {Promise<"off"|"unknown"|"failed">} "failed" = no token / the app did not
 *   answer / the POST itself failed; "unknown" = 200 but the re-read is not "off".
 */
export async function closeSignups({ installDir = vaultwardenInstallDir(), fetch: fetchImpl, readAdminToken = null, db = null } = {}) {
  const base = baseUrlFor(installDir);
  if (!base) return "failed";
  const { fetchImpl: doFetch, readToken } = operationDeps({ fetch: fetchImpl, readAdminToken, db });
  let token = null;
  try { token = await readToken(); } catch { token = null; }
  if (!token) return "failed";
  const session = await openAdminSession({ base, token, fetchImpl: doFetch });
  if (session.error) return "failed";
  if (!(await postCloseSignups({ base, cookie: session.cookie, fetchImpl: doFetch }))) return "failed";
  return (await readSignups({ base, cookie: session.cookie, fetchImpl: doFetch })) === "off" ? "off" : "unknown";
}

/**
 * Poll the container's `/alive` until it answers 200 (or the deadline passes).
 * A loopback URL only; a non-loopback one is `false` without a request.
 */
export async function waitForVaultwarden({
  installDir = vaultwardenInstallDir(),
  timeoutMs = 60_000,
  intervalMs = 1500,
  fetch: fetchImpl,
  now = Date.now,
  sleep = defaultSleep,
} = {}) {
  const base = baseUrlFor(installDir);
  if (!base) return false;
  const doFetch = typeof fetchImpl === "function" ? fetchImpl : defaultFetch;
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      const res = await doFetch(`${base}/alive`, { redirect: "manual", signal: requestSignal() });
      if (res && res.status === 200) return true;
    } catch { /* not up yet */ }
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await sleep(Math.min(intervalMs, remaining));
  }
}

// ── The code-held handler map ──
//
// The manifest names one entry of this map (`firstAdmin.invite`); nothing else in
// the manifest decides what runs. Frozen, so no caller can install a handler.
export const INVITE_HANDLERS = Object.freeze({
  vaultwarden: Object.freeze({
    bundleId: VAULTWARDEN_BUNDLE_ID,
    ownerEmailEnvKey: OWNER_EMAIL_ENV_KEY,
    state: cachedInviteState,
    inviteResult: inviteOwnerResult,
    invite: inviteOwner,
    closeSignups,
    waitForAlive: waitForVaultwarden,
  }),
});

/** The handler a manifest names, or null (unknown names are never resolved). */
export function inviteHandler(name) {
  return isInviteHandlerName(name) ? INVITE_HANDLERS[name] : null;
}

/** The handler THIS manifest declares (`firstAdmin.invite`), or null. */
export function inviteHandlerFor(manifest) {
  const fa = firstAdminOf(manifest);
  return fa && fa.invite ? inviteHandler(fa.invite) : null;
}

/**
 * id → state for every installed bundle whose manifest declares an invite
 * handler. Computed by the Extensions page (which stays pure) and cached ~60 s;
 * a handler that fails leaves its bundle without a state, which the card treats
 * as "unknown" plus the sentence why.
 */
export async function inviteStatesFor(installed = {}, manifests = {}, { db = null, ...deps } = {}) {
  const out = {};
  for (const id of Object.keys(installed || {})) {
    const handler = inviteHandlerFor(manifests ? manifests[id] : null);
    if (!handler) continue;
    try {
      out[id] = await handler.state({ installDir: join(BUNDLES_DIR, id), bundleId: id, db, ...deps });
    } catch {
      out[id] = { signups: "unknown", users: [], reachable: false, reason: "unknown" };
    }
  }
  return out;
}

/** The one plain install-log sentence a result is reported with (never a secret). */
export function inviteInstallSentence({ result, signups = null, email = "", name = "the app" } = {}) {
  const closed = signups === "off"
    ? " Sign-ups are closed to everyone else."
    : signups === null ? "" : " Crow could not confirm that sign-ups are closed — press Close sign-ups on the Extensions card.";
  if (result === "invited") return `Crow invited ${email}: open ${name} and create your account with that email.${closed}`;
  if (result === "already") return `${email} was already invited: open ${name} and create your account with that email.${closed}`;
  if (result === "invalid-email") return `Crow could not invite ${email}: that is not a valid email address. Fix ${OWNER_EMAIL_ENV_KEY} in Configure, then press "Invite my email" on the Extensions card.`;
  if (result === "unreachable") return `Crow could not invite ${email}: ${name} did not answer. Press "Invite my email" on the Extensions card once it is running.`;
  if (result === "no-token") return `Crow could not invite ${email}: no ${name} admin token is saved. Add it in Settings → Passwords, then press "Invite my email" on the Extensions card.`;
  return `Crow could not invite ${email}. Press "Invite my email" on the Extensions card.`;
}

/** Fixed sentences for the card's routes (never a raw error, never anything from Vaultwarden). */
export function inviteResultSentence(result, { email = "", name = "the app", signups = null } = {}) {
  if (result === "invited" || result === "already") return inviteInstallSentence({ result, signups, email, name });
  if (result === "invalid-email") return "That does not look like an email address.";
  if (result === "no-token") return `Crow has no ${name} admin token saved. Add it in Settings → Passwords and try again.`;
  if (result === "unreachable") return `Crow could not reach ${name}. Is it running?`;
  return "Crow could not invite that email. Try again.";
}

export function closeSignupsSentence(result, { name = "the app" } = {}) {
  if (result === "off") return `Sign-ups are closed. Only people you invite can create an ${name} account.`;
  if (result === "unknown") return "Crow asked to close sign-ups but could not confirm it. Reload this page to check.";
  return `Crow could not close sign-ups. Check that ${name} is running and that its admin token is in Settings → Passwords.`;
}

/**
 * The install path's step: when this bundle declares an invite handler and the
 * operator filled in the owner email, wait for the app to answer and invite it.
 * NEVER throws into the install, and logs exactly one plain sentence per result.
 * Returns null when this bundle has no invite handler or no email was given.
 */
export async function inviteFirstAdminOnInstall({
  bundleId,
  manifest,
  installDir = null,
  log = () => {},
  deps = {},
} = {}) {
  const handler = inviteHandlerFor(manifest);
  if (!handler) return null;
  const dir = typeof installDir === "string" && installDir ? installDir : vaultwardenInstallDir();
  try {
    const email = String(installedVaultwardenEnv(dir)[handler.ownerEmailEnvKey] || "").trim();
    if (!email) return null;
    const name = (manifest && typeof manifest.name === "string" && manifest.name) || bundleId || "the app";
    const d = { ...(deps || {}) };
    const up = await handler.waitForAlive({ installDir: dir, ...d });
    if (!up) {
      const result = "unreachable";
      log(inviteInstallSentence({ result, email, name }));
      return { result, signups: null };
    }
    const out = await handler.inviteResult({ email, installDir: dir, ...d });
    // The Extensions page may hold a read from before this install's invite.
    if (bundleId) clearInviteStateCache(bundleId);
    log(inviteInstallSentence({ result: out.result, signups: out.signups, email, name }));
    return out;
  } catch {
    // A failed invite never fails an install: the Extensions card repeats it.
    try { log("Crow could not invite the owner's email. Press \"Invite my email\" on the Extensions card."); } catch { /* console gone */ }
    return { result: "failed", signups: null };
  }
}
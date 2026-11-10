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
 *      plaintext token). The `VW_ADMIN` cookie is remembered for the life of this
 *      gateway process and reused until Vaultwarden rejects it (a 401 or a
 *      redirect to the login form), because it rate-limits `POST /admin`;
 *   2. `POST /admin/invite { email }` — invites the owner's address (works with no
 *      mail server: they create the account in the web UI);
 *   3. close sign-ups: `GET /admin`, take the WHOLE config form the way Vaultwarden's
 *      own admin_settings.js serializes it, set `signups_allowed = false` and POST
 *      it back. A PARTIAL config body REPLACES the stored config.json (SMTP and
 *      every other admin setting would be reset), so a form that does not parse
 *      into a full config is refused instead of posted. Then RE-READ `/admin` to
 *      confirm (a 200 alone proves nothing: Vaultwarden answers 200 for an unknown
 *      key too);
 *   4. keep the installed `.env` in step (`VAULTWARDEN_SIGNUPS_ALLOWED=false`), so
 *      a reinstall or a restarted compose stack starts closed too.
 *
 * The handler is BOUND to the bundle it belongs to (`INVITE_HANDLERS` entries carry
 * `bundleId`): `inviteHandlerFor(manifest, bundleId)` resolves one only when both
 * the manifest's `firstAdmin.invite` name AND the bundle id are Vaultwarden's. A
 * manifest of some other installed bundle can therefore never drive this code, and
 * the keychain admin-token reader is only ever called from it.
 *
 * Crow only ever talks to `http://127.0.0.1:<port>`, and the port comes from the
 * REVIEWED manifest's `webUI.port` (8097, the compose file's fixed
 * `127.0.0.1:8097:80`), never from the installed `.env`'s `VAULTWARDEN_URL`: that
 * file is editable through `POST /bundles/api/env`, so it must not decide where the
 * admin token is sent.
 *
 * Never logged, never returned: the admin token, the session cookie, or anything
 * Vaultwarden said beyond a fixed status word. Every seam (fetch, keychain reader,
 * clock, sleep) is injectable, so tests need no container and no keychain.
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
/** The env var kept in step with the app's own sign-ups setting. */
export const SIGNUPS_ENV_KEY = "VAULTWARDEN_SIGNUPS_ALLOWED";
/**
 * The admin panel's port when the reviewed manifest does not name a usable one. The
 * shipped manifest's `webUI.port` is 8097, the compose file binds 127.0.0.1:8097.
 */
export const ADMIN_PORT = 8097;
/** How long one Extensions render trusts a cached read (one admin login each time it expires). */
export const STATE_TTL_MS = 300_000;
/** Below this many parsed form fields the admin config is not the full form. */
export const MIN_ADMIN_CONFIG_KEYS = 40;
/** One HTTP call's budget: a wedged container must never hang a page render. */
const REQUEST_TIMEOUT_MS = 5000;

const defaultFetch = (url, init) => globalThis.fetch(url, init);
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function requestSignal() {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined;
}

/**
 * The installed bundle's `.env` as an object (empty when absent or unreadable).
 * Used for the operator's own address (the email to invite, and the one account a
 * card treats as expected) — NEVER for where Crow sends the admin token: that is
 * vaultwardenBaseUrl().
 */
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

/**
 * Where this instance's Vaultwarden admin panel is: ALWAYS plain http on 127.0.0.1.
 * The port is the reviewed manifest's `webUI.port` when it is a sane port number,
 * else ADMIN_PORT. Nothing from the installed `.env` reaches this: a `.env` can be
 * rewritten by a non-owner session (`POST /bundles/api/env`), so it must not choose
 * the destination of the admin token.
 *
 * @param {object|null} manifest the REVIEWED manifest (bundles-config getManifest)
 * @returns {string}
 */
export function vaultwardenBaseUrl(manifest = null) {
  const declared = Number(manifest && manifest.webUI && manifest.webUI.port);
  const port = Number.isInteger(declared) && declared > 0 && declared < 65536 ? declared : ADMIN_PORT;
  return `http://127.0.0.1:${port}`;
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

/** The class names Vaultwarden's own admin settings form uses, and nothing else. */
const CONF_CHECKBOX = "conf-checkbox";
const CONF_NUMBER = "conf-number";
const CONF_TEXT = ["conf-text", "conf-password"];

/**
 * The full admin config form as Vaultwarden's own admin_settings.js serializes it:
 *
 *   document.querySelectorAll(".conf-checkbox").forEach(e => data[e.name] = e.checked);
 *   document.querySelectorAll(".conf-number").forEach(e => data[e.name] = e.value ? +e.value : null);
 *   document.querySelectorAll(".conf-text, .conf-password").forEach(e => data[e.name] = e.value || null);
 *
 * An `<input>` without a `conf-*` class, or without a `name`, is skipped. Attribute
 * values are HTML-escaped in the page (`&#x3D;` inside the Argon2 hash of
 * `admin_token`), and the parser decodes them. Never throws: a page it cannot read
 * is an empty object, which adminConfigComplete() refuses.
 *
 * @param {string} html the `/admin` page
 * @returns {Promise<Record<string, boolean|number|string|null>>}
 */
export async function adminConfigFromPage(html) {
  const values = {};
  let document;
  try {
    const { parseHTML } = await import("linkedom");
    ({ document } = parseHTML(String(html || "")));
  } catch {
    return values;
  }
  for (const el of document.querySelectorAll("input")) {
    const name = el.getAttribute("name");
    if (!name) continue;
    const classes = new Set(String(el.getAttribute("class") || "").split(/\s+/).filter(Boolean));
    const raw = el.getAttribute("value");
    if (classes.has(CONF_CHECKBOX)) {
      values[name] = el.hasAttribute("checked");
    } else if (classes.has(CONF_NUMBER)) {
      const n = raw === null || raw === "" ? null : Number(raw);
      values[name] = n !== null && Number.isFinite(n) ? n : null;
    } else if (CONF_TEXT.some((c) => classes.has(c))) {
      values[name] = raw === null || raw === "" ? null : raw;
    }
  }
  return values;
}

/**
 * Does this parse look like the REAL full admin form? Vaultwarden replaces its whole
 * stored config.json with whatever a `POST /admin/config` body holds, so posting a
 * form that came back short (a different page, a login form, a partial render) would
 * wipe the operator's SMTP and every other admin setting. Both the sign-ups switch
 * and the admin token must be in it, and it must be big enough to be that form.
 */
export function adminConfigComplete(config) {
  if (!config || typeof config !== "object") return false;
  const keys = Object.keys(config);
  return keys.length >= MIN_ADMIN_CONFIG_KEYS
    && Object.hasOwn(config, "signups_allowed")
    && Object.hasOwn(config, "admin_token");
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

// ── The remembered admin cookie (Vaultwarden rate-limits POST /admin) ──
//
// Vaultwarden counts every `POST /admin` (3 per ~5 minutes by default), so a login
// per operation would lock the operator out after a couple of button presses. One
// cookie per base URL is kept for this gateway process and reused until the app
// says it is gone; only then is one more login made.
const ADMIN_COOKIES = new Map();

/** Forget every remembered admin cookie (a test seam; also used when a token changes). */
export function clearAdminSession() {
  ADMIN_COOKIES.clear();
}

/** A response that means the admin cookie is gone: 401, or a redirect to the login form. */
function isExpired(res) {
  if (!res) return false;
  if (res.status === 401) return true;
  return res.status >= 300 && res.status < 400;
}

/**
 * The keychain reader for the plaintext /admin token: the same extension entry the
 * install path saved (`bundle_id: vaultwarden`, `env_key: VAULTWARDEN_ADMIN_TOKEN`),
 * opened with the keychain key. Missing, sealed under another key, or unreadable →
 * null (the card then says to add it in Settings → Passwords). Never throws.
 *
 * Only the Vaultwarden handler ever calls it (see inviteHandlerFor: the handler is
 * bound to the bundle id).
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

/**
 * One admin login. `reachable` says whether the app answered at all (a refused token
 * and a rate limit are answers; a connection error is not).
 *
 * @returns {Promise<{cookie?: string, error?: string, reachable?: boolean}>}
 */
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
    return { error: "unreachable", reachable: false };
  }
  if (!res) return { error: "unreachable", reachable: false };
  // Vaultwarden limits admin logins: say so instead of hammering it.
  if (res.status === 429) return { error: "rate-limited", reachable: true };
  // A wrong token is a 401 with no cookie: the saved token has to be re-added.
  if (res.status === 401) return { error: "no-token", reachable: true };
  // The cookie is what proves the login, whether the app answers 200 + page or a
  // 303 to /admin.
  const cookie = adminCookie(res);
  return cookie ? { cookie } : { error: "failed", reachable: true };
}

/**
 * Run `run(cookie)` on the admin session: reuse the remembered cookie, log in when
 * there is none or when the app rejected it, and log in ONE more time after a
 * rejection. A 429 from the login is `{ error: "rate-limited" }`.
 */
async function withAdminSession({ base, fetchImpl, readToken, run }) {
  let cookie = ADMIN_COOKIES.get(base) || null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!cookie) {
      let token = null;
      try { token = await readToken(); } catch { token = null; }
      if (!token) return { error: "no-token", reachable: false };
      const session = await openAdminSession({ base, token, fetchImpl });
      if (session.error) return session;
      cookie = session.cookie;
    }
    const out = await run(cookie);
    if (!out || out.expired !== true) {
      ADMIN_COOKIES.set(base, cookie);
      return out || { error: "unknown", reachable: true };
    }
    // The cookie the app was given is gone: one more login, then run once more.
    ADMIN_COOKIES.delete(base);
    cookie = null;
  }
  return { error: "failed", reachable: true };
}

/** `GET <path>` on the admin session: `{ text }` on 200, `{ expired }` when the cookie is gone. */
async function adminGetText({ base, path, cookie, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(`${base}${path}`, { headers: { cookie }, redirect: "manual", signal: requestSignal() });
  } catch {
    return { error: "unreachable" };
  }
  if (!res) return { error: "unreachable" };
  if (isExpired(res)) return { expired: true };
  if (res.status !== 200) return { error: "unknown" };
  try {
    return { text: await res.text() };
  } catch {
    return { error: "unknown" };
  }
}

/**
 * `GET /admin/users` → the accounts. `_status`: 0 = registered (has a vault key),
 * 1 = invited (no account yet), 2 = disabled (present, but neither invited nor
 * registered: it must not be read as "someone was invited").
 */
async function readUsers({ base, cookie, fetchImpl }) {
  const got = await adminGetText({ base, path: "/admin/users", cookie, fetchImpl });
  if (got.expired || got.error) return got;
  try {
    const body = JSON.parse(got.text);
    if (!Array.isArray(body)) return { error: "unknown" };
    const users = [];
    for (const u of body) {
      const email = u && typeof u.email === "string" ? u.email : "";
      if (email === "") continue;
      const status = Number(u && u._status);
      users.push({ email, status, registered: status === 0, invited: status === 1, disabled: status === 2 });
    }
    return { users };
  } catch {
    return { error: "unknown" };
  }
}

/** `GET /admin` → the current sign-ups state. */
async function readSignups({ base, cookie, fetchImpl }) {
  const got = await adminGetText({ base, path: "/admin", cookie, fetchImpl });
  if (got.expired || got.error) return got;
  return { signups: parseSignupsAllowed(got.text) };
}

/**
 * Close sign-ups on an open session: read the FULL admin form, flip ONLY
 * `signups_allowed`, POST the whole object, then re-read to confirm.
 *
 * @returns {Promise<{signups: "on"|"off"|"unknown", posted?: boolean, expired?: boolean, error?: string}>}
 *   `posted` says whether a config body was sent at all (a form that does not parse
 *   into the full config is refused, never posted partially).
 */
async function closeSignupsOnSession({ base, cookie, fetchImpl }) {
  const page = await adminGetText({ base, path: "/admin", cookie, fetchImpl });
  if (page.expired || page.error) return page;
  const config = await adminConfigFromPage(page.text);
  if (!adminConfigComplete(config)) return { signups: "unknown", posted: false };
  config.signups_allowed = false;
  let res;
  try {
    res = await fetchImpl(`${base}/admin/config`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(config),
      redirect: "manual",
      signal: requestSignal(),
    });
  } catch {
    return { error: "unreachable" };
  }
  if (!res) return { error: "unreachable" };
  if (isExpired(res)) return { expired: true };
  if (res.status === 429) return { signups: "unknown", posted: false, error: "rate-limited" };
  if (res.status !== 200) return { signups: "unknown", posted: false };
  const after = await readSignups({ base, cookie, fetchImpl });
  if (after.expired) return { expired: true };
  if (after.error) return { signups: "unknown", posted: true };
  return { signups: after.signups, posted: true };
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

/** Keep the installed `.env` in step with the app: sign-ups are closed. */
async function rememberSignupsClosed(installDir) {
  if (typeof installDir !== "string" || installDir === "") return;
  try {
    const { writeBundleEnv } = await import("../bundle-first-admin-setup.js");
    writeBundleEnv(installDir, { [SIGNUPS_ENV_KEY]: "false" });
  } catch {
    // The card still shows the truth from the app itself.
  }
}

/** Resolve the injectable seams of one operation. */
function operationDeps({ fetch: fetchImpl, readAdminToken = null, db = null } = {}) {
  return {
    fetchImpl: typeof fetchImpl === "function" ? fetchImpl : defaultFetch,
    readToken: typeof readAdminToken === "function" ? readAdminToken : keychainAdminTokenReader({ db }),
  };
}

/** The registered addresses that are not the owner's own (capped, for the card). */
function otherRegistered(users, ownerEmail) {
  const owner = typeof ownerEmail === "string" ? ownerEmail.trim().toLowerCase() : "";
  return users
    .filter((u) => u && u.registered === true && typeof u.email === "string" && u.email !== "")
    .map((u) => u.email)
    // Without a configured owner email Crow cannot vouch for ANY account, so all of
    // them are worth naming. With one, the owner's own account is expected.
    .filter((email) => owner === "" || email.toLowerCase() !== owner)
    .slice(0, 5);
}

/**
 * Who has an account in this Vaultwarden, and are sign-ups open?
 *
 * At most one admin login (none at all when the remembered cookie still works).
 * Never throws.
 *
 * @param {{installDir?: string, manifest?: object|null, fetch?: Function, readAdminToken?: Function, db?: object|null}} [o]
 *   `manifest` is the REVIEWED manifest: it decides the port (see vaultwardenBaseUrl).
 * @returns {Promise<{signups: "on"|"off"|"unknown", users: Array<{email: string, status: number, registered: boolean, invited: boolean, disabled: boolean}>, others: string[], reachable: boolean, reason: string|null}>}
 *   `reason` is null when the account list was really read; otherwise one of
 *   "no-token" (nothing saved, or Vaultwarden refused it), "rate-limited",
 *   "unreachable" or "unknown".
 */
export async function vaultwardenState({ installDir = vaultwardenInstallDir(), manifest = null, fetch: fetchImpl, readAdminToken = null, db = null } = {}) {
  const failed = (reason, reachable = false) => ({ signups: "unknown", users: [], others: [], reachable, reason });
  const base = vaultwardenBaseUrl(manifest);
  const { fetchImpl: doFetch, readToken } = operationDeps({ fetch: fetchImpl, readAdminToken, db });
  const out = await withAdminSession({
    base,
    fetchImpl: doFetch,
    readToken,
    run: async (cookie) => {
      const users = await readUsers({ base, cookie, fetchImpl: doFetch });
      if (users.expired || users.error) return users;
      const signups = await readSignups({ base, cookie, fetchImpl: doFetch });
      if (signups.expired || signups.error) return signups;
      return { users: users.users, signups: signups.signups };
    },
  });
  if (out.error) {
    // A login/limit/open-session error says whether the app answered; one that bubbled
    // up from a request means it usually did (only a connection error did not).
    const reachable = out.reachable === undefined ? out.error !== "unreachable" : out.reachable === true;
    return failed(out.error, reachable);
  }
  if (!Array.isArray(out.users)) return failed("unknown", true);
  const owner = installedVaultwardenEnv(installDir)[OWNER_EMAIL_ENV_KEY];
  return { signups: out.signups, users: out.users, others: otherRegistered(out.users, owner), reachable: true, reason: null };
}

// ── The state cache (one admin login per five minutes, not per Extensions render) ──
const STATE_CACHE = new Map();

/** Forget a cached state (an invite / close just changed it). */
export function clearInviteStateCache(bundleId = null) {
  if (typeof bundleId === "string" && bundleId) STATE_CACHE.delete(bundleId);
  else STATE_CACHE.clear();
}

/**
 * vaultwardenState with a short in-memory cache, keyed by bundle id. Best-effort:
 * a render never waits more than once per TTL, and the failure is cached too (a
 * stopped container must not stall every page load, and a rate-limited login must
 * not be retried on every render).
 */
export async function cachedInviteState({
  bundleId = VAULTWARDEN_BUNDLE_ID,
  installDir = null,
  manifest = null,
  ttlMs = STATE_TTL_MS,
  now = Date.now,
  ...deps
} = {}) {
  const key = String(bundleId || VAULTWARDEN_BUNDLE_ID);
  const hit = STATE_CACHE.get(key);
  const at = now();
  if (hit && at - hit.at >= 0 && at - hit.at < ttlMs) return hit.state;
  const state = await vaultwardenState({ installDir: installDir || vaultwardenInstallDir(), manifest, ...deps });
  STATE_CACHE.set(key, { at, state });
  return state;
}

/**
 * Invite `email` to this Vaultwarden, then close sign-ups if they are on (SAME
 * cookie, then re-read to confirm). One login at most for the whole operation.
 *
 * @param {{email?: string, installDir?: string, manifest?: object|null, fetch?: Function, readAdminToken?: Function, db?: object|null}} [o]
 * @returns {Promise<{result: "invited"|"already"|"invalid-email"|"unreachable"|"no-token"|"rate-limited"|"failed", signups: "on"|"off"|"unknown"|null}>}
 */
export async function inviteOwnerResult({ email, installDir = vaultwardenInstallDir(), manifest = null, fetch: fetchImpl, readAdminToken = null, db = null } = {}) {
  const address = typeof email === "string" ? email.trim() : "";
  if (!isEmailShaped(address)) return { result: "invalid-email", signups: null };
  const base = vaultwardenBaseUrl(manifest);
  const { fetchImpl: doFetch, readToken } = operationDeps({ fetch: fetchImpl, readAdminToken, db });

  const out = await withAdminSession({
    base,
    fetchImpl: doFetch,
    readToken,
    run: async (cookie) => {
      let res;
      try {
        res = await doFetch(`${base}/admin/invite`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ email: address }),
          redirect: "manual",
          signal: requestSignal(),
        });
      } catch {
        return { error: "unreachable" };
      }
      if (!res) return { error: "unreachable" };
      if (isExpired(res)) return { expired: true };
      if (res.status === 429) return { error: "rate-limited" };
      let invited;
      if (res.status === 200) invited = "invited";
      else if (res.status === 409) invited = "already"; // duplicate, or already registered
      else if (res.status === 500) invited = (await isEmailRefusal(res)) ? "invalid-email" : "failed";
      else invited = "failed";
      if (invited !== "invited" && invited !== "already") return { error: invited };
      // Close sign-ups now, with the cookie that just worked, and confirm by re-reading.
      const before = await readSignups({ base, cookie, fetchImpl: doFetch });
      if (before.expired) return { expired: true };
      if (before.error) return { invited, signups: "unknown" };
      if (before.signups !== "on") return { invited, signups: before.signups };
      const closed = await closeSignupsOnSession({ base, cookie, fetchImpl: doFetch });
      if (closed.expired) return { expired: true };
      if (closed.error) return { invited, signups: "unknown" };
      return { invited, signups: closed.signups };
    },
  });

  // The card re-renders from a fresh read either way.
  clearInviteStateCache(VAULTWARDEN_BUNDLE_ID);
  if (out.error) return { result: out.error === "no-token" ? "no-token" : out.error, signups: null };
  if (out.signups === "off") await rememberSignupsClosed(installDir);
  return { result: out.invited, signups: out.signups === undefined ? null : out.signups };
}

/** inviteOwnerResult's result word alone (the manifest-facing API). */
export async function inviteOwner(options = {}) {
  return (await inviteOwnerResult(options)).result;
}

/**
 * Close sign-ups to everyone. At most one login; the full config form is posted
 * back (a partial one would wipe the app's other admin settings) and the state is
 * re-read, because the POST's 200 proves nothing on its own.
 *
 * @param {{installDir?: string, manifest?: object|null, fetch?: Function, readAdminToken?: Function, db?: object|null}} [o]
 * @returns {Promise<"off"|"unknown"|"rate-limited"|"failed">} "failed" = no token /
 *   the app did not answer / the login was refused; "unknown" = posted (or refused
 *   before posting) but the re-read is not "off"; "rate-limited" = Vaultwarden's
 *   login limit, try again in a few minutes.
 */
export async function closeSignups({ installDir = vaultwardenInstallDir(), manifest = null, fetch: fetchImpl, readAdminToken = null, db = null } = {}) {
  const base = vaultwardenBaseUrl(manifest);
  const { fetchImpl: doFetch, readToken } = operationDeps({ fetch: fetchImpl, readAdminToken, db });
  const out = await withAdminSession({
    base,
    fetchImpl: doFetch,
    readToken,
    run: (cookie) => closeSignupsOnSession({ base, cookie, fetchImpl: doFetch }),
  });
  clearInviteStateCache(VAULTWARDEN_BUNDLE_ID);
  if (out.error === "rate-limited") return "rate-limited";
  if (out.error) return "failed";
  if (out.signups === "off") {
    await rememberSignupsClosed(installDir);
    return "off";
  }
  return "unknown";
}

/**
 * Poll the container's `/alive` until it answers 200 (or the deadline passes).
 */
export async function waitForVaultwarden({
  installDir = vaultwardenInstallDir(),
  manifest = null,
  timeoutMs = 60_000,
  intervalMs = 1500,
  fetch: fetchImpl,
  now = Date.now,
  sleep = defaultSleep,
} = {}) {
  const base = vaultwardenBaseUrl(manifest);
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
// The manifest names one entry of this map (`firstAdmin.invite`), and the entry is
// bound to the bundle it belongs to: a second manifest naming the same handler can
// never run it (see inviteHandlerFor). Frozen, so no caller can install a handler.
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

/**
 * The handler THIS manifest declares (`firstAdmin.invite`) FOR THIS bundle, or null.
 *
 * Both must match: the manifest's `firstAdmin.invite` name AND the bundle id the
 * handler belongs to. Resolving on the name alone let any installed bundle that
 * wrote `invite: "vaultwarden"` into its own manifest drive the Vaultwarden code with
 * Vaultwarden's admin token in hand (and the app writes that manifest from inside its
 * own container).
 *
 * @param {object|null} manifest the REVIEWED manifest (never the installed copy)
 * @param {string|null} bundleId the installed bundle the manifest is for
 */
export function inviteHandlerFor(manifest, bundleId) {
  const fa = firstAdminOf(manifest);
  if (!fa || !fa.invite) return null;
  const handler = inviteHandler(fa.invite);
  if (!handler) return null;
  return typeof bundleId === "string" && handler.bundleId === bundleId ? handler : null;
}

/**
 * The invite state for the ONE bundle a reviewed manifest declares it for — or `{}`
 * when that bundle is not installed, or the manifest is not Vaultwarden's own.
 *
 * Not a loop over `installed`: the reviewed manifest is handed in by the caller
 * (panels/extensions.js and the routes read it from bundles-config), and a bundle
 * whose name and id do not both match gets nothing computed — no login, no token
 * read.
 */
export async function inviteStatesFor({
  installed = {},
  manifest = null,
  bundleId = VAULTWARDEN_BUNDLE_ID,
  db = null,
  ...deps
} = {}) {
  const handler = inviteHandlerFor(manifest, bundleId);
  if (!handler || !installed || !installed[bundleId]) return {};
  try {
    const state = await handler.state({ installDir: join(BUNDLES_DIR, bundleId), manifest, bundleId, db, ...deps });
    return { [bundleId]: state };
  } catch {
    return { [bundleId]: { signups: "unknown", users: [], others: [], reachable: false, reason: "unknown" } };
  }
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
  if (result === "rate-limited") return `Crow could not invite ${email}: ${name} is limiting admin logins for a few minutes. Try again shortly.`;
  return `Crow could not invite ${email}. Press "Invite my email" on the Extensions card.`;
}

/** Fixed sentences for the card's routes (never a raw error, never anything from Vaultwarden). */
export function inviteResultSentence(result, { email = "", name = "the app", signups = null } = {}) {
  if (result === "invited" || result === "already") return inviteInstallSentence({ result, signups, email, name });
  if (result === "invalid-email") return "That does not look like an email address.";
  if (result === "no-token") return `Crow has no ${name} admin token saved. Add it in Settings → Passwords and try again.`;
  if (result === "unreachable") return `Crow could not reach ${name}. Is it running?`;
  if (result === "rate-limited") return `${name} is limiting admin logins for a few minutes; try again shortly.`;
  return "Crow could not invite that email. Try again.";
}

export function closeSignupsSentence(result, { name = "the app" } = {}) {
  if (result === "off") return `Sign-ups are closed. Only people you invite can create an ${name} account.`;
  if (result === "rate-limited") return `${name} is limiting admin logins for a few minutes; try again shortly.`;
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
  const handler = inviteHandlerFor(manifest, bundleId);
  if (!handler) return null;
  const dir = typeof installDir === "string" && installDir ? installDir : join(BUNDLES_DIR, bundleId);
  try {
    const email = String(installedVaultwardenEnv(dir)[handler.ownerEmailEnvKey] || "").trim();
    if (!email) return null;
    const name = (manifest && typeof manifest.name === "string" && manifest.name) || bundleId || "the app";
    const d = { ...(deps || {}) };
    const up = await handler.waitForAlive({ installDir: dir, manifest, ...d });
    if (!up) {
      const result = "unreachable";
      log(inviteInstallSentence({ result, email, name }));
      return { result, signups: null };
    }
    const out = await handler.inviteResult({ email, installDir: dir, manifest, ...d });
    // The Extensions page may hold a read from before this install's invite.
    clearInviteStateCache(bundleId);
    log(inviteInstallSentence({ result: out.result, signups: out.signups, email, name }));
    return out;
  } catch {
    // A failed invite never fails an install: the Extensions card repeats it.
    try { log("Crow could not invite the owner's email. Press \"Invite my email\" on the Extensions card."); } catch { /* console gone */ }
    return { result: "failed", signups: null };
  }
}
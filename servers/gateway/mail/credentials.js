/**
 * Crow Mail's credentials: an account's password or OAuth refresh token lives in the sealed keychain of
 * the gateway (`kind 'service'`, `connection_uuid` = the mail account id, bundle `crow-mail`), never in
 * `mail_accounts`, a page, a log or an error. Three functions reach the keychain — saveSecret,
 * getSecrets and deleteSecrets — and getSecrets is the only plaintext path: the adapter factory calls
 * it to build a login, and nothing else does.
 *
 * Two different keys are involved and they are resolved the way the keychain's own callers resolve
 * them. Saving needs the WRITE key (ensureWriteKey creates the key file on first use and refuses to
 * re-key a table that still has rows); reading needs the key that is on disk now (loadKeychainKey,
 * which never creates one). So a crow.db restored onto a machine without its key file lists its rows as
 * unreadable and getSecrets raises KeychainKeyMissingError — the fault is the key, not the token. That
 * error is NOT a MailError and passes through unchanged (code `KEYCHAIN_KEY_MISSING`), so the caller
 * never reports a missing key as a bad password. Every other failure leaves this module as a MailError
 * with a fixed sentence: a keychain or library message can quote a value, and none of it may travel.
 *
 * `authFor` turns an account plus those secrets into the login an adapter hands imapflow or nodemailer.
 * A `TokenProvider` is any async function `({accountId, forceRefresh?}) => ({accessToken, expiresAt?,
 * refreshToken?})`; the OAuth wizards that produce one live in plan 5, so this module only consumes it.
 * A provider's reply that carries a rotated refresh token reaches the keychain only when the caller
 * supplied a `rotation` writer (`createRotationWriter(credentials)`), and only the refresh token is
 * written — an access token expires within the hour and is never persisted.
 */
import { MailError, toMailError } from "./errors.js";
import {
  ensureKeychainTable,
  ensureWriteKey,
  saveServiceSecret,
  serviceSecretsFor,
  deleteServiceSecrets,
  KeychainKeyMissingError,
} from "../keychain/store.js";
import { loadKeychainKey } from "../keychain/key.js";

/** The keychain bundle id the mail rows carry (there is no installed bundle behind it). */
export const MAIL_BUNDLE_ID = "crow-mail";

/** The only env keys a mail account row may hold. Nothing else is ever written or served. */
export const MAIL_SECRET_KEYS = Object.freeze(["MAIL_PASSWORD", "MAIL_REFRESH_TOKEN"]);

const SECRET_KEYS = new Set(MAIL_SECRET_KEYS);
const ACCOUNT_ID_RE = /^\S{1,80}$/;

function requireAccountId(value) {
  // Account ids are the store's `ma-<hex>`: no whitespace, bounded. A blank id would otherwise name a
  // keychain row no account owns.
  if (typeof value !== "string" || !ACCOUNT_ID_RE.test(value)) throw new MailError("BAD_INPUT", "account_id");
  return value;
}

function requireSecretKey(value) {
  if (typeof value !== "string" || !SECRET_KEYS.has(value)) throw new MailError("BAD_INPUT", "env_key");
  return value;
}

function requireSecret(value) {
  if (typeof value !== "string" || value === "") throw new MailError("BAD_INPUT", "secret");
  return value;
}

/** A keychain/library failure as a mail error. The key-missing fault is the caller's to report. */
function asMailError(err) {
  if (err instanceof MailError || err instanceof KeychainKeyMissingError) return err;
  return toMailError(err);
}

/**
 * The label the keychain panel shows for this account's rows: "Mail: <address>", or the account id when
 * the mail_accounts row is gone (a delete that raced a save). An address is not a secret, and the row
 * has to say which account it belongs to.
 */
async function labelFor(db, accountId) {
  const { rows } = await db.execute({
    sql: "SELECT address FROM mail_accounts WHERE id = ?",
    args: [accountId],
  });
  const address = rows[0] && typeof rows[0].address === "string" ? rows[0].address : "";
  return `Mail: ${address || accountId}`;
}

/**
 * The mail account credential store.
 *
 * `crowHome` is passed through to the keychain so a test (or a second instance) uses its own key file;
 * leaving it out means the keychain's own default (`CROW_HOME`, else `~/.crow`).
 *
 * @param {{db: object, crowHome?: string}} options
 */
export function createMailCredentials({ db, crowHome } = {}) {
  if (!db || typeof db.execute !== "function") {
    throw new TypeError("createMailCredentials needs a db client");
  }

  return {
    /**
     * Seal one secret for one account (upsert on connection uuid + env key). The write key is resolved
     * on every save, so a key created after the gateway booted is picked up.
     *
     * @param {string} accountId the mail account id (the keychain's connection uuid)
     * @param {"MAIL_PASSWORD"|"MAIL_REFRESH_TOKEN"} envKey
     * @param {string} secret non-empty plaintext
     * @returns {Promise<{id: number, created: boolean}>}
     */
    async saveSecret(accountId, envKey, secret) {
      const id = requireAccountId(accountId);
      const key = requireSecretKey(envKey);
      const value = requireSecret(secret);
      const label = await labelFor(db, id);
      try {
        const writeKey = await ensureWriteKey(db, { crowHome });
        return await saveServiceSecret(db, writeKey, {
          connectionUuid: id,
          bundleId: MAIL_BUNDLE_ID,
          envKey: key,
          label,
          secret: value,
        });
      } catch (err) {
        throw asMailError(err);
      }
    },

    /**
     * One account's secrets as `{envKey: plaintext}`, or `{}` when nothing is saved. Only the two mail
     * env keys can come back. A row sealed under a key that is not on this machine raises
     * KeychainKeyMissingError unchanged.
     *
     * @param {string} accountId
     * @returns {Promise<Record<string, string>>}
     */
    async getSecrets(accountId) {
      const id = requireAccountId(accountId);
      // The keychain table is created lazily by its own store; a mail account saved on this machine
      // always has it, and "nothing saved" must answer {} even before the first save.
      await ensureKeychainTable(db);
      const key = loadKeychainKey({ crowHome });
      if (!key) {
        // No key file here. Nothing saved is an empty answer; rows under this uuid were sealed
        // elsewhere, so serviceSecretsFor raises the key-missing fault rather than reporting {}.
        const { rows } = await db.execute({
          sql: `SELECT 1 AS present FROM crow_keychain
                 WHERE kind = 'service' AND connection_uuid = ? AND status = 'active' LIMIT 1`,
          args: [id],
        });
        if (rows.length === 0) return {};
      }
      return serviceSecretsFor(db, key, id, { allowedKeys: MAIL_SECRET_KEYS });
    },

    /**
     * Remove every secret of one account (the account's own delete path). No key is needed: nothing is
     * sealed here, so an account can still be disconnected from a crow.db whose key file is gone.
     *
     * @param {string} accountId
     * @returns {Promise<{deleted: number}>}
     */
    async deleteSecrets(accountId) {
      const id = requireAccountId(accountId);
      try {
        return await deleteServiceSecrets(db, id);
      } catch (err) {
        throw asMailError(err);
      }
    },
  };
}

/**
 * The writer `authFor` and the adapter hand a rotated refresh token to. It writes MAIL_REFRESH_TOKEN
 * and nothing else: an access token is never persisted, even when the object carries one, so the only
 * thing the keychain keeps is the credential that outlives the hour. A missing or empty token is
 * ignored (a provider may rotate on some calls only).
 *
 * @param {{saveSecret: Function}} credentials the object createMailCredentials returns
 * @returns {(accountId: string, rotation?: {refreshToken?: string}) => Promise<{saved: boolean}>}
 */
export function createRotationWriter(credentials) {
  if (!credentials || typeof credentials.saveSecret !== "function") {
    throw new TypeError("createRotationWriter needs a credentials object");
  }
  return async function writeRotatedToken(accountId, { refreshToken } = {}) {
    if (typeof refreshToken !== "string" || refreshToken.trim() === "") return { saved: false };
    await credentials.saveSecret(accountId, "MAIL_REFRESH_TOKEN", refreshToken);
    return { saved: true };
  };
}

/**
 * The login for one account.
 *
 * - `authKind: "password"` → `{user, pass}` from the keychain (a missing password is AUTH_FAILED).
 * - `authKind: "xoauth2"` → `{user, accessToken}` from `tokenProvider({accountId, forceRefresh})`; no
 *   provider, or a reply without an access token, is AUTH_FAILED. A reply's `refreshToken` goes to
 *   `rotation(accountId, {refreshToken})` when the caller supplied one; a rotation write that fails
 *   does not fail the sign-in, because the token just issued is the one the connection uses now.
 *
 * A provider error is a library error and may quote the token it was given, so only a MailError's own
 * allow-listed `detail` survives; the code is always AUTH_FAILED. KeychainKeyMissingError from the
 * password path passes through unchanged.
 *
 * @param {object} account a mail_accounts row as the account store returns it
 * @param {{credentials?: object, tokenProvider?: Function, forceRefresh?: boolean,
 *   rotation?: Function}} [options]
 * @returns {Promise<{user: string, pass?: string, accessToken?: string}>}
 */
export async function authFor(account, { credentials, tokenProvider, forceRefresh = false, rotation } = {}) {
  if (!account || typeof account !== "object" || typeof account.id !== "string" || account.id === "") {
    throw new MailError("BAD_INPUT", "account");
  }
  const user = typeof account.username === "string" && account.username !== ""
    ? account.username
    : (typeof account.address === "string" ? account.address : "");
  if (!user) throw new MailError("BAD_INPUT", "username");

  if (account.authKind === "password") {
    if (!credentials || typeof credentials.getSecrets !== "function") throw new MailError("AUTH_FAILED");
    const secrets = await credentials.getSecrets(account.id);
    const pass = secrets && typeof secrets.MAIL_PASSWORD === "string" ? secrets.MAIL_PASSWORD : "";
    if (!pass) throw new MailError("AUTH_FAILED");
    return { user, pass };
  }

  if (account.authKind === "xoauth2") {
    if (typeof tokenProvider !== "function") throw new MailError("AUTH_FAILED");
    let result;
    try {
      result = await tokenProvider({ accountId: account.id, forceRefresh: Boolean(forceRefresh) });
    } catch (err) {
      // Never the library's text: it can quote the refresh token or the server's reply.
      throw new MailError("AUTH_FAILED", err instanceof MailError ? err.detail : null);
    }
    const accessToken = result && typeof result.accessToken === "string" ? result.accessToken : "";
    if (!accessToken) throw new MailError("AUTH_FAILED");
    if (result.refreshToken && typeof rotation === "function") {
      try {
        await rotation(account.id, { refreshToken: result.refreshToken });
      } catch {
        // The access token in hand is valid; a failed rotation write is retried on the next refresh.
      }
    }
    return { user, accessToken };
  }

  throw new MailError("BAD_INPUT", "auth_kind");
}
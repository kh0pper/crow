/**
 * Whether a Crow Mail account can send right now, for Crow Recurring Reports.
 *
 * This is the one place in the reports code that reaches into Crow Mail. It lives in its own file so
 * `reports/approvals.js` imports nothing under `mail/`: the approval module owns seals and the live set,
 * the routes own the wiring, and the mail read stays a small, separately readable seam. A test reads the
 * reports modules' import text to keep it that way.
 *
 * The rule: the account row must exist, be `active` (not signed out, not claimed by another instance)
 * and carry an auth kind this Crow signs in with, and the account's credential must be present in the
 * keychain. Crow Mail has no single "send-ready" predicate to reuse (the send path reads the account and
 * then the secrets, one step at a time), so this reads the same two things through the same accessors.
 * Any failure, including a missing keychain key, is a plain false: go-live then refuses rather than
 * approving a sender nobody looked at.
 */
import { getAccount, MAIL_AUTH_KINDS } from "../mail/store/accounts.js";
import { createMailCredentials } from "../mail/credentials.js";

/**
 * Can this mail account send right now?
 *
 * @param {object} db a libsql-shaped client
 * @param {string} accountId a Crow Mail account id (`ma-<16 hex>`)
 * @returns {Promise<boolean>}
 */
export async function senderReady(db, accountId) {
  if (typeof accountId !== "string" || !accountId) return false;
  let account;
  try {
    account = await getAccount(db, accountId);
  } catch {
    return false;
  }
  if (!account || account.status !== "active") return false;
  if (!MAIL_AUTH_KINDS.includes(account.authKind)) return false;
  try {
    const secrets = await createMailCredentials({ db }).getSecrets(accountId);
    const key = account.authKind === "xoauth2" ? "MAIL_REFRESH_TOKEN" : "MAIL_PASSWORD";
    return typeof secrets?.[key] === "string" && secrets[key] !== "";
  } catch {
    return false;
  }
}

export default senderReady;
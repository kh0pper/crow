/**
 * The one probe behind "Connect": build an adapter, connect it, list the folders, close it — and keep
 * nothing of it. A connect alone can pass against a server that then refuses every mailbox operation,
 * and a listing alone says nothing about the password, so both are part of the probe.
 *
 * The caller passes the credentials to use, which is what lets this run BEFORE an account row exists:
 * the connect route hands it a reader that answers with the password just typed, and plan 2's
 * re-enter-a-password route hands it one that answers with the new secret. The adapter factory is the
 * pinned `({account, credentials}) => adapter` signature the sync supervisor uses, so the same adapter
 * implementation is exercised here as by a sync.
 *
 * Every failure leaves as a MailError (`toMailError`): a library's text quotes the server, the command
 * and the username, so none of it may reach a response or a log. The adapter is closed in `finally` on
 * success and on failure, and a failed close never masks the probe's own verdict.
 */
import { MailError, toMailError } from "./errors.js";

/**
 * @param {{adapterFactory: Function, account: object, credentials: object}} options
 *   `account` is a mail_accounts-shaped row (imap, smtp, address, username, authKind);
 *   `credentials` is anything with `getSecrets(accountId) -> {MAIL_PASSWORD?}`.
 * @returns {Promise<void>} resolves when the server accepted the sign-in and listed a folder
 */
export async function probeAccount({ adapterFactory, account, credentials } = {}) {
  if (typeof adapterFactory !== "function") throw new MailError("BAD_INPUT", "adapter_factory");
  if (account == null || typeof account !== "object" || Array.isArray(account)) {
    throw new MailError("BAD_INPUT", "account");
  }

  let adapter = null;
  try {
    adapter = await adapterFactory({ account, credentials });
    if (adapter == null || typeof adapter.connect !== "function" || typeof adapter.listFolders !== "function") {
      throw new MailError("PROTOCOL", "adapter");
    }
    await adapter.connect();
    await adapter.listFolders();
  } catch (err) {
    throw toMailError(err);
  } finally {
    if (adapter != null && typeof adapter.close === "function") {
      try {
        await adapter.close();
      } catch {
        // The connection is being thrown away either way; a close failure changes the verdict not at all.
      }
    }
  }
}

export default probeAccount;
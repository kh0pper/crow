/**
 * The Crow Mail account store (`mail_accounts`, plus the per-account allow list and sync state).
 *
 * One account is one row; nothing secret is ever stored here — the password or refresh token lives in
 * the sealed keychain (credentials.js) and no function in this module reads or writes it. The row is
 * returned as a camelCase `Account` with no secret field at all, so an account object can be logged,
 * sent to the owner's browser or held by the supervisor without a redaction step.
 *
 * Validation lives here, not in CHECK constraints (the schema has none on purpose): a bad address,
 * host, port, security, status or status detail is a MailError BAD_INPUT, and its `detail` names the
 * field so a log line says which one without quoting the value. Addresses and senders are lower-cased
 * on the way in, so the UNIQUE COLLATE NOCASE address column and this module agree on identity.
 *
 * Times are epoch ms from Date.now(). The plan's later stores add to this module's exports; nothing
 * here is special-cased for a caller.
 *
 * Three fields carry what an account is for sending (0029's ADD COLUMNs, so a store from before them
 * reads their defaults): `displayName` is the name that goes on From and is null until the operator
 * names the account, `aliases` are its other addresses (used by reply-all, stored as a JSON array) and
 * `sentCopy` says how the Sent copy is kept — `provider` when the provider files it, `append` when Crow
 * appends it. All three are validated here, like every other column.
 *
 * `deleteAccount` runs every hook registered with `onAccountDeleting` before it opens its transaction.
 * A hook that throws aborts the delete, so a caller that must stop a removal (a scheduled send still
 * waiting, a secret in flight) refuses it by throwing rather than by racing the cascade.
 */
import { randomBytes } from "node:crypto";
import { MailError } from "../errors.js";
import { validateAddress } from "../adapter/interface.js";

export const MAIL_ACCOUNT_STATUSES = Object.freeze(["active", "auth_failed", "claimed_elsewhere"]);
export const MAIL_AUTH_KINDS = Object.freeze(["password", "xoauth2"]);
export const MAIL_SECURITIES = Object.freeze(["ssl", "starttls", "none"]);
/** How an account's Sent copy is kept: the provider files it, or Crow appends one after a send. */
export const MAIL_SENT_COPY_VALUES = Object.freeze(["provider", "append"]);

/** The most other addresses one account may carry: reply-all reads them, a person types them. */
const MAX_ALIASES = 50;

/** A plaintext connection is only defensible to a server on this machine. */
const PLAINTEXT_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const HOST_RE = /^[A-Za-z0-9.-]+$/;
const CODE_RE = /^[A-Za-z0-9_]{1,40}$/;
const DIGEST_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DUPLICATE_ADDRESS_RE = /UNIQUE constraint failed: mail_accounts\.address/i;

const UPDATE_FIELDS = new Set([
  "label", "status", "statusDetail", "windowDays", "localModelsOnly", "digestOptIn", "digestTime",
  "lastSyncAt", "displayName", "aliases", "sentCopy",
]);
const SYNC_STATE_FIELDS = new Set([
  "state", "errorCode", "failures", "backoffUntil", "lastSuccessAt", "lastNoticeAt",
]);

const ACCOUNT_COLUMNS = `id, address, label, provider, imap_host, imap_port, imap_security,
  smtp_host, smtp_port, smtp_security, username, auth_kind, status, status_detail, window_days,
  local_models_only, digest_opt_in, digest_time, display_name, aliases_json, sent_copy, created_at,
  updated_at, last_sync_at`;

const SYNC_STATE_COLUMNS = `account_id, state, error_code, failures, backoff_until, last_success_at,
  last_notice_at`;

function fail(field) {
  throw new MailError("BAD_INPUT", field);
}

/* ------------------------------------------------------------------ validation */

function normalizeId(value, field) {
  if (typeof value !== "string" || !value || value.length > 80 || /\s/.test(value)) fail(field);
  return value;
}

/** Trimmed, lower-cased, one `@`, no whitespace on either side. */
function normalizeAddress(value) {
  if (typeof value !== "string") fail("address");
  const address = value.trim().toLowerCase();
  if (!address || address.length > 254) fail("address");
  if (/[\s\u0000-\u001f\u007f]/.test(address)) fail("address");
  const at = address.indexOf("@");
  if (at <= 0 || at !== address.lastIndexOf("@") || at === address.length - 1) fail("address");
  return address;
}

/** Lower-cased, one `@`, no whitespace: the same identity rule as an address, without requiring one. */
function normalizeSender(value) {
  if (typeof value !== "string") fail("sender");
  const sender = value.trim().toLowerCase();
  if (!sender || sender.length > 254) fail("sender");
  if (/[\s\u0000-\u001f\u007f]/.test(sender)) fail("sender");
  return sender;
}

function normalizeLabel(value) {
  if (typeof value !== "string") fail("label");
  const label = value.trim();
  if (!label || label.length > 120) fail("label");
  return label;
}

function normalizeHost(value) {
  // No trimming: a host with any whitespace in it is refused, not repaired.
  if (typeof value !== "string" || !value) fail("host");
  const host = value.toLowerCase();
  if (host !== "::1" && !HOST_RE.test(host)) fail("host");
  return host;
}

function normalizePort(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) fail("port");
  return value;
}

function normalizeSecurity(value, host) {
  if (!MAIL_SECURITIES.includes(value)) fail("security");
  if (value === "none" && !PLAINTEXT_HOSTS.has(host)) fail("security");
  return value;
}

function normalizeEndpoint(value, field) {
  if (!value || typeof value !== "object") fail(field);
  const host = normalizeHost(value.host);
  const port = normalizePort(value.port);
  const security = normalizeSecurity(value.security, host);
  return { host, port, security };
}

function normalizeUsername(value, address) {
  if (value == null || value === "") return address;
  if (typeof value !== "string") fail("username");
  const username = value.trim();
  if (!username || username.length > 254 || /[\s\u0000-\u001f\u007f]/.test(username)) fail("username");
  return username;
}

function normalizeAuthKind(value) {
  if (value == null) return "password";
  if (!MAIL_AUTH_KINDS.includes(value)) fail("auth_kind");
  return value;
}

function normalizeProvider(value) {
  if (value == null) return null;
  if (typeof value !== "string") fail("provider");
  const provider = value.trim();
  if (provider.length > 60) fail("provider");
  return provider || null;
}

function normalizeCode(value, field) {
  if (typeof value !== "string" || !CODE_RE.test(value)) fail(field);
  return value;
}

function normalizeOptionalCode(value, field) {
  return value == null ? null : normalizeCode(value, field);
}

function normalizeWindowDays(value) {
  if (!Number.isInteger(value) || value < 1 || value > 3650) fail("window_days");
  return value;
}

function normalizeFlag(value, field) {
  if (typeof value !== "boolean") fail(field);
  return value ? 1 : 0;
}

/** A display name is header text: a control character is removed rather than carried to a header. */
function normalizeDisplayName(value) {
  if (value == null) return null;
  if (typeof value !== "string") fail("display_name");
  // The same characters `validateOutgoing` strips from a From name, and for the same reason: a CR/LF
  // in it would be a header line, not padding.
  const name = value.replace(/[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/g, "").trim();
  if (!name) return null;
  if (name.length > 120) fail("display_name");
  return name;
}

/**
 * The account's other addresses, each one a clean addr-spec by the rule `validateOutgoing` applies to
 * an address — the same parser, so a display name, a group, a second address or a control character is
 * refused rather than read back as something else. Angle brackets and quotes are refused on top of
 * that: an alias is an address the account answers to, never a header form, and no such address is
 * ever written with a quoted local part. They are lower-cased and named once, so a reply-all compares
 * them the way the address column is compared, and they are stored as a JSON array. At most
 * `MAX_ALIASES`; a longer list is refused whole rather than cut short.
 */
function normalizeAliases(value) {
  if (!Array.isArray(value)) fail("aliases");
  if (value.length > MAX_ALIASES) fail("aliases");
  const aliases = [];
  for (const entry of value) {
    if (typeof entry !== "string") fail("aliases");
    if (/["<>]/.test(entry)) fail("aliases");
    const address = validateAddress(entry, "aliases");
    if (!aliases.includes(address)) aliases.push(address);
  }
  return aliases;
}

/** `sent_copy` is one of two words; anything else is refused rather than stored and read as one. */
function normalizeSentCopy(value) {
  if (!MAIL_SENT_COPY_VALUES.includes(value)) fail("sent_copy");
  return value;
}

/** A stored alias list, as the array the Account carries; a row nothing wrote reads as no aliases. */
function parseAliases(json) {
  if (typeof json !== "string" || !json) return [];
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
}

function normalizeTime(value, field) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 0) fail(field);
  return value;
}

function normalizeFailures(value) {
  if (!Number.isInteger(value) || value < 0) fail("failures");
  return value;
}

/* ---------------------------------------------------------------------- rows */

function rowToAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    address: row.address,
    provider: row.provider ?? null,
    imap: { host: row.imap_host, port: Number(row.imap_port), security: row.imap_security },
    smtp: { host: row.smtp_host, port: Number(row.smtp_port), security: row.smtp_security },
    // The column is nullable; an account created here always carries one.
    username: row.username ?? row.address,
    authKind: row.auth_kind,
    status: row.status,
    statusDetail: row.status_detail ?? null,
    windowDays: Number(row.window_days),
    localModelsOnly: Boolean(row.local_models_only),
    digestOptIn: Boolean(row.digest_opt_in),
    digestTime: row.digest_time,
    displayName: row.display_name ?? null,
    aliases: parseAliases(row.aliases_json),
    // A stored value that is not one of the two modes (a hand edit, a restored copy) reads as the
    // default rather than as a third mode the rest of the code would have to know about.
    sentCopy: MAIL_SENT_COPY_VALUES.includes(row.sent_copy) ? row.sent_copy : "provider",
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastSyncAt: row.last_sync_at == null ? null : Number(row.last_sync_at),
  };
}

function rowToSyncState(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    state: row.state,
    errorCode: row.error_code ?? null,
    failures: Number(row.failures),
    backoffUntil: row.backoff_until == null ? null : Number(row.backoff_until),
    lastSuccessAt: row.last_success_at == null ? null : Number(row.last_success_at),
    lastNoticeAt: row.last_notice_at == null ? null : Number(row.last_notice_at),
  };
}

/* ------------------------------------------------------------------- accounts */

/**
 * Create one account. Only the columns the caller supplies are written; status, window and digest
 * defaults come from MAIL_DDL, and the send fields (no display name, no aliases, `provider`) come from
 * MAIL_ACCOUNT_SEND_COLUMNS' own defaults, so the schema stays the single source of truth — a new
 * account is named and given its Sent-copy rule by `updateAccount`. A second row with the same address
 * in any case is refused by the UNIQUE COLLATE NOCASE column and surfaces as BAD_INPUT.
 */
export async function createAccount(db, input = {}) {
  const address = normalizeAddress(input.address);
  const label = normalizeLabel(input.label);
  const provider = normalizeProvider(input.provider);
  const username = normalizeUsername(input.username, address);
  const authKind = normalizeAuthKind(input.authKind);
  const imap = normalizeEndpoint(input.imap, "imap");
  const smtp = normalizeEndpoint(input.smtp, "smtp");

  const id = "ma-" + randomBytes(8).toString("hex");
  const now = Date.now();
  try {
    // One transaction: the insert and the read-back are atomic, so the caller gets the stored row and
    // never a half-written account.
    const [, readBack] = await db.batch([
      {
        sql: `INSERT INTO mail_accounts
                (id, address, label, provider, imap_host, imap_port, imap_security,
                 smtp_host, smtp_port, smtp_security, username, auth_kind, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, address, label, provider, imap.host, imap.port, imap.security,
          smtp.host, smtp.port, smtp.security, username, authKind, now, now],
      },
      { sql: `SELECT ${ACCOUNT_COLUMNS} FROM mail_accounts WHERE id = ?`, args: [id] },
    ]);
    return rowToAccount(readBack.rows[0]);
  } catch (err) {
    if (DUPLICATE_ADDRESS_RE.test(String(err && err.message))) throw new MailError("BAD_INPUT", "address");
    throw err;
  }
}

/** One account, or null when there is no such row. */
export async function getAccount(db, id) {
  if (typeof id !== "string" || !id || id.length > 80) return null;
  const { rows } = await db.execute({
    sql: `SELECT ${ACCOUNT_COLUMNS} FROM mail_accounts WHERE id = ?`,
    args: [id],
  });
  return rowToAccount(rows[0]);
}

/** Every account, oldest first — the order the owner added them in. */
export async function listAccounts(db) {
  const { rows } = await db.execute({
    sql: `SELECT ${ACCOUNT_COLUMNS} FROM mail_accounts ORDER BY created_at ASC, id ASC`,
    args: [],
  });
  return rows.map(rowToAccount);
}

/**
 * Write the owner-settable fields of one account. Unknown keys and out-of-range values are BAD_INPUT
 * and change nothing (each key and value is inspected as it is read, before the single UPDATE runs).
 * Returns the updated account, or null when the id names no row.
 */
export async function updateAccount(db, id, patch = {}) {
  normalizeId(id, "id");
  for (const key of Object.keys(patch || {})) {
    if (!UPDATE_FIELDS.has(key)) fail("field");
  }
  const sets = [];
  const args = [];
  for (const [key, value] of Object.entries(patch || {})) {
    switch (key) {
      case "label":
        sets.push("label = ?");
        args.push(normalizeLabel(value));
        break;
      case "status":
        if (!MAIL_ACCOUNT_STATUSES.includes(value)) fail("status");
        sets.push("status = ?");
        args.push(value);
        break;
      case "statusDetail":
        // An allow-listed code or null: server text must never land in status_detail (RF2).
        sets.push("status_detail = ?");
        args.push(normalizeOptionalCode(value, "status_detail"));
        break;
      case "windowDays":
        sets.push("window_days = ?");
        args.push(normalizeWindowDays(value));
        break;
      case "localModelsOnly":
        sets.push("local_models_only = ?");
        args.push(normalizeFlag(value, "local_models_only"));
        break;
      case "digestOptIn":
        sets.push("digest_opt_in = ?");
        args.push(normalizeFlag(value, "digest_opt_in"));
        break;
      case "digestTime":
        if (typeof value !== "string" || !DIGEST_TIME_RE.test(value)) fail("digest_time");
        sets.push("digest_time = ?");
        args.push(value);
        break;
      case "lastSyncAt":
        sets.push("last_sync_at = ?");
        args.push(normalizeTime(value, "last_sync_at"));
        break;
      case "displayName":
        sets.push("display_name = ?");
        args.push(normalizeDisplayName(value));
        break;
      case "aliases":
        sets.push("aliases_json = ?");
        args.push(JSON.stringify(normalizeAliases(value)));
        break;
      case "sentCopy":
        sets.push("sent_copy = ?");
        args.push(normalizeSentCopy(value));
        break;
      default:
        fail("field");
    }
  }
  if (!sets.length) return getAccount(db, id);
  sets.push("updated_at = ?");
  args.push(Date.now());
  args.push(id);
  await db.execute({ sql: `UPDATE mail_accounts SET ${sets.join(", ")} WHERE id = ?`, args });
  return getAccount(db, id);
}

/* --------------------------------------------------------------- removal hooks */

/**
 * Every hook registered with `onAccountDeleting`, in the order it was registered. Module state, like
 * the add-on registries elsewhere: a hook is registered once at boot by the code that must speak before
 * an account goes. A `Set`, so registering the same function twice (a module loaded twice, a test that
 * re-registers) is still one hook that runs once.
 */
const accountDeletingHooks = new Set();

/**
 * Register `fn(db, accountId)`, which `deleteAccount` awaits before it opens its transaction. A hook
 * that throws aborts the delete and nothing is removed, so this is how a caller refuses a removal it
 * cannot let happen. Answers an unsubscribe function, so a caller (or a test) can take its hook back.
 *
 * @param {(db: object, accountId: string) => unknown} fn
 * @returns {() => void}
 */
export function onAccountDeleting(fn) {
  if (typeof fn !== "function") throw new TypeError("onAccountDeleting needs a function");
  accountDeletingHooks.add(fn);
  return () => {
    accountDeletingHooks.delete(fn);
  };
}

/** Drop every registered hook. The seam a test uses between cases; nothing in the app calls it. */
export function _resetAccountDeletingHooksForTests() {
  accountDeletingHooks.clear();
}

/**
 * Remove one account and everything that belongs to it, in one transaction. `mail_messages` goes
 * first so the FTS delete trigger removes the index entries; `mail_messages_fts` is never written
 * directly. The keychain is NOT touched here — the caller owns the secret's lifetime.
 *
 * The registered removal hooks run first, awaited one after another, while the account and its rows are
 * still whole; the first one that throws ends the delete with nothing removed. Only then does the
 * synchronous transaction open — a transaction callback may not await, so a hook cannot run inside it.
 *
 * @returns {Promise<{messages: number}>} how many message rows were removed
 */
export async function deleteAccount(db, id) {
  normalizeId(id, "id");
  for (const hook of [...accountDeletingHooks]) {
    await hook(db, id);
  }
  return db.runTransaction((run) => {
    const read = run({ sql: "SELECT COUNT(*) AS n FROM mail_messages WHERE account_id = ?", args: [id] });
    const messages = Number(read.rows[0]?.n ?? 0);
    run({ sql: "DELETE FROM mail_messages WHERE account_id = ?", args: [id] });
    run({ sql: "DELETE FROM mail_threads WHERE account_id = ?", args: [id] });
    run({ sql: "DELETE FROM mail_folders WHERE account_id = ?", args: [id] });
    run({ sql: "DELETE FROM mail_image_allow WHERE account_id = ?", args: [id] });
    run({ sql: "DELETE FROM mail_sync_state WHERE account_id = ?", args: [id] });
    run({ sql: "DELETE FROM mail_accounts WHERE id = ?", args: [id] });
    return { messages };
  });
}

/* ---------------------------------------------------------------- image allow */

/** Allow one sender's remote images on one account. Idempotent. */
export async function addImageAllow(db, accountId, sender) {
  normalizeId(accountId, "account_id");
  const value = normalizeSender(sender);
  await db.execute({
    sql: `INSERT INTO mail_image_allow (account_id, sender, created_at) VALUES (?, ?, ?)
          ON CONFLICT DO NOTHING`,
    args: [accountId, value, Date.now()],
  });
  return true;
}

/** @returns {Promise<boolean>} whether a row was removed */
export async function removeImageAllow(db, accountId, sender) {
  normalizeId(accountId, "account_id");
  const value = normalizeSender(sender);
  const result = await db.execute({
    sql: "DELETE FROM mail_image_allow WHERE account_id = ? AND sender = ?",
    args: [accountId, value],
  });
  return result.rowsAffected === 1;
}

export async function isImageAllowed(db, accountId, sender) {
  normalizeId(accountId, "account_id");
  const value = normalizeSender(sender);
  const { rows } = await db.execute({
    sql: "SELECT 1 AS ok FROM mail_image_allow WHERE account_id = ? AND sender = ?",
    args: [accountId, value],
  });
  return rows.length > 0;
}

/* ------------------------------------------------------------------ sync state */

export async function getSyncState(db, accountId) {
  if (typeof accountId !== "string" || !accountId) return null;
  const { rows } = await db.execute({
    sql: `SELECT ${SYNC_STATE_COLUMNS} FROM mail_sync_state WHERE account_id = ?`,
    args: [accountId],
  });
  return rowToSyncState(rows[0]);
}

/**
 * Merge `patch` into one account's sync state, creating the row on first use. The read and the write
 * are one transaction, so two writers cannot lose each other's counters; fields the patch omits keep
 * their stored value (last_notice_at in particular survives a restart and a state reset).
 * `state` and `errorCode` are allow-listed tokens; errorCode may be null.
 */
export async function setSyncState(db, accountId, patch = {}) {
  normalizeId(accountId, "account_id");
  for (const key of Object.keys(patch || {})) {
    if (!SYNC_STATE_FIELDS.has(key)) fail("field");
  }
  const next = {};
  for (const [key, value] of Object.entries(patch || {})) {
    switch (key) {
      case "state": next.state = normalizeCode(value, "state"); break;
      case "errorCode": next.error_code = normalizeOptionalCode(value, "error_code"); break;
      case "failures": next.failures = normalizeFailures(value); break;
      case "backoffUntil": next.backoff_until = normalizeTime(value, "backoff_until"); break;
      case "lastSuccessAt": next.last_success_at = normalizeTime(value, "last_success_at"); break;
      case "lastNoticeAt": next.last_notice_at = normalizeTime(value, "last_notice_at"); break;
      default: fail("field");
    }
  }

  const row = await db.runTransaction((run) => {
    const current = run({
      sql: `SELECT ${SYNC_STATE_COLUMNS} FROM mail_sync_state WHERE account_id = ?`,
      args: [accountId],
    }).rows[0];
    const merged = {
      account_id: accountId,
      state: "state" in next ? next.state : (current?.state ?? "idle"),
      error_code: "error_code" in next ? next.error_code : (current?.error_code ?? null),
      failures: "failures" in next ? next.failures : (current?.failures ?? 0),
      backoff_until: "backoff_until" in next ? next.backoff_until : (current?.backoff_until ?? null),
      last_success_at: "last_success_at" in next ? next.last_success_at : (current?.last_success_at ?? null),
      last_notice_at: "last_notice_at" in next ? next.last_notice_at : (current?.last_notice_at ?? null),
    };
    run({
      sql: `INSERT INTO mail_sync_state
              (account_id, state, error_code, failures, backoff_until, last_success_at, last_notice_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(account_id) DO UPDATE SET
              state = excluded.state, error_code = excluded.error_code, failures = excluded.failures,
              backoff_until = excluded.backoff_until, last_success_at = excluded.last_success_at,
              last_notice_at = excluded.last_notice_at`,
      args: [merged.account_id, merged.state, merged.error_code, merged.failures,
        merged.backoff_until, merged.last_success_at, merged.last_notice_at],
    });
    return merged;
  });
  return rowToSyncState(row);
}
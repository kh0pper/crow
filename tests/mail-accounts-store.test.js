// Crow Mail's error vocabulary and account store (Tasks 4 of plan 1): one fixed sentence per code,
// no library text anywhere, accounts validated on the way in, and one account removed in one
// transaction. Every test builds the mail tables from MAIL_DDL in a scratch DB.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { MAIL_DDL } from "../servers/shared/mail-schema.js";
import { MailError, MAIL_ERROR_CODES, MAIL_ERROR_TEXT, toMailError } from "../servers/gateway/mail/errors.js";
import {
  MAIL_ACCOUNT_STATUSES, createAccount, getAccount, listAccounts, updateAccount, deleteAccount,
  addImageAllow, removeImageAllow, isImageAllowed, getSyncState, setSyncState,
} from "../servers/gateway/mail/store/accounts.js";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "crow-mail-accounts-"));
  dirs.push(dir);
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(MAIL_DDL);
  return db;
}

const ALIASES = ["mail.example.test", "127.0.0.1"];

function accountInput(overrides = {}) {
  const host = ALIASES[0];
  return {
    label: "Alex",
    address: "alex@example.com",
    imap: { host, port: 993, security: "ssl" },
    smtp: { host, port: 465, security: "ssl" },
    ...overrides,
  };
}

function isBadInput(err) {
  return err instanceof MailError && err.code === "BAD_INPUT";
}

function badInput() {
  return (err) => {
    assert.ok(isBadInput(err), `expected BAD_INPUT, got ${err && err.code}`);
    return true;
  };
}

/** A folder, a thread, a searchable message, an allow row and a sync-state row for one account. */
async function seedMail(db, accountId, { token, uid }) {
  await db.execute({
    sql: "INSERT INTO mail_folders (account_id, path, name) VALUES (?, 'INBOX', 'Inbox')",
    args: [accountId],
  });
  const { rows: folders } = await db.execute({
    sql: "SELECT id FROM mail_folders WHERE account_id = ?", args: [accountId],
  });
  await db.execute({
    sql: "INSERT INTO mail_threads (account_id, thread_key, subject, last_date, message_count) VALUES (?, ?, ?, ?, 1)",
    args: [accountId, `key-${uid}`, "A subject", 1_700_000_000_000],
  });
  const { rows: threads } = await db.execute({
    sql: "SELECT id FROM mail_threads WHERE account_id = ?", args: [accountId],
  });
  await db.execute({
    sql: `INSERT INTO mail_messages
            (account_id, folder_id, uid, thread_id, subject, from_text, to_text, body_text, date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [accountId, folders[0].id, uid, threads[0].id, "A subject",
      "alex@example.com", "sam@example.com", token, 1_700_000_000_000],
  });
  await addImageAllow(db, accountId, "news@example.com");
  await setSyncState(db, accountId, { state: "idle" });
}

async function count(db, sql, args = []) {
  const { rows } = await db.execute({ sql, args });
  return rows[0].n;
}

function ftsRowids(db, term) {
  return db
    .execute({ sql: "SELECT rowid FROM mail_messages_fts WHERE mail_messages_fts MATCH ?", args: [term] })
    .then(({ rows }) => rows.map((r) => r.rowid));
}

/* ------------------------------------------------------------------ errors.js */

const LEAK = ["hunter2", "Login failed for alex"];

/** An error shaped like a library's: message, response, responseText and command all quote the user. */
function hostileError(props = {}) {
  return Object.assign(new Error("hunter2 Login failed for alex"), {
    response: "hunter2 in response",
    responseText: "hunter2 in responseText",
    command: "LOGIN alex hunter2",
  }, props);
}

function assertNoLeak(err) {
  const out = toMailError(err);
  assert.ok(out instanceof MailError, "toMailError returns a MailError");
  assert.ok(MAIL_ERROR_CODES.includes(out.code), `${out.code} is a known code`);
  assert.equal(out.message, MAIL_ERROR_TEXT[out.code], "the message is the code's fixed sentence");
  const text = [out.name, out.code, out.detail, out.message, JSON.stringify(out)].join("\n");
  for (const marker of LEAK) assert.equal(text.includes(marker), false, `${marker} leaked`);
  return out;
}

test("MAIL_ERROR_CODES and MAIL_ERROR_TEXT line up, and every sentence is plain prose", () => {
  assert.deepEqual(MAIL_ERROR_CODES, [
    "AUTH_FAILED", "NETWORK", "TLS", "PROTOCOL", "NOT_FOUND",
    "BAD_INPUT", "CLAIMED_ELSEWHERE", "TOO_LARGE", "TIMEOUT", "CHANGED",
  ]);
  assert.deepEqual(Object.keys(MAIL_ERROR_TEXT).sort(), [...MAIL_ERROR_CODES].sort());
  for (const code of MAIL_ERROR_CODES) {
    const sentence = MAIL_ERROR_TEXT[code];
    assert.equal(typeof sentence, "string");
    assert.ok(sentence.length > 10 && sentence.endsWith("."), `${code} has a full sentence`);
    assert.doesNotMatch(sentence, /\bnull\b|undefined|\{|\}|%s/, `${code} carries no placeholder`);
  }
  assert.equal(MAIL_ERROR_TEXT.CHANGED,
    "This message changed on the mail server. Crow is refreshing; try again.");
});

test("new MailError always uses the fixed sentence and keeps only an allow-listed detail", () => {
  const err = new MailError("NETWORK", "ECONNRESET");
  assert.ok(err instanceof Error);
  assert.equal(err.code, "NETWORK");
  assert.equal(err.detail, "ECONNRESET");
  assert.equal(err.message, MAIL_ERROR_TEXT.NETWORK);

  assert.equal(new MailError("NETWORK", "Login failed for alex").detail, null);
  assert.equal(new MailError("NETWORK", "Login failed").detail, null);
  assert.equal(new MailError("NETWORK", "A".repeat(41)).detail, null);
  assert.equal(new MailError("NETWORK", "has space").detail, null);
  assert.equal(new MailError("NETWORK").detail, null);

  assert.throws(() => new MailError("NOT_A_CODE"), TypeError);
});

test("RF2 toMailError classifies library errors and copies no library text", () => {
  const cases = [
    [{ authenticationFailed: true }, "AUTH_FAILED"],
    [{ authenticationFailed: false }, "PROTOCOL"],
    [{ code: "EAUTH" }, "AUTH_FAILED"],
    [{ code: "ERR_TLS_CERT_ALTNAME_INVALID" }, "TLS"],
    [{ code: "ERR_SSL_WRONG_VERSION_NUMBER" }, "TLS"],
    [{ code: "CERT_HAS_EXPIRED" }, "TLS"],
    [{ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }, "TLS"],
    [{ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }, "TLS"],
    [{ code: "SELF_SIGNED_CERT_IN_CHAIN" }, "TLS"],
    [{ code: "ETLS" }, "TLS"],
    [{ code: "ECONNREFUSED" }, "NETWORK"],
    [{ code: "ENOTFOUND" }, "NETWORK"],
    [{ code: "ECONNRESET" }, "NETWORK"],
    [{ code: "EPIPE" }, "NETWORK"],
    [{ code: "ESOCKET" }, "NETWORK"],
    [{ code: "ECONNECTION" }, "NETWORK"],
    [{ code: "ETIMEOUT" }, "TIMEOUT"],
    [{ code: "ETIMEDOUT" }, "TIMEOUT"],
    [{ name: "Timeout" }, "TIMEOUT"],
    [{ responseStatus: "NO" }, "PROTOCOL"],
    [{ responseStatus: "BAD" }, "PROTOCOL"],
    [{}, "PROTOCOL"],
  ];
  for (const [props, code] of cases) {
    const out = assertNoLeak(hostileError(props));
    assert.equal(out.code, code, `${JSON.stringify(props)} classifies as ${code}`);
  }

  assert.equal(assertNoLeak(null).code, "PROTOCOL");
  assert.equal(assertNoLeak("hunter2 Login failed for alex").code, "PROTOCOL");
  assert.equal(assertNoLeak(new MailError("AUTH_FAILED", "Login failed for alex")).code, "AUTH_FAILED");
});

test("RF2 toMailError keeps an allow-listed code as detail and drops the rest", () => {
  assert.equal(toMailError(hostileError({ code: "ECONNRESET" })).detail, "ECONNRESET");
  assert.equal(toMailError(hostileError({ code: "ERR_TLS_CERT_ALTNAME_INVALID" })).detail,
    "ERR_TLS_CERT_ALTNAME_INVALID");
  assert.equal(toMailError(hostileError({ responseStatus: "NO" })).detail, "NO");
  assert.equal(toMailError(hostileError({ code: "Login failed for alex" })).detail, null);
  assert.equal(toMailError(hostileError({ code: "hunter2".repeat(10) })).detail, null);
  assert.equal(toMailError(hostileError({})).detail, null);
});

test("CHANGED is its own code, passes toMailError through untouched and leaks no detail", () => {
  assert.ok(MAIL_ERROR_CODES.includes("CHANGED"));
  const changed = new MailError("CHANGED");
  assert.equal(changed.message,
    "This message changed on the mail server. Crow is refreshing; try again.");
  assert.equal(toMailError(changed), changed, "a MailError is returned as the same object");
  assert.equal(changed.detail, null);
  const attempted = new MailError("CHANGED", "Login failed for alex");
  assert.equal(attempted.detail, null);
  assert.equal(toMailError(attempted).detail, null);
  assert.equal(JSON.stringify(toMailError(changed)).includes("hunter2"), false);
});

/* ------------------------------------------------------------ store/accounts.js */

test("createAccount lower-cases and trims the address and mints a ma- id", async () => {
  const db = await freshDb();
  const account = await createAccount(db, {
    ...accountInput(),
    address: "  Alex@Example.COM  ",
    label: "  Alex  ",
  });

  assert.match(account.id, /^ma-[0-9a-f]{16}$/);
  assert.equal(account.address, "alex@example.com");
  assert.equal(account.label, "Alex");
  assert.equal(account.provider, null);
  assert.deepEqual(account.imap, { host: "mail.example.test", port: 993, security: "ssl" });
  assert.deepEqual(account.smtp, { host: "mail.example.test", port: 465, security: "ssl" });
  assert.equal(account.username, "alex@example.com", "username defaults to the lower-cased address");
  assert.equal(account.authKind, "password");
  assert.equal(account.status, "active");
  assert.equal(account.statusDetail, null);
  assert.equal(account.lastSyncAt, null);
  assert.equal(account.createdAt, account.updatedAt);

  assert.deepEqual(Object.keys(account).sort(), [
    "address", "authKind", "createdAt", "digestOptIn", "digestTime", "id", "imap", "label",
    "lastSyncAt", "localModelsOnly", "provider", "smtp", "status", "statusDetail", "updatedAt",
    "username", "windowDays",
  ], "the account object is exactly the camelCase shape, with no secret field");

  assert.deepEqual(await getAccount(db, account.id), account, "reading it back gives the same object");
  assert.deepEqual(await listAccounts(db), [account]);

  const { rows } = await db.execute({
    sql: "SELECT address, username, auth_kind, status FROM mail_accounts WHERE id = ?",
    args: [account.id],
  });
  assert.deepEqual(rows[0], {
    address: "alex@example.com", username: "alex@example.com", auth_kind: "password", status: "active",
  });

  const second = await createAccount(db, accountInput({ address: "sam@example.com", label: "Sam" }));
  assert.match(second.id, /^ma-[0-9a-f]{16}$/);
  assert.notEqual(second.id, account.id);
  assert.equal((await listAccounts(db)).length, 2);
});

test("a new account starts at 90 days, both opt-ins off and 07:00", async () => {
  const db = await freshDb();
  const account = await createAccount(db, accountInput());
  assert.equal(account.windowDays, 90);
  assert.equal(account.localModelsOnly, false);
  assert.equal(account.digestOptIn, false);
  assert.equal(account.digestTime, "07:00");
});

test("RF5 a case-different duplicate address is BAD_INPUT and stores nothing", async () => {
  const db = await freshDb();
  await createAccount(db, accountInput());
  await assert.rejects(
    () => createAccount(db, accountInput({ address: "Alex@Example.com", label: "Dup" })),
    badInput(),
  );
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM mail_accounts"), 1);
  assert.equal((await listAccounts(db))[0].label, "Alex");
});

test("security \"none\" is refused for a remote host and allowed for a loopback one", async () => {
  const db = await freshDb();
  await assert.rejects(
    () => createAccount(db, accountInput({ imap: { host: "mail.example.test", port: 143, security: "none" } })),
    badInput(),
  );
  await assert.rejects(
    () => createAccount(db, accountInput({ imap: { host: "127.0.0.1", port: 993, security: "ssl" },
      smtp: { host: "mail.example.test", port: 25, security: "none" } })),
    badInput(),
  );

  const local = await createAccount(db, accountInput({
    imap: { host: "127.0.0.1", port: 1143, security: "none" },
    smtp: { host: "127.0.0.1", port: 1025, security: "none" },
  }));
  assert.deepEqual(local.imap, { host: "127.0.0.1", port: 1143, security: "none" });

  for (const host of ["::1", "localhost"]) {
    const other = await createAccount(db, accountInput({
      address: `${host === "::1" ? "v6" : "local"}@example.com`,
      imap: { host, port: 143, security: "none" },
      smtp: { host, port: 25, security: "none" },
    }));
    assert.equal(other.imap.security, "none", `${host} is loopback`);
  }

  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM mail_accounts"), 3);
});

test("ports outside 1..65535, non-integers, bad hosts and bad security are BAD_INPUT", async () => {
  const db = await freshDb();
  const cases = [
    { imap: { host: "mail.example.test", port: 0, security: "ssl" } },
    { imap: { host: "mail.example.test", port: 70_000, security: "ssl" } },
    { imap: { host: "mail.example.test", port: 993.5, security: "ssl" } },
    { imap: { host: "mail.example.test", port: "993", security: "ssl" } },
    { imap: { host: "", port: 993, security: "ssl" } },
    { imap: { host: " mail.example.test", port: 993, security: "ssl" } },
    { imap: { host: "mail.example.test ", port: 993, security: "ssl" } },
    { imap: { host: "mail example.test", port: 993, security: "ssl" } },
    { imap: { host: "mail\texample.test", port: 993, security: "ssl" } },
    { imap: { host: "mail.example.test:993", port: 993, security: "ssl" } },
    { imap: { host: "user@mail.example.test", port: 993, security: "ssl" } },
    { imap: { host: "::2", port: 993, security: "ssl" } },
    { imap: { host: "mail.example.test", port: 993, security: "tls" } },
    { smtp: { host: "mail.example.test", port: 0, security: "ssl" } },
    { smtp: { host: "bad host", port: 465, security: "ssl" } },
    { smtp: { host: "mail.example.test", port: 465, security: null } },
    { imap: null },
    { imap: "mail.example.test:993" },
    { address: "alexexample.com" },
    { address: "alex@@example.com" },
    { address: "@example.com" },
    { address: "alex@" },
    { address: "alex@exa mple.com" },
    { address: "" },
    { password: undefined, address: "alex at example.com" },
    { label: "" },
    { label: "   " },
    { authKind: "oauth2" },
    { username: "   " },
  ];
  for (const overrides of cases) {
    await assert.rejects(
      () => createAccount(db, accountInput(overrides)),
      badInput(),
      `refused: ${JSON.stringify(overrides)}`,
    );
  }
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM mail_accounts"), 0);
});

test("updateAccount writes only the allowed fields and refuses everything else", async () => {
  const db = await freshDb();
  const account = await createAccount(db, accountInput());

  const updated = await updateAccount(db, account.id, {
    label: "Work", status: "auth_failed", statusDetail: "AUTH_FAILED", windowDays: 30,
    localModelsOnly: true, digestOptIn: true, digestTime: "06:30", lastSyncAt: 1_700_000_000_000,
  });
  assert.equal(updated.label, "Work");
  assert.equal(updated.status, "auth_failed");
  assert.equal(updated.statusDetail, "AUTH_FAILED");
  assert.equal(updated.windowDays, 30);
  assert.equal(updated.localModelsOnly, true);
  assert.equal(updated.digestOptIn, true);
  assert.equal(updated.digestTime, "06:30");
  assert.equal(updated.lastSyncAt, 1_700_000_000_000);
  assert.equal(updated.address, "alex@example.com", "the address is not patchable");
  assert.equal(updated.createdAt, account.createdAt);
  assert.deepEqual(await getAccount(db, account.id), updated);

  const refusals = [
    { nope: 1 },
    { address: "sam@example.com" },
    { username: "someone" },
    { authKind: "xoauth2" },
    { imap: { host: "127.0.0.1", port: 143, security: "none" } },
    { status: "paused" },
    { status: null },
    { statusDetail: "Login failed for alex" },
    { statusDetail: "has space" },
    { statusDetail: "A".repeat(41) },
    { windowDays: 0 },
    { windowDays: 90.5 },
    { windowDays: "90" },
    { localModelsOnly: 1 },
    { digestOptIn: "yes" },
    { digestTime: "7:00" },
    { digestTime: "24:00" },
    { lastSyncAt: "yesterday" },
  ];
  for (const patch of refusals) {
    await assert.rejects(
      () => updateAccount(db, account.id, patch),
      badInput(),
      `refused: ${JSON.stringify(patch)}`,
    );
  }
  assert.deepEqual(await getAccount(db, account.id), updated, "a refused patch changes nothing");

  const cleared = await updateAccount(db, account.id, { statusDetail: null });
  assert.equal(cleared.statusDetail, null);

  assert.deepEqual(await updateAccount(db, account.id, {}), cleared, "an empty patch is a read");
  assert.equal(await updateAccount(db, "ma-0000000000000000", { label: "Ghost" }), null);
  assert.deepEqual([...MAIL_ACCOUNT_STATUSES], ["active", "auth_failed", "claimed_elsewhere"]);
  assert.equal((await updateAccount(db, account.id, { status: "claimed_elsewhere" })).status,
    "claimed_elsewhere");
});

test("RF5 deleteAccount removes that account's rows in every table, leaving the other one whole", async () => {
  const db = await freshDb();
  const gone = await createAccount(db, accountInput());
  const kept = await createAccount(db, accountInput({ address: "sam@example.com", label: "Sam" }));
  await seedMail(db, gone.id, { token: "gonebodytoken", uid: 11 });
  await seedMail(db, kept.id, { token: "keptbodytoken", uid: 12 });
  assert.deepEqual(await ftsRowids(db, "gonebodytoken"), [1], "the message starts indexed");
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM mail_messages"), 2);

  assert.deepEqual(await deleteAccount(db, gone.id), { messages: 1 });
  for (const [table, column] of [
    ["mail_messages", "account_id"], ["mail_threads", "account_id"], ["mail_folders", "account_id"],
    ["mail_image_allow", "account_id"], ["mail_sync_state", "account_id"], ["mail_accounts", "id"],
  ]) {
    assert.equal(await count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, [gone.id]), 0,
      `${table} holds nothing for the deleted account`);
  }
  assert.deepEqual(await ftsRowids(db, "gonebodytoken"), [], "the FTS entry went with the row");
  assert.deepEqual(await ftsRowids(db, "keptbodytoken"), [2], "the other account stays indexed");

  assert.equal(await getAccount(db, gone.id), null);
  assert.deepEqual(await getSyncState(db, gone.id), null);
  assert.equal(await isImageAllowed(db, gone.id, "news@example.com"), false);

  const keptState = await getSyncState(db, kept.id);
  assert.equal(keptState.state, "idle");
  assert.equal((await listAccounts(db)).length, 1);
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM mail_messages"), 1);

  assert.deepEqual(await deleteAccount(db, gone.id), { messages: 0 }, "deleting again is harmless");
});

test("image allow is per account and case-insensitive", async () => {
  const db = await freshDb();
  const alex = await createAccount(db, accountInput());
  const sam = await createAccount(db, accountInput({ address: "sam@example.com", label: "Sam" }));

  assert.equal(await isImageAllowed(db, alex.id, "news@example.com"), false);
  await addImageAllow(db, alex.id, "  News@Example.COM  ");
  await addImageAllow(db, alex.id, "news@example.com");
  assert.equal(await isImageAllowed(db, alex.id, "news@example.com"), true);
  assert.equal(await isImageAllowed(db, alex.id, "NEWS@EXAMPLE.COM"), true);
  assert.equal(await isImageAllowed(db, sam.id, "news@example.com"), false, "the allow is per account");
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM mail_image_allow"), 1, "adding twice is one row");

  assert.equal(await removeImageAllow(db, alex.id, "nEwS@example.com"), true);
  assert.equal(await isImageAllowed(db, alex.id, "news@example.com"), false);
  assert.equal(await removeImageAllow(db, alex.id, "news@example.com"), false);

  await assert.rejects(() => addImageAllow(db, alex.id, "   "), badInput());
  await assert.rejects(() => isImageAllowed(db, alex.id, null), badInput());
});

test("setSyncState round-trips lastNoticeAt and every field it is given", async () => {
  const db = await freshDb();
  const account = await createAccount(db, accountInput());
  assert.equal(await getSyncState(db, account.id), null);

  const first = await setSyncState(db, account.id, {
    state: "backoff", errorCode: "NETWORK", failures: 3,
    backoffUntil: 5_000, lastSuccessAt: 1_000, lastNoticeAt: 2_000,
  });
  assert.deepEqual(first, {
    accountId: account.id, state: "backoff", errorCode: "NETWORK", failures: 3,
    backoffUntil: 5_000, lastSuccessAt: 1_000, lastNoticeAt: 2_000,
  });

  const second = await setSyncState(db, account.id, { state: "idle", failures: 0 });
  assert.equal(second.state, "idle");
  assert.equal(second.failures, 0);
  assert.equal(second.lastNoticeAt, 2_000, "a field the patch omits keeps its value");
  assert.equal(second.errorCode, "NETWORK");
  assert.deepEqual(await getSyncState(db, account.id), second);

  const cleared = await setSyncState(db, account.id, { errorCode: null, backoffUntil: null });
  assert.equal(cleared.errorCode, null);
  assert.equal(cleared.backoffUntil, null);
  assert.equal(cleared.lastNoticeAt, 2_000);

  const other = await createAccount(db, accountInput({ address: "sam@example.com", label: "Sam" }));
  assert.equal(await getSyncState(db, other.id), null, "sync state is per account");

  for (const patch of [{ nope: 1 }, { state: "has space" }, { failures: -1 }, { failures: 1.5 },
    { lastNoticeAt: "soon" }, { errorCode: "Login failed for alex" }]) {
    await assert.rejects(
      () => setSyncState(db, account.id, patch),
      badInput(),
      `refused: ${JSON.stringify(patch)}`,
    );
  }
  assert.deepEqual(await getSyncState(db, account.id), cleared, "a refused patch changes nothing");
});
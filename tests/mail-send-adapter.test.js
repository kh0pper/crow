// Crow Mail plan 3, Task 2: plan 1's amendments — A1 (a Message-ID the caller owns), A2
// (`appendToSent`, the Sent copy), A3's account fields (display name, aliases, how the Sent copy is
// kept) and A4 (`onAccountDeleting`) — plus `composeRaw`, the RFC 822 bytes a Sent copy or a stored
// draft is made of. `composeRaw` never reaches a socket: it is the offline half of the outgoing path,
// built from `validateOutgoing`'s output and nodemailer's own composer.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { MAIL_DDL, MAIL_ACCOUNT_SEND_COLUMNS } from "../servers/shared/mail-schema.js";
import { MailError } from "../servers/gateway/mail/errors.js";
import {
  ADAPTER_METHODS, assertAdapter, validateOutgoing,
} from "../servers/gateway/mail/adapter/interface.js";
import { composeRaw } from "../servers/gateway/mail/adapter/compose.js";
import { createImapSmtpAdapter } from "../servers/gateway/mail/adapter/imap-smtp.js";
import { createFakeMailAdapter, DEFAULT_FOLDERS } from "./fixtures/fake-mail-adapter.mjs";
import { createFakeImapServer, FAKE_PASSWORD, FAKE_USER } from "./fixtures/fake-mail-server.mjs";
import { rawMessage, runAdapterContract } from "./fixtures/mail-adapter-contract.mjs";
import {
  createAccount, getAccount, listAccounts, updateAccount, deleteAccount, addImageAllow,
  isImageAllowed, getSyncState, setSyncState, onAccountDeleting, _resetAccountDeletingHooksForTests,
} from "../servers/gateway/mail/store/accounts.js";

const ALEX = "alex@example.com";
const SAM = "sam@example.com";
const HIDDEN = "hidden@example.com";

const dirs = [];
after(() => {
  _resetAccountDeletingHooksForTests();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A scratch DB with the 0027 tables and the 0029 account columns. The account columns are ADD COLUMN
 * specs rather than part of MAIL_DDL, so a store built from MAIL_DDL alone has the 0027 shape only.
 */
async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "crow-mail-send-adapter-"));
  dirs.push(dir);
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(MAIL_DDL);
  for (const spec of MAIL_ACCOUNT_SEND_COLUMNS) {
    await db.execute({ sql: `ALTER TABLE ${spec.table} ADD COLUMN ${spec.column} ${spec.definition}`, args: [] });
  }
  return db;
}

function accountInput(overrides = {}) {
  return {
    label: "Alex",
    address: ALEX,
    imap: { host: "mail.example.test", port: 993, security: "ssl" },
    smtp: { host: "mail.example.test", port: 465, security: "ssl" },
    ...overrides,
  };
}

function badInput(detail) {
  return (err) => {
    assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
    assert.equal(err.code, "BAD_INPUT");
    if (detail) assert.equal(err.detail, detail);
    return true;
  };
}

function mailCode(code) {
  return (err) => {
    assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
    assert.equal(err.code, code);
    return true;
  };
}

/** The header lines of a raw message, one per line, so one field's occurrences can be counted. */
function headerLines(raw) {
  return raw.split("\r\n").filter((line) => /^[!-9;-~]+:/.test(line));
}

function headersNamed(raw, name) {
  return headerLines(raw).filter((line) => line.slice(0, line.indexOf(":")).trim().toLowerCase() === name);
}

/** A plain message the tests adjust one field at a time. */
function outgoing(overrides = {}) {
  return {
    from: { name: "Alex", address: ALEX },
    to: [{ address: SAM }],
    subject: "Hello from Crow",
    text: "A plain body.",
    ...overrides,
  };
}

const asText = (buffer) => buffer.toString("utf8");

/* ------------------------------------------------------------------ A1: the Message-ID */

test("messageId is honoured and validated", async () => {
  const id = "<plan-3-task-2@example.com>";
  const raw = asText(await composeRaw(outgoing({ messageId: id }), { keepBcc: false }));
  assert.deepEqual(headersNamed(raw, "message-id"), [`Message-ID: ${id}`],
    "the caller's id is the one composed, once");

  // Absent, the composer writes an id of its own.
  const generated = await composeRaw(outgoing(), { keepBcc: false });
  assert.ok(Buffer.isBuffer(generated), "composeRaw answers with bytes");
  const own = headersNamed(asText(generated), "message-id");
  assert.equal(own.length, 1, "a message always carries one Message-ID");
  assert.notEqual(own[0], `Message-ID: ${id}`);

  const refused = [
    "<a b>",
    "<a@example.com>\r\n",
    "<a@example.com>\nBcc: x@example.com",
    "a@example.com",
    "<>",
    `<${"a".repeat(251)}@example.com>`,
  ];
  for (const bad of refused) {
    const shown = JSON.stringify(bad);
    await assert.rejects(
      () => composeRaw(outgoing({ messageId: bad }), { keepBcc: false }),
      badInput("messageId"),
      shown,
    );
    assert.throws(() => validateOutgoing(outgoing({ messageId: bad })), badInput("messageId"), `bare ${shown}`);
  }

  // The fake records what a real transport is handed: the caller's id, not a generated one.
  const fake = createFakeMailAdapter();
  const result = await fake.send(outgoing({ messageId: id }));
  assert.equal(result.messageId, id);
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0].messageId, id);
});

/* --------------------------------------------------------------- composeRaw and the Bcc */

test("composeRaw with keepBcc false has no Bcc header and with true keeps it", async () => {
  const message = outgoing({ bcc: [{ address: HIDDEN }], cc: [{ address: "kim@example.com" }] });
  const blind = asText(await composeRaw(message, { keepBcc: false }));
  assert.deepEqual(headersNamed(blind, "bcc"), [], "the blind recipient is not in the bytes");
  assert.equal(blind.includes(HIDDEN), false, "and not anywhere else either");
  assert.equal(headersNamed(blind, "to").length, 1);
  assert.equal(headersNamed(blind, "cc").length, 1, "the visible recipients are there");

  const kept = asText(await composeRaw(message, { keepBcc: true }));
  assert.deepEqual(headersNamed(kept, "bcc"), [`Bcc: ${HIDDEN}`],
    "a Sent copy keeps the blind recipient");
  assert.equal(kept.includes("A plain body."), true);

  // The default is the wire's shape: no Bcc.
  assert.deepEqual(headersNamed(asText(await composeRaw(message)), "bcc"), []);
});

test("composeRaw refuses an attachment path or href", async () => {
  for (const extra of [{ path: "/etc/passwd" }, { href: "https://mail.example.test/report.bin" }]) {
    await assert.rejects(
      () => composeRaw(outgoing({
        attachments: [{ filename: "report.bin", contentType: "application/octet-stream", content: "bytes", ...extra }],
      }), { keepBcc: false }),
      badInput("attachments"),
      JSON.stringify(extra),
    );
  }

  const composed = asText(await composeRaw(outgoing({
    attachments: [{
      filename: "report.bin",
      contentType: "application/octet-stream",
      content: Buffer.from("the attachment bytes"),
    }],
  }), { keepBcc: false }));
  assert.match(composed, /filename="?report\.bin"?/);
  assert.ok(composed.includes(Buffer.from("the attachment bytes").toString("base64")),
    "the part carries the bytes it was given");
});

/* ------------------------------------------------------------- A2: appendToSent, fake adapter */

test("appendToSent files the copy in the sent folder with \\Seen and is NOT_FOUND without one", async () => {
  const fake = createFakeMailAdapter();
  const raw = rawMessage({ subject: "sent copy", body: "the sent body" });
  const copy = await fake.appendToSent(raw);
  assert.equal(copy.folderPath, "Sent");
  assert.ok(Number.isInteger(copy.uid), "the fake names the uid it appended at");
  assert.equal(fake.appended.length, 1);
  assert.equal(fake.appended[0].folderPath, "Sent");
  assert.equal(asText(fake.appended[0].raw), raw, "the bytes are stored as given");
  const [stored] = await fake.get(copy.folderPath, [copy.uid]);
  assert.deepEqual(stored.flags, ["\\Seen"], "a sent copy is seen, not a draft");
  assert.match(asText(stored.raw), /the sent body/);

  const withoutSent = createFakeMailAdapter({
    folders: DEFAULT_FOLDERS.filter((folder) => folder.specialUse !== "\\Sent"),
  });
  await assert.rejects(() => withoutSent.appendToSent(raw), mailCode("NOT_FOUND"));
  assert.deepEqual(withoutSent.appended, [], "nothing is filed in a folder the account does not have");
  await assert.rejects(() => withoutSent.appendToSent(42), badInput());
});

test("assertAdapter fails on an adapter missing appendToSent", () => {
  assert.ok([...ADAPTER_METHODS].includes("appendToSent"), "the method is part of the contract");
  const complete = createFakeMailAdapter();
  assert.doesNotThrow(() => assertAdapter(complete));

  const incomplete = createFakeMailAdapter();
  delete incomplete.appendToSent;
  assert.throws(() => assertAdapter(incomplete), (err) => {
    assert.ok(err instanceof TypeError);
    assert.match(err.message, /appendToSent/);
    return true;
  });
});

/** The fake as the contract's factory sees it: the adapter plus its seeding hooks. */
runAdapterContract(async (opts = {}) => {
  const fake = createFakeMailAdapter(opts);
  return {
    adapter: fake,
    deliver: fake.deliver,
    expunge: fake.expunge,
    moveIn: fake.moveIn,
    bumpUidValidity: fake.bumpUidValidity,
    resetUidValidity: fake.resetUidValidity,
    dropWatch: fake.dropWatch,
    emit: fake.emit,
    commands: () => [...fake.wire],
    silenceNext: (method) => { fake.failNext(method, new MailError("TIMEOUT", "command_deadline")); },
    credentials: () => [],
  };
});

/* --------------------------------------------------------- A2: appendToSent, IMAP adapter */

const FAST = { connectMs: 4000, greetingMs: 4000, socketMs: 4000, commandMs: 4000 };

const passwordCredentials = (password) => ({ getSecrets: async () => ({ MAIL_PASSWORD: password }) });

function imapAdapterFor(imap) {
  return createImapSmtpAdapter({
    account: {
      id: "ma-0123456789abcdef",
      label: "Alex",
      address: FAKE_USER,
      imap: { host: imap.host, port: imap.port, security: "none" },
      smtp: { host: imap.host, port: imap.port, security: "none" },
      username: FAKE_USER,
      authKind: "password",
      status: "active",
      statusDetail: null,
      windowDays: 90,
    },
    credentials: passwordCredentials(FAKE_PASSWORD),
    timeouts: FAST,
  });
}

/** An append as the fake recorded it, with its literal as text so a deep-equal can pin it. */
function recordedAppend({ mailbox, flags, raw }) {
  return { mailbox, flags, raw: raw.toString("utf8") };
}

test("the IMAP adapter's appendToSent is NOT_FOUND on a server with no sent folder", async () => {
  // A server with a drafts folder and no mailbox that answers to \Sent, by flag or by name.
  const imap = await createFakeImapServer({ mailboxes: ["INBOX", "Drafts"] });
  const adapter = imapAdapterFor(imap);
  try {
    await assert.rejects(() => adapter.appendToSent(42), badInput());
    assert.equal(imap.connectionCount(), 0, "a refused input opens no socket");
    await assert.rejects(
      () => adapter.appendToSent(rawMessage({ subject: "sent copy" })),
      mailCode("NOT_FOUND"),
    );
    assert.deepEqual(imap.appended, [], "nothing was filed anywhere");
  } finally {
    await adapter.close();
    await imap.close();
  }
});

test("appendToSent files into the folder imapflow names Sent when the server flags none", async () => {
  // No mailbox here carries a special-use flag: the folder's own name is all that says which one is
  // which, and imapflow resolves that itself (specialUseSource "name").
  const imap = await createFakeImapServer({
    mailboxes: ["INBOX", "Sent", "Drafts"],
    specialUse: { Sent: null, Drafts: null },
  });
  const adapter = imapAdapterFor(imap);
  const raw = rawMessage({ subject: "sent copy", body: "the sent body" });
  try {
    const copy = await adapter.appendToSent(raw);
    assert.equal(copy.folderPath, "Sent");
    assert.deepEqual(imap.appended.map(recordedAppend), [{ mailbox: "Sent", flags: ["\\Seen"], raw }]);
  } finally {
    await adapter.close();
    await imap.close();
  }
});

test("appendToSent without any sent-like mailbox is NOT_FOUND and files nothing", async () => {
  const imap = await createFakeImapServer({ mailboxes: ["INBOX", "Drafts", "Notes"] });
  const adapter = imapAdapterFor(imap);
  try {
    await assert.rejects(
      () => adapter.appendToSent(rawMessage({ subject: "sent copy" })),
      (err) => {
        assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
        assert.equal(err.code, "NOT_FOUND");
        assert.equal(err.detail, "sent");
        return true;
      },
    );
    assert.deepEqual(imap.appended, [], "no folder was picked for the copy");
  } finally {
    await adapter.close();
    await imap.close();
  }
});

test("appendToSent files the copy once and answers the uid a UIDPLUS server reports", async () => {
  const imap = await createFakeImapServer({ capabilities: ["UIDPLUS"] });
  const adapter = imapAdapterFor(imap);
  const raw = rawMessage({ subject: "sent copy", body: "the sent body" });
  try {
    const copy = await adapter.appendToSent(raw);
    assert.equal(copy.folderPath, "Sent");
    assert.ok(Number.isInteger(copy.uid) && copy.uid > 0, "the server names the message it appended");
    assert.deepEqual(imap.appended.map(recordedAppend), [{ mailbox: "Sent", flags: ["\\Seen"], raw }],
      "one append, seen, and never a draft flag");
    const [stored] = await adapter.get(copy.folderPath, [copy.uid]);
    assert.ok(stored, "the copy is fetchable at the uid the server reported");
    assert.deepEqual(stored.flags, ["\\Seen"]);
    assert.match(stored.raw.toString("utf8"), /the sent body/);
  } finally {
    await adapter.close();
    await imap.close();
  }
});

test("saveDraft's NOT_FOUND names drafts, while appendToSent's names sent", async () => {
  const imap = await createFakeImapServer({ mailboxes: ["INBOX", "Sent"] });
  const adapter = imapAdapterFor(imap);
  try {
    await assert.rejects(() => adapter.saveDraft(rawMessage({ subject: "a draft" })), (err) => {
      assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
      assert.equal(err.code, "NOT_FOUND");
      assert.equal(err.detail, "drafts", "the detail the Save-as-draft path reports is the drafts folder");
      return true;
    });
    assert.deepEqual(imap.appended, [], "nothing was filed anywhere");
  } finally {
    await adapter.close();
    await imap.close();
  }
});

/* ------------------------------------------------------------------------ A3: the account */

test("Account carries displayName, aliases and sentCopy with their defaults", async () => {
  const db = await freshDb();
  const account = await createAccount(db, accountInput());
  assert.equal(account.displayName, null, "an account is not named until the operator names it");
  assert.deepEqual(account.aliases, []);
  assert.equal(account.sentCopy, "provider");

  const { rows } = await db.execute({
    sql: "SELECT display_name, aliases_json, sent_copy FROM mail_accounts WHERE id = ?",
    args: [account.id],
  });
  assert.deepEqual(rows[0], { display_name: null, aliases_json: "[]", sent_copy: "provider" },
    "the column defaults are what an existing row reads too");
  assert.deepEqual(await getAccount(db, account.id), account);
  assert.deepEqual(await listAccounts(db), [account]);
});

test("updateAccount accepts displayName, aliases and sentCopy and rejects sentCopy bogus", async () => {
  const db = await freshDb();
  const account = await createAccount(db, accountInput());

  const updated = await updateAccount(db, account.id, {
    displayName: "  Alex  ",
    aliases: ["  Alex+Work@Example.com ", "alex+work@example.com", "alex@Example.com"],
    sentCopy: "append",
  });
  assert.equal(updated.displayName, "Alex");
  assert.deepEqual(updated.aliases, ["alex+work@example.com", "alex@example.com"],
    "an alias is lower-cased like an address and named once");
  assert.equal(updated.sentCopy, "append");
  assert.equal(updated.address, ALEX, "the account's own address is still not patchable");

  const { rows } = await db.execute({
    sql: "SELECT display_name, aliases_json, sent_copy FROM mail_accounts WHERE id = ?",
    args: [account.id],
  });
  assert.deepEqual(rows[0], {
    display_name: "Alex",
    aliases_json: '["alex+work@example.com","alex@example.com"]',
    sent_copy: "append",
  }, "the aliases are stored as a JSON array");
  assert.deepEqual(await getAccount(db, account.id), updated);

  const fifty = Array.from({ length: 50 }, (_, index) => `alex+${index}@example.com`);

  const refusals = [
    { sentCopy: "bogus" },
    { sentCopy: null },
    { sentCopy: "APPEND" },
    { aliases: "alex@example.com" },
    { aliases: [{ address: ALEX }] },
    { aliases: ["not-an-address"] },
    { aliases: ["a@example.com\r\nBcc: x@example.com"] },
    { aliases: ["<alex@example.com>"] },
    { aliases: ['"alex"@example.com'] },
    { aliases: [...fifty, "alex+50@example.com"] },
    { displayName: 7 },
    { displayName: "A".repeat(121) },
  ];
  for (const patch of refusals) {
    await assert.rejects(
      () => updateAccount(db, account.id, patch),
      badInput(),
      `refused: ${JSON.stringify(patch)}`,
    );
  }
  assert.deepEqual(await getAccount(db, account.id), updated, "a refused patch changes nothing");

  // Fifty aliases fit; the fifty-first was refused above, so the fifty are still what is stored.
  assert.deepEqual((await updateAccount(db, account.id, { aliases: fifty })).aliases, fifty);
  assert.deepEqual((await getAccount(db, account.id)).aliases, fifty);

  assert.equal((await updateAccount(db, account.id, { displayName: null })).displayName, null);
  assert.deepEqual((await updateAccount(db, account.id, { aliases: [] })).aliases, []);
  assert.equal((await updateAccount(db, account.id, { sentCopy: "provider" })).sentCopy, "provider");
});

test("a stored sent_copy outside the two values reads as provider", async () => {
  const db = await freshDb();
  const account = await createAccount(db, accountInput());
  // Written around the store, as a hand edit or a restored copy would: the read still answers a mode
  // the rest of the code can switch on, never the odd string the column holds.
  await db.execute({
    sql: "UPDATE mail_accounts SET sent_copy = ? WHERE id = ?",
    args: ["bogus", account.id],
  });
  assert.equal((await getAccount(db, account.id)).sentCopy, "provider");
  assert.deepEqual((await listAccounts(db)).map((row) => row.sentCopy), ["provider"]);
});

/* --------------------------------------------------------- A4: the removal hooks */

/** A folder, a message, an allow row and a sync-state row, so a delete has something to cascade. */
async function seedAccountRows(db, accountId) {
  await db.execute({
    sql: "INSERT INTO mail_folders (account_id, path, name) VALUES (?, 'INBOX', 'Inbox')",
    args: [accountId],
  });
  const { rows: folders } = await db.execute({
    sql: "SELECT id FROM mail_folders WHERE account_id = ?", args: [accountId],
  });
  await db.execute({
    sql: `INSERT INTO mail_messages (account_id, folder_id, uid, subject, from_text, to_text, date)
          VALUES (?, ?, 11, 'A subject', ?, ?, ?)`,
    args: [accountId, folders[0].id, ALEX, SAM, 1_700_000_000_000],
  });
  await addImageAllow(db, accountId, "news@example.com");
  await setSyncState(db, accountId, { state: "idle" });
}

async function countFor(db, table, column, accountId) {
  const { rows } = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, args: [accountId],
  });
  return Number(rows[0].n);
}

const ROWS = [
  ["mail_messages", "account_id"], ["mail_folders", "account_id"], ["mail_image_allow", "account_id"],
  ["mail_sync_state", "account_id"], ["mail_accounts", "id"],
];

test("onAccountDeleting hooks run before the cascade and a throwing hook aborts the delete", async () => {
  const db = await freshDb();
  const gone = await createAccount(db, accountInput());
  await seedAccountRows(db, gone.id);

  const seen = [];
  const stop = onAccountDeleting(async (hookDb, accountId) => {
    // Read through the same DB, so the hook sees the store as it is when it runs: whole.
    const still = await getAccount(hookDb, accountId);
    seen.push({ accountId, present: Boolean(still), messages: await countFor(hookDb, "mail_messages", "account_id", accountId) });
  });
  try {
    assert.deepEqual(await deleteAccount(db, gone.id), { messages: 1 });
  } finally {
    stop();
    _resetAccountDeletingHooksForTests();
  }
  assert.deepEqual(seen, [{ accountId: gone.id, present: true, messages: 1 }],
    "the hook ran while the account and its rows were still there");
  assert.equal(await getAccount(db, gone.id), null, "the cascade ran after the hook");

  // A throwing hook stops the delete before its transaction opens: nothing is removed.
  const kept = await createAccount(db, accountInput({ address: "sam@example.com", label: "Sam" }));
  await seedAccountRows(db, kept.id);
  const ran = [];
  onAccountDeleting(async () => { ran.push("first"); });
  onAccountDeleting(async () => {
    ran.push("second");
    throw new MailError("NETWORK", "ECONNRESET");
  });
  try {
    await assert.rejects(() => deleteAccount(db, kept.id), (err) => {
      assert.ok(err instanceof MailError);
      assert.equal(err.code, "NETWORK");
      return true;
    });
  } finally {
    _resetAccountDeletingHooksForTests();
  }
  assert.deepEqual(ran, ["first", "second"], "every hook runs in the order it was registered");
  assert.ok(await getAccount(db, kept.id), "the account is still there");
  for (const [table, column] of ROWS) {
    assert.equal(await countFor(db, table, column, kept.id), 1, `${table} still holds its row`);
  }
  assert.equal((await getSyncState(db, kept.id)).state, "idle");
  assert.equal(await isImageAllowed(db, kept.id, "news@example.com"), true);

  // A hook registered again after the clear still runs.
  const again = [];
  onAccountDeleting(async () => { again.push("cleared-then-registered"); });
  try {
    await deleteAccount(db, kept.id);
  } finally {
    _resetAccountDeletingHooksForTests();
  }
  assert.deepEqual(again, ["cleared-then-registered"]);
  assert.equal(await getAccount(db, kept.id), null);
});

test("the same hook registered twice runs once, and its unsubscribe takes it back", async () => {
  const db = await freshDb();
  const account = await createAccount(db, accountInput());
  const calls = [];
  const hook = async (hookDb, accountId) => {
    assert.equal(Boolean(await getAccount(hookDb, accountId)), true, "the account is still there");
    calls.push(accountId);
  };
  try {
    onAccountDeleting(hook);
    onAccountDeleting(hook);
    await deleteAccount(db, account.id);
  } finally {
    _resetAccountDeletingHooksForTests();
  }
  assert.deepEqual(calls, [account.id], "one function is one hook");

  const other = await createAccount(db, accountInput({ address: SAM, label: "Sam" }));
  const taken = [];
  const stop = onAccountDeleting(async () => { taken.push("ran"); });
  assert.equal(typeof stop, "function", "registration answers its unsubscribe");
  stop();
  try {
    await deleteAccount(db, other.id);
  } finally {
    _resetAccountDeletingHooksForTests();
  }
  assert.deepEqual(taken, [], "an unsubscribed hook does not run");
});
// Crow Mail's draft preflight (plan 3, Task 4): what blocks a send before anything is claimed, the
// recipient flags a revision carries (new, changed, a Reply-To that is not the sender), and the reply
// and forward derivation from a message the store already holds.
//
// Harness: the draft store's — a scratch DB built from MAIL_DDL, the account send columns and
// MAIL_DRAFTS_DDL, the real account and draft stores, an injected clock — plus the `contacts` table
// init-db.js gives the instance (newRecipients reads its `email` column) and hand-written raw message
// bytes for the thread attachments the extractor turns into bytes.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { MAIL_DDL, MAIL_ACCOUNT_SEND_COLUMNS, MAIL_DRAFTS_DDL } from "../servers/shared/mail-schema.js";
import { parseAddressListDetailed } from "../servers/gateway/staged/canonical.js";
import { MailError } from "../servers/gateway/mail/errors.js";
import { composeRaw } from "../servers/gateway/mail/adapter/compose.js";
import { createAccount, updateAccount } from "../servers/gateway/mail/store/accounts.js";
import { extractAttachment, safeAttachmentName } from "../servers/gateway/mail/reader/attachments.js";
import { createDraft, listRevisions } from "../servers/gateway/mail/drafts/store.js";
import { MAX_SEND_BYTES, preflight } from "../servers/gateway/mail/drafts/preflight.js";
import {
  changedRecipients, deriveForward, deriveReply, newRecipients,
} from "../servers/gateway/mail/drafts/recipients.js";

const ALEX = "alex@example.test";
const SAM = "sam@example.test";
const JO = "jo@example.test";
const HIDDEN = "hidden@example.test";
const HOST = "mail.example.test";
const T0 = 1_700_000_000_000;

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

/** The mail tables, the account send columns, the draft tables and the contacts table init-db builds. */
async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "crow-mail-drafts-preflight-"));
  dirs.push(dir);
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(MAIL_DDL);
  for (const spec of MAIL_ACCOUNT_SEND_COLUMNS) {
    await db.execute({ sql: `ALTER TABLE ${spec.table} ADD COLUMN ${spec.column} ${spec.definition}`, args: [] });
  }
  await db.executeMultiple(MAIL_DRAFTS_DDL);
  // The columns init-db.js gives `contacts` that this task reads: newRecipients treats an address in
  // the address book as one Crow has used before.
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crow_id TEXT NOT NULL UNIQUE,
      display_name TEXT,
      ed25519_pubkey TEXT NOT NULL,
      secp256k1_pubkey TEXT NOT NULL,
      email TEXT
    );
  `);
  return db;
}

async function makeAccount(db, overrides = {}) {
  const account = await createAccount(db, {
    label: "Alex",
    address: ALEX,
    imap: { host: HOST, port: 993, security: "ssl" },
    smtp: { host: HOST, port: 465, security: "ssl" },
    ...overrides,
  });
  return updateAccount(db, account.id, {
    displayName: overrides.displayName ?? "Alex",
    ...(overrides.aliases ? { aliases: overrides.aliases } : {}),
  });
}

/** A RevisionInput for a reply to sam@example.test. */
function revInput(overrides = {}) {
  return {
    to: [{ address: SAM }],
    cc: [],
    bcc: [],
    subject: "Re: Tuesday",
    body: "Hello Sam,\n\nTuesday works for me.\n",
    inReplyTo: "<m1@mail.example.test>",
    references: ["<m0@mail.example.test>"],
    attachments: [],
    ...overrides,
  };
}

/** A draft and its head revision, as the card and the send service hand them to preflight. */
async function makeDraft(db, account, overrides = {}) {
  const draft = await createDraft(db, {
    accountId: account.id,
    mode: overrides.mode ?? "reply",
    replyToMid: overrides.replyToMid ?? "<m1@mail.example.test>",
    threadKey: "thread-1",
    chatThreadId: "chat-1",
    first: overrides.first ?? revInput(),
    author: "bot",
  }, { now: () => T0 });
  const [rev] = await listRevisions(db, draft.id);
  return { account, draft, rev };
}

async function seedFolder(db, accountId, { path, name, specialUse }) {
  const result = await db.execute({
    sql: `INSERT INTO mail_folders (account_id, path, name, special_use, delimiter)
          VALUES (?, ?, ?, ?, '/')`,
    args: [accountId, path, name, specialUse],
  });
  return Number(result.lastInsertRowid);
}

/** One stored message, written the way a sync writes it (only the columns this task reads). */
async function seedMessage(db, accountId, folderId, {
  uid, messageId, fromAddr = ALEX, fromName = "Alex", to = [], cc = [], replyTo = [],
  subject = "Tuesday", bodyText = "Tuesday works for me.", date = T0,
}) {
  await db.execute({
    sql: `INSERT INTO mail_messages
            (account_id, folder_id, uid, message_id, subject, from_name, from_addr, from_text,
             to_json, cc_json, reply_to_json, to_text, date, body_text, snippet)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      accountId, folderId, uid, messageId, subject, fromName, fromAddr, `${fromName} ${fromAddr}`,
      JSON.stringify(to), JSON.stringify(cc), JSON.stringify(replyTo), "", date, bodyText, bodyText,
    ],
  });
}

/* ----------------------------------------------------------------- raw messages */

const BOUNDARY = "b1";

/**
 * A multipart message with a text part and one attachment. `filenameHeader` replaces the generated
 * filename parameter verbatim, so a test can send the RFC 2231 form (the one that carries any name).
 */
function rawWithAttachment({ bytes, filename = null, filenameHeader = null }) {
  const nameParam = filenameHeader !== null ? filenameHeader : (filename ? `; filename="${filename}"` : "");
  return Buffer.from([
    `From: Sam <${SAM}>`,
    `To: Alex <${ALEX}>`,
    "Subject: Files",
    "Date: Wed, 01 Oct 2025 10:00:00 +0000",
    "Message-ID: <files-1@mail.example.test>",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${BOUNDARY}"`,
    "",
    `--${BOUNDARY}`,
    'Content-Type: text/plain; charset="utf-8"',
    "",
    "Hello there",
    `--${BOUNDARY}`,
    `Content-Type: text/plain${filename ? `; name="${filename}"` : ""}`,
    `Content-Disposition: attachment${nameParam}`,
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(bytes).toString("base64"),
    `--${BOUNDARY}--`,
    "",
  ].join("\r\n"), "utf8");
}

const THREAD_MID = "<files-1@mail.example.test>";

/** A thread attachment ref: the stored message, by its Message-ID, and one part of it. */
function threadRef(index = 0, filename = "notes.txt") {
  return { source: "thread", accountId: "any", mid: THREAD_MID, index, filename, size: null };
}

/** The header lines of a raw message, so one field's occurrences can be counted. */
function headersNamed(raw, name) {
  return raw.split("\r\n")
    .filter((line) => /^[!-9;-~]+:/.test(line))
    .filter((line) => line.slice(0, line.indexOf(":")).trim().toLowerCase() === name);
}

function rejected(result) {
  assert.equal(result.ok, false);
  assert.equal(result.message, undefined);
  assert.equal(result.attachDigest, undefined);
  return result;
}

/* ----------------------------------------------------------------- preflight */

test("unfilled [bracket] blocks send", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const { draft, rev } = await makeDraft(db, account, {
    first: revInput({
      subject: "Tuesday [Meeting Time]",
      body: "Hi Sam,\n\n[Your Name], and again [Meeting Time].\n",
    }),
  });

  const result = rejected(await preflight(db, draft, rev, { accountId: account.id }));
  assert.equal(result.code, "placeholders");
  assert.deepEqual(result.detail, ["[Meeting Time]", "[Your Name]"],
    "the detail names the unfilled brackets, each once, subject first");

  // A Markdown link is a link, not a placeholder: the same draft without brackets sends.
  const { draft: clean, rev: cleanRev } = await makeDraft(db, account, {
    first: revInput({ body: "Hi Sam,\n\n[the agenda](https://example.test/agenda)\n" }),
  });
  const ok = await preflight(db, clean, cleanRev, { accountId: account.id });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.flags.changedRecipients, [SAM], "a first revision adds every address it carries");
});

test("empty To is refused", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const { draft, rev } = await makeDraft(db, account, { first: revInput({ to: [], cc: [{ address: JO }] }) });

  const result = rejected(await preflight(db, draft, rev, { accountId: account.id }));
  assert.equal(result.code, "no_recipients", "a Cc with nobody in To is not a message");

  const bccOnly = rejected(await preflight(db, draft, { ...rev, cc: [], bcc: [{ address: JO }] }, {
    accountId: account.id,
  }));
  assert.equal(bccOnly.code, "no_recipients");
});

test("address with CRLF or angle brackets is refused", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const { draft, rev } = await makeDraft(db, account);

  const injected = `sam@example.test\r\nBcc: ${HIDDEN}`;
  const crlf = rejected(await preflight(db, draft, { ...rev, to: [{ name: null, address: injected }] }, {
    accountId: account.id,
  }));
  assert.equal(crlf.code, "bad_address");
  assert.deepEqual(crlf.detail, [injected], "the detail carries the offending token");

  const angled = `Sam <${SAM}>`;
  const brackets = rejected(await preflight(db, draft, { ...rev, to: [{ name: null, address: angled }] }, {
    accountId: account.id,
  }));
  assert.equal(brackets.code, "bad_address");
  assert.deepEqual(brackets.detail, [angled]);

  // A display name is text, not an address: the same header read by the RFC 5322 parser is one
  // address, and only that address may enter a revision.
  const parsed = parseAddressListDetailed(`"${ALEX}" <${SAM}>`);
  assert.deepEqual(parsed.addresses, [SAM]);
  assert.deepEqual(parsed.invalid, []);
});

test("display-name trick \"a@x.test\" <b@y.test> is parsed as one address b@y.test and flagged as changed", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);

  // A trick name that is itself an address: the RFC 5322 reader keeps the angle-addr and drops the
  // name, so the revision widens to b@y.test (sam@example.test here) and nothing else.
  const parsed = parseAddressListDetailed(`"${ALEX}" <${SAM}>`);
  assert.deepEqual(parsed.addresses, [SAM], "the angle-addr is the recipient");
  assert.deepEqual(parsed.invalid, []);
  assert.equal(parsed.addresses.includes(ALEX), false, "the display name is not a recipient");

  const previous = { ...revInput({ to: [{ address: ALEX }], cc: [], bcc: [] }), rev: 1 };
  const widened = { ...revInput({ to: parsed.addresses.map((address) => ({ address })) }), rev: 2 };
  assert.deepEqual(changedRecipients(previous, widened), [SAM], "the card marks the swap");

  // And the preflight of that revision carries it as an ordinary recipient.
  const { draft, rev } = await makeDraft(db, account, {
    first: revInput({ to: parsed.addresses.map((address) => ({ address })) }),
  });
  const result = await preflight(db, draft, rev, { accountId: account.id });
  assert.equal(result.ok, true);
  assert.deepEqual(result.message.to, [{ name: null, address: SAM }]);
});

test("from is always the account address even if the draft supplies one", async () => {
  const db = await freshDb();
  const account = await makeAccount(db, { displayName: "Alex Rivera" });
  const { draft, rev } = await makeDraft(db, account);

  // The revision names another display name over an address that is the account's: the message's From
  // is the account's own address and display name, never the revision's.
  const result = await preflight(db, draft, { ...rev, from: { name: "Sam", address: ALEX } }, {
    accountId: account.id,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.message.from, { name: "Alex Rivera", address: ALEX });
  // The From a tap seals is the account's address and its display name, resolved in one place.
  assert.equal(result.fromAddress, `${ALEX}\nAlex Rivera`);
  assert.equal(result.message.html, null, "html is never set");
});

test("the sealed From carries the account's display name, so a renaming is a different From", async () => {
  const db = await freshDb();
  const account = await makeAccount(db, { displayName: "Alex Rivera" });
  const { draft, rev } = await makeDraft(db, account);

  const before = await preflight(db, draft, rev, { accountId: account.id });
  assert.equal(before.ok, true);
  assert.equal(before.fromAddress, `${ALEX}\nAlex Rivera`);

  await db.execute({ sql: "UPDATE mail_accounts SET display_name = ? WHERE id = ?", args: ["Alex Other", account.id] });
  const after = await preflight(db, draft, rev, { accountId: account.id });
  assert.equal(after.ok, true);
  assert.equal(after.fromAddress, `${ALEX}\nAlex Other`);
  assert.notEqual(after.fromAddress, before.fromAddress, "a renamed account is a different From");

  // An account with no display name has one spelling too, so the seal still compares equal to itself.
  await db.execute({ sql: "UPDATE mail_accounts SET display_name = NULL WHERE id = ?", args: [account.id] });
  const unnamed = await preflight(db, draft, rev, { accountId: account.id });
  assert.equal(unnamed.ok, true);
  assert.equal(unnamed.fromAddress, `${ALEX}\n`);
});

test("a rename that only adds a control character or spacing seals and sends the same name", async () => {
  const db = await freshDb();
  const account = await makeAccount(db, { displayName: "Alex Rivera" });
  const { draft, rev } = await makeDraft(db, account);

  // The sealed name is the part of the sealed From after the address, and the name on the message has
  // to be that same text: one normaliser spells both, so they can never disagree.
  const read = async () => {
    const result = await preflight(db, draft, rev, { accountId: account.id });
    assert.equal(result.ok, true);
    const name = result.fromAddress.slice(result.fromAddress.indexOf("\n") + 1);
    assert.equal(result.message.from.name, name === "" ? null : name);
    return { sealed: result.fromAddress, sent: result.message.from.name };
  };

  const base = await read();
  assert.deepEqual(base, { sealed: `${ALEX}\nAlex Rivera`, sent: "Alex Rivera" });

  // Each of these is the same name carrying a control character or a second run of spaces. Written
  // straight to the account row, so it is the store's own normalising that is not in the way here.
  for (const displayName of ["Alex  Rivera", "Alex\tRivera", "Alex\nRivera", "Alex\u0000Rivera", " Alex Rivera "]) {
    await db.execute({ sql: "UPDATE mail_accounts SET display_name = ? WHERE id = ?", args: [displayName, account.id] });
    assert.deepEqual(await read(), base, JSON.stringify(displayName));
  }
});

test("a draft whose account address no longer matches the head revision's from address is refused bad_input", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const { draft, rev } = await makeDraft(db, account);

  // A forged account id: the draft does not belong to that account at all.
  const forged = rejected(await preflight(db, draft, rev, { accountId: "ma-0000000000000000" }));
  assert.equal(forged.code, "bad_input");

  // The account's address moved on after the revision was written.
  await db.execute({ sql: "UPDATE mail_accounts SET address = ? WHERE id = ?", args: ["alex.new@example.test", account.id] });
  const moved = rejected(await preflight(db, draft, rev, { accountId: account.id }));
  assert.equal(moved.code, "bad_input");
});

test("a revision that belongs to another draft is refused bad_input", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const { draft, rev } = await makeDraft(db, account);
  const { draft: other } = await makeDraft(db, account, { first: revInput({ subject: "Re: Wednesday" }) });
  assert.notEqual(other.id, draft.id);

  const own = await preflight(db, draft, rev, { accountId: account.id });
  assert.equal(own.ok, true, "the draft's own revision passes");

  const foreign = rejected(await preflight(db, draft, { ...rev, draftId: other.id }, { accountId: account.id }));
  assert.equal(foreign.code, "bad_input", "another draft's revision names another body and audience");

  // The revision row's own column is `draft_id`, which the store reads back as `draftId`; a caller that
  // hands the stored row over is read the same way.
  const columnForm = rejected(await preflight(db, draft, { ...rev, draftId: undefined, draft_id: other.id }, {
    accountId: account.id,
  }));
  assert.equal(columnForm.code, "bad_input");

  const unnamed = rejected(await preflight(db, draft, { ...rev, draftId: undefined }, { accountId: account.id }));
  assert.equal(unnamed.code, "bad_input", "a revision that names no draft is not this draft's");
});

test("subject CRLF becomes one space", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const { draft, rev } = await makeDraft(db, account);

  const result = await preflight(db, draft, { ...rev, subject: `Tuesday\r\nplans\r\nBcc: ${HIDDEN}` }, {
    accountId: account.id,
  });
  assert.equal(result.ok, true);
  assert.equal(result.message.subject, `Tuesday plans Bcc: ${HIDDEN}`, "the run collapses to one space");
  assert.equal(/[\r\n]/.test(result.message.subject), false, "no CR or LF reaches the header");
});

/* --------------------------------------------------------------- recipients */

test("reply-all drops own address and aliases", async () => {
  const db = await freshDb();
  const account = await makeAccount(db, { aliases: ["alex.alias@example.test"] });
  const message = {
    accountId: account.id,
    messageId: "<parent-1@mail.example.test>",
    fromName: "Sam",
    fromAddr: SAM,
    to: [{ address: ALEX }, { address: JO }],
    cc: [{ address: "ALEX.ALIAS@example.test" }, { address: "kim@example.test" }],
    replyTo: [],
    references: ["<m0@mail.example.test>"],
    subject: "Tuesday",
    date: T0,
  };

  const replyAll = deriveReply(message, account, { all: true });
  assert.deepEqual(replyAll.to, [{ name: "Sam", address: SAM }]);
  assert.deepEqual(replyAll.cc, [
    { name: null, address: JO },
    { name: null, address: "kim@example.test" },
  ], "own address and aliases are gone, in any case");

  const one = deriveReply(message, account, {});
  assert.deepEqual(one.to, [{ name: "Sam", address: SAM }]);
  assert.deepEqual(one.cc, [], "a single reply copies nobody");
  assert.equal(one.inReplyTo, "<parent-1@mail.example.test>");

  // The same rule through the card's own flag.
  const inbox = await seedFolder(db, account.id, { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" });
  await seedMessage(db, account.id, inbox, {
    uid: 1, messageId: "<parent-1@mail.example.test>", fromAddr: SAM, fromName: "Sam",
    to: [{ address: ALEX }, { address: JO }],
    cc: [{ address: "alex.alias@example.test" }],
  });
  const { draft, rev } = await makeDraft(db, account, {
    mode: "reply_all",
    replyToMid: "<parent-1@mail.example.test>",
  });
  const result = await preflight(db, draft, rev, { accountId: account.id });
  assert.equal(result.ok, true);
  assert.equal(result.flags.replyToDiffers, null);
});

test("a reply to one of the account's own addresses falls back to the message's To list", async () => {
  const db = await freshDb();
  const account = await makeAccount(db, { aliases: ["alex.alias@example.test"] });
  const own = {
    accountId: account.id,
    messageId: "<parent-1@mail.example.test>",
    fromName: "Alex",
    fromAddr: "ALEX@example.test",
    to: [
      { name: "Sam", address: SAM },
      { address: ALEX },
      { address: "Alex.Alias@example.test" },
      { address: JO },
    ],
    cc: [{ address: "kim@example.test" }],
    replyTo: [],
    references: [],
    subject: "Tuesday",
    date: T0,
  };

  const reply = deriveReply(own, account, {});
  assert.deepEqual(reply.to, [{ name: "Sam", address: SAM }, { name: null, address: JO }],
    "the sender is this account, so the reply goes to the people the message was addressed to");
  assert.deepEqual(reply.cc, [], "a single reply copies nobody");
  assert.equal(reply.replyToDiffers, null);

  const all = deriveReply(own, account, { all: true });
  assert.deepEqual(all.to, [{ name: "Sam", address: SAM }, { name: null, address: JO }]);
  assert.deepEqual(all.cc, [{ name: null, address: "kim@example.test" }],
    "the original Cc stays, the account's own addresses do not");

  // A Reply-To naming one of the account's own addresses is the same situation.
  const viaReplyTo = deriveReply({ ...own, fromAddr: SAM, fromName: "Sam", replyTo: [{ address: ALEX }] }, account, {});
  assert.deepEqual(viaReplyTo.to, [{ name: "Sam", address: SAM }, { name: null, address: JO }]);
  assert.equal(viaReplyTo.replyToDiffers, null,
    "the card's Reply-To line only names an address the reply actually goes to");

  // Somebody else's message is unaffected: the reply goes to its sender alone.
  const theirs = deriveReply({ ...own, fromAddr: SAM, fromName: "Sam", to: [{ address: ALEX }] }, account, {});
  assert.deepEqual(theirs.to, [{ name: "Sam", address: SAM }]);
});

test("a Reply-To on the message routes the reply to it and sets replyToDiffers", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const parent = {
    accountId: account.id,
    messageId: "<parent-1@mail.example.test>",
    fromName: "Sam",
    fromAddr: SAM,
    to: [{ address: ALEX }],
    cc: [],
    replyTo: [{ name: null, address: "team@example.test" }],
    references: ["<m0@mail.example.test>"],
    subject: "Tuesday",
    date: T0,
  };

  const reply = deriveReply(parent, account, {});
  assert.deepEqual(reply.to, [{ name: null, address: "team@example.test" }]);
  assert.equal(reply.replyToDiffers, "team@example.test", "the card's line names the real destination");

  const inbox = await seedFolder(db, account.id, { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" });
  await seedMessage(db, account.id, inbox, {
    uid: 1,
    messageId: "<parent-1@mail.example.test>",
    fromAddr: SAM,
    fromName: "Sam",
    to: [{ address: ALEX }],
    replyTo: [{ name: null, address: "team@example.test" }],
  });
  const { draft, rev } = await makeDraft(db, account, { replyToMid: "<parent-1@mail.example.test>" });
  const result = await preflight(db, draft, rev, { accountId: account.id });
  assert.equal(result.ok, true);
  assert.equal(result.flags.replyToDiffers, "team@example.test");
});

test("no Reply-To, or one equal to the sender, leaves replyToDiffers null", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const base = {
    accountId: account.id,
    messageId: "<parent-1@mail.example.test>",
    fromName: "Sam",
    fromAddr: SAM,
    to: [{ address: ALEX }],
    cc: [],
    references: [],
    subject: "Tuesday",
    date: T0,
  };

  assert.equal(deriveReply({ ...base, replyTo: [] }, account, {}).replyToDiffers, null);
  assert.equal(deriveReply({ ...base, replyTo: null }, account, {}).replyToDiffers, null);
  assert.equal(deriveReply({ ...base, replyTo: [{ address: "SAM@example.test" }] }, account, {}).replyToDiffers, null,
    "a Reply-To that is the sender changes nothing");
});

test("Re: is not doubled", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const message = {
    accountId: account.id,
    messageId: "<parent-1@mail.example.test>",
    fromName: "Sam",
    fromAddr: SAM,
    to: [{ address: ALEX }],
    cc: [],
    replyTo: [],
    references: [],
    subject: "Tuesday",
    date: T0,
  };

  assert.equal(deriveReply({ ...message, subject: "Tuesday" }, account, {}).subject, "Re: Tuesday");
  assert.equal(deriveReply({ ...message, subject: "Re: Tuesday" }, account, {}).subject, "Re: Tuesday");
  assert.equal(deriveReply({ ...message, subject: "RE: Tuesday" }, account, {}).subject, "RE: Tuesday",
    "a prefix already there is kept as it was written");
  assert.equal(deriveReply({ ...message, subject: "re: Re: Tuesday" }, account, {}).subject, "re: Re: Tuesday");
});

test("references trimmed to the last 50", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const many = Array.from({ length: 60 }, (_, index) => `<r${index}@mail.example.test>`);
  const message = {
    accountId: account.id,
    messageId: "<parent-1@mail.example.test>",
    fromName: "Sam",
    fromAddr: SAM,
    to: [{ address: ALEX }],
    cc: [],
    replyTo: [],
    references: many,
    subject: "Tuesday",
    bodyText: "Tuesday works for me.",
    date: T0,
  };

  const reply = deriveReply(message, account, {});
  assert.equal(reply.references.length, 50);
  assert.deepEqual(reply.references, [...many, "<parent-1@mail.example.test>"].slice(-50),
    "the parent's Message-ID joins the chain and the tail is what survives");
  assert.equal(reply.references.includes("<r9@mail.example.test>"), false);

  const forward = deriveForward({ ...message, attachments: [{ filename: "notes.txt", contentType: "text/plain", size: 12 }] });
  assert.equal(forward.subject, "Fwd: Tuesday");
  assert.match(forward.quotedBody, /Tuesday works for me\./);
  assert.deepEqual(forward.attachments, [{
    source: "thread",
    accountId: account.id,
    mid: "<parent-1@mail.example.test>",
    index: 0,
    filename: "notes.txt",
    size: 12,
  }]);
});

test("new recipient flag: an address present only in a Drafts-folder message is still new", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const sent = await seedFolder(db, account.id, { path: "Sent", name: "Sent", specialUse: "\\Sent" });
  const draftFolder = await seedFolder(db, account.id, { path: "Drafts", name: "Drafts", specialUse: "\\Drafts" });

  await seedMessage(db, account.id, sent, { uid: 1, messageId: "<s1@mail.example.test>", to: [{ address: JO }] });
  await seedMessage(db, account.id, draftFolder, { uid: 1, messageId: "<d1@mail.example.test>", to: [{ address: SAM }] });

  assert.deepEqual(await newRecipients(db, account.id, [{ address: JO }, { address: SAM }]), [SAM],
    "a recipient of a draft Crow never sent is new");

  // The address book counts as "mailed before".
  await db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, email)
          VALUES (?, ?, ?, ?, ?)`,
    args: ["crow-1", "Kim", "pk-ed", "pk-sec", "kim@example.test"],
  });
  assert.deepEqual(await newRecipients(db, account.id, [{ address: "kim@example.test" }]), []);

  // The card's flag is the same answer.
  const { draft, rev } = await makeDraft(db, account, {
    first: revInput({ to: [{ address: JO }, { address: HIDDEN }] }),
  });
  const result = await preflight(db, draft, rev, { accountId: account.id });
  assert.equal(result.ok, true);
  assert.deepEqual(result.flags.newRecipients, [HIDDEN]);
});

test("an address on another domain that was mailed before is not flagged", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const sent = await seedFolder(db, account.id, { path: "Sent", name: "Sent Messages", specialUse: "\\Sent" });
  const partner = "partner@other.example.test";
  await seedMessage(db, account.id, sent, {
    uid: 1,
    messageId: "<s1@mail.example.test>",
    to: [{ address: partner }],
    cc: [{ address: "cc@third.example.test" }],
  });

  assert.deepEqual(await newRecipients(db, account.id, [
    { address: partner }, { address: "cc@third.example.test" }, { address: SAM },
  ]), [SAM], "only the address Crow has never used is new: there is no domain rule");

  const other = await makeAccount(db, { label: "Work", address: "alex@work.example.test" });
  assert.deepEqual(await newRecipients(db, other.id, [{ address: partner }]), [partner],
    "another account's Sent folder is not this account's history");
});

test("a Sent folder named without the special-use flag still counts", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  // A server whose Sent folder is only a name: no \\Sent flag anywhere in the mailbox.
  const sent = await seedFolder(db, account.id, { path: "Sent Messages", name: "Sent Messages", specialUse: null });
  await seedMessage(db, account.id, sent, { uid: 1, messageId: "<s1@mail.example.test>", to: [{ address: JO }] });

  assert.deepEqual(await newRecipients(db, account.id, [{ address: JO }, { address: SAM }]), [SAM],
    "the Sent role is decided by folderRole, not only by the special-use flag");

  // An account with no Sent folder at all: the Sent half is empty and the address book still counts.
  await db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, email)
          VALUES (?, ?, ?, ?, ?)`,
    args: ["crow-2", "Kim", "pk-ed-2", "pk-sec-2", "kim@example.test"],
  });
  const bare = await makeAccount(db, { label: "Bare", address: "alex@bare.example.test" });
  assert.deepEqual(await newRecipients(db, bare.id, [{ address: JO }, { address: "kim@example.test" }]),
    [JO], "without a Sent folder only the address book is history");
});

test("addresses are compared in any case, in a Sent message and in the address book", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const sent = await seedFolder(db, account.id, { path: "Sent", name: "Sent", specialUse: "\\Sent" });
  await seedMessage(db, account.id, sent, {
    uid: 1,
    messageId: "<s1@mail.example.test>",
    fromAddr: "Alex@Example.TEST",
    to: [{ name: "Jo", address: "JO@Example.TEST" }],
    cc: [{ address: "CC@Example.TEST" }],
  });
  await db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, email)
          VALUES (?, ?, ?, ?, ?)`,
    args: ["crow-1", "Kim", "pk-ed", "pk-sec", "Kim@Example.TEST"],
  });

  assert.deepEqual(await newRecipients(db, account.id, [
    { address: "jo@example.test" },
    { address: "cc@example.test" },
    { address: "alex@example.test" },
    { address: "kim@example.test" },
    { address: "sam@example.test" },
  ]), [SAM], "only the address that appears in no case anywhere is new");

  // The card's flag agrees.
  const { draft, rev } = await makeDraft(db, account, {
    first: revInput({ to: [{ address: "JO@Example.TEST" }, { address: "SAM@Example.TEST" }] }),
  });
  const result = await preflight(db, draft, rev, { accountId: account.id });
  assert.equal(result.ok, true);
  assert.deepEqual(result.flags.newRecipients, [SAM]);
});

/* -------------------------------------------------------------- attachments */

test("total attachment size over 18 MiB gives too_large", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const { draft, rev } = await makeDraft(db, account);
  const ref = { source: "storage", fileId: "f-big", filename: "big.bin", size: MAX_SEND_BYTES + 1 };
  const huge = { ...rev, attachments: [ref] };

  assert.equal(MAX_SEND_BYTES, 18 * 1024 * 1024);

  const result = rejected(await preflight(db, draft, huge, {
    accountId: account.id,
    deps: { readStorageFile: async () => Buffer.alloc(MAX_SEND_BYTES + 1) },
  }));
  assert.equal(result.code, "too_large");

  const small = await preflight(db, draft, { ...rev, attachments: [{ ...ref, fileId: "f-small" }] }, {
    accountId: account.id,
    deps: { readStorageFile: async () => Buffer.from("a small file") },
  });
  assert.equal(small.ok, true, "a file inside the ceiling sends");

  // Without a storage reader a storage attachment cannot be resolved at all.
  const unresolved = rejected(await preflight(db, draft, { ...rev, attachments: [{ ...ref, size: 8 }] }, {
    accountId: account.id,
  }));
  assert.equal(unresolved.code, "bad_input");
});

test("attachDigest changes when a thread attachment's bytes change", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const inbox = await seedFolder(db, account.id, { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" });
  await seedMessage(db, account.id, inbox, {
    uid: 1, messageId: THREAD_MID, fromAddr: SAM, fromName: "Sam", subject: "Files",
  });

  const { draft, rev } = await makeDraft(db, account, {
    first: revInput({ attachments: [threadRef()] }),
  });
  const withBytes = (bytes) => ({
    readMessageRaw: async () => rawWithAttachment({ bytes, filename: "notes.txt" }),
  });

  const first = await preflight(db, draft, rev, { accountId: account.id, deps: withBytes("first version") });
  assert.equal(first.ok, true);
  assert.match(first.attachDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(first.message.attachments[0].content, Buffer.from("first version"));
  assert.equal(first.message.attachments[0].filename, "notes.txt");

  const again = await preflight(db, draft, rev, { accountId: account.id, deps: withBytes("first version") });
  assert.equal(again.attachDigest, first.attachDigest, "the same bytes give the same digest");

  const changed = await preflight(db, draft, rev, { accountId: account.id, deps: withBytes("second version") });
  assert.notEqual(changed.attachDigest, first.attachDigest, "the digest follows the bytes");

  // A thread ref this account does not hold, and a thread ref with no reader, are both refused.
  const missing = rejected(await preflight(db, draft, { ...rev, attachments: [threadRef(1)] }, {
    accountId: account.id, deps: withBytes("first version"),
  }));
  assert.equal(missing.code, "bad_input");
  const noReader = rejected(await preflight(db, draft, rev, { accountId: account.id }));
  assert.equal(noReader.code, "bad_input");
});

test("attachDigest frames each attachment's name, type and bytes", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const { draft, rev } = await makeDraft(db, account);

  const two = (firstFile, secondFile, firstBytes, secondBytes) => {
    const files = { [firstFile]: Buffer.from(firstBytes), [secondFile]: Buffer.from(secondBytes) };
    const attachments = [firstFile, secondFile].map((fileId) => ({
      source: "storage", fileId, filename: fileId, size: files[fileId].length,
    }));
    return preflight(db, draft, { ...rev, attachments }, {
      accountId: account.id,
      deps: { readStorageFile: async (fileId) => files[fileId] },
    });
  };

  const base = await two("a.txt", "b.txt", "ab", "c");
  assert.equal(base.ok, true);
  assert.match(base.attachDigest, /^[0-9a-f]{64}$/);
  const same = await two("a.txt", "b.txt", "ab", "c");
  assert.equal(same.attachDigest, base.attachDigest, "the same attachments give the same digest");

  // "ab" then "c" and "a" then "bc": the same bytes, one boundary moved.
  const moved = await two("a.txt", "b.txt", "a", "bc");
  assert.equal(moved.ok, true);
  assert.notEqual(moved.attachDigest, base.attachDigest, "where one attachment ends is part of the digest");

  // The same bytes with the two names swapped.
  const swappedNames = await two("b.txt", "a.txt", "ab", "c");
  assert.equal(swappedNames.ok, true);
  assert.notEqual(swappedNames.attachDigest, base.attachDigest, "a name belongs to its own attachment");
  assert.notEqual(swappedNames.attachDigest, moved.attachDigest);
});

test("a throwing attachment reader refuses the draft instead of throwing out of preflight", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const inbox = await seedFolder(db, account.id, { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" });
  await seedMessage(db, account.id, inbox, {
    uid: 1, messageId: THREAD_MID, fromAddr: SAM, fromName: "Sam", subject: "Files",
  });
  const { draft, rev } = await makeDraft(db, account, { first: revInput({ attachments: [threadRef()] }) });

  const unreachable = rejected(await preflight(db, draft, rev, {
    accountId: account.id,
    deps: { readMessageRaw: async () => { throw new MailError("NETWORK"); } },
  }));
  assert.equal(unreachable.code, "attachment_unavailable",
    "the message is here, this Crow cannot reach the server to read its part");

  const slow = rejected(await preflight(db, draft, rev, {
    accountId: account.id,
    deps: { readMessageRaw: async () => { throw new MailError("TIMEOUT"); } },
  }));
  assert.equal(slow.code, "attachment_unavailable");

  const broken = rejected(await preflight(db, draft, rev, {
    accountId: account.id,
    deps: { readMessageRaw: async () => { throw new Error("reader failed"); } },
  }));
  assert.equal(broken.code, "bad_input", "anything that is not a network or timeout failure is a refusal");

  // The storage reader is caught the same way.
  const stored = { ...rev, attachments: [{ source: "storage", fileId: "f-1", filename: "notes.txt", size: 5 }] };
  const storedUnreachable = rejected(await preflight(db, draft, stored, {
    accountId: account.id,
    deps: { readStorageFile: async () => { throw new MailError("NETWORK"); } },
  }));
  assert.equal(storedUnreachable.code, "attachment_unavailable");

  const storedSlow = rejected(await preflight(db, draft, stored, {
    accountId: account.id,
    deps: { readStorageFile: async () => { throw new MailError("TIMEOUT"); } },
  }));
  assert.equal(storedSlow.code, "attachment_unavailable");

  const storedBroken = rejected(await preflight(db, draft, stored, {
    accountId: account.id,
    deps: { readStorageFile: async () => { throw new Error("reader failed"); } },
  }));
  assert.equal(storedBroken.code, "bad_input");
});

test("attachment filename with ../ or CRLF is sanitized", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const nasty = "../../se\"cret\r\nname.txt";
  const { draft, rev } = await makeDraft(db, account);

  const fromStorage = await preflight(db, draft, {
    ...rev,
    attachments: [{ source: "storage", fileId: "f-1", filename: nasty, size: 8 }],
  }, {
    accountId: account.id,
    deps: { readStorageFile: async () => Buffer.from("bytes") },
  });
  assert.equal(fromStorage.ok, true);
  assert.equal(fromStorage.message.attachments[0].filename, safeAttachmentName(nasty));
  assert.equal(fromStorage.message.attachments[0].filename, "....secretname.txt");

  const inbox = await seedFolder(db, account.id, { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" });
  await seedMessage(db, account.id, inbox, {
    uid: 1, messageId: THREAD_MID, fromAddr: SAM, fromName: "Sam", subject: "Files",
  });
  const raw = rawWithAttachment({
    bytes: "attachment bytes",
    filenameHeader: "; filename*=UTF-8''..%2F..%2Fse%22cret%0D%0Aname.txt",
  });
  const extracted = await extractAttachment(raw, 0);
  const fromThread = await preflight(db, draft, { ...rev, attachments: [threadRef()] }, {
    accountId: account.id,
    deps: { readMessageRaw: async () => raw },
  });
  assert.equal(fromThread.ok, true);
  const name = fromThread.message.attachments[0].filename;
  assert.equal(name, safeAttachmentName(extracted.filename), "the sender's name goes through safeAttachmentName");
  for (const character of ["/", "\\", "\"", "\r", "\n"]) {
    assert.equal(name.includes(character), false, `no ${JSON.stringify(character)} in the filename`);
  }
});

test("the display-name trick \"a@x.test\" <b@y.test> is refused through preflight and flagged as changed", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const token = '"a@x.test" <b@y.test>';

  // What the RFC 5322 reader makes of the token: the angle-addr is the one address, the quoted text
  // before it is a display name and never a recipient.
  const parsed = parseAddressListDetailed(token);
  assert.deepEqual(parsed.addresses, ["b@y.test"]);
  assert.deepEqual(parsed.invalid, []);

  const { draft, rev } = await makeDraft(db, account);

  // Posted whole as one address, the token is not exactly one clean addr-spec: preflight refuses it
  // and names the token it refused.
  const result = rejected(await preflight(db, draft, { ...rev, to: [{ name: null, address: token }] }, {
    accountId: account.id,
  }));
  assert.equal(result.code, "bad_address");
  assert.deepEqual(result.detail, [token]);

  // Read the way the parser reads it, the revision's recipient is b@y.test and that is what the send
  // would be addressed to.
  const widened = { ...rev, to: [{ name: null, address: parsed.addresses[0] }] };
  const accepted = await preflight(db, draft, widened, { accountId: account.id });
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.message.to, [{ name: null, address: "b@y.test" }]);
  assert.deepEqual(accepted.flags.changedRecipients, ["b@y.test"], "a first revision adds every address it carries");

  // The swap itself is what the card marks: a@x.test was on the previous revision, b@y.test was not.
  assert.deepEqual(changedRecipients({ ...rev, to: [{ address: "a@x.test" }] }, widened), ["b@y.test"]);
});

test("bcc never appears in the composed headers", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const sent = await seedFolder(db, account.id, { path: "Sent", name: "Sent", specialUse: "\\Sent" });
  await seedMessage(db, account.id, sent, { uid: 1, messageId: "<s1@mail.example.test>", to: [{ address: SAM }] });
  const { draft, rev } = await makeDraft(db, account, {
    first: revInput({ bcc: [{ address: HIDDEN }] }),
  });

  const result = await preflight(db, draft, rev, { accountId: account.id });
  assert.equal(result.ok, true);
  // The blind recipient is part of the message validateOutgoing sees: the adapter needs it.
  assert.deepEqual(result.message.bcc, [{ name: null, address: HIDDEN }]);

  // The bytes that would go on the wire carry no Bcc.
  const raw = (await composeRaw(result.message, { keepBcc: false })).toString("utf8");
  assert.deepEqual(headersNamed(raw, "bcc"), []);
  assert.equal(raw.includes(HIDDEN), false);
  assert.equal(headersNamed(raw, "to").length, 1, "the visible recipient is there");
  assert.deepEqual(result.flags.newRecipients, [HIDDEN]);
  assert.deepEqual(result.flags.changedRecipients, [SAM, HIDDEN]);
});
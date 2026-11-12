// Crow Mail's outgoing side (Task 13 of plan 1): `send` over the in-process fake SMTP server and
// `saveDraft` over the fake IMAP server, through the imapflow + nodemailer adapter. Every server binds
// 127.0.0.1 port 0, so nothing here depends on a fixed port, a real mailbox or the network.
//
// The tests follow the rules the adapter is built to: `validateOutgoing` runs before any socket exists,
// the message is built from its output alone, the recipient list nodemailer reports comes back in
// `accepted`/`rejected`, and a failure is a fixed sentence that carries no server text, no credential
// and no address. A draft is stored by special-use flag, never by folder name.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { readFileSync } from "node:fs";
import {
  createFakeImapServer, createFakeSmtpServer, makeRaw, FAKE_PASSWORD,
} from "./fixtures/fake-mail-server.mjs";
import { createImapSmtpAdapter } from "../servers/gateway/mail/adapter/imap-smtp.js";
import { MAIL_ERROR_TEXT, MailError } from "../servers/gateway/mail/errors.js";
import { parseRawMessage } from "../servers/gateway/mail/parse.js";

const ACCOUNT_ID = "ma-0123456789abcdef";
const ALEX = "alex@example.com";
const SAM = "sam@example.com";
const KIM = "kim@example.com";
const HIDDEN = "hidden@example.com";
const BLOCKED = "blocked@example.com";
const WRONG_PASSWORD = "not-the-app-password";
const CRLF = "\r\n";

/** Short budgets, so a hung server is a test failure rather than a hung run. */
const FAST = { connectMs: 4000, greetingMs: 4000, socketMs: 4000, commandMs: 4000 };

const openFakes = new Set();
after(async () => {
  for (const fake of openFakes) await fake.close();
  openFakes.clear();
});

async function startSmtp(options) {
  const fake = await createFakeSmtpServer(options);
  openFakes.add(fake);
  return fake;
}

async function startImap(options) {
  const fake = await createFakeImapServer(options);
  openFakes.add(fake);
  return fake;
}

async function stopFake(fake) {
  openFakes.delete(fake);
  await fake.close();
}

const passwordCredentials = (password) => ({ getSecrets: async () => ({ MAIL_PASSWORD: password }) });

/**
 * The account row the adapter consumes. The IMAP endpoint is a loopback port nothing listens on: a
 * send never touches it, and `saveDraft` tests pass their own fake in through `overrides`.
 */
function accountFor(smtpEndpoint, overrides = {}) {
  return {
    id: ACCOUNT_ID,
    label: "Alex",
    address: ALEX,
    imap: { host: "127.0.0.1", port: 1, security: "none" },
    smtp: smtpEndpoint,
    username: ALEX,
    authKind: "password",
    status: "active",
    statusDetail: null,
    windowDays: 90,
    ...overrides,
  };
}

/** An adapter whose SMTP endpoint is the fake server, over loopback with no TLS (as the fake speaks none). */
function adapterFor(fake, overrides = {}) {
  return createImapSmtpAdapter({
    account: accountFor(smtpEndpoint(fake)),
    credentials: passwordCredentials(FAKE_PASSWORD),
    timeouts: FAST,
    ...overrides,
  });
}

/** The account's `smtp` field for a fake server that bound 127.0.0.1 port 0. */
function smtpEndpoint(fake) {
  return { host: fake.host, port: fake.port, security: "none" };
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

async function rejectionOf(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

/** Every field of an error, so a leak anywhere in it is caught. */
function shownError(err) {
  return [err.message, err.code, String(err.detail), String(err), String(err.stack), JSON.stringify(err)].join(" ");
}

/** The header lines of a raw message, one per line, so one field's occurrences can be counted. */
function headerLines(raw) {
  return raw.split(CRLF).filter((line) => /^[!-9;-~]+:/.test(line));
}

const fieldsNamed = (raw, name) => headerLines(raw)
  .filter((line) => line.slice(0, line.indexOf(":")).trim().toLowerCase() === name);

function captureConsole() {
  const lines = [];
  const methods = ["log", "info", "warn", "error", "debug", "trace"];
  const originals = new Map();
  for (const method of methods) {
    originals.set(method, console[method]);
    console[method] = (...args) => { lines.push(args.map((value) => String(value)).join(" ")); };
  }
  return {
    text: () => lines.join("\n"),
    restore: () => { for (const [method, original] of originals) console[method] = original; },
  };
}

/* ------------------------------------------------------------------------- addresses and bodies */

test("to, cc and bcc are all delivered, and the transmitted message carries no Bcc header", async () => {
  const fake = await startSmtp();
  const adapter = adapterFor(fake);
  const result = await adapter.send(outgoing({
    to: [{ address: SAM }],
    cc: [{ name: "Kim", address: KIM }],
    bcc: [{ address: HIDDEN }],
    subject: "Blind copy",
    text: "Three of you, one unnamed.",
  }));

  assert.equal(fake.messages.length, 1, "one message was transmitted");
  const [message] = fake.messages;
  assert.equal(message.from, ALEX);
  assert.deepEqual(message.rcpt, [SAM, KIM, HIDDEN], "the blind recipient is delivered");
  const raw = message.raw;
  assert.deepEqual(fieldsNamed(raw, "bcc"), [], "the blind recipient is not published in the headers");
  assert.equal(fieldsNamed(raw, "to").length, 1);
  assert.equal(fieldsNamed(raw, "cc").length, 1);

  assert.match(result.messageId, /^<[^<>\s@]+@example\.com>$/, "the id is ours, domain from the From address");
  assert.match(raw, /^Message-ID: <[^<>\s@]+@example\.com>$/m, "the same id is in the sent copy");
  assert.equal(raw.includes(result.messageId), true, "the stored copy and the sent copy carry one id");
  assert.deepEqual([...result.accepted].sort(), [SAM, KIM, HIDDEN].sort());
  assert.deepEqual(result.rejected, []);
  await adapter.close();
  await stopFake(fake);
});

test("inReplyTo and references reach the transmitted message", async () => {
  const fake = await startSmtp();
  const adapter = adapterFor(fake);
  await adapter.send(outgoing({
    subject: "Re: the thread",
    inReplyTo: "<parent@example.com>",
    references: ["<root@example.com>", "<parent@example.com>"],
  }));

  const raw = fake.messages[0].raw;
  assert.deepEqual(fieldsNamed(raw, "in-reply-to").length, 1);
  assert.match(raw, /^In-Reply-To: <parent@example\.com>\s*$/m);
  assert.equal(fieldsNamed(raw, "references").length, 1, "one References header, never two");
  assert.ok(raw.includes("<root@example.com>"), "the first id is in References");
  assert.ok(raw.includes("<parent@example.com>"), "the last id is in References");
  assert.deepEqual(fake.messages[0].rcpt, [SAM]);
  await adapter.close();
  await stopFake(fake);
});

test("a unicode subject and body round-trip through parseRawMessage", async () => {
  const fake = await startSmtp();
  const adapter = adapterFor(fake);
  const subject = "Grüße aus München — Rückmeldung";
  const text = "Hallo Sam,\r\n\r\nDanke für die Rückmeldung. Bis bald.";
  await adapter.send(outgoing({ subject, text }));

  const parsed = await parseRawMessage(fake.messages[0].raw);
  assert.equal(parsed.subject, subject, "the subject survives the header encoding");
  assert.equal(parsed.from.address, ALEX);
  assert.deepEqual(parsed.to.map((entry) => entry.address), [SAM]);
  assert.ok(parsed.text.includes("Danke für die Rückmeldung"), "the body survives its transfer encoding");
  assert.equal(parsed.parseError, null);
  await adapter.close();
  await stopFake(fake);
});

test("a subject carrying CRLF and a header attempt yields one Subject and no second recipient", async () => {
  const fake = await startSmtp();
  const adapter = adapterFor(fake);
  await adapter.send(outgoing({ subject: `Quiet${CRLF}Bcc: evil@example.com`, text: "body" }));

  const [message] = fake.messages;
  assert.deepEqual(message.rcpt, [SAM], "the injected attempt names no recipient");
  assert.deepEqual(fieldsNamed(message.raw, "bcc"), [], "no Bcc header was added");
  assert.equal(fieldsNamed(message.raw, "subject").length, 1, "exactly one Subject line");
  assert.ok(message.raw.includes("Quiet"), "the subject's own words are kept");
  await adapter.close();
  await stopFake(fake);
});

test("a ten megabyte attachment is transmitted with its bytes", async () => {
  const fake = await startSmtp();
  const adapter = adapterFor(fake);
  const content = Buffer.alloc(10 * 1024 * 1024, 0x61);
  const result = await adapter.send(outgoing({
    subject: "The big report",
    text: "Attached.",
    attachments: [{ filename: "report.bin", contentType: "application/octet-stream", content }],
  }));

  assert.equal(fake.messages.length, 1);
  const [message] = fake.messages;
  assert.ok(message.raw.length > content.length, "the attachment's bytes are in the transmitted message");
  assert.deepEqual(result.rejected, []);
  assert.match(message.raw, /filename="?report\.bin"?/);
  await adapter.close();
  await stopFake(fake);
});

/* ---------------------------------------------------------------- validation before any socket */

test("an envelope key is BAD_INPUT and opens no connection at all", async () => {
  const fake = await startSmtp();
  const adapter = adapterFor(fake);
  const err = await rejectionOf(adapter.send(outgoing({
    envelope: { from: ALEX, to: [BLOCKED] },
  })));

  assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
  assert.equal(err.code, "BAD_INPUT");
  assert.equal(err.detail, "envelope", "the detail names the specific mistake");
  assert.equal(err.message, MAIL_ERROR_TEXT.BAD_INPUT);
  assert.equal(fake.connectionCount(), 0, "a refused message opens no socket");
  await adapter.close();
  await stopFake(fake);
});

test("an address carrying a second header is BAD_INPUT and nothing is transmitted", async () => {
  const fake = await startSmtp();
  const adapter = adapterFor(fake);
  const err = await rejectionOf(adapter.send(outgoing({
    to: [{ address: `a@example.com>${CRLF}Bcc: x@example.com` }],
  })));

  assert.equal(err.code, "BAD_INPUT");
  assert.equal(err.detail, "to");
  assert.equal(fake.connectionCount(), 0);
  await adapter.close();
  await stopFake(fake);
});

test("a message id, a media type and an unknown key are refused before any connection", async () => {
  const fake = await startSmtp();
  const adapter = adapterFor(fake);
  const refused = [
    ["inReplyTo", { inReplyTo: `<parent@example.com>${CRLF}Bcc: x@example.com` }],
    ["attachments", {
      attachments: [{
        filename: "report.txt",
        contentType: `text/plain${CRLF}Bcc: x@example.com`,
        content: "bytes",
      }],
    }],
    ["field", { headers: { Bcc: "x@example.com" } }],
  ];

  for (const [detail, fields] of refused) {
    const err = await rejectionOf(adapter.send(outgoing(fields)));
    assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
    assert.equal(err.code, "BAD_INPUT");
    assert.equal(err.detail, detail);
  }
  assert.equal(fake.connectionCount(), 0, "no refused message opened a socket");
  assert.equal(fake.messages.length, 0);
  await adapter.close();
  await stopFake(fake);
});

test("cleartext SMTP to a host that is not loopback is BAD_INPUT with no socket opened", async () => {
  const fake = await startSmtp();
  const adapter = createImapSmtpAdapter({
    account: accountFor({ host: "mail.example.test", port: 587, security: "none" }),
    credentials: passwordCredentials(FAKE_PASSWORD),
    timeouts: FAST,
  });
  const err = await rejectionOf(adapter.send(outgoing()));

  assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
  assert.equal(err.code, "BAD_INPUT");
  assert.equal(err.detail, "smtp_security");
  assert.equal(fake.connectionCount(), 0);
  await adapter.close();
  await stopFake(fake);
});

/* ----------------------------------------------------------------------- the server's answers */

test("a rejected recipient is reported in rejected, not thrown", async () => {
  const fake = await startSmtp({ rejectRcpt: (address) => address === BLOCKED });
  const adapter = adapterFor(fake);
  const result = await adapter.send(outgoing({ to: [{ address: SAM }, { address: BLOCKED }] }));

  assert.deepEqual(result.accepted, [SAM]);
  assert.deepEqual(result.rejected, [BLOCKED], "the address the server refused is the caller's own data");
  assert.deepEqual(fake.messages[0].rcpt, [SAM], "the refused recipient received nothing");
  await adapter.close();
  await stopFake(fake);
});

test("a refused SMTP sign-in is AUTH_FAILED and carries neither the password nor the username", async () => {
  const fake = await startSmtp({ users: { [ALEX]: "the-right-app-password" } });
  const adapter = adapterFor(fake, { credentials: passwordCredentials(WRONG_PASSWORD) });
  const err = await rejectionOf(adapter.send(outgoing()));

  assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
  assert.equal(err.code, "AUTH_FAILED");
  assert.equal(err.message, MAIL_ERROR_TEXT.AUTH_FAILED);
  const shown = shownError(err);
  assert.ok(!shown.includes(WRONG_PASSWORD), "the password is nowhere in the error");
  assert.ok(!shown.includes(ALEX), "the username is nowhere in the error");
  assert.equal(fake.messages.length, 0, "nothing was transmitted");
  await adapter.close();
  await stopFake(fake);
});

test("xoauth2 signs in with the provider's token and the server records XOAUTH2", async () => {
  const fake = await startSmtp();
  const calls = [];
  const adapter = createImapSmtpAdapter({
    account: accountFor({ host: fake.host, port: fake.port, security: "none" }, { authKind: "xoauth2" }),
    tokenProvider: async ({ accountId, forceRefresh }) => {
      calls.push({ accountId, forceRefresh });
      return { accessToken: "access-token-1" };
    },
    timeouts: FAST,
  });
  await adapter.send(outgoing());

  assert.deepEqual(calls, [{ accountId: ACCOUNT_ID, forceRefresh: false }]);
  // The fake refuses an empty bearer token, so a recorded XOAUTH2 sign-in is a token that arrived.
  assert.deepEqual(fake.messages.map((message) => message.auth), [{ user: ALEX, method: "XOAUTH2" }]);
  await adapter.close();
  await stopFake(fake);
});

test("STARTTLS an SMTP server does not offer fails TLS and transmits nothing", async () => {
  const fake = await startSmtp();
  const adapter = createImapSmtpAdapter({
    account: accountFor({ host: fake.host, port: fake.port, security: "starttls" }),
    credentials: passwordCredentials(FAKE_PASSWORD),
    timeouts: FAST,
  });
  const err = await rejectionOf(adapter.send(outgoing()));

  assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
  assert.equal(err.code, "TLS");
  assert.equal(err.message, MAIL_ERROR_TEXT.TLS);
  assert.equal(fake.messages.length, 0);
  await adapter.close();
  await stopFake(fake);
});

test("a silenced SMTP server rejects TIMEOUT within the injected greeting deadline", async () => {
  const sockets = new Set();
  const blackhole = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => blackhole.listen(0, "127.0.0.1", resolve));
  const { port } = blackhole.address();
  const adapter = createImapSmtpAdapter({
    account: accountFor({ host: "127.0.0.1", port, security: "none" }),
    credentials: passwordCredentials(FAKE_PASSWORD),
    timeouts: { ...FAST, greetingMs: 200, socketMs: 2000 },
  });
  try {
    const started = Date.now();
    const err = await rejectionOf(adapter.send(outgoing()));
    const elapsed = Date.now() - started;
    assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
    assert.equal(err.code, "TIMEOUT");
    assert.ok(elapsed < 3000, `the deadline fired (${elapsed} ms)`);
    const shown = shownError(err);
    assert.ok(!shown.includes(FAKE_PASSWORD), "no credential in the timeout");
    assert.ok(!shown.includes(SAM), "no recipient address in the timeout");
    for (const field of ["response", "responseText", "command", "executedCommand"]) {
      assert.ok(!Object.hasOwn(err, field), `the library field ${field} does not travel`);
    }
  } finally {
    await adapter.close();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise((resolve) => blackhole.close(resolve));
  }
});

test("sending writes nothing to the console, and never the password", async () => {
  const fake = await startSmtp({ users: { [ALEX]: FAKE_PASSWORD } });
  const adapter = adapterFor(fake);
  const captured = captureConsole();
  try {
    await adapter.send(outgoing());
  } finally {
    captured.restore();
  }
  assert.equal(fake.messages.length, 1, "the message went out while the console was captured");
  assert.ok(!captured.text().includes(FAKE_PASSWORD), "no console line carries the password");
  assert.ok(!captured.text().includes("AUTH"), "no console line carries the sign-in exchange");
  await adapter.close();
  await stopFake(fake);
});

/* ----------------------------------------------------------------------------------- saveDraft */

function imapAdapterFor(imap, overrides = {}) {
  return createImapSmtpAdapter({
    account: accountFor(
      { host: "127.0.0.1", port: 1, security: "none" },
      { imap: { host: imap.host, port: imap.port, security: "none" }, ...overrides },
    ),
    credentials: passwordCredentials(FAKE_PASSWORD),
    timeouts: FAST,
  });
}

test("saveDraft appends the bytes to Drafts with \\Draft and \\Seen", async () => {
  const imap = await startImap();
  const adapter = imapAdapterFor(imap);
  const raw = makeRaw({ subject: "Draft subject", body: "Not sent yet." });
  try {
    const saved = await adapter.saveDraft(raw);
    assert.equal(saved.folderPath, "Drafts");
    assert.ok(saved.uid == null || Number.isInteger(saved.uid), "uid is a uid or null");
    assert.equal(imap.appended.length, 1);
    assert.equal(imap.appended[0].mailbox, "Drafts");
    assert.deepEqual(imap.appended[0].flags, ["\\Draft", "\\Seen"]);
    assert.equal(imap.appended[0].raw.toString("utf8"), raw, "the bytes are stored as given");
    assert.ok(imap.commands.includes("APPEND"));

    // A Buffer is accepted as well as a string.
    const second = await adapter.saveDraft(Buffer.from(raw, "utf8"));
    assert.equal(second.folderPath, "Drafts");
    assert.equal(imap.appended.length, 2);
    assert.deepEqual(imap.appended[1].flags, ["\\Draft", "\\Seen"]);
  } finally {
    await adapter.close();
    await stopFake(imap);
  }
});

test("saveDraft finds the drafts folder by its special-use flag, not by its name", async () => {
  // No mailbox here is called Drafts: the flag is what names the drafts folder.
  const imap = await startImap({ mailboxes: ["INBOX", "Postponed"], specialUse: { Postponed: "\\Drafts" } });
  const adapter = imapAdapterFor(imap);
  try {
    const saved = await adapter.saveDraft(makeRaw({ subject: "Draft" }));
    assert.equal(saved.folderPath, "Postponed");
    assert.equal(imap.appended[0].mailbox, "Postponed");
  } finally {
    await adapter.close();
    await stopFake(imap);
  }
});

test("saveDraft without a \\Drafts folder is NOT_FOUND and stores nothing", async () => {
  const imap = await startImap({ mailboxes: ["INBOX", "Sent"] });
  const adapter = imapAdapterFor(imap);
  try {
    const err = await rejectionOf(adapter.saveDraft(makeRaw({ subject: "Draft" })));
    assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
    assert.equal(err.code, "NOT_FOUND");
    assert.equal(err.message, MAIL_ERROR_TEXT.NOT_FOUND);
    assert.equal(imap.appended.length, 0, "nothing was filed in a folder Crow picked by name");
  } finally {
    await adapter.close();
    await stopFake(imap);
  }
});

test("saveDraft refuses input that is not a message before opening a connection", async () => {
  const imap = await startImap();
  const adapter = imapAdapterFor(imap);
  try {
    for (const bad of [42, null, {}, "", new Uint8Array([1, 2, 3])]) {
      const err = await rejectionOf(adapter.saveDraft(bad));
      assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
      assert.equal(err.code, "BAD_INPUT");
    }
    assert.equal(imap.connectionCount(), 0, "a refused draft opens no socket");
  } finally {
    await adapter.close();
    await stopFake(imap);
  }
});

/* ------------------------------------------------------------------------------ the source rules */

test("the adapter source carries no caller-controlled message and keeps logging and TLS closed", () => {
  const source = readFileSync(
    new URL("../servers/gateway/mail/adapter/imap-smtp.js", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes("envelope:"), false, "no caller-supplied recipient list can be built");
  assert.equal(source.includes("sendmail"), false, "no second transport kind is reachable");
  assert.ok(source.includes("logger: false"));
  assert.ok(source.includes("debug: false"));
  assert.ok(source.includes("disableFileAccess: true"));
  assert.ok(source.includes("disableUrlAccess: true"));
  assert.ok(source.includes("rejectUnauthorized: true"));
  assert.ok(source.includes("pool: false"));
});
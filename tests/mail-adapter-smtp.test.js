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
import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { readFileSync } from "node:fs";
import { ImapFlow } from "imapflow";
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

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls a predicate, so a pushed answer never depends on a fixed delay. */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await tick(5);
  }
}

/* --------------------------------------------------------------- a throwaway TLS certificate */

function derLength(size) {
  if (size < 0x80) return Buffer.from([size]);
  const bytes = [];
  let value = size;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value = Math.floor(value / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag, ...chunks) {
  const content = Buffer.concat(chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))));
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

const derSequence = (...chunks) => der(0x30, ...chunks);
const derSet = (...chunks) => der(0x31, ...chunks);
const derOid = (...bytes) => der(0x06, Buffer.from(bytes));
const derName = (value) => derSequence(derSet(derSequence(derOid(0x55, 0x04, 0x03), der(0x0c, Buffer.from(value, "utf8")))));
/** A PEM block: base64 in 64-character lines, with no blank line before the tail. */
function derPem(label, bytes) {
  const lines = bytes.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/**
 * A self-signed certificate for `127.0.0.1`/`localhost`, built from `node:crypto` alone: an EC key, the
 * X.509 fields a server certificate needs, and an ECDSA signature over them. It is a throwaway that
 * exists for one test run and is trusted by nothing.
 */
function selfSignedCertificate() {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const subjectPublicKey = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const signatureAlgorithm = derSequence(derOid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02));
  const extensions = der(0xa3, derSequence(
    derSequence(derOid(0x55, 0x1d, 0x11), der(0x04, derSequence(
      der(0x82, Buffer.from("localhost", "ascii")),
      der(0x87, Buffer.from([127, 0, 0, 1])),
    ))),
    derSequence(derOid(0x55, 0x1d, 0x25), der(0x04, derSequence(derOid(0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01)))),
  ));
  const toBeSigned = derSequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    signatureAlgorithm,
    derName("localhost"),
    derSequence(
      der(0x17, Buffer.from("240101000000Z", "ascii")),
      der(0x17, Buffer.from("491231235959Z", "ascii")),
    ),
    derName("localhost"),
    subjectPublicKey,
    extensions,
  );
  const signature = crypto.sign("sha256", toBeSigned, privateKey);
  const certificate = derSequence(toBeSigned, signatureAlgorithm, der(0x03, Buffer.from([0]), signature));
  return {
    cert: derPem("CERTIFICATE", certificate),
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

/** An SMTP server behind implicit TLS, with the throwaway certificate. */
async function startTlsSmtp(pair) {
  const sockets = new Set();
  const server = tls.createServer({ key: pair.key, cert: pair.cert }, (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.write(`220 fake SMTP ready${CRLF}`);
    socket.on("data", () => {});
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    host: "127.0.0.1",
    port: server.address().port,
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Whether a TLS client with verification turned off reaches this server, and with it on refuses it. */
async function tlsVerdict(port) {
  const verdict = {};
  const attempt = (rejectUnauthorized) => new Promise((resolve) => {
    const socket = tls.connect({ port, host: "127.0.0.1", rejectUnauthorized }, () => {
      socket.end();
      resolve("connected");
    });
    socket.on("error", (err) => resolve(String(err.code)));
  });
  verdict.withoutVerification = await attempt(false);
  verdict.withVerification = await attempt(true);
  return verdict;
}

/* --------------------------------------------------------------- a server that never stops talking */

/**
 * An SMTP server that greets and then answers EHLO with one `250-` continuation line every 100 ms, for
 * as long as the client stays. Nothing is ever silent, so an inactivity timer measures nothing.
 */
async function startDribblingSmtp() {
  const sockets = new Set();
  const timers = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.setNoDelay(true);
    socket.write(`220 fake SMTP ready${CRLF}`);
    let buffer = "";
    let dribbling = null;
    socket.on("close", () => {
      if (dribbling) clearInterval(dribbling);
      timers.delete(dribbling);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes(CRLF) || dribbling) return;
      buffer = "";
      dribbling = setInterval(() => {
        if (socket.destroyed) return;
        socket.write(`250-still-working${CRLF}`);
      }, 100);
      timers.add(dribbling);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    host: "127.0.0.1",
    port: server.address().port,
    openConnections: () => sockets.size,
    async close() {
      for (const timer of timers) clearInterval(timer);
      timers.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/* --------------------------------------------- an SMTP server whose AUTH answer this test decides */

/**
 * A minimal SMTP server that refuses the first `failAuthTimes` sign-ins and accepts the next one, so a
 * test can see the retry on the wire. Everything after a successful sign-in is answered as accepted.
 */
async function startScriptedSmtp({ failAuthTimes }) {
  const state = { messages: [], authCommands: [], connections: 0, authFailures: 0 };
  const sockets = new Set();
  const server = net.createServer((socket) => {
    state.connections += 1;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.setNoDelay(true);
    socket.write(`220 fake SMTP ready${CRLF}`);
    let buffer = "";
    let data = null;
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const end = buffer.indexOf(CRLF);
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === ".") {
            state.messages.push(data.join(CRLF));
            data = null;
            socket.write(`250 2.0.0 Ok: queued${CRLF}`);
          } else {
            data.push(line.startsWith(".") ? line.slice(1) : line);
          }
          continue;
        }
        const verb = (line.split(" ")[0] || "").toUpperCase();
        if (verb === "EHLO") {
          socket.write(`250-fake${CRLF}250-AUTH PLAIN LOGIN XOAUTH2${CRLF}250 8BITMIME${CRLF}`);
        } else if (verb === "AUTH") {
          state.authCommands.push(line);
          if (state.authFailures < failAuthTimes) {
            state.authFailures += 1;
            socket.write(`535 5.7.8 Authentication credentials invalid${CRLF}`);
          } else {
            socket.write(`235 2.7.0 Authentication successful${CRLF}`);
          }
        } else if (verb === "MAIL") {
          socket.write(`250 2.1.0 Ok${CRLF}`);
        } else if (verb === "RCPT") {
          socket.write(`250 2.1.5 Ok${CRLF}`);
        } else if (verb === "DATA") {
          data = [];
          socket.write(`354 End data with <CR><LF>.<CR><LF>${CRLF}`);
        } else if (verb === "QUIT") {
          socket.write(`221 2.0.0 Bye${CRLF}`);
          socket.end();
        } else {
          socket.write(`250 2.0.0 Ok${CRLF}`);
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    host: "127.0.0.1",
    port: server.address().port,
    get authCommands() { return state.authCommands; },
    get messages() { return state.messages; },
    get connections() { return state.connections; },
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(resolve));
    },
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

function imapAdapterFor(imap, overrides = {}, adapterOptions = {}) {
  return createImapSmtpAdapter({
    account: accountFor(
      { host: "127.0.0.1", port: 1, security: "none" },
      { imap: { host: imap.host, port: imap.port, security: "none" }, ...overrides },
    ),
    credentials: passwordCredentials(FAKE_PASSWORD),
    timeouts: FAST,
    ...adapterOptions,
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

test("an attachment naming a local file, a URL, raw bytes or a transfer encoding is refused before any connection", async () => {
  const fake = await startSmtp();
  const adapter = adapterFor(fake);
  const content = Buffer.from("bytes", "utf8");
  const refused = [
    { path: "/etc/passwd" },
    { href: "https://example.test/report.bin" },
    { raw: "Content-Type: text/plain" },
    { encoding: "base64" },
  ];
  try {
    for (const extra of refused) {
      const err = await rejectionOf(adapter.send(outgoing({
        attachments: [{ filename: "report.bin", contentType: "application/octet-stream", content, ...extra }],
      })));
      assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
      assert.equal(err.code, "BAD_INPUT");
      assert.equal(err.detail, "attachments", "the detail names the field, never the value");
      assert.equal(err.message, MAIL_ERROR_TEXT.BAD_INPUT);
    }
    assert.equal(fake.connectionCount(), 0, "no refused message opened a socket");
    assert.equal(fake.messages.length, 0);
  } finally {
    await adapter.close();
    await stopFake(fake);
  }
});

/* ------------------------------------------------------------------------- the send deadline */

test("a server that dribbles one line at a time fails the send at the send deadline", async () => {
  const dribbler = await startDribblingSmtp();
  const adapter = createImapSmtpAdapter({
    account: accountFor({ host: dribbler.host, port: dribbler.port, security: "none" }),
    credentials: passwordCredentials(FAKE_PASSWORD),
    timeouts: { connectMs: 4000, greetingMs: 4000, socketMs: 4000, commandMs: 4000, sendMs: 600 },
  });
  try {
    const started = Date.now();
    const err = await rejectionOf(adapter.send(outgoing()));
    const elapsed = Date.now() - started;
    assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
    assert.equal(err.code, "TIMEOUT", "a send that never goes silent is still bounded");
    assert.equal(err.message, MAIL_ERROR_TEXT.TIMEOUT);
    assert.ok(elapsed < 1500, `the send deadline ended it (${elapsed} ms)`);
    const shown = shownError(err);
    assert.ok(!shown.includes(FAKE_PASSWORD), "no credential in the sentence");
    assert.ok(!shown.includes("still-working"), "no server line in the sentence");
    await waitFor(() => dribbler.openConnections() === 0);
    assert.equal(dribbler.openConnections(), 0, "the connection was closed, not left holding the send");
  } finally {
    await adapter.close();
    await dribbler.close();
  }
});

test("a hung token provider rejects TIMEOUT within the send budget", async () => {
  const adapter = createImapSmtpAdapter({
    account: accountFor({ host: "127.0.0.1", port: 1, security: "none" }, { authKind: "xoauth2" }),
    tokenProvider: () => new Promise(() => {}),
    timeouts: { connectMs: 4000, greetingMs: 4000, socketMs: 4000, commandMs: 4000, sendMs: 250 },
  });
  try {
    const started = Date.now();
    const err = await rejectionOf(adapter.send(outgoing()));
    const elapsed = Date.now() - started;
    assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
    assert.equal(err.code, "TIMEOUT", "the sign-in is under the same deadline as the send");
    assert.equal(err.detail, "send_deadline");
    assert.ok(elapsed < 1500, `the send deadline ended it (${elapsed} ms)`);
  } finally {
    await adapter.close();
  }
});

/* --------------------------------------------------------------- XOAUTH2 refusal and retry */

test("a refused XOAUTH2 send-signin retries once with a forced refresh", async () => {
  const server = await startScriptedSmtp({ failAuthTimes: 1 });
  const calls = [];
  const adapter = createImapSmtpAdapter({
    account: accountFor({ host: server.host, port: server.port, security: "none" }, { authKind: "xoauth2" }),
    tokenProvider: async ({ forceRefresh }) => {
      calls.push(forceRefresh);
      return { accessToken: `access-token-${calls.length}` };
    },
    timeouts: FAST,
  });
  try {
    const result = await adapter.send(outgoing());
    assert.deepEqual(calls, [false, true], "the second sign-in asks for a forced refresh");
    assert.equal(server.authCommands.length, 2, "two sign-ins were attempted");
    assert.equal(server.connections, 2, "the retry is its own connection");
    assert.equal(server.messages.length, 1, "the message was transmitted once");
    assert.ok(server.messages[0].includes("Hello from Crow"), "and it is the message that was asked for");
    assert.match(result.messageId, /^<[0-9a-f]{32}@example\.com>$/);
  } finally {
    await adapter.close();
    await server.close();
  }
});

test("a second refused XOAUTH2 sign-in is AUTH_FAILED and transmits nothing", async () => {
  const server = await startScriptedSmtp({ failAuthTimes: Number.POSITIVE_INFINITY });
  const calls = [];
  const adapter = createImapSmtpAdapter({
    account: accountFor({ host: server.host, port: server.port, security: "none" }, { authKind: "xoauth2" }),
    tokenProvider: async ({ forceRefresh }) => {
      calls.push(forceRefresh);
      return { accessToken: `access-token-${calls.length}` };
    },
    timeouts: FAST,
  });
  try {
    const err = await rejectionOf(adapter.send(outgoing()));
    assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
    assert.equal(err.code, "AUTH_FAILED");
    assert.equal(err.message, MAIL_ERROR_TEXT.AUTH_FAILED);
    assert.deepEqual(calls, [false, true], "the forced refresh is asked for exactly once");
    assert.equal(server.authCommands.length, 2, "two sign-ins, not a third");
    assert.equal(server.messages.length, 0, "nothing was transmitted");
    const shown = shownError(err);
    assert.ok(!shown.includes("access-token-1"), "no token in the sentence");
  } finally {
    await adapter.close();
    await server.close();
  }
});

/* ------------------------------------------------------------------ implicit TLS and a bad cert */

test("implicit TLS against a self-signed certificate is TLS and transmits nothing", async () => {
  const pair = selfSignedCertificate();
  const server = await startTlsSmtp(pair);
  try {
    const verdict = await tlsVerdict(server.port);
    assert.equal(verdict.withoutVerification, "connected", "the server is a real TLS endpoint");
    assert.match(
      String(verdict.withVerification),
      /CERT/,
      "and a client that verifies refuses its certificate",
    );

    const adapter = createImapSmtpAdapter({
      account: accountFor({ host: server.host, port: server.port, security: "ssl" }),
      credentials: passwordCredentials(FAKE_PASSWORD),
      timeouts: FAST,
    });
    try {
      const err = await rejectionOf(adapter.send(outgoing()));
      assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
      assert.equal(err.code, "TLS", "an untrusted certificate is a TLS fault, not a network one");
      assert.equal(err.message, MAIL_ERROR_TEXT.TLS);
      const shown = shownError(err);
      assert.ok(!shown.includes(FAKE_PASSWORD), "the sign-in never happened");
      assert.ok(!shown.includes(SAM), "no recipient address in the sentence");
    } finally {
      await adapter.close();
    }
  } finally {
    await server.close();
  }
});

test("saveDraft reports an APPENDLIMIT or TOOBIG refusal as TOO_LARGE", async () => {
  const imap = await startImap();
  let refusal = "APPENDLIMIT";
  const adapter = imapAdapterFor(imap, {}, {
    clientFactory: (options) => {
      const client = new ImapFlow(options);
      client.append = async () => {
        const err = new Error("the server refused the append");
        err.serverResponseCode = refusal;
        throw err;
      };
      return client;
    },
  });
  try {
    for (const code of ["APPENDLIMIT", "TOOBIG"]) {
      refusal = code;
      const err = await rejectionOf(adapter.saveDraft(makeRaw({ subject: "Draft", body: "Not sent yet." })));
      assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
      assert.equal(err.code, "TOO_LARGE", `${code} is the message being too large`);
      assert.equal(err.message, MAIL_ERROR_TEXT.TOO_LARGE);
      assert.equal(err.detail, code);
    }
    assert.equal(imap.appended.length, 0, "no refusal was filed as a draft");
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
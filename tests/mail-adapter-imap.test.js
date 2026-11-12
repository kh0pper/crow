// Crow Mail's IMAP adapter (Task 12 of plan 1): the provider-neutral contract run against the
// in-process fake IMAP server, plus the behaviour the security rules pin down — one fixed sentence
// per failure, an `error` listener on every connection, a deadline on every command, and at most
// three connections (one read connection plus one per watched folder). Every server binds 127.0.0.1
// port 0, so nothing here depends on a fixed port or on a real mailbox.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { readFileSync } from "node:fs";
import { ImapFlow } from "imapflow";
import {
  createFakeImapServer, createFakeSmtpServer, makeRaw, FAKE_USER, FAKE_PASSWORD,
} from "./fixtures/fake-mail-server.mjs";
import { runAdapterContract } from "./fixtures/mail-adapter-contract.mjs";
import { createImapSmtpAdapter, messageIdFor } from "../servers/gateway/mail/adapter/imap-smtp.js";
import { MAIL_ERROR_TEXT, MailError } from "../servers/gateway/mail/errors.js";

const ACCOUNT_ID = "ma-0123456789abcdef";
const WRONG_PASSWORD = "not-the-app-password";

const fakes = new Set();
after(async () => {
  for (const fake of fakes) await fake.close();
  fakes.clear();
});

async function startFake(options) {
  const fake = await createFakeImapServer(options);
  fakes.add(fake);
  return fake;
}

async function startSmtpFake(options) {
  const fake = await createFakeSmtpServer(options);
  fakes.add(fake);
  return fake;
}

async function stopFake(fake) {
  fakes.delete(fake);
  await fake.close();
}

/** The account row the adapter consumes, as the account store returns it (no secret field). */
function accountFor(endpoint, overrides = {}) {
  return {
    id: ACCOUNT_ID,
    label: "Alex",
    address: FAKE_USER,
    imap: { host: endpoint.host, port: endpoint.port, security: "none" },
    smtp: { host: endpoint.host, port: endpoint.port, security: "none" },
    username: FAKE_USER,
    authKind: "password",
    status: "active",
    statusDetail: null,
    windowDays: 90,
    ...overrides,
  };
}

const passwordCredentials = (password) => ({ getSecrets: async () => ({ MAIL_PASSWORD: password }) });

const FAST = { connectMs: 4000, greetingMs: 4000, socketMs: 4000, commandMs: 4001 };

function adapterFor(endpoint, overrides = {}) {
  return createImapSmtpAdapter({
    account: accountFor(endpoint),
    credentials: passwordCredentials(FAKE_PASSWORD),
    timeouts: FAST,
    ...overrides,
  });
}

function mailCode(code) {
  return (err) => {
    assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
    assert.equal(err.code, code);
    return true;
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

/** A port nothing listens on: bound once, then released, so a connect to it is refused. */
async function unusedPort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * A client wrapper that records every FETCH the adapter issues: the range it names, and whether the
 * fetch asked for the message body or only its metadata. The fake server records command names
 * without their arguments, so this is where a test sees which UIDs a body fetch was issued for.
 */
function recordingClientFactory(fetches) {
  return (options) => {
    const client = new ImapFlow(options);
    const fetch = client.fetch.bind(client);
    client.fetch = (range, query, opts) => {
      fetches.push({
        range: String(range),
        body: Boolean(query && query.source),
        source: query ? query.source : null,
      });
      return fetch(range, query, opts);
    };
    return client;
  };
}

/** A UID list as the adapter sends it (a comma-joined set of concrete UIDs, never a range). */
const rangeHas = (range, uid) => range.split(",").some((part) => Number(part) === uid);

/** An ImapFlow-shaped client for the clientFactory seam, with no socket behind it. */
function stubClient(overrides = {}) {
  return {
    on() {},
    close() {},
    usable: true,
    mailbox: { uidValidity: 1, uidNext: undefined },
    async connect() {},
    async logout() {},
    async getMailboxLock() { return { release() {} }; },
    async status() { return {}; },
    async list() { return []; },
    async search() { return []; },
    async idle() {},
    async mailboxOpen() {},
    async *fetch() {},
    ...overrides,
  };
}

/**
 * A one-response IMAP server: it greets, accepts a LOGIN, selects INBOX, answers a metadata FETCH with
 * a size, and answers a body FETCH by declaring a literal larger than the client's parser cap and then
 * going silent. The declaration alone is what the client has to refuse.
 */
async function startLiteralServer(declaredBytes) {
  const sockets = new Set();
  let declared = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.setNoDelay(true);
    socket.write("* OK [CAPABILITY IMAP4rev1] fake IMAP ready\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const tokens = line.split(" ");
        const tag = tokens[0];
        const first = (tokens[1] || "").toUpperCase();
        const name = first === "UID" ? (tokens[2] || "").toUpperCase() : first;
        if (name === "CAPABILITY") {
          socket.write("* CAPABILITY IMAP4rev1\r\n");
          socket.write(`${tag} OK CAPABILITY completed\r\n`);
        } else if (name === "LOGIN") {
          socket.write(`${tag} OK LOGIN completed\r\n`);
        } else if (name === "SELECT" || name === "EXAMINE") {
          socket.write("* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n");
          socket.write("* OK [UIDVALIDITY 1] UIDs valid\r\n* OK [UIDNEXT 2] next\r\n");
          socket.write(`${tag} OK [READ-WRITE] ${name} completed\r\n`);
        } else if (name === "FETCH") {
          if (/BODY/i.test(line)) {
            // The body is never sent: the declared size is the whole attack, and it is over the cap.
            declared += 1;
            socket.write(`* 1 FETCH (UID 1 BODY[] {${declaredBytes}}\r\n`);
          } else {
            socket.write('* 1 FETCH (UID 1 FLAGS () INTERNALDATE "01-Jan-2024 00:00:00 +0000" ');
            socket.write("RFC822.SIZE 32)\r\n");
            socket.write(`${tag} OK FETCH completed\r\n`);
          }
        } else {
          socket.write(`${tag} OK ${name} completed\r\n`);
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
    literalsDeclared: () => declared,
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

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

/* ------------------------------------------------------------------ the adapter contract */

// The fake server grows `omitUidNext` in the APPEND/SMTP task; until then the contract step that
// needs it is skipped by name rather than failed.
const FIXTURE_SOURCE = readFileSync(new URL("./fixtures/fake-mail-server.mjs", import.meta.url), "utf8");
const HAS_OMIT_UIDNEXT = FIXTURE_SOURCE.includes("omitUidNext");

const CONTRACT_SKIP = [];
if (!HAS_OMIT_UIDNEXT) CONTRACT_SKIP.push("a listing that omits UIDNEXT still yields a uidNext");

runAdapterContract(async (opts = {}) => {
  const fake = await startFake(opts.omitUidNext ? { omitUidNext: true } : {});
  // `send` needs a server that speaks SMTP, so one fake SMTP server stands behind the account's smtp
  // endpoint for the two contract steps that send a message.
  const smtp = await startSmtpFake();
  const adapter = createImapSmtpAdapter({
    account: accountFor(fake, { smtp: { host: smtp.host, port: smtp.port, security: "none" } }),
    credentials: passwordCredentials(FAKE_PASSWORD),
    timeouts: FAST,
  });
  const close = adapter.close.bind(adapter);
  adapter.close = async () => {
    await close();
    await stopFake(fake);
    await stopFake(smtp);
  };
  await adapter.connect();
  return {
    adapter,
    // The contract asserts a watch change right after the delivery, and a real socket answers a few
    // ticks later than the in-memory fake does: the hook waits the push out.
    deliver: async (mailbox, raw, options = {}) => {
      const uid = fake.deliver(mailbox, raw, options);
      await tick(30);
      return uid;
    },
    expunge: async (mailbox, uid) => fake.expunge(mailbox, uid),
    moveIn: async (mailbox, raw, options = {}) => fake.moveIn(mailbox, raw, options),
    bumpUidValidity: async (mailbox) => fake.bumpUidValidity(mailbox),
    dropWatch: async () => {
      fake.dropConnections();
      await tick(50);
    },
  };
}, { skip: CONTRACT_SKIP });

/* ------------------------------------------------------------------- a missing UIDNEXT */

test("a server that omits UIDNEXT still yields a uidNext from the highest listed uid", async () => {
  const fake = await startFake();
  fake.deliver("INBOX", makeRaw({ subject: "one" }));
  fake.deliver("INBOX", makeRaw({ subject: "two" }));
  const adapter = adapterFor(fake, {
    clientFactory: (options) => {
      const client = new ImapFlow(options);
      const openLock = client.getMailboxLock.bind(client);
      // SELECT without UIDNEXT, and a STATUS answer without it either: both fallbacks miss.
      client.getMailboxLock = async (path, lockOptions) => {
        const lock = await openLock(path, lockOptions);
        if (client.mailbox) client.mailbox.uidNext = undefined;
        return lock;
      };
      client.status = async (path) => ({ path, messages: 2 });
      return client;
    },
  });

  try {
    await adapter.connect();
    const listing = await adapter.list("INBOX");
    assert.equal(listing.uidNext, 3, "the highest listed uid plus one");
    const filtered = await adapter.list("INBOX", { afterUid: 2 });
    assert.deepEqual(filtered.items, [], "the n:* quirk is filtered out");
    assert.equal(filtered.uidNext, 3, "a filtered listing still reports a uidNext");
  } finally {
    await adapter.close();
    await stopFake(fake);
  }
});

/* ------------------------------------------------------------------------- RF2: secrets */

test("a wrong password is AUTH_FAILED and carries neither the password nor the username", async () => {
  const fake = await startFake({ users: { [FAKE_USER]: "the-right-app-password" } });
  const adapter = adapterFor(fake, { credentials: passwordCredentials(WRONG_PASSWORD) });
  try {
    const err = await rejectionOf(adapter.connect());
    assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
    assert.equal(err.code, "AUTH_FAILED");
    assert.equal(err.message, MAIL_ERROR_TEXT.AUTH_FAILED);
    const shown = [err.message, err.code, String(err.detail), JSON.stringify(err), String(err)].join(" ");
    assert.ok(!shown.includes(WRONG_PASSWORD), "the password is never in the error");
    assert.ok(!shown.includes(FAKE_USER), "the username is never in the error");
  } finally {
    await adapter.close();
    await stopFake(fake);
  }
});

test("a refused connection is NETWORK, with the fixed sentence", async () => {
  const port = await unusedPort();
  const adapter = adapterFor({ host: "127.0.0.1", port });
  try {
    const err = await rejectionOf(adapter.connect());
    assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
    assert.equal(err.code, "NETWORK");
    assert.equal(err.message, MAIL_ERROR_TEXT.NETWORK);
  } finally {
    await adapter.close();
  }
});

test("connecting writes nothing to the console, and never the password", async () => {
  const fake = await startFake();
  const adapter = adapterFor(fake);
  const captured = captureConsole();
  try {
    await adapter.connect();
    await adapter.listFolders();
  } finally {
    captured.restore();
  }
  assert.ok(!captured.text().includes(FAKE_PASSWORD), "no console line carries the password");
  await adapter.close();
  await stopFake(fake);
});

/* ---------------------------------------------------------------------- xoauth2 sign-in */

test("xoauth2 signs in with the provider's token and reports a rotated refresh token once", async () => {
  const fake = await startFake();
  const calls = [];
  const rotations = [];
  const adapter = createImapSmtpAdapter({
    account: accountFor(fake, { authKind: "xoauth2" }),
    tokenProvider: async ({ accountId, forceRefresh }) => {
      calls.push({ accountId, forceRefresh });
      return { accessToken: "access-token-1", refreshToken: "refresh-token-1" };
    },
    onTokenRotated: (refreshToken) => rotations.push(refreshToken),
    timeouts: FAST,
  });
  try {
    await adapter.connect();
    assert.deepEqual(calls, [{ accountId: ACCOUNT_ID, forceRefresh: false }]);
    assert.deepEqual(fake.logins, [{ user: FAKE_USER, method: "AUTHENTICATE XOAUTH2" }],
      "the fake only accepts a non-empty bearer token");
    assert.deepEqual(rotations, ["refresh-token-1"], "the rotated token reaches the writer once");
  } finally {
    await adapter.close();
    await stopFake(fake);
  }
});

test("a refused xoauth2 sign-in retries once with a forced refresh", async () => {
  const fake = await startFake();
  const calls = [];
  let issued = 0;
  const adapter = createImapSmtpAdapter({
    account: accountFor(fake, { authKind: "xoauth2" }),
    tokenProvider: async ({ forceRefresh }) => {
      calls.push(forceRefresh);
      issued += 1;
      return { accessToken: `access-token-${issued}` };
    },
    timeouts: FAST,
  });
  fake.failNextLogin();
  try {
    await adapter.connect();
    assert.deepEqual(calls, [false, true], "the second sign-in asks for a forced refresh");
    assert.equal(fake.logins.length, 1, "the retried sign-in is the one that succeeded");
  } finally {
    await adapter.close();
    await stopFake(fake);
  }
});

/* ------------------------------------------------------------------ RF8: drops and hangs */

test("a dropped idle read connection is no uncaughtException and the next call rejects NETWORK", async () => {
  const fake = await startFake();
  fake.deliver("INBOX", makeRaw({ subject: "one" }));
  const adapter = adapterFor(fake);
  await adapter.connect();
  assert.ok((await adapter.listFolders()).length > 0);

  const seen = [];
  const spy = (err) => seen.push(err);
  process.on("uncaughtException", spy);
  try {
    fake.dropConnections();
    await waitFor(() => fake.openConnections() === 0);
    await tick(50);
    const err = await rejectionOf(adapter.list("INBOX"));
    assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
    assert.equal(err.code, "NETWORK");
    assert.deepEqual(seen, [], "the error listener kept the drop off the process");
  } finally {
    process.off("uncaughtException", spy);
    await adapter.close();
    await stopFake(fake);
  }
});

test("a silent command rejects TIMEOUT within commandMs and closes the connection", async () => {
  const fake = await startFake();
  fake.deliver("INBOX", makeRaw({ subject: "one" }));
  const adapter = adapterFor(fake, { timeouts: { ...FAST, commandMs: 200 } });
  try {
    await adapter.connect();
    fake.silenceNext();
    const started = Date.now();
    const err = await rejectionOf(adapter.list("INBOX"));
    const elapsed = Date.now() - started;
    assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
    assert.equal(err.code, "TIMEOUT");
    assert.ok(elapsed < 3000, `the deadline fired (${elapsed} ms)`);
    await waitFor(() => fake.openConnections() === 0);
  } finally {
    await adapter.close();
    await stopFake(fake);
  }
});

test("a silent greeting rejects TIMEOUT within greetingMs", async () => {
  const blackhole = net.createServer((socket) => socket.on("error", () => {}));
  await new Promise((resolve) => blackhole.listen(0, "127.0.0.1", resolve));
  const { port } = blackhole.address();
  const adapter = adapterFor(
    { host: "127.0.0.1", port },
    { timeouts: { ...FAST, greetingMs: 200, commandMs: 2000 } },
  );
  try {
    const started = Date.now();
    const err = await rejectionOf(adapter.connect());
    const elapsed = Date.now() - started;
    assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
    assert.equal(err.code, "TIMEOUT");
    assert.ok(elapsed < 3000, `the greeting deadline fired (${elapsed} ms)`);
  } finally {
    await adapter.close();
    await new Promise((resolve) => blackhole.close(resolve));
  }
});

/* ----------------------------------------------------------------- the connection budget */

test("one read connection plus one per watched folder, and a third folder is refused", async () => {
  const fake = await startFake();
  const adapter = adapterFor(fake);
  try {
    const refused = await rejectionOf(
      adapter.watch(["INBOX", "Sent", "Drafts"], { onChange() {}, onError() {} }),
    );
    assert.ok(refused instanceof MailError, `expected a MailError, got ${refused && refused.name}`);
    assert.equal(refused.code, "BAD_INPUT");
    assert.equal(fake.connectionCount(), 0, "a refused watch opens no connection");

    await adapter.connect();
    const changes = [];
    const errors = [];
    const watcher = await adapter.watch(["INBOX", "Sent"], {
      onChange: (event) => changes.push(event),
      onError: (err) => errors.push(err),
    });
    await waitFor(() => fake.openConnections() === 3);
    assert.equal(fake.openConnections(), 3);

    fake.deliver("INBOX", makeRaw({ subject: "for the watcher" }));
    await waitFor(() => changes.length === 1);
    assert.equal(changes[0].folderPath, "INBOX");
    assert.equal(typeof changes[0].reason, "string");
    assert.deepEqual(errors, []);

    const secondWatcher = await rejectionOf(
      adapter.watch(["INBOX"], { onChange() {}, onError() {} }),
    );
    assert.ok(secondWatcher instanceof MailError, "a second watcher would be a fourth connection");
    assert.equal(secondWatcher.code, "BAD_INPUT");

    watcher.stop();
    await waitFor(() => fake.openConnections() === 1);
  } finally {
    await adapter.close();
    await stopFake(fake);
  }
});

/* --------------------------------------------------------------------- oversized messages */

test("get reports an oversized message with its metadata and issues no body fetch for it", async () => {
  const fake = await startFake();
  const big = fake.deliver("INBOX", makeRaw({ subject: "too big", body: "x".repeat(2000) }), {
    flags: ["\\Seen"],
  });
  const small = fake.deliver("INBOX", makeRaw({ subject: "small enough", body: "hello" }));
  const fetches = [];
  const adapter = adapterFor(fake, { maxRawBytes: 500, clientFactory: recordingClientFactory(fetches) });
  try {
    await adapter.connect();
    const messages = await adapter.get("INBOX", [big, small]);
    assert.equal(messages.length, 2, "both uids are reported");
    const oversized = messages.find((message) => message.uid === big);
    assert.ok(Buffer.isBuffer(oversized.raw));
    assert.equal(oversized.raw.length, 0, "the oversized message comes back without its bytes");
    assert.deepEqual(oversized.flags, ["\\Seen"], "its flags still come through");
    assert.equal(typeof oversized.internalDate, "number");
    const bodyFetches = fetches.filter((call) => call.body);
    assert.ok(bodyFetches.length > 0, "the small message's body was fetched");
    assert.ok(
      bodyFetches.every((call) => !rangeHas(call.range, big)),
      "no fetch asked for the oversized message's body",
    );
    const kept = messages.find((message) => message.uid === small);
    assert.match(kept.raw.toString("utf8"), /small enough/);
  } finally {
    await adapter.close();
    await stopFake(fake);
  }
});

/* ------------------------------------------------- the contract now covers send and saveDraft */

test("list bounds the window with sinceDate, afterUid, fromUid and beforeUid", async () => {
  const fake = await startFake();
  const edge = Date.UTC(2026, 1, 2, 3, 4, 5);
  fake.deliver("INBOX", makeRaw({ subject: "old" }), { internalDate: new Date(edge - 1000) });
  fake.deliver("INBOX", makeRaw({ subject: "edge" }), { internalDate: new Date(edge) });
  fake.deliver("INBOX", makeRaw({ subject: "new" }), { internalDate: new Date(edge + 1000) });
  const adapter = adapterFor(fake);
  try {
    await adapter.connect();
    assert.deepEqual((await adapter.list("INBOX", { sinceDate: edge })).items.map((i) => i.uid), [2, 3]);
    assert.deepEqual(
      (await adapter.list("INBOX", { sinceDate: edge + 1000 })).items.map((i) => i.uid),
      [3],
      "the bound is inclusive at the second a server can carry",
    );
    assert.deepEqual((await adapter.list("INBOX", { fromUid: 2 })).items.map((i) => i.uid), [2, 3]);
    assert.deepEqual((await adapter.list("INBOX", { afterUid: 2 })).items.map((i) => i.uid), [3]);
    assert.deepEqual((await adapter.list("INBOX", { beforeUid: 3 })).items.map((i) => i.uid), [1, 2]);
    assert.deepEqual(
      (await adapter.list("INBOX", { beforeUid: 3, newestFirst: true, limit: 1 })).items.map((i) => i.uid),
      [2],
    );
    await assert.rejects(adapter.list("INBOX", { afterUid: -1 }), mailCode("BAD_INPUT"));
    await assert.rejects(adapter.list("", {}), mailCode("BAD_INPUT"));
  } finally {
    await adapter.close();
    await stopFake(fake);
  }
});

test("search refuses an empty query and a control character", async () => {
  const fake = await startFake();
  const adapter = adapterFor(fake);
  try {
    await adapter.connect();
    await assert.rejects(adapter.search(""), mailCode("BAD_INPUT"));
    await assert.rejects(adapter.search("   "), mailCode("BAD_INPUT"));
    await assert.rejects(adapter.search("hello\r\nA2 LOGOUT"), mailCode("BAD_INPUT"));
    assert.deepEqual(await adapter.search("nothing-matches-this"), []);
  } finally {
    await adapter.close();
    await stopFake(fake);
  }
});

/* --------------------------------------------------------------- a library error never travels */

test("a missing folder is NOT_FOUND on list, get and search, with nothing of the answer kept", async () => {
  const fake = await startFake();
  fake.deliver("INBOX", makeRaw({ subject: "one" }));
  const adapter = adapterFor(fake);
  // No fake answer ever mentions this name, so a match in the error would have come from the request.
  const missing = "Gone2024";
  const calls = [
    ["list", () => adapter.list(missing)],
    ["get", () => adapter.get(missing, [1])],
    ["search", () => adapter.search("hello", { folderPath: missing })],
  ];
  try {
    await adapter.connect();
    for (const [name, call] of calls) {
      const err = await rejectionOf(call());
      assert.ok(err instanceof MailError, `${name} rejects a MailError, got ${err && err.name}`);
      assert.equal(err.code, "NOT_FOUND", `${name} on a missing folder`);
      assert.equal(err.message, MAIL_ERROR_TEXT.NOT_FOUND);
      for (const field of ["response", "responseText", "executedCommand", "command"]) {
        assert.ok(!Object.hasOwn(err, field), `${name} carries no ${field} from the library`);
      }
      const shown = `${JSON.stringify(err)} ${String(err)} ${String(err.stack)}`;
      assert.ok(!shown.includes(missing), `${name} names no folder`);
      assert.ok(!shown.includes("no such mailbox"), `${name} carries no server sentence`);
    }
  } finally {
    await adapter.close();
    await stopFake(fake);
  }
});

test("a NONEXISTENT response code is NOT_FOUND and a plain library error leaves as a MailError", async () => {
  const fake = await startFake();
  const serverText = "Mailbox Gone2024 does not exist";
  const rawMissing = Object.assign(new Error(`A7 NO [NONEXISTENT] ${serverText}`), {
    responseStatus: "NO",
    response: { tag: "A7", command: "NO", attributes: [{ section: [{ value: "NONEXISTENT" }] }] },
    responseText: serverText,
    executedCommand: "A7 SELECT Gone2024",
  });
  const throwingFactory = (thrown) => (options) => {
    const client = new ImapFlow(options);
    client.getMailboxLock = async () => { throw thrown; };
    return client;
  };

  const missingAdapter = adapterFor(fake, { clientFactory: throwingFactory(rawMissing) });
  const rangeAdapter = adapterFor(fake, {
    clientFactory: throwingFactory(new RangeError(`invalid input for Gone2024: ${serverText}`)),
  });
  try {
    await missingAdapter.connect();
    const missingErr = await rejectionOf(missingAdapter.list("Gone2024"));
    assert.ok(missingErr instanceof MailError, `expected a MailError, got ${missingErr && missingErr.name}`);
    assert.equal(missingErr.code, "NOT_FOUND", "the NONEXISTENT code means the mailbox is gone");
    for (const field of ["response", "responseText", "executedCommand", "command"]) {
      assert.ok(!Object.hasOwn(missingErr, field), `the library field ${field} does not travel`);
    }
    const shownMissing = `${JSON.stringify(missingErr)} ${String(missingErr)}`;
    assert.ok(!shownMissing.includes(serverText), "no server sentence");
    assert.ok(!shownMissing.includes("NONEXISTENT"), "not even the response code's raw form");

    await rangeAdapter.connect();
    const rangeErr = await rejectionOf(rangeAdapter.list("Gone2024"));
    assert.ok(rangeErr instanceof MailError, "a RangeError is classified like any other library fault");
    assert.equal(rangeErr.code, "PROTOCOL");
    const shownRange = `${JSON.stringify(rangeErr)} ${String(rangeErr)}`;
    assert.ok(!shownRange.includes("Gone2024"), "the folder name does not travel");
    assert.ok(!shownRange.includes("invalid input"), "the library's sentence does not travel");
  } finally {
    await missingAdapter.close();
    await rangeAdapter.close();
    await stopFake(fake);
  }
});

/* ------------------------------------------------------------------- RF2: a rotation write */

test("an async rotation writer that rejects is no unhandled rejection and does not fail the sign-in", async () => {
  const fake = await startFake();
  fake.deliver("INBOX", makeRaw({ subject: "still signed in" }));
  const fakeRefreshToken = "refresh-token-under-test";
  const unhandled = [];
  const spy = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", spy);
  const captured = captureConsole();
  const adapter = createImapSmtpAdapter({
    account: accountFor(fake, { authKind: "xoauth2" }),
    tokenProvider: async () => ({ accessToken: "access-token-1", refreshToken: fakeRefreshToken }),
    onTokenRotated: async () => {
      throw new Error(`the keychain refused ${fakeRefreshToken}`);
    },
    timeouts: FAST,
  });
  try {
    await adapter.connect();
    assert.ok((await adapter.listFolders()).length > 0, "the connection is up");
    assert.equal((await adapter.list("INBOX")).items.length, 1, "a command still works");
    // A dropped promise settles here, inside the window the spy is listening to.
    await tick(50);
  } finally {
    captured.restore();
    process.off("unhandledRejection", spy);
    await adapter.close();
    await stopFake(fake);
  }
  assert.deepEqual(unhandled, [], "the writer's rejection reached authFor instead of the process");
  assert.ok(!captured.text().includes(fakeRefreshToken), "the writer's sentence is nowhere in the console");
});

/* ------------------------------------------------------------- RF8: the client-side bounds */

test("the client is built with parser bounds above the raw cap, and cleartext only for loopback", async () => {
  const built = [];
  const factory = (options) => {
    built.push(options);
    return stubClient();
  };
  const local = createImapSmtpAdapter({
    account: accountFor({ host: "127.0.0.1", port: 143 }),
    credentials: passwordCredentials(FAKE_PASSWORD),
    timeouts: FAST,
    maxRawBytes: 4096,
    clientFactory: factory,
  });
  try {
    await local.connect();
  } finally {
    await local.close();
  }
  assert.equal(built.length, 1);
  const [options] = built;
  assert.ok(options.maxLiteralSize > 4096, "a literal may exceed the raw cap only by the framing");
  assert.ok(options.maxLiteralSize <= 4096 + 2 * 1024 * 1024);
  assert.ok(options.maxResponseSize > options.maxLiteralSize, "above the literal cap, as the parser asks");
  assert.ok(options.maxLineLength >= 1024 * 1024, "a line cap is set at all");
  assert.equal(options.maxLineLength, 16 * 1024 * 1024, "a SEARCH over a large mailbox answers on one line");
  assert.equal(options.logger, false);
  assert.equal(options.tls.rejectUnauthorized, true);

  const refusedBuilt = [];
  const remote = createImapSmtpAdapter({
    account: accountFor({ host: "mail.example.test", port: 143 }),
    credentials: passwordCredentials(FAKE_PASSWORD),
    timeouts: FAST,
    clientFactory: (opts) => {
      refusedBuilt.push(opts);
      return stubClient();
    },
  });
  try {
    const err = await rejectionOf(remote.connect());
    assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
    assert.equal(err.code, "BAD_INPUT");
    assert.deepEqual(refusedBuilt, [], "a cleartext host that is not loopback builds no client");
  } finally {
    await remote.close();
  }

  for (const host of ["127.0.0.1", "::1", "localhost"]) {
    const allowedBuilt = [];
    const adapter = createImapSmtpAdapter({
      account: accountFor({ host, port: 143 }),
      credentials: passwordCredentials(FAKE_PASSWORD),
      timeouts: FAST,
      clientFactory: (opts) => {
        allowedBuilt.push(opts);
        return stubClient();
      },
    });
    try {
      await adapter.connect();
    } finally {
      await adapter.close();
    }
    assert.equal(allowedBuilt.length, 1, `${host} is loopback, so cleartext is allowed`);
  }
});

test("a server that does not offer STARTTLS fails closed instead of signing in in the clear", async () => {
  const fake = await startFake();
  const adapter = createImapSmtpAdapter({
    account: accountFor(fake, { imap: { host: fake.host, port: fake.port, security: "starttls" } }),
    credentials: passwordCredentials(FAKE_PASSWORD),
    timeouts: FAST,
  });
  try {
    const err = await rejectionOf(adapter.connect());
    assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
    assert.equal(err.code, "TLS");
    assert.equal(err.message, MAIL_ERROR_TEXT.TLS);
    assert.ok(!String(err.message).includes(FAKE_PASSWORD), "no credential in the sentence");
    assert.deepEqual(fake.logins, [], "nothing was offered to a server that could not upgrade");
    await waitFor(() => fake.openConnections() === 0);
  } finally {
    await adapter.close();
    await stopFake(fake);
  }
});

test("a server literal above the parser cap rejects with a MailError and its bytes are never sent", async () => {
  const literalServer = await startLiteralServer(4 * 1024 * 1024);
  const adapter = createImapSmtpAdapter({
    account: accountFor(literalServer),
    credentials: passwordCredentials(FAKE_PASSWORD),
    timeouts: FAST,
    maxRawBytes: 1024,
  });
  try {
    await adapter.connect();
    const started = Date.now();
    const err = await rejectionOf(adapter.get("INBOX", [1]));
    const elapsed = Date.now() - started;
    assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
    assert.equal(err.code, "PROTOCOL");
    assert.equal(literalServer.literalsDeclared(), 1, "the oversized declaration was what arrived");
    assert.notEqual(err.detail, "command_deadline", "it was refused, not left waiting for the body");
    for (const field of ["response", "responseText", "executedCommand"]) {
      assert.ok(!Object.hasOwn(err, field), `the library field ${field} does not travel`);
    }
    assert.ok(!String(err.message).includes("Literal size"), "no parser sentence travels");
    assert.ok(elapsed < 3000, `the declaration was refused without waiting for the body (${elapsed} ms)`);
  } finally {
    await adapter.close();
    await literalServer.close();
  }
});

test("get drops the bytes of a message the server under-reported and reports it as oversized", async () => {
  const fake = await startFake();
  const big = fake.deliver("INBOX", makeRaw({ subject: "under-reported", body: "x".repeat(3000) }));
  const small = fake.deliver("INBOX", makeRaw({ subject: "small enough", body: "hello" }));
  const fetches = [];
  const adapter = adapterFor(fake, {
    maxRawBytes: 500,
    clientFactory: (options) => {
      const client = new ImapFlow(options);
      const fetch = client.fetch.bind(client);
      client.fetch = async function* (range, query, opts) {
        const body = Boolean(query && query.source);
        fetches.push({ range: String(range), body });
        for await (const message of fetch(range, query, opts)) {
          // The metadata answer names a size far below the message the server then sends.
          if (query && query.size === true && message.uid === big) yield { ...message, size: 12 };
          else yield message;
        }
      };
      return client;
    },
  });
  try {
    await adapter.connect();
    const messages = await adapter.get("INBOX", [big, small]);
    assert.equal(messages.length, 2, "both uids are still reported");
    assert.ok(
      fetches.some((call) => call.body && rangeHas(call.range, big)),
      "the under-reported body was asked for, so the drop happened after it arrived",
    );
    const oversized = messages.find((message) => message.uid === big);
    assert.equal(oversized.raw.length, 0, "the larger-than-reported body is dropped, not kept");
    assert.equal(typeof oversized.internalDate, "number", "its metadata still comes through");
    const kept = messages.find((message) => message.uid === small);
    assert.match(kept.raw.toString("utf8"), /small enough/);
  } finally {
    await adapter.close();
    await stopFake(fake);
  }
});

test("get stops at its byte budget, leaves the rest absent, and returns them in the next call", async () => {
  const fake = await startFake();
  const raw = makeRaw({ subject: "budgeted", body: "y".repeat(300) });
  const rawSize = Buffer.byteLength(raw);
  const uids = [];
  for (let index = 0; index < 8; index += 1) uids.push(fake.deliver("INBOX", raw));
  const adapter = adapterFor(fake, { maxRawBytes: rawSize + 10 });
  try {
    await adapter.connect();
    const first = await adapter.get("INBOX", uids);
    assert.ok(first.length >= 1 && first.length < uids.length, `one call stops part way (${first.length})`);
    assert.ok(first.every((message) => message.raw.length > 0), "every reported message carries its bytes");
    const reported = new Set(first.map((message) => message.uid));
    const rest = uids.filter((uid) => !reported.has(uid));
    assert.ok(rest.length > 0, "the rest of the uids is absent from the result");
    assert.deepEqual(
      first.map((message) => message.uid),
      uids.slice(0, first.length),
      "the budget stops in uid order",
    );

    const second = await adapter.get("INBOX", rest);
    assert.deepEqual(second.map((message) => message.uid), rest, "the next call fetches what was left");
    assert.ok(second.every((message) => message.raw.length > 0));
  } finally {
    await adapter.close();
    await stopFake(fake);
  }
});

/* --------------------------------------------------------------------- uid bookkeeping */

test("list drops a row whose uid is not a safe integer, and uidNext never becomes NaN", async () => {
  const fake = await startFake();
  fake.deliver("INBOX", makeRaw({ subject: "one" }));
  fake.deliver("INBOX", makeRaw({ subject: "two" }));
  const adapter = adapterFor(fake, {
    clientFactory: (options) => {
      const client = new ImapFlow(options);
      const openLock = client.getMailboxLock.bind(client);
      client.getMailboxLock = async (path, lockOptions) => {
        const lock = await openLock(path, lockOptions);
        if (client.mailbox) client.mailbox.uidNext = undefined;
        return lock;
      };
      client.status = async (path) => ({ path, messages: 2 });
      const fetch = client.fetch.bind(client);
      client.fetch = async function* (range, query, opts) {
        for await (const message of fetch(range, query, opts)) yield message;
        if (query && query.uid === true && query.size === true) {
          // A row that names no message: no usable uid, so nothing may store it or derive uidNext.
          yield { uid: Number.NaN, flags: [], internalDate: new Date(0), size: 1 };
        }
      };
      return client;
    },
  });
  try {
    await adapter.connect();
    const listing = await adapter.list("INBOX");
    assert.deepEqual(listing.items.map((item) => item.uid), [1, 2], "only rows with a usable uid are listed");
    assert.ok(listing.items.every((item) => Number.isSafeInteger(item.uid)));
    assert.equal(listing.uidNext, 3, "the guessed uidNext skips the unusable row");
    assert.ok(Number.isSafeInteger(listing.uidNext), "uidNext is a safe integer, never NaN");
  } finally {
    await adapter.close();
    await stopFake(fake);
  }
});

test("a very large listing still yields a uidNext instead of exhausting the argument list", async () => {
  const MANY = 200_000;
  const adapter = createImapSmtpAdapter({
    account: accountFor({ host: "127.0.0.1", port: 143 }),
    credentials: passwordCredentials(FAKE_PASSWORD),
    timeouts: FAST,
    clientFactory: () => stubClient({
      search: async () => Array.from({ length: MANY }, (_, index) => index + 1),
      fetch: async function* (range) {
        for (const part of String(range).split(",")) {
          const uid = Number(part);
          if (!Number.isSafeInteger(uid)) continue;
          yield { uid, flags: [], internalDate: new Date(0), size: 10 };
        }
      },
    }),
  });
  try {
    await adapter.connect();
    const listing = await adapter.list("INBOX");
    assert.equal(listing.items.length, MANY);
    assert.equal(listing.uidNext, MANY + 1);
  } finally {
    await adapter.close();
  }
});

/* ------------------------------------------------------------- names Crow will not command */

test("listFolders keeps a hostile name listed but out of every command, and drops a hostile flag", async () => {
  const fake = await startFake({ mailboxes: ["INBOX", "Odd"] });
  fake.deliver("INBOX", makeRaw({ subject: "findme", body: "wombat" }));
  const locks = [];
  const listed = [
    { path: "INBOX", name: "INBOX", specialUse: null, delimiter: "/", flags: new Set(["\\HasNoChildren"]) },
    {
      path: "Evil\r\nA9 LOGOUT",
      name: "Evil",
      specialUse: null,
      delimiter: "/",
      flags: new Set(["\\HasNoChildren"]),
    },
    { path: "Odd", name: "Odd", specialUse: "\u0001\\Sent", delimiter: "/", flags: new Set(["\\HasNoChildren"]) },
  ];
  const adapter = adapterFor(fake, {
    clientFactory: (options) => {
      const client = new ImapFlow(options);
      client.list = async () => listed;
      const openLock = client.getMailboxLock.bind(client);
      client.getMailboxLock = async (path, lockOptions) => {
        locks.push(path);
        return openLock(path, lockOptions);
      };
      return client;
    },
  });
  try {
    await adapter.connect();
    const folders = await adapter.listFolders();
    assert.deepEqual(
      folders.map((folder) => folder.path),
      ["INBOX", "Evil\r\nA9 LOGOUT", "Odd"],
      "the folder store still sees every folder the server listed, so it deletes no rows",
    );
    const evil = folders.find((folder) => folder.name === "Evil");
    assert.equal(evil.selectable, false, "a name with a control character is never selected or synced");
    assert.equal(folders.find((folder) => folder.path === "INBOX").selectable, true);
    const odd = folders.find((folder) => folder.path === "Odd");
    assert.equal(odd.selectable, true, "the flag is what was hostile, not the folder");
    assert.equal(odd.specialUse, null, "a control character in specialUse reports no flag at all");
    assert.deepEqual(
      await adapter.search("wombat"),
      [{ folderPath: "INBOX", uid: 1 }],
      "the search looks at the folders it can name",
    );
    assert.deepEqual(locks, ["INBOX", "Odd"], "no command ran for the path with a control character");
  } finally {
    await adapter.close();
    await stopFake(fake);
  }
});

test("get asks for a uid once even when the caller repeats it", async () => {
  const fake = await startFake();
  const one = fake.deliver("INBOX", makeRaw({ subject: "one" }));
  const fetches = [];
  const adapter = adapterFor(fake, { clientFactory: recordingClientFactory(fetches) });
  try {
    await adapter.connect();
    const messages = await adapter.get("INBOX", [one, one, one]);
    assert.equal(messages.length, 1);
    assert.ok(fetches.length > 0);
    assert.ok(fetches.every((call) => call.range === String(one)), "the repeated uid is named once");
  } finally {
    await adapter.close();
    await stopFake(fake);
  }
});

/* --------------------------------------------------------- close() during an in-flight call */

function slowStubClient(record) {
  const stub = {
    closed: 0,
    usable: false,
    on() {},
    async connect() {
      await tick(80);
      stub.usable = true;
    },
    close() {
      stub.closed += 1;
      stub.usable = false;
    },
  };
  record.push(stub);
  return stub;
}

test("close() during a slow connect leaves no unhandled rejection and no open client", async () => {
  const clients = [];
  const adapter = createImapSmtpAdapter({
    account: accountFor({ host: "127.0.0.1", port: 143 }),
    credentials: passwordCredentials(FAKE_PASSWORD),
    timeouts: FAST,
    clientFactory: () => slowStubClient(clients),
  });
  const unhandled = [];
  const spy = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", spy);
  let settling;
  try {
    settling = rejectionOf(adapter.connect());
    await tick(15);
    assert.equal(clients[0].closed, 0, "the connect is still in flight when close() runs");
    await adapter.close();
    const err = await settling;
    assert.ok(err instanceof MailError, `the abandoned connect rejects a MailError, got ${err && err.name}`);
    assert.equal(err.code, "NETWORK");
    await tick(30);
    assert.deepEqual(unhandled, [], "close() left no unhandled rejection behind");
    assert.ok(clients[0].closed >= 1, "the client that finished connecting was closed");
    assert.equal(clients[0].usable, false, "no open client is left behind");
  } finally {
    process.off("unhandledRejection", spy);
    await adapter.close();
  }
});

test("close() during a watch's in-flight connect closes that client as soon as it connects", async () => {
  const clients = [];
  const adapter = createImapSmtpAdapter({
    account: accountFor({ host: "127.0.0.1", port: 143 }),
    credentials: passwordCredentials(FAKE_PASSWORD),
    timeouts: FAST,
    clientFactory: () => slowStubClient(clients),
  });
  try {
    const watching = adapter.watch(["INBOX"], { onChange() {}, onError() {} });
    await tick(15);
    await adapter.close();
    const handle = await watching;
    assert.equal(typeof handle.stop, "function");
    assert.equal(clients.length, 1);
    assert.ok(clients[0].closed >= 1, "the watch's client did not stay open after close()");
    assert.equal(clients[0].usable, false);
    handle.stop();
  } finally {
    await adapter.close();
  }
});

/* ------------------------------------------------- a uid get() did not reach is never an empty body */

test("the body fetch asks the server to stop one byte past the raw cap", async () => {
  const fake = await startFake();
  const uid = fake.deliver("INBOX", makeRaw({ subject: "capped", body: "hello" }));
  const fetches = [];
  const adapter = adapterFor(fake, { maxRawBytes: 500, clientFactory: recordingClientFactory(fetches) });
  try {
    await adapter.connect();
    const [message] = await adapter.get("INBOX", [uid]);
    assert.ok(message.raw.length > 0, "the message came back with its bytes");
    const bodyFetches = fetches.filter((call) => call.body);
    assert.ok(bodyFetches.length > 0, "a body fetch was issued");
    for (const call of bodyFetches) {
      assert.deepEqual(call.source, { maxLength: 501 }, "the range is the cap plus one byte, never unbounded");
    }
  } finally {
    await adapter.close();
    await stopFake(fake);
  }
});

test("get leaves out a message expunged between the metadata and the body fetch", async () => {
  const fake = await startFake();
  const gone = fake.deliver("INBOX", makeRaw({ subject: "vanishes", body: "poof" }));
  const stays = fake.deliver("INBOX", makeRaw({ subject: "stays", body: "still here" }));
  let expunged = false;
  const adapter = adapterFor(fake, {
    clientFactory: (options) => {
      const client = new ImapFlow(options);
      const fetch = client.fetch.bind(client);
      client.fetch = async function* (range, query, opts) {
        for await (const message of fetch(range, query, opts)) yield message;
        // The metadata answer named this uid and the mailbox no longer holds it by the time the body is
        // asked for, which is what an expunge in between looks like from here.
        if (!(query && query.source) && !expunged) {
          expunged = true;
          fake.expunge("INBOX", gone);
        }
      };
      return client;
    },
  });
  try {
    await adapter.connect();
    const messages = await adapter.get("INBOX", [gone, stays]);
    assert.deepEqual(
      messages.map((message) => message.uid),
      [stays],
      "a uid with no body is absent from the answer, not reported with an empty Buffer",
    );
    assert.match(messages[0].raw.toString("utf8"), /still here/);
  } finally {
    await adapter.close();
    await stopFake(fake);
  }
});

test("a budget stop leaves the rest absent even when the bodies arrive out of order", async () => {
  const fake = await startFake();
  const raw = makeRaw({ subject: "budgeted", body: "y".repeat(300) });
  const rawSize = Buffer.byteLength(raw);
  const uids = [];
  for (let index = 0; index < 6; index += 1) uids.push(fake.deliver("INBOX", raw));
  // Every message claims ten bytes, so all six fit the planned budget and all six are asked for; the
  // real bodies are what overrun it, and they come back newest first.
  const adapter = adapterFor(fake, {
    maxRawBytes: rawSize + 10,
    clientFactory: (options) => {
      const client = new ImapFlow(options);
      const fetch = client.fetch.bind(client);
      client.fetch = async function* (range, query, opts) {
        const rows = [];
        for await (const message of fetch(range, query, opts)) rows.push(message);
        if (query && query.size) {
          for (const message of rows) yield { ...message, size: 10 };
          return;
        }
        for (const message of query && query.source ? rows.reverse() : rows) yield message;
      };
      return client;
    },
  });
  try {
    await adapter.connect();
    const first = await adapter.get("INBOX", uids);
    assert.ok(first.length > 0 && first.length < uids.length, `the call stops part way (${first.length})`);
    assert.ok(
      first.every((message) => message.raw.length > 0),
      "no uid the call did not finish is reported with an empty Buffer",
    );
    const reported = new Set(first.map((message) => message.uid));
    const rest = uids.filter((uid) => !reported.has(uid));
    assert.ok(rest.length > 0, "the uids the call did not reach are absent from the answer");

    const second = await adapter.get("INBOX", rest);
    assert.deepEqual(second.map((message) => message.uid), rest, "the next call fetches what was left");
    assert.ok(second.every((message) => message.raw.length > 0));
  } finally {
    await adapter.close();
    await stopFake(fake);
  }
});

/* ------------------------------------------------------------------ the generated Message-ID */

test("a Message-ID takes its domain from the From address, an internationalised one as punycode", () => {
  assert.match(messageIdFor("alex@example.com"), /^<[0-9a-f]{32}@example\.com>$/);
  assert.match(messageIdFor("alex@Bücher.Example"), /^<[0-9a-f]{32}@xn--bcher-kva\.example>$/);
  assert.match(messageIdFor("alex@"), /^<[0-9a-f]{32}@localhost>$/, "an address with no domain falls back");
  assert.notEqual(messageIdFor("alex@example.com"), messageIdFor("alex@example.com"));
});
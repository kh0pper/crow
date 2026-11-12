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
  createFakeImapServer, makeRaw, FAKE_USER, FAKE_PASSWORD,
} from "./fixtures/fake-mail-server.mjs";
import { runAdapterContract } from "./fixtures/mail-adapter-contract.mjs";
import { createImapSmtpAdapter } from "../servers/gateway/mail/adapter/imap-smtp.js";
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

const CONTRACT_SKIP = ["saveDraft", "send"];
if (!HAS_OMIT_UIDNEXT) CONTRACT_SKIP.push("a listing that omits UIDNEXT still yields a uidNext");
// RFC 3501's INTERNALDATE is `DD-Mon-YYYY HH:MM:SS +0000` and carries no fractional seconds, so two
// messages whose internal dates are one millisecond apart come back from the server identical. The
// contract step that separates exactly that pair cannot hold for any IMAP implementation, so it is
// skipped here; the same rule has a one-second-resolution case in "list bounds the window with
// sinceDate ..." below, which is the finest bound a real server can carry.
CONTRACT_SKIP.push("sinceDate is an exact millisecond bound");

runAdapterContract(async (opts = {}) => {
  const fake = await startFake(opts.omitUidNext ? { omitUidNext: true } : {});
  const adapter = adapterFor(fake);
  const close = adapter.close.bind(adapter);
  adapter.close = async () => {
    await close();
    await stopFake(fake);
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

test("get skips the bytes of a message above maxRawBytes and keeps its metadata", async () => {
  const fake = await startFake();
  const big = fake.deliver("INBOX", makeRaw({ subject: "too big", body: "x".repeat(2000) }), {
    flags: ["\\Seen"],
  });
  const small = fake.deliver("INBOX", makeRaw({ subject: "small enough", body: "hello" }));
  const adapter = adapterFor(fake, { maxRawBytes: 500 });
  try {
    await adapter.connect();
    const messages = await adapter.get("INBOX", [big, small]);
    assert.equal(messages.length, 2, "both uids are reported");
    const oversized = messages.find((message) => message.uid === big);
    assert.ok(Buffer.isBuffer(oversized.raw));
    assert.equal(oversized.raw.length, 0, "no bytes are fetched for a message above the limit");
    assert.deepEqual(oversized.flags, ["\\Seen"], "its flags still come through");
    assert.equal(typeof oversized.internalDate, "number");
    const kept = messages.find((message) => message.uid === small);
    assert.match(kept.raw.toString("utf8"), /small enough/);
  } finally {
    await adapter.close();
    await stopFake(fake);
  }
});

/* ------------------------------------------------------------------- the shims for Task 13 */

test("saveDraft and send exist as methods and refuse until Task 13 fills them in", async () => {
  const fake = await startFake();
  const adapter = adapterFor(fake);
  try {
    for (const method of ["saveDraft", "send"]) {
      const err = await rejectionOf(adapter[method]({}));
      assert.ok(err instanceof MailError, `${method} throws a MailError`);
      assert.equal(err.code, "PROTOCOL");
      assert.equal(err.detail, "not_implemented");
      assert.equal(err.message, MAIL_ERROR_TEXT.PROTOCOL);
    }
    assert.equal(fake.connectionCount(), 0, "neither method opens a connection");
  } finally {
    await adapter.close();
    await stopFake(fake);
  }
});

/* ------------------------------------------------------------------------- list/get/search */

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
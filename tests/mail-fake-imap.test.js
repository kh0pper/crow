// The in-process fake IMAP server (Task 9 of plan 1) and what imapflow 2.11 needs from it: a
// greeting with capabilities, LIST/LSUB with special-use flags, SELECT with UIDVALIDITY and
// UIDNEXT, SEARCH by date and by UID set, a full-source FETCH, IDLE with EXISTS push, and the
// abrupt connection drop that a real network failure produces. The controls that make a server
// misbehave (`silenceNext`, `failNextLogin`) and the commands the mail adapter sends
// (AUTHENTICATE, UID STORE, EXAMINE, CLOSE, NAMESPACE) have their own cases here, some of them over
// a raw socket because imapflow never sends the sequences they pin down. Every server binds
// 127.0.0.1 port 0, so nothing here depends on a fixed port.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { ImapFlow } from "imapflow";
import {
  createFakeImapServer, makeRaw, FAKE_USER,
  FAKE_PASSWORD,
} from "./fixtures/fake-mail-server.mjs";

const openServers = new Set();
const openClients = new Set();

after(async () => {
  for (const client of openClients) {
    try {
      client.close();
    } catch {
      // the client may already be closed by its test
    }
  }
  openClients.clear();
  for (const fake of openServers) await fake.close();
  openServers.clear();
});

async function startFake(options) {
  const fake = await createFakeImapServer(options);
  openServers.add(fake);
  return fake;
}

function makeClient(fake, overrides = {}) {
  const client = new ImapFlow({
    host: fake.host,
    port: fake.port,
    secure: false,
    logger: false,
    disableAutoIdle: true,
    auth: { user: FAKE_USER, pass: FAKE_PASSWORD },
    ...overrides,
  });
  openClients.add(client);
  return client;
}

async function connectFake(fake, overrides) {
  const client = makeClient(fake, overrides);
  await client.connect();
  return client;
}

/** Polls a predicate until it holds, so a pushed response never depends on a fixed delay. */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

/**
 * A raw socket session, for the parts of the protocol imapflow never exercises: an IDLE line that
 * is not DONE, and a command issued after CLOSE. Lines matching no waiter are kept, so a test can
 * check that a line was never sent.
 */
async function openRaw(fake) {
  const socket = net.connect({ host: fake.host, port: fake.port });
  socket.setEncoding("utf8");
  const lines = [];
  const waiters = new Set();
  let buffer = "";

  socket.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf("\r\n");
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const waiter = [...waiters].find((entry) => entry.predicate(line));
      if (!waiter) {
        lines.push(line);
        continue;
      }
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(line);
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("the connection closed"));
    }
    waiters.clear();
  });

  await new Promise((resolve, reject) => {
    const failed = (err) => reject(err);
    socket.once("error", failed);
    socket.once("connect", () => {
      socket.removeListener("error", failed);
      resolve();
    });
  });

  return {
    send(line) {
      socket.write(`${line}\r\n`);
    },
    /** The first matching line, already buffered or arriving later. */
    next(predicate, timeoutMs = 3000) {
      const buffered = lines.findIndex(predicate);
      if (buffered >= 0) return Promise.resolve(lines.splice(buffered, 1)[0]);
      return new Promise((resolve, reject) => {
        const entry = { predicate, resolve, reject };
        entry.timer = setTimeout(() => {
          waiters.delete(entry);
          reject(new Error("timed out waiting for a line"));
        }, timeoutMs);
        waiters.add(entry);
      });
    },
    unconsumed() {
      return [...lines];
    },
    close() {
      socket.destroy();
    },
  };
}

/** Signs in on a raw session and asserts the tagged OK. */
async function rawLogin(raw) {
  raw.send(`a1 LOGIN ${FAKE_USER} ${FAKE_PASSWORD}`);
  assert.match(await raw.next((line) => line.startsWith("a1 ")), /^a1 OK/);
}

test("connect, list, select and fetch a message source", async () => {
  const fake = await startFake();
  const uid = fake.deliver("INBOX", makeRaw({ subject: "First message", body: "Hello there." }));
  const client = await connectFake(fake);

  const folders = await client.list();
  const paths = folders.map((folder) => folder.path);
  assert.ok(paths.includes("INBOX"));
  assert.ok(paths.includes("Sent"));
  assert.equal(folders.find((folder) => folder.path === "Sent").specialUse, "\\Sent");

  const box = await client.mailboxOpen("INBOX");
  assert.equal(box.exists, 1);
  assert.equal(Number(box.uidValidity), 1);
  assert.equal(Number(box.uidNext), uid + 1);

  const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
  assert.equal(message.uid, uid);
  assert.match(message.source.toString(), /Subject: First message/);
  assert.match(message.source.toString(), /Hello there\./);

  const status = await client.status("INBOX", { messages: true, uidNext: true, uidValidity: true, unseen: true });
  assert.equal(status.messages, 1);
  assert.equal(status.uidNext, uid + 1);
  assert.equal(status.unseen, 1);

  assert.ok(fake.commands.includes("LIST"));
  assert.ok(fake.commands.includes("SELECT"));
  assert.ok(fake.commands.includes("UID FETCH"));
  assert.equal(fake.connectionCount(), 1);
  assert.equal(fake.logins.length, 1);
  assert.equal(fake.logins[0].user, FAKE_USER);

  await client.logout();
});

test("the LOGIN command is accepted when the client asks for it", async () => {
  const fake = await startFake();
  const client = await connectFake(fake, {
    auth: { user: FAKE_USER, pass: FAKE_PASSWORD, loginMethod: "LOGIN" },
  });
  assert.equal(fake.logins[0].method, "LOGIN");
  assert.ok(fake.commands.includes("LOGIN"));
  await client.logout();
});

test("a wrong password is reported as a failed authentication", async () => {
  const fake = await startFake();
  const client = makeClient(fake, { auth: { user: FAKE_USER, pass: "not-the-password" } });

  const err = await rejectionOf(client.connect());
  assert.ok(err, "connecting with a wrong password must reject");
  assert.equal(err.authenticationFailed, true);
  assert.equal(fake.logins.length, 0);
});

test("SEARCH SINCE filters by internal date", async () => {
  const fake = await startFake();
  fake.deliver("INBOX", makeRaw({ subject: "Old" }), { internalDate: new Date("2024-01-05T10:00:00Z") });
  const recent = fake.deliver("INBOX", makeRaw({ subject: "Recent" }), {
    internalDate: new Date("2024-06-05T10:00:00Z"),
  });
  const client = await connectFake(fake);
  await client.mailboxOpen("INBOX");

  const uids = await client.search({ since: new Date("2024-03-01T00:00:00Z") }, { uid: true });
  assert.deepEqual(uids, [recent]);

  const all = await client.search({ all: true }, { uid: true });
  assert.deepEqual(all, [1, recent]);
  await client.logout();
});

test("UID SEARCH UID n:* returns the last message when n is above the highest UID", async () => {
  const fake = await startFake();
  fake.deliver("INBOX", makeRaw({ subject: "One" }));
  const last = fake.deliver("INBOX", makeRaw({ subject: "Two" }));
  const client = await connectFake(fake);
  await client.mailboxOpen("INBOX");

  const uids = await client.search({ uid: `${last + 500}:*` }, { uid: true });
  assert.deepEqual(uids, [last]);

  const below = await client.search({ uid: "2:3" }, { uid: true });
  assert.deepEqual(below, [last]);
  await client.logout();
});

test("IDLE reports EXISTS after a delivery", async () => {
  const fake = await startFake();
  const client = await connectFake(fake);
  await client.mailboxOpen("INBOX");

  const exists = new Promise((resolve) => client.once("exists", resolve));
  const idle = client.idle().catch((err) => err);
  await waitFor(() => fake.commands.includes("IDLE"));

  const uid = fake.deliver("INBOX", makeRaw({ subject: "Arrived while idling" }));
  const event = await exists;
  assert.equal(event.path, "INBOX");
  assert.equal(event.count, 1);
  assert.equal(uid, 1);
  assert.equal(fake.commands.filter((name) => name === "NOOP").length, 0);

  client.close();
  const idleResult = await idle;
  // A closed connection ends IDLE: imapflow reports that as false or as an error.
  assert.ok(idleResult === false || idleResult === undefined || idleResult instanceof Error);
});

test("a bumped UIDVALIDITY appears on the next SELECT", async () => {
  const fake = await startFake();
  const client = await connectFake(fake);

  const first = await client.mailboxOpen("INBOX");
  assert.equal(Number(first.uidValidity), 1);

  const bumped = fake.bumpUidValidity("INBOX");
  assert.equal(bumped, 2);

  const again = await client.mailboxOpen("INBOX");
  assert.equal(Number(again.uidValidity), 2);
  await client.logout();
});

test("expunge drops the UID from the mailbox", async () => {
  const fake = await startFake();
  const first = fake.deliver("INBOX", makeRaw({ subject: "One" }));
  const second = fake.deliver("INBOX", makeRaw({ subject: "Two" }));
  const client = await connectFake(fake);
  await client.mailboxOpen("INBOX");

  const expunged = [];
  client.on("expunge", (event) => expunged.push(event));
  assert.equal(fake.expunge("INBOX", first), true);
  await waitFor(() => expunged.length === 1);
  assert.equal(expunged[0].seq, 1);
  assert.equal(client.mailbox.exists, 1);

  const uids = await client.search({ all: true }, { uid: true });
  assert.deepEqual(uids, [second]);
  await client.logout();
});

test("moveIn gives a new high UID with an old internal date", async () => {
  const fake = await startFake();
  const first = fake.deliver("INBOX", makeRaw({ subject: "Already here" }), {
    internalDate: new Date("2024-05-01T00:00:00Z"),
  });
  const moved = fake.moveIn("INBOX", makeRaw({ subject: "Moved in" }), {
    internalDate: new Date("2023-02-03T04:05:06Z"),
  });
  assert.ok(moved > first);

  const client = await connectFake(fake);
  await client.mailboxOpen("INBOX");
  const message = await client.fetchOne(String(moved), { uid: true, internalDate: true, size: true }, { uid: true });
  assert.equal(message.uid, moved);
  assert.ok(message.internalDate instanceof Date, "INTERNALDATE must parse to a Date");
  assert.equal(message.internalDate.toISOString().slice(0, 10), "2023-02-03");
  assert.ok(message.size > 0);
  await client.logout();
});

test("SEARCH OR TEXT matches either word", async () => {
  const fake = await startFake();
  const invoice = fake.deliver("INBOX", makeRaw({ subject: "One", body: "The invoice is attached." }));
  const receipt = fake.deliver("INBOX", makeRaw({ subject: "Two", body: "Here is the receipt." }));
  fake.deliver("INBOX", makeRaw({ subject: "Three", body: "Nothing to see." }));
  const client = await connectFake(fake);
  await client.mailboxOpen("INBOX");

  const uids = await client.search({ or: [{ text: "invoice" }, { text: "receipt" }] }, { uid: true });
  assert.deepEqual(uids, [invoice, receipt]);
  await client.logout();
});

test("setFlags, addMailbox and removeMailbox move the mailbox state", async () => {
  const fake = await startFake();
  const uid = fake.deliver("INBOX", makeRaw({ subject: "Flag me" }));
  const client = await connectFake(fake);
  await client.mailboxOpen("INBOX");

  assert.equal(fake.setFlags("INBOX", uid, ["\\Seen"]), true);
  const status = await client.status("INBOX", { messages: true, unseen: true });
  assert.equal(status.messages, 1);
  assert.equal(status.unseen, 0);

  fake.addMailbox("Archive", { specialUse: "\\Archive" });
  const added = await client.list();
  const archive = added.find((folder) => folder.path === "Archive");
  assert.ok(archive);
  assert.equal(archive.specialUse, "\\Archive");

  fake.removeMailbox("Archive");
  const after = await client.list();
  assert.equal(after.some((folder) => folder.path === "Archive"), false);
  await client.logout();
});

test("APPEND stores the message in the named mailbox with its flags", async () => {
  const fake = await startFake();
  const client = await connectFake(fake);

  const raw = makeRaw({ subject: "Draft from the fake", body: "Not sent yet." });
  const result = await client.append("Drafts", raw, ["\\Draft"]);
  assert.equal(result.destination, "Drafts");

  assert.equal(fake.appended.length, 1);
  assert.equal(fake.appended[0].mailbox, "Drafts");
  assert.deepEqual(fake.appended[0].flags, ["\\Draft"]);
  assert.equal(fake.appended[0].raw.length, Buffer.byteLength(raw));
  assert.match(fake.appended[0].raw.toString(), /Subject: Draft from the fake/);
  assert.ok(fake.commands.includes("APPEND"));

  // It lands in the mailbox itself, readable like any other message there.
  const box = await client.mailboxOpen("Drafts");
  assert.equal(box.exists, 1);
  const stored = await client.fetchOne("1", { uid: true, flags: true, source: true }, { uid: true });
  assert.equal(stored.uid, 1);
  assert.ok(stored.flags.has("\\Draft"));
  assert.equal(stored.flags.has("\\Seen"), false);
  assert.match(stored.source.toString(), /Not sent yet\./);

  // Nothing was appended to the mailbox the client had not named.
  const inbox = await client.status("INBOX", { messages: true });
  assert.equal(inbox.messages, 0);
  await client.logout();
});

test("omitUidNext leaves UIDNEXT out of SELECT while STATUS still answers it", async () => {
  const fake = await startFake({ omitUidNext: true });
  const uid = fake.deliver("INBOX", makeRaw({ subject: "No UIDNEXT in SELECT" }));
  const client = await connectFake(fake);

  const box = await client.mailboxOpen("INBOX");
  assert.equal(box.exists, 1);
  assert.equal(box.uidNext, undefined);

  const status = await client.status("INBOX", { messages: true, uidNext: true });
  assert.equal(status.messages, 1);
  assert.equal(status.uidNext, uid + 1);
  await client.logout();
});

test("a dropped connection with no error listener reaches uncaughtException", async () => {
  const fake = await startFake();
  const client = makeClient(fake);
  await client.connect();

  let caught = null;
  process.setUncaughtExceptionCaptureCallback((err) => {
    caught = err;
  });
  try {
    fake.dropConnections();
    await waitFor(() => caught !== null);
  } finally {
    process.setUncaughtExceptionCaptureCallback(null);
  }
  assert.ok(caught instanceof Error);
  try {
    client.close();
  } catch {
    // the connection is already gone
  }
});

test("close leaves no listener behind", async () => {
  const fake = await startFake();
  const client = await connectFake(fake);
  assert.equal(fake.connectionCount(), 1);

  await client.logout();
  await waitFor(() => fake.openConnections() === 0);
  await fake.close();
  assert.equal(fake.openConnections(), 0);

  const refused = await new Promise((resolve) => {
    const probe = net.connect({ host: fake.host, port: fake.port });
    probe.once("connect", () => {
      probe.destroy();
      resolve(false);
    });
    probe.once("error", () => resolve(true));
  });
  assert.equal(refused, true);
  await fake.close();
});

/* ---------------------------------------------------------- the controls a test needs */

test("silenceNext leaves the next command unanswered", async () => {
  const fake = await startFake();
  fake.deliver("INBOX", makeRaw({ subject: "Quiet" }));
  const client = await connectFake(fake);
  await client.mailboxOpen("INBOX");

  fake.silenceNext();
  // Either outcome settles; what the race shows is that it does not settle within the window.
  const pending = client.noop().then(() => "answered", () => "answered");
  const outcome = await Promise.race([pending, tick(250).then(() => "silent")]);
  assert.equal(outcome, "silent", "the silenced command was never answered");
  assert.ok(fake.commands.includes("NOOP"), "the command was read and recorded anyway");

  client.close();
  await waitFor(() => fake.openConnections() === 0);
});

test("failNextLogin refuses exactly one sign-in", async () => {
  const fake = await startFake();
  fake.failNextLogin();

  const refused = makeClient(fake);
  const err = await rejectionOf(refused.connect());
  assert.ok(err, "the first sign-in is refused");
  assert.equal(err.authenticationFailed, true);
  assert.deepEqual(fake.logins, [], "a refused sign-in is not recorded as a login");

  const client = await connectFake(fake);
  assert.deepEqual(fake.logins, [{ user: FAKE_USER, method: "AUTHENTICATE PLAIN" }],
    "the next sign-in goes through");
  await client.logout();
});

test("AUTHENTICATE PLAIN and AUTHENTICATE XOAUTH2 are recorded with their method", async () => {
  const fake = await startFake();

  const plain = await connectFake(fake, {
    auth: { user: FAKE_USER, pass: FAKE_PASSWORD, loginMethod: "AUTH=PLAIN" },
  });
  await plain.logout();

  const oauth = await connectFake(fake, { auth: { user: FAKE_USER, accessToken: "access-token-1" } });
  await oauth.logout();

  assert.deepEqual(fake.logins, [
    { user: FAKE_USER, method: "AUTHENTICATE PLAIN" },
    { user: FAKE_USER, method: "AUTHENTICATE XOAUTH2" },
  ]);
  assert.ok(fake.commands.includes("AUTHENTICATE"));
});

/* ------------------------------------------------------- the commands the adapter sends */

test("UID STORE changes the flags a later fetch reports", async () => {
  const fake = await startFake();
  const uid = fake.deliver("INBOX", makeRaw({ subject: "Flag me too" }));
  const client = await connectFake(fake);
  await client.mailboxOpen("INBOX");

  await client.messageFlagsAdd(String(uid), ["\\Seen", "\\Flagged"], { uid: true });
  assert.ok(fake.commands.includes("UID STORE"));

  const flagged = await client.fetchOne(String(uid), { flags: true }, { uid: true });
  assert.deepEqual([...flagged.flags].sort(), ["\\Flagged", "\\Seen"]);
  assert.equal((await client.status("INBOX", { unseen: true })).unseen, 0);

  await client.messageFlagsRemove(String(uid), ["\\Seen"], { uid: true });
  const unflagged = await client.fetchOne(String(uid), { flags: true }, { uid: true });
  assert.deepEqual([...unflagged.flags], ["\\Flagged"]);
  assert.equal((await client.status("INBOX", { unseen: true })).unseen, 1);
  await client.logout();
});

test("EXAMINE opens a mailbox read-only and refuses a flag change", async () => {
  const fake = await startFake();
  const uid = fake.deliver("INBOX", makeRaw({ subject: "Look, do not touch" }));
  const client = await connectFake(fake);

  const box = await client.mailboxOpen("INBOX", { readOnly: true });
  assert.equal(box.readOnly, true);
  assert.ok(fake.commands.includes("EXAMINE"));

  // imapflow reports a refused STORE as `false` rather than an error.
  assert.equal(await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }), false,
    "a flag change in a read-only mailbox is refused");
  assert.equal((await client.status("INBOX", { unseen: true })).unseen, 1,
    "the refused change did not stick");

  // The same mailbox is writable under SELECT.
  const writable = await client.mailboxOpen("INBOX");
  assert.equal(writable.readOnly, false);
  await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
  assert.equal((await client.status("INBOX", { unseen: true })).unseen, 0);
  await client.logout();

  // On the wire the refusal is a tagged NO, not a STORE that quietly does nothing.
  const raw = await openRaw(fake);
  try {
    await rawLogin(raw);
    raw.send("a2 EXAMINE INBOX");
    const selected = await raw.next((line) => line.startsWith("a2 "));
    assert.match(selected, /^a2 OK \[READ-ONLY\]/);
    raw.send("a3 STORE 1 +FLAGS (\\Flagged)");
    assert.match(await raw.next((line) => line.startsWith("a3 ")), /^a3 NO \[READ-ONLY\]/);
  } finally {
    raw.close();
  }
});

test("CLOSE ends the selection and the next command sees no mailbox", async () => {
  const fake = await startFake();
  fake.deliver("INBOX", makeRaw({ subject: "Closing" }));
  const raw = await openRaw(fake);
  try {
    await rawLogin(raw);
    raw.send("a2 SELECT INBOX");
    assert.match(await raw.next((line) => line.startsWith("a2 ")), /^a2 OK/);

    raw.send("a3 CLOSE");
    assert.match(await raw.next((line) => line.startsWith("a3 ")), /^a3 OK CLOSE completed/);

    raw.send("a4 UID STORE 1 +FLAGS (\\Seen)");
    assert.match(await raw.next((line) => line.startsWith("a4 ")), /^a4 BAD no mailbox selected/);
  } finally {
    raw.close();
  }
});

test("NAMESPACE reports the personal namespace", async () => {
  const fake = await startFake();
  const client = await connectFake(fake);
  assert.ok(fake.commands.includes("NAMESPACE"));
  assert.deepEqual(client.namespaces.personal, [{ prefix: "", delimiter: "/" }]);
  assert.equal(client.namespaces.other, false);
  assert.equal(client.namespaces.shared, false);
  await client.logout();
});

/* ------------------------------------------------------------------------------ IDLE */

test("IDLE reports an EXPUNGE pushed while idling", async () => {
  const fake = await startFake();
  const first = fake.deliver("INBOX", makeRaw({ subject: "One" }));
  fake.deliver("INBOX", makeRaw({ subject: "Two" }));
  const client = await connectFake(fake);
  await client.mailboxOpen("INBOX");

  const expunged = new Promise((resolve) => client.once("expunge", resolve));
  const idle = client.idle().catch((err) => err);
  await waitFor(() => fake.commands.includes("IDLE"));

  assert.equal(fake.expunge("INBOX", first), true);
  const event = await expunged;
  assert.equal(event.path, "INBOX");
  assert.equal(event.seq, 1);
  assert.equal(client.mailbox.exists, 1);

  client.close();
  const idleResult = await idle;
  // A closed connection ends IDLE: imapflow reports that as false or as an error.
  assert.ok(idleResult === false || idleResult === undefined || idleResult instanceof Error);
});

test("IDLE ends with a tagged OK on DONE and a tagged BAD on any other line", async () => {
  const fake = await startFake();
  const raw = await openRaw(fake);
  try {
    await rawLogin(raw);
    raw.send("a2 SELECT INBOX");
    assert.match(await raw.next((line) => line.startsWith("a2 ")), /^a2 OK/);

    raw.send("a3 IDLE");
    assert.equal(await raw.next((line) => line.startsWith("+")), "+ idling");
    raw.send("DONE");
    assert.match(await raw.next((line) => line.startsWith("a3 ")), /^a3 OK IDLE terminated/);

    raw.send("a4 IDLE");
    assert.equal(await raw.next((line) => line.startsWith("+")), "+ idling");
    // A line that is not DONE ends the IDLE for the IDLE's own tag; it is not run as a command.
    raw.send("a5 NOOP");
    assert.match(await raw.next((line) => line.startsWith("a4 ")), /^a4 BAD/);
    await tick(150);
    assert.deepEqual(raw.unconsumed().filter((line) => line.startsWith("a5 ")), [],
      "the line was not answered as a command");
  } finally {
    raw.close();
  }
  assert.equal(fake.commands.filter((name) => name === "NOOP").length, 0);
});

/* ---------------------------------------------------------------------------- SEARCH */

test("FROM, TO, CC and SUBJECT match their own header only", async () => {
  const fake = await startFake();
  // Each needle sits in exactly one header, and kim also appears in the body: a search over the
  // whole raw message would answer every one of these.
  const uid = fake.deliver("INBOX", makeRaw({
    from: "alex@example.com",
    to: "sam@example.com",
    subject: "Quarterly report",
    body: "kim@example.com is only mentioned here, and a wombat appears too.",
    extraHeaders: { Cc: "kim@example.com" },
  }));
  const client = await connectFake(fake);
  await client.mailboxOpen("INBOX");

  assert.deepEqual(await client.search({ from: "alex@example.com" }, { uid: true }), [uid]);
  assert.deepEqual(await client.search({ from: "sam@example.com" }, { uid: true }), [],
    "a recipient is not a sender");
  assert.deepEqual(await client.search({ to: "sam@example.com" }, { uid: true }), [uid]);
  assert.deepEqual(await client.search({ to: "kim@example.com" }, { uid: true }), [],
    "a cc is not a to");
  assert.deepEqual(await client.search({ cc: "kim@example.com" }, { uid: true }), [uid]);
  assert.deepEqual(await client.search({ subject: "report" }, { uid: true }), [uid]);
  assert.deepEqual(await client.search({ subject: "wombat" }, { uid: true }), [],
    "body text is not a subject");
  assert.deepEqual(await client.search({ from: "ALEX@EXAMPLE.COM" }, { uid: true }), [uid],
    "the match is case-insensitive");
  await client.logout();
});

test("HEADER matches the named header and its value", async () => {
  const fake = await startFake();
  const tagged = fake.deliver("INBOX", makeRaw({
    subject: "Tagged",
    body: "Nothing about the marker here.",
    extraHeaders: { "X-Marker": "wombat-42" },
  }));
  fake.deliver("INBOX", makeRaw({ subject: "Untagged", body: "Plain." }));
  const client = await connectFake(fake);
  await client.mailboxOpen("INBOX");

  assert.deepEqual(await client.search({ header: { "X-Marker": "wombat-42" } }, { uid: true }), [tagged]);
  assert.deepEqual(await client.search({ header: { "X-Marker": "nope" } }, { uid: true }), []);
  // The value has to be in the named header: the same text elsewhere does not match.
  assert.deepEqual(await client.search({ header: { Subject: "wombat-42" } }, { uid: true }), []);
  await client.logout();
});

/* ----------------------------------------------------------------------------- FETCH */

test("a partial section fetch answers with the requested bytes under the <0> origin", async () => {
  const fake = await startFake();
  const raw = makeRaw({ subject: "Partial me", body: "0123456789" });
  const bytes = Buffer.from(raw, "utf8");
  fake.deliver("INBOX", raw);
  const client = await connectFake(fake);
  await client.mailboxOpen("INBOX");

  const capped = await client.fetchOne("1", { source: { maxLength: 40 } }, { uid: true });
  assert.equal(capped.source.length, 40, "the answer stops at the requested length");
  assert.deepEqual(capped.source, bytes.subarray(0, 40), "and it is the first bytes of the message");

  const whole = await client.fetchOne("1", { source: true }, { uid: true });
  assert.equal(whole.source.length, bytes.length, "a fetch with no range is still the whole message");
  assert.deepEqual(whole.source, bytes);
  await client.logout();
});

test("a BODYSTRUCTURE fetch is not answered as BODY[]", async () => {
  const fake = await startFake();
  fake.deliver("INBOX", makeRaw({ subject: "Structure me", body: "Body text." }));
  const raw = await openRaw(fake);
  try {
    await rawLogin(raw);
    raw.send("a2 SELECT INBOX");
    assert.match(await raw.next((line) => line.startsWith("a2 ")), /^a2 OK/);

    raw.send("a3 UID FETCH 1 (BODYSTRUCTURE)");
    const row = await raw.next((line) => line.startsWith("* 1 FETCH"));
    assert.ok(!row.includes("BODY["), "the structure is not answered with the message");
    assert.match(await raw.next((line) => line.startsWith("a3 ")), /^a3 OK FETCH completed/);
    await tick(50);
    assert.deepEqual(raw.unconsumed().filter((line) => line.includes("Subject:")), [],
      "no message bytes went out for a BODY item that is not a section fetch");

    raw.send("a4 UID FETCH 1 (BODY.PEEK[])");
    assert.match(await raw.next((line) => line.startsWith("* 1 FETCH")), /BODY\[\] \{\d+\}/);
    assert.match(await raw.next((line) => line.startsWith("a4 ")), /^a4 OK FETCH completed/);
  } finally {
    raw.close();
  }
});

/* ------------------------------------------------------------------------------ LIST */

test("a mailbox name is escaped in the LIST line and survives the round trip", async () => {
  const fake = await startFake();
  const path = 'Odd "quoted" \\ name';
  fake.addMailbox(path);

  const raw = await openRaw(fake);
  try {
    await rawLogin(raw);
    raw.send('a2 LIST "" "*"');
    const line = await raw.next((text) => text.includes("Odd"));
    assert.equal(line, '* LIST (\\HasNoChildren) "/" "Odd \\"quoted\\" \\\\ name"');
    assert.match(await raw.next((text) => text.startsWith("a2 ")), /^a2 OK/);
  } finally {
    raw.close();
  }

  const client = await connectFake(fake);
  const folders = await client.list();
  assert.ok(folders.some((folder) => folder.path === path), "the name survives the round trip");
  await client.logout();
});

/* ----------------------------------------------------------------------------- close */

test("close leaves no socket from the server behind", async () => {
  // Socket handles come and go in the whole process, so the check is a delta against a baseline
  // taken before this server exists.
  const sockets = () => process.getActiveResourcesInfo().filter((name) => name.startsWith("TCP")).length;
  const baseline = sockets();

  const fake = await createFakeImapServer();
  const client = makeClient(fake);
  await client.connect();
  await client.mailboxOpen("INBOX");
  assert.ok(sockets() > baseline, "the listener and the connection are open now");

  client.close();
  await waitFor(() => fake.openConnections() === 0);
  await fake.close();
  await waitFor(() => sockets() <= baseline);
  assert.ok(sockets() <= baseline, `no socket from this server is left open (${sockets()} > ${baseline})`);
});
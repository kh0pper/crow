// The in-process fake IMAP server (Task 9 of plan 1) and what imapflow 2.11 needs from it: a
// greeting with capabilities, LIST/LSUB with special-use flags, SELECT with UIDVALIDITY and
// UIDNEXT, SEARCH by date and by UID set, a full-source FETCH, IDLE with EXISTS push, and the
// abrupt connection drop that a real network failure produces. Every server binds 127.0.0.1 port
// 0, so nothing here depends on a fixed port.

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
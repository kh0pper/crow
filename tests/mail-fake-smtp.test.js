// The in-process fake SMTP server (Task 10 of plan 1) and what nodemailer 10 needs from it: a
// greeting, EHLO with an AUTH mechanism list, AUTH PLAIN/LOGIN/XOAUTH2, MAIL FROM, RCPT TO, DATA
// with dot-unstuffing, RSET and QUIT. Every server binds 127.0.0.1 port 0, so nothing here depends
// on a fixed port. nodemailer is the client, which is also the client the adapter uses, so the fake
// answers the same command sequence a real server would see.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import nodemailer from "nodemailer";
import { createFakeSmtpServer } from "./fixtures/fake-mail-server.mjs";

const ALEX = "alex@example.com";
const SAM = "sam@example.com";
const KIM = "kim@example.com";
const CC = "cc@example.com";
const BLOCKED = "blocked@example.com";
const PASSWORD = "fake-smtp-pass";

const openServers = new Set();
const openTransports = new Set();

after(async () => {
  for (const transport of openTransports) {
    try {
      transport.close();
    } catch {
      // a transport whose connection is already gone
    }
  }
  openTransports.clear();
  for (const fake of openServers) await fake.close();
  openServers.clear();
});

async function startFake(options) {
  const fake = await createFakeSmtpServer(options);
  openServers.add(fake);
  return fake;
}

function makeTransport(fake, overrides = {}) {
  const transport = nodemailer.createTransport({
    host: fake.host,
    port: fake.port,
    secure: false,
    logger: false,
    debug: false,
    auth: { user: ALEX, pass: PASSWORD },
    ...overrides,
  });
  openTransports.add(transport);
  return transport;
}

async function rejectionOf(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a nodemailer send records the envelope, the raw message and the auth", async () => {
  const fake = await startFake();
  const transport = makeTransport(fake);

  await transport.sendMail({
    from: `Alex <${ALEX}>`,
    to: [SAM, KIM],
    cc: CC,
    subject: "Hello from the fake",
    text: "First line\r\n.leading dot",
  });

  assert.equal(fake.messages.length, 1);
  const [message] = fake.messages;
  assert.equal(message.from, ALEX);
  assert.deepEqual(message.rcpt, [SAM, KIM, CC]);
  assert.match(message.raw, /^From: "?Alex"? </m);
  assert.match(message.raw, /^Subject: Hello from the fake$/m);
  // Dot-stuffing is undone: the body line arrives with the single dot the sender wrote.
  assert.match(message.raw, /\r\n\.leading dot/);
  assert.equal(message.raw.includes("..leading dot"), false);
  assert.deepEqual(message.auth, { user: ALEX, method: "PLAIN" });
  assert.equal(fake.connectionCount(), 1);
});

test("AUTH PLAIN, LOGIN and XOAUTH2 each record the user and the method", async () => {
  const fake = await startFake();

  const plain = makeTransport(fake);
  await plain.sendMail({ from: ALEX, to: SAM, subject: "plain", text: "one" });

  const login = makeTransport(fake, { auth: { user: ALEX, pass: PASSWORD, method: "LOGIN" } });
  await login.sendMail({ from: ALEX, to: SAM, subject: "login", text: "two" });

  const oauth = makeTransport(fake, {
    auth: { type: "OAuth2", user: ALEX, accessToken: "fake-access-token" },
  });
  await oauth.sendMail({ from: ALEX, to: SAM, subject: "oauth2", text: "three" });

  assert.deepEqual(fake.messages.map((message) => message.auth), [
    { user: ALEX, method: "PLAIN" },
    { user: ALEX, method: "LOGIN" },
    { user: ALEX, method: "XOAUTH2" },
  ]);
  assert.deepEqual(fake.messages.map((message) => message.rcpt), [[SAM], [SAM], [SAM]]);
});

test("rejectRcpt refuses a named recipient", async () => {
  const fake = await startFake({ rejectRcpt: (address) => address === BLOCKED });
  const transport = makeTransport(fake);

  const partial = await transport.sendMail({
    from: ALEX,
    to: [SAM, BLOCKED],
    subject: "one of two",
    text: "half there",
  });
  assert.deepEqual(partial.accepted, [SAM]);
  assert.deepEqual(partial.rejected, [BLOCKED]);
  assert.deepEqual(fake.messages[0].rcpt, [SAM]);

  const err = await rejectionOf(transport.sendMail({
    from: ALEX,
    to: [BLOCKED],
    subject: "nobody left",
    text: "gone",
  }));
  assert.ok(err, "a send whose only recipient is refused must reject");
  assert.deepEqual(err.rejected, [BLOCKED]);
  assert.equal(fake.messages.length, 1);
});

test("failNextData fails one send and records nothing", async () => {
  const fake = await startFake();
  const transport = makeTransport(fake);

  fake.failNextData();
  const err = await rejectionOf(transport.sendMail({
    from: ALEX,
    to: SAM,
    subject: "not this one",
    text: "body",
  }));
  assert.ok(err, "a refused DATA must reject the send");
  assert.equal(err.responseCode, 451);
  assert.equal(fake.messages.length, 0);

  await transport.sendMail({ from: ALEX, to: SAM, subject: "this one", text: "body" });
  assert.equal(fake.messages.length, 1);
  assert.match(fake.messages[0].raw, /^Subject: this one$/m);
});

test("a configured user refuses a wrong password and accepts the right one", async () => {
  const fake = await startFake({ users: { [ALEX]: PASSWORD } });

  const wrong = makeTransport(fake, { auth: { user: ALEX, pass: "not-the-password" } });
  const err = await rejectionOf(wrong.sendMail({
    from: ALEX,
    to: SAM,
    subject: "refused",
    text: "body",
  }));
  assert.ok(err, "a wrong password must reject");
  assert.equal(err.code, "EAUTH");
  assert.equal(fake.messages.length, 0);

  const right = makeTransport(fake, { auth: { user: ALEX, pass: PASSWORD } });
  await right.sendMail({ from: ALEX, to: SAM, subject: "accepted", text: "body" });
  assert.equal(fake.messages.length, 1);
  assert.deepEqual(fake.messages[0].auth, { user: ALEX, method: "PLAIN" });
});

test("close leaves no listener behind", async () => {
  const fake = await startFake();
  const transport = makeTransport(fake);
  await transport.sendMail({ from: ALEX, to: SAM, subject: "one", text: "body" });
  assert.equal(fake.connectionCount(), 1);

  transport.close();
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
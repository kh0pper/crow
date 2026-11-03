// The credential reference and the Gmail draft client (servers/gateway/staged/{cred-ref,gmail-client}.js):
// which server/account a draft came from, where its token file is resolvable (operator config only),
// get/update/send against tests/fixtures/fake-gmail.mjs — never the network.
//
// The two security tests here: the send ships the APPROVED snapshot and not the provider's stored
// draft (so a post-approval edit cannot ride along), and no Gmail error ever carries a byte of the
// provider's response (a Gmail error echoes the request; the client must not even read the body).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { credRefFromWorld, resolveTokenFile } from "../servers/gateway/staged/cred-ref.js";
import { createGmailClient, faithful, GmailError, snapshotFromRaw } from "../servers/gateway/staged/gmail-client.js";
import { canonicalSnapshot, contentHash, findPlaceholders, parseAddressList, parseAddressListDetailed } from "../servers/gateway/staged/canonical.js";
import { createFakeGmail, makeDraftRaw } from "./fixtures/fake-gmail.mjs";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "staged-gmail-"));
  dirs.push(dir);
  return dir;
}

const CRED = { server: "google-workspace", role: "primary" };

/** An operator-owned config pair: canonical mcp.json plus a (usually absent) mcp-addons.json. */
function operatorConfig(dir, env, { server = "google-workspace", addons = null } = {}) {
  const canonical = join(dir, "mcp.json");
  writeFileSync(canonical, JSON.stringify({ mcpServers: { [server]: { command: "gws", args: [], env } } }));
  const addonsPath = join(dir, "mcp-addons.json");
  if (addons) writeFileSync(addonsPath, JSON.stringify(addons));
  return { canonical, addons: addonsPath };
}

/** A refresh-grant token file (fake values only) and the config that names it. */
function credentials(dir) {
  const tokenFile = join(dir, "gws-token.json");
  const creds = {
    token: "fake-access-token",
    refresh_token: "fake-refresh-token",
    client_id: "fake-client-id",
    client_secret: "fake-client-secret",
  };
  writeFileSync(tokenFile, JSON.stringify(creds));
  return { tokenFile, creds, configPaths: operatorConfig(dir, { GOOGLE_TOKEN_FILE: tokenFile }) };
}

/** A client against the fake, with the operator config in a scratch dir. */
function clientAgainst(dir, fake) {
  return createGmailClient({ credRef: CRED, fetchImpl: fake.fetchImpl, configPaths: credentials(dir).configPaths });
}

/** A raw message from explicit header lines and a body block (as it would travel: ASCII). */
function rawMessage(headers, body = "Hi") {
  return [...headers, "", body].join("\r\n");
}

/** The error a call threw, so a test can assert the code and the message separately. */
async function thrown(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to reject");
}

test("credRefFromWorld primary/personal/unreadable", () => {
  const world = {
    mcpServers: {
      "google-workspace": {
        command: "gws",
        env: { GOOGLE_TOKEN_FILE: "/operator/primary.json", GOOGLE_PERSONAL_TOKEN_FILE: "/operator/personal.json" },
      },
      "workspace-mcp": { command: "uvx", env: { GOOGLE_CLIENT_ID: "fake-client-id" } },
      "half-configured": { command: "gws", env: { GOOGLE_PERSONAL_TOKEN_FILE: "/operator/personal.json" } },
      disabled: { command: "gws", disabled: true, env: { GOOGLE_TOKEN_FILE: "/operator/primary.json" } },
    },
  };
  assert.deepEqual(credRefFromWorld(world, "mcp__google-workspace__gmail_create_draft"), { server: "google-workspace", role: "primary", source: "canonical" });
  assert.deepEqual(credRefFromWorld(world, "mcp__google-workspace__gmail_create_draft_personal"), { server: "google-workspace", role: "personal", source: "canonical" });
  assert.deepEqual(credRefFromWorld(world, "mcp__google-workspace__gmail_create_threaded_reply"), { server: "google-workspace", role: "primary", source: "canonical" });

  // Unreadable: the public workspace-mcp carries no token file env Crow can read.
  assert.equal(credRefFromWorld(world, "mcp__workspace-mcp__gmail_create_draft"), null);
  // The role's own env key must be defined, or there is nothing to resolve at send time.
  assert.equal(credRefFromWorld(world, "mcp__half-configured__gmail_create_draft"), null);
  assert.deepEqual(credRefFromWorld(world, "mcp__half-configured__gmail_create_draft_personal"), { server: "half-configured", role: "personal", source: "canonical" });
  // A disabled block (pi's closed-world file) and a raw (voice/add-on) tool name resolve to nothing.
  assert.equal(credRefFromWorld(world, "mcp__disabled__gmail_create_draft"), null);
  assert.equal(credRefFromWorld(world, "gmail_create_draft"), null);
  assert.equal(credRefFromWorld(null, "mcp__google-workspace__gmail_create_draft"), null);

  // mcp-addons.json's flat shape works too.
  const addons = { "google-workspace-second": { command: "gws", env: { GOOGLE_TOKEN_FILE: "/operator/second.json" } } };
  assert.deepEqual(credRefFromWorld(addons, "mcp__google-workspace-second__gmail_create_draft"), { server: "google-workspace-second", role: "primary", source: "canonical" });
});

test("resolveTokenFile ignores bot-writable paths", () => {
  const dir = scratch();
  const operator = join(dir, "operator-token.json");
  const botWritable = join(dir, "bot-writable-token.json");
  writeFileSync(operator, JSON.stringify({ token: "operator" }));
  writeFileSync(botWritable, JSON.stringify({ token: "from-bot-data" }));

  const canonical = join(dir, "mcp.json");
  writeFileSync(canonical, JSON.stringify({
    mcpServers: { "google-workspace": { command: "gws", env: { GOOGLE_TOKEN_FILE: operator, GOOGLE_PERSONAL_TOKEN_FILE: join(dir, "personal.json") } } },
  }));
  // The add-on map names the same server with the SAME token file (agreeing), plus a server only it has.
  const addonsPath = join(dir, "mcp-addons.json");
  writeFileSync(addonsPath, JSON.stringify({
    "google-workspace": { command: "gws", env: { GOOGLE_TOKEN_FILE: operator } },
    "google-workspace-second": { command: "gws", env: { GOOGLE_PERSONAL_TOKEN_FILE: join(dir, "second.json") } },
  }));
  const paths = { canonical, addons: addonsPath };

  assert.equal(resolveTokenFile(CRED, paths), operator, "both files agree: that token file");
  // A tokenFile a bot put on the ref is ignored: only the operator config is read.
  assert.equal(resolveTokenFile({ ...CRED, tokenFile: botWritable }, paths), operator);
  assert.equal(resolveTokenFile({ ...CRED, tokenFile: botWritable }, paths) === botWritable, false);
  assert.equal(resolveTokenFile({ server: "workspace-mcp", role: "primary", tokenFile: botWritable }, paths), null);

  // The add-on map is the fallback for a server the canonical file does not have.
  assert.equal(resolveTokenFile({ server: "google-workspace-second", role: "personal" }, paths), join(dir, "second.json"));
  assert.equal(resolveTokenFile({ server: "google-workspace-second", role: "primary" }, paths), null);

  assert.equal(resolveTokenFile(null, paths), null);
  assert.equal(resolveTokenFile({ server: "google-workspace", role: "nonsense" }, paths), null);
  assert.equal(resolveTokenFile(CRED, { canonical: join(dir, "missing.json"), addons: join(dir, "missing-addons.json") }), null);
});

test("a server named in both operator files with different token files resolves to nothing", () => {
  const dir = scratch();
  const canonical = join(dir, "mcp.json");
  const addons = join(dir, "mcp-addons.json");
  writeFileSync(canonical, JSON.stringify({ mcpServers: { "google-workspace": { env: { GOOGLE_TOKEN_FILE: join(dir, "account-a.json") } } } }));
  writeFileSync(addons, JSON.stringify({ "google-workspace": { env: { GOOGLE_TOKEN_FILE: join(dir, "account-b.json") } } }));
  // {server, role} cannot say which account made the draft: never guess (the card says "Open in Gmail").
  assert.equal(resolveTokenFile({ server: "google-workspace", role: "primary" }, { canonical, addons }), null);
});

test("gmail client get/update/send against fake-gmail", async () => {
  const dir = scratch();
  const { tokenFile, creds, configPaths } = credentials(dir);
  const raw = makeDraftRaw({
    to: "Alex <Alex@Example.com>, alex@example.com",
    cc: "cc@example.com",
    subject: "Re: hello",
    body: "Hi there   \r\nSecond line\r\n",
    messageId: "<draft-1@example.com>",
    inReplyTo: "<root@example.com>",
    references: "<root@example.com>",
  });
  const fake = createFakeGmail({ drafts: { d1: { raw, threadId: "thread-1" } } });
  const client = createGmailClient({ credRef: CRED, fetchImpl: fake.fetchImpl, configPaths });

  const got = await client.getDraft("d1");
  assert.deepEqual(got.snapshot, {
    to: ["alex@example.com"],
    cc: ["cc@example.com"],
    bcc: [],
    subject: "Re: hello",
    body: "Hi there\nSecond line",
  });
  assert.equal(got.threadId, "thread-1");
  assert.equal(got.faithful, true, "a text/plain draft (plus an html rendering) is one we can send");
  assert.equal(got.reason, null);
  assert.match(got.raw, /^To: Alex <Alex@Example\.com>/);
  assert.equal(fake.calls.token, 1, "the access token was minted in memory");
  assert.deepEqual(JSON.parse(readFileSync(tokenFile, "utf8")), creds, "the token file is never written back");

  const edited = {
    to: ["new@example.com"],
    cc: [],
    bcc: ["secret@example.com"],
    subject: "New subject",
    body: "New body",
  };
  await client.updateDraft("d1", edited);
  assert.equal(fake.calls.update, 1);
  const update = fake.updates[0];
  assert.equal(update.id, "d1");
  assert.equal(update.threadId, "thread-1", "the draft stays in its thread");
  assert.match(update.raw, /^To: new@example\.com$/m);
  assert.match(update.raw, /^Bcc: secret@example\.com$/m);
  assert.match(update.raw, /^Subject: New subject$/m);
  // The threading headers survive the edit.
  assert.match(update.raw, /^Message-ID: <draft-1@example\.com>$/m);
  assert.match(update.raw, /^In-Reply-To: <root@example\.com>$/m);
  assert.match(update.raw, /^References: <root@example\.com>$/m);
  const [, encodedBody] = update.raw.split("\n\n");
  assert.equal(Buffer.from(encodedBody.replace(/\s+/g, ""), "base64").toString("utf8"), "New body");

  const sent = await client.sendDraft("d1", { snapshot: edited, threadId: "thread-1" });
  assert.deepEqual(sent, { messageId: "msg-1", threadId: "thread-1" });
  assert.equal(fake.sent.length, 1, "exactly one drafts.send reached the provider");
  assert.equal(fake.sent[0].id, "d1");
  assert.equal(fake.sent[0].threadId, "thread-1");
  // The sent bytes are the snapshot rebuilt: the approved Bcc goes out, nothing else is added.
  assert.match(fake.sent[0].raw, /^To: new@example\.com$/m);
  assert.match(fake.sent[0].raw, /^Bcc: secret@example\.com$/m);
  assert.match(fake.sent[0].raw, /^Message-ID: <draft-1@example\.com>$/m);

  // The minted token is reused, not re-minted per call.
  await client.getDraft("d1");
  assert.equal(fake.calls.token, 1);
  assert.ok(fake.calls.get >= 2);
});

test("send ships the approved snapshot, not the stored draft", async () => {
  const dir = scratch();
  const fake = createFakeGmail({
    drafts: {
      d1: {
        raw: makeDraftRaw({
          to: "alex@example.com",
          subject: "Hello",
          body: "The approved words",
          messageId: "<d1@example.com>",
        }),
        threadId: "t1",
      },
    },
  });
  const client = clientAgainst(dir, fake);

  const approved = await client.getDraft("d1");
  assert.equal(approved.faithful, true);

  // The bot edits the Gmail draft AFTER the operator approved it: another recipient, a Bcc, a
  // different body and an HTML part — none of which the operator ever saw.
  fake.drafts.get("d1").raw = makeDraftRaw({
    to: "alex@example.com, hidden@example.com",
    bcc: "spy@example.com",
    subject: "Hello",
    body: "Something else entirely",
    html: "<p>Something else entirely</p>",
    messageId: "<d1@example.com>",
    inReplyTo: "<root@example.com>",
  });

  await client.sendDraft("d1", { snapshot: approved.snapshot, threadId: approved.threadId });

  assert.equal(fake.sent.length, 1);
  const sentRaw = fake.sent[0].raw;
  assert.match(sentRaw, /^To: alex@example\.com$/m, "only the approved recipient");
  assert.doesNotMatch(sentRaw, /hidden@example\.com/, "the added recipient never goes out");
  assert.doesNotMatch(sentRaw, /spy@example\.com/, "the added Bcc never goes out");
  assert.doesNotMatch(sentRaw, /^Bcc:/m);
  assert.doesNotMatch(sentRaw, /text\/html|multipart/, "the added HTML part never goes out");
  const [, encodedBody] = sentRaw.split("\n\n");
  assert.equal(
    Buffer.from(encodedBody.replace(/\s+/g, ""), "base64").toString("utf8"),
    "The approved words",
    "the body is the approved one",
  );
  // The threading headers still come from the draft being replaced, so it stays in the conversation.
  assert.match(sentRaw, /^Message-ID: <d1@example\.com>$/m);
  assert.match(sentRaw, /^In-Reply-To: <root@example\.com>$/m);
});

test("a draft without an approved snapshot is never sent", async () => {
  const dir = scratch();
  const fake = createFakeGmail({ drafts: { d1: { raw: makeDraftRaw(), threadId: "t1" } } });
  const client = clientAgainst(dir, fake);

  const err = await thrown(client.sendDraft("d1"));
  assert.equal(err.code, "no_snapshot");
  assert.equal(fake.calls.send, 0, "no drafts.send was issued");
  assert.deepEqual(fake.sent, []);
});

test("unfaithful drafts are reported per reason", async () => {
  const base = ["To: alex@example.com", "Subject: Hello", "MIME-Version: 1.0"];
  const plain = "Content-Type: text/plain; charset=UTF-8";

  assert.deepEqual(faithful(rawMessage([...base, plain])), { ok: true });

  // A single part that is not text/plain.
  assert.deepEqual(faithful(rawMessage([...base, "Content-Type: text/html"])), { ok: false, reason: "content-type" });

  // An attachment, named or dispositioned, in any shape.
  const attachment = rawMessage(
    [...base, 'Content-Type: multipart/mixed; boundary="b1"'],
    [
      "--b1", "Content-Type: text/plain", "", "Hi",
      "--b1", 'Content-Type: application/pdf; name="report.pdf"',
      'Content-Disposition: attachment; filename="report.pdf"', "", "AAAA",
      "--b1--", "",
    ].join("\r\n"),
  );
  assert.deepEqual(faithful(attachment), { ok: false, reason: "attachment" });

  // A multipart inside a multipart.
  const nested = rawMessage(
    [...base, 'Content-Type: multipart/mixed; boundary="b1"'],
    [
      "--b1", 'Content-Type: multipart/alternative; boundary="b2"', "",
      "--b2", "Content-Type: text/plain", "", "Hi", "--b2--",
      "--b1--", "",
    ].join("\r\n"),
  );
  assert.deepEqual(faithful(nested), { ok: false, reason: "nested-multipart" });

  // Other multipart shapes (two renderings we do not know, a calendar part, two text parts).
  const calendar = rawMessage(
    [...base, 'Content-Type: multipart/alternative; boundary="b1"'],
    [
      "--b1", "Content-Type: text/plain", "", "Hi",
      "--b1", "Content-Type: text/calendar", "", "BEGIN:VCALENDAR",
      "--b1--", "",
    ].join("\r\n"),
  );
  assert.deepEqual(faithful(calendar), { ok: false, reason: "multipart" });
  const twoTexts = rawMessage(
    [...base, 'Content-Type: multipart/mixed; boundary="b1"'],
    ["--b1", "Content-Type: text/plain", "", "One", "--b1", "Content-Type: text/plain", "", "Two", "--b1--", ""].join("\r\n"),
  );
  assert.deepEqual(faithful(twoTexts), { ok: false, reason: "multipart" });

  // Headers that would change who receives it or where a reply goes.
  assert.deepEqual(
    faithful(rawMessage([...base, "Reply-To: elsewhere@example.com", plain])),
    { ok: false, reason: "reply-to" },
  );
  assert.deepEqual(
    faithful(rawMessage([...base, "To: second@example.com", plain])),
    { ok: false, reason: "duplicate-header" },
  );
  assert.deepEqual(
    faithful(rawMessage([...base, "Subject: Two", plain])),
    { ok: false, reason: "duplicate-header" },
  );
  assert.deepEqual(
    faithful(rawMessage([...base, "Cc: one@example.com", "Cc: two@example.com", plain])),
    { ok: false, reason: "duplicate-header" },
  );

  // An address entry we cannot read cleanly: an address hidden beside the brackets, or an empty one.
  // (These carry their own To, so they do not also trip the duplicate-header rule.)
  const toBase = ["Subject: Hello", "MIME-Version: 1.0"];
  assert.deepEqual(
    faithful(rawMessage([...toBase, "To: Boss <boss@example.com> carol@example.com", plain])),
    { ok: false, reason: "bad-address" },
  );
  assert.deepEqual(
    faithful(rawMessage([...toBase, 'To: "Bob" <> ', plain])),
    { ok: false, reason: "bad-address" },
  );

  // The one alternative we accept: text/plain plus its html rendering (the html is dropped on send).
  const alternative = rawMessage(
    [...base, 'Content-Type: multipart/alternative; boundary="b1"'],
    [
      "--b1", "Content-Type: text/plain", "", "Hi",
      "--b1", "Content-Type: text/html", "", "<p>Hi</p>",
      "--b1--", "",
    ].join("\r\n"),
  );
  assert.deepEqual(faithful(alternative), { ok: true });
  assert.deepEqual(faithful(makeDraftRaw({ html: "<p>Hi</p>" })), { ok: true }, "gws's own draft shape");

  // …and getDraft hands the verdict (with the reason) to the card alongside the snapshot.
  const dir = scratch();
  const fake = createFakeGmail({ drafts: { d1: { raw: attachment, threadId: "t1" } } });
  const got = await clientAgainst(dir, fake).getDraft("d1");
  assert.equal(got.faithful, false);
  assert.equal(got.reason, "attachment");
  assert.equal(typeof got.snapshot.body, "string", "the snapshot comes back even when unfaithful");
});

test("RFC 2047 encoded words survive a getDraft → updateDraft round trip", async () => {
  const dir = scratch();
  const configPaths = credentials(dir).configPaths;
  const subject = "Café [Client Name]";
  const encoded = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;

  // A draft whose subject arrived as an encoded word…
  const fake = createFakeGmail({ drafts: { d1: { raw: makeDraftRaw({ subject: encoded }), threadId: "t1" } } });
  const client = createGmailClient({ credRef: CRED, fetchImpl: fake.fetchImpl, configPaths });

  const first = await client.getDraft("d1");
  assert.equal(first.snapshot.subject, subject);
  assert.deepEqual(findPlaceholders(first.snapshot), ["Client Name"], "the placeholder is found in an encoded subject");

  // …and one whose provider wrote raw UTF-8 bytes into the header.
  const eightBit = createFakeGmail({ drafts: { d2: { raw: makeDraftRaw({ subject }), threadId: "t2" } } });
  const fromEightBit = await createGmailClient({ credRef: CRED, fetchImpl: eightBit.fetchImpl, configPaths }).getDraft("d2");
  assert.equal(fromEightBit.snapshot.subject, subject);

  // The round trip: our edit re-encodes the subject, and the re-read hashes the same.
  await client.updateDraft("d1", first.snapshot);
  const second = await client.getDraft("d1");
  assert.equal(second.snapshot.subject, subject);
  assert.equal(contentHash(second.snapshot), contentHash(first.snapshot));
  assert.equal(contentHash(second.snapshot), contentHash(fromEightBit.snapshot));

  // An encoded display name stays a display name: it is dropped, never read as an address.
  const named = createFakeGmail({
    drafts: { d3: { raw: makeDraftRaw({ to: "=?UTF-8?Q?Doe=2C_Jane?= <jane@example.com>" }), threadId: "t3" } },
  });
  const withName = await createGmailClient({ credRef: CRED, fetchImpl: named.fetchImpl, configPaths }).getDraft("d3");
  assert.deepEqual(withName.snapshot.to, ["jane@example.com"]);
  assert.equal(withName.faithful, true);
});

test("a part's own charset is honoured", async () => {
  const dir = scratch();
  const configPaths = credentials(dir).configPaths;
  const part = (charset) => [
    "To: alex@example.com",
    "Subject: Charset",
    "MIME-Version: 1.0",
    `Content-Type: text/plain; charset="${charset}"`,
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("Caf\xe9 au lait", "latin1").toString("base64"),
  ].join("\r\n");

  const latin1 = createFakeGmail({ drafts: { d1: { raw: part("ISO-8859-1"), threadId: "t1" } } });
  const got = await createGmailClient({ credRef: CRED, fetchImpl: latin1.fetchImpl, configPaths }).getDraft("d1");
  assert.equal(got.snapshot.body, "Café au lait");
  assert.equal(got.faithful, true);
  assert.equal(snapshotFromRaw(part("ISO-8859-1")).body, "Café au lait");

  // An unknown charset label falls back to UTF-8 instead of throwing on a draft.
  const odd = createFakeGmail({ drafts: { d1: { raw: part("x-bogus"), threadId: "t1" } } });
  const fallback = await createGmailClient({ credRef: CRED, fetchImpl: odd.fetchImpl, configPaths }).getDraft("d1");
  assert.match(fallback.snapshot.body, /au lait$/);
});

test("an edited subject with a newline round-trips to the same hash", async () => {
  const dir = scratch();
  const configPaths = credentials(dir).configPaths;
  const fake = createFakeGmail({ drafts: { d1: { raw: makeDraftRaw({ subject: "Hello", body: "Body" }), threadId: "t1" } } });
  const client = createGmailClient({ credRef: CRED, fetchImpl: fake.fetchImpl, configPaths });

  // The operator pastes a subject with a line break in it. The header can only carry one line, so
  // the provider will hold "One line Two lines"; if the hash kept the newline, every later send
  // would read as "the draft changed" and the card could never be approved.
  const edited = canonicalSnapshot({
    to: ["alex@example.com"], cc: [], bcc: [], subject: "One line\r\nTwo lines", body: "Body",
  });
  assert.equal(edited.subject, "One line Two lines", "the newline collapses to one space, as the header writes it");

  await client.updateDraft("d1", edited);
  const reread = await client.getDraft("d1");
  assert.equal(reread.snapshot.subject, "One line Two lines");
  assert.equal(contentHash(reread.snapshot), contentHash(edited), "the re-read hashes the same");
  assert.equal(reread.faithful, true);

  // The same holds for a subject the row stored before this rule existed: canonicalising it again
  // (which contentHash does) collapses the newline, so it matches what the provider holds.
  const stored = { ...edited, subject: "One line\nTwo lines" };
  assert.equal(contentHash(stored), contentHash(reread.snapshot));
});

test("an address with search syntax is always new and is never sent to Gmail search", async () => {
  const dir = scratch();
  const fake = createFakeGmail();
  const client = clientAgainst(dir, fake);

  // Anything that is not a plain address would be read by Gmail's search as syntax (a second term,
  // a negation, a field) — the hint would then be about a different identity, so it is not asked.
  for (const address of [
    '"john doe"@example.com',
    "alex@example.com OR from:ceo@example.com",
    "alex@example.com -in:sent",
    "bcc:alex@example.com",
    "alex@example.com\r\nBcc: evil@example.net",
    "alex@example.com;",
    "",
  ]) {
    assert.equal(await client.hasSentTo(address), false, JSON.stringify(address));
  }
  assert.equal(fake.calls.sentTo, 0, "no search left the gateway");
  assert.deepEqual(fake.sentQueries, []);

  // A plain address is searched, lower-cased and QUOTED as one term.
  assert.equal(await client.hasSentTo("Alex@Example.com"), false);
  assert.equal(fake.calls.sentTo, 1);
  assert.deepEqual(fake.sentQueries, ['in:sent to:"alex@example.com"']);
  fake.sentTo.add("alex@example.com");
  assert.equal(await client.hasSentTo("alex@example.com"), true);
});

test("404 → gone", async () => {
  const dir = scratch();
  const fake = createFakeGmail();
  const client = clientAgainst(dir, fake);

  const err = await thrown(client.getDraft("deleted-draft"));
  assert.ok(err instanceof GmailError);
  assert.equal(err.code, "gone");
  assert.equal(err.message, "This draft is gone from Gmail");

  // A draft that is gone cannot be sent: the read that fetches its threading headers fails first.
  const sendErr = await thrown(client.sendDraft("deleted-draft", {
    snapshot: { to: ["alex@example.com"], cc: [], bcc: [], subject: "Hi", body: "Body" },
  }));
  assert.equal(sendErr.code, "gone");
  assert.equal(fake.calls.send, 0, "drafts.send was never called");
  assert.deepEqual(fake.sent, [], "nothing was sent");

  // And a draft Gmail loses between the read and the send is "gone" too, with the send attempted.
  const live = createFakeGmail({ drafts: { d1: { raw: makeDraftRaw(), threadId: "t1" } } });
  const liveClient = clientAgainst(dir, live);
  const approved = await liveClient.getDraft("d1");
  live.failNext = { status: 404, body: '{"error":"draft d1 not found"}', on: "send" };
  const lateErr = await thrown(liveClient.sendDraft("d1", { snapshot: approved.snapshot }));
  assert.equal(lateErr.code, "gone");
  assert.equal(live.calls.send, 1);
  assert.deepEqual(live.sent, []);
  assert.equal(live.errorBodyReads, 0, "the 404 body was never read");
});

test("error message has no body", async () => {
  const dir = scratch();
  const { tokenFile, configPaths } = credentials(dir);
  const canary = "CANARY-BODY-9f2c alex@example.com the whole draft text";
  const fake = createFakeGmail({ drafts: { d1: { raw: makeDraftRaw({ body: canary }), threadId: "t1" } } });
  const client = createGmailClient({ credRef: CRED, fetchImpl: fake.fetchImpl, configPaths });

  const cases = [
    { status: 500, code: "other" },
    { status: 429, code: "rate" },
    { status: 403, code: "auth" },
  ];
  for (const { status, code } of cases) {
    fake.failNext = { status, body: JSON.stringify({ error: canary }) };
    const err = await thrown(client.getDraft("d1"));
    assert.ok(err instanceof GmailError, `HTTP ${status} is a GmailError`);
    assert.equal(err.code, code);
    assert.ok(!err.message.includes("CANARY"), `HTTP ${status} message carries no body`);
    assert.ok(!err.message.includes("@example.com"), `HTTP ${status} message carries no address`);
    assert.ok(!String(err.message).includes(canary));
    assert.ok(!String(err.stack).includes(canary));
    // The token file is still the operator's, untouched, and no address reached it either.
    assert.equal(JSON.parse(readFileSync(tokenFile, "utf8")).token, "fake-access-token");
  }
  // Not one byte of a failed response's body was read: reading it is how a canary would escape.
  assert.equal(fake.errorBodyReads, 0);

  // A failed send is the same: a fixed message, no body read.
  const list = createFakeGmail({ drafts: { d1: { raw: makeDraftRaw({ body: canary }), threadId: "t1" } } });
  const listClient = createGmailClient({ credRef: CRED, fetchImpl: list.fetchImpl, configPaths });
  const approved = await listClient.getDraft("d1");
  list.failNext = { status: 502, body: JSON.stringify({ error: canary }) };
  const sendErr = await thrown(listClient.sendDraft("d1", { snapshot: approved.snapshot }));
  assert.ok(!String(sendErr.message).includes("CANARY"));
  assert.equal(list.errorBodyReads, 0);

  // A network failure is "other" too, with the same fixed message.
  const deadClient = createGmailClient({
    credRef: CRED,
    fetchImpl: async () => { throw new Error(canary); },
    configPaths,
  });
  const err = await thrown(deadClient.getDraft("d1"));
  assert.equal(err.code, "other");
  assert.ok(!err.message.includes("CANARY"));
});
test("control characters and address-like quoted local parts are not clean addresses", () => {
  const { invalid } = parseAddressListDetailed(['"a\nb"@example.com', '"a\\" <evil@example.com>"@example.com', "ok@example.com"]);
  assert.ok(invalid.length >= 2, JSON.stringify(invalid));
  assert.deepEqual(parseAddressList("ok@example.com"), ["ok@example.com"]);
});

test("a draft that became unfaithful after the card was shown is not sent from Crow", async () => {
  const dir = scratch();
  const fake = createFakeGmail({
    drafts: { d1: { raw: makeDraftRaw({ to: "alex@example.com", subject: "Hello", body: "Words", messageId: "<d1@example.com>" }), threadId: "t1" } },
  });
  const client = clientAgainst(dir, fake);
  const approved = await client.getDraft("d1");
  assert.equal(approved.faithful, true);
  // A Reply-To added after approval makes the draft one Crow cannot represent.
  fake.drafts.get("d1").raw = "Reply-To: elsewhere@example.com\r\n" + fake.drafts.get("d1").raw;
  await assert.rejects(client.sendDraft("d1", { snapshot: approved.snapshot, threadId: "t1" }),
    (e) => e instanceof GmailError && e.code === "unfaithful" && !/example\.com/.test(e.message));
  assert.equal((fake.sent || []).length, 0, "nothing was sent");
});

test("a ref that names its source resolves in that file only, even when the other file names another account", () => {
  const dir = scratch();
  const canonical = join(dir, "mcp.json");
  const addons = join(dir, "mcp-addons.json");
  writeFileSync(canonical, JSON.stringify({ mcpServers: { "google-workspace": { env: { GOOGLE_TOKEN_FILE: join(dir, "work.json") } } } }));
  writeFileSync(addons, JSON.stringify({ "google-workspace": { env: { GOOGLE_TOKEN_FILE: join(dir, "personal.json") } } }));
  const paths = { canonical, addons };
  assert.equal(resolveTokenFile({ server: "google-workspace", role: "primary", source: "canonical" }, paths), join(dir, "work.json"));
  assert.equal(resolveTokenFile({ server: "google-workspace", role: "primary", source: "addons" }, paths), join(dir, "personal.json"));
  // A row recorded before sources existed keeps the old rule: ambiguous means nothing.
  assert.equal(resolveTokenFile({ server: "google-workspace", role: "primary" }, paths), null);
  // A source whose file lacks the key resolves to nothing, never falls through to the other file.
  assert.equal(resolveTokenFile({ server: "google-workspace", role: "personal", source: "canonical" }, paths), null);
  // An unknown source is ignored (treated as no source).
  assert.equal(resolveTokenFile({ server: "google-workspace", role: "primary", source: "elsewhere" }, paths), null);
});

test("credRefFromWorld records that the credential came from the canonical config", () => {
  const ref = credRefFromWorld({ mcpServers: { "google-workspace": { env: { GOOGLE_TOKEN_FILE: "/x.json" } } } }, "mcp__google-workspace__gmail_create_draft");
  assert.deepEqual(ref, { server: "google-workspace", role: "primary", source: "canonical" });
});

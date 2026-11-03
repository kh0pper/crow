// The credential reference and the Gmail draft client (servers/gateway/staged/{cred-ref,gmail-client}.js):
// which server/account a draft came from, where its token file is resolvable (operator config only),
// and get/update/send against tests/fixtures/fake-gmail.mjs — never the network.
//
// The error tests are the security review's item: a Gmail error echoes the request, so the client's
// errors carry a code and a fixed sentence, never a byte of the provider's response.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { credRefFromWorld, resolveTokenFile } from "../servers/gateway/staged/cred-ref.js";
import { createGmailClient, GmailError } from "../servers/gateway/staged/gmail-client.js";
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
  assert.deepEqual(credRefFromWorld(world, "mcp__google-workspace__gmail_create_draft"), { server: "google-workspace", role: "primary" });
  assert.deepEqual(credRefFromWorld(world, "mcp__google-workspace__gmail_create_draft_personal"), { server: "google-workspace", role: "personal" });
  assert.deepEqual(credRefFromWorld(world, "mcp__google-workspace__gmail_create_threaded_reply"), { server: "google-workspace", role: "primary" });

  // Unreadable: the public workspace-mcp carries no token file env Crow can read.
  assert.equal(credRefFromWorld(world, "mcp__workspace-mcp__gmail_create_draft"), null);
  // The role's own env key must be defined, or there is nothing to resolve at send time.
  assert.equal(credRefFromWorld(world, "mcp__half-configured__gmail_create_draft"), null);
  assert.deepEqual(credRefFromWorld(world, "mcp__half-configured__gmail_create_draft_personal"), { server: "half-configured", role: "personal" });
  // A disabled block (pi's closed-world file) and a raw (voice/add-on) tool name resolve to nothing.
  assert.equal(credRefFromWorld(world, "mcp__disabled__gmail_create_draft"), null);
  assert.equal(credRefFromWorld(world, "gmail_create_draft"), null);
  assert.equal(credRefFromWorld(null, "mcp__google-workspace__gmail_create_draft"), null);

  // mcp-addons.json's flat shape works too.
  const addons = { "google-workspace-second": { command: "gws", env: { GOOGLE_TOKEN_FILE: "/operator/second.json" } } };
  assert.deepEqual(credRefFromWorld(addons, "mcp__google-workspace-second__gmail_create_draft"), { server: "google-workspace-second", role: "primary" });
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
  assert.match(got.raw, /^To: Alex <Alex@Example\.com>/);
  assert.equal(fake.calls.token, 1, "the access token was minted in memory");
  assert.deepEqual(JSON.parse(readFileSync(tokenFile, "utf8")), creds, "the token file is never written back");

  await client.updateDraft("d1", {
    to: ["new@example.com"],
    cc: [],
    bcc: ["secret@example.com"],
    subject: "New subject",
    body: "New body",
  });
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

  const sent = await client.sendDraft("d1");
  assert.deepEqual(sent, { messageId: "msg-1", threadId: "thread-1" });
  assert.deepEqual(fake.sent, [{ id: "d1" }], "exactly one drafts.send reached the provider");

  // The minted token is reused, not re-minted per call.
  await client.getDraft("d1");
  assert.equal(fake.calls.token, 1);
  assert.ok(fake.calls.get >= 2);
});

test("404 → gone", async () => {
  const dir = scratch();
  const { configPaths } = credentials(dir);
  const fake = createFakeGmail();
  const client = createGmailClient({ credRef: CRED, fetchImpl: fake.fetchImpl, configPaths });

  const err = await thrown(client.getDraft("deleted-draft"));
  assert.ok(err instanceof GmailError);
  assert.equal(err.code, "gone");
  assert.equal(err.message, "This draft is gone from Gmail");

  const sendErr = await thrown(client.sendDraft("deleted-draft"));
  assert.equal(sendErr.code, "gone");
  assert.equal(fake.calls.send, 1);
  assert.deepEqual(fake.sent, [], "nothing was sent");
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
    // The token file is still the operator's, untouched, and no address reached it either.
    assert.equal(JSON.parse(readFileSync(tokenFile, "utf8")).token, "fake-access-token");
  }

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
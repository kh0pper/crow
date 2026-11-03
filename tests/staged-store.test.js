// The staged-send record (servers/gateway/staged/{canonical,store}.js): the canonical snapshot and
// its hash, the placeholder rule that blocks Send, and the state machine — one claim wins, a failed
// send is retryable, a sent one is final, and a replacing draft marks the old card.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { STAGED_SENDS_DDL } from "../scripts/migrations/0017-staged-sends.mjs";
import {
  parseAddressList, canonicalSnapshot, contentHash, findPlaceholders, placeholderSource,
} from "../servers/gateway/staged/canonical.js";
import {
  createStaged, getStaged, listStaged, claimSend, settle, replaceWith, discard,
} from "../servers/gateway/staged/store.js";

const { createDbClient } = await import("../servers/db.js");

const dirs = [];
const clients = [];
after(() => {
  for (const c of clients) { try { c.close(); } catch {} }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "staged-store-"));
  dirs.push(dir);
  const path = join(dir, "crow.db");
  const raw = new Database(path);
  raw.exec(STAGED_SENDS_DDL);
  raw.close();
  const db = createDbClient(path);
  clients.push(db);
  return db;
}

const base = (over = {}) => ({
  sessionId: "perchlive-abc",
  threadId: "perchlive-abc",
  botId: "writer",
  cardId: 7,
  jobId: null,
  channel: "gmail",
  credRef: { server: "google-workspace", role: "primary" },
  providerDraftId: "d1",
  providerThreadId: "t1",
  snapshot: { to: ["alex@example.com"], cc: [], bcc: [], subject: "Hello", body: "Hi there" },
  tainted: true,
  ...over,
});

test("parseAddressList", () => {
  assert.deepEqual(parseAddressList("Bob <Bob@Example.com>, alice@example.com"), ["alice@example.com", "bob@example.com"]);
  assert.deepEqual(parseAddressList('"Doe, Jane" <jane@example.com>, JANE@example.com'), ["jane@example.com"]);
  assert.deepEqual(parseAddressList("  ,  "), []);
  assert.deepEqual(parseAddressList(null), []);
  assert.deepEqual(parseAddressList(["b@example.com", "a@example.com", "a@example.com"]), ["a@example.com", "b@example.com"]);
  // A semicolon-joined list and a bare display name both yield addresses.
  assert.deepEqual(parseAddressList("a@example.com; b@example.com"), ["a@example.com", "b@example.com"]);
});

test("canonical stable across CRLF and whitespace", () => {
  const a = canonicalSnapshot({
    to: "Bob <B@Example.com>, a@example.com",
    cc: "",
    bcc: null,
    subject: "  Weekly Update \r\n",
    body: "Hi Bob,   \r\nLine two\t\r\n\r\n",
  });
  const b = canonicalSnapshot({
    to: "a@example.com,B@EXAMPLE.COM",
    cc: [],
    bcc: [],
    subject: "Weekly Update",
    body: "Hi Bob,\nLine two\n",
  });
  assert.deepEqual(a, b);
  assert.deepEqual(a.to, ["a@example.com", "b@example.com"]);
  assert.equal(a.body, "Hi Bob,\nLine two");
  assert.equal(contentHash(a), contentHash(b));
  // Key order in the caller's object is irrelevant; the hash is over the canonical shape only.
  assert.equal(
    contentHash({ body: "Hi Bob,\nLine two", subject: "Weekly Update", to: ["a@example.com", "b@example.com"], cc: [], bcc: [] }),
    contentHash(a),
  );
  assert.notEqual(contentHash({ ...a, subject: "Weekly Update!" }), contentHash(a));
});

test("placeholder rule", () => {
  const at = (subject, body) => findPlaceholders(canonicalSnapshot({ subject, body }));

  // A bracketed name is an unfilled placeholder.
  assert.deepEqual(at("Quick note", "Dear [Client Name], here is the draft."), ["Client Name"]);
  // A Markdown link is not: the bracket is followed by "(".
  assert.deepEqual(at("Quick note", "See [the docs](https://example.com/docs) for details."), []);
  // Common subject tags are not, whatever their case.
  assert.deepEqual(at("[EXTERNAL] Weekly update", "Body text."), []);
  assert.deepEqual(at("[Fwd] and [RE] a note", "Body text."), []);
  // Each placeholder once, first-seen order, subject before body.
  assert.deepEqual(at("About [Date]", "Dear [Name], the [Date] is set. [Date]"), ["Date", "Name"]);

  // The serialised rule the client greps with agrees with the server.
  const src = placeholderSource();
  assert.equal(src.flags, "gi");
  assert.ok(src.allow.includes("external"));
  const client = new RegExp(src.pattern, src.flags);
  const tokens = (text) => [...String(text).matchAll(client)]
    .map((m) => m[1].trim())
    .filter((t) => t && !src.allow.includes(t.toLowerCase()));
  assert.deepEqual(tokens("[Client Name] and [text](url) and [EXTERNAL]"), ["Client Name"]);
});

test("claimSend once under two concurrent claims", async () => {
  const db = freshDb();
  const id = await createStaged(db, base());
  const row = await getStaged(db, id);
  assert.equal(row.state, "staged");
  assert.equal(row.contentHash, contentHash(base().snapshot));
  assert.deepEqual(row.credRef, { server: "google-workspace", role: "primary" });
  assert.equal(row.tainted, true);

  const results = await Promise.all([
    claimSend(db, id, row.contentHash),
    claimSend(db, id, row.contentHash),
    claimSend(db, id, row.contentHash),
  ]);
  assert.equal(results.filter(Boolean).length, 1, "exactly one claim wins");
  assert.equal((await getStaged(db, id)).state, "sending");

  // A second claim never wins, and a hash the operator did not see never claims at all.
  assert.equal(await claimSend(db, id, row.contentHash), false);
  assert.equal(await claimSend(db, id, "0".repeat(64)), false);
});

test("failed can be re-claimed, sent cannot", async () => {
  const db = freshDb();
  const id = await createStaged(db, base());
  const hash = (await getStaged(db, id)).contentHash;

  // staged cannot jump straight to sent: only a claimed row settles.
  assert.equal(await settle(db, id, { state: "sent", providerMessageId: "msg-0" }), false);
  assert.equal(await claimSend(db, id, hash), true);
  assert.equal(await settle(db, id, { state: "failed", failReason: "This draft is gone from Gmail" }), true);
  let row = await getStaged(db, id);
  assert.equal(row.state, "failed");
  assert.equal(row.failReason, "This draft is gone from Gmail");

  // The operator's retry claims the same snapshot again.
  assert.equal(await claimSend(db, id, hash), true);
  assert.equal(await settle(db, id, { state: "sent", providerMessageId: "msg-1" }), true);
  row = await getStaged(db, id);
  assert.equal(row.state, "sent");
  assert.equal(row.providerMessageId, "msg-1");
  assert.equal(typeof row.sentAt, "number");
  assert.equal(row.failReason, null);

  // sent is final: no claim, no settle back, no discard.
  assert.equal(await claimSend(db, id, hash), false);
  assert.equal(await settle(db, id, { state: "failed", failReason: "retry" }), false);
  assert.equal(await discard(db, id), false);
  assert.equal((await getStaged(db, id)).state, "sent");

  // The draft-deleted-in-Gmail case (spec §12.3 item 3): the route re-reads the provider before it
  // claims, so a gone draft fails the card from `staged` — and stays retryable.
  const goneId = await createStaged(db, base({ providerDraftId: "d-gone" }));
  assert.equal(await settle(db, goneId, { state: "failed", failReason: "This draft is gone from Gmail" }), true);
  assert.equal((await getStaged(db, goneId)).state, "failed");
});

test("replaceWith", async () => {
  const db = freshDb();
  const oldId = await createStaged(db, base());
  const old = await getStaged(db, oldId);

  const newId = await replaceWith(db, oldId, {
    providerDraftId: "d2",
    snapshot: { to: ["alex@example.com"], cc: [], bcc: [], subject: "Hello again", body: "Second take" },
  });
  assert.match(newId, /^ss-[0-9a-f]{16}$/);
  assert.notEqual(newId, oldId);

  assert.equal((await getStaged(db, oldId)).state, "replaced");
  const next = await getStaged(db, newId);
  assert.equal(next.state, "staged");
  assert.equal(next.providerDraftId, "d2");
  assert.equal(next.threadId, old.threadId, "the new card stays in the chat's thread");
  assert.equal(next.sessionId, old.sessionId);
  assert.equal(next.cardId, old.cardId);
  assert.deepEqual(next.credRef, old.credRef);
  assert.equal(next.contentHash, contentHash(next.snapshot));
  assert.notEqual(next.contentHash, old.contentHash);

  // Only the new row is open in that thread.
  assert.deepEqual((await listStaged(db, { threadId: old.threadId })).map((r) => r.id), [newId]);
  assert.deepEqual((await listStaged(db, { states: ["replaced"] })).map((r) => r.id), [oldId]);

  // An already replaced row cannot be replaced again, and a sent draft cannot be replaced at all.
  await assert.rejects(() => replaceWith(db, oldId, { providerDraftId: "d3", snapshot: base().snapshot }), /cannot be replaced/);
  const sentId = await createStaged(db, base({ providerDraftId: "d4" }));
  const hash = (await getStaged(db, sentId)).contentHash;
  assert.equal(await claimSend(db, sentId, hash), true);
  assert.equal(await settle(db, sentId, { state: "sent", providerMessageId: "msg-1" }), true);
  await assert.rejects(() => replaceWith(db, sentId, { providerDraftId: "d5", snapshot: base().snapshot }), /cannot be replaced/);
});

test("listStaged scopes by session, card and state", async () => {
  const db = freshDb();
  const a = await createStaged(db, base({ sessionId: "s-a", threadId: "s-a", providerDraftId: "d-a" }));
  const b = await createStaged(db, base({ sessionId: "s-b", threadId: "s-b", cardId: 9, providerDraftId: "d-b" }));
  const c = await createStaged(db, base({ sessionId: "s-b", threadId: "s-b", cardId: 9, providerDraftId: "d-c" }));
  assert.deepEqual((await listStaged(db, { sessionId: "s-b" })).map((r) => r.id).sort(), [b, c].sort());
  assert.deepEqual((await listStaged(db, { cardId: 9 })).map((r) => r.id).sort(), [b, c].sort());
  assert.deepEqual((await listStaged(db, { sessionId: "s-a" })).map((r) => r.id), [a]);
  assert.equal(await discard(db, b), true);
  assert.deepEqual((await listStaged(db, { cardId: 9 })).map((r) => r.id), [c], "a discarded row is not open");
  await assert.rejects(() => listStaged(db, { states: ["nonsense"] }), /unknown state/);
});
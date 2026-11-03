// The staged-send record (servers/gateway/staged/{canonical,store}.js): the canonical snapshot and
// its hash, the address parser, the placeholder rule that blocks Send, and the state machine — one
// claim wins, a failed send is retryable, a sent one is final, a claimed one can go back to review,
// and a replacing draft marks the old card atomically.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { STAGED_SENDS_DDL } from "../scripts/migrations/0017-staged-sends.mjs";
import {
  parseAddressList, parseAddressListDetailed, canonicalSnapshot, contentHash, findPlaceholders,
  placeholderSource, decodeEncodedWords, stripSubjectTags,
} from "../servers/gateway/staged/canonical.js";
import {
  createStaged, getStaged, listStaged, findStagedByDraftId, claimSend, claimEdit, failEdit, settle,
  replaceWith, discard, setNewRecipients, reconcileStale,
} from "../servers/gateway/staged/store.js";

// The two-connection claim test needs WAL (a fresh temp DB per test, never a real one).
process.env.CROW_JOURNAL_MODE = "WAL";
const { createDbClient } = await import("../servers/db.js");

const dirs = [];
const clients = [];
after(() => {
  for (const c of clients) { try { c.close(); } catch {} }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A throwaway crow.db carrying only the staged_sends DDL, and its path (two clients may share it). */
function freshDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "staged-store-"));
  dirs.push(dir);
  const path = join(dir, "crow.db");
  const raw = new Database(path);
  raw.exec(STAGED_SENDS_DDL);
  raw.close();
  return path;
}

function connect(path) {
  const db = createDbClient(path);
  clients.push(db);
  return db;
}

const freshDb = () => connect(freshDbPath());

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

  // The review's cases: an addr-spec in a display name or a comment is text, never the recipient.
  assert.deepEqual(parseAddressList('"<boss@old.example.com>" <evil@example.com>'), ["evil@example.com"]);
  assert.deepEqual(parseAddressList("evil@example.com (Boss <boss@old.example.com>)"), ["evil@example.com"]);
  // An escaped quote inside the display name must not end it early (the comma stays quoted).
  assert.deepEqual(parseAddressList('"x\\", <boss@old.example.com>" <evil@example.com>'), ["evil@example.com"]);
  // A group contributes its members.
  assert.deepEqual(parseAddressList("Team: a@example.com, b@example.com;"), ["a@example.com", "b@example.com"]);
  // A quoted local part is ONE address, comma and all.
  assert.deepEqual(parseAddressList('"john,doe"@example.com'), ['"john,doe"@example.com']);
  // An encoded display name is an opaque atom: its encoded comma cannot split the entry.
  assert.deepEqual(parseAddressList("=?UTF-8?Q?Doe=2C_Jane?= <jane@example.com>"), ["jane@example.com"]);
  // Comments and empty entries add nothing; a bare display name is not an address.
  assert.deepEqual(parseAddressList("a@example.com (Bob), (nobody)"), ["a@example.com"]);
  assert.deepEqual(parseAddressList("Bob"), []);

  // Nothing that is not a clean addr-spec is reported as clean (faithful uses this to fail closed).
  const beside = parseAddressListDetailed("Boss <boss@example.com> carol@example.com");
  assert.deepEqual(beside.addresses, ["boss@example.com"]);
  assert.equal(beside.invalid.length, 1, "a second address beside the brackets is ambiguous");
  assert.equal(parseAddressListDetailed('"Bob" <>').invalid.length, 1);
  assert.equal(parseAddressListDetailed("alex@example.com").invalid.length, 0);
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

  // Canonicalising a snapshot twice is a no-op, even for a quoted local part with a comma in it.
  const quoted = canonicalSnapshot({ to: '"john,doe"@example.com', subject: "Hi", body: "Body" });
  assert.deepEqual(quoted.to, ['"john,doe"@example.com']);
  assert.deepEqual(canonicalSnapshot(quoted), quoted);
  assert.equal(contentHash(canonicalSnapshot(quoted)), contentHash(quoted));
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

  // A leading subject tag (or several, around a Re:/Fwd: prefix) is a label, not a placeholder.
  assert.deepEqual(at("[EXTERNAL SENDER] Re: [crow-dev] Hello", "Body text."), []);
  assert.deepEqual(at("Re: [crow-dev] Hello", "Body text."), []);
  assert.deepEqual(at("  Fwd: [EXTERNAL] Re: [EXT] Hello", "Body text."), []);
  // …but a placeholder later in the subject still counts.
  assert.deepEqual(at("Hello [Client Name]", "Body text."), ["Client Name"]);
  assert.deepEqual(at("Re: Hello [Client Name]", "Body text."), ["Client Name"]);

  // The widened class: an apostrophe or an underscore inside brackets is still a placeholder.
  assert.deepEqual(at("Quick note", "Dear [Client's Name], hello."), ["Client's Name"]);
  assert.deepEqual(at("Quick note", "Re: [CLIENT_NAME] now."), ["CLIENT_NAME"]);

  // The serialised rule the client greps with agrees with the server.
  const src = placeholderSource();
  assert.equal(src.flags, "gi");
  assert.ok(src.allow.includes("external"));
  assert.deepEqual(src.subjectPrefixes, ["re", "fwd", "fw"]);
  assert.ok(src.subjectTagAllow.includes("external sender"));
  assert.equal(src.subjectScanMax, 998);
  const client = new RegExp(src.pattern, src.flags);
  const tokens = (text) => [...String(text).matchAll(client)]
    .map((m) => m[1].trim())
    .filter((t) => t && !src.allow.includes(t.toLowerCase()));
  assert.deepEqual(tokens("[Client Name] and [text](url) and [EXTERNAL]"), ["Client Name"]);
});

test("a subject's leading labels: inherited and known tags go, a leading placeholder stays", () => {
  const at = (subject) => findPlaceholders({ to: [], cc: [], bcc: [], subject, body: "" });
  assert.deepEqual(at("[EXTERNAL SENDER] Re: [crow-dev] Hello"), []);
  assert.deepEqual(at("[External Email] Hello"), []);
  assert.deepEqual(at("Fwd: Re: [crow-dev] [sic] notes"), []);
  // The review's false negatives: a placeholder at the very start is still found.
  assert.deepEqual(at("[Client Name] proposal"), ["Client Name"]);
  assert.deepEqual(at("[Your Name] Re: hello"), ["Your Name"]);
  assert.deepEqual(at("Hello [Client Name]"), ["Client Name"]);
  assert.equal(stripSubjectTags("Re: [crow-dev] Hello"), "Hello");
});

test("the subject scan is linear on adversarial subjects (no ReDoS)", () => {
  for (const s of ["re: ".repeat(20000) + "x", " ".repeat(20000) + "re:x", "fw:".repeat(20000) + "[", "re:" + " ".repeat(20000) + "\u0000", "[".repeat(20000), "Re: " + "[a]".repeat(20000)]) {
    const t = process.hrtime.bigint();
    findPlaceholders({ to: [], cc: [], bcc: [], subject: s, body: "" });
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(ms < 200, `${JSON.stringify(s.slice(0, 12))} took ${ms} ms`);
  }
});

test("RFC 2047 encoded words decode", () => {
  const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
  assert.equal(decodeEncodedWords(`=?UTF-8?B?${b64("Café")}?= [Client Name]`), "Café [Client Name]");
  // Adjacent encoded words are joined without the whitespace between them.
  assert.equal(
    decodeEncodedWords(`=?UTF-8?B?${b64("Café")}?= =?UTF-8?Q?_=5BClient_Name=5D?=`),
    "Café [Client Name]",
  );
  // Quoted-printable in a non-UTF-8 charset is decoded in that charset.
  assert.equal(decodeEncodedWords("=?ISO-8859-1?Q?Caf=E9?="), "Café");
  // Plain text, a malformed word, and an unknown charset: text back, never a throw.
  assert.equal(decodeEncodedWords("Café"), "Café");
  assert.equal(decodeEncodedWords("=?UTF-8?X?nope?="), "=?UTF-8?X?nope?=");
  assert.equal(decodeEncodedWords("=?x-bogus?B?Q2Fmw6k=?="), "Café");
});

test("claimSend once under two concurrent claims", async () => {
  // Two separate connections to the same WAL file, as the gateway and a second instance would be:
  // both see `staged`, both fire the claim, and the single UPDATE is the only arbiter.
  const path = freshDbPath();
  const dbA = connect(path);
  const dbB = connect(path);
  const id = await createStaged(dbA, base());
  const row = await getStaged(dbB, id);
  assert.equal(row.state, "staged");
  assert.equal(row.contentHash, contentHash(base().snapshot));
  assert.deepEqual(row.credRef, { server: "google-workspace", role: "primary" });
  assert.equal(row.tainted, true);

  const claims = await Promise.all([
    claimSend(dbA, id, row.contentHash),
    claimSend(dbB, id, row.contentHash),
  ]);
  assert.equal(claims.filter(Boolean).length, 1, "exactly one claim wins");
  assert.equal((await getStaged(dbA, id)).state, "sending");
  assert.equal((await getStaged(dbB, id)).state, "sending", "both connections see the claim");

  // A second claim never wins, and a hash the operator did not see never claims at all.
  assert.equal(await claimSend(dbA, id, row.contentHash), false);
  assert.equal(await claimSend(dbB, id, row.contentHash), false);
  assert.equal(await claimSend(dbA, id, "0".repeat(64)), false);
  assert.equal((await getStaged(dbA, id)).state, "sending");
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

test("a claimed row can go back to staged", async () => {
  const db = freshDb();
  const id = await createStaged(db, base());
  const hash = (await getStaged(db, id)).contentHash;
  assert.equal(await claimSend(db, id, hash), true);

  // The provider's draft no longer matches the snapshot after the claim: the row is not sent and not
  // failed, it goes back for review.
  assert.equal(await settle(db, id, { state: "staged" }), true);
  const row = await getStaged(db, id);
  assert.equal(row.state, "staged");
  assert.equal(row.sentAt, null);
  assert.equal(row.failReason, null);

  // …and can be claimed again, exactly once.
  assert.equal(await claimSend(db, id, hash), true);
  assert.equal(await claimSend(db, id, hash), false);
});

test("claimEdit and failEdit never touch a row claimed for send", async () => {
  const db = freshDb();
  const id = await createStaged(db, base());
  const hash = (await getStaged(db, id)).contentHash;

  // The edit's claim bumps the stamp and leaves the row where it was: an edit is not a send.
  const before = await getStaged(db, id);
  const at = await claimEdit(db, id);
  assert.equal(typeof at, "number");
  let row = await getStaged(db, id);
  assert.equal(row.state, "staged");
  assert.ok(row.updatedAt >= before.updatedAt);

  // A failed edit while a send holds the row writes NOTHING: this is the transition that used to
  // reopen a send in flight (the operator's next tap then sent a second time).
  assert.equal(await claimSend(db, id, hash), true);
  assert.equal(await failEdit(db, id, { at, failReason: "Gmail could not send this draft" }), false);
  row = await getStaged(db, id);
  assert.equal(row.state, "sending", "the claim still stands");
  assert.equal(row.failReason, null);

  // Nor may an edit start during a send.
  assert.equal(await claimEdit(db, id), null);

  // A failure with a stale stamp is refused too: the row was touched since the edit read it. (The
  // +1 stands in for a later write: two writes in the same millisecond would share a stamp.)
  assert.equal(await settle(db, id, { state: "failed", failReason: "This draft is gone from Gmail" }), true);
  await db.execute({ sql: "UPDATE staged_sends SET updated_at = updated_at + 1 WHERE id = ?", args: [id] });
  assert.equal(await failEdit(db, id, { at, failReason: "Gmail could not send this draft" }), false);
  assert.equal((await getStaged(db, id)).failReason, "This draft is gone from Gmail");

  // …and with the stamp it took, the failure lands (still editable, still claimable).
  const again = await claimEdit(db, id);
  assert.equal(await failEdit(db, id, { at: again, failReason: "Gmail could not send this draft" }), true);
  row = await getStaged(db, id);
  assert.equal(row.state, "failed");
  assert.equal(row.failReason, "Gmail could not send this draft");
  assert.equal(await claimSend(db, id, hash), true, "a failed edit stays retryable");
});

test("a settle is a CAS on the claim the sweeper read", async () => {
  const db = freshDb();
  const id = await createStaged(db, base());
  const hash = (await getStaged(db, id)).contentHash;
  assert.equal(await claimSend(db, id, hash), true);
  const claim = await getStaged(db, id);

  // Nothing touched it since the sweeper read it: the settle lands.
  assert.equal(await settle(db, id, { state: "staged", expectedUpdatedAt: claim.updatedAt }), true);
  assert.equal((await getStaged(db, id)).state, "staged");

  // A row touched since (here: re-claimed, as a live send's retry would) is left ALONE. Settling it
  // back to `staged` would put a send in flight back on the card, and the next tap would send twice.
  // (The +1 stands in for the later write: two writes in the same millisecond share a stamp, which
  // is why the state half of the predicate — never `sending` for the sweeper's reads — also holds.)
  assert.equal(await claimSend(db, id, hash), true);
  await db.execute({ sql: "UPDATE staged_sends SET updated_at = updated_at + 1 WHERE id = ?", args: [id] });
  const touched = await getStaged(db, id);
  assert.equal(await settle(db, id, { state: "failed", expectedUpdatedAt: claim.updatedAt }), false);
  const row = await getStaged(db, id);
  assert.equal(row.state, "sending");
  assert.equal(row.updatedAt, touched.updatedAt);

  // The stale default is ten minutes: a claim five minutes old is a send that is still going.
  await db.execute({ sql: "UPDATE staged_sends SET updated_at = ? WHERE id = ?", args: [Date.now() - 5 * 60 * 1000, id] });
  assert.deepEqual(await reconcileStale(db), [], "5 minutes is not stale");
  await db.execute({ sql: "UPDATE staged_sends SET updated_at = ? WHERE id = ?", args: [Date.now() - 11 * 60 * 1000, id] });
  assert.deepEqual(await reconcileStale(db), [id], "11 minutes is");
});

/**
 * settle() used to allow `sending` -> `failed`, which is the send's own transition; an edit that
 * failed while a send was in flight therefore flipped the row to `failed`, and the operator's retry
 * claimed it again — two `drafts.send` calls for one approved draft. The edit has its own claim now;
 * the store tests above prove it. The route-level probe lives in tests/staged-routes.test.js
 * (`a failed edit during a send does not reopen it`).
 */
test("reconcileStale reports rows stuck in sending and changes nothing", async () => {
  const db = freshDb();
  const oldId = await createStaged(db, base());
  const oldHash = (await getStaged(db, oldId)).contentHash;
  assert.equal(await claimSend(db, oldId, oldHash), true);
  const stagedId = await createStaged(db, base({ providerDraftId: "d-staged" }));
  const doneId = await createStaged(db, base({ providerDraftId: "d-done" }));
  const doneHash = (await getStaged(db, doneId)).contentHash;
  assert.equal(await claimSend(db, doneId, doneHash), true);
  assert.equal(await settle(db, doneId, { state: "sent", providerMessageId: "msg-1" }), true);

  const now = Date.now();
  // A fresh claim is not stale, and a staged or sent row is never reported.
  assert.deepEqual(await reconcileStale(db, { olderThanMs: 60_000, now }), []);
  assert.deepEqual(await reconcileStale(db, { olderThanMs: 60_000, now: now + 61_000 }), [oldId]);
  // Reporting only: the row is still `sending` until the caller settles it.
  assert.equal((await getStaged(db, oldId)).state, "sending");
  assert.equal((await getStaged(db, stagedId)).state, "staged");
  assert.deepEqual(await reconcileStale(db, { olderThanMs: 0, now: now + 61_000 }), [oldId]);

  // A stale claim is settled by re-reading the draft: a 404 means Gmail SENT it (a sent draft is
  // deleted), so it settles `sent` and is never re-sent.
  assert.equal(await settle(db, oldId, { state: "sent", providerMessageId: "msg-2" }), true);
  assert.deepEqual(await reconcileStale(db, { olderThanMs: 0, now: now + 61_000 }), []);
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

test("a row claimed for send is not replaceable", async () => {
  const db = freshDb();
  const id = await createStaged(db, base());
  const hash = (await getStaged(db, id)).contentHash;
  assert.equal(await claimSend(db, id, hash), true);

  // The replace's compare-and-set (staged/failed -> replaced) changes nothing, so the whole
  // transaction fails and the guarded insert never lands.
  await assert.rejects(
    () => replaceWith(db, id, { providerDraftId: "d-race", snapshot: base().snapshot }),
    (err) => err.code === "not_replaceable",
  );
  assert.equal((await getStaged(db, id)).state, "sending", "the claim still stands");
  assert.equal((await listStaged(db, { states: ["staged"] })).length, 0, "no new row was inserted");

  const rows = await listStaged(db, { states: ["staged", "sending", "failed"] });
  assert.deepEqual(rows.map((r) => r.id), [id], "the race left exactly the claimed row");

  // The same replace works once the row is back in a replaceable state.
  assert.equal(await settle(db, id, { state: "failed", failReason: "This draft is gone from Gmail" }), true);
  const newId = await replaceWith(db, id, { providerDraftId: "d-race-2", snapshot: base().snapshot });
  assert.equal((await getStaged(db, id)).state, "replaced");
  assert.equal((await getStaged(db, newId)).state, "staged");
});

test("setNewRecipients", async () => {
  const db = freshDb();
  const id = await createStaged(db, base());
  assert.equal((await getStaged(db, id)).newRecipients, null);

  assert.equal(await setNewRecipients(db, id, ["Bob <Bob@Example.com>", "alice@example.com", "ALICE@example.com"]), true);
  assert.deepEqual((await getStaged(db, id)).newRecipients, ["alice@example.com", "bob@example.com"]);

  // Replaced whole.
  assert.equal(await setNewRecipients(db, id, ["carol@example.com"]), true);
  assert.deepEqual((await getStaged(db, id)).newRecipients, ["carol@example.com"]);

  // An EMPTY list is a real answer ("none of these is new"): it is stored as "[]" and reads back
  // as [] so the card never asks Gmail again. Only null means "cannot tell, ask again".
  assert.equal(await setNewRecipients(db, id, []), true);
  const { rows } = await db.execute({ sql: "SELECT new_recipients FROM staged_sends WHERE id = ?", args: [id] });
  assert.equal(String(rows[0].new_recipients), "[]");
  assert.deepEqual((await getStaged(db, id)).newRecipients, []);

  assert.equal(await setNewRecipients(db, id, null), true);
  assert.equal((await getStaged(db, id)).newRecipients, null);

  assert.equal(await setNewRecipients(db, "ss-missing", ["a@example.com"]), false);
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

test("findStagedByDraftId matches the draft id plus the credential, in every state", async () => {
  const db = freshDb();
  const primary = await createStaged(db, base({ providerDraftId: "d-1" }));
  const open = await createStaged(db, base({ providerDraftId: "d-2", credRef: null }));

  assert.equal((await findStagedByDraftId(db, { providerDraftId: "d-1", credRef: { server: "google-workspace", role: "primary" } })).id, primary);
  assert.equal(await findStagedByDraftId(db, { providerDraftId: "d-1", credRef: { server: "google-workspace", role: "personal" } }), null,
    "another role is another draft");
  assert.equal((await findStagedByDraftId(db, { providerDraftId: "d-2", credRef: null })).id, open,
    "a NULL cred_ref matches NULL (Open in Gmail)");
  assert.equal(await findStagedByDraftId(db, { providerDraftId: "nope", credRef: null }), null);
  assert.equal(await findStagedByDraftId(db, { providerDraftId: "", credRef: null }), null);

  // A row that left the open states still counts: a replay must not resurrect a sent draft.
  await claimSend(db, primary, (await getStaged(db, primary)).contentHash);
  await settle(db, primary, { state: "sent", providerMessageId: "m-1" });
  assert.equal((await findStagedByDraftId(db, { providerDraftId: "d-1", credRef: { server: "google-workspace", role: "primary" } })).id, primary);
});
test("replaceWith keeps the source flags, the credential and the taint", async () => {
  const db = freshDb();
  const id = await createStaged(db, { ...base(), tainted: true, sourceFlags: { sensitive: true } });
  const before = await getStaged(db, id);
  const newId = await replaceWith(db, id, { providerDraftId: before.providerDraftId, snapshot: { to: ["alex@example.com"], cc: [], bcc: [], subject: "New", body: "New body" } });
  const row = await getStaged(db, newId);
  assert.deepEqual(row.sourceFlags, { sensitive: true }, "a reserved flag is never washed off by a replace");
  assert.equal(row.tainted, true);
  assert.deepEqual(row.credRef, before.credRef);
});

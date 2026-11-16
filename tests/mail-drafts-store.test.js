// Crow Mail's draft store (plan 3, Task 3): the draft row, its immutable revisions, the hash rule and
// the transitions that clear a tap seal. Every test builds the mail tables from MAIL_DDL, the account
// send columns and MAIL_DRAFTS_DDL in a scratch DB, and moves an injected clock.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDbClient } from "../servers/db.js";
import { MAIL_DDL, MAIL_ACCOUNT_SEND_COLUMNS, MAIL_DRAFTS_DDL } from "../servers/shared/mail-schema.js";
import { MailError } from "../servers/gateway/mail/errors.js";
import { createAccount, updateAccount } from "../servers/gateway/mail/store/accounts.js";
import {
  ATTACHMENT_SOURCES, COMMENT_STATES, DRAFT_MODES, DRAFT_STATES, REVISION_AUTHORS, TAP_ACTIONS,
  addComment, addRevision, createDraft, discardDraft, getDraft, getVoice, hashOf, listComments,
  listDraftsForChat, listRevisions, markCommentsApplied, onRevisionAdded, revisionToInput, setVoice,
  transition,
} from "../servers/gateway/mail/drafts/store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE_SOURCE = readFileSync(join(HERE, "..", "servers/gateway/mail/drafts/store.js"), "utf8");

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const T0 = 1_700_000_000_000;
const HOST = "mail.example.test";

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "crow-mail-drafts-"));
  dirs.push(dir);
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(MAIL_DDL);
  for (const spec of MAIL_ACCOUNT_SEND_COLUMNS) {
    await db.execute({ sql: `ALTER TABLE ${spec.table} ADD COLUMN ${spec.column} ${spec.definition}`, args: [] });
  }
  await db.executeMultiple(MAIL_DRAFTS_DDL);
  return db;
}

async function makeAccount(db, overrides = {}) {
  const account = await createAccount(db, {
    label: "Alex",
    address: "alex@example.com",
    imap: { host: HOST, port: 993, security: "ssl" },
    smtp: { host: HOST, port: 465, security: "ssl" },
    ...overrides,
  });
  return updateAccount(db, account.id, { displayName: "Alex" });
}

/** A RevisionInput for a reply to sam@example.com. */
function revInput(overrides = {}) {
  return {
    to: [{ address: "sam@example.com" }],
    cc: [],
    bcc: [],
    subject: "Re: Tuesday",
    body: "Hello Sam,\n\nTuesday works for me.\n",
    inReplyTo: "<m1@mail.example.test>",
    references: ["<m0@mail.example.test>"],
    attachments: [],
    ...overrides,
  };
}

async function makeDraft(db, overrides = {}) {
  const account = overrides.account ?? await makeAccount(db);
  const draft = await createDraft(db, {
    accountId: account.id,
    mode: "reply",
    replyToMid: "<m1@mail.example.test>",
    threadKey: "thread-1",
    chatThreadId: "chat-1",
    audience: "sam",
    first: revInput(),
    author: "bot",
    ...overrides.draft,
  }, { now: () => T0 });
  return { account, draft };
}

async function draftRow(db, id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM mail_drafts WHERE id = ?", args: [id] });
  return rows[0];
}

async function count(db, sql, args = []) {
  const { rows } = await db.execute({ sql, args });
  return rows[0].n;
}

function isBadInput(err) {
  return err instanceof MailError && err.code === "BAD_INPUT";
}

function badInput() {
  return (err) => {
    assert.ok(isBadInput(err), `expected BAD_INPUT, got ${err && err.code}`);
    return true;
  };
}

/** The fields a move into `holding` or `scheduled` must carry: a full seal bound to that tap. */
function seal(state, overrides = {}) {
  return {
    ...(state === "holding" ? { hold_until: T0 + 10_000 } : { due_at: T0 + 60_000 }),
    tap_seal: "seal-1",
    tap_id: "tap-1",
    tap_action: state === "holding" ? "send" : "schedule",
    attach_digest: "digest-1",
    ...overrides,
  };
}

/** A draft resting in `holding` or `scheduled` with a full seal written. */
async function sealedDraft(db, state) {
  const { draft } = await makeDraft(db);
  const ok = await transition(db, draft.id, ["draft"], state, seal(state), { now: () => T0 });
  assert.equal(ok, true, `the draft entered ${state}`);
  return draft;
}

/** A draft moved into any state the send, schedule and settle code can leave it in. */
async function draftInState(db, state) {
  if (state === "holding" || state === "scheduled") return sealedDraft(db, state);
  const { draft } = await makeDraft(db);
  if (state === "draft") return draft;
  if (state === "sending" || state === "sent") {
    await transition(db, draft.id, ["draft"], "sending", { claim_token: "claim-1" }, { now: () => T0 });
    if (state === "sent") await transition(db, draft.id, ["sending"], "sent", { sent_at: T0 }, { now: () => T0 });
    return draft;
  }
  await transition(db, draft.id, ["draft"], state, {}, { now: () => T0 });
  return draft;
}

/* ------------------------------------------------------------------- hashOf */

test("hash is stable across key order and changes with attachments, a display name, references, mode or from", () => {
  const base = {
    to: [{ address: "sam@example.com" }],
    cc: [],
    bcc: [],
    subject: "Re: Tuesday",
    body: "Hello Sam,\n\nTuesday works for me.\n",
    inReplyTo: "<m1@mail.example.test>",
    references: ["<m0@mail.example.test>"],
    from: { name: "Alex", address: "alex@example.com" },
    attachments: [],
  };
  const h = hashOf(base, { mode: "reply" });
  assert.match(h, /^[0-9a-f]{64}$/);

  const reordered = {
    attachments: [], references: ["<m0@mail.example.test>"],
    from: { address: "alex@example.com", name: "Alex" },
    inReplyTo: "<m1@mail.example.test>", body: base.body, subject: base.subject,
    bcc: [], cc: [], to: [{ address: "sam@example.com" }],
  };
  assert.equal(hashOf(reordered, { mode: "reply" }), h, "key order does not move the hash");

  const attachments = [
    { source: "thread", mid: "<m1@mail.example.test>", index: 0, filename: "agenda.pdf", size: 1200 },
    { source: "storage", fileId: "f-1", filename: "notes.txt", size: 40 },
  ];
  assert.notEqual(hashOf({ ...base, to: [{ name: "Sam", address: "sam@example.com" }] }, { mode: "reply" }), h,
    "a display name is part of the hash");
  assert.notEqual(hashOf({ ...base, references: ["<m0@mail.example.test>", "<m1@mail.example.test>"] }, { mode: "reply" }), h);
  assert.notEqual(hashOf({ ...base, inReplyTo: "<m2@mail.example.test>" }, { mode: "reply" }), h);
  assert.notEqual(hashOf(base, { mode: "reply_all" }), h);
  assert.notEqual(hashOf({ ...base, from: { name: "Alex", address: "other@example.com" } }, { mode: "reply" }), h);
  assert.notEqual(hashOf({ ...base, from: { name: "Alexandra", address: "alex@example.com" } }, { mode: "reply" }), h);
  assert.notEqual(hashOf({ ...base, attachments: [attachments[0]] }, { mode: "reply" }), h);
  assert.equal(
    hashOf({ ...base, attachments: [...attachments].reverse() }, { mode: "reply" }),
    hashOf({ ...base, attachments }, { mode: "reply" }),
    "attachments hash in a stable order (source, id, index)",
  );

  assert.equal(hashOf({ ...base, body: "Hello Sam,\r\n\r\nTuesday works for me.   \r\n" }, { mode: "reply" }), h,
    "the body's line endings and trailing spaces are canonicalised away");
  assert.equal(hashOf({ ...base, subject: "Re: Tuesday\r\n" }, { mode: "reply" }), h);

  assert.throws(() => hashOf(base, { mode: "bogus" }), badInput());
  assert.throws(() => hashOf({ ...base, attachments: [{ source: "elsewhere", filename: "a" }] }, { mode: "reply" }), badInput());
  assert.deepEqual([...DRAFT_MODES], ["new", "reply", "reply_all", "forward"]);
  assert.deepEqual([...ATTACHMENT_SOURCES], ["thread", "storage"]);
});

/* ----------------------------------------------------------------- createDraft */

test("createDraft writes the draft and revision 1, with from taken from the account", async () => {
  const db = await freshDb();
  const { account, draft } = await makeDraft(db, { draft: { first: revInput() } });

  assert.match(draft.id, /^md-[0-9a-f]{16}$/);
  assert.equal(draft.accountId, account.id);
  assert.equal(draft.mode, "reply");
  assert.equal(draft.state, "draft");
  assert.equal(draft.headRev, 1);
  assert.match(draft.headHash, /^[0-9a-f]{64}$/);
  assert.equal(draft.replyToMid, "<m1@mail.example.test>");
  assert.equal(draft.threadKey, "thread-1");
  assert.equal(draft.chatThreadId, "chat-1");
  assert.equal(draft.audience, "sam");
  assert.equal(draft.reconcileCount, 0);
  assert.equal(draft.createdAt, T0);
  assert.equal(draft.updatedAt, T0);
  assert.deepEqual(await getDraft(db, draft.id), draft);

  const revisions = await listRevisions(db, draft.id);
  assert.equal(revisions.length, 1);
  const first = revisions[0];
  assert.equal(first.rev, 1);
  assert.equal(first.author, "bot");
  assert.equal(first.mode, "reply");
  assert.deepEqual(first.from, { name: "Alex", address: "alex@example.com" });
  assert.deepEqual(first.to, [{ name: null, address: "sam@example.com" }]);
  assert.equal(first.contentHash, draft.headHash);

  // A caller that posts a From of its own does not get it: the store fills it from the account.
  const spoofed = await createDraft(db, {
    accountId: account.id,
    mode: "new",
    first: revInput({ from: { name: "Sam", address: "sam@example.com" } }),
    author: "user",
  }, { now: () => T0 });
  const spoofedRev = (await listRevisions(db, spoofed.id))[0];
  assert.deepEqual(spoofedRev.from, { name: "Alex", address: "alex@example.com" });

  // The hash of a stored revision is reproducible from the row, and it is what the head carries.
  assert.equal(hashOf(revisionToInput(first), { mode: first.mode }), first.contentHash);
  assert.equal(hashOf(revisionToInput(first)), first.contentHash, "the mode travels with the input");
});

test("createDraft refuses an unknown mode, an unknown author, an unknown account and a bad address", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fields = { accountId: account.id, mode: "reply", first: revInput(), author: "bot" };
  await assert.rejects(() => createDraft(db, { ...fields, mode: "bounce" }), badInput());
  await assert.rejects(() => createDraft(db, { ...fields, author: "robot" }), badInput());
  await assert.rejects(
    () => createDraft(db, { ...fields, accountId: "ma-0000000000000000" }),
    (err) => err instanceof MailError && err.code === "NOT_FOUND",
  );
  await assert.rejects(
    () => createDraft(db, { ...fields, first: revInput({ to: ["Sam <sam@example.com>"] }) }),
    badInput(),
  );
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM mail_drafts"), 0);
});

test("listDraftsForChat returns that chat's drafts, newest first", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const one = await createDraft(db, {
    accountId: account.id, mode: "new", chatThreadId: "chat-1", first: revInput(), author: "bot",
  }, { now: () => T0 });
  const two = await createDraft(db, {
    accountId: account.id, mode: "new", chatThreadId: "chat-1", first: revInput(), author: "bot",
  }, { now: () => T0 + 5 });
  await createDraft(db, {
    accountId: account.id, mode: "new", chatThreadId: "chat-2", first: revInput(), author: "bot",
  }, { now: () => T0 + 10 });

  assert.deepEqual((await listDraftsForChat(db, "chat-1")).map((d) => d.id), [two.id, one.id]);
  assert.equal((await listDraftsForChat(db, "chat-2")).length, 1);
  assert.deepEqual(await listDraftsForChat(db, "chat-3"), []);
  await assert.rejects(() => listDraftsForChat(db, ""), badInput());
});

/* ----------------------------------------------------------------- addRevision */

test("addRevision creates rev 2 and moves head atomically", async () => {
  const db = await freshDb();
  const { draft } = await makeDraft(db);
  const result = await addRevision(db, draft.id, revInput({ body: "Tuesday at 10.\n" }), {
    author: "user", expectHash: draft.headHash, now: () => T0 + 1_000,
  });

  assert.ok(!result.refused);
  assert.equal(result.rev, 2);
  assert.match(result.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(result.hash, draft.headHash);

  const head = await getDraft(db, draft.id);
  assert.equal(head.headRev, 2);
  assert.equal(head.headHash, result.hash);
  assert.equal(head.state, "draft", "an edit does not change the state");
  assert.equal(head.updatedAt, T0 + 1_000);

  const revisions = await listRevisions(db, draft.id);
  assert.equal(revisions.length, 2);
  assert.equal(revisions[1].rev, 2);
  assert.equal(revisions[1].author, "user");
  assert.equal(revisions[1].body, "Tuesday at 10.");
  assert.equal(revisions[1].contentHash, result.hash);
  assert.equal(revisions[1].createdAt, T0 + 1_000);
  assert.equal(hashOf(revisionToInput(revisions[1]), { mode: "reply" }), result.hash);
  assert.equal(revisions[0].body, "Hello Sam,\n\nTuesday works for me.", "rev 1 is untouched");
});

test("a revision takes its from from the account and stores no caller-supplied from", async () => {
  const db = await freshDb();
  const { draft } = await makeDraft(db);
  const result = await addRevision(db, draft.id, revInput({
    from: { name: "Someone", address: "sam@example.com" },
  }), { author: "bot", expectHash: draft.headHash, now: () => T0 + 1 });
  assert.ok(!result.refused);
  const revisions = await listRevisions(db, draft.id);
  assert.deepEqual(revisions[1].from, { name: "Alex", address: "alex@example.com" });

  // A change of the account's display name reaches the next revision, and only that one.
  await updateAccount(db, draft.accountId, { displayName: "Alex Rivera" });
  const third = await addRevision(db, draft.id, revInput({ body: "Shorter." }), {
    author: "user", expectHash: result.hash, now: () => T0 + 2,
  });
  assert.ok(!third.refused);
  const after = await listRevisions(db, draft.id);
  assert.deepEqual(after[1].from, { name: "Alex", address: "alex@example.com" });
  assert.deepEqual(after[2].from, { name: "Alex Rivera", address: "alex@example.com" });
});

test("stale expectHash is refused as changed and writes nothing", async () => {
  const db = await freshDb();
  const { draft } = await makeDraft(db);
  const first = await addRevision(db, draft.id, revInput({ body: "One." }), {
    author: "user", expectHash: draft.headHash, now: () => T0 + 1,
  });
  assert.ok(!first.refused);

  const stale = await addRevision(db, draft.id, revInput({ body: "Two." }), {
    author: "bot", expectHash: draft.headHash, now: () => T0 + 2,
  });
  assert.deepEqual(stale, { refused: "changed" });

  const head = await getDraft(db, draft.id);
  assert.equal(head.headRev, 2, "the head did not move");
  assert.equal(head.headHash, first.hash);
  assert.equal(head.updatedAt, T0 + 1);
  const revisions = await listRevisions(db, draft.id);
  assert.equal(revisions.length, 2, "no revision was inserted");
  assert.equal(revisions[1].body, "One.");
});

test("two concurrent addRevision calls with the same expectHash: exactly one wins", async () => {
  const db = await freshDb();
  const { draft } = await makeDraft(db);
  const [a, b] = await Promise.all([
    addRevision(db, draft.id, revInput({ body: "From the person." }), {
      author: "user", expectHash: draft.headHash, now: () => T0 + 1,
    }),
    addRevision(db, draft.id, revInput({ body: "From the bot." }), {
      author: "bot", expectHash: draft.headHash, now: () => T0 + 1,
    }),
  ]);

  const winners = [a, b].filter((result) => !result.refused);
  const losers = [a, b].filter((result) => result.refused);
  assert.equal(winners.length, 1, "exactly one writer won");
  assert.equal(losers.length, 1);
  assert.equal(losers[0].refused, "changed");

  const head = await getDraft(db, draft.id);
  assert.equal(head.headRev, 2);
  assert.equal(head.headHash, winners[0].hash);
  const revisions = await listRevisions(db, draft.id);
  assert.equal(revisions.length, 2);
  assert.equal(revisions[1].contentHash, winners[0].hash);
  assert.equal(revisions[1].refused, undefined);
});

test("a bot revision on a scheduled, holding or sending draft is refused as frozen", async () => {
  for (const state of ["scheduled", "holding", "sending"]) {
    const db = await freshDb();
    const draft = state === "sending"
      ? await (async () => {
        const { draft: made } = await makeDraft(db);
        await transition(db, made.id, ["draft"], "sending", { claim_token: "claim-1" }, { now: () => T0 });
        return made;
      })()
      : await sealedDraft(db, state);
    const before = await draftRow(db, draft.id);

    const result = await addRevision(db, draft.id, revInput({ body: "Bot rewrite." }), {
      author: "bot", expectHash: before.head_hash, now: () => T0 + 1,
    });
    assert.deepEqual(result, { refused: "frozen" }, `${state} refuses a bot`);

    const after = await draftRow(db, draft.id);
    assert.equal(after.state, state);
    assert.equal(after.head_rev, before.head_rev);
    assert.equal(after.head_hash, before.head_hash);
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM mail_draft_revisions WHERE draft_id = ?", [draft.id]), 1);
  }
});

test("a user edit on a scheduled draft cancels the schedule and creates the next revision", async () => {
  const db = await freshDb();
  const draft = await sealedDraft(db, "scheduled");
  const result = await addRevision(db, draft.id, revInput({ body: "Rewritten by hand." }), {
    author: "user", expectHash: draft.headHash, cancelSchedule: true, now: () => T0 + 2_000,
  });
  assert.ok(!result.refused);

  const head = await getDraft(db, draft.id);
  assert.equal(head.state, "draft", "the schedule is cancelled");
  assert.equal(head.headRev, 2);
  assert.equal(head.headHash, result.hash);
  assert.equal(head.tapSeal, null, "the seal went with the schedule");
  assert.equal(head.tapId, null);
  assert.equal(head.tapAction, null);
  assert.equal(head.attachDigest, null);
  assert.equal(head.dueAt, T0 + 60_000, "the old due time is left as a record, not honoured");
  assert.equal(head.updatedAt, T0 + 2_000);

  const revisions = await listRevisions(db, draft.id);
  assert.equal(revisions.length, 2);
  assert.equal(revisions[1].rev, 2);
  assert.equal(revisions[1].body, "Rewritten by hand.");
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM mail_drafts WHERE state = 'scheduled'"), 0);
});

test("a user edit on a scheduled draft without cancelSchedule is refused and leaves the schedule whole", async () => {
  const db = await freshDb();
  const draft = await sealedDraft(db, "scheduled");
  const result = await addRevision(db, draft.id, revInput({ body: "Rewritten by hand." }), {
    author: "user", expectHash: draft.headHash, now: () => T0 + 2_000,
  });
  assert.deepEqual(result, { refused: "frozen" });
  const head = await draftRow(db, draft.id);
  assert.equal(head.state, "scheduled");
  assert.equal(head.tap_seal, "seal-1");
  assert.equal(head.tap_id, "tap-1");
  assert.equal(head.tap_action, "schedule");
  assert.equal(head.attach_digest, "digest-1");
  assert.equal(head.head_rev, 1);
  assert.equal(head.updated_at, T0);
});

test("a user edit of a scheduled draft under a stale expectHash writes nothing at all", async () => {
  const db = await freshDb();
  const draft = await sealedDraft(db, "scheduled");
  const result = await addRevision(db, draft.id, revInput({ body: "Rewritten by hand." }), {
    author: "user", expectHash: "0".repeat(64), cancelSchedule: true, now: () => T0 + 2_000,
  });
  assert.deepEqual(result, { refused: "changed" });
  const head = await draftRow(db, draft.id);
  assert.equal(head.state, "scheduled", "the cancelled schedule was rolled back");
  assert.equal(head.tap_seal, "seal-1");
  assert.equal(head.head_rev, 1);
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM mail_draft_revisions WHERE draft_id = ?", [draft.id]), 1);
});

test("addRevision on a draft that does not exist is NOT_FOUND and needs an expectHash", async () => {
  const db = await freshDb();
  const { draft } = await makeDraft(db);
  await assert.rejects(
    () => addRevision(db, "md-0000000000000000", revInput(), { author: "user", expectHash: draft.headHash }),
    (err) => err instanceof MailError && err.code === "NOT_FOUND",
  );
  await assert.rejects(() => addRevision(db, draft.id, revInput(), { author: "user" }), badInput());
  await assert.rejects(() => addRevision(db, draft.id, revInput(), { author: "robot", expectHash: draft.headHash }), badInput());
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM mail_draft_revisions"), 1);
});

test("a revision row has no update or delete path in the store", () => {
  assert.doesNotMatch(STORE_SOURCE, /UPDATE\s+mail_draft_revisions/i);
  assert.doesNotMatch(STORE_SOURCE, /DELETE\s+FROM\s+mail_draft_revisions/i);
  assert.doesNotMatch(STORE_SOURCE, /REPLACE\s+INTO\s+mail_draft_revisions/i);
  assert.deepEqual([...REVISION_AUTHORS], ["bot", "user", "system"]);
});

test("onRevisionAdded hears about a new revision and a throwing listener never fails the write", async () => {
  const db = await freshDb();
  const { draft } = await makeDraft(db);
  const heard = [];
  const stop = onRevisionAdded((payload) => { heard.push(payload); });
  const stopBad = onRevisionAdded(() => { throw new Error("listener trouble"); });
  const stopRejects = onRevisionAdded(async () => { throw new Error("listener trouble"); });

  const result = await addRevision(db, draft.id, revInput({ body: "One." }), {
    author: "user", expectHash: draft.headHash, now: () => T0 + 1,
  });
  assert.ok(!result.refused);
  assert.deepEqual(heard, [{ draftId: draft.id, rev: 2, hash: result.hash, author: "user" }]);
  assert.equal((await getDraft(db, draft.id)).headRev, 2);

  stop(); stopBad(); stopRejects();
  await addRevision(db, draft.id, revInput({ body: "Two." }), {
    author: "bot", expectHash: result.hash, now: () => T0 + 2,
  });
  assert.equal(heard.length, 1, "an unsubscribed listener hears nothing");
});

/* ------------------------------------------------------------------ transition */

test("transition() refuses an unknown state and a field outside its whitelist", async () => {
  const db = await freshDb();
  const { draft } = await makeDraft(db);
  assert.deepEqual([...DRAFT_STATES], [
    "draft", "holding", "scheduled", "sending", "sent", "failed", "unknown", "missed", "discarded",
  ]);

  await assert.rejects(() => transition(db, draft.id, ["draft"], "bogus", {}, { now: () => T0 }), badInput());
  await assert.rejects(() => transition(db, draft.id, ["bogus"], "sent", {}, { now: () => T0 }), badInput());
  await assert.rejects(() => transition(db, draft.id, [], "sent", {}, { now: () => T0 }), badInput());
  await assert.rejects(() => transition(db, draft.id, ["draft"], "sent", { head_hash: "x" }, { now: () => T0 }), badInput());
  await assert.rejects(() => transition(db, draft.id, ["draft"], "sent", { state: "sent" }, { now: () => T0 }), badInput());
  await assert.rejects(() => transition(db, draft.id, ["draft"], "sent", { tap_seal: "s" }, { now: () => T0 }), badInput(),
    "a seal column on a move out of the tap states is refused");
  await assert.rejects(() => transition(db, draft.id, ["draft"], "holding", { tap_action: "post" }, { now: () => T0 }), badInput());
  assert.equal((await draftRow(db, draft.id)).state, "draft", "a refused transition changes nothing");

  assert.equal(await transition(db, draft.id, ["draft"], "holding", seal("holding"), { now: () => T0 + 1 }), true);
  assert.equal(await transition(db, draft.id, ["draft"], "holding", seal("holding"), { now: () => T0 + 2 }), false,
    "a row in another state is not moved");
  assert.equal((await draftRow(db, draft.id)).updated_at, T0 + 1);
  assert.deepEqual([...TAP_ACTIONS], ["send", "schedule"]);
});

test("transition() refuses a move whose expectHash is not the head", async () => {
  const db = await freshDb();
  const { draft } = await makeDraft(db);
  assert.equal(await transition(db, draft.id, ["draft"], "scheduled", seal("scheduled"), {
    now: () => T0, expectHash: "1".repeat(64),
  }), false);
  assert.equal((await draftRow(db, draft.id)).state, "draft");
  assert.equal(await transition(db, draft.id, ["draft"], "scheduled", seal("scheduled"), {
    now: () => T0, expectHash: draft.headHash,
  }), true);
});

test("every transition out of holding or scheduled nulls tap_seal, tap_id, tap_action and attach_digest", async () => {
  const targets = ["draft", "sending", "failed", "missed", "discarded", "unknown"];
  for (const from of ["holding", "scheduled"]) {
    for (const to of targets) {
      const db = await freshDb();
      const draft = await sealedDraft(db, from);
      const before = await draftRow(db, draft.id);
      assert.equal(before.tap_seal, "seal-1", `${from} carries a seal`);
      assert.equal(before.tap_id, "tap-1");
      assert.equal(before.tap_action, from === "holding" ? "send" : "schedule");
      assert.equal(before.attach_digest, "digest-1");

      const moved = await transition(db, draft.id, [from], to, {}, { now: () => T0 + 500 });
      assert.equal(moved, true, `${from} -> ${to} moved the row`);

      const after = await draftRow(db, draft.id);
      assert.equal(after.state, to);
      for (const column of ["tap_seal", "tap_id", "tap_action", "attach_digest"]) {
        assert.equal(after[column], null, `${from} -> ${to} leaves ${column} null`);
      }
      assert.equal(after.updated_at, T0 + 500);
    }
  }
});

test("a move into holding or scheduled is the only one that may write the seal", async () => {
  const db = await freshDb();
  const { draft } = await makeDraft(db);
  assert.equal(await transition(db, draft.id, ["draft"], "holding", {
    hold_until: T0 + 10_000, tap_seal: "seal-2", tap_id: "tap-2", tap_action: "send",
    attach_digest: "digest-2",
  }, { now: () => T0 }), true);
  const row = await draftRow(db, draft.id);
  assert.equal(row.tap_seal, "seal-2");
  assert.equal(row.tap_id, "tap-2");
  assert.equal(row.tap_action, "send");
  assert.equal(row.attach_digest, "digest-2");
  assert.equal(row.hold_until, T0 + 10_000);

  // sending, then settled back with a claim token: setting a seal on the settle is refused.
  assert.equal(await transition(db, draft.id, ["holding"], "sending", { claim_token: "claim-1" }, { now: () => T0 + 1 }), true);
  await assert.rejects(
    () => transition(db, draft.id, ["sending"], "sent", { sent_at: T0 + 2, tap_seal: "again" }, { now: () => T0 + 2 }),
    badInput(),
  );
  assert.equal(await transition(db, draft.id, ["sending"], "sent", { sent_at: T0 + 2 }, { now: () => T0 + 2 }), true);
  const sent = await draftRow(db, draft.id);
  assert.equal(sent.state, "sent");
  assert.equal(sent.sent_at, T0 + 2);
  assert.equal(sent.claim_token, "claim-1", "a column the move does not name keeps its value");
  assert.equal(sent.tap_seal, null);
});

/* -------------------------------------------------------------------- discard */

test("discard refuses a holding draft and the drafts a send owns", async () => {
  for (const state of ["holding", "scheduled", "sending", "sent"]) {
    const db = await freshDb();
    const draft = state === "holding" || state === "scheduled"
      ? await sealedDraft(db, state)
      : await (async () => {
        const { draft: made } = await makeDraft(db);
        await transition(db, made.id, ["draft"], "sending", { claim_token: "claim-1" }, { now: () => T0 });
        if (state === "sent") await transition(db, made.id, ["sending"], "sent", { sent_at: T0 }, { now: () => T0 });
        return made;
      })();
    const result = await discardDraft(db, draft.id, { now: () => T0 + 1 });
    assert.deepEqual(result, { refused: true, state }, `${state} is refused`);
    const row = await draftRow(db, draft.id);
    assert.equal(row.state, state);
    assert.equal(row.updated_at, T0);
    if (state === "holding" || state === "scheduled") assert.equal(row.tap_seal, "seal-1");
  }
});

test("discard works from draft, failed, missed and unknown", async () => {
  for (const state of ["draft", "failed", "missed", "unknown"]) {
    const db = await freshDb();
    const { draft } = await makeDraft(db);
    if (state !== "draft") {
      await transition(db, draft.id, ["draft"], state, { fail_reason: "seal" }, { now: () => T0 });
    }
    assert.deepEqual(await discardDraft(db, draft.id, { now: () => T0 + 1 }), { ok: true }, `${state} discards`);
    const row = await draftRow(db, draft.id);
    assert.equal(row.state, "discarded");
    assert.equal(row.updated_at, T0 + 1);
    assert.deepEqual(await discardDraft(db, draft.id, { now: () => T0 + 2 }), { refused: true, state: "discarded" },
      "a discarded draft is terminal");
  }
  const db = await freshDb();
  await assert.rejects(() => discardDraft(db, "md-0000000000000000"), (err) => err.code === "NOT_FOUND");
});

/* ---------------------------------------------------------- comments and voice */

test("comments queue, list by state and are marked applied once", async () => {
  const db = await freshDb();
  const { draft } = await makeDraft(db);
  const first = await addComment(db, draft.id, { rev: 1, lineIndex: 3, quote: "Tuesday works", text: "Say Thursday" }, { now: () => T0 + 1 });
  const second = await addComment(db, draft.id, { rev: 1, text: "  Shorter, please  " }, { now: () => T0 + 2 });
  assert.match(first.id, /^mdc-[0-9a-f]{16}$/);
  assert.equal(first.state, "queued");
  assert.equal(first.lineIndex, 3);
  assert.equal(first.quote, "Tuesday works");
  assert.equal(second.text, "Shorter, please");
  assert.equal(second.lineIndex, null);

  assert.deepEqual((await listComments(db, draft.id)).map((c) => c.id), [first.id, second.id]);
  assert.equal((await listComments(db, draft.id, { state: "queued" })).length, 2);
  assert.deepEqual(await listComments(db, draft.id, { state: "applied" }), []);
  assert.deepEqual([...COMMENT_STATES], ["queued", "applied", "dropped"]);
  await assert.rejects(() => listComments(db, draft.id, { state: "pending" }), badInput());

  // A revision is what folds a comment in, so the head moves to 2 before any is marked applied.
  const foldIn = await addRevision(db, draft.id, revInput({ body: "Thursday it is." }), {
    author: "bot", expectHash: draft.headHash, now: () => T0 + 3,
  });
  assert.ok(!foldIn.refused);
  assert.equal(foldIn.rev, 2);

  assert.equal(await markCommentsApplied(db, draft.id, [first.id], 2), 1);
  assert.deepEqual((await listComments(db, draft.id, { state: "applied" })).map((c) => c.id), [first.id]);
  assert.deepEqual((await listComments(db, draft.id, { state: "queued" })).map((c) => c.id), [second.id]);
  assert.equal(await markCommentsApplied(db, draft.id, [first.id], 2), 0, "a replay changes nothing");
  assert.equal(await markCommentsApplied(db, draft.id, [], 2), 0);
  await assert.rejects(() => markCommentsApplied(db, draft.id, [first.id], 0), badInput());
  await assert.rejects(() => markCommentsApplied(db, draft.id, [first.id], 3), badInput(),
    "a revision past the head folded nothing in");
  await assert.rejects(() => markCommentsApplied(db, "md-0000000000000000", [first.id], 1),
    (err) => err.code === "NOT_FOUND");

  await assert.rejects(() => addComment(db, draft.id, { rev: 1, text: "   " }), badInput());
  await assert.rejects(() => addComment(db, draft.id, { rev: 0, text: "x" }), badInput());
  await assert.rejects(() => addComment(db, "md-0000000000000000", { rev: 1, text: "x" }), (err) => err.code === "NOT_FOUND");
});

test("a voice note is written once per revision and reads back", async () => {
  const db = await freshDb();
  const { draft } = await makeDraft(db);
  assert.equal(await getVoice(db, draft.id, 1), null);
  assert.equal(await setVoice(db, draft.id, 1, { transcript: "Make it warmer", seconds: 4 }, { now: () => T0 + 1 }), true);
  assert.equal(await setVoice(db, draft.id, 1, { transcript: "Second take" }, { now: () => T0 + 2 }), false);
  assert.deepEqual(await getVoice(db, draft.id, 1), {
    draftId: draft.id, rev: 1, voice: { transcript: "Make it warmer", seconds: 4 }, createdAt: T0 + 1,
  });

  // A note may only name a revision the draft has: rev 2 exists once the head moved there.
  await assert.rejects(() => setVoice(db, draft.id, 2, { transcript: "Too soon" }), badInput());
  const second = await addRevision(db, draft.id, revInput({ body: "A second take." }), {
    author: "user", expectHash: draft.headHash, now: () => T0 + 3,
  });
  assert.ok(!second.refused);
  assert.equal(await setVoice(db, draft.id, 2, { transcript: "On the next one" }, { now: () => T0 + 4 }), true);
  assert.equal((await getVoice(db, draft.id, 2)).voice.transcript, "On the next one");
  await assert.rejects(() => setVoice(db, draft.id, 3, { transcript: "Past the head" }), badInput());
  await assert.rejects(() => setVoice(db, draft.id, 1, null), badInput());
  await assert.rejects(() => setVoice(db, "md-0000000000000000", 1, { a: 1 }), (err) => err.code === "NOT_FOUND");
});

/* ------------------------------------------------- review findings: seal, addresses, ids */

test("a move between holding and scheduled needs a fresh seal, and a full one replaces the old", async () => {
  const db = await freshDb();
  const draft = await sealedDraft(db, "holding");
  const original = await draftRow(db, draft.id);
  assert.equal(original.tap_seal, "seal-1");

  // holding -> scheduled carrying no seal fields at all is refused and writes nothing.
  await assert.rejects(
    () => transition(db, draft.id, ["holding"], "scheduled", { due_at: T0 + 90_000 }, { now: () => T0 + 100 }),
    badInput(),
  );
  let row = await draftRow(db, draft.id);
  assert.equal(row.state, "holding", "the refused move left the state alone");
  assert.equal(row.tap_seal, "seal-1");
  assert.equal(row.tap_id, "tap-1");
  assert.equal(row.tap_action, "send");
  assert.equal(row.attach_digest, "digest-1");
  assert.equal(row.due_at, null);
  assert.equal(row.updated_at, T0);

  // A partial seal (one column missing) and a seal word for the other target are refused too.
  await assert.rejects(() => transition(db, draft.id, ["holding"], "scheduled", {
    due_at: T0 + 90_000, tap_seal: "seal-2", tap_id: "tap-2", tap_action: "schedule",
  }, { now: () => T0 + 100 }), badInput());
  await assert.rejects(() => transition(db, draft.id, ["holding"], "scheduled", seal("scheduled", {
    tap_action: "send",
  }), { now: () => T0 + 100 }), badInput());
  row = await draftRow(db, draft.id);
  assert.equal(row.state, "holding");
  assert.equal(row.tap_seal, "seal-1");
  assert.equal(row.updated_at, T0);

  // A full new seal replaces every old value in the same UPDATE.
  assert.equal(await transition(db, draft.id, ["holding"], "scheduled", seal("scheduled", {
    due_at: T0 + 90_000, tap_seal: "seal-2", tap_id: "tap-2", attach_digest: "digest-2",
  }), { now: () => T0 + 200 }), true);
  row = await draftRow(db, draft.id);
  assert.equal(row.state, "scheduled");
  assert.equal(row.tap_seal, "seal-2");
  assert.equal(row.tap_id, "tap-2");
  assert.equal(row.tap_action, "schedule");
  assert.equal(row.attach_digest, "digest-2");
  assert.equal(row.updated_at, T0 + 200);

  // And back to holding with a seal of its own, never the one the schedule carried.
  await assert.rejects(
    () => transition(db, draft.id, ["scheduled"], "holding", { hold_until: T0 + 20_000 }, { now: () => T0 + 300 }),
    badInput(),
  );
  assert.equal(await transition(db, draft.id, ["scheduled"], "holding", seal("holding", {
    hold_until: T0 + 20_000, tap_seal: "seal-3", tap_id: "tap-3", attach_digest: "digest-3",
  }), { now: () => T0 + 400 }), true);
  row = await draftRow(db, draft.id);
  assert.equal(row.state, "holding");
  assert.equal(row.tap_seal, "seal-3");
  assert.equal(row.tap_id, "tap-3");
  assert.equal(row.tap_action, "send");
  assert.equal(row.attach_digest, "digest-3");
});

test("markCommentsApplied never touches a comment of another draft", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const one = await createDraft(db, {
    accountId: account.id, mode: "new", chatThreadId: "chat-1", first: revInput(), author: "bot",
  }, { now: () => T0 });
  const other = await createDraft(db, {
    accountId: account.id, mode: "new", chatThreadId: "chat-1", first: revInput({ body: "Other." }), author: "bot",
  }, { now: () => T0 + 1 });
  const mine = await addComment(db, one.id, { rev: 1, text: "Mine" }, { now: () => T0 + 2 });
  const theirs = await addComment(db, other.id, { rev: 1, text: "Theirs" }, { now: () => T0 + 3 });

  assert.equal(await markCommentsApplied(db, one.id, [theirs.id], 1), 0,
    "another draft's comment is not moved");
  assert.equal((await listComments(db, other.id))[0].state, "queued");

  assert.equal(await markCommentsApplied(db, one.id, [mine.id, theirs.id], 1), 1,
    "only this draft's comment changed");
  assert.equal((await listComments(db, one.id))[0].state, "applied");
  assert.equal((await listComments(db, other.id))[0].state, "queued");
});

test("an address entry is exactly one clean addr-spec", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fields = { accountId: account.id, mode: "new", author: "bot" };
  const create = (first) => createDraft(db, { ...fields, first }, { now: () => T0 });

  await assert.rejects(() => create(revInput({ to: [{ address: "sam@example.com, jo@example.com" }] })), badInput(),
    "a comma-joined pair is refused, never split");
  await assert.rejects(() => create(revInput({ to: [{ address: "typo@@example.com" }] })), badInput());
  await assert.rejects(() => create(revInput({ cc: [{ address: "sam @example.com" }] })), badInput(),
    "whitespace inside an address is refused");
  await assert.rejects(() => create(revInput({ to: [{ address: "Sam <sam@example.com>" }] })), badInput(),
    "angle brackets are refused");
  await assert.rejects(() => create(revInput({ bcc: [{ address: "sam@example.com; jo@example.com" }] })), badInput());
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM mail_drafts"), 0, "a refused address wrote no draft");

  const good = await create(revInput({ to: [{ name: "Sam", address: "sam@example.com" }] }));
  assert.deepEqual((await listRevisions(db, good.id))[0].to, [{ name: "Sam", address: "sam@example.com" }]);

  await assert.rejects(() => addRevision(db, good.id, revInput({ to: [{ address: "a@example.com b@example.com" }] }), {
    author: "user", expectHash: good.headHash,
  }), badInput());
  assert.equal((await getDraft(db, good.id)).headRev, 1);
});

test("hashOf canonicalises an address list before it collects display names", async () => {
  const db = await freshDb();
  const duplicated = revInput({
    to: [
      { name: "Sam", address: "sam@example.com" },
      { name: "Sam again", address: "SAM@example.com" },
      { address: "sam@example.com" },
    ],
  });
  const { draft } = await makeDraft(db, { draft: { first: duplicated } });
  const stored = (await listRevisions(db, draft.id))[0];
  assert.deepEqual(stored.to, [{ name: "Sam", address: "sam@example.com" }], "one entry, one name");

  const from = { name: "Alex", address: "alex@example.com" };
  const single = revInput({ to: [{ name: "Sam", address: "sam@example.com" }], from });
  assert.equal(hashOf({ ...duplicated, from }, { mode: "reply" }), draft.headHash,
    "the raw input hashes like the head the store wrote");
  assert.equal(hashOf({ ...duplicated, from }, { mode: "reply" }), hashOf(single, { mode: "reply" }),
    "a duplicate entry and its case cannot move the hash");
  assert.equal(hashOf(revisionToInput(stored), { mode: "reply" }), draft.headHash);
});

test("a caller's from is stripped before validation, so a malformed one cannot refuse a revision", async () => {
  const db = await freshDb();
  const { account, draft } = await makeDraft(db);
  const result = await addRevision(db, draft.id, revInput({
    from: { name: "Not an address", address: "typo@@example.com" },
  }), { author: "user", expectHash: draft.headHash, now: () => T0 + 1 });
  assert.ok(!result.refused);
  assert.deepEqual((await listRevisions(db, draft.id))[1].from, { name: "Alex", address: "alex@example.com" });

  // Not an object, not even a string: still ignored.
  const again = await addRevision(db, draft.id, revInput({ from: ["sam@example.com"] }), {
    author: "bot", expectHash: result.hash, now: () => T0 + 2,
  });
  assert.ok(!again.refused);

  const made = await createDraft(db, {
    accountId: account.id,
    mode: "new",
    first: revInput({ from: { address: "a,b@example.com" } }),
    author: "user",
  }, { now: () => T0 + 3 });
  assert.deepEqual((await listRevisions(db, made.id))[0].from, { name: "Alex", address: "alex@example.com" });
});

test("a comment names a revision the draft has, on a draft a person can still change", async () => {
  const db = await freshDb();
  const { draft } = await makeDraft(db);
  await assert.rejects(() => addComment(db, draft.id, { rev: 2, text: "Ahead of the head" }), badInput());
  assert.equal((await addComment(db, draft.id, { rev: 1, text: "Here" }, { now: () => T0 + 1 })).rev, 1);

  const rev2 = await addRevision(db, draft.id, revInput({ body: "Two." }), {
    author: "user", expectHash: draft.headHash, now: () => T0 + 2,
  });
  assert.ok(!rev2.refused);
  assert.equal((await addComment(db, draft.id, { rev: 2, text: "On the new one" }, { now: () => T0 + 3 })).rev, 2);

  for (const state of ["sent", "discarded", "unknown", "holding", "sending"]) {
    const closed = await freshDb();
    const made = await draftInState(closed, state);
    await assert.rejects(() => addComment(closed, made.id, { rev: 1, text: "Too late" }, { now: () => T0 + 4 }),
      badInput(), `${state} refuses a comment`);
    assert.equal(await count(closed, "SELECT COUNT(*) AS n FROM mail_draft_comments"), 0);
  }

  for (const state of ["draft", "failed", "missed", "scheduled"]) {
    const open = await freshDb();
    const made = await draftInState(open, state);
    assert.equal((await addComment(open, made.id, { rev: 1, text: "Still open" }, { now: () => T0 + 5 })).rev, 1,
      `${state} takes a comment`);
  }
});

test("a revision's inReplyTo and references are Message-IDs, and references keep the last 50", async () => {
  const db = await freshDb();
  const account = await makeAccount(db);
  const fields = { accountId: account.id, mode: "reply", author: "bot" };
  await assert.rejects(() => createDraft(db, { ...fields, first: revInput({ inReplyTo: "m1@mail.example.test" }) }),
    badInput(), "an inReplyTo without angle brackets is refused");
  await assert.rejects(() => createDraft(db, { ...fields, first: revInput({ inReplyTo: "<a b@mail.example.test>" }) }),
    badInput());
  await assert.rejects(() => createDraft(db, {
    ...fields, first: revInput({ references: ["<m0@mail.example.test>", "nope"] }),
  }), badInput());
  await assert.rejects(() => createDraft(db, { ...fields, first: revInput({ references: "<m0@mail.example.test>" }) }),
    badInput(), "references must be an array");
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM mail_drafts"), 0, "a bad id wrote no draft");

  const created = await createDraft(db, {
    accountId: account.id, mode: "reply", first: revInput(), author: "bot",
  }, { now: () => T0 });
  await assert.rejects(() => addRevision(db, created.id, revInput({
    references: ["<ok@mail.example.test>", "not-an-id"],
  }), { author: "user", expectHash: created.headHash, now: () => T0 + 1 }), badInput());
  assert.equal((await getDraft(db, created.id)).headRev, 1, "the refused input moved nothing");

  const many = Array.from({ length: 55 }, (_, i) => `<r${i}@mail.example.test>`);
  const result = await addRevision(db, created.id, revInput({ references: many }), {
    author: "user", expectHash: created.headHash, now: () => T0 + 2,
  });
  assert.ok(!result.refused);
  const stored = (await listRevisions(db, created.id))[1];
  assert.equal(stored.references.length, 50);
  assert.deepEqual(stored.references, many.slice(-50), "the last 50 are kept");
});

test("the head-move compare-and-set is the guard, not the pre-read", async () => {
  const db = await freshDb();
  const { draft } = await makeDraft(db);
  const tampered = "f".repeat(64);

  // A direct UPDATE lands between addRevision's pre-read of the row and its guarded UPDATE.
  let fired = false;
  const racing = {
    async execute(arg) {
      const result = await db.execute(arg);
      const sql = typeof arg === "string" ? arg : arg.sql;
      if (!fired && /FROM mail_drafts WHERE id = \?/.test(sql)) {
        fired = true;
        await db.execute({ sql: "UPDATE mail_drafts SET head_hash = ? WHERE id = ?", args: [tampered, draft.id] });
      }
      return result;
    },
    batch: (statements) => db.batch(statements),
    executeMultiple: (sql) => db.executeMultiple(sql),
    runTransaction: (work) => db.runTransaction(work),
    close: () => db.close(),
  };

  const result = await addRevision(racing, draft.id, revInput({ body: "Racing." }), {
    author: "user", expectHash: draft.headHash, now: () => T0 + 1,
  });
  assert.equal(fired, true, "the tamper ran after the pre-read");
  assert.deepEqual(result, { refused: "changed" });

  const row = await draftRow(db, draft.id);
  assert.equal(row.head_hash, tampered, "only the tamper changed the hash");
  assert.equal(row.head_rev, 1, "the head did not move");
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM mail_draft_revisions WHERE draft_id = ?", [draft.id]), 1,
    "no revision row was inserted");
});

test("addRevision refuses a bad input before it opens a transaction, leaving a scheduled draft whole", async () => {
  const db = await freshDb();
  const draft = await sealedDraft(db, "scheduled");
  const before = await draftRow(db, draft.id);
  let opened = 0;
  const watched = {
    ...db,
    runTransaction: (work) => {
      opened += 1;
      return db.runTransaction(work);
    },
  };

  await assert.rejects(() => addRevision(watched, draft.id, revInput({ references: ["not-an-id"] }), {
    author: "user", expectHash: draft.headHash, cancelSchedule: true, now: () => T0 + 1_000,
  }), badInput());
  assert.equal(opened, 0, "the transaction was never opened");

  const after = await draftRow(db, draft.id);
  assert.equal(after.state, "scheduled");
  assert.equal(after.tap_seal, before.tap_seal);
  assert.equal(after.tap_id, before.tap_id);
  assert.equal(after.tap_action, before.tap_action);
  assert.equal(after.attach_digest, before.attach_digest);
  assert.equal(after.due_at, before.due_at);
  assert.equal(after.head_rev, before.head_rev);
  assert.equal(after.head_hash, before.head_hash);
  assert.equal(after.updated_at, before.updated_at);
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM mail_draft_revisions WHERE draft_id = ?", [draft.id]), 1);
});
// Crow Mail's revision loop (plan 3, Task 9): the person's comments on the lines of a draft, the
// Revise that carries them to the bot, the note the card's note box adds, and the history the card
// reads. Every test builds the mail tables, the account send columns and the draft tables in a
// scratch DB (the draft store's own harness), and drives the services with an injected turn.
import { test, after, beforeEach } from "node:test";
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
  addComment, addRevision, createDraft, getDraft, listComments, listRevisions, transition,
} from "../servers/gateway/mail/drafts/store.js";
import {
  KEEP_USER_EDITS_SENTENCE, REVISE_FEEDBACK_NOTE, _resetTurnCommentIdsForTests,
  forgetTurnCommentIds, noteTurnCommentIds, queueComment, reviseInstruction, reviseNow, turnCommentIds,
} from "../servers/gateway/mail/drafts/revise.js";
import { proposeDraftRevision } from "../servers/gateway/mail-draft-mcp.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TURN_SOURCE = readFileSync(join(HERE, "..", "servers/gateway/mail/drafts/turn.js"), "utf8");

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
beforeEach(() => { _resetTurnCommentIdsForTests(); });

const T0 = 1_700_000_000_000;
const HOST = "mail.example.test";
const SAM = "sam@example.com";

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "crow-mail-revise-"));
  dirs.push(dir);
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(MAIL_DDL);
  for (const spec of MAIL_ACCOUNT_SEND_COLUMNS) {
    await db.execute({ sql: `ALTER TABLE ${spec.table} ADD COLUMN ${spec.column} ${spec.definition}`, args: [] });
  }
  await db.executeMultiple(MAIL_DRAFTS_DDL);
  return db;
}

async function makeAccount(db) {
  const account = await createAccount(db, {
    label: "Alex",
    address: "alex@example.com",
    imap: { host: HOST, port: 993, security: "ssl" },
    smtp: { host: HOST, port: 465, security: "ssl" },
  });
  return updateAccount(db, account.id, { displayName: "Alex" });
}

function revInput(overrides = {}) {
  return {
    to: [{ address: SAM }],
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
    botId: "draftbot",
    first: revInput(),
    author: "user",
  }, { now: () => T0 });
  return { account, draft };
}

/** The seal a move into `scheduled` must carry (the send service's job; a test only plants it). */
function scheduleSeal() {
  return {
    due_at: T0 + 3_600_000,
    tap_seal: "seal-1",
    tap_id: "tap-1",
    tap_action: "schedule",
    attach_digest: "digest-1",
  };
}

let seq = 0;

/**
 * A drafting turn stood in for the real one: it records the options it was started with, and records
 * the comments the turn starts with, exactly as `startDraftingTurn` does at mint time.
 */
function fakeTurn(db, calls) {
  return async (store, deps, options) => {
    calls.push({ deps, options });
    seq += 1;
    const turnId = "mt-" + String(seq).padStart(16, "0");
    const queued = await listComments(store, options.draftId, { state: "queued" });
    noteTurnCommentIds(turnId, queued.map((comment) => comment.id));
    return { turnId };
  };
}

function isCode(code) {
  return (err) => {
    assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
    assert.equal(err.code, code);
    return true;
  };
}

/* ------------------------------------------------------------------ the instruction */

test("the instruction names every comment with its quoted line, the card's note and the keep-edits rule", () => {
  const instruction = reviseInstruction({
    comments: [
      { lineIndex: 2, quote: "Tuesday works for me.", text: "Say Thursday." },
      { lineIndex: null, quote: null, text: "Shorter, please." },
    ],
    chatNote: "Keep it friendly.",
  });

  assert.ok(instruction.includes(REVISE_FEEDBACK_NOTE), "the framing is the exported constant, whole");
  assert.match(REVISE_FEEDBACK_NOTE, /untrusted data/);
  assert.ok(instruction.includes("Line 2"), "the line the person pointed at");
  assert.ok(instruction.includes("Tuesday works for me."), "and the words they pointed at");
  assert.ok(instruction.includes("Say Thursday."));
  assert.ok(instruction.includes("Shorter, please."), "a comment with no line still travels");
  assert.ok(instruction.includes("Keep it friendly."), "the note from the card's note box");
  assert.ok(instruction.includes(KEEP_USER_EDITS_SENTENCE));
  assert.equal(KEEP_USER_EDITS_SENTENCE, "Keep every edit the person made by hand (revisions authored 'user').");

  const bare = reviseInstruction({ comments: [] });
  assert.ok(!bare.includes("Keep it friendly."), "no note, no note line");
  assert.ok(bare.includes(KEEP_USER_EDITS_SENTENCE));
});

/* --------------------------------------------------------------------- queueing */

test("a comment may name only the revision the draft is on", async () => {
  const db = await freshDb();
  const { draft } = await makeDraft(db);
  const first = await queueComment(db, draft.id, { rev: 1, lineIndex: 1, quote: "Hello Sam,", text: "Warmer." },
    { now: () => T0 + 1 });
  assert.equal(first.state, "queued");
  assert.equal(first.rev, 1);
  assert.equal(first.quote, "Hello Sam,");

  const second = await addRevision(db, draft.id, revInput({ body: "Tuesday it is." }), {
    author: "user", expectHash: draft.headHash, now: () => T0 + 2,
  });
  assert.ok(!second.refused);
  await assert.rejects(() => queueComment(db, draft.id, { rev: 1, text: "On the old one" }), isCode("CHANGED"),
    "a comment on a revision the draft has left is a stale card");
  await assert.rejects(() => queueComment(db, draft.id, { rev: 9, text: "Ahead of the head" }), isCode("CHANGED"),
    "a revision the draft does not have is not the one it is on either");
  assert.equal((await queueComment(db, draft.id, { rev: 2, text: "On the head" })).rev, 2);
  await assert.rejects(() => queueComment(db, "md-0000000000000000", { rev: 1, text: "x" }), isCode("NOT_FOUND"));
});

/* ----------------------------------------------------------------------- Revise */

test("reviseNow reads the queued comments and hands them to one turn", async () => {
  const db = await freshDb();
  const { draft } = await makeDraft(db);
  const comment = await queueComment(db, draft.id, {
    rev: 1, lineIndex: 1, quote: "Tuesday works for me.", text: "Say Thursday.",
  }, { now: () => T0 + 1 });

  const calls = [];
  const out = await reviseNow(db, { startDraftingTurn: fakeTurn(db, calls) }, {
    draftId: draft.id, expectHash: draft.headHash,
  });

  assert.match(out.turnId, /^mt-[0-9a-f]+$/);
  assert.equal(calls.length, 1, "exactly one turn");
  assert.equal(calls[0].options.draftId, draft.id);
  assert.equal(calls[0].options.botId, "draftbot", "the draft's own bot runs the revise");
  assert.match(calls[0].options.instruction, /Say Thursday\./);
  assert.match(calls[0].options.instruction, /Tuesday works for me\./);
  assert.deepEqual(Object.keys(calls[0].deps), [], "a revise turn gets no adapter and no sync");
  assert.deepEqual(turnCommentIds(out.turnId), [comment.id], "the turn's own comments are recorded");
  forgetTurnCommentIds(out.turnId);
});

test("a note from the card's note box rides the same instruction", async () => {
  const db = await freshDb();
  const { draft } = await makeDraft(db);
  await queueComment(db, draft.id, { rev: 1, text: "Warmer." }, { now: () => T0 + 1 });

  const calls = [];
  const out = await reviseNow(db, { startDraftingTurn: fakeTurn(db, calls) }, {
    draftId: draft.id, chatNote: "Keep it under three lines.",
  });
  assert.ok(out.turnId);
  assert.match(calls[0].options.instruction, /Keep it under three lines\./);
  assert.match(calls[0].options.instruction, /Warmer\./);
  forgetTurnCommentIds(out.turnId);
});

test("reviseNow starts no turn when nothing is waiting and no note was typed", async () => {
  const db = await freshDb();
  const { draft } = await makeDraft(db);
  const calls = [];
  const out = await reviseNow(db, { startDraftingTurn: fakeTurn(db, calls) }, { draftId: draft.id });
  assert.deepEqual(out, { turnId: null });
  assert.equal(calls.length, 0);

  const composed = await reviseNow(db, { startDraftingTurn: fakeTurn(db, calls) }, {
    draftId: draft.id, chatNote: "Say it in one line.",
  });
  assert.ok(composed.turnId, "a note on its own is a reason to revise");
  forgetTurnCommentIds(composed.turnId);
});

test("a stale expectHash is refused changed and no turn starts", async () => {
  const db = await freshDb();
  const { draft } = await makeDraft(db);
  await queueComment(db, draft.id, { rev: 1, text: "Warmer." }, { now: () => T0 + 1 });
  const calls = [];
  const out = await reviseNow(db, { startDraftingTurn: fakeTurn(db, calls) }, {
    draftId: draft.id, expectHash: "0".repeat(64),
  });
  assert.deepEqual(out, { refused: "changed" });
  assert.equal(calls.length, 0);
  assert.equal((await listComments(db, draft.id))[0].state, "queued", "the comment still waits");
});

test("a revise on a scheduled draft is refused, and the comments stay queued", async () => {
  const db = await freshDb();
  const { draft } = await makeDraft(db);
  await queueComment(db, draft.id, { rev: 1, text: "Warmer." }, { now: () => T0 + 1 });
  // The send service is the only writer of a tap state; this test plants one to stand in for it.
  assert.equal(await transition(db, draft.id, ["draft"], "scheduled", scheduleSeal(), { now: () => T0 }), true);

  const calls = [];
  const out = await reviseNow(db, { startDraftingTurn: fakeTurn(db, calls) }, {
    draftId: draft.id, expectHash: (await getDraft(db, draft.id)).headHash,
  });
  assert.deepEqual(out, { refused: "frozen", state: "scheduled" });
  assert.equal(calls.length, 0);
  assert.equal((await listComments(db, draft.id))[0].state, "queued");
});

/* ----------------------------------------------------- the comments and the propose */

test("Revise applies all queued comments and marks them applied with the revision it lands", async () => {
  const db = await freshDb();
  const { draft } = await makeDraft(db);
  const warmer = await queueComment(db, draft.id, { rev: 1, lineIndex: 1, text: "Warmer." }, { now: () => T0 + 1 });
  const shorter = await queueComment(db, draft.id, { rev: 1, text: "Shorter." }, { now: () => T0 + 2 });

  const calls = [];
  const started = await reviseNow(db, { startDraftingTurn: fakeTurn(db, calls) }, {
    draftId: draft.id, expectHash: draft.headHash,
  });
  const head = await getDraft(db, draft.id);
  const proposed = await proposeDraftRevision(db, {
    draftId: draft.id, turnId: started.turnId, startHash: head.headHash,
  }, { body: "Warmer, and shorter." });

  assert.equal(proposed.rev, 2);
  const row = await getDraft(db, draft.id);
  assert.equal(row.headRev, 2);
  assert.equal((await listRevisions(db, draft.id)).at(-1).body, "Warmer, and shorter.");
  assert.deepEqual((await listComments(db, draft.id, { state: "applied" })).map((c) => c.id).sort(),
    [warmer.id, shorter.id].sort(), "both comments went with the revision");
  assert.deepEqual(await listComments(db, draft.id, { state: "queued" }), []);
  assert.deepEqual(turnCommentIds(started.turnId), [], "the turn's record is spent");
});

test("a user edit during a bot turn makes propose refuse changed and the comments stay queued", async () => {
  const db = await freshDb();
  const { draft } = await makeDraft(db);
  const comment = await queueComment(db, draft.id, { rev: 1, text: "Warmer." }, { now: () => T0 + 1 });

  const calls = [];
  const started = await reviseNow(db, { startDraftingTurn: fakeTurn(db, calls) }, {
    draftId: draft.id, expectHash: draft.headHash,
  });
  const edited = await addRevision(db, draft.id, revInput({ body: "The person's own wording." }), {
    author: "user", expectHash: draft.headHash, now: () => T0 + 2,
  });
  assert.ok(!edited.refused);

  const proposed = await proposeDraftRevision(db, {
    draftId: draft.id, turnId: started.turnId, startHash: draft.headHash,
  }, { body: "The bot's stale revision." });
  assert.deepEqual(proposed, { refused: "changed" });

  const row = await getDraft(db, draft.id);
  assert.equal(row.headRev, 2);
  assert.equal((await listRevisions(db, draft.id)).at(-1).body, "The person's own wording.");
  assert.equal((await listComments(db, draft.id))[0].state, "queued", "the comment waits for the next Revise");
  assert.equal((await listComments(db, draft.id))[0].id, comment.id);
});

test("a comment queued during a turn is not marked applied by that turn's propose", async () => {
  const db = await freshDb();
  const { draft } = await makeDraft(db);
  const seen = await queueComment(db, draft.id, { rev: 1, text: "Warmer." }, { now: () => T0 + 1 });

  const calls = [];
  const started = await reviseNow(db, { startDraftingTurn: fakeTurn(db, calls) }, {
    draftId: draft.id, expectHash: draft.headHash,
  });
  // The person adds a second comment while the bot is still writing.
  const later = await addComment(db, draft.id, { rev: 1, text: "And shorter." }, { now: () => T0 + 2 });
  assert.equal(later.draftId, draft.id);
  assert.equal((await getDraft(db, draft.id)).headRev, 1);

  const proposed = await proposeDraftRevision(db, {
    draftId: draft.id, turnId: started.turnId, startHash: draft.headHash,
  }, { body: "Warmer." });
  assert.equal(proposed.rev, 2);
  assert.deepEqual((await listComments(db, draft.id, { state: "applied" })).map((c) => c.id), [seen.id]);
  assert.deepEqual((await listComments(db, draft.id, { state: "queued" })).map((c) => c.id), [later.id],
    "the comment the turn never saw is still waiting");
});

test("propose on a draft that is gone answers not_found and the turn's record is left alone", async () => {
  const db = await freshDb();
  const { draft } = await makeDraft(db);
  noteTurnCommentIds("mt-other", []);
  const proposed = await proposeDraftRevision(db, {
    draftId: "md-0000000000000000", turnId: "mt-other", startHash: draft.headHash,
  }, { body: "Nowhere." });
  assert.deepEqual(proposed, { error: "not_found" });
  forgetTurnCommentIds("mt-other");
});

/* -------------------------------------------------------------------- the record */

test("the first record for a turn is the one propose reads", () => {
  noteTurnCommentIds("mt-first", ["mdc-a"]);
  noteTurnCommentIds("mt-first", ["mdc-b"]);
  assert.deepEqual(turnCommentIds("mt-first"), ["mdc-a"], "the turn's own snapshot is never replaced");
  forgetTurnCommentIds("mt-first");
  assert.deepEqual(turnCommentIds("mt-first"), []);
  assert.deepEqual(turnCommentIds("mt-never-noted"), []);
});

test("a drafting turn records the comments it started with", () => {
  assert.match(TURN_SOURCE, /noteTurnCommentIds\(/, "the turn records its snapshot at mint time");
  assert.match(TURN_SOURCE, /forgetTurnCommentIds\(/, "and forgets it when the turn ends");
});
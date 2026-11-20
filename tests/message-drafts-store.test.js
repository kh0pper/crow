// Crow Messages' draft store (servers/gateway/messages/drafts-store.js): one open draft per
// conversation, the compare-and-set every edit goes through, the sealed audience (contact id, crow id
// and the KEY SNAPSHOT per recipient), the audit trail that carries ids and hashes but never the
// text, the boot sweep that reopens an interrupted send, and the live event every write pokes.
//
// A real init-db'd scratch crow.db (CROW_DATA_DIR, so nothing can touch the real ~/.crow), copied per
// test, and the real store — only the clock and the seal seed are injected.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const root = mkdtempSync(join(tmpdir(), "message-drafts-store-"));
process.env.CROW_DATA_DIR = join(root, "master");
process.env.CROW_HOME = join(root, "home");
delete process.env.CROW_DB_PATH;
mkdirSync(process.env.CROW_HOME, { recursive: true });
const REPO = new URL("..", import.meta.url).pathname;
const MASTER = join(root, "master", "crow.db");

const { createDbClient } = await import("../servers/db.js");
const bus = (await import("../servers/shared/event-bus.js")).default;
const store = await import("../servers/gateway/messages/drafts-store.js");
const { verifyRecipients, sealRecipients } = await import("../servers/gateway/messages/drafts-seal.js");
const { recipientKey, canonicalRecipients } = await import("../servers/gateway/messages/conversations.js");

const SEED = Buffer.from("a fixed keychain seed for the draft store");
const CONVERSATION = { conversationKind: "contact", conversationId: 7 };
const PEER = { contactId: 7, crowId: "crow:peer", pubkey: "02" + "a".repeat(64) };
const RECIPIENTS = [PEER];

const open = [];

after(() => {
  for (const db of open) {
    try { db.close(); } catch { /* already closed */ }
  }
  rmSync(root, { recursive: true, force: true });
});

before(() => {
  mkdirSync(join(root, "master"), { recursive: true });
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: join(root, "master") },
    stdio: "pipe",
    cwd: REPO,
  });
  // Fold any WAL back into the file, so each test's copy is the whole schema.
  const raw = new Database(MASTER);
  raw.pragma("wal_checkpoint(TRUNCATE)");
  raw.close();
});

beforeEach(() => {
  bus.removeAllListeners(store.DRAFT_CHANGED_EVENT);
});

let n = 0;

/** A private copy of the master DB, and the clock/seed seam the store takes. */
function fixture() {
  const dir = join(root, "t" + (++n));
  mkdirSync(dir);
  const crow = join(dir, "crow.db");
  copyFileSync(MASTER, crow);
  const db = createDbClient(crow);
  open.push(db);
  let ticks = 0;
  let clock = 1_767_225_600_000;
  const opts = {
    loadSeed: async () => SEED,
    now: () => (clock += ++ticks),
  };
  return { db, crow, opts };
}

/** The store's own create call, with the recipient set the route would have derived. */
function newDraft(f, over = {}) {
  return store.createDraft(f.db, {
    ...CONVERSATION,
    body: "Are we still on for Saturday?",
    recipients: RECIPIENTS,
    ...over,
  }, f.opts);
}

const sha = (text) => createHash("sha256").update(text).digest("hex");

test("the boot pass runs the sweep with its own client, and never throws", async () => {
  const f = fixture();
  const { draft } = await newDraft(f);
  await store.beginSend(f.db, draft.id, { body: "stuck words", expectVersion: 1 }, f.opts);

  const { runStuckDraftSweep } = await import("../servers/gateway/boot/message-drafts-sweep.js");
  const lines = [];
  const opened = [];
  const out = await runStuckDraftSweep({
    dbFactory: () => {
      const db = createDbClient(f.crow);
      opened.push(db);
      return db;
    },
    now: Date.now() + 60 * 60 * 1000,
    olderThanMs: 0,
    log: (m) => lines.push(m),
  });
  assert.equal(out.reopened, 1, "the boot pass reopened the interrupted send");
  assert.equal(opened.length, 1, "it opened exactly one client");
  assert.equal((await store.getDraft(f.db, draft.id)).state, "open");
  assert.match(lines.join("\n"), /reopened 1 interrupted send/, "and said so once");

  // A boot path never throws, whatever the store or the db factory does.
  const failed = await runStuckDraftSweep({
    dbFactory: () => { throw new Error("no database"); },
    log: (m) => lines.push(m),
  });
  assert.deepEqual(failed, { reopened: 0, parked: 0 });
  assert.match(lines.join("\n"), /stuck-send sweep skipped/);

  // And it IS wired into the boot sequence (post-listen), not just available to it.
  const src = readFileSync(new URL("../servers/gateway/boot/post-listen.js", import.meta.url), "utf8");
  assert.match(src, /message-drafts-sweep\.js/, "the gateway's boot path runs the sweep");
  assert.match(src, /runStuckDraftSweep/, "by name");

  // ONCE, at boot, and never on an interval: a periodic pass would reopen a send that is still in
  // flight (here or in another gateway sharing crow.db), and the delivery that then lands would leave
  // the draft open holding text that already went out — the next tap sends it twice.
  const fromDrafts = src.slice(src.indexOf("Crow Messages saved drafts"));
  assert.ok(fromDrafts.length > 0, "the drafts block is where it was");
  const block = fromDrafts.slice(0, fromDrafts.indexOf("Card offers"));
  assert.match(block, /setImmediate/, "the pass is armed right after listen");
  assert.doesNotMatch(block, /setInterval/, "and nothing re-arms it: no interval can reopen an in-flight send");
});

/* -------------------------------------------------------------------- tests */

test("a draft is sealed, hashed and written with a create audit row that carries no text", async () => {
  const f = fixture();
  const { ok, draft, created } = await newDraft(f, { body: "the private words" });
  assert.equal(ok, true);
  assert.equal(created, true);
  assert.match(draft.id, store.MESSAGE_DRAFT_ID_RE);
  assert.equal(draft.state, "open");
  assert.equal(draft.version, 1);
  assert.deepEqual(draft.recipients, [PEER], "the audience carries the contact, the crow id and the key snapshot");
  assert.equal(draft.bodyHash, sha("the private words"));
  assert.equal(draft.origin, "owner");
  assert.equal(draft.botId, null);
  assert.equal(draft.botName, null);

  // The seal covers the draft's identity AND its audience, keys included, under the injected seed.
  const fields = store.sealFieldsFor(draft);
  assert.deepEqual(fields, {
    draftId: draft.id,
    origin: "owner",
    botId: null,
    botName: null,
    conversationKind: "contact",
    conversationId: 7,
    createdAt: draft.createdAt,
    recipients: [recipientKey(PEER)],
  });
  assert.equal(draft.recipientsSeal, sealRecipients(fields, SEED));
  assert.equal(verifyRecipients(fields, draft.recipientsSeal, SEED), true);

  // The row on disk holds the audience in the documented shape.
  const raw = await f.db.execute({ sql: "SELECT recipients_json FROM message_drafts WHERE id = ?", args: [draft.id] });
  assert.deepEqual(JSON.parse(raw.rows[0].recipients_json), [{
    contact_id: 7, crow_id: "crow:peer", secp256k1_pubkey: PEER.pubkey,
  }]);

  const audit = await store.listAudit(f.db, draft.id);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "create");
  assert.equal(audit[0].actor, "owner");
  assert.equal(audit[0].version, 1);
  assert.equal(audit[0].bodyHash, sha("the private words"));
  assert.equal(audit[0].recipientsSeal, draft.recipientsSeal);
  assert.doesNotMatch(JSON.stringify(audit), /private words/, "the audit trail never carries the message text");
});

test("a bot's draft records its origin, its id and the name snapshot that is sealed with it", async () => {
  const f = fixture();
  const { draft } = await newDraft(f, {
    origin: "bot", botId: "bird", botName: "Hank", body: "Drafted by the bot",
  });
  assert.equal(draft.origin, "bot");
  assert.equal(draft.botId, "bird");
  assert.equal(draft.botName, "Hank", "the name a person will read is on the row (and under the seal)");
  assert.equal(draft.state, "open", "a bot's message is always a draft in v1");
  assert.equal(store.sealFieldsFor(draft).botName, "Hank");
  assert.equal(verifyRecipients(store.sealFieldsFor(draft), draft.recipientsSeal, SEED), true);
  const audit = await store.listAudit(f.db, draft.id);
  assert.equal(audit[0].actor, "bot");
  assert.equal(audit[0].actorId, "bird");
});

test("one open draft per conversation: a second create is an edit of the same row", async () => {
  const f = fixture();
  const first = await newDraft(f, { body: "first" });
  const second = await newDraft(f, { body: "second" });
  assert.equal(second.created, false, "the conversation already had an open draft");
  assert.equal(second.draft.id, first.draft.id, "it is the same draft");
  assert.equal(second.draft.version, 2);
  assert.equal(second.draft.body, "second");

  const rows = await store.listDrafts(f.db, CONVERSATION);
  assert.equal(rows.length, 1, "one row, not two");
  const audit = await store.listAudit(f.db, first.draft.id);
  assert.deepEqual(audit.map((row) => row.action), ["create", "edit"]);

  // A different conversation gets its own open draft.
  const other = await store.createDraft(f.db, {
    conversationKind: "contact",
    conversationId: 8,
    body: "hi",
    recipients: [{ contactId: 8, crowId: "crow:other", pubkey: "02" + "b".repeat(64) }],
  }, f.opts);
  assert.equal(other.created, true);
  assert.notEqual(other.draft.id, first.draft.id);
});

test("create-only (`expectVersion: 0`) never overwrites an open draft: it answers changed with it", async () => {
  const f = fixture();
  const first = await newDraft(f, { body: "words another view saved" });

  const outcome = await newDraft(f, { body: "words typed in ignorance of them", expectVersion: 0 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.refused, "changed");
  assert.equal(outcome.draft.id, first.draft.id, "the caller is handed the row that is there");
  assert.equal(outcome.draft.body, "words another view saved");
  assert.equal(outcome.draft.version, 1);
  assert.equal((await store.getDraft(f.db, first.draft.id)).body, "words another view saved",
    "nothing was written");
  assert.deepEqual((await store.listAudit(f.db, first.draft.id)).map((row) => row.action), ["create"],
    "and no edit row claims otherwise");

  // With no open draft, create-only is just a create.
  const fresh = await store.createDraft(f.db, {
    conversationKind: "contact",
    conversationId: 9,
    body: "first",
    recipients: [{ contactId: 9, crowId: "crow:nine", pubkey: "02" + "c".repeat(64) }],
    expectVersion: 0,
  }, f.opts);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.created, true);
});

test("a create with a stale expectVersion is refused as changed, with the row as it now is", async () => {
  const f = fixture();
  const { draft } = await newDraft(f, { body: "one" });
  await newDraft(f, { body: "two" });
  const outcome = await newDraft(f, { body: "three", expectVersion: draft.version });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.refused, "changed");
  assert.equal(outcome.draft.version, 2, "the caller is told the version to redraw from");
  assert.equal((await store.getDraft(f.db, draft.id)).body, "two", "nothing was written");
});

test("an autosave is a compare-and-set on the version", async () => {
  const f = fixture();
  const { draft } = await newDraft(f, { body: "draft one" });

  const good = await store.updateBody(f.db, draft.id, { body: "draft two", expectVersion: 1 }, f.opts);
  assert.equal(good.ok, true);
  assert.equal(good.draft.version, 2);
  assert.equal(good.draft.body, "draft two");

  // A second writer still holding version 1 loses, and is told the current version.
  const stale = await store.updateBody(f.db, draft.id, { body: "draft three", expectVersion: 1 }, f.opts);
  assert.equal(stale.ok, false);
  assert.equal(stale.refused, "changed");
  assert.equal(stale.draft.version, 2);
  assert.equal((await store.getDraft(f.db, draft.id)).body, "draft two", "the stale write never landed");

  const audit = await store.listAudit(f.db, draft.id);
  assert.deepEqual(audit.map((row) => [row.action, row.version]), [["create", 1], ["edit", 2]]);
  assert.equal(audit[1].bodyHash, sha("draft two"));
});

test("send-state: open -> sending (audited) -> sent, and a failure puts it back to open", async () => {
  const f = fixture();
  const { draft } = await newDraft(f);

  const begun = await store.beginSend(f.db, draft.id, { body: "the posted text", expectVersion: 1 }, f.opts);
  assert.equal(begun.ok, true);
  assert.equal(begun.draft.state, "sending");
  assert.equal(begun.draft.version, 2);
  assert.equal(begun.draft.body, "the posted text", "the text that is about to go out is the text stored");
  assert.equal(begun.draft.bodyHash, sha("the posted text"));

  // A second tap on the version it was looking at loses: the row is no longer open.
  const second = await store.beginSend(f.db, draft.id, { body: "again", expectVersion: 1 }, f.opts);
  assert.equal(second.ok, false);
  assert.equal(second.refused, "not_open");
  assert.equal(second.draft.state, "sending");

  // A delivery that does not land returns the draft to open, with a reason and no audit row.
  assert.equal(await store.markSendFailed(f.db, draft.id, { reason: "delivery_failed" }, f.opts), true);
  const reopened = await store.getDraft(f.db, draft.id);
  assert.equal(reopened.state, "open");
  assert.equal(reopened.failReason, "delivery_failed");
  assert.equal(reopened.sentAt, null);
  const afterFailure = await store.listAudit(f.db, draft.id);
  assert.deepEqual(afterFailure.map((row) => row.action), ["create", "send"],
    "a failed attempt is not a send: no audit row for it");

  // Trying again works, and a landed delivery closes the draft.
  const retry = await store.beginSend(f.db, draft.id, { body: "the posted text", expectVersion: 2 }, f.opts);
  assert.equal(retry.ok, true);
  assert.equal(await store.markSent(f.db, draft.id, { messageId: 42 }, f.opts), true);
  const sent = await store.getDraft(f.db, draft.id);
  assert.equal(sent.state, "sent");
  assert.equal(sent.sentMessageId, "42");
  assert.equal(sent.failReason, null);
  assert.equal(await store.markSent(f.db, draft.id, {}, f.opts), false, "a row not sending cannot be marked sent");

  // A sent draft is finished: no more edits.
  const frozen = await store.updateBody(f.db, draft.id, { body: "too late", expectVersion: sent.version }, f.opts);
  assert.equal(frozen.ok, false);
  assert.equal(frozen.refused, "not_open");
});

test("discard closes the draft, keeps the row, and frees the conversation", async () => {
  const f = fixture();
  const { draft } = await newDraft(f);
  const discarded = await store.discardDraft(f.db, draft.id, {}, f.opts);
  assert.equal(discarded.ok, true);
  assert.equal(discarded.draft.state, "discarded");

  const again = await store.discardDraft(f.db, draft.id, {}, f.opts);
  assert.equal(again.ok, false);
  assert.equal(again.refused, "not_open");

  const stale = await store.discardDraft(f.db, draft.id, { expectVersion: 1 }, f.opts);
  assert.equal(stale.ok, false, "a discarded row is never open, whatever the version says");

  const audit = await store.listAudit(f.db, draft.id);
  assert.deepEqual(audit.map((row) => row.action), ["create", "discard"]);

  // The conversation is free again: the partial unique index only holds one OPEN row.
  const next = await newDraft(f, { body: "a fresh start" });
  assert.equal(next.created, true);
  assert.notEqual(next.draft.id, draft.id);
  assert.equal((await store.listDrafts(f.db, CONVERSATION)).length, 2,
    "the discarded row is history, the new one is the open draft");
});

test("a tampered audience, a forged seal, a rewritten origin or a backdated row stops verifying", async () => {
  const f = fixture();
  const { draft } = await newDraft(f);
  assert.equal(verifyRecipients(store.sealFieldsFor(draft), draft.recipientsSeal, SEED), true);

  // Somebody edited the audience straight in the table (a bot writing the DB directly).
  const other = { contact_id: 99, crow_id: "crow:somebody-else", secp256k1_pubkey: "02" + "d".repeat(64) };
  await f.db.execute({
    sql: "UPDATE message_drafts SET recipients_json = ? WHERE id = ?",
    args: [JSON.stringify([other]), draft.id],
  });
  const edited = await store.getDraft(f.db, draft.id);
  assert.deepEqual(edited.recipients, [{
    contactId: 99, crowId: "crow:somebody-else", pubkey: other.secp256k1_pubkey,
  }]);
  assert.equal(verifyRecipients(store.sealFieldsFor(edited), edited.recipientsSeal, SEED), false,
    "the seal no longer covers the audience the row names");

  // The SAME crow id with a replaced key is a different recipient (the pubkey is in the snapshot).
  const swappedKey = { ...edited.recipients[0], pubkey: "02" + "e".repeat(64) };
  assert.equal(verifyRecipients(store.sealFieldsFor({ ...edited, recipients: [swappedKey] }), edited.recipientsSeal, SEED), false,
    "a key that changed is not the draft this seal was made for");

  // A forged seal is refused too, whatever it covers.
  const forged = sealRecipients(
    { ...store.sealFieldsFor(draft), recipients: canonicalRecipients([{ contactId: 99, crowId: "crow:somebody-else", pubkey: other.secp256k1_pubkey }]) },
    SEED,
  );
  assert.equal(verifyRecipients(store.sealFieldsFor(draft), forged, SEED), false,
    "a seal for another audience does not verify for this row");

  // A bot's draft rewritten to be the owner's fails: origin, bot id and bot name are sealed.
  const botDraft = await newDraft(f, { conversationKind: "contact", conversationId: 11, origin: "bot", botId: "hank", botName: "Hank", body: "from a bot", recipients: [PEER] });
  assert.equal(verifyRecipients(store.sealFieldsFor(botDraft.draft), botDraft.draft.recipientsSeal, SEED), true);
  await f.db.execute({
    sql: "UPDATE message_drafts SET origin = 'owner', bot_id = NULL, bot_name = NULL WHERE id = ?",
    args: [botDraft.draft.id],
  });
  const rewritten = await store.getDraft(f.db, botDraft.draft.id);
  assert.equal(rewritten.origin, "owner");
  assert.equal(verifyRecipients(store.sealFieldsFor(rewritten), rewritten.recipientsSeal, SEED), false,
    "a bot's draft cannot be rewritten as the operator's");

  // Backdating is sealed too: created_at is part of the payload.
  await f.db.execute({ sql: "UPDATE message_drafts SET created_at = 1 WHERE id = ?", args: [draft.id] });
  const backdated = await store.getDraft(f.db, draft.id);
  assert.equal(verifyRecipients(store.sealFieldsFor(backdated), backdated.recipientsSeal, SEED), false);

  // A different key (another instance's keychain) sees none of it as valid.
  const otherKey = Buffer.from("a different instance's keychain key");
  assert.equal(verifyRecipients(store.sealFieldsFor(draft), draft.recipientsSeal, otherKey), false);
});

test("a delivery that lands after its row was moved closes it as sent, with a `sent-late` audit row", async () => {
  const f = fixture();
  const { draft } = await newDraft(f);
  await store.beginSend(f.db, draft.id, { body: "the posted text", expectVersion: 1 }, f.opts);

  // A boot pass (this process, or another gateway sharing crow.db) decided the sender was gone and
  // reopened the row while the delivery was still in flight.
  const sweptAt = Date.now() + 10 * 60_000;
  await store.sweepStuckSends(f.db, { ...f.opts, olderThanMs: 0, now: sweptAt });
  assert.equal((await store.getDraft(f.db, draft.id)).state, "open");

  // The delivery then lands: markSent only moves a `sending` row, so it answers false...
  assert.equal(await store.markSent(f.db, draft.id, { messageId: 55 }, f.opts), false);
  // ...and the row is closed on the sent id anyway, because the message DID go out.
  assert.equal(await store.markSentLate(f.db, draft.id, { messageId: 55 }, { ...f.opts, now: sweptAt + 1000 }), true);
  const sent = await store.getDraft(f.db, draft.id);
  assert.equal(sent.state, "sent", "no open draft is left holding text that already went out");
  assert.equal(sent.sentMessageId, "55");
  assert.equal(sent.sentAt, sent.updatedAt, "it carries the time the delivery landed");
  assert.equal(sent.failReason, null, "the sweep's send_interrupted no longer applies");
  assert.deepEqual((await store.listAudit(f.db, draft.id)).map((row) => [row.action, row.actor]),
    [["create", "owner"], ["send", "owner"], ["reopened", "system"], ["sent-late", "system"]],
    "a reader can explain why a row nobody tapped is closed");
  assert.equal(await store.getOpenDraft(f.db, "contact", 7), null, "the conversation has no open draft");

  // A row already `sent` is not moved twice.
  assert.equal(await store.markSentLate(f.db, draft.id, {}, f.opts), false);

  // A delivery that failed and was put back to `open`, whose retry then landed late, is closed the
  // same way — no open draft keeps the words a second time.
  const again = await store.createDraft(f.db, {
    conversationKind: "contact",
    conversationId: 8,
    body: "tried twice",
    recipients: [{ contactId: 8, crowId: "crow:other", pubkey: "02" + "b".repeat(64) }],
  }, f.opts);
  await store.beginSend(f.db, again.draft.id, { body: "tried twice", expectVersion: 1 }, f.opts);
  assert.equal(await store.markSendFailed(f.db, again.draft.id, { reason: "delivery_failed" }, f.opts), true);
  assert.equal((await store.getDraft(f.db, again.draft.id)).state, "open");
  assert.equal(await store.markSentLate(f.db, again.draft.id, { messageId: "56" }, f.opts), true);
  assert.equal((await store.getDraft(f.db, again.draft.id)).state, "sent");
});

test("the boot sweep returns an interrupted send to open, with a `reopened` audit row", async () => {
  const f = fixture();
  const { draft } = await newDraft(f);
  await store.beginSend(f.db, draft.id, { body: "the posted text", expectVersion: 1 }, f.opts);
  assert.equal((await store.getDraft(f.db, draft.id)).state, "sending");

  // A sweep that runs immediately leaves a send that may still be in flight alone.
  const young = await store.sweepStuckSends(f.db, { ...f.opts, olderThanMs: 60_000 });
  assert.deepEqual(young, { reopened: 0, parked: 0 }, "a fresh `sending` row is somebody's live send");
  assert.equal((await store.getDraft(f.db, draft.id)).state, "sending");

  // Once it is older than the window, it goes back to `open` — text kept, reason recorded.
  const swept = await store.sweepStuckSends(f.db, { ...f.opts, olderThanMs: 0, now: Date.now() + 10 * 60_000 });
  assert.equal(swept.reopened, 1);
  const reopened = await store.getDraft(f.db, draft.id);
  assert.equal(reopened.state, "open");
  assert.equal(reopened.failReason, "send_interrupted");
  assert.equal(reopened.body, "the posted text", "the words are still there to send again");
  assert.deepEqual((await store.listAudit(f.db, draft.id)).map((row) => [row.action, row.actor]),
    [["create", "owner"], ["send", "owner"], ["reopened", "system"]],
    "a state change nobody tapped is in the trail");

  // And the conversation can be sent again.
  const retry = await store.beginSend(f.db, draft.id, { body: "the posted text", expectVersion: reopened.version }, f.opts);
  assert.equal(retry.ok, true);
});

test("the boot sweep parks a stuck send whose conversation gained a newer draft", async () => {
  const NEWER_ID = "msgd-" + "e".repeat(32);
  const f = fixture();
  const { draft } = await newDraft(f);
  await store.beginSend(f.db, draft.id, { body: "in flight", expectVersion: 1 }, f.opts);
  // The person started over while that send was in flight: `sending` does not hold the partial unique
  // index, so a NEW open draft can exist beside it — and the sweep's UPDATE to `open` is the one that
  // collides with it.
  await f.db.execute({
    sql: `INSERT INTO message_drafts
            (id, conversation_kind, conversation_id, origin, bot_id, bot_name, state, version, body,
             body_hash, recipients_json, recipients_seal, created_at, updated_at)
          VALUES (?, 'contact', 7, 'owner', NULL, NULL, 'open', 1, 'newer',
                  'hash', '[{"contact_id":7,"crow_id":"crow:peer","secp256k1_pubkey":"x"}]',
                  'seal', 1, 1)`,
    args: [NEWER_ID],
  });
  const swept = await store.sweepStuckSends(f.db, { ...f.opts, olderThanMs: 0, now: Date.now() + 10 * 60_000 });
  assert.equal(swept.parked, 1);
  assert.equal((await store.getDraft(f.db, draft.id)).state, "failed",
    "the stuck send is parked, never sent, and the newer draft stays the open one");
  assert.equal((await store.getDraft(f.db, NEWER_ID)).state, "open");
  assert.deepEqual((await store.listAudit(f.db, draft.id)).map((row) => [row.action, row.actor]),
    [["create", "owner"], ["send", "owner"], ["parked", "system"]],
    "a row parked as failed is `parked` in the trail, not a draft anybody can pick up again");
});

test("one row the sweep cannot move is reported and left alone; the rest of the pass still runs", async () => {
  const f = fixture();
  const stuck = await newDraft(f, { body: "stuck words" });
  const other = await store.createDraft(f.db, {
    conversationKind: "contact",
    conversationId: 8,
    body: "other words",
    recipients: [{ contactId: 8, crowId: "crow:other", pubkey: "02" + "b".repeat(64) }],
  }, f.opts);
  await store.beginSend(f.db, stuck.draft.id, { body: "stuck words", expectVersion: 1 }, f.opts);
  await store.beginSend(f.db, other.draft.id, { body: "other words", expectVersion: 1 }, f.opts);

  // A table that refuses to write ONE row (a lock held by another writer) — the store must not throw
  // out of the whole pass, and the row it could not move must stay exactly as it was.
  const lines = [];
  const flaky = {
    execute: async (query) => {
      if (String(query.sql).includes("UPDATE message_drafts") && (query.args || []).includes(stuck.draft.id)) {
        throw new Error("database is locked");
      }
      return f.db.execute(query);
    },
  };
  const out = await store.sweepStuckSends(flaky, {
    ...f.opts,
    olderThanMs: 0,
    now: Date.now() + 10 * 60_000,
    log: (m) => lines.push(m),
  });
  assert.equal(out.reopened, 1, "the other row was swept in the same pass");
  assert.equal((await store.getDraft(f.db, other.draft.id)).state, "open");
  assert.equal((await store.getDraft(f.db, stuck.draft.id)).state, "sending",
    "the row that could not be written is untouched, not half-moved");
  assert.match(lines.join("\n"), /not swept/, "and the failure was reported, not swallowed");
  assert.match(lines.join("\n"), /locked/, "with the reason");
  assert.doesNotMatch(lines.join("\n"), /stuck words/, "never with the message text");
});

test("every write pokes message-drafts:changed with ids only", async () => {
  const f = fixture();
  const seen = [];
  bus.on(store.DRAFT_CHANGED_EVENT, (payload) => seen.push(payload));

  const { draft } = await newDraft(f, { body: "secret words" });
  await store.updateBody(f.db, draft.id, { body: "secret words again", expectVersion: 1 }, f.opts);
  await store.discardDraft(f.db, draft.id, {}, f.opts);
  const second = await newDraft(f, { body: "a new one" });
  await store.beginSend(f.db, second.draft.id, { body: "a new one", expectVersion: 1 }, f.opts);
  await store.markSent(f.db, second.draft.id, {}, f.opts);

  assert.deepEqual(seen.map((p) => p.action), ["create", "edit", "discard", "create", "send", "send"]);
  for (const payload of seen) {
    assert.match(payload.draftId, store.MESSAGE_DRAFT_ID_RE);
    assert.equal(payload.conversationKind, "contact");
    assert.equal(payload.conversationId, 7);
    assert.deepEqual(Object.keys(payload).sort(),
      ["action", "conversationId", "conversationKind", "draftId"],
      "the payload is ids and the action word, nothing else");
  }
  assert.doesNotMatch(JSON.stringify(seen), /secret words/, "no message text rides the live channel");
});

test("a store refusal is a DraftError naming a field, never a value", async () => {
  const f = fixture();
  await assert.rejects(() => store.createDraft(f.db, {
    conversationKind: "carrier-pigeon", conversationId: 7, body: "", recipients: RECIPIENTS,
  }, f.opts), (err) => err.code === "BAD_INPUT" && err.detail === "conversationKind");
  await assert.rejects(() => newDraft(f, { recipients: [] }), (err) => err.code === "BAD_INPUT");
  await assert.rejects(() => newDraft(f, { origin: "ghost" }), (err) => err.code === "BAD_INPUT" && err.detail === "origin");
  await assert.rejects(
    () => store.beginSend(f.db, "msgd-0123456789abcdef", { body: "x", expectVersion: 1 }, f.opts),
    (err) => err.code === "NOT_FOUND",
  );
  assert.equal(await store.getDraft(f.db, "not-an-id"), null);

  // No keychain key, no seal: the create refuses rather than writing an unsealable row.
  await assert.rejects(
    () => store.createDraft(f.db, { ...CONVERSATION, body: "x", recipients: RECIPIENTS }, { loadSeed: async () => null }),
    (err) => err.code === "SEAL_UNAVAILABLE",
  );
  assert.equal((await store.listDrafts(f.db, CONVERSATION)).length, 0);
});
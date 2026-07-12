// tests/crow-accept-bot-invite.test.js
//
// F5 (spec `2026-07-12-advertised-contact-prune-design.md` §3 F5, §5 test 2):
// ONE shared `acceptBotInvite()`; the classification (`origin`, `is_bot`,
// `advertised_by_instance_id`) is carried by the INSERT itself, in one place,
// and the row reaches the wire already classified. D1 was the opposite: the tool
// inserted an unclassified row, emitted it, and the *caller* stamped the
// classification afterwards — the contacts panel with a SECOND emit, the messages
// panel with NO emit at all. Peers got `origin=NULL` and whether they ever learned
// otherwise depended on which panel the user happened to click.
//
// A REAL schema is mandatory: the feature lives in columns
// (`advertised_by_instance_id`, `lamport_ts`) a hand-rolled `contacts` cannot express.
// NEVER point this file at ~/.crow — this code path INSERTs and DELETEs contacts.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createDbClient } from "../servers/db.js";
import {
  buildBotAcceptPayload,
} from "../servers/sharing/tools/contacts.js";
import { acceptBotInvite } from "../servers/sharing/accept-bot-invite.js";
import { deriveBotIdentity, generateBotInviteCode, parseBotInviteCode } from "../servers/sharing/identity.js";
import { __setEmitSinkForTest } from "../servers/sharing/contact-sync.js";
import { _setFetchImpl, _resetCache } from "../servers/gateway/dashboard/advertised-bots-cache.js";
import { handleContactAction } from "../servers/gateway/dashboard/panels/contacts/api-handlers.js";
import { handlePostAction } from "../servers/gateway/dashboard/panels/messages/api-handlers.js";

test("buildBotAcceptPayload carries the token + the accepter's identity, typed crow_social/bot_invite_accept", () => {
  const identity = {
    crowId: "crow:me0000000",
    ed25519Pubkey: "ed".repeat(16),
    secp256k1Pubkey: "ab".repeat(33),
  };
  const out = JSON.parse(buildBotAcceptPayload("the-token", identity, "Kevin"));
  assert.equal(out.type, "crow_social");
  assert.equal(out.subtype, "bot_invite_accept");
  assert.equal(out.token, "the-token");
  assert.equal(out.sender.crow_id, "crow:me0000000");
  assert.equal(out.sender.ed25519_pubkey, identity.ed25519Pubkey);
  assert.equal(out.sender.secp256k1_pubkey, identity.secp256k1Pubkey);
  assert.equal(out.sender.display_name, "Kevin");
});

// A stub sharing-client factory that records callTool invocations and NEVER
// spins up the real in-memory sharing server (which would open live Nostr relay
// sockets + Hyperswarm and keep node:test alive forever). Injected via the
// handlePostAction `sharingClientFactory` param.
function makeStubSharingFactory() {
  const toolCalls = [];
  const factory = async () => ({
    callTool: async (args) => { toolCalls.push(args); return { content: [{ type: "text", text: "" }] }; },
    close: async () => {},
  });
  factory.toolCalls = toolCalls;
  return factory;
}

test("messages handlePostAction routes accept_bot_invite to the sharing tool and redirects", async () => {
  // The PASTE form keeps its MCP round-trip (it has no advertiser ⇒ NULL provenance).
  const sharingClientFactory = makeStubSharingFactory();
  const calls = [];
  const req = { body: { action: "accept_bot_invite", invite_code: "crow:x.y.z" } };
  const res = { redirectAfterPost: (u) => { calls.push(u); res.headersSent = true; } };
  await handlePostAction(req, res, { db: { execute: async () => ({ rows: [] }) }, sharingClientFactory });
  assert.equal(calls[0], "/dashboard/messages", "redirects back to messages");
  assert.equal(sharingClientFactory.toolCalls[0]?.name, "crow_accept_bot_invite", "routes to the bot-invite tool via the injected factory");
});

test("messages handlePostAction send_peer honors the injected sharingClientFactory (no real runtime)", async () => {
  // Regression guard: the send_peer branch used to call getSharingClient()
  // directly, ignoring the injectable factory and starting the real sharing
  // runtime (live relay sockets). Prove the injected stub is the one used.
  const sharingClientFactory = makeStubSharingFactory();
  const calls = [];
  const req = { body: { action: "send_peer", contact_id: "7", message: "hello there" } };
  const res = { redirectAfterPost: (u) => { calls.push(u); res.headersSent = true; } };
  const db = { execute: async () => ({ rows: [{ display_name: "Alice", crow_id: "crow:alice0001" }] }) };
  await handlePostAction(req, res, { db, sharingClientFactory });
  assert.equal(calls[0], "/dashboard/messages", "redirects back to messages");
  const sent = sharingClientFactory.toolCalls[0];
  assert.equal(sent?.name, "crow_send_message", "send_peer went through the injected factory");
  assert.equal(sent?.arguments?.contact, "Alice");
  assert.equal(sent?.arguments?.message, "hello there");
});

// ── F5: the shared accept + server-side provenance ───────────────────────────

const tmpDir = mkdtempSync(join(tmpdir(), "crow-acceptbot-test-"));
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: tmpDir },
  stdio: "pipe",
});
const DB_PATH = join(tmpDir, "crow.db");
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const LOCAL_ID = "inst-local-f5";
const ADV = "inst-advertiser-f5";

// getOrCreateLocalInstanceId() reads $CROW_DATA_DIR/instance-id at call time.
// Pin both so the directory read resolves LOCAL_ID and never touches ~/.crow.
writeFileSync(join(tmpDir, "instance-id"), LOCAL_ID);
process.env.CROW_DATA_DIR = tmpDir;

const db = createDbClient(DB_PATH);

const BOT = deriveBotIdentity(randomBytes(32), "f5-bot");
const CODE = generateBotInviteCode(BOT, "tok-f5", [], "F5 Bot");
const BOT_CROW_ID = parseBotInviteCode(CODE).botCrowId;
/** trailing-64 lowercase x-only key — the shape getBotDirectory's `pubkeys` Sets hold. */
const BOT_X = String(BOT.secp256k1Pubkey).slice(-64).toLowerCase();

const STALE_PK = "f".repeat(64); // a prunable contact's key; never advertised

/** Stand up a fake advertised directory: ADV serves `bots`, everyone else is unreachable. */
function advertise(bots) {
  _resetCache();
  _setFetchImpl(async (_db, instanceId) =>
    instanceId === ADV
      ? { ok: true, body: { bots, complete: true } }
      : { ok: false, error: "not_paired" });
}

const BOT_ENTRY = {
  bot_id: "f5-bot",
  display_name: "F5 Bot",
  messaging_pubkey: BOT.secp256k1Pubkey, // 02/03-prefixed; the cache normalizes
  invite_code: CODE,
};

async function seedAdvertiser() {
  await db.execute({
    sql: "INSERT INTO crow_instances (id, name, crow_id, trusted, status, is_home) VALUES (?,?,?,1,'active',0)",
    args: [ADV, "Advertiser", "crow:adv0000001"],
  });
}

/** A zero-message contact whose advertiser is ADV and whose key ADV does NOT advertise ⇒ prunable. */
async function seedPrunableContact() {
  await db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey,
                                lamport_ts, origin, is_bot, advertised_by_instance_id)
          VALUES ('crow:stalebot1', 'Stale Bot', 'ed01', ?, 100, 'advertised', 1, ?)`,
    args: ["02" + STALE_PK, ADV],
  });
}

function fakeRes() {
  return { headersSent: false, _redir: null, redirectAfterPost(u) { this.headersSent = true; this._redir = u; return this; } };
}

async function contactRow(crowId) {
  const { rows } = await db.execute({
    sql: "SELECT origin, is_bot, advertised_by_instance_id FROM contacts WHERE crow_id = ?",
    args: [crowId],
  });
  return rows[0] || null;
}

beforeEach(async () => {
  await db.execute("DELETE FROM messages");
  await db.execute("DELETE FROM contacts");
  await db.execute("DELETE FROM contact_tombstones");
  await db.execute("DELETE FROM crow_instances");
  _resetCache();
  _setFetchImpl(null);
  __setEmitSinkForTest(null);
});

/** Capture every emitContactChange. The sink REPLACES the SyncManager, so it sees the RAW row. */
function captureEmits() {
  const emits = [];
  __setEmitSinkForTest({ emitChange: async (table, op, row) => { emits.push({ table, op, row }); return 1; } });
  return emits;
}

// ── §5 test 2, first half: the panel directory add ───────────────────────────

test("F5: contacts-panel directory add emits EXACTLY ONE insert carrying is_bot + advertised_by_instance_id", async () => {
  await seedAdvertiser();
  advertise([BOT_ENTRY]);
  const emits = captureEmits();
  try {
    const out = await handleContactAction(
      { body: { action: "dir_add_bot", invite_code: CODE } },
      db,
      { managers: {} },
    );
    assert.equal(out.redirect, "/dashboard/contacts?view=bots");

    // THE assertion. The old contacts panel fired TWO emits (insert, then update);
    // the old messages panel fired one then nothing. Both are bugs this replaces.
    assert.equal(emits.length, 1, "exactly one emit — not the old insert-then-update pair");
    assert.equal(emits[0].table, "contacts");
    assert.equal(emits[0].op, "insert", "insert is load-bearing: it is the only op that passes a peer's tombstone gate");
    assert.equal(Number(emits[0].row.is_bot), 1, "the emitted payload is already classified as a bot");
    assert.equal(emits[0].row.advertised_by_instance_id, ADV, "the FACT of who advertised it rides the wire");
    // NOTE on `origin`: this sink stands in for the SyncManager, so it sees the RAW
    // row — which does still carry origin. The wire strip happens INSIDE
    // SyncManager.emitChange (EXCLUDED_COLUMNS.contacts, F3) and is locked down by
    // tests/contacts-origin-wire.test.js. Asserting its absence HERE would be
    // asserting a falsehood about this seam.

    const row = await contactRow(BOT_CROW_ID);
    assert.equal(row.origin, "advertised", "local row classified at INSERT, not by a follow-up UPDATE");
    assert.equal(Number(row.is_bot), 1);
    assert.equal(row.advertised_by_instance_id, ADV);
  } finally { __setEmitSinkForTest(null); }
});

test("F5: messages-panel dir_message_bot emits exactly one classified insert and opens the conversation", async () => {
  await seedAdvertiser();
  advertise([BOT_ENTRY]);
  const emits = captureEmits();
  try {
    const res = fakeRes();
    await handlePostAction(
      { body: { action: "dir_message_bot", invite_code: CODE } },
      res,
      { db, _managers: {} },
    );
    assert.equal(emits.length, 1, "exactly one emit — the messages panel used to emit NOTHING here");
    assert.equal(emits[0].op, "insert");
    assert.equal(emits[0].row.advertised_by_instance_id, ADV);
    const { rows } = await db.execute({ sql: "SELECT id FROM contacts WHERE crow_id = ?", args: [BOT_CROW_ID] });
    assert.equal(res._redir, `/dashboard/messages?open=${rows[0].id}`, "still lands inside the new conversation");
  } finally { __setEmitSinkForTest(null); }
});

// ── §5 test 2, second half: the MCP / paste path is BYTE-IDENTICAL to today ──

test("F5: the MCP/paste path (no advertiser) still emits its own insert, and the row is NULL-provenance", async () => {
  const emits = captureEmits();
  try {
    // The tool is a thin wrapper over exactly this call — no advertisedByInstanceId.
    const r = await acceptBotInvite(db, {}, { inviteCode: CODE });
    assert.equal(r.outcome, "created");
    assert.equal(r.botCrowId, BOT_CROW_ID);
    assert.equal(r.notified, false, "no nostrManager ⇒ 'added, but could not reach the bot' — NOT a failed accept");
    assert.equal(r.ok, true, "the contact is still added");

    // Emit-coverage regression guard: the refactor must not lose the tool's emit.
    assert.equal(emits.length, 1, "the tool path still emits");
    assert.equal(emits[0].op, "insert");

    const row = await contactRow(BOT_CROW_ID);
    assert.equal(row.origin, null, "pasted invite ⇒ no judgment");
    assert.equal(Number(row.is_bot), 0);
    assert.equal(row.advertised_by_instance_id, null, "NULL provenance ⇒ structurally NEVER prunable");
  } finally { __setEmitSinkForTest(null); }
});

// ── §5 test 3: provenance is resolved server-side, never taken from the form ──

test("F5: a forged advertised_by in the POST body is IGNORED — provenance comes from the directory", async () => {
  await seedAdvertiser();
  advertise([BOT_ENTRY]);
  await handleContactAction(
    {
      body: {
        action: "dir_add_bot",
        invite_code: CODE,
        advertised_by: "inst-attacker",
        advertised_by_instance_id: "inst-attacker",
      },
    },
    db,
    { managers: {} },
  );
  const row = await contactRow(BOT_CROW_ID);
  assert.equal(row.advertised_by_instance_id, ADV, "the directory is authoritative; the form is not");
});

test("F5: with NO resolvable advertiser, a forged body field still cannot stamp the row prunable", async () => {
  // No trusted peers at all ⇒ nothing to resolve against.
  await handlePostAction(
    { body: { action: "dir_add_bot", invite_code: CODE, advertised_by_instance_id: "inst-attacker" } },
    fakeRes(),
    { db, _managers: {} },
  );
  const row = await contactRow(BOT_CROW_ID);
  assert.equal(row.advertised_by_instance_id, null, "unspoofable: NULL, never the attacker's value");
});

// ── §5 test 4 (R3-MAJOR-6): the ADD path performs ZERO deletes ────────────────

test("F5/R3-MAJOR-6: adding a bot from the directory DELETES NOTHING — a prunable contact survives", async () => {
  await seedAdvertiser();
  await seedPrunableContact(); // advertised_by=ADV, zero messages, key NOT in ADV's list ⇒ prunable
  advertise([BOT_ENTRY]);      // ADV answers ok+complete and does NOT advertise STALE_PK

  await handleContactAction(
    { body: { action: "dir_add_bot", invite_code: CODE } },
    db,
    { managers: {} },
  );

  const stale = await contactRow("crow:stalebot1");
  assert.ok(stale, "clicking Add must never garbage-collect: getBotDirectory prunes as a SIDE EFFECT when asked to, so the add path MUST read it with {prune:false}");
  const { rows: tombs } = await db.execute("SELECT COUNT(*) AS n FROM contact_tombstones");
  assert.equal(Number(tombs[0].n), 0, "and it must not tombstone anything either");
  assert.ok(await contactRow(BOT_CROW_ID), "the bot the user actually clicked IS added");
});

// ── §5 test 5: unresolvable advertiser ⇒ NULL provenance (fail-safe) ──────────

test("F5: an unresolvable advertiser (peer unreachable) yields NULL provenance, and the contact is STILL added", async () => {
  await seedAdvertiser();
  _resetCache();
  _setFetchImpl(async () => ({ ok: false, error: "timeout" })); // directory unreachable

  const emits = captureEmits();
  try {
    await handleContactAction(
      { body: { action: "dir_add_bot", invite_code: CODE } },
      db,
      { managers: {} },
    );
    const row = await contactRow(BOT_CROW_ID);
    assert.ok(row, "the add succeeds — a directory outage must not block the user");
    assert.equal(row.advertised_by_instance_id, null, "un-prunable is the FAIL-SAFE direction");
    assert.equal(emits.length, 1, "still exactly one insert emit");
  } finally { __setEmitSinkForTest(null); }
});

// ── The already-a-contact branch is unchanged: reuse the row, no second emit ──

test("F5: re-adding an existing bot reuses the row and emits NOTHING", async () => {
  await seedAdvertiser();
  advertise([BOT_ENTRY]);
  await handleContactAction({ body: { action: "dir_add_bot", invite_code: CODE } }, db, { managers: {} });

  const emits = captureEmits();
  try {
    await handleContactAction({ body: { action: "dir_add_bot", invite_code: CODE } }, db, { managers: {} });
    assert.equal(emits.length, 0, "no emit on the already-a-contact branch");
    const { rows } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM contacts WHERE crow_id = ?", args: [BOT_CROW_ID] });
    assert.equal(Number(rows[0].n), 1, "idempotent on crow_id");
  } finally { __setEmitSinkForTest(null); }
});

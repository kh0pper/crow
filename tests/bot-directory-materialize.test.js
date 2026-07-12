// tests/bot-directory-materialize.test.js
//
// The messages panel's DIRECTORY actions (dir_add_bot / dir_message_bot): routing and
// redirects. F5 moved the materialize itself off the MCP client and onto the shared
// `acceptBotInvite` — so what this file guards is that the handler calls the SHARED
// accept (never the tool), and that dir_message_bot still lands inside the conversation.
//
// The classification the accept performs (origin/is_bot/advertised_by_instance_id, and
// the single "insert" emit) is asserted end-to-end against a REAL schema in
// tests/crow-accept-bot-invite.test.js — it cannot be expressed on the hand-rolled
// contacts table here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveBotIdentity, generateBotInviteCode, parseBotInviteCode } from "../servers/sharing/identity.js";
import { handlePostAction } from "../servers/gateway/dashboard/panels/messages/api-handlers.js";

// The directory read resolves the local instance id from $CROW_DATA_DIR. Pin it to a
// throwaway dir so this test can NEVER read or write ~/.crow.
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-dirmat-test-"));

const SEED = randomBytes(32);
const BOT_ID = "dir-bot-1";
const ident = deriveBotIdentity(SEED, BOT_ID);
const CODE = generateBotInviteCode(ident, "tok-1", [], "Dir Bot");
const CROW_ID = parseBotInviteCode(CODE).botCrowId;

function fakeRes() { return { headersSent: false, _redir: null, redirectAfterPost(u){ this.headersSent = true; this._redir = u; return this; } }; }
async function db0() {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE contacts (id INTEGER PRIMARY KEY, crow_id TEXT, secp256k1_pubkey TEXT, origin TEXT, is_bot INTEGER DEFAULT 0)`);
  return db;
}

/** Stand-in for the shared accept: records the call and materializes the row like the real one. */
function spyAccept(db, calls) {
  return async (_db, _managers, opts) => {
    calls.push(opts);
    await db.execute({
      sql: "INSERT INTO contacts (crow_id, secp256k1_pubkey, origin, is_bot) VALUES (?,?,?,?)",
      args: [CROW_ID, ident.secp256k1Pubkey, opts.advertisedByInstanceId ? "advertised" : null, opts.advertisedByInstanceId ? 1 : 0],
    });
    return { ok: true, outcome: "created", botCrowId: CROW_ID, notified: true };
  };
}

/** Any MCP callTool from the directory path is a regression — F5 removed that round-trip. */
function forbiddenClientFactory(toolCalls) {
  return async () => ({ async callTool(a){ toolCalls.push(a.name); return { content: [] }; }, async close(){} });
}

test("dir_add_bot materializes via the SHARED acceptBotInvite, not the MCP tool", async () => {
  const db = await db0(); const accepts = []; const toolCalls = [];
  const req = { body: { action: "dir_add_bot", invite_code: CODE } };
  const res = fakeRes();
  await handlePostAction(req, res, {
    db, _managers: {},
    sharingClientFactory: forbiddenClientFactory(toolCalls),
    acceptBotInviteFn: spyAccept(db, accepts),
  });
  assert.equal(res.headersSent, true);
  assert.deepEqual(toolCalls, [], "the directory path makes NO MCP round-trip (D1: that is where the double/absent emit came from)");
  assert.equal(accepts.length, 1, "exactly one accept");
  assert.equal(accepts[0].inviteCode, CODE);
  const { rows } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM contacts WHERE crow_id=?", args: [CROW_ID] });
  assert.equal(Number(rows[0].n), 1, "contact materialized");
});

test("dir_message_bot materializes and redirects to ?open=<id>", async () => {
  const db = await db0(); const accepts = [];
  const req = { body: { action: "dir_message_bot", invite_code: CODE } };
  const res = fakeRes();
  await handlePostAction(req, res, { db, _managers: {}, acceptBotInviteFn: spyAccept(db, accepts) });
  assert.equal(accepts.length, 1, "accept only; no forced message");
  const { rows } = await db.execute({ sql: "SELECT id FROM contacts WHERE crow_id=?", args: [CROW_ID] });
  assert.equal(res._redir, `/dashboard/messages?open=${rows[0].id}`, "redirects to the new conversation");
});

// R5/MAJOR-3: bot-ness and prunability are DIFFERENT facts.
//
// Deriving `is_bot` from provenance conflates them. The advertised-bots cache expires
// after 60 s and any peer can exceed the 2 s directory timeout, so
// `resolveAdvertisedByInstanceId` legitimately returns null between the render and the
// click — and the user who clicked a BOT in the BOT DIRECTORY then gets `is_bot=0`: not
// badged as a bot, AND swept into `backfillContactsOnce` (which filters `is_bot = 0`) to
// be re-emitted as an `update` every boot. A directory add is a bot whether or not we
// could resolve WHO advertised it, so the handlers assert it EXPLICITLY. (Both actions:
// they are the same code path, and both must carry it.)
for (const action of ["dir_add_bot", "dir_message_bot"]) {
  test(`${action} passes isBot:true EXPLICITLY — an unresolvable advertiser costs prunability, never bot-ness`, async () => {
    const db = await db0(); const accepts = [];
    const req = { body: { action, invite_code: CODE } };
    await handlePostAction(req, fakeRes(), { db, _managers: {}, acceptBotInviteFn: spyAccept(db, accepts) });
    assert.equal(accepts.length, 1, "exactly one accept");
    assert.equal(accepts[0].advertisedByInstanceId ?? null, null,
      "setup: the advertiser is unresolvable here (no directory) — the 60 s-cache / 2 s-timeout case");
    assert.equal(accepts[0].isBot, true,
      "…and the accept is STILL told this is a bot. Otherwise the row lands is_bot=0: unbadged in the UI " +
      "and re-emitted as an `update` by backfillContactsOnce on every boot.");
  });
}

test("dir_add_bot on a failed accept does not materialize anything", async () => {
  const db = await db0();
  const req = { body: { action: "dir_add_bot", invite_code: CODE } };
  const res = fakeRes();
  await handlePostAction(req, res, {
    db, _managers: {},
    acceptBotInviteFn: async () => { throw new Error("bad invite"); },
  });
  assert.equal(res.headersSent, true, "still redirects — a failed add must not 500 the panel");
  const { rows } = await db.execute("SELECT COUNT(*) AS n FROM contacts");
  assert.equal(Number(rows[0].n), 0, "nothing materialized");
});

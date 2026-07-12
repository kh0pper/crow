// tests/bot-directory-contacts-surface.test.js
//
// The contacts panel's directory action (dir_add_bot): routing + redirect. F5 moved the
// materialize off the MCP client onto the shared `acceptBotInvite`, which also killed
// this panel's SECOND emit (it used to fire "insert" from inside the tool and then
// "update" after stamping origin/is_bot — D1). The classification + the exactly-one-emit
// guarantee are asserted against a REAL schema in tests/crow-accept-bot-invite.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveBotIdentity, generateBotInviteCode, parseBotInviteCode } from "../servers/sharing/identity.js";
import { handleContactAction } from "../servers/gateway/dashboard/panels/contacts/api-handlers.js";

// The directory read resolves the local instance id from $CROW_DATA_DIR. Pin it to a
// throwaway dir so this test can NEVER read or write ~/.crow.
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-dirsurf-test-"));

const ident = deriveBotIdentity(randomBytes(32), "c-dir-bot");
const CODE = generateBotInviteCode(ident, "tok", [], "Dir Bot");
const CROW_ID = parseBotInviteCode(CODE).botCrowId;

test("contacts dir_add_bot materializes via the SHARED acceptBotInvite, not the MCP tool", async () => {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE contacts (id INTEGER PRIMARY KEY, crow_id TEXT, secp256k1_pubkey TEXT, origin TEXT, is_bot INTEGER DEFAULT 0)`);
  const toolCalls = [];
  const accepts = [];
  const result = await handleContactAction(
    { body: { action: "dir_add_bot", invite_code: CODE } },
    db,
    {
      managers: {},
      // Any callTool from the directory path is a regression — F5 removed that round-trip.
      sharingClientFactory: async () => ({ async callTool(a){ toolCalls.push(a.name); return { content: [] }; }, async close(){} }),
      acceptBotInviteFn: async (_db, _mgr, opts) => {
        accepts.push(opts);
        await db.execute({
          sql: "INSERT INTO contacts (crow_id, secp256k1_pubkey, origin, is_bot) VALUES (?,?,?,?)",
          args: [CROW_ID, ident.secp256k1Pubkey, opts.advertisedByInstanceId ? "advertised" : null, opts.advertisedByInstanceId ? 1 : 0],
        });
        return { ok: true, outcome: "created", botCrowId: CROW_ID, notified: true };
      },
    },
  );
  assert.equal(result.redirect, "/dashboard/contacts?view=bots");
  assert.deepEqual(toolCalls, [], "no MCP round-trip on the directory path");
  assert.equal(accepts.length, 1, "exactly one accept");
  assert.equal(accepts[0].inviteCode, CODE);
  const { rows } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM contacts WHERE crow_id=?", args: [CROW_ID] });
  assert.equal(Number(rows[0].n), 1, "contact materialized");
});

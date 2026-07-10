import { test } from "node:test";
import assert from "node:assert";
import { handlePostAction } from "../servers/gateway/dashboard/panels/messages/api-handlers.js";

function fakeRes() {
  return { _r: null, headersSent: false, redirectAfterPost(p) { this._r = p; this.headersSent = true; return true; } };
}
// A stub db: accept-success path looks the contact row up by crow_id.
function fakeDb(rowsByCrowId = {}) {
  return {
    async execute(q) {
      const sql = typeof q === "string" ? q : q.sql;
      if (/SELECT id FROM contacts WHERE crow_id/.test(sql)) {
        const crowId = q.args[0];
        return { rows: rowsByCrowId[crowId] ? [{ id: rowsByCrowId[crowId] }] : [] };
      }
      return { rows: [] };
    },
  };
}
const okAccept = (text) => async () => ({
  callTool: async () => ({ content: [{ type: "text", text }] }),
  close: async () => {},
});

test("accept_invite success redirects into the new conversation (F-UI-3)", async () => {
  const res = fakeRes();
  const req = {
    method: "POST",
    body: { action: "accept_invite", invite_code: "crow:abcdefghij.payload.sig" },
  };
  const db = fakeDb({ "crow:abcdefghij": 42 });
  await handlePostAction(req, res, { db, sharingClientFactory: okAccept("Connected to crow:abcdefghij!\nCrow ID: crow:abcdefghij") });
  assert.match(res._r, /^\/dashboard\/messages\?connected=1&open=42$/);
});

test("accept_invite success without a resolvable contact still signals success", async () => {
  const res = fakeRes();
  const req = { method: "POST", body: { action: "accept_invite", invite_code: "crow:abcdefghij.p.s" } };
  await handlePostAction(req, res, { db: fakeDb({}), sharingClientFactory: okAccept("Connected!") });
  assert.match(res._r, /^\/dashboard\/messages\?connected=1$/);
});

test("accept_short_invite success resolves the contact from the tool text", async () => {
  const res = fakeRes();
  const req = { method: "POST", body: { action: "accept_short_invite", short_code: "K7Q4-M2X9-3FHT" } };
  const db = fakeDb({ "crow:qrstuvwxyz": 7 });
  await handlePostAction(req, res, { db, sharingClientFactory: okAccept("Connected to crow:qrstuvwxyz!\nCrow ID: crow:qrstuvwxyz\nSafety Number: 1") });
  assert.match(res._r, /^\/dashboard\/messages\?connected=1&open=7$/);
});

test("accept_invite ERROR path still re-renders (returns false, no redirect)", async () => {
  const res = fakeRes();
  const req = { method: "POST", body: { action: "accept_invite", invite_code: "crow:abcdefghij.p.s" } };
  const errFactory = async () => ({
    callTool: async () => ({ isError: true, content: [{ type: "text", text: "expired" }] }),
    close: async () => {},
  });
  const handled = await handlePostAction(req, res, { db: fakeDb({}), sharingClientFactory: errFactory });
  assert.equal(handled, false);
  assert.equal(res._r, null);
  assert.match(req._inviteError, /expired/);
});

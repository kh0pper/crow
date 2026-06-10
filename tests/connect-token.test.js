import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateLocalToken, revokeLocalToken, getLocalTokenMeta,
  validateLocalToken, LOCAL_TOKEN_KEYS,
} from "../servers/gateway/local-token.js";
import { isSyncable } from "../servers/gateway/dashboard/settings/registry.js";

// In-memory db stub matching the exact SQL the settings registry emits for
// local-scoped reads/writes (readSetting / writeSetting{scope:"local"} /
// deleteLocalSetting). instance_id (args[1] on writes/reads) is irrelevant
// here: the test process is a single logical instance.
function memDb() {
  const overrides = new Map();
  const globals = new Map();
  return {
    async execute({ sql, args }) {
      const s = sql.replace(/\s+/g, " ").trim();
      if (s.startsWith("INSERT INTO dashboard_settings_overrides")) {
        overrides.set(args[0], args[2]); return { rows: [] };
      }
      if (s.startsWith("SELECT value FROM dashboard_settings_overrides")) {
        const v = overrides.get(args[0]);
        return { rows: v === undefined ? [] : [{ value: v }] };
      }
      if (s.startsWith("SELECT value FROM dashboard_settings WHERE")) {
        const v = globals.get(args[0]);
        return { rows: v === undefined ? [] : [{ value: v }] };
      }
      if (s.startsWith("DELETE FROM dashboard_settings_overrides")) {
        overrides.delete(args[0]); return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

test("no token configured: meta empty, validate false", async () => {
  const db = memDb();
  assert.deepEqual(await getLocalTokenMeta(db), { present: false, createdAt: null });
  assert.equal(await validateLocalToken(db, "anything"), false);
  assert.equal(await validateLocalToken(db, ""), false);
});

test("generate returns a raw token, stores hash, validates", async () => {
  const db = memDb();
  const token = await generateLocalToken(db);
  assert.match(token, /^[0-9a-f]{64}$/, "32-byte hex token");
  const meta = await getLocalTokenMeta(db);
  assert.equal(meta.present, true);
  assert.ok(meta.createdAt, "records a created timestamp");
  assert.equal(await validateLocalToken(db, token), true, "the issued token validates");
  // "x" is never a valid hex digit, so this is guaranteed != the real token
  // (replacing the last char with a digit could collide when it already matches).
  assert.equal(await validateLocalToken(db, token.slice(0, -1) + "x"), false, "a tampered token fails");
});

test("rotate (generate again) invalidates the old token", async () => {
  const db = memDb();
  const first = await generateLocalToken(db);
  const second = await generateLocalToken(db);
  assert.notEqual(first, second);
  assert.equal(await validateLocalToken(db, first), false, "old token no longer valid");
  assert.equal(await validateLocalToken(db, second), true, "new token valid");
});

test("revoke clears the token", async () => {
  const db = memDb();
  const token = await generateLocalToken(db);
  await revokeLocalToken(db);
  assert.equal((await getLocalTokenMeta(db)).present, false);
  assert.equal(await validateLocalToken(db, token), false);
});

test("the token hash key is NOT syncable (per-instance, never replicated)", () => {
  assert.equal(isSyncable(LOCAL_TOKEN_KEYS.HASH_KEY), false);
  assert.equal(isSyncable(LOCAL_TOKEN_KEYS.CREATED_KEY), false);
});

import {
  localTokenAuthMiddleware, localOperatorAuth, applyLocalTokenAuth,
} from "../servers/gateway/local-token.js";

function run(mw, req) {
  return new Promise((resolve) => {
    mw(req, { status() { return this; }, json() {}, send() {} }, () => resolve(true));
  });
}

test("middleware sets req.localTokenAuth for a valid token on an MCP path", async () => {
  const db = memDb();
  const token = await generateLocalToken(db);
  const req = { path: "/router/mcp", headers: { authorization: `Bearer ${token}` } };
  await run(localTokenAuthMiddleware(db), req);
  assert.deepEqual(req.localTokenAuth, { token: "local-mcp" });
});

test("middleware skips the DB read on non-MCP paths (cost guard)", async () => {
  const db = memDb();
  await generateLocalToken(db);
  let reads = 0;
  const spyDb = { execute: (...a) => { reads++; return db.execute(...a); } };
  const req = { path: "/dashboard/nest", headers: { authorization: "Bearer whatever" } };
  await run(localTokenAuthMiddleware(spyDb), req);
  assert.equal(reads, 0, "no settings read for a non-MCP request");
  assert.equal(req.localTokenAuth, undefined);
});

test("middleware ignores a wrong token (falls through, no flag)", async () => {
  const db = memDb();
  await generateLocalToken(db);
  const req = { path: "/router/mcp", headers: { authorization: "Bearer not-the-token" } };
  await run(localTokenAuthMiddleware(db), req);
  assert.equal(req.localTokenAuth, undefined);
});

test("middleware yields to instance auth (does not run when req.instanceAuth set)", async () => {
  const db = memDb();
  const token = await generateLocalToken(db);
  const req = { path: "/router/mcp", headers: { authorization: `Bearer ${token}` }, instanceAuth: { instance: { id: "x" } } };
  await run(localTokenAuthMiddleware(db), req);
  assert.equal(req.localTokenAuth, undefined, "instance auth wins");
});

test("middleware no-ops without a Bearer header", async () => {
  const db = memDb();
  await generateLocalToken(db);
  const req = { path: "/router/mcp", headers: {} };
  const ok = await run(localTokenAuthMiddleware(db), req);
  assert.equal(ok, true);
  assert.equal(req.localTokenAuth, undefined);
});

test("localOperatorAuth() is a full-access mcp:tools credential", () => {
  const a = localOperatorAuth();
  assert.equal(a.clientId, "local-mcp");
  assert.deepEqual(a.scopes, ["mcp:tools"]);
  assert.ok(a.expiresAt > Math.floor(Date.now() / 1000), "expiry in the future");
});

test("applyLocalTokenAuth: synthesizes full auth ONLY when the flag is set, never touches a gate", () => {
  const yes = { localTokenAuth: { token: "local-mcp" } };
  assert.equal(applyLocalTokenAuth(yes), true);
  assert.equal(yes.auth.clientId, "local-mcp");
  assert.deepEqual(yes.auth.scopes, ["mcp:tools"]);

  const no = {};
  assert.equal(applyLocalTokenAuth(no), false, "no flag -> falls through to OAuth");
  assert.equal(no.auth, undefined, "does not fabricate auth without the flag");
});

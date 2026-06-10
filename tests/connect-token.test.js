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

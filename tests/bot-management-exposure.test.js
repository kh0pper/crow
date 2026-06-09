import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseManagedBots, getPeerManagedBots, botPeerManageable, remoteBotManagementEnabled,
  MANAGED_BOTS_SETTING_KEY, REMOTE_BOT_MGMT_FLAG,
} from "../servers/gateway/bot-management-exposure.js";

// db stub: returns settings values keyed by the setting key (args[0]).
// readSetting queries dashboard_settings_overrides first (args:[key,localId])
// then dashboard_settings (args:[key]). Return value on the global query only.
function dbWith(settings) {
  return {
    async execute({ sql, args }) {
      const key = args?.[0];
      if (/dashboard_settings_overrides/.test(sql)) return { rows: [] };
      const v = settings[key];
      return { rows: v === undefined ? [] : [{ value: v }] };
    },
  };
}

test("parseManagedBots: array of strings → Set; junk dropped", () => {
  const s = parseManagedBots(JSON.stringify(["a", "", null, 3, "b"]));
  assert.deepEqual([...s].sort(), ["a", "b"]);
});

test("parseManagedBots: absent/malformed/non-array → empty set", () => {
  assert.equal(parseManagedBots(null).size, 0);
  assert.equal(parseManagedBots("{bad").size, 0);
  assert.equal(parseManagedBots(JSON.stringify({ a: 1 })).size, 0);
});

test("master flag OFF → empty managed set (default-deny), even if list non-empty", async () => {
  const db = dbWith({
    feature_flags: JSON.stringify({ remote_bot_management: false }),
    remote_managed_bots: JSON.stringify(["scout"]),
  });
  assert.equal((await getPeerManagedBots(db)).size, 0);
  assert.equal(await botPeerManageable(db, "scout"), false);
});

test("absent master flag → default-deny", async () => {
  const db = dbWith({ remote_managed_bots: JSON.stringify(["scout"]) });
  assert.equal(await remoteBotManagementEnabled(db), false);
  assert.equal(await botPeerManageable(db, "scout"), false);
});

test("master ON + bot in list → manageable; other bot → not", async () => {
  const db = dbWith({
    feature_flags: JSON.stringify({ remote_bot_management: true }),
    remote_managed_bots: JSON.stringify(["scout", "filer"]),
  });
  assert.equal(await remoteBotManagementEnabled(db), true);
  assert.deepEqual([...(await getPeerManagedBots(db))].sort(), ["filer", "scout"]);
  assert.equal(await botPeerManageable(db, "scout"), true);
  assert.equal(await botPeerManageable(db, "ghost"), false);
});

test("master ON + empty list → nothing manageable", async () => {
  const db = dbWith({ feature_flags: JSON.stringify({ remote_bot_management: true }) });
  assert.equal((await getPeerManagedBots(db)).size, 0);
  assert.equal(await botPeerManageable(db, "scout"), false);
});

test("non-string botId → false, never throws", async () => {
  const db = dbWith({ feature_flags: JSON.stringify({ remote_bot_management: true }), remote_managed_bots: JSON.stringify(["scout"]) });
  assert.equal(await botPeerManageable(db, null), false);
  assert.equal(await botPeerManageable(db, ""), false);
});

test("exposes setting key + flag name constants", () => {
  assert.equal(MANAGED_BOTS_SETTING_KEY, "remote_managed_bots");
  assert.equal(REMOTE_BOT_MGMT_FLAG, "remote_bot_management");
});

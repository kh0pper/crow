import { test } from "node:test";
import assert from "node:assert/strict";
import section from "../servers/gateway/dashboard/settings/sections/remote-bot-management.js";

test("getPreview reflects the flag", async () => {
  assert.equal(await section.getPreview({ settings: { feature_flags: JSON.stringify({ remote_bot_management: true }) } }), "enabled");
  assert.equal(await section.getPreview({ settings: { feature_flags: "{}" } }), "disabled");
});

test("handleAction returns true for its action, false for others", async () => {
  const db = {
    async execute({ sql }) {
      if (/dashboard_settings_overrides/.test(sql)) return { rows: [] };
      if (/SELECT value FROM dashboard_settings/.test(sql)) return { rows: [{ value: JSON.stringify({ smart_chat: true }) }] };
      return { rows: [] };
    },
  };
  const res = { redirectAfterPost() {} };
  assert.equal(await section.handleAction({ req: { body: { enabled: "on" } }, res, db, action: "set_remote_bot_management" }), true);
  assert.equal(await section.handleAction({ req: { body: {} }, res: {}, db: {}, action: "something_else" }), false);
});

test("section metadata", () => {
  assert.equal(section.id, "remote-bot-management");
  assert.equal(section.group, "multiInstance");
});

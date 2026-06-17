import { test } from "node:test";
import assert from "node:assert/strict";
import { translations } from "../servers/gateway/dashboard/shared/i18n.js";

test("all new room i18n keys exist in EN and ES", () => {
  const keys = ["messages.newGroup", "messages.newGroupDesc", "messages.groupName", "messages.groupMembers", "messages.createGroupBtn", "messages.roomMode", "messages.roomModeAddressed", "messages.roomModeAlways", "messages.roomMembers", "messages.roomRename", "messages.roomDelete", "messages.roomAddMember", "messages.roomAddBotPrompt", "messages.roomLeaveHint"];
  for (const k of keys) {
    assert.ok(translations[k], "missing key " + k);
    assert.ok(translations[k].en && translations[k].es, "missing en/es for " + k);
  }
});

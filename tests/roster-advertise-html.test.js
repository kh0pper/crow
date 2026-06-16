// tests/roster-advertise-html.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessagesHTML } from "../servers/gateway/dashboard/panels/messages/html.js";

test("advertised bots render a section with a materialize form", () => {
  const html = buildMessagesHTML({
    items: [], totalUnread: 0, aiConfigured: false, storageAvailable: false,
    inviteResult: null, inviteError: null, lang: "en", botInvite: null,
    csrf: '<input type="hidden" name="_csrf" value="tok">',
    advertisedBots: [{
      type: "advertised", botId: "b1", displayName: "Helper Bot",
      instanceId: "phone1", instanceLabel: "Phone", messagingPubkey: "a".repeat(64),
      inviteCode: "crow:abc.def.ghi",
    }],
  });
  assert.ok(html.includes("Helper Bot"), "bot name rendered");
  assert.ok(html.includes("Phone"), "instance label badge rendered");
  assert.ok(html.includes('value="message_advertised_bot"'), "materialize action present");
  assert.ok(html.includes("crow:abc.def.ghi"), "invite code embedded");
  assert.ok(html.includes('name="_csrf"'), "csrf present");
});

test("no advertised section when list is empty", () => {
  const html = buildMessagesHTML({
    items: [], totalUnread: 0, aiConfigured: false, storageAvailable: false,
    inviteResult: null, inviteError: null, lang: "en", botInvite: null,
    csrf: "", advertisedBots: [],
  });
  assert.ok(!html.includes("message_advertised_bot"), "no materialize form when empty");
});

// tests/bot-directory-messages-surface.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessagesHTML } from "../servers/gateway/dashboard/panels/messages/html.js";

const BASE = {
  items: [], totalUnread: 0, aiConfigured: false, storageAvailable: false,
  inviteResult: null, inviteError: null, lang: "en", botInvite: null,
  csrf: '<input type="hidden" name="_csrf" value="tok">',
};

test("collapsed Browse entry shows the not-added count and opens the directory", () => {
  const html = buildMessagesHTML({ ...BASE, botDirectory: { groups: [{ instanceId:"p", instanceLabel:"Phone", bots:[{botId:"b1",displayName:"Helper",inviteCode:"crow:a.b.c",added:false,contactId:null}] }], total: 1, notAddedCount: 1 } });
  assert.ok(/1/.test(html), "count rendered");
  assert.ok(html.includes("msgOpenBotDirectory") || html.includes("bot-dir-modal"), "wired to open the directory");
  assert.ok(html.includes('value="dir_message_bot"') || html.includes('value="dir_add_bot"'), "directory forms embedded");
});

test("Browse entry hidden when nothing is available", () => {
  const html = buildMessagesHTML({ ...BASE, botDirectory: { groups: [], total: 0, notAddedCount: 0 } });
  assert.ok(!html.includes("bots available on your other Crows"), "no browse entry at zero");
});

test("popover has a 'Message a Bot' item", () => {
  const html = buildMessagesHTML({ ...BASE, botDirectory: { groups: [], total: 0, notAddedCount: 0 } });
  assert.ok(html.includes("msgOpenBotDirectory"), "Message a Bot item wired");
});

// tests/bot-directory-render.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBotDirectory } from "../servers/gateway/dashboard/shared/bot-directory.js";

const GROUPS = [{
  instanceId: "phone", instanceLabel: "Phone", bots: [
    { botId: "b1", displayName: "Helper", description: "Schedules & reminders", inviteCode: "crow:a.b.c", added: false, contactId: null, instanceLabel: "Phone" },
    { botId: "b2", displayName: "Chef <x>", description: null, inviteCode: "crow:d.e.f", added: true, contactId: 7, instanceLabel: "Phone" },
  ],
}];
const CSRF = '<input type="hidden" name="_csrf" value="tok">';

test("messages context renders Add + Message for not-added, Added for added, with csrf + escaping", () => {
  const html = buildBotDirectory({ groups: GROUPS, context: "messages", csrf: CSRF, lang: "en" });
  assert.ok(html.includes("Phone"), "instance group header");
  assert.ok(html.includes("Schedules &amp; reminders"), "tagline escaped");
  assert.ok(html.includes("Chef &lt;x&gt;"), "display name escaped");
  assert.ok(html.includes('value="dir_add_bot"'), "Add action present");
  assert.ok(html.includes('value="dir_message_bot"'), "Message action present");
  assert.ok(html.includes('name="_csrf"'), "csrf present");
  assert.ok(/Added/.test(html), "added bot shows Added state");
  assert.ok(html.includes("?open=7") || html.includes('data-contact-id="7"'), "added → open chat by id");
  assert.ok(html.includes('data-bot-directory-search'), "search input present");
});

test("contacts context renders Add only (no Message)", () => {
  const html = buildBotDirectory({ groups: GROUPS, context: "contacts", csrf: CSRF, lang: "en" });
  assert.ok(html.includes('value="dir_add_bot"'), "Add present");
  assert.ok(!html.includes('value="dir_message_bot"'), "no Message in contacts context");
});

test("empty directory renders the resolved empty-state, no forms, no raw keys", () => {
  const html = buildBotDirectory({ groups: [], context: "messages", csrf: CSRF, lang: "en" });
  assert.ok(!html.includes("dir_add_bot"), "no add forms when empty");
  assert.ok(html.includes("No bots available"), "resolved empty-state string");
  assert.ok(!html.includes("botdir."), "no raw i18n key leaked");
});

test("es branch resolves the directory strings (t() falls back to en silently)", () => {
  const html = buildBotDirectory({ groups: GROUPS, context: "messages", csrf: CSRF, lang: "es" });
  assert.ok(html.includes("Agregar"), "es Add label resolved");
  assert.ok(html.includes("Buscar bots"), "es search placeholder resolved");
  assert.ok(!html.includes("botdir."), "no raw key leaked in es");
});

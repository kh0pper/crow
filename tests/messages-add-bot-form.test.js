// tests/messages-add-bot-form.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessagesHTML } from "../servers/gateway/dashboard/panels/messages/html.js";

const BASE = {
  items: [], totalUnread: 0, aiConfigured: false, storageAvailable: false,
  inviteResult: null, inviteError: null, lang: "en", botInvite: null,
  botDirectory: { groups: [], total: 0, notAddedCount: 0 }, csrf: '<input type="hidden" name="_csrf" value="tok">',
};

// Helper: isolate the markup of the invite-bot form (from its dialog id to the
// next closing </form>) so per-field assertions can't be satisfied by some
// OTHER form on the page.
function botForm(html) {
  const start = html.indexOf('id="invite-bot"');
  assert.notEqual(start, -1, "invite-bot dialog present");
  const end = html.indexOf("</form>", start);
  assert.notEqual(end, -1, "invite-bot form closes");
  return html.slice(start, end);
}

test("popover renders an 'Add a Bot' paste dialog posting accept_bot_invite", () => {
  const html = buildMessagesHTML({ ...BASE });
  const form = botForm(html);
  assert.ok(form.includes('value="accept_bot_invite"'), "accept_bot_invite action present");
  assert.ok(/name="invite_code"/.test(form), "invite_code field present");
  assert.ok(html.includes("msgShowInviteDialog('bot')"), "Add a Bot popover item wired to dialog");
  assert.ok(html.includes("Add a Bot"), "item title resolved via i18n");
  assert.ok(form.includes('placeholder="Paste a bot invite code..."'), "placeholder key resolved");
  assert.ok(!html.includes("messages.pasteBotInvitePlaceholder"), "no raw placeholder key");
  assert.ok(!html.includes("messages.addBot"), "no raw addBot key leaked");
});

test("Add a Bot form carries the CSRF token", () => {
  const html = buildMessagesHTML({ ...BASE });
  assert.ok(botForm(html).includes('name="_csrf"'), "csrf token present in the bot paste form");
});

test("Add a Bot strings resolve in Spanish (es branch of the new keys)", () => {
  const html = buildMessagesHTML({ ...BASE, lang: "es" });
  assert.ok(html.includes("Agregar un bot"), "es item title resolved");
  assert.ok(botForm(html).includes('placeholder="Pega un código de invitación de bot..."'), "es placeholder resolved");
});

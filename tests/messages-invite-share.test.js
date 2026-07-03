// tests/messages-invite-share.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessagesHTML } from "../servers/gateway/dashboard/panels/messages/html.js";

const BASE = {
  items: [], totalUnread: 0, aiConfigured: false, storageAvailable: false,
  inviteResult: null, inviteError: null, lang: "en", botInvite: null,
  botDirectory: { groups: [], total: 0, notAddedCount: 0 },
  requests: [],
  csrf: '<input type="hidden" name="_csrf" value="tok">',
  inviteShare: null, personInvite: null,
};
const CODE = "crow:abc123def0.eyJmYWtlIjoxfQ.c2ln";
const SHARE = { code: CODE, url: `https://maestro.press/software/crow/invite/#${encodeURIComponent(CODE)}`, qrDataUrl: "data:image/png;base64,AAAA" };

test("inviteShare renders the share block (url + QR), not the raw pre dump", () => {
  const html = buildMessagesHTML({ ...BASE, inviteResult: "Invite code generated...", inviteShare: SHARE });
  assert.ok(html.includes(SHARE.url), "share url");
  assert.ok(html.includes('src="data:image/'), "QR");
  assert.ok(html.includes("Copy link"), "copy button");
});

test("inviteResult without a share still renders as before (fallback)", () => {
  const html = buildMessagesHTML({ ...BASE, inviteResult: "some tool text" });
  assert.ok(html.includes("some tool text"), "raw fallback preserved");
});

test("personInvite renders a pre-filled accept card with preview", () => {
  const html = buildMessagesHTML({ ...BASE, personInvite: { code: CODE, fromId: "crow:abc123def0", csrf: BASE.csrf } });
  const start = html.indexOf("msg-person-invite-card");
  assert.notEqual(start, -1, "card present");
  const card = html.slice(start, html.indexOf("</form>", start));
  assert.ok(card.includes('value="accept_invite"'), "posts accept_invite");
  assert.ok(card.includes(CODE), "code carried");
  assert.ok(card.includes("crow:abc123def0"), "peer preview");
  assert.ok(card.includes('name="_csrf"'), "csrf");
  assert.ok(html.includes("Connect with"), "i18n title");
});

test("personInvite with fromId=null shows invalid notice, no accept form", () => {
  const html = buildMessagesHTML({ ...BASE, personInvite: { code: "junk", fromId: null, csrf: BASE.csrf } });
  assert.ok(html.includes("invalid or has expired"), "invalid notice");
  const start = html.indexOf("msg-person-invite-card");
  const card = html.slice(start, start + 800);
  assert.ok(!card.includes('value="accept_invite"'), "no accept form for invalid code");
});

test("tray dialogs use the shared forms (same actions as before)", () => {
  const html = buildMessagesHTML({ ...BASE });
  const gen = html.indexOf('id="invite-generate"');
  const acc = html.indexOf('id="invite-accept"');
  assert.notEqual(gen, -1); assert.notEqual(acc, -1);
  assert.ok(html.slice(gen, acc).includes('value="generate_invite"'), "generate action kept");
  const accBlock = html.slice(acc, html.indexOf("</form>", acc));
  assert.ok(accBlock.includes('value="accept_invite"'), "accept action kept");
  assert.ok(accBlock.includes("Paste an invite link or code"), "shared placeholder");
});

test("spanish strings resolve", () => {
  const html = buildMessagesHTML({ ...BASE, lang: "es", personInvite: { code: CODE, fromId: "crow:abc123def0", csrf: BASE.csrf } });
  assert.ok(html.includes("Conectar con"), "es connectWith");
  assert.ok(!html.includes("invite.connectWith"), "no raw keys");
});

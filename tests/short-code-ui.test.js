// tests/short-code-ui.test.js
//
// Messages Phase 2 PR2 (short-code pairing) Task 4 — dashboard UI.
// Mirrors the fixture patterns in tests/peer-invite-ui.test.js,
// tests/messages-invite-share.test.js and tests/contacts-peer-add.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderShortCodeShare,
  renderShortCodeForms,
  parseShortCodeResult,
} from "../servers/gateway/dashboard/shared/peer-invite-ui.js";
import { buildMessagesHTML } from "../servers/gateway/dashboard/panels/messages/html.js";
import { renderContactList } from "../servers/gateway/dashboard/panels/contacts/html.js";

const FORMATTED_CODE = "K7Q4-M2X9-3FHT";
const TOOL_TEXT = [
  "Short pairing code (expires in 10 minutes):",
  "",
  FORMATTED_CODE,
  "",
  "Speak it aloud or type it to the other person — don't post it anywhere public.",
  "They should use `crow_accept_short_invite` with this code.",
  "Once connected, verify the safety number through a separate channel to confirm the connection is secure.",
].join("\n");

// ──────────────────────────────────────────────
// parseShortCodeResult
// ──────────────────────────────────────────────

test("parseShortCodeResult finds the 12-char (3-group) code and round-trips", () => {
  const parsed = parseShortCodeResult(TOOL_TEXT);
  assert.ok(parsed, "parsed non-null");
  assert.equal(parsed.formattedCode, FORMATTED_CODE);
  assert.ok(typeof parsed.expiresAt === "number" && parsed.expiresAt > Date.now(), "expiresAt is a future timestamp");
});

test("parseShortCodeResult returns null on garbage / two-group-only / non-string input", () => {
  assert.equal(parseShortCodeResult("no code here"), null);
  assert.equal(parseShortCodeResult(null), null);
  assert.equal(parseShortCodeResult(undefined), null);
  // Two-group (8-char) fragment must NOT match — regression guard for the
  // round-2 CRITICAL: a two-group regex would truncate the 12-char code.
  assert.equal(parseShortCodeResult("Your code: K7Q4-M2X9 use it now"), null);
});

test("parseShortCodeResult ignores an unrelated crow: invite code inside the same text", () => {
  // Sanity: the short-code regex must not accidentally match invite-link tokens.
  const mixed = `${TOOL_TEXT}\nAlso see crow:abc123def0.eyJmYWtlIjoxfQ.c2ln`;
  const parsed = parseShortCodeResult(mixed);
  assert.equal(parsed.formattedCode, FORMATTED_CODE);
});

// ──────────────────────────────────────────────
// renderShortCodeShare
// ──────────────────────────────────────────────

test("renderShortCodeShare shows the code big, the expiry hint, and the speak-don't-post hint (en)", () => {
  const html = renderShortCodeShare({ formattedCode: FORMATTED_CODE, expiresAt: Date.now() + 10 * 60 * 1000 }, "en");
  assert.ok(html.includes(FORMATTED_CODE), "code shown");
  assert.ok(html.includes("10 minutes"), "expiry text");
  assert.ok(html.includes("Read it aloud or type it"), "hint text");
  assert.ok(html.includes("safety number") || html.includes("safety numbers"), "safety-number backstop pointer");
});

test("renderShortCodeShare resolves Spanish strings", () => {
  const html = renderShortCodeShare({ formattedCode: FORMATTED_CODE, expiresAt: Date.now() + 10 * 60 * 1000 }, "es");
  assert.ok(!html.includes("invite.shortCode"), "no raw i18n keys");
  assert.ok(html.includes(FORMATTED_CODE), "code shown (es)");
});

test("renderShortCodeShare escapes a hostile formattedCode (XSS)", () => {
  const html = renderShortCodeShare({ formattedCode: "<script>x</script>", expiresAt: Date.now() }, "en");
  assert.ok(!html.includes("<script>"), "code escaped");
});

test("renderShortCodeShare returns empty string for a null/incomplete share", () => {
  assert.equal(renderShortCodeShare(null, "en"), "");
  assert.equal(renderShortCodeShare({}, "en"), "");
});

// ──────────────────────────────────────────────
// renderShortCodeForms
// ──────────────────────────────────────────────

test("renderShortCodeForms returns generate + accept forms with correct actions/fields/csrf", () => {
  const { generateForm, acceptForm } = renderShortCodeForms({
    lang: "en", csrf: '<input type="hidden" name="_csrf" value="tok">',
  });
  assert.ok(generateForm.includes('value="generate_short_invite"'), "generate action");
  assert.ok(generateForm.includes('name="_csrf"'), "csrf in generate form");
  assert.ok(acceptForm.includes('value="accept_short_invite"'), "accept action");
  assert.ok(acceptForm.includes('name="short_code"'), "short_code field present");
  assert.ok(acceptForm.includes('maxlength="20"'), "maxlength 20 (hyphens/spaces tolerant)");
  assert.ok(acceptForm.includes("12-character code"), "placeholder resolved (en)");
  assert.ok(acceptForm.includes('name="_csrf"'), "csrf in accept form");
});

test("renderShortCodeForms resolves Spanish placeholder", () => {
  const { acceptForm } = renderShortCodeForms({ lang: "es" });
  assert.ok(!acceptForm.includes("invite.shortCode"), "no raw i18n keys");
});

// ──────────────────────────────────────────────
// Messages panel wiring
// ──────────────────────────────────────────────

const MSG_BASE = {
  items: [], totalUnread: 0, aiConfigured: false, storageAvailable: false,
  inviteResult: null, inviteError: null, lang: "en", botInvite: null,
  botDirectory: { groups: [], total: 0, notAddedCount: 0 },
  requests: [],
  csrf: '<input type="hidden" name="_csrf" value="tok">',
  inviteShare: null, personInvite: null,
};

test("buildMessagesHTML renders the short-code share block when shortCodeShare is set", () => {
  const html = buildMessagesHTML({
    ...MSG_BASE,
    shortCodeShare: { formattedCode: FORMATTED_CODE, expiresAt: Date.now() + 10 * 60 * 1000 },
  });
  assert.ok(html.includes(FORMATTED_CODE), "generated code shown");
});

test("invite-generate dialog gains a 'use a short code instead' toggle posting generate_short_invite", () => {
  const html = buildMessagesHTML({ ...MSG_BASE });
  const gen = html.indexOf('id="invite-generate"');
  const acc = html.indexOf('id="invite-accept"');
  assert.notEqual(gen, -1); assert.notEqual(acc, -1);
  const genBlock = html.slice(gen, acc);
  assert.ok(genBlock.includes('value="generate_invite"'), "PR1 generate form still present");
  assert.ok(genBlock.includes('value="generate_short_invite"'), "short-code generate action added");
  assert.ok(genBlock.includes("Use a short code instead"), "toggle label");
});

test("invite-accept dialog gains a short-code accept form posting accept_short_invite", () => {
  const html = buildMessagesHTML({ ...MSG_BASE });
  const acc = html.indexOf('id="invite-accept"');
  const nextDialog = html.indexOf('id="invite-bot"');
  assert.notEqual(acc, -1); assert.notEqual(nextDialog, -1);
  const accBlock = html.slice(acc, nextDialog);
  assert.ok(accBlock.includes('value="accept_invite"'), "PR1 accept form still present");
  assert.ok(accBlock.includes('value="accept_short_invite"'), "short-code accept action added");
  assert.ok(accBlock.includes('name="short_code"'), "short_code field present");
});

test("no shortCodeShare set → no leftover code text, dialogs still render", () => {
  const html = buildMessagesHTML({ ...MSG_BASE });
  assert.ok(html.includes('id="invite-generate"'));
  assert.ok(!html.includes(FORMATTED_CODE));
});

// ──────────────────────────────────────────────
// Contacts panel wiring
// ──────────────────────────────────────────────

test("renderContactList's add-peer section gains a 'use a short code instead' toggle", () => {
  const html = renderContactList([], [], {}, "en");
  const start = html.indexOf("contacts-add-peer");
  assert.notEqual(start, -1, "add-peer section present");
  const block = html.slice(start);
  assert.ok(block.includes('value="generate_short_invite"'), "short-code generate form");
  assert.ok(block.includes('value="accept_short_invite"'), "short-code accept form");
  assert.ok(block.includes('name="short_code"'), "short_code field present");
  assert.ok(block.includes("Use a short code instead"), "toggle label");
});

test("renderContactList shows the short-code share result when peerAdd.shortCodeShare is set", () => {
  const html = renderContactList([], [], {}, "en", {
    shortCodeShare: { formattedCode: FORMATTED_CODE, expiresAt: Date.now() + 10 * 60 * 1000 },
  });
  assert.ok(html.includes(FORMATTED_CODE), "generated short code shown");
});

test("renderContactList resolves Spanish short-code toggle", () => {
  const html = renderContactList([], [], {}, "es");
  assert.ok(!html.includes("invite.shortCode"), "no raw i18n keys");
});

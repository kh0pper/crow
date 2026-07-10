// tests/peer-invite-ui.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseInviteCodeFromText,
  buildInviteShare,
  renderInviteShare,
  renderPeerInviteForms,
} from "../servers/gateway/dashboard/shared/peer-invite-ui.js";
import { buildInviteUrl } from "../servers/sharing/invite-url.js";

const CODE = "crow:abc123def0.eyJmYWtlIjoxfQ.c2ln";
const TOOL_TEXT = [
  "Invite code generated (expires in 24 hours):", "",
  `\`${CODE}\``, "",
  "Share link (opens a page with the code and instructions):",
  buildInviteUrl(CODE, {}), "",
  "Your Crow ID: crow:abc123def0",
].join("\n");

test("parseInviteCodeFromText finds the backticked code", () => {
  assert.equal(parseInviteCodeFromText(TOOL_TEXT), CODE);
  assert.equal(parseInviteCodeFromText("no code here"), null);
  assert.equal(parseInviteCodeFromText(null), null);
});

test("buildInviteShare returns code+url (+ qr data URL) and never throws", async () => {
  const share = await buildInviteShare(TOOL_TEXT, {});
  assert.equal(share.code, CODE);
  assert.equal(share.url, buildInviteUrl(CODE, {}));
  // qrcode dep is installed in this repo — expect a data URL.
  assert.ok(share.qrDataUrl && share.qrDataUrl.startsWith("data:image/"), "QR data URL");
  assert.equal(await buildInviteShare("nothing", {}), null);
});

test("renderInviteShare renders url, QR, raw-code fallback, honest hint (en+es)", async () => {
  const share = await buildInviteShare(TOOL_TEXT, {});
  const en = renderInviteShare(share, "en");
  assert.ok(en.includes(share.url), "url shown");
  assert.ok(en.includes('src="data:image/'), "QR img");
  assert.ok(en.includes(CODE), "raw code fallback");
  assert.ok(en.includes("channel you trust"), "honest copy");
  assert.ok(en.includes("Copy link"), "copy button");
  const es = renderInviteShare(share, "es");
  assert.ok(es.includes("Copiar enlace"), "es copy button");
  assert.ok(!es.includes("invite.copyLink"), "no raw i18n keys");
  assert.equal(renderInviteShare(null, "en"), "");
});

test("renderInviteShare omits the QR img when qrDataUrl is null", () => {
  const html = renderInviteShare({ code: CODE, url: "https://x/#c", qrDataUrl: null }, "en");
  assert.ok(!html.includes("<img"), "no img without QR");
});

test("renderInviteShare escapes hostile values", () => {
  const html = renderInviteShare({ code: '<script>x</script>', url: '"><img onerror=1>', qrDataUrl: null }, "en");
  assert.ok(!html.includes("<script>"), "code escaped");
  assert.ok(!html.includes('"><img onerror'), "url escaped");
});

test("renderPeerInviteForms returns generate + accept forms with csrf and prefill", () => {
  const { generateForm, acceptForm } = renderPeerInviteForms({
    lang: "en", csrf: '<input type="hidden" name="_csrf" value="tok">', prefillCode: CODE,
  });
  assert.ok(generateForm.includes('value="generate_invite"'), "generate action");
  assert.ok(generateForm.includes('name="_csrf"'), "csrf in generate form");
  assert.ok(acceptForm.includes('value="accept_invite"'), "accept action");
  assert.ok(acceptForm.includes('name="invite_code"'), "accept field");
  assert.ok(acceptForm.includes(CODE), "prefill present");
  assert.ok(acceptForm.includes("Paste an invite link or code"), "placeholder resolved");
  const es = renderPeerInviteForms({ lang: "es" });
  assert.ok(es.acceptForm.includes("Pega un enlace"), "es placeholder");
});

test("renderPeerInviteForms escapes a hostile prefill", () => {
  const { acceptForm } = renderPeerInviteForms({ lang: "en", prefillCode: '</textarea><script>x</script>' });
  assert.ok(!acceptForm.includes("<script>"), "prefill escaped");
});

test("invite forms opt out of Turbo Drive (F-UI-1: Turbo discards non-redirect POST responses)", () => {
  const { generateForm, acceptForm } = renderPeerInviteForms({ lang: "en", csrf: "" });
  assert.match(generateForm, /<form method="POST" data-turbo="false">/);
  assert.match(acceptForm, /<form method="POST" data-turbo="false">/);
});

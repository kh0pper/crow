// tests/contacts-peer-add.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderContactList } from "../servers/gateway/dashboard/panels/contacts/html.js";

const CODE = "crow:abc123def0.eyJmYWtlIjoxfQ.c2ln";
const SHARE = { code: CODE, url: `https://maestro.press/software/crow/invite/#x`, qrDataUrl: null };

test("contact list renders an Add-a-peer section with generate + accept forms", () => {
  const html = renderContactList([], [], {}, "en");
  const start = html.indexOf("contacts-add-peer");
  assert.notEqual(start, -1, "add-peer section present");
  const block = html.slice(start);
  assert.ok(block.includes('value="generate_invite"'), "generate form");
  assert.ok(block.includes('value="accept_invite"'), "accept form");
  assert.ok(block.includes("Add a Crow peer"), "i18n title");
});

test("share result renders inside the add-peer section", () => {
  const html = renderContactList([], [], {}, "en", { inviteShare: SHARE });
  assert.ok(html.includes(SHARE.url), "share url shown");
  assert.ok(html.includes("Copy link"), "share block rendered");
});

test("invite error renders", () => {
  const html = renderContactList([], [], {}, "en", { inviteError: "expired" });
  assert.ok(html.includes("expired"), "error surfaced");
});

test("spanish strings resolve", () => {
  const html = renderContactList([], [], {}, "es");
  assert.ok(html.includes("Añadir un par de Crow"), "es title");
  assert.ok(!html.includes("contacts.addPeer"), "no raw keys");
});

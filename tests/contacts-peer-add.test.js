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

test("add_by_id form opts out of Turbo Drive (F-UI-1 addendum: silent add-by-id rejection)", () => {
  const html = renderContactList([], [], {}, "en", {});
  const addByIdIdx = html.indexOf('value="add_by_id"');
  assert.ok(addByIdIdx > -1);
  const formOpen = html.lastIndexOf("<form", addByIdIdx);
  const formTag = html.slice(formOpen, html.indexOf(">", formOpen) + 1);
  assert.match(formTag, /data-turbo="false"/);
});

test("add_by_id form embeds the CSRF token (classic POST bypasses Turbo's header injection)", () => {
  // Task 8 seam fix: data-turbo="false" (Task 1) means Turbo's
  // turbo:submit-start hook no longer injects the X-Crow-Csrf header, so the
  // classic POST must carry the _csrf hidden input or csrfMiddleware 403s
  // before the handler ever runs.
  const html = renderContactList([], [], {}, "en", { csrf: '<input type="hidden" name="_csrf" value="tok">' });
  const addByIdIdx = html.indexOf('value="add_by_id"');
  assert.ok(addByIdIdx > -1, "add_by_id form present");
  const formOpen = html.lastIndexOf("<form", addByIdIdx);
  const formClose = html.indexOf("</form>", addByIdIdx);
  const formHtml = html.slice(formOpen, formClose);
  assert.match(formHtml, /name="_csrf"/);
});

test("peer_added flash renders as a success banner and opens the section (F-UI-3)", () => {
  const html = renderContactList([], [], {}, "en", { flash: "Peer connected ✓" });
  assert.match(html, /Peer connected ✓/);
  const detailsIdx = html.indexOf('class="contacts-add-peer"');
  const detailsTag = html.slice(html.lastIndexOf("<details", detailsIdx), html.indexOf(">", detailsIdx) + 1);
  assert.match(detailsTag, / open/);
});

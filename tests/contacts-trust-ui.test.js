// tests/contacts-trust-ui.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderContactProfile, renderContactList } from "../servers/gateway/dashboard/panels/contacts/html.js";
import { computeSafetyNumber } from "../servers/sharing/identity.js";

const MY_PUB = "a".repeat(64);
const THEIR_PUB = "b".repeat(64);

function makeContact(overrides = {}) {
  return {
    id: 7,
    display_name: "Alice",
    contact_type: "crow",
    crow_id: "crow:abcd1234",
    ed25519_pubkey: THEIR_PUB,
    verified: 0,
    ...overrides,
  };
}

test("renderContactProfile renders the safety number + set_verified form when both keys present", () => {
  const contact = makeContact();
  const html = renderContactProfile(contact, [], [], [], "en", MY_PUB);
  const safety = computeSafetyNumber(MY_PUB, THEIR_PUB);
  assert.ok(html.includes(safety), "exact safety number string present");
  assert.ok(html.includes('value="set_verified"'), "set_verified form present");
});

test("unverified contact shows Mark as verified (verified=1); verified contact shows badge + unverify (verified=0)", () => {
  const unverified = renderContactProfile(makeContact({ verified: 0 }), [], [], [], "en", MY_PUB);
  assert.ok(unverified.includes('name="verified" value="1"'), "offers to set verified=1");
  assert.ok(!unverified.includes('name="verified" value="0"'), "does not yet offer to unverify");
  assert.ok(unverified.includes("Mark as verified"), "shows markVerified copy");

  const verified = renderContactProfile(makeContact({ verified: 1 }), [], [], [], "en", MY_PUB);
  assert.ok(verified.includes('name="verified" value="0"'), "offers to set verified=0");
  assert.ok(!verified.includes('name="verified" value="1"'), "does not offer to re-verify");
  assert.ok(verified.includes("Verified"), "shows verified badge copy");
  assert.ok(verified.includes("Remove verification"), "shows unverify copy");
});

test("omitted myEd25519Pubkey: no set_verified form, no throw", () => {
  const contact = makeContact();
  let html;
  assert.doesNotThrow(() => {
    html = renderContactProfile(contact, [], [], [], "en", "");
  });
  assert.ok(!html.includes('value="set_verified"'), "no verify form when myEd25519Pubkey is empty");

  // Also covers the default-param path (5-arg call, brief's default "").
  let html2;
  assert.doesNotThrow(() => {
    html2 = renderContactProfile(contact, [], [], [], "en");
  });
  assert.ok(!html2.includes('value="set_verified"'), "no verify form when myEd25519Pubkey omitted");
});

test("manual contact: no verification section even with both keys present", () => {
  const contact = makeContact({ contact_type: "manual", ed25519_pubkey: THEIR_PUB });
  const html = renderContactProfile(contact, [], [], [], "en", MY_PUB);
  assert.ok(!html.includes('value="set_verified"'), "no verify form for manual contacts");
  assert.ok(!html.includes("Verification"), "no verification section title for manual contacts");
});

test("XSS: hostile display_name is escaped; safety number contains no raw injection", () => {
  const hostile = '<script>alert(1)</script>';
  const contact = makeContact({ display_name: hostile });
  const html = renderContactProfile(contact, [], [], [], "en", MY_PUB);
  assert.ok(!html.includes(hostile), "raw script tag not present");
  assert.ok(html.includes("&lt;script&gt;"), "display_name escaped");
  const safety = computeSafetyNumber(MY_PUB, THEIR_PUB);
  assert.match(safety, /^[0-9 ]+$/, "safety number is digits+spaces only");
});

test("renderContactList: verified contact card contains the verified badge; unverified does not", () => {
  const contacts = [
    { id: 1, display_name: "Verified Vic", contact_type: "crow", verified: 1 },
    { id: 2, display_name: "Unverified Uma", contact_type: "crow", verified: 0 },
  ];
  const html = renderContactList(contacts, [], {}, "en");
  const vicStart = html.indexOf("Verified Vic");
  const vicCard = html.slice(Math.max(0, vicStart - 400), vicStart + 200);
  assert.ok(vicCard.includes("verified-badge"), "verified card has badge markup");

  const umaStart = html.indexOf("Unverified Uma");
  const umaCard = html.slice(Math.max(0, umaStart - 400), umaStart + 200);
  assert.ok(!umaCard.includes("verified-badge"), "unverified card has no badge markup");
});

test("set_verified action UPDATEs contacts.verified and redirects (verified=1 and verified=0)", async () => {
  const { handleContactAction } = await import("../servers/gateway/dashboard/panels/contacts/api-handlers.js");

  const calls = [];
  const db = {
    execute: async (query) => {
      calls.push(query);
      return { rows: [] };
    },
  };

  const result1 = await handleContactAction(
    { body: { action: "set_verified", contact_id: "5", verified: "1" } },
    db
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /UPDATE contacts SET verified = \? WHERE id = \?/);
  assert.deepEqual(calls[0].args, [1, 5]);
  assert.deepEqual(result1, { redirect: "/dashboard/contacts?view=contact&contact=5" });

  const result2 = await handleContactAction(
    { body: { action: "set_verified", contact_id: "5", verified: "0" } },
    db
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, [0, 5]);
  assert.deepEqual(result2, { redirect: "/dashboard/contacts?view=contact&contact=5" });
});

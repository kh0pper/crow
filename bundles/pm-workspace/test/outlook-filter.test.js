import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMailIgnore, filterMessages } from "../server/digest/adapters/outlook.js";

const MSGS = [
  { subject: "TEHCY Support Request Assigned: #4821", from: "support@esc11.net" },
  { subject: "Re: agenda for the biweekly", from: "someone@example.org" },
  { subject: "Weekly notice", from: "noreply@newsletter.example" },
  { subject: null, from: "nobody@example.org" },
];

test("empty or unset OUTLOOK_MAIL_IGNORE keeps every message", () => {
  assert.deepEqual(filterMessages(MSGS, parseMailIgnore(undefined)), MSGS);
  assert.deepEqual(filterMessages(MSGS, parseMailIgnore("")), MSGS);
  assert.deepEqual(filterMessages(MSGS, parseMailIgnore(" ; ")), MSGS);
});

test("subject match is case-insensitive and drops only the matching message", () => {
  const out = filterMessages(MSGS, parseMailIgnore("tehcy support request assigned"));
  assert.equal(out.length, 3);
  assert.ok(out.every((m) => !/Support Request/.test(m.subject || "")));
});

test("patterns match the sender too, and several patterns combine", () => {
  const out = filterMessages(MSGS, parseMailIgnore("Support Request; newsletter\\.example$"));
  assert.deepEqual(out.map((m) => m.subject), ["Re: agenda for the biweekly", null]);
});

test("an invalid regex falls back to a literal match instead of disabling the filter", () => {
  const pats = parseMailIgnore("Assigned: #4821 (");
  assert.equal(pats.length, 1);
  const out = filterMessages([{ subject: "x Assigned: #4821 ( y", from: "" }, MSGS[1]], pats);
  assert.deepEqual(out, [MSGS[1]]);
});

test("messages without subject or sender survive when nothing matches", () => {
  const out = filterMessages([{ subject: null, from: null }, {}], parseMailIgnore("anything"));
  assert.equal(out.length, 2);
});

// The Perch call card (spec 2026-10-01 §4.4). The client is a string emitted
// inside a template literal; these tests check its static shape and extract
// its pure functions with new Function, as perch-hub-client.test.js does.
// The fake-DOM behaviour tests live in perch-hub-client.test.js (its harness).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { perchHubJs } from "../servers/gateway/dashboard/perch-hub/client.js";
import { perchPhoneCardJs } from "../servers/gateway/dashboard/perch-hub/phone-card.js";
import { perchHubCss } from "../servers/gateway/dashboard/perch-hub/css.js";
import { translations } from "../servers/gateway/dashboard/shared/i18n.js";

function maskComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}
function extract(src, name, extra = "") {
  const start = src.indexOf("function " + name + "(");
  assert.ok(start > -1, name + " is not in the snippet");
  const masked = maskComments(src);
  let depth = 0, end = -1;
  for (let i = masked.indexOf("{", start); i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}") { depth--; if (!depth) { end = i; break; } }
  }
  return new Function(extra + src.slice(start, end + 1) + "; return " + name + ";")();
}

test("the card snippet is spliced into the hub script and wired to the stream and history", () => {
  for (const lang of ["en", "es"]) {
    const js = perchHubJs(lang);
    assert.ok(js.includes(perchPhoneCardJs(lang)), "snippet spliced verbatim");
    assert.match(js, /on\('phone_call',function\(d\)\{/);
    assert.match(js, /if\(!histSettled\)\{ phoneBuf\.push\(d\); return; \}/);
    assert.match(js, /if\(current\.sid\) replayUnsent\(current\.sid\);\n    loadPhoneCards\(current\.sid\);/,
      "the cards load after #393's unsent-message replay");
    assert.equal((js.match(/resetPhoneCards\(\);/g) || []).length, 3, "every transcript reset also resets the cards");
    assert.doesNotThrow(() => new Function(js), lang + " parses");
  }
});

test("I6: createElement/textContent only — no HTML sinks, no backticks, no dollar-brace", () => {
  for (const lang of ["en", "es"]) {
    const js = perchPhoneCardJs(lang);
    assert.ok(!/\.innerHTML\s*\+?=|\.outerHTML\s*\+?=|insertAdjacentHTML\s*\(|document\.write\s*\(|setSanitizedHtml\(/.test(js), "no HTML sink");
    assert.equal(js.includes("`"), false, "no backtick");
    assert.equal(js.includes("${"), false, "no dollar-brace");
  }
  assert.equal((perchHubJs("en").match(/\.innerHTML\s*\+?=/g) || []).length, 1, "the hub keeps exactly one innerHTML site");
});

test("I2: cards come from the phone API by call_id; frames are only pointers", () => {
  const js = perchPhoneCardJs("en");
  assert.match(js, /phoneApi\('GET','\/calls\/'\+encodeURIComponent\(id\)\)/);
  assert.match(js, /phoneApi\('GET','\/perch\/'\+encodeURIComponent\(sid\)\+'\/calls'\)/);
  assert.match(js, /typeof d\.call_id!=='string'/);
});

test("I1: actions POST to the existing phone routes with CSRF and the shown plan_hash — never the ask/answer channel", () => {
  const js = perchPhoneCardJs("en");
  for (const p of ["/approve", "/reject", "/farend", "/stop"]) assert.ok(js.includes("'" + p + "'"), p);
  assert.ok(!/\/answer|ask_user|perchApi\(/.test(js));
  assert.match(js, /'X-Crow-Csrf':csrf\(\)/);
  assert.match(js, /plan_hash:c\.plan_hash/);
});

test("I7: controls only for a local session (a real boolean true); Stop for anyone on a live call", () => {
  const phoneControls = extract(perchPhoneCardJs("en"), "phoneControls");
  assert.deepEqual(phoneControls({ local: false }, "pending"), { approve: false, farend: false, stop: false });
  assert.deepEqual(phoneControls({ local: false }, "live"), { approve: false, farend: false, stop: true });
  assert.deepEqual(phoneControls({ local: true }, "pending"), { approve: true, farend: false, stop: false });
  assert.deepEqual(phoneControls({ local: true }, "live"), { approve: false, farend: true, stop: true });
  assert.deepEqual(phoneControls({ local: true }, "terminal"), { approve: false, farend: false, stop: false });
  assert.equal(phoneControls({ local: "true" }, "live").farend, false);
  assert.equal(phoneControls(null, "pending").approve, false);
});

test("views, and the 'business answered' prompt waits for the first business line", () => {
  const js = perchPhoneCardJs("en");
  const phoneView = extract(js, "phoneView");
  assert.deepEqual(["awaiting_approval", "approved", "starting", "live", "done", "rejected", "expired", "cancelled"].map(phoneView),
    ["pending", "queued", "queued", "live", "terminal", "terminal", "terminal", "terminal"]);
  const needs = extract(js, "phoneNeedsPrompt");
  assert.equal(needs([{ type: "state", state: "dialing" }]), false);
  assert.equal(needs([{ type: "state", state: "answered" }]), true);
  assert.equal(needs([{ type: "state", state: "answered" }, { type: "agent", text: "Hi, I'm an automated assistant" }, { type: "agent", text: "Hello?" }]), true,
    "after speak-first the owner still has to type the business's line");
  assert.equal(needs([{ type: "state", state: "answered" }, { type: "farend", text: "Smile Dental" }]), false);
  assert.equal(needs(null), false);
});

test("a card only ever lands in the chat that asked for the call", () => {
  const belongs = extract(perchPhoneCardJs("en"), "phoneBelongs");
  assert.equal(belongs({ id: "call_1", deliver_to: { kind: "perch", session_id: "s1" } }, "s1"), true);
  assert.equal(belongs({ id: "call_1", deliver_to: { kind: "perch", session_id: "s2" } }, "s1"), false);
  assert.equal(belongs({ id: "call_1", deliver_to: { kind: "gateway", gateway_thread_id: "s1" } }, "s1"), false);
  assert.equal(belongs({ id: "call_1", deliver_to: null }, "s1"), false);
  assert.equal(belongs({ id: 7, deliver_to: { kind: "perch", session_id: "s1" } }, "s1"), false);
});

test("S11: history shows open calls plus only the newest finished one, oldest first", () => {
  const js = perchPhoneCardJs("en");
  const viewSrc = js.slice(js.indexOf("function phoneView("), js.indexOf("/* I7: owner controls"));
  const run = extract(js, "phoneHistoryPick", viewSrc);
  const newestFirst = [
    { id: "c6", status: "live" }, { id: "c5", status: "done" }, { id: "c4", status: "awaiting_approval" },
    { id: "c3", status: "rejected" }, { id: "c2", status: "approved" }, { id: "c1", status: "done" },
  ];
  assert.deepEqual(run(newestFirst).map((c) => c.id), ["c2", "c4", "c5", "c6"]);
  assert.deepEqual(run([]), []);
  assert.deepEqual(run(null), []);
});

test("S4: the proposed time prefills a datetime-local value; bad input gives ''", () => {
  const phoneLocalInput = extract(perchPhoneCardJs("en"), "phoneLocalInput");
  const iso = "2030-01-01T15:07:00.000Z";
  const v = phoneLocalInput(iso);
  assert.match(v, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(new Date(v).getTime(), Date.parse(iso), "local wall time round-trips to the same instant");
  assert.equal(phoneLocalInput(null), "");
  assert.equal(phoneLocalInput("not a date"), "");
});

test("limits render as plain text", () => {
  const phoneLimits = extract(perchPhoneCardJs("en"), "phoneLimits", "var PH_NO_LIMITS='none';");
  assert.equal(phoneLimits(null), "none");
  assert.equal(phoneLimits({ days_of_week: ["tue", "thu"], time_window: { start: "15:00", end: "18:00", tz: "America/Chicago" } }),
    "tue, thu; 15:00–18:00 America/Chicago");
});

test("six identity guards in the snippet (perch-hub-client.test.js counts them hub-wide)", () => {
  assert.equal((perchPhoneCardJs("en").match(/current\.sid\s*!==/g) || []).length, 6);
});

test("S12: the two unlabelled inputs carry aria-labels", () => {
  const js = perchPhoneCardJs("en");
  assert.match(js, /when\.setAttribute\('aria-label',PH_APPROVE_AT\)/);
  assert.match(js, /inp\.setAttribute\('aria-label',PH_SAYS\)/);
});

test("every perch.phone* key the card uses exists in EN and ES and they differ", () => {
  const src = readFileSync(new URL("../servers/gateway/dashboard/perch-hub/phone-card.js", import.meta.url), "utf8");
  const keys = [...src.matchAll(/tJs\("(perch\.phone[A-Za-z]+)"/g)].map((m) => m[1]);
  assert.equal(keys.length, 35);
  for (const k of keys) {
    assert.ok(translations[k] && translations[k].en && translations[k].es, k);
    assert.notEqual(translations[k].en, translations[k].es, k);
  }
  assert.ok(translations["perch.phoneApprovedAt"].en.includes("{time}"));
  assert.ok(translations["perch.phoneApprovedAt"].es.includes("{time}"));
});

test("the card has its own styles", () => {
  assert.match(perchHubCss(), /#perch-hub-root \.phonecard\{/);
});

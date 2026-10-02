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
  assert.match(js, /when\.setAttribute\('aria-label',PH_WHEN\)/);
  assert.match(js, /inp\.setAttribute\('aria-label',PH_SAYS\)/);
});

test("every perch.phone* key the card uses exists in EN and ES and they differ", () => {
  const src = readFileSync(new URL("../servers/gateway/dashboard/perch-hub/phone-card.js", import.meta.url), "utf8");
  const keys = [...src.matchAll(/tJs\("(perch\.phone[A-Za-z]+)"/g)].map((m) => m[1]);
  assert.equal(keys.length, 76);
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

// ---- spec 2026-10-02: card polish ----
import { OUTCOMES } from "../bundles/phone/server/plan.js";

test("numbers display as (512) 555-0101 for US/Canada and stay E.164 otherwise", () => {
  const f = extract(perchPhoneCardJs("en"), "phoneNumberText");
  assert.equal(f("+15125550101"), "(512) 555-0101");
  assert.equal(f("+442071234567"), "+442071234567");
  assert.equal(f(null), "");
});

test("the live clock reads SQLite UTC timestamps and formats m:ss", () => {
  const js = perchPhoneCardJs("en");
  const utc = extract(js, "phoneUtcMs");
  assert.equal(utc("2026-10-02 15:04:05"), Date.parse("2026-10-02T15:04:05Z"), "datetime('now') is UTC, not local");
  assert.equal(utc("2026-10-02T15:04:05.000Z"), Date.parse("2026-10-02T15:04:05Z"));
  assert.ok(Number.isNaN(utc(null)));
  const clock = extract(js, "phoneClock");
  assert.equal(clock(42000), "0:42"); assert.equal(clock(605000), "10:05"); assert.equal(clock(-5), "0:00");
});

test("the wrap-up shows while the row is still live: the last line state is 'ended'", () => {
  const ended = extract(perchPhoneCardJs("en"), "phoneEnded");
  assert.equal(ended([{ type: "state", state: "answered" }, { type: "agent", text: "Bye" }, { type: "state", state: "ended" }]), true);
  assert.equal(ended([{ type: "state", state: "ended" }, { type: "state", state: "answered" }]), false);
  assert.equal(ended(null), false);
});

test("every outcome has a pill tone and a label: green success, amber follow-up, grey stopped, red failure", () => {
  const js = perchPhoneCardJs("en");
  const map = new Function(js.slice(js.indexOf("var PH_OUTCOMES="), js.indexOf("/* call_id ->")) + "; return PH_OUTCOMES;")();
  assert.deepEqual(Object.keys(map).sort(), [...OUTCOMES].sort(), "one entry per plan.js outcome, stopped included");
  for (const o of OUTCOMES) assert.ok(["ok", "warn", "neutral", "err"].includes(map[o][0]) && map[o][1], o);
  assert.equal(map.info_gathered[0], "ok"); assert.equal(map.booked[0], "ok");
  assert.equal(map.needs_callback[0], "warn"); assert.equal(map.no_answer[0], "warn"); assert.equal(map.voicemail[0], "warn");
  assert.equal(map.stopped[0], "neutral");
  assert.equal(map.failed[0], "err"); assert.equal(map.not_in_service[0], "err");
  assert.equal(map.stopped[1], "Stopped by you"); assert.equal(map.info_gathered[1], "Got the info");
  const es = perchPhoneCardJs("es");
  const mapEs = new Function(es.slice(es.indexOf("var PH_OUTCOMES="), es.indexOf("/* call_id ->")) + "; return PH_OUTCOMES;")();
  assert.equal(mapEs.stopped[1], "Detenida por ti");
});

test("the primary and Hang up labels match the spec in both languages", () => {
  assert.equal(translations["perch.phoneApprove"].en, "Approve and call now");
  assert.equal(translations["perch.phoneApprove"].es, "Aprobar y llamar ahora");
  assert.equal(translations["perch.phoneStop"].en, "Hang up");
  assert.equal(translations["perch.phoneStop"].es, "Colgar");
});

test("styles: checkbox rows undo the shared input width, status tokens exist in both themes, the dot respects reduced motion", () => {
  const css = perchHubCss();
  assert.match(css, /label\.ph-check\{display:flex;[^}]*min-height:44px/);
  assert.match(css, /label\.ph-check input\[type=checkbox\]\{width:20px;height:20px;flex:none/);
  assert.ok(!/\.phonecard label\{display:block/.test(css), "the rule that stacked the box above its label is gone");
  const [light, dark] = [css.slice(0, css.indexOf("@media (prefers-color-scheme:dark)")), css.slice(css.indexOf("@media (prefers-color-scheme:dark)"))];
  for (const t of ["--ok:", "--ok-soft:", "--warn:", "--warn-soft:", "--err:", "--err-soft:"]) {
    assert.ok(light.includes(t), "light " + t);
    assert.ok(dark.slice(0, dark.indexOf("}}")).includes(t), "dark " + t);
  }
  assert.match(css, /\.phonecard \.ph-err\{color:var\(--err\)/, "error text uses the AA token, not --attn");
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{#perch-hub-root \.phonecard \.ph-dot\{animation:none\}\}/);
  assert.match(css, /#perch-hub-root \.phonecard\{[^}]*min-width:0;[^}]*overflow-wrap:anywhere/);
  assert.ok(css.lastIndexOf("#perch-hub-root .phonecard [hidden]{display:none}") > css.lastIndexOf(".ph-sched{"), "[hidden] wins by source order");
});

// ---- backlog P5/P6 (2026-10-02 phone polish) ----

test("P6: refusal codes read in the viewer's language; unknown codes fall back to the message, then the code", () => {
  for (const [lang, want] of [["en", translations["perch.phoneErrNotice"].en], ["es", translations["perch.phoneErrNotice"].es]]) {
    const js = perchPhoneCardJs(lang);
    const errs = js.slice(js.indexOf("var PH_ERRORS="), js.indexOf("/* Backlog P5: the live poll"));
    const f = extract(js, "phoneErrText", errs);
    assert.equal(f({ status: 409, j: { error: "notice_not_acknowledged", message: "Acknowledge the AI-call notice in Phone settings first." } }), want);
    assert.equal(f({ status: 400, j: { error: "something_new", message: "Server words." } }), "Server words.");
    assert.equal(f({ status: 400, j: { error: "something_new" } }), "something_new");
    assert.equal(f({ status: 0, j: null }), "0");
    assert.equal(f({ status: 400, j: { error: "toString" } }), "toString", "no prototype keys");
  }
  for (const code of ["local_login_required", "totp_required", "business_confirmation_required", "notice_not_acknowledged",
    "owner_name_required", "invalid_run_after", "not_pending", "not_live"]) {
    assert.ok(perchPhoneCardJs("es").includes(code + ":'"), code);
  }
});

test("P5: the poll delay doubles per failure from 1.5 s and caps at 30 s", () => {
  const js = perchPhoneCardJs("en");
  const f = extract(js, "phonePollDelay", "var PH_POLL_MS=1500, PH_POLL_MAX_MS=30000;");
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(f), [1500, 3000, 6000, 12000, 24000, 30000, 30000]);
  assert.match(js, /var PH_POLL_MS=1500, PH_POLL_MAX_MS=30000, PH_POLL_MAX_FAILS=5;/);
});

test("P3: --dim text is WCAG AA (4.5:1) on --card and --sky in both themes", () => {
  const css = perchHubCss();
  const lum = (h) => {
    const x = h.length === 4 ? "#" + [...h.slice(1)].map((c) => c + c).join("") : h;
    const c = [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const dark = css.indexOf("@media (prefers-color-scheme:dark)");
  for (const block of [css.slice(0, dark), css.slice(dark, css.indexOf("}}", dark))]) {
    const tok = (n) => block.match(new RegExp("--" + n + ":(#[0-9a-fA-F]{3,6})"))[1];
    for (const bg of ["card", "sky"]) assert.ok(ratio(tok("dim"), tok(bg)) >= 4.5, "--dim on --" + bg + " " + ratio(tok("dim"), tok(bg)).toFixed(2));
  }
});

test("review M8: each scheduled poll carries an epoch; a stopped or superseded poll's reply is ignored", () => {
  const js = perchPhoneCardJs("en");
  assert.match(js, /var ep=rec\.pollEp=\(rec\.pollEp\|\|0\)\+1;/);
  assert.match(js, /if\(phoneCards\[id\]!==rec\|\|rec\.view!=='live'\|\|ep!==rec\.pollEp\) return;/);
  assert.match(js, /function phoneStopPoll\(rec\)\{\n    if\(!rec\) return;\n    rec\.pollEp=\(rec\.pollEp\|\|0\)\+1;/);
});

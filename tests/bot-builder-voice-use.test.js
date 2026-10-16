/**
 * "Which bot answers voice" (item 20 PR 3, tasks 5 + 7): the Bot Builder
 * card line's kiosk part and the ⋯ "Use for voice…" dialog (voice-use.js).
 *
 * The client script reads the Kiosk listing ONCE per render
 * (GET /api/kiosk/admin/displays — never polled) and writes only through the
 * Kiosk panel's own CSRF-railed endpoints: POST /api/kiosk/admin/dashboard-voice
 * {bot_id} and POST /api/kiosk/admin/displays/<id> {bound_bot_id} (nothing
 * else, so no other setting of a display is rebound). Glasses and companion
 * stay read-only here (their channel settings own them).
 *
 * Runs the real emitted markup + script in linkedom (vm). Bot names are neutral.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { translations } from "../servers/gateway/dashboard/shared/i18n.js";
import { voiceUseScript, voiceUseDialogHtml, voiceLineHtml, voiceUseItemHtml } from "../servers/gateway/dashboard/panels/bot-builder/voice-use.js";
import { DASH_VOICE_PATH, displayPath, dashBody, dashAutoBody, displayBody } from "./fixtures/voice-use-bodies.mjs";

const T = (k) => translations[k].en;
const KIOSK = { id: "kiosk-1", name: "Kitchen", bound_bot_id: "b-two", kiosk_settings: { memory_integration: false } };
const HALL = { id: "kiosk 2", name: "Hall", bound_bot_id: "a-one", kiosk_settings: { memory_integration: true } };
const BOTS = [
  { bot_id: "a-one", display_name: "Alpha One", fit: "full", fit_memory: "full" },
  { bot_id: "b-two", display_name: "Beta Two", fit: "full", fit_memory: "full" },
  { bot_id: "c-big", display_name: "Cee Big", fit: "too_large", fit_memory: "too_large" },
  { bot_id: "d-lean", display_name: "Dee Lean", fit: "no_skills", fit_memory: "too_large" },
];
const listing = (over = {}) => ({
  devices: [KIOSK], bots: BOTS, pending: [], stt_profiles: [], tts_profiles: [],
  dashboard_voice: { available: true, bot_id: null, effective_bot_id: "a-one", auto_bot_id: "a-one" },
  ...over,
});

function scriptsOf(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

/**
 * A page with one card per bot id (server parts as html.js renders them),
 * the dialog, and the script. `replies` is a queue of fetch answers:
 * { status, body, type, redirected } (default: 200 JSON of the listing).
 */
function page({ cards = [["a-one", "Alpha One", ["Office glasses"]], ["b-two", "Beta Two", []], ["c-big", "Cee Big", []], ["d-lean", "Dee Lean", []]], replies = [], lang = "en" } = {}) {
  const body = cards.map(([id, name, srv], i) =>
    `<div class="btb-botcard" data-bot="${id}">` + voiceLineHtml(id, srv, lang) +
    `<button type="button" class="btb-more" aria-controls="btb-menu-${i}" aria-expanded="false">⋯</button>` +
    `<div class="btb-menu" id="btb-menu-${i}" role="menu" hidden>` + voiceUseItemHtml(id, name, lang) + `</div></div>`).join("");
  const html = voiceUseDialogHtml(lang) + voiceUseScript(lang);
  const { document, window } = parseHTML(`<html><body>${body}${html}</body></html>`);
  let active = null;
  window.HTMLElement.prototype.focus = function () { active = this; };
  Object.defineProperty(document, "activeElement", { get: () => active, configurable: true });
  const calls = [];
  const queue = [...replies];
  const fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : undefined });
    const r = queue.length ? queue.shift() : {};
    const status = r.status || 200;
    const payload = r.body !== undefined ? r.body : listing();
    return {
      ok: status >= 200 && status < 300, status, redirected: !!r.redirected,
      headers: { get: (h) => (h.toLowerCase() === "content-type" ? (r.type || "application/json; charset=utf-8") : null) },
      json: async () => (typeof payload === "string" ? JSON.parse(payload) : payload),
    };
  };
  const listeners = { n: 0 };
  const addEv = document.addEventListener.bind(document);
  document.addEventListener = (...a) => { listeners.n++; return addEv(...a); };
  // A fresh window per page: linkedom's window writes through to the process global, so the
  // script's bind-once flag would leak from one page to the next.
  const win = {};
  const ctx = vm.createContext({ document, window: win, fetch, JSON, String, Array, Object, Promise, encodeURIComponent });
  const run = () => { for (const src of scriptsOf(html)) vm.runInContext(src, ctx); };
  run();
  const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
  const line = (id) => document.querySelector(`.btb-voice[data-voice-bot="${id}"]`);
  const item = (id) => document.querySelector(`.btb-voice-use[data-bot-id="${id}"]`);
  const dlg = () => document.getElementById("btb-vu");
  // (assertions compare nodes with === / ok: a failing deepEqual on a linkedom node would inspect the whole DOM)
  const row = (key) => dlg().querySelector(`[data-vu-row="${key}"]`);
  const box = (key) => row(key)?.querySelector("input[type=checkbox]");
  const click = (n) => n.dispatchEvent(new window.Event("click", { bubbles: true }));
  const change = (n) => n.dispatchEvent(new window.Event("change", { bubbles: true }));
  const key = (n, k) => { const ev = new window.Event("keydown", { bubbles: true }); ev.key = k; n.dispatchEvent(ev); return ev; };
  const open = async (id) => { click(item(id)); await flush(); };
  const save = async () => { click(document.getElementById("btb-vu-save")); await flush(); };
  const posts = () => calls.filter((c) => c.method === "POST");
  return { document, window, calls, posts, queue, flush, line, item, dlg, row, box, click, change, key, open, save, run, listeners, active: () => active };
}

test("the emitted script is a template literal's worth: no backticks, no dollar-brace; the strings JSON cannot close its script", () => {
  const html = voiceUseScript("en");
  for (const src of scriptsOf(html)) { assert.ok(!src.includes("`")); assert.ok(!src.includes("${")); }
  const json = html.match(/<script type="application\/json" id="btb-vu-s">([\s\S]*?)<\/script>/)[1];
  assert.ok(!json.includes("<"));
  assert.equal(JSON.parse(json).phoneDash, T("botbuilder.voicePhoneDash"));
});

test("card line: fills Phone & dashboard (automatic) and each display on the right cards, after the server part; read once, never polled", async () => {
  const p = page();
  await p.flush();
  assert.deepEqual(p.calls.map((c) => [c.method, c.url]), [["GET", "/api/kiosk/admin/displays"]], "one listing, no interval (none is even available)");
  assert.equal(p.line("a-one").hidden, false);
  assert.ok(p.line("a-one").textContent.includes(`Office glasses, ${T("botbuilder.voicePhoneDash")} ${T("botbuilder.voiceAutomatic")}`));
  assert.equal(p.line("b-two").hidden, false, "b-two has only a kiosk part, and is shown");
  assert.ok(p.line("b-two").textContent.includes("Kitchen"));
  assert.ok(!p.line("b-two").textContent.includes(T("botbuilder.voicePhoneDash")));
  assert.equal(p.line("c-big").hidden, true, "nothing to say: hidden, never a dash");
  for (const id of ["a-one", "b-two", "c-big"]) assert.equal(p.item(id).hidden, false, `${id}: Use for voice… shows once the listing loads`);
});

test("card line: an explicit choice reads without '(automatic)'", async () => {
  const p = page({ replies: [{ body: listing({ dashboard_voice: { available: true, bot_id: "b-two", effective_bot_id: "b-two", auto_bot_id: "a-one" } }) }] });
  await p.flush();
  assert.ok(p.line("b-two").textContent.includes(T("botbuilder.voicePhoneDash")));
  assert.ok(!p.line("b-two").textContent.includes(T("botbuilder.voiceAutomatic")));
  assert.ok(!p.line("a-one").textContent.includes(T("botbuilder.voicePhoneDash")));
});

test("no kiosk listing (404, a login page, a redirect, a network error, available:false with no displays): kiosk parts and the ⋯ item stay hidden", async () => {
  for (const reply of [{ status: 404, body: { error: "not_found" } }, { type: "text/html", body: "{}" }, { redirected: true }, { body: listing({ devices: [], dashboard_voice: { available: false } }) }]) {
    const p = page({ replies: [reply] });
    await p.flush();
    assert.equal(p.item("a-one").hidden, true, JSON.stringify(reply));
    assert.equal(p.line("b-two").hidden, true, JSON.stringify(reply));
    assert.ok(p.line("a-one").textContent.includes("Office glasses"), "the server part stays");
    assert.ok(!p.line("a-one").textContent.includes(T("botbuilder.voicePhoneDash")));
  }
  const boom = page();
  // a fetch that throws synchronously
  boom.queue.length = 0;
  const { document, window } = parseHTML(`<html><body>${voiceLineHtml("a-one", [], "en")}${voiceUseDialogHtml("en")}</body></html>`);
  const ctx = vm.createContext({ document, window: {}, fetch: () => { throw new Error("offline"); }, JSON, String, Array, Object, Promise, encodeURIComponent });
  for (const src of scriptsOf(voiceUseScript("en"))) assert.doesNotThrow(() => vm.runInContext(src, ctx));
});

test("I1: Phone & dashboard needs dashboard_voice.available; display rows need only the displays", async () => {
  const noDash = { body: listing({ dashboard_voice: { available: false } }) };
  const p = page({ replies: [noDash, noDash] });
  await p.flush();
  assert.equal(p.item("a-one").hidden, false, "a display can still be bound");
  assert.ok(!p.line("a-one").textContent.includes(T("botbuilder.voicePhoneDash")));
  await p.open("a-one");
  assert.ok(p.row("dash") === null, "no Phone & dashboard row");
  assert.ok(p.row("dev:kiosk-1"), "the display row");
});

test("dialog: opens for the bot from its ⋯ item, names it, re-reads the listing, and lists Phone & dashboard + each display with who answers now", async () => {
  const p = page();
  await p.flush();
  await p.open("a-one");
  assert.equal(p.dlg().hidden, false);
  assert.equal(p.document.getElementById("btb-vu-h").textContent, "Use Alpha One for voice");
  assert.equal(p.calls.filter((c) => c.method === "GET").length, 2, "opening re-reads the listing (the line may be stale)");
  assert.equal(p.box("dash").checked, true, "Alpha One answers now (automatically)");
  assert.ok(p.row("dash").textContent.includes("Automatic — now Alpha One"));
  assert.ok(p.dlg().textContent.includes(T("botbuilder.voiceUseNextOpen")), "I5: phone/dashboard applies next time");
  assert.ok(p.dlg().textContent.includes(T("botbuilder.voiceUseDisplaysNow")), "I5: displays switch right away");
  assert.equal(p.box("dev:kiosk-1").checked, false);
  assert.equal(p.box("dev:kiosk-1").disabled, false);
  assert.ok(p.row("dev:kiosk-1").textContent.includes("now: Beta Two"));
  const ch = p.document.getElementById("btb-vu-ch-link");
  assert.equal(ch.getAttribute("href"), "/dashboard/bot-builder?bot=a-one&tab=basics", "glasses/companion: read-only, a link to the channel settings");
  assert.ok(p.dlg().textContent.includes(T("botbuilder.voiceUseChannels")));
  assert.equal(p.dlg().querySelectorAll("input[type=checkbox]").length, 2, "no glasses or companion rows");
});

test("dialog: checking a display POSTs ONLY {bound_bot_id} to that display's endpoint (id encoded), then refreshes every card", async () => {
  const moved = listing({ devices: [{ ...KIOSK, bound_bot_id: "a-one" }] });
  const p = page({ replies: [{}, {}, { body: { ok: true, device: {} } }, { body: moved }] });
  await p.flush();
  await p.open("a-one");
  p.box("dev:kiosk-1").checked = true; p.change(p.box("dev:kiosk-1"));
  await p.save();
  assert.deepEqual(p.posts(), [{ url: displayPath("kiosk-1"), method: "POST", body: displayBody("a-one") }]);
  assert.ok(p.row("dev:kiosk-1").textContent.includes(T("botbuilder.voiceUseSaved")), "a per-row result");
  assert.ok(p.line("a-one").textContent.includes("Kitchen"), "the card line follows");
  assert.equal(p.line("b-two").hidden, true, "and the card the display left is updated too");
});

test("dialog: a display id with spaces is encoded in the path", async () => {
  const p = page({ replies: [{ body: listing({ devices: [KIOSK, { ...HALL, bound_bot_id: "b-two" }] }) }, { body: listing({ devices: [KIOSK, { ...HALL, bound_bot_id: "b-two" }] }) }, { body: { ok: true } }] });
  await p.flush();
  await p.open("a-one");
  p.box("dev:kiosk 2").checked = true;
  await p.save();
  assert.equal(p.posts()[0].url, "/api/kiosk/admin/displays/kiosk%202");
  assert.equal(p.posts()[0].url, displayPath("kiosk 2"));
});

test("dialog: a display already on this bot is checked and disabled, with how to move it and a link to Kiosk (a display can never be unbound)", async () => {
  const p = page({ replies: [{ body: listing({ devices: [KIOSK, HALL] }) }, { body: listing({ devices: [KIOSK, HALL] }) }] });
  await p.flush();
  await p.open("a-one");
  assert.equal(p.box("dev:kiosk 2").checked, true);
  assert.equal(p.box("dev:kiosk 2").disabled, true);
  assert.ok(p.row("dev:kiosk 2").textContent.includes(T("botbuilder.voiceUseAlready")));
  assert.equal(p.row("dev:kiosk 2").querySelector("a").getAttribute("href"), "/dashboard/kiosk");
});

test("dialog: checking Phone & dashboard POSTs {bot_id}; unchecking an explicit choice POSTs {bot_id: ''} (back to Automatic)", async () => {
  const p = page({ replies: [{}, {}, { body: { ok: true, bot_id: "b-two", effective_bot_id: "b-two", auto_bot_id: "a-one" } }] });
  await p.flush();
  await p.open("b-two");
  assert.equal(p.box("dash").checked, false);
  p.box("dash").checked = true; p.change(p.box("dash"));
  await p.save();
  assert.deepEqual(p.posts(), [{ url: DASH_VOICE_PATH, method: "POST", body: dashBody("b-two") }]);

  const explicit = listing({ dashboard_voice: { available: true, bot_id: "b-two", effective_bot_id: "b-two", auto_bot_id: "a-one" } });
  const q = page({ replies: [{ body: explicit }, { body: explicit }, { body: { ok: true, bot_id: null, effective_bot_id: "a-one", auto_bot_id: "a-one" } }, {}] });
  await q.flush();
  await q.open("b-two");
  assert.equal(q.box("dash").checked, true);
  assert.ok(q.row("dash").textContent.includes("now: Beta Two"));
  q.box("dash").checked = false; q.change(q.box("dash"));
  await q.save();
  assert.deepEqual(q.posts(), [{ url: DASH_VOICE_PATH, method: "POST", body: dashAutoBody() }]);
  assert.ok(q.row("dash").textContent.includes("Automatic — now Alpha One"), "the row then says who Automatic picks");
});

test("dialog: unchecking an automatic-only pick is a no-op with a hint (nothing is posted)", async () => {
  const p = page();
  await p.flush();
  await p.open("a-one");
  p.box("dash").checked = false; p.change(p.box("dash"));
  assert.equal(p.box("dash").checked, true, "stays checked");
  assert.ok(p.row("dash").textContent.includes("Automatic already picks Alpha One"));
  await p.save();
  assert.deepEqual(p.posts(), []);
  assert.equal(p.document.getElementById("btb-vu-status").textContent, T("botbuilder.voiceUseNothing"));
});

test("dialog: a too-large bot's targets are disabled with the fit wording; a display with memories on uses fit_memory; without-skills warns", async () => {
  const both = { body: listing({ devices: [KIOSK, { ...HALL, bound_bot_id: "b-two" }] }) };
  const p = page({ replies: [both, both, both] });
  await p.flush();
  await p.open("c-big");
  assert.equal(p.box("dash").disabled, true);
  assert.equal(p.box("dev:kiosk-1").disabled, true);
  assert.ok(p.row("dash").textContent.includes(T("botbuilder.voiceUseTooLarge")));
  p.click(p.dlg().querySelector("[data-vu-close]"));
  await p.open("d-lean");
  assert.equal(p.box("dev:kiosk-1").disabled, false, "memories off: fits without its skills");
  assert.ok(p.row("dev:kiosk-1").textContent.includes(T("botbuilder.voiceUseNoSkills")));
  assert.equal(p.box("dev:kiosk 2").disabled, true, "memories on: fit_memory says too large");
  assert.ok(p.row("dev:kiosk 2").textContent.includes(T("botbuilder.voiceUseTooLarge")));
  // An older listing without fit_memory: the plain fit is used.
  const old = listing({ bots: BOTS.map(({ fit_memory, ...b }) => b), devices: [{ ...HALL, bound_bot_id: "b-two" }] });
  const q = page({ replies: [{ body: old }, { body: old }] });
  await q.flush();
  await q.open("d-lean");
  assert.equal(q.box("dev:kiosk 2").disabled, false);
});

test("dialog: the server's refusals are shown in words per row; saves run one after another", async () => {
  const two = listing({ devices: [KIOSK, { ...HALL, bound_bot_id: "b-two" }], dashboard_voice: { available: true, bot_id: null, effective_bot_id: "b-two", auto_bot_id: "b-two" } });
  const p = page({ replies: [{ body: two }, { body: two }, { status: 400, body: { error: "bot_too_large" } }, { status: 400, body: { error: "bot_required" } }, { status: 500, body: { error: "internal" } }, { body: two }] });
  await p.flush();
  await p.open("a-one");
  for (const k of ["dash", "dev:kiosk-1", "dev:kiosk 2"]) { p.box(k).checked = true; p.change(p.box(k)); }
  await p.save();
  assert.deepEqual(p.posts().map((c) => c.url), ["/api/kiosk/admin/dashboard-voice", "/api/kiosk/admin/displays/kiosk-1", "/api/kiosk/admin/displays/kiosk%202"]);
  assert.ok(p.row("dash").textContent.includes(T("botbuilder.voiceUseTooLarge")));
  assert.ok(p.row("dev:kiosk-1").textContent.includes(T("botbuilder.voiceUseRequired")));
  assert.ok(p.row("dev:kiosk 2").textContent.includes("Not saved (internal)"));
});

test("dialog: Escape and Close hide it and give focus back to the ⋯ trigger", async () => {
  const p = page();
  await p.flush();
  await p.open("b-two");
  const trigger = p.document.querySelector('[aria-controls="btb-menu-1"]');
  assert.equal(p.document.getElementById("btb-menu-1").hidden, true, "the menu closed when the dialog opened");
  const ev = p.key(p.box("dash"), "Escape");
  assert.equal(p.dlg().hidden, true);
  assert.ok(p.active() === trigger, "focus is back on the ⋯ trigger");
  assert.equal(ev.defaultPrevented, true);
  await p.open("b-two");
  p.click(p.dlg().querySelector("[data-vu-close]"));
  assert.equal(p.dlg().hidden, true);
  assert.ok(p.active() === trigger, "and after Close");
});

test("I3 Turbo: a second run of the script (a Turbo render) binds nothing new but reads and fills the lines again", async () => {
  const p = page();
  await p.flush();
  const bound = p.listeners.n;
  const gets = p.calls.length;
  p.run();
  await p.flush();
  assert.equal(p.listeners.n, bound, "listeners are bound once per page lifetime");
  assert.equal(p.calls.length, gets + 1, "the lines are refilled on every render");
  await p.open("a-one");
  assert.equal(p.dlg().hidden, false, "and the one set of listeners still opens the dialog");
});

test("Spanish: the dialog and lines use the Spanish strings", async () => {
  const p = page({ lang: "es" });
  await p.flush();
  assert.ok(p.line("a-one").textContent.includes(translations["botbuilder.voicePhoneDash"].es));
  await p.open("a-one");
  assert.equal(p.document.getElementById("btb-vu-h").textContent, "Usar a Alpha One para la voz");
  assert.ok(!p.dlg().textContent.includes(T("botbuilder.voiceUseNextOpen")));
});

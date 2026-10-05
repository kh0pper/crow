import { test } from "node:test";
import assert from "node:assert/strict";
import panel, { CLIENT_SCRIPT } from "../bundles/kiosk/panel/kiosk.js";
import { STRINGS } from "../bundles/kiosk/server/strings.js";

const SAME_OK = new Set(["brand"]);

test("strings: en/es parity — same keys, non-empty, translated, same {placeholders}", () => {
  const en = Object.keys(STRINGS.en).sort(), es = Object.keys(STRINGS.es).sort();
  assert.deepEqual(es, en);
  assert.ok(en.length >= 40);
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(",");
  for (const k of en) {
    assert.ok(STRINGS.en[k] && STRINGS.es[k], k);
    if (!SAME_OK.has(k)) assert.notEqual(STRINGS.es[k], STRINGS.en[k], `untranslated: ${k}`);
    assert.equal(ph(STRINGS.es[k]), ph(STRINGS.en[k]), `placeholders: ${k}`);
  }
});

test("panel client script lives in a template literal: no backticks, no ${", () => {
  assert.ok(!CLIENT_SCRIPT.includes("`"));
  assert.ok(!CLIENT_SCRIPT.includes("${"));
  assert.doesNotMatch(CLIENT_SCRIPT, /innerHTML/);
});

test("panel renders in the viewer's language with escaped JSON strings", async () => {
  assert.equal(panel.id, "kiosk");
  assert.equal(panel.route, "/dashboard/kiosk");
  let html = "";
  await panel.handler({ query: {} }, { send: (h) => { html = h; } }, { db: {}, lang: "es", layout: ({ title, content }) => `<title>${title}</title>${content}` });
  assert.match(html, new RegExp(STRINGS.es.panel_title));
  const json = html.match(/<script type="application\/json" id="kk-strings">([\s\S]*?)<\/script>/)[1];
  assert.ok(!json.includes("<"), "JSON block cannot close the script element");
  assert.equal(JSON.parse(json).approve, STRINGS.es.approve);
  assert.match(html, new RegExp(STRINGS.es.household_hint.slice(0, 20)));
});

test("page string keys exist in en and es (page keys are a subset of STRINGS)", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = new URL("../bundles/kiosk/public/", import.meta.url);
  const keys = new Set();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".js"))) {
    const src = readFileSync(new URL(f, dir), "utf8");
    for (const m of src.matchAll(/\bt\(\s*["']([a-z_]+)["']/g)) keys.add(m[1]);
    for (const m of src.matchAll(/banner(?:\(|:\s*)["']([a-z_]+)["']/g)) keys.add(m[1]);
    for (const m of src.matchAll(/hint:\s*["']([a-z_]+)["']/g)) keys.add(m[1]);
    for (const m of src.matchAll(/return\s+["'](mic_blocked|no_mic|mic_error|needs_gesture)["']/g)) keys.add(m[1]);
  }
  for (const c of ["turn_busy", "empty_transcript", "audio_too_long", "turn_failed", "tts_error", "acquire_failed", "bot_too_large"]) keys.add("err_" + c);
  assert.ok(keys.size >= 15, "found " + keys.size);
  for (const k of keys) { assert.ok(STRINGS.en[k], "en missing " + k); assert.ok(STRINGS.es[k], "es missing " + k); }
});

test("panel and docs say /display for the page URL", () => {
  assert.match(STRINGS.en.pair_steps, /\/display/);
  assert.match(STRINGS.es.no_pending, /\/display/);
  assert.doesNotMatch(STRINGS.en.pair_steps + STRINGS.es.pair_steps + STRINGS.en.no_pending + STRINGS.es.no_pending, /\/kiosk/);
});

// Final-review item 5: Save never silently rebinds. A current value missing
// from the options shows a selected "(not set)" instead of the first option,
// and only the fields the admin changed are posted.
async function runPanel(device, data = {}) {
  const { parseHTML } = await import("linkedom");
  const vm = await import("node:vm");
  const { document, window } = parseHTML(`<html><body><div id="kk-root"><div id="kk-pair"></div><div id="kk-dash" hidden></div><div id="kk-devices"></div></div><script type="application/json" id="kk-strings">${JSON.stringify(STRINGS.en)}</script></body></html>`);
  const posts = [];
  const listing = {
    devices: [device], pending: [],
    bots: [{ bot_id: "chef", display_name: "Chef" }, { bot_id: "household", display_name: "Household" }],
    stt_profiles: [{ id: "stt-a", name: "Whisper A" }, { id: "stt-b", name: "Whisper B" }],
    tts_profiles: [{ id: "tts-a", name: "Kokoro", provider: "kokoro" }],
    ...data,
  };
  const fetch = async (path, opts = {}) => {
    if (opts.method === "POST") posts.push({ path, body: JSON.parse(opts.body) });
    return { status: 200, json: async () => (opts.method === "POST" ? (data.postReply || { ok: true }) : listing) };
  };
  const ctx = vm.createContext({ document, window, fetch, JSON, String, setInterval: () => 0, clearInterval: () => {}, encodeURIComponent, Date });
  window.confirm = () => false;
  vm.runInContext(CLIENT_SCRIPT, ctx);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  const card = document.querySelector("#kk-devices section");
  const [bot, stt, sm, tts] = card.querySelectorAll("select");
  const vad = [...card.querySelectorAll("input")].find((i) => i.type === "number");
  const save = [...card.querySelectorAll("button")].find((b) => b.textContent === STRINGS.en.save);
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  const change = (node) => node.dispatchEvent(new window.Event("change"));
  // linkedom: selecting one option clears the others (and un-selecting ANY option clears the selected one), so only the target is set.
  const choose = (sel, value) => { [...sel.querySelectorAll("option")].find((o) => o.value === value).selected = true; change(sel); };
  return { bot, stt, sm, tts, vad, save, posts, flush, card, document, window, change, choose, pairForm: document.querySelector("#kk-pair form") };
}
const KDEV = { id: "kiosk-a", name: "Kitchen", connected: true, latency: {}, kiosk_settings: { follow_up: true, memory_integration: false } };

test("panel Save: a missing bot/voice shows (not set) selected, and an untouched Save rebinds nothing", async () => {
  const p = await runPanel({ ...KDEV, bound_bot_id: "deleted-bot", stt_profile_id: "stt-gone", tts_profile_id: null });
  for (const sel of [p.bot, p.stt, p.tts]) {
    assert.equal(sel.querySelector("option").textContent, STRINGS.en.not_set);
    assert.equal(sel.value, "", "the blank option is selected, not the first real one");
  }
  p.save.dispatchEvent(new p.save.ownerDocument.defaultView.Event("click"));
  await p.flush();
  assert.equal(p.posts.length, 0, "nothing changed: no POST, no silent rebind");
});

test("panel Save: only changed fields are posted; a known current value has no (not set) option", async () => {
  const p = await runPanel({ ...KDEV, bound_bot_id: "household", stt_profile_id: "stt-a", tts_profile_id: "tts-a" });
  assert.equal(p.bot.value, "household");
  assert.ok(![...p.bot.querySelectorAll("option")].some((o) => o.textContent === STRINGS.en.not_set));
  for (const o of p.stt.querySelectorAll("option")) o.selected = o.value === "stt-b";
  p.save.dispatchEvent(new p.save.ownerDocument.defaultView.Event("click"));
  await p.flush();
  assert.equal(p.posts.length, 1);
  assert.deepEqual(p.posts[0].body, { stt_profile_id: "stt-b" }, "bot, tts and settings untouched → omitted");
  assert.equal(p.posts[0].path, "/api/kiosk/admin/displays/kiosk-a");
});

test("smoke 2026-10-04 levers in the panel: end-of-speech wait (300-900 ms) and speech model are per display; only changes are posted", async () => {
  const p = await runPanel({ ...KDEV, bound_bot_id: "household", stt_profile_id: "stt-a", tts_profile_id: "tts-a", kiosk_settings: { ...KDEV.kiosk_settings, vad_hangover_ms: 450, stt_model: "default" } });
  assert.equal(p.vad.value, "450");
  assert.equal(p.vad.min, "300"); assert.equal(p.vad.max, "900");
  assert.equal(p.sm.value, "default");
  assert.deepEqual([...p.sm.querySelectorAll("option")].map((o) => o.value), ["default", "tiny.en"]);
  p.save.dispatchEvent(new p.save.ownerDocument.defaultView.Event("click"));
  await p.flush();
  assert.equal(p.posts.length, 0, "untouched: nothing posted");
  p.vad.value = "5000";
  for (const o of p.sm.querySelectorAll("option")) o.selected = o.value === "tiny.en";
  p.save.dispatchEvent(new p.save.ownerDocument.defaultView.Event("click"));
  await p.flush();
  assert.equal(p.posts.length, 1);
  assert.deepEqual(p.posts[0].body, { kiosk_settings: { follow_up: true, memory_integration: false, vad_hangover_ms: 900, stt_model: "tiny.en" } }, "typed value clamped to 900");
});

// Assistant fit: the picker says, BEFORE binding, whether an assistant's prompt fits the quick voice model.
const FIT_BOTS = [
  { bot_id: "chef", display_name: "Chef", fit: "full", fit_memory: "full" },
  { bot_id: "general", display_name: "General", fit: "no_skills", fit_memory: "no_skills" },
  { bot_id: "edge", display_name: "Edge", fit: "no_skills", fit_memory: "too_large" },
  { bot_id: "huge", display_name: "Huge", fit: "too_large", fit_memory: "too_large" },
  { bot_id: "mystery", display_name: "Mystery", fit: null, fit_memory: null },
];

test("fit in the pairing form: every assistant is listed with its status; picking a too-large one shows the distinct warning before Pair", async () => {
  const p = await runPanel({ ...KDEV, bound_bot_id: "chef", stt_profile_id: "stt-a", tts_profile_id: "tts-a" }, { bots: FIT_BOTS, postReply: { error: "bot_too_large" } });
  const sel = p.pairForm.querySelector("select");
  const labels = Object.fromEntries([...sel.querySelectorAll("option")].map((o) => [o.value, o.textContent]));
  assert.equal(labels.chef, "Chef");
  assert.equal(labels.general, `General — ${STRINGS.en.fit_tag_no_skills}`);
  assert.equal(labels.huge, `Huge — ${STRINGS.en.fit_tag_too_large}`);
  assert.equal(labels.mystery, "Mystery", "unknown fit: no claim either way");
  const line = p.pairForm.querySelector(".kk-fit");
  assert.equal(line.textContent, "", "nothing chosen yet");
  p.choose(sel, "general");
  assert.equal(line.textContent, STRINGS.en.fit_no_skills);
  assert.ok(line.classList.contains("kk-fit-warn") && !line.classList.contains("kk-fit-bad"));
  p.choose(sel, "huge");
  assert.equal(line.textContent, STRINGS.en.fit_too_large);
  assert.ok(line.classList.contains("kk-fit-bad"), "too large is visually distinct");
  p.choose(sel, "chef");
  assert.equal(line.textContent, STRINGS.en.fit_full);
  assert.ok(!line.classList.contains("kk-fit-bad") && !line.classList.contains("kk-fit-warn"));
  // The server's refusal is shown in words.
  p.choose(sel, "huge");
  p.pairForm.querySelector("input[name=code]").value = "123456";
  p.pairForm.dispatchEvent(new p.window.Event("submit"));
  await p.flush();
  assert.equal(p.pairForm.querySelector(".kk-msg").textContent, STRINGS.en.bot_too_large);
});

test("fit on a paired display: the bound assistant's status is shown, follows the picker and the memory box, and a refused save is explained", async () => {
  const p = await runPanel({ ...KDEV, bound_bot_id: "huge", stt_profile_id: "stt-a", tts_profile_id: "tts-a" }, { bots: FIT_BOTS, postReply: { error: "bot_too_large" } });
  const line = p.card.querySelector(".kk-fit");
  assert.equal(line.textContent, STRINGS.en.fit_too_large, "a display already bound to a too-large assistant says so");
  assert.ok(line.classList.contains("kk-fit-bad"));
  assert.ok([...p.bot.querySelectorAll("option")].some((o) => o.textContent === `Huge — ${STRINGS.en.fit_tag_too_large}`));
  p.choose(p.bot, "edge");
  assert.equal(line.textContent, STRINGS.en.fit_no_skills);
  const mem = [...p.card.querySelectorAll("input")].filter((i) => i.type === "checkbox")[1];
  mem.checked = true; p.change(mem);
  assert.equal(line.textContent, STRINGS.en.fit_too_large, "with memories on this assistant no longer fits");
  p.save.dispatchEvent(new p.window.Event("click"));
  await p.flush();
  assert.equal(p.posts.length, 1);
  assert.equal(p.card.querySelector(".kk-msg").textContent, STRINGS.en.bot_too_large);
});

test("fit strings: the three states and the refusal exist in en and es; the page's too-large line is its own string", () => {
  for (const L of ["en", "es"]) {
    for (const k of ["fit_full", "fit_no_skills", "fit_too_large", "fit_tag_no_skills", "fit_tag_too_large", "bot_too_large", "err_bot_too_large"]) assert.ok(STRINGS[L][k], `${L}.${k}`);
  }
  assert.match(CLIENT_SCRIPT, /kk-fit-bad/);
});

test("fit in the dashboard-voice picker: every assistant has its status, the warning follows the selection, and 'nothing fits' is said in words", async () => {
  const dv = { available: true, bot_id: null, effective_bot_id: "chef" };
  const p = await runPanel({ ...KDEV, bound_bot_id: "chef", stt_profile_id: "stt-a", tts_profile_id: "tts-a" }, { bots: FIT_BOTS, dashboard_voice: dv, postReply: { error: "bot_too_large" } });
  const box = p.document.getElementById("kk-dash");
  const sel = box.querySelector("select");
  const labels = Object.fromEntries([...sel.querySelectorAll("option")].map((o) => [o.value, o.textContent]));
  assert.equal(labels[""], STRINGS.en.dash_voice_auto);
  assert.equal(labels.huge, `Huge — ${STRINGS.en.fit_tag_too_large}`);
  assert.equal(labels.general, `General — ${STRINGS.en.fit_tag_no_skills}`);
  assert.equal(labels.chef, "Chef");
  const line = box.querySelector(".kk-fit");
  assert.equal(line.textContent, "", "Automatic: the line below names who answers");
  assert.ok(box.textContent.includes(STRINGS.en.dash_voice_now.replace("{name}", "Chef")));
  p.choose(sel, "huge");
  assert.equal(line.textContent, STRINGS.en.fit_too_large);
  assert.ok(line.classList.contains("kk-fit-bad"));
  await p.flush();
  assert.equal(box.querySelector(".kk-msg").textContent, STRINGS.en.bot_too_large, "the server's refusal is shown");
  // Automatic with assistants enabled but none that fits.
  const none = await runPanel({ ...KDEV, bound_bot_id: "chef", stt_profile_id: "stt-a", tts_profile_id: "tts-a" }, { bots: FIT_BOTS.filter((b) => b.bot_id === "huge"), dashboard_voice: { available: true, bot_id: null, effective_bot_id: null } });
  const nbox = none.document.getElementById("kk-dash");
  assert.ok(nbox.textContent.includes(STRINGS.en.dash_voice_none_fit));
  assert.ok(nbox.querySelector(".kk-warn"));
  for (const L of ["en", "es"]) { assert.ok(STRINGS[L].dash_voice_none_fit); assert.match(STRINGS[L].dash_voice_auto, L === "en" ? /fits/ : /quepa/); }
});

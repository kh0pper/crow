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
  for (const c of ["turn_busy", "empty_transcript", "audio_too_long", "turn_failed", "tts_error", "acquire_failed"]) keys.add("err_" + c);
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
  const { document, window } = parseHTML(`<html><body><div id="kk-root"><div id="kk-pair"></div><div id="kk-devices"></div></div><script type="application/json" id="kk-strings">${JSON.stringify(STRINGS.en)}</script></body></html>`);
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
    return { status: 200, json: async () => (opts.method === "POST" ? { ok: true } : listing) };
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
  return { bot, stt, sm, tts, vad, save, posts, flush, card };
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

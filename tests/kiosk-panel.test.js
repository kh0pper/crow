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

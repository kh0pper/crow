import { test } from "node:test";
import assert from "node:assert/strict";
import { buildToolDefinitions, SHOW_KINDS, WM_VERBS, MEDIA_VERBS, OUTCOMES, MAX_APPS, MUST_NOTES } from "../bundles/kiosk/server/tools.js";
import { displayPromptSuffix, capsSentence, displayTurnContext } from "../bundles/kiosk/server/prompt.js";
import { createWmStore } from "../bundles/kiosk/server/wm.js";
import { STRINGS } from "../bundles/kiosk/server/strings.js";

const ALL = { windows: ["timer", "recipe", "content"], sources: ["music", "radio", "news"], verbs: [...WM_VERBS, ...MEDIA_VERBS],
  items: [{ id: "lab_dashboard", title: "Lab dashboard" }, { id: "now_playing", title: "Now playing" }] };
const byName = (defs) => Object.fromEntries(defs.map((d) => [d.name, d]));

test("four tools, in a fixed order, each with at most three flat arguments and a one-line description", () => {
  const defs = buildToolDefinitions(ALL);
  assert.deepEqual(defs.map((d) => d.name), ["crow_play", "crow_open", "crow_show", "crow_wm"]);
  for (const d of defs) {
    const props = Object.entries(d.inputSchema.properties);
    assert.ok(props.length <= 3, d.name);
    for (const [k, p] of props) assert.equal(p.type, "string", `${d.name}.${k} is flat`);
    assert.doesNotMatch(d.description, /\n/, `${d.name}: one line`);
    assert.doesNotMatch(JSON.stringify(d), /<[a-z_ ]+>/i, `${d.name}: no angle-bracket placeholder a model could copy`);
    assert.ok(d.description.length <= 240, d.name);
  }
  assert.equal(JSON.stringify(buildToolDefinitions(ALL)), JSON.stringify(defs), "byte-stable for the same session");
});

test("enumerations come from the session: a source, app, kind or verb the display lacks is never offered", () => {
  const t = byName(buildToolDefinitions(ALL));
  assert.deepEqual(t.crow_play.inputSchema.properties.source.enum, ["auto", "music", "radio", "news"]);
  assert.deepEqual(t.crow_play.inputSchema.required, ["what"]);
  assert.deepEqual(t.crow_open.inputSchema.properties.app.enum, ["lab_dashboard", "now_playing", "launcher"]);
  assert.match(t.crow_open.inputSchema.properties.app.description, /lab_dashboard = Lab dashboard/);
  assert.deepEqual(t.crow_show.inputSchema.properties.kind.enum, SHOW_KINDS);
  assert.deepEqual(t.crow_show.inputSchema.required, ["kind", "title", "body"]);
  assert.deepEqual(t.crow_wm.inputSchema.properties.do.enum, [...WM_VERBS, ...MEDIA_VERBS]);
  const radioOnly = byName(buildToolDefinitions({ ...ALL, sources: ["radio", "youtube", "nope"] }));
  assert.deepEqual(radioOnly.crow_play.inputSchema.properties.source.enum, ["auto", "radio"], "unknown sources are dropped");
  const noRecipe = byName(buildToolDefinitions({ ...ALL, windows: ["timer", "content"] }));
  assert.deepEqual(noRecipe.crow_show.inputSchema.properties.kind.enum, ["text", "list", "timer"]);
  assert.ok(!noRecipe.crow_wm.inputSchema.properties.do.enum.includes("next_step"), "no recipe window, no step verbs");
});

test("a tool with nothing to offer is left out: no sources → no crow_play; no items → no crow_open (the WM1a production surface)", () => {
  const defs = buildToolDefinitions({ windows: ["timer", "recipe", "content"], sources: [], items: [], verbs: WM_VERBS });
  assert.deepEqual(defs.map((d) => d.name), ["crow_show", "crow_wm"]);
  assert.deepEqual(byName(defs).crow_wm.inputSchema.properties.do.enum, WM_VERBS);
  assert.deepEqual(buildToolDefinitions({ windows: [], sources: [], items: [], verbs: [] }), []);
});

test("app ids are slugs; a bad id never reaches the model; at most 24 apps with launcher", () => {
  const items = [{ id: "ok_one", title: "One" }, { id: "Bad Id", title: "x" }, { id: "launcher", title: "dup" }, { id: "https://evil.example", title: "y" },
    ...Array.from({ length: 40 }, (_, i) => ({ id: `app_${i}`, title: `App ${i}` }))];
  const en = byName(buildToolDefinitions({ ...ALL, items })).crow_open.inputSchema.properties.app.enum;
  assert.equal(en.length, MAX_APPS + 1);
  assert.equal(en.at(-1), "launcher");
  assert.equal(en.filter((x) => x === "launcher").length, 1);
  assert.ok(en.every((x) => /^[a-z0-9][a-z0-9_:-]{0,39}$/.test(x)));
});

test("OUTCOMES names every outcome a tool may return (they are the log codes)", () => {
  assert.deepEqual(Object.keys(OUTCOMES), ["crow_play", "crow_open", "crow_show", "crow_wm"]);
  for (const list of Object.values(OUTCOMES)) for (const o of list) assert.match(o, /^[a-z][a-z0-9_]{0,31}$/);
  assert.deepEqual(OUTCOMES.crow_show, ["shown", "updated", "invalid"]);
  assert.deepEqual(Object.keys(MUST_NOTES), ["crow_show", "crow_play", "crow_open"]);
  for (const [name, note] of Object.entries(MUST_NOTES)) { assert.match(note, /^\[Display\] /); assert.ok(note.includes(name), name); assert.match(note, /never say/); }
});

test("prompt suffix: static per capability set, names no tool by its old command grammar, carries one capability sentence and no date or time", () => {
  const small = { screen: { w: 800, h: 480, touch: true }, audio: { out: true }, video: "none" };
  const s = displayPromptSuffix(small);
  assert.equal(s, displayPromptSuffix(small), "static");
  assert.match(s, /\[Now\]/);
  assert.match(s, /This display has a small touch screen and a speaker\. It cannot play video\./);
  assert.doesNotMatch(s, /\d{4}|[AP]M\b/);
  assert.doesNotMatch(s, /\| |\|\|/, "no bar grammar");
  assert.equal(capsSentence({ screen: { w: 1920, h: 1080, touch: false }, audio: { out: false }, video: "hd" }), "This display has a screen. It can play video.");
  assert.ok(displayPromptSuffix(null).length >= s.length - 40, "the default (used by the bind-time fit) is not shorter than a real one by more than a few words");
});

test("turn context: names and titles by default; kinds and counts only on a turn that asks for new content", () => {
  const store = createWmStore({ now: () => 0, setTimer: () => ({}), clearTimer: () => {} });
  assert.equal(displayTurnContext(store, "d"), "[Display] Open windows: none.");
  store.open("d", { kind: "content", title: "Fruits", blocks: [] });
  store.open("d", { kind: "timer", name: "Rice", title: "Rice", seconds: 600 });
  assert.equal(displayTurnContext(store, "d"), "[Display] Open windows: content 'Fruits'; timer 'Rice' 10:00 left.");
  assert.equal(displayTurnContext(store, "d", { countsOnly: true }), "[Display] Open windows: 1 card, 1 timer.");
  assert.doesNotMatch(displayTurnContext(store, "d", { countsOnly: true }), /Fruits|Rice/);
  assert.equal(displayTurnContext(store, "d", { media: "Playing: Morning Mix (radio)." }), "[Display] Open windows: content 'Fruits'; timer 'Rice' 10:00 left. Playing: Morning Mix (radio).");
});

test("spoken lines: every say_ line exists in en and es, fits 120 characters with a long title, and has the same placeholders", () => {
  const keys = Object.keys(STRINGS.en).filter((k) => k.startsWith("say_") || k.endsWith("_missed_say"));
  for (const k of ["say_shown", "say_updated", "say_steps_shown", "say_timer_set", "say_timer_set_plain", "say_closed", "say_timer_stopped", "say_all_clear", "say_step", "say_nothing_open", "say_nothing_like_that", "say_open_unavailable", "say_play_unavailable", "say_choices", "play_missed_say", "open_missed_say"]) assert.ok(keys.includes(k), k);
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(",");
  for (const k of keys) { assert.ok(STRINGS.es[k], k); assert.equal(ph(STRINGS.es[k]), ph(STRINGS.en[k]), k); assert.ok(STRINGS.en[k].length <= 90 && STRINGS.es[k].length <= 90, `${k} leaves room for a title`); }
});

test("prompt suffix names only what the display's tools can do: with show and wm alone it never says open or play", () => {
  const small = { screen: { w: 800, h: 480, touch: true }, audio: { out: true }, video: "none" };
  const shipped = displayPromptSuffix(small, ["crow_show", "crow_wm"]);
  assert.match(shipped, /asks to see, time or follow something;/);
  assert.doesNotMatch(shipped, /\b(open|play) something\b|, open|or play/);
  assert.equal(displayPromptSuffix(small), shipped, "the default is the tools every display has");
  assert.match(displayPromptSuffix(small, ["crow_play", "crow_open", "crow_show", "crow_wm"]), /asks to see, time, follow, open or play something;/);
  assert.match(displayPromptSuffix(small, ["crow_play", "crow_show", "crow_wm"]), /asks to see, time, follow or play something;/);
});

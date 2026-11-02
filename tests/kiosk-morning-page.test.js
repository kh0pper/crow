/**
 * Kiosk morning window, PAGE side (For You §13): the card the display draws from the contract's window object —
 * weather, up to three headlines and today's move, large type, plain text only. Loaded through createWindowView
 * exactly as tests/kiosk-page.test.js does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { createWindowView, morningHighLow } from "../bundles/kiosk/public/wm-view.js";
import { STRINGS } from "../bundles/kiosk/server/strings.js";

const PUB = new URL("../bundles/kiosk/public/", import.meta.url);
const read = (f) => readFileSync(new URL(f, PUB), "utf8");
const t = (k) => STRINGS.en[k] ?? k;

/** The contract's window object; a test overrides only the part it is about. */
const WINDOW = {
  id: "morning-1", kind: "morning", title: "Morning",
  weather: { temp: 18, high: 24, low: 12, unit: "F", label: "Mostly cloudy" },
  move: { title: "Walk the dog", minutes: 20 },
  headlines: [
    { title: "The ferry runs again", source: "Harbor News" },
    { title: "Library reopens today", source: "Town Crier" },
    { title: "Rain by Friday", source: "Weather Desk" },
  ],
  updated_at: 1_700_000_000_000,
};

function mount() {
  const { document, window } = parseHTML("<div id=w></div>");
  const root = document.getElementById("w");
  const dismissed = [];
  const view = createWindowView(root, { t, now: () => 0, onDismiss: (id) => dismissed.push(id) });
  const open = (w) => view.apply({ action: "open", window: w });
  return { document, window, root, view, dismissed, open };
}

const texts = (root, sel) => [...root.querySelectorAll(sel)].map((e) => e.textContent);

test("a full morning window: the temperature and its unit, the label, high/low, the move with its minutes, three headlines with their sources", () => {
  const { root, open } = mount();
  open(WINDOW);
  const card = root.querySelector("article.k-win-morning");
  assert.ok(card, "the card carries the morning kind, so its CSS hook exists");
  assert.equal(card.querySelector(".k-win-title").textContent, "Morning", "the title sits above everything else");
  assert.equal(card.querySelector(".k-morning-temp").textContent, "18°F");
  assert.equal(card.querySelector(".k-morning-sky").textContent, "Mostly cloudy");
  assert.equal(card.querySelector(".k-morning-hilo").textContent, "High 24° · Low 12°");
  assert.deepEqual(texts(root, ".k-win-morning .k-sub"), ["Today's move", "Headlines"], "the two sub-headings are the page's own strings");
  assert.equal(card.querySelector(".k-morning-move").textContent, "Walk the dog");
  assert.equal(card.querySelector(".k-morning-minutes").textContent, "20 min");
  assert.deepEqual(texts(root, ".k-morning-headline"), ["The ferry runs again", "Library reopens today", "Rain by Friday"]);
  assert.deepEqual(texts(root, ".k-morning-source"), ["Harbor News", "Town Crier", "Weather Desk"]);
  assert.equal(card.querySelector(".k-morning-empty"), null, "a full card says nothing about being empty");
  assert.equal(root.querySelectorAll("a,img,picture,svg,input,textarea").length, 0, "text only: no links, images or fields");
  assert.equal(root.querySelectorAll("button").length, 1, "the card's own close button is the only control");
  assert.equal(root.querySelector("button").className, "k-win-close");
});

test("weather, move and headlines all empty → the one empty line, and nothing else", () => {
  const { root, open } = mount();
  open({ ...WINDOW, weather: null, move: null, headlines: [] });
  const card = root.querySelector("article.k-win-morning");
  const lines = [...card.children].filter((e) => !e.classList.contains("k-win-close"));
  assert.deepEqual(lines.map((e) => e.className), ["k-win-title", "k-morning-empty"], "the title and the one line");
  assert.equal(card.querySelector(".k-morning-empty").textContent, "Nothing for this morning yet.");
  assert.equal(card.querySelector(".k-sub"), null, "no empty sub-headings");
  assert.equal(card.querySelector(".k-morning-weather, .k-morning-news, .k-morning-move"), null);
});

test("a headline title of <b>x</b> is literal text: the card gets no b child (everything goes through textContent)", () => {
  const { root, open } = mount();
  open({
    ...WINDOW,
    weather: { temp: null, high: null, low: null, unit: "C", label: "<b>gray</b>" },
    move: { title: "<img src=x onerror=alert(1)>", minutes: null },
    headlines: [{ title: "<b>x</b>", source: "<script>alert(1)</script>" }],
  });
  assert.equal(root.querySelectorAll("b,img,script,i,svg").length, 0, root.innerHTML);
  assert.equal(root.querySelector(".k-morning-headline").textContent, "<b>x</b>");
  assert.equal(root.querySelector(".k-morning-source").textContent, "<script>alert(1)</script>");
  assert.equal(root.querySelector(".k-morning-sky").textContent, "<b>gray</b>");
  assert.equal(root.querySelector(".k-morning-move").textContent, "<img src=x onerror=alert(1)>");
  assert.ok(!root.innerHTML.includes("<b>"), "escaped in serialised markup");
  assert.equal(root.querySelector(".k-morning-temp"), null, "no number when temp is null");
  assert.equal(root.querySelector(".k-morning-hilo"), null, "no high/low line when both numbers are missing");
  assert.equal(root.querySelector(".k-morning-minutes"), null, "no minutes when they are not a number");
});

test("a partial weather row leaves only the missing part out; zero is a temperature, not a gap", () => {
  const { root, open } = mount();
  open({ ...WINDOW, weather: { temp: null, high: 24, low: null, unit: "C", label: "Sunny" }, move: null, headlines: [] });
  assert.equal(root.querySelector(".k-morning-temp"), null);
  assert.equal(root.querySelector(".k-morning-sky").textContent, "Sunny");
  assert.equal(root.querySelector(".k-morning-hilo").textContent, "High 24°");
  assert.equal(root.querySelector(".k-morning-empty"), null, "a weather row is something to show");
  open({ ...WINDOW, weather: { temp: 0, high: null, low: -3, unit: "C", label: "" }, move: null, headlines: [] });
  assert.equal(root.querySelector(".k-morning-temp").textContent, "0°C");
  assert.equal(root.querySelector(".k-morning-hilo").textContent, "Low -3°");
  assert.equal(root.querySelector(".k-morning-sky"), null, "no empty label line");
  assert.equal(morningHighLow((k) => STRINGS.es[k] ?? k, { high: 1, low: 2 }), "Máx 1° · Mín 2°", "es fills the same template");
});

test("the card is still dismissable like the others: its close button reports the dismiss, and a tap on the text does not", () => {
  const { root, window, open, dismissed } = mount();
  open(WINDOW);
  root.querySelector("article").dispatchEvent(new window.Event("click"));
  assert.deepEqual(dismissed, [], "a tap on an ordinary window is not a dismiss");
  root.querySelector(".k-win-close").dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.deepEqual(dismissed, ["morning-1"]);
});

test("kiosk.js reports the morning kind in CAPS.kinds (the server takes the lesser of this and the display's profile)", () => {
  const src = read("kiosk.js");
  const at = src.indexOf("const CAPS");
  assert.ok(at > 0, "the caps literal is the page's build description");
  const lit = src.slice(at, src.indexOf("};", at) + 2);
  assert.match(lit, /kinds: \["card", "timer", "nowplaying", "morning"\]/);
});

test("en and es both carry the four morning strings, with the same placeholders in the high/low template", () => {
  for (const L of ["en", "es"]) {
    for (const k of ["morning_move", "morning_news", "morning_empty", "morning_hilo"]) assert.ok(STRINGS[L][k], `${L}.${k}`);
    assert.deepEqual((STRINGS[L].morning_hilo.match(/\{\w+\}/g) || []).sort(), ["{high}", "{low}"]);
  }
  assert.equal(STRINGS.en.morning_move, "Today's move");
  assert.equal(STRINGS.es.morning_move, "Movimiento de hoy");
  assert.equal(STRINGS.en.morning_news, "Headlines");
  assert.equal(STRINGS.es.morning_news, "Titulares");
  assert.equal(STRINGS.en.morning_empty, "Nothing for this morning yet.");
  assert.equal(STRINGS.es.morning_empty, "Todavía no hay nada para esta mañana.");
});

test("kiosk.css: a .k-win-morning card in large type, at most three headlines visible, and compact variants", () => {
  const css = read("kiosk.css");
  const at = css.indexOf("/* Morning (For You");
  assert.ok(at >= 0, "the morning block is in kiosk.css");
  const block = css.slice(at);
  // Every top-level rule of the block, with grouped selectors split: selector → its declarations joined.
  const decls = (src) => {
    const map = new Map();
    for (const m of src.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      for (const sel of m[1].replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((x) => x.trim()).filter(Boolean)) {
        map.set(sel, (map.get(sel) || "") + ";" + m[2]);
      }
    }
    return map;
  };
  const top = decls(block.slice(0, block.indexOf("@media")));
  const rule = (sel) => { assert.ok(top.has(sel), sel); return top.get(sel); };
  assert.match(rule(".k-win-morning"), /display:\s*grid/);
  assert.match(rule(".k-morning-temp"), /font-size:\s*4rem/, "the temperature reads across the room");
  assert.match(rule(".k-morning-move"), /font-size:\s*1\.6rem/, "so does today's move");
  assert.match(rule(".k-morning-news li"), /font-size:\s*1\.6rem/, "and the headlines");
  assert.match(rule(".k-morning-news li"), /overflow-wrap:\s*anywhere/, "a long headline never scrolls the card sideways");
  assert.match(rule(".k-morning-source"), /font-size:\s*\.6em/, "the source is the smaller line");
  assert.match(rule(".k-morning-source"), /color:\s*var\(--k-dim\)/);
  assert.match(rule(".k-morning-news li:nth-child(n+4)"), /display:\s*none/, "at most three headlines are visible");
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/, "calm: the existing --k-* tokens only, no new hard-coded colours");
  // Compact rules: the phone query, and the short Pi 7" (800×480) landscape; each steps the temperature down.
  const media = (q) => { const i = block.search(q); assert.ok(i >= 0, String(q)); return block.slice(i, block.indexOf("}}", i) + 2); };
  assert.match(media(/@media \(max-width:\s*599px\)/), /\.k-morning-temp\{font-size:3rem\}/);
  assert.match(media(/@media \(max-height:\s*520px\) and \(min-width:\s*600px\)/), /\.k-morning-temp\{font-size:3\.2rem\}/);
});

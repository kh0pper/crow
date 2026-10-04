import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { parseHTML } from "linkedom";
import { ASSETS } from "../bundles/kiosk/server/runtime.js";
import { classifySwipe, formatRemaining, createWindowView } from "../bundles/kiosk/public/wm-view.js";

const PUB = new URL("../bundles/kiosk/public/", import.meta.url);
const files = readdirSync(PUB);
const read = (f) => readFileSync(new URL(f, PUB), "utf8");
// Served by runtime.js outside the ASSETS whitelist: generated (theme, strings) or read from Ramble (bird engine).
const GENERATED = new Set(["theme.css", "strings.js", "bird-svg.js"]);

test("idle DOM: no video/iframe, no inline script/style (CSP), bird engine then module entry", () => {
  const html = read("kiosk.html");
  const { document } = parseHTML(html);
  assert.equal(document.querySelectorAll("video,iframe").length, 0);
  const scripts = [...document.querySelectorAll("script")];
  assert.deepEqual(scripts.map((s) => [s.getAttribute("src"), s.getAttribute("type")]), [["/display/assets/bird-svg.js", null], ["/display/assets/kiosk.js", "module"]]);
  assert.deepEqual([...document.querySelectorAll("link[rel=stylesheet]")].map((l) => l.getAttribute("href")), ["/display/assets/theme.css", "/display/assets/kiosk.css"]);
  assert.doesNotMatch(html, /\sstyle=/);
  for (const id of ["bird", "bird-art", "mic", "captions", "cap-user", "cap-bot", "windows", "pairing", "pair-code", "banner", "clock"]) assert.ok(document.getElementById(id), id);
});

test("ruling F1: the page lives at /display — no page file references the maker-lab-owned /kiosk/ path; every /display/assets URL is served", () => {
  for (const f of files) {
    const src = read(f);
    assert.doesNotMatch(src.replaceAll("/api/kiosk/", ""), /["'`(]\/kiosk\//, `${f} references /kiosk/`);
    for (const m of src.matchAll(/\/display\/assets\/([\w.-]+)/g)) assert.ok(Object.hasOwn(ASSETS, m[1]) || GENERATED.has(m[1]), `${f} → ${m[1]} is not served`);
  }
  assert.match(read("audio.js"), /addModule\("\/display\/assets\/pcm-worklet\.js"\)/);
  assert.match(read("kiosk.js"), /\/api\/kiosk\/session/, "the WS path is unchanged");
  assert.match(read("kiosk.js"), /\/api\/kiosk\/pair\/start/, "the pair API is unchanged");
});

test("no requestAnimationFrame and no video/iframe creation anywhere in the page code", () => {
  for (const f of files.filter((x) => x.endsWith(".js"))) {
    const src = read(f);
    assert.doesNotMatch(src, /requestAnimationFrame/, f);
    assert.doesNotMatch(src, /createElement\(\s*["'](video|iframe)["']/, f);
    assert.doesNotMatch(src, /innerHTML\s*=(?!\s*RB\.drawBird)/, `${f}: innerHTML only for the bird engine's own SVG`);
    assert.doesNotMatch(src, /insertAdjacentHTML|outerHTML\s*=|document\.write/, f);
  }
});

test("page weight ≤ 80 KB (html + css + js, uncompressed)", () => {
  const total = files.reduce((n, f) => n + statSync(new URL(f, PUB)).size, 0);
  assert.ok(total <= 80 * 1024, `page is ${total} bytes`);
});

test("every relative import resolves to a whitelisted asset", () => {
  for (const f of files.filter((x) => x.endsWith(".js"))) {
    for (const m of read(f).matchAll(/from\s+["']\.\/([\w.-]+)["']/g)) assert.ok(Object.hasOwn(ASSETS, m[1]) || m[1] === "strings.js", `${f} imports ${m[1]}`);
  }
  for (const f of files.filter((x) => x !== "kiosk.html")) assert.ok(Object.hasOwn(ASSETS, f), `${f} is served`);
});

test("CSS: reduced motion honoured, 56 px touch targets, 20 px body text, phone single column", () => {
  const css = read("kiosk.css");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.no-anim/);
  assert.match(css, /min-height:\s*56px/);
  assert.match(css, /font-size:\s*20px/);
  assert.match(css, /@media \(max-width: 599px\)/);
});

test("CSS never transforms hook groups that carry an SVG transform attribute; idle animates only the HTML wrapper", () => {
  const css = read("kiosk.css");
  assert.doesNotMatch(css, /\.rb-(bird|wing|tail)\b/);
  assert.doesNotMatch(css, /\.rb-beak(?!-lower)\b/);
  assert.match(css, /\.is-idle \.k-bird-art\s*\{[^}]*animation/);
  assert.doesNotMatch(css, /\.is-idle [^{]*\.rb-/, "nothing inside the SVG animates at idle");
});

test("swipe + countdown helpers", () => {
  assert.equal(classifySwipe({ dx: -90, dy: 5, dt: 400 }), "left");
  assert.equal(classifySwipe({ dx: 40, dy: 2, dt: 50 }), "right", "fast fling");
  assert.equal(classifySwipe({ dx: 40, dy: 2, dt: 400 }), null);
  assert.equal(classifySwipe({ dx: 100, dy: 200, dt: 100 }), null, "vertical scroll is not a dismiss");
  assert.equal(formatRemaining(61_001), "1:02");
});

test("window view: one visible window + tab rail; text only (no markup injection); close button dismisses", (t) => {
  const { document, window } = parseHTML("<div id=w></div>");
  const root = document.getElementById("w");
  const dismissed = [];
  const v = createWindowView(root, { t: (k) => k, onDismiss: (id) => dismissed.push(id), now: () => 0 });
  t.after(() => v.apply({ action: "close_all" }));   // a failed assertion must not leave the 1 Hz timer tick holding the run open
  v.apply({ action: "snapshot", windows: [
    { id: "content-1", kind: "content", title: "<img src=x onerror=alert(1)>", blocks: [{ type: "heading", text: "x" }, { type: "text", text: "<b>hi</b>" }, { type: "list", items: ["a", "b"] }] },
    { id: "recipe-2", kind: "recipe", title: "Lasagna", ingredients: ["noodles"], steps: ["Boil", "Layer"], step: 1 },
  ] });
  assert.equal(root.querySelectorAll("article").length, 1);
  assert.equal(root.querySelector("article").dataset.id, "recipe-2");
  assert.equal(root.querySelectorAll(".k-tabs button").length, 2);
  assert.equal(root.querySelector(".k-steps .is-current").textContent, "Layer");
  v.apply({ action: "focus", id: "content-1" });
  assert.equal(root.querySelectorAll("img,b").length, 0, "markup arrives as text");
  root.querySelector(".k-win-close").dispatchEvent(new window.Event("click"));
  assert.deepEqual(dismissed, ["content-1"]);
  v.apply({ action: "open", window: { id: "timer-3", kind: "timer", title: "Tea", name: "Tea", ends_at: 61_001, done: false } });
  assert.equal(root.querySelector(".k-timer").textContent, "1:02");
  v.apply({ action: "timer_done", id: "timer-3" });
  assert.ok(root.querySelector("article").classList.contains("is-done"));
  v.apply({ action: "close_all" });
  assert.equal(root.hidden, true);
});

test("Task 8 carry: every model-supplied string (title, name, blocks, ingredients, steps, tab labels) renders as TEXT", (t) => {
  const { document } = parseHTML("<div id=w></div>");
  const root = document.getElementById("w");
  const X = "<img src=x onerror=alert(1)>";
  const v = createWindowView(root, { t: (k) => k, now: () => 0 });
  t.after(() => v.apply({ action: "close_all" }));
  v.apply({ action: "snapshot", windows: [
    { id: "content-1", kind: "content", title: X, blocks: [{ type: "text", text: X }, { type: "list", items: [X] }, { type: "card", title: X }] },
    { id: "recipe-2", kind: "recipe", title: X, ingredients: [X], steps: [X, X], step: 0 },
    { id: "timer-3", kind: "timer", title: X, name: X, ends_at: 5000, done: false },
  ] });
  const check = () => {
    assert.equal(root.querySelectorAll("img,script,b,svg").length, 0, root.innerHTML);
    assert.ok(!root.innerHTML.includes("<img"), "escaped in serialised markup");
  };
  check();
  assert.ok([...root.querySelectorAll(".k-tabs button")].every((b) => b.textContent === X), "tab labels are text");
  assert.equal(root.querySelector(".k-win-title").textContent, X);
  v.apply({ action: "focus", id: "recipe-2" }); check();
  assert.equal(root.querySelector(".k-ingredients li").textContent, X);
  assert.equal(root.querySelector(".k-steps .is-current").textContent, X);
  v.apply({ action: "focus", id: "content-1" }); check();
  assert.equal(root.querySelector("article p").textContent, X);
  v.apply({ action: "update", window: { id: "content-1", kind: "content", title: "ok", blocks: [{ type: "text", text: "<script>alert(1)</script>" }] } }); check();
});

// Final-review item 1 (page half): once a turn ends — including a no_speech
// timeout — no further PCM frame leaves the page.
test("ending a turn (no_speech included) stops the frame upload: onFrame gates on turn.ended, endTurn sets it and stops the mic", () => {
  const src = read("kiosk.js");
  const onFrame = src.slice(src.indexOf("function onFrame("), src.indexOf("async function startTurn("));
  assert.match(onFrame, /^function onFrame\([^)]*\) \{\s*if \(!turn \|\| turn\.ended\) return;/, "the gate precedes ws.send");
  assert.ok(onFrame.indexOf("turn.ended) return") < onFrame.indexOf("ws.send(pcm)"));
  const endTurn = src.slice(src.indexOf("function endTurn("), src.indexOf("function report("));
  const iEnded = endTurn.indexOf("turn.ended = true"), iStop = endTurn.indexOf("mic?.stop()"), iSend = endTurn.indexOf('type: "turn_end"');
  assert.ok(iEnded > 0 && iStop > iEnded && iSend > iStop, "ended + mic stop happen before turn_end is sent");
  assert.match(src.slice(src.indexOf("function startTurn"), src.indexOf("function endTurn")), /noSpeechMs/, "the no-speech timeout ends the turn through the VAD → endTurn");
});

test("smoke A1 (2026-10-04): [hidden] beats class display — the pairing overlay and #windows really hide", () => {
  const css = read("kiosk.css");
  assert.match(css, /(^|\n)\s*\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/, "kiosk.css needs [hidden]{display:none !important}");
  // Every element the HTML ships hidden (or the JS toggles) whose class sets a display value is covered by that rule.
  const { document } = parseHTML(read("kiosk.html"));
  const hiddenEls = [...document.querySelectorAll("[hidden]")];
  for (const id of ["pairing", "windows"]) assert.ok(hiddenEls.some((el) => el.id === id), `#${id} ships hidden`);
  for (const el of hiddenEls) {
    for (const cls of el.classList) {
      const rule = css.match(new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`));
      if (rule && /display\s*:/.test(rule[1])) assert.doesNotMatch(rule[1], /!important/, `.${cls} display must not out-rank [hidden]`);
    }
  }
  // After approval the page hides the overlay via the attribute (which the CSS rule now honours).
  assert.match(read("kiosk.js"), /j\.state === "approved"[^\n]*\$\("pairing"\)\.hidden = true/);
});

test("smoke 2026-10-04 item 7: every banner/caption write is recorded; a long press on the clock shows the ring; the ring element ships hidden", () => {
  const src = read("kiosk.js");
  const sets = src.split("\n").filter((l) => /\$\("cap-bot"\)\.textContent = /.test(l));
  for (const l of sets) assert.match(l, /note\(/, `every cap-bot write is noted: ${l.trim()}`);
  // Privacy: user/assistant words never enter the ring (lengths only).
  assert.match(src, /note\("transcript", `\$\{\(m\.text \|\| ""\)\.length\} chars`\)/);
  assert.doesNotMatch(src, /note\("transcript", m\.text/);
  assert.doesNotMatch(src, /note\("caption:reply", m\.text/);
  assert.match(src, /function banner\(key\) \{[^\n]*note\("banner"/);
  assert.match(src, /function setBird\(s\) \{\s*if \(s !== birdState\) note\("bird"/);
  assert.match(src, /\$\("clock"\)\.addEventListener\("pointerdown"[^\n]*700\)/);
  assert.match(src, /case "error":\s*note\("error"/);
  const { document } = parseHTML(read("kiosk.html"));
  const dbg = document.getElementById("debug");
  assert.ok(dbg && dbg.hasAttribute("hidden"), "#debug ships hidden");
  assert.doesNotMatch(src, /debug"\)\.innerHTML/, "rendered as text");
});

test("lever D: the page reports speech_pause from the VAD and the bytes sent at the last voiced frame on turn_end", () => {
  const src = read("kiosk.js");
  const onFrame = src.slice(src.indexOf("function onFrame("), src.indexOf("async function startTurn("));
  assert.match(onFrame, /turn\.sentBytes \+= /);
  assert.match(onFrame, /if \(r\.voiced\) turn\.voicedBytes = turn\.sentBytes;/);
  assert.match(onFrame, /if \(r\.pause\) send\(\{ type: "speech_pause" \}\);/);
  assert.ok(onFrame.indexOf("r.pause") < onFrame.indexOf("r.end"), "the pause is sent before a same-frame end");
  assert.match(src, /send\(\{ type: "turn_end", vad_reason: reason, voiced_bytes: turn\.voicedBytes \}\);/);
});

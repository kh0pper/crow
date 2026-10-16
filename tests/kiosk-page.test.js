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

// Fetched only through kiosk.js's dynamic import(), never part of a plain page load: agent-link.js + speaker-view.js by a
// Pi launched with ?agent=1 (DV13), bar-link.js by a dashboard session frame opened with ?bar=1 (B3; a Pi never fetches it).
const LAZY = new Set(["agent-link.js", "speaker-view.js", "bar-link.js"]);

// 82 → 88 KB (2026-10-15, queue item 21): the B3 mic-release start gate now, the player-bar link next (~+7 KB once, cached on a Pi 3).
// 80 → 82 KB (2026-10-15, queue item 18): the page was at 80,853 of 81,920 bytes; the DV13 speaker chip's eager part
// (its slot, its CSS and the ?agent=1 gate, ~1.2 KB) does not fit. The chip's code itself stays out of the count (LAZY).
test("page weight ≤ 88 KB (html + css + eagerly loaded js, uncompressed); the agent-only and bar-only modules are loaded on demand", () => {
  const total = files.filter((f) => !LAZY.has(f)).reduce((n, f) => n + statSync(new URL(f, PUB)).size, 0);
  assert.ok(total <= 88 * 1024, `page is ${total} bytes`);
  for (const f of files.filter((x) => x.endsWith(".js"))) {
    for (const m of read(f).matchAll(/from\s+["']\.\/([\w.-]+)["']/g)) assert.ok(!LAZY.has(m[1]), `${f} imports ${m[1]} eagerly`);
  }
  for (const f of LAZY) assert.ok(files.includes(f), f);
});

test("item 21 (source): a media load marks the turn and lets an idle open mic go BEFORE the view sees it; the settle release stamps the time and kicks a held start; the view's start asks mediaStartGate and notes each real start", () => {
  const src = read("kiosk.js");
  const media = src.slice(src.indexOf('case "media":'), src.indexOf("mediaView?.apply(m);") + 20);
  assert.match(media, /if \(\(m\.action === "load" && !m\.paused\) \|\| m\.action === "play"\) \{ if \(turn\) turn\.mediaLoaded = true; micForMedia\(\); \}/, "a resume counts too (review minor 1)");
  assert.ok(media.indexOf("micForMedia()") < media.indexOf("mediaView?.apply(m)"), "the mic goes before the view tries to start");
  const rel = src.slice(src.indexOf("function releaseMicAfterTurn("), src.indexOf("/** turn_metrics, once per turn"));
  assert.match(rel, /micReleasedAt = performance\.now\(\)/);
  assert.match(rel, /mediaView\?\.kick\(\)/);
  const mfm = src.slice(src.indexOf("function micForMedia("), src.indexOf("function releaseMicAfterTurn("));
  assert.match(mfm, /releaseForMediaDecision\(\{ config, micOpen: !!mic \|\| micGate\.opening\(\), turnOpen: !!\(turn && !\(turn\.ended && turn\.done\)\), playing: !!player\?\.playing \}\)/);
  assert.match(mfm, /micGate\.release\(\)/);
  assert.match(mfm, /micReleasedAt = performance\.now\(\)/);
  assert.match(mfm, /mediaView\?\.kick\(\)/, "a held start goes at once, not on its next poll (review minor 2)");
  const ens = src.slice(src.indexOf("const d = micDecision(null, ctx.state);"), src.indexOf("banner(null);"));
  assert.match(ens, /if \(config\.mic_per_turn\) \{ micGate\.release\(\); captureEnded\(\); mic = null; micReleasedAt = performance\.now\(\); pauseOutput\(\); \}/, "no turn after needs_gesture: the phone's mic is not left open (review minor 3)");
  assert.match(src, /canStart: \(\) => \{ const g = mediaStartGate\(\{ micOpen: !!mic, micOpening: micGate\.opening\(\), releasedAt: micReleasedAt, now: performance\.now\(\), config \}\); return g\.ok \|\| g\.waitMs; \}/);
  assert.match(src, /onPlay: \(\) => note\("media", `start mic=\$\{mic \|\| micGate\.opening\(\) \? "open" : "closed"\}`\)/);
  const drained = /onDrained: \(\) => \{([^}]*)\}/.exec(src)[1];
  assert.match(drained, /if \(turn\) settle\(turn\); else micForMedia\(\);/, "TTS with no turn (G12): the drain lets the mic go");
});

test("every relative import resolves to a whitelisted asset", () => {
  for (const f of files.filter((x) => x.endsWith(".js"))) {
    for (const m of read(f).matchAll(/from\s+["']\.\/([\w.-]+)["']/g)) assert.ok(Object.hasOwn(ASSETS, m[1]) || m[1] === "strings.js", `${f} imports ${m[1]}`);
  }
  for (const f of files.filter((x) => x !== "kiosk.html")) assert.ok(Object.hasOwn(ASSETS, f), `${f} is served`);
  for (const f of files.filter((x) => x.endsWith(".js"))) {
    for (const m of read(f).matchAll(/import\(\s*["']\.\/([\w.-]+)["']\s*\)/g)) assert.ok(Object.hasOwn(ASSETS, m[1]), `${f} imports ${m[1]} on demand`);
  }
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

test("a finished timer: one tap anywhere on the card dismisses it (once, through onDismiss), it says so, and the page tint follows it", (t) => {
  const { document, window } = parseHTML("<html><body><div id=w></div></body></html>");
  const root = document.getElementById("w");
  const dismissed = [];
  const v = createWindowView(root, { t: (k) => ({ timer_done: "Time's up", timer_tap_dismiss: "Tap to dismiss" })[k] || k, onDismiss: (id) => dismissed.push(id), now: () => 0 });
  t.after(() => v.apply({ action: "close_all" }));
  v.apply({ action: "open", window: { id: "timer-1", kind: "timer", title: "Tea", name: "Tea", ends_at: 60_000, done: false } });
  assert.equal(document.documentElement.classList.contains("k-ringing"), false, "a running timer does not tint the page");
  root.querySelector("article").dispatchEvent(new window.Event("click"));
  assert.deepEqual(dismissed, [], "a tap on a RUNNING timer does not dismiss it");
  assert.equal(root.querySelector(".k-tap-dismiss"), null);
  v.apply({ action: "timer_done", id: "timer-1" });
  const card = root.querySelector("article.is-done");
  assert.equal(card.querySelector(".k-tap-dismiss").textContent, "Tap to dismiss");
  assert.equal(card.getAttribute("role"), "button");
  assert.equal(document.documentElement.classList.contains("k-ringing"), true);
  card.querySelector(".k-timer").dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.deepEqual(dismissed, ["timer-1"], "a tap on the text inside the card dismisses it");
  assert.equal(root.querySelectorAll("article").length, 0);
  assert.equal(root.hidden, true);
  assert.equal(document.documentElement.classList.contains("k-ringing"), false, "the tint goes with it");
  card.dispatchEvent(new window.Event("click"));
  assert.deepEqual(dismissed, ["timer-1"], "a second event from the same gesture is not a second dismiss");
});

test("a finished timer's close button and a tap on its card are one dismiss, not two", (t) => {
  const { document, window } = parseHTML("<html><body><div id=w></div></body></html>");
  const root = document.getElementById("w");
  const dismissed = [];
  const v = createWindowView(root, { t: (k) => k, onDismiss: (id) => dismissed.push(id), now: () => 0 });
  t.after(() => v.apply({ action: "close_all" }));
  v.apply({ action: "snapshot", windows: [
    { id: "recipe-2", kind: "recipe", title: "Soup", ingredients: [], steps: ["Boil"], step: 0 },
    { id: "timer-1", kind: "timer", title: "Tea", name: "Tea", ends_at: 0, done: true },
  ] });
  assert.equal(document.documentElement.classList.contains("k-ringing"), true, "a snapshot with a finished timer tints the page (a reopened overlay)");
  root.querySelector(".k-win-close").dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.deepEqual(dismissed, ["timer-1"]);
  assert.equal(root.querySelector("article").dataset.id, "recipe-2", "the next window shows");
  root.querySelector("article").dispatchEvent(new window.Event("click"));
  assert.deepEqual(dismissed, ["timer-1"], "a tap on an ordinary window does not dismiss it");
  assert.equal(document.documentElement.classList.contains("k-ringing"), false);
});

test("CSS: a finished timer is never a full-screen layer; the talk button sits above windows; in session mode a window's close button is top-LEFT", () => {
  const css = read("kiosk.css");
  const rule = (sel) => { const i = css.indexOf(sel + " {"); assert.ok(i >= 0, sel); return css.slice(i, css.indexOf("}", i)); };
  const done = rule(".k-win-timer.is-done");
  assert.doesNotMatch(done, /position:\s*fixed|inset:/, "the finished card stays in its pane, so the bird and the talk button are not covered");
  assert.match(done, /cursor:\s*pointer/);
  assert.match(rule(".k-mic"), /z-index:\s*\d/);
  assert.match(css, /html\.k-ringing, html\.k-ringing body \{[^}]*background/);
  const sClose = rule('[data-mode="session"] .k-win-close');
  assert.match(sClose, /left:\s*4px/);
  assert.match(sClose, /right:\s*auto/);
  assert.match(rule('[data-mode="session"] .k-win'), /padding:\s*16px 20px 16px 64px/, "the title makes room on the left");
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

test("the debug list shows each tool call's outcome for the turn (name:code from turn_done — no arguments, no text)", () => {
  const src = read("kiosk.js");
  const done = src.slice(src.indexOf('case "turn_done":'), src.indexOf('case "error":'));
  assert.match(done, /m\.timings\?\.tools/);
  assert.match(done, /note\("tools", toolsLine\(m\.timings\)\)/);
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

// ---- Session mode (the dashboard's Talk to Crow overlay, /display/session) ----

test("session mode: no pairing and no stored token — the socket is the dashboard session's, and hello echoes the CSRF cookie", () => {
  const src = read("kiosk.js");
  assert.match(src, /const SESSION = document\.documentElement\.dataset\.mode === "session";/);
  const connect = src.slice(src.indexOf("function connect()"), src.indexOf("const send = "));
  assert.match(connect, /const id = SESSION \? null : ls\.get\(LS_DEV\), tok = SESSION \? null : ls\.get\(LS_TOK\);/, "session mode never reads a device token");
  assert.match(connect, /if \(!SESSION && \(!id \|\| !tok\)\) \{ pair\(\); return; \}/, "session mode never pairs");
  assert.match(connect, /\/api\/kiosk\/session\$\{SESSION \? "\/dashboard" : ""\}/);
  assert.match(connect, /\{ type: "hello", mode: "session", csrf: cookie\("crow_csrf"\), caps: CAPS, tz: TZ, owner: barOwner \}/, "session mode reports the browser's time zone too (and, in bar mode, the tab's owner nonce)");
  assert.match(connect, /closeDecision\(ev\.code, ev\.reason, SESSION \? "session" : "paired"\)/);
  assert.doesNotMatch(src, /ls\.set\([^)]*\)[^\n]*SESSION|SESSION[^\n]*ls\.set\(/, "nothing is stored for a session display");
  assert.doesNotMatch(read("kiosk.html"), /data-mode/, "the mode is stamped by the server on /display/session only");
});

test("session mode: the dashboard can stop the mic, audio and socket at once; Escape inside the frame asks the dashboard to close", () => {
  const src = read("kiosk.js");
  const block = src.slice(src.indexOf("if (SESSION) {\n  // The dashboard closes the overlay"));
  assert.ok(block.length > 100, "session block present");
  const rel = block.slice(block.indexOf("window.crowKioskRelease"), block.indexOf("document.addEventListener(\"keydown\""));
  for (const needle of ["halted = true", "clearTimeout(reconnectTimer)", "releaseAudio(", "ctx?.close()", "s?.close(1000"]) assert.ok(rel.includes(needle), needle);
  assert.match(block, /e\.key === "Escape" && window\.parent !== window\) window\.parent\.postMessage\("crow-talk-close", location\.origin\)/, "posted to this origin only, never '*'");
  const release = src.slice(src.indexOf("function releaseAudio("), src.indexOf("function setBird("));
  assert.ok(release.length > 50);
  for (const needle of ["micGate.release()", "player?.flush()", "ctx?.suspend()"]) assert.ok(release.includes(needle), needle);   // the mic goes through the one gate (review H3)
  assert.doesNotMatch(src, /postMessage\([^)]*["']\*["']\)/);
});

test("session mode: 'no assistant' links to the Kiosk panel in the top window; the link is built with DOM calls", () => {
  const src = read("kiosk.js");
  assert.match(src, /a\.href = "\/dashboard\/kiosk"; a\.target = "_top"; a\.textContent = t\("session_bot_link"\)/);
  // Which banner an error frame shows is decided in state.js (errorDecision, unit-tested): in session
  // mode both "no assistant" and "assistant too large" show session_no_bot — the banner that gets this link.
  assert.match(src, /errorDecision\(m\.code, m\.recoverable, SESSION \? "session" : "paired"\); if \(d\.banner\) banner\(d\.banner\)/);
  assert.match(src, /if \(key === "session_no_bot"\) b\.append\(" ", kioskPanelLink\(\)\)/);
  const css = read("kiosk.css");
  assert.match(css, /\[data-mode="session"\] \.k-banner\s*\{[^}]*right:/, "the banner leaves room for the dashboard's close button");
  assert.match(css, /\[data-mode="session"\] \.k-top\s*\{[^}]*padding-right:/);
});

test("the page reports caps v2: screen, audio, the kinds this build draws; no kind it cannot draw", () => {
  const src = read("kiosk.js");
  const at = src.indexOf("const CAPS");
  const lit = src.slice(at, src.indexOf("};", at) + 2);
  assert.match(lit, /v: 2/);
  assert.match(lit, /kinds: \["card", "timer", "nowplaying"\]/);
  assert.match(lit, /screen: \{ w: screen\.width, h: screen\.height/);
  assert.doesNotMatch(lit, /"media"|"app"|"camera"/);
});

test("media: one <audio> element (preload none) and a now-playing chip that [hidden] hides; media-view is served and small", () => {
  const { document } = parseHTML(read("kiosk.html"));
  const audios = document.querySelectorAll("audio");
  assert.equal(audios.length, 1);
  assert.equal(audios[0].id, "media");
  assert.equal(audios[0].getAttribute("preload"), "none");
  assert.equal(audios[0].getAttribute("src"), null, "no address in the page: the server sends a ticket path");
  const chip = document.getElementById("np-chip");
  assert.equal(chip.tagName, "BUTTON");
  assert.ok(chip.hasAttribute("hidden"));
  assert.ok(Object.hasOwn(ASSETS, "media-view.js"));
  assert.ok(statSync(new URL("media-view.js", PUB)).size < 11 * 1024, "media-view.js stays under 11 KB (10 → 11 for the item 21 start gate)");
});

test("media wiring: ducking follows the mic, the server's bird and the TTS — never turn_done; turn_over and errors re-check it", () => {
  const src = read("kiosk.js");
  const sync = src.slice(src.indexOf("function syncDuck()"), src.indexOf("function applyTheme()"));
  assert.match(sync, /duckDecision\(\{ turnOpen: !!\(turn && !turn\.ended\), serverBird, playing \}\)/);
  assert.doesNotMatch(sync, /turn\.done/);
  assert.match(src, /const renderBird = \(\) => \{ setBird\([^;]+\); syncDuck\(\); \};/, "every bird change (state frames, socket close, TTS drain) re-checks the duck");
  const over = src.slice(src.indexOf('case "turn_over":'), src.indexOf('case "turn_done":'));
  assert.match(over, /syncDuck\(\)/);
  assert.match(over, /turn\.reported = true/, "a turn that never ran sends no metrics");
  const err = src.slice(src.indexOf('case "error":'), src.indexOf("default:", src.indexOf('case "error":')));
  assert.match(err, /syncDuck\(\)/);
  const start = src.slice(src.indexOf("async function startTurn("), src.indexOf("function endTurn("));
  assert.ok(start.indexOf("syncDuck()") < start.indexOf('send({ type: "turn_start"'), "ducking starts at the tap, before the server answers");
  // 400 → 600: item 21's micForMedia line and B3's barLink?.describe line both sit before apply (still the same case).
  assert.match(src, /case "media":[\s\S]{0,600}mediaView\?\.apply\(m\)/);
});

test("now-playing window: title and source as text, six buttons that send the touch verbs", () => {
  const { document } = parseHTML("<div id=w></div>");
  const root = document.getElementById("w");
  const sent = [];
  let np = { title: "<b>Song</b>", subtitle: "Artist", source: "music", paused: false, muted: false };
  const v = createWindowView(root, { t: (k) => k, now: () => 0, nowPlaying: () => np, onMedia: (verb) => sent.push(verb) });
  v.apply({ action: "open", window: { id: "w1", kind: "nowplaying", title: "Now playing" } });
  assert.equal(root.querySelector(".k-np-title").textContent, "<b>Song</b>");
  assert.equal(root.querySelector("b"), null, "never parsed as markup");
  assert.equal(root.querySelector(".k-np-sub").textContent, "Artist · music");
  const buttons = [...root.querySelectorAll(".k-np-controls button")];
  assert.equal(buttons.length, 6);
  for (const b of buttons) b.dispatchEvent(new document.defaultView.Event("click"));
  assert.deepEqual(sent, ["previous", "pause", "next", "volume_down", "volume_up", "mute"]);
  np = { ...np, paused: true, muted: true };
  v.refresh();
  sent.length = 0;
  for (const b of root.querySelectorAll(".k-np-controls button")) b.dispatchEvent(new document.defaultView.Event("click"));
  assert.deepEqual(sent, ["previous", "resume", "next", "volume_down", "volume_up", "unmute"]);
  v.apply({ action: "close", id: "w1" });
  assert.equal(root.hidden, true, "the server's close (the session ended) takes the window away");
});

test("smoke F8: an `open` with `behind` puts the now-playing window under the card in front; F9: offline, its controls are off and it says so", async (t) => {
  const { document, window } = parseHTML("<html><body><div id=w></div></body></html>");
  const root = document.getElementById("w");
  let np = { title: "Morning Mix", subtitle: "", source: "radio", paused: false, muted: false, offline: false };
  const v = createWindowView(root, { t: (k) => k, now: () => 0, nowPlaying: () => np });
  t.after(() => v.apply({ action: "close_all" }));
  v.apply({ action: "open", window: { id: "content-1", kind: "content", title: "Fruits", blocks: [] } });
  v.apply({ action: "open", behind: true, window: { id: "nowplaying-2", kind: "nowplaying", title: "Now playing" } });
  assert.deepEqual(v.list().map((w) => w.id), ["nowplaying-2", "content-1"]);
  assert.equal(root.querySelector("article").dataset.id, "content-1", "the card keeps the front");
  v.apply({ action: "focus", id: "nowplaying-2" });
  assert.equal(root.querySelectorAll(".k-np-controls button").length, 6);
  assert.equal([...root.querySelectorAll(".k-np-controls button")].some((b) => b.disabled), false);
  np = { ...np, offline: true };
  v.refresh();
  assert.equal([...root.querySelectorAll(".k-np-controls button")].every((b) => b.disabled), true);
  assert.ok(root.textContent.includes("media_offline"));
  assert.ok(window);
});

test("DV13 speaker chip: only a Pi launched with ?agent=1 loads it (one agent link per page load, never in mountUi); phones get nothing", () => {
  const src = read("kiosk.js");
  const { document } = parseHTML(read("kiosk.html"));
  const chip = document.querySelector("header.k-top #speaker");
  assert.ok(chip, "the chip's slot sits in the top bar");
  assert.equal(chip.hasAttribute("hidden"), true, "and ships hidden");
  const gate = src.match(/^if \(!SESSION && new URLSearchParams\(location\.search\)\.get\("agent"\) === "1"\)[^\n]*$/m);
  assert.ok(gate, "the import is gated on ?agent=1 (same test as agent-link's agentWanted), at module scope");
  const block = src.slice(gate.index, src.indexOf("\n}", gate.index));
  assert.match(block, /import\("\.\/agent-link\.js"\)/);
  assert.match(block, /import\("\.\/speaker-view\.js"\)/);
  assert.match(block, /createSpeakerView\(\$\("speaker"\), \{ t, link \}\)/);
  assert.match(block, /link\.start\(\)/);
  assert.equal((src.match(/createAgentLink\(/g) || []).length, 1, "one link");
  const mountUi = src.slice(src.indexOf("function mountUi()"), src.indexOf("\n}", src.indexOf("function mountUi()")));
  assert.doesNotMatch(mountUi, /agent-link|createAgentLink|speaker/);
  assert.ok(Object.hasOwn(ASSETS, "agent-link.js") && Object.hasOwn(ASSETS, "speaker-view.js"), "both are served (else a 404)");
});

test("DV13 speaker chip CSS: 56 px touch target, sits at the right of the top bar, its status line under it", () => {
  const css = read("kiosk.css");
  const rule = (sel) => (css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`)) || [])[1] || "";
  assert.match(rule(".k-spk"), /margin-left:\s*auto/);
  assert.match(rule(".k-spk-btn"), /min-height:\s*56px/);
  assert.match(rule(".k-spk-line"), /top:\s*100%/);
  assert.match(css, /\.k-spk-line:empty \{[^}]*display:\s*none/);
});

test("item 21c: every mic release tells the Android app (CrowAudioPort) the capture ended, only through the guarded helper", () => {
  const src = read("kiosk.js");
  const releases = src.match(/micGate\.release\(\)/g) || [];
  const told = src.match(/micGate\.release\(\); captureEnded\(\);/g) || [];
  assert.ok(releases.length >= 4, "the four release paths exist");
  assert.equal(told.length, releases.length, "each micGate.release() is followed by captureEnded()");
  assert.match(src, /const audioPort = globalThis\.CrowAudioPort \|\| null;/, "no port off Android: every call is a no-op");
  assert.match(src, /const captureEnded = \(\) => \{ try \{ audioPort\?\.postMessage\('\{"op":"captureEnded"\}'\); \} catch \{\} \};/);
  // The page posts exactly the two ops the app accepts, and nothing else on the port.
  const posts = [...src.matchAll(/audioPort\??\.postMessage\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(posts.sort(), [`'{"op":"captureEnded"}'`, `'{"op":"captureStarting"}'`, `'{"op":"hello"}'`]);
  assert.match(src, /audioPortLine\(e\?\.data\)/, "native lines go through the parser before the debug ring");
  assert.match(src, /createMicGate\(\(\) => \{ captureStarting\(\); return openMic\(ctx, onFrame\); \}\)/, "every getUserMedia is announced first (rev 2, R2.2)");
});

test("item 21c rev 2: in the Android app only, an idle AudioContext is paused after each mic release, and every play path resumes it", () => {
  const src = read("kiosk.js");
  const fn = src.slice(src.indexOf("function pauseOutput()"), src.indexOf("const outputNeedsResume"));
  assert.match(fn, /if \(!audioPort \|\| !ctx \|\| outputPaused \|\| ctx\.state !== "running" \|\| player\?\.playing \|\| mic \|\| micGate\.opening\(\)\) return;/, "no port (a Pi, a browser): untouched; never while a reply plays or a mic is still held");
  const rel0 = src.slice(src.indexOf("function releaseAudio("), src.indexOf("function setBird("));
  assert.match(rel0, /if \(audioPort && ctx\) outputPaused = true;\s*\/\/[^\n]*\n  try \{ ctx\?\.suspend\(\); \} catch \{\}/, "releaseAudio's suspend is tracked too (re-review N3)");
  assert.match(fn, /outputPaused = true;\n  try \{ ctx\.suspend\(\)/, "the REQUEST is tracked: suspend() is async and ctx.state lags (review I1)");
  assert.match(src, /const outputNeedsResume = \(\) => !!ctx && \(outputPaused \|\| ctx\.state === "suspended"\);/);
  assert.match(src, /const resumeOutput = \(\) => \{ if \(!audioPort \|\| !outputNeedsResume\(\)\) return; outputPaused = false;/, "app only (review M6)");
  assert.match(fn, /note\("audio", "output paused"\)/);
  const rel = src.slice(src.indexOf("function releaseMicAfterTurn("), src.indexOf("/** turn_metrics, once per turn"));
  assert.match(rel, /note\("mic", "released"\);\n  pauseOutput\(\);/);
  const mfm = src.slice(src.indexOf("function micForMedia("), src.indexOf("function releaseMicAfterTurn("));
  assert.match(mfm, /note\("mic", "released for media"\);\n  pauseOutput\(\);/);
  const tts = src.slice(src.indexOf('case "tts_start"'), src.indexOf('case "wm"'));
  assert.ok(tts.indexOf("resumeOutput()") >= 0 && tts.indexOf("resumeOutput()") < tts.indexOf("player?.begin("), "an announcement resumes before it plays");
  const chime = src.slice(src.indexOf("function chime()"), src.indexOf("async function onTap()"));
  assert.match(chime, /if \(!ctx\) return;\n  resumeOutput\(\);/, "a timer chime is never silent");
  const ens = src.slice(src.indexOf("async function ensureAudio()"), src.indexOf("function onFrame("));
  assert.match(ens, /if \(outputNeedsResume\(\)\) \{ outputPaused = false; try \{ await ctx\.resume\(\); \} catch \{\} \}/, "a tap resumes before the mic opens, even mid-suspend (review I1)");
  const close = src.slice(src.indexOf("sock.onclose"), src.indexOf("const send = "));
  assert.match(close, /player\?\.flush\(\);\n    pauseOutput\(\);/, "after a socket close the flushed context is paused (review M2)");
  const tap = src.slice(src.indexOf("async function onTap()"), src.indexOf('$("bird").addEventListener'));
  assert.match(tap, /player\?\.flush\(\);\n      pauseOutput\(\);/, "after a barge the flushed context is paused (review M2)");
});

// ─── B3 (T10): bar mode — the overlay's media plays in the dashboard's player bar ───

test("B3 bar mode: only a session frame opened with ?bar=1 whose parent bar has an owner; bar-link.js is a dynamic import (a Pi never fetches it)", () => {
  const src = read("kiosk.js");
  assert.match(src, /const BAR_WANTED = SESSION && window\.parent !== window && new URLSearchParams\(location\.search\)\.get\("bar"\) === "1";/);
  assert.match(src, /barOwner = window\.parent\.crowPlayer\.kioskOwner\(\)/);
  assert.match(src, /await import\("\.\/bar-link\.js"\)/);
  assert.doesNotMatch(src, /from\s+["']\.\/bar-link\.js["']/, "never a static import");
  assert.match(src, /const BAR = !!barLink;/);
  assert.match(src, /CAPS\.bar = BAR;/);
  assert.ok(src.indexOf("CAPS.bar = BAR;") < src.indexOf("\nconnect();"), "caps carry bar before the first hello");
  assert.ok(Object.hasOwn(ASSETS, "bar-link.js"), "served");
  assert.match(src, /window\.addEventListener\("message", barLink\.onMessage\)/);
  assert.match(src, /onCommand: \(verb\) => send\(\{ type: "media_cmd", do: verb \}\)/);
});

test("B3 bar mode: the media view drives the bar link, with no chip; each load is described to the link before the view sees it", () => {
  const src = read("kiosk.js");
  const mv = src.slice(src.indexOf("mediaView = createMediaView({"));
  assert.match(mv, /audio: barLink \|\| \$\("media"\)/);
  assert.match(mv, /chip: BAR \? document\.createElement\("button"\) : \$\("np-chip"\)/, "bar mode: the chip is never shown (the player bar is the now-playing surface)");
  const media = src.slice(src.indexOf('case "media":'), src.indexOf("break;", src.indexOf('case "media":')));
  assert.ok(media.indexOf("barLink?.describe(m)") >= 0 && media.indexOf("barLink?.describe(m)") < media.indexOf("mediaView?.apply(m)"));
});

test("B3 bar mode (review 1): crowKioskRelease keeps the media and RETURNS {volume, resume}; pagehide never stops bar media", () => {
  const src = read("kiosk.js");
  const block = src.slice(src.indexOf("window.crowKioskRelease"), src.indexOf("document.addEventListener(\"keydown\""));
  assert.match(block, /const keep = BAR \? mediaView\?\.release\(\) \?\? null : undefined;/);
  assert.match(block, /releaseAudio\(\{ keepMedia: BAR \}\)/);
  assert.match(block, /return keep;/);
  assert.ok(block.indexOf("mediaView?.release()") < block.indexOf("releaseAudio("), "read before the release");
  const release = src.slice(src.indexOf("function releaseAudio("), src.indexOf("function setBird("));
  assert.match(release, /if \(!keepMedia\) mediaView\?\.apply\(\{ action: "stop" \}\);/);
  assert.match(src, /window\.addEventListener\("pagehide", \(\) => releaseAudio\(\{ keepMedia: BAR \}\)\);/);
});

test("bar-link.js stays small and posts to this origin only", () => {
  const src = read("bar-link.js");
  assert.ok(statSync(new URL("bar-link.js", PUB)).size < 5 * 1024);
  assert.doesNotMatch(src, /postMessage\([^)]*["']\*["']\)/);
  assert.match(src, /e\.source !== parent \|\| e\.origin !== origin/);
});

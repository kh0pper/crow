/**
 * S1a: the kiosk page's on-screen keyboard — the pure part (Node, no browser).
 *
 * RED until the feature lands: `bundles/kiosk/public/osk.js` does not exist yet, so this file fails on its
 * import and nothing else. The contract below IS the spec the next task implements.
 *
 *   export const LAYOUTS = { en: { letters: [...], symbols: [...] }, es: { … } }
 *     A row is one string of one-character keys, in the order they are drawn. `letters` are the QWERTY
 *     letter rows, `symbols` the "?123" layer; es is en with ñ at the end of the second letter row.
 *
 *   export function applyKey(state, key, { maxLen = 500 } = {}) → the NEXT state (pure: `state` is never mutated)
 *     state = { value, start, end, layer: "letters" | "symbols", shift }
 *       start/end are the selection, a collapsed caret when they are equal.
 *     key   = { k: "char", ch: "a" } | { k: "space" } | { k: "backspace" } | { k: "shift" } | { k: "layer" }
 *     The result carries the same fields: `value`, a collapsed caret (start === end) after every insert,
 *     replace or delete, and `shift` / `layer` for the mode keys. A char on the letters layer with `shift`
 *     set goes in as a capital and turns shift off (shift is one-shot); on the symbols layer the shift key
 *     is ignored. The layer key toggles letters ⇄ symbols and clears shift. Nothing is inserted past
 *     `maxLen` (the value and the caret stay as they were).
 *
 *   export function oskWanted({ param, session, physicalKey }) → boolean      (state.js)
 *     The ?osk= parameter decides absolutely ("1" on, "0" off; anything else is no parameter). Without it a
 *     session gets no keyboard — the phone's Talk to Crow overlay brings the phone's own. Otherwise the
 *     keyboard is offered on the Pi's 7" kiosk touchscreen (that is the whole point: kiosk cage Chromium
 *     installs no system keyboard) unless a physical key has been seen, which means a real keyboard is
 *     right there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHTML, Event as DomEvent, CustomEvent as DomCustomEvent } from "linkedom";
import { LAYOUTS, applyKey, mountOsk } from "../bundles/kiosk/public/osk.js";
import { oskWanted, MAX_TEXT_CHARS } from "../bundles/kiosk/public/state.js";
import { ASSETS } from "../bundles/kiosk/server/runtime.js";
import { STRINGS } from "../bundles/kiosk/server/strings.js";

const PUB = new URL("../bundles/kiosk/public/", import.meta.url);
const read = (f) => readFileSync(new URL(f, PUB), "utf8");

/** A keyboard state with a caret; `start === end` unless both are given. */
const st = (value = "", start = value.length, end = start, opts = {}) =>
  ({ value, start, end, layer: "letters", shift: false, ...opts });
const ch = (c) => ({ k: "char", ch: c });
const SPACE = { k: "space" }, BACK = { k: "backspace" }, SHIFT = { k: "shift" }, LAYER = { k: "layer" };
const caret = (s) => [s.start, s.end];

// ---- one key press on the text ----

test("a char inserts at the caret — start, middle and end of the value", () => {
  let s = applyKey(st("helo", 3, 3), ch("l"));
  assert.equal(s.value, "hello", "in the middle");
  assert.deepEqual(caret(s), [4, 4], "the caret ends after the new character");

  s = applyKey(st("bc", 0, 0), ch("a"));
  assert.equal(s.value, "abc", "at the start");
  assert.deepEqual(caret(s), [1, 1]);

  s = applyKey(st("ab"), ch("c"));
  assert.equal(s.value, "abc", "at the end");
  assert.deepEqual(caret(s), [3, 3]);

  const untouched = st("helo", 3, 3), before = JSON.stringify(untouched);
  applyKey(untouched, ch("l"));
  assert.equal(JSON.stringify(untouched), before, "the input state is not mutated: the page can keep one object");
});

test("a char replaces a selection", () => {
  const s = applyKey(st("hello", 1, 4), ch("a"));
  assert.equal(s.value, "hao", "\"ell\" is replaced");
  assert.deepEqual(caret(s), [2, 2]);
});

test("shift capitalises one character on the letters layer and turns itself off", () => {
  let s = applyKey(st("", 0, 0), SHIFT);
  assert.equal(s.shift, true, "the shift key arms it");
  assert.equal(s.layer, "letters", "shift does not leave the letters layer");

  s = applyKey(s, ch("a"));
  assert.equal(s.value, "A", "one capital");
  assert.equal(s.shift, false, "and it turns itself off");

  s = applyKey(s, ch("b"));
  assert.equal(s.value, "Ab", "the next one is lower case again");
  assert.deepEqual(caret(s), [2, 2]);
});

test("shift is ignored on the symbols layer", () => {
  const sym = st("", 0, 0, { layer: "symbols" });
  const after = applyKey(sym, SHIFT);
  assert.equal(after.shift, false, "the shift key does nothing there: there are no capitals");
  assert.equal(after.layer, "symbols");

  const stray = applyKey(st("", 0, 0, { layer: "symbols", shift: true }), ch("?"));
  assert.equal(stray.value, "?", "a stray shift never re-cases a symbol");
});

test("the layer key toggles letters ⇄ symbols and clears shift", () => {
  let s = applyKey(st("hi", 2, 2, { shift: true }), LAYER);
  assert.equal(s.layer, "symbols");
  assert.equal(s.shift, false, "a new layer starts unshifted");
  assert.equal(s.value, "hi", "the layer key types nothing");
  assert.deepEqual(caret(s), [2, 2]);

  s = applyKey(s, LAYER);
  assert.equal(s.layer, "letters");
  assert.equal(s.shift, false);
});

test("space inserts one space at the caret and leaves no armed shift behind", () => {
  let s = applyKey(st("ab", 1, 1), SPACE);
  assert.equal(s.value, "a b");
  assert.deepEqual(caret(s), [2, 2]);

  s = applyKey(st("ab"), SPACE);
  assert.equal(s.value, "ab ");
  assert.deepEqual(caret(s), [3, 3]);

  assert.equal(applyKey(st("ab", 0, 2), SPACE).value, " ", "a selection is replaced by the space");
  const shifted = applyKey(st("a", 1, 1, { shift: true }), SPACE);
  assert.equal(shifted.value, "a ");
  assert.equal(shifted.shift, false, "there is no capital space");
});

test("backspace deletes before the caret, the selection when there is one, and nothing at 0", () => {
  let s = applyKey(st("abc", 2, 2), BACK);
  assert.equal(s.value, "ac", "the character before the caret");
  assert.deepEqual(caret(s), [1, 1]);

  s = applyKey(st("abcdef", 1, 4), BACK);
  assert.equal(s.value, "aef", "a selection goes in one press");
  assert.deepEqual(caret(s), [1, 1]);

  s = applyKey(st("abc", 0, 0), BACK);
  assert.equal(s.value, "abc", "there is nothing before the first character");
  assert.deepEqual(caret(s), [0, 0]);

  s = st("abc");
  for (const [value, at] of [["ab", 2], ["a", 1], ["", 0], ["", 0]]) {
    s = applyKey(s, BACK);
    assert.equal(s.value, value, "repeated backspace runs the value out");
    assert.deepEqual(caret(s), [at, at]);
  }

  assert.equal(applyKey(st("abc", 2, 2, { shift: true }), BACK).shift, true, "backspace does not touch shift");
});

// ---- the cap ----

test("maxLen: an insert at the cap is ignored — 500 by default, or a shorter cap", () => {
  assert.equal(MAX_TEXT_CHARS, 500, "the page's typed-message cap");
  const full = "x".repeat(MAX_TEXT_CHARS);

  let s = applyKey(st(full, 250, 250), ch("y"));
  assert.equal(s.value, full, "no 501st character");
  assert.deepEqual(caret(s), [250, 250], "and the caret does not move");

  s = applyKey(st(full), ch("y"));
  assert.equal(s.value, full, "with no third argument the cap is the page's 500");

  assert.equal(applyKey(st("abc", 3, 3), ch("d"), { maxLen: 3 }).value, "abc", "a short cap holds too");
  assert.equal(applyKey(st("abc", 3, 3), SPACE, { maxLen: 3 }).value, "abc", "and it holds for a space");
  assert.equal(applyKey(st("abc", 3, 3), ch("d"), { maxLen: 4 }).value, "abcd", "one under the cap goes in");
  assert.equal(applyKey(st("abcd", 1, 4), ch("y"), { maxLen: 3 }).value, "ay", "replacing a selection frees room");
  assert.equal(applyKey(st("abc", 1, 1), BACK, { maxLen: 3 }).value, "bc", "backspace still works at the cap");
});

// ---- the layouts ----

test("layouts: en is QWERTY, es is the same alphabet plus ñ", () => {
  const flat = (L) => L.letters.join("");
  assert.deepEqual(LAYOUTS.en.letters, ["qwertyuiop", "asdfghjkl", "zxcvbnm"], "the letter rows as they are drawn");
  assert.equal(flat(LAYOUTS.en), "qwertyuiopasdfghjklzxcvbnm", "every letter once, in QWERTY order");
  assert.ok(!flat(LAYOUTS.en).includes("ñ"), "the English layout has no ñ");

  const es = flat(LAYOUTS.es);
  for (const c of "abcdefghijklmnopqrstuvwxyz") assert.ok(es.includes(c), `the Spanish layout has ${c}`);
  assert.ok(es.includes("ñ"), "the Spanish layout has ñ");
  assert.equal(es.replaceAll("ñ", "").length, 26, "es is the same 26 letters plus ñ, nothing else");
  assert.equal(LAYOUTS.es.letters[1], "asdfghjklñ", "ñ sits at the end of the second letter row");
});

test("layouts: the ?123 layer is the same in both languages", () => {
  const SYMBOLS = ["1234567890", "-/:;()$&@\"", ".,?!'"];
  assert.deepEqual(LAYOUTS.en.symbols, SYMBOLS, "the symbols rows as they are drawn");
  assert.deepEqual(LAYOUTS.es.symbols, SYMBOLS, "the symbols do not depend on the language");
});

test("layouts: every row of both layers is a non-empty string of keys", () => {
  for (const lang of ["en", "es"]) {
    assert.ok(LAYOUTS[lang], `${lang} exists`);
    for (const layer of ["letters", "symbols"]) {
      const rows = LAYOUTS[lang][layer];
      assert.ok(Array.isArray(rows), `${lang}.${layer} is a list of rows`);
      assert.ok(rows.length >= 3, `${lang}.${layer} draws at least three rows`);
      for (const row of rows) {
        assert.equal(typeof row, "string", `${lang}.${layer}: a row is a string`);
        assert.ok(row.length > 0, `${lang}.${layer}: no empty row`);
      }
      const keys = rows.join("");
      assert.equal(new Set(keys).size, keys.length, `${lang}.${layer}: no key twice`);
    }
    assert.equal(LAYOUTS[lang].letters.length, 3, `${lang}: three letter rows`);
    for (const row of LAYOUTS[lang].letters) assert.match(row, /^[a-zñ]+$/, `${lang}: letter rows hold letters only`);
    for (const row of LAYOUTS[lang].symbols) assert.doesNotMatch(row, /\s/, `${lang}: the space is its own key, not a row character`);
  }
});

// ---- the labels ----

test("strings: the keyboard's six labels read as designed in en and in es; the two key sets stay identical", () => {
  const OSK = ["osk_label", "osk_space", "osk_symbols", "osk_letters", "osk_shift", "osk_backspace"];
  const EXPECTED = {
    en: { osk_label: "On-screen keyboard", osk_space: "Space", osk_symbols: "?123", osk_letters: "ABC", osk_shift: "Shift", osk_backspace: "Backspace" },
    es: { osk_label: "Teclado en pantalla", osk_space: "Espacio", osk_symbols: "?123", osk_letters: "ABC", osk_shift: "Mayúsculas", osk_backspace: "Borrar" },
  };
  for (const lang of ["en", "es"]) {
    for (const k of OSK) {
      const v = STRINGS[lang][k];
      assert.equal(typeof v, "string", `${lang}.${k} is a string`);
      assert.ok(v.trim().length > 0, `${lang}.${k} is not empty`);
      assert.equal(v, EXPECTED[lang][k], `${lang}.${k} reads as the design says`);
    }
    assert.notEqual(STRINGS[lang].osk_symbols, STRINGS[lang].osk_letters, `${lang}: the layer key has two readable labels`);
  }
  assert.deepEqual(Object.keys(STRINGS.en).sort(), Object.keys(STRINGS.es).sort(), "en and es carry the same keys");
});

// ---- whether the page offers it at all ----

test("oskWanted: ?osk decides absolutely; otherwise a display with no physical keyboard gets the keyboard", () => {
  // The parameter overrides everything — the session mode and a physical key seen alike.
  for (const session of [true, false]) {
    for (const physicalKey of [true, false]) {
      assert.equal(oskWanted({ param: "1", session, physicalKey }), true, `?osk=1 forces it on (session ${session}, physical ${physicalKey})`);
      assert.equal(oskWanted({ param: "0", session, physicalKey }), false, `?osk=0 forces it off (session ${session}, physical ${physicalKey})`);
    }
  }
  // No parameter: a session gets nothing (the phone overlay has the phone's own keyboard)…
  assert.equal(oskWanted({ session: true, physicalKey: false }), false, "a phone or tablet on Talk to Crow");
  assert.equal(oskWanted({ session: true, physicalKey: true }), false, "and it stays off once a real keyboard typed");
  // …and a kiosk display gets it until a physical key is seen.
  assert.equal(oskWanted({ session: false, physicalKey: false }), true, "the Pi's 7\" touchscreen kiosk (no system keyboard is installed)");
  assert.equal(oskWanted({ session: false, physicalKey: true }), false, "a kiosk with a keyboard attached needs no on-screen one");
  // Missing arguments are simply "no parameter, no session, no physical keyboard seen yet" — never a throw.
  assert.equal(oskWanted(), true, "no argument at all");
  assert.equal(oskWanted({}), true, "an empty object");
  assert.equal(oskWanted({ session: true }), false, "a session with no physical key still gets nothing");
  assert.equal(oskWanted({ session: false }), true, "a display, physicalKey defaulting to false");
  assert.equal(oskWanted({ physicalKey: true }), false, "a single physical key is enough on a display");
  assert.equal(oskWanted({ param: undefined, session: true, physicalKey: false }), false, "an undefined param is no parameter");
  assert.equal(oskWanted({ param: undefined, session: false, physicalKey: true }), false);
  assert.equal(oskWanted({ param: "", session: false, physicalKey: false }), true, "an empty param is no parameter");
  assert.equal(oskWanted({ param: "2", session: true, physicalKey: false }), false, "only \"1\" and \"0\" are overrides");
  assert.equal(oskWanted({ param: "2", session: false, physicalKey: false }), true, "so the kiosk rule still decides");
  assert.equal(oskWanted({ param: "2", session: false, physicalKey: true }), false);
});

// ---- served, and built without markup ----

test("runtime: the page's two keyboard assets are served", () => {
  assert.equal(ASSETS["osk.js"], "text/javascript");
  assert.equal(ASSETS["osk.css"], "text/css");
});

test("source: osk.js builds nodes and never markup; kiosk.js reaches it only through a dynamic import", () => {
  const osk = read("osk.js");
  assert.doesNotMatch(osk, /\.innerHTML\s*=/, "keys and labels are nodes/text, never HTML");
  assert.doesNotMatch(osk, /insertAdjacentHTML|outerHTML\s*=|document\.write/, "no markup path at all");

  const src = read("kiosk.js");
  assert.match(src, /import\(\s*["']\.\/osk\.js["']\s*\)/, "loaded on demand, when a field first takes focus");
  assert.doesNotMatch(src, /from\s+["']\.\/osk\.js["']/, "never a static import (it would ride every page load)");
  assert.doesNotMatch(src, /^\s*import\s+["']\.\/osk\.js["']/m, "and never a bare side-effect import either");
});

// ---- the keyboard as it is built: the ?123 layer's Backspace, and a key with no pointer behind it ----

/**
 * The composer's form with one field, plus the caret a real input keeps (linkedom's field has no
 * selection API of its own; everything else is the mark-up osk.js really builds).
 */
function keyboard() {
  const { document } = parseHTML(`<html><head></head><body><form id="compose"><input id="compose-text"><button id="compose-send" type="submit">Send</button></form></body></html>`);
  const input = document.getElementById("compose-text");
  let caret = null;
  Object.defineProperty(input, "selectionStart", { configurable: true, get: () => (caret == null ? input.value.length : caret) });
  Object.defineProperty(input, "selectionEnd", { configurable: true, get: () => (caret == null ? input.value.length : caret) });
  Object.defineProperty(input, "setSelectionRange", { configurable: true, value: (start) => { caret = start; } });
  const t = (k) => STRINGS.en[k] || k;
  const osk = mountOsk({ input, form: document.getElementById("compose"), lang: "en", t, doc: document });
  const keys = () => [...document.querySelectorAll("#osk button")];
  const key = (label) => keys().find((b) => (b.textContent || "").trim() === label || b.getAttribute("aria-label") === label) || null;
  /** The finger or mouse path: one pointerdown on a key. */
  const press = (label) => {
    const b = key(label);
    assert.ok(b, `the ${JSON.stringify(label)} key is drawn`);
    b.dispatchEvent(new DomEvent("pointerdown", { bubbles: true, cancelable: true }));
    return b;
  };
  /** The assistive-tech path: a click with no pointer behind it, so no detail from a mouse. */
  const clickKey = (label, detail = 0) => {
    const b = key(label);
    assert.ok(b, `the ${JSON.stringify(label)} key is drawn`);
    b.dispatchEvent(new DomCustomEvent("click", { detail, bubbles: true, cancelable: true }));
    return b;
  };
  return { document, input, osk, keys, key, press, clickKey };
}

test("the ?123 layer carries its own Backspace, and it deletes without leaving the layer", () => {
  const { input, osk, key, press } = keyboard();
  try {
    osk.open();
    input.value = "abc";
    press(STRINGS.en.osk_symbols);
    assert.ok(key(STRINGS.en.osk_letters), "the keyboard is on the symbols layer (its layer key reads ABC)");
    const back = key(STRINGS.en.osk_backspace);
    assert.ok(back, "the symbols layer has a Backspace key");
    assert.equal(back.tagName, "BUTTON", "and it is a button (never a link or a div)");
    press(STRINGS.en.osk_backspace);
    assert.equal(input.value, "ab", "one press deletes one character");
    assert.ok(key(STRINGS.en.osk_letters), "the keyboard stays on the symbols layer");
    press(STRINGS.en.osk_backspace);
    assert.equal(input.value, "a", "so deleting needs no trip back to ABC");
    assert.ok(key(STRINGS.en.osk_letters), "still there");
  } finally { osk.destroy(); }
});

test("a synthetic click (detail 0) types one letter; a pointer's own click types nothing more", () => {
  const { input, osk, press, clickKey } = keyboard();
  try {
    osk.open();
    clickKey("a", 0);
    assert.equal(input.value, "a", "a click with no pointer behind it is a key press (a screen reader, assistive tech)");
    clickKey("a", 1);
    assert.equal(input.value, "a", "a click the pointer path already handled adds nothing");
    press("b");
    assert.equal(input.value, "ab", "a real pointer press is one letter, from pointerdown alone");
    assert.equal(clickKey("b", 1).tagName, "BUTTON", "and its own click does not double it");
    assert.equal(input.value, "ab");
  } finally { osk.destroy(); }
});

// ---- the page's wiring (kiosk.js): when the keyboard is offered, and what closes it ----

test("kiosk.js: inputmode follows whether a keyboard is WANTED (from boot), and a close never undoes it", () => {
  const src = read("kiosk.js");
  assert.match(src, /const OSK_PARAM = new URLSearchParams\(location\.search\)\.get\("osk"\);/, "the parameter is read once");
  assert.match(src, /const oskIsWanted = \(\) => oskWanted\(\{ session: SESSION, param: OSK_PARAM, physicalKey \}\);/, "one answer to \"is a keyboard wanted\" for the page");
  assert.match(src, /function syncOskMode\(\) \{ const i = \$\("compose-text"\); if \(oskIsWanted\(\)\) i\.setAttribute\("inputmode", "none"\); else i\.removeAttribute\("inputmode"\); \}/, "the field's inputmode follows that answer only");
  assert.match(src, /^syncOskMode\(\);/m, "and it is set at boot, not only on the first focus");
  assert.match(src, /if \(document\.activeElement === input && oskIsWanted\(\)\) oskApi\.open\(\);/, "the lazy mount re-asks, so a physical key seen meanwhile is honoured");
  assert.doesNotMatch(read("osk.js"), /removeAttribute\("inputmode"\)/, "the keyboard never takes inputmode away: the page does, when none is wanted");
});

test("kiosk.js: every voice toggle closes it, a focus that lands inside it keeps the field, and only a key that types counts", () => {
  const src = read("kiosk.js");
  const voice = src.slice(src.indexOf("function setVoiceOff("), src.indexOf("function sendTyped("));
  assert.match(voice, /\$\("type-btn"\)\.hidden = voiceOff;\s*\n\s*closeOsk\(\);/, "the composer hides on either toggle, so the keyboard goes with it (not only when voice goes off)");

  const focusout = src.slice(src.indexOf('$("compose-text").addEventListener("focusout"'), src.indexOf('$("mic").addEventListener("click", onTap)'));
  assert.match(focusout, /const board = document\.getElementById\("osk"\);/, "the guard looks for the keyboard");
  assert.match(focusout, /if \(ev\.relatedTarget && board\?\.contains\(ev\.relatedTarget\)\) \{ \$\("compose-text"\)\.focus\(\); return; \}/, "a focus that lands inside it is put back on the field, and the keyboard stays");
  assert.match(focusout, /closeOsk\(\);/, "anything else closes it");

  assert.match(src, /const physicalKeyCounts = \(key\) => typeof key === "string" && \(key\.length === 1 \|\| key === "Backspace" \|\| key === "Enter"\);/, "one character, Backspace or Enter: Escape, the F-keys and the modifiers are no keyboard");
  assert.match(src, /if \(!e\.isTrusted \|\| !physicalKeyCounts\(e\.key\)\) return;/, "so only a key that types is counted");
  assert.match(src, /physicalKey = true;\s*\n\s*syncOskMode\(\);\s*\n\s*if \(!oskIsWanted\(\)\) closeOsk\(\);/, "and with ?osk=1 a physical key neither closes nor disables the keyboard");
});
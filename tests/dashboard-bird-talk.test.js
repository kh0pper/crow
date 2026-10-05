/**
 * One header button: the bird.
 *   tap        → the tray (notifications + health), with "Talk to Crow" on top
 *   long-press → the Talk to Crow overlay directly (touch, mouse and keyboard)
 * The old Companion ("ear") button and its overlay toggle are gone. With no
 * Kiosk extension there is no Talk row and a long-press is just a tap.
 *
 * The gesture and overlay script is executed here against a linkedom document
 * with a hand-driven timer, so "the long-press must not also fire the tap" is
 * a behaviour test, not a string match.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { tamagotchiHtml, tamagotchiJs, tamagotchiCss, headerIconsHtml, headerIconsJs, headerIconsCss } from "../servers/gateway/dashboard/shared/notifications.js";
import { crowTalkJs, crowTalkCss, crowTalkOverlayHtml, crowTalkRowHtml, isCrowTalkAvailable, CROW_TALK_PATH, CROW_TALK_HOLD_MS } from "../servers/gateway/dashboard/shared/crow-talk.js";
import { renderLayout } from "../servers/gateway/dashboard/shared/layout.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ─── markup ─────────────────────────────────────────────────────────────────

test("the ear button is gone from both header modes, whatever the options say", () => {
  for (const html of [
    tamagotchiHtml("en"), tamagotchiHtml("en", { talkAvailable: true }), tamagotchiHtml("en", { companionAvailable: true }),
    headerIconsHtml("en"), headerIconsHtml("en", { talkAvailable: true }), headerIconsHtml("en", { companionAvailable: true }),
  ]) {
    assert.doesNotMatch(html, /kiosk-toggle-btn|toggleKioskMode|kiosk\.toggle/);
  }
  const src = read("../servers/gateway/dashboard/shared/notifications.js") + read("../servers/gateway/dashboard/shared/layout.js") + read("../servers/gateway/dashboard/index.js");
  assert.doesNotMatch(src, /toggleKioskMode|exitKioskMode|kiosk-toggle-btn|__crowCompanionUrl|set_kiosk|:12393/, "the old companion overlay toggle is removed, not hidden");
});

test("the bird is a real button: focusable, labelled, and it owns the tray", () => {
  const { document } = parseHTML(`<div>${tamagotchiHtml("en", { talkAvailable: true })}</div>`);
  const bird = document.getElementById("crow-bird-btn");
  assert.equal(bird.tagName, "BUTTON");
  assert.equal(bird.getAttribute("type"), "button");
  assert.equal(bird.getAttribute("aria-controls"), "crow-dropdown");
  assert.equal(bird.getAttribute("aria-expanded"), "false");
  assert.ok(bird.getAttribute("aria-label").length > 5);
  assert.ok(bird.querySelector("svg#crow-tama"), "the bird art lives inside the button");
  assert.equal(document.querySelectorAll("button.header-icon-btn:not(#crow-ptt-btn)").length, 0, "no second header button beside the bird");
});

test("Kiosk installed: a large Talk to Crow row is the FIRST thing in the tray, in the viewer's language", () => {
  for (const lang of ["en", "es"]) {
    const { document } = parseHTML(`<div>${tamagotchiHtml(lang, { talkAvailable: true })}</div>`);
    const tray = document.getElementById("crow-dropdown");
    const first = tray.firstElementChild;
    assert.equal(first.id, "crow-talk-row", "the row comes before the title, the health bar and the list");
    assert.equal(first.tagName, "BUTTON");
    assert.ok(first.textContent.includes(t("talk.row", lang)), lang);
    assert.equal(document.getElementById("crow-bird-btn").hasAttribute("data-crow-talk"), true);
    assert.ok(tray.querySelector("#notif-list") && tray.querySelector("#crow-health-bar"), "notifications and health are still there");
  }
  assert.notEqual(t("talk.row", "es"), t("talk.row", "en"));
  assert.equal(t("talk.row", "en"), "Talk to Crow");
});

test("Kiosk not installed: no Talk row and the bird is not armed for long-press (no fallback to the old companion)", () => {
  for (const opts of [undefined, {}, { talkAvailable: false }, { companionAvailable: true }]) {
    const { document } = parseHTML(`<div>${tamagotchiHtml("en", opts)}</div>`);
    assert.equal(document.getElementById("crow-talk-row"), null);
    assert.equal(document.getElementById("crow-bird-btn").hasAttribute("data-crow-talk"), false);
    assert.ok(document.getElementById("notif-list"), "the tray itself is unchanged");
  }
});

test("classic header (bird turned off): the bell carries the same row and long-press", () => {
  const on = parseHTML(`<div>${headerIconsHtml("en", { talkAvailable: true })}</div>`).document;
  assert.equal(on.getElementById("notif-dropdown").firstElementChild.id, "crow-talk-row");
  assert.equal(on.getElementById("notif-icon-btn").hasAttribute("data-crow-talk"), true);
  const off = parseHTML(`<div>${headerIconsHtml("en")}</div>`).document;
  assert.equal(off.getElementById("crow-talk-row"), null);
  assert.equal(off.getElementById("notif-icon-btn").hasAttribute("data-crow-talk"), false);
});

test("Talk is offered only when the installed Kiosk panel declares the session display AND its routes loaded", () => {
  assert.equal(isCrowTalkAvailable({ id: "kiosk", sessionDisplay: true }, true), true);
  assert.equal(isCrowTalkAvailable({ id: "kiosk" }, true), false, "an older installed kiosk copy has no /display/session");
  assert.equal(isCrowTalkAvailable({ id: "kiosk", sessionDisplay: true }, false), false, "routes failed to load");
  assert.equal(isCrowTalkAvailable(undefined, false), false);
  assert.equal(isCrowTalkAvailable({ id: "kiosk", sessionDisplay: "yes" }, true), false);
});

test("the installed-panel flag is really exported by the kiosk bundle", async () => {
  const panel = (await import("../bundles/kiosk/panel/kiosk.js")).default;
  assert.equal(panel.sessionDisplay, true);
});

// ─── emitted scripts stay valid inside their template literals ──────────────

test("emitted scripts parse; the talk script has no backtick and no ${ in its source", () => {
  for (const lang of ["en", "es"]) {
    assert.doesNotThrow(() => new Function(tamagotchiJs(lang)));
    assert.doesNotThrow(() => new Function(headerIconsJs(lang)));
  }
  const js = crowTalkJs();
  assert.doesNotThrow(() => new Function(js));
  assert.ok(!js.includes("`"));
  assert.ok(!js.includes("${"));
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|document\.write/);
});

// ─── layout ─────────────────────────────────────────────────────────────────

test("layout: the overlay shell, its close button and the script ship on every page; it stacks above the phone drawer", () => {
  for (const lang of ["en", "es"]) {
    const html = renderLayout({ title: "T", content: "<p>x</p>", activePanel: "nest", panels: [], lang });
    const { document } = parseHTML(html);
    const o = document.getElementById("crow-talk-overlay");
    assert.ok(o, "overlay");
    assert.equal(o.getAttribute("role"), "dialog");
    assert.equal(o.getAttribute("aria-modal"), "true");
    assert.equal(o.getAttribute("aria-label"), t("talk.row", lang));
    const x = document.getElementById("crow-talk-close");
    assert.equal(x.tagName, "BUTTON");
    assert.equal(x.getAttribute("aria-label"), t("talk.close", lang));
    assert.equal(o.querySelector("iframe"), null, "no frame (and no microphone) until it is opened");
    assert.ok(html.includes("window.openCrowTalk"), "script present");
    assert.equal(document.getElementById("kiosk-overlay"), null);
  }
  const oz = Number(crowTalkCss.match(/\.crow-talk-overlay\s*\{[^}]*z-index:\s*(\d+)/)[1]);
  const layout = read("../servers/gateway/dashboard/shared/layout.js");
  const drawer = Math.max(...[...layout.matchAll(/\.sidebar(?:-overlay)?\s*\{[^}]*z-index:\s*(\d+)/g)].map((m) => Number(m[1])));
  assert.ok(drawer >= 1100, "found the phone drawer z-index");
  assert.ok(oz > drawer, `overlay ${oz} must out-stack the drawer ${drawer}`);
  const xz = Number(crowTalkCss.match(/\.crow-talk-close\s*\{[^}]*z-index:\s*(\d+)/)[1]);
  assert.ok(xz > oz, "the close button sits above the frame");
  assert.doesNotMatch(crowTalkCss, /\.crow-talk-close\s*\{[^}]*display:\s*none/, "the close control is always visible");
  assert.doesNotMatch(headerIconsCss + tamagotchiCss, /kiosk-toggle-btn|kiosk-overlay|kiosk-exit-btn|kiosk-error-msg/, "old overlay CSS removed");
  assert.equal(crowTalkOverlayHtml("en").includes(CROW_TALK_PATH), false, "the frame URL is not in the markup");
  assert.equal(CROW_TALK_PATH, "/display/session");
});

// ─── behaviour: tap vs long-press ───────────────────────────────────────────

function harness({ talk = true, classic = false } = {}) {
  const header = classic ? headerIconsHtml("en", { talkAvailable: talk }) : tamagotchiHtml("en", { talkAvailable: talk });
  const { document, window } = parseHTML(`<html><body>${crowTalkOverlayHtml("en")}<header>${header}</header><a id="elsewhere" href="#">x</a></body></html>`);
  const timers = [];
  let clock = 1000;
  const setT = (fn, ms) => { const tm = { fn, at: clock + ms, ms, dead: false }; timers.push(tm); return tm; };
  const clearT = (tm) => { if (tm) tm.dead = true; };
  const advance = (ms) => { clock += ms; for (const tm of timers) if (!tm.dead && tm.at <= clock) { tm.dead = true; tm.fn(); } };
  const released = [];
  const vibrations = [];
  const win = {
    document, location: { origin: "https://crow.example.ts.net:8444" },
    navigator: { vibrate: (n) => vibrations.push(n) },
    addEventListener: (type, fn) => { (win._l[type] ||= []).push(fn); }, _l: {},
  };
  const DateStub = { now: () => clock };
  new Function("window", "document", "location", "navigator", "setTimeout", "clearTimeout", "Date", crowTalkJs())(win, document, win.location, win.navigator, setT, clearT, DateStub);
  const id = classic ? "notif-icon-btn" : "crow-bird-btn";
  const trayId = classic ? "notif-dropdown" : "crow-dropdown";
  const bird = document.getElementById(id);
  const tray = document.getElementById(trayId);
  let taps = 0;
  // What the inline onclick does (toggleCrowDropdown / toggleNotifDropdown): honour the swallow, then toggle.
  bird.addEventListener("click", (e) => {
    if (win.crowTalkSwallowTap()) { e.stopPropagation(); return; }
    taps++;
    tray.style.display = tray.style.display === "none" ? "block" : "none";
  });
  const row = document.getElementById("crow-talk-row");
  if (row) row.addEventListener("click", () => win.openCrowTalk());
  document.getElementById("crow-talk-close").addEventListener("click", () => win.closeCrowTalk());
  const ev = (type, props = {}, target = bird) => {
    const e = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, { button: 0, isPrimary: true, clientX: 10, clientY: 10, pointerType: "mouse" }, props);
    target.dispatchEvent(e);
    return e;
  };
  const overlay = document.getElementById("crow-talk-overlay");
  const frame = () => overlay.querySelector("iframe");
  const isOpen = () => overlay.classList.contains("active");
  /** Give the frame a fake kiosk page so close can be seen releasing the mic. */
  const fakePage = () => { const f = frame(); Object.defineProperty(f, "contentWindow", { configurable: true, value: { crowKioskRelease: () => released.push("released") } }); return f; };
  return { document, window, win, bird, tray, ev, advance, overlay, frame, isOpen, fakePage, released, vibrations, taps: () => taps, timers };
}

test("tap (mouse or touch): the tray opens, the overlay does not", () => {
  for (const pointerType of ["mouse", "touch"]) {
    const h = harness();
    h.ev("pointerdown", { pointerType });
    h.advance(120);
    h.ev("pointerup", { pointerType });
    h.ev("click");
    h.advance(2000);
    assert.equal(h.taps(), 1, pointerType);
    assert.equal(h.tray.style.display, "block");
    assert.equal(h.isOpen(), false);
    assert.equal(h.frame(), null);
  }
});

test("long-press with the mouse: the overlay opens at the hold time and the release click does NOT also open the tray", () => {
  const h = harness();
  assert.equal(CROW_TALK_HOLD_MS, 500);
  h.ev("pointerdown");
  h.advance(CROW_TALK_HOLD_MS - 1);
  assert.equal(h.isOpen(), false, "not before the hold time");
  h.advance(1);
  assert.equal(h.isOpen(), true);
  const f = h.frame();
  assert.equal(f.getAttribute("src"), CROW_TALK_PATH);
  assert.match(f.getAttribute("allow"), /microphone/);
  h.ev("pointerup");
  h.ev("click");
  assert.equal(h.taps(), 0, "the tap did not fire");
  assert.equal(h.tray.style.display, "none");
  // The swallow is one-shot: after closing, a normal tap works again.
  h.win.closeCrowTalk();
  h.ev("pointerdown"); h.advance(50); h.ev("pointerup"); h.ev("click");
  assert.equal(h.taps(), 1);
});

test("long-press by touch: opens at the hold time; with no click afterwards the NEXT tap is still a tap", () => {
  const h = harness();
  h.ev("pointerdown", { pointerType: "touch" });
  h.advance(CROW_TALK_HOLD_MS);
  assert.equal(h.isOpen(), true);
  assert.deepEqual(h.vibrations.length, 1, "a short haptic tick");
  h.ev("pointerup", { pointerType: "touch" });      // browsers send no click after a long touch
  h.win.closeCrowTalk();
  h.ev("pointerdown", { pointerType: "touch" }); h.advance(80); h.ev("pointerup", { pointerType: "touch" }); h.ev("click");
  assert.equal(h.taps(), 1);
  assert.equal(h.isOpen(), false);
});

test("touch: the browser's own long-press (contextmenu) counts as the long-press and its menu is suppressed — even if it cancelled the pointer first", () => {
  {
    const h = harness();
    h.ev("pointerdown", { pointerType: "touch" });
    h.advance(400);
    const e = h.ev("contextmenu", { pointerType: "touch" });
    assert.equal(e.defaultPrevented, true);
    assert.equal(h.isOpen(), true);
    h.advance(1000);
    assert.equal(h.overlay.querySelectorAll("iframe").length, 1, "the timer does not open it a second time");
  }
  {
    const h = harness();
    h.ev("pointerdown", { pointerType: "touch" });
    h.advance(400);
    h.ev("pointercancel", { pointerType: "touch" });
    const e = h.ev("contextmenu", { pointerType: "touch" });
    assert.equal(e.defaultPrevented, true);
    assert.equal(h.isOpen(), true);
  }
  {
    const h = harness();                              // a mouse right-click keeps its normal menu
    const e = h.ev("contextmenu", { button: 2 });
    assert.equal(e.defaultPrevented, false);
    assert.equal(h.isOpen(), false);
  }
});

test("a press that moves away, is released early, is cancelled or uses another button never opens the overlay", () => {
  const cases = [
    (h) => { h.ev("pointerdown"); h.advance(200); h.ev("pointermove", { clientX: 40, clientY: 10 }); h.advance(1000); },
    (h) => { h.ev("pointerdown"); h.advance(499); h.ev("pointerup"); h.advance(1000); },
    (h) => { h.ev("pointerdown", { pointerType: "touch" }); h.advance(100); h.ev("pointercancel", { pointerType: "touch" }); h.advance(1000); },
    (h) => { h.ev("pointerdown", { button: 2 }); h.advance(1000); },
    (h) => { h.ev("pointerdown", { isPrimary: false }); h.advance(1000); },
    (h) => { h.ev("pointerdown", {}, h.document.getElementById("elsewhere")); h.advance(1000); },
  ];
  cases.forEach((run, i) => { const h = harness(); run(h); assert.equal(h.isOpen(), false, "case " + i); });
  // A small wobble (under 10 px) is still a hold.
  const h = harness();
  h.ev("pointerdown"); h.ev("pointermove", { clientX: 14, clientY: 13 }); h.advance(CROW_TALK_HOLD_MS);
  assert.equal(h.isOpen(), true);
});

test("keyboard: Enter/Space tapped → tray on key-up; held → overlay, no tray, and focus moves to Close only after the key is released", () => {
  for (const key of ["Enter", " "]) {
    const h = harness();
    const down = h.ev("keydown", { key });
    assert.equal(down.defaultPrevented, true, "the native click-on-keydown is held back");
    h.advance(100);
    h.ev("keyup", { key });
    assert.equal(h.taps(), 1, JSON.stringify(key));
    assert.equal(h.isOpen(), false);
  }
  for (const key of ["Enter", " "]) {
    const h = harness();
    let focused = 0;
    h.document.getElementById("crow-talk-close").focus = () => { focused++; };
    h.ev("keydown", { key });
    h.advance(200);
    h.ev("keydown", { key, repeat: true });
    h.advance(CROW_TALK_HOLD_MS);
    assert.equal(h.isOpen(), true, JSON.stringify(key));
    assert.equal(focused, 0, "focus stays on the bird while the key is down (a held Enter on Close would shut it again)");
    const rep = h.ev("keydown", { key, repeat: true });
    assert.equal(rep.defaultPrevented, true);
    const up = h.ev("keyup", { key });
    assert.equal(up.defaultPrevented, true);
    assert.equal(focused, 1);
    assert.equal(h.taps(), 0);
    assert.equal(h.isOpen(), true);
  }
  const h = harness();
  h.ev("keydown", { key: "a" }); h.advance(1000);
  assert.equal(h.isOpen(), false, "other keys do nothing");
});

test("Kiosk not installed: a long-press is just a tap (the tray opens on release) and no overlay opens", () => {
  for (const classic of [false, true]) {
    const h = harness({ talk: false, classic });
    h.ev("pointerdown");
    h.advance(3000);
    assert.equal(h.isOpen(), false);
    h.ev("pointerup"); h.ev("click");
    assert.equal(h.taps(), 1);
    assert.equal(h.tray.style.display, "block");
    const down = h.ev("keydown", { key: "Enter" });
    assert.equal(down.defaultPrevented, false, "the keyboard is left to the browser");
  }
});

test("the Talk to Crow row opens the overlay and puts the tray away", () => {
  const h = harness();
  h.ev("pointerdown"); h.advance(50); h.ev("pointerup"); h.ev("click");
  assert.equal(h.tray.style.display, "block");
  h.document.getElementById("crow-talk-row").dispatchEvent(new h.window.Event("click", { bubbles: true }));
  assert.equal(h.isOpen(), true);
  assert.equal(h.tray.style.display, "none");
  assert.equal(h.document.body.classList.contains("crow-talk-open"), true);
  h.win.openCrowTalk();
  assert.equal(h.overlay.querySelectorAll("iframe").length, 1, "opening twice keeps one frame");
});

test("closing (button, Escape, or the page asking) releases the microphone first, removes the frame and restores the page", () => {
  const closers = [
    (h) => h.document.getElementById("crow-talk-close").dispatchEvent(new h.window.Event("click", { bubbles: true })),
    (h) => h.ev("keydown", { key: "Escape" }, h.document.body),
    (h) => h.win._l.message.forEach((fn) => fn({ origin: h.win.location.origin, data: "crow-talk-close", source: h.frame().contentWindow })),
  ];
  closers.forEach((close, i) => {
    const h = harness();
    h.win.openCrowTalk();
    h.fakePage();
    close(h);
    assert.equal(h.isOpen(), false, "closer " + i);
    assert.equal(h.frame(), null, "frame removed (its document, microphone and socket go with it)");
    assert.deepEqual(h.released, ["released"], "the page was told to stop the mic and audio before removal");
    assert.equal(h.document.body.classList.contains("crow-talk-open"), false);
  });
});

test("a close message from another origin or another window is ignored; Escape with the overlay shut does nothing", () => {
  const h = harness();
  h.win.openCrowTalk();
  h.fakePage();
  h.win._l.message.forEach((fn) => fn({ origin: "https://evil.example", data: "crow-talk-close", source: h.frame().contentWindow }));
  h.win._l.message.forEach((fn) => fn({ origin: h.win.location.origin, data: "crow-talk-close", source: {} }));
  h.win._l.message.forEach((fn) => fn({ origin: h.win.location.origin, data: "something-else", source: h.frame().contentWindow }));
  assert.equal(h.isOpen(), true);
  h.win.closeCrowTalk();
  const e = h.ev("keydown", { key: "Escape" }, h.document.body);
  assert.equal(e.defaultPrevented, false);
  assert.deepEqual(h.released, ["released"], "closed once");
});

test("a page that throws on release still closes", () => {
  const h = harness();
  h.win.openCrowTalk();
  Object.defineProperty(h.frame(), "contentWindow", { configurable: true, get() { throw new Error("gone"); } });
  h.win.closeCrowTalk();
  assert.equal(h.isOpen(), false);
  assert.equal(h.frame(), null);
});

test("the tray row markup: a button that calls openCrowTalk, with the hold hint", () => {
  const html = crowTalkRowHtml("en", { holdTarget: "bird" });
  assert.match(html, /^\s*<button type="button" id="crow-talk-row" class="crow-talk-row"[^>]*onclick="openCrowTalk\(event\)"/);
  assert.ok(html.includes(t("talk.rowHintBird", "en")));
  assert.ok(crowTalkRowHtml("es", { holdTarget: "bell" }).includes(t("talk.rowHintBell", "es")));
  assert.match(crowTalkCss, /\.crow-talk-row\s*\{[^}]*min-height:\s*(5[6-9]|[6-9]\d)px/, "large touch target");
});

test("classic header: a press that starts inside the open tray (the row, a notification, Clear all) never arms the long-press", () => {
  const h = harness({ classic: true });
  h.tray.style.display = "block";
  const inside = h.document.getElementById("notif-list");
  h.ev("pointerdown", {}, inside);
  h.advance(3000);
  assert.equal(h.isOpen(), false, "holding a notification does not open the overlay");
  const down = h.ev("keydown", { key: "Enter" }, h.tray.querySelector("button.btn"));
  assert.equal(down.defaultPrevented, false, "keys inside the tray keep their own behaviour");
  h.advance(3000);
  assert.equal(h.isOpen(), false);
  // The bell itself is still armed.
  h.ev("pointerdown"); h.advance(CROW_TALK_HOLD_MS);
  assert.equal(h.isOpen(), true);
});

test("every inline script the layout emits parses (talk script + header scripts inside the page's template literal)", () => {
  for (const lang of ["en", "es"]) {
    for (const [html, js] of [[tamagotchiHtml(lang, { talkAvailable: true }), tamagotchiJs(lang)], [headerIconsHtml(lang, { talkAvailable: true }), headerIconsJs(lang)]]) {
      const page = renderLayout({ title: "T", content: "<p>x</p>", activePanel: "nest", panels: [], lang, headerIcons: html, scripts: js });
      const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      assert.ok(scripts.length >= 2);
      for (const src of scripts) assert.doesNotThrow(() => new Function(src), lang);
      assert.equal((page.match(/id="crow-talk-row"/g) || []).length, 1);
    }
  }
});

/**
 * Talk to Crow — the dashboard's voice overlay and the header bird's long-press.
 *
 *   tap the bird        → the tray (notifications + health); when the Kiosk
 *                         extension is installed its first row is "Talk to Crow"
 *   press and hold it   → the overlay directly (mouse, touch, or a held
 *                         Enter/Space on the focused bird)
 *
 * The overlay is a same-origin frame on the Kiosk extension's session display
 * (/display/session): the kiosk page for a user who is already logged in to the
 * dashboard, so there is no pairing code. Closing it (the close button, Escape,
 * or the page asking) first tells the page to release the microphone and stop
 * its audio, then removes the frame — the frame's document, socket and media
 * stream go with it.
 *
 * With no Kiosk extension there is no row, the bird is not armed (a long press
 * is an ordinary tap) and nothing here opens. There is no other voice surface
 * behind this button.
 *
 * crowTalkJs() is emitted inside a template literal by renderLayout: it must
 * contain no backtick and no dollar-brace (tests/dashboard-bird-talk.test.js).
 */

import { t } from "./i18n.js";

/** The Kiosk extension's session display (bundles/kiosk/server/runtime.js). */
export const CROW_TALK_PATH = "/display/session";
/** How long the bird must be held. */
export const CROW_TALK_HOLD_MS = 500;

/**
 * Is Talk to Crow available on this instance? Only when the INSTALLED Kiosk
 * panel declares the session display (an older installed copy does not serve
 * /display/session) and its routes actually loaded.
 */
export function isCrowTalkAvailable(kioskPanel, kioskRoutesLoaded) {
  return !!kioskPanel && kioskPanel.sessionDisplay === true && kioskRoutesLoaded === true;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The first row of the tray. `holdTarget` names what to hold: the bird, or the bell in the classic header. */
export function crowTalkRowHtml(lang, { holdTarget = "bird" } = {}) {
  const hint = t(holdTarget === "bell" ? "talk.rowHintBell" : "talk.rowHintBird", lang);
  return `<button type="button" id="crow-talk-row" class="crow-talk-row" onclick="openCrowTalk(event)">
      <svg class="crow-talk-row-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="9" y1="21" x2="15" y2="21"/></svg>
      <span class="crow-talk-row-text"><span class="crow-talk-row-label">${esc(t("talk.row", lang))}</span><span class="crow-talk-row-hint">${esc(hint)}</span></span>
    </button>`;
}

/** The overlay shell. Empty (no frame, no microphone) until openCrowTalk() runs. */
export function crowTalkOverlayHtml(lang) {
  return `<div id="crow-talk-overlay" class="crow-talk-overlay" role="dialog" aria-modal="true" aria-label="${esc(t("talk.row", lang))}">
    <button type="button" id="crow-talk-close" class="crow-talk-close" onclick="closeCrowTalk()" aria-label="${esc(t("talk.close", lang))}" title="${esc(t("talk.close", lang))}">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  </div>`;
}

export const crowTalkCss = `
  /* ─── Talk to Crow ─── */
  /* Above everything the dashboard stacks, including the phone drawer (1100) and its backdrop. */
  .crow-talk-overlay {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 10000;
    background: var(--crow-bg-deep);
  }
  .crow-talk-overlay.active { display: block; }
  .crow-talk-overlay iframe {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
  }
  /* Always visible, in the dashboard's own document: it works even when the frame fails to load. */
  .crow-talk-close {
    position: absolute;
    top: calc(0.5rem + env(safe-area-inset-top, 0px));
    right: calc(0.5rem + env(safe-area-inset-right, 0px));
    z-index: 10001;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 1px solid var(--crow-border);
    background: var(--crow-bg-surface);
    color: var(--crow-text-primary);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 8px rgba(0,0,0,0.25);
  }
  .crow-talk-close:hover { border-color: var(--crow-accent); color: var(--crow-accent); }
  .crow-talk-close:focus-visible { outline: 2px solid var(--crow-accent); outline-offset: 2px; }
  body.crow-talk-open { overflow: hidden; }
  .crow-talk-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    min-height: 64px;
    padding: 0.75rem 1rem;
    border: 0;
    border-bottom: 1px solid var(--crow-border);
    border-radius: 10px 10px 0 0;
    background: color-mix(in srgb, var(--crow-accent) 10%, transparent);
    color: var(--crow-accent);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .crow-talk-row:hover { background: color-mix(in srgb, var(--crow-accent) 18%, transparent); }
  .crow-talk-row:focus-visible { outline: 2px solid var(--crow-accent); outline-offset: -2px; }
  .crow-talk-row-icon { flex-shrink: 0; }
  .crow-talk-row-text { display: flex; flex-direction: column; min-width: 0; }
  .crow-talk-row-label { font-size: 1.05rem; font-weight: 700; line-height: 1.25; }
  .crow-talk-row-hint { font-size: 0.72rem; color: var(--crow-text-muted); line-height: 1.3; }
  /* A held finger must not select text, open the image callout or scroll the page under the bird. */
  [data-crow-talk] { -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; touch-action: manipulation; }
`;

export function crowTalkJs() {
  return `
(function () {
  // Once per document: under Turbo this script re-runs on every body swap, and
  // every listener below is delegated from document/window (which survive it).
  if (window.__crowTalkInit) return;
  window.__crowTalkInit = true;
  var TALK_PATH = ${JSON.stringify(CROW_TALK_PATH)};
  var HOLD_MS = ${CROW_TALK_HOLD_MS};
  var MOVE_PX = 10;
  var press = null;            // the press in progress: { el, x, y, key, touch, fired, timer }
  var lastTouch = null;        // { el, at }: the last finger that went down on the bird
  var swallowTap = false;      // the click that ends a long-press is not a tap
  var deferredFocus = false;   // opened by a held key: focus Close only once the key is up
  var lastFocus = null;

  function overlay() { return document.getElementById('crow-talk-overlay'); }
  function frameEl() { return document.getElementById('crow-talk-frame'); }
  function isOpen() { var o = overlay(); return !!(o && o.classList.contains('active')); }
  function focusClose() { var x = document.getElementById('crow-talk-close'); if (x && typeof x.focus === 'function') x.focus(); }

  function openTalk(fromKey) {
    var o = overlay();
    if (!o || o.classList.contains('active')) return;
    var trays = document.querySelectorAll('.crow-dropdown, .header-dropdown');
    for (var i = 0; i < trays.length; i++) trays[i].style.display = 'none';
    var owners = document.querySelectorAll('[aria-controls="crow-dropdown"], [aria-controls="notif-dropdown"]');
    for (var j = 0; j < owners.length; j++) owners[j].setAttribute('aria-expanded', 'false');
    lastFocus = document.activeElement || null;
    var frame = document.createElement('iframe');
    frame.id = 'crow-talk-frame';
    frame.setAttribute('src', TALK_PATH);
    frame.setAttribute('title', o.getAttribute('aria-label') || '');
    frame.setAttribute('allow', 'microphone; autoplay');
    o.appendChild(frame);
    o.classList.add('active');
    document.body.classList.add('crow-talk-open');
    // A key still held down would land on Close as a click and shut the overlay again.
    if (fromKey) deferredFocus = true; else focusClose();
  }

  function closeTalk() {
    var o = overlay();
    if (!o) return;
    var frame = frameEl();
    if (frame) {
      // Stop the microphone and any audio NOW (same-origin call), then drop the frame:
      // its document, media stream and socket are destroyed with it either way.
      try {
        var w = frame.contentWindow;
        if (w && typeof w.crowKioskRelease === 'function') w.crowKioskRelease();
      } catch (e) {}
      if (frame.parentNode) frame.parentNode.removeChild(frame);
    }
    var wasOpen = o.classList.contains('active');
    o.classList.remove('active');
    document.body.classList.remove('crow-talk-open');
    deferredFocus = false;
    try {
      if (wasOpen && lastFocus && typeof lastFocus.focus === 'function' && document.body.contains(lastFocus)) lastFocus.focus();
    } catch (e) {}
    lastFocus = null;
  }

  /** The armed bird (or bell) under this node — never from inside its open tray, whose rows have their own taps. */
  function talkTarget(node) {
    if (!node || typeof node.closest !== 'function') return null;
    if (node.closest('.crow-dropdown, .header-dropdown')) return null;
    return node.closest('[data-crow-talk]');
  }
  function cancelPress() { if (press) { clearTimeout(press.timer); press = null; } }
  function fire() {
    if (!press || press.fired) return;
    press.fired = true;
    clearTimeout(press.timer);
    press.timer = null;
    if (press.key == null) swallowTap = true;
    try { if (press.touch && navigator.vibrate) navigator.vibrate(15); } catch (e) {}
    openTalk(press.key != null);
  }
  function startPress(el, info) {
    cancelPress();
    press = { el: el, x: info.x || 0, y: info.y || 0, key: info.key == null ? null : info.key, touch: !!info.touch, fired: false, timer: null };
    press.timer = setTimeout(fire, HOLD_MS);
  }

  document.addEventListener('pointerdown', function (e) {
    swallowTap = false;                       // a new gesture: whatever was pending is over
    var el = talkTarget(e.target);
    if (!el) return;
    if (e.button || e.isPrimary === false) return;
    var touch = !!e.pointerType && e.pointerType !== 'mouse';
    if (touch) lastTouch = { el: el, at: Date.now() };
    startPress(el, { x: e.clientX, y: e.clientY, touch: touch });
  });
  document.addEventListener('pointermove', function (e) {
    if (!press || press.key != null || press.fired) return;
    var dx = (e.clientX || 0) - press.x, dy = (e.clientY || 0) - press.y;
    if (dx * dx + dy * dy > MOVE_PX * MOVE_PX) cancelPress();
  });
  function endPointer() { if (press && press.key == null) cancelPress(); }
  document.addEventListener('pointerup', endPointer);
  document.addEventListener('pointercancel', endPointer);

  // Touch browsers have their own long-press (the context menu). On the bird it IS the
  // long-press: suppress the menu and open now, even if it cancelled the pointer first.
  document.addEventListener('contextmenu', function (e) {
    var el = talkTarget(e.target);
    if (!el) return;
    var mine = press && press.el === el && press.touch;
    var recent = lastTouch && lastTouch.el === el && Date.now() - lastTouch.at < 1500;
    if (!mine && !recent) return;             // a mouse right-click keeps its menu
    e.preventDefault();
    lastTouch = null;
    if (press && press.el === el) { if (!press.fired) fire(); return; }
    if (!isOpen()) { swallowTap = true; try { if (navigator.vibrate) navigator.vibrate(15); } catch (err) {} openTalk(false); }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (isOpen()) { closeTalk(); e.stopPropagation(); }
      return;
    }
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    var el = talkTarget(e.target);
    if (!el) return;
    // Decided on key-up: a tap opens the tray, a hold opens the overlay. Holding back the
    // default also stops auto-repeat from clicking the bird over and over.
    e.preventDefault();
    if (e.repeat || press) return;
    startPress(el, { key: e.key });
  });
  document.addEventListener('keyup', function (e) {
    if (!press || press.key == null || e.key !== press.key) return;
    e.preventDefault();
    var p = press;
    cancelPress();
    if (p.fired) { if (deferredFocus) { deferredFocus = false; focusClose(); } return; }
    if (p.el && typeof p.el.click === 'function') p.el.click();
  });

  // The kiosk page asks to close (Escape pressed while focus is inside the frame).
  window.addEventListener('message', function (e) {
    if (!e || e.data !== 'crow-talk-close' || e.origin !== location.origin) return;
    var frame = frameEl();
    var w = null;
    try { w = frame ? frame.contentWindow : null; } catch (err) { w = null; }
    if (!frame || e.source !== w) return;
    closeTalk();
  });

  /** For the bird's own click handler: true (once) when this click only ended a long-press. */
  window.crowTalkSwallowTap = function () { if (!swallowTap) return false; swallowTap = false; return true; };
  window.openCrowTalk = function (e) { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); openTalk(false); };
  window.closeCrowTalk = closeTalk;
})();
`;
}

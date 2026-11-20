/**
 * The kiosk page's on-screen keyboard (queue item 69), loaded on demand by kiosk.js.
 *
 * The Pi's kiosk runs under the cage compositor, which has no layer-shell and no input-method
 * protocol, so no system keyboard can ever come up: the keyboard has to be part of the page. A
 * phone (a session display) brings its own keyboard, so this module is never part of a plain page
 * load — kiosk.js reaches it through import("./osk.js") the first time a field needs it.
 *
 * LAYOUTS and applyKey are pure (no DOM); mountOsk builds the DOM out of
 * createElement/textContent/createElementNS only (never markup) and is the only part that touches
 * the page. Nothing here runs at import time.
 */

/** The key rows as drawn: `letters` is QWERTY, `symbols` the "?123" layer (es adds ñ to row 2). */
export const LAYOUTS = {
  en: {
    letters: ["qwertyuiop", "asdfghjkl", "zxcvbnm"],
    symbols: ["1234567890", "-/:;()$&@\"", ".,?!'"],
  },
  es: {
    letters: ["qwertyuiop", "asdfghjklñ", "zxcvbnm"],
    symbols: ["1234567890", "-/:;()$&@\"", ".,?!'"],
  },
};

/** The typed-message cap the page's field carries (state.js MAX_TEXT_CHARS). */
const MAX_TEXT = 500;
const SVG_NS = "http://www.w3.org/2000/svg";
/** The stylesheet link's id: kiosk.js and this module agree on exactly one link per page load. */
const CSS_ID = "osk-css";
const CSS_HREF = "/display/assets/osk.css";
/** Glyph keys (shift, backspace, hide) draw a path instead of a character. */
const GLYPHS = {
  shift: "M12 3.5 19 11h-4.2v9.5H9.2V11H5z",
  backspace: "M9 5h11a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9L3 12zM11.5 9.5l5 5M16.5 9.5l-5 5",
  hide: "M6 9l6 6 6-6",
};

/**
 * One key press on the text. `state` = { value, start, end, layer: "letters" | "symbols", shift };
 * `key` = { k: "char", ch } | { k: "space" } | { k: "backspace" } | { k: "shift" } | { k: "layer" }.
 * Returns the NEXT state (never mutates the argument): a collapsed caret after every insert,
 * replace or delete, `shift` one-shot on the letters layer, and nothing inserted past `maxLen`.
 */
export function applyKey(state, key, { maxLen = MAX_TEXT } = {}) {
  const s = state || {};
  const value = typeof s.value === "string" ? s.value : "";
  const len = value.length;
  const at = (n, fallback) => (Number.isFinite(n) ? Math.min(Math.max(0, Math.trunc(n)), len) : fallback);
  const start0 = at(s.start, len);
  const end0 = at(s.end, start0);
  const a = Math.min(start0, end0);
  const b = Math.max(start0, end0);
  const layer = s.layer === "symbols" ? "symbols" : "letters";
  const shift = s.shift === true;
  const base = { value, start: a, end: b, layer, shift };
  const kind = key && typeof key === "object" ? key.k : null;

  if (kind === "shift") return layer === "letters" ? { ...base, shift: !shift } : { ...base };
  if (kind === "layer") return { ...base, layer: layer === "letters" ? "symbols" : "letters", shift: false };
  if (kind === "backspace") {
    if (a !== b) return { value: value.slice(0, a) + value.slice(b), start: a, end: a, layer, shift };
    if (a === 0) return { ...base };
    return { value: value.slice(0, a - 1) + value.slice(a), start: a - 1, end: a - 1, layer, shift };
  }

  let text = null;
  if (kind === "char" && typeof key.ch === "string" && key.ch) text = key.ch;
  else if (kind === "space") text = " ";
  if (text === null) return { ...base };

  const capital = layer === "letters" && shift;
  const insert = capital ? text.toUpperCase() : text;
  if (len - (b - a) + insert.length > maxLen) return { ...base };
  const caret = a + insert.length;
  return { value: value.slice(0, a) + insert + value.slice(b), start: caret, end: caret, layer, shift: capital ? false : shift };
}

/**
 * Build the keyboard inside `host` (an element mountOsk creates and appends when none is given),
 * with the field the keys type into and the form its Send key submits.
 *   mountOsk({ host, input, form, lang, t, onClose, doc }) → { open(), close(), isOpen(), destroy() }
 * Every key is a <button type="button">; a key press never moves the focus (pointerdown/mousedown
 * are cancelled), so the caret stays where the user left it in the field.
 */
export function mountOsk(options = {}) {
  const { host = null, input = null, form = null, lang = "en", t = (k) => k, onClose = null, doc: docOpt = null } = options || {};
  const doc = docOpt || (typeof document === "undefined" ? null : document);
  const idle = { open() {}, close() {}, isOpen: () => false, destroy() {} };
  if (!doc || !input || typeof doc.createElement !== "function") return idle;

  const win = doc.defaultView || globalThis;
  const layout = LAYOUTS[lang] || LAYOUTS.en;
  const str = (key) => {
    let v = null;
    try { v = typeof t === "function" ? t(key) : null; } catch { v = null; }
    return typeof v === "string" && v ? v : key;
  };
  const el = (tag, cls) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    return node;
  };
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };

  // ── the host ───────────────────────────────────────────────────────────────
  const root = el("div", "k-osk");
  root.id = "osk";
  root.hidden = true;
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", str("osk_label"));
  const parent = host && host.nodeType === 1 && (host.isConnected || host === doc.body) ? host : doc.body || doc.documentElement;
  parent.appendChild(root);

  /**
   * The stylesheet rides along with the module: one link, never two. The page's own kiosk.css sits next to
   * it and a "ends in osk.css" test would match it too — the id (and the exact href) is what tells them apart.
   */
  function ensureStylesheet() {
    try {
      if (doc.getElementById(CSS_ID) || doc.querySelector(`link[href="${CSS_HREF}"]`)) return;
      const link = doc.createElement("link");
      link.id = CSS_ID;
      link.rel = "stylesheet";
      link.href = CSS_HREF;
      // The measured height is what the page makes room for, and it cannot be read before the rules land.
      link.addEventListener("load", () => measure());
      (doc.head || doc.documentElement).appendChild(link);
    } catch { /* a page that cannot take a link still gets the keys */ }
  }

  // ── the key state (layer and whether shift is armed) ─────────────────────
  const state = { layer: "letters", shift: false };
  let open = false;
  let firstRepeat = 0;
  let everyRepeat = 0;

  function glyph(name) {
    const svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "24");
    svg.setAttribute("class", "k-osk-glyph");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", GLYPHS[name] || GLYPHS.hide);
    svg.appendChild(path);
    return svg;
  }

  function makeKey({ label = "", aria = null, title = null, cls = "", svg = null, pressed = null } = {}) {
    const btn = el("button", "k-osk-key" + (cls ? " " + cls : ""));
    btn.type = "button";
    if (aria) btn.setAttribute("aria-label", aria);
    if (title) btn.title = title;
    if (pressed !== null) btn.setAttribute("aria-pressed", pressed ? "true" : "false");
    if (svg) btn.appendChild(glyph(svg));
    else btn.textContent = label;
    return btn;
  }

  function stopRepeat() {
    if (firstRepeat) { win.clearTimeout(firstRepeat); firstRepeat = 0; }
    if (everyRepeat) { win.clearInterval(everyRepeat); everyRepeat = 0; }
  }

  /** Holding a key repeats it: once after 400 ms, then every 60 ms until the finger or mouse goes. */
  function startRepeat(action) {
    stopRepeat();
    action();
    firstRepeat = win.setTimeout(() => {
      firstRepeat = 0;
      everyRepeat = win.setInterval(action, 60);
    }, 400);
  }

  /**
   * A key never takes the focus: its pointerdown is cancelled and the action runs by hand. A synthetic
   * click — a screen reader or other assistive tech, which has no pointer behind it — runs the same
   * action; every pointer path carries a detail of 1 or more, so nothing ever happens twice.
   */
  function bind(btn, action, { repeat = false } = {}) {
    btn.addEventListener("pointerdown", (ev) => {
      if (ev.button > 0) return;              // the right or middle button is no key press
      ev.preventDefault();
      ev.stopPropagation();
      if (repeat) startRepeat(action);
      else action();
    });
    if (repeat) for (const name of ["pointerup", "pointercancel", "pointerleave"]) btn.addEventListener(name, stopRepeat);
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      if (ev.detail === 0) action();           // no pointer behind it: this IS the key press
    });
  }

  // ── the keys ─────────────────────────────────────────────────────────────
  function press(key) {
    const value = typeof input.value === "string" ? input.value : "";
    const cur = {
      value,
      start: Number.isFinite(input.selectionStart) ? input.selectionStart : value.length,
      end: Number.isFinite(input.selectionEnd) ? input.selectionEnd : value.length,
      layer: state.layer,
      shift: state.shift,
    };
    const next = applyKey(cur, key, { maxLen: MAX_TEXT });
    state.layer = next.layer;
    state.shift = next.shift;
    if (next.value !== cur.value) {
      input.value = next.value;
      try { input.setSelectionRange(next.start, next.end); } catch { /* a field without a selection API */ }
      try { input.dispatchEvent(new win.Event("input", { bubbles: true })); } catch { /* no Event constructor */ }
    }
    if (next.layer !== cur.layer || next.shift !== cur.shift) render();
  }

  /** Send goes through the page's own path (the submit handler), then puts the keyboard away. */
  function send() {
    try {
      if (form && typeof form.requestSubmit === "function") form.requestSubmit();
      else if (form && typeof form.submit === "function") form.submit();
    } catch { /* an invalid form stays as it is */ }
    closeKeyboard();
  }

  function charKey(ch) {
    const label = state.layer === "letters" && state.shift ? ch.toUpperCase() : ch;
    const btn = makeKey({ label });
    bind(btn, () => press({ k: "char", ch }));
    return btn;
  }

  function charRow(chars) {
    const row = el("div", "k-osk-row");
    for (const ch of chars) row.appendChild(charKey(ch));
    return row;
  }

  /** Backspace, with the hold-to-repeat both layers give it. */
  function backKey() {
    const btn = makeKey({ aria: str("osk_backspace"), title: str("osk_backspace"), cls: "is-special", svg: "backspace" });
    bind(btn, () => press({ k: "backspace" }), { repeat: true });
    return btn;
  }

  function bottomRow() {
    const row = el("div", "k-osk-row");
    const layerKey = makeKey({ label: state.layer === "letters" ? str("osk_symbols") : str("osk_letters"), cls: "is-special" });
    bind(layerKey, () => press({ k: "layer" }));
    const hideKey = makeKey({ aria: str("type_close"), title: str("type_close"), cls: "is-special", svg: "hide" });
    bind(hideKey, () => closeKeyboard());
    const spaceKey = makeKey({ label: str("osk_space"), cls: "is-space" });
    bind(spaceKey, () => press({ k: "space" }));
    const sendKey = makeKey({ label: str("type_send"), cls: "is-send" });
    bind(sendKey, () => send());
    row.appendChild(layerKey);
    row.appendChild(hideKey);
    row.appendChild(spaceKey);
    row.appendChild(sendKey);
    return row;
  }

  function lettersRows() {
    const [row1, row2, row3] = layout.letters;
    root.appendChild(charRow(row1));
    root.appendChild(charRow(row2));
    const row = el("div", "k-osk-row");
    const shiftKey = makeKey({ aria: str("osk_shift"), title: str("osk_shift"), cls: "is-special", svg: "shift", pressed: state.shift });
    bind(shiftKey, () => press({ k: "shift" }));
    row.appendChild(shiftKey);
    for (const ch of row3) row.appendChild(charKey(ch));
    row.appendChild(backKey());
    root.appendChild(row);
  }

  /** The ?123 layer: its third row keeps a Backspace beside the punctuation, so deleting needs no trip to ABC. */
  function symbolsRows() {
    const [row1, row2, row3] = layout.symbols;
    root.appendChild(charRow(row1));
    root.appendChild(charRow(row2));
    const row = el("div", "k-osk-row");
    row.appendChild(backKey());
    for (const ch of row3) row.appendChild(charKey(ch));
    root.appendChild(row);
  }

  function render() {
    clear(root);
    if (state.layer === "symbols") symbolsRows();
    else lettersRows();
    root.appendChild(bottomRow());
  }

  // ── open / close ─────────────────────────────────────────────────────────
  /** The measured height is what the page makes room for (osk.css reads --osk-h). */
  function measure() {
    if (!open) return;
    const html = doc.documentElement;
    let h = 0;
    try { h = Math.round(root.getBoundingClientRect().height); } catch { h = 0; }
    if (h > 0) html.style.setProperty("--osk-h", h + "px");
  }

  function onResize() { measure(); }

  function openKeyboard() {
    render();
    ensureStylesheet();
    root.hidden = false;
    open = true;
    doc.documentElement.classList.add("k-osk-open");
    try { input.setAttribute("inputmode", "none"); } catch { /* an older field */ }
    // The stylesheet may still be on its way: measure now, then again once it has had time to apply.
    measure();
    for (const ms of [0, 60, 200]) win.setTimeout(measure, ms);
  }

  function closeKeyboard() {
    stopRepeat();
    const was = open;
    open = false;
    root.hidden = true;
    const html = doc.documentElement;
    html.classList.remove("k-osk-open");
    html.style.removeProperty("--osk-h");
    // inputmode is NOT undone here: the page owns it and removes it when no keyboard is wanted any more.
    if (was && typeof onClose === "function") {
      try { onClose(); } catch { /* the page's own callback never breaks the keyboard */ }
    }
  }

  function destroy() {
    stopRepeat();
    open = false;
    try { win.removeEventListener("resize", onResize); } catch { /* no window */ }
    try { if (root.parentNode) root.parentNode.removeChild(root); } catch { /* already gone */ }
    const html = doc.documentElement;
    html.classList.remove("k-osk-open");
    html.style.removeProperty("--osk-h");
  }

  // A tap on the keyboard's own padding (or a stray mouse press) must not take the focus either, and a
  // finger on a key must not blur the field (the touch's own compatibility mouse events are cancelled
  // too, so a finger press acts once — through pointerdown).
  for (const name of ["pointerdown", "mousedown", "contextmenu"]) root.addEventListener(name, (ev) => ev.preventDefault());
  root.addEventListener("touchstart", (ev) => ev.preventDefault(), { passive: false });
  try { win.addEventListener("resize", onResize); } catch { /* no window */ }
  render();

  return { open: openKeyboard, close: closeKeyboard, isOpen: () => open, destroy };
}
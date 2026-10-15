/**
 * The anchor helper (spec §5.3), injected by the artifact origin into the HTML
 * of scripted types. It runs in the SAME realm as untrusted content, which can
 * override or impersonate it, so everything it sends is an untrusted proposal
 * (the viewer validates schema, size and rate, and acts only on a user gesture
 * in the trusted rail).
 *
 * It does two things:
 *   1. hello: posts the per-load nonce once, so the viewer's navigation
 *      tripwire can tell this load from a navigated one (with the load count);
 *   2. comment mode: when the viewer turns it on, a click proposes an element
 *      anchor (not in select-only mode: documents, D28) and a text selection
 *      proposes a text-range anchor. Selections are read from a DEBOUNCED
 *      selectionchange (review H1: a phone's long-press selection fires no
 *      mouseup), at most one proposal per 400 ms and never the same quote
 *      twice in a row; entering comment mode proposes the current selection.
 *      Proposals carry `block`: the id of the selection's (or click's)
 *      enclosing renderer block (#b<n>), else null;
 *   3. pins: given the owner's numbered anchors, it reports where they are
 *      ({kind:"anchor-rect"}), at most every 250 ms (well under the viewer's
 *      flood limit). A quote is matched whitespace-insensitively across
 *      inline elements; a document block anchor may carry the block's own
 *      words and which occurrence (nth, S1). Each rect is the quote's FIRST
 *      line box plus bx, the enclosing block's left edge (the pin gutter).
 *      The rects are cosmetic and untrusted: the viewer clamps them and a pin
 *      only focuses a thread in the trusted rail. The same quote ranges are
 *      painted with the CSS Highlight API (S3; an adopted, constructed sheet);
 *      element and whole-block anchors are not painted.
 *   4. selection-cleared (S6, plan Rev 3 H2): documents keep selection on
 *      all the time, so when a selection goes away the viewer must hide its
 *      "Comment on …" button. Posted ONLY on a real selected→collapsed
 *      transition (taps and caret moves on a collapsed selection post
 *      nothing), at most once per 250 ms (trailing).
 * The viewer never posts anything sensitive in: only {kind:"comment-mode"}
 * and {kind:"pins"} (owner anchors the content itself proposed).
 *
 * MESSAGE BUDGET: the viewer trips its wire at more than 20 messages a
 * second, so this helper stays at or under 10: hello (once) + anchor-rect
 * (at most 4/s) + proposals (at most 2.5/s: one per 400 ms) + selection-
 * cleared (at most 4/s). Anything new must fit in what is left.
 */
export function anchorHelperSource(nonce) {
  const n = JSON.stringify(String(nonce));
  return `(() => {
  "use strict";
  const NONCE = ${n};
  const post = (m) => { try { parent.postMessage(Object.assign({ t: "crow-artifact", nonce: NONCE }, m), "*"); } catch (e) {} };
  let on = false, selectOnly = false, selTimer = 0, lastQuote = "";
  const clip = (s, n) => String(s || "").replace(/\\s+/g, " ").trim().slice(0, n);
  function selectorOf(el) {
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 12) {
      if (el.id && /^[A-Za-z][\\w-]{0,63}$/.test(el.id)) { parts.unshift("#" + el.id); break; }
      let i = 1, s = el;
      while ((s = s.previousElementSibling)) if (s.tagName === el.tagName) i++;
      parts.unshift(el.tagName.toLowerCase() + ":nth-of-type(" + i + ")");
      el = el.parentElement;
    }
    return parts.join(" > ");
  }
  let pins = [], last = 0, timer = 0;
  function blockOf(node) {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    for (let i = 0; el && i < 64; i++, el = el.parentElement) if (el.id && /^b\\d{1,6}$/.test(el.id)) return el.id;
    return null;
  }
  /* S1: a root's text with ALL whitespace removed, each character mapped
     back to its (text node, offset), so a quote matches across inline
     elements (<strong>, <a>) and whatever spacing the rendering has. Bounded
     at 200 KB; built once per root per rect pass. */
  function compactOf(root, cache) {
    if (cache && cache.has(root)) return cache.get(root);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let c = "", n;
    const at = [];
    while ((n = w.nextNode()) && c.length < 200000) {
      const d = n.data;
      for (let i = 0; i < d.length && c.length < 200000; i++) if (!/\\s/.test(d[i])) { c += d[i]; at.push(n, i); }
    }
    const out = { c: c, at: at };
    if (cache) cache.set(root, out);
    return out;
  }
  /* The nth (0-based, overlapping: the server counts the same way) occurrence
     of q in root, whitespace-insensitive, as a Range; null when absent. */
  function quoteRange(root, q, nth, cache) {
    const qq = String(q || "").replace(/\\s+/g, "");
    if (!qq) return null;
    const t = compactOf(root, cache);
    let pos = t.c.indexOf(qq);
    for (let k = 0; pos >= 0 && k < Math.min(Number(nth) || 0, 9999); k++) pos = t.c.indexOf(qq, pos + 1);
    if (pos < 0) return null;
    const e = pos + qq.length - 1;
    const r = document.createRange();
    r.setStart(t.at[2 * pos], t.at[2 * pos + 1]);
    r.setEnd(t.at[2 * e], t.at[2 * e + 1] + 1);
    return r;
  }
  /* The first line box of a range (a wrapped quote pins its first line). */
  function firstBox(r) {
    const rs = r.getClientRects();
    for (let k = 0; k < rs.length; k++) if (rs[k].width > 0 || rs[k].height > 0) return rs[k];
    return r.getBoundingClientRect();
  }
  /* The left edge of the nearest block-level ancestor: the pin gutter. */
  function blockLeft(node) {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    for (let i = 0; el && i < 64; i++, el = el.parentElement) {
      if (!/^inline/.test(getComputedStyle(el).display)) return el.getBoundingClientRect().left;
    }
    return 0;
  }
  function rectOf(a, cache) {
    try {
      if (a.kind === "element") { const el = document.querySelector(a.selector); if (!el) return null; const b = el.getBoundingClientRect(); return { box: b, bx: b.left }; }
      if (a.kind === "block" && /^b\\d{1,6}$/.test(a.id || "")) {
        const el = document.getElementById(a.id);
        if (!el) return null;
        const r = a.quote ? quoteRange(el, a.quote, a.nth, cache) : null;
        return { box: r ? firstBox(r) : el.getBoundingClientRect(), bx: el.getBoundingClientRect().left, range: r };
      }
      if (a.kind === "text" && a.quote) {
        const r = quoteRange(document.body || document.documentElement, a.quote, 0, cache);
        if (r) return { box: firstBox(r), bx: blockLeft(r.startContainer), range: r };
      }
    } catch (e) {}
    return null;
  }
  /* S3: the pinned quotes stay highlighted (CSS Custom Highlight API). The
     style is a CONSTRUCTED sheet adopted by the document: no <style> node,
     and independent of the style-src policy. No CSS.highlights (older
     browsers): nothing is painted and the pin stays. A page's own CSS can
     restyle ::highlight(crow-comments): cosmetic, and fine. */
  let hlSheet = null;
  function paint(ranges) {
    try {
      if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight !== "function") return;
      if (!ranges.length) { CSS.highlights.delete("crow-comments"); return; }
      if (!hlSheet && Array.isArray(document.adoptedStyleSheets) && typeof CSSStyleSheet === "function") {
        hlSheet = new CSSStyleSheet();
        hlSheet.replaceSync("::highlight(crow-comments){background-color:rgba(255,196,0,.35)}");
        document.adoptedStyleSheets = document.adoptedStyleSheets.concat([hlSheet]);
      }
      CSS.highlights.set("crow-comments", new Highlight(...ranges));
    } catch (e) {}
  }
  function sendRects() {
    timer = 0; last = Date.now();
    const rects = [], ranges = [], cache = new Map();
    for (const p of pins.slice(0, 100)) {
      const r = rectOf(p.anchor || {}, cache);
      if (!r) continue;
      rects.push({ i: p.i, x: r.box.left, y: r.box.top, w: r.box.width, h: r.box.height, bx: r.bx });
      if (r.range) ranges.push(r.range);
    }
    paint(ranges);
    post({ kind: "anchor-rect", rects });
  }
  function queueRects() { if (!pins.length || timer) return; timer = setTimeout(sendRects, Math.max(0, 250 - (Date.now() - last))); }
  addEventListener("scroll", queueRects, true);
  addEventListener("resize", queueRects);
  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || e.data.t !== "crow-viewer") return;
    if (e.data.kind === "comment-mode") { on = !!e.data.on; selectOnly = !!e.data.selectOnly; lastQuote = ""; if (on) proposeSelection(); }
    if (e.data.kind === "pins" && Array.isArray(e.data.pins)) { pins = e.data.pins; if (!pins.length) paint([]); queueRects(); }
  });
  addEventListener("click", (e) => {
    if (!on || selectOnly) return;   // documents (D28): selection only, a tap proposes nothing
    e.preventDefault(); e.stopPropagation();
    const el = e.target && e.target.nodeType === 1 ? e.target : null;
    if (!el) return;
    const sel = getSelection && getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    post({ kind: "anchor", anchor: { kind: "element", selector: selectorOf(el), text: clip(el.textContent, 200), block: blockOf(el) } });
  }, true);
  function proposeSelection() {
    selTimer = 0;
    if (!on) return;
    const sel = getSelection && getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const quote = clip(sel.toString(), 500);
    if (!quote || quote === lastQuote) return;
    lastQuote = quote;
    // S1/M2: the context is THIS selection's, read around the range itself
    // (within its block, else the body), so a repeated phrase stays
    // distinguishable: never the first occurrence's.
    const range = sel.getRangeAt(0);
    const block = blockOf(range.commonAncestorContainer);
    const root = (block && document.getElementById(block)) || document.body || document.documentElement;
    let prefix = "", suffix = "";
    try {
      const pre = document.createRange(); pre.selectNodeContents(root); pre.setEnd(range.startContainer, range.startOffset);
      prefix = String(pre.toString()).replace(/\\s+/g, " ").slice(-40);
      const aft = document.createRange(); aft.selectNodeContents(root); aft.setStart(range.endContainer, range.endOffset);
      suffix = String(aft.toString()).replace(/\\s+/g, " ").slice(0, 40);
    } catch (e) {}
    post({ kind: "anchor", anchor: { kind: "text", quote, prefix, suffix, block } });
  }
  let hadSel = false, clrTimer = 0, clrLast = 0;
  function postCleared() {
    clrTimer = 0;
    const cur = getSelection && getSelection();
    if (cur && !cur.isCollapsed) return;   // selected again meanwhile: nothing to clear
    clrLast = Date.now();
    post({ kind: "selection-cleared" });
  }
  document.addEventListener("selectionchange", () => {
    if (!on) return;
    const cur = getSelection && getSelection();
    if (!cur || cur.isCollapsed) {
      lastQuote = "";   // re-selecting the same words proposes again
      // S6/H2: only a selected→collapsed transition, throttled (trailing).
      if (hadSel) { hadSel = false; if (!clrTimer) clrTimer = setTimeout(postCleared, Math.max(0, 250 - (Date.now() - clrLast))); }
    } else hadSel = true;
    clearTimeout(selTimer);
    selTimer = setTimeout(proposeSelection, 400);
  });
  post({ kind: "hello" });
})();
`;
}

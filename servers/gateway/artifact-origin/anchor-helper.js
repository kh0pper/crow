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
 *      anchor and a text selection proposes a text-range anchor;
 *   3. pins: given the owner's numbered anchors, it reports where they are
 *      ({kind:"anchor-rect"}), at most every 250 ms (well under the viewer's
 *      flood limit). The rects are cosmetic and untrusted: the viewer clamps
 *      them and a pin only focuses a thread in the trusted rail.
 * The viewer never posts anything sensitive in: only {kind:"comment-mode"}
 * and {kind:"pins"} (owner anchors the content itself proposed).
 */
export function anchorHelperSource(nonce) {
  const n = JSON.stringify(String(nonce));
  return `(() => {
  "use strict";
  const NONCE = ${n};
  const post = (m) => { try { parent.postMessage(Object.assign({ t: "crow-artifact", nonce: NONCE }, m), "*"); } catch (e) {} };
  let on = false;
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
  function rectOf(a) {
    try {
      if (a.kind === "element") { const el = document.querySelector(a.selector); return el ? el.getBoundingClientRect() : null; }
      if (a.kind === "text" && a.quote) {
        const w = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
          const at = n.data.indexOf(a.quote.slice(0, 200));
          if (at >= 0) { const r = document.createRange(); r.setStart(n, at); r.setEnd(n, Math.min(n.data.length, at + a.quote.length)); return r.getBoundingClientRect(); }
        }
      }
    } catch (e) {}
    return null;
  }
  function sendRects() {
    timer = 0; last = Date.now();
    const rects = [];
    for (const p of pins.slice(0, 100)) {
      const r = rectOf(p.anchor || {});
      if (r) rects.push({ i: p.i, x: r.left, y: r.top, w: r.width, h: r.height });
    }
    post({ kind: "anchor-rect", rects });
  }
  function queueRects() { if (!pins.length || timer) return; timer = setTimeout(sendRects, Math.max(0, 250 - (Date.now() - last))); }
  addEventListener("scroll", queueRects, true);
  addEventListener("resize", queueRects);
  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || e.data.t !== "crow-viewer") return;
    if (e.data.kind === "comment-mode") on = !!e.data.on;
    if (e.data.kind === "pins" && Array.isArray(e.data.pins)) { pins = e.data.pins; queueRects(); }
  });
  addEventListener("click", (e) => {
    if (!on) return;
    e.preventDefault(); e.stopPropagation();
    const el = e.target && e.target.nodeType === 1 ? e.target : null;
    if (!el) return;
    const sel = getSelection && getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    post({ kind: "anchor", anchor: { kind: "element", selector: selectorOf(el), text: clip(el.textContent, 200) } });
  }, true);
  addEventListener("mouseup", () => {
    if (!on) return;
    const sel = getSelection && getSelection();
    if (!sel || sel.isCollapsed) return;
    const quote = clip(sel.toString(), 500);
    if (!quote) return;
    const all = clip(document.body ? document.body.textContent : "", 200000);
    const at = all.indexOf(quote);
    post({ kind: "anchor", anchor: { kind: "text", quote,
      prefix: at > 0 ? all.slice(Math.max(0, at - 40), at) : "",
      suffix: at >= 0 ? all.slice(at + quote.length, at + quote.length + 40) : "" } });
  }, true);
  post({ kind: "hello" });
})();
`;
}

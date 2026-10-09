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
 *      anchor and a text selection proposes a text-range anchor.
 * The viewer never posts anything sensitive in: only {kind:"comment-mode"}.
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
  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || e.data.t !== "crow-viewer") return;
    if (e.data.kind === "comment-mode") on = !!e.data.on;
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

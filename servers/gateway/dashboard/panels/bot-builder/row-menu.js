/**
 * Bot Builder list — the row ⋯ menu's client script (queue item 20, option A).
 *
 * Same semantics as the Perch session rows' menu (perch-hub/client.js,
 * buildRowMenu): the menu opens INLINE under its row; opening one closes the
 * others; ArrowDown on the trigger opens it on its first item; arrows,
 * Home/End move inside; Escape closes and hands focus back to the trigger; an
 * outside click closes it, and so does focus leaving it (Tab away) for
 * anything that is neither the menu nor its trigger. "Is a menu open" is read from the DOM every time.
 *
 * Document-level delegation, bound once per page lifetime: Turbo swaps the
 * body but keeps window/document, so a second run must not stack listeners.
 * The rows are server-rendered (html.js); the script carries no strings.
 *
 * This is a template literal: never put a backtick or a dollar-brace inside.
 */
export function rowMenuScript() {
  return `<script>(function(){
  if (window.__btbRowMenu) return;
  window.__btbRowMenu = 1;
  function trigOf(m){ return document.querySelector('[aria-controls="' + m.id + '"]'); }
  function menuOf(b){ return document.getElementById(b.getAttribute('aria-controls')); }
  function itemsOf(m){ return Array.prototype.slice.call(m.querySelectorAll('[role="menuitem"]')); }
  function openMenu(){
    var all = document.querySelectorAll('.btb-menu');
    for (var i = 0; i < all.length; i++) if (!all[i].hidden) return all[i];
    return null;
  }
  function setOpen(m, open, refocus){
    m.hidden = !open;
    var b = trigOf(m);
    if (b) b.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { var first = itemsOf(m)[0]; if (first) first.focus(); }
    else if (refocus && b) b.focus();
  }
  function openOnly(m){
    var cur = openMenu();
    if (cur && cur !== m) setOpen(cur, false, false);
    setOpen(m, true, false);
  }
  document.addEventListener('click', function(ev){
    var t = ev.target;
    var b = t && t.closest ? t.closest('.btb-more') : null;
    if (b) {
      var m = menuOf(b);
      if (!m) return;
      if (m.hidden) openOnly(m); else setOpen(m, false, true);
      return;
    }
    var cur = openMenu();
    if (cur && !(t && cur.contains(t))) setOpen(cur, false, false);
  });
  document.addEventListener('focusout', function(ev){
    var cur = openMenu();
    var to = ev.relatedTarget;
    if (!cur || !to) return;
    if (cur.contains(to) || to === trigOf(cur)) return;
    setOpen(cur, false, false);
  });
  document.addEventListener('keydown', function(ev){
    var t = ev.target;
    if (!t || !t.closest) return;
    var b = t.closest('.btb-more');
    if (b) {
      var bm = menuOf(b);
      if (!bm) return;
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        if (bm.hidden) openOnly(bm); else { var f = itemsOf(bm)[0]; if (f) f.focus(); }
      } else if (ev.key === 'Escape' && !bm.hidden) {
        ev.preventDefault();
        setOpen(bm, false, true);
      }
      return;
    }
    var m = t.closest('.btb-menu');
    if (!m || m.hidden) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      if (ev.stopPropagation) ev.stopPropagation();
      setOpen(m, false, true);
      return;
    }
    var its = itemsOf(m), n = its.length, i = its.indexOf(document.activeElement), next = -1;
    if (!n) return;
    if (ev.key === 'ArrowDown') next = (i + 1) % n;
    else if (ev.key === 'ArrowUp') next = (i <= 0 ? n : i) - 1;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = n - 1;
    if (next < 0) return;
    ev.preventDefault();
    its[next].focus();
  });
})();</script>`;
}

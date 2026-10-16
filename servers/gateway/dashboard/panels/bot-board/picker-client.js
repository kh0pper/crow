/**
 * Bot Board — client scripts for the option B picker and the phone lane tabs
 * (queue item 20).
 *
 * pickerScript(): the name button is the <summary> of a <details>, so the
 * sheet opens and closes with no JS at all (the open sheet's scrim is the
 * summary's own ::before, so a tap outside the sheet closes it too). The
 * script only adds Escape: close, focus back on the button.
 *
 * laneTabsScript(): on a phone the board's columns become tabs. The tab
 * strip ships `hidden` and the board stacks its columns, so without JS
 * nothing is lost; the script unhides the strip, marks the board
 * .bb-tabbed (CSS shows only .bb-lane-cur under 641px) and opens the first
 * lane that has cards. Arrow keys / Home / End move between tabs.
 *
 * Both: document-level listeners bound once per page lifetime (Turbo keeps
 * window/document across visits); the per-page init re-runs on every render.
 * These are template literals: never put a backtick or a dollar-brace inside.
 */
export function pickerScript() {
  return `<script>(function(){
  if (window.__bbPicker) return;
  window.__bbPicker = 1;
  document.addEventListener('keydown', function(ev){
    if (ev.key !== 'Escape') return;
    var d = document.querySelector('details.bb-picker[open]');
    if (!d) return;
    ev.preventDefault();
    d.open = false;
    var s = d.querySelector('summary');
    if (s) s.focus();
  });
})();</script>`;
}

export function laneTabsScript() {
  return `<script>(function(){
  function tabsOf(strip){ return Array.prototype.slice.call(strip.querySelectorAll('[role="tab"]')); }
  function select(tab, focus){
    var strip = tab.closest('.bb-lane-tabs');
    if (!strip) return;
    tabsOf(strip).forEach(function(b){
      var on = b === tab;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      var col = document.getElementById(b.getAttribute('aria-controls'));
      if (col) col.classList.toggle('bb-lane-cur', on);
    });
    if (focus) tab.focus();
  }
  function init(){
    var strip = document.querySelector('.bb-lane-tabs');
    var board = document.getElementById('bb-board');
    if (!strip || !board || strip.getAttribute('data-ready')) return;
    strip.setAttribute('data-ready', '1');
    var tabs = tabsOf(strip);
    if (!tabs.length) return;
    tabs.forEach(function(b){
      var col = document.getElementById(b.getAttribute('aria-controls'));
      if (col) { col.setAttribute('role', 'tabpanel'); col.setAttribute('aria-labelledby', b.id); }
    });
    var start = tabs[0];
    for (var i = 0; i < tabs.length; i++) {
      var n = tabs[i].querySelector('.bb-lane-n');
      if (n && Number(n.textContent) > 0) { start = tabs[i]; break; }
    }
    board.classList.add('bb-tabbed');
    strip.hidden = false;
    select(start, false);
  }
  if (window.__bbLaneTabs) { init(); return; }
  window.__bbLaneTabs = 1;
  document.addEventListener('click', function(ev){
    var t = ev.target && ev.target.closest ? ev.target.closest('.bb-lane-tabs [role="tab"]') : null;
    if (t) select(t, false);
  });
  document.addEventListener('keydown', function(ev){
    var t = ev.target && ev.target.closest ? ev.target.closest('.bb-lane-tabs [role="tab"]') : null;
    if (!t) return;
    var tabs = tabsOf(t.closest('.bb-lane-tabs')), i = tabs.indexOf(t), n = tabs.length, next = -1;
    if (ev.key === 'ArrowRight') next = (i + 1) % n;
    else if (ev.key === 'ArrowLeft') next = (i - 1 + n) % n;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = n - 1;
    if (next < 0) return;
    ev.preventDefault();
    select(tabs[next], true);
  });
  init();
})();</script>`;
}

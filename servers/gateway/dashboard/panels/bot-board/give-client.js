/**
 * Bot Board — the give sheet's client script (queue item 20, PR 2).
 *
 * The sheet itself is server-rendered (html.js giveSheetHtml): one dialog
 * per page, opened by any Give to… button in the Unassigned lane. This
 * script fills in the card, keeps the controls honest (Give is disabled
 * until a bot is picked; "Start now" is disabled, with a hint, for a bot
 * with no Perch chat, since the dispatch would only refuse), places the
 * panel beside the card on wide screens (a bottom sheet on a phone is pure
 * CSS), traps Tab inside the dialog, and closes on Escape, Cancel or a tap
 * on the backdrop with focus back on the Give to… button.
 *
 * Give POSTs {bot_id, start} to /dashboard/perch-api/cards/<id>/give — the
 * CSRF-railed router (the layout's fetch wrapper adds X-Crow-Csrf). start is
 * true only when "Start now" is picked; "Add to board for later" is the
 * default. A start that fails still gives the card, and the toast says why.
 *
 * Document-level delegation, bound once per page lifetime (Turbo keeps
 * document across visits). This is a template literal: never put a backtick
 * or a dollar-brace inside, except the tJs interpolations.
 */
import { tJs } from "../../shared/i18n.js";

export function giveScript(lang) {
  return `<script>(function(){
  /* The Give to… buttons render hidden (no dead button without JS): reveal
     them on EVERY run — a Turbo visit re-runs this script against a fresh
     body while the listeners below stay bound once. */
  Array.prototype.slice.call(document.querySelectorAll('.bb-give-btn')).forEach(function(b){ b.hidden = false; });
  if (window.__bbGive) return;
  window.__bbGive = 1;
  var T = {
    to: '${tJs("botboard.giveTo", lang)}',
    btn: '${tJs("botboard.giveBtn", lang)}',
    done: '${tJs("botboard.giveDone", lang)}',
    started: '${tJs("botboard.giveStarted", lang)}',
    startFailed: '${tJs("botboard.giveStartFailed", lang)}',
    failed: '${tJs("botboard.giveFailed", lang)}'
  };
  var API = '/dashboard/perch-api/cards/';
  var st = { card: null, trigger: null, busy: false };
  function fill(s, o){ return String(s).replace(/\\{(\\w+)\\}/g, function(m, k){ return Object.prototype.hasOwnProperty.call(o, k) ? String(o[k]) : m; }); }
  function dlg(){ return document.getElementById('bb-give'); }
  function radios(name){ var d = dlg(); return d ? Array.prototype.slice.call(d.querySelectorAll('[name="' + name + '"]')) : []; }
  function when(v){ return radios('bb-give-when').filter(function(r){ return r.value === v; })[0] || null; }
  function picked(){ return radios('bb-give-bot').filter(function(r){ return r.checked; })[0] || null; }
  function toast(msg, type){ if (window.crowToast) window.crowToast(msg, { type: type }); }
  function sync(){
    var r = picked(), now = when('now'), later = when('later');
    var hint = document.getElementById('bb-give-hint'), go = document.getElementById('bb-give-go');
    var noPerch = !!r && r.getAttribute('data-perch') !== '1';
    if (now) {
      now.disabled = noPerch;
      if (noPerch && now.checked) { now.checked = false; if (later) later.checked = true; }
    }
    if (hint) hint.hidden = !noPerch;
    if (go) {
      go.disabled = !r || st.busy;
      go.textContent = r ? fill(T.btn, { name: r.getAttribute('data-name') }) : T.to;
    }
  }
  function place(btn){
    var d = dlg(), p = d && d.querySelector('.bb-give-panel');
    if (!p) return;
    var wide = window.matchMedia && window.matchMedia('(min-width:641px)').matches;
    if (!wide || !btn.getBoundingClientRect) {
      p.style.left = ''; p.style.top = ''; p.classList.remove('bb-placed');
      return;
    }
    var r = btn.getBoundingClientRect(), w = p.offsetWidth, h = p.offsetHeight;
    var left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    var top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = r.top - h - 6;
    if (top < 8) {
      /* fits neither under nor over the button: beside it, vertically
         centred on it and kept inside the screen */
      left = r.right + 8 + w <= window.innerWidth - 8 ? r.right + 8 : Math.max(8, r.left - w - 8);
      top = Math.max(8, Math.min(r.top + r.height / 2 - h / 2, window.innerHeight - h - 8));
    }
    p.style.left = Math.round(left) + 'px';
    p.style.top = Math.round(top) + 'px';
    p.classList.add('bb-placed');
  }
  function focusables(){
    var d = dlg();
    if (!d) return [];
    /* type=hidden inputs (a board-off bot's Turn on form) are never focusable */
    return Array.prototype.slice.call(d.querySelectorAll('input,button')).filter(function(e){
      return !e.disabled && !e.hidden && String(e.getAttribute('type') || '').toLowerCase() !== 'hidden';
    });
  }
  function open(btn){
    var d = dlg();
    if (!d) return;
    st.card = btn.getAttribute('data-card-id');
    st.trigger = btn;
    st.busy = false;
    var line = document.getElementById('bb-give-card');
    if (line) line.textContent = btn.getAttribute('data-card-title') || '';
    radios('bb-give-bot').forEach(function(r){ r.checked = false; });
    var later = when('later'), now = when('now');
    if (later) later.checked = true;
    if (now) now.checked = false;
    sync();
    d.hidden = false;
    place(btn);
    var f = focusables()[0];
    if (f) f.focus();
  }
  function close(refocus){
    var d = dlg();
    if (!d || d.hidden) return;
    d.hidden = true;
    if (refocus && st.trigger && st.trigger.focus) st.trigger.focus();
  }
  function give(){
    var r = picked();
    if (!r || st.busy || !st.card) return;
    var now = when('now');
    var start = !!(now && now.checked && !now.disabled);
    var name = r.getAttribute('data-name');
    st.busy = true;
    sync();
    fetch(API + encodeURIComponent(st.card) + '/give', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: r.value, start: start })
    }).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(j){ return { ok: res.ok, j: j || {} }; });
    }).then(function(x){
      st.busy = false;
      if (!x.ok) { toast(fill(T.failed, { reason: x.j.error || '?' }), 'error'); sync(); return; }
      if (x.j.started) toast(fill(T.started, { name: name }), 'success');
      else if (start) toast(fill(T.startFailed, { name: name, reason: x.j.code || '?' }), 'warning');
      else toast(fill(T.done, { name: name }), 'success');
      close(false);
      setTimeout(function(){
        if (window.Turbo && window.Turbo.visit) window.Turbo.visit(location.href, { action: 'replace' });
        else location.reload();
      }, 700);
    }).catch(function(){
      st.busy = false;
      toast(fill(T.failed, { reason: '?' }), 'error');
      sync();
    });
  }
  document.addEventListener('click', function(ev){
    var t = ev.target;
    if (!t || !t.closest) return;
    var b = t.closest('.bb-give-btn');
    if (b) { open(b); return; }
    var d = dlg();
    if (!d || d.hidden) return;
    if (t === d || t.closest('[data-give-close]')) { close(true); return; }
    if (t.closest('[id="bb-give-go"]')) give();
  });
  document.addEventListener('change', function(ev){
    var t = ev.target, d = dlg();
    if (!d || !t || !d.contains(t)) return;
    sync();
    /* the hint can appear or go, changing the panel's height: re-place it */
    if (!d.hidden && st.trigger) place(st.trigger);
  });
  document.addEventListener('keydown', function(ev){
    var d = dlg();
    if (!d || d.hidden) return;
    if (ev.key === 'Escape') { ev.preventDefault(); close(true); return; }
    if (ev.key !== 'Tab') return;
    var f = focusables();
    if (!f.length) return;
    var i = f.indexOf(document.activeElement);
    if (ev.shiftKey && i <= 0) { ev.preventDefault(); f[f.length - 1].focus(); }
    else if (!ev.shiftKey && (i < 0 || i === f.length - 1)) { ev.preventDefault(); f[0].focus(); }
  });
})();</script>`;
}

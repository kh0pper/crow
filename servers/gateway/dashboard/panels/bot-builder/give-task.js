/**
 * Bot Builder — the "Give <Name> a task" dialog's client script (queue item
 * 20, PR 2, option B). Opened from a board-on bot card's ⋯ "Give a task…"
 * (a menuitem button carrying data-bot-id / data-name / data-perch).
 *
 * Either a new task (the textarea) → POST /dashboard/perch-api/bots/<id>/tasks
 * {title, start}, or a waiting card (the select of Unassigned cards) →
 * POST /dashboard/perch-api/cards/<id>/give {bot_id, start}. The two are
 * exclusive: picking a card clears the text, typing clears the pick. start
 * is true only for "Start now"; "Add to board for later" is the default, and
 * "Start now" is disabled (with a hint) for a bot with no Perch chat. Both
 * routes are on the CSRF-railed perch-api router; the layout's fetch wrapper
 * adds X-Crow-Csrf.
 *
 * Document-level delegation, bound once per page lifetime. This is a
 * template literal: never put a backtick or a dollar-brace inside, except
 * the tJs interpolations.
 */
import { tJs } from "../../shared/i18n.js";

export function giveTaskScript(lang) {
  return `<script>(function(){
  if (window.__btbGiveTask) return;
  window.__btbGiveTask = 1;
  var T = {
    title: '${tJs("botbuilder.giveTaskTitle", lang)}',
    ph: '${tJs("botbuilder.giveTaskNewPh", lang)}',
    needOne: '${tJs("botbuilder.giveTaskNeedOne", lang)}',
    btn: '${tJs("botboard.giveBtn", lang)}',
    done: '${tJs("botboard.giveDone", lang)}',
    started: '${tJs("botboard.giveStarted", lang)}',
    startFailed: '${tJs("botboard.giveStartFailed", lang)}',
    failed: '${tJs("botboard.giveFailed", lang)}'
  };
  var st = { bot: null, name: '', perch: false, trigger: null, busy: false };
  function fill(s, o){ return String(s).replace(/\\{(\\w+)\\}/g, function(m, k){ return Object.prototype.hasOwnProperty.call(o, k) ? String(o[k]) : m; }); }
  function $(id){ return document.getElementById(id); }
  function when(v){
    var d = $('btb-give');
    if (!d) return null;
    return Array.prototype.slice.call(d.querySelectorAll('[name="btb-give-when"]')).filter(function(r){ return r.value === v; })[0] || null;
  }
  function toast(msg, type){ if (window.crowToast) window.crowToast(msg, { type: type }); }
  function closeMenu(btn){
    var m = btn.closest('.btb-menu');
    if (!m) return null;
    m.hidden = true;
    var tr = document.querySelector('[aria-controls="' + m.id + '"]');
    if (tr) tr.setAttribute('aria-expanded', 'false');
    return tr;
  }
  function open(btn){
    var d = $('btb-give');
    if (!d) return;
    st.bot = btn.getAttribute('data-bot-id');
    st.name = btn.getAttribute('data-name') || st.bot;
    st.perch = btn.getAttribute('data-perch') === '1';
    st.busy = false;
    st.trigger = closeMenu(btn) || btn;
    var h = $('btb-give-h'); if (h) h.textContent = fill(T.title, { name: st.name });
    var text = $('btb-give-text'); if (text) { text.value = ''; text.placeholder = fill(T.ph, { name: st.name }); }
    var sel = $('btb-give-card'); if (sel) sel.value = '';
    var later = when('later'), now = when('now');
    if (later) later.checked = true;
    if (now) { now.checked = false; now.disabled = !st.perch; }
    var hint = $('btb-give-hint'); if (hint) hint.hidden = st.perch;
    var go = $('btb-give-go'); if (go) { go.disabled = false; go.textContent = fill(T.btn, { name: st.name }); }
    d.hidden = false;
    if (text) text.focus();
  }
  function close(refocus){
    var d = $('btb-give');
    if (!d || d.hidden) return;
    d.hidden = true;
    if (refocus && st.trigger && st.trigger.focus) st.trigger.focus();
  }
  function give(){
    if (st.busy || !st.bot) return;
    var text = $('btb-give-text'), sel = $('btb-give-card'), now = when('now');
    var title = text ? String(text.value || '').trim() : '';
    var card = sel ? String(sel.value || '') : '';
    if (!title && !card) { toast(T.needOne, 'error'); return; }
    var start = !!(now && now.checked && !now.disabled);
    var url, payload;
    if (title) { url = '/dashboard/perch-api/bots/' + encodeURIComponent(st.bot) + '/tasks'; payload = { title: title, start: start }; }
    else { url = '/dashboard/perch-api/cards/' + encodeURIComponent(card) + '/give'; payload = { bot_id: st.bot, start: start }; }
    var go = $('btb-give-go');
    st.busy = true;
    if (go) go.disabled = true;
    var name = st.name;
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function(res){ return res.json().catch(function(){ return {}; }).then(function(j){ return { ok: res.ok, j: j || {} }; }); })
      .then(function(x){
        st.busy = false;
        if (go) go.disabled = false;
        if (!x.ok) { toast(fill(T.failed, { reason: x.j.error || '?' }), 'error'); return; }
        if (x.j.started) toast(fill(T.started, { name: name }), 'success');
        else if (start) toast(fill(T.startFailed, { name: name, reason: x.j.code || '?' }), 'warning');
        else toast(fill(T.done, { name: name }), 'success');
        close(true);
        if (card) setTimeout(function(){
          if (window.Turbo && window.Turbo.visit) window.Turbo.visit(location.href, { action: 'replace' });
          else location.reload();
        }, 700);
      })
      .catch(function(){ st.busy = false; if (go) go.disabled = false; toast(fill(T.failed, { reason: '?' }), 'error'); });
  }
  function focusables(){
    var d = $('btb-give');
    if (!d) return [];
    return Array.prototype.slice.call(d.querySelectorAll('textarea,select,input,button')).filter(function(e){ return !e.disabled && !e.hidden; });
  }
  document.addEventListener('click', function(ev){
    var t = ev.target;
    if (!t || !t.closest) return;
    var b = t.closest('.btb-give-task');
    if (b) { open(b); return; }
    var d = $('btb-give');
    if (!d || d.hidden) return;
    if (t === d || t.closest('[data-give-close]')) { close(true); return; }
    if (t.closest('[id="btb-give-go"]')) give();
  });
  document.addEventListener('change', function(ev){
    var t = ev.target;
    if (t && t.id === 'btb-give-card' && t.value) { var text = $('btb-give-text'); if (text) text.value = ''; }
  });
  document.addEventListener('input', function(ev){
    var t = ev.target;
    if (t && t.id === 'btb-give-text' && String(t.value || '').trim()) { var sel = $('btb-give-card'); if (sel) sel.value = ''; }
  });
  document.addEventListener('keydown', function(ev){
    var d = $('btb-give');
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

/**
 * Bot Builder — "which bot answers voice" (queue item 20, PR 3).
 *
 * Each bot card carries a line "Answers voice on: …". The server part
 * (html.js) names the glasses and AI Companion devices bound to the bot, from
 * the core device registry. The kiosk part — "Phone & dashboard" (the
 * dashboard's own Talk to Crow, incl. the phone browser/app overlay) and each
 * paired kiosk display — is filled here from ONE read of the Kiosk listing
 * (GET /api/kiosk/admin/displays) per render, never polled. That listing is
 * the Kiosk panel's own, so "Automatic" is resolved by the same server code
 * the voice socket uses (never re-implemented here); reading it starts no
 * model (tests/voice-assess-no-acquire.test.js).
 *
 * The ⋯ "Use for voice…" item opens one page-level dialog that writes only
 * through the Kiosk panel's CSRF-railed endpoints (the layout's fetch wrapper
 * adds X-Crow-Csrf): POST /api/kiosk/admin/dashboard-voice {bot_id} and
 * POST /api/kiosk/admin/displays/<id> {bound_bot_id} — nothing else, so a
 * display's voice, speech model or other settings are never rebound. Glasses
 * and the companion stay read-only here: their channel settings own them.
 *
 * The server decides whether the Kiosk is there at all (html.js gets
 * kioskAvailable); the client still treats a non-JSON, redirected or failed
 * listing as "no kiosk" and keeps the kiosk parts and the item hidden.
 *
 * Turbo: the document listeners are bound once per page lifetime; the
 * listing is read and the lines filled on every render (the script runs again).
 * Strings reach the script as a JSON block, never interpolated into it.
 * The script is a template literal: never put a backtick or a dollar-brace inside.
 */
import { escapeHtml } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";

const STRING_KEYS = {
  voiceOn: "botbuilder.voiceOn",
  phoneDash: "botbuilder.voicePhoneDash",
  automatic: "botbuilder.voiceAutomatic",
  title: "botbuilder.voiceUseTitle",
  now: "botbuilder.voiceUseNow",
  nobody: "botbuilder.voiceUseNobody",
  autoNow: "botbuilder.voiceUseAutoNow",
  autoNone: "botbuilder.voiceUseAutoNone",
  autoKeep: "botbuilder.voiceUseAutoKeep",
  autoWould: "botbuilder.voiceUseAutoWould",
  autoWouldNone: "botbuilder.voiceUseAutoWouldNone",
  moveFrom: "botbuilder.voiceUseMoveFrom",
  already: "botbuilder.voiceUseAlready",
  kioskLink: "botbuilder.voiceUseKioskLink",
  nextOpen: "botbuilder.voiceUseNextOpen",
  displays: "botbuilder.voiceUseDisplays",
  displaysNow: "botbuilder.voiceUseDisplaysNow",
  tooLarge: "botbuilder.voiceUseTooLarge",
  noSkills: "botbuilder.voiceUseNoSkills",
  required: "botbuilder.voiceUseRequired",
  saved: "botbuilder.voiceUseSaved",
  failed: "botbuilder.voiceUseFailed",
  nothing: "botbuilder.voiceUseNothing",
  noTargets: "botbuilder.voiceUseNoTargets",
  loadFailed: "botbuilder.voiceUseLoadFailed",
  abilBy: "botbuilder.abilBy",
  abilNone: "botbuilder.abilNone",
  abilSlower: "botbuilder.abilSlower",
  abilMore: "botbuilder.abilMore",
  abilcalendar: "botbuilder.abilCalendar",
  abilreminders: "botbuilder.abilReminders",
  abilmessages: "botbuilder.abilMessages",
  abilcrow_messages: "botbuilder.abilCrowMessages",
  abillists: "botbuilder.abilLists",
  abilmemory: "botbuilder.abilMemory",
  abilprojects: "botbuilder.abilProjects",
  abilblog: "botbuilder.abilBlog",
  abilnews: "botbuilder.abilNews",
  abilfiles: "botbuilder.abilFiles",
};

/** The card line. `names` = the glasses/companion devices bound to this bot (server side); hidden when empty. */
export function voiceLineHtml(botId, names, lang) {
  const srv = (names || []).map((n) => escapeHtml(String(n))).join(", ");
  return `<p class="btb-voice" data-voice-bot="${escapeHtml(String(botId))}" data-voice-srv="${srv ? 1 : 0}"${srv ? "" : " hidden"}>` +
    `<span class="btb-voice-l">${escapeHtml(t("botbuilder.voiceOn", lang))}</span> ` +
    `<span class="btb-voice-srv">${srv}</span><span class="btb-voice-kk"></span></p>`;
}

/**
 * "By voice on displays: …" — what the bot can do by voice on a display (the Kiosk listing's `abilities`,
 * decided by the voice turn's own classifier: servers/gateway/voice/voice-abilities.js). Rendered only when
 * the Kiosk is available, hidden until the listing fills it; an older Kiosk without the field leaves it hidden.
 */
export function abilityLineHtml(botId) {
  return `<p class="btb-abil" data-abil-bot="${escapeHtml(String(botId))}" hidden></p>`;
}

/** The ⋯ menu item (enabled bots, kiosk available); hidden until the Kiosk listing loads. */
export function voiceUseItemHtml(botId, name, lang) {
  return `<button type="button" role="menuitem" tabindex="-1" class="btb-voice-use" data-bot-id="${escapeHtml(String(botId))}" ` +
    `data-name="${escapeHtml(String(name))}" aria-haspopup="dialog" aria-controls="btb-vu" hidden>${escapeHtml(t("botbuilder.rowUseForVoice", lang))}</button>`;
}

/** One dialog per page, outside the list section (the layout's .card transform would contain its position:fixed). */
export function voiceUseDialogHtml(lang) {
  return `<div class="btb-give btb-vu" id="btb-vu" role="dialog" aria-modal="true" aria-labelledby="btb-vu-h" hidden>` +
    `<div class="btb-give-panel">` +
    `<p class="btb-give-h" id="btb-vu-h"></p>` +
    `<div class="btb-vu-rows" id="btb-vu-rows"></div>` +
    `<p class="btb-give-hint btb-vu-ch">${escapeHtml(t("botbuilder.voiceUseChannels", lang))} ` +
    `<a id="btb-vu-ch-link" href="/dashboard/bot-builder">${escapeHtml(t("botbuilder.voiceUseChannelsLink", lang))}</a></p>` +
    `<p class="btb-give-hint btb-vu-status" id="btb-vu-status" role="status"></p>` +
    `<div class="btb-give-actions">` +
    `<button type="button" class="btn btn-secondary btn-sm" data-vu-close>${escapeHtml(t("botbuilder.voiceUseClose", lang))}</button>` +
    `<button type="button" class="btn btn-primary btn-sm" id="btb-vu-save">${escapeHtml(t("botbuilder.voiceUseSave", lang))}</button>` +
    `</div></div></div>`;
}

export function voiceUseScript(lang) {
  const S = {};
  for (const [k, key] of Object.entries(STRING_KEYS)) S[k] = t(key, lang);
  const json = JSON.stringify(S).replace(/</g, "\\u003c");
  return `<script type="application/json" id="btb-vu-s">${json}</script>` + `<script>${CLIENT}</script>`;
}

const CLIENT = `(function(){
  var S = {};
  try { S = JSON.parse(document.getElementById('btb-vu-s').textContent) || {}; } catch (e) { S = {}; }
  var st = window.__btbVoiceUse;
  if (!st) {
    st = window.__btbVoiceUse = { data: null, bot: null, name: '', trigger: null, busy: false, gen: 0, init: {}, explicit: false, results: {}, S: S };
    bind();
  }
  st.S = S;
  load();

  function $(id){ return document.getElementById(id); }
  function fill(s, o){ return String(s).replace(/\\{(\\w+)\\}/g, function(m, k){ return Object.prototype.hasOwnProperty.call(o, k) ? String(o[k]) : m; }); }
  function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
  function clear(n){ while (n.firstChild) n.removeChild(n.firstChild); }
  function each(list, fn){ for (var i = 0; i < list.length; i++) fn(list[i], i); }
  function botOf(id){ var d = st.data, hit = null; if (d) each(d.bots, function(b){ if (b.bot_id === id) hit = b; }); return hit; }
  function nameOf(id){ var b = botOf(id); return b ? (b.display_name || b.bot_id) : String(id || ''); }
  /** fit by a display's memory setting; an older listing without fit_memory uses the plain fit. */
  function fitOf(b, mem){ if (!b) return null; return mem && b.fit_memory !== undefined ? b.fit_memory : b.fit; }
  function dashOn(){ var d = st.data; return !!(d && d.dashboard_voice && d.dashboard_voice.available); }
  /** Automatic answers when nothing is chosen, or when the chosen bot is off/gone (the server then falls back: effective differs). */
  function dashAuto(dv){ return !dv.bot_id || dv.bot_id !== dv.effective_bot_id; }
  function usable(){ var d = st.data; return !!(d && (dashOn() || d.devices.length)); }

  /** Read the Kiosk listing (once per render, on opening the dialog, after a save). Never throws. */
  function load(){
    var p;
    try { p = fetch('/api/kiosk/admin/displays', { credentials: 'same-origin', headers: { Accept: 'application/json' } }); }
    catch (e) { p = Promise.reject(e); }
    return Promise.resolve(p).then(function(res){
      var ct = res && res.headers && res.headers.get ? String(res.headers.get('content-type') || '') : '';
      if (!res || !res.ok || res.redirected || ct.indexOf('application/json') < 0) return null;
      return res.json();
    }).then(function(j){
      st.data = j && Array.isArray(j.devices) && Array.isArray(j.bots) ? j : null;
      paint();
      return st.data;
    }).catch(function(){ st.data = null; paint(); return null; });
  }

  /** The kiosk part of every card's line, and the ⋯ items. */
  function paint(){
    var d = st.data, S = st.S;
    each(document.querySelectorAll('.btb-voice[data-voice-bot]'), function(line){
      var id = line.getAttribute('data-voice-bot');
      var parts = [];
      if (d && dashOn() && d.dashboard_voice.effective_bot_id === id) parts.push(S.phoneDash + (dashAuto(d.dashboard_voice) ? ' ' + S.automatic : ''));
      if (d) each(d.devices, function(x){ if (x.bound_bot_id === id) parts.push(x.name || x.id); });
      var srv = line.getAttribute('data-voice-srv') === '1';
      var kk = line.querySelector('.btb-voice-kk');
      if (kk) kk.textContent = (srv && parts.length ? ', ' : '') + parts.join(', ');
      line.hidden = !(srv || parts.length);
    });
    each(document.querySelectorAll('.btb-voice-use'), function(b){ b.hidden = !usable(); });
    each(document.querySelectorAll('.btb-abil[data-abil-bot]'), function(line){ paintAbil(line, d ? botOf(line.getAttribute('data-abil-bot')) : null); });
  }

  /** One ability's words: a known id from the strings, an add-on by its manifest name (text, never markup); else none. */
  function abilWord(x){
    if (!x || typeof x.id !== 'string') return null;
    if (x.id.indexOf('addon:') === 0) return typeof x.label === 'string' && x.label ? x.label.slice(0, 60) : null;
    return /^[a-z_]{1,32}$/.test(x.id) && Object.prototype.hasOwnProperty.call(st.S, 'abil' + x.id) ? st.S['abil' + x.id] : null;
  }
  /** "By voice on displays: …" from the bot's abilities (memories off: a card is not one display). No field → hidden. */
  function paintAbil(line, b){
    var a = b ? b.abilities : null, S = st.S;
    line.removeAttribute('title');
    if (!a || !Array.isArray(a.items)) { line.textContent = ''; line.hidden = true; return; }
    var words = [];
    each(a.items, function(x){ var w = abilWord(x); if (w) words.push(x.quick === false ? fill(S.abilSlower, { item: w }) : w); });
    if (!words.length) line.textContent = S.abilNone;
    else if (words.length <= 4) line.textContent = fill(S.abilBy, { list: words.join(', ') });
    else {
      line.textContent = fill(S.abilBy, { list: words.slice(0, 4).join(', ') + ', ' + fill(S.abilMore, { n: words.length - 4 }) });
      line.setAttribute('title', fill(S.abilBy, { list: words.join(', ') }));
    }
    line.hidden = false;
  }

  function fitNote(row, lv){
    if (lv === 'too_large') row.appendChild(el('span', 'btb-vu-fit btb-vu-bad', st.S.tooLarge));
    else if (lv === 'no_skills') row.appendChild(el('span', 'btb-vu-fit btb-vu-warn', st.S.noSkills));
  }
  function addRow(box, key, label, sub, checked, disabled){
    var row = el('div', 'btb-vu-row'); row.setAttribute('data-vu-row', key);
    var l = el('label', 'btb-vu-l');
    var cb = el('input'); cb.type = 'checkbox'; cb.checked = !!checked; cb.disabled = !!disabled; cb.setAttribute('data-vu-key', key);
    l.appendChild(cb); l.appendChild(el('span', 'btb-vu-name', label));
    row.appendChild(l);
    if (sub) row.appendChild(el('span', 'btb-vu-sub', sub));
    box.appendChild(row);
    st.init[key] = !!checked;
    return row;
  }
  function addMsg(row, key){
    var m = el('span', 'btb-vu-msg', st.results[key] || '');
    m.setAttribute('role', 'status');
    row.appendChild(m);
  }

  function renderRows(){
    var box = $('btb-vu-rows'); if (!box) return;
    clear(box);
    st.init = {};
    var d = st.data, S = st.S, me = botOf(st.bot);
    if (!d) { box.appendChild(el('p', 'btb-vu-sub', S.loadFailed)); return; }
    if (dashOn()) {
      var dv = d.dashboard_voice, cur = dv.effective_bot_id === st.bot;
      st.explicit = cur && dv.bot_id === st.bot;
      var sub = !dashAuto(dv) ? fill(S.now, { name: nameOf(dv.effective_bot_id) })
        : (dv.effective_bot_id ? fill(S.autoNow, { name: nameOf(dv.effective_bot_id) }) : S.autoNone);
      var lv = fitOf(me, false);
      var row = addRow(box, 'dash', S.phoneDash, sub, cur, !cur && lv === 'too_large');
      fitNote(row, lv);
      addMsg(row, 'dash');
      box.appendChild(el('p', 'btb-vu-hint', S.nextOpen));
    }
    if (d.devices.length) {
      box.appendChild(el('p', 'btb-vu-group', S.displays));
      each(d.devices, function(x){
        var key = 'dev:' + x.id, cur = x.bound_bot_id === st.bot;
        var lv = fitOf(me, !!(x.kiosk_settings || {}).memory_integration);
        var off = cur || lv === 'too_large';
        // Held by another bot and tickable: say what ticking does (it moves the display), not just who has it.
        var sub = !x.bound_bot_id ? S.nobody : fill(off ? S.now : S.moveFrom, { name: nameOf(x.bound_bot_id) });
        var row = addRow(box, key, x.name || x.id, sub, cur, off);
        if (cur) {
          var why = el('span', 'btb-vu-sub', S.already + ' ');
          var a = el('a', null, S.kioskLink); a.setAttribute('href', '/dashboard/kiosk');
          why.appendChild(a); row.appendChild(why);
        } else fitNote(row, lv);
        addMsg(row, key);
      });
      box.appendChild(el('p', 'btb-vu-hint', S.displaysNow));
    }
    if (!dashOn() && !d.devices.length) box.appendChild(el('p', 'btb-vu-sub', S.noTargets));
  }

  function closeMenu(btn){
    var m = btn.closest('.btb-menu');
    if (!m) return null;
    m.hidden = true;
    var tr = document.querySelector('[aria-controls="' + m.id + '"]');
    if (tr) tr.setAttribute('aria-expanded', 'false');
    return tr;
  }
  function firstFocus(){ var f = focusables(); if (f.length) f[0].focus(); }
  function open(btn){
    var dlg = $('btb-vu'); if (!dlg) return;
    st.bot = btn.getAttribute('data-bot-id');
    st.name = btn.getAttribute('data-name') || st.bot;
    st.trigger = closeMenu(btn) || btn;
    // A new generation: a save chain still running for the previous open keeps st.busy (Save stays
    // blocked until it ends) but its results are dropped, never shown on this dialog.
    st.gen++; st.results = {}; st.touched = false;
    var go = $('btb-vu-save'); if (go) go.disabled = st.busy;
    var h = $('btb-vu-h'); if (h) h.textContent = fill(st.S.title, { name: st.name });
    var ch = $('btb-vu-ch-link'); if (ch) ch.setAttribute('href', '/dashboard/bot-builder?bot=' + encodeURIComponent(st.bot) + '&tab=basics');
    var status = $('btb-vu-status'); if (status) status.textContent = '';
    renderRows();
    dlg.hidden = false;
    firstFocus();
    // The card line may be stale (another session): read it again, and redraw unless the operator already started.
    var gen = st.gen;
    load().then(function(){ if (gen === st.gen && !st.touched && !dlg.hidden) { renderRows(); firstFocus(); } });
  }
  function close(refocus){
    var dlg = $('btb-vu');
    if (!dlg || dlg.hidden) return;
    dlg.hidden = true;
    if (refocus && st.trigger && st.trigger.focus) st.trigger.focus();
  }
  function boxes(){ var dlg = $('btb-vu'); return dlg ? Array.prototype.slice.call(dlg.querySelectorAll('input[data-vu-key]')) : []; }
  function refusal(j){
    var S = st.S;
    if (j.error === 'bot_too_large') return S.tooLarge;
    if (j.error === 'bot_required') return S.required;
    return fill(S.failed, { reason: j.error || '?' });
  }
  function post(url, body){
    var p;
    try { p = fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch (e) { p = Promise.reject(e); }
    return Promise.resolve(p).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(j){ j = j || {}; return { ok: !!(res.ok && j.ok), j: j }; });
    }).catch(function(){ return { ok: false, j: {} }; });
  }
  function save(){
    if (st.busy || !st.bot) return;
    var ops = [];
    each(boxes(), function(cb){
      var key = cb.getAttribute('data-vu-key'), was = !!st.init[key], now = !!cb.checked;
      if (key === 'dash') {
        if (now && !was) ops.push({ key: key, url: '/api/kiosk/admin/dashboard-voice', body: { bot_id: st.bot } });
        else if (!now && was && st.explicit) ops.push({ key: key, url: '/api/kiosk/admin/dashboard-voice', body: { bot_id: '' } });
      } else if (!cb.disabled && now && !was) {
        ops.push({ key: key, url: '/api/kiosk/admin/displays/' + encodeURIComponent(key.slice(4)), body: { bound_bot_id: st.bot } });
      }
    });
    var status = $('btb-vu-status');
    if (!ops.length) { if (status) status.textContent = st.S.nothing; return; }
    st.busy = true;
    var gen = st.gen;
    var go = $('btb-vu-save'); if (go) go.disabled = true;
    st.results = {};
    function next(i){
      if (i >= ops.length) return load().then(function(){
        st.busy = false;
        if (go) go.disabled = false;
        if (gen !== st.gen) return; // the dialog was reopened meanwhile: leave its rows alone
        st.touched = false;
        if (status) status.textContent = '';
        renderRows();
      });
      return post(ops[i].url, ops[i].body).then(function(r){
        if (gen === st.gen) st.results[ops[i].key] = r.ok ? st.S.saved : refusal(r.j);
        return next(i + 1);
      });
    }
    next(0);
  }
  function focusables(){
    var dlg = $('btb-vu');
    if (!dlg) return [];
    return Array.prototype.slice.call(dlg.querySelectorAll('input,button,a[href]')).filter(function(e){ return !e.disabled && !e.hidden; });
  }

  function bind(){
    document.addEventListener('click', function(ev){
      var t = ev.target;
      if (!t || !t.closest) return;
      var b = t.closest('.btb-voice-use');
      if (b) { open(b); return; }
      var dlg = $('btb-vu');
      if (!dlg || dlg.hidden) return;
      if (t === dlg || t.closest('[data-vu-close]')) { close(true); return; }
      if (t.closest('[id="btb-vu-save"]')) save();
    });
    document.addEventListener('change', function(ev){
      var t = ev.target;
      if (!t || !t.getAttribute || !t.getAttribute('data-vu-key')) return;
      st.touched = true;
      // An automatic-only pick cannot be unticked: Automatic would choose this bot again. Say so instead.
      if (t.getAttribute('data-vu-key') !== 'dash' || !st.init.dash) return;
      var row = t.closest('[data-vu-row]');
      var m = row ? row.querySelector('.btb-vu-msg') : null;
      if (!t.checked && !st.explicit) {
        t.checked = true;
        if (m) m.textContent = fill(st.S.autoKeep, { name: st.name });
      } else if (m) {
        // Unticking an explicit choice goes back to Automatic, which may pick this same bot: say whom, before saving.
        var dv = (st.data && st.data.dashboard_voice) || {};
        var known = Object.prototype.hasOwnProperty.call(dv, 'auto_bot_id');
        m.textContent = t.checked || !known ? '' : (dv.auto_bot_id ? fill(st.S.autoWould, { name: nameOf(dv.auto_bot_id) }) : st.S.autoWouldNone);
      }
    });
    document.addEventListener('keydown', function(ev){
      var dlg = $('btb-vu');
      if (!dlg || dlg.hidden) return;
      if (ev.key === 'Escape') { ev.preventDefault(); close(true); return; }
      if (ev.key !== 'Tab') return;
      var f = focusables();
      if (!f.length) return;
      var i = f.indexOf(document.activeElement);
      if (ev.shiftKey && i <= 0) { ev.preventDefault(); f[f.length - 1].focus(); }
      else if (!ev.shiftKey && (i < 0 || i === f.length - 1)) { ev.preventDefault(); f[0].focus(); }
    });
  }
})();`;

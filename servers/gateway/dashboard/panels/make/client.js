/**
 * Make panel client: the "Start something" sheet and composer.
 *
 * Returned as a <script> string that panels/make.js appends to the page, so it is a TEMPLATE LITERAL:
 * it must contain NO backticks and no dollar-brace sequences. Strings are single-quoted; the starter
 * texts and labels come from i18n through tJs. It re-runs on every Turbo visit and binds fresh to the
 * swapped-in sheet (the sheet is part of the page, so nothing leaks across visits).
 *
 * Flow: "+ Start something" opens the sheet. A type row opens the composer (type pill, project chip,
 * Perch-attached bot picker, field pre-filled with the type's starter text). Submit POSTs
 * /dashboard/perch-api/bots/:id/interactive {project_id}, then .../interactive/:sid/message {message},
 * then goes to /dashboard/perch#<threadId>. Blank (document, spreadsheet, deck) takes a title and POSTs
 * /dashboard/make-api/blank. Both send the dashboard CSRF token as X-Crow-Csrf.
 */
import { tJs } from "../../shared/i18n.js";

export function makeClientJs(lang) {
  return `<script>
(function () {
  var dlg = document.getElementById('mk-start');
  var openBtn = document.querySelector('[data-mk-open]');
  if (!dlg || !openBtn) return;
  var START = {
    document: '${tJs("shell.startDocument", lang)}',
    spreadsheet: '${tJs("shell.startSpreadsheet", lang)}',
    deck: '${tJs("shell.startDeck", lang)}',
    page: '${tJs("shell.startPage", lang)}',
    diagram: '${tJs("shell.startDiagram", lang)}'
  };
  var BLANK_KIND = { document: 'docx', spreadsheet: 'xlsx', deck: 'pptx' };
  var T_ASK = '${tJs("shell.askBot", lang)}';
  var T_BLANK = '${tJs("shell.blank", lang)}';
  var T_NOBOTS = '${tJs("shell.noBots", lang)}';
  var T_FAILED = '${tJs("shell.startFailed", lang)}';
  var T_START = '${tJs("shell.start", lang)}';

  var list = dlg.querySelector('[data-mk-list]');
  var form = dlg.querySelector('[data-mk-composer]');
  var pillsBox = dlg.querySelector('[data-mk-pills]');
  var field = dlg.querySelector('[data-mk-field]');
  var botRow = dlg.querySelector('[data-mk-botrow]');
  var botSel = dlg.querySelector('[data-mk-bot]');
  var titleRow = dlg.querySelector('[data-mk-titlerow]');
  var titleIn = dlg.querySelector('[data-mk-title]');
  var status = dlg.querySelector('[data-mk-status]');
  var submitBtn = dlg.querySelector('[data-mk-submit]');
  var rawProject = dlg.getAttribute('data-project') || 'unassigned';
  var projectId = /^[1-9][0-9]*$/.test(rawProject) ? Number(rawProject) : 'unassigned';

  var type = null;      // the chosen type id
  var blank = false;    // Blank mode: a title instead of a bot and text
  var bots = null;      // Perch-attached bots, loaded once
  var busy = false;

  function csrf() {
    var parts = document.cookie.split(';');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim().split('=');
      if (kv[0] === 'crow_csrf') return decodeURIComponent(kv.slice(1).join('='));
    }
    return '';
  }
  function show(el, on) { if (!el) return; if (on) el.removeAttribute('hidden'); else el.setAttribute('hidden', ''); }
  function say(text) { if (status) status.textContent = text || ''; }
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Crow-Csrf': csrf() }, body: JSON.stringify(body) });
  }
  // The chosen option; the first one when the DOM gives no selection (a fresh select always has one).
  function chosen() {
    var opts = botSel && botSel.options;
    if (!opts || !opts.length) return null;
    var i = botSel.selectedIndex;
    return opts[i >= 0 ? i : 0] || opts[0];
  }
  function botName() { var o = chosen(); return o ? o.textContent : ''; }
  function label() {
    if (!submitBtn) return;
    submitBtn.textContent = blank ? T_BLANK : (botName() ? T_ASK.split('{bot}').join(botName()) : T_START);
  }

  function loadBots() {
    if (bots) return Promise.resolve();
    return fetch('/dashboard/perch-api/bots').then(function (r) { return r.json(); }).then(function (d) {
      bots = ((d && d.bots) || []).filter(function (b) { return b && b.perch_attached; });
      botSel.innerHTML = '';
      for (var i = 0; i < bots.length; i++) {
        var o = document.createElement('option');
        o.value = bots[i].id;
        o.textContent = bots[i].name || bots[i].id;
        botSel.appendChild(o);
      }
      if (!bots.length && !blank) say(T_NOBOTS);
      label();
    }).catch(function () { bots = []; if (!blank) say(T_FAILED); });
  }

  function pick(id, asBlank) {
    type = id;
    blank = !!asBlank;
    say('');
    show(list, false);
    show(form, true);
    var pills = dlg.querySelectorAll('[data-mk-pill]');
    for (var i = 0; i < pills.length; i++) pills[i].setAttribute('aria-pressed', pills[i].getAttribute('data-mk-pill') === id ? 'true' : 'false');
    show(pillsBox, !blank);
    show(botRow, !blank);
    show(field, !blank);
    show(titleRow, blank);
    if (!blank) {
      field.value = START[id] || '';
      loadBots().then(function () { if (bots && !bots.length) say(T_NOBOTS); });
      if (field.focus) field.focus();
    } else if (titleIn && titleIn.focus) {
      titleIn.focus();
    }
    label();
  }

  function back() { type = null; say(''); show(form, false); show(list, true); }
  function openSheet() {
    back();
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }
  function closeSheet() {
    if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
  }

  function fail() { busy = false; if (submitBtn) submitBtn.removeAttribute('disabled'); say(T_FAILED); }

  function submit() {
    if (busy || !type) return;
    if (blank) {
      var title = (titleIn.value || '').trim();
      if (!title) return;
      busy = true; if (submitBtn) submitBtn.setAttribute('disabled', ''); say('');
      post('/dashboard/make-api/blank', { kind: BLANK_KIND[type], title: title, project_id: projectId })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (x) {
          if (!x.ok || !x.d || !x.d.ok) return fail();
          // Same tab (R-P4-9): a new tab opened after an async fetch is popup-blocked, and Workspace has its own back.
          if (!x.d.webUrl) return fail();
          location.href = x.d.webUrl;
        }).catch(fail);
      return;
    }
    var text = (field.value || '').trim();
    var bo = chosen();
    var bot = bo ? bo.value : '';
    if (!text || !bot) { if (!bot) say(T_NOBOTS); return; }
    busy = true; if (submitBtn) submitBtn.setAttribute('disabled', ''); say('');
    post('/dashboard/perch-api/bots/' + encodeURIComponent(bot) + '/interactive', { project_id: projectId })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        var sid = x.ok && x.d && (x.d.threadId || x.d.sessionId);
        if (!sid) return fail();
        return post('/dashboard/perch-api/interactive/' + encodeURIComponent(sid) + '/message', { message: text }).then(function (r) {
          if (!r.ok) return fail();
          location.href = '/dashboard/perch#' + sid;
        });
      }).catch(fail);
  }

  openBtn.addEventListener('click', openSheet);
  dlg.addEventListener('click', function (e) {
    var el = e.target;
    if (el === dlg) { closeSheet(); return; }
    if (!el || !el.closest) return;
    var t = el.closest('[data-mk-type]');
    if (t) { pick(t.getAttribute('data-mk-type'), false); return; }
    var b = el.closest('[data-mk-blank]');
    if (b) { var row = b.closest('[data-mk-row]'); pick(row.getAttribute('data-mk-row'), true); return; }
    var p = el.closest('[data-mk-pill]');
    if (p) { pick(p.getAttribute('data-mk-pill'), false); return; }
    if (el.closest('[data-mk-close]')) { closeSheet(); return; }
    if (el.closest('[data-mk-back]')) { back(); return; }
    if (el.closest('[data-mk-submit]')) { e.preventDefault(); submit(); }
  });
  form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
  if (botSel) botSel.addEventListener('change', label);
  document.addEventListener('turbo:before-cache', function () { if (dlg.open) closeSheet(); });
})();
</script>`;
}

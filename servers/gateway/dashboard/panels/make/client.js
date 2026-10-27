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
  // Previews (Task 4.5): a pending tile re-checks its image ONCE after data-mk-pv-wait ms; a
  // Workspace tile tries Nextcloud's image at once. Only a loaded image replaces the type tile.
  var boxes = document.querySelectorAll('[data-mk-pv-src]');
  Array.prototype.forEach.call(boxes, function (box) {
    var src = box.getAttribute('data-mk-pv-src');
    if (!src || src.indexOf('/dashboard/make/preview/') !== 0) return;
    var wait = Number(box.getAttribute('data-mk-pv-wait')) || 0;
    setTimeout(function () {
      if (!box.isConnected) return;
      var img = new Image();
      img.alt = '';
      img.width = 640;
      img.height = 400;
      img.decoding = 'async';
      img.onload = function () {
        if (!box.isConnected) return;
        box.textContent = '';
        box.classList.add('mk-preview-img');
        box.removeAttribute('data-mk-pv-src');
        box.appendChild(img);
      };
      img.src = src;
    }, wait);
  });
})();
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
(function () {
  var pv = document.getElementById('mk-preview');
  if (!pv) return;
  var T_VLINE = '${tJs("shell.versionLine", lang)}';
  var T_VN = '${tJs("shell.versionN", lang)}';
  var T_MOVED = '${tJs("shell.moved", lang)}';
  var T_MOVE_FAILED = '${tJs("shell.moveFailed", lang)}';
  var titleEl = pv.querySelector('[data-mk-pv-title]');
  var vline = pv.querySelector('[data-mk-vline]');
  var vlist = pv.querySelector('[data-mk-versions]');
  var openA = pv.querySelector('[data-mk-pv-open]');
  var sel = pv.querySelector('[data-mk-pv-project]');
  var moveBtn = pv.querySelector('[data-mk-pv-move]');
  var pvStatus = pv.querySelector('[data-mk-pv-status]');
  var cur = null;       // the cell being previewed
  var token = 0;        // guards a slow version fetch against a newer sheet
  var suppress = false; // a long press just fired: swallow the click that follows
  var timer = null, sx = 0, sy = 0;

  function csrf() {
    var parts = document.cookie.split(';');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim().split('=');
      if (kv[0] === 'crow_csrf') return decodeURIComponent(kv.slice(1).join('='));
    }
    return '';
  }
  function hide(el, on) { if (on) el.setAttribute('hidden', ''); else el.removeAttribute('hidden'); }

  function showVersions(art, versions) {
    var ns = [];
    for (var i = 0; i < versions.length; i++) ns.push(Number(versions[i].n));
    ns.sort(function (a, b) { return b - a; });
    var now = Number(art && art.current_version) || ns[0] || 1;
    vlist.innerHTML = '';
    if (ns.length > 1) {
      vline.textContent = T_VLINE.split('{n}').join(String(now));
      vline.removeAttribute('data-plain');
      for (var j = 0; j < ns.length; j++) {
        var li = document.createElement('li');
        var a = document.createElement('a');
        a.className = 'mk-vlink';
        a.setAttribute('data-mk-vlink', '');
        a.setAttribute('href', '/dashboard/artifacts/view/' + encodeURIComponent(cur.getAttribute('data-mk-ref')) + '?v=' + ns[j]);
        a.textContent = T_VN.split('{n}').join(String(ns[j]));
        li.appendChild(a);
        vlist.appendChild(li);
      }
    } else {
      vline.textContent = 'v' + now;
      vline.setAttribute('data-plain', '');
    }
    hide(vline, false);
  }

  var curProject = 'unassigned';
  function chosenProject() {
    var o = sel.options && sel.options[sel.selectedIndex >= 0 ? sel.selectedIndex : 0];
    return sel.value || (o && o.value) || 'unassigned';
  }
  function selectProject(v) {
    var opts = sel.options || [];
    for (var i = 0; i < opts.length; i++) {
      if (opts[i].value === v) { sel.selectedIndex = i; return; }
    }
  }
  function syncMove() {
    if (chosenProject() === curProject) moveBtn.setAttribute('disabled', ''); else moveBtn.removeAttribute('disabled');
  }
  function refresh() {
    if (window.Turbo && typeof window.Turbo.visit === 'function') window.Turbo.visit(location.href, { action: 'replace' });
    else location.reload();
  }
  function openPreview(cell) {
    cur = cell;
    var kind = cell.getAttribute('data-mk-kind');
    var ref = cell.getAttribute('data-mk-ref');
    var mine = ++token;
    titleEl.textContent = cell.getAttribute('data-mk-title') || '';
    openA.setAttribute('href', cell.getAttribute('data-mk-href') || '#');
    if (kind === 'workspace_file') { openA.setAttribute('target', '_blank'); openA.setAttribute('rel', 'noopener'); }
    else { openA.removeAttribute('target'); openA.removeAttribute('rel'); }
    pvStatus.textContent = '';
    curProject = cell.getAttribute('data-mk-project') || 'unassigned';
    selectProject(curProject);
    syncMove();
    vlist.innerHTML = '';
    hide(vlist, true);
    hide(vline, true);
    if (typeof pv.showModal === 'function') pv.showModal(); else pv.setAttribute('open', '');
    if (kind !== 'artifact') return;
    fetch('/api/artifacts/' + encodeURIComponent(ref)).then(function (r) { return r.json(); }).then(function (d) {
      if (mine !== token || !d || !d.versions) return;
      showVersions(d.artifact, d.versions);
    }).catch(function () { /* the sheet still opens; the version line just stays off */ });
  }
  function closePreview() { token++; if (typeof pv.close === 'function') pv.close(); else pv.removeAttribute('open'); }

  function cancelPress() { if (timer) { clearTimeout(timer); timer = null; } }
  document.addEventListener('pointerdown', function (e) {
    var tile = e.target && e.target.closest ? e.target.closest('.mk-tile') : null;
    if (!tile) return;
    cancelPress();
    sx = e.clientX; sy = e.clientY;
    var cell = tile.closest('.mk-cell');
    timer = setTimeout(function () { timer = null; suppress = true; openPreview(cell); }, 500);
  });
  document.addEventListener('pointermove', function (e) {
    if (!timer) return;
    if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) cancelPress();
  });
  document.addEventListener('pointerup', cancelPress);
  document.addEventListener('pointercancel', cancelPress);
  document.addEventListener('scroll', cancelPress, true);
  document.addEventListener('contextmenu', function (e) {
    if (e.target && e.target.closest && e.target.closest('.mk-tile') && (timer || suppress)) e.preventDefault();
  });

  document.addEventListener('click', function (e) {
    var el = e.target;
    if (!el || !el.closest) return;
    if (suppress && el.closest('.mk-tile')) { suppress = false; e.preventDefault(); return; }
    suppress = false;
    var more = el.closest('[data-mk-more]');
    if (more) { openPreview(more.closest('.mk-cell')); return; }
  });
  if (sel.addEventListener) sel.addEventListener('change', syncMove);
  pv.addEventListener('click', function (e) {
    var el = e.target;
    if (el === pv || (el.closest && el.closest('[data-mk-pv-close]'))) { closePreview(); return; }
    if (el.closest && el.closest('[data-mk-vline]') && !vline.hasAttribute('data-plain')) { hide(vlist, !vlist.hasAttribute('hidden')); return; }
    if (el.closest && el.closest('[data-mk-pv-move]')) move();
  });

  function move() {
    if (!cur) return;
    var raw = chosenProject();
    if (raw === curProject) return;
    var pid = /^[1-9][0-9]*$/.test(raw) ? Number(raw) : 'unassigned';
    moveBtn.setAttribute('disabled', '');
    fetch('/dashboard/shell-api/items/' + encodeURIComponent(cur.getAttribute('data-mk-kind')) + '/' + encodeURIComponent(cur.getAttribute('data-mk-ref')) + '/project', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Crow-Csrf': csrf() }, body: JSON.stringify({ project_id: pid })
    }).then(function (r) {
      if (!r.ok) { syncMove(); pvStatus.textContent = T_MOVE_FAILED; return; }
      pvStatus.textContent = T_MOVED;
      setTimeout(refresh, 600);
    }).catch(function () { syncMove(); pvStatus.textContent = T_MOVE_FAILED; });
  }
  document.addEventListener('turbo:before-cache', function () { if (pv.open) closePreview(); });
})();
</script>`;
}

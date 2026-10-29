/**
 * The project Services page client.
 *
 * Row menu (Task 10): Test again POSTs /dashboard/services/api/connection/<uuid>/test, Disconnect
 * asks first (the row's data-confirm, escaped server-side) and POSTs .../disconnect; both send the
 * dashboard CSRF token (X-Crow-Csrf, from the crow_csrf cookie). A passed test or a disconnect
 * re-renders the page from the server, so the pill and "Tested ..." show the stored state. A
 * failed test stays on the page: the pill takes the answered status and the row shows the error
 * class's copy (Task 11). Opening one row's menu closes the others.
 *
 * Add a service and the connect sheet (Task 11): + Add and "Add one here" ([data-svc-add]) open
 * one <dialog> (a bottom sheet on a phone). The Add view lists the catalog by group (signin,
 * paste, builtin; "Found on your network" only for a discovery hit, which no entry has before the
 * discovery PR, so a network service sits under Paste a key), filtered by name, with Connect when
 * the extension is installed and Install otherwise, and Browse everything. The Connect view shows
 * the numbered steps, one input per field, the account name (pre-filled: "main", or for a
 * label-from-address service the typed address's host, the same rule as the server), the "For:"
 * line and Connect and test, which POSTs .../project/<slug>/connect and keeps the sheet open with
 * the error class's copy on a failure.
 *
 * The Install sheet (Task 12): Install on an extension that isn't installed opens the same view
 * with two numbered cards (add the extension to Crow; connect it to this project, holding the
 * fields) and Install and connect. That runs the store's own path, no other: GET
 * /dashboard/bundles/api/consent-challenge/<id>, POST /dashboard/bundles/api/install (no account
 * fields: those go only to the connect), the job poll, then the connect above. An extension that
 * needs consent or other install settings goes to its own form in Extensions instead. A refusal
 * because a required program isn't installed system-wide shows the store's own line. Once the
 * install lands, the button only connects: a failed connect leaves the extension installed and
 * pressing again never reinstalls.
 *
 * Typed secrets: a secret input is type=password with autocomplete=new-password (so a browser
 * never fills a saved password into it), has no name attribute (a stray native submit can't
 * serialise it) and no value attribute. Its value goes only into the connect POST body; it never
 * goes into a URL, storage, a data- attribute or the console. Every secret input is emptied when
 * the connection is saved or the service refuses the key (auth_failed), on Back, when the sheet
 * closes, and before Turbo caches the page; any other failure keeps it so a wrong address or
 * label can be fixed without pasting again. A step link is built only from the typed ADDRESS field, normalized and http(s) only.
 *
 * Every service-supplied string is written with textContent; the data comes from the page's own
 * JSON block (projectServicesDataScript). Returned as a <script> string, so it is a TEMPLATE
 * LITERAL: NO backticks, no dollar-brace sequences, and every regex backslash is doubled.
 * It re-runs on every Turbo visit and binds only to this page's elements.
 */

import { t } from "../../shared/i18n.js";
import { LABEL_MAX } from "../../../../shared/service-catalog.js";

const GROUP_ORDER = ["network", "signin", "paste", "builtin"];
const STATUSES = ["active", "needs_reauth", "error", "needs_install", "disconnected", "not_tested"];
export const ERROR_CODES = [
  "unreachable", "auth_failed", "timeout", "bad_address", "redirect", "unexpected_response", "forbidden_target",
  "not_found", "not_a_vault", "label_taken", "missing_field", "bad_value", "not_installed", "child_unavailable", "busy",
];
const STATIC_KEYS = [
  "services.add.title", "services.add.search", "services.add.searchPlaceholder", "services.add.browse",
  "services.add.connect", "services.add.install",
  "services.connect.for", "services.connect.label", "services.connect.labelHelp", "services.connect.labelDefault",
  "services.connect.labelHere", "services.connect.submit",
  "services.error.generic", "common.close", "common.back",
  "services.install.step1", "services.install.step1Help", "services.install.step2", "services.install.step2Help",
  "services.install.submit", "services.install.footnote", "extensions.binsNotTrusted",
  "services.install.hasConnection", "services.install.showRow",
  "services.group.signin", "services.group.paste", "services.group.builtin",
  ...ERROR_CODES.map((c) => `services.error.${c}`),
  ...STATUSES.map((s) => `services.status.${s}`),
];

/**
 * What the client needs, from loadServicesPage's payload: the project, botsLive, the catalog
 * cards (no value, ever: names, kinds, i18n keys, step-link templates) and the translated copy.
 */
export function projectServicesData(page, lang = "en") {
  const botsLive = page?.botsLive === true;
  // Only the success line that is true now: the page never says bots use a connection before they do.
  const keys = new Set([...STATIC_KEYS, botsLive ? "services.connect.ok" : "services.connect.okPending"]);
  const groups = {};
  for (const g of GROUP_ORDER) {
    groups[g] = (page?.groups?.[g] || []).map((c) => {
      for (const f of c.fields || []) {
        if (f.labelKey) keys.add(f.labelKey);
        if (f.helpKey) keys.add(f.helpKey);
      }
      for (const k of c.steps || []) keys.add(k);
      return {
        serviceId: c.serviceId,
        // The extension the Install sheet installs; no id means Install opens the store.
        ...(typeof c.bundleId === "string" && c.bundleId ? { bundleId: c.bundleId } : {}),
        name: c.name,
        installed: c.installed === true,
        labelFrom: c.labelFrom || null,
        ...(c.found === true ? { found: true } : {}),
        fields: (c.fields || []).map((f) => ({ name: f.name, kind: f.kind, labelKey: f.labelKey || null, helpKey: f.helpKey || null })),
        steps: [...(c.steps || [])],
        stepLinks: { ...(c.stepLinks || {}) },
      };
    });
  }
  // "Found on your network" only for a discovery hit (none before the discovery PR).
  if (groups.network.some((c) => c.found === true)) keys.add("services.group.network");
  const strings = {};
  for (const k of keys) strings[k] = t(k, lang);
  return {
    project: { slug: page?.project?.slug || "", name: page?.project?.name || "" },
    lang,
    botsLive,
    order: [...GROUP_ORDER],      // the one group order; the client reads it from here
    labelMax: LABEL_MAX,          // the server's account-name cap (cleanLabel)
    groups,
    strings,
  };
}

/** The data as an inert JSON block, safe inside HTML (no "<", ">", "&" or line separators raw). */
export function projectServicesDataScript(page, lang = "en") {
  const json = JSON.stringify(projectServicesData(page, lang))
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `<script type="application/json" data-svc-data>${json}</script>`;
}

export function projectServicesClientJs() {
  return `<script>
(function () {
  var root = document.querySelector('[data-svc]');
  if (!root || root.getAttribute('data-svc-bound')) return;
  root.setAttribute('data-svc-bound', '1');
  var API = '/dashboard/services/api/connection/';
  var BUNDLES = '/dashboard/bundles/api/';
  var busy = false;
  var HAS = Object.prototype.hasOwnProperty;

  var DATA = null;
  try {
    var dn = document.querySelector('script[data-svc-data]');
    DATA = dn ? JSON.parse(dn.textContent || 'null') : null;
  } catch (e) { DATA = null; }
  var S = (DATA && DATA.strings) || {};
  var ORDER = (DATA && DATA.order) || [];
  function T(k) { return HAS.call(S, k) ? S[k] : k; }
  // {name} placeholders in ONE pass: a value holding "{project}" stays as typed.
  function fillOnce(str, params) {
    return String(str).replace(/\\{(\\w+)\\}/g, function (m, k) { return HAS.call(params, k) ? String(params[k]) : m; });
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function clearKids(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  function csrf() {
    var parts = document.cookie.split(';');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim().split('=');
      if (kv[0] === 'crow_csrf') return decodeURIComponent(kv.slice(1).join('='));
    }
    return '';
  }
  function reload() {
    if (window.Turbo && window.Turbo.visit) window.Turbo.visit(location.href, { action: 'replace' });
    else location.reload();
  }
  function go(url) {
    if (window.Turbo && window.Turbo.visit) window.Turbo.visit(url);
    else location.href = url;
  }

  var ERRORS = { unreachable: 1, auth_failed: 1, timeout: 1, bad_address: 1, redirect: 1, unexpected_response: 1,
    forbidden_target: 1, not_found: 1, not_a_vault: 1, label_taken: 1, missing_field: 1, bad_value: 1,
    not_installed: 1, child_unavailable: 1, busy: 1 };
  // The copy for an error class; an answer with no class (a keychain key fault, a dropped
  // connection) gets the generic line.
  function errorText(code, fieldLabel, serviceName) {
    if (typeof code !== 'string' || !HAS.call(ERRORS, code)) return T('services.error.generic');
    if (code === 'missing_field' || code === 'bad_value') {
      if (!fieldLabel) return T('services.error.generic');
      return fillOnce(T('services.error.' + code), { field: fieldLabel });
    }
    return fillOnce(T('services.error.' + code), { service: serviceName || '' });
  }

  // ---- Row menu ----------------------------------------------------------------------------
  var PILLS = { active: 1, needs_reauth: 1, error: 1, needs_install: 1, disconnected: 1, not_tested: 1 };
  function setBusy(row, on) {
    busy = on;
    var items = row.querySelectorAll('.svc-menu-item');
    for (var i = 0; i < items.length; i++) {
      if (on) items[i].setAttribute('disabled', ''); else items[i].removeAttribute('disabled');
    }
  }
  function rowError(row, text) {
    var box = row.querySelector('.svc-text') || row;
    var line = row.querySelector('.svc-row-error');
    if (!line) {
      line = el('span', 'svc-row-error');
      line.setAttribute('role', 'alert');
      box.appendChild(line);
    }
    line.textContent = text;
  }
  function failedTest(row, j) {
    var pill = row.querySelector('.svc-pill');
    var st = j && typeof j.status === 'string' && HAS.call(PILLS, j.status) ? j.status : 'error';
    if (pill) {
      pill.className = 'svc-pill svc-pill--' + st;
      pill.textContent = T('services.status.' + st);
    }
    var nameEl = row.querySelector('.svc-name');
    rowError(row, errorText(j && j.error, '', nameEl ? nameEl.textContent : ''));
    var menu = row.querySelector('.svc-menu');
    if (menu) menu.open = false;
  }
  function post(row, action) {
    var uuid = row.getAttribute('data-uuid') || '';
    setBusy(row, true);
    fetch(API + encodeURIComponent(uuid) + '/' + action, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Crow-Csrf': csrf() },
      body: '{}'
    }).then(function (r) {
      if (action !== 'test') {
        if (r.status === 200 || r.status === 400 || r.status === 404) { reload(); return; }
        setBusy(row, false);
        return;
      }
      return r.json().then(function (j) { return j; }, function () { return null; }).then(function (j) {
        // A passed test, or a connection that is gone: show the stored state.
        if ((r.status === 200 && j && j.ok === true) || r.status === 404) { reload(); return; }
        setBusy(row, false);
        failedTest(row, j);
      });
    }, function () {
      setBusy(row, false);
      if (action === 'test') failedTest(row, null);
    });
  }

  root.addEventListener('toggle', function (e) {
    var d = e.target;
    if (!d || !d.classList || !d.classList.contains('svc-menu') || !d.open) return;
    var all = root.querySelectorAll('.svc-menu[open]');
    for (var i = 0; i < all.length; i++) if (all[i] !== d) all[i].open = false;
  }, true);

  root.addEventListener('click', function (e) {
    var add = e.target && e.target.closest ? e.target.closest('[data-svc-add]') : null;
    if (add) { openAdd(); return; }
    var t = e.target && e.target.closest ? e.target.closest('[data-svc-retest], [data-svc-disconnect]') : null;
    if (!t || busy) return;
    var row = t.closest('[data-svc-row]');
    if (!row) return;
    if (t.hasAttribute('data-svc-retest')) { post(row, 'test'); return; }
    if (window.confirm(t.getAttribute('data-confirm') || '')) post(row, 'disconnect');
  });

  // ---- The sheet ---------------------------------------------------------------------------
  var sheet = null;
  var connected = false;   // a connection was made while the sheet was open: re-render on close
  var closing = false;
  // Bumped whenever the sheet's view is replaced or the sheet closes: a connect answer that
  // arrives for an older view never touches the current one.
  var view = 0;

  function wipeSecrets(scope) {
    var box = scope || sheet;
    if (!box) return;
    var s = box.querySelectorAll('input.svc-secret');
    for (var i = 0; i < s.length; i++) s[i].value = '';
  }
  function onClosed() {
    if (closing || (sheet && sheet.open)) return;   // a late close event after the sheet reopened
    closing = true;
    view++;
    wipeSecrets();
    if (sheet) clearKids(sheet);
    closing = false;
    if (connected) { connected = false; reload(); }
  }
  function ensureSheet() {
    if (sheet && sheet.parentNode) return sheet;
    sheet = el('dialog', 'svc-sheet');
    sheet.setAttribute('data-svc-sheet', '');
    sheet.setAttribute('aria-labelledby', 'svc-sheet-title');
    sheet.addEventListener('close', onClosed);
    root.appendChild(sheet);
    return sheet;
  }
  function showSheet() {
    if (sheet.open || sheet.hasAttribute('open')) return;
    if (typeof sheet.showModal === 'function') {
      try { sheet.showModal(); return; } catch (e) { /* fall through */ }
    }
    sheet.setAttribute('open', '');
  }
  function closeSheet() {
    wipeSecrets();
    if (typeof sheet.close === 'function' && sheet.open) { sheet.close(); return; }  // fires close
    sheet.removeAttribute('open');
    onClosed();
  }
  function head(title, back) {
    var h = el('div', 'svc-sheet-head');
    if (back) {
      var b = el('button', 'svc-icon-btn', '\\u2190');
      b.type = 'button';
      b.setAttribute('aria-label', T('common.back'));
      b.setAttribute('data-svc-back', '');
      h.appendChild(b);
    }
    var ti = el('h2', 'svc-sheet-title', title);
    ti.id = 'svc-sheet-title';
    h.appendChild(ti);
    var c = el('button', 'svc-icon-btn', '\\u00d7');
    c.type = 'button';
    c.setAttribute('aria-label', T('common.close'));
    c.setAttribute('data-svc-close', '');
    h.appendChild(c);
    sheet.appendChild(h);
  }
  function letter(name) {
    var c = String(name || '?').trim().charAt(0);
    return c ? c.toUpperCase() : '?';
  }
  function allServices() {
    var out = [];
    var g = (DATA && DATA.groups) || {};
    for (var i = 0; i < ORDER.length; i++) {
      var list = g[ORDER[i]] || [];
      for (var j = 0; j < list.length; j++) out.push(list[j]);
    }
    return out;
  }
  function byId(id) {
    var all = allServices();
    for (var i = 0; i < all.length; i++) if (all[i].serviceId === id) return all[i];
    return null;
  }

  // The Add view. "Found on your network" is for a discovery hit (entry.found); until discovery
  // exists a network service is listed with the other paste-a-key services.
  function openAdd() {
    if (!DATA) return;
    ensureSheet();
    wipeSecrets();
    view++;
    clearKids(sheet);
    head(fillOnce(T('services.add.title'), { project: DATA.project.name }), false);
    var lab = el('label', 'svc-field-label', T('services.add.search'));
    lab.setAttribute('for', 'svc-q');
    var q = el('input', 'svc-input');
    q.type = 'search';
    q.id = 'svc-q';
    q.setAttribute('placeholder', T('services.add.searchPlaceholder'));
    q.setAttribute('autocomplete', 'off');
    sheet.appendChild(lab);
    sheet.appendChild(q);

    var g = DATA.groups || {};
    var buckets = {};
    var order = ORDER;
    for (var b = 0; b < order.length; b++) buckets[order[b]] = [];
    for (var i = 0; i < order.length; i++) {
      var list = g[order[i]] || [];
      for (var j = 0; j < list.length; j++) {
        var s = list[j];
        var to = order[i] === 'network' && s.found !== true && buckets.paste ? 'paste' : order[i];
        buckets[to].push(s);
      }
    }
    var wrap = el('div', 'svc-groups');
    for (var k = 0; k < order.length; k++) {
      var items = buckets[order[k]];
      if (!items.length) continue;
      var sec = el('section', 'svc-group');
      sec.setAttribute('data-group', order[k]);
      sec.appendChild(el('h3', 'svc-label', T('services.group.' + order[k])));
      var ul = el('ul', 'svc-pick-list');
      for (var m = 0; m < items.length; m++) {
        var it = items[m];
        var li = el('li', 'svc-pick');
        li.setAttribute('data-svc-pick', '');
        li.setAttribute('data-service', it.serviceId);
        var ic = el('span', 'svc-icon', letter(it.name));
        ic.setAttribute('aria-hidden', 'true');
        li.appendChild(ic);
        li.appendChild(el('span', 'svc-pick-name', it.name));
        var btn = el('button', 'svc-pick-btn' + (it.installed ? '' : ' svc-pick-btn--install'),
          T(it.installed ? 'services.add.connect' : 'services.add.install'));
        btn.type = 'button';
        btn.setAttribute(it.installed ? 'data-svc-connect' : 'data-svc-install', it.serviceId);
        btn.setAttribute('aria-label', T(it.installed ? 'services.add.connect' : 'services.add.install') + ' ' + it.name);
        li.appendChild(btn);
        ul.appendChild(li);
      }
      sec.appendChild(ul);
      wrap.appendChild(sec);
    }
    sheet.appendChild(wrap);
    var browse = el('a', 'svc-browse', T('services.add.browse'));
    browse.setAttribute('href', '/dashboard/extensions');
    sheet.appendChild(browse);

    q.addEventListener('input', function () { filterAdd(wrap, q.value); });
    showSheet();
    try { q.focus(); } catch (e) { /* no focus in this environment */ }
  }
  function filterAdd(wrap, raw) {
    var needle = String(raw || '').trim().toLowerCase();
    var secs = wrap.querySelectorAll('.svc-group');
    for (var i = 0; i < secs.length; i++) {
      var lis = secs[i].querySelectorAll('[data-svc-pick]');
      var shown = 0;
      for (var j = 0; j < lis.length; j++) {
        var nm = lis[j].querySelector('.svc-pick-name');
        var hit = !needle || (nm ? nm.textContent : '').toLowerCase().indexOf(needle) >= 0;
        if (hit) { lis[j].removeAttribute('hidden'); shown++; } else lis[j].setAttribute('hidden', '');
      }
      if (shown) secs[i].removeAttribute('hidden'); else secs[i].setAttribute('hidden', '');
    }
  }

  // An address as the server normalizes it: http(s) only, no userinfo, query or fragment, one
  // trailing slash dropped. null otherwise.
  function normAddr(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s || s.indexOf('@') >= 0 || s.indexOf('?') >= 0 || s.indexOf('#') >= 0) return null;
    var u;
    try { u = new URL(s); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname || u.username || u.password) return null;
    var h = u.href;
    return h.charAt(h.length - 1) === '/' ? h.slice(0, -1) : h;
  }
  // A step's link, from the typed ADDRESS fields only. Any other placeholder (a secret, a text
  // field) or a result that is not http(s) gives no link.
  function stepHref(svc, key, form) {
    var tpl = svc.stepLinks && typeof svc.stepLinks[key] === 'string' ? svc.stepLinks[key] : null;
    if (!tpl) return null;
    var open = '$' + '{';
    for (var i = 0; i < svc.fields.length; i++) {
      var f = svc.fields[i];
      if (f.kind !== 'address') continue;
      var ph = open + f.name + '}';
      if (tpl.indexOf(ph) < 0) continue;
      var input = form.querySelector('input[data-field="' + f.name + '"]');
      var a = normAddr(input ? input.value : '');
      if (!a) return null;
      tpl = tpl.split(ph).join(a);
    }
    if (tpl.indexOf(open) >= 0) return null;
    var u;
    try { u = new URL(tpl); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  }
  // The account name the server would pick (suggestLabel): the address's host, or
  // "this Crow :{port}" on loopback. '' when there is nothing to suggest.
  function suggestLabel(svc, form) {
    if (svc.labelFrom !== 'address') return '';
    for (var i = 0; i < svc.fields.length; i++) {
      var f = svc.fields[i];
      if (f.kind !== 'address') continue;
      var input = form.querySelector('input[data-field="' + f.name + '"]');
      var a = normAddr(input ? input.value : '');
      if (!a) return '';
      var u = new URL(a);
      var host = u.hostname.replace(/^\\[(.*)\\]$/, '$1');
      var h = host.toLowerCase().replace(/\\.$/, '');
      var loop = h === 'localhost' || h.slice(-10) === '.localhost' || h === '::1' || /^127\\.\\d+\\.\\d+\\.\\d+$/.test(h);
      if (loop) return fillOnce(T('services.connect.labelHere'), { port: u.port || (u.protocol === 'https:' ? '443' : '80') });
      return host;
    }
    return '';
  }

  // The connect sheet, and (svc not installed) the Install sheet: step 1 adds the extension to
  // Crow through the store's own path (consent-challenge, install, job poll), step 2 is the same
  // connect form, and Install and connect runs both. A connect that fails after the install
  // leaves the extension installed; pressing the button again only connects.
  function openConnect(svc) {
    ensureSheet();
    wipeSecrets();
    var mine = ++view;
    clearKids(sheet);
    head(svc.name, true);
    var form = el('form', 'svc-connect');
    form.setAttribute('method', 'post');
    form.setAttribute('novalidate', '');
    form.setAttribute('autocomplete', 'off');
    var labelTouched = false;
    var inflight = false;
    var done = false;
    var installMode = svc.installed !== true;
    var installed = !installMode;

    // Where the steps and fields go: the form itself, or step 2's card.
    var box2 = form;
    var card1 = null;
    function installCard(n, title, help) {
      var c = el('div', 'svc-install-step');
      c.setAttribute('data-svc-install-step', String(n));
      var num = el('span', 'svc-install-num', String(n));
      num.setAttribute('aria-hidden', 'true');
      c.appendChild(num);
      var body = el('div', 'svc-install-body');
      body.appendChild(el('div', 'svc-install-title', title));
      body.appendChild(el('p', 'svc-help', help));
      c.appendChild(body);
      form.appendChild(c);
      return { card: c, num: num, body: body };
    }
    if (installMode) {
      card1 = installCard(1, fillOnce(T('services.install.step1'), { service: svc.name }), T('services.install.step1Help'));
      box2 = installCard(2, fillOnce(T('services.install.step2'), { project: DATA.project.name }), T('services.install.step2Help')).body;
    }

    var ol = null;
    if (svc.steps && svc.steps.length) {
      ol = el('ol', 'svc-steps');
      for (var i = 0; i < svc.steps.length; i++) {
        var li = el('li', 'svc-step');
        li.setAttribute('data-step', svc.steps[i]);
        li.textContent = T(svc.steps[i]);
        ol.appendChild(li);
      }
      box2.appendChild(ol);
    }
    function updateLinks() {
      if (!ol) return;
      var lis = ol.querySelectorAll('.svc-step');
      for (var i = 0; i < lis.length; i++) {
        var key = lis[i].getAttribute('data-step');
        if (!svc.stepLinks || typeof svc.stepLinks[key] !== 'string') continue;
        var href = stepHref(svc, key, form);
        clearKids(lis[i]);
        if (href) {
          var a = el('a', 'svc-step-link', T(key));
          a.setAttribute('href', href);
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
          lis[i].appendChild(a);
        } else {
          lis[i].textContent = T(key);
        }
      }
    }

    var label = null;
    function updateLabel() {
      if (!label || labelTouched || svc.labelFrom !== 'address') return;
      label.value = suggestLabel(svc, form);
    }
    for (var j = 0; j < svc.fields.length; j++) {
      var f = svc.fields[j];
      var box = el('div', 'svc-field');
      var id = 'svc-f-' + j;
      var lb = el('label', 'svc-field-label', f.labelKey ? T(f.labelKey) : f.name);
      lb.setAttribute('for', id);
      var input = el('input', 'svc-input');
      input.id = id;
      input.setAttribute('data-field', f.name);
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('spellcheck', 'false');
      input.setAttribute('autocapitalize', 'off');
      if (f.kind === 'secret') {
        input.type = 'password';
        input.className = 'svc-input svc-secret';
        input.setAttribute('autocomplete', 'new-password');
      } else if (f.kind === 'address') {
        input.type = 'url';
        input.setAttribute('inputmode', 'url');
        input.addEventListener('input', function () { updateLinks(); updateLabel(); });
      } else {
        input.type = 'text';
      }
      box.appendChild(lb);
      box.appendChild(input);
      if (f.helpKey) box.appendChild(el('p', 'svc-help', T(f.helpKey)));
      box2.appendChild(box);
    }

    var lbox = el('div', 'svc-field');
    var llb = el('label', 'svc-field-label', T('services.connect.label'));
    llb.setAttribute('for', 'svc-f-label');
    label = el('input', 'svc-input');
    label.type = 'text';
    label.id = 'svc-f-label';
    label.setAttribute('maxlength', String(DATA.labelMax || 60));
    label.setAttribute('autocomplete', 'off');
    label.setAttribute('data-svc-label', '');
    label.value = svc.labelFrom === 'address' ? '' : T('services.connect.labelDefault');
    label.addEventListener('input', function () { labelTouched = true; });
    lbox.appendChild(llb);
    lbox.appendChild(label);
    lbox.appendChild(el('p', 'svc-help', T('services.connect.labelHelp')));
    box2.appendChild(lbox);

    // A paused connection of this service already in the project (its extension was removed):
    // the install brings it back, so say so and point at its row (a same-name connect would
    // answer label_taken).
    var existingRow = null;
    if (installMode) {
      var rows = root.querySelectorAll('[data-svc-row]');
      for (var r = 0; r < rows.length; r++) if (rows[r].getAttribute('data-service') === svc.serviceId) { existingRow = rows[r]; break; }
    }
    if (existingRow) {
      var has = el('p', 'svc-footnote', fillOnce(T('services.install.hasConnection'), { service: svc.name }));
      has.setAttribute('data-svc-has-connection', '');
      var show = el('button', 'svc-link-btn', T('services.install.showRow'));
      show.type = 'button';
      show.addEventListener('click', function () {
        var row = existingRow;
        closeSheet();
        row.setAttribute('tabindex', '-1');
        try { if (row.scrollIntoView) row.scrollIntoView({ block: 'center' }); row.focus(); } catch (e) { /* no focus in this environment */ }
      });
      has.appendChild(document.createTextNode(' '));
      has.appendChild(show);
      form.appendChild(has);
    }
    if (installMode) form.appendChild(el('p', 'svc-footnote', T('services.install.footnote')));
    else form.appendChild(el('p', 'svc-for', fillOnce(T('services.connect.for'), { project: DATA.project.name })));
    var err = el('p', 'svc-error');
    err.setAttribute('role', 'alert');
    err.setAttribute('data-svc-error', '');
    form.appendChild(err);
    var ok = el('p', 'svc-ok');
    ok.setAttribute('role', 'status');
    ok.setAttribute('data-svc-ok', '');
    form.appendChild(ok);
    var submit = el('button', 'svc-submit', T(installMode ? 'services.install.submit' : 'services.connect.submit'));
    submit.type = 'submit';
    form.appendChild(submit);
    sheet.appendChild(form);

    function fieldLabel(name) {
      if (name === 'accountLabel') return T('services.connect.label');
      for (var i = 0; i < svc.fields.length; i++) {
        if (svc.fields[i].name === name) return svc.fields[i].labelKey ? T(svc.fields[i].labelKey) : name;
      }
      return '';
    }
    function markInvalid(name) {
      var inputs = form.querySelectorAll('input');
      for (var i = 0; i < inputs.length; i++) inputs[i].removeAttribute('aria-invalid');
      if (!name) return;
      var target = name === 'accountLabel' ? label : form.querySelector('input[data-field="' + name + '"]');
      if (target) target.setAttribute('aria-invalid', 'true');
    }
    function stopped(text) {
      inflight = false;
      submit.disabled = false;
      err.textContent = text;
    }

    // ---- Step 1: the store's own install path, no other --------------------------------------
    function readJson(r) {
      return r.json().then(function (j) { return { status: r.status, j: j }; }, function () { return { status: r.status, j: null }; });
    }
    var netFail = function () { return { status: 0, j: null }; };
    function installedNow() {
      installed = true;
      svc.installed = true;
      connected = true;           // the page shows the new extension even if the sheet closes now
      if (card1) {
        card1.card.classList.add('svc-install-step--done');
        card1.num.textContent = '\\u2713';
      }
      // From here the button only connects: a retry never installs again.
      submit.textContent = T('services.connect.submit');
    }
    // A restart was scheduled (the install loaded new code): poll the gateway until it has gone
    // away and answers again. No fixed wait tied to the server's restart delay: it goes on once
    // /health fails and then answers, or once it has answered for 15 s straight (a restart
    // that never came), and gives up waiting after about 2 minutes.
    function whenBack(next) {
      var tries = 0;
      var sawDown = false;
      var upRun = 0;
      (function ping() {
        if (mine !== view) return;
        fetch('/health', { credentials: 'same-origin' }).then(function (r) { return r.ok; }, function () { return false; }).then(function (up) {
          if (mine !== view) return;
          tries++;
          if (!up) { sawDown = true; upRun = 0; } else upRun++;
          if ((up && sawDown) || upRun > 15 || tries > 120) { next(); return; }
          setTimeout(ping, 1000);
        });
      })();
    }
    // A job that is lost (the gateway forgot it, or it never finishes) never leaves the sheet
    // stuck: the generic line, and Install and connect stays available (a retry that finds the
    // extension installed answers already_installed and goes on to the connect).
    var POLL_MAX = 900;   // 1 s apart: 15 minutes, well past the store's pull timeouts
    function lostJob() { stopped(T('services.error.generic')); }
    function pollJob(jobId, next, polls) {
      polls = polls || 0;
      fetch(BUNDLES + 'jobs/' + encodeURIComponent(jobId), { credentials: 'same-origin' }).then(readJson, netFail).then(function (res) {
        if (mine !== view) return;
        var st = res.j && typeof res.j.status === 'string' ? res.j.status : '';
        if (st === 'complete') { installedNow(); next(); return; }
        if (st === 'complete_restart') { installedNow(); whenBack(next); return; }
        if (st === 'failed') { stopped(T('services.error.generic')); return; }
        if (res.status === 404) { lostJob(); return; }
        if (polls + 1 >= POLL_MAX) { lostJob(); return; }
        // The gateway is away (a restart): ask again once it answers; a job it no longer
        // knows is then a 404 above.
        if (res.status === 0) { whenBack(function () { pollJob(jobId, next, polls + 1); }); return; }
        setTimeout(function () { if (mine === view) pollJob(jobId, next, polls + 1); }, 1000);
      });
    }
    function install(next) {
      var bid = svc.bundleId;
      fetch(BUNDLES + 'consent-challenge/' + encodeURIComponent(bid) + '?lang=' + encodeURIComponent(DATA.lang || 'en'),
        { credentials: 'same-origin' }).then(readJson, netFail).then(function (c) {
        if (mine !== view) return;
        if (c.status !== 200 || !c.j) { stopped(T('services.error.generic')); return; }
        // This sheet asks for no consent and no other settings: such an extension installs from
        // its own form in Extensions.
        var more = Array.isArray(c.j.install_required) && c.j.install_required.length > 0;
        if (c.j.required === true || more) {
          closeSheet();
          go('/dashboard/extensions?q=' + encodeURIComponent(bid));
          return;
        }
        return fetch(BUNDLES + 'install', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-Crow-Csrf': csrf() },
          body: JSON.stringify({ bundle_id: bid, env_vars: {} })
        }).then(readJson, netFail).then(function (r) {
          if (mine !== view) return;
          var code = r.j && typeof r.j.code === 'string' ? r.j.code : '';
          if (r.status === 200 && r.j && r.j.job_id) { connected = true; pollJob(r.j.job_id, next); return; }
          if (r.status === 409 && code === 'already_installing' && r.j.job_id) { pollJob(r.j.job_id, next); return; }
          if (r.status === 409 && code === 'already_installed') { installedNow(); next(); return; }
          if (r.status === 409 && code === 'bins_not_trusted') {
            var bins = Array.isArray(r.j.bins) ? r.j.bins.filter(function (b) { return typeof b === 'string'; }) : [];
            stopped(fillOnce(T('extensions.binsNotTrusted'), { bins: bins.join(', ') }));
            return;
          }
          stopped(T('services.error.generic'));
        });
      });
    }

    // ---- Step 2 (or the whole connect sheet): Task 11's connect ------------------------------
    function connect() {
      var values = {};
      var inputs = form.querySelectorAll('input[data-field]');
      for (var i = 0; i < inputs.length; i++) values[inputs[i].getAttribute('data-field')] = inputs[i].value;
      var body = JSON.stringify({ serviceId: svc.serviceId, accountLabel: label.value, values: values });
      values = null;
      var url = '/dashboard/services/api/project/' + encodeURIComponent(DATA.project.slug) +
        '/connect?lang=' + encodeURIComponent(DATA.lang || 'en');
      fetch(url, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Crow-Csrf': csrf() },
        body: body
      }).then(function (r) {
        return r.json().then(function (j) { return { status: r.status, j: j }; }, function () { return { status: r.status, j: null }; });
      }, function () { return { status: 0, j: null }; }).then(function (res) {
        body = null;
        inflight = false;
        var saved = res.status === 201 && res.j && res.j.ok === true;
        if (mine !== view) {
          // The sheet was closed or moved on while this was in flight: leave the current view
          // alone; a connection that was made still shows on the page.
          if (saved && document.body && document.body.contains(root)) reload();
          return;
        }
        var code = res.j && typeof res.j.error === 'string' ? res.j.error : null;
        // Cleared once saved, or when the key itself was refused; kept through other failures
        // (a wrong address or label) so it needn't be pasted again. Closing always clears it.
        if (res.status === 201 || code === 'auth_failed') wipeSecrets(form);
        if (saved) {
          done = true;
          connected = true;
          var all = form.querySelectorAll('input');
          for (var i = 0; i < all.length; i++) all[i].disabled = true;
          ok.textContent = T(DATA.botsLive === true ? 'services.connect.ok' : 'services.connect.okPending');
          ok.setAttribute('tabindex', '-1');
          try { ok.focus(); } catch (e2) { /* no focus in this environment */ }
          return;
        }
        submit.disabled = false;
        var field = res.j && typeof res.j.field === 'string' ? res.j.field : '';
        err.textContent = errorText(code, field ? fieldLabel(field) : '', svc.name);
        markInvalid(field || null);
      });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (inflight || done) return;
      inflight = true;
      submit.disabled = true;
      err.textContent = '';
      markInvalid(null);
      if (installed) connect();
      else install(function () { if (mine === view) connect(); });
    });
    showSheet();
    // The button that had focus is gone: start on the first field.
    var first = form.querySelector('input');
    try { if (first) first.focus(); } catch (e) { /* no focus in this environment */ }
  }

  root.addEventListener('click', function (e) {
    if (!sheet || !e.target || !e.target.closest) return;
    var t = e.target.closest('[data-svc-close], [data-svc-back], [data-svc-connect], [data-svc-install]');
    if (!t || !sheet.contains(t)) return;
    if (t.hasAttribute('data-svc-close')) { closeSheet(); return; }
    if (t.hasAttribute('data-svc-back')) { openAdd(); return; }
    if (t.hasAttribute('data-svc-connect')) {
      var svc = byId(t.getAttribute('data-svc-connect'));
      if (svc && svc.installed) openConnect(svc);
      return;
    }
    // Install: the Install sheet; an entry without its extension id goes to the store instead.
    var inst = byId(t.getAttribute('data-svc-install'));
    if (inst && !inst.installed && typeof inst.bundleId === 'string' && inst.bundleId) { openConnect(inst); return; }
    closeSheet();
    go('/dashboard/extensions');
  });

  // Turbo keeps a copy of the page for Back: never with a typed secret or an open sheet in it.
  // The bound flag never goes into the cache either: a restored snapshot (Back) binds again.
  document.addEventListener('turbo:before-cache', function uncache() {
    document.removeEventListener('turbo:before-cache', uncache);
    root.removeAttribute('data-svc-bound');
    view++;
    if (!sheet) return;
    wipeSecrets();
    connected = false;
    if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
    sheet = null;
  });
})();
</script>`;
}

/**
 * The Models page change sheet (roles Phase 2): the browser side of "Change".
 *
 * "Change" opens the bottom sheet `<dialog id="models-change">` (rendered
 * empty by models.js), lists what may fill the role (GET /api/roles/<id>/picks),
 * previews the choice (POST .../preview, or .../profile/preview for stt/tts)
 * and shows who moves, the cloud sentence, refusals, the re-embed line and the
 * pin box. Save sends the preview's hash and the acks it asked for (with the
 * role's stored fallback chain, unchanged); success reloads the page with
 * Turbo, and a 409 re-renders the preview it returns. The picks are locked
 * while a Save is in flight, so no pick can drop a save's answer.
 *
 * Every server string reaches the DOM through textContent. A refusal that is
 * not JSON (the CSRF check answers 403 as plain text) shows one generic
 * "try again / reload" line; server text is never shown.
 *
 * ABSOLUTE RULE: the returned source is embedded in a template literal: no
 * backticks in it, and no unescaped dollar-brace.
 */
import { tJs, translations } from "../../../shared/i18n.js";

/** Translations the warning may name by key: consumer and refusal labels, role names. */
const LABEL_PREFIXES = ["settings.providers.job.", "settings.providers.phone.", "settings.roles."];

function labelMap(lang) {
  const out = {};
  for (const [k, v] of Object.entries(translations)) {
    if (!LABEL_PREFIXES.some((p) => k.startsWith(p))) continue;
    const s = v?.[lang] || v?.en;
    if (typeof s === "string") out[k] = s;
  }
  return out;
}

/** JSON safe inside a <script> and a template literal (no <, backtick or dollar left raw). */
function scriptJson(v) {
  return JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/`/g, "\\u0060")
    .replace(/\$/g, "\\u0024")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** @returns {string} the client JS (no <script> wrapper) */
export function modelsClientJS({ lang = "en" } = {}) {
  return `
(function () {
  var dlg = document.getElementById('models-change');
  if (!dlg) return;
  var T = {
    changes: '${tJs("models.warn.changes", lang)}',
    notAffected: '${tJs("models.warn.notAffected", lang)}',
    keepsOwn: '${tJs("models.warn.keepsOwn", lang)}',
    cloud: '${tJs("models.warn.cloud", lang)}',
    cloudIfUnavailable: '${tJs("models.warn.cloudIfUnavailable", lang)}',
    speechCloud: '${tJs("models.warn.speechCloud", lang)}',
    paired: '${tJs("models.warn.paired", lang)}',
    useFor: '${tJs("models.warn.useFor", lang)}',
    ackUnattended: '${tJs("models.warn.ackUnattended", lang)}',
    refused: '${tJs("models.warn.refused", lang)}',
    reembed: '${tJs("models.warn.reembed", lang)}',
    replacePin: '${tJs("models.warn.replacePin", lang)}',
    customSetting: '${tJs("models.warn.customSetting", lang)}',
    changed: '${tJs("models.warn.changed", lang)}',
    env: '${tJs("models.status.env", lang)}',
    notSet: '${tJs("models.status.not_set", lang)}',
    notSetUp: '${tJs("models.status.not_set_up", lang)}',
    recommended: '${tJs("models.ui.recommended", lang)}',
    failed: '${tJs("models.ui.failed", lang)}',
    save: '${tJs("common.save", lang)}',
    cancel: '${tJs("common.cancel", lang)}',
    close: '${tJs("common.close", lang)}'
  };
  var GROUPS = [
    ['unattended', '${tJs("models.warn.group.unattended", lang)}'],
    ['bots', '${tJs("models.warn.group.bots", lang)}'],
    ['subagents', '${tJs("models.warn.group.subagents", lang)}'],
    ['jobs', '${tJs("models.warn.group.jobs", lang)}'],
    ['otherCrows', '${tJs("models.warn.group.otherCrows", lang)}']
  ];
  var WHERE = {
    here: '${tJs("models.where.here", lang)}',
    other_box: '${tJs("models.where.other_box", lang)}',
    cloud: '${tJs("models.where.cloud", lang)}',
    unproven: '${tJs("models.where.unproven", lang)}',
    missing: '${tJs("models.where.missing", lang)}'
  };
  var LABELS = ${scriptJson(labelMap(lang))};

  function fill(s, p) {
    var out = String(s);
    for (var k in p) out = out.split('{' + k + '}').join(String(p[k]));
    return out;
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function str(v) { return typeof v === 'string' && v.trim() && v !== 'null' ? v.trim() : ''; }
  function csrf() {
    var parts = String(document.cookie || '').split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (p.indexOf('crow_csrf=') === 0) {
        try { return decodeURIComponent(p.slice(10)); } catch (e) { return p.slice(10); }
      }
    }
    return '';
  }
  /** Never parses a non-JSON answer: data is null for those (and for network errors). */
  function call(method, path, body) {
    var headers = { 'Accept': 'application/json' };
    if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers['X-Crow-Csrf'] = csrf(); }
    var init = { method: method, headers: headers, credentials: 'same-origin' };
    if (body !== undefined) init.body = JSON.stringify(body);
    var done = function (r, d) { return { ok: !!r.ok, status: r.status, data: d && typeof d === 'object' ? d : null }; };
    return fetch(path, init).then(function (r) {
      var ct = '';
      try { ct = String((r.headers && typeof r.headers.get === 'function' && r.headers.get('content-type')) || ''); } catch (e) { ct = ''; }
      if (ct.toLowerCase().indexOf('application/json') === -1) return done(r, null);
      return r.json().then(function (d) { return done(r, d); }, function () { return done(r, null); });
    }, function () { return { ok: false, status: 0, data: null }; });
  }

  // --- the sheet ---------------------------------------------------------------
  var ui = {};
  var st = { seq: 0 };

  function build() {
    dlg.textContent = '';
    var inner = el('div', 'mc-inner');
    var head = el('div', 'mc-head');
    ui.title = el('h2', 'mc-title');
    ui.title.setAttribute('id', 'models-change-title');
    var x = el('button', 'mc-close', '×');
    x.type = 'button';
    x.setAttribute('aria-label', T.close);
    x.addEventListener('click', closeSheet);
    head.appendChild(ui.title);
    head.appendChild(x);
    ui.list = el('div', 'mc-list');
    ui.warn = el('div', 'mc-warn');
    ui.warn.setAttribute('data-mc-warn', '');
    ui.warn.setAttribute('aria-live', 'polite');
    ui.error = el('p', 'mc-error');
    ui.error.setAttribute('data-mc-error', '');
    ui.error.setAttribute('role', 'alert');
    var actions = el('div', 'mc-actions');
    var cancel = el('button', 'mr-change mc-cancel', T.cancel);
    cancel.type = 'button';
    cancel.addEventListener('click', closeSheet);
    ui.save = el('button', 'mr-btn mr-add mc-save', T.save);
    ui.save.type = 'button';
    ui.save.setAttribute('data-mc-save', '');
    ui.save.disabled = true;
    ui.save.addEventListener('click', save);
    actions.appendChild(cancel);
    actions.appendChild(ui.save);
    inner.appendChild(head);
    inner.appendChild(ui.list);
    inner.appendChild(ui.warn);
    inner.appendChild(ui.error);
    inner.appendChild(actions);
    dlg.appendChild(inner);
  }

  function closeSheet() {
    st.seq++;
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
  }

  function showError() {
    ui.error.textContent = T.failed;
    st.busy = false;
    lockPicks(false);
    updateSave();
  }

  /** Locks every pick during a Save; unlocking restores a refused pick's own disabled state. */
  function lockPicks(on) {
    var items = ui.items || [];
    for (var i = 0; i < items.length; i++) items[i].disabled = !!on || items[i].getAttribute('data-mc-refused') === 'true';
  }

  /** The acks that apply now: "Replace the pin" can bring in a job the pin held. */
  function needsNow() {
    var pv = st.preview;
    if (!pv) return {};
    var n = pv.pin && st.replacePin === true && pv.needsIfReplacePin ? pv.needsIfReplacePin : pv.needs;
    return n && typeof n === 'object' ? n : {};
  }

  function updateSave() {
    var pv = st.preview;
    var needsU = !!needsNow().ackUnattended;
    if (ui.ackRow) ui.ackRow.hidden = !needsU;
    ui.save.disabled = !pv || !!st.busy || (needsU && st.ackU !== true);
  }

  function openSheet(btn) {
    var role = btn.getAttribute('data-role') || '';
    st = {
      seq: st.seq + 1,
      role: role,
      kind: btn.getAttribute('data-role-kind') || 'chat',
      label: btn.getAttribute('data-role-label') || role,
      base: '/api/roles/' + encodeURIComponent(role),
      choice: null, preview: null, busy: false, ackU: false, replacePin: false, pickLabels: {}, fallback: null
    };
    ui.items = [];
    ui.ackRow = null;
    ui.title.textContent = st.label;
    ui.list.textContent = '';
    ui.warn.textContent = '';
    ui.error.textContent = '';
    ui.save.textContent = T.save;
    updateSave();
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); }
    else dlg.setAttribute('open', '');
    var seq = st.seq;
    call('GET', st.base + '/picks').then(function (r) {
      if (seq !== st.seq) return;
      if (!r.ok || !r.data) return showError();
      renderPicks(r.data);
    });
  }

  function whereChip(w) {
    var code = Object.prototype.hasOwnProperty.call(WHERE, w) ? w : 'unproven';
    return el('span', 'mr-where mr-where-' + code, WHERE[code]);
  }

  function pickItem(id, text, where, recommended, allowed, onChoose, provider) {
    var b = el('button', 'mc-pick');
    b.type = 'button';
    b.setAttribute('data-mc-pick', id);
    b.setAttribute('aria-pressed', 'false');
    b.appendChild(el('span', 'mc-pick-label', text));
    // The provider beside the model: two models with the same name from different providers stay apart.
    if (provider && provider !== text) b.appendChild(el('span', 'mc-pick-provider', provider));
    if (where) b.appendChild(whereChip(where));
    if (recommended) {
      var star = el('span', 'mc-star', '★');
      star.setAttribute('title', T.recommended);
      star.setAttribute('aria-label', T.recommended);
      b.appendChild(star);
    }
    if (!allowed) {
      b.disabled = true;
      b.setAttribute('data-mc-refused', 'true');
      b.setAttribute('aria-disabled', 'true');
      b.appendChild(el('span', 'mc-pick-note', fill(T.refused, { consumer: st.label })));
    }
    b.addEventListener('click', function () {
      if (b.disabled || st.busy) return;
      for (var i = 0; i < ui.items.length; i++) ui.items[i].setAttribute('aria-pressed', ui.items[i] === b ? 'true' : 'false');
      onChoose();
    });
    ui.items.push(b);
    ui.list.appendChild(b);
  }

  function renderPicks(data) {
    ui.list.textContent = '';
    ui.items = [];
    if (st.kind === 'speech') {
      var profiles = Array.isArray(data.profiles) ? data.profiles : [];
      profiles.forEach(function (p) {
        if (!p || typeof p.id !== 'string') return;
        var name = str(p.name) || p.id;
        pickItem(p.id, name, p.where, false, true, function () {
          choose({ speech: true, profileId: p.id, label: name, provider: str(p.provider) }, '/profile/preview', { profileId: p.id });
        });
      });
    } else {
      var picks = Array.isArray(data.picks) ? data.picks : [];
      var fb = data.fallback;
      st.fallback = Array.isArray(fb) && fb.every(function (f) { return typeof f === 'string'; }) ? fb.slice() : null;
      if (st.kind !== 'media') {
        pickItem('', T.notSet, null, false, true, function () {
          choose({ model: null, label: T.notSet }, '/preview', chatBody(null));
        });
      }
      picks.forEach(function (p) {
        if (!p || typeof p.key !== 'string') return;
        var text = str(p.label) || p.key;
        st.pickLabels[p.key] = text;
        pickItem(p.key, text, p.where, p.recommended === true, p.allowed !== false, function () {
          choose({ model: p.key, label: text }, '/preview', chatBody(p.key));
        }, str(p.providerLabel));
      });
    }
    if (!ui.items.length) ui.list.appendChild(el('p', 'mc-empty', T.notSetUp));
  }

  /** A chat-style body: the model plus the stored fallback chain, unchanged, when there is one.
   *  Safety never carries a chain (the server refuses one), so a stale stored chain is dropped. */
  function chatBody(model) {
    var b = { model: model };
    if (st.fallback && st.role !== 'safety') b.fallback = st.fallback.slice();
    return b;
  }

  function choose(choice, path, body) {
    st.seq++;
    var seq = st.seq;
    st.choice = choice;
    st.preview = null;
    st.ackU = false;
    st.replacePin = false;
    st.busy = false;
    ui.ackRow = null;
    ui.warn.textContent = '';
    ui.error.textContent = '';
    ui.save.textContent = T.save;
    updateSave();
    call('POST', st.base + path, body).then(function (r) {
      if (seq !== st.seq) return;
      if (!r.ok || !r.data || typeof r.data.previewHash !== 'string') return showError();
      render(r.data, false);
    });
  }

  // --- the warning ---------------------------------------------------------------

  function nameOf(c) {
    if (!c) return '';
    return (c.labelKey && LABELS[c.labelKey]) || str(c.label) || str(c.id);
  }
  function providerOf(key) {
    var k = str(key);
    if (!k || k.indexOf('role:') === 0) return '';
    var i = k.indexOf('/');
    return i > 0 ? k.slice(0, i) : '';
  }
  function modelLabel(key) { return st.pickLabels[key] || str(key); }
  function line(cls, text) { var p = el('p', cls, text); ui.warn.appendChild(p); return p; }
  function list(items) {
    var ul = el('ul', 'mc-names');
    var seen = {};
    items.forEach(function (c) {
      var n = nameOf(c);
      if (!n || Object.prototype.hasOwnProperty.call(seen, n)) return;
      seen[n] = true;
      ul.appendChild(el('li', null, n));
    });
    ui.warn.appendChild(ul);
  }
  function checkbox(attr, value, text, onChange) {
    var lab = el('label', 'mc-check');
    var cb = el('input');
    cb.type = 'checkbox';
    cb.setAttribute(attr, value);
    cb.addEventListener('change', function (e) { onChange(!!((e && e.target) || cb).checked); });
    lab.appendChild(cb);
    lab.appendChild(el('span', null, text));
    ui.warn.appendChild(lab);
    cb.row = lab;
    return cb;
  }

  function render(pv, changed) {
    st.preview = pv;
    st.ackU = false;
    st.replacePin = false;
    st.busy = false;
    ui.ackRow = null;
    lockPicks(false);
    ui.warn.textContent = '';
    ui.error.textContent = '';
    if (changed) line('mc-changed', T.changed);
    if (st.choice && st.choice.speech) renderSpeech(pv);
    else renderChat(pv);
    if (pv.paired === true) line('mc-paired', T.paired);
    var cloudAck = st.choice && st.choice.speech ? pv.cloud === true : !!(pv.needs && pv.needs.ackCloud);
    // Clearing a role names no model: the plain Save label, never "Use Not set ...".
    var clearing = !!(st.choice && !st.choice.speech && st.choice.model === null);
    ui.save.textContent = cloudAck && !clearing ? fill(T.useFor, { model: (st.choice && st.choice.label) || '' }) : T.save;
    updateSave();
    if (typeof ui.warn.scrollIntoView === 'function') { try { ui.warn.scrollIntoView({ block: 'nearest' }); } catch (e) { /* cosmetic */ } }
  }

  function renderSpeech(pv) {
    if (pv.cloud !== true) return;
    var c = st.choice;
    var host = str(pv.host) || c.provider || c.label || WHERE.cloud;
    line('mc-cloud', fill(T.speechCloud, { host: host }));
  }

  function renderChat(pv) {
    var cons = pv.consumers || {};
    var shown = GROUPS.filter(function (g) { return Array.isArray(cons[g[0]]) && cons[g[0]].length; });
    if (shown.length) {
      line('mc-changes', T.changes);
      shown.forEach(function (g) {
        ui.warn.appendChild(el('h3', 'mc-group', g[1]));
        list(cons[g[0]]);
      });
    }
    if (Array.isArray(cons.notAffected) && cons.notAffected.length) {
      line('mc-group', T.notAffected);
      list(cons.notAffected);
    }
    if (Array.isArray(cons.keepsOwnModel) && cons.keepsOwnModel.length) {
      var names = cons.keepsOwnModel.map(nameOf).filter(function (n) { return n; });
      if (names.length) line('mc-keeps', fill(T.keepsOwn, { names: names.join(', ') }));
    }
    if (pv.envPinned === true) line('mc-env', T.env);
    if (pv.cloud && typeof pv.cloud === 'object') {
      var host = str(pv.cloud.host) || providerOf(pv.cloud.model) || WHERE.cloud;
      var s = fill(T.cloud, { host: host });
      if (pv.cloud.now === false) s += ' ' + fill(T.cloudIfUnavailable, { model: modelLabel(pv.cloud.model) });
      line('mc-cloud', s);
    }
    (Array.isArray(pv.refused) ? pv.refused : []).forEach(function (r) {
      line('mc-refused', fill(T.refused, { consumer: nameOf(r) }));
    });
    var re = pv.reembed === true ? line('mc-reembed', T.reembed) : null;
    if (re) re.hidden = !!pv.pin;
    if (pv.pin && typeof pv.pin === 'object') {
      checkbox('data-mc-pin', '', fill(T.replacePin, { value: str(pv.pin.value) || T.customSetting }), function (on) {
        st.replacePin = on;
        if (re) re.hidden = !on;
        updateSave();
      });
    }
    var ifPin = pv.pin && pv.needsIfReplacePin && pv.needsIfReplacePin.ackUnattended;
    if ((pv.needs && pv.needs.ackUnattended) || ifPin) {
      ui.ackRow = checkbox('data-mc-ack', 'unattended', T.ackUnattended, function (on) {
        st.ackU = on;
        updateSave();
      }).row;
    }
  }

  // --- save ------------------------------------------------------------------

  function save() {
    var pv = st.preview;
    var c = st.choice;
    if (!pv || !c || st.busy || ui.save.disabled) return;
    var path, body;
    if (c.speech) {
      path = st.base + '/profile';
      body = { profileId: c.profileId, previewHash: pv.previewHash, ackCloud: pv.cloud === true };
    } else {
      var n = needsNow();
      path = st.base;
      body = chatBody(c.model);
      body.previewHash = pv.previewHash;
      // An ack the current state does not ask for (a hidden box) is never sent.
      body.ackUnattended = !!n.ackUnattended && st.ackU === true;
      body.ackCloud = !!n.ackCloud;
      body.replacePin = st.replacePin === true;
    }
    st.busy = true;
    lockPicks(true);
    ui.error.textContent = '';
    updateSave();
    var seq = st.seq;
    call('POST', path, body).then(function (r) {
      if (seq !== st.seq) return;
      if (r.ok && r.data && r.data.ok === true) {
        closeSheet();
        if (window.Turbo && typeof window.Turbo.visit === 'function') window.Turbo.visit(location.href, { action: 'replace' });
        else location.reload();
        return;
      }
      var p = r.data && r.data.preview;
      if (r.status === 409 && p && typeof p === 'object' && typeof p.previewHash === 'string') {
        return render(p, r.data.reason === 'preview_changed');
      }
      showError();
    });
  }

  build();
  var btns = document.querySelectorAll('.mr-change[data-role]');
  for (var i = 0; i < btns.length; i++) {
    (function (b) { b.addEventListener('click', function () { openSheet(b); }); })(btns[i]);
  }
  dlg.addEventListener('click', function (e) { if (e && e.target === dlg) closeSheet(); });
  // Close the sheet before Turbo caches this page (once per document).
  if (!window.__crowModelsSheetCacheBound) {
    window.__crowModelsSheetCacheBound = true;
    document.addEventListener('turbo:before-cache', function () {
      var d = document.getElementById('models-change');
      if (d && typeof d.close === 'function' && d.open) d.close();
    });
  }
})();
`;
}

/**
 * The custom-role sheet (Task 18): "Add a role" and a custom row's "Edit"
 * open `<dialog id="models-custom">` with a name, a job, what it works with
 * (text, or text and images) and the "may use big models" switch. Save
 * posts /api/roles/custom; an edit that changes what the role may use comes
 * back 409 with a preview (what the role will use after it, who moves, the
 * cloud line and the unattended ack), and the next Save sends its hash.
 * Delete (custom roles only, inside the sheet) asks once more, then sends
 * DELETE /api/roles/custom/<id>; a 409 lists what still uses the role.
 *
 * Same rules as the change sheet: textContent only, no backtick, no
 * unescaped dollar-brace.
 * @returns {string} the client JS (no <script> wrapper)
 */
export function customRolesClientJS({ lang = "en" } = {}) {
  return `
(function () {
  var dlg = document.getElementById('models-custom');
  if (!dlg) return;
  var T = {
    add: '${tJs("models.ui.addRole", lang)}',
    edit: '${tJs("models.custom.editTitle", lang)}',
    name: '${tJs("models.custom.name", lang)}',
    job: '${tJs("models.custom.job", lang)}',
    capability: '${tJs("models.custom.capability", lang)}',
    capChat: '${tJs("models.custom.cap.chat", lang)}',
    capVision: '${tJs("models.custom.cap.vision", lang)}',
    big: '${tJs("models.custom.bigModels", lang)}',
    inUse: '${tJs("models.custom.inUse", lang)}',
    confirmDelete: '${tJs("models.custom.deleteConfirm", lang)}',
    invalidLabel: '${tJs("models.custom.invalidLabel", lang)}',
    invalidJob: '${tJs("models.custom.invalidJob", lang)}',
    nameTaken: '${tJs("models.custom.nameTaken", lang)}',
    next: '${tJs("models.custom.previewNext", lang)}',
    none: '${tJs("models.custom.previewNone", lang)}',
    changes: '${tJs("models.warn.changes", lang)}',
    cloud: '${tJs("models.warn.cloud", lang)}',
    ackUnattended: '${tJs("models.warn.ackUnattended", lang)}',
    changed: '${tJs("models.warn.changed", lang)}',
    failed: '${tJs("models.ui.failed", lang)}',
    save: '${tJs("common.save", lang)}',
    del: '${tJs("common.delete", lang)}',
    cancel: '${tJs("common.cancel", lang)}',
    close: '${tJs("common.close", lang)}'
  };
  var LABELS = ${scriptJson(labelMap(lang))};
  var MOVES = ['unattended', 'bots', 'subagents', 'jobs', 'otherCrows'];

  function fill(s, p) {
    var out = String(s);
    for (var k in p) out = out.split('{' + k + '}').join(String(p[k]));
    return out;
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function str(v) { return typeof v === 'string' && v.trim() && v !== 'null' ? v.trim() : ''; }
  function csrf() {
    var parts = String(document.cookie || '').split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (p.indexOf('crow_csrf=') === 0) {
        try { return decodeURIComponent(p.slice(10)); } catch (e) { return p.slice(10); }
      }
    }
    return '';
  }
  function call(method, path, body) {
    var headers = { 'Accept': 'application/json', 'X-Crow-Csrf': csrf() };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    var init = { method: method, headers: headers, credentials: 'same-origin' };
    if (body !== undefined) init.body = JSON.stringify(body);
    var done = function (r, d) { return { ok: !!r.ok, status: r.status, data: d && typeof d === 'object' ? d : null }; };
    return fetch(path, init).then(function (r) {
      var ct = '';
      try { ct = String((r.headers && typeof r.headers.get === 'function' && r.headers.get('content-type')) || ''); } catch (e) { ct = ''; }
      if (ct.toLowerCase().indexOf('application/json') === -1) return done(r, null);
      return r.json().then(function (d) { return done(r, d); }, function () { return done(r, null); });
    }, function () { return { ok: false, status: 0, data: null }; });
  }
  function nameOf(c) {
    if (!c) return '';
    return (c.labelKey && LABELS[c.labelKey]) || str(c.label) || str(c.id);
  }
  function namesOf(list) {
    var seen = {}, out = [];
    (Array.isArray(list) ? list : []).forEach(function (c) {
      var n = nameOf(c);
      if (n && !Object.prototype.hasOwnProperty.call(seen, n)) { seen[n] = true; out.push(n); }
    });
    return out;
  }

  var ui = {};
  var st = { seq: 0 };

  function field(labelText, input) {
    var lab = el('label', 'mc-field');
    lab.appendChild(el('span', null, labelText));
    lab.appendChild(input);
    ui.form.appendChild(lab);
    return input;
  }

  function build() {
    dlg.textContent = '';
    var inner = el('div', 'mc-inner');
    var head = el('div', 'mc-head');
    ui.title = el('h2', 'mc-title');
    ui.title.setAttribute('id', 'models-custom-title');
    var x = el('button', 'mc-close', '×');
    x.type = 'button';
    x.setAttribute('aria-label', T.close);
    x.addEventListener('click', closeSheet);
    head.appendChild(ui.title);
    head.appendChild(x);
    ui.form = el('div', 'mc-form');
    ui.name = el('input');
    ui.name.type = 'text';
    ui.name.setAttribute('maxlength', '40');
    ui.name.setAttribute('data-custom-name', '');
    field(T.name, ui.name);
    ui.job = el('input');
    ui.job.type = 'text';
    ui.job.setAttribute('maxlength', '160');
    ui.job.setAttribute('data-custom-job', '');
    field(T.job, ui.job);
    ui.cap = el('select');
    ui.cap.setAttribute('data-custom-cap', '');
    [['chat', T.capChat], ['vision', T.capVision]].forEach(function (o) {
      var opt = el('option', null, o[1]);
      opt.value = o[0];
      opt.setAttribute('value', o[0]);
      ui.cap.appendChild(opt);
    });
    field(T.capability, ui.cap);
    var heavy = el('label', 'mc-check');
    ui.heavy = el('input');
    ui.heavy.type = 'checkbox';
    ui.heavy.setAttribute('data-custom-heavy', '');
    heavy.appendChild(ui.heavy);
    heavy.appendChild(el('span', null, T.big));
    ui.form.appendChild(heavy);
    // Any change to the form drops a preview the user saw for the old values.
    [ui.name, ui.job, ui.cap, ui.heavy].forEach(function (n) {
      n.addEventListener('change', resetPreview);
      n.addEventListener('input', resetPreview);
    });
    ui.warn = el('div', 'mc-warn');
    ui.warn.setAttribute('data-custom-warn', '');
    ui.warn.setAttribute('aria-live', 'polite');
    ui.error = el('p', 'mc-error');
    ui.error.setAttribute('data-custom-error', '');
    ui.error.setAttribute('role', 'alert');
    var actions = el('div', 'mc-actions');
    ui.del = el('button', 'mr-change mc-delete', T.del);
    ui.del.type = 'button';
    ui.del.setAttribute('data-custom-delete', '');
    ui.del.addEventListener('click', del);
    var cancel = el('button', 'mr-change mc-cancel', T.cancel);
    cancel.type = 'button';
    cancel.addEventListener('click', closeSheet);
    ui.save = el('button', 'mr-btn mr-add mc-save', T.save);
    ui.save.type = 'button';
    ui.save.setAttribute('data-custom-save', '');
    ui.save.addEventListener('click', save);
    actions.appendChild(ui.del);
    actions.appendChild(cancel);
    actions.appendChild(ui.save);
    inner.appendChild(head);
    inner.appendChild(ui.form);
    inner.appendChild(ui.warn);
    inner.appendChild(ui.error);
    inner.appendChild(actions);
    dlg.appendChild(inner);
  }

  function closeSheet() {
    st.seq++;
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
  }

  function resetPreview() {
    if (!st.preview && !st.armed) return;
    st.preview = null;
    st.ackU = false;
    st.armed = false;
    ui.del.textContent = T.del;
    ui.warn.textContent = '';
    updateSave();
  }

  function updateSave() {
    var needsU = !!(st.preview && st.preview.needs && st.preview.needs.ackUnattended);
    ui.save.disabled = !!st.busy || (needsU && st.ackU !== true);
    ui.del.disabled = !!st.busy;
  }

  function openSheet(btn) {
    var id = btn ? btn.getAttribute('data-custom-edit') : null;
    st = { seq: st.seq + 1, id: id || null, preview: null, ackU: false, busy: false, armed: false };
    ui.title.textContent = id ? T.edit : T.add;
    ui.name.value = id ? (btn.getAttribute('data-custom-label') || '') : '';
    ui.job.value = id ? (btn.getAttribute('data-custom-job') || '') : '';
    ui.cap.value = id && btn.getAttribute('data-custom-capability') === 'vision' ? 'vision' : 'chat';
    ui.heavy.checked = !!id && btn.getAttribute('data-custom-heavy') === 'true';
    // Only an existing custom role can be deleted.
    ui.del.hidden = !id;
    ui.del.textContent = T.del;
    ui.warn.textContent = '';
    ui.error.textContent = '';
    updateSave();
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); }
    else dlg.setAttribute('open', '');
  }

  function line(cls, text) { var p = el('p', cls, text); ui.warn.appendChild(p); return p; }

  function renderPreview(pv, changed) {
    st.preview = pv;
    st.ackU = false;
    ui.warn.textContent = '';
    if (changed) line('mc-changed', T.changed);
    var nk = pv.next && (str(pv.next.label) || str(pv.next.key));
    line('mc-next', nk ? fill(T.next, { model: nk }) : T.none);
    var cons = pv.consumers || {};
    var moved = [];
    MOVES.forEach(function (g) { moved = moved.concat(namesOf(cons[g])); });
    if (moved.length) {
      line('mc-changes', T.changes);
      var ul = el('ul', 'mc-names');
      moved.forEach(function (n) { ul.appendChild(el('li', null, n)); });
      ui.warn.appendChild(ul);
    }
    if (pv.cloud && typeof pv.cloud === 'object') line('mc-cloud', fill(T.cloud, { host: str(pv.cloud.host) || str(pv.cloud.model) }));
    if (pv.needs && pv.needs.ackUnattended) {
      var lab = el('label', 'mc-check');
      var cb = el('input');
      cb.type = 'checkbox';
      cb.setAttribute('data-custom-ack', 'unattended');
      cb.addEventListener('change', function (e) { st.ackU = !!((e && e.target) || cb).checked; updateSave(); });
      lab.appendChild(cb);
      lab.appendChild(el('span', null, T.ackUnattended));
      ui.warn.appendChild(lab);
    }
  }

  function done() {
    closeSheet();
    if (window.Turbo && typeof window.Turbo.visit === 'function') window.Turbo.visit(location.href, { action: 'replace' });
    else location.reload();
  }

  function fail(text) {
    ui.error.textContent = text || T.failed;
    st.busy = false;
    updateSave();
  }

  function save() {
    if (st.busy || ui.save.disabled) return;
    var label = String(ui.name.value || '').trim();
    if (!label || label.length > 40) return fail(T.invalidLabel);
    var body = { label: label, job: String(ui.job.value || '').trim(), capability: ui.cap.value === 'vision' ? 'vision' : 'chat', allowHeavy: ui.heavy.checked === true };
    if (st.id) body.id = st.id;
    if (st.preview && typeof st.preview.previewHash === 'string') {
      body.previewHash = st.preview.previewHash;
      body.ackUnattended = !!(st.preview.needs && st.preview.needs.ackUnattended) && st.ackU === true;
      body.ackCloud = !!(st.preview.needs && st.preview.needs.ackCloud);
    }
    st.busy = true;
    ui.error.textContent = '';
    updateSave();
    var seq = st.seq;
    call('POST', '/api/roles/custom', body).then(function (r) {
      if (seq !== st.seq) return;
      if (r.ok && r.data && r.data.ok === true) return done();
      var d = r.data || {};
      if (r.status === 409 && d.preview && typeof d.preview === 'object' && typeof d.preview.previewHash === 'string') {
        st.busy = false;
        renderPreview(d.preview, d.reason === 'preview_changed');
        return updateSave();
      }
      fail(d.reason === 'invalid_label' ? T.invalidLabel : d.reason === 'invalid_job' ? T.invalidJob : d.reason === 'name_taken' ? T.nameTaken : T.failed);
    });
  }

  function del() {
    if (!st.id || st.busy) return;
    if (!st.armed) {
      // Ask once more: a role, and the model chosen for it, go together.
      st.armed = true;
      st.preview = null;
      ui.warn.textContent = '';
      line('mc-confirm', fill(T.confirmDelete, { name: String(ui.name.value || '').trim() || st.id }));
      ui.del.textContent = T.del;
      ui.del.setAttribute('data-armed', 'true');
      return updateSave();
    }
    st.busy = true;
    ui.error.textContent = '';
    updateSave();
    var seq = st.seq;
    call('DELETE', '/api/roles/custom/' + encodeURIComponent(st.id)).then(function (r) {
      if (seq !== st.seq) return;
      if (r.ok && r.data && r.data.ok === true) return done();
      var d = r.data || {};
      st.armed = false;
      ui.del.removeAttribute('data-armed');
      ui.warn.textContent = '';
      if (r.status === 409 && d.reason === 'in_use') return fail(fill(T.inUse, { names: namesOf(d.consumers).join(', ') }));
      fail(T.failed);
    });
  }

  build();
  var opens = document.querySelectorAll('[data-custom-add], [data-custom-edit]');
  for (var i = 0; i < opens.length; i++) {
    (function (b) { b.addEventListener('click', function () { openSheet(b.hasAttribute('data-custom-edit') ? b : null); }); })(opens[i]);
  }
  dlg.addEventListener('click', function (e) { if (e && e.target === dlg) closeSheet(); });
  if (!window.__crowCustomSheetCacheBound) {
    window.__crowCustomSheetCacheBound = true;
    document.addEventListener('turbo:before-cache', function () {
      var d = document.getElementById('models-custom');
      if (d && typeof d.close === 'function' && d.open) d.close();
    });
  }
})();
`;
}

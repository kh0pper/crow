/**
 * "Add a provider" on the Models page (roles phase 2b): the sheet and its
 * browser side.
 *
 * Steps: pick a provider (a plan or region choice for a preset with variants,
 * such as Z.AI or Model Studio; a server address only for "Other"), paste one
 * key, Test (POST /api/providers/test, one plain line per outcome), tick
 * models (recommended ones pre-ticked and starred, a filter past 20, a "type a
 * model name" field; a provider with no model list offers its recommended ids),
 * Save (POST /api/providers). Then each
 * recommended pick with its stored check, "Test the picks" (the only trigger
 * of a probe), "Use the recommended models" with opt-ins unticked, one combined
 * warning, and the roles still empty.
 *
 * The key: one `type="password"` field with autocomplete off, never filled by
 * the server, cleared once saved and whenever the sheet opens or closes. Only
 * the test and the save requests carry it.
 *
 * Every server string reaches the DOM through textContent. A refusal that is
 * not JSON (the CSRF check answers 403 as plain text) shows one generic line.
 *
 * ABSOLUTE RULE: the client source is embedded in a template literal: no
 * backticks in it, and no unescaped dollar-brace.
 */
import { escapeHtml } from "./components.js";
import { t, tJs, fill, translations } from "./i18n.js";
import { PROVIDER_PRESETS } from "../../../shared/provider-presets.js";
import { loadRecommendations } from "../../../shared/provider-recommendations.js";

const TEST_CODES = ["ok", "key_rejected", "bad_key", "rate_limited", "unreachable", "not_found", "bad_url", "forbidden_target", "provider_error"];
const ERR_CODES = ["unknown_preset", "bad_model", "save_failed"];
const WHY_CODES = ["seeded", "runs_today", "cloud", "not_available"];
const SKIP_CODES = ["set", "none_offered", "not_listed", "not_tested", "failed_check", "unknown"];
const LABEL_PREFIXES = ["settings.providers.job.", "settings.providers.phone.", "settings.roles."];

/** JSON safe inside a <script> and a template literal (no <, backtick or dollar left raw). */
function scriptJson(v) {
  return JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/`/g, "\\u0060")
    .replace(/\$/g, "\\u0024")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function labelMap(lang) {
  const out = {};
  for (const [k, v] of Object.entries(translations)) {
    if (!LABEL_PREFIXES.some((p) => k.startsWith(p))) continue;
    const s = v?.[lang] || v?.en;
    if (typeof s === "string") out[k] = s;
  }
  return out;
}

function copyMap(prefix, codes, lang) {
  const out = {};
  for (const c of codes) out[c] = t(`${prefix}${c}`, lang);
  return out;
}

const presetLabel = (p, lang) => t(p.labelKey, lang);
const hasVariants = (p) => Array.isArray(p.variants) && p.variants.length > 0;

/**
 * Every preset's variants (plans or regions), one optgroup per preset. The
 * sheet's client keeps only the chosen preset's; the onboarding no-script form
 * sends whichever is picked and its handler ignores one from another preset.
 */
export function variantOptionsHtml(lang) {
  return PROVIDER_PRESETS.filter(hasVariants).map((p) =>
    `<optgroup label="${escapeHtml(presetLabel(p, lang))}">` +
    p.variants.map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(t(v.labelKey, lang))}</option>`).join("") +
    "</optgroup>").join("");
}

function reviewedDate() {
  const a = loadRecommendations().accessed;
  return typeof a === "string" ? a : "";
}

const STYLE = `<style>
  .mc-inner { padding:16px 16px calc(16px + env(safe-area-inset-bottom, 0px)); display:flex; flex-direction:column; gap:0.75rem; min-width:0; }
  .mc-head { display:flex; align-items:center; justify-content:space-between; gap:0.5rem; }
  .mc-title { font-size:1.05rem; margin:0; overflow-wrap:anywhere; }
  .mc-close { width:44px; height:44px; flex:0 0 44px; border:none; border-radius:50%; background:transparent; color:var(--crow-text-secondary); font-size:1.4rem; cursor:pointer; }
  .mc-star { color:var(--crow-accent); }
  .mc-warn { display:flex; flex-direction:column; gap:0.35rem; font-size:0.9rem; overflow-wrap:anywhere; }
  .mc-warn p { margin:0; }
  .mc-warn [hidden] { display:none; }
  .mc-group { font-size:0.8rem; margin:0.25rem 0 0; color:var(--crow-text-secondary); }
  .mc-names { margin:0; padding-left:1.2rem; }
  .mc-cloud, .mc-changed { font-weight:600; }
  .mc-check { display:flex; align-items:flex-start; gap:0.5rem; min-height:44px; padding-top:0.6rem; box-sizing:border-box; cursor:pointer; }
  .mc-check input { width:20px; height:20px; flex:0 0 20px; margin:0; }
  .mc-error { margin:0; color:var(--crow-error); font-size:0.85rem; }
  .mc-error:empty { display:none; }
  .mc-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:0.5rem; position:sticky; bottom:0; background:var(--crow-bg-surface); padding-top:0.5rem; }
  #models-add { border:none; padding:0; width:min(560px, 100%); max-width:100%; max-height:90dvh; box-sizing:border-box; overflow:auto;
    border-radius:var(--crow-radius-card); background:var(--crow-bg-surface); color:var(--crow-text-primary); box-shadow:0 -8px 32px rgba(0,0,0,0.18); }
  #models-add::backdrop { background:rgba(0,0,0,0.4); }
  #models-add[open]:not(:modal) { position:fixed; inset:auto 0 0; z-index:1200; margin:0 auto; }
  @media (max-width: 480px) {
    #models-add { width:100%; margin:auto 0 0; border-radius:var(--crow-radius-card) var(--crow-radius-card) 0 0; }
  }
  .ap-field { display:flex; flex-direction:column; gap:0.3rem; font-size:0.9rem; min-width:0; }
  .ap-field[hidden], .ap-sheet [hidden] { display:none; }
  .ap-field select, .ap-field input, .ap-type input, .ap-filter { min-height:44px; padding:0 0.75rem; box-sizing:border-box; width:100%; max-width:100%;
    font:inherit; color:var(--crow-text-primary); background:var(--crow-bg-elevated); border:1px solid var(--crow-border); border-radius:var(--crow-radius-control); }
  .ap-note { margin:0; font-size:0.8rem; color:var(--crow-text-muted); }
  .ap-line { margin:0; font-size:0.9rem; overflow-wrap:anywhere; }
  .ap-line:empty { display:none; }
  .ap-sub { font-size:0.95rem; margin:0.5rem 0 0; }
  .ap-list { display:flex; flex-direction:column; gap:0.1rem; max-height:40dvh; overflow:auto; }
  .ap-list .mc-check, .ap-rec .mc-check { overflow-wrap:anywhere; }
  .ap-type { display:flex; flex-wrap:wrap; gap:0.5rem; }
  .ap-type input { flex:1 1 180px; width:auto; }
  .ap-pick { display:flex; flex-wrap:wrap; gap:0.25rem 0.5rem; padding:0.5rem 0; border-bottom:1px solid var(--crow-border); font-size:0.9rem; overflow-wrap:anywhere; }
  .ap-pick-role { font-weight:600; flex-basis:100%; }
  .ap-pick-status, .ap-why { font-size:0.8rem; color:var(--crow-text-muted); }
  .ap-why { display:block; }
  .ap-btn { min-height:44px; padding:0 1rem; border-radius:var(--crow-radius-control); font:inherit; cursor:pointer;
    background:transparent; color:var(--crow-text-primary); border:1px solid var(--crow-border); }
  .ap-primary { background:var(--crow-accent); color:var(--crow-accent-contrast); border:0; }
  .ap-btn:disabled { opacity:0.5; cursor:not-allowed; }
</style>`;

/**
 * The sheet: an empty-state form inside `<dialog id="models-add">`. Never
 * carries a key or any stored provider value. `open` marks it to open on load
 * (`?add=1`).
 * @returns {string}
 */
export function addProviderSheetHtml({ lang = "en", open = false } = {}) {
  const e = (k) => escapeHtml(t(k, lang));
  const options = PROVIDER_PRESETS.map((p) =>
    `<option value="${escapeHtml(p.id)}">${escapeHtml(presetLabel(p, lang))}</option>`).join("");
  const variants = variantOptionsHtml(lang);
  const reviewed = reviewedDate();
  return `${STYLE}
    <dialog id="models-add" class="mc-sheet ap-sheet" aria-labelledby="models-add-title"${open ? ' data-open="1"' : ""}>
      <div class="mc-inner">
        <div class="mc-head">
          <h2 class="mc-title" id="models-add-title">${e("models.add.title")}</h2>
          <button type="button" class="mc-close" data-ap="close" aria-label="${e("common.close")}">×</button>
        </div>
        <label class="ap-field">${e("models.add.provider")}
          <select data-ap="preset">${options}</select>
        </label>
        <label class="ap-field" data-ap="variantRow" hidden><span data-ap="variantLabel">${e("models.add.plan")}</span>
          <select data-ap="variant">${variants}</select>
        </label>
        <label class="ap-field" data-ap="urlRow" hidden>${e("models.add.baseUrl")}
          <input type="url" data-ap="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://api.example.com/v1">
        </label>
        <label class="ap-field">${e("models.add.key")}
          <input type="password" data-ap="key" autocomplete="off" autocapitalize="off" spellcheck="false">
        </label>
        <p class="ap-note" data-ap="presetNote" hidden></p>
        <p class="ap-note">${e("models.add.keyNote")}</p>
        <div><button type="button" class="ap-btn" data-ap="test">${e("models.add.testBtn")}</button></div>
        <p class="ap-line" data-ap="testLine" aria-live="polite"></p>
        <div data-ap="modelsBox" hidden>
          <h3 class="ap-sub">${e("models.add.models")}</h3>
          <input type="search" class="ap-filter" data-ap="filter" autocomplete="off" placeholder="${e("models.add.filter")}" aria-label="${e("models.add.filter")}" hidden>
          <p class="ap-note" data-ap="truncated" hidden></p>
          <div class="ap-list" data-ap="list"></div>
          <div class="ap-type">
            <input type="text" data-ap="typeName" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${e("models.add.typeName")}" aria-label="${e("models.add.typeName")}">
            <button type="button" class="ap-btn" data-ap="addName">${e("models.add.addName")}</button>
          </div>
          <div><button type="button" class="ap-btn ap-primary" data-ap="save" disabled>${e("common.save")}</button></div>
          <p class="ap-line" data-ap="saveLine" role="status"></p>
        </div>
        <div data-ap="picksBox" hidden>
          <h3 class="ap-sub">${e("models.add.picksTitle")}</h3>
          ${reviewed ? `<p class="ap-note">${escapeHtml(fill(t("models.ui.recsReviewed", lang), { date: reviewed }))}</p>` : ""}
          <p class="ap-note" data-ap="stale" hidden>${e("models.add.recsStale")}</p>
          <p class="ap-note">${e("models.add.onlyTicked")}</p>
          <div data-ap="picks"></div>
          <div><button type="button" class="ap-btn" data-ap="probe">${e("models.add.probe")}</button></div>
          <div class="ap-rec" data-ap="recBox" hidden>
            <div data-ap="recList"></div>
            <div data-ap="skipList"></div>
            <div class="mc-warn" data-ap="warn" aria-live="polite"></div>
            <div><button type="button" class="ap-btn ap-primary" data-ap="apply" disabled>${e("models.add.useRecommended")}</button></div>
            <p class="ap-line" data-ap="result" role="status"></p>
          </div>
        </div>
        <p class="mc-error" data-ap="error" role="alert"></p>
        <div class="mc-actions"><button type="button" class="ap-btn" data-ap="done">${e("common.close")}</button></div>
      </div>
    </dialog>`;
}

/** @returns {string} the client JS (no <script> wrapper) */
export function addProviderClientJS({ lang = "en" } = {}) {
  const presets = PROVIDER_PRESETS.map((p) => ({
    id: p.id, label: presetLabel(p, lang), hint: p.keyHint || "",
    variants: hasVariants(p) ? p.variants.map((v) => ({ id: v.id, label: t(v.labelKey, lang) })) : [],
    variantLabel: t(p.variantLabelKey || "models.add.plan", lang),
    note: p.keyNoteKey ? t(p.keyNoteKey, lang) : "",
    rejected: p.keyRejectedKey ? t(p.keyRejectedKey, lang) : "",
  }));
  return `
(function () {
  var dlg = document.getElementById('models-add');
  if (!dlg) return;
  var T = {
    failed: '${tJs("models.ui.failed", lang)}',
    recommended: '${tJs("models.ui.recommended", lang)}',
    saved: '${tJs("models.add.saved", lang)}',
    okNoList: '${tJs("models.add.test.okNoList", lang)}',
    truncated: '${tJs("models.add.truncated", lang)}',
    notTested: '${tJs("models.add.notTested", lang)}',
    tryLater: '${tJs("models.add.tryLater", lang)}',
    passed: '${tJs("models.add.passed", lang)}',
    probeFailed: '${tJs("models.add.probeFailed", lang)}',
    checkedOn: '${tJs("models.add.checkedOn", lang)}',
    rerankNote: '${tJs("models.add.rerankNote", lang)}',
    noPicks: '${tJs("models.add.noPicks", lang)}',
    runsToday: '${tJs("models.add.runsToday", lang)}',
    stillEmpty: '${tJs("models.add.stillEmpty", lang)}',
    allSet: '${tJs("models.add.allSet", lang)}',
    notChanged: '${tJs("models.add.notChanged", lang)}',
    changes: '${tJs("models.warn.changes", lang)}',
    cloud: '${tJs("models.warn.cloud", lang)}',
    refused: '${tJs("models.warn.refused", lang)}',
    reembed: '${tJs("models.warn.reembed", lang)}',
    ackUnattended: '${tJs("models.warn.ackUnattended", lang)}',
    changed: '${tJs("models.warn.changed", lang)}',
    cloudWhere: '${tJs("models.where.cloud", lang)}'
  };
  var TEST = ${scriptJson(copyMap("models.add.test.", TEST_CODES, lang))};
  var ERR = ${scriptJson(copyMap("models.add.err.", ERR_CODES, lang))};
  var WHY = ${scriptJson(copyMap("models.add.why.", WHY_CODES, lang))};
  var SKIP = ${scriptJson(copyMap("models.add.skip.", SKIP_CODES, lang))};
  var GROUPS = [
    ['unattended', '${tJs("models.warn.group.unattended", lang)}'],
    ['bots', '${tJs("models.warn.group.bots", lang)}'],
    ['subagents', '${tJs("models.warn.group.subagents", lang)}'],
    ['jobs', '${tJs("models.warn.group.jobs", lang)}'],
    ['otherCrows', '${tJs("models.warn.group.otherCrows", lang)}']
  ];
  var LABELS = ${scriptJson(labelMap(lang))};
  var PRESETS = ${scriptJson(presets)};
  var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };

  function q(name) { return dlg.querySelector('[data-ap="' + name + '"]'); }
  var ui = {};
  ['close', 'preset', 'variantRow', 'variantLabel', 'variant', 'presetNote', 'urlRow', 'url', 'key', 'test', 'testLine', 'modelsBox', 'filter', 'truncated',
    'list', 'typeName', 'addName', 'save', 'saveLine', 'picksBox', 'stale', 'picks', 'probe', 'recBox', 'recList', 'skipList',
    'warn', 'apply', 'result', 'error', 'done'].forEach(function (n) { ui[n] = q(n); });
  if (!ui.preset || !ui.key) return;

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
  function roleName(id) { return LABELS['settings.roles.' + id] || String(id); }
  function nameOf(c) { return c ? ((c.labelKey && LABELS[c.labelKey]) || str(c.label) || str(c.id)) : ''; }
  function dateOf(at) { return typeof at === 'string' && at.length >= 10 ? at.slice(0, 10) : ''; }

  var st = { seq: 0 };

  function presetNow() {
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === ui.preset.value) return PRESETS[i];
    return PRESETS[0];
  }

  function form() {
    var p = presetNow();
    var b = { presetId: p.id, apiKey: String(ui.key.value || '') };
    if (p.variants.length && ui.variant) b.variantId = String(ui.variant.value || '');
    if (p.id === 'other' && ui.url) b.baseUrl = String(ui.url.value || '').trim();
    return b;
  }

  function resetTest() {
    st.seq++;
    st.testOk = false;
    st.typedOnly = false;
    st.models = [];
    ui.testLine.textContent = '';
    ui.saveLine.textContent = '';
    ui.list.textContent = '';
    ui.modelsBox.hidden = true;
    ui.filter.hidden = true;
    ui.filter.value = '';
    ui.truncated.hidden = true;
    updateSave();
  }

  /** Only the chosen preset's variants are offered; the first (the default) is selected. */
  function syncVariants(p) {
    if (!ui.variant) return;
    ui.variant.textContent = '';
    p.variants.forEach(function (v) {
      var o = el('option', null, v.label);
      o.value = v.id;
      ui.variant.appendChild(o);
    });
    if (p.variants.length) ui.variant.value = p.variants[0].id;
    if (ui.variantLabel) ui.variantLabel.textContent = p.variantLabel;
  }

  function syncPreset() {
    var p = presetNow();
    ui.variantRow.hidden = !p.variants.length;
    syncVariants(p);
    if (ui.presetNote) { ui.presetNote.textContent = p.note; ui.presetNote.hidden = !p.note; }
    ui.urlRow.hidden = p.id !== 'other';
    try { ui.key.setAttribute('placeholder', p.hint || ''); } catch (e) { /* cosmetic */ }
    resetTest();
  }

  function openSheet() {
    st = { seq: st.seq + 1, changed: false, busy: false, providerId: null, models: [], closed: false };
    ui.key.value = '';
    ui.error.textContent = '';
    ui.picksBox.hidden = true;
    ui.picks.textContent = '';
    ui.recBox.hidden = true;
    ui.save.hidden = false;
    syncPreset();
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); }
    else dlg.setAttribute('open', '');
  }

  /** Every way the sheet closes (the button, the backdrop, Escape): forget the key; reload once after a save. */
  function onClosed() {
    ui.key.value = '';
    if (st.closed) return;
    st.closed = true;
    st.seq++;
    if (st.changed) {
      if (window.Turbo && typeof window.Turbo.visit === 'function') window.Turbo.visit(location.href, { action: 'replace' });
      else location.reload();
    }
  }

  function closeSheet() {
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
    onClosed();
  }

  // --- test and models -----------------------------------------------------------

  function codeText(d) {
    var p = presetNow();
    var code = d && typeof d.code === 'string' ? d.code : '';
    var s = (code === 'key_rejected' && p.rejected) || (code && has(TEST, code) && code !== 'ok' && TEST[code]) || (code && has(ERR, code) && ERR[code]) || '';
    if (!s) return T.failed;
    return fill(s, { provider: p.label, host: str(d.host) || p.label, status: d.status != null ? d.status : '?' });
  }

  function runTest() {
    if (st.busy) return;
    resetTest();
    var seq = st.seq;
    st.busy = true;
    ui.test.disabled = true;
    call('POST', '/api/providers/test', form()).then(function (r) {
      st.busy = false;
      ui.test.disabled = false;
      if (seq !== st.seq) return;
      var d = r.data;
      if (!d || typeof d.ok !== 'boolean') { ui.testLine.textContent = T.failed; return updateSave(); }
      var models = Array.isArray(d.models) ? d.models.filter(function (m) { return typeof m === 'string'; }) : [];
      if (d.ok) {
        st.testOk = true;
        // No model list from this provider: the choices are Crow's picks for it.
        ui.testLine.textContent = d.noListing === true ? T.okNoList : fill(TEST.ok, { n: models.length });
        renderModels(models, Array.isArray(d.recommended) ? d.recommended : [], d.truncated === true);
      } else {
        ui.testLine.textContent = codeText(d);
        // A server with no listing can still be saved with a typed model name.
        if (presetNow().id === 'other' && d.code === 'not_found') { st.typedOnly = true; renderModels([], [], false); }
      }
      updateSave();
    });
  }

  function addModel(id, ticked, star) {
    var lab = el('label', 'mc-check');
    var cb = el('input');
    cb.type = 'checkbox';
    cb.setAttribute('data-ap-model', id);
    cb.checked = !!ticked;
    cb.addEventListener('change', updateSave);
    lab.appendChild(cb);
    lab.appendChild(el('span', 'ap-model-id', id));
    if (star) {
      var s = el('span', 'mc-star', '★');
      s.setAttribute('title', T.recommended);
      s.setAttribute('aria-label', T.recommended);
      lab.appendChild(s);
    }
    cb.row = lab;
    st.models.push(cb);
    ui.list.appendChild(lab);
    return cb;
  }

  function renderModels(models, rec, truncated) {
    ui.list.textContent = '';
    st.models = [];
    var recSet = {};
    rec.forEach(function (id) { if (typeof id === 'string') recSet[id] = true; });
    var first = models.filter(function (m) { return has(recSet, m); });
    var rest = models.filter(function (m) { return !has(recSet, m); });
    first.forEach(function (m) { addModel(m, true, true); });
    rest.forEach(function (m) { addModel(m, false, false); });
    ui.filter.hidden = models.length <= 20;
    ui.truncated.hidden = !truncated;
    if (truncated) ui.truncated.textContent = fill(T.truncated, { n: models.length });
    ui.modelsBox.hidden = false;
  }

  function ticked() {
    return st.models.filter(function (cb) { return cb.checked; }).map(function (cb) { return cb.getAttribute('data-ap-model'); });
  }

  function updateSave() {
    ui.save.disabled = !!st.busy || !!st.providerId || !(st.testOk || st.typedOnly) || !ticked().length;
  }

  function applyFilter() {
    var f = String(ui.filter.value || '').trim().toLowerCase();
    st.models.forEach(function (cb) {
      cb.row.hidden = !!f && String(cb.getAttribute('data-ap-model')).toLowerCase().indexOf(f) === -1;
    });
  }

  function addTyped() {
    var id = String(ui.typeName.value || '').trim();
    if (!id) return;
    var found = st.models.filter(function (cb) { return cb.getAttribute('data-ap-model') === id; })[0];
    if (found) found.checked = true;
    else addModel(id, true, false);
    ui.typeName.value = '';
    updateSave();
  }

  function save() {
    if (ui.save.disabled || st.busy) return;
    var body = form();
    body.modelIds = ticked();
    st.busy = true;
    updateSave();
    ui.saveLine.textContent = '';
    var seq = st.seq;
    call('POST', '/api/providers', body).then(function (r) {
      st.busy = false;
      if (seq !== st.seq) return updateSave();
      var d = r.data;
      if (r.ok && d && d.ok === true && typeof d.providerId === 'string') {
        st.providerId = d.providerId;
        st.changed = true;
        ui.key.value = '';
        ui.saveLine.textContent = T.saved;
        updateSave();
        ui.picksBox.hidden = false;
        return loadPlan();
      }
      ui.saveLine.textContent = d ? codeText(d) : T.failed;
      updateSave();
    });
  }

  // --- picks, probe, recommended ---------------------------------------------------------

  function base() { return '/api/providers/' + encodeURIComponent(st.providerId); }

  function loadPlan() {
    var seq = st.seq;
    return call('GET', base() + '/plan').then(function (r) {
      if (seq !== st.seq) return;
      if (!r.ok || !r.data) { ui.error.textContent = T.failed; return; }
      renderPlan(r.data);
    });
  }

  function statusText(p) {
    if (!p.check || typeof p.check !== 'object') return T.notTested;
    // A busy or unreachable server says nothing about the model (L2).
    if (p.check.retryable === true) return T.notTested + ' · ' + fill(T.tryLater, { code: str(p.check.code) });
    var d = dateOf(p.check.at);
    var when = d ? ' · ' + fill(T.checkedOn, { date: d }) : '';
    return (p.check.ok === true ? T.passed : T.probeFailed) + when;
  }

  function renderPlan(d) {
    st.plan = d;
    st.labels = {};
    ui.picks.textContent = '';
    var picks = Array.isArray(d.picks) ? d.picks : [];
    picks.forEach(function (p) {
      if (!p || typeof p.roleId !== 'string') return;
      var label = str(p.label) || str(p.modelId);
      if (typeof p.key === 'string') st.labels[p.key] = label;
      var row = el('div', 'ap-pick');
      row.setAttribute('data-ap-pick', p.roleId);
      row.appendChild(el('span', 'ap-pick-role', roleName(p.roleId)));
      row.appendChild(el('span', 'ap-pick-label', label));
      if (str(p.providerLabel)) row.appendChild(el('span', 'mc-pick-provider', str(p.providerLabel)));
      row.appendChild(el('span', 'ap-pick-status', statusText(p)));
      if (p.probed === false) row.appendChild(el('span', 'ap-why', T.rerankNote));
      ui.picks.appendChild(row);
    });
    if (!picks.length) ui.picks.appendChild(el('p', 'ap-note', T.noPicks));
    ui.stale.hidden = d.stale !== true;
    ui.probe.hidden = !picks.some(function (p) { return p && p.probed !== false; });
    renderRec(d);
  }

  function keyLabel(key) {
    if (has(st.labels, key)) return st.labels[key];
    var k = str(key);
    var i = k.indexOf('/');
    return i > 0 ? k.slice(i + 1) : k;
  }

  function renderRec(d, changed) {
    ui.recList.textContent = '';
    ui.skipList.textContent = '';
    ui.warn.textContent = '';
    ui.result.textContent = '';
    st.recBoxes = [];
    st.pv = null;
    st.ackU = false;
    var add = function (x, on) {
      if (!x || typeof x.roleId !== 'string') return;
      var lab = el('label', 'mc-check');
      var cb = el('input');
      cb.type = 'checkbox';
      cb.setAttribute('data-ap-rec', x.roleId);
      cb.checked = !!on;
      cb.addEventListener('change', function () { refreshPreview(false); });
      lab.appendChild(cb);
      var text = el('span', null, roleName(x.roleId) + ': ' + keyLabel(x.key));
      var cur = x.current && (str(x.current.label) || str(x.current.key));
      if (!on) {
        var why = x.why === 'runs_today' && cur ? '' : (has(WHY, x.why) ? WHY[x.why] : '');
        if (why) text.appendChild(el('span', 'ap-why', why));
        if (cur) text.appendChild(el('span', 'ap-why', fill(T.runsToday, { model: cur })));
      }
      lab.appendChild(text);
      ui.recList.appendChild(lab);
      st.recBoxes.push(cb);
    };
    (Array.isArray(d.apply) ? d.apply : []).forEach(function (x) { add(x, true); });
    (Array.isArray(d.optIn) ? d.optIn : []).forEach(function (x) { add(x, false); });
    (Array.isArray(d.skipped) ? d.skipped : []).forEach(function (x) {
      if (!x || typeof x.roleId !== 'string') return;
      ui.skipList.appendChild(el('p', 'ap-note', roleName(x.roleId) + ': ' + (has(SKIP, x.why) ? SKIP[x.why] : SKIP.unknown)));
    });
    ui.recBox.hidden = !st.recBoxes.length && !ui.skipList.children.length;
    refreshPreview(!!changed);
  }

  /** A 409 that carries the fresh plan: show what is offered now, and say something changed. */
  function freshPlanOf(d) {
    var p = d && d.plan;
    return p && typeof p === 'object' && Array.isArray(p.apply) ? p : null;
  }
  function showFresh(p) {
    // Never loop: a plan that keeps moving under the sheet stops at the generic line.
    st.fresh = (st.fresh || 0) + 1;
    if (st.fresh > 3) { ui.error.textContent = T.failed; return; }
    if (st.plan) { st.plan.apply = p.apply; st.plan.optIn = p.optIn; st.plan.skipped = p.skipped; }
    renderRec(p, true);
  }

  function chosenRoles() {
    return (st.recBoxes || []).filter(function (cb) { return cb.checked; }).map(function (cb) { return cb.getAttribute('data-ap-rec'); });
  }

  function updateApply() {
    var needs = (st.pv && st.pv.needs) || {};
    ui.apply.disabled = !st.pv || !!st.busy || !chosenRoles().length || (!!needs.ackUnattended && st.ackU !== true);
  }

  function refreshPreview(changed) {
    st.seq++;
    var seq = st.seq;
    st.pv = null;
    st.ackU = false;
    ui.warn.textContent = '';
    updateApply();
    var roles = chosenRoles();
    if (!roles.length) { if (changed) ui.warn.appendChild(el('p', 'mc-changed', T.changed)); return; }
    call('POST', base() + '/recommended/preview', { roles: roles }).then(function (r) {
      if (seq !== st.seq) return;
      if (r.status === 409 && freshPlanOf(r.data)) return showFresh(freshPlanOf(r.data));
      if (!r.ok || !r.data || typeof r.data.previewHash !== 'string') { ui.error.textContent = T.failed; return; }
      renderWarn(r.data, roles, changed);
    });
  }

  function line(cls, text) { var p = el('p', cls, text); ui.warn.appendChild(p); return p; }

  function renderWarn(pv, roles, changed) {
    st.fresh = 0;
    st.pv = pv;
    st.pvRoles = roles;
    ui.warn.textContent = '';
    if (changed) line('mc-changed', T.changed);
    var cons = pv.consumers || {};
    var shown = GROUPS.filter(function (g) { return Array.isArray(cons[g[0]]) && cons[g[0]].length; });
    if (shown.length) {
      line('mc-changes', T.changes);
      shown.forEach(function (g) {
        ui.warn.appendChild(el('h3', 'mc-group', g[1]));
        var ul = el('ul', 'mc-names');
        var seen = {};
        cons[g[0]].forEach(function (c) {
          var n = nameOf(c);
          if (!n || has(seen, n)) return;
          seen[n] = true;
          ul.appendChild(el('li', null, n));
        });
        ui.warn.appendChild(ul);
      });
    }
    var clouds = Array.isArray(pv.clouds) ? pv.clouds : (pv.cloud ? [pv.cloud] : []);
    var hosts = {};
    clouds.forEach(function (c) {
      var h = (c && str(c.host)) || T.cloudWhere;
      if (has(hosts, h)) return;
      hosts[h] = true;
      line('mc-cloud', fill(T.cloud, { host: h }));
    });
    (Array.isArray(pv.refused) ? pv.refused : []).forEach(function (x) { line('mc-refused', fill(T.refused, { consumer: nameOf(x) })); });
    if (pv.reembed === true) line('mc-reembed', T.reembed);
    if (pv.needs && pv.needs.ackUnattended) {
      var lab = el('label', 'mc-check');
      var cb = el('input');
      cb.type = 'checkbox';
      cb.setAttribute('data-ap-ack', 'unattended');
      cb.addEventListener('change', function (e) { st.ackU = !!((e && e.target) || cb).checked; updateApply(); });
      lab.appendChild(cb);
      lab.appendChild(el('span', null, T.ackUnattended));
      ui.warn.appendChild(lab);
    }
    updateApply();
  }

  function applyRec() {
    var pv = st.pv;
    if (!pv || ui.apply.disabled || st.busy) return;
    var needs = pv.needs || {};
    var body = {
      roles: (st.pvRoles || []).slice(),
      previewHash: pv.previewHash,
      ackUnattended: !!needs.ackUnattended && st.ackU === true,
      // The cloud sentence is on screen above the button that sends this.
      ackCloud: !!needs.ackCloud
    };
    st.busy = true;
    updateApply();
    ui.result.textContent = '';
    var seq = st.seq;
    call('POST', base() + '/recommended', body).then(function (r) {
      st.busy = false;
      if (seq !== st.seq) return;
      var d = r.data;
      if (r.status === 409) return freshPlanOf(d) ? showFresh(freshPlanOf(d)) : refreshPreview(true);
      if (!d || !Array.isArray(d.applied)) { ui.error.textContent = T.failed; return updateApply(); }
      if (d.applied.length) st.changed = true;
      var parts = [];
      (Array.isArray(d.refused) ? d.refused : []).forEach(function (x) {
        if (x && typeof x.roleId === 'string') parts.push(fill(T.notChanged, { role: roleName(x.roleId) }));
      });
      var empty = Array.isArray(d.stillEmpty) ? d.stillEmpty.filter(function (x) { return typeof x === 'string'; }) : [];
      parts.push(empty.length ? fill(T.stillEmpty, { roles: empty.map(roleName).join(', ') }) : T.allSet);
      var text = parts.join(' ');
      ui.result.textContent = text;
      st.pv = null;
      updateApply();
      // Read the plan again so the list shows only what is still offered; keep the result line.
      if (d.applied.length) {
        var again = loadPlan();
        if (again && typeof again.then === 'function') again.then(function () { ui.result.textContent = text; });
      }
    });
  }

  function probe() {
    if (!st.providerId || st.busy) return;
    st.busy = true;
    ui.probe.disabled = true;
    var seq = st.seq;
    call('POST', base() + '/probe', {}).then(function (r) {
      st.busy = false;
      ui.probe.disabled = false;
      if (seq !== st.seq) return;
      if (!r.ok || !r.data) { ui.error.textContent = T.failed; return; }
      loadPlan();
    });
  }

  ui.preset.addEventListener('change', syncPreset);
  if (ui.variant) ui.variant.addEventListener('change', resetTest);
  if (ui.url) ui.url.addEventListener('input', resetTest);
  ui.key.addEventListener('input', function () { if (!st.providerId) resetTest(); });
  ui.test.addEventListener('click', runTest);
  ui.filter.addEventListener('input', applyFilter);
  ui.addName.addEventListener('click', addTyped);
  ui.save.addEventListener('click', save);
  ui.probe.addEventListener('click', probe);
  ui.apply.addEventListener('click', applyRec);
  ui.close.addEventListener('click', closeSheet);
  ui.done.addEventListener('click', closeSheet);
  dlg.addEventListener('click', function (e) { if (e && e.target === dlg) closeSheet(); });
  // Escape closes a modal dialog natively, without the buttons: the same cleanup.
  dlg.addEventListener('close', onClosed);
  var openers = document.querySelectorAll('[data-models-add]');
  for (var i = 0; i < openers.length; i++) openers[i].addEventListener('click', openSheet);
  if (dlg.getAttribute('data-open') === '1') openSheet();
  if (!window.__crowAddProviderCacheBound) {
    window.__crowAddProviderCacheBound = true;
    document.addEventListener('turbo:before-cache', function () {
      var d = document.getElementById('models-add');
      if (!d) return;
      var k = d.querySelector('[data-ap="key"]');
      if (k) k.value = '';
      if (typeof d.close === 'function' && d.open) d.close();
    });
  }
})();
`;
}

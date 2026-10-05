/**
 * Crow's Nest panel — Kiosk displays: pair (code approval), bind an assistant,
 * per-display voice + settings, unpair, latency diagnostics.
 * All user data is rendered with textContent. CLIENT_SCRIPT has NO backticks
 * and NO "${" (it sits inside a template literal; tests/kiosk-panel.test.js).
 */
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE_DIR = [
  join(process.env.CROW_HOME || join(homedir(), ".crow"), "bundles", "kiosk"),
  process.env.CROW_APP_ROOT ? join(process.env.CROW_APP_ROOT, "bundles", "kiosk") : null,
  resolve(here, ".."),
].filter(Boolean).find((p) => existsSync(join(p, "server", "strings.js")));
const { STRINGS } = await import(pathToFileURL(join(BUNDLE_DIR, "server", "strings.js")).href);

export const CLIENT_SCRIPT = `
(function () {
  if (window.__kkRefresh) { clearInterval(window.__kkRefresh); window.__kkRefresh = null; }
  var S = JSON.parse(document.getElementById('kk-strings').textContent);
  var root = document.getElementById('kk-root');
  if (!root) return;
  function fill(s, o) { return String(s).replace(/\\{(\\w+)\\}/g, function (m, k) { return o && o[k] != null ? String(o[k]) : m; }); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function opt(sel, value, label, selected) { var o = el('option', null, label); o.value = value; if (selected) o.selected = true; sel.appendChild(o); }
  function api(method, path, body) {
    return fetch(path, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.__status = r.status; return j; }); });
  }
  var state = null;
  /** A select whose current value may be missing from the options: then a blank "(not set)" stays selected, never the first option. */
  function pick(options, current) {
    var sel = el('select');
    var known = options.some(function (o) { return o[0] === current; });
    if (!known) opt(sel, '', S.not_set, true);
    options.forEach(function (o) { opt(sel, o[0], o[1], o[0] === current); });
    return sel;
  }
  /** An assistant's fit on the quick voice model: 'full' | 'no_skills' | 'too_large' | null (unknown), by the display's memory setting. */
  function fitOf(b, memOn) { return b ? (memOn ? b.fit_memory : b.fit) : null; }
  function botLabel(b, memOn) {
    var lv = fitOf(b, memOn), name = b.display_name || b.bot_id;
    return lv === 'too_large' ? name + ' — ' + S.fit_tag_too_large : lv === 'no_skills' ? name + ' — ' + S.fit_tag_no_skills : name;
  }
  /** The status line under an assistant picker. It follows the selection, so the warning shows BEFORE Pair/Save. */
  function fitLine(bots, sel, memOn) {
    var p = el('p', 'kk-fit');
    function show() {
      var b = null;
      bots.forEach(function (x) { if (x.bot_id === sel.value) b = x; });
      var lv = fitOf(b, memOn());
      p.className = 'kk-fit' + (lv === 'too_large' ? ' kk-fit-bad' : lv === 'no_skills' ? ' kk-fit-warn' : '');
      p.textContent = lv ? S['fit_' + lv] : '';
    }
    sel.addEventListener('change', show);
    show();
    return { node: p, show: show };
  }
  /** Only what changed is sent: an untouched (or unset) field is never rebound by Save. */
  function savePatch(a, b) {
    var p = {}, any = false;
    if (b.bot !== a.bot && b.bot) { p.bound_bot_id = b.bot; any = true; }
    if (b.stt !== a.stt) { p.stt_profile_id = b.stt; any = true; }
    if (b.tts !== a.tts) { p.tts_profile_id = b.tts; any = true; }
    if (b.fu !== a.fu || b.mem !== a.mem || b.vad !== a.vad || b.sm !== a.sm) {
      p.kiosk_settings = { follow_up: b.fu, memory_integration: b.mem };
      if (b.vad !== a.vad) p.kiosk_settings.vad_hangover_ms = b.vad;
      if (b.sm !== a.sm) p.kiosk_settings.stt_model = b.sm;
      any = true;
    }
    return any ? p : null;
  }

  function renderPair(data) {
    var box = document.getElementById('kk-pair'); clear(box);
    box.appendChild(el('h2', null, S.pair_title));
    box.appendChild(el('p', 'kk-dim', S.pair_steps));
    var pend = el('div', 'kk-pending');
    pend.appendChild(el('h3', null, S.pending_requests));
    if (!data.pending.length) pend.appendChild(el('p', 'kk-dim', S.no_pending));
    data.pending.forEach(function (p) {
      var row = el('p', 'kk-req');
      row.appendChild(el('strong', null, p.name_hint || '?'));
      row.appendChild(document.createTextNode(' — ' + fill(S.requester, { ip: p.ip }) + (p.login ? ' (' + p.login + ')' : '') + ' — ' + (p.ua || '').slice(0, 80)));
      pend.appendChild(row);
    });
    box.appendChild(pend);
    var form = el('form', 'kk-form');
    var code = el('input'); code.name = 'code'; code.inputMode = 'numeric'; code.autocomplete = 'off'; code.placeholder = '123 456'; code.required = true;
    var name = el('input'); name.name = 'name'; name.placeholder = S.name; name.maxLength = 64;
    var bot = el('select'); bot.name = 'bot_id'; opt(bot, '', '— ' + S.bot + ' —', true);
    data.bots.forEach(function (b) { opt(bot, b.bot_id, botLabel(b, false), false); });
    var fit = fitLine(data.bots, bot, function () { return false; });   // a new display starts with memories off
    var go = el('button', 'btn btn-primary', S.approve); go.type = 'submit';
    var msg = el('p', 'kk-msg');
    [[S.code, code], [S.name, name], [S.bot, bot]].forEach(function (pair) { var l = el('label', null, pair[0]); l.appendChild(pair[1]); form.appendChild(l); });
    form.appendChild(fit.node); form.appendChild(go); form.appendChild(msg);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (!bot.value) { msg.textContent = S.bot_required; return; }
      api('POST', '/api/kiosk/admin/approve', { code: code.value.replace(/\\s+/g, ''), name: name.value, bot_id: bot.value }).then(function (j) {
        if (j.ok) { code.value = ''; name.value = ''; msg.textContent = S.saved; load(); return; }
        msg.textContent = j.error === 'locked' ? fill(S.locked, { s: j.retry_after_s }) : (S[j.error] || j.error || '');
      });
    });
    box.appendChild(form);
    box.appendChild(el('p', 'kk-hint', S.household_hint));
    if (!data.tts_profiles.some(function (p) { return p.provider === 'kokoro'; })) box.appendChild(el('p', 'kk-warn', S.tts_missing));
  }

  /** Which assistant answers the dashboard's own Talk to Crow (no display, no pairing). */
  function renderDash(data) {
    var box = document.getElementById('kk-dash'); if (!box) return;
    clear(box);
    var dv = data.dashboard_voice;
    box.hidden = !(dv && dv.available);
    if (box.hidden) return;
    box.appendChild(el('h2', null, S.dash_voice_title));
    box.appendChild(el('p', 'kk-dim', S.dash_voice_intro));
    if (!data.bots.length) { box.appendChild(el('p', 'kk-warn', S.dash_voice_none)); return; }
    var sel = el('select'); opt(sel, '', S.dash_voice_auto, !dv.bot_id);
    data.bots.forEach(function (b) { opt(sel, b.bot_id, botLabel(b, false), b.bot_id === dv.bot_id); });
    var l = el('label', null, S.bot); l.appendChild(sel); box.appendChild(l);
    box.appendChild(fitLine(data.bots, sel, function () { return false; }).node);   // same status as the display pickers
    var now = el('p', 'kk-dim'), msg = el('span', 'kk-msg');
    function showNow() {
      var hit = data.bots.filter(function (b) { return b.bot_id === dv.effective_bot_id; })[0];
      now.className = hit ? 'kk-dim' : 'kk-warn';
      now.textContent = hit ? fill(S.dash_voice_now, { name: hit.display_name || hit.bot_id }) : S.dash_voice_none_fit;   // assistants exist, none fits
    }
    showNow();
    sel.addEventListener('change', function () {
      api('POST', '/api/kiosk/admin/dashboard-voice', { bot_id: sel.value }).then(function (j) {
        if (!j.ok) { msg.textContent = S[j.error] || j.error || ''; return; }
        dv.bot_id = j.bot_id; dv.effective_bot_id = j.effective_bot_id; showNow(); msg.textContent = S.saved;
      });
    });
    box.appendChild(now); box.appendChild(msg);
  }

  function renderDevice(d, data) {
    var card = el('section', 'kk-card');
    var head = el('h3', null, d.name);
    head.appendChild(el('span', d.connected ? 'kk-on' : 'kk-off', d.connected ? S.connected : S.offline));
    card.appendChild(head);
    card.appendChild(el('p', 'kk-dim', d.last_seen ? fill(S.last_seen, { when: new Date(d.last_seen).toLocaleString() }) : S.never_seen));
    var lat = d.latency || {};
    card.appendChild(el('p', 'kk-lat', lat.n ? fill(S.latency, { median: lat.median_ms == null ? '>' + 3000 : lat.median_ms, p90: lat.p90_ms == null ? '>' + 3000 : lat.p90_ms, n: lat.n }) + (lat.no_audio ? ' · ' + lat.no_audio + ' ✗' : '') : S.no_latency));   // Infinity serializes as null
    var memSaved = !!(d.kiosk_settings || {}).memory_integration;
    var bot = pick(data.bots.map(function (b) { return [b.bot_id, botLabel(b, memSaved)]; }), d.bound_bot_id);
    var stt = pick(data.stt_profiles.map(function (p) { return [p.id, p.name]; }), d.stt_profile_id);
    var tts = pick(data.tts_profiles.map(function (p) { return [p.id, p.name]; }), d.tts_profile_id);
    var ks = d.kiosk_settings || {};
    var fu = el('input'); fu.type = 'checkbox'; fu.checked = !!ks.follow_up;
    var mem = el('input'); mem.type = 'checkbox'; mem.checked = !!ks.memory_integration;
    var sm = pick([['default', S.stt_model_default], ['tiny.en', S.stt_model_tiny]], ks.stt_model || 'default');
    var vad = el('input'); vad.type = 'number'; vad.min = '300'; vad.max = '900'; vad.step = '50'; vad.value = String(ks.vad_hangover_ms || 450);
    function vadValue() { var n = parseInt(vad.value, 10); return isFinite(n) ? Math.min(900, Math.max(300, n)) : (initial ? initial.vad : (ks.vad_hangover_ms || 450)); }
    function current() { return { bot: bot.value, stt: stt.value, tts: tts.value, fu: fu.checked, mem: mem.checked, vad: vadValue(), sm: sm.value }; }
    var initial = null;
    initial = current();
    var fit = fitLine(data.bots, bot, function () { return mem.checked; });
    mem.addEventListener('change', fit.show);
    [[S.bot, bot], [S.stt, stt], [S.stt_model, sm], [S.tts, tts], [S.vad_wait, vad], [S.follow_up, fu], [S.memory, mem]].forEach(function (pair) { var l = el('label', null, pair[0]); l.appendChild(pair[1]); card.appendChild(l); if (pair[1] === bot) card.appendChild(fit.node); });
    card.appendChild(el('p', 'kk-dim', S.vad_wait_hint));
    card.appendChild(el('p', 'kk-dim', S.memory_warn + ' ' + S.memory_hint));
    var msg = el('span', 'kk-msg');
    var save = el('button', 'btn btn-primary btn-sm', S.save); save.type = 'button';
    save.addEventListener('click', function () {
      var patch = savePatch(initial, current());
      if (!patch) { msg.textContent = S.saved; return; }
      api('POST', '/api/kiosk/admin/displays/' + encodeURIComponent(d.id), patch)
        .then(function (j) {
          if (j.ok) { initial = current(); vad.value = String(initial.vad); msg.textContent = S.saved; return; }
          msg.textContent = S[j.error] || j.error || '';
        });
    });
    var unpair = el('button', 'btn btn-secondary btn-sm', S.unpair); unpair.type = 'button';
    unpair.addEventListener('click', function () {
      if (!window.confirm(fill(S.unpair_confirm, { name: d.name }))) return;
      api('DELETE', '/api/kiosk/admin/displays/' + encodeURIComponent(d.id)).then(load);
    });
    var diagBtn = el('button', 'btn btn-secondary btn-sm', S.diagnostics); diagBtn.type = 'button';
    var diag = el('div', 'kk-diag');
    diagBtn.addEventListener('click', function () {
      api('GET', '/api/kiosk/admin/displays/' + encodeURIComponent(d.id) + '/metrics').then(function (j) {
        clear(diag);
        diag.appendChild(el('p', 'kk-dim', S.diag_cols));
        (j.turns || []).slice(0, 20).forEach(function (t) {
          var tm = t.timings || {};
          diag.appendChild(el('p', 'kk-row', [new Date(t.at).toLocaleTimeString(), t.e2e_ms == null ? (t.barged ? S.turn_barged : S.diag_failed) : t.e2e_ms, tm.stt_ms == null ? '—' : tm.stt_ms + (tm.stt_early === 'used' ? ' (early ' + tm.stt_early_ms + ')' : ''), tm.llm_first_token_ms == null ? '—' : tm.llm_first_token_ms, tm.tts_first_chunk_ms == null ? '—' : tm.tts_first_chunk_ms, (t.fast_path ? 'fast-path' : (t.route || '?')) + (t.degraded ? ' (' + t.degraded + ')' : '') + (t.vad_reason ? ' · ' + t.vad_reason : '') + (tm.prompt_fit ? ' · ' + tm.prompt_fit : '') + (t.failed ? ' · ✗ ' + t.failed : '')].join(' · ')));
        });
      });
    });
    var bar = el('div', 'kk-bar'); [save, diagBtn, unpair, msg].forEach(function (n) { bar.appendChild(n); });
    card.appendChild(bar); card.appendChild(diag);
    return card;
  }

  function render(data) {
    state = data;
    renderPair(data);
    renderDash(data);
    var list = document.getElementById('kk-devices'); clear(list);
    list.appendChild(el('h2', null, S.displays));
    if (!data.devices.length) list.appendChild(el('p', 'kk-dim', S.no_displays));
    data.devices.forEach(function (d) { list.appendChild(renderDevice(d, data)); });
  }
  function load() { return api('GET', '/api/kiosk/admin/displays').then(function (j) { if (j.devices) render(j); }); }
  function refreshPending() {
    if (!document.getElementById('kk-root') || document.hidden) return;
    api('GET', '/api/kiosk/admin/displays').then(function (j) {
      if (!j.devices || !state) return;
      var changed = JSON.stringify(j.pending) !== JSON.stringify(state.pending) || j.devices.length !== state.devices.length;
      if (changed && !document.activeElement.closest('#kk-root form, #kk-root section, #kk-dash')) render(j);
      else state = j;
    });
  }
  load();
  window.__kkRefresh = setInterval(refreshPending, 5000);
})();
`;

const STYLES = `
  .kk-wrap { max-width: 880px; }
  .kk-dim, .kk-hint { color: var(--crow-text-secondary); }
  .kk-warn { color: var(--crow-warning); }
  .kk-fit { margin: 0 0 6px; font-size: .9rem; color: var(--crow-text-secondary); }
  .kk-fit:empty { display: none; }
  .kk-fit-warn { color: var(--crow-warning); }
  .kk-fit-bad { color: var(--crow-error); font-weight: 600; }
  .kk-fit-bad::before { content: "\\26A0  "; }
  .kk-card { border: 1px solid var(--crow-border); border-radius: 14px; padding: 12px 16px; margin: 12px 0; background: var(--crow-bg-surface); }
  .kk-card h3 { display: flex; gap: 12px; align-items: baseline; margin: 0 0 4px; }
  .kk-on { color: var(--crow-success); font-size: .85rem; } .kk-off { color: var(--crow-text-muted); font-size: .85rem; }
  .kk-card label, .kk-form label { display: flex; gap: 8px; align-items: center; margin: 6px 0; }
  .kk-bar { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  .kk-form { display: grid; gap: 4px; max-width: 420px; }
  .kk-form input[name=code] { font-size: 1.4rem; letter-spacing: .15em; width: 9ch; }
  .kk-row { font-family: ui-monospace, monospace; font-size: .8rem; margin: 2px 0; }
`;

export default {
  id: "kiosk",
  name: "Kiosk",
  icon: "monitor",
  route: "/dashboard/kiosk",
  navOrder: 56,
  category: "hardware",
  // The dashboard header offers "Talk to Crow" only when the installed panel says its
  // routes serve the session display (/display/session); an older copy does not.
  sessionDisplay: true,
  async handler(req, res, { layout, lang }) {
    const L = STRINGS[lang] ? lang : "en";
    const S = STRINGS[L];
    const json = JSON.stringify(S).replace(/</g, "\\u003c");
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const content = `
      <style>${STYLES}</style>
      <div id="kk-root" class="kk-wrap">
        <h1>${esc(S.panel_title)}</h1>
        <p class="kk-dim">${esc(S.panel_intro)}</p>
        <div id="kk-pair" class="kk-card"></div>
        <div id="kk-dash" class="kk-card" hidden></div>
        <div id="kk-devices"></div>
      </div>
      <script type="application/json" id="kk-strings">${json}</script>
      <script>${CLIENT_SCRIPT}<\/script>`;
    res.send(layout({ title: S.panel_title, content }));
  },
};

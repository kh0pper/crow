/**
 * Project home client: "change" shows the bot pick (for this session only),
 * and "Start a session" POSTs /dashboard/perch-api/bots/<id>/interactive with
 * { project_id } and the dashboard CSRF token (X-Crow-Csrf), then goes to
 * /dashboard/perch?project=<slug>#<sessionId>.
 *
 * Returned as a <script> string, so it is a TEMPLATE LITERAL: it must contain
 * NO backticks and no dollar-brace sequences other than the tJs strings below.
 * It re-runs on every Turbo visit and binds only to this page's elements.
 */
import { tJs } from "../../shared/i18n.js";

export function projectHomeClientJs(lang) {
  return `<script>
(function () {
  var root = document.querySelector('[data-ph]');
  if (!root) return;
  var btn = root.querySelector('[data-ph-start]');
  if (!btn) return;
  var T_FAILED = '${tJs("perch.startFailed", lang)}';
  var T_ENGINE = '${tJs("perch.engineRequired", lang)}';
  var T_NOT_ATTACHED = '${tJs("perch.notAttached", lang)}';
  var sel = root.querySelector('[data-ph-bot]');
  var pick = root.querySelector('.ph-pick');
  var change = root.querySelector('[data-ph-change]');
  var nameEl = root.querySelector('[data-ph-lead-name]');
  var status = root.querySelector('[data-ph-status]');
  var pid = Number(root.getAttribute('data-project-id'));
  var slug = root.getAttribute('data-project-slug') || '';
  var busy = false;

  function csrf() {
    var parts = document.cookie.split(';');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim().split('=');
      if (kv[0] === 'crow_csrf') return decodeURIComponent(kv.slice(1).join('='));
    }
    return '';
  }
  function say(text) { if (status) status.textContent = text || ''; }
  function fail(text) { busy = false; btn.removeAttribute('disabled'); say(text); }

  if (change && pick) change.addEventListener('click', function () {
    var show = pick.hasAttribute('hidden');
    if (show) pick.removeAttribute('hidden'); else pick.setAttribute('hidden', '');
    change.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show && sel) sel.focus();
  });
  if (sel) sel.addEventListener('change', function () {
    var o = sel.options[sel.selectedIndex];
    if (!o) return;
    btn.setAttribute('data-bot', o.value);
    if (nameEl) nameEl.textContent = o.textContent;
  });

  btn.addEventListener('click', function () {
    if (busy) return;
    busy = true; btn.setAttribute('disabled', ''); say('');
    fetch('/dashboard/perch-api/bots/' + encodeURIComponent(btn.getAttribute('data-bot')) + '/interactive', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Crow-Csrf': csrf() },
      body: JSON.stringify({ project_id: pid })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, j: j }; });
    }).then(function (x) {
      var sid = x.j && (x.j.sessionId || x.j.threadId);
      if (x.status >= 200 && x.status < 300 && sid) { location.href = '/dashboard/perch?project=' + encodeURIComponent(slug) + '#' + encodeURIComponent(sid); return; }
      var err = x.j && x.j.error;
      fail(err === 'engine_required' ? T_ENGINE : err === 'perch_not_attached' ? T_NOT_ATTACHED : T_FAILED);
    }, function () { fail(T_FAILED); });
  });
})();
</script>`;
}

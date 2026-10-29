/**
 * The project Services page client (Task 10: the row menu). Test again POSTs
 * /dashboard/services/api/connection/<uuid>/test, Disconnect asks first (the row's data-confirm,
 * escaped server-side) and POSTs .../disconnect; both send the dashboard CSRF token
 * (X-Crow-Csrf, from the crow_csrf cookie) and then re-render the page from the server, so the
 * pill and "Tested ..." always show the stored state. Opening one row's menu closes the others.
 * The + Add buttons ([data-svc-add]) are wired by the Add sheet.
 *
 * Returned as a <script> string, so it is a TEMPLATE LITERAL: it must contain NO backticks and
 * no dollar-brace sequences. No service-supplied string is written into the page here.
 * It re-runs on every Turbo visit and binds only to this page's elements.
 */

export function projectServicesClientJs() {
  return `<script>
(function () {
  var root = document.querySelector('[data-svc]');
  if (!root || root.getAttribute('data-svc-bound')) return;
  root.setAttribute('data-svc-bound', '1');
  var API = '/dashboard/services/api/connection/';
  var busy = false;

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
  function setBusy(row, on) {
    busy = on;
    var items = row.querySelectorAll('.svc-menu-item');
    for (var i = 0; i < items.length; i++) {
      if (on) items[i].setAttribute('disabled', ''); else items[i].removeAttribute('disabled');
    }
  }
  function post(row, action) {
    var uuid = row.getAttribute('data-uuid') || '';
    setBusy(row, true);
    fetch(API + encodeURIComponent(uuid) + '/' + action, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Crow-Csrf': csrf() },
      body: '{}'
    }).then(function (r) {
      // A finished test (passed or failed) and a disconnect both changed the stored state.
      if (r.status === 200 || r.status === 400 || r.status === 404) { reload(); return; }
      setBusy(row, false);
    }, function () { setBusy(row, false); });
  }

  root.addEventListener('toggle', function (e) {
    var d = e.target;
    if (!d || !d.classList || !d.classList.contains('svc-menu') || !d.open) return;
    var all = root.querySelectorAll('.svc-menu[open]');
    for (var i = 0; i < all.length; i++) if (all[i] !== d) all[i].open = false;
  }, true);

  root.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-svc-retest], [data-svc-disconnect]') : null;
    if (!t || busy) return;
    var row = t.closest('[data-svc-row]');
    if (!row) return;
    if (t.hasAttribute('data-svc-retest')) { post(row, 'test'); return; }
    if (window.confirm(t.getAttribute('data-confirm') || '')) post(row, 'disconnect');
  });
})();
</script>`;
}

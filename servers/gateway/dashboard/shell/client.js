/**
 * The new shell's client JS (redesign P2): opens the drawer and the avatar
 * sheet as modal <dialog>s. Escape (native to showModal) and a tap on the
 * backdrop close them, and focus returns to the button that opened them.
 *
 * Emitted inside renderLayout's inline <script>, which is itself built from a
 * template literal: this source must contain NO backticks (the panel
 * client.js rule). It re-runs on every Turbo visit; the dialogs are part of
 * the swapped body, so per-element listeners are bound fresh each time and
 * the one document-level listener is guarded.
 */

export function shellClientJs() {
  return `
    // ─── New shell: drawer + avatar sheet ───
    (function () {
      function readCsrf() {
        var parts = document.cookie.split(';');
        for (var i = 0; i < parts.length; i++) {
          var kv = parts[i].trim().split('=');
          if (kv[0] === 'crow_csrf') return decodeURIComponent(kv.slice(1).join('='));
        }
        return '';
      }
      function openSheet(btn) {
        var dlg = document.getElementById(btn.getAttribute('data-shell-open'));
        if (!dlg || dlg.open) return;
        dlg.__shellOpener = btn;
        var ret = dlg.querySelectorAll('input[name="return"]');
        for (var i = 0; i < ret.length; i++) ret[i].value = location.pathname + location.search;
        if (typeof dlg.showModal === 'function') dlg.showModal();
        else dlg.setAttribute('open', '');
      }
      var openers = document.querySelectorAll('[data-shell-open]');
      for (var i = 0; i < openers.length; i++) {
        openers[i].addEventListener('click', function (e) { openSheet(e.currentTarget); });
      }
      var sheets = document.querySelectorAll('dialog.shell-sheet');
      for (var j = 0; j < sheets.length; j++) {
        var dlg = sheets[j];
        // A click whose target is the dialog element itself landed on the
        // backdrop (the content fills .shell-sheet-inner).
        dlg.addEventListener('click', function (e) {
          if (e.target === e.currentTarget) e.currentTarget.close();
        });
        dlg.addEventListener('close', function (e) {
          var opener = e.currentTarget.__shellOpener;
          e.currentTarget.__shellOpener = null;
          if (opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus();
        });
      }
      // The rail's project form has no opener: fill its return path now.
      var railRet = document.querySelectorAll('.shell-projects--rail input[name="return"]');
      for (var k = 0; k < railRet.length; k++) railRet[k].value = location.pathname + location.search;
      // The Turbo-off path: carry the CSRF token in the body as well.
      if (!window.__crowShellSubmitBound) {
        window.__crowShellSubmitBound = true;
        document.addEventListener('submit', function (e) {
          var form = e.target;
          if (!form || !form.closest || !form.closest('body.shell')) return;
          var field = form.querySelector('input[name="_csrf"]');
          if (field && !field.value) field.value = readCsrf();
        }, true);
      }
    })();
`;
}

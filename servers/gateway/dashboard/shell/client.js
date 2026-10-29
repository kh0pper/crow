/**
 * The new shell's client JS (redesign P2): opens the drawer and the avatar
 * sheet as modal <dialog>s. Escape (native to showModal), a tap on the
 * backdrop and the sheet's own close button close them, and focus returns to
 * the button that opened them. Open sheets are closed before Turbo snapshots
 * the page, so Back never restores a stale open dialog.
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
      // Works for both paths: a modal dialog, and the open-attribute
      // fallback where close() may be missing.
      function closeSheet(dlg) {
        if (!dlg) return;
        if (typeof dlg.close === 'function') { dlg.close(); return; }
        dlg.removeAttribute('open');
        var opener = dlg.__shellOpener;
        dlg.__shellOpener = null;
        if (opener && typeof opener.focus === 'function') opener.focus();
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
          if (e.target === e.currentTarget) closeSheet(e.currentTarget);
        });
        var closeBtn = dlg.querySelector('.shell-sheet-close');
        if (closeBtn) closeBtn.addEventListener('click', function (e) {
          closeSheet(e.currentTarget.closest('dialog'));
        });
        dlg.addEventListener('close', function (e) {
          var opener = e.currentTarget.__shellOpener;
          e.currentTarget.__shellOpener = null;
          // The close event fires a task after close(): if focus has already
          // moved on to something else (a quick keypress, a tap), leave it.
          var a = document.activeElement;
          var parked = !a || a === document.body || a === document.documentElement || e.currentTarget.contains(a);
          if (parked && opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus();
        });
      }
      // The rail's project form has no opener: fill its return path now.
      var railRet = document.querySelectorAll('.shell-projects--rail input[name="return"]');
      for (var k = 0; k < railRet.length; k++) railRet[k].value = location.pathname + location.search;
      // Close open sheets before Turbo caches this page (once per document).
      if (!window.__crowShellCacheBound) {
        window.__crowShellCacheBound = true;
        document.addEventListener('turbo:before-cache', function () {
          var open = document.querySelectorAll('dialog.shell-sheet[open]');
          for (var m = 0; m < open.length; m++) closeSheet(open[m]);
        });
      }
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

    // ─── The apps launcher (R1.2 PR 5): the drawer's Apps grid ───
    // window.CrowApps is shared with the Perch session's apps sheet
    // (perch-hub/client.js): one tile renderer, one open rule.
    (function () {
      var API = '/dashboard/shell-api/apps?project=';
      // A direct-mode app cannot sit behind the subpath proxy: its link is
      // https://<this hostname>:<port><path> (the nest panel's rule).
      function fixDirect(a) {
        var port = a.getAttribute('data-direct-port');
        if (!port || !/^[0-9]{1,5}$/.test(port)) return;
        var path = a.getAttribute('data-direct-path') || '/';
        if (path.charAt(0) !== '/') path = '/' + path;
        a.setAttribute('href', 'https://' + location.hostname + ':' + port + path);
      }
      function tile(x, extra) {
        var a = document.createElement('a');
        var href = String(x.href || '/dashboard/extensions');
        a.className = 'shell-app' + (extra ? ' shell-app--extra' : '');
        a.setAttribute('href', href);
        if (extra) a.setAttribute('data-launcher-tile', String(x.id));
        else {
          a.setAttribute('data-app-id', String(x.id));
          a.setAttribute('data-app-kind', x.kind === 'desktop' ? 'desktop' : 'page');
          if (x.directPort != null) {
            a.setAttribute('data-direct-port', String(x.directPort));
            a.setAttribute('data-direct-path', String(x.path || '/'));
          }
        }
        if (href.indexOf('/dashboard/') !== 0) a.setAttribute('data-turbo', 'false');
        var ic = document.createElement('span');
        ic.className = 'shell-app-icon';
        ic.setAttribute('aria-hidden', 'true');
        // Trusted: the server's app-icons table (a manifest only names a key).
        if (typeof x.icon === 'string') ic.innerHTML = x.icon;
        var lb = document.createElement('span');
        lb.className = 'shell-app-label';
        lb.textContent = String(x.label == null ? x.id : x.label);
        a.appendChild(ic); a.appendChild(lb);
        fixDirect(a);
        return a;
      }
      function note(grid, text) {
        var p = document.createElement('p');
        p.className = 'shell-apps-empty';
        p.textContent = text;
        grid.appendChild(p);
        return p;
      }
      // opts: { empty: text when there are no apps, emptyAction: optional
      // { label, href } link after it }.
      function render(grid, data, opts) {
        opts = opts || {};
        while (grid.firstChild) grid.removeChild(grid.firstChild);
        var apps = data && Array.isArray(data.apps) ? data.apps : [];
        var tiles = data && Array.isArray(data.tiles) ? data.tiles : [];
        for (var i = 0; i < apps.length; i++) grid.appendChild(tile(apps[i], false));
        if (!apps.length && opts.empty) {
          var p = note(grid, opts.empty);
          if (opts.emptyAction) {
            p.appendChild(document.createTextNode(' \u00b7 '));
            var l = document.createElement('a');
            l.setAttribute('href', String(opts.emptyAction.href));
            l.textContent = String(opts.emptyAction.label);
            p.appendChild(l);
          }
        }
        for (var j = 0; j < tiles.length; j++) grid.appendChild(tile(tiles[j], true));
      }
      function load(project) {
        return fetch(API + encodeURIComponent(project || 'all'), { credentials: 'same-origin', headers: { accept: 'application/json' } })
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
      }
      // A desktop app first asks the open session to show it as a tile
      // (crow:open-app-tile; the Perch client calls preventDefault when it
      // does). Unhandled, the link navigates as usual. Returns true when handled.
      function openDesktop(appId) {
        var ev;
        try { ev = new CustomEvent('crow:open-app-tile', { detail: { appId: appId }, cancelable: true }); }
        catch (e) { return false; }
        document.dispatchEvent(ev);
        return ev.defaultPrevented;
      }
      window.CrowApps = { render: render, load: load, openDesktop: openDesktop, fixDirect: fixDirect };

      var direct = document.querySelectorAll('a.shell-app[data-direct-port]');
      for (var d = 0; d < direct.length; d++) fixDirect(direct[d]);

      // The drawer's switch: This project is server-rendered; All loads on the
      // first switch to it, and a failure can be retried by switching again.
      var section = typeof document.querySelector === 'function' ? document.querySelector('#shell-drawer .shell-apps') : null;
      function show(view) {
        if (!section) return;
        var chips = section.querySelectorAll('[data-apps-view]');
        for (var c = 0; c < chips.length; c++) chips[c].setAttribute('aria-pressed', chips[c].getAttribute('data-apps-view') === view ? 'true' : 'false');
        var grids = section.querySelectorAll('[data-apps-grid]');
        var target = null;
        for (var g = 0; g < grids.length; g++) {
          var on = grids[g].getAttribute('data-apps-grid') === view;
          grids[g].hidden = !on;
          if (on) target = grids[g];
        }
        if (!target || target.getAttribute('data-loaded') || target.getAttribute('data-loading')) return;
        target.setAttribute('data-loading', '1');
        while (target.firstChild) target.removeChild(target.firstChild);
        note(target, section.getAttribute('data-apps-loading') || '');
        load('all').then(function (data) {
          target.removeAttribute('data-loading');
          target.setAttribute('data-loaded', '1');
          render(target, data, { empty: section.getAttribute('data-apps-empty-all') || '' });
        }, function () {
          target.removeAttribute('data-loading');
          while (target.firstChild) target.removeChild(target.firstChild);
          note(target, section.getAttribute('data-apps-failed') || '');
        });
      }
      if (section) {
        section.addEventListener('click', function (e) {
          var b = e.target && e.target.closest ? e.target.closest('[data-apps-view],[data-apps-goto]') : null;
          if (!b || !section.contains(b)) return;
          var view = b.getAttribute('data-apps-view') || b.getAttribute('data-apps-goto');
          show(view);
          // The empty line's All apps hides with its grid: focus the chip.
          if (b.hasAttribute('data-apps-goto')) {
            var chip = section.querySelector('[data-apps-view="' + view + '"]');
            if (chip && chip.focus) chip.focus();
          }
        });
      }

      // Opening a desktop app (drawer or a session's apps sheet), once per document.
      if (!window.__crowAppsOpenBound) {
        window.__crowAppsOpenBound = true;
        document.addEventListener('click', function (e) {
          if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          var a = e.target && e.target.closest ? e.target.closest('a.shell-app[data-app-kind="desktop"]') : null;
          if (!a) return;
          if (!openDesktop(a.getAttribute('data-app-id'))) return;
          e.preventDefault();
          var dlg = a.closest('dialog');
          if (dlg && dlg.open) {
            if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
          }
        });
      }
    })();
`;
}

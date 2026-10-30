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
      // The mascot (or bell) opens the "Notifications and settings" sheet,
      // which holds its tray (phone review 2026-10-29). Its own inline
      // handler toggles the tray (and loads the list when it shows it) on a
      // tap, and leaves it alone for the click that only ended a long-press
      // (Talk to Crow). So: note the tray's state before that handler (a
      // capture listener on the button runs first) and open the sheet when
      // it changed. A changed state, not "now shown": a reopen that lands
      // before the last close event has reset the tray toggles it the
      // other way.
      function trayOf(btn) { return document.getElementById(btn.getAttribute('data-shell-tray')); }
      function resetTray(btn) {
        var tr = trayOf(btn);
        if (tr) tr.style.display = 'none';
        btn.setAttribute('aria-expanded', 'false');
      }
      var trayOpeners = document.querySelectorAll('[data-shell-tray]');
      for (var ti = 0; ti < trayOpeners.length; ti++) {
        var tb = trayOpeners[ti];
        tb.addEventListener('click', function (e) {
          var tr = trayOf(e.currentTarget);
          e.currentTarget.__trayBefore = tr ? tr.style.display : null;
        }, true);
        tb.addEventListener('click', function (e) {
          var btn = e.currentTarget, tr = trayOf(btn);
          if (!tr || tr.style.display === btn.__trayBefore) return;
          var dlg = document.getElementById(btn.getAttribute('aria-controls'));
          if (!dlg || dlg.open) return;
          tr.style.display = 'block';
          btn.setAttribute('aria-expanded', 'true');
          dlg.__shellOpener = btn;
          if (typeof dlg.showModal === 'function') dlg.showModal();
          else dlg.setAttribute('open', '');
        });
        // The bell is a div with role=button: Enter and Space press it. An
        // armed bell (data-crow-talk) already gets that from crow-talk.js; a
        // second press would toggle the tray straight back.
        if (tb.tagName !== 'BUTTON' && !tb.hasAttribute('data-crow-talk')) tb.addEventListener('keydown', function (e) {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          e.currentTarget.click();
        });
        var home = document.getElementById(tb.getAttribute('aria-controls'));
        if (home) {
          // A late close event after a quick reopen belongs to the closed sheet.
          home.addEventListener('close', (function (btn) { return function (e) { if (!e.currentTarget.open) resetTray(btn); }; })(tb));
          // "Talk to Crow" inside the sheet: the overlay cannot take focus
          // behind a modal dialog, so the sheet closes first (capture phase,
          // before the row's own handler), with focus parked on the mascot
          // for the overlay to hand back when it closes.
          home.addEventListener('click', (function (btn) { return function (e) {
            var row = e.target && e.target.closest ? e.target.closest('.crow-talk-row') : null;
            if (!row) return;
            var dlg = e.currentTarget;
            dlg.__shellOpener = null;
            closeSheet(dlg);
            if (typeof btn.focus === 'function') btn.focus();
          }; })(tb), true);
        }
      }
      // The "Needs attention" group: prefetched once at page load (so the
      // group is already there when the sheet opens and nothing shifts under a
      // finger), refetched on every open (the open attribute is the one signal
      // that covers every opener) and replaced only when the markup changed.
      // Only the latest response is applied. The alert landing
      // (?sheet=attention) opens the sheet once, then drops the parameter so a
      // reload or Back does not reopen it.
      var attnSlot = document.querySelector('[data-shell-attention]');
      if (attnSlot) {
        var attnDlg = attnSlot.closest('dialog');
        var attnSeq = 0;
        // "This is expected" returns to the page the user is on, with the sheet open.
        var fixAttnBack = function () {
          var back = location.pathname;
          try {
            var u = new URL(location.href);
            u.searchParams.set('sheet', 'attention');
            back = u.pathname + u.search;
          } catch (e) {}
          var fields = attnSlot.querySelectorAll('input[name="back"]');
          for (var f = 0; f < fields.length; f++) fields[f].value = back;
        };
        var loadAttention = function () {
          var mine = ++attnSeq;
          fetch('/dashboard/attention/fragment', { credentials: 'same-origin', cache: 'no-store' })
            .then(function (r) { return r.ok ? r.text() : null; })
            .then(function (html) {
              if (mine !== attnSeq || html === null) return;
              if (attnSlot.__attnHtml !== html) {
                attnSlot.innerHTML = html; attnSlot.__attnHtml = html;
                // The bird's badge counts these issues: tell it when they changed
                // (window-wide, so a Turbo visit after an ack counts too).
                var changed = window.__crowAttnLast !== undefined && window.__crowAttnLast !== html;
                window.__crowAttnLast = html;
                if (changed) document.dispatchEvent(new Event('crow:attention-changed'));
              }
              fixAttnBack();
            })
            .catch(function () {});
        };
        (window.requestIdleCallback || function (fn) { setTimeout(fn, 200); })(loadAttention);
        if (attnDlg && typeof MutationObserver === 'function') {
          new MutationObserver(function () { if (attnDlg.open) loadAttention(); })
            .observe(attnDlg, { attributes: true, attributeFilter: ['open'] });
        }
        if (/[?&]sheet=attention(&|$)/.test(location.search)) {
          var attnBtn = attnDlg ? document.querySelector('[data-shell-tray][aria-controls="' + attnDlg.id + '"]') : null;
          if (attnBtn) attnBtn.click();
          try {
            var attnUrl = new URL(location.href);
            attnUrl.searchParams.delete('sheet');
            history.replaceState(history.state, '', attnUrl.pathname + attnUrl.search + attnUrl.hash);
          } catch (e) {}
        }
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
          // A late close event that lands after a quick reopen belongs to the
          // sheet that already closed: keep the reopened sheet's opener and focus.
          if (e.currentTarget.open) return;
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

    // ─── The Chat tab returns to the open chat (2026-10-29) ───
    // Chat -> Board -> Chat used to land on the session list. While a chat is
    // open (/dashboard/perch#perchlive-<8 hex>) it is remembered for this tab;
    // going back to the list forgets it. The Chat tab then reopens it, when it
    // belongs to the tab's project (or the tab has none).
    (function () {
      var KEY = 'crow.shell.lastChat';
      function save(v) { try { if (v) sessionStorage.setItem(KEY, v); else sessionStorage.removeItem(KEY); } catch (e) {} }
      function load() { try { return sessionStorage.getItem(KEY); } catch (e) { return null; } }
      function projectOf(href) {
        try {
          var u = new URL(href, location.origin);
          if (u.pathname.indexOf('/dashboard/project/') === 0) return decodeURIComponent(u.pathname.slice(19).split('/')[0]);
          return u.searchParams.get('project') || '';
        } catch (e) { return null; }
      }
      function remember() {
        if (location.pathname !== '/dashboard/perch') return;
        save(/^#perchlive-[0-9a-f]{8}$/.test(location.hash) ? location.pathname + location.search + location.hash : null);
      }
      remember();
      if (!window.__crowShellChatReturnBound) {
        window.__crowShellChatReturnBound = true;
        if (typeof window.addEventListener === 'function') window.addEventListener('hashchange', remember);
        document.addEventListener('click', function (e) {
          if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          var a = e.target && e.target.closest ? e.target.closest('a.shell-tab[data-shell-tab="chat"]') : null;
          if (!a || location.pathname === '/dashboard/perch') return;
          var last = load();
          if (!last) return;
          var want = projectOf(a.getAttribute('href'));
          if (want === null || (want !== '' && want !== projectOf(last))) return;
          e.preventDefault();
          if (window.Turbo && typeof window.Turbo.visit === 'function') window.Turbo.visit(last); else location.href = last;
        });
      }
    })();

    // ─── For You: the phone swipe (For You v1) ───
    // A left-to-right swipe opens For You, only where it can't fight anything
    // else: the Chat list (/dashboard/perch with no chat open) and a project's
    // home, at phone width (the bottom-bar layout), never on a chat or a
    // canvas. It must start at least EDGE px in from the left edge, which
    // Android's system back gesture owns, and never on a field, in an open
    // dialog, or in a box that scrolls sideways. A tap or a vertical scroll
    // is untouched (passive listeners; nothing is prevented). It exists only
    // while the flag is on: the drawer's For You link (data-for-you-entry,
    // rendered only then) is its target.
    (function () {
      if (window.__crowForYouSwipeBound) return;
      window.__crowForYouSwipeBound = true;
      var EDGE = 32, MIN_DX = 80, MAX_MS = 700;
      var start = null;
      function surface() {
        var p = location.pathname;
        if (p === '/dashboard/perch') return !/^#perchlive-/.test(location.hash);
        return /^\\/dashboard\\/project\\/[^\\/]+$/.test(p);
      }
      function blocked(el) {
        for (var n = el; n && n !== document.body; n = n.parentElement) {
          if (n.matches && n.matches('input,textarea,select,[contenteditable],dialog,canvas,video,[data-no-swipe]')) return true;
          if (n.scrollWidth > n.clientWidth + 1) {
            var ox = getComputedStyle(n).overflowX;
            if (ox === 'auto' || ox === 'scroll') return true;
          }
        }
        return false;
      }
      document.addEventListener('touchstart', function (e) {
        start = null;
        if (!e.touches || e.touches.length !== 1 || !surface()) return;
        if (!window.matchMedia || !window.matchMedia('(max-width: 1023px)').matches) return;
        if (document.querySelector('dialog[open]')) return;
        var t = e.touches[0];
        if (t.clientX < EDGE || blocked(e.target)) return;
        start = { x: t.clientX, y: t.clientY, at: Date.now() };
      }, { passive: true });
      document.addEventListener('touchend', function (e) {
        var s = start;
        start = null;
        if (!s || !e.changedTouches || !e.changedTouches.length) return;
        var t = e.changedTouches[0];
        var dx = t.clientX - s.x, dy = t.clientY - s.y;
        if (dx < MIN_DX || Math.abs(dy) > dx / 2 || Date.now() - s.at > MAX_MS) return;
        var link = document.querySelector('a[data-for-you-entry]');
        if (!link) return;
        var href = link.getAttribute('href');
        if (window.Turbo && typeof window.Turbo.visit === 'function') window.Turbo.visit(href); else location.href = href;
      }, { passive: true });
      document.addEventListener('touchcancel', function () { start = null; }, { passive: true });
    })();

    // ─── The apps launcher (R1.2 PR 5): the drawer's Apps grid ───
    // window.CrowApps is shared with the Perch session's apps sheet
    // (perch-hub/client.js): one tile renderer, one open rule.
    (function () {
      var API = '/dashboard/shell-api/apps?project=';
      // A direct-mode app cannot sit behind the subpath proxy: its link is
      // https://<this hostname>:<port><path> (the nest panel's rule).
      function fixDirect(a) {
        // The port is an integer 1..65535 and the path a same-host absolute
        // path ("/x", never "//x"); anything else keeps the fallback href.
        var port = a.getAttribute('data-direct-port');
        if (!port || !/^[0-9]{1,5}$/.test(port)) return;
        var n = Number(port);
        if (n < 1 || n > 65535) return;
        var path = a.getAttribute('data-direct-path') || '/';
        if (!/^\\/(?!\\/)/.test(path)) return;
        a.setAttribute('href', 'https://' + location.hostname + ':' + n + path);
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

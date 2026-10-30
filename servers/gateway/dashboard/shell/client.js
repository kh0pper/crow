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

    // ─── For You: the drag reveal (For You v1; drag reveal 2026-10-30) ───
    // A left-to-right drag pulls For You in from the left, like the Pixel's
    // Discover feed: the page and a For You panel beside it follow the finger
    // 1:1. On release it lands on For You (past COMMIT of the width, or a
    // flick) or springs back. On For You the mirror drag (right to left)
    // pushes it back out: Back after a forward drag landed here (a one-time
    // sessionStorage marker) or when the page before was a Crow page and the
    // document came from this origin, else the Chat list.
    //
    // Where: the Chat list (/dashboard/perch with no chat open) and a
    // project's home (For You itself for the way back), at phone width (the
    // bottom-bar layout), never on a chat or a canvas. It must not feel like
    // the system Back gesture (a swipe in from either edge with a small
    // chevron): it starts at least EDGE px in from the edge it moves away
    // from, only after a deliberate sideways move (the axis lock: past SLOP
    // px and AXIS times more sideways than up or down), the whole page moves,
    // and the forward drag never calls history.back(). Never from a field, a
    // box that scrolls sideways or a canvas/video/[data-no-swipe], or while a
    // drawer, sheet or dialog is open; dropped when text is selected, when a
    // text field on the page holds a draft (leaving would lose it), and on a
    // paired kiosk display (its browser holds the kiosk's pairing token).
    // Vertical scrolling is untouched: .content-body is touch-action pan-y,
    // touchstart/end are passive, and the one non-passive touchmove listener
    // sits on an eligible page's .main-content and cancels moves only once a
    // drag has locked. It exists only while the flag is on: the For You link
    // (data-for-you-entry, rendered only then) is its target.
    //
    // The panel: For You's HTML is fetched once per page view on the first
    // eligible touch (once, success or not; a new render aborts it) and
    // parsed with DOMParser (nothing in it runs); scripts, frames, media,
    // dialogs and SVG animation are dropped, then ids, names, event
    // attributes, off-site URLs and any CSS that could load something
    // (url(, @import), and the copy goes into an inert panel. Until it
    // arrives the panel is a skeleton. On commit the page stays where the animation
    // left it until Turbo renders For You, so nothing flashes. Transforms only,
    // will-change while dragging, one rAF per frame; turbo:before-render tidies
    // anything a cached snapshot carried. With prefers-reduced-motion nothing
    // slides: the panel cross-fades in over the page instead.
    (function () {
      if (typeof window.__crowForYouReveal === 'function') { window.__crowForYouReveal(); return; }
      var EDGE = 48, SLOP = 12, AXIS = 1.5, COMMIT = 0.35, FLICK = 0.5;
      var SETTLE_MS = 230, MIN_MS = 120, FADE_MS = 150, GIVE_UP_MS = 10000;
      var EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
      var FY = '/dashboard/for-you', CHAT = '/dashboard/perch';
      var PROJECT = /^\\/dashboard\\/project\\/[^\\/]+$/;
      var DROP = 'script,iframe,frame,frameset,object,embed,link,meta,base,template,noscript,audio,video,source,track,dialog,animate,set,animatemotion,animatetransform';
      var start = null, drag = null, busy = null, raf = 0;
      var gen = 0, preview = null, tried = false, ctl = null, here = null, prev = null;

      function kiosk() {
        try { return !!window.localStorage.getItem('crow.kiosk.token'); } catch (e) { return false; }
      }
      function media(q) { return !!(window.matchMedia && window.matchMedia(q).matches); }
      function surface() {
        var p = location.pathname;
        if (p === CHAT) {
          if (/^#perchlive-/.test(location.hash)) return false;
          return !document.body || document.body.getAttribute('data-view') !== 'chat';
        }
        return PROJECT.test(p);
      }
      function onForYou() { return location.pathname === FY && !/[?&]view=/.test(location.search || ''); }
      function entry() { return document.querySelector('a[data-for-you-entry]'); }
      // The link's href, only as a same-origin /dashboard/ path (else null).
      function entryHref() {
        var link = entry(), h = link ? String(link.getAttribute('href') || '') : '';
        return /^\\/dashboard\\//.test(h) && !/[\\s\\\\]/.test(h) ? h : null;
      }
      // An open dialog, or a modal layer that is actually on screen. Some modal
      // layers live in every page, hidden by CSS until opened (Crow Talk's
      // overlay is display:none until .active): those must not count, or the
      // drag never starts anywhere.
      function overlayOpen() {
        if (document.querySelector('dialog[open]')) return true;
        var mods = document.querySelectorAll('[aria-modal="true"]:not([hidden]):not([aria-hidden="true"])');
        for (var i = 0; i < mods.length; i++) {
          var cs = typeof getComputedStyle === 'function' ? getComputedStyle(mods[i]) : null;
          if (!cs || (cs.display !== 'none' && cs.visibility !== 'hidden')) return true;
        }
        return false;
      }
      function hasDraft() {
        var fields = document.querySelectorAll('.content-body textarea, .content-body input[type="text"], .content-body input[type="search"], .content-body input:not([type]), .content-body [contenteditable="true"]');
        for (var i = 0; i < fields.length; i++) {
          var v = fields[i].isContentEditable ? fields[i].textContent : fields[i].value;
          if (v && String(v).trim() !== '') return true;
        }
        return false;
      }
      function selecting() {
        var sel = window.getSelection ? window.getSelection() : null;
        return !!(sel && !sel.isCollapsed && String(sel).trim() !== '');
      }
      // A box that really scrolls sideways keeps its own swipe. The page's own
      // vertical scrollers (.content-body, main) are skipped: overflow-y:auto
      // makes their computed overflow-x "auto" too, and a pixel of overflow
      // used to block the swipe everywhere.
      function blocked(el) {
        for (var n = el; n && n !== document.body; n = n.parentElement) {
          if (n.matches && n.matches('input,textarea,select,[contenteditable],dialog,canvas,video,[data-no-swipe]')) return true;
          if (n.matches && n.matches('.content-body, main, html')) continue;
          if (n.scrollWidth > n.clientWidth + 8) {
            var ox = getComputedStyle(n).overflowX;
            if (ox === 'auto' || ox === 'scroll') return true;
          }
        }
        return false;
      }
      function go(href) {
        if (window.Turbo && typeof window.Turbo.visit === 'function') window.Turbo.visit(href); else location.href = href;
      }
      function shift(x) { return 'translate3d(' + x + 'px,0,0)'; }

      // ── The preview: structure only, nothing fetched may run ──
      // CSS that could load anything: url(, @import, or an escape that could
      // spell either. The preview never needs an outside resource.
      function fetchesCss(text) { return /url\\s*\\(|@import|\\\\/i.test(String(text)); }
      function scrub(root) {
        var drop = root.querySelectorAll(DROP);
        for (var i = 0; i < drop.length; i++) if (drop[i].parentNode) drop[i].parentNode.removeChild(drop[i]);
        var css = root.querySelectorAll('style');
        for (var c = 0; c < css.length; c++) if (fetchesCss(css[c].textContent) && css[c].parentNode) css[c].parentNode.removeChild(css[c]);
        var all = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')));
        for (var j = 0; j < all.length; j++) {
          var at = all[j].attributes;
          for (var k = at.length - 1; k >= 0; k--) {
            var name = String(at[k].name).toLowerCase(), val = String(at[k].value || '');
            var url = name === 'href' || name === 'src' || name === 'xlink:href' || name === 'poster';
            // A URL stays only as a same-site path ("/x", never "//x", "/\\x" or one with spaces).
            // name/form clobber window globals; is= upgrades a custom element on import.
            var bad = /^on/.test(name) || /^(id|name|form|is|background|ping|cite|data|srcset|srcdoc|action|formaction|autofocus|data-turbo-permanent)$/.test(name) ||
              (name === 'style' && fetchesCss(val)) ||
              (url && (!/^\\/(?![\\/\\\\])/.test(val) || /[\\s\\\\]/.test(val)));
            if (bad) all[j].removeAttribute(at[k].name);
          }
        }
      }
      function copyOf(doc) {
        var main = doc.querySelector('.main-content');
        if (!main || !main.querySelector('[data-fy]')) return null; // not For You (a sign-in page, an error)
        var parts = [main, doc.querySelector('.shell-tabs')];
        var box = document.createElement('div');
        for (var i = 0; i < parts.length; i++) {
          if (!parts[i]) continue;
          scrub(parts[i]);
          box.appendChild(document.importNode(parts[i], true));
        }
        return box;
      }
      // At most one fetch per page view, success or not (a failure keeps the
      // skeleton); a new render aborts it.
      function prefetch() {
        var href = entryHref();
        if (tried || !href || typeof fetch !== 'function' || typeof DOMParser !== 'function') return;
        tried = true;
        var g = gen;
        ctl = typeof AbortController === 'function' ? new AbortController() : null;
        fetch(href, { credentials: 'same-origin', headers: { accept: 'text/html' }, signal: ctl ? ctl.signal : undefined })
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
          .then(function (html) { if (g === gen) preview = copyOf(new DOMParser().parseFromString(html, 'text/html')); })
          .catch(function () {});
      }
      function abortFetch() {
        if (ctl) { try { ctl.abort(); } catch (e) {} }
        ctl = null;
      }
      // Until the copy arrives: this page's own header and tab bar (no tab
      // lit), the For You title and three grey cards.
      function chrome(sel) {
        var el = document.querySelector(sel);
        if (!el) return null;
        var c = el.cloneNode(true);
        scrub(c);
        var lit = c.querySelectorAll('[aria-current]');
        for (var i = 0; i < lit.length; i++) lit[i].removeAttribute('aria-current');
        return c;
      }
      function skeleton() {
        var box = document.createElement('div');
        var main = document.createElement('main');
        main.className = 'main-content';
        var link = entry();
        var name = (link && String(link.textContent).trim()) || 'For You';
        // For You has no tab, so its title shows on a line of its own.
        var head = chrome('.main-content > .content-header');
        if (head) {
          if (head.classList) head.classList.remove('shell-header--tab');
          var h2 = head.querySelector('h2');
          if (h2) h2.textContent = name;
          main.appendChild(head);
        }
        var body = document.createElement('div');
        body.className = 'content-body';
        var title = document.createElement('p');
        title.className = 'fy-reveal-title';
        title.textContent = name;
        body.appendChild(title);
        for (var i = 0; i < 3; i++) {
          var card = document.createElement('div');
          card.className = 'fy-reveal-card';
          body.appendChild(card);
        }
        main.appendChild(body);
        box.appendChild(main);
        var tabs = chrome('.shell-tabs');
        if (tabs) box.appendChild(tabs);
        return box;
      }
      // dir 1: For You comes in from the left; -1: a plain panel from the right
      // (history.back() restores the page itself from Turbo's cache).
      function makePanel(dir, w, fade) {
        var p = document.createElement('div');
        p.className = dir > 0 ? 'fy-reveal dashboard' : 'fy-reveal';
        p.setAttribute('data-fy-reveal', '');
        p.setAttribute('aria-hidden', 'true');
        p.setAttribute('inert', '');
        if (dir > 0) {
          var src = preview ? preview.cloneNode(true) : skeleton();
          while (src.firstChild) p.appendChild(src.firstChild);
        }
        if (fade) p.style.opacity = '0'; else p.style.transform = shift(-dir * w);
        p.style.willChange = fade ? 'opacity' : 'transform';
        document.body.appendChild(p);
        return p;
      }

      // ── Moving ──
      function unstyle(el) {
        el.style.transition = '';
        el.style.transform = '';
        el.style.willChange = '';
      }
      function tidy(root) {
        if (!root || !root.querySelectorAll) return;
        var old = root.querySelectorAll('[data-fy-reveal]');
        for (var i = 0; i < old.length; i++) if (old[i].parentNode) old[i].parentNode.removeChild(old[i]);
        var moved = root.querySelectorAll('[data-fy-moved]');
        for (var j = 0; j < moved.length; j++) { unstyle(moved[j]); moved[j].removeAttribute('data-fy-moved'); }
        document.documentElement.style.overflowX = '';
      }
      // Late guards, checked when the drag would start to show.
      function ready() {
        if (overlayOpen() || selecting() || hasDraft()) return false;
        if (start.dir < 0) return onForYou();
        start.href = entryHref();
        return surface() && !!start.href;
      }
      function lock(t) {
        var w = window.innerWidth || 0;
        if (w <= 0) return false;
        var fade = media('(prefers-reduced-motion: reduce)');
        var movers = [];
        if (!fade) {
          var sel = ['.main-content', '.shell-tabs'];
          for (var i = 0; i < sel.length; i++) {
            var el = document.querySelector(sel[i]);
            if (el) movers.push(el);
          }
          if (!movers.length) return false;
          for (var m = 0; m < movers.length; m++) {
            movers[m].setAttribute('data-fy-moved', '');
            movers[m].style.willChange = 'transform';
          }
          document.documentElement.style.overflowX = 'clip';
        }
        drag = { dir: start.dir, href: start.href, w: w, x: 0, x0: t.clientX, fade: fade, movers: movers, panel: makePanel(start.dir, w, fade), samples: [] };
        return true;
      }
      function place(d, x) {
        if (d.fade) { d.panel.style.opacity = String(Math.abs(x) / d.w); return; }
        for (var i = 0; i < d.movers.length; i++) d.movers[i].style.transform = shift(x);
        d.panel.style.transform = shift(x - d.dir * d.w);
      }
      function paint() {
        raf = 0;
        if (drag) place(drag, drag.x);
      }
      function undo(d) {
        if (busy === d) busy = null;
        clearTimeout(d.timer);
        if (d.panel.parentNode) d.panel.parentNode.removeChild(d.panel);
        for (var i = 0; i < d.movers.length; i++) { unstyle(d.movers[i]); d.movers[i].removeAttribute('data-fy-moved'); }
        document.documentElement.style.overflowX = '';
      }
      // Back only to a Crow page: the page before was one (a /dashboard/ page
      // other than For You, seen in this window) and the document came from
      // this origin. Anything else goes to the Chat list.
      // The way back after a forward drag. The app usually opens Crow fresh
      // (no referrer), so the forward landing leaves a one-time marker in
      // sessionStorage: { from, to, at, landed }. For You's render marks it
      // landed (if it arrived within GIVE_UP_MS); any other page clears it;
      // the reverse drag consumes it and goes Back.
      var MARK = 'crow.forYou.dragFrom';
      function crowPath(v) { return typeof v === 'string' && /^\\/dashboard\\//.test(v) && v.indexOf(FY) !== 0 && !/[\\s\\\\]/.test(v); }
      function readMark() {
        try { var m = JSON.parse(window.sessionStorage.getItem(MARK) || 'null'); return m && typeof m === 'object' ? m : null; } catch (e) { return null; }
      }
      function writeMark(m) {
        try { if (m) window.sessionStorage.setItem(MARK, JSON.stringify(m)); else window.sessionStorage.removeItem(MARK); } catch (e) {}
      }
      function noteLanding(at) {
        var m = readMark();
        if (!m) return;
        if (at === m.to && !m.landed && Date.now() - m.at < GIVE_UP_MS) { m.landed = true; writeMark(m); }
        else if (at !== m.to || !m.landed) writeMark(null);
      }
      function cameFromCrow() {
        var ref = '';
        try { ref = document.referrer ? new URL(document.referrer).origin : ''; } catch (e) { ref = ''; }
        return !!(prev && prev.indexOf('/dashboard/') === 0 && prev.indexOf(FY) !== 0 &&
          ref && ref === location.origin && window.history && window.history.length > 1);
      }
      // Arrived: navigate, and keep the page where it is until the new one
      // renders. If it never does, put the page back.
      function land(d) {
        var m = d.dir < 0 ? readMark() : null;
        if (d.dir > 0) {
          if (crowPath(here)) writeMark({ from: here, to: d.href, at: Date.now(), landed: false });
          go(d.href);
        } else if (m && m.landed && m.to === here && crowPath(m.from)) {
          writeMark(null);
          window.history.back();
        } else if (cameFromCrow()) window.history.back();
        else go(CHAT);
        d.timer = setTimeout(function () { if (document.body.contains(d.panel)) undo(d); }, GIVE_UP_MS);
      }
      function settle(d, commit) {
        drag = null;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        busy = d;
        var to = commit ? d.dir * d.w : 0;
        var ms = d.fade ? FADE_MS : Math.round(MIN_MS + (SETTLE_MS - MIN_MS) * Math.abs(to - d.x) / d.w);
        var how = (d.fade ? 'opacity ' : 'transform ') + ms + 'ms ' + EASE;
        d.panel.style.transition = how;
        for (var i = 0; i < d.movers.length; i++) d.movers[i].style.transition = how;
        place(d, to);
        d.timer = setTimeout(function () { if (commit) land(d); else undo(d); }, ms + 20);
      }
      // px per ms toward where the drag goes, over the last 100 ms of moves;
      // a finger that stopped before lifting has none.
      function speed(d) {
        var s = d.samples, a = s[0], b = s[s.length - 1];
        if (s.length < 2 || Date.now() - b.t > 100 || b.t <= a.t) return 0;
        return (b.x - a.x) / (b.t - a.t) * d.dir;
      }

      function begin(e) {
        if (drag) { cancel(); return; } // a second finger mid-drag: spring back
        start = null;
        if (busy || !e.touches || e.touches.length !== 1 || kiosk() || !media('(max-width: 1023px)') || overlayOpen()) return;
        var dir = surface() ? 1 : onForYou() ? -1 : 0;
        if (!dir) return;
        var t = e.touches[0], w = window.innerWidth || 0;
        if (dir > 0 ? t.clientX < EDGE : t.clientX > w - EDGE) return;
        var tgt = e.target;
        if (!tgt || !tgt.closest || !tgt.closest('.main-content') || blocked(tgt)) return;
        start = { x: t.clientX, y: t.clientY, dir: dir };
        if (dir > 0) prefetch();
      }
      function move(e) {
        if (!start) return;
        if (!e.touches || e.touches.length !== 1) { cancel(); return; }
        var t = e.touches[0];
        if (!drag) {
          var dx = t.clientX - start.x, dy = t.clientY - start.y;
          var ax = Math.abs(dx), ay = Math.abs(dy);
          if (ax > SLOP && ax > ay * AXIS) {
            if (dx * start.dir < 0 || !ready() || !lock(t)) { start = null; return; }
          } else {
            if (ay > SLOP) start = null; // a scroll: hands off
            return;
          }
        }
        if (e.cancelable) e.preventDefault();
        var x = t.clientX - drag.x0;
        drag.x = drag.dir > 0 ? Math.max(0, Math.min(drag.w, x)) : Math.max(-drag.w, Math.min(0, x));
        var now = Date.now(), s = drag.samples;
        s.push({ x: drag.x, t: now });
        while (s.length > 2 && now - s[0].t > 100) s.shift();
        if (!raf) raf = requestAnimationFrame(paint);
      }
      function end() {
        var d = drag;
        start = null;
        if (!d) return;
        var v = speed(d);
        settle(d, v >= FLICK || (Math.abs(d.x) >= d.w * COMMIT && v > -FLICK));
      }
      function cancel() {
        var d = drag;
        start = null;
        if (d) settle(d, false);
      }
      // Per page view (this script re-runs on every Turbo render): a fresh
      // preview, the page we came from, and the touch wiring for this body.
      function setTouch() {
        var cb = document.querySelector('.content-body');
        if (cb) cb.style.touchAction = entry() && (surface() || onForYou()) ? 'pan-y pinch-zoom' : '';
      }
      function visit() {
        gen++;
        abortFetch();
        preview = null; tried = false; start = null;
        tidy(document.body);
        var at = location.pathname + (location.search || '');
        if (at !== here) { prev = here; here = at; }
        noteLanding(at);
        var p = location.pathname, main = document.querySelector('.main-content');
        if (main && !main.__crowFyMove && entry() && (p === CHAT || p === FY || PROJECT.test(p))) {
          main.__crowFyMove = true;
          main.addEventListener('touchmove', move, { passive: false });
        }
        setTouch();
      }
      window.__crowForYouReveal = visit;
      document.addEventListener('touchstart', begin, { passive: true });
      document.addEventListener('touchend', end, { passive: true });
      document.addEventListener('touchcancel', cancel, { passive: true });
      // The body Turbo is about to show may be a cached snapshot taken
      // mid-reveal: tidy it before it paints. The old body is left as it is
      // (it is going away, and moving it back would flash).
      document.addEventListener('turbo:before-render', function (e) {
        if (busy) clearTimeout(busy.timer);
        start = null; drag = null; busy = null;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        abortFetch();
        tidy(e && e.detail && e.detail.newBody);
      });
      if (typeof window.addEventListener === 'function') {
        window.addEventListener('hashchange', setTouch);
        window.addEventListener('pageshow', function (e) { if (e && e.persisted) { busy = null; tidy(document.body); } });
      }
      visit();
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

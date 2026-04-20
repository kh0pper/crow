/**
 * Dashboard Layout — HTML shell with Dark Editorial design
 *
 * Generates the full page HTML with sidebar nav, header, theme toggle,
 * Google Fonts, and CSS custom properties.
 */

import { CROW_HERO_SVG } from "./crow-hero.js";
import { FONT_IMPORT, designTokensCss } from "./design-tokens.js";
import { headerIconsCss, tamagotchiCss } from "./notifications.js";
import { t, SUPPORTED_LANGS } from "./i18n.js";

// Turbo Drive. Default-on as of the post-Phase-8 flip: inject the vendored
// Turbo 8.0.5 UMD build unless explicitly opted out with CROW_ENABLE_TURBO=0.
// `turbo-cache-control: no-cache` disables Turbo's preview-from-stale-snapshot
// (important for a dashboard with live data). `view-transition: same-origin`
// enables the View Transitions API fallback where supported.
function turboHead() {
  if (process.env.CROW_ENABLE_TURBO === "0") return "";
  return `<script src="/vendor/turbo-8.0.5.umd.js" defer></script>
  <meta name="turbo-cache-control" content="no-cache">
  <meta name="view-transition" content="same-origin">`;
}

// Turbo diagnostic overlay. Visible when ?diag=turbo is on the URL (or
// localStorage.crowDiagTurbo==='1'). Shows the last 20 uncaught errors,
// whether Turbo loaded, whether window.crowPlayer exists, and the last few
// Turbo lifecycle events. Cheap to ship in every page — the overlay only
// renders DOM if the query param / localStorage flag is set, so there's
// no visible effect by default.
function turboDiagScript() {
  if (process.env.CROW_ENABLE_TURBO === "0") return "";
  return `<script>
(function() {
  if (window.__crowDiagInit) return;
  window.__crowDiagInit = true;
  var urlEnabled = /(?:^|[?&])diag=turbo(?:&|$)/.test(location.search);
  var lsEnabled = false;
  try { lsEnabled = localStorage.getItem('crowDiagTurbo') === '1'; } catch(e) {}
  if (urlEnabled) { try { localStorage.setItem('crowDiagTurbo', '1'); lsEnabled = true; } catch(e) {} }
  var off = /(?:^|[?&])diag=off(?:&|$)/.test(location.search);
  if (off) { try { localStorage.removeItem('crowDiagTurbo'); } catch(e) {} return; }
  if (!lsEnabled) return;

  var errors = [];
  var events = [];

  function stamp() {
    var d = new Date();
    return d.getMinutes() + ':' + String(d.getSeconds()).padStart(2,'0') + '.' + String(d.getMilliseconds()).padStart(3,'0');
  }

  window.addEventListener('error', function(e) {
    errors.push(stamp() + ' ' + (e.message||'?') + ' @ ' + (e.filename||'?') + ':' + (e.lineno||'?'));
    if (errors.length > 20) errors.shift();
    render();
  });
  window.addEventListener('unhandledrejection', function(e) {
    errors.push(stamp() + ' unhandled: ' + (e.reason && (e.reason.message||e.reason) || 'unknown'));
    if (errors.length > 20) errors.shift();
    render();
  });

  ['turbo:load','turbo:before-visit','turbo:visit','turbo:before-render','turbo:render','turbo:before-fetch-request','turbo:before-fetch-response'].forEach(function(evt) {
    document.addEventListener(evt, function(e) {
      var raw = e.detail && (e.detail.url || (e.detail.fetchResponse && e.detail.fetchResponse.response && e.detail.fetchResponse.response.url));
      // e.detail.url is a URL object on turbo:before-fetch-request; coerce to
      // string before .replace() to avoid "url.replace is not a function".
      var url = raw ? String(raw) : '';
      var shortUrl = url ? url.replace(/^https?:\\/\\/[^/]+/, '') : '';
      events.push(stamp() + ' ' + evt + (shortUrl ? ' ' + shortUrl : ''));
      if (events.length > 15) events.shift();
      render();
    });
  });

  var box;
  function ensureBox() {
    if (box) return box;
    box = document.createElement('div');
    box.id = 'crow-diag-turbo';
    box.style.cssText = 'position:fixed;bottom:4.5rem;right:0.5rem;width:22em;max-height:60vh;overflow:auto;background:rgba(10,12,18,0.92);color:#d4e3ff;font:11px/1.35 JetBrains Mono,monospace;padding:0.5rem 0.6rem;border:1px solid rgba(127,200,255,0.4);border-radius:4px;z-index:99999;box-shadow:0 4px 14px rgba(0,0,0,0.6);';
    document.body.appendChild(box);
    return box;
  }

  function render() {
    if (!document.body) return;
    var el = ensureBox();
    var lines = [];
    lines.push('turbo: ' + (typeof window.Turbo === 'undefined' ? 'NOT LOADED' : (window.Turbo.session ? 'active' : 'loaded')));
    lines.push('crowPlayer: ' + (window.crowPlayer ? (typeof window.crowPlayer.queue === 'function' ? 'ok' : 'present-but-partial') : 'MISSING'));
    var audio = document.getElementById('crow-audio');
    lines.push('audio: ' + (audio ? 'present (init=' + (audio.dataset.crowPlayerInitialized||'?') + ', src=' + (audio.src ? audio.src.slice(-40) : '(empty)') + ')' : 'MISSING'));
    var root = document.getElementById('music-root');
    if (root) lines.push('music-root: init=' + (root.dataset.initialized||'?'));
    if (errors.length) { lines.push(''); lines.push('errors:'); errors.slice().reverse().forEach(function(x){ lines.push('  '+x); }); }
    if (events.length) { lines.push(''); lines.push('events:'); events.slice().reverse().forEach(function(x){ lines.push('  '+x); }); }
    lines.push('');
    lines.push('hide: add ?diag=off to URL');
    el.textContent = lines.join('\\n');
    el.style.whiteSpace = 'pre-wrap';
  }

  // Render once on boot, again after DOMContentLoaded, again after turbo:load.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
  document.addEventListener('turbo:load', render);
  // Re-render periodically so player state updates stay visible.
  setInterval(render, 2000);
})();
</script>`;
}

/**
 * Render the full dashboard HTML page.
 * @param {object} opts
 * @param {string} opts.title - Page title
 * @param {string} opts.content - Main content HTML
 * @param {string} opts.activePanel - Active panel ID for nav highlighting
 * @param {Array} opts.panels - Array of { id, name, icon, route, navOrder }
 * @param {string} [opts.theme] - "dark" or "light" (default: dark)
 * @param {boolean} [opts.glass] - Enable glass aesthetic
 * @param {boolean} [opts.serif] - Enable serif headings
 * @param {string} [opts.scripts] - Additional inline JS
 * @param {string} [opts.afterContent] - HTML rendered after </main> inside .dashboard (e.g. persistent player bar)
 * @param {string} [opts.headerIcons] - HTML rendered inside .content-header, right of title (e.g. notification bell, health icon)
 * @param {Array} [opts.navGroups] - Grouped nav: [{ id, name, collapsed, panels: [{ id, name, icon, route, navOrder }] }]
 * @param {Array|null} [opts.instanceTabs] - Unified multi-instance tabs: [{ id, name, status, isLocal }]. When null, strip is rendered hidden (body.unified-off).
 */
export function renderLayout({ title, content, activePanel, panels, theme, glass, serif, scripts, afterContent, headerIcons, lang, navGroups, instanceTabs }) {
  const themeClass = [
    theme === "light" ? "theme-light" : "",
    glass ? "theme-glass" : "",
    serif ? "theme-serif" : "",
    // Unified-off class gates the permanent tabs strip visibility via CSS.
    // The strip is ALWAYS rendered (for Turbo permanence across panel nav)
    // but hidden when the unified flag is off or no peers are trusted.
    (Array.isArray(instanceTabs) && instanceTabs.length > 1) ? "" : "unified-off",
  ].filter(Boolean).join(" ");
  const sortedPanels = [...panels].sort((a, b) => (a.navOrder || 0) - (b.navOrder || 0));

  // Render the instance tabs strip. Populated with local + peer tabs when
  // `instanceTabs` is provided; otherwise empty shell for Turbo permanence.
  // ARIA role varies by path — tablist on /dashboard (tabpanels exist),
  // navigation elsewhere (plain links). Since we don't have the active path
  // here, we go with role="tablist" on the nest panel (activePanel === 'nest')
  // and role="navigation" otherwise, using activePanel as a proxy.
  const isNestPanel = activePanel === "nest";
  const stripRole = isNestPanel ? "tablist" : "navigation";
  const stripAriaLabel = "Instances";
  let stripInner = "";
  if (Array.isArray(instanceTabs) && instanceTabs.length > 0) {
    stripInner = instanceTabs.map(tab => {
      const isLocalTab = tab.isLocal === true;
      const hash = isLocalTab ? "" : `#i/${encodeURIComponent(tab.id)}`;
      const href = `/dashboard${hash}`;
      const online = tab.status === "online";
      const tabRole = isNestPanel ? ' role="tab"' : '';
      const ariaDisabled = !online ? ' aria-disabled="true"' : '';
      const ariaSelected = isNestPanel ? ` aria-selected="${isLocalTab ? "true" : "false"}"` : '';
      const tabIndex = isNestPanel ? ` tabindex="${isLocalTab ? "0" : "-1"}"` : '';
      const klass = `crow-instance-tab ${online ? "tab--online" : "tab--offline"}${isLocalTab ? " active" : ""}`;
      return `<a href="${href}" class="${klass}"${tabRole}${ariaDisabled}${ariaSelected}${tabIndex} data-instance-id="${escapeHtml(tab.id)}"><span class="crow-instance-tab-dot"></span>${escapeHtml(tab.name)}</a>`;
    }).join("");
  }
  const instanceTabsStrip = `<nav id="crow-instance-tabs" class="crow-instance-tabs" role="${stripRole}" aria-label="${stripAriaLabel}" data-turbo-permanent>${stripInner}</nav>`;

  let navItems;
  if (navGroups && navGroups.length > 0) {
    // Grouped navigation
    navItems = navGroups.map((g) => {
      const groupLabel = t("nav.group." + g.id, lang) !== "nav.group." + g.id ? t("nav.group." + g.id, lang) : g.name;
      const items = g.panels.map((p) => {
        const active = p.id === activePanel ? "active" : "";
        const icon = NAV_ICONS[p.icon] || NAV_ICONS.default;
        const label = t("nav." + p.id, lang) !== "nav." + p.id ? t("nav." + p.id, lang) : p.name;
        const preload = p.preload ? " data-turbo-preload" : "";
        return `<a href="${p.route}" class="nav-item ${active}"${preload}>${icon}<span>${escapeHtml(label)}</span></a>`;
      }).join("\n          ");
      return `<div class="nav-group${g.collapsed ? " collapsed" : ""}" data-group-id="${escapeHtml(g.id)}">
          <button class="nav-group-header" onclick="toggleNavGroup('${escapeHtml(g.id)}')">
            <span>${escapeHtml(groupLabel)}</span>
            <svg class="nav-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <div class="nav-group-items" id="nav-group-${escapeHtml(g.id)}">
            ${items}
          </div>
        </div>`;
    }).join("\n        ");
  } else {
    // Flat navigation (backward compatible)
    navItems = sortedPanels.map((p) => {
      const active = p.id === activePanel ? "active" : "";
      const icon = NAV_ICONS[p.icon] || NAV_ICONS.default;
      const label = t("nav." + p.id, lang) !== "nav." + p.id ? t("nav." + p.id, lang) : p.name;
      const preload = p.preload ? " data-turbo-preload" : "";
      return `<a href="${p.route}" class="nav-item ${active}"${preload}>${icon}<span>${escapeHtml(label)}</span></a>`;
    }).join("\n        ");
  }

  return `<!DOCTYPE html>
<html lang="${lang || 'en'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>${escapeHtml(title)} — Crow's Nest</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <link rel="icon" type="image/svg+xml" href="/icons/crow-icon.svg">
  <link rel="apple-touch-icon" href="/icons/crow-icon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,400;0,500;0,700;1,400&family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700;1,9..144,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  ${dashboardCss()}
  ${turboHead()}
</head>
<body class="${themeClass}">
  <div id="kiosk-overlay" class="kiosk-overlay"></div>
  <div class="dashboard">
    <aside class="sidebar">
      <div class="sidebar-header">
        <h1 class="logo">Crow</h1>
      </div>
      <nav class="sidebar-nav">
        ${navItems}
      </nav>
      <div class="sidebar-footer">
        <button onclick="toggleTheme()" class="theme-toggle" title="${escapeHtml(t("nav.toggleTheme", lang))}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
        </button>
        <a href="/dashboard/logout" class="nav-item logout" data-turbo="false">${escapeHtml(t("nav.logout", lang))}</a>
      </div>
    </aside>
    <div class="sidebar-overlay" onclick="closeSidebar()"></div>
    <main class="main-content">
      <header class="content-header">
        <button class="hamburger" onclick="toggleSidebar()" aria-label="Toggle menu">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
        </button>
        <h2>${escapeHtml(title)}</h2>
        ${headerIcons ? `<div class="header-icons">${headerIcons}</div>` : ""}
      </header>
      ${instanceTabsStrip}
      <div class="content-body">
        ${content}
      </div>
    </main>
    ${afterContent || ""}
  </div>
  <script>
    function toggleTheme() {
      document.body.classList.toggle('theme-light');
      fetch('/dashboard/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'action=set_theme&theme=' + (document.body.classList.contains('theme-light') ? 'light' : 'dark')
      });
      fetch('/dashboard/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'action=set_theme_mode&mode=' + (document.body.classList.contains('theme-light') ? 'light' : 'dark')
      });
    }
    // ─── Kiosk Mode ───
    function toggleKioskMode() {
      var overlay = document.getElementById('kiosk-overlay');
      if (overlay.classList.contains('active')) {
        exitKioskMode();
        return;
      }
      var companionUrl = 'https://' + location.hostname + ':12393/';
      var iframe = document.createElement('iframe');
      iframe.src = companionUrl;
      iframe.setAttribute('allow', 'microphone; camera; autoplay; fullscreen');
      iframe.setAttribute('allowfullscreen', '');
      iframe.style.cssText = 'width:100%;height:100%;border:none';
      overlay.appendChild(iframe);
      overlay.classList.add('active');
      fetch('/dashboard/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'action=set_kiosk&kiosk=true'
      });
    }
    function exitKioskMode() {
      var overlay = document.getElementById('kiosk-overlay');
      overlay.classList.remove('active');
      while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
      fetch('/dashboard/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'action=set_kiosk&kiosk=false'
      });
    }
    // Document/window-level listeners must only attach ONCE per document
    // lifetime. Under Turbo these scripts re-execute on every nav; without
    // this guard, each nav stacks additional keydown + message listeners.
    if (!window.__crowLayoutKeyListeners) {
      window.__crowLayoutKeyListeners = true;
      document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && document.getElementById('kiosk-overlay') && document.getElementById('kiosk-overlay').classList.contains('active')) {
          exitKioskMode();
          e.stopPropagation();
        }
      });

      // Listen for companion requesting exit
      window.addEventListener('message', function(e) {
        if (e.data === 'crow-exit-kiosk') exitKioskMode();
      });

      // Global Escape-closes-sidebar listener — also only once per document
      document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') closeSidebar();
      });

      // Auth-boundary interception: when a Turbo fetch lands on a 401 or
      // crosses into /dashboard/login (session expired mid-nav), force a
      // full reload instead of body-swapping a login page into the
      // authenticated layout's DOM. Prevents orphaned tamagotchi/notif
      // timers and stale sidebar scripts from continuing to poll an
      // unauthenticated endpoint. No-op when Turbo isn't loaded.
      document.addEventListener('turbo:before-fetch-response', function(event) {
        var fetchResponse = event.detail && event.detail.fetchResponse;
        if (!fetchResponse || !fetchResponse.response) return;
        var resp = fetchResponse.response;
        var url = resp.url || '';
        if (resp.status === 401 || /\\/dashboard\\/login(\\/|$|\\?)/.test(url)) {
          event.preventDefault();
          window.location.href = url || '/dashboard/login';
        }
      });

      // CSRF double-submit: attach the crow_csrf cookie value as
      // X-Crow-Csrf on every state-changing same-origin request.
      //   - Turbo form submissions: turbo:submit-start hook.
      //   - Turbo.visit / link prefetch: turbo:before-fetch-request hook.
      //   - Raw window.fetch() from panel code: wrapped below.
      //   - Classic <form data-turbo="false"> submissions: carry a server-
      //     rendered <input name="_csrf"> via csrfInput().
      function readCookie(name) {
        var cookies = document.cookie.split(';');
        for (var i = 0; i < cookies.length; i++) {
          var p = cookies[i].trim().split('=');
          if (p[0] === name) return decodeURIComponent(p.slice(1).join('='));
        }
        return '';
      }
      document.addEventListener('turbo:submit-start', function(event) {
        var token = readCookie('crow_csrf');
        if (!token) return;
        var fetchReq = event.detail && event.detail.formSubmission &&
                       event.detail.formSubmission.fetchRequest;
        if (fetchReq && fetchReq.headers) {
          fetchReq.headers['X-Crow-Csrf'] = token;
        }
      });
      document.addEventListener('turbo:before-fetch-request', function(event) {
        var token = readCookie('crow_csrf');
        if (!token) return;
        var method = (event.detail && event.detail.fetchOptions && event.detail.fetchOptions.method || '').toUpperCase();
        if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || method === '') return;
        var headers = event.detail.fetchOptions.headers;
        if (headers) {
          if (typeof headers.set === 'function') headers.set('X-Crow-Csrf', token);
          else headers['X-Crow-Csrf'] = token;
        }
      });

      // Wrap window.fetch so raw fetch() POST/PUT/DELETE/PATCH calls also
      // carry the CSRF header. Same-origin only (never leak token to
      // third-party origins). Idempotent: guarded by a flag so repeated
      // layout inclusions (Turbo page navs) don't double-wrap.
      if (!window.__crowFetchWrapped) {
        window.__crowFetchWrapped = true;
        var origFetch = window.fetch.bind(window);
        window.fetch = function(input, init) {
          try {
            var token = readCookie('crow_csrf');
            if (!token) return origFetch(input, init);
            var url = typeof input === 'string' ? input : (input && input.url) || '';
            var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
            if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
              return origFetch(input, init);
            }
            // Same-origin check: relative URL (starts with '/') OR matches current origin.
            var sameOrigin = false;
            if (url.charAt(0) === '/' && !url.startsWith('//')) {
              sameOrigin = true;
            } else {
              try {
                var u = new URL(url, window.location.href);
                sameOrigin = (u.origin === window.location.origin);
              } catch (e) { sameOrigin = false; }
            }
            if (!sameOrigin) return origFetch(input, init);
            var newInit = Object.assign({}, init || {});
            var hdrs = new Headers(newInit.headers || (typeof input !== 'string' ? input.headers : undefined) || {});
            if (!hdrs.has('X-Crow-Csrf')) hdrs.set('X-Crow-Csrf', token);
            newInit.headers = hdrs;
            return origFetch(input, newInit);
          } catch (err) {
            return origFetch(input, init);
          }
        };
      }
    }

    function toggleSidebar() {
      var sidebar = document.querySelector('.sidebar');
      if (sidebar.classList.contains('open')) {
        closeSidebar();
      } else {
        document.body._scrollY = window.scrollY;
        sidebar.classList.add('open');
        document.body.classList.add('sidebar-open');
      }
    }
    function closeSidebar() {
      document.querySelector('.sidebar').classList.remove('open');
      document.body.classList.remove('sidebar-open');
      if (document.body._scrollY !== undefined) {
        window.scrollTo(0, document.body._scrollY);
      }
    }
    // Sidebar nav-item click handlers are attached fresh each nav because
    // the sidebar DOM is swapped — listeners auto-GC with old DOM.
    document.querySelectorAll('.sidebar .nav-item').forEach(function(a) {
      a.addEventListener('click', closeSidebar);
    });
    function toggleNavGroup(id) {
      const group = document.querySelector('.nav-group[data-group-id="' + id + '"]');
      if (group) {
        group.classList.toggle('collapsed');
        fetch('/dashboard/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'action=toggle_nav_group&group_id=' + encodeURIComponent(id)
        });
      }
    }
    ${scripts || ""}
    // Service Worker registration (PWA) — once per document lifetime
    if ('serviceWorker' in navigator && !window.__crowSwRegistered) {
      window.__crowSwRegistered = true;
      navigator.serviceWorker.register('/sw.js').catch(function() {});
    }

  </script>
  ${turboDiagScript()}
</body>
</html>`;
}

/**
 * Render the login page.
 * @param {object} opts
 * @param {string} [opts.error] - Error message to display
 * @param {boolean} [opts.isSetup] - True if setting password for first time
 */
export function renderLogin({ error, isSetup, setupToken, lockoutHelp, lang } = {}) {
  return `<!DOCTYPE html>
<html lang="${lang || 'en'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>${isSetup ? escapeHtml(t("login.setupTitle", lang)) : escapeHtml(t("login.title", lang))} — Crow's Nest</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Fraunces:opsz,wght@9..144,700&display=swap" rel="stylesheet">
  ${dashboardCss()}
</head>
<body>
  <div class="login-page">
    <div class="login-card">
      <div style="width:120px;height:120px;margin:0 auto 1rem">${CROW_HERO_SVG}</div>
      <h1 class="login-logo">Crow</h1>
      <p class="login-subtitle">${isSetup ? escapeHtml(t("login.setupSubtitle", lang)) : escapeHtml(t("login.subtitle", lang))}</p>
      ${error ? `<div class="login-error">${escapeHtml(error)}</div>` : ""}
      <form method="POST" action="/dashboard/login">
        ${isSetup ? `${setupToken ? `<input type="hidden" name="setup_token" value="${setupToken}">` : ""}
        <input type="password" name="password" placeholder="${escapeHtml(t("login.choosePasswordPlaceholder", lang))}" required minlength="12" autofocus>
        <input type="password" name="confirm" placeholder="${escapeHtml(t("login.confirmPlaceholder", lang))}" required minlength="12">` :
        `<input type="password" name="password" placeholder="${escapeHtml(t("login.passwordPlaceholder", lang))}" required autofocus>`}
        <button type="submit">${isSetup ? escapeHtml(t("login.setPasswordButton", lang)) : escapeHtml(t("login.loginButton", lang))}</button>
      </form>
      ${!isSetup ? `<p style="margin-top:1rem;font-size:0.8rem;color:var(--crow-text-tertiary)"><a href="/dashboard/reset">${escapeHtml(t("login.forgotPassword", lang))}</a></p>` : ""}
      ${lockoutHelp || ""}
    </div>
  </div>
</body>
</html>`;
}

/**
 * Render the 2FA verification page (TOTP code entry after password).
 */
export function render2faVerify({ error, lang } = {}) {
  return `<!DOCTYPE html>
<html lang="${lang || 'en'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>${escapeHtml(t("login.2faTitle", lang))} — Crow's Nest</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Fraunces:opsz,wght@9..144,700&display=swap" rel="stylesheet">
  ${dashboardCss()}
</head>
<body>
  <div class="login-page">
    <div class="login-card">
      <div style="width:120px;height:120px;margin:0 auto 1rem">${CROW_HERO_SVG}</div>
      <h1 class="login-logo">Crow</h1>
      <p class="login-subtitle">${escapeHtml(t("login.2faSubtitle", lang))}</p>
      ${error ? `<div class="login-error">${escapeHtml(error)}</div>` : ""}
      <form method="POST" action="/dashboard/login/2fa">
        <input type="text" name="totp_code" placeholder="${escapeHtml(t("login.2faPlaceholder", lang))}" required autofocus autocomplete="one-time-code" inputmode="numeric" pattern="[0-9\\-]*" maxlength="14" style="text-align:center;font-size:1.2rem;letter-spacing:0.2em">
        <label style="display:flex;align-items:center;gap:0.5rem;margin:0.75rem 0;font-size:0.85rem;color:var(--crow-text-secondary);cursor:pointer">
          <input type="checkbox" name="trust_device" value="1"> ${escapeHtml(t("login.2faTrustDevice", lang))}
        </label>
        <button type="submit">${escapeHtml(t("login.2faVerifyButton", lang))}</button>
      </form>
      <p style="margin-top:1rem;font-size:0.8rem;color:var(--crow-text-tertiary)">
        <a href="/dashboard/login/2fa/recovery">${escapeHtml(t("login.2faUseRecovery", lang))}</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Render the 2FA recovery code entry page.
 */
export function render2faRecovery({ error, lang } = {}) {
  return `<!DOCTYPE html>
<html lang="${lang || 'en'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>${escapeHtml(t("login.2faRecoveryTitle", lang))} — Crow's Nest</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Fraunces:opsz,wght@9..144,700&display=swap" rel="stylesheet">
  ${dashboardCss()}
</head>
<body>
  <div class="login-page">
    <div class="login-card">
      <div style="width:120px;height:120px;margin:0 auto 1rem">${CROW_HERO_SVG}</div>
      <h1 class="login-logo">Crow</h1>
      <p class="login-subtitle">${escapeHtml(t("login.2faRecoverySubtitle", lang))}</p>
      ${error ? `<div class="login-error">${escapeHtml(error)}</div>` : ""}
      <form method="POST" action="/dashboard/login/2fa/recovery">
        <input type="text" name="recovery_code" placeholder="xxxx-xxxx-xxxx" required autofocus autocomplete="off" style="text-align:center;font-size:1.1rem;letter-spacing:0.1em" maxlength="14">
        <button type="submit">${escapeHtml(t("login.2faRecoveryButton", lang))}</button>
      </form>
      <p style="margin-top:1rem;font-size:0.8rem;color:var(--crow-text-tertiary)">
        <a href="/dashboard/login">${escapeHtml(t("login.backToLogin", lang))}</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Render the mandatory 2FA setup page (for managed hosting first login).
 */
export function render2faSetup({ secret, qrDataUri, recoveryCodes, error, lang } = {}) {
  const codesHtml = recoveryCodes ? recoveryCodes.map(c => `<code style="display:block;padding:0.25rem 0;font-size:0.95rem">${escapeHtml(c)}</code>`).join("") : "";
  return `<!DOCTYPE html>
<html lang="${lang || 'en'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>${escapeHtml(t("login.2faSetupTitle", lang))} — Crow's Nest</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Fraunces:opsz,wght@9..144,700&display=swap" rel="stylesheet">
  ${dashboardCss()}
</head>
<body>
  <div class="login-page">
    <div class="login-card" style="max-width:440px">
      <h1 class="login-logo" style="font-size:1.5rem">${escapeHtml(t("login.2faSetupTitle", lang))}</h1>
      <p class="login-subtitle">${escapeHtml(t("login.2faSetupSubtitle", lang))}</p>
      ${error ? `<div class="login-error">${escapeHtml(error)}</div>` : ""}
      ${qrDataUri ? `<div style="text-align:center;margin:1rem 0"><img src="${qrDataUri}" alt="QR Code" width="200" height="200" style="border-radius:8px;background:#fff;padding:8px"></div>` : ""}
      ${secret ? `<p style="font-size:0.75rem;color:var(--crow-text-tertiary);word-break:break-all;text-align:center;margin-bottom:1rem">${escapeHtml(t("login.2faManualKey", lang))}: <code>${escapeHtml(secret)}</code></p>` : ""}
      ${recoveryCodes ? `
        <div style="background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:8px;padding:1rem;margin:1rem 0;text-align:center">
          <p style="font-size:0.8rem;font-weight:600;margin-bottom:0.5rem;color:var(--crow-text-secondary)">${escapeHtml(t("login.2faRecoveryCodes", lang))}</p>
          ${codesHtml}
          <p style="font-size:0.7rem;color:var(--crow-text-tertiary);margin-top:0.5rem">${escapeHtml(t("login.2faSaveCodesWarning", lang))}</p>
        </div>` : ""}
      <form method="POST" action="/dashboard/login/2fa/setup">
        <input type="hidden" name="secret" value="${escapeHtml(secret || "")}">
        <input type="text" name="totp_code" placeholder="${escapeHtml(t("login.2faPlaceholder", lang))}" required autofocus autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]*" maxlength="6" style="text-align:center;font-size:1.2rem;letter-spacing:0.2em">
        <button type="submit">${escapeHtml(t("login.2faSetupVerifyButton", lang))}</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Render the password reset request page (enter email / request reset).
 */
export function renderResetRequest({ error, success, isHosted, lang } = {}) {
  return `<!DOCTYPE html>
<html lang="${lang || 'en'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>${escapeHtml(t("login.resetTitle", lang))} — Crow's Nest</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Fraunces:opsz,wght@9..144,700&display=swap" rel="stylesheet">
  ${dashboardCss()}
</head>
<body>
  <div class="login-page">
    <div class="login-card">
      <div style="width:120px;height:120px;margin:0 auto 1rem">${CROW_HERO_SVG}</div>
      <h1 class="login-logo">Crow</h1>
      <p class="login-subtitle">${escapeHtml(t("login.resetSubtitle", lang))}</p>
      ${error ? `<div class="login-error">${escapeHtml(error)}</div>` : ""}
      ${success ? `<div style="background:var(--crow-accent-bg,rgba(100,200,100,0.1));border:1px solid var(--crow-accent,#4a9);border-radius:8px;padding:1rem;margin-bottom:1rem;font-size:0.9rem">${escapeHtml(success)}</div>` : ""}
      ${isHosted ? `
      <form method="POST" action="/dashboard/reset">
        <button type="submit">${escapeHtml(t("login.resetSendButton", lang))}</button>
      </form>` : `
      <p style="font-size:0.9rem;color:var(--crow-text-secondary);margin-bottom:1rem">${escapeHtml(t("login.resetSelfHosted", lang))}</p>
      <pre style="background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:8px;padding:1rem;font-size:0.85rem;overflow-x:auto">npm run reset-password</pre>`}
      <p style="margin-top:1rem;font-size:0.8rem;color:var(--crow-text-tertiary)">
        <a href="/dashboard/login">${escapeHtml(t("login.backToLogin", lang))}</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Render the password reset form (new password entry after clicking email link).
 */
export function renderResetForm({ error, token, lang } = {}) {
  return `<!DOCTYPE html>
<html lang="${lang || 'en'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>${escapeHtml(t("login.resetTitle", lang))} — Crow's Nest</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Fraunces:opsz,wght@9..144,700&display=swap" rel="stylesheet">
  ${dashboardCss()}
</head>
<body>
  <div class="login-page">
    <div class="login-card">
      <div style="width:120px;height:120px;margin:0 auto 1rem">${CROW_HERO_SVG}</div>
      <h1 class="login-logo">Crow</h1>
      <p class="login-subtitle">${escapeHtml(t("login.resetNewPassword", lang))}</p>
      ${error ? `<div class="login-error">${escapeHtml(error)}</div>` : ""}
      <form method="POST" action="/dashboard/reset/complete">
        <input type="hidden" name="token" value="${escapeHtml(token || "")}">
        <input type="password" name="password" placeholder="${escapeHtml(t("login.choosePasswordPlaceholder", lang))}" required minlength="12" autofocus>
        <input type="password" name="confirm" placeholder="${escapeHtml(t("login.confirmPlaceholder", lang))}" required minlength="12">
        <button type="submit">${escapeHtml(t("login.resetPasswordButton", lang))}</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const NAV_ICONS = {
  messages: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  edit: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  files: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
  settings: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  extensions: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`,
  health: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12L12 4l9 8"/><path d="M5 10v9a1 1 0 0 0 1 1h4v-5h4v5h4a1 1 0 0 0 1-1v-9"/></svg>`,
  mic: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="9" y1="21" x2="15" y2="21"/></svg>`,
  contacts: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  skills: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`,
  default: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>`,
};

function dashboardCss() {
  return `<style>
  ${FONT_IMPORT}

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  ${designTokensCss()}

  body {
    font-family: 'DM Sans', sans-serif;
    background: var(--crow-bg-deep);
    color: var(--crow-text-primary);
    line-height: 1.6;
    min-height: 100vh;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
  }

  a { color: var(--crow-accent); text-decoration: none; }
  a:hover { color: var(--crow-accent-hover); }

  /* Dashboard layout */
  .dashboard { display: flex; min-height: 100vh; }

  /* Sidebar */
  .sidebar {
    width: 240px;
    background: var(--crow-bg-surface);
    border-right: 1px solid var(--crow-border);
    display: flex;
    flex-direction: column;
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    z-index: 100;
    transition: transform 0.2s ease-out;
  }
  .sidebar-header {
    padding: 1.5rem;
    border-bottom: 1px solid var(--crow-border);
  }
  .logo {
    font-family: 'Fraunces', serif;
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--crow-text-primary);
  }
  .sidebar-nav {
    flex: 1;
    padding: 0.75rem;
    overflow-y: auto;
  }
  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 0.75rem;
    border-radius: 8px;
    color: var(--crow-text-secondary);
    font-size: 0.9rem;
    font-weight: 500;
    transition: all 0.15s;
    margin-bottom: 0.15rem;
  }
  .nav-item:hover {
    background: var(--crow-bg-elevated);
    color: var(--crow-text-primary);
  }
  .nav-item.active {
    background: rgba(99,102,241,0.08);
    color: var(--crow-accent);
    border-left: 3px solid var(--crow-brand-gold);
    padding-left: calc(0.75rem - 3px);
  }
  .nav-item svg { flex-shrink: 0; }

  /* Nav groups */
  .nav-group { margin-bottom: 0.25rem; }
  .nav-group-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 0.35rem 0.75rem;
    background: none;
    border: none;
    color: var(--crow-text-muted);
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    cursor: pointer;
    transition: color 0.15s;
  }
  .nav-group-header:hover { color: var(--crow-text-secondary); }
  .nav-chevron {
    transition: transform 0.2s ease;
    flex-shrink: 0;
  }
  .nav-group.collapsed .nav-chevron { transform: rotate(-90deg); }
  .nav-group-items {
    overflow: hidden;
    max-height: 500px;
    transition: max-height 0.25s ease-out, opacity 0.2s ease;
    opacity: 1;
  }
  .nav-group.collapsed .nav-group-items {
    max-height: 0;
    opacity: 0;
  }
  .sidebar-footer {
    padding: 0.75rem;
    border-top: 1px solid var(--crow-border);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .theme-toggle {
    background: none;
    border: 1px solid var(--crow-border);
    border-radius: 6px;
    padding: 0.4rem;
    color: var(--crow-text-muted);
    cursor: pointer;
    transition: color 0.15s;
  }
  .theme-toggle:hover { color: var(--crow-accent); }
  .logout { font-size: 0.8rem; }

  /* Main content */
  .main-content {
    flex: 1;
    margin-left: 240px;
    min-height: 100vh;
  }
  .content-header {
    padding: 1.25rem 2rem;
    border-bottom: 1px solid var(--crow-border);
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .content-header h2 {
    font-family: 'Fraunces', serif;
    font-size: 1.25rem;
    font-weight: 600;
    flex: 1;
  }
  .header-icons {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-left: auto;
  }
  .hamburger {
    display: none;
    background: none;
    border: none;
    color: var(--crow-text-primary);
    cursor: pointer;
    padding: 0.25rem;
  }
  .content-body {
    padding: 2rem;
  }

  /* Cards */
  .card {
    background: var(--crow-bg-surface);
    border: 1px solid var(--crow-border);
    border-radius: 12px;
    padding: 1.25rem;
    animation: fadeInUp 0.4s ease-out both;
    box-shadow: 0 1px 3px rgba(0,0,0,0.2), 0 0 0 1px rgba(99,102,241,0.05);
    transition: box-shadow 0.15s;
  }
  .card:hover {
    box-shadow: 0 4px 12px rgba(0,0,0,0.3), 0 0 0 1px rgba(99,102,241,0.1);
  }
  .card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1rem;
  }
  .stat-card {
    background: var(--crow-bg-surface);
    border: 1px solid var(--crow-border);
    border-radius: 12px;
    padding: 1.25rem;
    box-shadow: 0 1px 3px rgba(0,0,0,0.2), 0 0 0 1px rgba(99,102,241,0.05);
  }
  .stat-card .label {
    font-size: 0.8rem;
    color: var(--crow-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.35rem;
  }
  .stat-card .value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 1.75rem;
    font-weight: 500;
    color: var(--crow-accent);
  }

  /* Tables */
  .data-table {
    width: 100%;
    border-collapse: collapse;
  }
  .data-table th, .data-table td {
    padding: 0.65rem 0.75rem;
    text-align: left;
    border-bottom: 1px solid var(--crow-border);
  }
  .data-table th {
    font-size: 0.75rem;
    color: var(--crow-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 500;
  }
  .data-table tr:hover td { background: var(--crow-bg-elevated); }
  .data-table .mono {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.85rem;
  }

  /* Forms */
  input, textarea, select {
    font-family: 'DM Sans', sans-serif;
    background: var(--crow-bg-elevated);
    border: 1px solid var(--crow-border);
    border-radius: 8px;
    padding: 0.6rem 0.75rem;
    color: var(--crow-text-primary);
    font-size: 0.9rem;
    width: 100%;
    transition: border-color 0.15s;
  }
  input:focus, textarea:focus, select:focus {
    outline: none;
    border-color: var(--crow-accent);
  }
  textarea { resize: vertical; min-height: 120px; }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    border-radius: 8px;
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    border: 1px solid transparent;
    font-family: 'DM Sans', sans-serif;
  }
  .btn-primary {
    background: var(--crow-accent);
    color: #ffffff;
  }
  .btn-primary:hover { background: var(--crow-accent-hover); }
  .btn-secondary {
    background: transparent;
    border-color: var(--crow-border);
    color: var(--crow-text-secondary);
  }
  .btn-secondary:hover {
    border-color: var(--crow-accent);
    color: var(--crow-text-primary);
  }
  .btn-danger {
    background: transparent;
    border-color: var(--crow-error);
    color: var(--crow-error);
  }
  .btn-danger:hover { background: var(--crow-error); color: white; }
  .btn-sm { padding: 0.3rem 0.6rem; font-size: 0.8rem; }

  /* Badge */
  .badge {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    font-size: 0.7rem;
    font-weight: 500;
    text-transform: uppercase;
  }
  .badge-published { background: var(--crow-success); color: #ffffff; }
  .badge-draft { background: var(--crow-bg-elevated); color: var(--crow-text-muted); }
  .badge-connected { background: var(--crow-success); color: #ffffff; }
  .badge-error { background: var(--crow-error); color: white; }

  /* Empty state */
  .empty-state {
    text-align: center;
    padding: 3rem 1rem;
    color: var(--crow-text-muted);
  }
  .empty-state img {
    width: 48px;
    height: 48px;
    margin-bottom: 1rem;
    opacity: 0.6;
  }
  .empty-state h3 {
    font-family: 'Fraunces', serif;
    font-size: 1.25rem;
    margin-bottom: 0.5rem;
    color: var(--crow-text-secondary);
  }

  /* Alert */
  .alert {
    padding: 0.75rem 1rem;
    border-radius: 8px;
    margin-bottom: 1rem;
    font-size: 0.9rem;
  }
  .alert-success { background: rgba(34,197,94,0.1); border: 1px solid var(--crow-success); color: var(--crow-success); }
  .alert-error { background: rgba(239,68,68,0.1); border: 1px solid var(--crow-error); color: var(--crow-error); }

  /* Login page */
  .login-page {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
  }
  .login-card {
    background: var(--crow-bg-surface);
    border: 1px solid var(--crow-border);
    border-radius: 12px;
    padding: 2.5rem;
    width: 100%;
    max-width: 380px;
    text-align: center;
    animation: fadeInUp 0.4s ease-out both;
  }
  .login-logo {
    font-family: 'Fraunces', serif;
    font-size: 2.5rem;
    font-weight: 700;
    color: var(--crow-accent);
    margin-bottom: 0.25rem;
  }
  .login-subtitle {
    color: var(--crow-text-muted);
    margin-bottom: 1.5rem;
    font-size: 0.9rem;
  }
  .login-error {
    background: rgba(239,68,68,0.1);
    border: 1px solid var(--crow-error);
    color: var(--crow-error);
    padding: 0.5rem 0.75rem;
    border-radius: 8px;
    margin-bottom: 1rem;
    font-size: 0.85rem;
  }
  .login-card form { display: flex; flex-direction: column; gap: 0.75rem; }
  .login-card button {
    background: var(--crow-accent);
    color: #ffffff;
    border: none;
    border-radius: 8px;
    padding: 0.65rem;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    font-family: 'DM Sans', sans-serif;
    transition: background 0.15s;
  }
  .login-card button:hover { background: var(--crow-accent-hover); }

  /* Animations */
  @keyframes fadeInUp {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* Header icons (notifications, health) */
  ${headerIconsCss}

  /* Tamagotchi crow */
  ${tamagotchiCss}

  /* Glass overrides for dashboard */
  .theme-glass .sidebar {
    backdrop-filter: var(--crow-glass-blur-heavy);
    -webkit-backdrop-filter: var(--crow-glass-blur-heavy);
    background: rgba(0,0,0,0.72);
  }
  .theme-glass.theme-light .sidebar {
    background: rgba(245,245,247,0.72);
  }
  .theme-glass .card,
  .theme-glass .stat-card {
    backdrop-filter: var(--crow-glass-blur);
    -webkit-backdrop-filter: var(--crow-glass-blur);
    border-width: 0.5px;
    box-shadow: none;
  }
  .theme-glass .card:hover {
    box-shadow: 0 4px 16px rgba(0,0,0,0.2);
  }
  .theme-glass .nav-item.active {
    background: var(--crow-accent-muted);
    border-left-color: var(--crow-accent);
  }
  /* Glass overrides for popups, modals, and fixed overlays */
  .theme-glass .header-dropdown,
  .theme-glass .crow-dropdown,
  .theme-glass #modal-content,
  .theme-glass #crow-player-bar,
  .theme-glass .msg-popover {
    background: var(--crow-bg-popup);
    backdrop-filter: var(--crow-glass-blur);
    -webkit-backdrop-filter: var(--crow-glass-blur);
    border-color: var(--crow-border-popup);
  }

  /* Sidebar overlay (hidden by default, shown on mobile when sidebar is open) */
  .sidebar-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.5);
    z-index: 99;
  }

  /* Safe area insets for notched devices */
  @supports (padding: env(safe-area-inset-top)) {
    .content-header { padding-top: env(safe-area-inset-top); }
    .sidebar { padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); }
    .content-body { padding-bottom: env(safe-area-inset-bottom); }
  }

  /* Responsive — mobile */
  @media (max-width: 768px) {
    .sidebar {
      transform: translateX(-100%);
    }
    .sidebar.open {
      transform: translateX(0);
      box-shadow: 4px 0 24px rgba(0,0,0,0.5);
    }
    .sidebar.open ~ .sidebar-overlay {
      display: block;
    }
    body.sidebar-open {
      overflow: hidden;
      position: fixed;
      width: 100%;
    }
    .main-content {
      margin-left: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
      height: 100dvh;
      overflow: hidden;
    }
    .content-header {
      flex-shrink: 0;
    }
    .content-body {
      flex: 1;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      min-height: 0;
      padding: 1rem;
    }
    .hamburger { display: block; }
    .dashboard {
      height: 100vh;
      height: 100dvh;
    }
  }

  /* ─── Instance Tabs Strip (unified multi-instance; permanent across Turbo nav) ─── */
  .crow-instance-tabs {
    display: flex;
    gap: 0.25rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--crow-border);
    overflow-x: auto;
    scrollbar-width: none;
    background: var(--crow-bg-deep);
    flex-shrink: 0;
  }
  .crow-instance-tabs::-webkit-scrollbar { display: none; }

  .crow-instance-tab {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.85rem;
    border-radius: 8px;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--crow-text-secondary);
    text-decoration: none;
    cursor: pointer;
    background: transparent;
    border: 1px solid transparent;
    white-space: nowrap;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .crow-instance-tab:hover {
    background: rgba(99,102,241,0.08);
    color: var(--crow-text-primary);
  }
  .crow-instance-tab:focus-visible {
    outline: 2px solid var(--crow-accent);
    outline-offset: 2px;
  }
  .crow-instance-tab.active,
  .crow-instance-tab[aria-selected="true"] {
    background: rgba(99,102,241,0.15);
    border-color: rgba(99,102,241,0.3);
    color: var(--crow-text-primary);
  }
  .crow-instance-tab[aria-disabled="true"],
  .crow-instance-tab.tab--offline {
    opacity: 0.5;
    cursor: default;
  }
  .crow-instance-tab-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--crow-text-muted);
  }
  .crow-instance-tab.tab--online .crow-instance-tab-dot {
    background: var(--crow-success);
  }
  .crow-instance-tab.tab--offline .crow-instance-tab-dot {
    background: var(--crow-text-muted);
  }

  body.unified-off #crow-instance-tabs { display: none; }
</style>`;
}

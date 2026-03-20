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
 */
export function renderLayout({ title, content, activePanel, panels, theme, glass, serif, scripts, afterContent, headerIcons, lang }) {
  const themeClass = [
    theme === "light" ? "theme-light" : "",
    glass ? "theme-glass" : "",
    serif ? "theme-serif" : "",
  ].filter(Boolean).join(" ");
  const sortedPanels = [...panels].sort((a, b) => (a.navOrder || 0) - (b.navOrder || 0));

  const navItems = sortedPanels.map((p) => {
    const active = p.id === activePanel ? "active" : "";
    const icon = NAV_ICONS[p.icon] || NAV_ICONS.default;
    const label = t("nav." + p.id, lang) !== "nav." + p.id ? t("nav." + p.id, lang) : p.name;
    return `<a href="${p.route}" class="nav-item ${active}">${icon}<span>${escapeHtml(label)}</span></a>`;
  }).join("\n        ");

  return `<!DOCTYPE html>
<html lang="${lang || 'en'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — Crow's Nest</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,400;0,500;0,700;1,400&family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700;1,9..144,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  ${dashboardCss()}
</head>
<body class="${themeClass}">
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
        <a href="/dashboard/logout" class="nav-item logout">${escapeHtml(t("nav.logout", lang))}</a>
      </div>
    </aside>
    <main class="main-content">
      <header class="content-header">
        <button class="hamburger" onclick="toggleSidebar()" aria-label="Toggle menu">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
        </button>
        <h2>${escapeHtml(title)}</h2>
        ${headerIcons ? `<div class="header-icons">${headerIcons}</div>` : ""}
      </header>
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
    function toggleSidebar() {
      document.querySelector('.sidebar').classList.toggle('open');
    }
    ${scripts || ""}
  </script>
</body>
</html>`;
}

/**
 * Render the login page.
 * @param {object} opts
 * @param {string} [opts.error] - Error message to display
 * @param {boolean} [opts.isSetup] - True if setting password for first time
 */
export function renderLogin({ error, isSetup, setupToken, lang } = {}) {
  return `<!DOCTYPE html>
<html lang="${lang || 'en'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
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

  /* Responsive */
  @media (max-width: 768px) {
    .sidebar {
      transform: translateX(-100%);
    }
    .sidebar.open {
      transform: translateX(0);
      box-shadow: 4px 0 24px rgba(0,0,0,0.5);
    }
    .main-content { margin-left: 0; }
    .hamburger { display: block; }
    .content-body { padding: 1rem; }
  }
</style>`;
}

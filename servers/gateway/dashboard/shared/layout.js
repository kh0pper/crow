/**
 * Dashboard Layout — HTML shell with Dark Editorial design
 *
 * Generates the full page HTML with sidebar nav, header, theme toggle,
 * Google Fonts, and CSS custom properties.
 */

/**
 * Render the full dashboard HTML page.
 * @param {object} opts
 * @param {string} opts.title - Page title
 * @param {string} opts.content - Main content HTML
 * @param {string} opts.activePanel - Active panel ID for nav highlighting
 * @param {Array} opts.panels - Array of { id, name, icon, route, navOrder }
 * @param {string} [opts.theme] - "dark" or "light" (default: dark)
 * @param {string} [opts.scripts] - Additional inline JS
 */
export function renderLayout({ title, content, activePanel, panels, theme, scripts }) {
  const themeClass = theme === "light" ? "theme-light" : "";
  const sortedPanels = [...panels].sort((a, b) => (a.navOrder || 0) - (b.navOrder || 0));

  const navItems = sortedPanels.map((p) => {
    const active = p.id === activePanel ? "active" : "";
    const icon = NAV_ICONS[p.icon] || NAV_ICONS.default;
    return `<a href="${p.route}" class="nav-item ${active}">${icon}<span>${escapeHtml(p.name)}</span></a>`;
  }).join("\n        ");

  return `<!DOCTYPE html>
<html lang="en">
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
        <button onclick="toggleTheme()" class="theme-toggle" title="Toggle theme">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
        </button>
        <a href="/dashboard/logout" class="nav-item logout">Logout</a>
      </div>
    </aside>
    <main class="main-content">
      <header class="content-header">
        <button class="hamburger" onclick="toggleSidebar()" aria-label="Toggle menu">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
        </button>
        <h2>${escapeHtml(title)}</h2>
      </header>
      <div class="content-body">
        ${content}
      </div>
    </main>
  </div>
  <script>
    function toggleTheme() {
      document.body.classList.toggle('theme-light');
      fetch('/dashboard/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'action=set_theme&theme=' + (document.body.classList.contains('theme-light') ? 'light' : 'dark')
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
export function renderLogin({ error, isSetup } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${isSetup ? "Setup" : "Login"} — Crow's Nest</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Fraunces:opsz,wght@9..144,700&display=swap" rel="stylesheet">
  ${dashboardCss()}
</head>
<body>
  <div class="login-page">
    <div class="login-card">
      <h1 class="login-logo">Crow</h1>
      <p class="login-subtitle">${isSetup ? "Set your Crow's Nest password" : "Crow's Nest Login"}</p>
      ${error ? `<div class="login-error">${escapeHtml(error)}</div>` : ""}
      <form method="POST" action="/dashboard/login">
        ${isSetup ? `<input type="password" name="password" placeholder="Choose a password" required minlength="6" autofocus>
        <input type="password" name="confirm" placeholder="Confirm password" required minlength="6">` :
        `<input type="password" name="password" placeholder="Password" required autofocus>`}
        <button type="submit">${isSetup ? "Set Password" : "Login"}</button>
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
  default: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>`,
};

function dashboardCss() {
  return `<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,400;0,500;0,700;1,400&family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700;1,9..144,400&family=JetBrains+Mono:wght@400;500&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --crow-bg-deep: #0c0a09;
    --crow-bg-surface: #1c1917;
    --crow-bg-elevated: #292524;
    --crow-border: #44403c;
    --crow-text-primary: #fafaf9;
    --crow-text-secondary: #a8a29e;
    --crow-text-muted: #78716c;
    --crow-accent: #f59e0b;
    --crow-accent-hover: #fbbf24;
    --crow-accent-muted: #92400e;
    --crow-success: #22c55e;
    --crow-error: #ef4444;
    --crow-info: #38bdf8;
  }

  .theme-light {
    --crow-bg-deep: #fafaf9;
    --crow-bg-surface: #ffffff;
    --crow-bg-elevated: #f5f5f4;
    --crow-border: #e7e5e4;
    --crow-text-primary: #1c1917;
    --crow-text-secondary: #57534e;
    --crow-text-muted: #a8a29e;
    --crow-accent: #b45309;
    --crow-accent-hover: #92400e;
    --crow-accent-muted: #fef3c7;
  }

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
    background: var(--crow-bg-elevated);
    color: var(--crow-accent);
    border-left: 3px solid var(--crow-accent);
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
    color: #0c0a09;
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
  .badge-published { background: var(--crow-success); color: #0c0a09; }
  .badge-draft { background: var(--crow-bg-elevated); color: var(--crow-text-muted); }
  .badge-connected { background: var(--crow-success); color: #0c0a09; }
  .badge-error { background: var(--crow-error); color: white; }

  /* Empty state */
  .empty-state {
    text-align: center;
    padding: 3rem 1rem;
    color: var(--crow-text-muted);
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
    color: #0c0a09;
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

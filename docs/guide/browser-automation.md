---
title: Browser Automation
---

# Browser Automation

Stealth browser automation with VNC viewing — navigate websites, fill forms, extract content, and scrape data via Chrome DevTools Protocol.

## What You Get

- **18 MCP tools** — navigation, form filling, screenshots, content extraction, scraping
- **Docker container** — headless Chrome with Xvfb + VNC viewer
- **Stealth mode** — human-like typing, click randomization, fingerprint spoofing
- **Dashboard panel** — live VNC view, container controls, saved sessions, installed skills
- **Content extraction** — article text, HTML tables, structured data, pagination
- **FFFF filing skill** — IRS Free File Fillable Forms automation (bundled)

## Installation

1. Open the **Extensions** page in your Crow's Nest dashboard
2. Find **Browser Automation** and click **Install**
3. Docker builds the container (takes a few minutes on first install)
4. The gateway restarts — the Browser panel appears in the sidebar

There is no VNC password to set or enter: the viewer is reached only through your signed-in Crow dashboard.

## Dashboard Panel

The Browser panel has three tabs:

### Status
- Container status (Running/Stopped) with Start/Stop/Restart buttons
- CDP (Chrome DevTools Protocol) connection status
- **Live VNC view** — embedded iframe showing the browser in real-time
- "Open VNC Viewer" link for a larger view

### Sessions
- List of saved browser sessions (cookies + localStorage)
- Restore sessions to resume where you left off

### Skills
- Installed automation skills (e.g., FFFF Filing, custom scraping recipes)

## MCP Tools

### Core Tools

| Tool | Description |
|------|-------------|
| `crow_browser_launch` | Connect to browser via CDP, returns the viewer's dashboard path |
| `crow_browser_status` | Container and CDP health check |
| `crow_browser_navigate` | Go to URL with stealth scripts |
| `crow_browser_screenshot` | Capture page or element as PNG |
| `crow_browser_fill_form` | Fill form fields with human-like typing |
| `crow_browser_click` | Click with position randomization |
| `crow_browser_evaluate` | Run JavaScript in page context |
| `crow_browser_wait_for_user` | Pause for human intervention (CAPTCHA, 2FA) |
| `crow_browser_discover_selectors` | Find all interactive elements on page |
| `crow_browser_save_session` | Save cookies + localStorage to file |
| `crow_browser_load_session` | Restore a saved session |

### Content Extraction Tools

| Tool | Description |
|------|-------------|
| `crow_browser_extract_text` | Clean article text via Mozilla Readability |
| `crow_browser_extract_tables` | HTML tables to JSON or CSV |
| `crow_browser_extract_links` | All links with text and URLs, filterable |
| `crow_browser_scrape` | Structured data via CSS selector mapping |
| `crow_browser_paginate` | Follow pagination, collect multi-page results |
| `crow_browser_export` | Save scraped data as CSV or JSON file |
| `crow_browser_capture_har` | Record network requests for API discovery |

## Workflows

### Basic Navigation & Form Filling

```
1. crow_browser_launch          → connect to browser
2. crow_browser_navigate        → go to the site
3. crow_browser_discover_selectors → find form fields
4. crow_browser_fill_form       → fill in values
5. crow_browser_click           → submit
6. crow_browser_screenshot      → verify result
```

### Content Scraping

```
1. crow_browser_navigate        → go to the page
2. crow_browser_extract_text    → get clean article text
   — or —
   crow_browser_scrape          → extract structured data via CSS selectors
3. crow_browser_export          → save as CSV or JSON
```

### Multi-Page Scraping

```
1. crow_browser_navigate        → go to first page
2. crow_browser_paginate        → follow "next" links, extract from each page
3. crow_browser_export          → save combined results
```

### Session Management

```
1. crow_browser_save_session    → save cookies before long operations
2. (... time passes, session might expire ...)
3. crow_browser_load_session    → restore cookies and continue
```

## Stealth Features

The browser includes anti-detection measures:

- **navigator.webdriver** masked
- **User-Agent rotation** — Chrome on Windows, macOS, or Linux profiles
- **Plugin spoofing** — fake Chrome PDF Plugin, PDF Viewer, Native Client
- **Screen dimensions** — 1920x1080 with realistic available area
- **window.chrome** object mocked
- **Timezone** configurable (defaults to Central)
- **Human-like typing** — per-character delays with randomization
- **Human-like clicking** — position randomized within element bounds
- **Navigation pauses** — random delays between actions

## Human Intervention

For CAPTCHA, 2FA, security questions, or any action requiring human judgment:

1. The AI calls `crow_browser_wait_for_user` with a message
2. You see the message and tap **Take over** in the chat (or open the Browser panel)
3. Complete the action manually in the browser
4. Tell the AI to continue (it calls `wait_for_user` with `resume: true`)

## VNC Access

The VNC viewer is reached only through the Crow gateway, behind your dashboard sign-in:

- **Embedded**: In the Browser panel's Status tab (iframe), the live browser tile, and the **Take over** sheet in a chat
- **Full view**: `/proxy/browser/vnc.html?autoconnect=true&resize=scale&view_only=false` (same HTTPS as your dashboard)

The viewer connects on its own: there is no separate VNC password. The screen (x11vnc, and the X display under it) is on no network port: x11vnc listens only on a root-only unix socket inside the container, and the X display needs a per-start cookie and has no TCP or host-wide socket. noVNC (port 6080) listens on `127.0.0.1` only, and connects a viewer only with a per-instance key that Crow generates at install (`CROW_BROWSER_VNC_TOKEN` in the bundle's `.env`, handed to the container as a root-only file). The Crow gateway adds the key on its side, after checking your sign-in and that the request comes from the dashboard's own page; no page or link contains it, and a wrong key is refused without being logged. This keeps **web pages and other machines** away from the screen. It does **not** keep out programs already running on this machine as any user: Chrome DevTools (CDP, `127.0.0.1:9222`) has no authentication, so a local program can drive the browser and read its cookies through it. Gating CDP is tracked separately. The container stops at startup if the screen is on any TCP port, an X socket is reachable host-wide, or noVNC is reachable on a non-loopback address. After changing the key in `.env`, recreate the container.

## Docker Container

The container runs:
- **Ubuntu 22.04** with Xvfb (virtual framebuffer)
- **Playwright Chromium** (latest)
- **x11vnc + noVNC** for browser viewing
- **Host networking** (`network_mode: host`) for CDP access

Container limits: 2GB RAM, 1GB shared memory.

### Container Management

From the Browser panel:
- **Start** / **Stop** / **Restart** buttons
- Container auto-restarts on reboot (`restart: unless-stopped`)

From the command line:
```bash
cd ~/.crow/bundles/browser
docker compose up -d      # start
docker compose stop       # stop
docker compose logs -f    # view logs
```

The browser's profile (its cookies and saved logins) lives on a named Docker volume, one per instance (`browser-chromium-profile` on the main instance), so stopping, restarting, rebuilding or re-creating the container keeps it. Only `docker compose down -v` (or `docker volume rm`) deletes it. An install from before 1.3.12 keeps its profile inside the old container until an operator moves it once with `scripts/ops/browser-profile-to-volume.sh` (run `--dry-run` first); until then, avoid anything that re-creates that container.

## FFFF Filing Skill

The Browser Automation extension includes a skill for filing taxes via IRS Free File Fillable Forms. See the [Tax Filing Assistant](/guide/tax-filing) guide for details.

## Security

- **CDP port (9222)** binds to `127.0.0.1` only, but has **no authentication**: any program running on this machine, as any user, can drive the browser and read its cookies through it (gating it is tracked separately)
- **VNC**: x11vnc is on a unix socket inside the container (no TCP port); the X display needs a per-start cookie and has no TCP or host-wide socket; noVNC (6080) binds to `127.0.0.1` only and needs the per-instance key that the gateway adds, after the session and same-origin checks
- **No ports exposed** to the network — everything goes through the gateway's HTTPS
- No VNC password: for web pages and other machines, the dashboard sign-in is the gate (programs on this machine: see CDP above). A page served by another app under the dashboard's `/proxy/` shares the dashboard's origin, so a flaw in such an app reaches what the dashboard reaches. An older install's `CROW_BROWSER_VNC_PASSWORD` in the bundle's `.env` is ignored

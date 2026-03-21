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
3. Enter a VNC password when prompted
4. Docker builds the container (takes a few minutes on first install)
5. The gateway restarts — the Browser panel appears in the sidebar

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
| `crow_browser_launch` | Connect to browser via CDP, returns VNC URL |
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
2. You see the message and open the VNC viewer
3. Complete the action manually in the browser
4. Tell the AI to continue (it calls `wait_for_user` with `resume: true`)

## VNC Access

The VNC viewer is accessible through the Crow gateway:

- **Embedded**: In the Browser panel's Status tab (iframe)
- **Full view**: `/proxy/browser/vnc.html` (same HTTPS as your dashboard)
- **Direct**: `http://localhost:6080/vnc.html` (local access only)

No firewall ports need to be opened — VNC is proxied through the gateway.

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
docker compose down       # stop
docker compose logs -f    # view logs
```

## FFFF Filing Skill

The Browser Automation extension includes a skill for filing taxes via IRS Free File Fillable Forms. See the [Tax Filing Assistant](/guide/tax-filing) guide for details.

## Security

- **CDP port (9222)** binds to `127.0.0.1` only
- **VNC** is proxied through the gateway with session authentication
- **No ports exposed** to the network — everything goes through the gateway's HTTPS
- VNC password is required (set during installation)

---
name: crow-browser
description: "All-in-one browser automation + scraping toolkit with stealth — navigate, fill forms, scrape, extract articles past paywalls, capture APIs, download files, and hand CAPTCHA to a human over VNC. Activates when the user asks to automate a website, fill forms, scrape or extract web data, bypass a paywall, or drive a browser."
allowed-tools: ["exec", "message"]
---

# Crow Browser — All-in-One Automation & Scraping Toolkit

You drive a **real, headful Chrome** running in a container (Xvfb + noVNC) over the Chrome DevTools Protocol, with anti-detection stealth applied automatically. The user can watch every action live via VNC. This skill teaches you **how to use the toolkit**; for a specific target, also load (or write) a *recipe* skill — see `scrape-recipe-template.md`.

## Golden rule: cheapest tool first, escalate only when blocked

Match effort to the target. Don't open a browser to read an API; don't fight a paywall with raw fetches.

1. **Clean data?** (API, RSS, JSON) → you may not need this toolkit at all; a plain HTTP fetch is better.
2. **Static-ish page** → `navigate` → `extract_text` / `extract_tables` / `scrape`.
3. **JS-heavy / lazy-loaded** → `navigate` → `wait_for` / `scroll_extract`, or `capture_responses` to grab the hidden JSON API directly (often more stable than parsing the DOM).
4. **Paywalled article** → `extract_article` (runs the fallback ladder for you).
5. **Bot-walled / login / CAPTCHA** → stealth is already on; add a proxy at launch if IP-blocked, and **hand CAPTCHA/2FA to the human over VNC** (`wait_for_user`).

## Setup

1. `crow_browser_launch` — starts/connects the container and returns the VNC URL. (Pass `restart: true` to recycle a stuck browser; pass `proxy_url` to route through a proxy — see Escalation.)
2. Give the user the VNC URL so they can watch and intervene: `http://localhost:6080/vnc.html`.
3. `crow_browser_status` — check container + CDP health any time.

## Tool reference

### Automation
- `crow_browser_navigate` `{url, wait_until}` — go to a URL (`wait_until`: load | domcontentloaded | networkidle).
- `crow_browser_discover_selectors` `{filter, frame_selector?}` — dump interactive elements (inputs/buttons/links/selects) with positions + attributes. **Use this to find selectors — never guess.** Pass `frame_selector` to look inside an iframe.
- `crow_browser_fill_form` `{fields, clear_first?}` — fill a `{selector: value}` map with human-like typing.
- `crow_browser_click` `{selector, wait_after?}` — click with position randomization.
- `crow_browser_evaluate` `{expression}` — run JS in the page (use for reloads, custom DOM reads, clicking through sticky nav: `el.click()`).
- `crow_browser_screenshot` `{selector?, full_page?}` — capture state for verification.
- `crow_browser_wait_for` `{selector, timeout_ms?, state?}` — wait for an element to appear/hide/attach/detach. **Prefer this over fixed sleeps** on dynamic pages.
- `crow_browser_scroll_extract` `{extract_selector, scroll_pause_ms?, max_scrolls?, container_selector?}` — auto-scroll an infinite-scroll feed, collecting items; stops when nothing new loads.

### Session & identity
- `crow_browser_save_session` `{name}` / `crow_browser_load_session` `{name}` — persist/restore cookies + localStorage. Save before risky steps and before a proxy restart.
- `crow_browser_set_headers` `{headers}` — set extra HTTP headers (UA, Referer, bot-impersonation) **before navigating**.
- `crow_browser_add_cookies` `{cookies}` — inject a copied session's cookies.

### Extraction
- `crow_browser_extract_text` `{format?, include_metadata?}` — clean article text via Readability; `format: "markdown"` for structured output.
- `crow_browser_extract_tables` `{selector?, format?}` — tables → JSON or CSV.
- `crow_browser_extract_links` `{filter?, limit?}` — links with text, regex-filterable.
- `crow_browser_scrape` `{selectors, multiple?, container?}` — CSS-schema extraction; `container` + `multiple` for repeating cards.
- `crow_browser_paginate` `{next_selector, extract_selector, max_pages?}` — follow "next" links across pages.
- `crow_browser_extract_article` `{url, methods?, format?, min_words?}` — **paywall fallback ladder**: live page → archive.today → Wayback → 12ft.io, each loaded in the stealth browser, parsed with Readability, quality-gated (paywall-phrase + min-words). Returns the first clean result, tagged with the method that won. *Don't hand-roll paywall bypass — use this.*
- `crow_browser_extract_pdf` `{url_or_path, type?, max_pages?}` — text/metadata from a PDF (URL or local path).
- `crow_browser_export` `{data, format, filename?}` — write scraped data to `~/.crow/browser-exports/` as CSV/JSON.

### Network / API discovery
- `crow_browser_capture_har` `{action}` — start/stop lightweight request logging (URLs/status/type) for API discovery.
- `crow_browser_capture_responses` `{action, filter_url_pattern?, include_response_body?}` — capture full responses (incl. JSON bodies) via raw CDP. **The fastest path to a site's hidden JSON API** — watch the network, scrape the API, not the DOM.
- `crow_browser_block_requests` `{patterns}` — block ads/trackers/images for speed and a smaller detection surface.

### Files
- `crow_browser_download` `{selector, output_dir?}` — trigger a download (click) and save the file to the host at `~/.crow/browser-downloads/`.

### Escalation
- `crow_browser_wait_for_user` `{message, resume?}` — **the VNC human-in-the-loop handoff** (see below).
- `crow_browser_launch` `{proxy_url}` — route the session through a proxy (set **before** navigating; this restarts the browser — save/load session around it).

## The VNC human-in-the-loop rule (CRITICAL)

When you hit something you must not automate — **CAPTCHA / reCAPTCHA, 2FA, security questions, payment/submit confirmations, or any irreversible real-world action** — do NOT guess or click blind:

1. `crow_browser_screenshot` — show the current state.
2. `crow_browser_wait_for_user` with a clear message of exactly what the human must do (and the VNC URL).
3. The human completes just that step in the live VNC browser.
4. `crow_browser_wait_for_user` with `resume: true` — execution continues where it parked.

This is the ethical, robust alternative to solver services: no third party sees the session, it never trips "automated solving" detection, and a human stays on the irreversible steps.

## Stealth (automatic)

Applied on every page without you doing anything: `navigator.webdriver`/plugins/screen/`window.chrome` spoofing, WebRTC leak masking, rotating realistic User-Agents, and human-like typing/click cadence with natural pauses. A coherent fingerprint (timezone/locale/UA) is maintained. You don't configure it — but know it's there, and that screenshots may render a bot wall while `capture_responses` still has valid data.

## Working with iframes

Many forms live in iframes. Inspect with `discover_selectors({frame_selector: "iframe#formFrame"})`. Note that direct click/fill target the main frame — drive iframe-only flows via the recipe's documented selectors.

## Error recovery

- CDP disconnected → `crow_browser_launch({restart: true})`.
- Page stuck → `crow_browser_evaluate({expression: "location.reload()"})`.
- Session expired → `crow_browser_load_session`.
- Health check → `crow_browser_status`.

## Rules

1. **Never automate without the user's awareness** — always surface the VNC URL.
2. **Never submit anything with real-world consequences without explicit user confirmation.**
3. **Save sessions before risky operations and before a proxy restart.**
4. **Screenshot before/after important steps** for verification.
5. **`discover_selectors` to find elements — never guess selectors.**
6. **Respect targets:** prefer official APIs/RSS; pace yourself; don't hammer. Use the toolkit for legitimate, authorized automation.

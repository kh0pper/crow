---
name: crow-browser
description: "Browser automation with stealth — form filling, scraping, screenshots via CDP. Activates when user asks to automate a website, fill forms, scrape data, or interact with web pages."
allowed-tools: ["exec", "message"]
---

# Crow Browser — Browser Automation Skill

You control a headless Chrome browser via CDP (Chrome DevTools Protocol) with anti-detection stealth. The user can watch your actions in real-time via VNC.

## Setup

1. Start the container: `docker compose -f ~/crow-browser/docker-compose.yml up -d`
2. Call `crow_browser_launch` to connect via CDP
3. Give the user the VNC URL so they can watch: `http://localhost:6080/vnc.html`

## Core Workflow

### Navigation & Discovery
1. `crow_browser_navigate` — go to a URL
2. `crow_browser_discover_selectors` — find all interactive elements (inputs, buttons, links)
3. `crow_browser_screenshot` — capture current state for verification

### Form Filling
1. Use `discover_selectors` with `filter: "inputs"` to find form fields
2. `crow_browser_fill_form` with a map of selector → value pairs
3. `crow_browser_screenshot` to verify values were entered correctly
4. `crow_browser_click` to submit

### Human Intervention Points
When you encounter CAPTCHA, 2FA, security questions, or anything that requires human judgment:

1. `crow_browser_screenshot` — show current state
2. `crow_browser_wait_for_user` — pause with a clear message explaining what the user needs to do
3. User completes action in VNC viewer
4. `crow_browser_wait_for_user` with `resume: true` — continue automation

**CRITICAL:** Always pause for human intervention on:
- CAPTCHA / reCAPTCHA
- Two-factor authentication
- Security questions
- Payment confirmations
- Any action with real-world consequences (submitting forms, making purchases)

## Session Management

- `crow_browser_save_session` before long operations — saves cookies + localStorage
- `crow_browser_load_session` to restore if the session times out

## Stealth Features (Automatic)

All interactions use human-like patterns:
- Typing has random per-character delays
- Clicks land at randomized positions within elements
- Navigation includes natural pauses
- Browser fingerprint is spoofed (plugins, screen size, user agent)
- `navigator.webdriver` is masked

## Working with Iframes

Some sites use iframes for forms. Use `discover_selectors` with `frame_selector` to inspect inside iframes:
```
crow_browser_discover_selectors({ filter: "inputs", frame_selector: "iframe#formFrame" })
```

## Error Recovery

- If CDP disconnects: call `crow_browser_launch` with `restart: true`
- If page is stuck: `crow_browser_evaluate` with `location.reload()`
- If session expired: `crow_browser_load_session` to restore cookies
- Check `crow_browser_status` to verify container and connection health

## Rules

1. **Never automate without user awareness** — always provide VNC URL
2. **Never submit forms with real-world consequences without user confirmation**
3. **Save sessions before risky operations**
4. **Screenshot before and after important steps** for verification
5. **Use discover_selectors** to find elements — never guess selectors

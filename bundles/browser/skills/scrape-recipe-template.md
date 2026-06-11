---
name: scrape-recipe-template
description: "TEMPLATE — clone this to write a new scrape/automation recipe for a specific site. Tells the AI WHAT to scrape or automate on one target, using the crow-browser toolkit. Not a live recipe itself; copy it to a new file and fill in the placeholders."
allowed-tools: ["exec", "message"]
---

# Scrape/Automation Recipe Template

> **How to use this file:** copy it to `~/crow/bundles/browser/skills/<your-target>.md` (and add that path to the bundle `manifest.json` `skills[]`, or drop it straight into `~/.crow/skills/` for a quick local recipe). Replace every `<PLACEHOLDER>` and delete guidance you don't need. Keep it **specific** — the value of a recipe is the exact selectors, frame map, and gotchas that took trial-and-error to find, like the `ffff-filing` recipe. The toolkit *how* lives in `crow-browser.md`; this file is the *what* for one target.
>
> The `name:` and `description:` above MUST be rewritten for your target — the `description` is what triggers the recipe, so phrase it around what the user would ask ("Activates when the user asks to <task> on <site>").

# <Recipe Title> — e.g. "Scrape Acme School Board Agendas"

You automate `<SITE / SYSTEM NAME>` (`<BASE_URL>`) using crow-browser. Goal: `<one-sentence outcome>`.

## When to activate

Trigger when the user asks to `<task phrasings: e.g. "get the latest Acme board agendas", "check Acme for new meetings">`.

## Pre-flight checklist

Before starting, verify:
1. crow-browser container is running (`crow_browser_status`); `crow_browser_launch` if not.
2. The user has VNC open to watch (`http://localhost:6080/vnc.html` or the Browser panel) — required if any human-intervention step exists.
3. `<any inputs needed: credentials available? date range? target IDs? output destination?>`
4. `<auth: does this site need login? how — cookies via add_cookies, a saved session via load_session, or a live human login over VNC?>`

## Target page map

Document the structure so you target reliably instead of guessing:

- **Entry URL(s):** `<URL or URL pattern, e.g. https://acme.example.com/meetings?year={YEAR}>`
- **Frames (if any):** `<iframe selectors and what renders in each — most sites have none; ASP.NET/portal/viewer sites often do>`
- **Key selectors** (find with `crow_browser_discover_selectors`; record the *stable* ones):
  - List/rows: `<selector>`
  - Item link: `<selector, e.g. a[href*="Agenda"]>`
  - Pagination "next": `<selector — or note "infinite scroll", use scroll_extract>`
  - Form fields: `<selector → meaning>` (note if `name` is randomized per session → target by `title`/`id`/`placeholder` instead)
  - Download/export trigger: `<selector>`
- **Hidden API (preferred if present):** run `crow_browser_capture_responses` once and note any JSON endpoint that returns the data — scraping the API is more stable than the DOM. Endpoint: `<URL pattern>`; shape: `<fields>`.

## Step-by-step flow

Number the steps; show the exact tool calls. Screenshot before/after important steps.

```
1. crow_browser_navigate({ url: "<ENTRY_URL>", wait_until: "domcontentloaded" })
2. crow_browser_wait_for({ selector: "<list selector>" })
3. <extract: crow_browser_scrape / extract_tables / extract_article / scroll_extract / capture_responses>
4. <paginate or loop over items as needed>
5. crow_browser_export({ data: [...], format: "csv", filename: "<name>" })
```

Describe per-item logic, loops, and stop conditions in prose where a code sketch isn't enough.

## Human-intervention points (VNC)

List every step where you MUST pause for the human (`crow_browser_wait_for_user`, resume with `resume: true`). Always include:
- CAPTCHA / reCAPTCHA
- 2FA / login / security questions
- Payment or final-submit confirmations
- `<any target-specific gate, e.g. "click through the cookie/consent wall">`

If the target has none, say so explicitly: `<"No human-intervention points — fully unattended.">`

## Data shape & export

- **Fields to capture:** `<field: meaning>` for each.
- **Normalization:** `<dates → ISO, strip leading apostrophes, zero-pad IDs, dedupe key, etc.>`
- **Output:** `crow_browser_export` as `<csv|json>` to `~/.crow/browser-exports/<name>`, OR `<other destination — a Crow note, a DB, an email>`.

## Gotchas

Capture the hard-won, site-specific traps (this is the most valuable section — see how detailed `ffff-filing` is):
- `<e.g. "field name attributes randomize per session — target by title">`
- `<e.g. "session times out after ~15 min idle — evaluate something periodically to keep alive">`
- `<e.g. "the PDF loads in a WebViewer iframe — use capture_responses to grab the application/pdf URL instead of reaching into the iframe">`
- `<e.g. "this domain is behind PerimeterX/Cloudflare — expect to add a proxy or rely on the VNC handoff">`
- `<e.g. "rounding / encoding / pagination quirks">`

## Validation

How to know it worked end-to-end:
- `<e.g. "row count matches the site's stated total", "every export row has a non-empty date + URL", "a known record appears with correct values">`
- Re-runnable / idempotent? `<note dedupe so re-runs don't double-collect>`
- **Never** mark the task done on a partial result — report what was collected vs. expected, and surface any items that failed.

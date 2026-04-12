---
name: stirling-pdf
description: Launcher for self-hosted Stirling PDF — 50+ PDF operations in-browser
triggers:
  - "stirling"
  - "merge pdf"
  - "split pdf"
  - "ocr pdf"
  - "compress pdf"
  - "pdf tool"
tools:
  - stirling_status
  - stirling_web_url
---

# Stirling PDF

Stirling PDF is a self-hosted PDF toolbox with 50+ operations: merge, split,
OCR, compress, convert to/from Office formats, rotate, sign, watermark, and
more. Every operation runs **in the browser** — there is no server-side
automation API.

## What this bundle can (and can't) do

This bundle is a launcher:

- `stirling_status` — confirms the Stirling container is up and reachable.
- `stirling_web_url` — returns the URL for the user to open.

There is **no** way for Crow to invoke PDF operations on the user's behalf.
If the user asks "merge these two PDFs", the correct answer is to point
them at the web UI with `stirling_web_url` and explain that Stirling is a
browser-based tool.

## Security note

Stirling PDF 2.x ships with a login form enabled by default. The first
admin account is created through the web UI on first visit. The container
is bound to `127.0.0.1:8092` only — if the user wants to publish it on a
domain, they should install the caddy bundle and route through it.

## Typical interaction

User: "can you compress this PDF?"
Crow:
1. Call `stirling_status` to confirm the container is running.
2. Call `stirling_web_url` and show the URL.
3. Tell the user to open the URL, upload their PDF, and use the "Compress"
   tool. Mention that Stirling runs operations client-side, so nothing is
   uploaded to a third party.

---
title: Home Screen
---

# Home Screen

The Crow's Nest home screen is your app launcher. It shows your panels and installed bundles as a clean tile grid — like a phone home screen.

## What's on the home screen

- **Greeting** — Crow icon, welcome message, and current date
- **Pinned items** — Optional row above the grid for bookmarked conversations, drafts, or projects
- **Panel tiles** — Built-in Crow panels (Messages, Memory, Blog, Files, Skills, Extensions, Settings)
- **Bundle tiles** — Installed Docker add-ons (Ollama, Nextcloud, Immich, etc.)

## Tile ordering

1. Built-in panels appear first, sorted by their navigation order
2. Bundle tiles follow, sorted by install date (oldest first)

## Bundle tile lifecycle

When you install a bundle add-on, its tile automatically appears on the home screen. When you uninstall it, the tile disappears. No manual management needed.

- Bundles with a web UI open it in a new tab when clicked
- Bundles without a web UI link to the Extensions panel
- Running bundles show a green status dot; stopped bundles show a muted dot

## Tile icons

Bundle tiles resolve their icon in this order:

1. **Branded logo** — Official add-ons (Ollama, Nextcloud, etc.) have custom SVG logos
2. **Manifest icon** — The `icon` field in the add-on manifest maps to a feather-style icon
3. **First-letter fallback** — Unknown add-ons show the first letter of their name

Supported manifest icon keys: `brain`, `cloud`, `image`, `home`, `book`, `rss`, `mic`, `message-circle`, `gamepad`, `archive`.

## What doesn't get tiles

- **MCP servers** — Headless integrations with no UI to launch
- **Skills** — Markdown behavior files, visible in the Skills panel
- **Panel add-ons** — Already appear as panel tiles via the panel registry

## Pinned items

Pin conversations, blog drafts, or projects to the home screen for quick access. Pinned items appear in a scrollable row above the main grid. Hover over a pinned item to reveal the unpin button.

## Related

- [Crow's Nest Overview](/guide/crows-nest) — Full dashboard documentation
- [Creating Add-ons](/developers/creating-addons) — How to build add-ons that appear on the home screen
- [Creating Panels](/developers/creating-panels) — How to build dashboard panels

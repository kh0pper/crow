---
name: homepage
description: Launcher for gethomepage/homepage — the YAML-configured startpage. Panel-only; no automation tools.
triggers:
  - "homepage dashboard"
  - "startpage"
  - "service launcher"
  - "dashboard aggregator"
tools: []
---

# Homepage

[gethomepage/homepage](https://gethomepage.dev) is a static startpage that
renders a grid of self-hosted services from YAML config files. This bundle
installs it as a container bound to `127.0.0.1:3030`.

## Why there are no MCP tools

Homepage has no public API. Its config is edited via YAML files on disk
and the page renders statically at request time. There is nothing useful
to wrap in MCP tools, so this bundle ships as **panel-only**: a Crow's
Nest tile that embeds the rendered page in an iframe.

## How the user configures it

Config files live at `HOMEPAGE_CONFIG_DIR` (default `~/.crow/homepage/`).
On first boot the bundle copies skeleton files from the image into that
directory. The operator edits them directly:

- `services.yaml` — tiles for services (with optional API-connected widgets)
- `widgets.yaml` — system/info widgets (CPU, weather, etc.)
- `bookmarks.yaml` — static bookmark groups
- `settings.yaml` — title, theme, layout

Homepage hot-reloads on file change.

## If the user asks for programmatic control

Direct them to edit the YAML files in `~/.crow/homepage/`. There is no
Crow MCP tool to add a service tile programmatically. For a tiles-type
dashboard that _does_ expose an API, suggest the built-in Crow Nest home
screen instead.

## Security note

The container respects `HOMEPAGE_ALLOWED_HOSTS`. Ports bind to
`127.0.0.1:3030` only. If exposing Homepage externally via Caddy, add
the public hostname to `HOMEPAGE_ALLOWED_HOSTS`.

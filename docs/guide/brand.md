---
title: Brand & Design
---

# Brand & Design

Crow's visual identity is the **Dark Editorial** design system — dark surfaces with iridescent indigo accents, inspired by the shimmering plumage of corvid birds.

## Design Philosophy

Dark surfaces. Indigo accents. Technological warmth. The aesthetic evokes a crow's feathers catching light — dark at rest, iridescent in motion. The design is editorial (clean typography, generous whitespace) but not sterile (warm stone tones, subtle texture).

## Color Palette

### Dark Theme (default)

| Token | Hex | Usage |
|-------|-----|-------|
| `--crow-bg-deep` | `#0f0f17` | Page background |
| `--crow-bg-surface` | `#1a1a2e` | Card/panel backgrounds |
| `--crow-bg-elevated` | `#2d2d3d` | Input backgrounds, elevated surfaces |
| `--crow-border` | `#3d3d4d` | Borders and dividers |
| `--crow-text-primary` | `#fafaf9` | Main text |
| `--crow-text-secondary` | `#a8a29e` | Secondary text |
| `--crow-text-muted` | `#78716c` | Metadata, labels, hints |
| `--crow-accent` | `#6366f1` | Primary indigo — links, buttons, active states |
| `--crow-accent-hover` | `#818cf8` | Hover state (lighter indigo) |
| `--crow-accent-muted` | `#2d2854` | Accent backgrounds (tags, badges) |
| `--crow-brand-gold` | `#fbbf24` | Active navigation indicator |
| `--crow-success` | `#22c55e` | Success states, connected |
| `--crow-error` | `#ef4444` | Error states, destructive actions |
| `--crow-info` | `#38bdf8` | Informational highlights |

### Light Theme

| Token | Hex |
|-------|-----|
| `--crow-bg-deep` | `#fafaf9` |
| `--crow-bg-surface` | `#ffffff` |
| `--crow-bg-elevated` | `#f5f5f4` |
| `--crow-border` | `#e7e5e4` |
| `--crow-text-primary` | `#1c1917` |
| `--crow-text-secondary` | `#57534e` |
| `--crow-text-muted` | `#a8a29e` |
| `--crow-accent` | `#4f46e5` |
| `--crow-accent-hover` | `#6366f1` |
| `--crow-accent-muted` | `#e0e7ff` |

### Serif Theme (blog reading)

Overrides the body font to `Fraunces` serif for a more literary reading experience. All other tokens inherit from the active base theme (dark or light).

## Typography

| Role | Font | Weights | Usage |
|------|------|---------|-------|
| **Display** | Fraunces | 400, 600, 700 | Headings, hero text, stat numbers |
| **Body** | DM Sans | 400, 500, 700 | Body text, labels, buttons |
| **Code** | JetBrains Mono | 400, 500 | Code blocks, Crow IDs, monospace data |

All fonts are loaded from Google Fonts.

## Spacing & Radius

**Spacing scale** (rem-based):
- `0.25rem` (4px) — tight gaps
- `0.5rem` (8px) — compact spacing
- `0.75rem` (12px) — standard padding
- `1rem` (16px) — section spacing
- `1.5rem` (24px) — card padding
- `2rem` (32px) — large gaps

**Border radius tiers:**
- `4px` — small (badges, inline elements)
- `8px` — medium (cards, inputs, panels)
- `12px` — large (modal dialogs, hero sections)

**Shadows:**
- Cards: `0 1px 3px rgba(0,0,0,0.2), 0 0 0 1px rgba(99,102,241,0.05)`
- Elevated: `0 4px 12px rgba(0,0,0,0.3)`

## Themes

Crow supports three visual themes:

- **Dark** (default) — Dark Editorial with indigo accents. Used everywhere by default.
- **Light** — Inverted palette for bright environments. Stone-warm backgrounds.
- **Serif** — Applies Fraunces serif font for blog reading. Combines with dark or light.

Theme is toggled via the Crow's Nest header or the `blog_theme` setting.

## SVG Assets

| Asset | Location | Usage |
|-------|----------|-------|
| `crow-hero.svg` | `docs/public/` | Hero crow illustration (gradients: `#2d2d3d` body, `#6366f1` sheens) |
| `grackle-pattern.svg` | `docs/public/` | Decorative background texture |
| `icon-*.svg` | `docs/public/` | Feature icons (MCP, memory, research, sharing, integrations, deploy, platforms) |
| Addon logos | `servers/gateway/dashboard/shared/logos.js` | SVG logos for Ollama, Nextcloud, MinIO, Immich, Obsidian, Home Assistant, Podcast |

## For Developers

All color tokens are defined in a single source of truth:

```
servers/gateway/dashboard/shared/design-tokens.js
```

Both the Crow's Nest dashboard (`layout.js`) and the public blog (`blog-public.js`) import from this file. When adding new colors or modifying the palette, edit `design-tokens.js` — the change propagates to both surfaces automatically.

See the [Customization guide](/guide/customization) for how users can adjust themes and appearance.

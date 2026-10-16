---
name: design-themes
description: Apply the owner's chosen house style (a named theme of colours and a font pair). Used only when a house style is set. Ported from Anthropic's theme-factory skill (Apache-2.0).
triggers: ["house style", "theme", "brand colours"]
license: Apache-2.0 — complete terms in third_party/anthropic-skills/theme-factory/LICENSE.txt; changes are listed in NOTICE.
---

Modified from anthropics/skills `theme-factory` (Apache-2.0); full licence text and change list ship in the Design kit bundle (LICENSES.md, NOTICE).

# Theme Factory Skill

This skill provides a curated collection of professional font and color themes themes, each with carefully selected color palettes and font pairings. Once a theme is chosen, it can be applied to any artifact.

## Purpose

To apply consistent, professional styling to pages, documents and diagrams, use this skill. Each theme includes:
- A cohesive color palette with hex codes
- Complementary font pairings for headers and body text
- A distinct visual identity suitable for different contexts and audiences

## Usage Instructions

In Crow the owner chooses the theme, as the house style of a project or of a bot; you do not show a showcase or ask for a choice. See *Using the Design kit in Crow* below: it says when this skill applies and how the chosen theme reaches the artifact.

## Themes Available

The following 10 themes are available:

1. **Ocean Depths** - Professional and calming maritime theme
2. **Sunset Boulevard** - Warm and vibrant sunset colors
3. **Forest Canopy** - Natural and grounded earth tones
4. **Modern Minimalist** - Clean and contemporary grayscale
5. **Golden Hour** - Rich and warm autumnal palette
6. **Arctic Frost** - Cool and crisp winter-inspired theme
7. **Desert Rose** - Soft and sophisticated dusty tones
8. **Tech Innovation** - Bold and modern tech aesthetic
9. **Botanical Garden** - Fresh and organic garden colors
10. **Midnight Galaxy** - Dramatic and cosmic deep tones

## Theme Details

Each theme's palette and font pair ship with the Design kit as a stylesheet of CSS custom properties (listed below). You do not read theme files yourself.

## Application Process

After the house style is set:
1. Use only the theme's custom properties for colour and type
2. Apply the specified colors and fonts consistently throughout the artifact
3. Ensure proper contrast and readability
4. Maintain the theme's visual identity across every section, slide-like screen or shape

## Create your Own Theme
Custom themes are not available in Crow: a house style is one of the ten themes below. When none is set, this skill does not apply; the design-frontend skill guides your choices.

## Using the Design kit in Crow

This skill applies **only when a house style is set** for your project or for you. You are told the theme's name. Crow adds `theme:<id>` (its fonts and palette) to every artifact you save; you do not list it yourself.

Use its CSS custom properties and nothing else for colour and type: `--hs-bg`, `--hs-fg`, `--hs-accent`, `--hs-accent-2`, `--hs-font-heading`, `--hs-font-body`. In a document or a diagram they already style the body, headings and links. In a page, first `<link rel="stylesheet">` each file your house-style instructions name (the fonts' `font.css`, then `__lib/themes/<id>.css`; the save result repeats them as `house_style_links`), then use the variables in your own CSS (`background: var(--hs-bg)`). Do not pick other colours or fonts while a house style is set.

Themes:
- `theme:arctic-frost` — Arctic Frost
- `theme:botanical-garden` — Botanical Garden
- `theme:desert-rose` — Desert Rose
- `theme:forest-canopy` — Forest Canopy
- `theme:golden-hour` — Golden Hour
- `theme:midnight-galaxy` — Midnight Galaxy
- `theme:modern-minimalist` — Modern Minimalist
- `theme:ocean-depths` — Ocean Depths
- `theme:sunset-boulevard` — Sunset Boulevard
- `theme:tech-innovation` — Tech Innovation

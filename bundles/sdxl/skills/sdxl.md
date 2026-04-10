---
name: sdxl
description: "Generate and manage AI backgrounds for the companion avatar using SDXL Turbo. Activates when user asks to generate a background, change the background, or manage the background gallery."
allowed-tools: ["crow_generate_background", "crow_list_backgrounds", "crow_set_background"]
---

# SDXL Background Generator

Generate dynamic backgrounds for the AI Companion using SDXL Turbo (stills) and SVD img2vid-xt (animation).

## Available Tools

- `crow_generate_background` — Generate a new background image from a text prompt
- `crow_list_backgrounds` — Browse the gallery of previously generated backgrounds
- `crow_set_background` — Set a gallery image as the current companion background

## Usage Notes

- SDXL Turbo generates 1024x576 images in ~2-4 seconds on consumer GPUs
- First generation takes 15-25 seconds (model loading)
- The companion frontend auto-refreshes when a new background is set
- Gallery persists across container restarts via Docker volume
- Use `/unload` on the SDXL service to free VRAM when not in use

## Prompt Tips

- Describe the scene, mood, and lighting ("cozy study with warm lamplight")
- The negative prompt defaults to filtering out text, watermarks, and blur
- Backgrounds work best at 1024x576 (16:9 widescreen) for the companion view

---
name: romm
description: Browse, organize, and play retro games via the RoMM web library
triggers:
  - retro games
  - what games do I have
  - browse my library
  - play a game
  - add ROMs
  - game library
  - emulator
  - romm
tools:
  - crow-memory
---

# RoMM Integration

## When to Activate

- User asks about their game library or what games they have
- User wants to browse, search, or organize retro games
- User mentions ROMs, emulators, or retro gaming
- User wants to play a specific game
- User wants to add new ROMs or organize their collection

## How It Works

RoMM is a self-hosted retro game library manager with a browser-based UI. It scans a local ROM directory, enriches games with metadata and cover art (via IGDB), and provides in-browser emulation for supported platforms.

**Web UI:** `http://localhost:3080` (or the configured host/port)

The AI assists with ROM organization, configuration, and navigation. Actual gameplay happens in the browser through RoMM's built-in emulator.

## Workflow 1: Browse the Game Library

Direct the user to the RoMM web UI to browse their collection:

1. Confirm RoMM is running: "Your game library is at http://localhost:3080"
2. Games are organized by platform — the UI shows cover art, metadata, and play buttons
3. To play a game, click it in the web UI and use the built-in emulator

## Workflow 2: Add New ROMs

Help the user organize ROM files correctly:

1. ROMs must be in the library path configured during setup (`ROMM_LIBRARY_PATH`)
2. Files should be organized into system subdirectories:
   ```
   roms/
     gba/          # Game Boy Advance
     gbc/          # Game Boy Color
     gb/           # Game Boy
     snes/         # Super Nintendo
     nes/          # Nintendo Entertainment System
     n64/          # Nintendo 64
     nds/          # Nintendo DS
     sega-genesis/ # Sega Genesis / Mega Drive
     psx/          # PlayStation
     psp/          # PlayStation Portable
   ```
3. After adding files, trigger a rescan from the RoMM web UI (Settings > Scan Library)
4. RoMM will automatically match games and pull metadata if IGDB credentials are configured

## Workflow 3: Metadata Enrichment

If games show up without cover art or descriptions:

1. Check if IGDB credentials are set (IGDB_CLIENT_ID and IGDB_CLIENT_SECRET)
2. IGDB credentials are free — sign up at https://api-docs.igdb.com/
3. After adding credentials, restart the RoMM container and rescan the library
4. RoMM will match ROM filenames to IGDB entries and pull cover art, descriptions, and ratings

## Supported Platforms

RoMM supports most retro systems through its built-in emulators. Common ones include:

- Nintendo: NES, SNES, N64, GB, GBC, GBA, NDS
- Sega: Master System, Genesis/Mega Drive, Game Gear
- Sony: PlayStation (PSX), PSP
- Atari: 2600, 7800
- Others: TurboGrafx-16, Neo Geo, Arcade (MAME)

## Tips

- Use clear, standard ROM filenames — RoMM matches metadata based on the filename
- Keep BIOS files in the appropriate system directory if needed (some emulators require them)
- Store the user's library path and platform preferences in Crow memory for future reference
- If the user has a large collection, suggest organizing by system first before scanning

## Error Handling

- If RoMM is unreachable: "RoMM doesn't seem to be running. Start it with `crow bundle start romm` or `docker compose up -d` in the romm bundle directory."
- If no games appear: "Make sure your ROM files are organized into system subdirectories (e.g., roms/gba/, roms/snes/) and trigger a library scan from Settings in the web UI."
- If metadata is missing: "IGDB credentials may not be configured. They're free — sign up at https://api-docs.igdb.com/ and add IGDB_CLIENT_ID and IGDB_CLIENT_SECRET to your bundle config."

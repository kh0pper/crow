---
title: Studio
---

# Crow Studio

Crow Studio is a shared music studio: you in the dashboard and an AI agent over MCP edit **one live song** together. There is no "your copy" and no save step — every edit lands in the same song, appears in every open window as it happens, and is one undoable step in a shared history.

## Songs live in projects

Every song belongs to a [project space](/guide/workspace). The project decides who may write, and the song document, its history and its renders stay on the Crow instance that owns the project.

A project's bot only ever sees the songs of its **own** project: a song in another project answers exactly like a song that does not exist. Crow's voice can read any song, but it cannot change one.

## The screen

- **Session grid** — tracks as columns, scenes as rows. An empty cell makes a one-bar clip; a filled cell opens it in the editor.
- **Track headers** — the [SunVox](https://warmplace.ru/soft/sunvox/) instrument for the track, mute/solo, gain and pan, and the lock.
- **Clip editor** — a piano roll: click an empty cell to add a note, drag a note to move it, <kbd>Delete</kbd> to remove the selected note, and the clip's length in bars. Notes are pitches and velocities inside a clip that loops over its length.
- **Transport** — play/stop, the tempo, and a bar.beat.sixteenth position. A scene's launch button starts it on the next bar.
- **History** — every step, newest first, with who made it. Undo any step; redo puts it back.

Every edit is a registry command, so the dashboard, the agent and the history all speak the same vocabulary — what you do with a button and what a bot does with a tool are the same step.

## Two hands on the same song

An agent's edits are drawn **in blue** next to yours (yours are amber), and each one is a history step you can undo. An undo restores only what is still unchanged: a field that was edited again since comes back as an inline conflict, and the newer edit is left alone rather than clobbered.

Agents are held back from the parts you are using:

- **A locked track is off-limits.** Lock a track in its header to keep the agent off it, and unlock it to let the agent work again. Only a person can lock or unlock a track, and an agent cannot take back someone's lock by undoing it.
- **The clip you have open is off-limits** while the editor is open on it.
- Agents never start or stop your playback.

## Letting a bot use Studio

Studio's tools (`studio_*`) are an extension. A bot gets them when you enable the **Studio** extension for that bot in [Bot Builder](/guide/bot-builder); it can then list and edit its own project's songs, one command per tool call.

Your own coding agent — Claude Code and any other MCP client — reaches Studio through the gateway's tools MCP. The Studio MCP server itself speaks stdio only and opens no network port; the gateway serves the panel, the live sync socket and the agent API.

### Ask the agent

A song page carries an **Ask the agent** box. It opens a chat with the song project's bot — the bot whose home project is that project — and shows the bot's replies underneath as they arrive. If the project has no bot yet the box stays disabled and says so. If the bot engine is not running, or the bot has no chat channel set up (Bot Builder → Perch), the box says that instead of failing silently.

## Renders and loudness

The bot can render the song, one scene, or one clip through the same engine your browser plays, and it hears the result through that render. Each render is written into the project's storage as a WAV and reports its **integrated loudness** (LUFS) and **true peak** (dBTP), so a mix can be compared by numbers rather than by memory. Renders are limited in length by the instance's setting (see below).

## Limits

| Limit | Value | Setting |
|---|---|---|
| SunVox tracks per song | 16 | — |
| Notes per clip | 4096 | — |
| Scenes per song | 64 | — |
| Clip length | 64 bars | — |
| Render length | 300 s | `STUDIO_MAX_RENDER_SECONDS` |
| Concurrent renders per MCP process | 1 running, up to 3 waiting, then refused | — |
| Songs per project | 500 | — |

Every limit refuses with a plain-English error that names it; nothing is ever truncated to fit.

## Credits

> Powered by SunVox (modular synth & tracker) Copyright (c) 2008 - 2026, Alexander Zolotov <nightradio@gmail.com>, WarmPlace.ru

Studio's engine runs SunVox (the WebAssembly build of the SunVox library) so the browser and the server's offline renders use the same synthesizer. The full licence texts — SunVox's own, plus the tremor.txt, sundog.txt and libflac.txt notices from the SunVox archive — ship with the bundle in `bundles/studio/vendor/sunvox/THIRD-PARTY-NOTICES.txt`.
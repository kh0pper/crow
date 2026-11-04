---
title: Studio
---

# Crow Studio

Crow Studio is a shared music studio: you in the dashboard and an AI agent over MCP edit **one live song** together. There is no "your copy" and no save step — every edit lands in the same song, appears in every open window as it happens, and is one undoable step in a shared history.

## Songs live in projects

Every song belongs to a [project space](/guide/projects). The project decides who may write, and the song document, its history and its renders stay on the Crow instance that owns the project.

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

Studio is an extension: its tools (`studio_*`) are how a bot lists and edits its own project's songs, one command per tool call.

Installing Studio restarts the gateway; the Studio page, its live connection and the agent tools start after that.

To give a bot those tools, open it in [Bot Builder](/guide/bot-builder) → the bot's **Abilities** tab → set the **Studio** row to **Read-only** or **All**. *Read-only* lets it look at songs; *All* lets it edit them, under the rules above (locked tracks, the clip you have open, your playback).

The **Ask the agent** box is a chat, so it needs the bot's **Perch** channel too ([Bot Builder](/guide/bot-builder) → **Basics** → channel → **Perch (dashboard chat)**). Tools without a channel are still usable by a coding agent; the box just has nothing to talk to.

Your own coding agent — [Claude Code](/platforms/claude-code) and any other MCP client — reaches Studio through the gateway's tools endpoint at `/tools/mcp`. The Studio MCP server itself speaks stdio only and opens no network port; the gateway serves the panel, the live sync socket and the agent API.

### Ask the agent

A song page carries an **Ask the agent** box. It opens a chat with the song project's bot — the bot whose home project is that project — and shows the bot's replies underneath as they arrive. The chat is remembered per song for the tab, so coming back to it carries on where you left off. If the project has no bot yet the box stays disabled and says so. If the bot engine is not running, or the bot has no chat channel set up (Bot Builder → Perch), the box says that instead of failing silently.

## Renders and loudness

The bot can render the song, one scene, or one clip through the same engine your browser plays, and it hears the result through that render. Each render is written into the project's storage as a WAV and reports its **integrated loudness** (LUFS) and **true peak** (dBTP), so a mix can be compared by numbers rather than by memory. Renders are limited in length by the instance's setting (see below).

## Recording takes

Add an **audio track** (**+ Audio track**) to record a guitar, a voice or anything else through your audio interface.

1. **Calibrate once per interface.** Connect a cable from an output of your interface to an input, open the track's latency chip (**Not calibrated — Calibrate…**) and press Start. Studio plays a few clicks and measures how late they come back, then uses that delay to line every take up with the song. A take recorded without calibration is marked *uncompensated*; calibrate later and ask the bot to correct its timing.
2. **Arm** the audio track and pick its input. Studio asks your browser for the raw input, with echo cancellation, noise suppression and auto gain turned off, and warns you if the browser keeps any of them on.
3. Press **Record**, then launch a scene. Recording starts on that scene's first bar (or on the next bar if the song is already playing). An empty slot gets an audio clip as long as the scene's longest clip.
4. Press **Stop**. The take ends at the end of the loop pass you are in. If the clip looped while you played, **each pass becomes its own take**.

Hear yourself through your interface's **direct-monitor knob**: it has no delay. **Monitor through Studio** is there too, and tells you how late you would hear yourself.

**Nothing is lost if the connection drops.** Every piece of a take is saved on this device first and then uploaded to the project's storage. A take recorded offline, or interrupted by a reload, uploads (or is recovered) the next time the song is open. Until then its row says so.

**Takes and comps.** Select an audio clip to see its takes, newest first. **Keep** plays one take over the whole clip; **Discard** and **Restore** hide and bring back a take; drag across the comp bar with a take selected to use it for just that part (Shift snaps to a quarter beat). Every change is one undoable step. **Remove from this device** clears the downloaded take audio from this browser; it stays on Crow.

**What the bot can do with takes.** It can list them, keep one, comp them, restore a discarded one and correct a take's timing, and it hears them in its renders. It can never record, add or discard a take, or remove a clip, track or scene that holds takes: those need you.

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
| Take length | 1200 s of 48 kHz stereo (115,200,000 samples) | `STUDIO_MAX_TAKE_SECONDS` |
| Takes per clip | 64 | — |
| Recording channels and rates | 1 or 2 channels; 44.1, 48, 88.2 or 96 kHz | — |

Every limit refuses with a plain-English error that names it; nothing is ever truncated to fit.

## Known limits

- **Your own MCP session sees every song.** A coding agent connected as you (an MCP session on this instance) is not a bot: the project filter is a bot rule, not a permission, and a session with the owner's access can read and edit any song on the instance it can reach. Studio is single-operator in this phase.
- **Calls through the gateway's shared tools endpoint with the gateway token count as you.** Every MCP caller is recorded as an agent, but only a Crow bot running its own copy of Studio's tools is limited to its project. A client that reaches Studio through the gateway's `/tools/mcp` (or the router) with the gateway token is treated as the owner, with every song — even a device bridge that calls itself a bot over that endpoint, such as the companion. That token already grants owner access to every gateway tool, so Studio adds nothing it did not already allow.

## Credits

> Powered by SunVox (modular synth & tracker) Copyright (c) 2008 - 2026, Alexander Zolotov <nightradio@gmail.com>, WarmPlace.ru

Studio's engine runs SunVox (the WebAssembly build of the SunVox library) so the browser and the server's offline renders use the same synthesizer. The full licence texts — SunVox's own, plus the tremor.txt, sundog.txt and libflac.txt notices from the SunVox archive — ship with the bundle in `bundles/studio/vendor/sunvox/THIRD-PARTY-NOTICES.txt`.
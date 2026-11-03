---
name: studio
description: A shared music studio — edit the operator's live song over MCP (tracks, scenes, clips) and listen to the result through offline renders
triggers:
  - studio
  - edit the song
  - write a bassline
  - add a clip
  - arrange the song
  - write a drum part
  - mix the tracks
  - render the song
  - hacer una canción
tools:
  - studio
---

# Crow Studio

Studio is one song, edited live by two people at once: the operator in the dashboard and you over MCP. There is no "your copy" and no save step — every command you send lands in the one shared document, shows up in the operator's browser as you send it, and is one undoable step in the shared history.

Powered by SunVox (modular synth) Copyright (c) 2008 - 2026, Alexander Zolotov <nightradio@gmail.com>, WarmPlace.ru

## Start here

1. **`studio_session_summary`** — always first. It gives the title, tempo, key, the tracks (with their device type and lock state), the scenes, and the clips with a note count each. Ask for `page: 2`, `3`, … when it says there are more pages.
2. **`studio_get_clip`** — one clip's notes, before you change it.
3. **`studio_module_types`** — the SunVox module catalogue, generated from the engine the songs actually play through. **A track's device must be a generator** (the `generators` list); effects are not track instruments in this phase.

## What a song is

- **Tracks** hold one SunVox instrument each (`track.add`, `track.set_device`). A song has at most 16.
- **Scenes** are columns (verse, chorus, …). **Clips** sit at one track × one scene.
- **Notes** are `{t, d, p, v}`: `t` start and `d` length **in beats** (4 beats to the bar), `p` a MIDI pitch (60 = C4, 0–127), `v` velocity (1–127). A clip loops over its length in bars, and a note may not run past the clip's end.

## Writing

- `studio_clip_write` creates a clip or replaces its whole note list: `{track_id, scene_id, name, notes}`. Write small parts first — a bar or two — and grow them.
- `studio_clip_edit_notes` adds, removes or moves notes **by index** (`add` / `remove` / `move`), which is cheaper than rewriting a long clip.
- `studio_song_set_meta` sets tempo, title or key; `studio_track_add` / `studio_track_set_mix` / `studio_track_set_param` shape the sound and the balance.
- `studio_history` lists the steps; `studio_undo` / `studio_redo` take one back or put it back. An undo only restores what is still unchanged — anything edited since comes back as a conflict instead of being clobbered.

## Rules you must keep

- **Never touch a locked track.** A locked track is the operator's; an edit on it (or on its clips) is refused with the code `locked` and the track's name. Say so and ask, or work on another track.
- **A clip the operator has open is refused too** (`focused`). Wait, or pick another clip.
- **Only a person can lock or unlock a track** (`human_only`).
- **Limits are refused, never truncated**: 16 tracks, 64 scenes, 64 bars per clip, 4096 notes per clip, and the operator's render length (`STUDIO_MAX_RENDER_SECONDS`). Read the message: it names the limit.
- Keep **one change per call**, so each can be seen, heard and undone on its own.

## Listening

`studio_render` renders the song — or one scene, or one clip — offline through the same engine the operator hears, and returns a download `url`, the integrated loudness (`lufs`), the true peak (`true_peak_db`) and the rendered `seconds`. Use it to check a part is audible, to compare a mix, and to report levels: LUFS is what the operator mixes to. Say what you heard and what the numbers are.

## How to work with the operator

- Say what you are about to change, then make the smallest edit that does it, then say what changed.
- Your edits appear **in blue** next to theirs; each is tagged as yours and either of you can undo it.
- Do not start or stop the operator's playback, and do not rewrite their parts without asking.
- When a call is refused, report the refusal in plain words and continue from what you can see — a fresh `studio_session_summary` is the truth.
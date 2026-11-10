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

The bot can render the song, one scene, or one clip through the same engine your browser plays, **chains and all**, and it hears the result through that render. Each render is written into the project's storage as a WAV and reports its **integrated loudness** (LUFS), its **true peak** (dBTP) and the **highest short-term figure** (3 s window) the master meter read while it played, all measured on the final output — after the master's own chain. It also reports the song's target and whether the render **meets** it: the loudness within 1 LU of the target and the true peak at or under its ceiling. Renders are limited in length by the instance's setting (see below).

## Instruments

**+ Instrument** adds a **soundfont track**: a track that plays one **preset** of one **bank** — a SoundFont (SF2 or SF3) file in the song's library, the list of instruments the song can use. Select a preset in the track header and the change is one undoable step; the song's banks belong to the song, so every track can share one.

**Get the default instruments.** A new track with no bank says where they come from, and **Get the default instruments** downloads the vetted default bank (MuseScore General) once for this Crow, checked against its published sha256 before anything is kept. Its credit line shows under the picker, and so does every bank's licence. A track whose bank this device does not have says **Get this instrument** instead: press it and the preset list appears. Nothing is re-downloaded for the next song that wants the same bank.

**Your own bank.** **Add your own bank…** uploads an SF2 or SF3 file you own. Studio checks the file's type and size in the browser and again on the server and never parses it outside the audio engine. Under the button it says it plainly: *For your own use: you are responsible for this bank's licence.* A bank can be up to 512 MB, a song can hold 32 of them, and the song's library can hold 256 entries in all.

**Loads when you stop.** A bank is parsed only while the transport is stopped, because parsing it during playback would break the sound. A bank you pick while the song is playing parses when you press Stop, and the track says *Loads when you stop.* until it has. A bank this browser cannot read — a corrupt download, a file that is not really a bank — plays silence and says why on the track; a render that could not load one names it in its `missing_library` list.

**Presets.** The list is read from the bank itself, so it is the bank's own instruments, not a guess: `bank:program Name`, with bank 128 the General MIDI drum bank, where the program picks the drum kit and the note picks the drum (the bot's skills carry the 35–81 drum map).

**What the bot can do with instruments.** It reads the library — id, name, licence, credit, and which tracks play each bank — and it picks presets, one undoable step each, outlined in its colour like any other agent edit. It cannot add a bank to the song, download one, or point a track at a different bank: those are your actions, and Studio refuses it with *Only the operator changes the instrument a track plays.* A bank that a track plays cannot be removed from the library at all until that track plays another one.

**Credits.** Every bank's licence and credit are shown where the instrument is chosen and in the library list, and a render's metadata carries a `credits` list of the banks it heard.

## Mixer

Every track, every return and the master has its own strip, and the mixer screen — the **Mixer** button beside Session and Arrangement — draws them in that order: your tracks, then the returns, then the master on the right. At phone width the strips scroll sideways inside their own box.

**Effects.** Each strip holds a **chain** of up to eight effects, run top to bottom. Press **+ effect** to pick one — equalizer, filter, delay, reverb, chorus, phaser, saturation, compressor, limiter, gate, de-esser, or the **Amp** (see **Amp and cabinet** below) — and drag to reorder, or use the switch on an effect to **bypass** it without losing its settings. Opening an effect shows its own controls with their real ranges, and each change is one undoable step. A chain edit while the song plays crossfades over 64 frames, so it does not click.

**Sends and returns.** **+ return** makes a strip of its own (a reverb or a delay, typically) with its own chain and level. Every track's strip has a **Sends** control: pick a return and a level, −60 to +6 dB, and choose whether the send is taken **after** the fader (the usual choice, so pulling the fader down takes the reverb with it) or **before** it. One track can feed up to eight returns, a song holds up to eight returns, and a return still fed by a send cannot be removed until the send is gone.

**The master and its target.** The master strip has a **Level** (−24 to +12 dB), the song's **Target in LUFS** with its **True-peak ceiling**, and its own chain — the limiter belongs there, last. The target picker offers **−14 LUFS — streaming services turn louder songs down to about this** (so **−14 LUFS is a reference, not a delivery rule**), **−16 LUFS — speech**, and **Custom** (anywhere from −30 to −6 LUFS), with a ceiling of −6 to −0.1 dBTP (default −1). The pick is one undoable step.

**The limiter's look-ahead.** The master limiter is the one effect in Studio with look-ahead: 1.5 ms, shown under the master strip as **Limiter look-ahead: 1.5 ms**. Everything on a track or a return is zero-latency by rule, so the mix you hear and the mix a render measures line up; a limiter on a track works as a clipper instead, without the delay or the ceiling guarantee.

**An agent's mix pass.** The bot can build chains, set every effect's parameters, add returns, set sends and set the master's level and target — each step undoable, and a run of them outlined in the bot's colour under a banner with **Hear: before (A/B)** / **Hear: after (A/B)** and **Undo pass**. A/B plays the song as it was *before* the pass without changing anything, so you can hear the difference in place; it leaves the moment you change anything. **Undo pass** takes the pass back newest step first, stopping at the first step you changed since and telling you which one. **Undo** on a single step still works exactly as it does anywhere else.

**When an effect fails.** If an effect produces a sample that is not a number — a broken build, a hostile setting — Studio catches it at that effect's output, replaces the block with the signal that went in, bypasses the effect **in the engine** (never in the song) and says so once on the strip: *"&lt;effect&gt; on &lt;track&gt; produced an invalid sample; it is bypassed."* The rest of the chain plays. Moving that effect's own parameters (or its bypass switch) arms it again. A render reports such an effect in its `effect_problems` list rather than failing, and the same goes for a compiled effect this build does not have.

**What the bot cannot do.** It cannot remove a sound: swapping an amp's capture or cabinet (see **Amp and cabinet**), taking a pad's sample, replacing a track's bank or taking back a library file are all your steps. What it may do is the mix itself, which is why every mixer step is an ordinary undoable field.

## Amp and cabinet

**+ effect → Amp** on a guitar's track adds an **amp**: a NAM capture (the amplifier, recorded) played through a cabinet **impulse response** (the speaker, measured). An amp is the one insert whose sound is a *file you chose*, so picking it opens its own editor rather than adding a silent effect: choose a capture and the amp exists, from that one undoable step.

**The starter sounds.** Studio ships one starter capture and five starter cabinets inside the bundle, so a guitar track can sound like a guitar on the first day. The capture is the **NAM example A2 model**, shown as *Starter capture (NAM example model)* — a training example whose source amplifier is unknown, so it carries no amplifier name — by Steven Atkinson (NeuralAmpModelerCore), MIT. The five cabinets are from **"Impulse Responses" by David Fau Casquel** (archive.org/details/ImpulseResponses), **CC BY 3.0**, unmodified: *Cabinet 1 (AmpMix)*, *Cabinet 2 (AmpMix2)*, *Cabinet 3 (Axhom)*, *Cabinet 4 (Bestplugins)* and *Cabinet 5 (Mixxx)*. Each one's credit line rides on its own entry in the picker (the option carries it), the line under the picker names the sound the amp currently plays, and the bundle's `library/files/NOTICES.md` carries every file's source, licence and credit.

**Your own captures and cabinets.** **Add your own capture…** takes a `.nam` file and **Add a cabinet IR…** takes a WAV or AIFF. Both belong to the song's library, both are checked before they are stored, and both are your actions alone. Two rules:

- **A capture must be an A2 model.** Any older NAM format is refused with *"This capture uses an older NAM format; Studio plays A2 captures. Re-export it with a current NAM trainer."*
- **A cabinet is at most one second long.** The check allows a few frames of tolerance (two at 44.1 kHz, a few more at higher rates, so a one-second file still fits after it is converted to your interface's rate): a 44.1 kHz cabinet of 44101 frames loads; a longer one is refused with its own length in the sentence.

**The amp editor.** The capture picker, the cabinet picker (**No cabinet** is a choice) and three numbers: **input** (−24 to +24 dB, the drive into the capture), **output** (−24 to +12 dB) and **IR mix** (0–1, how much of the cabinet you hear). A capture or a cabinet you chose says **Only you can change this amp's capture.** beside it — the bot may set the three numbers, move the amp, bypass it or build you an amp from a capture the song already holds, but never swap or remove the capture and cabinet you picked.

**Monitoring through the chain.** On an armed audio track, **Hear the chain while recording** sends your input through that track's effects *and its amp*, so you hear the sound you are about to record while you play. Studio is honest about the delay: the switch shows your interface's measured round trip, and **Adds N ms** is what the chain itself adds — the amp's capture and cabinet are why it is not zero. The take is still recorded **dry** (the input, before the amp), so the amp is a choice you can change afterwards and never a decision baked into the recording. On a Chromebook or a phone the page asks the capture engine for its **slim** size, which is lighter on the processor; that choice is a property of the page and is never written into the song.

## Recording takes

Add an **audio track** (**+ Audio track**) to record a guitar, a voice or anything else through your audio interface.

1. **Calibrate once per interface.** Connect a cable from an output of your interface to an input, open the track's latency chip (**Not calibrated — Calibrate…**) and press Start. Studio plays a few clicks and measures how late they come back, then uses that delay to line every take up with the song. A take recorded without calibration is marked *uncompensated*; calibrate later and ask the bot to correct its timing.
2. **Arm** the audio track and pick its input. Studio asks your browser for the raw input, with echo cancellation, noise suppression and auto gain turned off, and warns you if the browser keeps any of them on.
3. Press **Record**, then launch a scene. Recording starts on that scene's first bar (or on the next bar if the song is already playing). An empty slot gets an audio clip as long as the scene's longest clip.
4. Press **Stop**. The take ends at the end of the loop pass you are in. If the clip looped while you played, **each pass becomes its own take**.

Hear yourself through your interface's **direct-monitor knob**: it has no delay. **Hear the chain while recording** is there too — it puts your input through the track's effects and amp — and tells you how late you would hear yourself, and what the chain itself adds.

**Nothing is lost if the connection drops.** Every piece of a take is saved on this device first and then uploaded to the project's storage. A take recorded offline, or interrupted by a reload, uploads (or is recovered) the next time the song is open. Until then its row says so.

**Takes and comps.** Select an audio clip to see its takes, newest first. **Keep** plays one take over the whole clip; **Discard** and **Restore** hide and bring back a take; drag across the comp bar with a take selected to use it for just that part (Shift snaps to a quarter beat). Every change is one undoable step. **Remove from this device** clears the downloaded take audio from this browser; it stays on Crow.

**What the bot can do with takes.** It can list them, keep one, comp them, restore a discarded one and correct a take's timing, and it hears them in its renders. It can never record, add or discard a take, or remove a clip, track or scene that holds takes: those need you.

## The sampler

A **sampler track** plays a **kit**: banks of 16 pads, each pad holding one sample or one slice of a sample. Its clips are **patterns** rather than notes: 16 step buttons per page, up to four pages, and each step fires one pad at a velocity. A sample belongs to the song, not to the track, so two pads or two tracks can play the same sound.

**Making a sampler track.** **+ Sampler** adds a track with one bank of pads, A. Press a pad to hear it, or use keys 1–8 and Q–I for the first sixteen; a pad whose sample is still uploading says **Uploading…** and plays nothing. Select a pad to see its settings — mode (one-shot plays to the end, gate releases at the step's end), pitch, level, pan, envelope, filter, choke group and reverse — and each change is one undoable step.

**Bringing sounds in.** There are three ways, and all of them are yours:

1. **Import** a WAV, FLAC, MP3 or OGG file. Studio decodes it in your browser and re-encodes it as a 24-bit WAV at your browser's sample rate before uploading it to the project's storage, so what plays back is what was stored; an MP3 brings its encoder delay with it. A sample can be up to 60 s.
2. **Record into pad** arms the recorder on that pad: press Record, play, press Stop, and the recording becomes the pad's sample. It starts where you started it, with no latency compensation.
3. **Resample** records the master output, or one track's output, through the same recorder, so a sound you made in Studio becomes a pad. **Snap to bar** is on by default, which turns a resample into a loop you can chain.

**Chopping.** The chop editor draws the waveform with its slice markers. **Auto-chop by hits** finds the transients (the sensitivity slider decides how many), the **Grid** pick cuts it into 2, 4, 8 or 16 equal pieces, and dragging a marker moves a cut by hand. Each chop is one undoable step, and a slice keeps its id, so a pad that plays a slice carries on playing it after a re-chop; removing a slice a pad still plays is refused, and the refusal names the pad, so **Clear pad** (in the pad's settings, after a second press to be sure) empties that pad — keeping its name, level, envelope and filter — and the chop goes through. **Assign slices to pads** fills pads 1, 2, 3… in order.

**Steps and locks.** Click a step to put a hit on it, click it again to take it off; its height is its velocity. Press and hold a step to put it in **lock mode**: until you press **Done** (or Escape, or tap another step), the pad controls set that step only, so that pitch, level, filter, envelope or pan applies to that step's own voice, up to 8 locks on a step. A long press never toggles the step. The clip has a length in steps, a step length (16ths by default, 32nds for rolls) and a **swing** amount that delays the second step of every pair. Choke groups make a hit cut the other voices in its group, which is what keeps an open hat from ringing through the next closed one.

**Patterns and chains.** A pattern clip holds up to 16 patterns and a **chain**: an ordered list of them that loops (`A, B, A`), so one clip is a bar or a phrase and the chain is the part. Pattern tabs, the chain editor and the length and swing controls sit above the steps.

**Motion record.** Press **Motion**, play the pattern, and turn a pad control or a MIDI knob: every move becomes a point on that field's **motion lane**, at the step the transport is on, for the pattern it is actually playing. One pass of the pattern ends the take and writes it, and each lane is one undoable step; **Clear** beside a lane takes that curve off the pattern.

**What the bot can do with the sampler.** It writes patterns, steps, locks, chains, slices and pad settings, and every one of those is a step you can undo. It cannot bring a sound in — it can import nothing, record nothing and resample nothing — and no step of its, undo included, can drop or replace the sound a pad plays (clearing a pad is yours alone: **Clear pad**), undo the adding of a bank or a sampler track whose pads now hold sounds, swap a sampler track's device, or take back a sample's arrival. A track you lock keeps it off that kit, and re-chopping a sound a locked track plays is refused too. It cannot hover over a pad in your browser, so it cannot hear what you hear: ask it for a render and say what you think.

## MIDI controllers

A song can be played from a floor pedalboard or a pad keyboard. Every **mapping** belongs to the song — one message from one named controller, routed to one thing it does — so the same pedals do the same thing on any device you open the song on.

1. **Connect controllers.** Press **Connect controllers** once in a browser and allow MIDI access; Studio asks for it only when you press that button, never on page load. The cards at the top of the MIDI section show what is plugged in. A controller you unplug stays listed as *Unplugged* and keeps its mappings; plug it back in (the same name) and it plays them again.
2. **Learn.** Press **Learn**, click the control on the page — a scene's launch button, Play, Record, a pad, a pad setting, an effect, the looper — then move the pedal, press the pad or turn the knob you want. Escape cancels. The press that taught the mapping is not also played.
3. **Set up for…** lays out a whole controller in one step: **FCB1010** (one pedal per scene, in song order, and the expression pedals on the first tracks' levels) or **MPK Mini** (the pads on the first sampler's pads and the knobs on the selected track's macro knobs). Every row it lays out arrives as a **proposal**.
4. **The bot's proposals.** The agent can propose mappings, and it cannot make one live: the notice above the table says how many it proposed. **Accept** makes one live, **Reject** throws it away, **Accept all** takes the lot. Once you accept a row it is yours — no agent step, undo included, can change or remove it. The **Set by** column says who set each row: you (amber) or the bot (blue). When a proposal moved after the page drew it, accepting it is refused and nothing goes live: look at the row again and decide.
5. **Every row** names the control the way the hardware calls it ("FCB1010 pedal 3"), what it **sends**, what it **does**, and offers **Learn** (learn another message for that row) and **Remove**.

**The FCB1010 needs a USB-MIDI cable** — the pedalboard itself has only the round MIDI socket. Its factory layout is pedals 1–10 sending program changes 0–9, with expression pedals A and B on CC 27 and CC 7. The MPK Mini is USB and needs no driver: its pads send notes 36–43 on channel 10, its knobs CC 70–77, and its keys send notes. Every unit can be reprogrammed, so if a pedal does the wrong thing, **Learn** that row — the mapping follows the message, not the name.

One tab per song listens to the controllers, so two open windows never double-trigger a pedal; a tab that is not the listener says so at the top of the section. A mapping the bot wrote for you (a row it proposed and you accepted) is played as you: the actions a controller can run are the page's own controls, never a change to the song.

The keys are not played yet: `keys.play` stays on the list of what a mapping can run for when they are, and no profile proposes one.

## Performance effects and the looper

Under the steps of a sampler track sit six buttons: **Filter sweep**, **Lo-fi**, **Stutter**, **Looper**, **Tape stop** and **Reverb throw**. **Hold one to apply it and let go to return** to the dry mix — a filter sweep under a scene, a stutter on the last beat, a tape stop into the next section; the reverb throw's tail rings out after you let go. A pedal or knob you map to an effect holds it the same way, so the floor does what the screen does.

**The looper** records the master in whole bars. Press **Looper** to start recording (it starts on the bar), again to play the loop, again to overdub, and again to go back to playing. **Loop → pad** turns what the looper holds into a sample on the pad you have selected — or the first empty pad of the bank when you have not picked one — named for its length, so a loop you just played becomes part of the kit; a bank whose pads all hold a sound says so and waits for you to pick the pad it replaces. A looper that has recorded nothing says so.

None of this is a change to the song: the effects and the looper are live, they never become steps in the history, and the bot cannot hold them — it has no tool that presses one, and its renders are always dry.

## The timeline

Switch from **Session** to **Arrangement** to lay the song out on bars. Each track gets a lane, and each block on a lane is a **placement** of one of that track's clips, outlined in the colour of whoever placed it (you, or the bot).

- **Place a clip** by dragging it from the Session grid onto its lane, or with **Place on timeline** in the clip editor. Drag a placement to move it and its right edge to make it longer: a placement longer than its clip loops it.
- **Split at playhead** cuts the selected placement in two; the halves play exactly as before until you change one. Audio placements also have **fade in** and **fade out** handles on their top corners.
- **Sections and markers** sit on the ruler: drag on the section row to add a section, click the marker row to add a marker, and use their buttons to rename or remove them.
- **Record to timeline** records a performance: turn it on, launch scenes in Session view as you play, and press Stop. Every launch becomes a placement, as one step you can undo. If the performance clashes with placements already there, Studio keeps it and offers **Place what fits** or **Discard**.
- An audio lane's **Takes** button opens that clip's takes under the lane, so you can comp on the timeline.

Every timeline change is one undoable step, and the bot can do all of it too (place, move, split, fade, add sections and markers), and render the arrangement from any bar.

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
| Placements on the timeline | 2048 | — |
| Timeline length | 999 bars | — |
| Markers / sections | 256 / 128 | — |
| Banks per kit | 8 | — |
| Pads per bank | 16 | — |
| Samples per song | 512 | — |
| Sample length | 60 s of 48 kHz stereo (5,760,000 samples) | — |
| Slices per sample | 64 | — |
| Step positions per pattern | 64 (16 per page) | — |
| Steps per pattern | 1024 | — |
| Patterns per clip | 16 | — |
| Chain length | 64 | — |
| Locks per step | 8 | — |
| MIDI mappings per song | 256 | — |
| Decoded samples held in memory | 256 MB | — |
| Fonts (SoundFont banks) per song | 32 | — |
| Library entries per song | 256 | — |
| Bank file | 512 MB | — |
| Banks loaded in a page | 1024 MB | — |
| Instruments a render holds (all of the song's banks) | 1024 MB, refused before it starts | — |
| Effects per chain | 8 | — |
| Amp inserts per song | 16 | — |
| Capture file (`.nam`, A2) | 20 MB | — |
| Cabinet impulse response | 10 MB, 1 s (a few frames of tolerance) | — |
| Returns per song | 8 | — |
| Sends per track | 8 | — |
| Master gain / loudness target | −24 to +12 dB / −30 to −6 LUFS, ceiling −6 to −0.1 dBTP | — |
| Master limiter look-ahead | 1.5 ms (the only insert that delays anything) | — |

Every limit refuses with a plain-English error that names it; nothing is ever truncated to fit.

## Known limits

- **Your own MCP session sees every song.** A coding agent connected as you (an MCP session on this instance) is not a bot: the project filter is a bot rule, not a permission, and a session with the owner's access can read and edit any song on the instance it can reach. Studio is single-operator in this phase.
- **Calls through the gateway's shared tools endpoint with the gateway token count as you.** Every MCP caller is recorded as an agent, but only a Crow bot running its own copy of Studio's tools is limited to its project. A client that reaches Studio through the gateway's `/tools/mcp` (or the router) with the gateway token is treated as the owner, with every song — even a device bridge that calls itself a bot over that endpoint, such as the companion. That token already grants owner access to every gateway tool, so Studio adds nothing it did not already allow.

## Credits

> Powered by SunVox (modular synth & tracker) Copyright (c) 2008 - 2026, Alexander Zolotov &lt;nightradio@gmail.com&gt;, WarmPlace.ru&gt;
>
> The default instruments are downloaded, not redistributed with Crow: MuseScore General by S. Christian Collins, from FluidR3Mono by Michael Cowgill and FluidR3 by Frank Wen; Temple Blocks by Ethan Winer; Drumline Cymbals by Michael Schorsch — MIT, per its own licence file.
>
> The starter capture is the A2 example model from NeuralAmpModelerCore, by Steven Atkinson, MIT (2023), shipped unmodified under a neutral name; its source amplifier is unknown. The starter cabinets are from "Impulse Responses" by David Fau Casquel (archive.org/details/ImpulseResponses), CC BY 3.0, shipped unmodified. Every file's source, licence and credit are in `bundles/studio/library/files/NOTICES.md`.

Studio's engine runs SunVox (the WebAssembly build of the SunVox library) so the browser and the server's offline renders use the same synthesizer. The full licence texts — SunVox's own, plus the tremor.txt, sundog.txt and libflac.txt notices from the SunVox archive — ship with the bundle in `bundles/studio/vendor/sunvox/THIRD-PARTY-NOTICES.txt`.

The amp runs Neural Amp Modeler through the WebAssembly build in neural-amp-modeler-wasm (MIT, TONE3000), which compiles in NeuralAmpModelerCore and AudioDSPTools (MIT, Steven Atkinson), nlohmann/json (MIT) and Eigen (MPL-2.0). Their notices, with Eigen's source link, ship in `bundles/studio/vendor/nam/THIRD-PARTY-NOTICES.txt`.
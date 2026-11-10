/**
 * Studio engine worklet processor — the SunVox host.
 *
 * `engine-client.js` concatenates these files into ONE module and loads it with
 * `audioWorklet.addModule()`:
 *
 *     sequencer.js + resample.js + sampler-voice.js + perf-fx.js + sunvox.js
 *       + spessasynth.js + font-voice.js + dynamics.js + faust-host.js
 *       + meter.js + studio-processor.js
 *
 * so this file shares a module scope with the vendored SunVox glue (which
 * declares the `SunVoxLib` factory), with the pure sequencer
 * (`StudioSequencer` on `globalThis`), with the sampler's voice DSP
 * (`StudioSamplerVoice`), with the performance-effects bus (`StudioPerfFx`) and
 * with the SoundFont hosts (`StudioFontVoice`, which drives the vendored
 * synth's `SpessaSynthProcessor`), with Crow's own dynamics (`StudioDynamics`),
 * with the compiled Faust effects' host (`StudioFaustHost`) and with the master
 * meter (`StudioMeter`) (plan 1d, Tasks 7, 8 and 9). Nothing here is imported:
 * the same source
 * runs in a browser's `AudioWorkletGlobalScope` and in node-web-audio-api's
 * worklet thread.
 *
 * ## One SunVox engine per track, mixed in JavaScript
 *
 * `sv_audio_callback()` mixes every open slot of its engine instance into one
 * stereo buffer, and the library's only per-module tap is `sv_get_module_scope2()`'s
 * 16-bit scope — a display trace, not a mixdown. So an exact per-track gain and
 * pan is only possible if each track owns its own engine instance: one
 * `SunVoxLib()` per track (16 at most), each with one open slot, one device
 * module in that slot, connected straight to that engine's Output. Every block
 * renders each engine into its own preallocated buffer and THIS file does the
 * mix:
 *
 *     out += track * 10^(gain_db / 20) * [cos θ, sin θ],  θ = (pan + 1)π/4
 *
 * which is the constant-power pan and a real dB gain (so −60 dB is −60 dB, not
 * a rounded-away controller value). The SunVox side stays at unity: the slot
 * volume is set once, and no gain or pan is ever written to a SunVox volume,
 * balance or amplifier controller. After the sum, one hard clip at ±1.0 is the
 * whole master stage (spec §5.1: no Web Audio node shapes sound).
 *
 * The vendored `sunvox_lib_loader.js` keeps ONE instance in a module-scope
 * `svlib` plus module-scope scratch pointers, so it can back only one engine
 * per realm — it is not part of this worklet module. `bindEngine()` below talks
 * to the `_sv_*` exports directly instead, which is what lets sixteen engines
 * live in one worklet.
 *
 * ## What this depends on (vendored 2.1.4d WASM build)
 *
 * - **`out_time` must advance.** With `out_time` stuck the library returns
 *   silence. Every engine therefore keeps its own frame clock, advanced by the
 *   frames rendered; it is never `sv_get_ticks()`, which is wall-clock time and
 *   would make two hosts disagree.
 * - **`sv_set_event_t(slot, 1, 0)` is required for live notes.** With the
 *   default "automatic" timestamps a note sent by `sv_send_event()` can land
 *   far ahead of the audio we ask for and never sound; pinning the timestamp to
 *   0 means "as quickly as possible", i.e. at the start of the next callback,
 *   which is exactly what the sub-block split below needs.
 * - **Note numbers are 11 semitones below the library's own pitch base.** A
 *   note sent as `nn` sounds at `16.333984375 * 2^((nn + 11) / 12)` Hz, so MIDI
 *   60 (261.63 Hz) is SunVox note 37, i.e. `nn = p - 23`. The pitch test in
 *   `tests/studio-engine.test.js` pins this.
 * - **`sv_send_event()`'s module field is one past the module number**
 *   `sv_new_module()` returned: the device module `M` is addressed as `M + 1`.
 * - **`sv_new_module()` / `sv_connect_module()` / `sv_remove_module()` need the
 *   slot lock** (`USE LOCK/UNLOCK!` in the vendor header), including the
 *   cleanup path of a build that failed.
 *
 * The glue is told it is not Node (see `callSunVoxFactory`): inside
 * node-web-audio-api's worklet thread `globalThis.process` exists, and the Node
 * branch of the factory would reach for `require("fs")`/`__dirname`, neither of
 * which exists in that scope.
 *
 * ## Audio tracks: two PCM voices, not an engine
 *
 * A track whose device is `{engine: "audio"}` plays recorded takes instead of
 * SunVox notes, so it has no engine and no module. Its slot holds two PCM
 * voices: the sequencer alternates between them at consecutive comp segment
 * starts, and when a start lands while the other voice is still sounding the
 * two crossfade linearly over 64 frames — the old one 1 → 0, the new one
 * 0 → 1, sample-exact and independent of the block size, because the ramps are
 * counted in frames and not in blocks. A voice that reaches the end of its
 * take goes silent.
 *
 * A voice's gain can also be ramped by an arrangement placement's fade
 * (`{type:"fade", track_id, voice, frame, from, to, frames}`): the ramp is
 * counted in frames from the frame it was applied at and multiplies the
 * crossfade envelope, so a fade in starts at silence and reaches its top
 * exactly `frames` frames later, whatever block size the host asks for.
 *
 * The PCM arrives already at the context's rate
 * (`{type:"audio", take_id, channels:[Float32Array…]}`, transferred), because
 * resampling is `engine/resample.js`'s business and runs on the client. A
 * start for a take that has not been loaded plays silence and is reported once
 * per take id: "Take <id> is not loaded yet." A mono take plays to both
 * channels; the take's own `take_frame` says where in it to start (it already
 * carries the recorded offset, and may be negative, which is a short silence
 * before the take begins).
 *
 * Track gain, pan, mute and solo apply to an audio track exactly as they do to
 * an engine's output: in the mix below, after the voices are summed.
 *
 * ## SoundFont tracks: one synth per font, one channel per track
 *
 * A track whose device is `{engine: "soundfont", font_id, bank, program}` plays
 * an instrument out of the song's `library` (plan 1d). Its notes go to
 * `font-voice.js` (`StudioFontVoice`), which parses ONE bank per font however
 * many tracks play it and gives each track its own MIDI channel. Every run is
 * rendered through the synth once and each soundfont track reads its own
 * channel's dry stereo pair, so its gain, pan, mute, solo (and, from PR B, its
 * inserts) work exactly as they do on any other track:
 *
 *     StudioFontVoice.process(frames) → track id → {left, right}
 *
 * **Channels are assigned in snapshot track order** among the tracks on one
 * font (0-15), which is the order both hosts read the song in, so a page and a
 * render put the same track on the same channel. The GM drum bank (128) is
 * `setDrums(true)` on that track's own channel, never by reserving channel 9.
 * A preset (or a font) that changed is applied at the next block's first frame:
 * `syncSlots` runs on the message path, between two blocks, and never inside
 * one.
 *
 * **Loading happens while the transport is stopped.** `{type:"library"}` arrives
 * with the bank's bytes and the client's own `request_id`; a load that arrives
 * while the playhead runs is held and answered `{type:"library_deferred"}` so
 * the page can say "Loads when you stop.", and a load whose queued job finds the
 * playhead running goes back to that same queue. Every ack repeats the
 * `request_id`, so one load never answers another. A track whose font is not
 * loaded is silent and is reported once per font id as
 * `{type:"library_needed"}`; a bank that will not parse (or that the song's own
 * fonts leave no room for under the cap) is silent and reported once as
 * `{type:"library_failed", reason}`. A refusal for ROOM is retried — reported as
 * `library_needed` again — when a font is unloaded or the song's font set
 * shrinks, because that is what makes room for it. Neither throws: a font costs
 * its own tracks and never the song.
 *
 * ## Sampler tracks: a pool of pad voices, JS DSP
 *
 * A track whose device is `{engine: "sampler"}` plays a kit of pads instead of
 * notes, and its clips are patterns (see `sequencer.js`). Its slot holds a pool
 * of 16 voices (`sampler-voice.js`, `StudioSamplerVoice`), and a `pad` event
 * starts one:
 *
 *     {frame, type: "pad", track_id, bank_id, index, v, locks, gate_frames}
 *
 * The pad is read from the song's own `pads` container, which `setSong` copies
 * into a flat map; a step's `locks` override the pad's fields for that one
 * voice. The voice plays the pad's slice (or the whole sample), pitched by
 * resampling, through its envelope and its one biquad, then gain and pan.
 *
 * - **The PCM** arrives from the client already at the context's rate
 *   (`{type:"sample", sample_id, channels}`, acknowledged like a take), because
 *   resampling is `resample.js`'s business and runs on the client. A trigger for
 *   a sample that is not loaded plays silence and is reported once per sample
 *   id ("Sample <id> is not loaded yet."), and is also posted as
 *   `{type:"sample_needed", sample_id}` so the client can load it again.
 * - **Voice stealing:** 16 voices per track, 64 for the whole song. The 17th
 *   voice on a track steals that track's oldest, and a start that would take
 *   the song past 64 steals the song's oldest — a voice that is already fading
 *   out (choked, or already releasing) goes before one that is still held. A
 *   track's own steal fades: the stolen voice is moved into one of the track's
 *   two fade tails and rung out over 64 frames while the new voice takes its
 *   slot (with both tails in use it is cut instead — the pool stays 16). The
 *   song-wide steal cuts, so a song past its 64-voice cap really is 64 voices.
 *   Nothing is stolen until the new voice's own range is known to be playable.
 * - **Choke groups:** a start in choke group *n* fades every other sounding
 *   voice of group *n* on that track out over 64 frames.
 * - **Modes:** a `oneshot` pad plays to the end of its range and stops there
 *   (with a 64-frame fade when it is still at level); a `gate` pad releases at
 *   `gate_frames`, the step's own length.
 * - **Live pads:** `{type:"live", track_id, bank_id, index, v, on}` starts or
 *   releases a pad from the panel (on-screen audition, MIDI later). A live
 *   start never goes through history and is never quantized. A release only
 *   releases `gate` voices: a `oneshot` pad that was pressed plays to its end.
 * - **Locks:** every one of a pad's own fields can be locked per step —
 *   `attack_ms`, `decay_ms`, `sustain`, `release_ms`, `pitch`, `gain_db`,
 *   `pan`, `reverse`, `cutoff_hz`, `resonance` and the filter's kind under
 *   `filter_type` — and all of them go through the same `field()` lookup.
 *
 * ## Motion
 *
 * A pattern's motion lanes (`sequencer.js`, "Motion") sweep one of a pad's
 * numeric fields while the pattern plays. The sequencer hands this file, for
 * every sampler track and every pattern slot of every block, a descriptor in
 * the block's non-enumerable `motions` array:
 *
 *     {frame, track_id, pattern_id, lanes, origin_frame, frames_per_beat,
 *      slot_start_beat, step_beats, length_steps}
 *
 * `lanes` is that pattern's curve — `{pad, param, points}` per lane, `points`
 * sorted by `step_frac` — or `null` for a slot that sweeps nothing. A
 * descriptor describes a window: the curve stands from its own frame to the
 * end of its slot, and a segment that stops inside a block ends its curve
 * there, with one more descriptor carrying `lanes: null`.
 *
 * **On a fixed grid, once per pad.** Motion is read on sub-steps of
 * `MOTION_SUB_STEP` frames counted from the engine's first frame
 * (`absoluteFrame % 32 === 0`), never per frame and never per voice: the block
 * is rendered in runs that never cross one of those absolute boundaries, and at
 * each sub-step every lane of a track's curve is evaluated ONCE — at the
 * sub-step's own first frame, so two runs inside one sub-step hold the same
 * value — and then written into that pad's sounding voices. A lane is read with
 * its own cursor, which only ever walks forward through the point list and
 * starts again on a loop wrap or when a new descriptor moves the clock under it,
 * so a 4096-point lane costs a few comparisons per sub-step instead of a scan.
 *
 * The step position of a sub-step is
 * `((frame - origin_frame) / frames_per_beat - slot_start_beat) / step_beats`,
 * which is built from the song and the transport alone, so the grid — and every
 * value on it — is the same whatever block size the host asks for. `pitch`,
 * `gain_db`, `pan` and the envelope's times hold their sub-step value between
 * boundaries (they are written, not ramped); a filter is re-tuned at most once
 * per sub-step even when cutoff and resonance both move.
 *
 * **Precedence:** a step's lock beats motion, and motion beats the pad's own
 * field. A voice remembers the lock names its step carried, and a lane that
 * names one of them leaves that voice alone; a voice whose every lane is locked
 * is not swept at all and keeps the whole-run fast path. Motion moves `pitch`,
 * `gain_db`, `pan`, `sustain`, `cutoff_hz`, `resonance`, envelope times, and
 * `release_ms` for a release still to come. The cutoff and resonance go through
 * the very same coefficient maths as the pad's own filter
 * (`StudioSamplerVoice.setFilter`), with the filter's state carried across, so
 * a sweep is a moving filter and not a train of clicks.
 *
 * **Every voice is swept, live presses included.** A live pad press goes through
 * the very same `startPad`, so it carries the pad key and the step locks (`{}`)
 * a step's voice does: a lane over its pad sweeps it exactly like a step's voice.
 * A live press simply has no lock of its own to be spared by.
 *
 * **A curve that stops applying gives the voice back.** When the lane goes away
 * — a chain turns onto a pattern without it, the transport stops, the lane is
 * cleared, the segment ends — the next sub-step puts the voice back on the
 * values its pad and its step's locks gave it (`restorePadMotion`), so a voice
 * is never left holding a stale swept value. A swept sustain of 0 in the
 * sustain stage releases the voice: motion must not leave a voice sounding
 * silently for ever.
 *
 * ## The mixer: chains, sends, returns and the master
 *
 * The song's `inserts`, `sends`, `returns` and `master` containers (see
 * `server/doc.js`) are the mixer, and the order they run in is the signal path
 * (plan 1d, Task 9, one final order):
 *
 *     track: source → inserts → fader/pan → sends (pre or post fader)
 *     return: inserts → fader
 *     tracks + returns → the master sum → looper → performance bus
 *       → master gain → master inserts → clip → output
 *
 * **Sends.** A send's `pre` is tapped after the track's inserts and before its
 * fader and pan; its `post` is tapped after them. `level_db` is a linear gain
 * on that tap. A muted track's sends are silent either way, and so are the
 * sends of a track that any track's solo silences: a soloed track's sends
 * play, and the returns are never muted by solo. A return pans with the same
 * constant-power law as a track.
 *
 * **Chains are built outside `process()`.** A chain is a list of insert runners,
 * one object per insert (`StudioDynamics.create` or `StudioFaustHost.create`,
 * with its parameters), and it is built and edited on the message path — never in
 * a block.
 *
 * A snapshot is compared by SHAPE (each insert's id and kind, in order, with its
 * bypass flag). A chain whose shape is unchanged only had parameters turned:
 * every runner takes its own `setParams`, keeps its insert, its state and its
 * fault, and nothing is rebuilt and nothing fades. Any other change is a chain
 * edit, and it is applied insert by insert: an insert the edit did not touch
 * keeps its object — a reverb's tail, a delay's line, a limiter's lookahead — and
 * does not fade; an added insert fades in from the dry signal; a removed or
 * bypassed one fades out where it stands and is dropped when the fade ends. Each
 * fade is armed once and counts down frame by frame across runs and blocks (never
 * per run: a motion curve splits a block into runs of no more than 32 frames),
 * over 64 frames — or over the master chain's own latency when that moved with
 * the edit (a limiter added or removed). A snapshot that lands mid-fade only
 * re-targets the weights, which keep their value, so nothing restarts and nothing
 * clicks.
 *
 * **A replaced segment runs its two sides in PARALLEL.** When an edit puts new
 * inserts where the old ones were — an insert deleted and another added in its
 * place, an id given another kind, the whole chain reordered — fading the two one
 * after the other is wrong twice over: the arriving insert's weight brings its
 * output in on top of what the leaving one still passes (both half in, so the
 * level swells by +1 to +4 dB), and it runs on the leaving insert's OUTPUT, so a
 * new delay replays the echoes of the effect it replaced. Those two sides are
 * therefore one node of the chain that runs both paths on the SAME input and
 * blends the two OUTPUTS by one weight (see `runBlend`). For a reorder the whole
 * chain is that node (the old order against the new one); every insert is
 * rebuilt, so the reorder costs their state, as it always did. The path that
 * arrives is always run, even while the weight is still 0: that is what primes a
 * limiter's lookahead, and the weight waits for the arriving path's own latency
 * before it moves, so a rebuilt master limiter spends the whole crossfade
 * limiting (the ceiling holds and the time base does not move). An insert an
 * edit *added* has nothing to run against and still fades in by its own weight;
 * an insert it *deleted* still fades out by its own weight.
 *
 * **A fade that moves latency is not time-aligned.** The dry side of an insert's
 * own weight is the signal as it arrived; the wet side is that signal delayed by
 * the insert's own latency. While a latency-bearing insert fades in or out — a
 * master limiter added, removed or bypassed — the two sides are therefore up to
 * `latencyFrames` apart in time and the mix combs over `max(64, L)` frames. That
 * is deliberate: a crossfade is the only way to move a delay in or out of a path
 * without a step, and a side that was delayed before the fade began would be a
 * jump rather than a blend. The number the master reports follows the running
 * delay (it switches at the fade's midpoint, see `runningLatencyOf`), so nothing
 * downstream is told a delay the audio does not have.
 *
 * A Faust insert whose module has not been compiled yet passes audio through and
 * says so once, as `{type:"insert_loading", insert_id, message}`:
 * "<effect> on <track> is still loading." Only that case is retried (until the
 * page posts its `faust-modules`); a kind that is missing after them, or one
 * whose build throws, is a permanent pass-through reported once as an error.
 *
 * **The NaN guard.** After every insert the block is checked for a sample that
 * is not a finite number. One bad sample replaces the whole block with the
 * insert's own input, the insert is bypassed IN THE ENGINE (never in the
 * document) and reported once: "<effect> on <track> produced an invalid sample;
 * it is bypassed." Only that insert's OWN parameters (or its kind) moving arms it
 * again — any other edit to the song leaves it bypassed — and arming it resets it
 * and fades it back in from the dry signal, primed by its own latency, so an
 * insert that comes back at another level is not a step in the master. An AMP
 * insert is the exception the other way: a bad sample stops it SILENT, because
 * the dry signal is not something an amp may fall back to (see below).
 *
 * **Latency.** Every track and return insert is zero-latency except an amp whose
 * capture is at another rate than the context's; only the master limiter has its
 * 1.5 ms lookahead, applied after everything else. The master path is delayed by
 * the master chain's total latency and nothing else, and the RUNNING delay — the
 * one the audio being handed out really has, so a fade that moves the limiter in
 * or out crosses it at its midpoint, and a limiter the NaN guard has bypassed
 * does not count — is posted as `{type:"master_latency", ms}` whenever it changes
 * (never twice for the same number) and repeated in every meter reading as
 * `latency_ms`.
 *
 * ## Amp inserts: captures and cabinets (plan 1d, Task 13)
 *
 * An insert of kind `amp` is the one insert whose sound is a FILE the operator
 * chose (`server/doc.js`'s `AMP_PARAMS`): a NAM capture (`model_id`) played
 * through a cabinet IR (`ir_id`), with an input trim, an output trim and an IR
 * mix. It runs inside the same runner system as every other insert — the same
 * chain-edit crossfade, the same priming, the same NaN guard — and its own
 * signal path is
 *
 *     input_db → [resample to the capture's rate] → NAM (mono: the two channels
 *       summed, the same out on both sides) → [resample back] → cabinet
 *       convolver (wet/dry by ir_mix; no cabinet = skip) → output_db
 *
 * `engine/nam-host.js` (`StudioNamHost`) owns the NAM side: the engine wasm is
 * compiled ONCE per page from bytes the page transferred (`{type:"nam-wasm"}`)
 * and every amp insert OBJECT owns one instance inside that one module. The
 * capture's JSON arrives as a library file (`{type:"library", kind:"nam"}`),
 * is parsed HERE on the message path while the transport is stopped (`JSON.parse`
 * for the A2 check, then the engine's own parse), and is handed to every insert
 * that names it. `engine/convolver.js` (`StudioConvolver`) owns the cabinet:
 * uniform-partitioned FFT convolution whose first partition runs directly, so it
 * is zero latency like every track insert.
 *
 * **An unchanged attachment costs nothing.** Each amp remembers what its capture
 * and its cabinet were built from (the library id, the text/IR, the engine's
 * readiness). A song snapshot — any edit, a fader moved, a mute — re-attaches
 * every amp, and an amp whose files did not move finds them unchanged and does
 * nothing: no JSON parsed again, no capture copied into the wasm heap, no FFTs
 * rebuilt, no click. Choosing ANOTHER capture or cabinet while the song plays is
 * parked and applied on the next Stop, exactly as a library load is.
 *
 * **Loads happen while the transport is stopped** — the plan's rule for fonts
 * and captures both, so a capture load that arrives while the song plays is held
 * and answered `{type:"library_deferred"}` (the page says "Loads when you stop.")
 * and parsed on the next Stop. A chain edit that arrives during playback is held
 * the same way: an amp runner it builds is parked SILENT until Stop (a reorder
 * moves the already-loaded instance instead, so nothing loads and nothing is
 * duplicated). Cabinets are not parsed: their PCM is built into partitions on
 * the message path the moment it arrives, and a cabinet for a brand-new amp
 * runner waits for Stop with its capture.
 *
 * **A capture that cannot be played is SILENCE, not pass-through.** A legacy
 * (non-A2) capture, a broken one, one the engine refuses, one that is not on
 * this device, one whose `_nam_process` TRAPS inside the wasm, and one whose
 * output is not a finite number all leave that insert silent; the first is
 * reported once with the plan's sentence, a missing one as `library_needed` (so
 * the page can load it or offer the download), exactly as a missing font is
 * (Review Focus 1 and 5), and a trap or a bad sample as an `insert_fault` once.
 * A trap also POISONS the shared NAM module (every other amp reads silence
 * without being marked failed) and rebuilds it on the message path; the rebuilt
 * module re-attaches them at the next Stop, because a capture is loaded only
 * while the transport is stopped. The amp that trapped stays stopped until its
 * own settings move. A cabinet longer than a second is refused at load with the
 * plan's sentence. An amp insert with no `model_id` at all is a pass-through:
 * nothing has been chosen for it yet.
 *
 * The insert's own latency is the rate converters' look-ahead: a capture at the
 * context's rate needs no conversion and delays nothing, one at another rate
 * delays by what the two bridges really delay (`latencyFrames`, which the runner
 * primes for and the monitor's number includes).
 *
 * ## Monitoring through the chain
 *
 * The engine's node has ONE input (`inputs[0]`), and the page connects the armed
 * track's live input to it when the operator turns Monitor through Studio on.
 * `{type:"monitor", track_id, on}` names the track whose inserts (amps included)
 * that signal is run through: the input is summed into that track's own source,
 * so it goes through the track's chain, its fader and pan, and the master exactly
 * as its recorded audio will. The recorder taps the input itself, OUTSIDE the
 * engine, so a take is still the dry signal. The delay the chain adds is posted
 * as `{type:"monitor_latency", track_id, ms}` whenever it changes, and the page
 * adds it to the measured round trip it shows.
 *
 * ## The meter
 *
 * `meter.js` (`StudioMeter`) reads the master AFTER the master inserts: the
 * momentary (400 ms), short-term (3 s) and integrated (gated, reset on each
 * Play) loudness in LUFS, and the true peak since the last Play in dBTP, all on
 * the very same BS.1770-4 K-weighting and gating `server/loudness.js` measures
 * a render with. It is fed only while the playhead runs, and a reading is posted
 * every 100 ms of audio (the hop subtracted from the counter, so readings land
 * on the same frames at any block size) and once when the transport stops, as
 * `{type:"meter", momentary, short_term, integrated, true_peak_db, latency_ms}`.
 * The integrated measurement is a fixed histogram of gating-block powers, so its
 * cost does not grow with the length of a Play. A module composed without
 * `meter.js` (some engine tests build their own file list) simply posts none.
 *
 * ## Taps
 *
 * `{type:"tap", target, on}` turns on a copy of the master ("master") or of
 * one track's own output (that track's id) per block, posted as
 * `{type:"tap_block", target, frame, channels}`, `frame` being the context's
 * frame the block's first sample sits on (the same clock `launched` and
 * `nextBarFrame` report). Record-into-pad and resampling use it. A tap is off by
 * default, and off costs nothing at all.
 *
 * A track tap reads AFTER that track's inserts and its fader, so a resample of a
 * track is what you hear from it. A master tap copies the master AFTER the
 * performance bus, the master chain and the clip, so what it records is what
 * the room hears; because the master chain delays the master by its own latency
 * (the limiter's lookahead), a MASTER tap's `frame` is stamped that many frames
 * back, so a resample of the master lines up with a resample of a track instead
 * of leading it by 1.5 ms. (A tap armed on the very first block therefore starts
 * at a negative context frame: those first samples are the master chain's
 * pre-roll, and they belong where they will be heard.)
 *
 * ## The performance bus and the looper
 *
 * `perf-fx.js` (`StudioPerfFx`) sits on the master bus, and the order it is
 * called in is the signal path:
 *
 *     tracks + returns → master sum → looper → performance bus → master gain
 *       → master inserts → clip/limit → tap/output
 *
 * The looper therefore taps the mix BEFORE any effect and mixes its take back
 * in, so a held stutter or reverb is never baked into a loop; the clip and the
 * master tap both come after the effects. Both calls return at once when
 * nothing is held and the looper is empty.
 *
 * The effects are live performance state: `{type:"fx", name, amount, on}`
 * holds or releases one, and nothing else in this file touches them. A scene
 * launch, a stop or a pattern change does NOT release an effect — only a
 * release does (a held stutter keeps repeating its slice through a transport
 * stop, and a held tape stop stays at silence). The looper answers
 * `{type:"looper", action}` with `record`, `overdub`, `play`, `stop` or
 * `clear`, all quantized to the sequencer's own next bar line, and
 * `{type:"looper_take"}` with `{type:"looper_buffer", id, left, right, frames,
 * rate, bars}` — whole bars of the master in the looper's own buffers, which the
 * page turns into a pad's sample.
 *
 * **The looper's buffers belong to the page.** `{type:"looper_buffers", left,
 * right}` hands the processor a pair (transferred) sized for eight bars at the
 * song's current tempo; a `looper_take` transfers that same pair back, and the
 * page returns it with another `looper_buffers`. Nothing in this file allocates
 * a looper buffer, and a recording that would pass the end of them ends at the
 * last whole bar that fits.
 *
 * Both take a `transport` the processor keeps for the block:
 * `{frame, playing, bpm, beatsPerBar, barFrame, nextBarFrame, offset}`, where
 * `frame` is the block's first frame, `barFrame` the frame of the bar line the
 * playhead is inside and `nextBarFrame` the sequencer's own next bar line (both
 * `null` while the transport is stopped: there is no grid to quantize to, so a
 * command acts at once), and `offset` the run's first index inside the output
 * buffers. Both are read from the sequencer's `barLines()`, which fills a reused
 * object: a block allocates nothing.
 *
 * ## Block splitting
 *
 * `process()` is handed 128 frames. The sequencer's events for the block are
 * applied at their own frame: the block is rendered in runs, `sv_send_event()`
 * for every event at the cursor, then `sv_audio_callback()` on every track's
 * engine covering the frames up to the next event. Nothing is allocated per
 * block: each engine's callback buffer is allocated once (with the smallest
 * block it will ever be asked for) and only grows if a host asks for a block
 * bigger than the current one.
 *
 * A block that carries a motion descriptor is also cut on the motion grid
 * (`MOTION_SUB_STEP`, counted from the engine's first frame), so no run — and so
 * no swept voice — ever crosses a sub-step boundary. That is what makes a curve
 * read the same value for the same frame at any block size; a block with no
 * curve at all is rendered exactly as it was before motion existed.
 *
 * ## `process()` never throws
 *
 * A throw out of an AudioWorkletProcessor takes the host's audio thread down
 * and the graph never recovers, so the block body is guarded: the first throw
 * is reported to the client once, the engine is marked failed, and every later
 * block outputs silence while `process()` keeps returning true. A fault in a
 * client message or in one track's build is reported without stopping the
 * engine — only process-time or start-up faults are fatal.
 *
 * ## Messages
 *
 * client → processor: `{type:"song", snapshot}`, `{type:"launchScene", id}`,
 * `{type:"launchClip", id}`, `{type:"stopTrack", id}`, `{type:"stopAll"}`,
 * `{type:"play"}`, `{type:"stop"}`, `{type:"setMode", mode}`,
 * `{type:"seek", bar}`, `{type:"flush", id}`,
 * `{type:"nextBarFrame", id}`, `{type:"audio", take_id, channels}`,
 * `{type:"audio_unload", take_id}`, `{type:"sample", sample_id, channels}`,
 * `{type:"sample_unload", sample_id}`, `{type:"library", library_id, kind,
 * bytes}` (kind `"font"` with a bank's bytes, `"nam"` with a capture's bytes,
 * or `"ir"` with `channels`/`rate`), `{type:"library_unload", library_id}`,
 * `{type:"nam-wasm", bytes}` (the NAM engine binary, once per page),
 * `{type:"monitor", track_id, on}`, `{type:"live", track_id,
 * bank_id, index, v, on}`, `{type:"tap", target, on}`, `{type:"fx", name,
 * amount, on}`, `{type:"looper", action}`, `{type:"looper_buffers", left,
 * right}`, `{type:"looper_take", id}`, `{type:"faust-modules", modules}`
 * processor → client: `{type:"ready"}`, `{type:"flushed", id}`, `{type:"error",
 * error}`, `{type:"position", bar, beat, sixteenth, patterns}` (at most every
 * 50 ms of audio; `patterns` maps each sampler track that was playing a pattern
 * clip in that block to `{pattern_id, slot_start_beat, slot_beats, chain_index}`
 * — the chain slot it played, which is where the motion recorder puts a lane —
 * see `reportPosition`), `{type:"launched",
 * track_id, clip_id, scene_id, bar, frame}` (one
 * per launch the sequencer applied in that block; see below),
 * `{type:"nextBarFrame", id, frame, bar}`, `{type:"audio_loaded", take_id}`
 * (one ack per `audio` message, so the client knows the PCM is in),
 * `{type:"sample_loaded", sample_id}` (one ack per `sample` message),
 * `{type:"sample_needed", sample_id}` (a trigger for a sample that is not
 * loaded, once per sample id), `{type:"library_loaded", library_id, ok,
 * reason?, request_id}` (one ack per `library` message, matched to that message's
 * own `request_id`), `{type:"library_deferred", library_id, request_id}` (a load
 * that waits for Stop), `{type:"library_needed",
 * library_id}` (a track's font is not loaded, once per font id),
 * `{type:"library_failed", library_id, reason}` (a bank that will not parse or
 * render, or a capture that cannot be played, once per library id),
 * `{type:"monitor_latency", track_id, ms}` (the delay the monitored track's
 * own chain adds, whenever it changes), `{type:"tap_block", target, frame,
 * channels}`
 * (while a tap is on, one per block), `{type:"looper_buffer", id, left, right,
 * frames, rate, bars}` (one answer per `looper_take`; the `left`/`right` buffers
 * are transferred, and the page hands them back with `looper_buffers`),
 * `{type:"meter", momentary, short_term, integrated, true_peak_db, latency_ms}`
 * (the master's loudness and true peak after the master inserts, every 100 ms of
 * audio while the transport runs and once when it stops — see "The meter"),
 * `{type:"master_latency", ms}` (once per master chain build that moves it: the
 * delay the master chain — the limiter's lookahead — puts on the master path),
 * `{type:"insert_fault", insert_id, message}` (an insert that produced a
 * non-finite sample: it is bypassed in the engine and this is said once — see
 * "The mixer"), `{type:"insert_loading", insert_id, message}` (a Faust insert
 * whose compiled module the page has not posted yet: it passes audio through
 * until then, and this is said once per insert — not an error)
 *
 * ## Frames the client can count on
 *
 * A `launched` report and a `nextBarFrame` answer are both in the CONTEXT's
 * frames, not this processor's: `currentFrame`, the AudioWorkletGlobalScope
 * global every processor on one AudioContext shares, so a recorder built as a
 * second worklet on the same context arms on the very frame the engine's
 * launch took effect. A `tap_block` carries its own `frame` in the same clock —
 * the context frame of its first sample, moved back by the master chain's
 * latency for a master tap (see "Taps") — so a resample can cut what it keeps
 * exactly on a bar line instead of counting blocks. `bar` is 0-based. The
 * translation from the sequencer's
 * own frames is measured once, at the first block (see `contextOffset()`).
 *
 * Two message types exist only when `processorOptions.testHooks === true`, and
 * are ignored otherwise: `{type:"__throw"}` arms a throw inside the next
 * `process()` (the failure policy above), and a track whose
 * `device.type` is `"__fail_device"` cannot be built (the retry rule in
 * `syncSlots`).
 *
 * ## Parity
 *
 * Two hosts that feed the same song the same number of frames do the same wasm
 * work and the same float mix in the same order, so they produce the same
 * bytes.
 */
(function () {
  "use strict";

  /** The name this file registers, and the name engine-client constructs. */
  const PROCESSOR_NAME = "studio-processor";

  /** A song holds at most this many tracks, and each track owns one engine. */
  const MAX_TRACKS = 16;

  /** Every track's engine uses this one slot: the track is that engine's song. */
  const SLOT = 0;

  /** A SunVox song's Output module is always module 0. */
  const OUTPUT_MODULE = 0;

  /** The module used for a track whose device names none, or an unknown one. */
  const FALLBACK_DEVICE = "Analog generator";

  /** A device type that only exists under the test hooks (see `buildSlot`). */
  const FAILING_DEVICE = "__fail_device";

  /** MIDI pitch → SunVox note number (see the header: MIDI 60 is note 37). */
  const MIDI_TO_NOTE = -23;

  /** The lowest and highest note number the library accepts. */
  const LOWEST_NOTE = 1;
  const HIGHEST_NOTE = 127;

  /** Velocity is `1..129` in SunVox; 0 means "the module's default". */
  const LOWEST_VELOCITY = 1;
  const HIGHEST_VELOCITY = 129;

  /** SunVox's "all notes off for this module" command. */
  const NOTECMD_NOTE_OFF = 128;

  /**
   * A track's gain is held between these, in dB: the document's range. −60 dB
   * is a real −60 dB in the mix below, never silence (mute is what silences a
   * track).
   */
  const LOWEST_GAIN_DB = -60;
  const HIGHEST_GAIN_DB = 12;

  /** The slot volume every engine runs at: unity, so gain belongs to the mix. */
  const SLOT_VOLUME_UNITY = 256;

  /**
   * `sv_init` flags, inlined because the vendored loader (which defines the
   * `SV_INIT_FLAG_*` names) is not part of this module:
   * no debug output, our own audio callback, float32 samples, one thread.
   */
  const INIT_FLAGS =
    (1 << 0) | /* SV_INIT_FLAG_NO_DEBUG_OUTPUT */
    (1 << 1) | /* SV_INIT_FLAG_USER_AUDIO_CALLBACK */
    (1 << 3) | /* SV_INIT_FLAG_AUDIO_FLOAT32 */
    (1 << 4); /* SV_INIT_FLAG_ONE_THREAD */

  /** How much audio between two `position` messages, in seconds. */
  const POSITION_INTERVAL_SECONDS = 0.05;

  /** The smallest block this processor allocates and primes for. */
  const INITIAL_QUANTUM = 128;

  /** The device engine that marks a track as a PCM one (see `isAudioTrack`). */
  const AUDIO_ENGINE = "audio";

  /** The device engine that marks a track as a sampler one (see `isSamplerTrack`). */
  const SAMPLER_ENGINE = "sampler";

  /**
   * The device engine that marks a track as a SoundFont one (see
   * `isFontTrack`): it plays a preset of one library font through
   * `font-voice.js`.
   */
  const FONT_ENGINE = "soundfont";

  /**
   * How many bytes of fonts one processor holds at once when the client names
   * no other cap: the plan's 1 GiB. An offline render may pass its own
   * (`processorOptions.maxFontBytes`), exactly as it does for samples. The cap
   * counts the files plus their decoded sample data; past it the least recently
   * played font NO track of the current song plays is unloaded and requested
   * again, and a load the song's own fonts leave no room for is refused with a
   * reason the page shows.
   */
  const DEFAULT_MAX_FONT_BYTES = 1024 * 1024 * 1024;

  /**
   * Why a load's own request is answered without its bank being parsed: a newer
   * load of the same font replaced it, or the font was unloaded before the job
   * that would have parsed it ran (see `parseFont` and `unloadLibrary`).
   */
  const LOAD_SUPERSEDED = "A newer load of this instrument replaced this one.";
  const LOAD_CANCELLED = "The instrument was unloaded before it finished loading.";

  /** The empty list a host answers its `take*` calls with, so a run allocates none. */
  const NO_IDS = Object.freeze([]);

  /** The empty per-track map a host without a synth hands back every run. */
  const NO_OUTPUTS = Object.freeze(new Map());

  /**
   * A font host that holds nothing, for an engine module built without
   * `font-voice.js` (a host that composes its own file list, as two of the
   * engine's tests do). Every call is a no-op, so a soundfont track in such an
   * engine is silent and reported like a font that is not loaded, and nothing
   * throws on the audio thread.
   *
   * It is built per processor — its `assign` remembers that processor's own
   * soundfont tracks, so two engines in one process never share them. It still
   * answers `missing()` with EVERY soundfont track's font, so the page is told
   * once per font id that nothing here can play it — and it hands back the same
   * empty map and lists every run, so it allocates nothing per block.
   * @returns {object}
   */
  function noFontHost() {
    /** The soundfont tracks last given to this no-op host. */
    let noFontSpecs = [];
    return {
      ready: function ready() {
        return Promise.resolve();
      },
      load: function load() {
        return Promise.reject(new Error("the SoundFont host is not part of this engine"));
      },
      unload: function unload() {},
      isLoaded: function isLoaded() {
        return false;
      },
      assign: function assign(list) {
        noFontSpecs = Array.isArray(list) ? list : [];
      },
      channelFor: function channelFor() {
        return null;
      },
      outputFor: function outputFor() {
        return null;
      },
      noteOn: function noteOn() {},
      noteOff: function noteOff() {},
      process: function process() {
        return NO_OUTPUTS;
      },
      missing: function missing() {
        // There is no synth at all, so every font the song's tracks name is
        // missing. The processor reports each id once (`fontNeeded`).
        const ids = new Set();
        for (let index = 0; index < noFontSpecs.length; index += 1) {
          const spec = noFontSpecs[index];
          const id = spec && spec.font_id !== undefined && spec.font_id !== null ? String(spec.font_id) : "";
          if (id !== "") ids.add(id);
        }
        return Array.from(ids).sort();
      },
      takeEvicted: function takeEvicted() {
        return NO_IDS;
      },
      takeFailures: function takeFailures() {
        return NO_IDS;
      },
      loadedIds: function loadedIds() {
        return NO_IDS;
      },
      stats: function stats() {
        return null;
      },
      fontSynth: function fontSynth() {
        return null;
      },
      destroy: function destroy() {
        noFontSpecs = [];
      },
    };
  }

  /** How many voices one sampler track holds, and how many the song may sound. */
  const SAMPLER_VOICES_PER_TRACK = 16;
  const SAMPLER_VOICES_SONG_WIDE = 64;

  /**
   * How many stolen voices one track can ring out at once. The 16 voice slots
   * are all in use when a steal happens, so the stolen voice fades in one of
   * these tails instead of holding the slot it is losing; two cover a steal
   * chain, and past them a stolen voice is simply cut.
   */
  const STOLEN_TAILS_PER_TRACK = 2;

  /**
   * How many bytes of decoded samples may be loaded at once when the client
   * asks for nothing else: the browser panel's cap. Past it the
   * least-recently-triggered sample is unloaded (the client reloads it when a
   * `sample_needed` says so). A caller that knows better passes its own cap as
   * `processorOptions.maxSampleBytes`; an offline render does, sized to the
   * samples its window plays so that none of them is trimmed away.
   */
  const DEFAULT_MAX_SAMPLE_BYTES = 256 * 1024 * 1024;

  /**
   * What a trigger for a sample the client has not loaded is reported with,
   * once per sample id.
   * @param {string} sampleId
   * @returns {string}
   */
  function missingSampleText(sampleId) {
    return `Sample ${sampleId} is not loaded yet.`;
  }

  /** How long a comp-boundary crossfade runs, in frames. */
  const VOICE_FADE_FRAMES = 64;

  /**
   * How long a chain edit's crossfade runs, in frames (plan 1d: any chain edit
   * while the song plays fades old → new over 64 frames). Counted in frames, so
   * it is the same ramp whatever block size the host asks for.
   */
  const CHAIN_FADE_FRAMES = 64;

  /**
   * How many blends may be nested inside one another. A blend holds the chain an
   * edit replaced, so an edit that lands while a blend is still fading builds one
   * blend around another; the scratch pairs `runBlend` runs the arriving path in
   * are preallocated to this depth, and a chain rewritten more often than this
   * inside a few milliseconds settles by letting the arriving path take over (see
   * `runBlend`).
   */
  const BLEND_DEPTH = 3;

  /**
   * The longest run of frames one insert is handed at a time: the block
   * `engine/faust-host.js` lays its wasm buffers out for. A run longer than this
   * (only a host with a bigger quantum than 128 makes one) is offered to each
   * insert in pieces of this many frames.
   */
  const INSERT_BLOCK = 128;

  /**
   * The four inserts `engine/dynamics.js` builds in JavaScript (`KINDS` there).
   * Every other kind of `EFFECT_PARAMS` is a compiled Faust effect. A worklet
   * cannot import the dynamics module's list, so the names are duplicated here
   * and a test holds the two together.
   */
  const DYNAMICS_KINDS = Object.freeze(["compressor", "limiter", "gate", "deesser"]);

  /**
   * What an insert's kind is called in a sentence, exactly as
   * `server/doc.js`'s `EFFECT_PARAMS[kind].label` spells it ("equalizer",
   * "de-esser", …). A worklet cannot import the document, so the labels are
   * duplicated here and a test pins the two copies together: the message a
   * bypassed insert is reported with has to name the effect the panel names.
   * `amp` is not in `EFFECT_PARAMS` (an amp is a capture and a cabinet, not an
   * effect with settings) and its label is `AMP_PARAMS.amp.label`.
   */
  const INSERT_LABELS = Object.freeze({
    eq: "equalizer",
    filter: "filter",
    delay: "delay",
    reverb: "reverb",
    chorus: "chorus",
    phaser: "phaser",
    saturation: "saturation",
    compressor: "compressor",
    limiter: "limiter",
    gate: "gate",
    deesser: "de-esser",
    amp: "amp",
  });

  /**
   * The one insert kind whose sound is a library FILE the operator chose: a NAM
   * capture through a cabinet IR (`server/doc.js`'s `AMP_KIND`).
   */
  const AMP_KIND = "amp";

  /** The two library kinds an amp insert names, and their entry fields. */
  const CAPTURE_KIND = "nam";
  const CABINET_KIND = "ir";

  /**
   * An amp insert's three numbers, as `server/doc.js`'s `AMP_PARAMS.amp.params`
   * ranges them: the input trim, the output trim and the cabinet's wet share.
   * A worklet cannot import the document, so the ranges are duplicated here.
   */
  const AMP_INPUT_DB = Object.freeze([-24, 24]);
  const AMP_OUTPUT_DB = Object.freeze([-24, 12]);
  const AMP_IR_MIX = Object.freeze([0, 1]);

  /**
   * What an amp insert whose capture is not on this device is reported with: the
   * page's own sentence (a library entry nobody downloaded, or one still
   * uploading). A capture that IS here but cannot be played is reported with the
   * reason `engine/nam-host.js` gives — the plan's re-export sentence for a
   * legacy model, or "This file is not a NAM capture." — and the cabinet's own
   * sentence comes from `engine/convolver.js`.
   */
  const CAPTURE_NOT_HERE_TEXT = "This capture isn't on this device.";

  /** How an amp insert's key is spelled in the NAM host. The suffix is a number
   * owned by the insert OBJECT (not by the document's insert id): a chain edit
   * that blends an amp out and back in runs two runners for one insert, and each
   * one needs its own NAM state.
   */
  const AMP_INSTANCE_PREFIX = "insert:";

  /**
   * The cabinet length tolerance the page and the server use too: two frames
   * past the rate. A cabinet shipped as exactly one second at 44.1 kHz is 44101
   * frames, and it loads (see `lengthProblem` in engine/convolver.js).
   */
  const IR_LENGTH_TOLERANCE_FRAMES = 2;

  /** The master's gain range, in dB: `MIXER_RANGES.master.gain_db` in `doc.js`. */
  const LOWEST_MASTER_GAIN_DB = -24;
  const HIGHEST_MASTER_GAIN_DB = 12;

  /** A return's gain range, in dB: `MIXER_RANGES.return.gain_db` in `doc.js`. */
  const LOWEST_RETURN_GAIN_DB = -60;
  const HIGHEST_RETURN_GAIN_DB = 12;

  /** A send's level range, in dB: `MIXER_RANGES.send.level_db` in `doc.js`. */
  const LOWEST_SEND_DB = -60;
  const HIGHEST_SEND_DB = 6;

  /** How much audio between two `meter` messages, in seconds. */
  const METER_INTERVAL_SECONDS = 0.1;

  /** The mixer an engine with no song (or no mixer containers) runs: nothing. */
  const NO_MIXER = Object.freeze({
    chains: new Map(),
    sendsByTrack: new Map(),
    returns: Object.freeze([]),
    masterGainDb: 0,
  });

  /** The chain an owner with no inserts in the document has. */
  const NO_INSERTS = Object.freeze([]);

  /**
   * The frame grid motion is read on: a swept voice is rendered in runs that
   * never cross one of these boundaries, counted from the engine's first frame
   * (`absoluteFrame % MOTION_SUB_STEP === 0`), and every lane is evaluated once
   * per sub-step. `32` divides the usual 128-frame quantum, so a host that hands
   * the processor a whole quantum still gets four sub-steps out of it, and the
   * boundaries are absolute — which is what keeps the values (and so the audio)
   * independent of the block size the host chose.
   */
  const MOTION_SUB_STEP = 32;

  /**
   * The envelope stages `sampler-voice.js` counts through, as numbers: motion
   * applies an envelope time to the stage the voice is in, and this file reads
   * the stage number the voice carries.
   */
  const STAGE_ATTACK = 0;
  const STAGE_DECAY = 1;
  const STAGE_SUSTAIN = 2;

  /** The pad's numeric fields a motion lane may sweep (see `MOTION_PARAMS`). */
  const MOTION_RANGES = Object.freeze({
    pitch: Object.freeze([-24, 24]),
    gain_db: Object.freeze([-60, 12]),
    pan: Object.freeze([-1, 1]),
    attack_ms: Object.freeze([0, 10000]),
    decay_ms: Object.freeze([0, 10000]),
    sustain: Object.freeze([0, 1]),
    release_ms: Object.freeze([0, 10000]),
    cutoff_hz: Object.freeze([20, 20000]),
    resonance: Object.freeze([0, 1]),
  });

  /**
   * Each sweepable field's bit in a voice's swept mask (`voice.motion_mask`):
   * the fields one sub-step's lanes put on a voice, so the next sub-step knows
   * exactly which of them no lane covers any more and gives those back — a
   * cleared lane never leaves a stale value on a voice another lane still
   * sweeps.
   */
  const MOTION_PARAM_BITS = Object.freeze({
    pitch: 1,
    gain_db: 2,
    pan: 4,
    attack_ms: 8,
    decay_ms: 16,
    sustain: 32,
    release_ms: 64,
    cutoff_hz: 128,
    resonance: 256,
  });

  /** Every sweepable field, in the order `MOTION_PARAM_BITS` numbers them. */
  const MOTION_PARAM_NAMES = Object.freeze(Object.keys(MOTION_PARAM_BITS));

  /** Four beats to the bar, everywhere in Studio. */
  const BEATS_PER_BAR = 4;

  /** The tempo a song without a usable `meta.bpm` counts the performance bus at. */
  const DEFAULT_BPM = 120;

  /**
   * A song's tempo, from its own `meta.bpm`; a missing or unusable one is 120.
   * @param {object} snapshot
   * @returns {number}
   */
  function bpmOf(snapshot) {
    const meta = snapshot && typeof snapshot.meta === "object" && snapshot.meta ? snapshot.meta : {};
    const value = Number(meta.bpm);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_BPM;
  }

  /** @returns {number} the value held between two bounds. */
  function clamp(value, low, high) {
    if (!Number.isFinite(value)) return low;
    if (value < low) return low;
    if (value > high) return high;
    return value;
  }

  /**
   * One motion lane's value at a step position: linear between two points, and
   * wrapped round the loop from the last point to the first (a lane with one
   * point holds it everywhere).
   *
   * `cursor` is the index of the last point at or before `stepFrac`, as the
   * sub-step reader keeps it (`advanceMotionCursor`): the segment is then found
   * without walking the list. A caller that passes no cursor gets the same value
   * from a scan, so a one-off read stays correct.
   *
   * Only IEEE doubles, in one fixed order, so both hosts read the same value for
   * the same frame (see the parity note in the file header).
   * @param {Array<{step_frac: number, value: number}>} points sorted by step
   * @param {number} stepFrac where the loop stands, in steps
   * @param {number} lengthSteps the loop's length, in steps
   * @param {number} [cursor] the index of the last point at or before `stepFrac`
   * @returns {number}
   */
  function motionValueAt(points, stepFrac, lengthSteps, cursor) {
    const count = points.length;
    if (count === 0) return 0;
    if (count === 1) return points[0].value;
    const first = points[0];
    const last = points[count - 1];
    // From the last point round to the first: the loop wraps, so the curve has
    // no end and a sweep recorded anywhere plays back everywhere.
    const wrap = first.step_frac + lengthSteps - last.step_frac;
    if (stepFrac < first.step_frac || stepFrac >= last.step_frac) {
      if (!(wrap > 0)) return last.value;
      const into =
        stepFrac < first.step_frac ? stepFrac + lengthSteps - last.step_frac : stepFrac - last.step_frac;
      return last.value + (first.value - last.value) * (into / wrap);
    }
    let at = Number(cursor);
    if (!(at >= 0) || at > count - 2) {
      // No usable cursor: find the segment the plain way (a lane with one point
      // is answered above, so there is always a pair to land in).
      at = 0;
      while (at + 1 < count && points[at + 1].step_frac <= stepFrac) at += 1;
      if (at > count - 2) at = count - 2;
    }
    const previous = points[at];
    const next = points[at + 1];
    const span = next.step_frac - previous.step_frac;
    if (!(span > 0)) return next.value;
    return previous.value + (next.value - previous.value) * ((stepFrac - previous.step_frac) / span);
  }

  /**
   * Walk one lane's cursor forward to the segment `stepFrac` falls in: the index
   * of the last point at or before it.
   *
   * A cursor only ever moves forward, so a whole loop over a 4096-point lane
   * costs one pass and not one scan per sub-step. The reader resets it to 0 when
   * the step position jumps backwards (a loop wrap) or when a new descriptor
   * moves the clock under the curve, so it can never point at a stale segment.
   * @param {Array<{step_frac: number, value: number}>} points sorted by step
   * @param {number} stepFrac where the loop stands, in steps
   * @param {number} cursor where this lane stood last time
   * @returns {number} the new cursor
   */
  function advanceMotionCursor(points, stepFrac, cursor) {
    const count = points.length;
    if (count === 0) return 0;
    let at = cursor;
    if (!(at >= 0) || at >= count) at = 0;
    while (at + 1 < count && points[at + 1].step_frac <= stepFrac) at += 1;
    return at;
  }

  /** @returns {string} an id in the form a Map is keyed by. */
  function asId(value) {
    return value === undefined || value === null ? "" : String(value);
  }

  /**
   * The AudioWorkletGlobalScope's `currentFrame`: the frame the whole context
   * has rendered so far, which every processor on that context reads the same
   * way. A host that does not provide it answers `null`.
   * @returns {number|null}
   */
  function contextFrameNow() {
    // `typeof` on an undeclared identifier is safe and is the only way to ask
    // for a worklet global without assuming the host has one.
    if (typeof currentFrame === "undefined") return null;
    return typeof currentFrame === "number" && Number.isFinite(currentFrame) ? currentFrame : null;
  }

  /** @returns {string} the module type a track's device names. */
  function deviceType(track) {
    const device = track && typeof track === "object" ? track.device : null;
    const type = device && typeof device.type === "string" ? device.type.trim() : "";
    return type === "" ? FALLBACK_DEVICE : type;
  }

  /**
   * Whether a track plays recorded takes instead of a SunVox module. An audio
   * track's device is exactly `{engine: "audio"}` (see `doc.js`).
   * @param {object} track
   * @returns {boolean}
   */
  function isAudioTrack(track) {
    const device = track && typeof track === "object" ? track.device : null;
    return !!(device && typeof device === "object" && device.engine === AUDIO_ENGINE);
  }

  /**
   * Whether a track plays a kit of pads instead of notes or takes. A sampler
   * track's device is exactly `{engine: "sampler"}` (see `doc.js`); its kit
   * lives in the song's own `banks` and `pads`, never inside the device.
   * @param {object} track
   * @returns {boolean}
   */
  function isSamplerTrack(track) {
    const device = track && typeof track === "object" ? track.device : null;
    return !!(device && typeof device === "object" && device.engine === SAMPLER_ENGINE);
  }

  /**
   * Whether a track plays a preset of a library font. A soundfont track's device
   * is `{engine: "soundfont", font_id, bank, program}` (see `doc.js`).
   * @param {object} track
   * @returns {boolean}
   */
  function isFontTrack(track) {
    const device = track && typeof track === "object" ? track.device : null;
    return !!(device && typeof device === "object" && device.engine === FONT_ENGINE);
  }

  /**
   * The font spec one soundfont track contributes to its font host, in snapshot
   * order: the entry it plays and the preset inside it.
   * @param {object} track
   * @returns {{track_id: string, font_id: string, bank: number, program: number}}
   */
  function fontSpecOf(track) {
    const device = track && typeof track === "object" ? track.device : null;
    const plain = device && typeof device === "object" ? device : {};
    return {
      track_id: typeof track.id === "string" ? track.id : "",
      font_id: typeof plain.font_id === "string" ? plain.font_id : "",
      bank: clamp(Math.round(Number(plain.bank)), 0, 128),
      program: clamp(Math.round(Number(plain.program)), 0, 127),
    };
  }

  /**
   * The key one pad lives under in the song's `pads` container — the same key
   * `doc.js` writes, so a pad is one lookup and never a walk over the kit.
   * @param {string} trackId
   * @param {string} bankId
   * @param {number} index
   * @returns {string}
   */
  function padKey(trackId, bankId, index) {
    return `${asId(trackId)}/${asId(bankId)}/${Math.trunc(Number(index) || 0)}`;
  }

  /**
   * The key one slice lives under in the song's `slices` container.
   * @param {string} sampleId
   * @param {string} sliceId
   * @returns {string}
   */
  function sliceKey(sampleId, sliceId) {
    return `${asId(sampleId)}/${asId(sliceId)}`;
  }

  /**
   * Copy the bytes of a transferred bank into a JS-owned `Uint8Array`. A view
   * into a larger buffer is copied, so the parser never reads past the file.
   * @param {unknown} value
   * @returns {Uint8Array}
   */
  function readBytes(value) {
    if (value instanceof Uint8Array) {
      return value.byteLength === value.buffer.byteLength && value.byteOffset === 0
        ? value
        : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    }
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    }
    return new Uint8Array(0);
  }

  /**
   * Copy the channels a client posted into JS-owned `Float32Array`s, dropping
   * anything that is not a channel. A view into a larger buffer is copied, so
   * the voice never reads past its own channel.
   * @param {unknown} channels
   * @returns {Float32Array[]}
   */
  function readChannels(channels) {
    const list = [];
    const raw = Array.isArray(channels) ? channels : [];
    for (const channel of raw) {
      if (channel instanceof Float32Array) list.push(channel);
      else if (ArrayBuffer.isView(channel)) {
        list.push(
          new Float32Array(channel.buffer.slice(channel.byteOffset, channel.byteOffset + channel.byteLength)),
        );
      } else if (Array.isArray(channel)) list.push(Float32Array.from(channel));
    }
    return list;
  }

  /**
   * A silent PCM voice. `position` is the frame of the take it will read next
   * (negative until the take starts); `gain` is its fade envelope. The ramp is
   * advanced once per rendered frame in `advanceFade()`, so it is the same 64
   * frames whatever block size the host asks for. `fade` is a placement's
   * linear gain ramp on top of that envelope (see `startFade`).
   * @returns {object}
   */
  function newVoice() {
    return {
      channels: null,
      position: 0,
      sounding: false,
      gain: 0,
      fadeRemaining: 0,
      fadeStep: 0,
      fadeTarget: 1,
      fade: null,
    };
  }

  /**
   * The gain multiplier a voice's placement fade contributes at this frame
   * (1 when it has none).
   * @param {object} voice
   * @returns {number}
   */
  function fadeGainOf(voice) {
    const fade = voice.fade;
    if (!fade) return 1;
    if (fade.index >= fade.frames) return fade.to;
    return fade.from + ((fade.to - fade.from) * fade.index) / fade.frames;
  }

  /**
   * Advance a voice's placement fade by one frame, after that frame was
   * rendered.
   * @param {object} voice
   */
  function advanceVoiceFade(voice) {
    const fade = voice.fade;
    if (!fade || fade.index >= fade.frames) return;
    fade.index += 1;
  }

  /**
   * Start a linear ramp of one voice's gain, over the crossfade length.
   * @param {object} voice
   * @param {number} target the gain to reach
   */
  function beginFade(voice, target) {
    voice.fadeRemaining = VOICE_FADE_FRAMES;
    voice.fadeStep = (target - voice.gain) / VOICE_FADE_FRAMES;
    voice.fadeTarget = target;
  }

  /**
   * Send one voice out: 1 → 0 over the crossfade length, from wherever its
   * gain is now. A voice already on its way out keeps the ramp it has, so a
   * stop landing after the start that began the crossfade cannot restart it.
   * @param {object} voice
   */
  function beginFadeOut(voice) {
    if (!voice.sounding) return;
    if (voice.fadeRemaining > 0 && voice.fadeTarget === 0) return;
    if (voice.gain <= 0) {
      voice.sounding = false;
      return;
    }
    beginFade(voice, 0);
  }

  /**
   * Advance one voice's envelope by one frame, after that frame was rendered.
   * @param {object} voice
   */
  function advanceFade(voice) {
    if (voice.fadeRemaining <= 0) return;
    voice.fadeRemaining -= 1;
    if (voice.fadeRemaining === 0) {
      voice.gain = voice.fadeTarget;
      if (voice.gain <= 0) voice.sounding = false;
      return;
    }
    voice.gain += voice.fadeStep;
  }

  /**
   * A gain in dB as a linear factor, held inside the document's range. A
   * missing or non-finite value is 0 dB.
   * @param {unknown} value
   * @param {number} low
   * @param {number} high
   * @returns {number}
   */
  function dbToGain(value, low, high) {
    const db = Number(value);
    return Math.pow(10, (Number.isFinite(db) ? clamp(db, low, high) : 0) / 20);
  }

  /**
   * The constant-power pan pair a pan position makes, exactly as `applyMix` and
   * the sampler's voices work it out.
   * @param {unknown} value -1 (left) .. 1 (right); anything else is centre
   * @param {number} gain the linear gain to pan
   * @returns {{left: number, right: number}}
   */
  function panPair(value, gain) {
    const pan = Number(value);
    const theta = ((Number.isFinite(pan) ? clamp(pan, -1, 1) : 0) + 1) * Math.PI * 0.25;
    return { left: gain * Math.cos(theta), right: gain * Math.sin(theta) };
  }

  /**
   * The label a message names an insert's kind with, as the panel spells it
   * (`EFFECT_PARAMS[kind].label` in `server/doc.js`). A kind this engine does
   * not know is named as it came.
   * @param {string} kind
   * @returns {string}
   */
  function insertLabelOf(kind) {
    const name = asId(kind);
    return Object.hasOwn(INSERT_LABELS, name) ? INSERT_LABELS[name] : name === "" ? "effect" : name;
  }

  /**
   * The inserts of ONE chain as the engine runs them: the song's `inserts`
   * container read into plain specs, filtered to that owner and sorted by
   * `order` then id — the same order `doc.js`'s `byInsertOrder` gives.
   * @param {object} inserts the snapshot's `inserts` container
   * @param {string} owner `"track:<id>"`, `"return:<id>"` or `"master"`
   * @returns {Array<{id: string, kind: string, bypass: boolean, params: object}>}
   */
  function insertSpecsFor(inserts, owner) {
    const specs = [];
    if (!inserts || typeof inserts !== "object") return specs;
    for (const key of Object.keys(inserts)) {
      const insert = inserts[key];
      if (!insert || typeof insert !== "object") continue;
      if (asId(insert.owner) !== owner) continue;
      const order = Number(insert.order);
      specs.push({
        id: asId(insert.id) === "" ? key : asId(insert.id),
        kind: asId(insert.kind),
        order: Number.isFinite(order) ? order : 0,
        bypass: insert.bypass === true,
        params: insert.params && typeof insert.params === "object" ? insert.params : {},
      });
    }
    specs.sort((left, right) => {
      if (left.order !== right.order) return left.order < right.order ? -1 : 1;
      if (left.id === right.id) return 0;
      return left.id < right.id ? -1 : 1;
    });
    return specs;
  }

  /**
   * The song's whole mixer as the engine reads it: one sorted chain per owner,
   * the sends sorted by the track they leave, the returns in the snapshot's own
   * order and the master's gain. Read once per song, never inside a block.
   * @param {object} snapshot the song as `server/doc.js`'s `snapshot()` returns it
   * @returns {{chains: Map<string, object[]>, sendsByTrack: Map<string, object[]>,
   *            returns: Array<{id: string, name: string, gain_db: number,
   *                            pan: number, mute: boolean}>, masterGainDb: number}}
   */
  function mixerSpecOf(snapshot) {
    const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
    const inserts = snap.inserts && typeof snap.inserts === "object" ? snap.inserts : {};
    const tracks = Array.isArray(snap.tracks) ? snap.tracks : [];
    const returnValues = snap.returns && typeof snap.returns === "object" ? snap.returns : {};
    const sends = snap.sends && typeof snap.sends === "object" ? snap.sends : {};
    const master = snap.master && typeof snap.master === "object" ? snap.master : {};

    const chains = new Map();
    chains.set("master", insertSpecsFor(inserts, "master"));
    for (let index = 0; index < tracks.length; index += 1) {
      const id = asId(tracks[index] && tracks[index].id);
      if (id === "") continue;
      chains.set(`track:${id}`, insertSpecsFor(inserts, `track:${id}`));
    }

    const returns = [];
    for (const key of Object.keys(returnValues)) {
      const entry = returnValues[key];
      if (!entry || typeof entry !== "object") continue;
      const id = asId(entry.id) === "" ? key : asId(entry.id);
      const name = typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : id;
      const gain = Number(entry.gain_db);
      const pan = Number(entry.pan);
      returns.push({
        id: id,
        name: name,
        gain_db: Number.isFinite(gain) ? gain : 0,
        pan: Number.isFinite(pan) ? pan : 0,
        mute: entry.mute === true,
      });
      chains.set(`return:${id}`, insertSpecsFor(inserts, `return:${id}`));
    }

    // A send is keyed by the pair it joins; its own fields say the same pair, and
    // the key is what a damaged one is read from (as `doc.js` reads it).
    const sendsByTrack = new Map();
    for (const key of Object.keys(sends)) {
      const send = sends[key];
      if (!send || typeof send !== "object") continue;
      const parts = key.split("/");
      const trackId = asId(send.track_id) === "" ? (parts.length === 2 ? parts[0] : "") : asId(send.track_id);
      const returnId = asId(send.return_id) === "" ? (parts.length === 2 ? parts[1] : "") : asId(send.return_id);
      if (trackId === "" || returnId === "") continue;
      const level = Number(send.level_db);
      const list = sendsByTrack.get(trackId);
      const spec = {
        return_id: returnId,
        level_db: Number.isFinite(level) ? level : 0,
        pre: send.pre === true,
      };
      if (list) list.push(spec);
      else sendsByTrack.set(trackId, [spec]);
    }

    const gainDb = Number(master.gain_db);
    return {
      chains: chains,
      sendsByTrack: sendsByTrack,
      returns: returns,
      masterGainDb: Number.isFinite(gainDb) ? gainDb : 0,
    };
  }

  /**
   * What makes two builds of one chain "the same chain": each insert's id, kind
   * and bypass, in the order the chain runs them. A chain whose key is unchanged
   * only had parameters turned, so it keeps its insert objects (and their state)
   * and needs no crossfade. A different key — another kind, another order, an
   * insert added, removed or bypassed — is a chain edit.
   * @param {object[]} specs
   * @returns {string}
   */
  function chainKeyOf(specs) {
    let key = "";
    for (let index = 0; index < specs.length; index += 1) {
      const spec = specs[index];
      key += `${index === 0 ? "" : "\u0001"}${spec.id}\u0000${spec.kind}\u0000${spec.bypass ? "1" : "0"}`;
    }
    return key;
  }

  /**
   * Whether an error from the NAM engine is a wasm TRAP (the module is wounded)
   * rather than a capture the engine refused. A trap belongs to the insert that
   * hit it: the other amps on the same capture must not be marked failed, and
   * the shared module is rebuilt for them.
   * @param {unknown} error
   * @returns {boolean}
   */
  function isNamTrap(error) {
    if (!error) return false;
    if (typeof WebAssembly !== "undefined" && error instanceof WebAssembly.RuntimeError) return true;
    const message = String(error && error.message ? error.message : error);
    return /unreachable|out of bounds|memory access|table index|wasm|trap|null function/i.test(message);
  }

  /**
   * The frames one chain puts on the path it feeds once an edit has settled: the
   * sum of its inserts' own latency. Every track and return insert is
   * zero-latency, so in practice this is the master chain's limiter (plan 1d:
   * only the master limiter looks ahead) — plus any amp insert whose capture has
   * to be converted, which reports the rate bridges' real delay.
   *
   * NOTE (a design question for the operator, deliberately NOT implemented): a
   * rate-converted amp delays its track by ~0.7 ms (the two bridges' look-ahead,
   * reported here and primed for) but a track has no delay COMPENSATION. A
   * parallel or doubled track that does not go through the same converted amp
   * therefore arrives earlier, and the two can comb. Whether a track should be
   * delayed to match its amp's latency — and where that delay belongs — is the
   * operator's call; this function only reports the number.
   *
   * A runner an edit has retired does not count — the chain that stays is the one
   * the number is about — and neither does one the NaN guard has bypassed: a
   * faulted insert is a pass-through, so it delays nothing. A blend counts the
   * path it is arriving at, which is the chain the fade ends on.
   * @param {object[]} chain
   * @returns {number}
   */
  function chainLatencyOf(chain) {
    let frames = 0;
    for (let index = 0; index < chain.length; index += 1) {
      const node = chain[index];
      if (!node) continue;
      if (node.blend) {
        frames += chainLatencyOf(node.fresh);
        continue;
      }
      if (node.retired || node.bypass || node.faulted) continue;
      const insert = node.insert;
      if (insert && insert.latencyFrames > 0) frames += insert.latencyFrames;
    }
    return frames;
  }

  /**
   * The frames a chain is delaying the path it feeds RIGHT NOW — the same sum as
   * `chainLatencyOf`, taken from the weight each insert is at rather than from
   * where it is headed. An insert counts once it is more than half in the path, a
   * runner on its way out counts until it is less than half in, and a blend
   * counts the path it is closer to, so the number switches at the fade's
   * midpoint. That is the delay the audio really has, and so the number a master
   * tap and every meter reading have to be stamped with (see
   * `postMasterLatency`).
   * @param {object[]} chain
   * @returns {number}
   */
  function runningLatencyOf(chain) {
    let frames = 0;
    for (let index = 0; index < chain.length; index += 1) {
      const node = chain[index];
      if (!node) continue;
      if (node.blend) {
        frames += runningLatencyOf(node.weight >= 0.5 ? node.fresh : node.leaving);
        continue;
      }
      const insert = node.insert;
      if (!insert || node.faulted || !(node.wet >= 0.5)) continue;
      if (insert.latencyFrames > 0) frames += insert.latencyFrames;
    }
    return frames;
  }

  /**
   * The runners of a chain in the order it plays them, for a snapshot that only
   * turned parameters: a blend contributes the path it is arriving at (what is
   * leaving never takes parameters again) and a retired runner is left out.
   * @param {object[]} chain
   * @param {object[]} out collected into this list, in order
   * @returns {void}
   */
  function collectRunnerOrder(chain, out) {
    for (let index = 0; index < chain.length; index += 1) {
      const node = chain[index];
      if (!node) continue;
      if (node.blend) {
        collectRunnerOrder(node.fresh, out);
        continue;
      }
      if (!node.retired) out.push(node);
    }
  }

  /**
   * Every runner a chain still HOLDS: both paths of a blend (the one fading out
   * included) and the runners an edit has retired but not yet folded away. What
   * this finds is what a chain can still be RUNNING, which is what decides whether
   * an amp insert's NAM instance is still needed (see `pruneAmpInstances`).
   * @param {object[]} chain
   * @param {object[]} out collected into this list, in order
   * @returns {void}
   */
  function collectEveryRunner(chain, out) {
    for (let index = 0; index < chain.length; index += 1) {
      const node = chain[index];
      if (!node) continue;
      if (node.blend) {
        collectEveryRunner(node.leaving, out);
        collectEveryRunner(node.fresh, out);
        continue;
      }
      out.push(node);
    }
  }

  /**
   * One chain insert's parameters as a comparable key. Two snapshots that carry
   * the same settings for one insert produce the same key, so a snapshot that
   * turns nothing is not a rebuild — and, for an insert the NaN guard has
   * bypassed, not a re-arm either.
   * @param {object} params
   * @returns {string|null} null when the object cannot be serialised
   */
  function paramsKeyOf(params) {
    try {
      return JSON.stringify(params && typeof params === "object" ? params : {});
    } catch {
      return null;
    }
  }

  /**
   * Whether one block of audio holds a sample that is not a finite number: the
   * test the NaN guard makes at every insert's output. `v - v` is exactly 0 for
   * every finite double and NaN for a NaN or an infinity.
   * @param {Float32Array} left
   * @param {Float32Array} right
   * @param {number} frames
   * @returns {boolean}
   */
  function hasInvalidSample(left, right, frames) {
    for (let index = 0; index < frames; index += 1) {
      const value = left[index];
      if (value - value !== 0) return true;
      const other = right[index];
      if (other - other !== 0) return true;
    }
    return false;
  }

  /**
   * A track's device parameters as a plain object.
   * @param {object} track
   * @returns {object}
   */
  function deviceParams(track) {
    const device = track && typeof track === "object" ? track.device : null;
    const params = device && typeof device.params === "object" && device.params ? device.params : null;
    return params || {};
  }

  /**
   * A track's gain in dB, clamped to the document's range; a missing or
   * non-finite value means 0 dB.
   * @param {object} track
   * @returns {number} -60..+12
   */
  function gainDbOf(track) {
    const value = Number(track && track.gain_db);
    return Number.isFinite(value) ? clamp(value, LOWEST_GAIN_DB, HIGHEST_GAIN_DB) : 0;
  }

  /**
   * A track's pan, -1 (left) .. 1 (right); a missing or non-finite value means
   * centre.
   * @param {object} track
   * @returns {number} -1..1
   */
  function panOf(track) {
    const value = Number(track && track.pan);
    return Number.isFinite(value) ? clamp(value, -1, 1) : 0;
  }

  /**
   * The SunVox note number for a MIDI pitch.
   * @param {number} pitch MIDI pitch, 0..127
   * @returns {number} a note number the library accepts, 1..127
   */
  function noteFor(pitch) {
    return clamp(Math.round(Number(pitch)) + MIDI_TO_NOTE, LOWEST_NOTE, HIGHEST_NOTE);
  }

  /**
   * The SunVox velocity for a song velocity (1..127).
   *
   * SunVox's velocity range is 1..129 where 0 means "the module's default", so
   * a full-velocity note is 129, not 127.
   * @param {number} velocity
   * @returns {number} 1..129
   */
  function sunvoxVelocity(velocity) {
    const scaled = Math.round((Number(velocity) / 127) * 128) + 1;
    return clamp(scaled, LOWEST_VELOCITY, HIGHEST_VELOCITY);
  }

  /**
   * UTF-8 bytes for a string.
   *
   * `TextEncoder` is not guaranteed in every worklet host (and the SunVox calls
   * below only ever need module and controller names), so this encodes by hand.
   * @param {string} text
   * @returns {Uint8Array}
   */
  function utf8Bytes(text) {
    const bytes = [];
    for (let at = 0; at < text.length; at += 1) {
      let code = text.charCodeAt(at);
      if (code >= 0xd800 && code <= 0xdbff && at + 1 < text.length) {
        const low = text.charCodeAt(at + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          at += 1;
        }
      }
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      else if (code < 0x10000) {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      } else {
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f),
        );
      }
    }
    return new Uint8Array(bytes);
  }

  /**
   * Bind the SunVox calls this processor makes to one Emscripten instance.
   *
   * The vendored loader cannot be used: its `sv_*` functions and its callback
   * and scope scratch pointers are module-scope globals, bound to the single
   * instance it opened for itself. Talking to the `_sv_*` exports directly
   * keeps every instance's buffers in its own heap, which is what makes one
   * engine per track possible at all.
   * @param {object} module the instance `SunVoxLib()` resolved to
   * @returns {object} the calls this processor uses, all bound to `module`
   */
  function bindEngine(module) {
    /** @returns {number} a malloc'd, NUL-terminated UTF-8 C string (0 on failure). */
    function cstring(text) {
      const bytes = utf8Bytes(String(text));
      const pointer = module._malloc(bytes.length + 1);
      if (!pointer) return 0;
      module.HEAPU8.set(bytes, pointer);
      module.HEAPU8[pointer + bytes.length] = 0;
      return pointer;
    }

    return {
      /** @param {number} bytes @returns {number} a wasm pointer, 0 on failure. */
      alloc: function alloc(bytes) {
        return module._malloc(bytes);
      },
      /** @param {number} pointer @returns {void} */
      free: function free(pointer) {
        if (pointer) module._free(pointer);
      },
      /** @returns {number} the library version, or a negative error. */
      init: function init(freq, channels, flags) {
        return module._sv_init(0, freq, channels, flags);
      },
      /** @returns {number} 0 on success. */
      deinit: function deinit() {
        return module._sv_deinit();
      },
      /** @returns {number} Hz */
      sampleRate: function sampleRate() {
        return module._sv_get_sample_rate();
      },
      openSlot: function openSlot(slot) {
        return module._sv_open_slot(slot);
      },
      closeSlot: function closeSlot(slot) {
        return module._sv_close_slot(slot);
      },
      lockSlot: function lockSlot(slot) {
        return module._sv_lock_slot(slot);
      },
      unlockSlot: function unlockSlot(slot) {
        return module._sv_unlock_slot(slot);
      },
      playFromBeginning: function playFromBeginning(slot) {
        return module._sv_play_from_beginning(slot);
      },
      volume: function volume(slot, value) {
        return module._sv_volume(slot, value);
      },
      setEventT: function setEventT(slot, set, time) {
        return module._sv_set_event_t(slot, set, time);
      },
      sendEvent: function sendEvent(slot, track, note, velocity, mod, ctl, ctlValue) {
        return module._sv_send_event(slot, track, note, velocity, mod, ctl, ctlValue);
      },
      newModule: function newModule(slot, type, name, x, y, z) {
        const typePointer = cstring(type);
        const namePointer = cstring(name);
        try {
          return module._sv_new_module(slot, typePointer, namePointer, x, y, z);
        } finally {
          module._free(typePointer);
          module._free(namePointer);
        }
      },
      removeModule: function removeModule(slot, mod) {
        return module._sv_remove_module(slot, mod);
      },
      connectModule: function connectModule(slot, source, destination) {
        return module._sv_connect_module(slot, source, destination);
      },
      ctlCount: function ctlCount(slot, mod) {
        return module._sv_get_number_of_module_ctls(slot, mod);
      },
      /** @returns {string} a controller's name, "" when the index has none. */
      ctlName: function ctlName(slot, mod, ctl) {
        const pointer = module._sv_get_module_ctl_name(slot, mod, ctl);
        return pointer ? module.UTF8ToString(pointer) : "";
      },
      setCtl: function setCtl(slot, mod, ctl, value, scaled) {
        return module._sv_set_module_ctl_value(slot, mod, ctl, value, scaled);
      },
      /**
       * Render `frames` of this engine's mix into a buffer it owns in wasm
       * memory and return a view of the interleaved stereo result.
       * @param {number} pointer the wasm pointer to render into
       * @param {number} frames
       * @param {number} latency
       * @param {number} outTime the engine's frame clock
       * @returns {Float32Array} `frames * 2` interleaved samples
       */
      render: function render(pointer, frames, latency, outTime) {
        module._sv_audio_callback(pointer, frames, latency, outTime);
        // Read the heap view after the call: a growing heap replaces it.
        const start = pointer >> 2;
        return module.HEAPF32.subarray(start, start + frames * 2);
      },
    };
  }

  /**
   * Call the vendored `SunVoxLib()` factory with the options a worklet needs.
   *
   * `globalThis.process` is hidden for the synchronous prologue of that call
   * only: it is what the glue's `ENVIRONMENT_IS_NODE` detection reads, and the
   * Node branch would reach for `require("fs")`/`__dirname`, which this scope
   * does not have. Everything after the factory's first `await` sees the real
   * `process` again, and no Node-only path is reachable anyway. A host with no
   * `process` at all (a browser worklet) needs none of this.
   *
   * When the processor has already compiled the binary, the factory is handed
   * a synchronous `instantiateWasm` so each track's engine instantiates from
   * that one compiled module instead of compiling the bytes again.
   * @param {{wasmBinary: ArrayBuffer|Uint8Array, wasmModule?: WebAssembly.Module}} options
   * @returns {Promise<object>} the Emscripten module instance
   */
  function callSunVoxFactory(options) {
    const settings = {
      wasmBinary: options.wasmBinary,
      locateFile: function locateFile() {
        return "";
      },
      print: function print() {},
      printErr: function printErr() {},
    };
    if (options.wasmModule && typeof WebAssembly === "object") {
      const compiled = options.wasmModule;
      settings.instantiateWasm = function instantiateWasm(imports, done) {
        const instance = new WebAssembly.Instance(compiled, imports);
        done(instance, compiled);
        return instance.exports;
      };
    }
    if (globalThis.process === undefined) return SunVoxLib(settings);
    const saved = globalThis.process;
    let promise;
    try {
      globalThis.process = undefined;
      promise = SunVoxLib(settings);
    } finally {
      globalThis.process = saved;
    }
    return promise;
  }

  /**
   * One AudioWorkletProcessor that hosts the engine for one song: one SunVox
   * engine per track, the pure sequencer, and the mix.
   */
  class StudioProcessor extends AudioWorkletProcessor {
    /**
     * @param {{processorOptions?: {wasmBinary?: ArrayBuffer|Uint8Array, testHooks?: boolean,
     *          maxSampleBytes?: number}}} options
     */
    constructor(options) {
      super();

      const processorOptions = (options && options.processorOptions) || {};

      /** Whether the engine runs and the client has been told. */
      this.ready = false;
      /** The first error that stopped the engine, for `process()`'s silence. */
      this.failure = null;
      /** Whether that failure has been reported already (it is reported once). */
      this.failureReported = false;
      /** Test hook: throw inside the next block (see `receive`). */
      this.failNextBlock = false;
      /** Whether the client asked for the test hooks; off unless asked for. */
      this.testHooks = processorOptions.testHooks === true;

      /** The pure sequencer for this host's sample rate. */
      this.sequencer = StudioSequencer.create({ sampleRate: sampleRate });

      /** Absolute frame of the next block, so `block()` calls stay contiguous. */
      this.frame = 0;

      /**
       * The context's frame counter minus this processor's own, measured at
       * the first block (`null` until then). See `contextOffset()`.
       */
      this.frameOffset = null;

      /** Frames accumulated since the last `position` message. */
      this.sincePosition = 0;
      this.positionEvery = Math.max(1, Math.round(sampleRate * POSITION_INTERVAL_SECONDS));

      /** track id → track index, rebuilt on every song. */
      this.trackSlots = new Map();

      /** track index → that track's record (engine, device module, mix gains). */
      this.slots = [];

      /** take id → its decoded PCM, one Float32Array per channel. */
      this.takes = new Map();

      /** Take ids already reported as not loaded, so each is reported once. */
      this.missingTakes = new Set();

      /**
       * sample id → `{channels, frames, bytes, lastUsed}`, the decoded PCM the
       * sampler pads play (at the context's rate; the client resampled it).
       */
      this.samples = new Map();

      /** How many bytes those samples hold together, against `this.maxSampleBytes`. */
      this.sampleBytes = 0;

      /**
       * The song-wide cap those samples are held under: the browser's 256 MB,
       * or whatever the caller asked for (`processorOptions.maxSampleBytes`).
       */
      const askedCap = Number(processorOptions.maxSampleBytes);
      this.maxSampleBytes = Number.isFinite(askedCap) && askedCap > 0 ? askedCap : DEFAULT_MAX_SAMPLE_BYTES;

      /**
       * The cap the fonts are held under: the plan's 1 GiB, or what the caller
       * asked for (`processorOptions.maxFontBytes`, which an offline render
       * uses to hold a render to its own window).
       */
      const askedFontCap = Number(processorOptions.maxFontBytes);
      const fontCap = Number.isFinite(askedFontCap) && askedFontCap > 0 ? askedFontCap : DEFAULT_MAX_FONT_BYTES;

      /**
       * The cores the PAGE reported, for the NAM captures' slim size (plan 1d,
       * Task 13): `engine-client.js` measures `navigator.hardwareConcurrency` on
       * the main thread — where it exists — and hands it down, because an
       * `AudioWorkletGlobalScope` has no `navigator`. Undefined in an engine that
       * names none, and the NAM host then falls back to its own reading (which is
       * "no cores" in Node, so a render always plays the full capture).
       */
      const askedCores = Number(processorOptions.namCores);
      this.namCores = Number.isFinite(askedCores) && askedCores >= 0 ? askedCores : undefined;

      /** A counter every trigger bumps, so the oldest sample is the least recently played. */
      this.sampleClock = 0;

      /** Sample ids already reported as not loaded, so each is reported once. */
      this.missingSamples = new Set();

      /**
       * The SoundFont hosts (`font-voice.js`): one synth per font id, one MIDI
       * channel per track, and each track's own dry stereo pair (see the header).
       * Built on the first font the song (or a load) names: a song with no
       * soundfont tracks never pays for it. `null` until then.
       */
      this.fonts = null;

      /** The cap those fonts are held under (`processorOptions.maxFontBytes`). */
      this.maxFontBytes = fontCap;

      /**
       * The song's soundfont tracks, in snapshot order, as the font host reads
       * them (`fontSpecOf`). Rebuilt by every `syncSlots`.
       */
      this.fontTracks = [];

      /**
       * Bank loads that are waiting for a Stop: id → `{bytes, request_id}`, the
       * file's bytes and the request that load's client is waiting on (see
       * `loadLibrary`). A load that arrives while the playhead runs, or one whose
       * parse job finds the playhead running again, lands here.
       */
      this.deferredFonts = new Map();

      /**
       * The load of a font that occupies the queue right now: id → the request
       * id it was queued for. A parse job whose request is not the one held here
       * was superseded by a newer load of the same font or cancelled by
       * `library_unload`, and does nothing (see `parseFont`).
       */
      this.fontLoads = new Map();

      /** Font ids a track wanted and the engine reported already (once each). */
      this.fontNeeded = new Set();

      /** Font ids that failed to parse or render, reported once each (silent after). */
      this.fontFailed = new Set();

      /**
       * The font ids refused only for the cap (their `load` threw a `font_cap`
       * error). A refusal is not permanent: when a font is unloaded or the
       * song's font set shrinks, the room may be there now, so these are cleared
       * and reported as `library_needed` again (see `retryCapRefusals`).
       */
      this.fontCapFailed = new Set();

      /** The distinct font ids the song's soundfont tracks named last time. */
      this.fontIds = new Set();

      /**
       * The song's pads, slices and sample rates, flattened by `setSong`: the
       * key is the ref id `doc.js` uses (`padKey` / `sliceKey`).
       */
      this.pads = new Map();
      this.slices = new Map();
      this.sampleRates = new Map();

      /** A counter every sampler trigger bumps: the trigger order of the voices. */
      this.voiceSerial = 0;

      /**
       * track id → the motion curve standing right now, one record per sampler
       * track, reused across blocks (`setMotion`). `serial` is the block the
       * record was set in, so a curve from an earlier block is never read.
       */
      this.motion = new Map();

      /**
       * One value per lane of the record being read, filled in place by
       * `motionValuesAt` once per sub-step: a block allocates nothing, and every
       * voice of a pad reads the value its lane had at that sub-step.
       */
      this.motionValues = [];

      /** The block counter those records are stamped with (`setMotion`). */
      this.motionSerial = 0;

      /** Whether the master is tapped (record-into-pad / resampling). */
      this.tapMaster = false;

      /**
       * The performance-effects bus and the looper (`perf-fx.js`): live state
       * that never reaches the song, applied after the mix and before the clip.
       */
      this.perf = StudioPerfFx.create(sampleRate);

      /** The song's tempo, for the bus's beat and bar grid. */
      this.bpm = DEFAULT_BPM;

      /**
       * The transport the bus reads each block, kept as one object so the audio
       * thread allocates nothing: its first frame, whether the playhead runs, the
       * tempo, the frame of the bar line it is inside and the sequencer's own next
       * bar line.
       */
      this.transport = {
        frame: 0,
        offset: 0,
        playing: false,
        bpm: DEFAULT_BPM,
        beatsPerBar: BEATS_PER_BAR,
        barFrame: null,
        nextBarFrame: null,
      };

      /**
       * The sequencer's bar lines, filled in place every block (`updateTransport`)
       * so reading them costs no allocation on the audio thread.
       */
      this.barLineScratch = { barFrame: null, nextBarFrame: null, bar: null };

      /** The track whose own output is tapped, or null. */
      this.tapTrackId = null;

      /** track index → its tap's stereo scratch, allocated only while a track is tapped. */
      this.tapIndex = -1;
      this.tapLeft = null;
      this.tapRight = null;

      /**
       * The master meter (`meter.js`): momentary, short-term and integrated LUFS
       * plus true peak, read after the master inserts. Null when this module was
       * composed without `meter.js` (some engine tests build their own file
       * list), in which case no `meter` message is ever posted.
       */
      this.meter = typeof StudioMeter === "object" && StudioMeter !== null ? StudioMeter.create(sampleRate) : null;

      /** Frames since the last meter reading, and how many make one (100 ms). */
      this.sinceMeter = 0;
      this.meterEvery = Math.max(1, Math.round(sampleRate * METER_INTERVAL_SECONDS));

      /** Whether the playhead ran at the last block, so a stop posts one last reading. */
      this.meterWasPlaying = false;

      /**
       * The NAM host (`engine/nam-host.js`): the one compiled engine module and
       * one instance per amp insert. Built on the first amp insert (or the first
       * capture load): a song with no amp never pays for it. `null` until then,
       * and `null` forever in an engine composed without `nam-host.js`.
       */
      this.namHost = null;

      /** Whether the NAM host has been built (so a null one is not retried). */
      this.namHostBuilt = false;

      /** The NAM engine's bytes (`nam-wasm`), kept so a late host can compile. */
      this.namWasm = null;

      /**
       * Capture library id → its JSON text, as it was loaded (see `loadCapture`).
       * An amp insert names one of these; every insert that names it plays it.
       */
      this.namModels = new Map();

      /**
       * Capture ids that could not be played, and why — reported once each.
       */
      this.namFailed = new Map();

      /**
       * A counter for the NAM instance KEYS of amp insert objects. An instance
       * belongs to the insert OBJECT and not to the document's insert id: a chain
       * edit that blends an amp out and back in runs two runners for one insert
       * for the length of a fade, and each needs its own NAM state (see
       * `createAmpInsert`).
       */
      this.ampInstanceSeq = 0;

      /** Whether a rebuild of the shared NAM module is already queued. */
      this.namRebuildQueued = false;

      /**
       * One NAM module a rebuild has kept alive for the amp runners that were
       * still fading out when it happened. A fading runner keeps its already
       * loaded instance (no cut) until the chain folds it away, and the old
       * module is destroyed by `pruneAmpInstances` then.
       */
      this.namHeldHosts = [];

      /** Cabinet library id → its decoded PCM (`{channels, frames, rate}`). */
      this.cabinets = new Map();

      /** Cabinet ids that were refused (too long), and why — reported once each. */
      this.cabinetFailed = new Map();

      /**
       * Capture loads waiting for a Stop: id → `{bytes, request_id}`, the same
       * parking a font load gets (parsing a capture is only allowed while the
       * transport is stopped).
       */
      this.deferredCaptures = new Map();

      /** The capture load that owns the work queue right now: id → request id. */
      this.captureLoads = new Map();

      /** Library ids (captures and cabinets) an amp wanted and was told about. */
      this.ampNeeded = new Set();

      /**
       * The monitored input: the engine node's own `inputs[0]`, summed into the
       * named track's source before its chain (see "Monitoring through the
       * chain"). `null` when nothing is connected or nothing is monitored.
       */
      this.monitorTrackId = null;
      this.monitorLeft = null;
      this.monitorRight = null;
      /**
       * How many channels the armed track's input selection opens: 1 for a
       * one-channel input, 2 for a stereo pair (the default when nothing says).
       * It is the page's 1b input selection, and it decides the amp's mono sum
       * (see `monoSum` in `createAmpInsert`) — never the signal's own peaks.
       */
      this.monitorChannels = 2;

      /** The delay the monitored track's chain adds, in ms (posted when it moves). */
      this.monitorLatencyMs = 0;
      this.monitorLatencyKey = "";

      /**
       * The mixer the last song read (`mixerSpecOf`): one chain per owner, the
       * sends, the returns and the master's gain. Plain data, read on the message
       * path; the insert OBJECTS are built from it by `applyMixer()`.
       */
      this.mixer = NO_MIXER;

      /** The song's returns, in snapshot order, as chain holders (see `renderReturn`). */
      this.returns = [];
      this.returnRecords = new Map();

      /** The master's own chain holder, and its gain and chain latency. */
      this.masterRecord = this.newChainOwner("master");
      this.masterGain = 1;
      this.masterLatencyMs = 0;
      /** That latency in frames: what a master tap is moved back by (see `postTap`). */
      this.masterLatencyFrames = 0;
      /**
       * One scratch pair per nesting level a blend may hold, made with the rest of
       * the mixer's scratch (`ensureScratch`, once per block size).
       */
      this.blendLeft = null;
      this.blendRight = null;

      /**
       * Whether the page's compiled Faust effects have been posted. Until they
       * are, an insert of a Faust kind is "still loading" and is built again when
       * a snapshot arrives; after them, a missing module never appears, so it is a
       * permanent pass-through (reported once).
       */
      this.faustArrived = false;

      /**
       * Insert ids a message was already posted for: one "still loading" per
       * Faust insert whose modules have not arrived, and one "could not be
       * built" per insert that will not build at all.
       */
      this.loadingReported = new Set();
      this.brokenReported = new Set();

      /**
       * The mixer's scratch, allocated once per block size and never inside a
       * chain: the run's own copy of a track's source, the NaN guard's copy of an
       * insert's input (which is also what a fading insert is blended against),
       * the 128-frame pair a long run is handed to an insert through, and the
       * right channel a host without one gets.
       */
      this.scratchFrames = 0;
      this.mixLeft = null;
      this.mixRight = null;
      this.guardLeft = null;
      this.guardRight = null;
      this.insertLeft = null;
      this.insertRight = null;
      this.rightPad = null;

      /** Serialises the async slot work, so songs apply in arrival order. */
      this.queue = Promise.resolve();

      /** Messages that arrived before the engine was ready, in arrival order. */
      this.pending = [];

      /** The wasm bytes, and the module they compiled to once start() ran. */
      this.wasmBinary = null;
      this.wasmModule = null;

      this.port.onmessage = (event) => {
        const message = event && event.data;
        if (!message || typeof message !== "object") return;
        // A port delivers what was posted before the processor existed (a host
        // may construct it a moment after the node is built), so anything that
        // arrives before the wasm compiled waits its turn here and is replayed
        // in arrival order once the engine is up. That keeps a render that
        // posts its song and then waits for `ready` deterministic.
        if (!this.ready && !this.failure) {
          this.pending.push(message);
          return;
        }
        this.handle(message);
      };

      this.start(processorOptions.wasmBinary);
    }

    /**
     * @returns {object} the SoundFont hosts, building them on first use (and a
     *   no-op host when this module was composed without `font-voice.js`)
     */
    fontHost() {
      if (this.fonts === null) {
        this.fonts =
          typeof StudioFontVoice === "object" && StudioFontVoice !== null
            ? StudioFontVoice.create(sampleRate, { maxBytes: this.maxFontBytes })
            : noFontHost();
      }
      return this.fonts;
    }

    /**
     * Compile the wasm and tell the client. Failures are reported, never
     * thrown: a worklet that throws in its constructor would take the whole
     * audio thread down.
     * @param {ArrayBuffer|Uint8Array} wasmBinary
     * @returns {Promise<void>}
     */
    async start(wasmBinary) {
      try {
        if (!wasmBinary) throw new Error("no SunVox wasm binary was passed in processorOptions.wasmBinary");
        this.wasmBinary = wasmBinary instanceof Uint8Array ? wasmBinary : new Uint8Array(wasmBinary);
        // One compile for the whole processor: every track's engine
        // instantiates from this module, and a binary that will not compile is
        // reported as a start-up error instead of as unexplained silence.
        this.wasmModule = await WebAssembly.compile(this.wasmBinary);
        this.ready = true;
        this.port.postMessage({ type: "ready" });
        for (const message of this.pending) this.handle(message);
        this.pending.length = 0;
      } catch (error) {
        this.fail(error);
        this.pending.length = 0;
      }
    }

    /**
     * Handle one client message, reporting (never throwing) a fault inside it.
     * @param {object} message
     * @returns {void}
     */
    handle(message) {
      try {
        this.receive(message);
      } catch (error) {
        this.report(error);
      }
    }

    /**
     * One protocol message from the client.
     * @param {object} message
     * @returns {void}
     */
    receive(message) {
      if (!message || typeof message !== "object") return;
      switch (message.type) {
        case "song":
          this.setSong(message.snapshot);
          break;
        case "launchScene":
          this.sequencer.launchScene(message.id);
          break;
        case "launchClip":
          this.sequencer.launchClip(message.id);
          break;
        case "stopTrack":
          this.sequencer.stopTrack(message.id);
          break;
        case "stopAll":
          this.sequencer.stopAll();
          break;
        case "nextBarFrame": {
          // Answered from the sequencer's own clock, moved onto the context's:
          // the frame a recorder should arm at.
          const boundary = this.sequencer.nextBarFrame();
          this.port.postMessage({
            type: "nextBarFrame",
            id: message.id,
            frame: this.contextOffset() + boundary.frame,
            bar: boundary.bar,
          });
          break;
        }
        case "play":
          this.sequencer.play();
          // The integrated measurement and the true peak start again on every
          // Play (plan 1d, Task 9), and the first reading is 100 ms away.
          if (this.meter !== null) this.meter.reset();
          this.sinceMeter = 0;
          break;
        case "stop":
          this.sequencer.stop();
          // Parsing a bank or a capture happens only while the transport is
          // stopped, so a load that arrived while the song played lands here.
          this.drainDeferredFonts();
          this.drainDeferredCaptures();
          // An amp whose capture or cabinet the operator changed DURING playback
          // waited for this too ("Loads when you stop."), so every amp takes its
          // attachments again — and an amp whose files did not change does
          // nothing at all (see `attachCapture`).
          this.rebindAmps();
          // A capture or cabinet that waited for this Stop has just been
          // attached (or not), so the amp instances the chains no longer hold can
          // go now rather than at the next snapshot (plan 1d, Task 13).
          this.pruneAmpInstances();
          break;
        case "setMode":
          this.sequencer.setMode(message.mode);
          break;
        case "seek":
          this.sequencer.seek(message.bar);
          break;
        case "audio":
          this.loadTake(message.take_id, message.channels);
          break;
        case "audio_unload":
          this.takes.delete(asId(message.take_id));
          break;
        case "sample":
          this.loadSample(message.sample_id, message.channels);
          break;
        case "sample_unload":
          this.unloadSample(asId(message.sample_id));
          break;
        case "library":
          this.loadLibrary(message);
          break;
        case "library_unload":
          this.unloadLibrary(message.library_id);
          break;
        case "nam-wasm":
          // The NAM engine's binary, posted once per page (there is no fetch on the
          // audio thread): compiled here, on the message queue, never inside
          // `process()`, and shared by every amp insert. An amp that was waiting
          // for it can play from the next block on.
          this.enqueue(async () => {
            await this.setNamEngine(message.bytes);
            this.rebindAmps();
          });
          break;
        case "monitor":
          // Monitoring through the chain: name the track the node's input runs
          // through (its inserts, amps included, and its fader), or let it go.
          // `channels` is the page's 1b input selection (1 or 2); a test or an
          // older page that spells it `input_channels` is understood too.
          this.setMonitor(
            message.track_id,
            message.on === true,
            message.channels !== undefined ? message.channels : message.input_channels,
          );
          break;
        case "faust-modules":
          // The compiled Faust effects (plan 1d, Task 7). They are compiled once
          // per page here, on the message queue — never inside `process()` — and
          // then the chains are built again, because an insert that was waiting
          // for its module can now be a real one (plan 1d, Task 9). From this
          // point on a module that is missing is a permanent pass-through, not a
          // load in progress (see `createInsert`).
          this.enqueue(async () => {
            await this.compileFaustModules(message.modules);
            this.faustArrived = true;
            this.applyMixer();
          });
          break;
        case "live":
          this.live(message);
          break;
        case "tap":
          this.setTap(message.target, message.on === true);
          break;
        case "fx":
          // A performance effect is live state: the change takes effect at the
          // next block's first frame and never touches the song or its history.
          if (message.on === false) this.perf.release(message.name);
          else this.perf.hold(message.name, message.amount);
          break;
        case "looper":
          this.perf.looper(message.action);
          break;
        case "looper_buffers":
          // The page owns the looper's buffers: the audio thread allocates none, so
          // they arrive (transferred) before the first record and come back after a
          // take. Adopting them is the message path's work, never a block's.
          this.perf.setLooperBuffers(message.left, message.right);
          break;
        case "looper_take":
          this.postLooperTake(message);
          break;
        case "flush":
          // Messages are handled in arrival order and slot work is queued, so
          // answering at the end of the queue proves every message posted
          // before the flush has been applied — engines built and all.
          this.enqueue(() => {
            this.port.postMessage({ type: "flushed", id: message.id });
          });
          break;
        case "__throw":
          // Test hook only: arm a throw inside process(), which is where a real
          // fault (a hostile song, an engine bug) would surface.
          if (this.testHooks) this.failNextBlock = true;
          break;
        default:
          break;
      }
    }

    /**
     * Compile the Faust effects this page posted: their wasm, once per kind, so
     * every insert of that kind instantiates from one module. A host whose build
     * output is missing posts nothing, and this module was composed without
     * `faust-host.js` in a test that predates it — both are no-ops.
     * @param {Object<string, {wasm: ArrayBuffer, json: string}>} modules
     * @returns {Promise<void>}
     */
    async compileFaustModules(modules) {
      if (typeof StudioFaustHost === "undefined" || StudioFaustHost === null) return;
      await StudioFaustHost.compileModules(modules);
    }

    /**
     * Queue async slot work, keeping arrival order and swallowing a fault (a
     * track that cannot be built must not stop the rest of the song).
     * @param {() => Promise<void>|void} task
     * @returns {void}
     */
    enqueue(task) {
      this.queue = this.queue.then(task).catch((error) => {
        this.report(error);
      });
    }

    /**
     * Store one take's PCM, already at the context's rate, and acknowledge it.
     * A take whose bytes arrive again simply replaces the old ones.
     * @param {string} takeId
     * @param {Float32Array[]|ArrayBufferView[]} channels
     * @returns {void}
     */
    loadTake(takeId, channels) {
      const id = asId(takeId);
      this.takes.set(id, readChannels(channels));
      // A take that arrived late is no longer missing, so it may be reported
      // again only if it goes away a second time.
      this.missingTakes.delete(id);
      this.port.postMessage({ type: "audio_loaded", take_id: id });
    }

    /**
     * Store one sample's PCM, already at the context's rate, and acknowledge it.
     *
     * The song may hold at most `this.maxSampleBytes` of decoded samples at
     * once. A load that would go past that unloads the least-recently-triggered
     * samples first (a sample that has not been played since it loaded is the
     * first to go), and the client reloads one when a `sample_needed` says a
     * trigger wanted it.
     * @param {string} sampleId
     * @param {Float32Array[]|ArrayBufferView[]} channels
     * @returns {void}
     */
    loadSample(sampleId, channels) {
      const id = asId(sampleId);
      const list = readChannels(channels);
      let bytes = 0;
      for (const channel of list) bytes += channel.byteLength;
      const frames = list.length > 0 && list[0] ? list[0].length : 0;

      const previous = this.samples.get(id);
      if (previous) this.sampleBytes -= previous.bytes;
      this.sampleBytes += bytes;
      this.samples.set(id, {
        channels: list,
        frames: frames,
        bytes: bytes,
        lastUsed: (this.sampleClock += 1),
      });
      this.missingSamples.delete(id);

      this.trimSamples(id);
      this.port.postMessage({ type: "sample_loaded", sample_id: id });
    }

    /**
     * Drop one sample's PCM from the engine, freeing its bytes.
     * @param {string} sampleId
     * @returns {void}
     */
    unloadSample(sampleId) {
      const id = asId(sampleId);
      const held = this.samples.get(id);
      if (!held) return;
      this.sampleBytes -= held.bytes;
      this.samples.delete(id);
    }

    /**
     * Bring the loaded samples back under the song-wide cap by unloading the
     * least-recently-triggered ones. The sample that was just loaded is never a
     * candidate (a song that would need more than the whole cap for one sample
     * keeps it), so a load always leaves something to play.
     * @param {string} keepId the sample that must stay loaded
     * @returns {void}
     */
    trimSamples(keepId) {
      if (this.sampleBytes <= this.maxSampleBytes) return;
      while (this.sampleBytes > this.maxSampleBytes) {
        let victim = null;
        for (const [id, held] of this.samples) {
          if (id === keepId) continue;
          if (!victim || held.lastUsed < victim.held.lastUsed) victim = { id: id, held: held };
        }
        if (!victim) return;
        this.sampleBytes -= victim.held.bytes;
        this.samples.delete(victim.id);
      }
    }

    /**
     * Report a sample a trigger wanted but the client has not loaded, once per
     * sample id: a pad with no PCM plays silence, and a looping pattern would
     * otherwise say so on every pass. The `sample_needed` post is what lets the
     * client load it again (see the cap in `trimSamples`).
     * @param {string} sampleId
     * @returns {void}
     */
    reportMissingSample(sampleId) {
      const id = asId(sampleId);
      if (this.missingSamples.has(id)) return;
      this.missingSamples.add(id);
      this.port.postMessage({ type: "sample_needed", sample_id: id });
      this.report(new Error(missingSampleText(id)));
    }

    /**
     * Take one bank from the client.
     *
     * Parsing a font happens in the worklet ONLY while the transport is stopped
     * (plan 1d, Global Constraints): a load that arrives while the playhead runs
     * is held — bytes and all — and answered with `library_deferred`, so the page
     * can say "Loads when you stop." — and parsed on the next Stop. A load that was
     * queued while the transport stood still and was still queued when the
     * playhead started is put back in that same queue by its job (see
     * `parseFont`), so "stopped" is checked when the work happens, not when the
     * message arrived.
     *
     * Every `library` message carries a `request_id` from its client and every
     * answer repeats it: one ack per load, matched to the load that asked, so a
     * later load of the same font never answers an earlier one.
     *
     * Only `kind: "font"` is parsed into a synth, `kind: "nam"` is a capture
     * (parsed into the NAM engine while the transport is stopped) and `kind:
     * "ir"` is a cabinet (its PCM is built into partitions straight away — it is
     * not parsed from anything). Any other kind is acknowledged and left alone,
     * so a page that loads a song's whole library does not have to know which
     * entry is which.
     * @param {{request_id?: unknown, library_id?: string, kind?: string,
     *          bytes?: unknown, channels?: unknown, rate?: unknown}} message
     * @returns {void}
     */
    loadLibrary(message) {
      const id = asId(message.library_id);
      if (id === "") return;
      const requestId = message.request_id;
      const kind = asId(message.kind) === "" ? "font" : asId(message.kind);
      if (kind === CAPTURE_KIND) {
        this.loadCapture(id, readBytes(message.bytes), requestId);
        return;
      }
      if (kind === CABINET_KIND) {
        this.loadCabinet(id, message, requestId);
        return;
      }
      const bytes = readBytes(message.bytes);
      if (kind !== "font") {
        this.port.postMessage({ type: "library_loaded", library_id: id, kind: kind, ok: true, request_id: requestId });
        return;
      }
      if (this.sequencer.isPlaying()) {
        // This load supersedes one still queued for the same font: that one has
        // not been parsed, and this one is what the page wants.
        const queued = this.fontLoads.get(id);
        if (queued !== undefined) {
          this.fontLoads.delete(id);
          this.answerLibrary(queued, id, false, LOAD_SUPERSEDED);
        }
        this.deferFont(id, bytes, requestId);
        return;
      }
      this.parseFont(id, bytes, requestId);
    }

    /**
     * Park one load until the next Stop and answer it `library_deferred`. The last
     * load of a font wins: an older one waiting here is dropped, and its client
     * already has its `deferred` answer (it is waiting for the parse, not for the
     * parking), so nothing else has to be said about it.
     * @param {string} id
     * @param {Uint8Array} bytes
     * @param {unknown} requestId
     * @returns {void}
     */
    deferFont(id, bytes, requestId) {
      this.deferredFonts.set(id, { bytes: bytes, request_id: requestId });
      this.port.postMessage({ type: "library_deferred", library_id: id, request_id: requestId });
    }

    /**
     * Answer one load's own request: its ack, matched by the request id it
     * arrived with. A failed ack carries the reason the client shows, and a font
     * that loaded carries its `presets` — the instruments the parsed bank holds,
     * sorted by bank then program — so the page can list them without reading a
     * bank itself.
     * @param {unknown} requestId
     * @param {string} id
     * @param {boolean} ok
     * @param {string} [reason]
     * @param {Array<{bank: number, program: number, name: string}>} [presets]
     * @returns {void}
     */
    answerLibrary(requestId, id, ok, reason, presets) {
      const message = { type: "library_loaded", library_id: id, ok: ok, request_id: requestId };
      if (!ok && reason !== undefined) message.reason = String(reason);
      if (ok && Array.isArray(presets)) message.presets = presets;
      this.port.postMessage(message);
    }

    /**
     * Parse one bank and give it to the font host, on the processor's own work
     * queue so a song posted after it is assigned after it.
     *
     * The job re-reads the transport when it RUNS, and again after any await:
     * a load that was queued before the playhead started, or one whose decoder
     * was still compiling when Play arrived, is put back in the deferred queue
     * (`library_deferred`) instead of parsing while the song plays.
     *
     * A bank that will not parse leaves nothing behind: the track that wanted it
     * stays silent and the failure is reported once per font id, through both the
     * ack (`library_loaded` with `ok: false`) and `library_failed`. A font
     * refused only for ROOM is remembered (`fontCapFailed`) so a later shrink of
     * the song's font set can try it again.
     *
     * A load that was unloaded (or replaced) while it parsed is discarded in
     * SILENCE: its request was answered when it was cancelled, and a font nobody
     * wants must not post a second answer or a `library_failed`.
     * @param {string} id
     * @param {Uint8Array} bytes
     * @param {unknown} requestId the load's own request id
     * @returns {void}
     */
    parseFont(id, bytes, requestId) {
      const replaced = this.fontLoads.get(id);
      if (replaced !== undefined && replaced !== requestId) {
        this.answerLibrary(replaced, id, false, LOAD_SUPERSEDED);
      }
      // A load parked for the next Stop is superseded too; its client already has
      // its `deferred` answer, and this one replaces its bytes.
      this.deferredFonts.delete(id);
      this.fontLoads.set(id, requestId);
      this.enqueue(async () => {
        // Cancelled (`library_unload`) or superseded before it ran: its request
        // has already been answered, and nothing is parsed.
        if (this.fontLoads.get(id) !== requestId) return;
        // The transport may have started between the message and this job: a bank
        // is parsed only while the song is stopped, so it goes back to the queue.
        if (this.sequencer.isPlaying()) {
          this.fontLoads.delete(id);
          this.deferFont(id, bytes, requestId);
          return;
        }
        const fonts = this.fontHost();
        // Getting the decoder ready is an await of its own (the vendored Vorbis
        // decoder compiles on first use). Play can arrive while we wait, and a
        // bank is parsed only while stopped, so the transport is read again
        // AFTER that wait — before a byte is parsed or one sample decoded.
        if (typeof fonts.ready === "function") {
          try {
            await fonts.ready();
          } catch {
            /* no Ogg decoder: SF2 banks are unaffected */
          }
          if (this.fontLoads.get(id) !== requestId) return;
          if (this.sequencer.isPlaying()) {
            this.fontLoads.delete(id);
            this.deferFont(id, bytes, requestId);
            return;
          }
        }
        try {
          await fonts.load(id, bytes);
        } catch (error) {
          // Unloaded (or replaced) while it parsed: its request was answered
          // when it was cancelled, so the result is discarded silently — no
          // second answer, no `library_failed` for a font nobody wants.
          if (this.fontLoads.get(id) !== requestId) return;
          this.fontLoads.delete(id);
          const reason = error && error.message ? error.message : String(error);
          if (error && error.code === "font_cap") this.fontCapFailed.add(id);
          else this.fontCapFailed.delete(id);
          this.answerLibrary(requestId, id, false, reason);
          this.reportFontFailure(id, reason);
          return;
        }
        if (this.fontLoads.get(id) !== requestId) {
          // Unloaded (or replaced) while it parsed: it must not come back.
          this.fontHost().unload(id);
          this.bindFonts();
          return;
        }
        this.fontLoads.delete(id);
        // A load that worked clears every mark, so a font the cap evicts later is
        // requested (and, if it goes bad again, reported) once more.
        this.fontNeeded.delete(id);
        this.fontFailed.delete(id);
        this.fontCapFailed.delete(id);
        this.answerLibrary(requestId, id, true, undefined, this.fontPresets(fonts, id));
        this.bindFonts();
      });
    }

    /**
     * The presets a bank that just loaded carries, for the page's instrument
     * picker. Read here, when a load is answered — never in `process()` — and []
     * for a host that keeps no preset list.
     * @param {object} fonts the font host the load went through
     * @param {string} id
     * @returns {Array<{bank: number, program: number, name: string}>}
     */
    fontPresets(fonts, id) {
      if (!fonts || typeof fonts.presets !== "function") return [];
      try {
        const list = fonts.presets(id);
        return Array.isArray(list) ? list : [];
      } catch {
        return [];
      }
    }

    /**
     * Parse every bank that waited for a Stop, in arrival order. The work goes on
     * the queue, so a `flush` posted after the `stop` answers only once the banks
     * are in.
     * @returns {void}
     */
    drainDeferredFonts() {
      if (this.deferredFonts.size === 0) return;
      const waiting = Array.from(this.deferredFonts.entries());
      this.deferredFonts.clear();
      for (const [id, load] of waiting) this.parseFont(id, load.bytes, load.request_id);
    }

    /**
     * Drop one bank from the engine (a song that no longer plays it).
     *
     * A load of that font that has not been parsed yet is cancelled with it —
     * deferred, or queued and not yet run — and its own request is answered, so a
     * client that asked for a font it then unloaded is not left waiting. A job
     * already queued for it finds its request gone and parses nothing.
     * @param {unknown} libraryId
     * @returns {void}
     */
    unloadLibrary(libraryId) {
      const id = asId(libraryId);
      if (id === "") return;
      const deferred = this.deferredFonts.get(id);
      if (deferred) {
        this.deferredFonts.delete(id);
        this.answerLibrary(deferred.request_id, id, false, LOAD_CANCELLED);
      }
      const queued = this.fontLoads.get(id);
      if (queued !== undefined) {
        this.fontLoads.delete(id);
        this.answerLibrary(queued, id, false, LOAD_CANCELLED);
      }
      this.fontNeeded.delete(id);
      this.fontFailed.delete(id);
      this.fontCapFailed.delete(id);
      // A capture or a cabinet the song no longer holds goes the same way: the
      // inserts that still name it ask for it again, exactly as they do while one
      // is still uploading.
      this.unloadCapture(id);
      this.unloadCabinet(id);
      // The room this font held is free now: a font refused for the cap may fit
      // again, and is asked for once more rather than staying silent for ever.
      this.retryCapRefusals();
      this.fontHost().unload(id);
      this.bindFonts();
    }

    // ---- amp inserts: captures and cabinets ---------------------------------

    /**
     * The NAM host, built on first use.
     *
     * `null` when this module was composed without `nam-host.js` (some engine
     * tests build their own file list), and null forever after: an amp insert in
     * such an engine plays silence and is reported, exactly as one whose capture
     * is missing.
     * @returns {object|null}
     */
    namHostFor() {
      if (!this.namHostBuilt) {
        this.namHostBuilt = true;
        this.namHost = this.newNamHost();
        if (this.namHost !== null && this.namWasm !== null) {
          // The bytes arrived before the first amp did: compile them now, on the
          // queue, so a load posted after this waits for the engine rather than
          // failing.
          const bytes = this.namWasm;
          this.enqueue(async () => {
            await this.setNamEngine(bytes);
          });
        }
      }
      return this.namHost;
    }

    /** @returns {object|null} one fresh NAM host, or null in an engine without one. */
    newNamHost() {
      return typeof StudioNamHost === "object" && StudioNamHost !== null
        ? StudioNamHost.create({ sampleRate: sampleRate, cores: this.namCores })
        : null;
    }

    /**
     * Rebuild the SHARED NAM module after a trap inside it, on the message path.
     *
     * A wasm trap can leave the module's own state broken, so every other amp
     * insert is moved onto a freshly compiled engine rather than left playing on
     * a module that may be wounded. Each amp insert forgets what it had attached
     * (its NAM instance died with the old module) and loads its capture into the
     * new one; the amp that trapped stays SILENT — it is marked stopped itself
     * (see `createAmpInsert`). Nothing here runs on the audio thread.
     * @returns {void}
     */
    scheduleNamRebuild() {
      if (this.namRebuildQueued) return;
      this.namRebuildQueued = true;
      this.enqueue(async () => {
        this.namRebuildQueued = false;
        await this.rebuildNamHost();
      });
    }

    /**
     * Replace the compiled NAM module and re-attach every amp to it.
     * @returns {Promise<void>}
     */
    async rebuildNamHost() {
      const bytes = this.namWasm;
      const old = this.namHost;
      // The old instances die with it, so every amp's attachment goes with them —
      // EXCEPT one that is still fading out: it keeps its already-loaded instance
      // on the old module until the chain folds it away (no cut, see
      // `namHeldHosts`). That is the only way an amp may keep playing across a
      // rebuild.
      this.namHost = null;
      this.namHostBuilt = false;
      const held = [];
      this.eachAmpRunnerEverywhere((runner) => {
        const insert = runner.insert;
        if (!insert) return;
        if (runner.retired && runner.wet > 0 && typeof insert.holdHost === "function") {
          insert.holdHost(old);
          held.push(insert);
          return;
        }
        if (typeof insert.forgetModule === "function") insert.forgetModule();
      });
      if (old !== null) {
        if (held.length > 0) this.namHeldHosts.push({ host: old, inserts: held });
        else {
          try {
            old.destroy();
          } catch {
            /* the module is gone: nothing is left to clean up */
          }
        }
      }
      const host = this.newNamHost();
      this.namHost = host;
      this.namHostBuilt = true;
      if (host === null) return;
      if (bytes !== null) {
        try {
          await host.setWasm(bytes);
        } catch {
          /* reported by the amp that wanted it: there is no engine to play */
        }
      }
      // A capture may only be loaded while the transport is stopped. Rebuilding
      // the module is allowed during playback; re-attaching the captures is NOT,
      // so a playing song stays silent (never the dry signal) until the next
      // Stop, which calls `rebindAmps()` and loads them again. The amp that
      // trapped has already stopped itself and is left alone.
      if (this.sequencer.isPlaying()) return;
      this.rebindAmps();
      this.bindAmps();
    }

    /**
     * Compile the NAM engine from the bytes the page posted, once per page.
     * @param {unknown} bytes the `nam-engine.wasm` binary, transferred
     * @returns {Promise<void>}
     */
    async setNamEngine(bytes) {
      const host = this.namHostFor();
      const binary = readBytes(bytes);
      if (binary.byteLength === 0) return;
      this.namWasm = binary;
      if (host === null) return;
      await host.setWasm(binary);
    }

    /**
     * Take one capture from the client: the `.nam` file's own bytes.
     *
     * Parsing a capture happens in the worklet ONLY while the transport is
     * stopped (plan 1d, Global Constraints) — the file's JSON is read to decide
     * whether Studio can play it at all — so a load that arrives while the
     * playhead runs is held, answered `{type:"library_deferred"}` (the page says
     * "Loads when you stop.") and parsed on the next Stop, exactly like a bank.
     * @param {string} id the library entry's id
     * @param {Uint8Array} bytes
     * @param {unknown} requestId
     * @returns {void}
     */
    loadCapture(id, bytes, requestId) {
      if (bytes.byteLength === 0) {
        this.answerLibrary(requestId, id, false, CAPTURE_NOT_HERE_TEXT);
        return;
      }
      if (this.sequencer.isPlaying()) {
        const queued = this.captureLoads.get(id);
        if (queued !== undefined) {
          this.captureLoads.delete(id);
          this.answerLibrary(queued, id, false, LOAD_SUPERSEDED);
        }
        this.deferCapture(id, bytes, requestId);
        return;
      }
      this.parseCapture(id, bytes, requestId);
    }

    /**
     * Park one capture until the next Stop and answer it `library_deferred`.
     * @param {string} id
     * @param {Uint8Array} bytes
     * @param {unknown} requestId
     * @returns {void}
     */
    deferCapture(id, bytes, requestId) {
      this.deferredCaptures.set(id, { bytes: bytes, request_id: requestId });
      this.port.postMessage({ type: "library_deferred", library_id: id, request_id: requestId });
    }

    /**
     * Parse one capture and give it to every amp insert that names it, on the
     * processor's work queue.
     *
     * The job re-reads the transport when it RUNS (a load queued before Play is
     * put back in the deferred queue), waits for the NAM engine to compile if it
     * is still on its way, and refuses a legacy or broken capture with the
     * reason the plan gives. A capture that cannot be played leaves its inserts
     * SILENT and is reported once per library id (Review Focus 1): the audio
     * thread never throws, and a capture never falls back to the dry signal.
     * @param {string} id
     * @param {Uint8Array} bytes
     * @param {unknown} requestId the load's own request id
     * @returns {void}
     */
    parseCapture(id, bytes, requestId) {
      const replaced = this.captureLoads.get(id);
      if (replaced !== undefined && replaced !== requestId) {
        this.answerLibrary(replaced, id, false, LOAD_SUPERSEDED);
      }
      this.deferredCaptures.delete(id);
      this.captureLoads.set(id, requestId);
      this.enqueue(async () => {
        if (this.captureLoads.get(id) !== requestId) return;
        if (this.sequencer.isPlaying()) {
          this.captureLoads.delete(id);
          this.deferCapture(id, bytes, requestId);
          return;
        }
        let text = "";
        try {
          const host = this.namHostFor();
          if (host === null) throw new Error("the NAM engine is not part of this engine");
          text = StudioNamHost.textOfBytes(bytes);
          // The check is remembered by library id, so the inserts that play this
          // capture do not parse its JSON again (see `checkCapture` in
          // engine/nam-host.js).
          const problem =
            typeof host.checkCapture === "function"
              ? host.checkCapture(id, text)
              : StudioNamHost.captureProblem(text);
          if (problem) throw new Error(problem);
          // Getting the engine up is an await of its own, and Play can arrive
          // while we wait: a capture is parsed only while stopped, so the
          // transport is read again BEFORE a byte reaches the engine.
          await host.ready();
          if (this.captureLoads.get(id) !== requestId) return;
          if (this.sequencer.isPlaying()) {
            this.captureLoads.delete(id);
            this.deferCapture(id, bytes, requestId);
            return;
          }
        } catch (error) {
          if (this.captureLoads.get(id) !== requestId) return;
          this.captureLoads.delete(id);
          const reason = error && error.message ? error.message : String(error);
          this.answerLibrary(requestId, id, false, reason);
          this.reportCaptureFailure(id, reason);
          return;
        }
        // A capture that parsed is kept by id and loaded into every insert that
        // names it; an insert that is built later reads it from here.
        this.captureLoads.delete(id);
        this.namModels.set(id, text);
        this.namFailed.delete(id);
        this.ampNeeded.delete(id);
        this.answerLibrary(requestId, id, true);
        this.rebindAmps(id);
        this.bindAmps();
      });
    }

    /**
     * Take one cabinet's PCM from the client and build it into every amp insert
     * that names it.
     *
     * A cabinet is not parsed from a file: the page (or a render) decoded the
     * stored 24-bit WAV and resampled it to the context's rate, so what arrives
     * is Float32 channel data, TRANSFERRED. The partitions are built HERE, on the
     * message path, never in `process()`. A cabinet longer than a second after
     * that resampling is refused with the plan's sentence, and the insert plays
     * dry (no cabinet) rather than not at all.
     * @param {string} id
     * @param {{channels?: unknown, rate?: unknown}} message
     * @param {unknown} requestId
     * @returns {void}
     */
    loadCabinet(id, message, requestId) {
      const channels = readChannels(message.channels);
      const rate = Number(message.rate);
      const usableRate = Number.isFinite(rate) && rate > 0 ? rate : sampleRate;
      const frames = channels.length > 0 ? channels[0].length : 0;
      if (frames === 0) {
        this.answerLibrary(requestId, id, false, "An impulse response holds no audio.");
        return;
      }
      const problem =
        typeof StudioConvolver === "object" && StudioConvolver !== null
          ? StudioConvolver.lengthProblem(frames, usableRate)
          : frames > usableRate + IR_LENGTH_TOLERANCE_FRAMES
            ? "An impulse response is at most 1 second long."
            : null;
      if (problem) {
        this.cabinetFailed.set(id, problem);
        this.answerLibrary(requestId, id, false, problem);
        this.reportCaptureFailure(id, problem);
        return;
      }
      this.cabinets.set(id, { channels: channels, frames: frames, rate: usableRate });
      this.cabinetFailed.delete(id);
      this.ampNeeded.delete(id);
      this.answerLibrary(requestId, id, true);
      this.rebindAmps(null, id);
      this.bindAmps();
    }

    /**
     * Drop one capture from the engine: every amp insert that plays it goes
     * silent, and a load of it that has not parsed yet is cancelled and
     * answered.
     * @param {string} id
     * @returns {void}
     */
    unloadCapture(id) {
      const deferred = this.deferredCaptures.get(id);
      if (deferred) {
        this.deferredCaptures.delete(id);
        this.answerLibrary(deferred.request_id, id, false, LOAD_CANCELLED);
      }
      const queued = this.captureLoads.get(id);
      if (queued !== undefined) {
        this.captureLoads.delete(id);
        this.answerLibrary(queued, id, false, LOAD_CANCELLED);
      }
      this.namModels.delete(id);
      this.namFailed.delete(id);
      this.ampNeeded.delete(id);
      // The check cache is keyed by library id: a capture that is gone (or is
      // replaced under the same id) has to be parsed and checked again.
      if (this.namHost !== null && typeof this.namHost.forgetCapture === "function") {
        this.namHost.forgetCapture(id);
      }
      this.rebindAmps(id);
    }

    /**
     * Drop one cabinet from the engine: an amp that named it plays without one.
     * @param {string} id
     * @returns {void}
     */
    unloadCabinet(id) {
      if (!this.cabinets.has(id)) return;
      this.cabinets.delete(id);
      this.cabinetFailed.delete(id);
      this.ampNeeded.delete(id);
      this.rebindAmps(null, id);
    }

    /**
     * Parse every capture that waited for a Stop, in arrival order.
     * @returns {void}
     */
    drainDeferredCaptures() {
      if (this.deferredCaptures.size === 0) return;
      const waiting = Array.from(this.deferredCaptures.entries());
      this.deferredCaptures.clear();
      for (const [id, load] of waiting) this.parseCapture(id, load.bytes, load.request_id);
    }

    /**
     * Report a capture (or a cabinet) that cannot be played once per library id,
     * and stop reporting it. `library_failed` is the one report, exactly as it is
     * for a bank: the client turns it into the page's message and its log, and a
     * render puts the reason in `missing_library`.
     * @param {string} id
     * @param {string} reason
     * @returns {void}
     */
    reportCaptureFailure(id, reason) {
      const libraryId = asId(id);
      if (libraryId === "") return;
      if (this.namFailed.get(libraryId) === String(reason)) return;
      this.namFailed.set(libraryId, String(reason));
      this.ampNeeded.delete(libraryId);
      this.port.postMessage({ type: "library_failed", library_id: libraryId, reason: String(reason) });
    }

    /**
     * Walk every live amp insert runner in the song's chains.
     * @param {(runner: object) => void} visit
     * @returns {void}
     */
    eachAmpRunner(visit) {
      const owners = this.chainOwners();
      const runners = [];
      for (let index = 0; index < owners.length; index += 1) {
        const owner = owners[index];
        if (!owner || owner.chain === null || owner.chain === undefined) continue;
        collectRunnerOrder(owner.chain, runners);
      }
      this.visitAmpRunners(runners, visit);
    }

    /**
     * Walk every amp insert runner a chain still HOLDS — the ones it plays and the
     * ones an edit has retired or a blend is fading out. Their NAM instances are
     * still being run for the length of a fade, so they must not be let go until
     * the chain has folded them away (see `pruneAmpInstances`).
     * @param {(runner: object) => void} visit
     * @returns {void}
     */
    eachAmpRunnerEverywhere(visit) {
      const owners = this.chainOwners();
      const runners = [];
      for (let index = 0; index < owners.length; index += 1) {
        const owner = owners[index];
        if (!owner || owner.chain === null || owner.chain === undefined) continue;
        collectEveryRunner(owner.chain, runners);
      }
      this.visitAmpRunners(runners, visit);
    }

    /** @returns {object[]} the chain holders: the master, the returns and the tracks. */
    chainOwners() {
      const owners = [this.masterRecord];
      for (let index = 0; index < this.returns.length; index += 1) owners.push(this.returns[index]);
      for (let index = 0; index < this.slots.length; index += 1) {
        if (this.slots[index]) owners.push(this.slots[index]);
      }
      return owners;
    }

    /**
     * @param {object[]} runners
     * @param {(runner: object) => void} visit
     * @returns {void}
     */
    visitAmpRunners(runners, visit) {
      for (let index = 0; index < runners.length; index += 1) {
        const runner = runners[index];
        if (!runner || runner.kind !== AMP_KIND || !runner.insert || runner.insert.kind !== AMP_KIND) continue;
        visit(runner);
      }
    }

    /**
     * Give every amp insert its capture and its cabinet again: after a capture or
     * a cabinet loaded (or went away), after a NAM engine compiled, and after a
     * chain was built. A filtered call rebinds only the inserts that name one id.
     * @param {string|null} [captureId] only the inserts that name this capture
     * @param {string|null} [cabinetId] only the inserts that name this cabinet
     * @returns {void}
     */
    rebindAmps(captureId = null, cabinetId = null) {
      const capture = captureId === null ? null : asId(captureId);
      const cabinet = cabinetId === null ? null : asId(cabinetId);
      this.eachAmpRunner((runner) => {
        const amp = runner.insert;
        if (capture === null && cabinet === null) {
          amp.attachCapture();
          amp.attachCabinet();
          return;
        }
        if (capture !== null && amp.captureId() === capture) amp.attachCapture();
        if (cabinet !== null && amp.cabinetId() === cabinet) amp.attachCabinet();
      });
      // An amp whose capture has just finished parsing (or whose parked change
      // was applied at Stop) can change the monitored chain's delay, and no song
      // snapshot is involved. The page's round-trip number has to hear about it
      // now, exactly as it does after a snapshot (plan 1d, Task 13).
      this.postMonitorLatency();
    }

    /**
     * Let go of the NAM instances of amp insert objects the chains no longer hold
     * (an edit dropped one, or a blend finished folding the old runner away): an
     * instance costs wasm memory until it is destroyed.
     *
     * An instance is keyed by the insert OBJECT, so a runner a fade is still
     * playing counts as held even though it is retired.
     * @returns {void}
     */
    pruneAmpInstances() {
      const host = this.namHost;
      const liveInserts = new Set();
      this.eachAmpRunnerEverywhere((runner) => {
        if (runner.insert) liveInserts.add(runner.insert);
      });
      // A module a rebuild kept alive for a fading amp can go once no chain holds
      // any of the inserts that were playing on it.
      for (let index = this.namHeldHosts.length - 1; index >= 0; index -= 1) {
        const holding = this.namHeldHosts[index];
        let stillHeld = false;
        for (let at = 0; at < holding.inserts.length; at += 1) {
          if (liveInserts.has(holding.inserts[at])) {
            stillHeld = true;
            break;
          }
        }
        if (stillHeld) continue;
        this.namHeldHosts.splice(index, 1);
        try {
          holding.host.destroy();
        } catch {
          /* the module is going away: nothing is left to clean up */
        }
      }
      if (host === null || typeof host.instanceKeys !== "function") return;
      const live = new Set();
      this.eachAmpRunnerEverywhere((runner) => {
        if (typeof runner.insert.instanceKey === "function") live.add(runner.insert.instanceKey());
      });
      for (const key of host.instanceKeys()) {
        if (!live.has(key)) host.unloadModel(key);
      }
    }

    /**
     * Tell the page which capture or cabinet an amp insert names but the engine
     * does not hold — once per library id, so the page can fetch it from the
     * library route (or offer the download) exactly as it does for a font
     * (Review Focus 5).
     * @returns {void}
     */
    bindAmps() {
      this.eachAmpRunner((runner) => {
        const amp = runner.insert;
        const capture = amp.captureId();
        if (capture !== "" && !this.namModels.has(capture) && !this.namFailed.has(capture)) {
          if (!this.ampNeeded.has(capture)) {
            this.ampNeeded.add(capture);
            this.port.postMessage({ type: "library_needed", library_id: capture });
          }
        }
        const cabinet = amp.cabinetId();
        if (cabinet !== "" && !this.cabinets.has(cabinet) && !this.cabinetFailed.has(cabinet)) {
          if (!this.ampNeeded.has(cabinet)) {
            this.ampNeeded.add(cabinet);
            this.port.postMessage({ type: "library_needed", library_id: cabinet });
          }
        }
      });
    }

    /**
     * Turn monitoring through the chain on for one track, or off. The input the
     * node's own input is carrying is summed into that track's source (see
     * `renderTrack`), so it runs through the track's inserts — amps included —
     * and its fader; the chain's own delay is posted for the page to add to the
     * measured round trip it shows.
     * @param {unknown} trackId
     * @param {boolean} on
     * @param {unknown} [channels] the armed track's 1b input selection: 1 for a
     *   one-channel input, anything else (or nothing) for a stereo pair
     * @returns {void}
     */
    setMonitor(trackId, on, channels) {
      const id = asId(trackId);
      if (on) {
        this.monitorTrackId = id === "" ? null : id;
        this.monitorChannels = Number(channels) === 1 ? 1 : 2;
      } else {
        if (this.monitorTrackId === id) this.monitorTrackId = null;
        this.monitorChannels = 2;
      }
      this.applyAmpInputChannels();
      this.postMonitorLatency();
    }

    /**
     * Tell every amp insert which input selection its track has. An amp's mono
     * sum is decided ONCE from this selection (see `monoSum` in
     * `createAmpInsert`) and never from the signal's peaks, so a one-channel
     * input is never scaled by a 6 dB flip every few milliseconds. The only amp
     * that reads a one-channel selection is the one on the monitored track: a
     * stored clip is always a stereo pair and is averaged. This runs on the
     * message path only.
     * @returns {void}
     */
    applyAmpInputChannels() {
      const monitored = this.monitorTrackId === null ? "" : this.monitorTrackId;
      const channels = this.monitorChannels === 1 ? 1 : 2;
      this.eachAmpRunner((runner) => {
        if (!runner.insert || typeof runner.insert.setInputChannels !== "function") return;
        runner.insert.setInputChannels(runner.trackId === monitored ? channels : 2);
      });
    }

    /**
     * Post the delay the monitored track's own path adds, whenever it changes:
     * the page adds it to the round trip it measured.
     *
     * What the operator hears is the input through that track's chain AND then
     * through the master's, so the number is both: a track insert is zero-latency
     * by rule, the master limiter's look-ahead is not (see `masterLatencyFrames`,
     * which is also kept in step with the audio by `postMasterLatency`).
     * @returns {void}
     */
    postMonitorLatency() {
      const trackId = this.monitorTrackId === null ? "" : this.monitorTrackId;
      let frames = 0;
      if (trackId !== "") {
        const index = this.trackSlots.get(trackId);
        const record = index === undefined ? null : this.slots[index];
        if (record && record.chain) frames = chainLatencyOf(record.chain);
        // The monitored signal leaves through the master, so its own delay counts
        // towards what the operator hears (and it is 0 unless a limiter is there).
        frames += this.masterLatencyFrames;
      }
      const ms = (frames / sampleRate) * 1000;
      const key = `${trackId}\u0000${ms}`;
      if (key === this.monitorLatencyKey) return;
      this.monitorLatencyKey = key;
      this.monitorLatencyMs = ms;
      this.port.postMessage({ type: "monitor_latency", track_id: trackId, ms: ms });
    }

    /**
     * Forget every font that was refused only for ROOM, so the next
     * `bindFonts()` reports the ones the song still wants as `library_needed`
     * again. Called when a font is unloaded and when the song's font set shrinks:
     * either is what makes room for a previously refused bank.
     * @returns {void}
     */
    retryCapRefusals() {
      if (this.fontCapFailed.size === 0) return;
      for (const id of this.fontCapFailed) this.fontFailed.delete(id);
      this.fontCapFailed.clear();
    }

    /**
     * Give the font host the song's soundfont tracks and report what it cannot
     * play.
     *
     * The host assigns channels and applies presets itself (`assign`); what is
     * left here is the reporting: a track whose font is missing is silent and is
     * reported ONCE per font id, and a font the memory cap pushed out (or one that
     * broke while rendering) is reported once too.
     *
     * A song whose font set shrinks (a track that played its own bank left) may
     * have room for a font the cap refused earlier: that refusal is retried in
     * the same pass, so the page gets a fresh `library_needed` for it.
     * @returns {void}
     */
    bindFonts() {
      const ids = new Set();
      for (let index = 0; index < this.fontTracks.length; index += 1) {
        const spec = this.fontTracks[index];
        const id = spec && spec.font_id !== undefined && spec.font_id !== null ? String(spec.font_id) : "";
        if (id !== "") ids.add(id);
      }
      if (this.fontCapFailed.size > 0) {
        let shrank = ids.size < this.fontIds.size;
        if (!shrank) {
          for (const id of this.fontIds) {
            if (!ids.has(id)) {
              shrank = true;
              break;
            }
          }
        }
        if (shrank) this.retryCapRefusals();
      }
      this.fontIds = ids;

      // A song with no soundfont tracks never builds a host (and a page that
      // preloads a bank still gets one, through `parseFont`).
      if (this.fontTracks.length === 0 && this.fonts === null) return;
      const fonts = this.fontHost();
      fonts.assign(this.fontTracks);
      for (const failure of fonts.takeFailures()) this.reportFontFailure(failure.id, failure.reason);
      // An evicted font is simply missing again: the loop below asks for it.
      for (const id of fonts.takeEvicted()) this.fontNeeded.delete(id);
      for (const id of fonts.missing()) {
        if (this.fontFailed.has(id) || this.fontNeeded.has(id)) continue;
        this.fontNeeded.add(id);
        this.port.postMessage({ type: "library_needed", library_id: id });
      }
    }

    /**
     * Report a font that cannot be read (or that failed while rendering) once,
     * and stop reporting it: its tracks are silent from here on.
     *
     * `library_failed` is the one report (the client turns it into the page's
     * message and its log), which is why it is posted here and nowhere else.
     * @param {string} id
     * @param {string} reason
     * @returns {void}
     */
    reportFontFailure(id, reason) {
      const fontId = asId(id);
      if (fontId === "" || this.fontFailed.has(fontId)) return;
      this.fontFailed.add(fontId);
      this.fontNeeded.delete(fontId);
      this.port.postMessage({ type: "library_failed", library_id: fontId, reason: String(reason) });
    }

    /**
     * Turn a tap on or off: `"master"` for the mix, or a track's id for that
     * track's own output. Off is the default and costs nothing.
     * @param {unknown} target
     * @param {boolean} on
     * @returns {void}
     */
    setTap(target, on) {
      const name = asId(target);
      if (on) {
        if (name === "master") this.tapMaster = true;
        else if (name !== "") this.tapTrackId = name;
      } else if (name === "master") {
        this.tapMaster = false;
      } else if (this.tapTrackId === name) {
        this.tapTrackId = null;
        this.tapIndex = -1;
      }
      if (this.tapTrackId === null) {
        this.tapIndex = -1;
        this.tapLeft = null;
        this.tapRight = null;
      }
    }

    /**
     * Answer one `looper_take` with the looper's whole bars of the master, as
     * `{type:"looper_buffer", id, left, right, frames, rate, bars}` — the looper's
     * own buffers, TRANSFERRED rather than copied, which the page copies the
     * loop's frames out of (clipped to [−1, 1]: the looper taps the mix before the
     * clip) and hands straight back as `looper_buffers`. The looper keeps its
     * position while they are away, so it plays on from where it was; a looper
     * that has nothing (or whose buffers are already out on a take) answers no
     * bars.
     * @param {{id?: number}} message
     * @returns {void}
     */
    postLooperTake(message) {
      const take = this.perf.takeLooperBuffers();
      const answer = {
        type: "looper_buffer",
        id: message.id,
        rate: sampleRate,
        bars: take ? take.bars : 0,
        frames: take ? take.frames : 0,
        left: take ? take.left : null,
        right: take ? take.right : null,
      };
      if (take && take.left && take.right) {
        try {
          this.port.postMessage(answer, [take.left.buffer, take.right.buffer]);
          return;
        } catch {
          // A host whose port will not take a transfer list still gets a copy.
        }
      }
      this.port.postMessage(answer);
    }

    /**
     * Take a new song: the sequencer reads it at once (so the transport calls
     * that follow are ordered against it), then the tracks' engines follow it.
     * @param {object} snapshot the song as `server/doc.js`'s `snapshot()` returns it
     * @returns {void}
     */
    setSong(snapshot) {
      if (!this.ready) return;
      const tracks = Array.isArray(snapshot && snapshot.tracks) ? snapshot.tracks : [];
      if (tracks.length > MAX_TRACKS) {
        throw new Error(`A song can have at most ${MAX_TRACKS} tracks.`);
      }
      this.readKit(snapshot);
      // The mixer is plain data off the same snapshot: read here, so the chains
      // are built in the same queued step as the tracks they hang on (see
      // `syncSlots`), and so a send reaches a return that exists first.
      this.mixer = mixerSpecOf(snapshot);
      this.bpm = bpmOf(snapshot);
      this.sequencer.setSong(snapshot);
      this.enqueue(() => this.syncSlots(tracks));
    }

    /**
     * Read the sampler's containers off the song into flat maps, so a pad
     * trigger is one lookup. A song written before the sampler existed has
     * none of them, and reads as an empty kit.
     * @param {object} snapshot the song as `server/doc.js`'s `snapshot()` returns it
     * @returns {void}
     */
    readKit(snapshot) {
      const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
      this.pads = new Map();
      this.slices = new Map();
      this.sampleRates = new Map();

      const pads = snap.pads && typeof snap.pads === "object" ? snap.pads : {};
      for (const key of Object.keys(pads)) {
        const pad = pads[key];
        if (pad && typeof pad === "object") this.pads.set(key, pad);
      }
      const slices = snap.slices && typeof snap.slices === "object" ? snap.slices : {};
      for (const key of Object.keys(slices)) {
        const slice = slices[key];
        if (slice && typeof slice === "object") this.slices.set(key, slice);
      }
      const samples = snap.samples && typeof snap.samples === "object" ? snap.samples : {};
      for (const key of Object.keys(samples)) {
        const sample = samples[key];
        const rate = Number(sample && sample.rate);
        this.sampleRates.set(key, Number.isFinite(rate) && rate > 0 ? rate : sampleRate);
      }
    }

    /**
     * Make the tracks' engines match the song, in song order.
     *
     * A track keeps its engine and device as long as its id and device type are
     * unchanged — including a track whose device could NOT be built, which is
     * remembered as failed for that exact (track id, device type) and not
     * retried on every song update. Only a changed type (or id) retries.
     * @param {object[]} tracks the song's tracks, in song order
     * @returns {Promise<void>}
     */
    async syncSlots(tracks) {
      // Solo is a property of the whole song: any soloed track silences the rest.
      let anySolo = false;
      for (const track of tracks) {
        if (track && typeof track === "object" && track.solo === true) anySolo = true;
      }

      const previous = this.slots;
      const next = [];
      const trackSlots = new Map();
      const fontTracks = [];

      for (let index = 0; index < tracks.length; index += 1) {
        const track = tracks[index] && typeof tracks[index] === "object" ? tracks[index] : {};
        const id = typeof track.id === "string" ? track.id : "";
        const audio = isAudioTrack(track);
        const sampler = !audio && isSamplerTrack(track);
        const font = !audio && !sampler && isFontTrack(track);
        const type = audio
          ? AUDIO_ENGINE
          : sampler
            ? SAMPLER_ENGINE
            : font
              ? FONT_ENGINE
              : deviceType(track);
        let record = previous[index];
        if (
          record &&
          (record.track_id !== id ||
            record.type !== type ||
            !!record.audio !== audio ||
            !!record.sampler !== sampler ||
            !!record.font !== font)
        ) {
          this.teardown(record);
          record = null;
        }
        // Building an engine is the only await here; the old record is still in
        // `this.slots` (and so still in the mix) until the swap at the end.
        if (!record) {
          if (audio) record = this.buildAudioSlot(index, id);
          else if (sampler) record = this.buildSamplerSlot(index, id);
          else if (font) record = this.buildFontSlot(index, id);
          else record = await this.buildSlot(index, id, type);
        }
        next.push(record);
        // A track is a chain holder like the master and a return: its inserts,
        // its sends and the fade between two builds of its chain live on the
        // record, and a record reused across snapshots keeps them.
        if (record.chain === undefined) {
          record.chain = null;
          record.chainKey = null;
          record.chainLabel = id;
          record.preSends = NO_INSERTS;
          record.postSends = NO_INSERTS;
          record.sendGate = 1;
          record.muted = false;
          record.label = id;
        }
        // The font host assigns channels in snapshot order, so the song's own
        // track order is collected here, as the song arrived.
        if (font) fontTracks.push(fontSpecOf(track));
        if (record.failed) continue;
        if (!record.audio && !record.sampler && !record.font && !record.engine) continue;
        this.applyMix(record, track, anySolo);
        if (!record.audio && !record.sampler && !record.font) this.applyParams(record, track);
        if (id !== "") trackSlots.set(id, index);
      }

      for (let index = tracks.length; index < previous.length; index += 1) {
        if (previous[index]) this.teardown(previous[index]);
      }

      this.slots = next;
      this.trackSlots = trackSlots;
      this.fontTracks = fontTracks;
      this.bindFonts();
      // The tracks exist and the returns are known: build the mixer's chains on
      // them (one insert object per insert, outside `process()`), so the next
      // block runs the song's effects, sends, returns and master.
      this.applyMixer();
    }

    /**
     * Build one audio track's slot: two PCM voices, no engine and no module.
     * Nothing here can fail, so it is synchronous — an audio track is playable
     * as soon as its song arrives.
     * @param {number} index the track's position in the song
     * @param {string} trackId
     * @returns {object} the track's record
     */
    buildAudioSlot(index, trackId) {
      return {
        index: index,
        track_id: trackId,
        type: AUDIO_ENGINE,
        audio: true,
        sampler: false,
        failed: false,
        engine: null,
        module: -1,
        outPtr: 0,
        frames: 0,
        clock: 0,
        ctlNames: null,
        paramsKey: null,
        left: 0,
        right: 0,
        voices: [newVoice(), newVoice()],
      };
    }

    /**
     * Build one sampler track's slot: a pool of `StudioSamplerVoice` records and
     * no engine. Nothing here can fail, so it is synchronous — a sampler track
     * is playable as soon as its song arrives.
     * @param {number} index the track's position in the song
     * @param {string} trackId
     * @returns {object} the track's record
     */
    buildSamplerSlot(index, trackId) {
      const voices = [];
      for (let at = 0; at < SAMPLER_VOICES_PER_TRACK; at += 1) voices.push(StudioSamplerVoice.create());
      return {
        index: index,
        track_id: trackId,
        type: SAMPLER_ENGINE,
        audio: false,
        sampler: true,
        failed: false,
        engine: null,
        module: -1,
        outPtr: 0,
        frames: 0,
        clock: 0,
        ctlNames: null,
        paramsKey: null,
        left: 0,
        right: 0,
        voices: voices,
        /** Stolen voices ringing out their 64-frame fade; empty until one is needed. */
        tails: [],
      };
    }

    /**
     * Build one soundfont track's slot: no engine and no module, because the
     * track's audio comes from its font host's own channel (see the header).
     * Nothing here can fail, so it is synchronous — a soundfont track is
     * playable as soon as its font is loaded.
     * @param {number} index the track's position in the song
     * @param {string} trackId
     * @returns {object} the track's record
     */
    buildFontSlot(index, trackId) {
      return {
        index: index,
        track_id: trackId,
        type: FONT_ENGINE,
        audio: false,
        sampler: false,
        font: true,
        failed: false,
        engine: null,
        module: -1,
        outPtr: 0,
        frames: 0,
        clock: 0,
        ctlNames: null,
        paramsKey: null,
        left: 0,
        right: 0,
      };
    }

    /**
     * Build one track's engine: init, prime, open the slot, create the device
     * module and connect it to Output.
     * @param {number} index the track's position in the song
     * @param {string} trackId
     * @param {string} type the device's SunVox module type
     * @returns {Promise<object>} the track's record; `failed` is true when no
     *   device could be built
     */
    async buildSlot(index, trackId, type) {
      const record = {
        index: index,
        track_id: trackId,
        type: type,
        failed: true,
        engine: null,
        module: -1,
        outPtr: 0,
        frames: 0,
        clock: 0,
        ctlNames: null,
        paramsKey: null,
        left: 0,
        right: 0,
      };

      let engine = null;
      try {
        engine = await this.createEngine();
        const version = engine.init(sampleRate, 2, INIT_FLAGS);
        if (!(version >= 0)) throw new Error(`sv_init() failed with ${version}`);
        const engineRate = engine.sampleRate();
        if (engineRate !== sampleRate) {
          throw new Error(`the engine runs at ${engineRate} Hz, not the host's ${sampleRate} Hz`);
        }

        // Prime the callback buffer once, with the smallest block this engine
        // will ever be asked for and before its slot exists: the library sizes
        // its callback buffers from the first call, so no later sub-block can
        // make them grow on the audio thread.
        record.outPtr = engine.alloc(INITIAL_QUANTUM * 2 * 4);
        if (!record.outPtr) throw new Error("could not allocate the engine's block buffer");
        record.frames = INITIAL_QUANTUM;
        engine.render(record.outPtr, INITIAL_QUANTUM, 0, 0);
        record.clock = INITIAL_QUANTUM;

        if (engine.openSlot(SLOT) < 0) throw new Error(`could not open slot ${SLOT}`);
        // The engine's own volume stays at unity: every gain in Studio is the
        // JS mix's business (see the file header).
        engine.volume(SLOT, SLOT_VOLUME_UNITY);
        // There is no pattern data; this only keeps the slot's voices alive.
        engine.playFromBeginning(SLOT);

        let module = -1;
        engine.lockSlot(SLOT);
        try {
          if (this.testHooks && type === FAILING_DEVICE) {
            module = -1;
          } else {
            module = engine.newModule(SLOT, type, "device", 512, 512, 0);
            if (module < 0 && type !== FALLBACK_DEVICE) {
              this.report(new Error(`SunVox has no module type "${type}"; the track plays "${FALLBACK_DEVICE}".`));
              module = engine.newModule(SLOT, FALLBACK_DEVICE, "device", 512, 512, 0);
            }
            if (module >= 0 && engine.connectModule(SLOT, module, OUTPUT_MODULE) < 0) {
              // A device that cannot reach Output never sounds: drop it here,
              // inside the same lock its creation took (the vendor header
              // requires both module calls to run locked).
              engine.removeModule(SLOT, module);
              module = -1;
            }
          }
        } finally {
          engine.unlockSlot(SLOT);
        }

        if (module < 0) throw new Error(`could not build a "${type}" device for track ${trackId || index}`);
        // Live notes are timestamps "as quickly as possible", which is what
        // lets the sub-block split place an event on its own frame.
        engine.setEventT(SLOT, 1, 0);

        record.engine = engine;
        record.module = module;
        record.failed = false;
        return record;
      } catch (error) {
        this.report(error);
        if (engine) this.teardown(record, engine);
        return record;
      }
    }

    /**
     * Remove a record's device (locked, like its creation), free its block
     * buffer and deinit its engine. Safe to call on a half-built record.
     * @param {object} record
     * @param {object} [engine] the engine to use instead of `record.engine`
     * @returns {void}
     */
    teardown(record, engine) {
      if (record.voices) {
        for (const voice of record.voices) {
          voice.sounding = false;
          voice.channels = null;
        }
      }
      if (record.tails) {
        for (const tail of record.tails) {
          tail.sounding = false;
          tail.channels = null;
        }
      }
      const own = engine || record.engine;
      if (!own) return;
      try {
        if (record.module >= 0) {
          own.lockSlot(SLOT);
          try {
            own.removeModule(SLOT, record.module);
          } finally {
            own.unlockSlot(SLOT);
          }
        }
      } catch (error) {
        // The engine is going away; a failed removal has nothing left to clean.
        this.report(error);
      }
      record.module = -1;
      record.engine = null;
      try {
        if (record.outPtr) own.free(record.outPtr);
      } catch (error) {
        this.report(error);
      }
      record.outPtr = 0;
      record.frames = 0;
      try {
        own.deinit();
      } catch (error) {
        this.report(error);
      }
    }

    /**
     * @returns {Promise<object>} a freshly initialised engine, bound to its own
     *   wasm instance
     */
    async createEngine() {
      const instance = await callSunVoxFactory({
        wasmBinary: this.wasmBinary,
        wasmModule: this.wasmModule,
      });
      return bindEngine(instance);
    }

    /**
     * Write a track's device parameters, by controller name, whenever they
     * changed. Unknown names are ignored (a song carries names, not numbers).
     * @param {object} record
     * @param {object} track
     * @returns {void}
     */
    applyParams(record, track) {
      const params = deviceParams(track);
      let key;
      try {
        key = JSON.stringify(params);
      } catch {
        key = null;
      }
      if (key !== null && key === record.paramsKey) return;
      record.paramsKey = key;

      for (const name of Object.keys(params)) {
        const value = Number(params[name]);
        if (!Number.isFinite(value)) continue;
        const ctl = this.ctlIndex(record, name, -1);
        if (ctl < 0) continue;
        record.engine.setCtl(SLOT, record.module, ctl, Math.round(value), 1);
      }
    }

    /**
     * Cache a track's mix coefficients: its gain in dB as a linear factor, and
     * the constant-power pan pair.
     * @param {object} record
     * @param {object} track
     * @param {boolean} anySolo whether any track in the song is soloed
     * @returns {void}
     */
    applyMix(record, track, anySolo) {
      const muted = track.mute === true || (anySolo && track.solo !== true);
      record.muted = muted;
      const gain = muted ? 0 : Math.pow(10, gainDbOf(track) / 20);
      const theta = ((panOf(track) + 1) * Math.PI) / 4;
      record.left = gain * Math.cos(theta);
      record.right = gain * Math.sin(theta);
      // A track's name is what an insert fault names it by ("reverb on Bass …"),
      // and its sends are gated by the very same mute and solo rule as its fader.
      record.sendGate = muted ? 0 : 1;
      record.label = typeof track.name === "string" && track.name.trim() !== "" ? track.name.trim() : record.track_id;
    }

    /**
     * One chain holder: the runners that make up this chain, in the order they
     * run, and the name a message about one of them calls this chain. A track
     * record is one of these (it carries the same fields), a return record is
     * one, and the master is one.
     * @param {"track"|"return"|"master"} kind
     * @returns {object}
     */
    newChainOwner(kind) {
      return {
        kind: kind,
        /**
         * The chain's runners, in order (see `newRunner`). A chain edit is applied
         * to this list in place, on the message path, so `process()` only ever
         * walks a finished one.
         */
        chain: null,
        /** What that chain is (`chainKeyOf`), or null before anything was built. */
        chainKey: null,
        /** The name a message about one of its inserts calls it. */
        chainLabel: "",
      };
    }

    /**
     * Build the song's whole mixer from `this.mixer` and the tracks the last
     * `syncSlots` left in `this.slots`. Called on the message queue — never from
     * `process()` — so every insert object, its parameters and its wasm instance
     * are made here, and the audio thread only ever walks finished runners.
     *
     * A chain whose shape did not change keeps every insert object (its state and
     * all); an edit is applied insert by insert, so an insert the document did not
     * touch is never rebuilt and never fades (`applyChain`).
     * @returns {void}
     */
    applyMixer() {
      const mixer = this.mixer && typeof this.mixer === "object" ? this.mixer : NO_MIXER;

      // Returns first: a track's sends point at them.
      const previous = this.returnRecords;
      const next = new Map();
      const returns = [];
      // The returns' own send buffers are sized here, on the message path: a
      // return that the song has just added gets its pair before it is ever run,
      // so no block has to allocate one (see `ensureScratch`, which only grows
      // them when the host asks for a bigger block than they were made for).
      const scratchSize = Math.max(this.scratchFrames, INITIAL_QUANTUM);
      for (let index = 0; index < mixer.returns.length; index += 1) {
        const spec = mixer.returns[index];
        let record = previous.get(spec.id);
        if (!record) record = this.buildReturnRecord(spec.id);
        if (record.mixLeft === null || record.mixLeft.length < scratchSize) {
          record.mixLeft = new Float32Array(scratchSize);
          record.mixRight = new Float32Array(scratchSize);
        }
        record.name = spec.name;
        record.label = spec.name;
        const gain = spec.mute === true ? 0 : dbToGain(spec.gain_db, LOWEST_RETURN_GAIN_DB, HIGHEST_RETURN_GAIN_DB);
        const pan = panPair(spec.pan, gain);
        record.left = pan.left;
        record.right = pan.right;
        next.set(spec.id, record);
        returns.push(record);
        this.applyChain(record, mixer.chains.get(`return:${spec.id}`) || NO_INSERTS, spec.name);
      }
      // A return the song dropped takes its chain with it; the records still held
      // by a fading chain are dropped the next time the mixer is built.
      this.returnRecords = next;
      this.returns = returns;

      // The tracks, in song order, with the sends they carry.
      const slots = this.slots;
      for (let index = 0; index < slots.length; index += 1) {
        const record = slots[index];
        if (!record) continue;
        const trackId = asId(record.track_id);
        this.applyChain(record, mixer.chains.get(`track:${trackId}`) || NO_INSERTS, record.label || trackId);
        // The sends are read here, once per song: one gain per send, already
        // gated by the track's own mute and solo, split by where it taps.
        const preSends = [];
        const postSends = [];
        const sends = mixer.sendsByTrack.get(trackId);
        if (sends) {
          const gate = typeof record.sendGate === "number" ? record.sendGate : 0;
          for (let at = 0; at < sends.length; at += 1) {
            const send = sends[at];
            const target = next.get(send.return_id);
            if (!target) continue;
            const gain = dbToGain(send.level_db, LOWEST_SEND_DB, HIGHEST_SEND_DB) * gate;
            if (gain === 0) continue;
            const entry = { target: target, gain: gain };
            if (send.pre) preSends.push(entry);
            else postSends.push(entry);
          }
        }
        record.preSends = preSends;
        record.postSends = postSends;
      }

      // The master: its gain, and its own chain last of all.
      const master = this.masterRecord;
      master.label = "the master";
      this.masterGain = dbToGain(mixer.masterGainDb, LOWEST_MASTER_GAIN_DB, HIGHEST_MASTER_GAIN_DB);
      this.applyChain(master, mixer.chains.get("master") || NO_INSERTS, "the master");

      // Amp inserts exist now that the chains do: give them their capture and
      // their cabinet, report the files this device does not hold, and let go of
      // the instances of inserts the song dropped (plan 1d, Task 13).
      this.rebindAmps();
      this.bindAmps();
      this.pruneAmpInstances();
      this.postMonitorLatency();
    }

    /**
     * One return's record: its own chain holder plus the pair of buffers its
     * sends accumulate into (`renderReturn`).
     * @param {string} id
     * @returns {object}
     */
    buildReturnRecord(id) {
      const record = this.newChainOwner("return");
      record.id = id;
      record.name = id;
      record.label = id;
      record.left = 0;
      record.right = 0;
      record.mixLeft = null;
      record.mixRight = null;
      return record;
    }

    /**
     * Give one chain the inserts the document says it has.
     *
     * A chain is compared by SHAPE: its inserts' ids and kinds, in order, with
     * their bypass flags (`chainKeyOf`). A chain whose shape is unchanged only
     * had parameters turned — and possibly a Faust module that has arrived since
     * — so each runner takes its own `setParams` and keeps its insert, its state
     * and its fault: nothing is rebuilt and nothing fades.
     *
     * Anything else is a chain edit, and it is applied insert by insert rather
     * than by swapping one list of objects for another (see `buildChain`): an
     * insert the edit did not touch keeps its object — a reverb's tail, a
     * limiter's lookahead, a filter's state — and does not fade at all; an insert
     * that was added fades in from the dry signal; one that was removed, given
     * another kind or bypassed fades out where it stands. Every fade is armed
     * ONCE, here, and counts down frame by frame across runs and blocks (a run is
     * only a few dozen frames once a motion curve splits a block), so an edit can
     * never be stranded half-way. A snapshot that lands while a fade is still
     * running only re-targets the runners that are moving: each weight keeps the
     * value it had, so nothing restarts and nothing clicks.
     *
     * All of it runs on the message queue — never in `process()` — so the audio
     * thread only ever finds runner objects that are already built.
     * @param {object} owner a chain holder (a track, a return or the master)
     * @param {object[]} specs the chain's inserts, in the order they run
     * @param {string} label what a message about one of them calls this owner
     * @returns {void}
     */
    applyChain(owner, specs, label) {
      owner.chainLabel = label;
      if (owner.chain !== null) this.compactChain(owner);
      const key = chainKeyOf(specs);
      if (owner.chain === null) {
        // The first chain a song has: there is nothing to fade from, so it is
        // simply the chain that plays.
        owner.chain = this.buildChain(owner, specs, label, false);
        owner.chainKey = key;
        if (owner.kind === "master") this.postMasterLatency(owner.chain);
        return;
      }
      if (owner.chainKey === key) {
        this.applyChainParams(owner, specs);
        return;
      }
      const before = chainLatencyOf(owner.chain);
      const chain = this.buildChain(owner, specs, label, true);
      owner.chain = chain;
      owner.chainKey = key;
      // A chain whose total latency moved — the limiter added, removed or
      // bypassed — fades over its own delay as well as the 64 frames: the two
      // sides of the fade are that far apart in time (the dry side is not delayed
      // by the insert's lookahead, the wet side is), so the ramp is long enough
      // for the move to arrive spread over L frames instead of as a step. It is
      // not a time-aligned blend, and the comb it leaves for those frames is the
      // price of moving a delay in or out (see the file header). A REBUILT master
      // limiter is the case that does come out aligned: the pair runs the old and
      // the new chain in parallel and the old one holds the path while the new
      // one's lookahead fills (see `buildChain`).
      this.armFades(chain, Math.max(CHAIN_FADE_FRAMES, before, chainLatencyOf(chain)));
      if (owner.kind === "master") this.postMasterLatency(chain);
    }

    /**
     * Drop the runners an earlier edit retired once their fade has finished, and
     * fold a blend whose fade has arrived into the path it arrived at. Called on
     * the message path only, so `process()` never compacts a chain.
     * @param {object} owner
     * @returns {void}
     */
    compactChain(owner) {
      const chain = owner.chain;
      let dead = false;
      for (let index = 0; index < chain.length; index += 1) {
        const node = chain[index];
        if (!node) continue;
        if (node.blend ? node.weight === node.target : node.retired && node.wet === 0) {
          dead = true;
          break;
        }
      }
      if (!dead) return;
      const kept = [];
      for (let index = 0; index < chain.length; index += 1) {
        const node = chain[index];
        if (!node) continue;
        if (node.blend) {
          // A blend that has arrived IS the path it arrived at; one still fading
          // stays a node of the chain, with the path it is leaving inside it.
          if (node.weight === node.target) {
            for (let at = 0; at < node.fresh.length; at += 1) kept.push(node.fresh[at]);
          } else kept.push(node);
          continue;
        }
        if (node.retired && node.wet === 0) continue;
        kept.push(node);
      }
      owner.chain = kept;
      // A blend that has folded (or a retired runner that has finished its fade)
      // is gone: its amp insert's NAM instance is not needed any more, and a
      // module kept alive for it during a rebuild can be destroyed now too.
      this.pruneAmpInstances();
    }

    /**
     * Take the parameters of a chain whose shape did not change — and give an
     * insert that was waiting for a Faust module its chance to build now.
     *
     * Nothing is rebuilt and nothing fades: every insert keeps its state, so a
     * knob turn (or a snapshot that changed anything else about the song) costs
     * one `setParams` per insert whose own settings actually moved.
     * @param {object} owner
     * @param {object[]} specs
     * @returns {void}
     */
    applyChainParams(owner, specs) {
      // The runners the chain still plays, in the order it plays them: a blend
      // node contributes the path it is arriving at (see `collectRunnerOrder`).
      const chain = [];
      collectRunnerOrder(owner.chain, chain);
      let cursor = 0;
      for (let index = 0; index < specs.length; index += 1) {
        const spec = specs[index];
        const id = asId(spec.id);
        // The retired runners of an earlier edit are skipped: they are on their
        // way out and never take parameters again.
        while (cursor < chain.length && chain[cursor].id !== id) cursor += 1;
        if (cursor >= chain.length) break;
        const runner = chain[cursor];
        cursor += 1;
        if (runner.loading) {
          this.retryLoading(runner, spec, owner);
          continue;
        }
        this.applyRunnerParams(runner, spec);
      }
      // An insert that has just been built (a Faust module that arrived) or armed
      // again can move the master chain's delay: a limiter that appears, or one
      // the NaN guard bypassed that stops counting, is a latency the tap and the
      // meter have to hear about at once.
      if (owner.kind === "master") this.postMasterLatency(owner.chain);
    }

    /**
     * One more try at an insert whose Faust module had not arrived: build it now
     * if it has, and give up on it (as a permanent pass-through, reported once)
     * once the page has posted its modules and this kind is not among them.
     * @param {object} runner
     * @param {object} spec
     * @param {object} owner
     * @returns {void}
     */
    retryLoading(runner, spec, owner) {
      const host = typeof StudioFaustHost === "undefined" ? null : StudioFaustHost;
      if (host && typeof host.has === "function" && host.has(runner.kind) === true) {
        this.attachInsert(runner, spec, owner, this.sequencer.isPlaying());
        return;
      }
      if (!this.faustArrived) return;
      runner.loading = false;
      runner.broken = true;
      this.reportBrokenInsert(runner, owner, `no compiled "${spec.kind}" effect was posted`);
    }

    /**
     * Give one runner its insert's parameters. A faulted insert is armed again
     * ONLY when its own settings moved: any other edit to the song leaves it
     * bypassed, with the state it produced the bad sample from still in it.
     *
     * Arming it again is a fresh start, so it comes back the way a newly built
     * insert does: its state (the NaN is still in it) is thrown away, its own
     * latency runs off first (a limiter's lookahead fills from the incoming
     * signal) and then its weight fades in from the dry signal over the chain's
     * own 64 frames. An insert that comes back at another level is therefore a
     * short ramp and not a step in the master.
     * @param {object} runner
     * @param {object} spec
     * @returns {void}
     */
    applyRunnerParams(runner, spec) {
      const key = paramsKeyOf(spec.params);
      if (key !== null && key === runner.paramsKey) return;
      runner.paramsKey = key;
      if (runner.insert === null) return;
      runner.insert.setParams(spec.params);
      if (!runner.faulted) return;
      // Its own settings changed, so it gets another chance: its state (the NaN
      // is still in it) is reset and the insert comes back the way a new one
      // does — primed by its own latency, then faded in from the dry signal.
      runner.faulted = false;
      if (typeof runner.insert.reset === "function") runner.insert.reset();
      this.startFadeIn(runner);
    }

    /**
     * Put one runner back into the signal path: primed by its own latency (a
     * limiter's lookahead is filled from the incoming signal, so its output never
     * starts with the silence of an empty delay line) and then faded in from the
     * dry signal over the chain's own 64 frames. A stopped transport has nothing
     * to fade against, so there the insert simply plays.
     * @param {object} runner
     * @returns {void}
     */
    startFadeIn(runner) {
      const insert = runner.insert;
      const latency = insert && insert.latencyFrames > 0 ? insert.latencyFrames : 0;
      runner.fadeFrames = CHAIN_FADE_FRAMES;
      runner.fadeStep = 1 / CHAIN_FADE_FRAMES;
      runner.prime = latency;
      if (!this.sequencer.isPlaying()) {
        runner.wet = 1;
        runner.wetTarget = 1;
        runner.prime = 0;
        return;
      }
      runner.wet = 0;
      runner.wetTarget = 1;
    }

    /**
     * Build one chain from `specs`, reusing the runners the owner already holds.
     *
     * A runner is reused — the very same object, so its insert's tail, its delay
     * line, its filter state and its parameters all survive — when its insert id
     * kept its kind and the edit did not reorder the inserts around it. What comes
     * out is the chain as it will run once the edit has faded through:
     *
     *   - a reused runner keeps its place and its state (only its bypass flag and
     *     its parameters can have moved);
     *   - an insert that was added fades in from the dry signal, after its own
     *     latency has run off (a limiter's lookahead is filled from the incoming
     *     signal before its output is mixed in, so it never starts by outputting
     *     the silence of an empty delay line);
     *   - a runner the edit dropped stays where it stands with 0 as its weight's
     *     target, fades out, and is dropped by the next `applyChain`.
     *
     * Between two reused runners, though, an edit can leave a SEGMENT that is
     * replaced rather than ended: an insert deleted and another added in its
     * place, or one id given another kind. Fading those two one after the other
     * is wrong twice over — the arriving insert's weight brings its output in on
     * top of what the leaving one still passes (so the level swells while both
     * are half in), and it runs on the leaving insert's output rather than on the
     * signal that arrived (so a new delay replays the echoes of the effect it
     * replaced). A segment like that is therefore ONE node of the chain that runs
     * both paths on the same input and blends the two OUTPUTS (see `runBlend` and
     * `placeSegment`).
     *
     * A reorder (the same inserts in another order) is the extreme of that: no
     * insert can be reused at its place, so the whole chain is one such segment —
     * the old order and the new one, both fed the chain's input, crossfaded in
     * parallel. An edit that lands while a blend is still fading is treated the
     * same way (the old chain, live blend and all, becomes the leaving path), so
     * nothing has to re-fade a fade that is already running.
     * @param {object} owner the chain holder (`owner.chain` is the chain this
     *   edit replaces, or null for the first chain of a song)
     * @param {object[]} specs
     * @param {string} label
     * @param {boolean} edit whether this replaces a live chain (so new inserts
     *   fade in) rather than being the first one (which plays at once)
     * @returns {object[]} the new chain, in the order it runs
     */
    buildChain(owner, specs, label, edit) {
      const previous = owner.chain === null ? NO_INSERTS : owner.chain;
      const fadeIn = edit && this.sequencer.isPlaying();
      // Which spec each insert id names, and whether the inserts a spec still
      // names come back in the order they were in.
      const wanted = new Map();
      for (let index = 0; index < specs.length; index += 1) wanted.set(asId(specs[index].id), index);
      // A chain that holds a blend still fading cannot be taken apart position by
      // position (the two paths of that blend are one place in the chain), and a
      // reorder has no position to keep: both make the whole chain the segment.
      let whole = false;
      const reuse = new Map();
      let last = -1;
      let ordered = true;
      for (let index = 0; index < previous.length; index += 1) {
        const node = previous[index];
        if (!node) continue;
        if (node.blend) {
          whole = true;
          continue;
        }
        if (node.retired) continue;
        const target = wanted.get(node.id);
        if (target === undefined) continue;
        if (target <= last) ordered = false;
        else last = target;
        if (specs[target].kind === node.kind) reuse.set(node.id, node);
      }
      if (!ordered) {
        reuse.clear();
        whole = true;
      }
      if (whole) return this.buildParallelChain(owner, specs, label, previous, fadeIn);

      // The runners this edit keeps, by the spec index they come back at.
      const kept = new Array(specs.length);
      for (let index = 0; index < previous.length; index += 1) {
        const node = previous[index];
        if (!node || node.retired || node.blend) continue;
        const target = wanted.get(node.id);
        if (target === undefined || reuse.get(node.id) !== node) continue;
        kept[target] = node;
      }

      const chain = [];
      let oldAt = 0;
      let specAt = 0;
      for (let index = 0; index < specs.length; index += 1) {
        const node = kept[index];
        if (!node) continue;
        // Everything between the last kept runner and this one is one segment:
        // what the previous chain had there, and what the document has now.
        let at = oldAt;
        while (at < previous.length && previous[at] !== node) at += 1;
        this.placeSegment(chain, previous.slice(oldAt, at), specs.slice(specAt, index), owner, label, fadeIn);
        chain.push(node);
        this.refreshRunner(node, specs[index], owner, fadeIn);
        oldAt = at + 1;
        specAt = index + 1;
      }
      this.placeSegment(chain, previous.slice(oldAt), specs.slice(specAt), owner, label, fadeIn);
      return chain;
    }

    /**
     * Build a chain as the arriving side of one chain-wide blend: every insert
     * the document names is built fresh (a reorder reuses nothing, and the old
     * objects stay in the leaving path with the state the fade plays out), and the
     * whole previous chain is that leaving path.
     * @param {object} owner
     * @param {object[]} specs
     * @param {string} label
     * @param {object[]} previous the chain this edit replaces
     * @param {boolean} fadeIn whether a fade can run (the transport is playing)
     * @returns {object[]} the new chain
     */
    buildParallelChain(owner, specs, label, previous, fadeIn) {
      const fresh = [];
      for (let index = 0; index < specs.length; index += 1) {
        const spec = specs[index];
        const leaving = this.adoptAmpRunner(spec, previous);
        if (leaving) {
          // A reorder of an amp whose capture is already playing: MOVE its insert
          // (and with it its NAM instance, converters, cabinet and state) to the
          // arriving runner. The leaving runner becomes a pass-through for that
          // amp, so the two paths of the blend never advance one NAM state twice
          // and nothing has to be loaded while the song plays.
          const runner = this.makeRunner(spec, label, owner);
          runner.insert = leaving.insert;
          runner.paramsKey = paramsKeyOf(spec.params);
          runner.faulted = leaving.faulted === true;
          runner.prime = 0;
          runner.wet = 1;
          runner.wetTarget = 1;
          leaving.insert = null;
          leaving.paramsKey = null;
          leaving.faulted = false;
          runner.insert.setParams(spec.params);
          fresh.push(runner);
          continue;
        }
        fresh.push(this.newRunner(spec, label, owner, false));
      }
      if (!fadeIn) {
        // Nothing plays, so nothing fades: the arriving chain is simply the one
        // that plays, and what it replaced is let go where it stands.
        for (let index = 0; index < previous.length; index += 1) {
          const node = previous[index];
          if (!node || node.blend) continue;
          node.retired = true;
          node.wet = 0;
          node.wetTarget = 0;
          node.prime = 0;
        }
        return fresh;
      }
      if (previous.length === 0) return fresh;
      this.freezeNodes(previous);
      return [this.newBlend(previous, fresh, true)];
    }

    /**
     * Put one segment of a chain — the material between two runners the edit kept
     * — into the chain being built.
     *
     * Three shapes, and only the last has to run anything twice:
     *
     *   - nothing leaves: the arriving inserts fade in one by one, each against
     *     its own input, which cannot swell (an insert's weight only ever swaps
     *     its own output for the signal it was given);
     *   - nothing arrives: the leaving inserts fade out where they stand;
     *   - both: one blend node runs the two paths on the SAME input and fades
     *     between their outputs (see `buildChain`).
     * @param {object[]} chain the chain being built (appended to)
     * @param {object[]} leaving the previous chain's nodes in this segment
     * @param {object[]} specs the document's inserts in this segment
     * @param {object} owner
     * @param {string} label
     * @param {boolean} fadeIn whether a fade can run (the transport is playing)
     * @returns {void}
     */
    placeSegment(chain, leaving, specs, owner, label, fadeIn) {
      const dropped = [];
      for (let index = 0; index < leaving.length; index += 1) {
        const node = leaving[index];
        if (node && !node.blend) dropped.push(node);
      }
      if (dropped.length === 0) {
        for (let index = 0; index < specs.length; index += 1) {
          chain.push(this.newRunner(specs[index], label, owner, fadeIn));
        }
        return;
      }
      if (!fadeIn) {
        // Nothing plays, so nothing fades: what the document dropped just goes,
        // and what it added plays at once.
        for (let index = 0; index < dropped.length; index += 1) {
          const node = dropped[index];
          node.retired = true;
          node.wet = 0;
          node.wetTarget = 0;
          node.prime = 0;
        }
        for (let index = 0; index < specs.length; index += 1) {
          chain.push(this.newRunner(specs[index], label, owner, false));
        }
        return;
      }
      if (specs.length === 0) {
        // Nothing arrives: each leaving insert fades out where it stands.
        for (let index = 0; index < dropped.length; index += 1) {
          const node = dropped[index];
          node.retired = true;
          node.wetTarget = 0;
          node.prime = 0;
          chain.push(node);
        }
        return;
      }
      // Both sides: the two paths run in parallel and one weight fades between
      // their outputs, so nothing the old one made is fed to the new one and two
      // half-in inserts cannot add up to more than the louder of them.
      const fresh = [];
      for (let index = 0; index < specs.length; index += 1) {
        fresh.push(this.newRunner(specs[index], label, owner, false));
      }
      this.freezeNodes(dropped);
      chain.push(this.newBlend(dropped, fresh, true));
    }

    /**
     * Stop every runner in a list where its weight is. A path that goes into a
     * blend does not fade any more itself — the blend owns the crossfade, and a
     * path whose own weights kept moving would fade twice.
     * @param {object[]} nodes
     * @returns {void}
     */
    freezeNodes(nodes) {
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (!node) continue;
        if (node.blend) {
          // A blend inside a path is frozen too: it keeps the share of the signal
          // it has now, and the path it is leaving goes with the whole path.
          node.target = node.weight;
          node.prime = 0;
          continue;
        }
        node.retired = true;
        node.wetTarget = node.wet;
        node.prime = 0;
      }
    }

    /**
     * One blend node: two paths of the chain, both fed the same input, with one
     * weight fading between their outputs.
     *
     * The path being left runs while the path arriving PRIMES: a rebuilt master
     * limiter needs its lookahead filled before its output means anything, and
     * until then the old path is what the chain plays — so the ceiling holds, the
     * time base does not move, and the weight starts from a path that is already
     * at full strength instead of from silence.
     * @param {object[]} leaving the path on its way out, frozen where it stands
     * @param {object[]} fresh the path on its way in, at full weight
     * @param {boolean} fadeIn whether the weight fades (the transport is playing)
     * @returns {object} the node
     */
    newBlend(leaving, fresh, fadeIn) {
      return {
        blend: true,
        /** The path on its way out, and the one on its way in. */
        leaving: leaving,
        fresh: fresh,
        /** 0 is the leaving path alone, 1 the arriving one; it settles at 1. */
        weight: fadeIn ? 0 : 1,
        target: 1,
        /** Frames the arriving path runs before the weight starts moving. */
        prime: fadeIn ? chainLatencyOf(fresh) : 0,
        /** The frames the fade spans, and the step one frame takes. */
        fadeFrames: CHAIN_FADE_FRAMES,
        fadeStep: 1 / CHAIN_FADE_FRAMES,
      };
    }

    /**
     * Point one reused runner at the spec the document now holds: its bypass flag
     * and its parameters, and — when it has no insert to run (it was bypassed, or
     * its Faust module was still on its way) — a new one, which fades in.
     *
     * A runner whose weight is 0 is a special case, and the reason bypass is a
     * crossfade and not a switch: `runChainList` never ran it, so its insert's
     * state is frozen where it was when the fade reached zero — a master
     * limiter's 72-frame lookahead and its gain envelope, a delay's or a reverb's
     * tail. Handing that back is not the effect the song has any more (it is the
     * sound of the moment it was switched off), so an insert coming back from
     * silence starts from silence: reset, primed by its own latency, then faded
     * in like any insert arriving.
     * @param {object} runner
     * @param {object} spec
     * @param {object} owner
     * @param {boolean} fadeIn whether a fade can run (the transport is playing)
     * @returns {void}
     */
    refreshRunner(runner, spec, owner, fadeIn) {
      runner.label = insertLabelOf(spec.kind);
      runner.bypass = spec.bypass === true;
      if (runner.bypass) {
        // Bypass is a crossfade too: the insert keeps its object and its
        // parameters (an un-bypass picks both up again) but fades out of the
        // signal path.
        runner.wetTarget = 0;
        if (!fadeIn) runner.wet = 0;
        return;
      }
      const frozen = runner.wet === 0;
      runner.wetTarget = 1;
      if (runner.insert === null) {
        // Nothing to run yet: a bypass that was just lifted, or a module that has
        // arrived. A kind that can never be built stays a pass-through.
        if (!runner.broken) this.attachInsert(runner, spec, owner, fadeIn);
        return;
      }
      if (frozen) {
        // It sat the bypass out and its state is where that left it (see above).
        if (typeof runner.insert.reset === "function") runner.insert.reset();
        this.startFadeIn(runner);
      }
      this.applyRunnerParams(runner, spec);
    }

    /**
     * Give every node that is changing its target: a fade over `fadeFrames`
     * frames, counted per FRAME (so a block a motion curve split into a dozen runs
     * fades exactly as far as an unsplit one would have), or at once when the
     * transport is stopped — a stopped song has nothing to fade against, so its
     * new chain is simply the one that plays.
     * @param {object[]} chain
     * @param {number} fadeFrames
     * @returns {void}
     */
    armFades(chain, fadeFrames) {
      const playing = this.sequencer.isPlaying();
      const step = 1 / fadeFrames;
      for (let index = 0; index < chain.length; index += 1) {
        const node = chain[index];
        if (!node) continue;
        if (node.blend) {
          node.fadeFrames = fadeFrames;
          node.fadeStep = step;
          if (playing) continue;
          node.weight = node.target;
          node.prime = 0;
          continue;
        }
        node.fadeFrames = fadeFrames;
        node.fadeStep = step;
        if (node.wet === node.wetTarget) {
          node.prime = 0;
          continue;
        }
        if (playing) continue;
        node.wet = node.wetTarget;
        node.prime = 0;
      }
    }

    /**
     * Build one runner for one insert: Crow's own dynamics in JavaScript, or a
     * compiled Faust effect instantiated from the page's compiled module.
     *
     * A runner that has no insert to run yet is a PASS-THROUGH that costs nothing
     * (see `createInsert`), so one bad insert costs only itself.
     * @param {{id: string, kind: string, bypass: boolean, params: object}} spec
     * @param {string} label what a message calls this insert's chain
     * @param {object} owner
     * @param {boolean} fadeIn whether an insert built here starts dry and fades in
     * @returns {object} the runner `runChainList` drives
     */
    newRunner(spec, label, owner, fadeIn) {
      const runner = this.makeRunner(spec, label, owner);
      if (runner.bypass) {
        // A bypassed insert has nothing to run, so it has nothing to build
        // either: an un-bypass builds it then (see `refreshRunner`).
        runner.wet = 0;
        runner.wetTarget = 0;
        return runner;
      }
      this.attachInsert(runner, spec, owner, fadeIn);
      // An insert that could not be built (still loading, or never buildable) is
      // a pass-through at full weight: it is in the path, it just does nothing.
      if (runner.insert === null) {
        runner.wet = 1;
        runner.wetTarget = 1;
        runner.prime = 0;
      }
      return runner;
    }

    /**
     * One runner's bookkeeping, before any insert is built. Kept separate so a
     * reorder can hand an AMP insert from its leaving runner to an arriving one
     * without building a second one (see `adoptAmpRunner`).
     * @param {{id: string, kind: string, bypass: boolean, params: object}} spec
     * @param {string} label
     * @param {object} owner
     * @returns {object}
     */
    makeRunner(spec, label, owner) {
      return {
        id: asId(spec.id),
        kind: spec.kind,
        label: insertLabelOf(spec.kind),
        /** The track this runner belongs to ("" for a return or the master). */
        trackId: owner && owner.track_id !== undefined && owner.track_id !== null ? asId(owner.track_id) : "",
        bypass: spec.bypass === true,
        insert: null,
        faulted: false,
        /** Its weight in the signal path: 1 is the insert's output, 0 its input. */
        wet: 1,
        /** Where that weight is heading: 0 or 1. */
        wetTarget: 1,
        /** Frames its insert runs before its weight starts moving (its latency). */
        prime: 0,
        /** The frames the current fade spans, and the step one frame takes. */
        fadeFrames: CHAIN_FADE_FRAMES,
        fadeStep: 1 / CHAIN_FADE_FRAMES,
        /** The parameters it was last given, so a snapshot that turns nothing is nothing. */
        paramsKey: null,
        /** A Faust insert still waiting for the page's compiled modules. */
        loading: false,
        /** A kind that can never be built: a permanent pass-through, said once. */
        broken: false,
        /** Dropped by an edit: it fades out and `compactChain` lets it go. */
        retired: false,
      };
    }

    /**
     * The amp insert object a chain still holds for one spec, when the edit is a
     * reorder of the SAME capture: the arriving runner takes the leaving
     * runner's insert over — its NAM instance, its converters, its cabinet and
     * all its state — instead of building a second one. Moving it is the only
     * way a chain edit can keep an amp playing without loading a capture on the
     * render thread (plan 1d, Task 13).
     * @param {object} spec the arriving insert's spec
     * @param {object[]} previous the chain this edit replaces
     * @returns {object|null} the leaving runner, or null when there is nothing to move
     */
    adoptAmpRunner(spec, previous) {
      if (spec.bypass === true || spec.kind !== AMP_KIND) return null;
      const id = asId(spec.id);
      const params = spec.params && typeof spec.params === "object" ? spec.params : {};
      const modelId = asId(params.model_id);
      if (modelId === "") return null;
      const runners = [];
      collectEveryRunner(previous, runners);
      for (let index = 0; index < runners.length; index += 1) {
        const runner = runners[index];
        if (!runner || runner.id !== id || runner.kind !== AMP_KIND || !runner.insert) continue;
        if (typeof runner.insert.captureId !== "function" || runner.insert.captureId() !== modelId) continue;
        // Only an attachment that is really loaded (or one that is stopped) can
        // be moved. An insert whose capture merely arrived in the document while
        // a different one plays is parked, and must not carry the old instance
        // into a spec that names the new capture.
        if (typeof runner.insert.params === "function") {
          const state = runner.insert.params();
          if (!state || (state.attached !== true && state.failed !== true)) continue;
        }
        return runner;
      }
      return null;
    }

    /**
     * Build a runner's insert, and give it its parameters and its fade. Called
     * when a runner is made, and again later for one that was bypassed or waiting
     * for a Faust module — always on the message path, never from `process()`.
     * @param {object} runner
     * @param {object} spec
     * @param {object} owner
     * @param {boolean} fadeIn whether the insert starts dry and fades in
     * @returns {void}
     */
    attachInsert(runner, spec, owner, fadeIn) {
      const insert = this.createInsert(runner, spec, owner);
      if (insert === null) {
        // Nothing to run: pass-through at full weight, whatever it was before.
        runner.wet = 1;
        runner.wetTarget = 1;
        runner.prime = 0;
        return;
      }
      runner.insert = insert;
      runner.faulted = false;
      runner.paramsKey = paramsKeyOf(spec.params);
      // The parameters go on FIRST: an amp insert loads its capture here, and a
      // capture whose rate differs from the context's makes the insert delay its
      // audio (the rate bridge's real look-ahead), which is what `prime` has to
      // wait for. Reading `latencyFrames` before the capture was attached would
      // always see 0.
      insert.setParams(spec.params);
      // An amp that has nothing to play yet — a capture parked for Stop, one
      // this device does not hold, or one that failed — is SILENT from its first
      // block: fading it in from the dry signal would let the dry guitar through
      // for 64 frames, which an amp may never do (Review Focus 1).
      let silentAmp = false;
      if (runner.kind === AMP_KIND && typeof insert.params === "function") {
        const ampState = insert.params();
        silentAmp = !!(ampState && ampState.model_id !== "" && ampState.attached !== true);
      }
      // Its own delay runs off before its output is mixed in: a limiter fills its
      // lookahead from the incoming signal instead of starting with 72 frames of
      // the silence an empty delay line gives.
      runner.prime = !silentAmp && fadeIn && insert.latencyFrames > 0 ? insert.latencyFrames : 0;
      runner.wet = silentAmp ? 1 : fadeIn ? 0 : 1;
      runner.wetTarget = 1;
      // A build that worked clears both marks, so a fault or a missed module that
      // comes back later is reported again.
      this.loadingReported.delete(runner.id);
      this.brokenReported.delete(runner.id);
    }

    /**
     * Make one runner's insert object, or say why it has none.
     *
     * A Faust insert whose module has not arrived yet is left to wait: the page
     * posts its modules a moment after the engine comes up, and a song loaded
     * before them must play rather than fail. Once they have arrived, a kind that
     * is not among them never will be, so it is a permanent pass-through that is
     * reported once. An insert whose kind is neither Crow's dynamics nor a
     * compiled effect is reported once too, and so is one whose build throws, so
     * one bad insert costs only itself.
     * @param {object} runner
     * @param {object} spec
     * @param {object} owner
     * @returns {object|null} the insert, or null for a pass-through
     */
    createInsert(runner, spec, owner) {
      try {
        if (spec.kind === AMP_KIND) {
          runner.loading = false;
          runner.broken = false;
          return this.createAmpInsert(runner, owner);
        }
        if (DYNAMICS_KINDS.indexOf(spec.kind) !== -1) {
          if (typeof StudioDynamics === "undefined" || StudioDynamics === null) {
            throw new Error("Crow's dynamics are not part of this engine");
          }
          runner.loading = false;
          runner.broken = false;
          return StudioDynamics.create(spec.kind, sampleRate, {
            // Only the limiter that sits on the master gets the lookahead.
            master: owner.kind === "master" && spec.kind === "limiter",
          });
        }
        const host = typeof StudioFaustHost === "undefined" ? null : StudioFaustHost;
        if (!host || typeof host.has !== "function" || host.has(spec.kind) !== true) {
          if (!this.faustArrived) {
            runner.loading = true;
            runner.broken = false;
            this.reportLoadingInsert(runner.id, runner.label, owner.chainLabel);
            return null;
          }
          runner.loading = false;
          runner.broken = true;
          this.reportBrokenInsert(runner, owner, `no compiled "${spec.kind}" effect was posted`);
          return null;
        }
        runner.loading = false;
        runner.broken = false;
        return host.create(spec.kind, sampleRate);
      } catch (error) {
        runner.loading = false;
        runner.broken = true;
        this.reportBrokenInsert(
          runner,
          owner,
          error && error.message ? error.message : String(error),
        );
        return null;
      }
    }

    /**
     * One amp insert: a NAM capture through a cabinet (plan 1d, Task 13).
     *
     * The insert is a thin object around four pieces of engine state: the NAM
     * host's instance for this insert OBJECT (`engine/nam-host.js`), the capture
     * that instance plays, the cabinet convolver (`engine/convolver.js`) and the
     * streaming rate converters the capture's own rate may need. All four are
     * attached on the MESSAGE path (`setParams`, and again when a library file
     * arrives), never inside `process()`.
     *
     * Two rules keep them off the audio path:
     *
     *   - **an unchanged attachment is nothing.** The capture and the cabinet each
     *     remember what they were built from (the library id, the bytes/IR, the
     *     engine's readiness), so a song snapshot that only turned a fader — or
     *     anything else that runs `rebindAmps` — does not reload a capture or
     *     rebuild a cabinet;
     *   - **a file change while the song plays waits for Stop.** Choosing another
     *     capture or cabinet mid-performance is parked and applied on the next
     *     Stop ("Loads when you stop.", exactly as a library load is), so nothing
     *     re-parses a `.nam` or rebuilds an FFT while the playhead runs. A runner
     *     built DURING playback (a chain edit's arriving path) is parked SILENT
     *     until the next Stop ("Loads when you stop."), unless it is the same amp
     *     the edit moved: then it takes that runner's already-loaded instance over
     *     (see `adoptAmpRunner`), so a reorder loads nothing at all.
     *
     * The instance key is a per-OBJECT number, never the document's insert id: a
     * chain edit that fades an amp out and back in runs two runners for one insert
     * for the length of the fade, and each needs its own NAM state (one shared
     * instance would advance one model's state twice per block).
     *
     * What `process()` does to a run, in order (see the file header):
     *
     *     input_db → [convert to the capture's rate] → NAM (mono) → [convert
     *       back] → cabinet (wet/dry by ir_mix) → output_db
     *
     * A run is cut into `INSERT_BLOCK` pieces first, because the NAM engine's own
     * block is 128 frames wide; the converters' state carries across the pieces,
     * so a piece is invisible in the result. Nothing here allocates: every buffer
     * is made when the capture is attached.
     * @param {object} runner the runner this insert belongs to
     * @param {object} owner the chain holder, for a fault's sentence
     * @returns {object} the insert `runChainList` drives
     */
    createAmpInsert(runner, owner) {
      const processor = this;
      processor.ampInstanceSeq += 1;
      const key = AMP_INSTANCE_PREFIX + String(processor.ampInstanceSeq);
      const contextRate = sampleRate;

      /** What this insert currently is: the files it names and its three numbers. */
      const state = {
        modelId: "",
        irId: "",
        inputGain: 1,
        outputGain: 1,
        irMix: 1,
        /** Whether a capture is loaded into this insert's instance right now. */
        attached: false,
        /** The rate the capture plays at (the context's rate when it needs none). */
        captureRate: contextRate,
        /** Why this insert is silent, when it is (the page's or the plan's words). */
        reason: "",
        /**
         * Whether this amp has been STOPPED (silent): its capture trapped inside
         * the wasm engine, or produced a sample that is not a number. A stopped
         * amp plays silence — never the dry signal — until its own settings move.
         */
        failed: false,
        /** Whether that stop has been reported (one report per stop). */
        reported: false,
        /**
         * The armed track's input selection this insert decides its mono sum
         * from: 1 for a one-channel input, 2 for a stereo pair (the default). It
         * is fixed for the insert's life and never read from the signal itself.
         */
        inputChannels: 2,
        /** How many times this insert built its capture / its cabinet (for tests). */
        captureLoads: 0,
        cabinetLoads: 0,
      };

      /**
       * What the current attachment was built FROM. A rebind compares these with
       * the library as it is now and does nothing at all when they match: this is
       * what keeps a snapshot (a fader move, a mute, any edit elsewhere in the
       * song) from reloading every capture and rebuilding every cabinet.
       * `null` means "nothing attached yet", so the first attachment always runs.
       */
      const attached = {
        modelId: null,
        text: null,
        problem: null,
        ready: false,
        irId: null,
        pcm: null,
        convolverReady: false,
      };

      /**
       * A capture or cabinet the document changed while the song played, waiting
       * for the next Stop. The insert keeps playing what it already has until
       * then, which is the whole point: no reload during playback.
       */
      let parkedCapture = false;
      let parkedCabinet = false;

      /** Whether this insert has ever resolved a capture / a cabinet at all. */
      let everAttached = false;
      let everAttachedCabinet = false;

      /** The cabinet, or null for one this insert does not have. */
      let convolver = null;
      /** The converters around the capture, or null when the rates are equal. */
      let inBridge = null;
      let outBridge = null;
      /**
       * A module a rebuild has kept alive for this insert while it fades out: it
       * keeps playing on the module its NAM instance lives on, so a rebuild never
       * cuts a leaving amp. Null for an insert on the current module.
       */
      let hostOverride = null;

      // The input selection the page's 1b arm says the track has. Only the amp
      // on the monitored track reads a one-channel selection; a stored clip is
      // always averaged. Fixed until the page changes the selection (a message,
      // never a block) — never re-decided per 128-frame piece from its peaks.
      const ownerTrack = owner && owner.track_id !== undefined && owner.track_id !== null ? asId(owner.track_id) : "";
      state.inputChannels =
        ownerTrack !== "" && processor.monitorTrackId === ownerTrack && processor.monitorChannels === 1 ? 1 : 2;

      /**
       * The scratch, made when a capture is attached: the dry pair at the
       * context's rate, the pair at the capture's rate, the NAM's mono block,
       * the cabinet's wet pair and the run's own output pair.
       */
      const scratch = {
        capacity: 0,
        ctxLeft: null,
        ctxRight: null,
        modelLeft: null,
        modelRight: null,
        mono: null,
        namOut: null,
        wetLeft: null,
        wetRight: null,
        outLeft: null,
        outRight: null,
      };

      /**
       * Size the scratch for one capture's rate. Called on the message path only.
       * @param {number} captureRate
       * @returns {void}
       */
      function prepareScratch(captureRate) {
        const ratio = captureRate > 0 ? Math.min(32, captureRate / contextRate) : 1;
        const capacity = Math.ceil(INSERT_BLOCK * Math.max(1, ratio)) + 8;
        if (scratch.capacity >= capacity) return;
        scratch.capacity = capacity;
        scratch.ctxLeft = new Float32Array(INSERT_BLOCK);
        scratch.ctxRight = new Float32Array(INSERT_BLOCK);
        scratch.modelLeft = new Float32Array(capacity);
        scratch.modelRight = new Float32Array(capacity);
        scratch.mono = new Float32Array(capacity);
        scratch.namOut = new Float32Array(capacity);
        scratch.wetLeft = new Float32Array(INSERT_BLOCK);
        scratch.wetRight = new Float32Array(INSERT_BLOCK);
        scratch.outLeft = new Float32Array(INSERT_BLOCK);
        scratch.outRight = new Float32Array(INSERT_BLOCK);
      }
      prepareScratch(contextRate);

      /**
       * Forget what is attached, so the next `attachCapture` loads again. Used when
       * the shared NAM module is rebuilt: the instance this insert held died with
       * the old module.
       * @returns {void}
       */
      function forgetCapture() {
        attached.modelId = null;
        attached.text = null;
        attached.problem = null;
        attached.ready = false;
      }

      /**
       * The shared NAM module has been rebuilt: this insert's instance died with
       * the old module, so it has no capture until `attachCapture` runs again at
       * the next Stop. The insert is SILENT meanwhile (never the dry signal).
       * @returns {void}
       */
      function forgetModule() {
        forgetCapture();
        state.attached = false;
        inBridge = null;
        outBridge = null;
        insert.latencyFrames = 0;
      }

      /**
       * Give this insert its capture: load it into its NAM instance, and build
       * the converters the capture's own rate needs. A capture this device does
       * not hold leaves the insert SILENT (never pass-through), and so does one
       * that will not load.
       *
       * Called on the message path (a parameter change, a library file arriving,
       * a chain being built). Nothing happens at all when the capture this insert
       * would load is the one it already holds — that is what keeps a snapshot off
       * the audio path — and a change that arrived while the song plays waits for
       * the next Stop.
       * @returns {void}
       */
      function attachCapture() {
        if (state.failed) return;
        if (parkedCapture) {
          if (processor.sequencer.isPlaying()) return;
          parkedCapture = false;
        }
        const host = processor.namHostFor();
        const id = state.modelId;
        const failed = id === "" ? undefined : processor.namFailed.get(id);
        const text = id === "" ? undefined : processor.namModels.get(id);
        const ready = host !== null && host.isReady();
        if (
          attached.modelId === id &&
          attached.text === text &&
          attached.problem === (failed === undefined ? null : failed) &&
          attached.ready === ready
        ) {
          // The very same capture, from the very same library bytes, with the
          // engine in the same state: this insert's instance is already playing
          // it, and touching it here is exactly the click this avoids.
          return;
        }
        // Parsing a capture is only allowed while the transport is stopped. A
        // runner built (or edited) DURING playback keeps no capture until Stop:
        // it plays silence meanwhile, and "Loads when you stop." is the page's
        // sentence for it. This is the one rule that keeps a chain edit from
        // calling `_nam_loadModel`, building bridge tables, or rebuilding a
        // cabinet's FFTs on the render thread.
        const wouldLoad = id !== "" && failed === undefined && text !== undefined && ready;
        if (wouldLoad && processor.sequencer.isPlaying()) {
          parkedCapture = true;
          state.attached = false;
          state.reason = "";
          inBridge = null;
          outBridge = null;
          insert.latencyFrames = 0;
          return;
        }
        attached.modelId = id;
        attached.text = text;
        attached.problem = failed === undefined ? null : failed;
        attached.ready = ready;
        everAttached = true;
        state.attached = false;
        state.reason = "";
        inBridge = null;
        outBridge = null;
        insert.latencyFrames = 0;
        if (id === "") {
          // Nothing chosen yet: an amp with no capture is a pass-through.
          if (host) host.unloadModel(key);
          return;
        }
        if (failed !== undefined) {
          state.reason = String(failed);
          if (host) host.unloadModel(key);
          return;
        }
        if (text === undefined) {
          // Not on this device (yet): silent, and `bindAmps` has asked for it.
          if (host) host.unloadModel(key);
          return;
        }
        if (!ready) {
          // No NAM engine in this engine at all, or its bytes have not landed
          // yet (a `nam-wasm` message rebinds every amp when they do).
          return;
        }
        try {
          const info = host.loadModel(key, text, id);
          state.captureLoads += 1;
          state.captureRate = info.expectedSampleRate > 0 ? info.expectedSampleRate : contextRate;
          state.attached = true;
          prepareScratch(state.captureRate);
          if (state.captureRate !== contextRate) {
            inBridge = StudioNamHost.createBridge({
              fromRate: contextRate,
              toRate: state.captureRate,
              maxIn: INSERT_BLOCK,
              maxOut: scratch.capacity,
            });
            // The two converters' delays are reported rounded up per converter.
            // Passing the rounding remainder to the out-converter makes the PAIR
            // delay by exactly the sum the insert reports, so a primed runner is
            // aligned to the frame rather than to within one.
            const inExact = inBridge.latencyFrames * (contextRate / state.captureRate);
            const inFrames = Math.ceil(inExact);
            outBridge = StudioNamHost.createBridge({
              fromRate: state.captureRate,
              toRate: contextRate,
              maxIn: scratch.capacity,
              maxOut: INSERT_BLOCK,
              extraDelayFrames: inFrames - inExact,
            });
            // Both converters really delay their audio (a symmetric kernel needs
            // look-ahead), and the runner system has to know by how much: the
            // in-converter's delay is counted at the capture's rate, the
            // out-converter's is in the context's frames already.
            insert.latencyFrames = inFrames + outBridge.latencyFrames;
          }
        } catch (error) {
          state.attached = false;
          const reason = error && error.message ? error.message : String(error);
          state.reason = reason;
          // A trap inside the wasm while the rebuild loads a capture belongs to
          // THIS insert, not to the capture: the other amps that play the same
          // file must not be marked failed with it. The module is poisoned and
          // rebuilt for them; this insert stays silent, said once.
          if (isNamTrap(error)) {
            if (host && typeof host.poison === "function") host.poison();
            stopPlaying("its capture could not be played");
            processor.scheduleNamRebuild();
            return;
          }
          processor.reportCaptureFailure(id, reason);
        }
      }

      /**
       * Give this insert its cabinet, if the song's library holds the IR it
       * names. No cabinet (or one this device does not have) is no cabinet: the
       * capture plays dry, exactly as the ruling says.
       *
       * Like the capture, an unchanged attachment is nothing at all (a snapshot
       * that only turned a fader must not rebuild an FFT), and a change that
       * arrived while the song plays waits for the next Stop.
       * @returns {void}
       */
      function attachCabinet() {
        if (parkedCabinet) {
          if (processor.sequencer.isPlaying()) return;
          parkedCabinet = false;
        }
        const id = state.irId;
        const pcm = id === "" ? undefined : processor.cabinets.get(id);
        const available = typeof StudioConvolver === "object" && StudioConvolver !== null;
        if (
          attached.irId === id &&
          attached.pcm === (pcm === undefined ? null : pcm) &&
          attached.convolverReady === available
        ) {
          return;
        }
        // A runner built during playback must not build an FFT on the render
        // thread either: a cabinet it has never had waits for Stop, exactly as a
        // capture does. A cabinet a LOAD changed on an amp that already had one
        // is still built on the message path (the page's own cabinet arrival).
        if (processor.sequencer.isPlaying() && !everAttachedCabinet && id !== "" && pcm !== undefined && available) {
          parkedCabinet = true;
          return;
        }
        attached.irId = id;
        attached.pcm = pcm === undefined ? null : pcm;
        attached.convolverReady = available;
        everAttachedCabinet = true;
        convolver = null;
        if (id === "" || pcm === undefined || !available) return;
        try {
          convolver = StudioConvolver.create({ channels: pcm.channels, rate: contextRate });
          state.cabinetLoads += 1;
        } catch (error) {
          convolver = null;
          processor.reportCaptureFailure(id, error && error.message ? error.message : String(error));
        }
      }

      /**
       * Stop this amp for good: SILENT (never the dry signal), said ONCE, and the
       * shared NAM module rebuilt on the message path for the other amps.
       *
       * Review Focus 1: a capture that cannot be played is silence. A trap inside
       * the wasm engine (or a sample that is not a number) leaves this insert with
       * nothing it can honestly play, so it plays nothing and says so — it never
       * falls back to the signal it was given.
       * @param {string} tail the rest of the sentence (`"its capture could not be
       *   played"`, or `"it produced an invalid sample"`)
       * @returns {void}
       */
      function stopPlaying(tail) {
        if (state.failed) return;
        state.failed = true;
        state.attached = false;
        state.reason = `${runner.label} on ${owner.chainLabel} stopped: ${tail}.`;
        const host = processor.namHost;
        if (host !== null) {
          try {
            host.unloadModel(key);
          } catch {
            /* the engine is going away: nothing is left to unload */
          }
        }
        if (state.reported) return;
        state.reported = true;
        processor.port.postMessage({
          type: "insert_fault",
          insert_id: runner.id,
          message: state.reason,
        });
      }

      /**
       * The mono signal an amp's capture is handed, in `out`.
       *
       * The scale is decided by the armed track's INPUT SELECTION (1b), fixed for
       * this insert's life — never by a piece's own peaks: a noisy or gated input
       * used to flip between unscaled and half every few milliseconds, which is a
       * 6 dB step on the render thread, and an input whose "silent" side was only
       * quiet never took the one-sided branch at all. One input channel feeds its
       * channel unscaled (the mono stream a browser hands over is the same signal
       * on both sides); a stereo pair — which is also what a stored clip is — is
       * the usual (L+R)/2. The default, when nothing has said otherwise, is the
       * stereo average.
       * @param {Float32Array} leftIn
       * @param {Float32Array} rightIn
       * @param {number} count
       * @param {Float32Array} out
       * @returns {void}
       */
      function monoSum(leftIn, rightIn, count, out) {
        if (state.inputChannels === 1) {
          for (let at = 0; at < count; at += 1) out[at] = leftIn[at];
          return;
        }
        for (let at = 0; at < count; at += 1) out[at] = (leftIn[at] + rightIn[at]) * 0.5;
      }

      /**
       * One piece of a run, at most `INSERT_BLOCK` frames: the whole amp path.
       *
       * The engine's own `_nam_process` is called inside ONE try per piece: a trap
       * in the wasm must not take the processor (and with it every track) down.
       * The catch allocates nothing.
       * @param {Float32Array} left
       * @param {Float32Array|null} right
       * @param {number} base where the piece starts in the caller's buffers
       * @param {number} count its frames
       * @param {boolean} stereo whether the caller has a right channel
       * @returns {void}
       */
      function runPiece(left, right, base, count, stereo) {
        const ctxLeft = scratch.ctxLeft;
        const ctxRight = scratch.ctxRight;
        const outLeft = scratch.outLeft;
        const outRight = scratch.outRight;
        const inputGain = state.inputGain;
        for (let at = 0; at < count; at += 1) {
          const inLeft = left[base + at];
          ctxLeft[at] = inLeft * inputGain;
          ctxRight[at] = (stereo ? right[base + at] : inLeft) * inputGain;
        }

        const host = hostOverride !== null ? hostOverride : processor.namHost;
        let played = false;
        if (host !== null && state.attached) {
          try {
            const mono = scratch.mono;
            const namOut = scratch.namOut;
            if (inBridge === null) {
              monoSum(ctxLeft, ctxRight, count, mono);
              played = host.process(key, mono, namOut, count);
              if (played) {
                for (let at = 0; at < count; at += 1) {
                  outLeft[at] = namOut[at];
                  outRight[at] = namOut[at];
                }
              }
            } else {
              const modelLeft = scratch.modelLeft;
              const modelRight = scratch.modelRight;
              const produced = inBridge.process(ctxLeft, ctxRight, count, modelLeft, modelRight, modelRight.length);
              if (produced > 0) {
                monoSum(modelLeft, modelRight, produced, mono);
                played = host.process(key, mono, namOut, produced);
              }
              let back = 0;
              if (produced > 0) {
                // Silence is fed on when the capture is not playing, so the
                // out-converter stays in step with the stream the in-converter is
                // making: an amp that comes back must not be a block out of step
                // with its own converters.
                if (!played) namOut.fill(0, 0, produced);
                back = outBridge.process(namOut, namOut, produced, outLeft, outRight, count);
              }
              if (back < count) {
                // The out-converter's own look-ahead: the frames it cannot make
                // yet are silence, which is that delay (see `latencyFrames`).
                outLeft.fill(0, back, count);
                outRight.fill(0, back, count);
              }
            }
          } catch (error) {
            // A trap inside the engine: THIS amp stops (silent, said once), the
            // shared module is marked poisoned (every other amp reads silence
            // without being marked failed) and is rebuilt for them on the message
            // path. Nothing is allocated here and nothing is thrown on to the
            // audio thread.
            if (typeof host.poison === "function") host.poison();
            stopPlaying("its capture could not be played");
            processor.scheduleNamRebuild();
            played = false;
          }
        }
        if (!played) {
          // A capture that is not playing is SILENCE, never the dry signal: the
          // insert's sound is the capture, and the operator has to hear that it
          // is not there (Review Focus 1).
          outLeft.fill(0, 0, count);
          outRight.fill(0, 0, count);
        }

        if (convolver !== null) {
          const wetLeft = scratch.wetLeft;
          const wetRight = scratch.wetRight;
          for (let at = 0; at < count; at += 1) {
            wetLeft[at] = outLeft[at];
            wetRight[at] = outRight[at];
          }
          convolver.process(wetLeft, wetRight, count);
          const wet = state.irMix;
          const dry = 1 - wet;
          for (let at = 0; at < count; at += 1) {
            outLeft[at] = outLeft[at] * dry + wetLeft[at] * wet;
            outRight[at] = outRight[at] * dry + wetRight[at] * wet;
          }
        }

        const outputGain = state.outputGain;
        for (let at = 0; at < count; at += 1) {
          left[base + at] = outLeft[at] * outputGain;
          if (stereo) right[base + at] = outRight[at] * outputGain;
        }
      }

      const insert = {
        kind: AMP_KIND,
        rate: contextRate,
        /**
         * The frames this insert delays its audio by. A capture at the context's
         * rate needs no conversion and delays nothing; a capture at another rate
         * does (the rate bridges' real look-ahead), and says so here so the runner
         * system primes for it and the monitor's delay includes it.
         */
        latencyFrames: 0,

        /**
         * Take the document's settings for this insert. The two file ids move
         * the capture and the cabinet; the three numbers are gains and a mix.
         *
         * A file the operator changed while the song PLAYS is parked until the
         * next Stop ("Loads when you stop."), the same rule a library load
         * follows: nothing is parsed or rebuilt under a playing runner.
         * @param {object} params `{model_id, ir_id, input_db, output_db, ir_mix}`
         * @returns {void}
         */
        setParams: function setParams(params) {
          const plain = params && typeof params === "object" ? params : {};
          state.inputGain = dbToGain(plain.input_db, AMP_INPUT_DB[0], AMP_INPUT_DB[1]);
          state.outputGain = dbToGain(plain.output_db, AMP_OUTPUT_DB[0], AMP_OUTPUT_DB[1]);
          const mix = Number(plain.ir_mix);
          state.irMix = Number.isFinite(mix) ? clamp(mix, AMP_IR_MIX[0], AMP_IR_MIX[1]) : AMP_IR_MIX[1];
          const modelId = asId(plain.model_id);
          if (modelId !== state.modelId) {
            state.modelId = modelId;
            if (!state.failed && attached.modelId === modelId) {
              // Back to the capture that is playing: nothing to park, and the
              // attachment below sorts out whether it really is the same one.
              parkedCapture = false;
              attachCapture();
            } else {
              // A new capture is a fresh start: an amp a trap or a bad sample
              // stopped is armed again by its own settings moving, exactly as a
              // faulted effect is (see `applyRunnerParams`).
              state.failed = false;
              state.reported = false;
              forgetCapture();
              parkedCapture = everAttached && processor.sequencer.isPlaying();
              if (!parkedCapture) attachCapture();
            }
          }
          const irId = asId(plain.ir_id);
          if (irId !== state.irId) {
            state.irId = irId;
            parkedCabinet = everAttachedCabinet && processor.sequencer.isPlaying();
            if (!parkedCabinet) attachCabinet();
          }
        },

        /**
         * Back to silence without losing the capture or the cabinet: the
         * cabinet's own state and the capture's converter are cleared, so an
         * insert that was bypassed does not come back mid-tail.
         * @returns {void}
         */
        reset: function reset() {
          if (convolver !== null) convolver.reset();
          if (inBridge !== null) inBridge.reset();
          if (outBridge !== null) outBridge.reset();
        },

        /**
         * Run the whole amp path over one run, in place.
         * @param {Float32Array} left
         * @param {Float32Array|null} right
         * @param {number} frames
         * @returns {void}
         */
        process: function process(left, right, frames) {
          const count = Math.max(0, Math.trunc(Number(frames) || 0));
          if (count === 0 || !left) return;
          const stereo = right !== null && right !== undefined;
          if (state.modelId === "") {
            // An amp with no capture chosen is a pass-through: there is nothing
            // silent about "no capture yet" (the editor's empty state).
            return;
          }
          if (state.failed || !state.attached) {
            left.fill(0, 0, count);
            if (stereo) right.fill(0, 0, count);
            return;
          }
          for (let at = 0; at < count; at += INSERT_BLOCK) {
            runPiece(left, right, at, Math.min(INSERT_BLOCK, count - at), stereo);
          }
        },

        /** @returns {string} the capture this insert names ("" for none). */
        captureId: function captureId() {
          return state.modelId;
        },

        /** @returns {string} the cabinet this insert names ("" for none). */
        cabinetId: function cabinetId() {
          return state.irId;
        },

        /** @returns {string} this insert OBJECT's key in the NAM host. */
        instanceKey: function instanceKey() {
          return key;
        },

        /**
         * Re-attach the capture (a library file arrived or went away) and the
         * cabinet, on the message path.
         * @returns {void}
         */
        attachCapture: attachCapture,
        attachCabinet: attachCabinet,

        /**
         * Forget which capture is attached, so the next rebind loads it again —
         * the shared NAM module was rebuilt and this insert's instance died with
         * the old one.
         * @returns {void}
         */
        forgetCapture: forgetCapture,

        /**
         * The shared module was rebuilt: this insert is silent (and needs no
         * capture loaded) until the next Stop re-attaches it.
         * @returns {void}
         */
        forgetModule: forgetModule,

        /**
         * Keep this insert playing on the module its instance is already on
         * while it fades out across a rebuild (no cut). The old module is
         * destroyed once no chain holds the insert any more.
         * @param {object|null} host
         * @returns {void}
         */
        holdHost: function holdHost(host) {
          hostOverride = host;
        },

        /**
         * The armed track's 1b input selection: 1 for a one-channel input, 2 for
         * a stereo pair. Set from the page's message path only, and fixed in
         * between — never read from the audio itself.
         * @param {number} channels
         * @returns {void}
         */
        setInputChannels: function setInputChannels(channels) {
          state.inputChannels = Number(channels) === 1 ? 1 : 2;
        },

        /**
         * Stop this amp for good (silence, one report): the NaN guard's route to
         * Review Focus 1. A capture that cannot be played is silence, never the
         * dry signal, so this does not `reset()` and does not bypass to dry.
         * @param {string} tail the rest of the sentence
         * @returns {void}
         */
        silence: function silence(tail) {
          stopPlaying(tail);
        },

        /** @returns {object} what this insert currently is, read-only for tests. */
        params: function params() {
          return {
            model_id: state.modelId,
            ir_id: state.irId,
            input_db: state.inputGain,
            output_db: state.outputGain,
            ir_mix: state.irMix,
            attached: state.attached,
            capture_rate: state.captureRate,
            reason: state.reason,
            cabinet: convolver !== null,
            converted: inBridge !== null,
            failed: state.failed,
            parked: parkedCapture || parkedCabinet,
            input_channels: state.inputChannels,
            latency_frames: insert.latencyFrames,
            capture_loads: state.captureLoads,
            cabinet_loads: state.cabinetLoads,
          };
        },
      };

      // The capture and the cabinet are attached from the parameters the chain
      // gives this insert right after it is built (`attachInsert`).
      void owner;
      return insert;
    }

    /**
     * Say once that an insert has no compiled effect at all — its kind is not one
     * Crow ships, or its Faust module arrived broken. It plays as a pass-through
     * from here on.
     * @param {object} runner
     * @param {object} owner
     * @param {string} reason
     * @returns {void}
     */
    reportBrokenInsert(runner, owner, reason) {
      if (this.brokenReported.has(runner.id)) return;
      this.brokenReported.add(runner.id);
      this.report(new Error(`${runner.label} on ${owner.chainLabel} could not be built: ${reason}`));
    }

    /**
     * Say once that an insert is waiting for its compiled module, as its own
     * message — not as an engine error: a song loaded a moment before the page's
     * Faust effects arrive is not a failure, it is a load in progress, and nothing
     * about it belongs in the log or on the console.
     * @param {string} id
     * @param {string} effect the effect's label
     * @param {string} label the chain it sits in
     * @returns {void}
     */
    reportLoadingInsert(id, effect, label) {
      const insertId = asId(id);
      if (this.loadingReported.has(insertId)) return;
      this.loadingReported.add(insertId);
      this.port.postMessage({
        type: "insert_loading",
        insert_id: insertId,
        message: `${effect} on ${label} is still loading.`,
      });
    }

    /**
     * Post the master chain's own latency, once per change: the delay its inserts
     * put on the master path — the limiter's 1.5 ms lookahead, and nothing else
     * (plan 1d: every track and return insert is zero-latency, apart from an amp
     * whose capture is converted, which says so in its own `latencyFrames`).
     *
     * It is the RUNNING delay, not where an edit is heading: a fade that moves the
     * limiter in or out crosses the number at its own midpoint, and a master
     * limiter the NaN guard has bypassed stops counting the moment it stops
     * delaying (see `runningLatencyOf`). It is read here, on the message path after
     * an edit, and again after every run of the master chain, so the number a tap
     * and a meter reading carry is the one the audio really has.
     *
     * The frame count is kept too: a master tap is stamped with the block's frame
     * moved back by it, so a resample taken from the tap lines up with the song
     * (see `postTap`).
     * @param {object[]} chain
     * @returns {void}
     */
    postMasterLatency(chain) {
      const frames = runningLatencyOf(chain);
      if (frames === this.masterLatencyFrames) return;
      this.masterLatencyFrames = frames;
      this.masterLatencyMs = (frames / sampleRate) * 1000;
      this.port.postMessage({ type: "master_latency", ms: this.masterLatencyMs });
      // A monitored track is heard THROUGH the master, so a master whose delay
      // just moved (a limiter arriving, or one the NaN guard bypassed) changes
      // what the page has to add to the round trip it measured. The message is
      // only sent when the number really changed, so this is not a per-block post.
      this.postMonitorLatency();
    }

    /**
     * Run one chain over a run of frames, in place.
     *
     * A runner that is not changing costs exactly its insert's `process()`; a
     * runner that is fading blends its insert's output against its own input by
     * its own weight. An edit that REPLACED a segment of the chain instead runs its
     * two paths side by side and blends their outputs (see `runBlend`) — never two
     * copies of one chain, which would each advance the state of every insert they
     * share.
     *
     * The buffers are the run's own (index 0 is the run's first frame), because
     * a Faust insert lays its wasm buffers out for a block that starts at zero.
     * @param {object} owner a chain holder
     * @param {Float32Array} left
     * @param {Float32Array} right
     * @param {number} frames
     * @returns {void}
     */
    runChain(owner, left, right, frames) {
      if (owner.chain === null) return;
      this.runChainList(owner.chain, left, right, frames, owner.chainLabel, 0);
      // The master's delay is read after every run of its chain, so the number a
      // tap and the meter carry really is the delay the audio was handed out
      // with: a fade crosses it at its midpoint, and a faulted limiter stops
      // counting at once.
      if (owner.kind === "master") this.postMasterLatency(owner.chain);
    }

    /**
     * One list of chain nodes over a run of frames, in place, with the NaN guard
     * at every insert's output. A node is a runner, or a blend of two paths (see
     * `buildChain`).
     * @param {object[]} chain
     * @param {Float32Array} left
     * @param {Float32Array} right
     * @param {number} frames
     * @param {string} label the chain this list is (for a fault's sentence)
     * @param {number} depth how many blends this list is nested inside
     * @returns {void}
     */
    runChainList(chain, left, right, frames, label, depth) {
      for (let index = 0; index < chain.length; index += 1) {
        const node = chain[index];
        if (!node) continue;
        if (node.blend) {
          this.runBlend(node, left, right, frames, label, depth);
          continue;
        }
        const runner = node;
        if (runner.wet === 0 && runner.wetTarget === 0) continue;
        if (runner.insert === null || runner.faulted) {
          // A pass-through — an insert still loading, one that can never be
          // built, a bypass, or one bypassed in the engine after a bad sample —
          // has no weight to blend: it lands on its target and costs nothing.
          runner.wet = runner.wetTarget;
          runner.prime = 0;
          continue;
        }
        if (frames <= INSERT_BLOCK) {
          this.runInsert(runner, left, right, frames, label);
          continue;
        }
        // A host with a quantum bigger than 128 makes a longer run: an insert is
        // handed it in 128-frame pieces, the block size it is laid out for —
        // through the scratch pair, so no view is allocated on the audio thread.
        const blockLeft = this.insertLeft;
        const blockRight = this.insertRight;
        for (let at = 0; at < frames; at += INSERT_BLOCK) {
          const count = Math.min(INSERT_BLOCK, frames - at);
          for (let frame = 0; frame < count; frame += 1) {
            blockLeft[frame] = left[at + frame];
            blockRight[frame] = right[at + frame];
          }
          this.runInsert(runner, blockLeft, blockRight, count, label);
          for (let frame = 0; frame < count; frame += 1) {
            left[at + frame] = blockLeft[frame];
            right[at + frame] = blockRight[frame];
          }
        }
      }
    }

    /**
     * One blend over a run of frames: both paths run the SAME input, and what
     * comes out is the leaving path's output fading out while the arriving path's
     * fades in.
     *
     * The arriving path is always run, even while the weight is still 0: that is
     * what primes it (a limiter's lookahead fills from the incoming signal), and
     * it is why the weight waits for the arriving path's own latency before it
     * starts moving. The two paths are level-added, never chained, so nothing the
     * old effect made is fed to the new one and two half-in inserts cannot add up
     * to more than the louder of them.
     *
     * A blend inside a blend uses the next preallocated pair, so nothing here
     * allocates; past `BLEND_DEPTH` (a chain rewritten again and again inside a
     * few milliseconds) the arriving path simply takes over, which is a step
     * where the ramp would have been.
     * @param {object} node a blend node
     * @param {Float32Array} left the segment's input, and where its output goes
     * @param {Float32Array} right
     * @param {number} frames
     * @param {string} label
     * @param {number} depth
     * @returns {void}
     */
    runBlend(node, left, right, frames, label, depth) {
      const blendLeft = this.blendLeft;
      const freshLeft = blendLeft === null ? undefined : blendLeft[depth];
      if (!freshLeft) {
        node.weight = node.target;
        node.prime = 0;
        this.runChainList(node.fresh, left, right, frames, label, depth);
        return;
      }
      const freshRight = this.blendRight[depth];
      for (let at = 0; at < frames; at += 1) {
        freshLeft[at] = left[at];
        freshRight[at] = right[at];
      }
      this.runChainList(node.leaving, left, right, frames, label, depth + 1);
      this.runChainList(node.fresh, freshLeft, freshRight, frames, label, depth + 1);

      const target = node.target;
      const step = node.fadeStep;
      let weight = node.weight;
      let hold = node.prime;
      for (let at = 0; at < frames; at += 1) {
        if (hold > 0) {
          hold -= 1;
        } else if (weight !== target) {
          weight = target === 1 ? weight + step : weight - step;
          if (target === 1 ? weight >= 1 : weight <= 0) weight = target;
          // The last step's rounding away is the target too: a weight that only
          // misses it by less than half a step is there, and a blend that never
          // quite arrives would never be folded away.
          else if (Math.abs(target - weight) < step * 0.5) weight = target;
        }
        const leaving = 1 - weight;
        left[at] = left[at] * leaving + freshLeft[at] * weight;
        right[at] = right[at] * leaving + freshRight[at] * weight;
      }
      node.weight = weight;
      node.prime = hold;
    }

    /**
     * One insert over one block, in place: the block's input is kept, the insert
     * runs, and a block that comes back with a sample that is not a finite number
     * is replaced by that input, the insert is bypassed in the engine and the
     * fault is reported once.
     *
     * A runner whose weight is not 1 is crossfading: the copy taken for the guard
     * is its input, so the insert's output is blended back against it one frame at
     * a time while the weight walks towards its target. The steps are counted per
     * FRAME, never per run, so a run a motion curve cut short moves the fade
     * exactly as far as its frames were worth and a fade can never restart.
     *
     * When the insert delays its audio (the master limiter, and nothing else),
     * the two sides of that blend are NOT the same moment of the song: the dry
     * side is the signal as it arrived and the wet side is that signal
     * `latencyFrames` later, so the mix combs for the length of the fade. Delaying
     * the dry side would put a jump at the fade's start or end instead, which is
     * worse than a short comb; the file header says so too.
     * @param {object} runner
     * @param {Float32Array} left
     * @param {Float32Array} right
     * @param {number} frames
     * @param {string} label
     * @returns {void}
     */
    runInsert(runner, left, right, frames, label) {
      const guardLeft = this.guardLeft;
      const guardRight = this.guardRight;
      for (let at = 0; at < frames; at += 1) {
        guardLeft[at] = left[at];
        guardRight[at] = right[at];
      }
      runner.insert.process(left, right, frames);
      if (hasInvalidSample(left, right, frames)) {
        if (runner.kind === AMP_KIND && typeof runner.insert.silence === "function") {
          // Review Focus 1: a capture that cannot be played is SILENCE. An amp
          // insert is not an effect that can be bypassed to the dry signal — the
          // dry signal is not what an amp is — so a block of it that is not a
          // number stops the amp instead, and every later block is silence.
          runner.insert.silence("it produced an invalid sample");
          for (let at = 0; at < frames; at += 1) {
            left[at] = 0;
            right[at] = 0;
          }
          runner.wet = runner.wetTarget;
          runner.prime = 0;
          return;
        }
        for (let at = 0; at < frames; at += 1) {
          left[at] = guardLeft[at];
          right[at] = guardRight[at];
        }
        runner.wet = runner.wetTarget;
        runner.prime = 0;
        runner.faulted = true;
        const message = `${runner.label} on ${label} produced an invalid sample; it is bypassed.`;
        // The document is never touched: the insert stays in the song, bypassed in
        // the ENGINE, and only its OWN parameters moving arms it again.
        this.port.postMessage({ type: "insert_fault", insert_id: runner.id, message: message });
        return;
      }
      if (runner.prime === 0 && runner.wet === runner.wetTarget) return;
      const target = runner.wetTarget;
      const step = runner.fadeStep;
      let wet = runner.wet;
      let hold = runner.prime;
      for (let at = 0; at < frames; at += 1) {
        if (hold > 0) {
          // Its own latency runs off first: a limiter fills its lookahead from the
          // incoming signal before any of its output is mixed in.
          hold -= 1;
        } else if (wet !== target) {
          wet = target === 1 ? wet + step : wet - step;
          // A weight that arrives, or only misses its target by less than half a
          // step's rounding away, IS at it: a fade that stopped at 1e-16 would
          // never let its runner go (see `compactChain`).
          if (target === 1 ? wet >= 1 : wet <= 0) wet = target;
          else if (Math.abs(target - wet) < step * 0.5) wet = target;
        }
        const dry = 1 - wet;
        left[at] = left[at] * wet + guardLeft[at] * dry;
        right[at] = right[at] * wet + guardRight[at] * dry;
      }
      runner.prime = hold;
      runner.wet = wet;
    }

    /**
     * Size the mixer's scratch for a block, once per block size. The tap's own
     * buffers are sized the same way, in `prepareTap`.
     * @param {number} count the frames this block holds
     * @returns {void}
     */
    ensureScratch(count) {
      if (this.scratchFrames >= count) return;
      const size = Math.max(count, INITIAL_QUANTUM);
      this.scratchFrames = size;
      this.mixLeft = new Float32Array(size);
      this.mixRight = new Float32Array(size);
      this.guardLeft = new Float32Array(size);
      this.guardRight = new Float32Array(size);
      this.insertLeft = new Float32Array(INSERT_BLOCK);
      this.insertRight = new Float32Array(INSERT_BLOCK);
      this.rightPad = new Float32Array(size);
      // One pair per nesting level a blend may hold (`runBlend`): an edit that
      // lands while a blend is still fading builds one blend around another, and
      // every level needs its own copy of the segment's input for its arriving
      // path. Made here, once per block size, so the audio thread never allocates.
      this.blendLeft = [];
      this.blendRight = [];
      for (let level = 0; level < BLEND_DEPTH; level += 1) {
        this.blendLeft.push(new Float32Array(size));
        this.blendRight.push(new Float32Array(size));
      }
      // A return's own pair is sized when the mixer is built (`applyMixer`, on the
      // message path); a host that asks for a bigger block grows them here, once.
      for (let index = 0; index < this.returns.length; index += 1) {
        const record = this.returns[index];
        if (record.mixLeft !== null && record.mixLeft.length >= size) continue;
        record.mixLeft = new Float32Array(size);
        record.mixRight = new Float32Array(size);
      }
    }

    /**
     * Post one meter reading, or none when this engine has no meter.
     * @returns {void}
     */
    postMeter() {
      if (this.meter === null) return;
      const reading = this.meter.read();
      this.port.postMessage({
        type: "meter",
        momentary: reading.momentary,
        short_term: reading.short_term,
        integrated: reading.integrated,
        true_peak_db: reading.true_peak_db,
        latency_ms: this.masterLatencyMs,
      });
    }

    /**
     * Count a block towards the next meter reading: one every 100 ms of audio
     * while the playhead runs, and one more when it stops (so the master strip's
     * last number is the one the song ended on).
     * @param {number} frames the frames this block held
     * @returns {void}
     */
    meterBlock(frames) {
      if (this.meter === null) return;
      const playing = this.sequencer.isPlaying();
      if (playing) {
        this.sinceMeter += frames;
        if (this.sinceMeter >= this.meterEvery) {
          // The hop is SUBTRACTED, not zeroed: a block that straddles the 100 ms
          // line keeps its remainder, so readings land on the same frames whatever
          // block size the host asks for.
          this.sinceMeter -= this.meterEvery;
          this.postMeter();
        }
      } else if (this.meterWasPlaying) {
        this.postMeter();
      }
      this.meterWasPlaying = playing;
    }

    /**
     * The controller index of one module, by name.
     *
     * A module's names are read once per build and cached on the record.
     * @param {object} record
     * @param {string} name the controller's name as SunVox spells it
     * @param {number} fallback the index to assume when the name is missing
     * @returns {number} the controller index, or the fallback
     */
    ctlIndex(record, name, fallback) {
      if (!record.engine || record.module < 0) return fallback;
      let names = record.ctlNames;
      if (!names) {
        names = new Map();
        const count = record.engine.ctlCount(SLOT, record.module);
        for (let at = 0; at < count; at += 1) {
          const ctlName = record.engine.ctlName(SLOT, record.module, at);
          if (typeof ctlName !== "string" || ctlName === "") continue;
          if (!names.has(ctlName)) names.set(ctlName, at);
          const lower = ctlName.toLowerCase();
          if (!names.has(lower)) names.set(lower, at);
        }
        record.ctlNames = names;
      }
      const direct = names.get(name);
      if (direct !== undefined) return direct;
      const lower = names.get(name.toLowerCase());
      return lower === undefined ? fallback : lower;
    }

    /**
     * One block of audio. A throw here must never reach the host, so the work
     * is guarded: the first fault is reported once, the engine is marked failed
     * and every later block is silence, while `process()` keeps returning true.
     * @param {Float32Array[][]} inputs `inputs[0]` is the monitored signal when
     *   the page has connected one (`{type:"monitor"}`); it is summed into the
     *   monitored track's source and never written to
     * @param {Float32Array[][]} outputs `outputs[0]` holds the stereo pair
     * @returns {boolean} true, so the host keeps calling
     */
    process(inputs, outputs) {
      const output = outputs && outputs[0];
      const count = output && output.length > 0 ? output[0].length : 0;
      if (!output || count === 0) return true;

      // The context's clock is sampled here, at the top of the block, while
      // `this.frame` still is this block's first frame.
      this.contextOffset();

      const left = output[0];
      const right = output.length > 1 ? output[1] : null;
      // The node's own input is the monitored signal (see "Monitoring through
      // the chain"): the page connects the armed track's live input to it. It is
      // read here, once, and summed into that track's source by `renderTrack`.
      // Nothing else in the engine reads it, and a host with no input connected
      // hands over an empty array (or none at all).
      const input = inputs && inputs[0] && inputs[0].length > 0 ? inputs[0] : null;
      this.monitorLeft = input && input[0] && input[0].length >= count ? input[0] : null;
      this.monitorRight = this.monitorLeft === null ? null : input[1] && input[1].length >= count ? input[1] : this.monitorLeft;
      // The block's first frame, taken before `block()` advances the counter.
      const firstFrame = this.frame;
      try {
        this.prepareTap(count);
        // The mixer's scratch (the run's own copy of a track, the guard's copy of
        // an insert's input, the 128-frame pair a long run is handed through) and
        // each return's pair, sized once per block size. A return's buffers are
        // made when the mixer is built, so nothing here allocates one.
        this.ensureScratch(count);
        this.block(left, right, count);
        this.postTap(left, right, count, firstFrame);
      } catch (error) {
        this.fail(error);
        left.fill(0);
        if (right) right.fill(0);
      }
      return true;
    }

    /**
     * Zero the tapped track's scratch buffers at the start of a block, so what
     * `render()` accumulates is that block's own output and nothing else.
     * @param {number} count the frames this block holds
     * @returns {void}
     */
    prepareTap(count) {
      if (this.tapTrackId === null) {
        this.tapIndex = -1;
        return;
      }
      const index = this.trackSlots.get(this.tapTrackId);
      this.tapIndex = index === undefined ? -1 : index;
      if (this.tapIndex < 0) return;
      if (!this.tapLeft || this.tapLeft.length < count) {
        this.tapLeft = new Float32Array(count);
        this.tapRight = new Float32Array(count);
      }
      this.tapLeft.fill(0, 0, count);
      this.tapRight.fill(0, 0, count);
    }

    /**
     * Post a tap's copy of this block: the master (already mixed and clipped)
     * or the tapped track's own output. Nothing is posted while no tap is on.
     *
     * Every block names the CONTEXT frame its first sample sits on, so the
     * caller can cut what it keeps on the frame itself instead of counting.
     *
     * A MASTER tap is moved back by the master chain's own latency: the samples a
     * master tap carries at context frame F are the ones the master chain took in
     * at F − its lookahead, so an untrimmed tap is stamped with `F − latency` and
     * a resample of the master lines up with one of a track (which no insert
     * delays). The track tap is stamped where it is: nothing on a track's path
     * delays it.
     * @param {Float32Array} left the master's left channel
     * @param {Float32Array|null} right the master's right channel
     * @param {number} count the frames this block holds
     * @param {number} firstFrame this block's first frame, in the processor's own frames
     * @returns {void}
     */
    postTap(left, right, count, firstFrame) {
      // The block's first frame in the CONTEXT's clock, the same one `launched`
      // and `nextBarFrame` report in.
      const frame = this.contextOffset() + firstFrame;
      if (this.tapMaster) {
        const channels = right ? [left.slice(0, count), right.slice(0, count)] : [left.slice(0, count)];
        this.port.postMessage({
          type: "tap_block",
          target: "master",
          frame: frame - this.masterLatencyFrames,
          channels: channels,
        });
      }
      if (this.tapIndex >= 0 && this.tapLeft) {
        this.port.postMessage({
          type: "tap_block",
          target: this.tapTrackId,
          frame: frame,
          channels: [this.tapLeft.slice(0, count), this.tapRight.slice(0, count)],
        });
      }
    }

    /**
     * The block body: the sequencer's events, applied on their own frames.
     * @param {Float32Array} left
     * @param {Float32Array|null} right
     * @param {number} count the frames this block holds
     * @returns {void}
     */
    block(left, right, count) {
      if (this.failNextBlock) {
        this.failNextBlock = false;
        throw new Error("test hook: the processor was asked to fail inside process()");
      }

      // The host may reuse the buffers, so start from silence; the mix sums
      // into them from here.
      left.fill(0);
      if (right) right.fill(0);

      // The performance bus's transport is read BEFORE the sequencer moves its
      // own clock to the end of the block.
      this.updateTransport();

      // The sequencer must see every block, ready or not: its events are
      // measured from contiguous frame starts. A motion curve is stamped with
      // this block's number, so one that no descriptor refreshed is not read.
      this.motionSerial += 1;
      const events = this.sequencer.block(this.frame, count);
      this.reportLaunches(events.launches);
      const motions = events.motions;

      if (!this.ready || this.failure) {
        this.frame += count;
        return;
      }

      let cursor = 0;
      let next = 0;
      let nextMotion = 0;
      // Motion is read on a fixed absolute grid, so the runs are cut on it: a
      // run never crosses a sub-step boundary, which is what holds a swept voice
      // to the same value for the same frame at any block size. A block with no
      // curve at all (the usual case) skips the cutting and renders as it always
      // did.
      const onGrid = motions.length > 0;
      while (cursor < count) {
        while (next < events.length && events[next].frame <= cursor) {
          this.applyEvent(events[next]);
          next += 1;
        }
        // A curve stands from its own frame on: it is applied at that frame,
        // before the run that starts there is rendered.
        while (nextMotion < motions.length && motions[nextMotion].frame <= cursor) {
          this.setMotion(motions[nextMotion]);
          nextMotion += 1;
        }
        let boundary = next < events.length ? Math.min(count, events[next].frame) : count;
        if (nextMotion < motions.length) boundary = Math.min(boundary, motions[nextMotion].frame);
        if (onGrid) {
          // A DISTANCE to the next sub-step, added to the cursor before it is
          // compared with the block-relative event frames.
          const untilSubStep = MOTION_SUB_STEP - ((this.frame + cursor) % MOTION_SUB_STEP);
          const gridBoundary = cursor + untilSubStep;
          if (gridBoundary < boundary) boundary = gridBoundary;
        }
        const frames = boundary > cursor ? boundary - cursor : count - cursor;
        this.render(frames, left, right, cursor);
        cursor += frames;
      }

      this.frame += count;
      // A font that failed while rendering was dropped by its host mid-run; it is
      // reported once here, after the block, and its tracks stay silent.
      this.reportFontFailures();
      this.reportPosition(count, events.patterns);
      // One meter reading every 100 ms of audio while the playhead runs, and one
      // more when it stops.
      this.meterBlock(count);
    }

    /**
     * Work out the transport the performance bus reads for this block: its first
     * frame, whether the playhead runs, the song's tempo, and the two bar lines
     * around the playhead.
     *
     * Both come from the sequencer's own `barLines()` — the one place the
     * bar-boundary rounding lives — so the looper quantizes to the very line the
     * sequencer plays on, even after a tempo change moved the grid (it is never
     * `barFrame + barFrames` at the current tempo, which a dropped tempo would put
     * a whole bar — or, at a fractional bar, a frame — away from it). A stopped
     * transport has no grid at all, which is why both are null there: the looper's
     * commands then take effect at once instead of waiting for a bar that never
     * comes. The read fills a reused object: nothing is allocated per block.
     * @returns {void}
     */
    updateTransport() {
      const transport = this.transport;
      transport.frame = this.frame;
      transport.offset = 0;
      transport.playing = this.sequencer.isPlaying();
      transport.bpm = this.bpm;
      transport.beatsPerBar = BEATS_PER_BAR;
      const lines = this.sequencer.barLines(this.barLineScratch);
      transport.barFrame = lines.barFrame;
      transport.nextBarFrame = lines.nextBarFrame;
    }

    /**
     * Render `frames` of the song through the mixer, in the order the plan's
     * Task 9 fixes (one final signal path):
     *
     *     track: source → inserts → fader/pan → sends (pre or post fader)
     *     return: inserts → fader
     *     tracks + returns → master sum → looper → performance bus
     *       → master gain → master inserts → clip → output
     *
     * An audio track contributes its PCM voices here instead of a SunVox engine,
     * and a soundfont track its own MIDI channel's dry pair, through the very
     * same inserts, fader and sends. The final hard clip at ±1.0 is 1a's whole
     * output stage, and it comes after the master chain.
     * @param {number} frames
     * @param {Float32Array} left
     * @param {Float32Array|null} right
     * @param {number} offset
     * @returns {void}
     */
    render(frames, left, right, offset) {
      // The font hosts render every font this song's tracks read once for this
      // run, whichever tracks read it (a font played by eight tracks is still
      // parsed and rendered once); a loaded font no track reads is not rendered
      // at all. Each soundfont track then adds its own channel below.
      if (this.fonts !== null) this.fonts.process(frames);

      // A host that hands this processor one channel still runs a stereo mixer:
      // the right side goes to a scratch that is thrown away, at the same cost as
      // the tap's own copy, and nothing it holds is ever heard. Only this run's
      // frames are cleared — the rest of the scratch is this block's earlier runs.
      const outRight = right === null ? this.rightPad : right;
      if (right === null) this.rightPad.fill(0, offset, offset + frames);

      // Every return starts a run empty: the tracks' sends fill it.
      for (let index = 0; index < this.returns.length; index += 1) {
        const record = this.returns[index];
        record.mixLeft.fill(0, 0, frames);
        record.mixRight.fill(0, 0, frames);
      }

      const slots = this.slots;
      for (let index = 0; index < slots.length; index += 1) {
        const record = slots[index];
        if (!record) continue;
        this.renderTrack(record, frames, left, outRight, offset);
      }
      for (let index = 0; index < this.returns.length; index += 1) {
        this.renderReturn(this.returns[index], frames, left, outRight, offset);
      }

      // The master bus, in the order the signal path fixes: the looper first (it
      // taps the mix BEFORE any effect and mixes its own take back in), then the
      // performance-effects chain. Both return at once when nothing is held and
      // the looper is empty, so an idle bus costs one call per run. They read the
      // same pair the master chain is about to process — a host with one channel
      // included, so a stereo effect always sees two.
      this.transport.offset = offset;
      this.perf.loop(left, outRight, frames, this.transport);
      this.perf.process(left, outRight, frames, this.transport);

      // Then the master gain and the master's own inserts (the limiter last, by
      // convention), then the meter, then the clip.
      this.applyMaster(left, outRight, frames, offset);

      for (let at = 0; at < frames; at += 1) {
        const position = offset + at;
        const sample = left[position];
        left[position] = sample > 1 ? 1 : sample < -1 ? -1 : sample;
        if (right) {
          const other = right[position];
          right[position] = other > 1 ? 1 : other < -1 ? -1 : other;
        }
      }
    }

    /**
     * One track through the mixer for a run: its source at unity gain into the
     * scratch, its chain, its sends (pre and post fader), then its fader and pan
     * into the master — and its own tap, when it is the tapped track, which is
     * its output after the inserts and the fader.
     *
     * The source is summed into the scratch before the chain because nothing may
     * reach the master without going through its inserts, and a track's fader is
     * a gain on the CHAIN's output, not a gain on its source.
     * @param {object} record
     * @param {number} frames
     * @param {Float32Array} left
     * @param {Float32Array} right
     * @param {number} offset
     * @returns {void}
     */
    renderTrack(record, frames, left, right, offset) {
      const mixLeft = this.mixLeft;
      const mixRight = this.mixRight;
      mixLeft.fill(0, 0, frames);
      mixRight.fill(0, 0, frames);
      // The chain runs on the scratch from its first frame on (a Faust insert's
      // buffers start at zero), so the run's absolute frame is handed over
      // separately: motion is read at the sub-step that frame stands in.
      this.renderRecord(record, frames, mixLeft, mixRight, 0, this.frame + offset);
      // Monitoring through the chain: the node's input is this track's own source
      // for as long as the operator has monitoring on, so it goes through the
      // track's inserts (amps included), its fader and the master exactly as the
      // take will once it is recorded — and the take itself is still recorded
      // dry, because the recorder taps the input outside this engine.
      if (
        this.monitorLeft !== null &&
        this.monitorTrackId !== null &&
        record.track_id === this.monitorTrackId
      ) {
        const monitorLeft = this.monitorLeft;
        const monitorRight = this.monitorRight === null ? this.monitorLeft : this.monitorRight;
        for (let at = 0; at < frames; at += 1) {
          const position = offset + at;
          mixLeft[at] += monitorLeft[position];
          mixRight[at] += monitorRight[position];
        }
      }
      this.runChain(record, mixLeft, mixRight, frames);

      const gainLeft = record.left;
      const gainRight = record.right;
      const preSends = record.preSends;
      const postSends = record.postSends;
      const tapped = record.index === this.tapIndex && this.tapLeft !== null;
      const tappedLeft = this.tapLeft;
      const tappedRight = this.tapRight;

      if (!(gainLeft === 0 && gainRight === 0)) {
        for (let at = 0; at < frames; at += 1) {
          const position = offset + at;
          const outLeft = mixLeft[at] * gainLeft;
          const outRight = mixRight[at] * gainRight;
          left[position] += outLeft;
          right[position] += outRight;
          if (tapped) {
            tappedLeft[position] = outLeft;
            tappedRight[position] = outRight;
          }
        }
        // A PRE send taps the chain's output, before the fader and the pan; a
        // POST send taps the fader's own output. Both are already gated by the
        // track's mute and solo (see `applyMixer`), so a muted track sends
        // nothing either way and the loops below are skipped for it.
        for (let index = 0; index < preSends.length; index += 1) {
          const send = preSends[index];
          const targetLeft = send.target.mixLeft;
          const targetRight = send.target.mixRight;
          const gain = send.gain;
          for (let at = 0; at < frames; at += 1) {
            targetLeft[at] += mixLeft[at] * gain;
            targetRight[at] += mixRight[at] * gain;
          }
        }
        for (let index = 0; index < postSends.length; index += 1) {
          const send = postSends[index];
          const targetLeft = send.target.mixLeft;
          const targetRight = send.target.mixRight;
          const gain = send.gain;
          for (let at = 0; at < frames; at += 1) {
            targetLeft[at] += mixLeft[at] * gainLeft * gain;
            targetRight[at] += mixRight[at] * gainRight * gain;
          }
        }
        return;
      }

      // A muted track (or one another track's solo silences) adds nothing to the
      // master and its sends are silent too — but its engine, voices and synth
      // were rendered above, so it comes back where it should be.
      if (tapped) {
        for (let at = 0; at < frames; at += 1) {
          const position = offset + at;
          tappedLeft[position] = mixLeft[at] * gainLeft;
          tappedRight[position] = mixRight[at] * gainRight;
        }
      }
    }

    /**
     * One return through the mixer for a run: its inserts on what the sends gave
     * it, then its fader and pan into the master. Returns are never muted by a
     * solo (they are not tracks).
     * @param {object} record
     * @param {number} frames
     * @param {Float32Array} left
     * @param {Float32Array} right
     * @param {number} offset
     * @returns {void}
     */
    renderReturn(record, frames, left, right, offset) {
      this.runChain(record, record.mixLeft, record.mixRight, frames);
      const gainLeft = record.left;
      const gainRight = record.right;
      if (gainLeft === 0 && gainRight === 0) return;
      const mixLeft = record.mixLeft;
      const mixRight = record.mixRight;
      for (let at = 0; at < frames; at += 1) {
        const position = offset + at;
        left[position] += mixLeft[at] * gainLeft;
        right[position] += mixRight[at] * gainRight;
      }
    }

    /**
     * The master, last of all: its gain, its own inserts (the limiter last, by
     * convention), then the meter — and back into the output, where the clip
     * stage takes over.
     *
     * The master path is delayed by the master chain's total latency and nothing
     * else: a zero-latency chain changes nothing, and the limiter's lookahead
     * moves the master by exactly its own delay, which the meter reading and the
     * `master_latency` message both report.
     * @param {Float32Array} left
     * @param {Float32Array} right
     * @param {number} frames
     * @param {number} offset
     * @returns {void}
     */
    applyMaster(left, right, frames, offset) {
      const masterLeft = this.mixLeft;
      const masterRight = this.mixRight;
      const gain = this.masterGain;
      if (gain === 1) {
        for (let at = 0; at < frames; at += 1) {
          masterLeft[at] = left[offset + at];
          masterRight[at] = right[offset + at];
        }
      } else {
        for (let at = 0; at < frames; at += 1) {
          masterLeft[at] = left[offset + at] * gain;
          masterRight[at] = right[offset + at] * gain;
        }
      }
      this.runChain(this.masterRecord, masterLeft, masterRight, frames);
      // The meter reads the master AFTER its inserts (and before the clip, which
      // is the output stage, not a part of the mix), and only while the playhead
      // runs: a stopped transport has no reading to take, so the master strip's
      // last number is the one the song ended on.
      if (this.meter !== null && this.transport.playing) this.meter.process(masterLeft, masterRight, frames);
      for (let at = 0; at < frames; at += 1) {
        left[offset + at] = masterLeft[at];
        right[offset + at] = masterRight[at];
      }
    }

    /**
     * Render one track's own source into a run of frames at UNITY gain: whatever
     * its device is. The track's fader and pan are applied after its chain, on
     * the chain's output (see `renderTrack`), so nothing here shapes the level.
     * @param {object} record
     * @param {number} frames
     * @param {Float32Array} left
     * @param {Float32Array|null} right
     * @param {number} offset where the run starts in the destination
     * @param {number} [baseFrame] the run's first frame in the processor's own
     *   clock, when it is not `this.frame + offset` (a track renders its source
     *   into a scratch that starts at zero)
     * @returns {void}
     */
    renderRecord(record, frames, left, right, offset, baseFrame) {
      if (record.audio) {
        this.renderAudio(record, frames, left, right, offset);
        return;
      }
      if (record.sampler) {
        this.renderSampler(record, frames, left, right, offset, baseFrame);
        return;
      }
      if (record.font) {
        this.renderFont(record, frames, left, right, offset);
        return;
      }
      if (!record.engine || record.module < 0) return;
      // Every engine is rendered every sub-block, muted or not: its voices
      // have to advance with the song, or a track would come back mid-note.
      const interleaved = record.engine.render(this.bufferFor(record, frames), frames, 0, record.clock);
      record.clock += frames;
      for (let at = 0; at < frames; at += 1) {
        left[offset + at] += interleaved[at * 2];
        if (right) right[offset + at] += interleaved[at * 2 + 1];
      }
    }

    /**
     * Mix one soundfont track's own output over a run of frames at unity: its
     * channel's dry stereo pair from the font host. The track's inserts, fader
     * and pan are applied after this (`renderTrack`), exactly as they are for an
     * engine's or a sampler's output.
     *
     * The synth has already rendered by the time this runs (`render` calls
     * `StudioFontVoice.process` once per run), so a muted track still advances its
     * voices — it comes back where it should be.
     * @param {object} record
     * @param {number} frames
     * @param {Float32Array} left
     * @param {Float32Array|null} right
     * @param {number} offset
     * @returns {void}
     */
    renderFont(record, frames, left, right, offset) {
      if (this.fonts === null) return;
      const channels = this.fonts.outputFor(record.track_id);
      if (!channels) return;
      const sourceLeft = channels.left;
      const sourceRight = channels.right;
      const count = Math.min(frames, sourceLeft.length);
      for (let at = 0; at < count; at += 1) {
        left[offset + at] += sourceLeft[at];
        if (right) right[offset + at] += sourceRight[at];
      }
    }

    /**
     * Mix one sampler track's voices over a run of frames, at unity: the track's
     * own gain, pan and inserts are applied after its chain (see `renderTrack`).
     * Every voice is rendered even when the track is silent, so a muted track's
     * pads come back at the right point in their sound instead of mid-note.
     * @param {object} record
     * @param {number} frames
     * @param {Float32Array} left
     * @param {Float32Array|null} right
     * @param {number} offset
     * @param {number} [baseFrame] the run's first frame in the processor's clock
     * @returns {void}
     */
    renderSampler(record, frames, left, right, offset, baseFrame) {
      const state = this.motionStateFor(record.track_id);
      this.renderVoiceList(record.voices, frames, left, right, offset, 1, 1, state, baseFrame);
      // A stolen voice rings out in a fade tail for 64 frames after its slot was
      // taken (see `retireVoice`), through the very same mix. A tail is on its
      // way out, so no curve is read for it and no swept value of it is
      // restored: it keeps the values it was stolen with through its fade.
      if (record.tails && record.tails.length > 0) {
        this.renderVoiceList(record.tails, frames, left, right, offset, 1, 1, null, baseFrame);
      }
    }

    /**
     * Mix one list of sampler voices over a run of frames, with the track's own
     * gain and pan.
     *
     * The run never crosses a motion sub-step boundary (see `block()`), so every
     * lane of the track's curve is read ONCE here, at the sub-step's own first
     * frame, and the values are written into the voices of each lane's pad. Per
     * array element the order of the additions is the same with or without a
     * curve, so motion changes the sound and never the mix.
     * @param {object[]} voices
     * @param {number} frames
     * @param {Float32Array} left
     * @param {Float32Array|null} right
     * @param {number} offset
     * @param {number} gainLeft
     * @param {number} gainRight
     * @param {object|null} state the track's motion record, or null
     * @param {number} [baseFrame] the run's first frame in the processor's clock
     * @returns {void}
     */
    renderVoiceList(voices, frames, left, right, offset, gainLeft, gainRight, state, baseFrame) {
      // The sub-step this run stands in, in absolute frames: a run that starts
      // mid-sub-step (an event landed inside one) reads that sub-step's value, not
      // its own frame's, so two hosts that cut the run differently still agree.
      const base = typeof baseFrame === "number" ? baseFrame : this.frame + offset;
      const subStep = base - (base % MOTION_SUB_STEP);
      const values = state !== null ? this.motionValuesAt(state, subStep) : null;
      for (let at = 0; at < voices.length; at += 1) {
        const voice = voices[at];
        if (!voice.sounding) continue;
        if (values !== null && this.voiceSweeps(state, voice)) {
          this.applyPadMotion(voice, state, values);
          voice.swept = true;
        } else if (voice.swept === true) {
          // The curve stopped applying (a chain turn, a Stop, a cleared lane, a
          // segment that ended): the voice goes back to its own pad's value.
          this.restorePadMotion(voice);
        }
        StudioSamplerVoice.render(voice, frames, gainLeft === 0 ? null : left, gainRight === 0 ? null : right, offset, gainLeft, gainRight);
      }
    }

    /**
     * The value of every lane of one motion record at one sub-step, into the
     * processor's own reused array.
     *
     * Each lane is read through its own cursor (`advanceMotionCursor`), which
     * only walks forward and starts again when the step position jumps backwards
     * — a loop wrap — or when `setMotion` hands over a new curve or a moved
     * clock (a seek, a slot boundary). A 4096-point lane therefore costs a few
     * comparisons per sub-step instead of a scan of the whole list.
     * @param {object} state a motion record
     * @param {number} frame the absolute frame of the sub-step's first sample
     * @returns {number[]} one value per lane, in `state.lanes` order
     */
    motionValuesAt(state, frame) {
      const lanes = state.lanes;
      const values = this.motionValues;
      const cursors = state.cursors;
      const lastFracs = state.last_fracs;
      const framesPerBeat = state.frames_per_beat;
      const stepBeats = state.step_beats;
      const beat = framesPerBeat > 0 ? (frame - state.origin_frame) / framesPerBeat : 0;
      const stepFrac = stepBeats > 0 ? (beat - state.slot_start_beat) / stepBeats : 0;
      for (let at = 0; at < lanes.length; at += 1) {
        const lane = lanes[at];
        const points = lane.points;
        let cursor = cursors[at];
        // A position that went backwards is a loop wrap (or a seek): the cursor
        // means nothing there any more.
        if (!(stepFrac >= lastFracs[at])) cursor = 0;
        cursor = advanceMotionCursor(points, stepFrac, cursor);
        cursors[at] = cursor;
        lastFracs[at] = stepFrac;
        values[at] = motionValueAt(points, stepFrac, state.length_steps, cursor);
      }
      return values;
    }

    /**
     * Take one motion descriptor from the sequencer: which pattern of which
     * track is playing, its curve, and the clock its step positions are measured
     * on. A descriptor with no curve silences the track's motion, which is how a
     * chain turning onto a plain pattern, or a segment that stops, ends a sweep
     * at its own boundary.
     * @param {{frame?: number, track_id: string, pattern_id: string,
     *          lanes: object[]|null, origin_frame: number,
     *          frames_per_beat: number, slot_start_beat: number,
     *          step_beats: number, length_steps: number}} event
     * @returns {void}
     */
    setMotion(event) {
      const trackId = asId(event.track_id);
      let state = this.motion.get(trackId);
      if (!state) {
        state = {
          track_id: trackId,
          serial: 0,
          pattern_id: "",
          lanes: null,
          origin_frame: 0,
          frames_per_beat: 0,
          slot_start_beat: 0,
          step_beats: 0,
          length_steps: 0,
          /** One walk position per lane (`advanceMotionCursor`). */
          cursors: [],
          /** The step position each lane was last read at, for the wrap test. */
          last_fracs: [],
        };
        this.motion.set(trackId, state);
      }
      state.serial = this.motionSerial;
      const lanes = Array.isArray(event.lanes) && event.lanes.length > 0 ? event.lanes : null;
      const originFrame = Number(event.origin_frame) || 0;
      const framesPerBeat = Number(event.frames_per_beat) || 0;
      const slotStartBeat = Number(event.slot_start_beat) || 0;
      const stepBeats = Number(event.step_beats) || 0;
      const lengthSteps = Number(event.length_steps) || 0;
      if (
        lanes !== state.lanes ||
        originFrame !== state.origin_frame ||
        framesPerBeat !== state.frames_per_beat ||
        slotStartBeat !== state.slot_start_beat ||
        stepBeats !== state.step_beats ||
        lengthSteps !== state.length_steps
      ) {
        // A different curve, or the same curve on a clock that moved (a seek, a
        // chain slot turning over): every lane cursor starts again.
        state.cursors.length = 0;
        state.last_fracs.length = 0;
      }
      state.pattern_id = asId(event.pattern_id);
      state.lanes = lanes;
      state.origin_frame = originFrame;
      state.frames_per_beat = framesPerBeat;
      state.slot_start_beat = slotStartBeat;
      state.step_beats = stepBeats;
      state.length_steps = lengthSteps;
    }

    /**
     * @param {string} trackId
     * @returns {object|null} the motion record standing for this block, or null
     *   when the track's pattern sweeps nothing right now
     */
    motionStateFor(trackId) {
      const state = this.motion.get(trackId);
      if (!state || state.serial !== this.motionSerial || state.lanes === null || state.lanes.length === 0) {
        return null;
      }
      return state;
    }

    /**
     * Whether any lane of the record sweeps this voice's pad: a voice whose every
     * lane's field its own step locked is NOT swept at all, and keeps the
     * whole-run fast path.
     * @param {object} state a motion record
     * @param {object} voice a sampler voice
     * @returns {boolean}
     */
    voiceSweeps(state, voice) {
      const lanes = state.lanes;
      const locked = voice.locked;
      for (let at = 0; at < lanes.length; at += 1) {
        const lane = lanes[at];
        if (lane.pad !== voice.pad_key) continue;
        if (locked !== null && locked.indexOf(lane.param) !== -1) continue;
        return true;
      }
      return false;
    }

    /**
     * Write one sub-step's worth of motion into a voice. A lane whose field the
     * voice's step locked is left alone: a step's lock beats motion, and motion
     * beats the pad's own field (which is the value the voice started with, kept
     * as its `base_*` values for `restorePadMotion`).
     *
     * The fields this voice was holding from an earlier sub-step that NO current
     * lane covers any more are given back in the same pass (`restoreMotionParam`):
     * a lane cleared while another lane of the very same pad keeps moving leaves
     * that one field on its pad's own value, not a stale swept one.
     *
     * The cutoff and the resonance are collected and applied together, so a pad
     * whose filter moves on two lanes is re-tuned ONCE for this sub-step: two
     * `setFilter` calls would work out two sets of coefficients for one value of
     * each.
     * @param {object} voice a sounding sampler voice
     * @param {object} state the track's motion record
     * @param {number[]} values the record's lane values for this sub-step
     * @returns {void}
     */
    applyPadMotion(voice, state, values) {
      const lanes = state.lanes;
      const locked = voice.locked;
      let mask = 0;
      let cutoff = NaN;
      let resonance = NaN;
      for (let at = 0; at < lanes.length; at += 1) {
        const lane = lanes[at];
        if (lane.pad !== voice.pad_key) continue;
        if (locked !== null && locked.indexOf(lane.param) !== -1) continue;
        const bit = MOTION_PARAM_BITS[lane.param];
        if (!bit) continue;
        mask |= bit;
        if (lane.param === "cutoff_hz") {
          cutoff = values[at];
          continue;
        }
        if (lane.param === "resonance") {
          resonance = values[at];
          continue;
        }
        this.applyMotionValue(voice, lane.param, values[at]);
      }
      // Every field the previous sub-step swept that no lane covers now (a lane
      // cleared, another pattern's curve, a lock that took it over) goes back to
      // the pad's own value — or the step's lock, which is the base value.
      const lost = voice.motion_mask & ~mask;
      if (lost !== 0) {
        for (let at = 0; at < MOTION_PARAM_NAMES.length; at += 1) {
          if ((lost & MOTION_PARAM_BITS[MOTION_PARAM_NAMES[at]]) === 0) continue;
          this.restoreMotionParam(voice, MOTION_PARAM_NAMES[at]);
        }
      }
      voice.motion_mask = mask;
      if (Number.isFinite(cutoff)) voice.motion_cutoff = clamp(cutoff, MOTION_RANGES.cutoff_hz[0], MOTION_RANGES.cutoff_hz[1]);
      if (Number.isFinite(resonance)) {
        voice.motion_resonance = clamp(resonance, MOTION_RANGES.resonance[0], MOTION_RANGES.resonance[1]);
      }
      this.retuneVoiceIfChanged(voice);
    }

    /**
     * Give a voice back the values its pad (through its step's locks) gave it,
     * the moment its curve stops applying: a voice is never left holding a swept
     * value after a chain turns onto a pattern without that lane, the transport
     * stops, its lanes are cleared or a segment ends.
     *
     * An envelope stage the voice is still in keeps its own slope for the values
     * that came back, and a pad whose own sustain is 0 cannot hold: a voice that
     * is in its sustain stage then releases instead of sounding silently for
     * ever.
     * @param {object} voice a sounding sampler voice
     * @returns {void}
     */
    restorePadMotion(voice) {
      voice.swept = false;
      voice.motion_mask = 0;
      for (let at = 0; at < MOTION_PARAM_NAMES.length; at += 1) {
        this.restoreMotionParam(voice, MOTION_PARAM_NAMES[at]);
      }
      this.retuneVoiceIfChanged(voice);
    }

    /**
     * Put ONE swept field of a voice back where its pad (through its step's
     * locks) had it, the counterpart of `applyMotionValue` for a single field.
     *
     * `restorePadMotion` is this over every field; `applyPadMotion` uses it for
     * the fields a lane no longer covers, so clearing one lane of a pad leaves
     * the lanes beside it exactly where they are.
     * @param {object} voice a sounding sampler voice
     * @param {string} param one of `MOTION_RANGES`'s names
     * @returns {void}
     */
    restoreMotionParam(voice, param) {
      switch (param) {
        case "pitch":
          voice.step = voice.base_step;
          return;
        case "gain_db":
          voice.gain = voice.base_gain;
          return;
        case "pan":
          voice.panLeft = voice.base_pan_left;
          voice.panRight = voice.base_pan_right;
          return;
        case "attack_ms":
          voice.attackFrames = voice.base_attack_frames;
          if (voice.stage === STAGE_ATTACK) {
            voice.increment = voice.attackFrames > 0 ? 1 / voice.attackFrames : 0;
          }
          return;
        case "decay_ms":
          voice.decayFrames = voice.base_decay_frames;
          if (voice.stage === STAGE_DECAY) {
            voice.increment = voice.decayFrames > 0 ? (1 - voice.sustain) / voice.decayFrames : 0;
          }
          return;
        case "sustain":
          voice.sustain = voice.base_sustain;
          if (voice.stage === STAGE_SUSTAIN) {
            if (voice.sustain > 0) voice.level = voice.sustain;
            else StudioSamplerVoice.release(voice);
          } else if (voice.stage === STAGE_DECAY) {
            voice.increment = voice.decayFrames > 0 ? (1 - voice.sustain) / voice.decayFrames : 0;
          }
          return;
        case "release_ms":
          voice.releaseFrames = voice.base_release_frames;
          return;
        case "cutoff_hz":
          voice.motion_cutoff = voice.base_cutoff;
          return;
        case "resonance":
          voice.motion_resonance = voice.base_resonance;
          return;
        default:
          return;
      }
    }

    /**
     * Re-tune the voice's biquad to its swept cutoff and resonance — at most once
     * for one pair of values.
     *
     * A sub-step fixes both lane values before any voice is rendered, so this is
     * one `setFilter` per sub-step even when the cutoff and the resonance both
     * move; a second run inside the same sub-step (a block boundary cut it in
     * two) finds nothing to do, and a curve that stops applying restores the
     * pad's own filter with one more.
     * @param {object} voice
     * @returns {void}
     */
    retuneVoiceIfChanged(voice) {
      if (voice.motion_cutoff === voice.tuned_cutoff && voice.motion_resonance === voice.tuned_resonance) return;
      voice.tuned_cutoff = voice.motion_cutoff;
      voice.tuned_resonance = voice.motion_resonance;
      this.retuneVoice(voice);
    }

    /**
     * Put one swept value where the voice reads it. The cutoff and resonance are
     * not here: `applyPadMotion` applies those together, through one `setFilter`.
     *
     * An envelope time lands on the stage the voice is in, and `release_ms` on
     * the release still to come. A swept sustain recomputes a decay that is
     * running (its whole slope depends on where it is going), and a swept sustain
     * of 0 in the sustain stage releases the voice: a voice that cannot hold must
     * not sound silently for ever.
     * @param {object} voice
     * @param {string} param one of `MOTION_RANGES`'s names
     * @param {number} value the value at this sub-step
     * @returns {void}
     */
    applyMotionValue(voice, param, value) {
      const range = MOTION_RANGES[param];
      if (!range) return;
      const held = clamp(value, range[0], range[1]);
      switch (param) {
        case "pitch":
          voice.step = voice.reverse_sign * Math.pow(2, held / 12);
          return;
        case "gain_db":
          voice.gain = StudioSamplerVoice.dbToLinear(held) * voice.velocity_gain;
          return;
        case "pan": {
          const pan = StudioSamplerVoice.panCoefficients(held);
          voice.panLeft = pan.left;
          voice.panRight = pan.right;
          return;
        }
        case "sustain":
          voice.sustain = held;
          if (voice.stage === STAGE_SUSTAIN) {
            // A sustain of 0 has nothing to hold at: the voice releases from
            // wherever it stands (a release of 0 frames ends it at once).
            if (!(held > 0)) StudioSamplerVoice.release(voice);
            else voice.level = held;
            return;
          }
          if (voice.stage === STAGE_DECAY && voice.decayFrames > 0) {
            voice.increment = (1 - voice.sustain) / voice.decayFrames;
          }
          return;
        case "attack_ms":
          voice.attackFrames = StudioSamplerVoice.msToFrames(held, sampleRate);
          if (voice.stage === STAGE_ATTACK) voice.increment = voice.attackFrames > 0 ? 1 / voice.attackFrames : 0;
          return;
        case "decay_ms":
          voice.decayFrames = StudioSamplerVoice.msToFrames(held, sampleRate);
          if (voice.stage === STAGE_DECAY) {
            voice.increment = voice.decayFrames > 0 ? (1 - voice.sustain) / voice.decayFrames : 0;
          }
          return;
        case "release_ms":
          voice.releaseFrames = StudioSamplerVoice.msToFrames(held, sampleRate);
          return;
        default:
          return;
      }
    }

    /**
     * Re-tune one voice's filter to its swept cutoff and resonance, keeping the
     * filter's four state values on each channel: the coefficients are the very
     * ones `sampler-voice.js` computes for the pad's own filter, so a swept
     * filter sounds like a filter and a sweep never clicks.
     * @param {object} voice
     * @returns {void}
     */
    retuneVoice(voice) {
      const x1a = voice.x1a;
      const x2a = voice.x2a;
      const y1a = voice.y1a;
      const y2a = voice.y2a;
      const x1b = voice.x1b;
      const x2b = voice.x2b;
      const y1b = voice.y1b;
      const y2b = voice.y2b;
      StudioSamplerVoice.setFilter(
        voice,
        voice.motion_filter_type,
        voice.motion_cutoff,
        voice.motion_resonance,
        sampleRate,
      );
      voice.x1a = x1a;
      voice.x2a = x2a;
      voice.y1a = y1a;
      voice.y2a = y2a;
      voice.x1b = x1b;
      voice.x2b = x2b;
      voice.y1b = y1b;
      voice.y2b = y2b;
    }

    /**
     * Mix one audio track's voices over a run of frames: each sounding voice
     * reads its take at its own position (which may still be negative, a short
     * silence before the take begins), scaled by its fade envelope. The track's
     * inserts, gain and pan are applied after this (`renderTrack`), exactly as
     * they are for an engine's output.
     * @param {object} record
     * @param {number} frames
     * @param {Float32Array} left
     * @param {Float32Array|null} right
     * @param {number} offset
     * @returns {void}
     */
    renderAudio(record, frames, left, right, offset) {
      const voices = record.voices;
      for (let at = 0; at < voices.length; at += 1) {
        const voice = voices[at];
        if (!voice.sounding) continue;
        const channels = voice.channels;
        const length = channels && channels[0] ? channels[0].length : 0;
        const mono = !channels || channels.length < 2;
        for (let frame = 0; frame < frames; frame += 1) {
          const gain = voice.gain * fadeGainOf(voice);
          const position = voice.position;
          voice.position = position + 1;
          if (position >= 0 && position < length) {
            const sample = channels[0][position];
            left[offset + frame] += sample * gain;
            if (right) right[offset + frame] += (mono ? sample : channels[1][position]) * gain;
          }
          advanceFade(voice);
          advanceVoiceFade(voice);
        }
        if (!voice.sounding || voice.position >= length) {
          voice.sounding = false;
          voice.channels = null;
        }
      }
    }

    /**
     * The wasm buffer one track renders into, allocated at the smallest block
     * size and grown only if a host asks for a bigger one.
     * @param {object} record
     * @param {number} frames
     * @returns {number} the wasm pointer
     */
    bufferFor(record, frames) {
      if (record.outPtr && record.frames >= frames) return record.outPtr;
      const size = Math.max(frames, INITIAL_QUANTUM);
      if (record.outPtr) record.engine.free(record.outPtr);
      record.outPtr = record.engine.alloc(size * 2 * 4);
      record.frames = size;
      if (!record.outPtr) throw new Error("could not grow the engine's block buffer");
      return record.outPtr;
    }

    /**
     * Report every font that failed while rendering this block (a bank that threw
     * out of the synth), and re-bind the tracks so the ones whose font is still
     * there keep playing.
     * @returns {void}
     */
    reportFontFailures() {
      if (this.fonts === null) return;
      const failures = this.fonts.takeFailures();
      if (failures.length === 0) return;
      for (const failure of failures) this.reportFontFailure(failure.id, failure.reason);
      this.bindFonts();
    }

    /**
     * Apply one sequencer event at the cursor: an audio start or stop goes to
     * its track's voices, a note on or off to its track's engine or font.
     * @param {{frame: number, type: string}} event
     * @returns {void}
     */
    applyEvent(event) {
      if (event.type === "audio") this.startVoice(event);
      else if (event.type === "audio_stop") this.stopVoice(event);
      else if (event.type === "fade") this.startFade(event);
      else if (event.type === "pad") this.startPad(event, false);
      else this.sendNote(event);
    }

    /**
     * @param {string} trackId
     * @returns {object|null} the sampler record one track's slot holds
     */
    samplerRecord(trackId) {
      const index = this.trackSlots.get(trackId);
      if (index === undefined) return null;
      const record = this.slots[index];
      return record && record.sampler ? record : null;
    }

    /**
     * Start one pad's voice: a pattern step (`live` false) or a live press.
     *
     * The pad comes from the song's `pads` container and its sample from the
     * sample store; a step's `locks` then override the pad's own fields for this
     * one voice. A pad with no sample is silence and is not a fault; a pad whose
     * sample the client has not loaded is silence and is reported once.
     *
     * A step gives a `gate` pad its `gate_frames` to release at. A live press has
     * no step, so it holds until `liveRelease` for a `gate` pad and plays to the
     * end of its range for a `oneshot` one. A live press carries no locks of its
     * own, so a motion lane over its pad sweeps it exactly like a step's voice
     * (see "Motion" in the file header).
     *
     * Every one of the pad's own fields can be locked for this one voice, and
     * they all go through the same `field()` lookup: `attack_ms`, `decay_ms`,
     * `sustain`, `release_ms`, `pitch`, `gain_db`, `pan`, `reverse`,
     * `cutoff_hz`, `resonance`, and the filter's kind under `filter_type` (the
     * document spells the pad's own one `filter.type`).
     * @param {{track_id: string, bank_id: string, index: number, v: number,
     *          locks?: object, gate_frames?: number}} event
     * @param {boolean} live whether this is a live press rather than a step
     * @returns {void}
     */
    startPad(event, live) {
      const record = this.samplerRecord(event.track_id);
      if (!record) return;
      const bankId = asId(event.bank_id);
      const index = Math.trunc(Number(event.index) || 0);
      const pad = this.pads.get(padKey(event.track_id, bankId, index));
      if (!pad) return;

      const sampleId = asId(pad.sample_id);
      if (sampleId === "") return;
      const stored = this.samples.get(sampleId);
      if (!stored || stored.frames === 0) {
        this.reportMissingSample(sampleId);
        return;
      }

      const locks = event.locks && typeof event.locks === "object" ? event.locks : null;
      const field = (name, fallback) => (locks && locks[name] !== undefined ? locks[name] : fallback);

      const range = this.padRange(pad, stored);
      // An empty range plays nothing, so it must not take (and so steal) a
      // voice: the check is made here, before a slot is chosen, so a start that
      // cannot succeed leaves every sounding voice alone.
      if (!(range.end > range.start)) return;

      stored.lastUsed = this.sampleClock += 1;
      const mode = typeof pad.mode === "string" ? pad.mode : "oneshot";
      const gateFrames = mode === "gate" && !live ? Number(event.gate_frames) : NaN;
      const filter = pad.filter && typeof pad.filter === "object" ? pad.filter : {};
      const filterType = field("filter_type", filter.type);

      const voice = this.takeVoice(record);
      const started = StudioSamplerVoice.start(voice, {
        channels: stored.channels,
        frames: stored.frames,
        start: range.start,
        end: range.end,
        reverse: field("reverse", pad.reverse === true) === true,
        pitch: field("pitch", pad.pitch),
        gainDb: field("gain_db", pad.gain_db),
        velocity: event.v,
        pan: field("pan", pad.pan),
        attackMs: field("attack_ms", pad.attack_ms),
        decayMs: field("decay_ms", pad.decay_ms),
        sustain: field("sustain", pad.sustain),
        releaseMs: field("release_ms", pad.release_ms),
        filterType: typeof filterType === "string" ? filterType : "off",
        cutoffHz: field("cutoff_hz", filter.cutoff_hz),
        resonance: field("resonance", filter.resonance),
        gateFrames: Number.isFinite(gateFrames) ? gateFrames : -1,
        choke: pad.choke,
        mode: mode,
        trackId: asId(event.track_id),
        bankId: bankId,
        index: index,
        serial: (this.voiceSerial += 1),
        sampleRate: sampleRate,
      });
      if (!started) return;

      // What a motion lane needs of this voice: the pad it came from, the lock
      // names its step carried (a lock beats motion), and the values a lane
      // overrides — the velocity gain, the reverse direction, and the filter the
      // voice was built with. The `base_*` values are the ones a curve that stops
      // applying puts back (`restorePadMotion`), so they are captured here, after
      // the voice has worked them out for itself, never re-derived later.
      // The cutoff and the resonance are kept RAW, exactly as `setFilter` took
      // them from the pad: it is the one place that clamps them, so a restore
      // lands on the very coefficients the start did.
      const velocity = Number(event.v);
      const velocityHeld = Number.isFinite(velocity) ? clamp(velocity, 1, 127) : 127;
      const cutoff = Number(field("cutoff_hz", filter.cutoff_hz));
      const resonance = Number(field("resonance", filter.resonance));
      voice.pad_key = bankId + "." + index;
      voice.locked = locks ? Object.keys(locks) : null;
      voice.velocity_gain = (velocityHeld / 127) * (velocityHeld / 127);
      voice.reverse_sign = field("reverse", pad.reverse === true) === true ? -1 : 1;
      voice.motion_filter_type = typeof filterType === "string" ? filterType : "off";
      voice.motion_cutoff = Number.isFinite(cutoff) ? cutoff : 20000;
      voice.motion_resonance = Number.isFinite(resonance) ? resonance : 0;
      voice.base_step = voice.step;
      voice.base_gain = voice.gain;
      voice.base_pan_left = voice.panLeft;
      voice.base_pan_right = voice.panRight;
      voice.base_attack_frames = voice.attackFrames;
      voice.base_decay_frames = voice.decayFrames;
      voice.base_release_frames = voice.releaseFrames;
      voice.base_sustain = voice.sustain;
      voice.base_cutoff = voice.motion_cutoff;
      voice.base_resonance = voice.motion_resonance;
      voice.swept = false;
      // Which fields a lane has put on this voice (`MOTION_PARAM_BITS`): the ones
      // the next sub-step has to give back if no lane covers them any more.
      voice.motion_mask = 0;
      // The biquad was built from these very values by `start`, so they are what
      // it is tuned to: a curve has to move one before a retune is due.
      voice.tuned_cutoff = voice.motion_cutoff;
      voice.tuned_resonance = voice.motion_resonance;

      // A new voice in choke group n cuts every other voice of that group on
      // this track, over the crossfade length.
      const choke = Math.trunc(Number(pad.choke) || 0);
      if (choke > 0) {
        for (const other of record.voices) {
          if (other === voice) continue;
          if (!other.sounding || other.choke !== choke) continue;
          StudioSamplerVoice.beginFadeOut(other);
        }
      }

      this.stealSongWide(voice);
    }

    /**
     * The frames a pad plays inside one loaded sample: its slice when it names
     * one, the whole sample otherwise. A slice's frames are in the sample's own
     * rate (the document's), while the PCM here is at the context's rate, so
     * they are scaled by the ratio of the two.
     * @param {object} pad
     * @param {{frames: number}} stored
     * @returns {{start: number, end: number}}
     */
    padRange(pad, stored) {
      const sampleId = asId(pad.sample_id);
      const sliceId = asId(pad.slice_id);
      if (sliceId === "") return { start: 0, end: stored.frames };
      const slice = this.slices.get(sliceKey(sampleId, sliceId));
      if (!slice) return { start: 0, end: stored.frames };

      const docRate = this.sampleRates.get(sampleId) || sampleRate;
      const scale = sampleRate / docRate;
      const start = Math.max(0, Math.min(stored.frames, Math.trunc(Math.round(Number(slice.start_frame) * scale))));
      const end = Math.max(start, Math.min(stored.frames, Math.trunc(Math.round(Number(slice.end_frame) * scale))));
      return { start: start, end: end };
    }

    /**
     * Pick the voice a new trigger uses: a free one, else this track's oldest —
     * a voice that is already fading out (choked or releasing) goes first.
     *
     * The caller starts the new voice, and has already checked that its range
     * holds frames, so a steal never costs a sounding voice to a start that
     * could not happen.
     * @param {object} record
     * @returns {object} the voice record to overwrite
     */
    takeVoice(record) {
      const voices = record.voices;
      let oldest = voices[0];
      for (const voice of voices) {
        if (!voice.sounding) return voice;
        if (this.stealRank(voice) < this.stealRank(oldest)) oldest = voice;
      }
      this.retireVoice(record, oldest);
      return oldest;
    }

    /**
     * Move a stolen voice into a fade tail so it rings out over 64 frames
     * instead of clicking off, or cut it when both tails already ring.
     *
     * The choice, documented: the 16 slots belong to the 16 sounding voices and
     * the new voice needs this one on its very frame, so a stolen voice cannot
     * keep its slot. It keeps sounding in a fade tail when one is free (the
     * 64-frame ring-out) and is cut when both are in use.
     * @param {object} record
     * @param {object} voice the slot the new voice is about to take
     * @returns {void}
     */
    retireVoice(record, voice) {
      if (!voice.sounding) return;
      const tail = this.tailFor(record);
      if (!tail) return;
      Object.assign(tail, voice);
      // It holds its last sample and fades out: there is nothing left to read.
      tail.ending = true;
      tail.gateRemaining = -1;
      tail.fadeRemaining = StudioSamplerVoice.FADE_FRAMES;
      tail.sounding = true;
      // The tail is on its way out, so no curve is read for it (see
      // `renderSampler`): it keeps the very values it had at the moment it was
      // stolen, instead of jumping back to its pad's own during the 64-frame
      // fade. Nothing restores a tail, so there is no swept field left to track.
      tail.swept = false;
      tail.motion_mask = 0;
    }

    /**
     * @param {object} record
     * @returns {object|null} a tail voice that is free, or a new one while the
     *   track holds fewer than `STOLEN_TAILS_PER_TRACK`; null when none is
     */
    tailFor(record) {
      const tails = record.tails;
      if (!tails) return null;
      for (const tail of tails) if (!tail.sounding) return tail;
      if (tails.length >= STOLEN_TAILS_PER_TRACK) return null;
      const tail = StudioSamplerVoice.create();
      tails.push(tail);
      return tail;
    }

    /**
     * How good a steal candidate a voice is: the lower the value, the sooner it
     * goes. A voice already fading out is never heard again in any case, so it
     * goes before a held one; within a class the oldest goes first.
     * @param {object} voice
     * @returns {number}
     */
    stealRank(voice) {
      const fading = voice.fadeRemaining > 0 || voice.stage === StudioSamplerVoice.STAGE_RELEASE;
      return (fading ? 0 : 1) * 1000000000 + voice.serial;
    }

    /**
     * Keep the whole song inside its 64-voice cap: while too many voices sound,
     * the song's best steal candidate goes — across tracks, choked and releasing
     * ones first, then the oldest anywhere. A cross-track steal cuts rather than
     * fading: the cap is the song's DSP budget, so the frame that trips it plays
     * exactly the surviving voices and nothing else.
     * @param {object} newest the voice this trigger just started (never stolen)
     * @returns {void}
     */
    stealSongWide(newest) {
      let sounding = 0;
      for (const record of this.slots) {
        if (!record || !record.sampler) continue;
        for (const voice of record.voices) if (voice.sounding) sounding += 1;
      }
      while (sounding > SAMPLER_VOICES_SONG_WIDE) {
        let victim = null;
        for (const record of this.slots) {
          if (!record || !record.sampler) continue;
          for (const voice of record.voices) {
            if (!voice.sounding || voice === newest) continue;
            if (!victim || this.stealRank(voice) < this.stealRank(victim)) victim = voice;
          }
        }
        if (!victim) return;
        victim.sounding = false;
        victim.channels = null;
        sounding -= 1;
      }
    }

    /**
     * A live pad message: a press starts the pad's voice (never through
     * history, never quantized), a release lets the `gate` voices that pad
     * started go. A `oneshot` pad keeps playing to the end of its range: letting
     * go of the key does not cut a one-shot sound short.
     * @param {{track_id: string, bank_id: string, index: number, v: number, on: boolean}} event
     * @returns {void}
     */
    live(event) {
      if (event.on !== false) {
        this.startPad(event, true);
        return;
      }
      const record = this.samplerRecord(asId(event.track_id));
      if (!record) return;
      const bankId = asId(event.bank_id);
      const index = Math.trunc(Number(event.index) || 0);
      for (const voice of record.voices) {
        if (!voice.sounding) continue;
        if (voice.mode !== "gate") continue;
        if (voice.bankId !== bankId || voice.index !== index) continue;
        StudioSamplerVoice.release(voice);
      }
    }

    /**
     * Start a take on one of an audio track's voices. When the other voice is
     * still sounding the two crossfade (see the file header); a take that has
     * not been loaded plays silence and is reported once.
     * @param {{track_id: string, take_id: string, take_frame: number, voice: number}} event
     * @returns {void}
     */
    startVoice(event) {
      const record = this.audioRecord(event.track_id);
      if (!record) return;
      const index = event.voice === 1 ? 1 : 0;
      const voice = record.voices[index];
      if (!voice) return;

      const channels = this.takes.get(asId(event.take_id));
      if (!channels || channels.length === 0 || !channels[0] || channels[0].length === 0) {
        this.reportMissingTake(event.take_id);
        return;
      }

      const frame = Number(event.take_frame);
      voice.channels = channels;
      voice.position = Number.isFinite(frame) ? Math.trunc(frame) : 0;
      voice.sounding = true;
      // A start begins a clean envelope: a fade belongs to the voice its own
      // placement started.
      voice.fade = null;

      const other = record.voices[index === 0 ? 1 : 0];
      if (other && other.sounding && other.gain > 0) {
        voice.gain = 0;
        beginFade(voice, 1);
        beginFadeOut(other);
      } else {
        voice.gain = 1;
        voice.fadeRemaining = 0;
        voice.fadeTarget = 1;
      }
    }

    /**
     * Send one audio voice out over the crossfade length.
     * @param {{track_id: string, voice: number}} event
     * @returns {void}
     */
    stopVoice(event) {
      const record = this.audioRecord(event.track_id);
      if (!record) return;
      const voice = record.voices[event.voice === 1 ? 1 : 0];
      if (!voice) return;
      beginFadeOut(voice);
    }

    /**
     * Start a placement's linear gain ramp on one voice.
     *
     * The ramp is counted in frames from this very frame, so it is the same
     * whatever block size the host asks for. A voice that is not sounding has
     * nothing to ramp — the event is ignored, which is right: a fade that runs
     * over silence leaves the voice at its end value by the time it is heard.
     * @param {{track_id: string, voice: number, from: number, to: number, frames: number}} event
     * @returns {void}
     */
    startFade(event) {
      const record = this.audioRecord(event.track_id);
      if (!record) return;
      const voice = record.voices[event.voice === 1 ? 1 : 0];
      if (!voice || !voice.sounding) return;
      const frames = Math.round(Number(event.frames));
      const from = Number(event.from);
      const to = Number(event.to);
      if (!Number.isFinite(frames) || frames <= 0) return;
      if (!Number.isFinite(from) || !Number.isFinite(to)) return;
      voice.fade = { from: from, to: to, frames: frames, index: 0 };
    }

    /**
     * @param {string} trackId
     * @returns {object|null} the audio record one track's slot holds
     */
    audioRecord(trackId) {
      const index = this.trackSlots.get(trackId);
      if (index === undefined) return null;
      const record = this.slots[index];
      return record && record.audio ? record : null;
    }

    /**
     * Report a take the song plays but the client has not loaded yet, once per
     * take id: a voice with no PCM is silence, and a clip that loops would
     * otherwise say so on every pass.
     * @param {string} takeId
     * @returns {void}
     */
    reportMissingTake(takeId) {
      const id = asId(takeId);
      if (this.missingTakes.has(id)) return;
      this.missingTakes.add(id);
      this.report(new Error(`Take ${id} is not loaded yet.`));
    }

    /**
     * Send one sequencer event to its track's device: a note of a SunVox engine,
     * or of a soundfont track's channel.
     * @param {{track_id: string, type: string, p: number, v: number}} event
     * @returns {void}
     */
    sendNote(event) {
      const index = this.trackSlots.get(event.track_id);
      if (index === undefined) return;
      const record = this.slots[index];
      if (!record) return;
      if (record.font) {
        // A soundfont track's note goes to its own MIDI channel. A track whose
        // font is not loaded has no channel and stays silent; the engine has
        // already asked for the font (`library_needed`).
        if (this.fonts === null) return;
        if (event.type === "on") this.fonts.noteOn(record.track_id, event.p, event.v);
        else this.fonts.noteOff(record.track_id, event.p);
        return;
      }
      if (!record.engine || record.module < 0) return;
      const module = record.module + 1;
      if (event.type === "on") {
        record.engine.sendEvent(SLOT, 0, noteFor(event.p), sunvoxVelocity(event.v), module, 0, 0);
      } else {
        record.engine.sendEvent(SLOT, 0, NOTECMD_NOTE_OFF, 0, module, 0, 0);
      }
    }

    /**
     * Post every launch the sequencer applied in this block, in context frames.
     *
     * The sequencer reports a launch with the offset of its boundary inside the
     * block; the frame the client gets is the context's, so a recorder on the
     * same AudioContext can arm on the very frame the launch took effect.
     * @param {Array<object>|undefined} launches the block's launch reports
     * @returns {void}
     */
    reportLaunches(launches) {
      if (!launches || launches.length === 0) return;
      const base = this.contextOffset() + this.frame;
      for (let at = 0; at < launches.length; at += 1) {
        const launch = launches[at];
        this.port.postMessage({
          type: "launched",
          track_id: launch.track_id,
          clip_id: launch.clip_id,
          scene_id: launch.scene_id,
          bar: launch.bar,
          frame: base + launch.frame,
        });
      }
    }

    /**
     * The offset from this processor's frames to the context's.
     *
     * Measured once, at the first block, from the shared `currentFrame` global
     * minus this processor's own `frame`: both counters advance block by block
     * at the same rate, so the difference is constant. It is not re-measured on
     * every block because a host may not advance that global at all
     * (node-web-audio-api keeps it at 0), and re-measuring would drift further
     * away with every block.
     *
     * A host without the global leaves the offset at 0: every frame reported
     * then is this processor's own `this.frame` plus the block offset, which is
     * still one consistent clock.
     * @returns {number}
     */
    contextOffset() {
      if (this.frameOffset === null) {
        const now = contextFrameNow();
        this.frameOffset = now === null ? 0 : now - this.frame;
      }
      return this.frameOffset;
    }

    /**
     * Post the transport position, at most every 50 ms of audio.
     *
     * The report also carries `patterns`: which pattern each sampler track was
     * playing in this block, and where that pattern's chain slot sits
     * (`events.patterns`, filled in by the sequencer's own chain slot). It is the
     * one place a client can learn what the ENGINE played: a chain slot turns
     * over on the sequencer's own beat grid, so a recorder that guessed the
     * pattern from the transport position could write a lane into the slot before
     * the boundary instead of the one that sounded. Each entry is
     * `{pattern_id, slot_start_beat, slot_beats, chain_index}` — the slot the
     * block ends in, in the same beat clock the report's own bar/beat/sixteenth
     * are in — so a client can also follow the chain past the end of that slot
     * without waiting for the next report.
     *
     * The sequencer's entries are reused across blocks, so the report object is
     * built HERE, once per post, and never per block.
     * @param {number} frames the frames the block held
     * @param {Map<string, {pattern_id: string, slot_start_beat: number,
     *   slot_beats: number, chain_index: number}>|undefined} patterns track id →
     *   the slot the block played (empty when no pattern clip played)
     * @returns {void}
     */
    reportPosition(frames, patterns) {
      this.sincePosition += frames;
      if (this.sincePosition < this.positionEvery) return;
      this.sincePosition = 0;
      const position = this.sequencer.position();
      const played = {};
      if (patterns) {
        for (const [trackId, slot] of patterns) {
          played[trackId] = {
            pattern_id: slot.pattern_id,
            slot_start_beat: slot.slot_start_beat,
            slot_beats: slot.slot_beats,
            chain_index: slot.chain_index,
          };
        }
      }
      this.port.postMessage({
        type: "position",
        bar: position.bar,
        beat: position.beat,
        sixteenth: position.sixteenth,
        patterns: played,
      });
    }

    /**
     * Report a failure to the client as a string it can log or throw.
     * @param {unknown} error
     * @returns {void}
     */
    report(error) {
      const text = error && error.message ? error.message : String(error);
      this.port.postMessage({ type: "error", error: text });
    }

    /**
     * Stop the engine: report the fault once and go silent from here on.
     * @param {unknown} error
     * @returns {void}
     */
    fail(error) {
      if (!this.failure) this.failure = error;
      if (this.failureReported) return;
      this.failureReported = true;
      this.report(error);
    }
  }

  registerProcessor(PROCESSOR_NAME, StudioProcessor);
})();
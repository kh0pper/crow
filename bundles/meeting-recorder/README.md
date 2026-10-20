# Meeting Recorder

Record a meeting in the browser and transcribe it with a transcription endpoint you run.

The panel captures two audio sources, the meeting itself (a shared tab or window) and the
microphone, mixes them in WebAudio, and uploads Opus every 15 seconds. On stop, a detached worker
converts the audio, cuts it into 20 to 30 second chunks at the quietest moment in each window,
sends each chunk to an OpenAI-compatible transcription endpoint, and writes a timestamped markdown
transcript. With the default endpoint (loopback `:8004`) the audio never leaves the host, and no
API key is involved. If you point `WHISPER_URL` or `WHISPER_FALLBACK_URL` at another machine, the
audio goes there.

## Why chunks, and what happens to a bad one

Whisper can fall into a repetition loop on long audio: one sentence, or "thank you", over and over.
faster-whisper-server keeps `condition_on_previous_text` on and accepts a single temperature, so its
own fallback never runs. The worker defends against this itself:

1. **Chunks of at most one decoder window (30 s),** cut at the quietest 100 ms frame between 20 and
   30 seconds, each sent on its own at temperature 0 with no prompt carried over.
2. **A temperature ladder.** If any segment's compression ratio is above 2.4, or the loop guard
   (more than 4 words a second, or any five-word run repeated more than 8 times) flags the text, the
   chunk is sent again at 0.2, 0.4, 0.6, 0.8 and 1.0, and the first clean result is kept. A request
   that times out also moves up the ladder. If nothing comes back clean, the least bad result is
   kept and the chunk is marked `[possible repetition: …]` in the transcript and in `meta.json`.
   After a timeout the worker first sends a one-second request and waits for it, because the
   server keeps decoding a request the client gave up on; two timeouts on one chunk end its ladder.
3. **An optional fallback endpoint** (`WHISPER_FALLBACK_URL`) gets any chunk the primary could not
   answer or answered only suspectly. After two chunks in a row with the primary down, chunks go
   straight to the fallback, and the primary is tried again every ten chunks. A chunk that times
   out twice with nothing to show counts as the primary being down, even when the audio is what
   wedged it.
4. **Gaps, not failures.** A chunk no endpoint can read becomes `[transcription gap: …]`, and the
   rest of the meeting is still transcribed. Finished chunks are cached, so re-running the session
   pays only for the gaps. The run is marked failed instead when more than half the chunks are
   gaps, when no endpoint answers five chunks in a row, or at once on a 4xx (a wrong URL or model
   name, which no retry fixes).

The loop guard needs only text and audio length, so it applies to any engine.

## What it needs

- **ffmpeg** on the host.
- **A transcription endpoint.** The `faster-whisper-server` bundle is the intended pairing: CPU,
  int8, loopback `:8004`, which is this bundle's default. Any OpenAI-compatible
  `/v1/audio/transcriptions` endpoint works.
- **A secure context.** Browsers hand over tab audio only over HTTPS or on localhost. Reach the
  dashboard through Tailscale Serve, a TLS reverse proxy, or `http://localhost`. The panel says so
  on screen when the context is insecure, before you record silence by accident.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `WHISPER_URL` | `http://localhost:8004/v1/audio/transcriptions` | the primary transcription endpoint |
| `WHISPER_MODEL` | `Systran/faster-whisper-large-v3` | model name sent with each chunk |
| `WHISPER_FALLBACK_URL` | unset | optional second endpoint for chunks the primary cannot read cleanly |
| `WHISPER_FALLBACK_MODEL` | `WHISPER_MODEL` | model name for the fallback |
| `WHISPER_CHUNK_MIN_S` / `WHISPER_CHUNK_MAX_S` | `20` / `30` | the window each cut is placed in; above 30 s a chunk spans more than one decoder window and the loop risk returns |
| `WHISPER_CHUNK_TIMEOUT_MS` | `90000` | per-request ceiling, at most 290000 (`WHISPER_SLICE_TIMEOUT_MS` still works, but a value sized for the old four-minute slices is far too generous for a 30 s chunk) |
| `WHISPER_DRAIN_TIMEOUT_MS` | `600000` | how long to wait for the server to go idle after a timeout |
| `WHISPER_ATTEMPTS` | `3` | tries per request on connection errors (`WHISPER_SLICE_ATTEMPTS` still works) |
| `WHISPER_VAD_FILTER` | `true` | ask the server to skip non-speech |
| `WHISPER_LANGUAGE` | unset | send a language code instead of letting the server detect one per chunk |
| `WHISPER_COMPRESSION_RATIO_MAX` | `2.4` | the segment compression ratio above which a chunk is retried |
| `MEETING_RECORDER_EXPORT_DIR` | unset | if set, every transcript also lands in `<dir>/<date>-<slug>/transcript.md` |

`WHISPER_SLICE_SECONDS` (1.0.x) is no longer read.

## Where recordings live

`$CROW_HOME/data/meeting-recorder/<session-id>/`

| File | What |
|---|---|
| `audio.webm` (or `audio.<ext>` for an upload) | the recording |
| `audio.wav` | 16 kHz mono, what the transcriber read |
| `meta.json` | title, timings, state, results |
| `transcript.json` | segments with start, end, text, chunk index (and `suspect` / `gap` flags) |
| `chunks.json` | one record per chunk: span, engine, model, temperature, compression ratio, words per second, every attempt |
| `transcript.md` | the readable transcript, with any notes taken while listening |
| `chunks/` | finished chunks, kept only while a gap remains, so a re-run resumes (moved to `chunks.stale-<time>/` if the settings change) |

## Re-transcribing a session

```
CROW_HOME=<the instance's crow home> [WHISPER_URL=… WHISPER_MODEL=…] \
  node <installed bundle>/server/transcribe.js --retranscribe <session-id>
```

Run it with the same `WHISPER_*` settings the gateway uses (the defaults, unless the gateway sets
them). It exits 0 when it committed, 3 when gaps left nothing replaced, and 1 on an error.

This re-runs a finished session through the current worker, for example one transcribed before
1.0.2 that looped. It is careful by design:

- It refuses a session that is recording or has a live worker, another session with a live worker
  (two workers slow each other into timeouts), a second retranscribe of the same session, and a
  session whose recorded export folder has gone missing.
- Until it commits it writes nothing in the session but its own files: progress goes to
  `retranscribe.json`, and `meta.json`, the transcript and `state` stay as they were.
- It replaces nothing unless every chunk was transcribed. With gaps it stops, leaves the old
  transcript in place, and keeps the finished chunks so the next run asks only for the gaps
  (`--allow-gaps` commits anyway).
- On commit it copies `transcript.md`, `transcript.json`, `chunks.json` and `meta.json` (as it was
  before the run) to `*.v1-loop.*`, or `*.prev-<UTC time>.*` once a v1-loop set exists, and does the
  same in the export folder the session already points at (`meta.export_path`), then swaps the new
  files in. No archived file is ever overwritten, and nothing that was there is deleted.

## Throughput

About 4x real time on an AMD Ryzen AI Max+ 395 with faster-whisper large-v3 int8 on CPU (measured:
40 to 43 s per three-minute clip, 7 or 8 chunks each): a ninety-minute meeting finishes about 20 to
30 minutes after it ends. A chunk that needs the
temperature ladder costs up to six requests. Transcription starts when recording stops; there is
no live transcript.

## Limits worth knowing before you rely on it

- **No speaker labels.** Diarization is a second model and is not here. Every transcript carries a
  line saying so, because a machine transcript with confident-looking text invites quotation.
- **Names get misheard.** Verify any quotation against the audio before it travels.
- **Recording other people carries obligations this bundle does not handle.** Many hosts prohibit
  recording their sessions, and consent rules vary by jurisdiction. That judgement is the
  operator's, before pressing record.

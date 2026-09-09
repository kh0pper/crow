# Meeting Recorder

Record a meeting in the browser and transcribe it on the same machine that served the page.

The panel captures two audio sources, the meeting itself (a shared tab or window) and the
microphone, mixes them in WebAudio, and uploads Opus every 15 seconds. On stop, a detached worker
converts the audio, sends it to a local OpenAI-compatible transcription endpoint in ten-minute
slices, and writes a timestamped markdown transcript. Nothing leaves the host, and no API key is
involved.

## What it needs

- **ffmpeg and ffprobe** on the host.
- **A transcription endpoint.** The `faster-whisper-server` bundle is the intended pairing: CPU,
  int8, loopback `:8004`, which is this bundle's default. Any OpenAI-compatible
  `/v1/audio/transcriptions` endpoint works.
- **A secure context.** Browsers hand over tab audio only over HTTPS or on localhost. Reach the
  dashboard through Tailscale Serve, a TLS reverse proxy, or `http://localhost`. The panel says so
  on screen when the context is insecure, before you record silence by accident.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `WHISPER_URL` | `http://localhost:8004/v1/audio/transcriptions` | the transcription endpoint |
| `WHISPER_MODEL` | `Systran/faster-whisper-large-v3` | model name sent with each slice |
| `WHISPER_SLICE_SECONDS` | `600` | slice length; smaller means finer progress, more requests |
| `MEETING_RECORDER_EXPORT_DIR` | unset | if set, every transcript also lands in `<dir>/<date>-<slug>/transcript.md` |

## Where recordings live

`$CROW_HOME/data/meeting-recorder/<session-id>/`

| File | What |
|---|---|
| `audio.webm` (or `audio.<ext>` for an upload) | the recording |
| `audio.wav` | 16 kHz mono, what the transcriber read |
| `meta.json` | title, timings, state, results |
| `transcript.json` | segments with start, end, text |
| `transcript.md` | the readable transcript, with any notes taken while listening |

## Throughput

Roughly 3.5x real time on an AMD Ryzen AI Max+ 395 with faster-whisper large-v3 int8 on CPU: a
ninety-minute meeting finishes about twenty-five minutes after it ends. Transcription starts when
recording stops; there is no live transcript.

## Limits worth knowing before you rely on it

- **No speaker labels.** Diarization is a second model and is not here. Every transcript carries a
  line saying so, because a machine transcript with confident-looking text invites quotation.
- **Names get misheard.** Verify any quotation against the audio before it travels.
- **Recording other people carries obligations this bundle does not handle.** Many hosts prohibit
  recording their sessions, and consent rules vary by jurisdiction. That judgement is the
  operator's, before pressing record.

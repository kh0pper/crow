---
title: Frigate NVR
---

# Frigate NVR

Self-hosted camera system with AI object detection. Frigate processes RTSP/ONVIF camera streams locally, runs object-detection on CPU (or optional Coral TPU / OpenVINO iGPU / CUDA GPU), and records motion-triggered clips. Crow surfaces cameras, events, snapshots, and clips through MCP tools so your AI assistant can reason over what's happening on your property — without any footage leaving your home network.

## What You Get

- Local AI object detection (person, car, dog, package, etc.)
- Motion-triggered recording with configurable retention
- JWT-authenticated REST API on :8971
- Crow's Nest "Cameras" panel: camera list, recent events with thumbnails, system stats
- MCP tools for cameras, events, snapshots, clips, and detect toggle
- Frigate's own Web UI embedded as a tab in the Nest panel

## When to Use vs MotionEye

| | Frigate | MotionEye |
|---|---|---|
| AI object detection | Yes (local, CPU/Coral/OpenVINO/CUDA) | No |
| RTSP / ONVIF cameras | Yes | Yes |
| USB webcams | No | Yes |
| Hardware | x86 preferred (Pi 5 + Coral works) | Pi-class friendly |
| UI | Modern React SPA | Classic web admin |
| Crow MCP tools | Full (events, clips, snapshots, detect toggle) | Iframe-only |

Pick **Frigate** if you have RTSP cameras and want "who was at the front door at 9pm?" answered automatically. Pick **MotionEye** for a lightweight Pi deployment or USB-webcam setups.

## Setup

### Install the bundle

> "Crow, install the Frigate bundle"

Or via **Extensions** in the Crow's Nest → find Frigate under **Cameras**.

This runs Frigate in Docker using the official `ghcr.io/blakeblackshear/frigate:stable` image and exposes:

- `:8971` — authenticated UI + REST API (loopback only)
- `:8554` — RTSP restreamer (loopback only)
- `:8555` — WebRTC for low-latency live view (LAN)

Port `5000` (Frigate's internal unauthenticated API) is **intentionally not published**.

### First-run admin password

Frigate generates an admin password on first start. Find it in the container logs:

```bash
docker logs crow-frigate 2>&1 | grep "Password:"
```

Set these in `~/.crow/bundles/frigate/.env`:

```bash
FRIGATE_URL=http://localhost:8971
FRIGATE_USER=admin
FRIGATE_PASSWORD=<password from logs>
```

Then restart the bundle so the MCP server can authenticate:

> "Crow, restart the Frigate bundle"

You should also log in to the Web UI and rotate the password.

### Add a camera

Edit `~/.crow/data/frigate/config/config.yml` (seeded from `bundles/frigate/config.yml.example` on install). Example RTSP source:

```yaml
cameras:
  front_door:
    enabled: true
    ffmpeg:
      inputs:
        - path: rtsp://user:pass@192.168.1.42:554/stream
          roles:
            - detect
            - record
    detect:
      width: 1280
      height: 720
      fps: 5
    objects:
      track:
        - person
        - car
        - dog
```

Then:

> "Crow, restart the Frigate bundle"

The camera should appear in the Crow's Nest "Cameras" panel and via `crow_frigate_list_cameras`.

### Disk discipline

Default retention is **7 days of motion-triggered recordings**. Rough formula:

```
GB/day ≈ cameras × bitrate_mbps × 10.8
```

One 1080p camera at 2 Mbps → ~22 GB for 7 days of continuous recording, less for motion-only. Check disk headroom before raising `record.retain.days`:

```bash
df -h ~/.crow/data/frigate/media
```

The bundle's install script aborts if < 10 GB free on the target filesystem, and warns below 50 GB. A cleanup watchlist alerts if the media directory exceeds 30 GB.

## MCP Tools

| Tool | Purpose |
|---|---|
| `crow_frigate_list_cameras` | Camera list with detect/record state |
| `crow_frigate_list_events` | Events filtered by camera, label, time window |
| `crow_frigate_latest_by_label` | Most recent event for a label (e.g. "most recent person") |
| `crow_frigate_snapshot` | Snapshot URL for an event or camera-latest |
| `crow_frigate_clip_url` | MP4 clip URL for an event |
| `crow_frigate_set_detect` | Enable/disable detect per camera (destructive — requires `confirm: true`) |
| `crow_frigate_stats` | Version, uptime, detector inference time, process count |

### Example prompts

> "What Frigate cameras do I have?"
> → calls `crow_frigate_list_cameras`

> "Was there anyone at the front door between 8pm and 10pm last night?"
> → calls `crow_frigate_list_events` with camera, label=person, after/before filters

> "Show me the most recent car detection"
> → calls `crow_frigate_latest_by_label` with label=car

> "Give me the clip URL for event abc123"
> → calls `crow_frigate_clip_url`

### Sharing snapshots/clips off-tailnet

Frigate URLs are authenticated and work only from the Crow gateway or the Nest panel's iframe. **Do NOT share raw Frigate URLs off-tailnet** — they won't work (the receiver has no session), and even if they did, that would expose the Frigate UI externally.

To share externally: upload the file via `crow_upload_file` first, then share the resulting Crow storage URL.

## Troubleshooting

**"Cannot reach Frigate"**
The container is not running. Start it:

```bash
cd ~/.crow/bundles/frigate && docker compose up -d
```

**"Frigate authentication expired or invalid"**
`FRIGATE_USER` / `FRIGATE_PASSWORD` in `.env` are wrong or missing. Re-check the container logs for the first-run password, or use a user you've created in the Web UI. Restart the bundle after editing `.env`.

**"Frigate endpoint not found"**
Version skew. Our bundle targets `:stable` which currently resolves to Frigate 0.17. If a future version changes endpoint paths, open an issue.

**Tile does not appear in Extensions panel**
The bundle is installed to `~/.crow/bundles/frigate/` but `panels.json` / panel symlinks are missing. Re-run:

```bash
~/crow/scripts/crow bundle install frigate
```

and verify `~/.crow/panels/frigate.js` exists. Then restart the gateway.

**Can't reach Web UI tab in the Nest panel**
Frigate's JWT cookie is first-party to `:8971`. The iframe must be loaded from the same host where Frigate is published. If the panel iframe shows a blank page, confirm `FRIGATE_URL` points to a browser-reachable URL.

## Future Work

- **Coral TPU acceleration** — requires `libedgetpu1-std` on the host, udev rules, `/dev/bus/usb` mount, and a known USB3 re-enumeration workaround. Not wired in v1.
- **MQTT event stream** — Frigate can push events to MQTT in real time. Wiring this to Crow notifications (so "person detected at front door" becomes a push notification) needs a mosquitto broker and an event-to-notification bridge.
- **Home Assistant auto-linking** — works at the MQTT layer. Install both the Home Assistant bundle and a broker to wire it up.

## Security Notes

- Frigate's internal port 5000 is unauthenticated and **deliberately not published**. Don't expose it.
- Port 8971 (authenticated UI) is bound to loopback by default. The Nest panel proxies through the Crow gateway's auth boundary.
- Never map `/dashboard/frigate`, `/api/frigate/*`, or `/frigate/*` into a Tailscale Funnel prefix — the `rejectFunneled` middleware enforces this, and `tests/auth-network.test.js` has a regression test for it.

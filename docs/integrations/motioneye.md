---
title: motionEye
---

# motionEye

Lightweight web frontend for the venerable `motion` daemon. Motion-triggered recording, timestamp overlays, email notifications — no AI object detection. Pi-friendly (runs comfortably on a Pi 3/4/5 or any Linux SBC).

This is the **simple / nostalgic** camera bundle. If you want AI ("was there a person at the front door?") or MCP-callable camera tools from your AI assistant, install [Frigate](./frigate) instead.

## What You Get

- Web UI for configuring RTSP/ONVIF and USB (V4L2) cameras
- Motion-triggered recording with configurable per-camera retention
- Email notifications on motion
- Default timezone/timestamp overlay
- Crow's Nest iframe tab — single-pane access alongside your other tools

## What You Don't Get

- AI object detection (Frigate does this)
- MCP tools (`list_cameras`, `list_events`, `snapshot`, etc.) — motionEye's API uses session-cookie + CSRF admin auth that isn't worth wrapping for v1
- Real-time event notifications into Crow's notification center

## When to Use vs Frigate

| | motionEye | Frigate |
|---|---|---|
| USB webcams (V4L2) | Yes | No |
| RTSP / ONVIF | Yes | Yes |
| AI object detection | No | Yes |
| MCP tools | No (iframe only) | Yes (7 tools) |
| Hardware | Pi-class friendly | x86 preferred (Pi 5 + Coral works) |
| UI | Classic web admin | Modern React SPA |
| Footprint | 256 MB RAM baseline | 2 GB RAM baseline |

You can install **both**. They coexist under the same "Cameras" category in the Crow's Nest.

## Setup

### Install the bundle

> "Crow, install the motionEye bundle"

Or via **Extensions** in the Crow's Nest → find motionEye under **Cameras**.

Uses the official `ghcr.io/motioneye-project/motioneye:latest` multi-arch image (amd64, arm64, armhf, riscv64), version 0.43.1 as of this writing.

Exposes port `:8765` on loopback. The Nest iframe loads motionEye from that loopback address, so there's no public exposure of the camera UI.

### First login

Default credentials on first start:

- **Username:** `admin`
- **Password:** (empty)

**Rotate immediately** via Settings → General → Admin Password. If the bundle is exposed to any untrusted network (which it shouldn't be by default — Crow binds it to loopback), an empty admin password is a catastrophic hole.

### Add a camera

Inside the Web UI (either the Nest iframe tab or `http://localhost:8765` on the host):

1. Click the hamburger menu → **add camera**
2. Pick the camera type:
   - **Network camera** — paste an RTSP URL (e.g. `rtsp://user:pass@192.168.1.42:554/stream`)
   - **V4L2 camera** — pick a `/dev/videoN` device (USB webcam). You'll need to pass the device through in `docker-compose.yml`: add `devices: - "/dev/video0:/dev/video0"` under the service, then restart.
3. Click OK
4. Configure motion detection sensitivity under Settings → Motion Detection
5. Configure retention under Settings → Movies → **preserve movies** (day count; default is unlimited — set this or your disk fills up)

### Storage

Recordings land in `~/.crow/data/motioneye/media/` on the host. `post-install.sh` warns if free disk drops under 50 GB and aborts below 10 GB.

Per-camera retention is in the camera's Settings → Movies. Set it. motionEye defaults to unlimited.

## Troubleshooting

**Empty iframe / "connection refused"**
The container isn't running. Start it:

```bash
cd ~/.crow/bundles/motioneye && docker compose up -d
```

**USB webcam not detected**
motionEye needs the device passed through explicitly:

```yaml
# ~/.crow/bundles/motioneye/docker-compose.yml
services:
  motioneye:
    # ...
    devices:
      - "/dev/video0:/dev/video0"
    # match the device index to what `ls /dev/video*` shows on the host
```

Then `crow bundle restart motioneye`.

**Recordings filling the disk**
You didn't set per-camera retention. Open each camera's Settings → Movies → preserve movies → pick a day count (7, 14, 30).

**Tile does not appear in Extensions panel**
The bundle installed to `~/.crow/bundles/motioneye/` but the panel symlink is missing. Re-run:

```bash
~/crow/scripts/crow bundle install motioneye
```

Then restart the gateway.

**Need LAN access to motionEye directly (e.g., for the phone app)**
By default `:8765` is loopback-only. To expose on LAN, edit `~/.crow/bundles/motioneye/docker-compose.yml`:

```yaml
ports:
  - "8765:8765"      # all interfaces (not just loopback)
# or to a specific tailnet IP:
#  - "100.x.x.x:8765:8765"
```

Then `crow bundle restart motioneye`. Know that motionEye's built-in auth is weaker than the Crow gateway; prefer keeping it loopback and using the Nest iframe.

## Security Notes

- Default admin password is empty — rotate on first login, always.
- Loopback-only port binding in the default compose file.
- Never map `/dashboard/motioneye` into a Tailscale Funnel prefix — the `rejectFunneled` middleware enforces this, and `tests/auth-network.test.js` has a regression test for it.
- motionEye's config dir contains the admin password hash; backup `~/.crow/data/motioneye/config/` if you change passwords.

## Future Work

- **MCP tool wrapper** — motionEye has admin endpoints for snapshot/start/stop/config-get behind session cookies + CSRF; a future v2 could wrap them so the AI can ask "list my motionEye cameras." Not prioritized while Frigate covers the MCP path.
- **USB autodetect** — the current bundle requires manual `devices:` edit for USB cams. A future post-install could scan `/dev/video*` and generate the compose entries.

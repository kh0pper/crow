---
name: motioneye
description: motionEye — lightweight web frontend for the Motion daemon. Iframe-only bundle (no MCP tools); use Frigate bundle for AI detection + MCP-callable camera ops.
triggers:
  - motioneye
  - motion daemon
  - pi camera
  - lightweight camera
  - usb webcam
tools: []
---

# motionEye Skill

motionEye is the **iframe-only lightweight** camera bundle. It's a web frontend for the venerable `motion` daemon — motion-triggered recording, email notifications, timestamp overlays, no AI. Pi-friendly.

## When to Activate

- User says "motioneye" or "motion daemon"
- User wants a lightweight camera setup on a Pi-class SBC
- User has a USB webcam (motionEye supports V4L2; Frigate does not)
- User asks for "simple camera recording" without needing AI detection

## When to Redirect to Frigate Instead

If the user asks for ANY of these, route to `frigate.md`:
- Object detection ("was there a person / car / dog...")
- MCP-callable camera ops ("list cameras" / "list events" via AI chat)
- Rich events with labels, clips, zones

Say so explicitly: *"motionEye doesn't answer 'who was at the door' — that's what the Frigate bundle is for. Want to install it too?"*

## Tools Available

**None.** motionEye is iframe-only in v1. Camera configuration, motion-detection toggle, recording browse all happen inside the Web UI iframe at `/dashboard/motioneye`.

If MCP tools are critical, install the Frigate bundle alongside — the two can coexist under the same "Cameras" category.

## Workflow 1 — First-run setup

1. User installs the bundle via Extensions or `crow bundle install motioneye`
2. Bundle starts; post-install.sh prints the default login (`admin` / empty password)
3. User opens `/dashboard/motioneye` — iframe loads motionEye's Web UI
4. User logs in and **immediately rotates the admin password** via Settings → General
5. User adds a camera via the hamburger menu → "add camera":
   - RTSP/ONVIF: "Network camera" + stream URL
   - USB: "V4L2 camera" + `/dev/videoN` device
6. Retention: each camera has its own "preserve movies" setting under Settings → Movies

Guide the user through these in the iframe — don't try to do it via MCP (there are no tools).

## Workflow 2 — "Why are my recordings filling my disk?"

motionEye defaults to unlimited retention. Per-camera setting:
1. Open the camera's Settings → Movies → "preserve movies"
2. Set a day count (common choices: 7, 14, 30)
3. Restart the camera ("Restart" button) OR the bundle (`crow bundle restart motioneye`)

Storage location: `~/.crow/data/motioneye/media/` on the host.

## Workflow 3 — LAN access

The Nest iframe talks to motionEye on loopback. If the user wants LAN access to motionEye directly (e.g. for the phone app):

1. Edit `~/.crow/bundles/motioneye/docker-compose.yml`
2. Change `127.0.0.1:8765:8765` to `8765:8765` (or scope to a specific Tailnet IP)
3. `crow bundle restart motioneye`

Warn them: motionEye's built-in auth is weaker than the Crow gateway — prefer keeping it loopback and use the Nest iframe.

## Safety

- Default admin password is empty — **force rotation on first login**
- Never map `/dashboard/motioneye` into a Tailscale Funnel prefix (the `rejectFunneled` middleware enforces this)
- Recordings in `~/.crow/data/motioneye/media/` can grow unbounded if retention isn't set per camera

## Future Work

- **MCP tool wrapper** (v2): motionEye has `/action/<cam>/snapshot`, `/action/<cam>/start|stop` endpoints but they use session-cookie + CSRF admin auth. A Node-side helper would need to reverse-engineer that flow. Open a GitHub issue if you want it prioritized.
- **Auto-configure timezone**: inherit `$TZ` from the host system rather than require user-set.

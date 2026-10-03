# Cameras: Frigate on crow, the Ring doorbell through ring-mqtt, Home Assistant and the kiosk (Design)

**Date:** 2026-10-03.

**Status:** this is a spec. It comes from the kiosk brainstorm with Kevin on 2026-10-03. The handoff note says: "Cameras phase (separate): install Frigate extension + ring-mqtt bridge for the Ring doorbell → HA + Frigate; kiosk shows doorbell on ring." Rulings not marked *Kevin* are this spec's. Kevin reviews them before a plan is written.

**Base:** `origin/main` @ `09ae235f`. Host facts were checked on crow on 2026-10-03. Facts about ring-mqtt come from its upstream wiki (Installation (Docker), Video Streaming) and from `init-ring-mqtt.js` on the same date.

**Sibling spec:** `2026-10-03-crow-kiosk-companion-design.md`. Its sub-project K4 consumes this spec's doorbell event and camera stream.

## 1. Purpose

When someone rings the Ring doorbell, three things should happen:

- The kitchen display wakes up.
- The display shows who is at the door.
- The bird says so.

The doorbell also becomes a first-class device in Home Assistant, with dings and motion available to automations. Frigate becomes crow's NVR (network video recorder): it keeps event clips and serves a low-resolution stream the Pi 3 can actually play. Any future local RTSP camera fits the same path.

Cameras are **never** on the kiosk idle screen (Kevin). They appear only on a ring or on request.

## 2. Ground truth (verified 2026-10-03)

### The Frigate bundle

The bundle lives at `bundles/frigate/`: type `bundle`, v1.0.0, image `ghcr.io/blakeblackshear/frigate:stable`.

- **Image tag:** `:stable` is a floating tag. That runs against the image-freshness rail, which expects pinned tags.
- **Ports:**
  - `127.0.0.1:8971` is the authenticated UI and API.
  - `127.0.0.1:8554` is the RTSP restream.
  - **`8555:8555/tcp+udp` (WebRTC) is bound on all interfaces.** Docker-published ports bypass ufw, so this is reachable from the LAN today. The lesson was learned on the Dayane instance, whose fence had to be `DOCKER-USER`.
- **Config defaults** (`config.yml.example`): MQTT off, CPU detector, 7-day motion retention.
- **Post-install:** refuses to install with less than 10 GB free and warns below 50 GB.
- **MCP tools:** the bundle has MCP tools and a panel.

### Frigate on crow

- `installed.json` lists `frigate` as installed on 2026-04-21.
- **No `crow-frigate` container exists.**
- `~/.crow/data/frigate` holds only a seeded config (244 KB). It is a half-done install.

### Storage

| volume | size | free | notes |
|---|---|---|---|
| `/mnt/data` | 916 GB | **7.6 GB (100 %)** | Full. Unusable. |
| `/` (`vgmint-root`, NVMe) | 1.8 TB | 274 GB (85 %) | |
| `/mnt/external` | 3.7 TB | 2.3 TB | NTFS mounted through `ntfs-3g` (FUSE, `fuseblk`), a USB WD Elements drive, fstab `nofail`. It holds the hot second copy of migrated content. |

- The LVM volume group `vgmint` has **44.58 GB unallocated**.

### MQTT

- No MQTT broker exists on crow.
- There is no `mosquitto` or other MQTT bundle in `bundles/` or `registry/add-ons.json`.
- Ports `1883` and `55123` are free (not in the port allocation doc, nothing listening).

### Home Assistant on crow

- Host network on `:8123`.
- No `mqtt`, `ring` or `frigate` integration is configured.
- HACS is installed.
- HA's own `go2rtc` integration is present (a listener on `:18555`).

### ring-mqtt (upstream)

- **Image:** `tsightler/ring-mqtt`.
- **Data:** state lives in `/data`. `config.json` holds settings. `ring-state.json` holds runtime state, including the refresh token under `ring_token`. A persistent volume has been mandatory since v5.
- **Login:**
  - 2FA is mandatory for the Ring API.
  - The token comes from `init-ring-mqtt.js`, which prompts interactively (`requestInput` from ring-client-api) for email, password and 2FA code.
  - It accepts no environment variables for credentials.
- **Streams:**
  - It exposes on-demand RTSP through a built-in go2rtc: `rtsp://<host>:8554/<camera_id>_live` and `…_event`.
  - Optional stream credentials are set with `livestream_user` and `livestream_pass`.
  - A stream starts on the first client, in about 2–3 s.
  - A stream stops about 5–10 s after the last client disconnects.
- **Cloud dependency:** all streaming goes through Ring's cloud.
- **Upstream warnings:**
  - Running the live stream continuously causes energy drain and overheating.
  - It **disables motion notifications while streaming**.
  - It hurts battery cameras badly.
  - The event stream needs a Ring Protect plan.

## 3. Decisions

| # | Topic | Decision |
|---|---|---|
| C-D1 | Ring ingestion | Ring is **never streamed continuously**. Frigate does not run 24/7 detection or recording on the doorbell. The doorbell is a go2rtc stream that is pulled only while someone watches, plus an **event window**: N seconds recorded after each ding or motion event. |
| C-D2 | Ring → HA, events | **ring-mqtt only**, through HA's MQTT integration with MQTT discovery. Dings, motion, battery and snapshots all arrive as HA entities from one Ring login. HA's core Ring integration is **not** added. The brainstorm suggested the core integration for events; this deviates from that, and Kevin must confirm (Q4). The reason: two integrations would mean two Ring authorized devices, two token lifecycles and duplicate entities. |
| C-D3 | MQTT broker | A new **`mosquitto` bundle**. Loopback `127.0.0.1:1883` plus a private Docker network `crow-cameras`. Password auth with one user per client. No anonymous access. |
| C-D4 | Frigate storage | A **dedicated 40 GB LVM volume** `vgmint/frigate`, ext4, mounted at `/mnt/frigate`. This is a hard cap, so Frigate can never fill the root filesystem. Alternatives rejected: `/mnt/data` (full); `/` without a cap (shares space with everything); `/mnt/external` (an NTFS FUSE mount on a USB disk, where heavy writes are slow and CPU-costly, and a `nofail` mount that silently falls back to writing into the root filesystem when the disk is absent). It uses 40 of the 44.58 GB free in the volume group, so Kevin must confirm (Q3). |
| C-D5 | Retention | Event clips and snapshots are kept **30 days**. There is no continuous recording (C-D1). Frigate's own low-space cleanup is a backstop. |
| C-D6 | Detection | CPU detector, as the bundle ships it. No GPU, so it never contends with the model orchestrator. It is used for event clips and for any future local cameras. |
| C-D7 | Kiosk stream | Frigate's built-in go2rtc **transcodes** the Ring stream to 640×360 H.264 on crow's CPU, a trivial load there. The Pi 3 plays it through **MSE over WebSocket**, proxied by the gateway. The Ring stream itself is 1080p or higher, and a Pi 3 cannot decode that in Chromium. A snapshot shows instantly while the stream spins up (2–3 s). |
| C-D8 | Ring credentials | The Ring password and 2FA code are typed once into a Crow panel form. They are piped to `init-ring-mqtt.js` over **stdin** with `docker exec -i`. They never go on argv, never into a file, never into a log, and are never stored by Crow. The refresh token stays where ring-mqtt rotates it, in `ring-state.json` (§6). A "Save Ring password to Crow keychain" checkbox (default off) creates a manual keychain entry for the human-facing password only. |
| C-D9 | Exposure | Every camera surface is loopback or a private Docker network. The **only** path off-host is the gateway, behind Tailscale Serve, with dashboard auth or a kiosk device token. No Funnel. |

## 4. Architecture

```
 Ring cloud ◄──── ring-mqtt (crow-ring-mqtt) ──── MQTT ────► mosquitto (127.0.0.1:1883, net crow-cameras)
                    │  go2rtc RTSP :8554 (net only)                 ▲          ▲            ▲
                    │                                               │          │            │
                    ▼                                     HA (host, MQTT     Frigate     Crow gateway
           Frigate (crow-frigate, net crow-cameras)        integration +    (events)   (doorbell listener)
            go2rtc streams: front_door  ← rtsp ring-mqtt   discovery)                       │
                            front_door_sub ← ffmpeg 640×360                                 ▼
            record: event windows only → /mnt/frigate/media           bus "home:doorbell" + notification (type home)
            API/UI 127.0.0.1:8971 ◄── gateway proxy (dashboard auth / kiosk token) ──► kiosk camera window (MSE)
```

### 4.1 `mosquitto` bundle (new)

- **Type and image:** type `bundle`, `eclipse-mosquitto` pinned to a current 2.x tag, chosen at plan time.
- **Network:** `127.0.0.1:1883` plus the `crow-cameras` network. No websockets listener and no TLS: both are loopback and private-network only.
- **Users, each with a generated secret** (the W1 + keychain mechanism, `generate: "secret"`):
  - `ring-mqtt`, `frigate` and `crow` are machine secrets. They go to bundle env only.
  - `homeassistant` is also generated, but marked `keychain: true`, because Kevin types it into HA's MQTT integration form. It is a human-facing password.
- **ACLs:**
  - `ring-mqtt` may read and write `ring/#` and `homeassistant/#`.
  - `frigate` may read and write `frigate/#`.
  - `homeassistant` may read and write everything; it is HA's broker.
  - `crow` may read `ring/#` and `frigate/#`, and may write nothing.
- **Port allocation:** `docs/developers/port-allocation.md` gets a row for 1883 (`check-ports`).

### 4.2 `ring-mqtt` bundle (new)

- **Type and image:** type `bundle`, `tsightler/ring-mqtt` pinned to a release tag.
- **Network:** **no published host ports**. It is on `crow-cameras` only, and RTSP stays inside that network.
- **Data volume:** `~/.crow/data/ring-mqtt` is mounted at `/data`, mode 700, so `ring-state.json` is readable only by its owner.
- **`config.json` is seeded at install** with:
  - `mqtt_url = mqtt://ring-mqtt:<secret>@mosquitto:1883`;
  - `livestream_user` and `livestream_pass` set to generated secrets;
  - `enable_cameras: true`;
  - `disarm_code` unset.
- **Panel "Connect Ring":**
  1. The form takes email and password, then asks for the 2FA code once Ring sends it.
  2. The gateway runs `docker exec -i crow-ring-mqtt node init-ring-mqtt.js` and answers the prompts over stdin.
  3. It restarts the container.
  4. It shows the discovered devices, read from MQTT discovery.
  - **Risk:** `requestInput` may need a TTY, and this must be verified as the plan's first spike. If it does, the fallback is a documented [KEVIN] terminal step (`docker exec -it crow-ring-mqtt node init-ring-mqtt.js`) with the same no-storage guarantees.
- **Doorbell listener (Crow side):**
  - It ships with this bundle's `panelRoutes`, with `mqtt` declared in the bundle's `package.json` (the `bundle-server-deps` rule).
  - It connects as `crow` and subscribes to `ring/+/camera/+/ding/state` and `…/motion/state`. The exact topic paths are confirmed against the live discovery payload in C2.
  - On a ding it:
    - emits the in-process bus event `home:doorbell {camera, at, snapshot_url}`;
    - creates a notification: `type:"home"`, `source:"doorbell"`, `priority:"high"`, expiry 10 minutes;
    - debounces repeat dings for 20 s.
  - Motion emits `home:motion`. That produces no notification by default.

### 4.3 Frigate (repair + changes to the existing bundle)

The bundle version goes 1.0.0 → 1.1.0, so installed copies refresh.

- **Pin the image** to the current stable release tag at plan time.
- **WebRTC:** bind `8555` to `127.0.0.1`. WebRTC is unused, since the kiosk uses MSE through the gateway. This closes today's LAN exposure.
- **Network:** join `crow-cameras`.
- **RTSP password:** `FRIGATE_RTSP_PASSWORD` stops defaulting to `changeme`. It becomes `generate: "secret"`.
- **Admin password:** `FRIGATE_PASSWORD` becomes `generatable: true` + `keychain: true`.
- **Storage:** `FRIGATE_MEDIA_PATH` defaults to `/mnt/frigate/media` when that mount exists. The post-install hook **refuses** if the media path's filesystem is the root filesystem and less than 50 GB is free there. Today it only warns.
- **Config (seeded or merged):**
  - `mqtt: {enabled: true, host: mosquitto, user: frigate, password: <secret>}`.
  - `go2rtc.streams`:
    - `front_door: rtsp://<live_user>:<live_pass>@ring-mqtt:8554/<camera_id>_live`;
    - `front_door_sub: ffmpeg:front_door#video=h264#width=640#height=360`.
    - The `camera_id` is filled in by the C2 panel step from discovery.
  - The `front_door` camera **for recording only** uses the event-window mechanism below.
  - Retention: `record` events/alerts 30 days; snapshots 30 days; no continuous retention.

**Event-window recording.** Each ding or motion event should record a clip: about 5 s before (where the stream allows; Ring has no pre-roll without a running stream, so in practice it starts at stream start) to 45 s after. Two mechanisms are possible. **The plan's spike picks between them against the pinned Frigate version:**

- **(a)** Frigate's per-camera enable/disable over MQTT. Crow turns `front_door` on for the window, then off, so Frigate records and detects only then.
- **(b)** If (a) is unsupported in the pinned version, Crow's listener records the window itself. It runs `ffmpeg -c copy` from the go2rtc restream into `/mnt/frigate/clips/doorbell/`, and Crow prunes those files at 30 days.

**Do not take a third option.** That option is a Frigate camera that is always enabled on the Ring stream, and C-D1 forbids it.

**Gateway proxy for live view.**

- **Endpoint:** `GET /api/cameras/<name>/live` upgrades to a WebSocket that proxies Frigate's go2rtc MSE endpoint on `127.0.0.1:8971`, using Frigate's JWT, which is held server-side.
- **Snapshot:** `GET /api/cameras/<name>/snapshot.jpg` is the latest Frigate snapshot. Before Frigate has one, it falls back to ring-mqtt's MQTT snapshot image.
- **Access:** both routes accept dashboard auth, or a kiosk device token restricted to cameras the display is allowed to show (per-display setting `cameras`, default: the doorbell only).
- **Limits:** at most 2 concurrent live viewers per camera, and each viewer is cut off after 10 minutes. This keeps a forgotten window from becoming a continuous Ring stream (C-D1).

### 4.4 Frigate ↔ Home Assistant

- **In scope for this spec:** Frigate publishes `frigate/#` events to the shared broker, so HA automations can use them through plain MQTT triggers.
- **Out of scope for v1:** the Frigate HA custom integration (HACS, `frigate` component). The display is served by Crow, not by HA dashboards. If Kevin later wants Frigate cameras as HA entities, that is a HACS install with no Crow change.
- **HA MQTT integration** (C2, [KEVIN] in the HA UI):
  - broker `127.0.0.1`, port 1883, user `homeassistant`, password from Crow keychain;
  - discovery prefix `homeassistant`.
  - The Ring doorbell then appears with ding, motion, battery and a camera snapshot entity.

### 4.5 Kiosk doorbell pop and bird announce (implemented as kiosk K4)

On `home:doorbell` the kiosk session does five things for each display whose `cameras` setting includes this doorbell:

1. It sends `display {on:true}`, which wakes the screen even inside the sleep window.
2. It opens a `camera` window. The snapshot shows at once, then the MSE live view of `front_door_sub` takes over.
3. It speaks "Someone's at the front door" through the device TTS. The bird is set to `alarmed` mood while speaking.
4. It auto-closes the window after 60 s, or on a swipe, which ends the stream (C-D1).
5. On request, the bound bot can open the window by voice: "show the front door" → `crow_wm` `open camera front_door`, with the same 10-minute cap.

## 5. Security

- **Network surface:**
  - Nothing camera-related listens on a non-loopback host interface after this work.
  - The plan's verification runs `ss -ltnp` and, from another tailnet node and from the LAN, a port probe of 1883, 8554, 8555 and 8971. All must fail.
  - The only path is gateway → Serve → tailnet, with auth.
  - The gateway camera routes get added cases in `tests/auth-network.test.js` (Funnel refused, off-tailnet refused).
- **Ring:**
  - The password is never stored.
  - The refresh token lives only in `~/.crow/data/ring-mqtt/ring-state.json` (700/600).
  - That directory **must be excluded from any off-host backup or sync**, and the plan lists every backup job on crow and checks each one. The refresh token is a bearer credential for the whole Ring account. Losing it costs only a re-login.
  - Ring's "Authorized Client Devices" page shows the ring-mqtt session. Revoking it there is the kill switch.
- **MQTT:** per-client users with least-privilege ACLs; no anonymous access; loopback/private network only.
- **Stream credentials:**
  - The go2rtc `livestream_user`/`livestream_pass` and the Frigate RTSP password are generated secrets in bundle env (600).
  - The Frigate admin password is in the keychain.
  - The Frigate JWT is used server-side only.
- **Privacy:** the kiosk shows cameras only on a ring or on request, with a viewer cap and a time cap. Event clips stay on crow for 30 days.

## 6. Why the Ring token is not in the Crow keychain

The brainstorm suggested putting "Ring 2FA token handling → Crow keychain".

The keychain (#409) is a store for **human-facing passwords** that never change on their own. Ring's refresh token is the opposite: ring-mqtt **rotates it** during normal operation and rewrites `ring-state.json`. A copy in the keychain would be stale within hours, and using a stale copy would fail or log out the live session.

This spec therefore puts the human-facing Ring **password** in the keychain (optional, C-D8). The token stays with its owner process. Kevin confirms this as part of Q4.

## 7. Phasing

| sub-project | scope | exit gate |
|---|---|---|
| **C1: storage + broker + Frigate repair** | [KEVIN] approves the LV; create `vgmint/frigate` 40 GB ext4 → `/mnt/frigate` (fstab by UUID, *not* `nofail`, so a missing volume fails loudly); `mosquitto` bundle; Frigate bundle 1.1.0 (pin, 8555 loopback, network, generated secrets, MQTT on, storage refusal rule); reinstall Frigate on crow | Frigate healthy; `ss` shows only loopback; LAN + tailnet probes fail; a test MQTT publish from the `crow` user is refused (read-only) |
| **C2: ring-mqtt + HA** | `ring-mqtt` bundle; stdin login spike + "Connect Ring" panel (or the terminal fallback); doorbell listener + bus event + notification; HA MQTT integration | [KEVIN] logs into Ring with 2FA; the doorbell appears in HA through discovery; pressing the doorbell creates a Crow `home`/`doorbell` notification |
| **C3: Frigate ↔ Ring streams** | go2rtc streams (`front_door`, `front_door_sub`); event-window recording (spike a vs b); gateway snapshot + MSE proxy routes with viewer and time caps | a ding produces a 30–50 s clip in `/mnt/frigate`; the dashboard plays the live sub-stream; the stream stops within about 15 s of the viewer closing (ring-mqtt logs) |
| **K4** (kiosk spec) | doorbell pop, wake, bird announce, voice "show the front door" | kiosk acceptance A10 |

## 8. Testing

### 8.1 Hermetic (`npm test`)

- **Manifests and compose:**
  - `mosquitto`, `ring-mqtt` and `frigate` 1.1.0 pass `check-ports` and `build-registry --check`.
  - A compose lint test asserts that no camera bundle publishes a port on a non-loopback address. That is the regression guard for 8555.
- **Doorbell listener:** it is fed recorded MQTT messages through an injected message source, so the test needs no broker.
  - A ding emits `home:doorbell` once, and repeats within 20 s are debounced.
  - It creates the `home`/`doorbell` notification.
  - Motion creates no notification.
  - A malformed payload is ignored.
- **Ring login runner:** with a fake `docker exec` child, the test asserts:
  - the email, password and 2FA code are written to stdin in prompt order;
  - none of them appear in the argv of the spawned process;
  - none of them appear in captured logs;
  - a timeout kills the child.
- **Camera routes:**
  - Auth matrix: dashboard session OK; kiosk token OK only for allowed cameras; anything else 401/403.
  - Funnel and off-tailnet are refused.
  - The viewer cap is enforced.
  - The 10-minute cutoff works (fake clock).
  - The snapshot fallback to the MQTT image works.
- **Frigate post-install:** the root-filesystem refusal rule, using a stubbed `df`.

### 8.2 Live (crow + the real doorbell)

| # | check | steps |
|---|---|---|
| L1 | LV + Frigate | [KEVIN] approves the LV creation (sudo); Frigate is reinstalled and healthy; port probes from the LAN and from another tailnet node all fail |
| L2 | Ring login | [KEVIN] enters his Ring email and password in "Connect Ring", then the 2FA code from his phone; ring-mqtt connects; [KEVIN] sees the new authorized device in the Ring app |
| L3 | HA | [KEVIN] adds the MQTT integration in HA (password copied from Crow → Passwords); the doorbell's ding, motion and battery entities appear |
| L4 | Ding | [KEVIN] presses the doorbell → a Crow notification within 3 s; a clip appears in Frigate/`/mnt/frigate` within 1 minute; the Ring app still receives its normal ding notification |
| L5 | Live view | [KEVIN] opens the doorbell live view in the dashboard → video within 5 s; closes it → ring-mqtt logs the stream ending within about 15 s |
| L6 | Kiosk | kiosk acceptance A10 (K4) |

## 9. Risks

- **R1: Ring cloud dependency and ToS.**
  - ring-mqtt uses Ring's unofficial API. Ring can break it, and every stream goes through Ring's cloud.
  - Mitigation: none beyond pinning the version and accepting that it can break. When it does, the display degrades to "no doorbell pop". Nothing else depends on it.
- **R2: Battery doorbell.**
  - Each ding-triggered stream costs battery. The event window and viewer caps bound this.
  - If the doorbell is battery-powered (Q1), the plan sets the event window to 30 s and turns off motion-triggered recording by default.
- **R3: Motion notifications pause while streaming.** This is upstream behavior. The 10-minute viewer cap and the 60 s auto-close of the kiosk pop keep the pause short.
- **R4: The `init-ring-mqtt.js` stdin flow** may need a TTY. Spike first; there is a fallback (§4.2).
- **R5: Event stream without Ring Protect.** `_event` streams need a Protect plan. This design uses only `_live`, so it works without Protect. With Protect, Ring's own cloud recordings remain the primary record and Frigate's clips are a local copy.
- **R6: LV space.** Using 40 of the 44.58 GB unallocated leaves little for future LVM needs, such as snapshots before upgrades. Q3.

## 10. Open questions for Kevin

- **Q1:** Which Ring doorbell model is it, and is it **battery or hardwired**? This sets the event-window length and whether motion triggers recording.
- **Q2:** Do you have a **Ring Protect** plan? It doesn't block the design, but it decides whether Frigate's clips are the only recording.
- **Q3:** OK to carve a **40 GB LVM volume** for Frigate out of the 44.58 GB unallocated in `vgmint`? The alternative is a capped directory on `/mnt/external`, which is NTFS over USB with the fallback hazard described in C-D4.
- **Q4:** OK to use **ring-mqtt only** (via HA's MQTT integration) instead of adding HA's core Ring integration too? And OK to keep the rotating Ring token with ring-mqtt rather than in the Crow keychain, with only the Ring password optionally in the keychain (§6)?
- **Q5:** Any cameras other than the doorbell for Frigate now, such as local RTSP or ONVIF cameras? If not, Frigate's detector runs only during event windows.

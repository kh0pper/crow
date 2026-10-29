---
title: Kiosk Mode
---

# Kiosk Mode

Kiosk mode turns a Crow display into a full-screen [AI Companion](/architecture/companion) — an animated avatar you can talk to. It's how a tablet on the counter, a screen in the studio, or a wall display becomes a hands-free Crow surface.

## Launching

Open the companion at its own address — port `12393` on the Crow host — in a full-screen browser on the display. The browser asks for the microphone (and the camera, if face tracking is on) the first time.

The Crow's Nest header no longer has a **Companion** button. Its one button, the bird, opens the tray on a tap and **Talk to Crow** on a long press; Talk to Crow is the [Kiosk display](/architecture/kiosk) page (your Ramble bird, tap to talk), not the avatar companion.

Music or radio you start from Talk to Crow plays in the dashboard's **player bar** at the bottom of the page, not inside the overlay. It keeps playing after you close the overlay and while you move between panels; the bar's buttons pause, skip and stop it, and a reload of the page brings the bar back (tap ⏯ if the browser held the sound back). It ends when you stop it or log out.

## Who answers, and hand-offs

Every display answers as **Crow**, the same voice bot as your glasses and Talk to Crow on your phone. A kiosk is no longer bound to a bot of its own; Crow's persona, model and tool limits are set once on the **Crow** voice bot in the [Bot Builder](/guide/bot-builder). What stays per device is the look of the companion: the avatar and the kiosk features (avatar animation, pet/idle mode, social chat, memory). Set them on a bot's **Basics** tab: choose the channel **AI Companion (kiosk)**, pick or pair the display, and fill in the avatar and features. Pairing the display itself is done in the Kiosk panel.

Crow can hand a bigger job to one of your bots. A kiosk is a shared screen, so a yes spoken in the room is never enough: Crow sends a notification to your phone, and you tap Confirm there. When the bot finishes, one notification opens what it made, and if you are still talking to the kiosk Crow says the bot finished. You can ask "how's writer doing?" and say "stop writer" or "stop it"; Crow asks first (on a kiosk, again on your phone) and whatever the bot already made is kept. Which bots Crow may hand work to is set in Crow's voice settings in Bot Builder (**Hand-offs**). See [the kiosk architecture](/architecture/kiosk#hand-offs).

The avatar takes effect on the next kiosk session. The feature toggles apply at different layers: device-config features (`social_chat`, `face_tracking`) are fetched and applied on each kiosk page load; config-gen features (`avatar_model`, `memory_integration`) are baked into the generated companion config and only take effect after a config regeneration + container restart. See the [`companion_features` semantics table](/architecture/companion) for the full breakdown.

The model pair is shared by every display because one companion container has a single LLM `base_url` (the gateway's [`/llm/v1` router](/architecture/companion)). A kiosk that genuinely needs a *different* model pair needs its **own companion container** (own port + `conf.yaml`).

## Social / chat features

The companion's chatroom and DM features are gated by the per-device `social_chat` toggle, so a public-facing kiosk can run avatar-only (no social UI) while a personal display keeps full chat. Toggle it on the bot's Basics tab (channel **AI Companion (kiosk)**).

## Related

- [AI Companion architecture](/architecture/companion) — the engine, model router, and escalation
- [Bot Builder](/guide/bot-builder) — defining the agent a kiosk runs
- [Meta Glasses](/guide/meta-glasses) — the sibling voice channel and device-pairing flow

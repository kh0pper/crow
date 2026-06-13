---
title: Kiosk Mode
---

# Kiosk Mode

Kiosk mode turns a Crow display into a full-screen [AI Companion](/architecture/companion) — an animated avatar you can talk to. It's how a tablet on the counter, a screen in the studio, or a wall display becomes a hands-free Crow surface.

## Launching

In [Crow's Nest](/architecture/dashboard), click the **Companion** button in the header (shown when a companion is available). The avatar opens full-screen in an overlay; press **Esc** or the exit button to leave. The state is remembered, so a dedicated kiosk re-enters the companion automatically on load.

Under the hood the overlay loads the companion (`:12393`) in an iframe with microphone/camera/autoplay granted. If the companion host is unreachable, a visible error replaces the blank frame and the exit button stays available.

## Per-device customization

A kiosk is a **device** bound to a [Bot Builder](/architecture/bot-builder) agent — the same binding model as [Meta Glasses](/guide/meta-glasses). Different displays can run different bots:

```
kitchen-tablet → "Chef"  (avatar A · voice A · social off)
studio-display → "Aide"  (avatar B · voice B · social on)
```

Bind a device in the bot's **Gateways** tab → type **AI Companion**:

1. **Paired device** — pick the kiosk device, or simply **type a name** in the "…or pair a new kiosk" field and press Save: Crow creates and connects the device for you in one step (no Meta Glasses bundle required). Devices paired in the Meta Glasses panel also appear here; kiosks reuse that store, tagged `device_kind:"companion"`.
2. **Avatar** — the Live2D model that renders for this kiosk.
3. **Hearing style** — push-to-talk, wake word, or always listening.
4. **Voice idle timeout** — seconds of silence before the pet/idle animation.
5. **Features** — toggle avatar animation/lip-sync, pet/idle mode, social (chatroom & DM) features, and automatic memory integration.

Saving sets the device's `bound_bot_id` and stores the toggles as `companion_features`. Persona and avatar take effect on the next kiosk session; the feature toggles apply live.

### What is and isn't per device

| Per device | Shared across the container |
|------------|-----------------------------|
| Persona, avatar, voice | The fast→escalate **model pair** |
| `companion_features` (avatar animation, pet mode, social/chat, memory) | The MCP tool set |
| Bound bot | |

The model pair is shared because one companion container has a single LLM `base_url` (the [model proxy](/architecture/companion)). A kiosk that genuinely needs a *different* model pair or tool scope needs its **own companion container** (own port + `conf.yaml`).

## Social / chat features

The companion's chatroom and DM features are gated by the per-device `social_chat` toggle, so a public-facing kiosk can run avatar-only (no social UI) while a personal display keeps full chat. Toggle it in the Gateways tab.

## Related

- [AI Companion architecture](/architecture/companion) — the engine, model proxy, and escalation
- [Bot Builder](/guide/bot-builder) — defining the agent a kiosk runs
- [Meta Glasses](/guide/meta-glasses) — the sibling voice channel and device-pairing flow

---
title: Kiosk Mode
---

# Kiosk Mode

Kiosk mode turns a Crow display into a full-screen, hands-free voice surface — your Ramble bird, tap to talk — so a tablet on the counter, a screen in the studio or a wall display becomes a Crow you can simply speak to. It is the [Kiosk display](/architecture/kiosk) page.

> Kiosks, glasses, the phone and Talk to Crow in the dashboard all answer as the same **Crow voice bot** (`crow.voice`). There is no per-device avatar front end, no separate display page and no extra port to open.

## Launching

Open the [Kiosk display](/architecture/kiosk) page full screen on the display (the Kiosk panel pairs the display and gives you its address). The browser asks for the microphone the first time.

The Crow's Nest header has one button, the bird: a tap opens the tray, a long press opens **Talk to Crow**.

Music or radio you start from Talk to Crow plays in the dashboard's **player bar** at the bottom of the page, not inside the overlay. It keeps playing after you close the overlay and while you move between panels; the bar's buttons pause, skip and stop it, and a reload of the page brings the bar back (tap ⏯ if the browser held the sound back). It ends when you stop it or log out.

## Who answers, and hand-offs

Every display answers as **Crow**, the same voice bot as your glasses and Talk to Crow on your phone. A kiosk is not bound to a bot of its own; Crow's persona, model and tool limits are set once on the **Crow** voice bot in the [Bot Builder](/guide/bot-builder). What stays per device is the pairing and its kiosk settings (follow-up, memory, animation, sleep hours, theme), set in the Kiosk panel.

Model routing for every voice surface is the gateway's in-process [`/llm/v1` router](/developers/configuration): a fast local model answers (escalating to the bigger one on a leading `!escalate` or a tool-shaped turn). The pair comes from the voice role in Settings → Models, and `COMPANION_FAST_MODEL` / `COMPANION_ESCALATION_MODEL` still override it.

Crow can hand a bigger job to one of your bots. A kiosk is a shared screen, so a yes spoken in the room is never enough: Crow sends a notification to your phone, and you tap Confirm there. When the bot finishes, one notification opens what it made, and if you are still talking to the kiosk Crow says the bot finished. You can ask "how's writer doing?" and say "stop writer" or "stop it"; Crow asks first (on a kiosk, again on your phone) and whatever the bot already made is kept. Which bots Crow may hand work to is set in Crow's voice settings in Bot Builder (**Hand-offs**). See [the kiosk architecture](/architecture/kiosk#hand-offs).

## Typing to Crow, and turning voice off

The keyboard button on the page (**Type a message**) opens a message box: type what you want, tap **Send**, and Crow answers as it would to a spoken question. It is there on the phone's **Talk to Crow**, and on a kiosk display. On a display the page shows its own on-screen keyboard when you tap the message box (QWERTY, Shift, a ?123 numbers layer, Space, Backspace and Send; Spanish adds ñ), until a physical keyboard is used, while the phone's Talk to Crow uses the phone's own keyboard. Adding `?osk=1` or `?osk=0` to the display address forces it on or off.

The speaker button turns voice off with one tap (**Turn voice off**): you are not listened to, spoken replies and spoken lines are not spoken, and what Crow would have said appears on the screen as text instead (the timer's chime still sounds). A tap on it again (**Turn voice on**) brings the microphone and the spoken replies back. The choice is kept on that device, so a display set to text comes back in text after a reload.

A typed message can ask for a hand-off just like a spoken one, and it is still confirmed on your phone: what decides is the screen the message came from, not whether you typed or spoke it.

## Related

- [Kiosk display architecture](/architecture/kiosk) — the page, its tools and the hand-off rules
- [Bot Builder](/guide/bot-builder) — Crow's voice bot and the other bots it can hand work to
- [Meta Glasses](/guide/meta-glasses) — the sibling voice channel and device-pairing flow
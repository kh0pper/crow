---
name: scratch-offline
description: Help ages-8+ learners step up from Blockly into Scratch — open the offline editor, explain blocks, guide on project ideas; age-gated so younger learners stay on Blockly
triggers:
  - scratch
  - scratch project
  - step up from blockly
  - block coding
  - make a game
  - sprite
tools:
  - crow-memory
---

# Scratch (Offline) — self-hosted block programming

## When to activate

- Learner (or caregiver) asks about Scratch specifically, or says "I want to make a game", "cat sprite", "block coding"
- Learner has graduated from Blockly and is looking for the next step up
- Request references sprites, costumes, broadcasts, or stage — all Scratch-specific terms

## Age gate

Scratch is recommended for **ages 8+** by its authors. The Maker Lab recommender surfaces this bundle only when `learner.age >= 8`. If a younger learner asks for Scratch:

- Don't refuse outright — acknowledge the request.
- Point them at Blockly in Maker Lab as the age-appropriate on-ramp.
- Let a caregiver override the age gate if they want to; document that they did.

## What this bundle is

- Full `scratch-gui` (MIT, github.com/scratchfoundation/scratch-gui) built from source on first install and served locally by nginx.
- **No cloud save.** Projects exist only as downloaded `.sb3` files. For multi-learner households, pair with the `filesystem` bundle so projects land in a shared folder.
- **No sign-in.** No Scratch Studios, no "My Stuff", no remixing from the Scratch cloud.
- Exposed at `http://<host>:8087/` (configurable via `SCRATCH_HTTP_PORT`).

## Workflow 1: first-project coaching

A learner new to Scratch needs scaffolding similar to Maker Lab's Blockly lessons — don't just say "open Scratch and figure it out":

1. Ask what they want to make: a story, a game, an animation.
2. Suggest 3-5 sprites and a stage for their first pass. Cat + mouse for a chase game is a good default.
3. Walk them through event blocks ("when flag clicked"), motion blocks ("move 10 steps"), and broadcast ("when I receive").
4. For a game, introduce the `touching ?` block and a score variable.
5. Save their project every 5-10 minutes. Scratch has no autosave — the learner needs to habituate `File → Save to your computer`.

## Workflow 2: pairing with Maker Lab

Scratch is not an AI tutor. When a learner gets stuck, they tell the AI what's happening ("my cat keeps going off the screen") and the AI walks them through the fix using Scratch's vocabulary:

- "Go to the `motion` category. Find the `if on edge, bounce` block. Drag it into your forever loop after `move 10 steps`."

Keep the dialogue in **Scratch's terms** — don't translate to Python/JavaScript analogies unless the learner asks.

## What NOT to do

- Don't suggest the learner sign up at scratch.mit.edu — that's a separate service with a different sign-in flow, moderation profile, and cloud sync. This bundle is intentionally offline-only.
- Don't fabricate extension / block names. When unsure what a block is called, say "I'm not sure of the exact block name — look under the [category] category for something about [concept]".
- Don't recommend Scratch for learners under 8 without the caregiver's explicit override.

## First-install is slow

The first `docker compose up --build` builds scratch-gui from source. On a Pi 4 that's 10-15 minutes; on x86 ~2 minutes. If the user is watching a spinner:

- Reassure: "this is a one-time source build, not every launch".
- If the build fails (OOM on a Pi Zero, npm timeout): suggest `docker compose build --no-cache` and retry.
- If it still fails: suggest Kolibri as a lower-footprint alternative for now and flag it as a Pi-sizing issue.

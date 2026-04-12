---
name: kolibri
description: Route learners to offline-first Kolibri learning content — recommend channels, suggest lessons by topic/age, pair with Maker Lab's scaffolded tutor
triggers:
  - kolibri
  - find a lesson
  - teach me about
  - i want to learn
  - homework help
  - math practice
  - reading practice
  - science video
  - khan academy
tools:
  - crow-memory
  - crow-projects
---

# Kolibri — Offline-First Learning Platform

## When to activate

- Learner asks to learn about a topic ("teach me fractions", "i want to watch a science video")
- Parent / teacher asks for recommended content by age / subject ("what should my 7-year-old watch after dinner?")
- User asks about offline learning, classroom mode, or Kolibri specifically
- Request for "homework help" or practice on a specific subject with a school-aged learner in context

## What Kolibri is

- Self-hosted learning platform from Learning Equality (learningequality.org). Free, open-source, MIT.
- Runs on a Pi 4 comfortably. 512 MB RAM floor.
- Content catalog = "channels" curated by the global Learning Equality community: Khan Academy, CK-12, Touchable Earth, Storyweaver, Cambridge University Press ELT, and ~200 more.
- Offline-first: once channels are imported, learners don't need internet.
- LAN-sync: two Kolibri instances on the same network auto-discover and share content. Good for "one Pi in the closet, five tablets in the house" setups.

## Workflow 1: recommend a channel

1. Ask the learner (or a caregiver) their age band and topic: "are we doing K-2 reading, 3-5 STEM, or something for older kids?"
2. Match to a channel (without guessing at URLs — point them at the Kolibri UI):
   - **K-2 general**: Khan Academy Kids, Touchable Earth, Storyweaver
   - **3-5 STEM**: CK-12, Khan Academy, Touchable Earth (geography/cultures)
   - **6-8 math**: CK-12, Khan Academy
   - **Reading**: Storyweaver, Pratham Books, African Storybook
3. Tell them the channel name and direct them to `Channels → Import` in the Kolibri admin UI. Do NOT fabricate channel URLs or exact MB sizes — Kolibri Studio is the source of truth and sizes change.
4. After import, learners can browse to the channel via Kolibri's `Learn` page. Crow does not need to intermediate.

## Workflow 2: pair with Maker Lab

Kolibri is a sibling of Maker Lab, not a competitor:

- **Kolibri**: "watch a video", "do practice problems", "read a book" — structured content.
- **Maker Lab**: "ask the tutor why this works", "explore with Blockly", "have a Socratic conversation" — scaffolded AI dialogue.

When a learner finishes a Kolibri lesson and asks a follow-up question, route to Maker Lab's tutor. When Maker Lab's tutor hits the edge of a topic ("I don't have a lesson on this"), suggest the right Kolibri channel.

## Workflow 3: classroom / multi-device

If the user mentions "classroom" or "multiple kids on separate devices":

1. Install Kolibri on the server (a Pi works).
2. Other devices connect via the Kolibri app (Android/iOS) or a browser pointed at the server's IP.
3. Kolibri auto-discovers LAN peers — a second Kolibri instance can mirror content for redundancy.
4. Set up learner accounts under `Facility → Users`. Assign them to classes, assign lessons, track progress.

## Transparency

- Kolibri first-run setup (superuser + facility) is done in the Kolibri UI, not by the AI. If the user asks Crow to "set up Kolibri", point them at `http://<host>:8085/` (or whatever `KOLIBRI_HTTP_PORT` resolves to).
- Importing channels consumes disk: a K-5 STEM starter set is ~5-10 GB. Say so before the user commits.
- Kolibri content licenses vary by channel. Learning Equality reviews channels for openness before they land in the catalog; the AI should not assume all content is CC0 / public domain.

## What NOT to do

- Don't scrape or fabricate lists of channels — Kolibri Studio's catalog evolves monthly.
- Don't recommend importing every channel "just in case" — a Pi with 32 GB SD will fill up fast.
- Don't treat Kolibri as an AI tutor. It's a content library. Tutoring lives in Maker Lab.

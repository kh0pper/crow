---
name: studio-preferences
description: Use when the operator states a lasting musical taste or working rule for Studio — a genre, an arrangement density, an instrument, a loudness target, a mix or review habit, something never to do — or asks what you remembered, corrects a stored rule, or says not to remember it.
triggers:
  - studio preferences
  - remember my taste
  - from now on
  - never do that again
  - prefer my bass
  - keep that in mind
  - don't store that
  - what do you remember
  - mis preferencias
  - recuerda que
  - no lo recuerdes
  - guardar preferencia
tools:
  - studio
  - crow-memory
---

# Studio Preferences

A song is written once; the taste behind it should not have to be restated. Studio's `studio_*` tools keep nothing between sessions, so preferences live in Crow memory: stored when stated, recalled before you work, shown in one line. Store and tell — never write one silently.

## Preference or one-off?

Test: would the rule still hold in a different song next week? Yes → preference, store it. No → an instruction for this song: do it, drop it.

| Store (preference) | Do not store (this song) |
|---|---|
| Genre/style: "no drones under my songs" | "swing this verse" |
| Density: "sparse bass, one or two notes a bar" | "thin out bar 3" |
| Sounds: "pads stay SpectraVoice" | "use a Generator here" |
| Loudness/mix: "aim −14 LUFS, peak ≤ −1 dBTP" | "make the chorus 1 dB louder" |
| Review: "always send A/B renders" | "render this now" |
| Never: "never edit the vocal track" | "leave this clip alone today" |

One rejection is not a preference. A rule that names one project carries that project's numeric `project_id` (from `studio_list_songs`); taste that travels does not.

## Storing

- `crow_store_memory` with `category: "preference"`; tags start `studio` then the topics (`"studio, bass, arrangement"`, `"studio, mix, loudness"`, `"studio, review"`).
- Importance 7, or **8** for an explicit always/never — 8 also surfaces in the cross-platform Key Preferences.
- Content is one reusable rule, imperative, in the operator's language, with the number when there is one.
- Search `studio` plus the topic first with `crow_search_memories` (`limit: 50` when there are many rules — the default 10 hides some; hits come back as `[#id]`). If the rule exists, `crow_update_memory` that `id` instead of adding a near-duplicate.
- Show it at once: *[crow: noted your preference — "<short rule>" (studio)]*
- "Don't remember that" / "forget that rule" → `crow_delete_memory` with the `id` from the search and `confirm_token: ""`; the preview quotes the memory: confirm it is the rule they mean, then call again with the returned token — *[crow: memory deleted — "<rule>"]*.
- "Undo that" on its own is the song, not memory — use `studio_undo`. Delete only when the last thing you did was store one; otherwise ask which.

## Reading

- At the start of Studio work and before composing, arranging or mixing: `crow_search_memories` query `"studio"`, `category: "preference"`, `limit: 50`. When the song is in a project — `project_id` from `studio_list_songs`; skip if unknown — search again scoped to it.
- Show *[crow: recalled N studio preferences]* and apply them; when a rule shaped an edit, name it in one clause.
- A request that contradicts a stored rule: quote the rule, ask which wins, wait. If the operator changes their mind, `crow_update_memory` the rule and show the notice again.
- A loudness or balance rule is checkable only through `studio_render`'s `lufs` and `true_peak_db`; tone and masking stay the operator's ear.

## Inferring one

- The same kind of change undone or rejected twice earns a proposal: "Should I remember that you prefer …?" Store it only after a yes.
- Never store an unapproved inference or present it as their words.

## Adapting a skill

A preference that keeps bending a Studio skill is a case for customizing it: **Customize…** in the Skills panel gives the operator their own copy, which then stops getting updates. Propose it, get consent, never edit a skill unasked.

## Worked example

Operator: "I never want drones under my songs, and I like my bass lines sparse. Keep that in mind from now on."

- `crow_search_memories "studio bass"` → nothing yet, so two stores:
  - "Never put drones (held pedal or sustained single-note beds) under a song" — tags `"studio, arrangement, texture"`, importance 8.
  - "Bass stays sparse: 1–2 notes per bar, no fills or runs" — tags `"studio, bass, arrangement"`, importance 7.
- *[crow: noted your preference — "no drones under songs" (studio)]*, and the same notice for the bass rule.
- Reply: both apply from now on, including new scenes; a drone already in the song stays until asked.

## Sources

- Crow `skills/memory-management.md` and `skills/skill-writing.md` (MIT) — memory categories and importance tiers, the store and recall notices, the consent rule for customizing a skill.
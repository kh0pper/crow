# Skill Writing — Dynamic Skill Creation

## Description
This skill enables the AI to create, modify, and propose new skill files (`skills/*.md`) when existing skills don't cover a user's workflow. New skills are only written with **explicit user consent**.

## When to Activate
- User describes a recurring workflow that no existing skill covers
- User explicitly asks for a new skill or automation
- User says "make a skill for..." / "crear una habilidad para...", "automate..." / "automatizar...", "create a workflow for..." / "crear un flujo de trabajo para..."
- A compound workflow is repeated 2+ times and could be codified
- User wants to customize or extend an existing skill
- **Session start**: Check memory for `skill-gap` or `skill-writing-queue` entries logged by the reflection skill — propose deferred fixes

*Match intent in any language — the above phrases are English/Spanish examples. See `skills/i18n.md`.*

## Consent Protocol

**Never create or modify a skill file without asking first.** Follow this flow:

1. **Detect the opportunity**: Notice a workflow gap or user request
2. **Propose the skill**: Describe what the skill would do, which tools it would use, and what triggers it
3. **Get explicit consent**: Wait for user approval before writing anything
4. **Draft and present**: Show the skill content to the user for review
5. **Write on approval**: Create the file in `skills/` only after the user confirms
6. **Register the skill**: Update `CLAUDE.md` skill list and `superpowers.md` trigger table

### Consent phrases (user must say something like):
- "Yes, create that skill" / "Sí, crea esa habilidad"
- "Go ahead and make it" / "Adelante, hazlo"
- "That sounds good, write it" / "Suena bien, escríbelo"
- "Sure, add that" / "Claro, agrégalo"

Match consent intent in **any language** — these are examples, not an exhaustive list.

### Do NOT proceed if:
- User says "maybe later" / "quizás después" or "not now" / "ahora no"
- User hasn't explicitly confirmed
- The skill would override or conflict with an existing one (warn first)

---

## Skill File Structure

Every skill file in `skills/` should follow this template. **Skill files are always written in English** (canonical source). Claude translates on the fly when communicating with the user.

```markdown
# Skill Name — Short Description

## Description
One paragraph explaining what this skill does and when it's useful.

## When to Activate
- Trigger condition 1 (EN) / Trigger condition 1 (user's language)
- Trigger condition 2 (EN) / Trigger condition 2 (user's language)
- Include trigger phrases in English + user's preferred language + any other languages used in past sessions

## Workflow

### Step 1: [Name]
- What to do
- Which tools to use
- Expected output

### Step 2: [Name]
...

## Tools Used
- **tool-name**: How it's used in this workflow
- **tool-name**: How it's used in this workflow

## Language Adaptation
- Note any language-specific considerations for this skill
- Reference `skills/i18n.md` for the full protocol

## Tips
- Best practices specific to this skill
- Common pitfalls to avoid
```

---

## Writing Guidelines

### Structure
- **Clear trigger conditions**: When should this skill activate? Be specific.
- **Step-by-step workflow**: Break the process into numbered steps with tool calls
- **Tool references**: List which MCP tools are involved and how
- **Tips section**: Include gotchas, best practices, and edge cases

### Quality
- Keep skills **focused**: One skill = one workflow. Don't combine unrelated tasks.
- Keep skills **actionable**: Every step should map to a concrete tool call or decision
- Keep skills **discoverable**: Use clear keywords in the "When to Activate" section
- Keep skills **composable**: Skills should work alongside other skills, not replace them

### Creativity
When the user gives a vague request like "help me manage my mornings" or "I want a weekly review process", get creative:
- Think about which tools could combine in useful ways
- Suggest workflows the user might not have considered
- Draw on the full set of available MCP servers
- Consider memory integration — what should be stored/recalled automatically?

### Naming
- Filename: `skills/kebab-case-name.md`
- Title: `# Title Case Name — Short Description`
- Keep names descriptive but concise

---

## Post-Creation Checklist

After writing a new skill file:

1. **Update `CLAUDE.md`**: Add the skill to the appropriate category in the Skills section
2. **Update `superpowers.md`**: Add trigger keywords to the Trigger Table (include both English and user's preferred language columns)
3. **Store in memory**: Use `store_memory` to record that a new skill was created, what it does, and why
4. **Inform the user**: Confirm the skill is active and explain how to trigger it
5. **Create a watch item** (content in user's language, tags bilingual per `skills/i18n.md`):
```
store_memory({
  content: "<in user's language: Skill watch: skill-name.md created on date. Purpose: what it does. Monitor for: activation, friction, trigger accuracy.>",
  category: "learning",
  tags: "skill-watch, <localized:vigilancia-de-habilidad>, skill-metrics, <localized:métricas-de-habilidad>, <skill-name>",
  importance: 7
})
```
6. **Log skill creation in metrics** (content in user's language, tags bilingual):
```
store_memory({
  content: "<in user's language: Skill metrics: skill-name.md — Created: date. Usage count: 0. Friction incidents: 0. Refinements: 0.>",
  category: "learning",
  tags: "skill-metrics, <localized:métricas-de-habilidad>, <skill-name>",
  importance: 6
})
```

---

## Modifying Existing Skills

When a user wants to change an existing skill:

1. Read the current skill file
2. Propose the specific changes
3. Get user consent (unless it's a minor auto-fix from reflection — see below)
4. Edit the file (don't rewrite from scratch unless necessary)
5. Update trigger table if triggers changed
6. Store the change in memory
7. Update skill metrics with the refinement

### Reflection-Sourced Modifications (Auto-Fix Protocol)

When changes originate from the reflection skill's Phase 7 handoff:

**Minor fixes — auto-apply without asking:**
- Add/edit a tip or best practice
- Reorder steps for clarity
- Fix a tool name or reference
- Add an edge case or caveat

After auto-applying, inform the user **in their preferred language**:
- EN: "Auto-applied a minor fix to `<skill>.md`: <what changed>. This was identified during reflection."
- ES: "Se aplicó automáticamente una corrección menor a `<skill>.md`: <qué cambió>. Esto se identificó durante la reflexión."

**Major changes — full consent protocol:**
- New workflow steps, trigger conditions, structural rewrites, new skills, merges/splits, tool changes
- Follow the standard consent flow (propose → get approval → implement)

### Deferred Gap Pickup (Session Start)

At session start, after loading context and language preference:
1. Search memory for entries tagged `skill-gap` or `skill-writing-queue` (search in both English and user's language)
2. Show what was found: *[crow: found \<N\> deferred skill gaps from previous sessions]*
3. For each unresolved gap, show its classification:
   *[crow: processing gap — "\<description\>". Classification: \<minor/major\>.]*
   - Minor: auto-apply, show FYI with what changed and "say 'undo that' to revert"
   - Major: propose the change to the user via consent protocol
4. After processing, store a summary: "Processed N deferred skill gaps from reflection. Applied: X. Proposed: Y."

---

## Example: Creating a "Weekly Review" Skill

**User**: "I want to do a weekly review every Sunday"

**AI response**: "I can create a skill for that. Here's what it would do:
- Check all Trello cards completed this week
- Summarize email threads from the week
- Review calendar for next week's events
- Check research project progress
- Generate a summary and store it in memory

Want me to create this as `skills/weekly-review.md`?"

**User**: "Yes, go ahead"

**AI**: Creates the skill file, updates CLAUDE.md and superpowers.md, stores the creation in memory.

---

## Skill Effectiveness Tracking

### Usage Logging
Each time a skill is activated during a session, increment its usage count:
```
store_memory({
  content: "Skill usage: <skill-name>.md activated on <date>. Context: <brief description of what triggered it>.",
  category: "learning",
  tags: "skill-metrics, skill-usage, <skill-name>",
  importance: 4
})
```

### Metric Queries
Before proposing changes to a skill, check its history:
1. `recall_by_context("skill-metrics <skill-name>")` — Get usage count, friction incidents, refinement history
2. If friction rate is high (friction in 40%+ of uses) → recommend a structural rewrite rather than patches
3. If a skill has 0 usage after 5+ sessions → consider whether it's discoverable enough or should be removed

### Watch Item Evaluation
When reflection encounters a `skill-watch` entry:
1. Check if the skill has been used since creation
2. If used: did it cause friction? → update metrics accordingly
3. If unused: are the trigger conditions too narrow? → propose trigger expansion
4. After 3+ successful friction-free uses → remove the watch item (the skill is stable)

### Transparency for Metrics & Watch Items
Surface watch item evaluations to the user:
*[crow: watch item evaluated — \<skill\>.md has \<N\> uses, \<N\> friction. Status: \<stable/needs attention\>.]*

When removing a watch item:
*[crow: watch item removed — \<skill\>.md is stable after N friction-free uses]*

Usage logging (each skill activation) stays silent — too frequent and low-value for FYI lines.

---

## Compound Skill Detection

Watch for these patterns that suggest a new skill would help:

- **Repeated multi-step workflows**: User asks for the same sequence of actions across sessions
- **"Every time I..." statements**: User describes a recurring process
- **Tool combinations**: User regularly uses the same 3+ tools together
- **Frustration with manual steps**: User wishes something was automatic
- **Domain-specific workflows**: Academic writing, sprint planning, content creation, etc.

When detected, suggest: "I notice you do [X] regularly. Want me to create a skill for that so it's faster next time?"

### Declined Skill Proposals
If a user declines a skill creation proposal, store the observation for reflection:
```
store_memory({
  content: "Skill proposal declined: <what was proposed>. User reason: <if given>. Monitor whether this workflow causes friction without a dedicated skill.",
  category: "learning",
  tags: "skill-declined, skill-metrics",
  importance: 5
})
```
Reflection can revisit this — if the workflow causes friction in future sessions, re-propose with updated reasoning.

### Transparency for Re-proposals
When re-proposing a previously declined skill, always use a checkpoint:
**[crow checkpoint: Re-proposing skill "\<name\>" (previously declined on \<date\>). New reasoning: \<brief\>. Say "no" to decline again.]**

This ensures the user knows they already said no once and can quickly decline again if they still don't want it.

---

## Language Adaptation

All skill-writing interactions must follow `skills/i18n.md`:

### Skill Proposals
- Present proposals in the user's preferred language (description, rationale, consent question)
- The skill **file itself** is always written in English (canonical source)
- Example: A Spanish-speaking user sees the proposal in Spanish, but the generated `.md` file is in English

### New Skill Trigger Phrases
When creating a new skill's "When to Activate" section, include trigger phrases in:
1. English (always — canonical)
2. User's preferred language (always)
3. Other languages the user has used in past sessions (check memory for language history)

### Deferred Gap Presentation
- When presenting deferred skill gaps at session start, translate the description into user's preferred language
- The gap was stored in user's language, so it should be naturally readable

### Metrics and Watch Items
- All `store_memory` calls for metrics use bilingual tags (English + user's language)
- Content written in user's preferred language

### Compound Skill Detection
- "I notice you do [X] regularly. Want me to create a skill for that?" → say this in user's language
- Example (ES): "Noto que haces [X] regularmente. ¿Quieres que cree una habilidad para eso?"

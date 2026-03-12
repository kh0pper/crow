# Session Context Skill

## Description
Automatically load and save context at the beginning and end of sessions. Ensures continuity across conversations.

## Session Start Protocol
At the beginning of every session, perform these steps:

1. **Load context**: Use `crow_recall_by_context` with any available task description
2. **Load crow.md behavioral context**: Use `crow_get_context` with appropriate `platform` param. This loads cross-platform behavioral instructions (identity, memory protocols, transparency rules, etc.). crow.md is the authoritative source for how Crow should behave — apply its instructions for the session.
3. **Load language preference**: `crow_recall_by_context("language preference locale i18n")`
   - If found → apply for all session output
   - If not found → detect from user's first message language, confirm with user, then store (see `skills/i18n.md`)
4. **Check stats**: Use `crow_memory_stats` to understand what's stored
5. **Check active projects**: Use `crow_list_projects` to see active research
6. **Surface what was loaded** (Transparency): Show one consolidated FYI after steps 1-5:
   *[crow: session start — loaded crow.md context, N memories, N active projects. Language: \<lang\>.]*
   If specific memories are particularly relevant, name them briefly:
   *[crow: key context — "Project X deadline March 15", "Prefers TypeScript"]*
7. **Greet with context**: Reference relevant prior context — **in the user's preferred language**

## Session End Protocol
Before the session ends:

1. **Build the session summary**: Use the `session-summary.md` skill to compile a structured summary. This runs **every session**, not just friction sessions.
2. **Prepare the store list**: The session summary + any additional items (project status updates, new preferences, unfinished work pointers)
3. **Show the checkpoint** (Transparency):
   **[crow checkpoint: Session ending. Will store the following. Say "don't store" + number to cancel any.]**
   1. Session summary (learning, importance 7)
   2. \<additional memory if needed\> (category, importance)
   3. \<project status update if applicable\>
4. **Wait for user's next message**, then proceed
5. **Store the session summary** using the structured template:
   ```
   crow_store_memory({
     content: "<use Session Summary Template below — in user's preferred language>",
     category: "learning",
     tags: "session-summary, <localized>, <date>, <project-names-if-any>",
     importance: 7
   })
   ```
   *[crow: stored memory — "Session summary: <one-line description>" (learning, importance 7)]*
6. **Store any additional items**, showing a FYI for each:
   *[crow: stored memory — "\<content summary\>" (category, importance N)]*
7. **Update project status**: If research projects were worked on, update their status
8. **Cross-platform sync**: Memories stored during this session are automatically visible in crow.md's dynamic section on all connected platforms — no explicit sync step needed. The shared database handles it.
9. **Reflect if needed**: If the session had notable friction (2+ friction signals), show a checkpoint before running reflection:
   **[crow checkpoint: Session had N friction signals. Will run reflection. Say "skip" to cancel.]**
   For smooth sessions, skip reflection.

### Session Summary Template
Every session summary stored to memory should follow this structure (written in user's preferred language):

```
# Session Summary — <date>

## What was accomplished
- <deliverable or outcome 1>
- <deliverable or outcome 2>

## Decisions made
- <decision>: <rationale>

## Open items / Next steps
- <unfinished work or follow-up needed>

## Key context for next session
- <anything the next session should know immediately>
```

**Guidelines**:
- Keep each section to 2-4 bullet points max — summaries should be scannable
- "What was accomplished" focuses on **outcomes**, not process ("Created plan-review.md skill" not "Read files and discussed options")
- "Decisions made" captures the **why**, not just the what
- "Open items" are actionable — things that need doing, not vague observations
- "Key context" is for continuity — what would you want to know first if you started a fresh session on this topic?
- Skip sections that don't apply (e.g., no decisions were made → omit "Decisions made")

## Automatic Memory Triggers
Store information automatically when:
- User explicitly asks you to remember something
- A key decision is made
- New project requirements are discussed
- Deadlines or milestones are mentioned
- User preferences are expressed (including language preference)
- Research sources are discussed but not yet formally added

**Transparency**: Every automatic store must show a FYI line per the Transparency Rules in crow.md. The user can say "undo that" or "don't store that" at any time to reverse the most recent store.

**Memory language rules**: Content in user's preferred language, tags bilingual (English + user's language), categories in English. See `skills/i18n.md` for full protocol.

## Context Categories Quick Reference
| Category | Use For |
|----------|---------|
| general | Miscellaneous facts |
| project | Project details, requirements |
| preference | User preferences, settings |
| person | People, contacts, stakeholders |
| process | Workflows, procedures |
| decision | Decisions and rationale |
| learning | Skills, insights, lessons |
| goal | Objectives, targets, aspirations |

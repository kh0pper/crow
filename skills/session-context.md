# Session Context Skill

## Description
Automatically load and save context at the beginning and end of sessions. Ensures continuity across conversations.

## Session Start Protocol
At the beginning of every session, perform these steps:

1. **Load context**: Use `recall_by_context` with any available task description
2. **Load language preference**: `recall_by_context("language preference locale i18n")`
   - If found → apply for all session output
   - If not found → detect from user's first message language, confirm with user, then store (see `skills/i18n.md`)
3. **Check stats**: Use `memory_stats` to understand what's stored
4. **Check active projects**: Use `list_projects` to see active research
5. **Surface what was loaded** (Transparency): Show one consolidated FYI after steps 1-4:
   *[crow: session start — loaded N memories, N active projects. Language: \<lang\>.]*
   If specific memories are particularly relevant, name them briefly:
   *[crow: key context — "Project X deadline March 15", "Prefers TypeScript"]*
6. **Greet with context**: Reference relevant prior context — **in the user's preferred language**

## Session End Protocol
Before the session ends:

1. **Prepare the store list**: Identify what needs to be stored — new learnings, project status updates, unfinished work, decisions made
2. **Show the checkpoint** (Transparency):
   **[crow checkpoint: Session ending. Will store the following. Say "don't store" + number to cancel any.]**
   1. \<memory description\> (category, importance)
   2. \<memory description\> (category, importance)
   3. \<project status update if applicable\>
3. **Wait for user's next message**, then proceed
4. **Store each item**, showing a FYI for each:
   *[crow: stored memory — "\<content summary\>" (category, importance N)]*
5. **Update project status**: If research projects were worked on, update their status
6. **Reflect if needed**: If the session had notable friction (2+ friction signals), show a checkpoint before running reflection:
   **[crow checkpoint: Session had N friction signals. Will run reflection. Say "skip" to cancel.]**
   For smooth sessions, skip reflection.

## Automatic Memory Triggers
Store information automatically when:
- User explicitly asks you to remember something
- A key decision is made
- New project requirements are discussed
- Deadlines or milestones are mentioned
- User preferences are expressed (including language preference)
- Research sources are discussed but not yet formally added

**Transparency**: Every automatic store must show a FYI line per the Transparency Protocol in `CLAUDE.md`. The user can say "undo that" or "don't store that" at any time to reverse the most recent store.

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

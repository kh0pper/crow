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
5. **Greet with context**: Reference relevant prior context — **in the user's preferred language**

## Session End Protocol
Before the session ends:

1. **Store new learnings**: Save any important new information to memory
2. **Update project status**: If research projects were worked on, update their status
3. **Note unfinished work**: Store what was in progress with category "project" and high importance
4. **Store decisions**: Record any decisions made and their rationale
5. **Reflect if needed**: If the session had notable friction (failed tools, user corrections, wasted effort), run the reflection skill (`skills/reflection.md`). For smooth sessions, skip this step.

## Automatic Memory Triggers
Store information automatically when:
- User explicitly asks you to remember something
- A key decision is made
- New project requirements are discussed
- Deadlines or milestones are mentioned
- User preferences are expressed (including language preference)
- Research sources are discussed but not yet formally added

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

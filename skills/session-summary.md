---
name: session-summary
description: Save session summary and key learnings to Crow memory
triggers:
  - session summary
  - summarize session
  - what did we do
  - wrap up
tools:
  - crow-memory
---

# Session Summary

## When to Activate

- User asks for a session summary or says "wrap up" / "what did we do"
- End of a non-trivial session

## Core Principle

**Invoking this skill IS the approval.** Store memories immediately — do not ask for confirmation. Show what was saved afterward with an option to remove.

## Workflow

### 1. Review the Session

Scan the conversation for:
- Deliverables completed (files created/modified, messages sent, research done)
- Decisions made and their rationale
- Process learnings (build quirks, deployment steps, workarounds discovered)
- Unfinished work or next steps
- Key context the next session should know

### 2. Build and Store Immediately

Build the session summary using the template below, plus any additional memories (process learnings, new preferences, project status updates). Store everything in one step — do NOT show a preview or ask for approval first.

```
crow_store_memory({
  content: "<structured summary>",
  category: "learning",
  tags: "session-summary, <date>, <project-names>",
  importance: 7
})
```

Store additional learnings with appropriate category and importance.

### 3. Show What Was Saved

After storing, display a numbered list:

```
[crow: stored N memories]
1. Session summary — <one-line description> (learning, importance 7)
2. <additional memory description> (category, importance N)

**Say "remove N" to undo any.**
```

### 4. Update Project Status

If projects were worked on, update their status with `crow_update_project`.

### 5. Reflect If Needed

If the session had 2+ friction signals (failed tools, user corrections, unexpected blockers), suggest running `/reflection` for deeper analysis. But don't force it — the user can decline.

## Session Summary Template

Use this structure (in user's preferred language):

```
# Session Summary — <date>

## What was accomplished
- <outcome 1>
- <outcome 2>

## Decisions made
- <decision>: <rationale>

## Open items / Next steps
- <unfinished work or follow-up>

## Key context for next session
- <what the next session should know immediately>
```

**Guidelines:**
- 2-4 bullet points per section max — summaries should be scannable
- Focus on **outcomes**, not process ("Created backup.sh script" not "Read files and discussed options")
- "Decisions made" captures the **why**, not just the what
- Skip sections that don't apply
- "Key context" is for continuity — what would you want to know first in a fresh session?

## Language Adaptation

Follow `skills/i18n.md`: content in user's preferred language, tags bilingual, categories in English.

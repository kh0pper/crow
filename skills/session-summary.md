---
name: session-summary
description: Quick session summary — records deliverables, decisions, and next steps
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

- End of every non-trivial session (as part of session-context.md end protocol)
- User asks for a summary of what was accomplished
- User says "wrap up" or "what did we do"

This is the **quick path** — always appropriate, even for smooth sessions. For friction analysis and improvement proposals, use `reflection.md` instead.

## Workflow

### 1. Review the Session

Scan the conversation for:
- Deliverables completed (files created/modified, messages sent, research done)
- Decisions made and their rationale
- Research conducted and sources added
- Unfinished work or next steps
- Key context the next session should know

### 2. Build Summary

Use the structured template (in user's preferred language):

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

### 3. Store in Memory

```
crow_store_memory({
  content: "<structured summary>",
  category: "learning",
  tags: "session-summary, <localized>, <date>, <project-names>",
  importance: 7
})
```

Show transparency line:
*[crow: stored session summary — "<one-line description>" (learning, importance 7)]*

### 4. Update Project Status

If projects were worked on, update their status with `crow_update_project`.

## When to Escalate to Reflection

If the session had 2+ friction signals (failed tools, user corrections, unexpected blockers), suggest running `/reflection` for deeper analysis. But don't force it — the user can decline.

## Language Adaptation

Follow `skills/i18n.md`: content in user's preferred language, tags bilingual, categories in English.

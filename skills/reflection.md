# Session Reflection

A meta-skill for evaluating *how well things went* and proposing concrete fixes. Identifies friction, maps root causes, writes a fix plan, and implements only after user approval.

**Distinct from `session-summary.md`:** Session-summary records *what was done*. Reflection evaluates *how well it went* and fixes problems.

## When to Use

- When a session had notable friction (failed tool calls, user corrections, wasted effort)
- When the user asks to reflect (`/reflection` or "reflect on what went wrong")
- At end of session if 2+ friction signals occurred
- NOT for routine smooth sessions

## Workflow

### Step 1: Catalog Friction Points

Review the session for moments where:
- A tool call failed or required multiple attempts
- The user had to correct or redirect the approach
- A workflow took significantly more steps than expected
- Information was missing or had to be fetched unexpectedly
- The user expressed frustration or had to intervene

### Step 2: Classify Severity

| Level | Meaning | Example |
|-------|---------|---------|
| HIGH | Blocked work or user had to redo | Wrong database used, container misconfigured |
| MEDIUM | Wasted time but self-recovered | Needed 3 tries to find a file, wrong tool first |
| LOW | Minor inconvenience | Extra confirmation step, verbose output |

### Step 3: Map Root Causes

For each friction point, determine:
- **Code/tool bug** — The tool should work but doesn't → needs a code fix
- **Missing/incomplete skill** — The workflow isn't documented → needs skill refinement
- **Behavioral context issue** — crow.md instructions are missing/wrong → needs crow.md update
- **Missing memory** — Context should have been stored earlier → needs memory update
- **External issue** — API down, rate limited, etc. → note for awareness

**Prefer code fixes over skill workarounds.** If a tool should work but doesn't, fix the tool.

### Step 4: Read Relevant Files

Load each skill file, code file, or config that needs changes. Don't propose changes to files you haven't read. Understand the current state before proposing fixes.

### Step 5: Present the Fix Plan

**This is the critical step.** Present a structured plan covering ALL identified friction points:

```
## Reflection Fix Plan

### Fix 1: <friction point> (HIGH/MEDIUM/LOW)
- **Root cause:** <code bug / skill gap / missing memory / etc.>
- **File(s):** <exact paths>
- **Change:** <specific description of what to change>
- **Verification:** <how to confirm the fix works>

### Fix 2: ...

### Memory updates:
- <what to store for next time>
```

**On Claude Code:** Use `EnterPlanMode` to present the plan if available. The user reviews and approves/revises before implementation.

**On other platforms (Claude.ai, ChatGPT, BYOAI chat):** Present the plan inline and explicitly ask: "Should I apply these fixes? Reply with the fix numbers to approve, or 'all' to approve everything."

**Do NOT skip this step.** Do NOT auto-apply fixes without presenting the plan first. The user must see what will change and approve it.

### Step 6: Implement Approved Changes

After user approval:
1. Apply each approved fix (code edits, skill updates, memory stores)
2. Show a brief note for each change applied
3. Run verification steps
4. Commit if code changes were made

### Step 7: Store Reflection

After fixes are applied (or if user declines fixes), store a reflection note:

```
crow_store_memory({
  content: "# Reflection: <date>\n\n## Friction Points\n### 1. <point> (SEVERITY)\n- What happened: <description>\n- Root cause: <classification>\n- Fix applied: <what was changed, or 'deferred'>\n\n## Changes Made\n- <file>: <what changed>\n\n## Open Issues\n- <anything unresolved>",
  category: "learning",
  tags: "reflection, session-review, <date>",
  importance: 8
})
```

## Key Principles

- **Plan before act.** Never apply fixes without presenting a plan and getting approval.
- **Prefer code fixes** over skill workarounds or memory band-aids.
- **Be specific.** "Fix the database issue" is not a plan. "Delete ~/.crow/data/crow.db to eliminate the ambiguous fallback" is.
- **Read before proposing.** Don't suggest changes to files you haven't read.
- **Verify after applying.** Each fix should have a concrete verification step.

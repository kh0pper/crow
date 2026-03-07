# Reflection — Session Summary & Self-Evaluation Skill

## Description
A combined session-summary and reflection meta-skill. Summarizes what was accomplished, evaluates how well it went, identifies friction points, and proposes improvements. Stores everything in crow-memory for continuous improvement.

Can be invoked as `/reflection` or auto-triggered by the superpowers skill when friction accumulates or context is filling up.

## When to Use
- **Auto-trigger**: When superpowers.md detects 2+ friction signals
- **Auto-trigger**: When context window is approaching capacity (~80% full)
- **Manual**: User types `/reflection` or asks to reflect
- **End of session**: As part of the session-end protocol for non-trivial sessions
- **NOT needed**: For routine, smooth, short sessions — just use session-context.md end protocol

## Workflow

### Phase 1: Session Summary
Capture what was accomplished:
1. List deliverables completed (files created, messages sent, research done)
2. List decisions made and their rationale
3. List research conducted and sources added
4. Note any unfinished work or next steps

Store as memory:
```
store_memory({
  content: "<structured summary>",
  category: "project",
  tags: "session-summary, <date>, <project-names>",
  importance: 7
})
```

### Phase 2: Friction Catalog
Review the session for friction points:
- Tool calls that failed or required multiple attempts
- User corrections or redirections
- Workflows that took more steps than expected
- Missing information that had to be fetched unexpectedly
- User frustration or intervention

### Phase 3: Classify Severity

| Level | Meaning | Example |
|-------|---------|---------|
| HIGH | Blocked work or user had to redo | Auth failure on critical API, wrong file overwritten |
| MEDIUM | Wasted time but self-recovered | Search query needed 3 tries, wrong tool used first |
| LOW | Minor inconvenience | Slightly verbose output, extra confirmation step |

### Phase 4: Root Cause Analysis
For each friction point, determine the root cause:
- **Code/tool bug** — The tool should work but doesn't → needs a code fix
- **Missing/incomplete skill** — The workflow isn't documented → needs skill refinement
- **Missing memory** — Context should have been stored earlier → needs memory update
- **External issue** — API down, rate limited, etc. → note for awareness

**Prefer code fixes over skill workarounds.** If a tool should work but doesn't, the right fix is in the code, not adding a "remember to work around this" note to a skill.

### Phase 5: Store Reflection
Store the reflection in crow-memory:

```
store_memory({
  content: "# Reflection: <date>\n\n## Session Topic: <topic>\n\n## Friction Points\n### 1. <point> (HIGH/MEDIUM/LOW)\n- What happened: <description>\n- Root cause: <code bug / skill gap / missing memory>\n- Proposed fix: <specific change>\n\n## Changes Proposed\n- <file>: <what should change>\n\n## Open Issues\n- <anything unresolved>",
  category: "learning",
  tags: "reflection, session-review, <date>, <project-names>",
  importance: 8
})
```

### Phase 6: Propose Improvements
Present a clear list of proposed changes:
1. **Code fixes** — Specific file paths and changes
2. **Skill refinements** — Which skill files need updates
3. **Memory updates** — What should be stored for next time
4. **Verification steps** — How to confirm each fix works

If approved by the user, implement the changes in the current session.

---

## Standalone Mode (`/reflection`)
When invoked standalone (not as part of session end):
- Skip Phase 1 (session summary)
- Focus on Phases 2-6 (friction analysis and improvement)
- Useful for deep-diving into a specific problem mid-session

---

## Integration with Session Protocol
In `session-context.md`, the end-of-session protocol should:
1. Run standard session-end steps (store context, update projects)
2. If the session had notable friction → run this reflection skill
3. If the session was smooth → skip reflection, just do summary

---

## Memory Tags Reference
- `session-summary` — What was accomplished
- `reflection` — Friction analysis and improvement proposals
- `session-review` — Combined tag for searching all session meta-notes
- `learning` — Category for insights that improve future sessions

# Reflection — Session Summary & Self-Evaluation Skill

## Description
A combined session-summary and reflection meta-skill. Summarizes what was accomplished, evaluates how well it went, identifies friction points, and proposes improvements. Stores everything in crow-memory for continuous improvement.

Can be invoked as `/reflection` or auto-triggered by the superpowers skill when friction accumulates or context is filling up.

## When to Use
- **Auto-trigger**: When superpowers.md detects 2+ friction signals (always via checkpoint — see Transparency below)
- **Auto-trigger**: When context window is approaching capacity (~80% full)
- **Manual**: User types `/reflection` or asks to reflect
- **End of session**: As part of the session-end protocol for non-trivial sessions
- **NOT needed**: For routine, smooth, short sessions — just use session-context.md end protocol

## Transparency

Reflection involves multiple phases of autonomous analysis. Surface progress to the user so they can see what's happening.

### Phase Progress FYI
Show a brief FYI as each phase begins:
*[crow: reflection phase 1 — summarizing session accomplishments]*
*[crow: reflection phase 2 — cataloging friction points]*
*[crow: reflection phase 4 — analyzing root causes]*
*[crow: reflection phase 5 — storing reflection in memory]*
*[crow: reflection phase 7 — evaluating skill-writing handoff]*

### Auto-Fix Undo
When auto-applying a minor fix (Phase 7), show:
*[crow: auto-applied minor fix to \<skill\>.md — \<what changed\>. Say "undo that" to revert.]*

Track the previous file state so "undo that" can restore it within the session.

### Deferred Gap FYI
When storing a skill gap for next session:
*[crow: stored skill gap for next session — "\<gap description\>"]*

---

## Workflow

### Phase 1: Session Summary
Capture what was accomplished:
1. List deliverables completed (files created, messages sent, research done)
2. List decisions made and their rationale
3. List research conducted and sources added
4. Note any unfinished work or next steps

Store as memory (write content in user's preferred language; use bilingual tags per `skills/i18n.md`):
```
crow_store_memory({
  content: "<structured summary — in user's preferred language>",
  category: "project",
  tags: "session-summary, <localized:resumen-de-sesión>, <date>, <project-names>",
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

#### Skill Metrics Update
When a skill is identified as a friction root cause, log a friction incident (content in user's language, tags bilingual):
```
crow_store_memory({
  content: "Skill friction: <skill-name>.md — <description in user's language>. Incident date: <date>. Severity: <HIGH/MEDIUM/LOW>.",
  category: "learning",
  tags: "skill-metrics, <localized:métricas-de-habilidad>, skill-friction, <localized:fricción-de-habilidad>, <skill-name>",
  importance: 6
})
```
This builds a per-skill friction history that skill-writing can query to identify chronically problematic skills.

### Phase 5: Store Reflection
Store the reflection in crow-memory (content in user's preferred language, tags bilingual):

```
crow_store_memory({
  content: "# Reflection / <localized>: <date>\n\n## Session Topic / <localized>: <topic>\n\n## Friction Points / <localized>\n### 1. <point> (HIGH/MEDIUM/LOW)\n- What happened: <description in user's language>\n- Root cause: <code bug / skill gap / missing memory>\n- Proposed fix: <specific change in user's language>\n\n## Changes Proposed / <localized>\n- <file>: <what should change>\n\n## Open Issues / <localized>\n- <anything unresolved>",
  category: "learning",
  tags: "reflection, <localized:reflexión>, session-review, <localized:revisión-de-sesión>, <date>, <project-names>",
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

### Phase 7: Skill-Writing Handoff
When Phase 4 identifies a root cause of **"Missing/incomplete skill"**, hand off to the skill-writing workflow:

**If the user is still engaged (mid-session or has time):**
1. Classify the needed change as **minor** or **major** (see classification below)
2. **Minor fixes** (add a tip, reorder steps, fix a tool reference, add an edge case): Apply the edit directly, log it in memory, and inform the user it was auto-applied
3. **Major changes** (new skill, structural rewrite, new triggers, merge/split skills): Propose via the skill-writing consent protocol — describe the change and wait for approval

**If the session is ending or user is wrapping up:**
1. Store a structured skill gap entry in memory for deferred pickup (content in user's language, tags bilingual):
```
crow_store_memory({
  content: "Skill gap identified: <description in user's language>. Affected skill: <skill-name or 'new skill needed'>. Suggested fix: <specific change in user's language>. Source: reflection on <date>.",
  category: "learning",
  tags: "skill-gap, <localized:brecha-de-habilidad>, skill-writing-queue, <localized:cola-de-escritura>, <skill-name>",
  importance: 8
})
```
2. Skill-writing will pick this up at the next session start

#### Minor vs Major Classification

| Change Type | Classification | Action |
|---|---|---|
| Add/edit a tip or best practice | Minor | Auto-apply |
| Reorder steps for clarity | Minor | Auto-apply |
| Fix a tool name or reference | Minor | Auto-apply |
| Add an edge case or caveat | Minor | Auto-apply |
| Add a new workflow step | Major | Ask first |
| Add/change trigger conditions | Major | Ask first |
| Create an entirely new skill | Major | Ask first |
| Rewrite a section structurally | Major | Ask first |
| Merge or split skills | Major | Ask first |
| Change which tools a skill uses | Major | Ask first |

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

## Language Adaptation

All reflection output must follow `skills/i18n.md`:

### Output Language
- All user-facing reflection output (friction catalog, proposals, summaries) → user's stored language preference
- Phase names appear bilingual: "Phase 1: Session Summary / Fase 1: Resumen de Sesión"
- Technical identifiers (tag names, tool names, file paths) stay in English

### Memory Entries
- All `crow_store_memory` calls in this skill write content in user's preferred language
- Tags use bilingual format: English canonical + localized (see tag templates above)

### Auto-Fix Notifications
- When auto-applying minor fixes (Phase 7), inform the user in their preferred language
- Example (Spanish): "Se aplicó automáticamente una corrección menor a `reflection.md`: se agregó un caso extremo."

---

## Memory Tags Reference
- `session-summary` / `resumen-de-sesión` — What was accomplished
- `reflection` / `reflexión` — Friction analysis and improvement proposals
- `session-review` / `revisión-de-sesión` — Combined tag for searching all session meta-notes
- `learning` / `aprendizaje` — Category for insights that improve future sessions
- `skill-metrics` / `métricas-de-habilidad` — Skill usage and friction tracking data
- `skill-friction` / `fricción-de-habilidad` — Specific friction incidents tied to a skill
- `skill-gap` / `brecha-de-habilidad` — Identified skill gaps queued for skill-writing pickup
- `skill-writing-queue` / `cola-de-escritura` — Deferred skill changes awaiting next session

*Note: Spanish translations shown as examples. For other languages, generate localized tags on the fly per `skills/i18n.md`.*

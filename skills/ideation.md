---
name: ideation
description: Universal notes-to-plans — organize raw notes, brain dumps, and scattered ideas into structured plans
triggers:
  - organize notes
  - brain dump
  - sort these ideas
  - here are my notes
  - help me plan from these notes
  - organize my thoughts
tools:
  - crow-memory
  - crow-projects
---

# Ideation — Notes to Plans

## Description

Transform unstructured notes, brain dumps, and scattered ideas into organized, actionable plans. Works for any domain — development, research, creative projects, business planning, personal goals.

## When to Activate

- User pastes a block of unstructured notes or bullet points
- User says "organize these", "sort my ideas", "help me plan"
- User dumps mixed-topic notes and asks for structure
- User wants to distribute notes across existing projects
- User has a brain dump they want turned into a plan

## Workflow

### Phase 1: Intake

Accept the raw input without judgment. Notes can be:
- Bullet points, numbered lists, or free-form paragraphs
- Mixed languages (handle with i18n skill)
- Fragments, typos, incomplete thoughts — all fine
- A mix of topics, priorities, and types (features, bugs, ideas, questions)

Acknowledge receipt: *[crow: received N items/lines for organization]*

### Phase 2: Parse & Cluster

1. Read through all notes and identify distinct topics or themes
2. Group related items into clusters
3. Label each cluster with a clear theme name
4. Identify items that don't fit any cluster (mark as "uncategorized")
5. Flag items that seem contradictory or ambiguous

### Phase 3: Cross-Reference

Check existing context for overlap:

1. `crow_search_memories` — do any clusters match stored memories or ongoing work?
2. `crow_list_projects` — do any clusters align with existing research projects?
3. `crow_recall_by_context` — any relevant prior decisions or context?

Report connections: *[crow: found N existing memories and M projects related to these notes]*

### Phase 4: Resolve

Surface issues to the user before proceeding:

- **Contradictions**: "Notes 3 and 7 seem to conflict — note 3 says X but note 7 says Y. Which takes priority?"
- **Ambiguities**: "Note 5 could mean A or B — can you clarify?"
- **Duplicates**: "Notes 2 and 9 appear to cover the same thing. Merge them?"
- **Scope questions**: "Note 12 is very large — should it be its own project or a subtask?"

If no issues found, proceed directly to Phase 5.

### Phase 5: Sort & Distribute

Offer the user options for where to put organized notes:

1. **Into existing projects**: Use `crow_add_note` to attach notes to relevant projects
2. **Into new projects**: Create projects with `crow_create_project` for new themes
3. **Into memory**: Store key decisions or context with `crow_store_memory`
4. **Into a plan**: Generate a structured implementation plan (see Phase 6)
5. **Keep as organized list**: Just return the clustered, cleaned-up notes

Ask the user which option(s) they prefer. Multiple options can apply simultaneously.

### Phase 6: Plan Generation

If the user wants a plan, generate a structured output:

1. **Summary**: 2-3 sentence overview of what the notes cover
2. **Themes**: List of identified clusters with item counts
3. **Prioritized action items**: Ordered by dependencies and importance
4. **Phase breakdown**: Group actions into sequential phases if appropriate
5. **Open questions**: Anything that still needs user input
6. **Connections**: Links to existing projects, memories, or prior work

Format the plan clearly with headers, bullet points, and phase labels.

## Adapting to Note Quality

| Input quality | Approach |
|--------------|----------|
| Clean bullet points | Light clustering, fast output |
| Mixed fragments | Heavier interpretation, confirm ambiguities |
| Stream of consciousness | Extract discrete items first, then cluster |
| Mixed languages | Process in original languages, output in user's preferred language |
| Technical + non-technical mixed | Separate into domain clusters |

## Multi-Project Distribution

When notes span multiple projects:

1. Show the user which notes map to which projects
2. Confirm before distributing
3. Use `crow_add_note` with appropriate `project_id` for each
4. For notes that span projects, create a cross-reference note in both

## Tips

- Don't force structure where the user wants a simple list — ask first
- Large brain dumps (20+ items) benefit from showing clusters before asking what to do
- If the user has done this before, check memory for their preferred organization style
- Notes about people → also check `crow_list_contacts` for context
- Notes about deadlines → flag time-sensitive items prominently

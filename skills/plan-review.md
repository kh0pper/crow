# Plan Review — Checkpoint-Based Planning Skill

## Description
Before executing multi-step or significant tasks, Crow outlines its approach as an inline plan and waits for user approval. This ensures the user always has visibility into *what* will happen and *why* before changes are made. Lightweight by design — no separate plan files, just structured checkpoints.

## When to Activate
- User requests a task that involves **3+ distinct steps** or **changes to 2+ files**
- User asks to "plan", "outline", "what would you do", "how would you approach"
- User says "planear", "esquematizar", "qué harías", "cómo lo harías" (or equivalent in any language)
- A compound workflow is about to run (daily briefing, meeting prep, etc.)
- A structural change to the skill system or CLAUDE.md is proposed
- Any destructive or hard-to-reverse operation (delete, overwrite, bulk modify)

*Match intent in any language — see `skills/i18n.md`.*

### When NOT to activate
- Single-step tasks (store a memory, send one message, read a file)
- Tasks the user has already described in enough detail that the plan is obvious
- Follow-up steps in an already-approved plan
- Routine session start/end protocols

---

## Workflow

### Step 1: Assess the Task
Before starting execution, evaluate:
1. **How many steps?** If 3+, plan first.
2. **How many files affected?** If 2+, plan first.
3. **Is it reversible?** If hard to undo, plan first.
4. **Is there ambiguity?** If the approach isn't obvious, plan first.

If none of these apply, skip planning and just do the task.

### Step 2: Present the Plan
Use a Tier 2 checkpoint with a structured inline plan:

**[crow checkpoint: Here's my plan for "<task description>". Say "go" to approve, "change step N" to revise, or "stop" to cancel.]**

The plan body should include:

```
1. **<Step name>** — <What will happen> (<which tool/file>)
2. **<Step name>** — <What will happen> (<which tool/file>)
3. **<Step name>** — <What will happen> (<which tool/file>)
```

For plans involving risk or significant changes, also include:
- **Files affected**: List of files that will be created or modified
- **crow.md sections affected**: List any crow.md sections that will be modified (if applicable)
- **Risks**: Anything that could go wrong or is hard to reverse
- **Rollback**: How to undo if needed

### Step 3: Wait for Approval
Do not proceed until the user responds. Accept these responses:
- **"go"**, **"yes"**, **"do it"**, **"approved"** → Execute the plan
- **"change step N"**, **"skip step N"** → Revise and re-present
- **"stop"**, **"cancel"**, **"no"** → Abandon the plan
- **Questions or feedback** → Answer, revise plan if needed, re-present

Match approval/rejection intent in any language.

### Step 4: Execute with Progress
Once approved, execute step by step. Show FYI progress:

*[crow: plan step 1/N — <completed action>]*
*[crow: plan step 2/N — <completed action>]*

If a step fails or the situation changes, pause and present an updated plan rather than continuing blindly.

### Step 5: Confirm Completion
After all steps are done:

*[crow: plan complete — <brief summary of what was done>]*

---

## Plan Quality Guidelines

### Be Specific
Bad: "1. Update the files"
Good: "1. **Update session-context.md** — Add structured summary template to end protocol (lines 25-36)"

### Be Honest About Risk
If a step could fail or has side effects, say so. The user trusts plans that acknowledge uncertainty more than plans that promise everything will work.

### Keep It Short
A plan checkpoint should be scannable in 5 seconds. If the plan needs more than 6-7 steps, group related steps or break the task into phases with a checkpoint per phase.

### Don't Over-Plan
Simple tasks don't need plans. If you can describe what you're about to do in one sentence, just do it with a FYI line instead of a full plan checkpoint.

---

## Integration with Existing Protocols

### Transparency Protocol
Plan checkpoints are Tier 2 (bold, wait for response). Plan step progress is Tier 1 (italic FYI). This skill extends the checkpoint system — it doesn't replace it.

### Compound Workflows (superpowers.md)
The compound workflow checkpoint in superpowers.md *is* a plan checkpoint. This skill defines the general protocol; superpowers.md applies it to specific multi-tool workflows.

### Reflection (reflection.md)
When reflection proposes improvements (Phase 6), those proposals should follow the plan format: numbered steps, affected files, risks. The user approves before implementation.

### Skill Writing (skill-writing.md)
Major skill changes (new skills, structural rewrites) should be presented as plans. Minor auto-fixes skip planning per the existing minor/major classification.

---

## Language Adaptation

- Plan checkpoints and step descriptions → user's preferred language
- File paths, tool names, technical identifiers → English
- The `[crow checkpoint: ...]` prefix → English (per Transparency Protocol)
- See `skills/i18n.md` for full protocol

---

## Tips

- **Don't ask twice**: If the user already described exactly what they want in detail, don't echo it back as a "plan" — just confirm briefly and execute
- **Revisions are cheap**: If the user says "change step 3", revise and re-present the full plan — don't just describe the change
- **Failed steps need new plans**: If step 3 of 5 fails, don't continue with steps 4-5. Pause, explain what happened, present a revised plan
- **Context from memory**: Before planning, recall relevant context — a good plan accounts for what you already know about the user's preferences and project state

# Skill Writing — Dynamic Skill Creation

## Description
This skill enables the AI to create, modify, and propose new skill files (`skills/*.md`) when existing skills don't cover a user's workflow. New skills are only written with **explicit user consent**.

## When to Activate
- User describes a recurring workflow that no existing skill covers
- User explicitly asks for a new skill or automation
- User says "make a skill for...", "automate...", "create a workflow for..."
- A compound workflow is repeated 2+ times and could be codified
- User wants to customize or extend an existing skill

## Consent Protocol

**Never create or modify a skill file without asking first.** Follow this flow:

1. **Detect the opportunity**: Notice a workflow gap or user request
2. **Propose the skill**: Describe what the skill would do, which tools it would use, and what triggers it
3. **Get explicit consent**: Wait for user approval before writing anything
4. **Draft and present**: Show the skill content to the user for review
5. **Write on approval**: Create the file in `skills/` only after the user confirms
6. **Register the skill**: Update `CLAUDE.md` skill list and `superpowers.md` trigger table

### Consent phrases (user must say something like):
- "Yes, create that skill"
- "Go ahead and make it"
- "That sounds good, write it"
- "Sure, add that"

### Do NOT proceed if:
- User says "maybe later" or "not now"
- User hasn't explicitly confirmed
- The skill would override or conflict with an existing one (warn first)

---

## Skill File Structure

Every skill file in `skills/` should follow this template:

```markdown
# Skill Name — Short Description

## Description
One paragraph explaining what this skill does and when it's useful.

## When to Activate
- Trigger condition 1
- Trigger condition 2
- Keywords or phrases that should activate this skill

## Workflow

### Step 1: [Name]
- What to do
- Which tools to use
- Expected output

### Step 2: [Name]
...

## Tools Used
- **tool-name**: How it's used in this workflow
- **tool-name**: How it's used in this workflow

## Tips
- Best practices specific to this skill
- Common pitfalls to avoid
```

---

## Writing Guidelines

### Structure
- **Clear trigger conditions**: When should this skill activate? Be specific.
- **Step-by-step workflow**: Break the process into numbered steps with tool calls
- **Tool references**: List which MCP tools are involved and how
- **Tips section**: Include gotchas, best practices, and edge cases

### Quality
- Keep skills **focused**: One skill = one workflow. Don't combine unrelated tasks.
- Keep skills **actionable**: Every step should map to a concrete tool call or decision
- Keep skills **discoverable**: Use clear keywords in the "When to Activate" section
- Keep skills **composable**: Skills should work alongside other skills, not replace them

### Creativity
When the user gives a vague request like "help me manage my mornings" or "I want a weekly review process", get creative:
- Think about which tools could combine in useful ways
- Suggest workflows the user might not have considered
- Draw on the full set of available MCP servers
- Consider memory integration — what should be stored/recalled automatically?

### Naming
- Filename: `skills/kebab-case-name.md`
- Title: `# Title Case Name — Short Description`
- Keep names descriptive but concise

---

## Post-Creation Checklist

After writing a new skill file:

1. **Update `CLAUDE.md`**: Add the skill to the appropriate category in the Skills section
2. **Update `superpowers.md`**: Add trigger keywords to the Trigger Table
3. **Store in memory**: Use `store_memory` to record that a new skill was created, what it does, and why
4. **Inform the user**: Confirm the skill is active and explain how to trigger it

---

## Modifying Existing Skills

When a user wants to change an existing skill:

1. Read the current skill file
2. Propose the specific changes
3. Get user consent
4. Edit the file (don't rewrite from scratch unless necessary)
5. Update trigger table if triggers changed
6. Store the change in memory

---

## Example: Creating a "Weekly Review" Skill

**User**: "I want to do a weekly review every Sunday"

**AI response**: "I can create a skill for that. Here's what it would do:
- Check all Trello cards completed this week
- Summarize email threads from the week
- Review calendar for next week's events
- Check research project progress
- Generate a summary and store it in memory

Want me to create this as `skills/weekly-review.md`?"

**User**: "Yes, go ahead"

**AI**: Creates the skill file, updates CLAUDE.md and superpowers.md, stores the creation in memory.

---

## Compound Skill Detection

Watch for these patterns that suggest a new skill would help:

- **Repeated multi-step workflows**: User asks for the same sequence of actions across sessions
- **"Every time I..." statements**: User describes a recurring process
- **Tool combinations**: User regularly uses the same 3+ tools together
- **Frustration with manual steps**: User wishes something was automatic
- **Domain-specific workflows**: Academic writing, sprint planning, content creation, etc.

When detected, suggest: "I notice you do [X] regularly. Want me to create a skill for that so it's faster next time?"

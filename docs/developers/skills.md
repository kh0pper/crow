# Writing Skills

Skills are markdown files that teach the AI specific workflows. They're the simplest way to contribute to Crow — no code required.

## What is a Skill?

A skill is a behavioral prompt stored in `skills/`. When a user's intent matches a trigger pattern, the AI loads the relevant skill file and follows its instructions. Skills define **what to do** and **which tools to use**.

## Skill Anatomy

Every skill file follows this structure:

```markdown
# Skill Name

## Description
One-paragraph summary of what this skill does.

## When to Use
- Bullet list of trigger conditions
- When the user says "..."
- When a specific condition is detected

## Tools Available
- **tool_name** — What it does
- **another_tool** — What it does

## Workflow: Workflow Name
1. First step
2. Second step — call `tool_name` with parameters
3. Third step — store results with `crow_store_memory`

## Best Practices
- Tips for effective use
- Common pitfalls to avoid
```

## Adding Triggers

After creating your skill file, add a row to the trigger table in `skills/superpowers.md`:

```
| "english trigger", "another trigger" | "spanish trigger" | your-skill | primary-tools |
```

### Multilingual Triggers

Crow supports multilingual intent matching. Provide trigger phrases in at least English. Adding Spanish (or other languages) is encouraged but optional. The AI matches intent in **any** language — the examples are illustrative.

## Compound Workflows

Skills can combine multiple tools across different servers:

```markdown
## Workflow: Research Summary Email
1. Search memories with `crow_search_memories` for the topic
2. List project sources with `crow_list_sources`
3. Compose a summary
4. Send via `send_gmail_message`
5. Store the action in memory with `crow_store_memory`
```

## Transparency

Skills should include transparency lines so users can see what's happening:

```markdown
*[crow: step 1/3 — searched memories, found 5 relevant items]*
*[crow: step 2/3 — composed summary from 3 sources]*
```

## Testing

Skills are markdown — there's no build step. To test:
1. Place the file in `skills/`
2. Add the trigger row to `skills/superpowers.md`
3. Start a conversation and use one of the trigger phrases
4. Verify the AI follows the workflow correctly

## Submit

1. Open a [Skill Proposal](https://github.com/kh0pper/crow/issues/new?template=skill-proposal.md) issue
2. Fork the repo, add your skill file, and submit a PR

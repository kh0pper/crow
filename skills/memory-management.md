# Memory Management Skill

## Description
Store, search, and retrieve persistent memories across sessions. Use this skill to maintain context about the user, their projects, preferences, and important decisions.

## When to Use
- When the user shares important information about themselves, their team, or their projects
- When a key decision is made during a session
- When the user states a preference or requirement
- When you need to recall information from previous sessions
- At the start of a new session to load relevant context

## Tools Available
Use the `crow-memory` MCP server tools:

### Storing Memories
Use `crow_store_memory` with appropriate categorization:
- **general**: Miscellaneous facts and information
- **project**: Project-specific details, requirements, milestones
- **preference**: User preferences for tools, formatting, communication style
- **person**: Information about people (team members, stakeholders, contacts)
- **process**: Workflows, procedures, how things are done
- **decision**: Decisions made and their rationale
- **learning**: Things learned, skills acquired, insights gained
- **goal**: Goals, objectives, targets

### Importance Guidelines
- **9-10**: Critical project requirements, deadlines, key contacts
- **7-8**: Important preferences, recurring processes, project milestones
  - **Note:** Preferences stored with importance >= 8 automatically appear in crow.md's dynamic "Key Preferences" section, visible across all connected platforms.
- **5-6**: General context, background information
- **3-4**: Nice-to-know details, minor preferences
- **1-2**: Ephemeral notes, temporary context

### Searching and Recall
- Use `crow_deep_recall` for comprehensive cross-source recall (memories + research sources + research notes + blog posts)
- Use `crow_search_memories` for specific keyword searches within memories only
- Use `crow_recall_by_context` for quick memory-only context recall on simple tasks
- Use `crow_list_memories` to browse by category or importance
- Use `crow_memory_stats` to understand what's stored

## Workflow: Session Start
1. Use `crow_deep_recall` with the current task description (searches memories, research, notes, and blog posts)
2. Review returned results across all knowledge sources
3. Proceed with the task, informed by prior context

Use `crow_recall_by_context` for quick/simple tasks. Use `crow_deep_recall` when you need comprehensive cross-source recall.

## Workflow: Storing New Information
1. Identify information worth persisting
2. Choose the right category and importance level
3. Add descriptive tags for future retrieval
4. Note the source (conversation, document, API, etc.)
5. **Show the FYI line** immediately after storing (see Transparency section below)

## Transparency: Surfacing Memory Operations

Follow the Transparency Rules in crow.md (`transparency_rules` section). Memory operations are the most common autonomous actions, so consistent surfacing is critical.

### On Every Store
After calling `crow_store_memory`, immediately show a FYI line:

*[crow: stored memory — "\<first ~60 chars of content\>" (\<category\>, importance \<N\>, tags: \<tags\>)]*

### On Every Recall
After `crow_recall_by_context` or `crow_search_memories` returns results, show:

*[crow: recalled \<N\> memories matching "\<query summary\>"]*

Only show the count — don't dump memory contents into FYI lines. Reference the relevant memories naturally in your response.

### Undo Mechanism
If the user says "undo that" or "don't store that" after a memory FYI:
1. Use `crow_delete_memory` with the ID of the most recently stored memory
2. Confirm: *[crow: memory deleted — "\<content summary\>"]*

### Session Memory Ledger
Track all memory stores made during the session. If the user says "show me what you stored", list them all:

*[crow: memories stored this session:]*
1. *"\<content\>" (category, importance N)*
2. *"\<content\>" (category, importance N)*
...

## Examples

### Store a project preference
```
crow_store_memory({
  content: "User prefers TypeScript over JavaScript for all new code",
  category: "preference",
  tags: "coding, language, typescript",
  importance: 8
})
```

### Search for project context
```
crow_search_memories({
  query: "authentication requirements",
  category: "project",
  min_importance: 5
})
```

### Context-based recall
```
crow_recall_by_context({
  context: "Setting up the API endpoints for the user dashboard"
})
```

### Deep recall (cross-source)
```
crow_deep_recall({
  topic: "authentication and user sessions",
  per_source_limit: 5,
  project_id: 1
})
```

---

## Multilingual Memory Storage

Follow `skills/i18n.md` for the full language protocol. Key rules:

### Content Language
- Store memory content in the **user's preferred language**
- This ensures `crow_search_memories` and `crow_recall_by_context` return results immediately readable without translation
- Exception: Direct quotes from English sources → store original with a translated note

### Tag Strategy — Bilingual Format
Tags use both English canonical and localized forms:
```
tags: "english-tag, localized-tag, english-tag-2, localized-tag-2"
```
Example (Spanish user):
```
tags: "project, proyecto, deadline, fecha-límite, decision, decisión"
```

### Category Names
- **Always in English** — categories are system-level identifiers
- `general`, `project`, `preference`, `person`, `process`, `decision`, `learning`, `goal`

### Cross-Language Search
- FTS5 supports any language — searches work in whatever language content was stored in
- When searching by tags, try both English and user's language
- Example: `crow_search_memories({ query: "proyecto" })` will find memories stored in Spanish
- Example: `crow_search_memories({ query: "project" })` will find the same memories via bilingual tags

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
Use `store_memory` with appropriate categorization:
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
- **5-6**: General context, background information
- **3-4**: Nice-to-know details, minor preferences
- **1-2**: Ephemeral notes, temporary context

### Searching and Recall
- Use `search_memories` for specific keyword searches
- Use `recall_by_context` at the start of tasks to find relevant prior context
- Use `list_memories` to browse by category or importance
- Use `memory_stats` to understand what's stored

## Workflow: Session Start
1. Use `recall_by_context` with the current task description
2. Review returned memories for relevant context
3. Proceed with the task, informed by prior context

## Workflow: Storing New Information
1. Identify information worth persisting
2. Choose the right category and importance level
3. Add descriptive tags for future retrieval
4. Note the source (conversation, document, API, etc.)

## Examples

### Store a project preference
```
store_memory({
  content: "User prefers TypeScript over JavaScript for all new code",
  category: "preference",
  tags: "coding, language, typescript",
  importance: 8
})
```

### Search for project context
```
search_memories({
  query: "authentication requirements",
  category: "project",
  min_importance: 5
})
```

### Context-based recall
```
recall_by_context({
  context: "Setting up the API endpoints for the user dashboard"
})
```

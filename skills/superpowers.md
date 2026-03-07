# Superpowers — Auto-Activation & Routing Skill

## Description
This is the master routing skill. Consult this **before every task** to determine which skills and tools to activate. It maps user intent to the right combination of MCP servers, skills, and workflows.

## Always-On Rules
1. **Memory first**: Before any task, check `recall_by_context` for relevant prior context
2. **Multi-tool by default**: Most tasks benefit from combining 2-3 tools
3. **Document as you go**: Important findings → `store_memory`; external sources → `add_source`
4. **Reflect when needed**: If friction accumulates, trigger the reflection skill

---

## Trigger Table

| User Intent / Keywords | Activate Skills | Primary Tools |
|---|---|---|
| "remember", "store", "recall", "what did we..." | memory-management | crow-memory |
| "research", "find papers", "cite", "bibliography" | research-pipeline, web-search | crow-research, brave-search, mcp-research |
| "email", "calendar", "schedule", "meeting", "gmail" | google-workspace | google-workspace |
| "google chat", "chat space", "send chat" | google-chat | google-workspace (chat tools) |
| "task", "board", "card", "sprint", "trello" | project-management | trello |
| "assignment", "grade", "course", "canvas" | project-management | canvas-lms |
| "wiki", "notion", "page", "database" | notion | notion |
| "slack", "slack message", "slack channel" | slack | slack |
| "discord", "server", "guild" | discord | discord |
| "teams", "microsoft teams" | microsoft-teams | microsoft-teams |
| "repo", "issue", "PR", "commit", "github" | github | github |
| "search", "look up", "find out", "what is" | web-search | brave-search |
| "file", "download", "document", "folder" | filesystem | filesystem |
| "citation", "zotero", "library", "reference" | research-pipeline | zotero |
| Session start | session-context | crow-memory |
| End of session / high friction detected | reflection | crow-memory |

---

## Compound Workflows

### "Daily briefing" / "What's going on?"
1. **Gmail** — Check for important/unread emails
2. **Calendar** — Today's and tomorrow's events
3. **Slack/Discord/Teams** — Recent messages in key channels
4. **Trello** — Cards assigned to user, due soon
5. **Canvas** — Upcoming assignments (if student)
6. **Memory** — Recall any stored reminders or pending items
7. Present a consolidated briefing

### "Prepare for meeting about X"
1. **Calendar** — Get meeting details and attendees
2. **Gmail** — Search for related email threads
3. **Memory** — Recall prior context about X
4. **Research** — Check for relevant sources and notes
5. **Slack/Chat** — Search for recent discussions about X
6. Summarize all context for the user

### "Start research on X"
1. **Memory** — Check for any existing context on X
2. **Research** — Create a research project with `create_project`
3. **Brave Search** — Initial web search for overview
4. **MCP Research** — Search arXiv and Semantic Scholar for papers
5. **Zotero** — Check if user already has relevant references
6. For each valuable source → `add_source` with APA citation
7. Store initial findings in memory

### "Send update to the team about X"
1. **Memory** — Recall project context for X
2. **Research** — Check for recent findings if applicable
3. **Trello** — Check card status for related tasks
4. Compose the update message
5. Send via the appropriate channel (Slack, Discord, Teams, Gmail, or Google Chat)
6. Store that the update was sent in memory

### "Organize project X"
1. **Memory** — Recall all context about X
2. **Trello** — Check/create board and cards
3. **Notion** — Create wiki pages for project documentation
4. **GitHub** — Check repo status, open issues
5. **Research** — Link any research projects
6. Store the organizational structure in memory

---

## Auto-Detection Patterns

### Detect and adapt to user context
- If the user mentions a person → check memory for person context, check contacts
- If the user mentions a date → check calendar for conflicts
- If the user mentions a source/paper → check research pipeline and Zotero
- If the user mentions a project name → check memory, Trello, GitHub, and Notion
- If the user seems frustrated or corrects approach → note friction for reflection

### Friction Detection (feeds into reflection skill)
Track these signals during the session:
- Tool call failures (API errors, authentication issues)
- User corrections ("no, I meant...", "that's not right")
- Repeated attempts at the same task
- Long chains of tool calls without producing results
- User explicitly expressing frustration

When 2+ friction signals accumulate, suggest running the reflection skill before the session ends.

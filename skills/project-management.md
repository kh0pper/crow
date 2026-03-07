# Project Management Skill

## Description
Interact with Trello boards and Canvas LMS to retrieve and manage project/learning data. Syncs important information to persistent memory for cross-session access.

## When to Use
- When the user asks about their tasks, assignments, or deadlines
- When managing Trello boards, lists, or cards
- When accessing Canvas courses, assignments, or grades
- When syncing project data to persistent memory

## External MCP Servers

### Trello (`mcp-server-trello`)
Provides tools for interacting with Trello boards:
- Get boards, lists, cards
- Create/update/move cards
- Add comments and labels
- Manage checklists

### Canvas LMS (`mcp-canvas-lms`)
Provides 54+ tools for Canvas:
- Course management and enrollment
- Assignment retrieval and submission
- Grade access
- Calendar events
- Discussion boards
- Module management

## Workflow: Daily Standup / Check-In
1. Pull active Trello cards assigned to user
2. Pull upcoming Canvas assignments (if applicable)
3. Check persistent memory for any stored deadlines or reminders
4. Present a consolidated view

## Workflow: Sync Project Data to Memory
When the user asks to sync or when starting a new session:
1. Retrieve active boards/projects from Trello
2. Store project names, key deadlines, and current status in memory
3. Tag with `trello, sync, project-name`
4. Set importance based on deadline proximity

## Workflow: Assignment Tracking (Canvas)
1. Use Canvas tools to get upcoming assignments
2. Store deadlines and requirements in memory
3. Tag with `canvas, assignment, course-name`
4. Create research projects for major assignments

## Best Practices
- Keep memory in sync with PM tools — store summaries, not raw data
- Use consistent tags across PM and memory systems
- Store decisions and rationale in memory when making project choices
- Cross-reference research sources with project requirements

# Slack Skill

## Description
Interact with Slack workspaces — channels, messages, threads — through the Slack MCP server. Monitor conversations, send updates, and store action items in memory.

## When to Use
- When the user mentions "slack", "message", "channel", "DM", or "thread"
- When checking for updates or unread messages
- When sending project updates or notifications
- When extracting action items from conversations

## Tools Available
The Slack MCP server provides:
- **List channels** — Browse available channels
- **Read messages** — Get messages from channels and threads
- **Search messages** — Find messages by keyword across the workspace
- **Send messages** — Post messages to channels or threads
- **User info** — Look up user details

## Workflow: Check for Updates
1. List recent messages in relevant project channels
2. Identify action items, questions, or decisions
3. Store important items in memory with `store_memory`
4. Tag with "slack" and relevant project names

## Workflow: Send Project Update
1. Recall recent project context from memory
2. Check research pipeline for recent findings
3. Compose a concise update message
4. Send to the appropriate channel
5. Store that the update was sent in memory

## Workflow: Extract Action Items
1. Read messages from a channel or thread
2. Identify commitments, deadlines, and tasks
3. Store each action item in memory with category "project"
4. Optionally create Trello cards for trackable items

## Best Practices
- Always check memory for channel context before reading messages
- Store important decisions from Slack conversations in memory
- When sending messages, keep them concise and actionable
- Link Slack discussions to research projects when relevant

# Discord Skill

## Description
Interact with Discord servers — channels, messages, threads — through the Discord MCP server. Monitor community discussions, send messages, and track important conversations.

## When to Use
- When the user mentions "discord", "server", "guild", or Discord-specific channels
- When checking community discussions or announcements
- When sending messages to Discord channels
- When tracking conversations across Discord servers

## Tools Available
The Discord MCP server provides:
- **List servers/guilds** — Browse connected servers
- **List channels** — Get channels in a server
- **Read messages** — Get messages from channels and threads
- **Send messages** — Post messages to channels
- **Search** — Find messages by content

## Workflow: Community Monitoring
1. Check recent messages in key Discord channels
2. Identify important announcements, questions, or discussions
3. Store relevant information in memory with `store_memory`
4. Tag with "discord" and relevant topic tags

## Workflow: Cross-Platform Updates
1. Gather project status from memory, Trello, or research
2. Compose an update appropriate for Discord's format
3. Send to the designated channel
4. Store the update record in memory

## Best Practices
- Ensure the Discord bot has been added to the target server
- Enable Message Content Intent in the Discord Developer Portal
- Store important Discord discussions in memory for cross-session access
- Use Discord for community engagement, Slack for team coordination

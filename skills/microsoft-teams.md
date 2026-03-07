# Microsoft Teams Skill (Experimental)

## Description
Interact with Microsoft Teams — chats, channels, meetings — through the Teams MCP server. This integration is experimental and may have limited functionality.

## When to Use
- When the user mentions "teams", "microsoft teams", or Teams-specific channels
- When checking Teams messages or channel discussions
- When the organization primarily uses Microsoft 365

## Tools Available
The Teams MCP server provides:
- **List teams/channels** — Browse available teams and channels
- **Read messages** — Get messages from chats and channels
- **Send messages** — Post to channels or chats
- **Search messages** — Find messages across Teams

## Setup Requirements
Requires Azure AD app registration with Microsoft Graph API permissions:
- `Chat.Read` — Read chat messages
- `ChannelMessage.Read.All` — Read channel messages
- `ChannelMessage.Send` — Send channel messages

## Workflow: Check Teams Updates
1. List recent messages in relevant Teams channels
2. Identify action items and decisions
3. Store important items in memory with `store_memory`
4. Tag with "teams" and relevant project names

## Best Practices
- This integration is experimental — if it fails, fall back to checking Teams manually
- Azure AD setup requires admin consent for some permissions
- Store important Teams discussions in memory for cross-session access
- Use alongside Google Workspace if the user works across both platforms

## Troubleshooting
- If authentication fails, verify the Azure AD app registration
- Ensure admin consent has been granted for the required Graph permissions
- Check that TEAMS_CLIENT_ID, TEAMS_CLIENT_SECRET, and TEAMS_TENANT_ID are all set

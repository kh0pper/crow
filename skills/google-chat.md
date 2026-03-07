# Google Chat Skill

## Description
Interact with Google Chat — spaces, messages, threads — through the Google Workspace MCP server. Google Chat is already integrated as part of the google-workspace server; this skill documents its specific workflows.

## When to Use
- When the user mentions "google chat", "chat spaces", or Google Chat-specific conversations
- When checking messages in Google Chat spaces
- When sending messages via Google Chat
- When searching Chat conversations

## Tools Available (via google-workspace server)
- `list_spaces` — List all Google Chat spaces (rooms and DMs)
- `get_messages` — Get messages from a specific space
- `send_message` — Send a message to a space (supports threads)
- `search_messages` — Search messages by text content
- `create_reaction` — Add emoji reactions to messages
- `download_chat_attachment` — Download attachments from messages

## Workflow: Check Chat Updates
1. Use `list_spaces` to find relevant spaces
2. Use `get_messages` for recent messages in key spaces
3. Identify action items and decisions
4. Store important items in memory with `crow_store_memory`
5. Tag with "google-chat" and relevant project names

## Workflow: Send Team Update
1. Recall project context from memory
2. Compose a concise update
3. Use `send_message` to post to the appropriate space
4. For threaded conversations, use `thread_name` or `thread_key`
5. Store that the update was sent in memory

## Workflow: Search Conversations
1. Use `search_messages` with relevant keywords
2. Optionally filter by `space_id` for specific spaces
3. Extract relevant information from results
4. Store findings in memory if they contain important decisions

## Best Practices
- Google Chat is part of Google Workspace — no additional API keys needed
- Use Google Chat for Google Workspace-integrated teams
- Store important Chat decisions in memory for cross-session access
- Thread replies properly using thread_name for organized discussions

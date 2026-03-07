# Gemini

Connect Crow to Google's Gemini — both the Gemini CLI and Gemini in Google AI Studio/Enterprise.

## Prerequisites

- Crow gateway deployed and healthy ([Cloud Deploy Guide](../getting-started/cloud-deploy))

## Gemini CLI

The [Gemini CLI](https://github.com/google-gemini/gemini-cli) supports remote MCP servers via configuration.

### Setup Steps

1. Edit `~/.gemini/settings.json`:
   ```json
   {
     "mcpServers": {
       "crow-memory": {
         "url": "https://your-gateway.onrender.com/memory/mcp"
       },
       "crow-research": {
         "url": "https://your-gateway.onrender.com/research/mcp"
       },
       "crow-tools": {
         "url": "https://your-gateway.onrender.com/tools/mcp"
       }
     }
   }
   ```

2. Start Gemini CLI — it will auto-discover the OAuth metadata and prompt for authorization.

## Google AI Studio

Google AI Studio supports MCP servers for tool use in chat. Configuration is available through the interface when creating a new chat or agent.

### Setup Steps

1. Open [Google AI Studio](https://aistudio.google.com)
2. Create a new chat or agent
3. In the tools section, add an MCP server
4. Enter the Streamable HTTP URL:
   ```
   https://your-gateway.onrender.com/memory/mcp
   ```
5. Complete the OAuth authorization flow

## Transport

- **Type**: Streamable HTTP
- **Protocol**: `2025-03-26`
- **Auth**: OAuth 2.1 (automatic discovery)

## Verification

Ask Gemini:

> "Store a memory that Gemini is connected to Crow."

Then verify:

> "Search memories for 'Gemini'."

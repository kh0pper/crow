# Building Integrations

This guide explains how to add a new external service integration to Crow.

## What is an Integration?

An integration connects Crow to an external service (e.g., Gmail, Trello, Slack) via an MCP server. Most integrations use existing npm packages — you configure them and write a skill file that teaches the AI how to use them.

## Step 1: Find or Build an MCP Server

Search for an existing MCP server package:
- [MCP Server Registry](https://github.com/modelcontextprotocol/servers)
- npm: search for `mcp-server-<service>`

If no package exists, you can build one using the `@modelcontextprotocol/sdk` package.

## Step 2: Add a Bundle Manifest with a `connect` Block

Create `bundles/your-service/manifest.json`. The `connect` block makes it a service: it names the fields a person fills in and the steps the dashboard shows (add each `label_key` and step key, in English and Spanish, to `servers/gateway/dashboard/shared/i18n.js`). Then run `npm run build-registry`.

```json
{
  "id": "your-service",
  "name": "Your Service",
  "version": "1.0.0",
  "description": "Brief description of what this integration does",
  "type": "mcp-server",
  "author": "Crow",
  "category": "productivity",
  "server": {
    "command": "npx",
    "args": ["-y", "@scope/mcp-server-your-service"],
    "envKeys": ["YOUR_SERVICE_API_KEY"]
  },
  "env_vars": [
    { "name": "YOUR_SERVICE_API_KEY", "description": "API key from Your Service", "required": true, "secret": true }
  ],
  "connect": {
    "method": "token",
    "group": "paste",
    "fields": [
      { "name": "YOUR_SERVICE_API_KEY", "kind": "secret", "label_key": "services.field.YOUR_SERVICE_API_KEY" }
    ],
    "steps": ["services.steps.your-service.1", "services.steps.your-service.2"]
  },
  "ports": [],
  "webUI": null
}
```

## Step 3: Add to .mcp.json

Add the MCP server configuration:

```json
{
  "your-service": {
    "command": "npx",
    "args": ["-y", "@scope/mcp-server-your-service"],
    "env": {
      "YOUR_SERVICE_API_KEY": "${YOUR_SERVICE_API_KEY}"
    }
  }
}
```

## Step 4: Update .env.example

Add your environment variables:

```
YOUR_SERVICE_API_KEY=         # API key from https://yourservice.com/api-keys
```

## Step 5: Create a Skill File

Create `skills/your-service.md` following the skill template:

```markdown
# Your Service Skill

## Description
What this integration enables.

## When to Use
- Trigger phrases and conditions

## Tools Available
- List the MCP tools provided

## Workflow: Main Use Case
1. Step-by-step workflow
2. Including which tools to call
3. And what to store in memory

## Best Practices
- Configuration tips
- Common pitfalls
```

## Step 6: Add Trigger Row

Add a row to the trigger table in `skills/superpowers.md`:

```
| "your service", "keyword" | "tu servicio", "palabra clave" | your-service | your-service |
```

## Step 7: Test

```bash
# Verify the server starts
npx -y @scope/mcp-server-your-service

# Verify crow gateway still starts
node servers/gateway/index.js --no-auth
```

## Scaffolding Tool

Use the interactive scaffolding CLI to generate boilerplate:

```bash
npm run create-integration
```

This outputs the code snippets for all the files above — just copy them in.

## Submit

1. Open an [Integration Request](https://github.com/kh0pper/crow/issues/new?template=integration-request.md) issue to discuss your idea
2. Fork the repo, implement the integration, and submit a PR

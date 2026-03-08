# {{SERVICE_NAME}} Skill

## Description
Interact with {{SERVICE_NAME}} through the {{SERVICE_NAME}} MCP server. {{BRIEF_DESCRIPTION}}.

## When to Use
- When the user mentions "{{SERVICE_ID}}" or related keywords
- When managing {{SERVICE_NAME}} resources
- {{ADDITIONAL_TRIGGER}}

## Tools Available
The {{SERVICE_NAME}} MCP server provides:
- **{{tool_1}}** — {{Description}}
- **{{tool_2}}** — {{Description}}

## Workflow: {{Main Use Case}}
1. Identify what the user wants to do with {{SERVICE_NAME}}
2. Call the appropriate tool with the right parameters
3. Present results to the user
4. Store relevant results in memory with `crow_store_memory`
5. Tag with "{{SERVICE_ID}}" and relevant topic tags

## Workflow: Cross-Platform Updates
1. Gather context from memory, research, or other integrations
2. Compose content appropriate for {{SERVICE_NAME}}
3. Send/create via the {{SERVICE_NAME}} tool
4. Store the action record in memory

## Best Practices
- Ensure {{ENV_VAR}} is configured in `.env`
- Store important {{SERVICE_NAME}} data in memory for cross-session access
- Use {{SERVICE_NAME}} for {{USE_CASE}}, other tools for {{OTHER_USE_CASE}}

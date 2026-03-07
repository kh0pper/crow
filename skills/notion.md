# Notion Skill

## Description
Interact with Notion workspaces — pages, databases, wiki content — through the Notion MCP server. Use Notion as a structured knowledge base that complements Crow's memory and research pipeline.

## When to Use
- When the user mentions "wiki", "notion", "page", "database", or "knowledge base"
- When organizing project documentation or team knowledge
- When creating structured content (tables, databases, linked pages)
- When syncing information between Notion and Crow's memory

## Tools Available
The Notion MCP server provides access to the Notion API including:
- **Search** — Find pages and databases by title or content
- **Read pages** — Get page content and properties
- **Create pages** — Create new pages in any database or as sub-pages
- **Update pages** — Modify page properties and content
- **Query databases** — Filter and sort database entries
- **Create databases** — Build new structured databases

## Workflow: Sync Notion to Memory
When important information exists in Notion:
1. Search or read the relevant Notion page
2. Extract key facts, decisions, or requirements
3. Store in crow-memory with `store_memory` using category "project" or "decision"
4. Tag with "notion" plus relevant project tags
5. Include the Notion page URL in the memory content for reference

## Workflow: Research to Notion
When research should be documented in Notion:
1. Gather sources and notes from crow-research
2. Generate bibliography with `generate_bibliography`
3. Create a Notion page with structured content
4. Add sections for sources, key findings, and analysis
5. Store the Notion page link back in memory

## Workflow: Project Wiki
For maintaining project documentation:
1. Create a Notion database for the project (if not exists)
2. Add pages for requirements, decisions, meeting notes
3. Cross-reference with Trello cards and research projects
4. Keep memory updated with links to Notion pages

## Best Practices
- Always share Notion pages with the integration before trying to access them
- Use consistent naming conventions across Notion and memory
- Store Notion page URLs in memory for quick future reference
- Use databases (not plain pages) when content is structured/repeatable

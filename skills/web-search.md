# Web Search Skill

## Description
Search the web using Brave Search for research, fact-checking, current events, and general information gathering. Every valuable search result should be documented in the research pipeline with APA citations.

## When to Use
- When the user asks to "search", "look up", "find out", or "what is"
- When fact-checking or verifying claims
- When researching current events or recent developments
- When gathering background information on any topic
- When finding documentation, tutorials, or technical references

## Tools Available
The Brave Search MCP server provides:
- **Web search** — Full web search with snippets and URLs
- **Local search** — Location-based search results

## Workflow: Research Search
The primary search workflow — always document findings:
1. Formulate a clear search query
2. Execute the search via Brave Search
3. Evaluate results for relevance and credibility
4. For each valuable result:
   a. Add to research pipeline with `crow_add_source` (include URL, title, authors if available)
   b. Generate an APA citation
   c. Mark verification status appropriately
5. Store key findings in memory with `crow_store_memory`
6. Tag with relevant research project names

## Workflow: Quick Lookup
For simple factual queries that don't need full documentation:
1. Search for the specific fact
2. Verify across multiple results if possible
3. Present the answer to the user
4. Only add to research pipeline if the user wants to keep the reference

## Workflow: Literature Discovery
When searching for academic or technical content:
1. Search via Brave for initial discovery
2. Cross-reference with mcp-research (arXiv, Semantic Scholar) for academic papers
3. Check Zotero for items already in the user's library
4. Add new valuable sources to both research pipeline and Zotero

## Best Practices
- Always cite sources — never present search results without attribution
- Use specific, well-formed queries for better results
- Cross-reference with academic search for scholarly topics
- Store search strategies that work well in memory for reuse
- When a search reveals important new information, always `crow_store_memory`

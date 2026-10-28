---
name: web-search
description: Search the web for research, fact-checking and current events. Search results are leads, not sources; Crow opens a page before anything from it is cited.
tools:
  - crow-projects/crow_web_search
  - crow-projects/crow_add_source
  - brave-search
---

# Web Search Skill

## Description
Search the web for research, fact-checking, current events, and general information gathering. Search results are leads, not sources: Crow opens a page with `crow_add_source` before anything from it is cited.

## When to Use
- When the user asks to "search", "look up", "find out", or "what is"
- When fact-checking or verifying claims
- When researching current events or recent developments
- When gathering background information on any topic
- When finding documentation, tutorials, or technical references

## Tools Available
- `crow_web_search` (crow-projects): web search. Each result is stamped `SNIPPET, not a source`.
- `crow_add_source` (crow-projects): Crow opens the page and stores it as a source.
- The Brave Search MCP server, when installed: web and local search. Its results are snippets too.

If `crow_web_search` says search is not configured, use Brave Search if you have it, or ask the user for a URL.

## Workflow: Research Search
1. Formulate a clear search query
2. Search with `crow_web_search`
3. Pick the few results that look relevant and credible. They are leads, not sources.
4. For each result you want to use, call `crow_add_source` with its `url`, `title` and `source_type`:
   - `CITABLE: Crow fetched this page.` → read the page text in the result; you may cite it
   - `NOT citable: Crow could not open this page (...)` → do not cite it; find another source
5. Cite only sources Crow fetched. Never cite a snippet, even when it looks like the answer.
6. For notes, quotes and verification, follow the `research-pipeline` skill

## Workflow: Quick Lookup
For simple factual queries that don't need a research project:
1. Search for the specific fact
2. Open the best result with `crow_add_source` and check the fact in the page text
3. Present the answer and name the page it came from
4. If you could not open any page, say the answer comes from search snippets only and is unchecked

## Workflow: Literature Discovery
When searching for academic or technical content:
1. Search for initial discovery
2. Cross-reference with arXiv for academic papers
3. Check Zotero for items already in the user's library
4. Open each paper you will use with `crow_add_source` before citing it

## Best Practices
- Never present a snippet as a checked fact
- Use specific, well-formed queries for better results
- Cross-reference with academic search for scholarly topics
- Store search strategies that work well in memory for reuse

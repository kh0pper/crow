# Research Pipeline Skill

## Description
Manage academic and professional research with full source tracking, APA citations, and verification. Every piece of information gathered during research is documented, cited, and verifiable.

## When to Use
- When conducting research on any topic
- When the user shares an article, paper, or link to document
- When web search results yield useful information
- When information is gathered from any external source
- When organizing findings into a research project

## Tools Available
Use the `crow-projects` MCP server tools.

## Workflow: Starting a Research Project
1. Use `crow_create_project` with a clear name and description
2. Define tags for the project's key themes
3. Begin gathering sources

## Workflow: Documenting a Source
Every time you encounter useful information, document it:

1. **Identify the source type**: web_article, academic_paper, book, interview, web_search, web_scrape, api_data, document, video, podcast, social_media, government_doc, dataset, other
2. **Gather metadata**: title, authors, URL, publication date, publisher
3. **Use `crow_add_source`** with all available metadata
4. **APA citation**: Provide manually if you know the exact format, otherwise the system auto-generates one
5. **Add notes**: Use `crow_add_note` for key quotes, summaries, analysis, questions, or insights

## Citation Formats

Crow generates citations in four formats from source metadata — no extra columns needed:

- **APA** (default) — `Author (Year). Title. Publisher. URL`
- **MLA** — `Author. "Title." *Publisher*, Date. URL.`
- **Chicago** — `Author. "Title." Publisher. Date. URL.`
- **Web** — `Title. URL. Accessed DATE. [Found via METHOD]`

Use `citation_format` on `crow_add_source` to set the primary stored format. Use `crow_get_source` to see all formats. Use `crow_generate_bibliography` with `format: "mla"` (or `apa`, `chicago`, `web`, `all`) to generate bibliographies in any format.

## Source Verification Rules

1. **Record retrieval method**: Always set `retrieval_method` — note whether the source was found via AI search, direct URL, library database, or user-provided link
2. **Prefer primary sources**: When AI search returns a summary, trace back to the original source and store that instead
3. **Verify before storing**: When AI search surfaces a URL, verify it is real and accessible before calling `crow_add_source`
4. **Link claims to sources**: All factual claims in research output must reference a stored, cited source — no unverified assertions
5. **Mark AI-discovered sources**: Use `retrieval_method: "AI search via [model name]"` so users can distinguish AI-found from user-provided sources

## Workflow: Verifying Sources
1. Check if the URL is still accessible
2. Verify author and publication information
3. Cross-reference claims with other sources
4. Use `crow_verify_source` to mark as verified with notes

## Workflow: Generating a Bibliography
Use `crow_generate_bibliography` with:
- `project_id` for project-specific bibliographies
- `tag` to filter by topic
- `verified_only: true` for verified-only bibliographies
- `format` for citation style: `apa` (default), `mla`, `chicago`, `web`, or `all`

## Note Types
- **note**: General observation or comment
- **quote**: Direct quote from the source (include page/paragraph reference)
- **summary**: Your summary of the source's key points
- **analysis**: Your analysis or interpretation
- **question**: Questions raised by the source
- **insight**: Connections, patterns, or original insights

## Best Practices
- Always document the retrieval method (how you found the source)
- Rate relevance honestly (1-10)
- Tag sources consistently within a project
- Add summaries for every source — future searches depend on good summaries
- Verify important sources before citing in final work
- Use quotes sparingly and always with proper attribution

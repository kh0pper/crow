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

## APA Citation Format Reference

### Web Article
Author, A. B. (Year, Month Day). Title of article. *Website Name*. URL

### Academic Paper
Author, A. B., & Author, C. D. (Year). Title of article. *Journal Name, Volume*(Issue), Pages. https://doi.org/xxxxx

### Book
Author, A. B. (Year). *Title of book*. Publisher.

### Video
Author, A. B. [Username]. (Year, Month Day). *Title of video* [Video]. Platform. URL

### Interview
Interviewee, A. B. (Year, Month Day). Title/description [Interview].

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

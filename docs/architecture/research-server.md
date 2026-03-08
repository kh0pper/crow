# Research Server

The research server (`servers/research/`) provides a structured research pipeline with project management, source tracking, APA citation generation, and bibliography output.

## Tools

### crow_create_project

Create a new research project.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Project name |
| `description` | string | No | Project description and goals |
| `tags` | string | No | Comma-separated tags |

### crow_list_projects

List all research projects with optional status filter.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `status` | string | No | Filter by status |

### crow_update_project

Update a research project's name, description, status, or tags.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | number | Yes | Project ID |
| `name` | string | No | New name |
| `description` | string | No | New description |
| `status` | string | No | New status (active, paused, completed, archived) |
| `tags` | string | No | New tags |

### crow_add_source

Add a source to the research pipeline. Automatically generates an APA citation if none is provided.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `title` | string | Yes | Source title |
| `source_type` | string | Yes | Type (see list below) |
| `project_id` | number | No | Associate with a research project |
| `url` | string | No | URL where the source was found |
| `authors` | string | No | Author(s) in "Last, F. M." format |
| `publication_date` | string | No | Publication date (YYYY-MM-DD or YYYY) |
| `publisher` | string | No | Publisher or website name |
| `doi` | string | No | DOI (for academic papers) |
| `isbn` | string | No | ISBN (for books) |
| `abstract` | string | No | Abstract or brief description |
| `content_summary` | string | No | Summary of key points and findings |
| `full_text` | string | No | Full text content if available |
| `citation_apa` | string | No | Manual APA citation (auto-generated if omitted) |
| `retrieval_method` | string | No | How the source was obtained |
| `tags` | string | No | Comma-separated tags |
| `relevance_score` | number | No | How relevant to the project, 1-10 (default: 5) |

**Source types**: `web_article`, `academic_paper`, `book`, `interview`, `web_search`, `web_scrape`, `api_data`, `document`, `video`, `podcast`, `social_media`, `government_doc`, `dataset`, `other`

### crow_search_sources

Search sources using full-text search.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Search query |
| `source_type` | string | No | Filter by type |
| `project_id` | number | No | Filter by project |
| `limit` | number | No | Max results |

### crow_get_source

Get full details of a specific source.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `source_id` | number | Yes | Source ID |

### crow_verify_source

Mark a source's verification status.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `source_id` | number | Yes | Source ID |
| `verified` | boolean | Yes | Verification status |
| `verification_notes` | string | No | Notes about verification |

### crow_list_sources

List sources with optional filtering.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | number | No | Filter by project |
| `source_type` | string | No | Filter by type |
| `verified` | boolean | No | Filter by verification status |
| `limit` | number | No | Max results |

### crow_add_note

Add a research note, optionally linked to a project or source.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `content` | string | Yes | Note content |
| `note_type` | string | No | Type: note, quote, summary, analysis, question, insight (default: note) |
| `project_id` | number | No | Associated project |
| `source_id` | number | No | Associated source |
| `title` | string | No | Note title |
| `tags` | string | No | Comma-separated tags |

### crow_search_notes

Search research notes by content.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Search terms |
| `project_id` | number | No | Filter by project |
| `note_type` | string | No | Filter by type (note, quote, summary, analysis, question, insight) |
| `limit` | number | No | Max results (default: 10) |

### crow_generate_bibliography

Generate a formatted APA bibliography for a project or filtered set of sources.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | number | No | Generate bibliography for this project |
| `tag` | string | No | Filter by tag |
| `verified_only` | boolean | No | Only include verified sources (default: false) |

### crow_research_stats

Get statistics about the research pipeline. No parameters.

## Resources

### research://projects

Returns the list of all research projects.

## APA Citation Generation

The server automatically generates APA citations when adding sources. The citation format varies by source type:

- **Academic papers**: `Author (Year). Title. Publisher. DOI/URL`
- **Books**: `Author (Year). *Title*. Publisher.`
- **Web articles**: `Author (Year). Title. Site Name. URL`
- **Other types**: Standard APA format with available fields

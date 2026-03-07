# Research Server

The research server (`servers/research/`) provides a structured research pipeline with project management, source tracking, APA citation generation, and bibliography output.

## Tools

### crow_create_project

Create a new research project.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Project name |
| `description` | string | No | Project description |
| `status` | string | No | active, paused, completed, archived (default: active) |

### crow_list_projects

List all research projects with optional status filter.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `status` | string | No | Filter by status |

### crow_update_project

Update a research project.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | number | Yes | Project ID |
| `name` | string | No | New name |
| `description` | string | No | New description |
| `status` | string | No | New status |

### crow_add_source

Add a source to the research pipeline. Automatically generates an APA citation.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `title` | string | Yes | Source title |
| `url` | string | No | Source URL |
| `source_type` | string | No | Type (see list below) |
| `authors` | string | No | Author name(s) |
| `publication_date` | string | No | Publication date |
| `publisher` | string | No | Publisher name |
| `doi` | string | No | DOI identifier |
| `abstract` | string | No | Source abstract/summary |
| `tags` | string | No | Comma-separated tags |
| `project_id` | number | No | Link to a project |
| `notes` | string | No | Initial notes |

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

Add a research note linked to a source.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `source_id` | number | Yes | Source to link note to |
| `content` | string | Yes | Note content |
| `note_type` | string | No | Type: summary, quote, analysis, question, methodology |

### crow_search_notes

Search research notes.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Search query |
| `source_id` | number | No | Filter by source |

### crow_generate_bibliography

Generate a formatted bibliography for a project.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | number | Yes | Project ID |
| `format` | string | No | Citation format (default: APA) |

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

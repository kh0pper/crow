# Project Server

The project server (`servers/research/`) provides structured project management with support for different project types, source tracking, APA citation generation, bibliography output, and data backend registration.

::: info Renamed from Research Server
This server was previously called "crow-research." The server name is now `crow-projects`, and the factory function is `createProjectServer` (the old `createResearchServer` name still works as a backward-compatible alias). The gateway mounts at `/projects/mcp` (primary) and `/research/mcp` (legacy alias).
:::

## Project Types

Projects have a `type` field that determines their purpose:

| Type | Description |
|---|---|
| `research` | Traditional research projects with sources, citations, and bibliography (default) |
| `data_connector` | Projects that connect to external data through registered backends |

The type is set when creating a project and determines which tools and workflows are relevant.

## Tools

### crow_create_project

Create a new project.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Project name |
| `description` | string | No | Project description and goals |
| `tags` | string | No | Comma-separated tags |
| `type` | string | No | Project type: `research` (default) or `data_connector` |

### crow_list_projects

List all projects with optional status filter.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `status` | string | No | Filter by status |

### crow_update_project

Update a project's name, description, status, or tags.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | number | Yes | Project ID |
| `name` | string | No | New name |
| `description` | string | No | New description |
| `status` | string | No | New status (active, paused, completed, archived) |
| `tags` | string | No | New tags |

### crow_add_source

Add a source to a project. Automatically generates an APA citation if none is provided. Most commonly used with `research` type projects.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `title` | string | Yes | Source title |
| `source_type` | string | Yes | Type (see list below) |
| `project_id` | number | No | Associate with a project |
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

Verify a source, or clear its verification. With `quotes_checked` the source is marked verified only when it has at least one quote note and every quote is found on the page Crow fetched. See [Verifying a source](#verifying-a-source).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | number | Yes | Source ID |
| `verified` | boolean | No | `true` to verify (default), `false` to clear verification |
| `method` | string | No | `quotes_checked` (default) or `manual_owner` (the owner only; bots cannot) |
| `notes` | string | No | Verification notes |

### crow_list_sources

List sources with optional filtering.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | number | No | Filter by project |
| `source_type` | string | No | Filter by type |
| `verified` | boolean | No | Filter by verification status |
| `limit` | number | No | Max results |

### crow_add_note

Add a note, optionally linked to a project or source.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `content` | string | Yes | Note content |
| `note_type` | string | No | Type: note, quote, summary, analysis, question, insight (default: note) |
| `project_id` | number | No | Associated project |
| `source_id` | number | No | Associated source |
| `title` | string | No | Note title |
| `tags` | string | No | Comma-separated tags |

### crow_search_notes

Search notes by content.

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

### crow_project_stats

Get statistics about projects and the research pipeline. No parameters.

## Data Backend Tools

These tools manage external data connections for `data_connector` type projects.

### crow_register_backend

Register an external MCP server as a data backend.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Backend name |
| `server_url` | string | Yes | MCP server URL |
| `description` | string | No | What data this backend provides |

### crow_list_backends

List all registered data backends. No parameters.

### crow_remove_backend

Remove a registered data backend.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `backend_id` | number | Yes | Backend ID |

### crow_backend_schema

Get the schema (available tools) from a registered backend.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `backend_id` | number | Yes | Backend ID |

## Resources

### research://projects

Returns the list of all projects.

## APA Citation Generation

The server automatically generates APA citations when adding sources. The citation format varies by source type:

- **Academic papers**: `Author (Year). Title. Publisher. DOI/URL`
- **Books**: `Author (Year). *Title*. Publisher.`
- **Web articles**: `Author (Year). Title. Site Name. URL`
- **Other types**: Standard APA format with available fields

## Fetch before cite

Crow opens a source's page itself before the source counts as citable. A bot's claim that it read a page is never taken on trust.

### Fetch statuses

`research_sources.fetch_status` is one of:

| Status | Meaning |
|---|---|
| `fetched` | Crow opened the page and stored its readable text |
| `fetched_no_text` | Crow opened the page but found no readable text (a PDF, an image, a script-only page) |
| `failed` | Crow could not open the page; the reason is stored in `fetch_error` |
| `not_applicable` | The source has no URL (a book, an interview), so there is nothing to fetch |
| `legacy` | The source predates fetching; shown as "legacy, unchecked" |
| `NULL` | The row arrived from a peer, a share or a clone; it was never checked here and is not citable here |

A source is **citable** when its status is `fetched`, `fetched_no_text` or `legacy`, or when it is `not_applicable` and the owner verified it by hand (`manual_owner`). Bibliographies cite only citable sources and say how many were left out; `include_unfetched` lists the rest, marked `[NOT FETCHED: ...]`.

`crow_add_source` with a URL fetches the page first (through the shared SSRF-guarded fetcher in `servers/shared/fetch-page.js`) and stores the final URL, HTTP status, a content hash and the page text. `crow_fetch_source` refreshes a stored copy. A refresh that finds no readable text keeps the earlier copy, and a refresh whose new text would break a passing quote check keeps the old text unless the owner passes `force: true`.

### Note provenance

Quote and summary notes state where the claim comes from: `fetched` (backed by a page Crow opened), `snippet` (only a search-result snippet, so not citable in prose yet) or `derived` (the writer's own reasoning). Analysis and insight notes default to `derived`. A quote note on a fetched source is checked against the page text and records `quote_found` (1, 0, or NULL when the check could not decide) and a `locator`. Provenance, `quote_found` and `locator` stay local: they are in `EXCLUDED_COLUMNS` (and dropped from inbound rows) in `servers/sharing/instance-sync.js`, because each is a judgment about this instance's own copy of the page.

### Verifying a source

`crow_verify_source` records how a source was verified in `verification_method`:

- `quotes_checked` (default): the source needs at least one quote note, and every quote must be found on the stored page. If the stored copy is over 30 days old, Crow re-opens the page first and adopts the new text only when every quote still matches. A quote that later fails its check clears a `quotes_checked` verification; the audit log records it as `invalidated`.
- `manual_owner`: the owner verifies by hand. Bots cannot. This is the only way to verify a `not_applicable` source.
- `legacy_flag`: set once by the migration on rows that were already marked verified. It was never checked against a page, so it is not shown as `[V]`.

### Who is the owner

The project server decides the caller's identity when it is built, and the owner has to be explicit. `npm run mcp-config` marks the generated crow-projects entry `CROW_ACTOR_KIND=owner`; a hand-written client config needs the same env to verify by hand over stdio. Gateway mounts started with `--no-auth`, bots, peer instances and callers that say nothing are never the owner. A bot's HTTP calls to the gateway's `router`, `projects`, `research` and `tools` mounts are blocked by the pi-bots url guard, so a bot cannot reach the owner path through the gateway.

### Quote matching

`servers/research/quote-match.js` decides whether a quote is on the page. A quote counts as found only when its exact wording appears on the page. Crow never reconstructs an edited quote.

- **Normalization:** both sides are folded the same way: Unicode NFKC, whitespace, soft hyphens and zero-width characters, case, and the styles of quotes, dashes and apostrophes. Outer quote marks and a trailing `.` `,` `;` `:` on the quote are trimmed; `?` and `!` are kept, because they change what the sentence says.
- **Word boundaries:** a match must start and end on a word boundary. Hyphenated words and numbers such as `2.5` or `1,500` count as whole words.
- **Where it looks:** the Readability text first, then the full page body. A result reports `body` when the match came from the full body.
- **Allowed edits in a quote:** `[sic]`, `[citation needed]`, and a single capital-letter bracket that starts a word (`[I]t`). Any ellipsis or any other bracket makes the check "couldn't check exactly": quote the passage without cuts, or verify by hand. Footnote markers such as `[3]` are ignored on the page side only.
- **Couldn't check:** a quote over 2,000 characters, under 4 characters, or with too many possible placements on the page. A page that was cut off at the size cap and has no match is also "couldn't check", never "not on the page".
- **Attribution:** the full quote is tried first. Only if it is not found is a trailing dash or after-quote tail dropped, and only when the tail looks like a name: two or more capitalized words, not starting with words such as The, Never or Not, with an optional `, Title`. Put the speaker or publication in your own sentence, not inside the quote.
- **Result:** found (1), not found (0), or couldn't check (NULL).

Known limits: substring matching cannot tell when the page itself denies the quoted sentence, or when a match comes from page furniture such as a menu or footer (the result then reports `body`).

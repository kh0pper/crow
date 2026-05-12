---
name: capstone-research-workflow
description: Navigate the Texas School Finance Capstone (project_id=6) corpus from any Claude session — sources, drafts, case studies, PIRs, and publishing. Tools work from any host with the Crow MCP gateway available.
triggers:
  - capstone research
  - texas school finance capstone
  - school finance capstone
  - case study chapter
  - ARC regression
  - charter duplication
  - school finance research
  - PIR response
  - publish capstone chapter
  - capstone bibliography
  - capstone draft
  - INSD 5941
tools:
  - crow_list_projects
  - crow_list_sources
  - crow_search_sources
  - crow_get_source
  - crow_add_source
  - crow_generate_bibliography
  - crow_search_memories
  - crow_store_memory
  - crow_recall_by_context
  - crow_data_query
  - crow_data_case_study_publish
  - crow_list_files
  - crow_kb_search
---

# Capstone Research Workflow

The Texas School Finance Capstone is registered as **`research_projects.id=6`** on grackle's `crow.db`. After Phase 6 of the rosy-blossom plan, every PDF source, case-study section, PIR response, and chapter draft is addressable via Crow gateway MCP tools — no filesystem fumbling required.

## When to Activate

User mentions any of: the capstone, INSD 5941, a specific chapter (1, 2, 3, 4A-E, 5), Texas school finance research, ARC scores, charter/ISD duplication, bond elections, TIA, PIR responses from districts (Austin ISD, Cleveland ISD, Dallas ISD, KIPP, IDEA, ILTexas, Aldine, etc.), or asks to publish/browse/search the corpus.

## Corpus Quick Reference

| Resource | Location | Tool |
|---|---|---|
| Project metadata | `research_projects.id=6` | `crow_list_projects(type='research')` |
| Source citations (271 rows) | `research_sources WHERE project_id=6` | `crow_list_sources(project_id=6)` / `crow_search_sources(query, project_id=6)` |
| Source PDFs on disk | `~/spring-2026/insd-5941/sources/` | (filesystem) — `file_path` on each row |
| Source PDFs in MinIO | `crow/capstone-research/sources/` | `crow_list_files(bucket='capstone-research')` — `s3_key` on each row |
| Case studies (16 rows) | `data_case_studies WHERE project_id=6` | `crow_data_query` |
| Case study sections (167 rows) | `data_case_study_sections` | `crow_data_query` |
| PIR file index (849 rows) | `capstone_pir_files` | `crow_data_query` — `minio_key` per row |
| PIR raw files | MinIO `crow/capstone-research/pirs/` and `sources/<district>-pir*/` | `crow_list_files` |
| Drafts (~100 md files) | `~/spring-2026/insd-5941/drafts/` | `kb_search` (spring-2026 local KB) — pending Phase 6.3 indexing into Crow KB |
| Published chapters | `blog_posts WHERE status='published'` linked to case studies | `crow_list_posts(status='published')` |
| Blog URL | `https://maestro.press/blog/<slug>` | (web) |
| Project bibliography | computed from `research_sources` | `crow_generate_bibliography(project_id=6)` |

## Workflows

### 1. Session startup — orient to current state

1. **Confirm project metadata is current.**
   - `crow_list_projects(type='research')` — verify Texas School Finance Capstone (id=6) is listed and protected (`is_protected=1`).
   - For the structured `book_status` JSON and provenance fields: `crow_data_query("SELECT name, status, source_archive_path, gitea_archive_url, book_status FROM research_projects WHERE id=6", database='crow')`.

2. **Recall prior session decisions.**
   - `crow_recall_by_context(context='capstone-2026', limit=10)` returns recent notes tagged for this work.
   - Project-tagged memories: `crow_search_memories(query='<topic>', limit=10)` — combine with `category` or `tags` filter if known.

3. **Check publication state.**
   - `crow_data_query("SELECT cs.title, bp.status, bp.published_at FROM data_case_studies cs LEFT JOIN blog_posts bp ON bp.id = cs.blog_post_id WHERE cs.project_id=6 ORDER BY cs.display_order")` — shows which chapters are published vs draft.

### 2. Find sources

| Need | Tool | Example |
|---|---|---|
| Sources matching a topic | `crow_search_sources(query, project_id=6)` | `crow_search_sources(query='charter duplication', project_id=6)` |
| List all sources of a type | `crow_list_sources(project_id=6, source_type='academic_paper')` | source_type ∈ academic_paper, dataset, government_doc, web_article, book, other |
| Verified-only | `crow_list_sources(project_id=6, verified_only=true)` | |
| Sources with downloadable PDFs | `crow_data_query("SELECT id, title, file_path, s3_key FROM research_sources WHERE project_id=6 AND s3_key IS NOT NULL ORDER BY id", database='crow')` | ~15 academic papers + gov docs linked to MinIO post-6.2 |
| Full citation list | `crow_generate_bibliography(project_id=6)` | Returns APA bibliography for all sources |

### 3. Browse / fetch source PDFs

Sources with `s3_key` set can be fetched from MinIO:
- `crow_list_files(bucket='capstone-research', limit=50)` — browse the bucket
- Direct path: `crow/capstone-research/sources/<key>` (e.g., `Bifulco_2007.pdf`)
- District-specific archives: `crow/capstone-research/sources/austin-isd-r000873/`, `cleveland-isd-pir/`, etc.

Sources WITHOUT `s3_key` are URL-only (visit the `url` field). Most non-academic-paper sources fall into this category by design.

### 4. Add new source

When the user shares a new paper or citation:

1. Verify it's not a duplicate: `crow_search_sources(query='<title keywords>', project_id=6)` — flag rows 33/240 (Templeton 2023 dupes) as a known case.
2. Add via `crow_add_source(title, source_type, project_id=6, url, authors, publication_date, doi, citation_apa, ...)` — auto-APA via the gateway.
3. If the user provides a PDF: upload to MinIO at `capstone-research/sources/<author>_<year>.pdf` (or under the appropriate district subdir), then update the row's `file_path` + `s3_key` via `crow_data_query("UPDATE research_sources SET file_path=?, s3_key=? WHERE id=?")` (write-mode).

### 5. Save a finding for future sessions

```
crow_store_memory(
  content="<the finding, with context>",
  category='research',
  tags=['capstone', 'project-6', '<district-or-topic-slug>'],
  context='capstone-2026',
  source='session-<date>',
  importance=4
)
```

Retrieve later via `crow_recall_by_context(context='capstone-2026')` or `crow_search_memories(query='<topic>', category='research')`.

### 6. Publish a new chapter

Per the data-dashboard skill, the publish pipeline is:
1. `crow_data_case_study_create(...)` to register a new chapter row, OR edit an existing one with `crow_data_query` UPDATE.
2. Add sections (text, charts, figures) — see `data-dashboard` skill workflows.
3. `crow_data_case_study_publish(case_study_id, ..., confirm_token)` to publish to the blog.
4. The case study's `blog_post_id` will be set; the public URL is `https://maestro.press/blog/<slug>`.

### 7. Lookup drafts (transitional, pre-Phase-6.3)

Until Phase 6.3 indexes drafts into the Crow knowledge base, drafts in `~/spring-2026/insd-5941/drafts/` are searchable two ways:
- **From a `~/spring-2026` session**: use the project-local MCP tools `kb_search(query)`, `kb_deep_recall(query)`, `kb_get_draft(name)` (per the `using-knowledge-base` skill in that directory).
- **From any other session**: read the relevant draft via filesystem if accessible, or via gitea (`git@gitea:kh0pp/spring-2026.git`).

Post-Phase-6.3 this section will be updated to use `crow_kb_search` against the crow knowledge-base bundle.

## Conventions and gotchas

- The **canonical project name** is "Texas School Finance Capstone" (research_projects.id=6 on grackle). Always reference the row by `project_id=6` — do not create duplicates.
- **rows 33 and 240** in research_sources are duplicate citations of the same Templeton 2023 "Feast and Famine" paper. Until manually deduped, prefer row 240 (more complete).
- **The `highlighted/` subdir** under `insd-5941/sources/` contains annotated copies of root-level academic papers — never use these as the canonical PDF reference.
- **Two files with CRLF in their names** are intentionally skipped by all tooling (`mc mirror`, the indexer). To use them, rename to remove the embedded `\r\n` first.
- **MinIO orphan**: `commission-on-school-finance/expenditures-workgroup-foundation-school-program-overview-presentation.pptx` is in MinIO but no longer on disk. Safe to ignore or delete with `mc rm`.
- **Per-host crow.db divergence**: project 6 lives only on grackle's `crow.db`. Crow's `crow.db` has 0 rows in `research_projects`. After Phase 6.7 moves the working dir to crow, the row will be migrated. Until then, gateway tools targeting project 6 must hit grackle's instance (this is the default for sessions launched on grackle).
- **`book_status` JSON** on research_projects.id=6 holds publication progress (`{schema_version, as_of, total_chapters, published, drafted, outlined, ...}`). It's a snapshot — regenerate before relying on it for stale-detection.

## Cross-references

- Data dashboard / SQL queries / case study editing: `data-dashboard` skill.
- Adding new sources via the dedicated panel UI: `data-dashboard` skill, "Case Studies" section.
- Spring-2026-local KB (kb_warmup, kb_deep_recall, kb_search): `using-knowledge-base` skill in `~/spring-2026/.claude/skills/`.
- The rosy-blossom plan: `~/.claude/plans/ok-i-think-we-rosy-blossom.md` (Phase 6 sub-phases).

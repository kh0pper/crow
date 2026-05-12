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
  - kb_search
  - kb_deep_recall
  - kb_list_drafts_indexed
---

# Capstone Research Workflow

The Texas School Finance Capstone is registered as **`research_projects.id=6`** on both grackle's and crow's `crow.db` (project row mirrored in Phase 6.4). After Phases 6.7–6.9 of the rosy-blossom plan (executed 2026-05-12), the canonical working tree lives on **crow at `~/spring-2026/`**, mirrored to **Gitea at `kh0pp/capstone-research`** (renamed from `spring-2026`), with every PDF source, case-study section, PIR response, and chapter draft addressable via Crow gateway MCP tools — no filesystem fumbling required.

## When to Activate

User mentions any of: the capstone, INSD 5941, a specific chapter (1, 2, 3, 4A-E, 5), Texas school finance research, ARC scores, charter/ISD duplication, bond elections, TIA, PIR responses from districts (Austin ISD, Cleveland ISD, Dallas ISD, KIPP, IDEA, ILTexas, Aldine, etc.), or asks to publish/browse/search the corpus.

## Corpus Quick Reference

| Resource | Location | Tool |
|---|---|---|
| Project metadata | `research_projects.id=6` | `crow_list_projects(type='research')` |
| Source citations (270 rows) | `research_sources WHERE project_id=6` (grackle's `crow.db`) | `crow_list_sources(project_id=6)` / `crow_search_sources(query, project_id=6)` |
| Source PDFs on disk | `crow:~/spring-2026/insd-5941/sources/` | (filesystem) — `file_path` on each row, relative to `~/spring-2026/` |
| Source PDFs in MinIO | `crow/capstone-research/sources/` | `crow_list_files(bucket='capstone-research')` — `s3_key` on each row |
| Case studies (16 rows) | `data_case_studies WHERE project_id=6` (grackle-only) | `crow_data_query` against grackle's instance |
| Case study sections (167 rows) | `data_case_study_sections` (grackle-only, no `backend_id` column — SQL is inline in `sql`/`config` TEXT) | `crow_data_query` |
| PIR file index (849 rows) | `capstone_pir_files` | `crow_data_query` — `minio_key` per row |
| PIR raw files | MinIO `crow/capstone-research/pirs/` and `sources/<district>-pir*/` | `crow_list_files` |
| Drafts (125 .md files / 1251 chunks indexed) | `crow:~/spring-2026/insd-5941/drafts/` on disk; chunks in crow KB's `project_docs` collection (Phase 6.3) | `kb_search(query, types=['project_docs'])` / `kb_deep_recall(topic)` |
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

1. Verify it's not a duplicate: `crow_search_sources(query='<title keywords>', project_id=6)`. Convention for `file_path`: `insd-5941/sources/<author>_<year>.pdf` (Title_Year, e.g., `Bifulco_2007.pdf`, `Templeton_2023.pdf`); for `s3_key`: `sources/<author>_<year>.pdf`.
2. Add via `crow_add_source(title, source_type, project_id=6, url, authors, publication_date, doi, citation_apa, ...)` — auto-APA via the gateway.
3. If the user provides a PDF: drop it at `crow:~/spring-2026/insd-5941/sources/<author>_<year>.pdf`, upload to MinIO at `capstone-research/sources/<author>_<year>.pdf`, then `crow_data_query("UPDATE research_sources SET file_path=?, s3_key=? WHERE id=?")` (write-mode).

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

### 7. Lookup drafts

Drafts are indexed (Phase 6.3, 2026-05-12) in crow's knowledge-base-mcp `project_docs` Chroma collection — 125 markdown files / 1251 chunks, embedded via the Qwen3-Embedding-0.6B endpoint at `crow:8004` (1024 dims).

- **Semantic search a specific topic:** `kb_search(query='<topic>', types=['project_docs'])` — explicit collection filter.
- **Cross-collection deep recall:** `kb_deep_recall(topic='<topic>')` — surfaces project_docs hits under the "other" bucket alongside memories, sources, and notes.
- **List indexed drafts:** `kb_list_drafts_indexed(project_id='6')` — returns title, document_type, local_path, tags, word_count, chunks, content_hash for every indexed draft.
- **Register a new / re-register a changed draft:** `kb_register_draft(title, local_path, document_type, project_id='6', tags=['…'])` — chunks via the same ~500-word / 50-overlap chunker and upserts. Stable `draft_id = sha256(absolute_path)[:16]`, so re-registering the same path replaces prior chunks. If a draft *shrank*, call `kb_delete_draft(draft_id)` first to purge stale higher-index chunks.
- **Filesystem fallback:** the raw markdown is at `crow:~/spring-2026/insd-5941/drafts/` (read via SSH or directly from a session on crow).
- **Gitea backup:** `git@gitea:kh0pp/capstone-research.git` (the `spring-2026` repo was renamed in Phase 6.8). The old name redirects via Gitea's 301 but updating any consumer URLs to the new name is good hygiene.

## Conventions and gotchas

- The **canonical project name** is "Texas School Finance Capstone" (research_projects.id=6). The row exists on both grackle and crow as of Phase 6.4. Always reference the row by `project_id=6` — do not create duplicates.
- The **`highlighted/` subdir** under `insd-5941/sources/` contains annotated copies of root-level academic papers — use the non-highlighted top-level file as the canonical PDF reference (link `file_path = insd-5941/sources/<author>_<year>.pdf`).
- **Per-host crow.db divergence (still active):** `data_case_studies`, `data_case_study_sections`, `capstone_pir_files`, and `research_sources`(270 rows) live **only on grackle**. Crow's `crow.db` has only the `research_projects` row (mirrored) and instance-specific tables. Any case-study or source query routes to grackle's instance; sessions launched on crow without federation will see 0 rows. See `[[project-crow-db-per-host-divergence]]` in auto-memory for the full divergence map.
- **`book_status` JSON** on research_projects.id=6 holds publication progress (`{schema_version, as_of, total_chapters, published, drafted, outlined, ...}`). It's a snapshot — regenerate before relying on it for stale-detection.
- **Filesystem path stability:** `crow:~/spring-2026/` is the canonical path going forward (Phase 6.7, 2026-05-12). Grackle holds `~/spring-2026.PRE-MOVE.backup` until **2026-06-11** as a 30-day verification window. After that, the backup is deleted and any leftover grackle path reference will fail loudly — intentional, to surface missed consumers.
- **Backups are NOT in git** anymore (Phase 6.8 commit `b149dac`). The 41 historical backup files were removed from the index; `.gitignore` now excludes `backups/`. Database snapshots live in MinIO via the `crow/capstone-research/` bucket.
- **Gitea repo name:** the backup repo was renamed `spring-2026` → `capstone-research` in Phase 6.8. Old URL returns 301 redirect via Gitea, but `research_projects.gitea_archive_url` points to the new name.
- **fed-gov-data backend:** registered but its cache DB is 0-byte on both hosts as of 2026-05-12. First fed-data query will populate it. Need `CENSUS_API_KEY` in `~/.crow/env/fed-gov.env` on the host running the MCP — see `[[project-fed-gov-data-db-empty]]`.

## Cross-references

- Data dashboard / SQL queries / case study editing: `data-dashboard` skill.
- Adding new sources via the dedicated panel UI: `data-dashboard` skill, "Case Studies" section.
- KB tool usage details (chunking, idempotent re-index, dim gotcha): see `[[reference-kb-mcp-register-draft]]` and `[[reference-crow-embedding-endpoint]]` in auto-memory.
- The rosy-blossom plan: `~/.claude/plans/ok-i-think-we-rosy-blossom.md` (Phase 6 sub-phases).
- Spring-2026 move history: `[[project-spring2026-moved-to-crow]]` in auto-memory.

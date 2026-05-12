# research/ — Capstone Research Pipeline

Reproducibility scripts for the Texas School Finance Capstone
(`research_projects.id=6` — see `~/crow/bundles/data-dashboard/`,
[capstone-research-workflow skill](../../bundles/data-dashboard/skills/capstone-research-workflow.md)).

Most scripts assume the working corpus lives at `~/spring-2026/`. After
[plan-rosy-blossom](https://github.com/kh0pper/crow) Phase 6.7 moves the
corpus to crow, set `CAPSTONE_ROOT` to override. All scripts honor:

| Env var | Default | What it overrides |
|---|---|---|
| `CAPSTONE_ROOT` | `~/spring-2026` | Working corpus root |
| `CROW_DB` | `~/.crow/data/crow.db` | crow.db location |
| `TEA_DB_PATH` | `$CAPSTONE_ROOT/texas-gov-data-mcp/data/tea_data.db` | TEA cache DB |
| `CANVAS_DB` | `$CAPSTONE_ROOT/canvas-companion/db/canvas.db` | Legacy canvas-companion DB (still exists, service disabled in Phase 1.1) |
| `MINIO_ENDPOINT` | minio at crow:9000 | MinIO base URL |
| `CAPSTONE_BUCKET` | `crow/capstone-research` | MinIO bucket |
| `SPRING_ROOT` | `~/spring-2026` | Legacy alias used by index_sources_to_minio.py |

## Scripts

### Publication pipeline

| Script | Purpose |
|---|---|
| `publish_chapter.mjs` | Render a case study to `maestro.press/blog`. Reads `data_case_studies` + `data_case_study_sections` from crow.db, materializes figures, uploads to MinIO, posts to WriteFreely. Usage: `node publish_chapter.mjs <case_study_id> [--overwrite] [--write]`. |
| `publish_chapter.sh` | Bash wrapper around `publish_chapter.mjs` with env-var conveniences. |
| `build_chapter_plan.py` | Builds the chapter plan / publication checklist from `data_case_studies` rows. |

### crow.db sync (from canvas-companion legacy → research-mcp / data-dashboard)

| Script | Purpose |
|---|---|
| `sync_case_studies_to_crow.py` | Copies `case_studies` + `case_study_sections` from `canvas.db` into `crow.db` as `data_case_studies` + `data_case_study_sections`. |
| `sync_research_sources_to_crow.py` | Copies the bibliography rows from `canvas.db.research_sources` → `crow.db.research_sources`. |
| `sync_pirs_to_crow.py` | Copies PIR (public-information-request) metadata into `crow.db` `research_notes` rows. |

### MinIO mirroring

| Script | Purpose |
|---|---|
| `index_sources_to_minio.py` | Walks `~/spring-2026/insd-5941/sources/`, uploads new files to `crow/capstone-research/sources/`, links to `research_sources.s3_key`. Idempotent (sha256-keyed). `--dry-run`, `--force` supported. |
| `migrate_to_crow_s3_manifest.py` | Reads `mc ls --recursive crow/capstone-research` and emits a jsonl manifest mapping s3 keys → local source paths + sha256 + bytes + content_type. Backup/verification artifact. |

### Chapter content builders (per-case-study)

| Script | Purpose |
|---|---|
| `populate_chapter_1_san_antonio.py` | Builds the San Antonio case-study sections (text + chart + map) into `data_case_studies` + `data_case_study_sections`. |
| `populate_chapter_3_austin_mendez.py` | Austin/Mendez Settlement chapter. |
| `populate_chapter_5_houston.py` | Houston charter-duplication chapter. |
| `populate_chapter_7_conclusion.py` | Final conclusion / synthesis chapter. |

### Figure renderers

| Script | Purpose |
|---|---|
| `houston_render_charter_map.py` | Renders Houston charter footprint map PNG. Requires `~/spring-2026/scripts/.venv/bin/python` (matplotlib + geopandas). |
| `houston_build_timeline.py` | Renders Houston charter timeline PNG. Requires `~/spring-2026/texas-gov-data-mcp/.venv/bin/python`. |

### PIR data loaders + updaters (one-shot loaders for specific PIR responses)

| Script | Purpose |
|---|---|
| `load_austin_isd_pir_data.py` | Ingests Austin ISD PIR response into TEA tables (campus financial / staffing). |
| `load_edgewood_pir_data.py` | Edgewood ISD PIR loader. |
| `load_idea_austin_pir_data.py` | IDEA Public Schools (Austin) PIR loader. |
| `load_iltexas_pir_data.py` | ILTexas PIR #11 (Mar 2026) — teacher salary schedules, certification, construction. Honors `ILTEXAS_PIR_DIR` + `TEA_DB_PATH` envs. |
| `update_cleveland_iltexas_pir_data.py` | Batch update for the Cleveland case study (`case_study_id=2`) integrating ILTexas findings into section bodies. **Note**: writes to `canvas.db` (legacy schema; pre-data-dashboard cutover). |
| `update_cleveland_pir_2502721.py` | Integrates findings from TEA PIR #2502721 into Cleveland + Austin + ARC case studies via canvas.db. |

### Infrastructure / utilities (added 2026-05-12)

| Script | Purpose |
|---|---|
| `index_drafts_to_kb.py` | Phase 6.3 bulk indexer — walks `$CAPSTONE_ROOT/insd-5941/drafts/*.md` and registers each via `kb_register_draft` (knowledge-base-mcp). |
| `register_data_backends.py` | Phase 6.4 — registers `tea_data` + `fed_gov_data` as named `data_backends` rows for the project. Idempotent. Per-host paths via `--host {grackle,crow}`. |
| `build_research_index.py` | Phase 6.6 — generates static HTML for `https://maestro.press/research`. Run with `--deploy` to rsync to the droplet. Re-run after each `publish_chapter.mjs` to refresh. |

## Conventions

- **Idempotency where the script's nature allows it.** Most loaders use INSERT…ON CONFLICT or DELETE-then-INSERT keyed by a stable natural id. Re-running a loader should converge state, not double-write.
- **Dry-run support.** Look for `--dry-run` (most loaders + the indexer). Bash wrappers and `.mjs` scripts use the same flag.
- **No secrets in scripts.** Credentials live in `.env` or `~/.crow/env/<service>.env`. The `MINIO_*` and `CENSUS_API_KEY` family are sourced by wrappers, not hard-coded.
- **`os.path.expanduser` everywhere.** No `/home/kh0pp/...` literals in code; all paths derived from `~` + env-var overrides.

## Adding a new script here

1. Drop the script in this directory.
2. Add an entry to the appropriate table above.
3. Use `CAPSTONE_ROOT` + env-var defaults, not hard-coded paths.
4. If it's a one-shot loader for a specific PIR response, name it `load_<district>_pir_<id>.py` or `update_<district>_pir_<id>.py`.
5. Commit with a `scripts/research: ...` commit prefix.

## Provenance

These scripts originated in `~/spring-2026/scripts/` on grackle and were
moved here in Phase 6.5 of the rosy-blossom plan (2026-05-12) as part of
elevating the capstone corpus to a first-class crow project.

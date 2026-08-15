# Reader

An e-reader bundle for Crow: import PDFs, web pages, and files; read
them in a clean paragraph view; keep the original as an archival copy.

This is **milestone 1**: import + Read view + server-authoritative
progress. TTS (gateway registry, timing-aware playback), quote-anchored
annotations with crow memory promotion, a pdf.js Original view, and
Drive/Doc export are on the roadmap and land in later milestones — the
schema for annotations/chunks/embeddings already exists so those
milestones don't need a migration.

## What it does today

- **Import** — upload a PDF/HTML/TXT/MD file, import a web page by URL
  (Readability-extracted, raw HTML archived), or hand it a local path
  or URL from an MCP client (`crow_reader_ingest`). Every import stores
  the original/archived copy alongside the extracted text.
- **Extraction** — PDFs go through a vendored PyMuPDF extractor
  (`scripts/extract.py`, run via `uv`): block-level text, `[TABLE]`
  markdown for tabular content, and a cleanup chain (de-hyphenation,
  paragraph reflow, long-paragraph sentence splitting) shared with the
  capstone-tracker bundle's e-reader pipeline. Web pages go through
  `@mozilla/readability` + `linkedom`. Extraction runs as a subprocess
  with a timeout and structured JSON errors — a failed or partial
  extraction still creates a document row (`extraction_status`:
  `ok` / `partial` / `failed`) rather than losing the import.
- **Read view** — `/reader-app/:id`, a plain paragraph view with
  section navigation and `[TABLE]` blocks rendered as HTML tables.
  Scroll position saves as reading progress (forward-only: a document
  never rewinds itself) and resumes on reload.
- **Library** — `/dashboard/reader` panel: an import card and a table
  of documents with source, extraction status, progress, and tags.
  FTS5 search over titles, tags, and sources backs `crow_reader_list`.
- **MCP tools** — `crow_reader_ingest` (import from a local path or
  URL; local paths are checked against an allowlist), `crow_reader_list`
  (FTS-searchable library listing), `crow_reader_get` (one document
  with its sections).

## Requirements

- **[uv](https://docs.astral.sh/uv/)** on `PATH` (or point
  `READER_UV_BIN` at it) — runs the PDF extractor as a self-contained
  script; its `pymupdf` dependency is declared inline and resolved by
  `uv` on first run, no separate `pip install` needed.
- **System Tesseract + tessdata** for the `--ocr` extraction path
  (scanned/image-only PDFs). PyMuPDF's `get_textpage_ocr` shells out to
  Tesseract at runtime and raises if it isn't installed — OCR import
  will fail with a structured error until `tesseract` and language
  data are present on the host. Regular text-layer PDFs need neither.

## Configuration

Config is layered: `$CROW_HOME/env/reader.env` → the file named by
`READER_SECRETS_FILE` → `process.env` (highest wins), same `KEY=VALUE`
format as the other bundles (`#` comments, optional `export `, quoted
values all accepted).

| Key | Purpose |
|---|---|
| `READER_SECRETS_FILE` | Optional second env file |
| `READER_EMBED_URL` / `READER_EMBED_MODEL` | OpenAI-style embeddings endpoint for semantic search; unset disables it, FTS still works |
| `GOOGLE_TOKEN_FILE` | Google OAuth2 `authorized_user` JSON; unset hides Drive import and Doc export (later milestone) |
| `READER_EXPORT_DRIVE_FOLDER_ID` | Drive folder id for Google Doc exports (later milestone) |
| `READER_UV_BIN` | Path to the `uv` binary (default: `uv` on `PATH`) |
| `READER_EXTRACT_TIMEOUT_MS` | Extraction subprocess timeout in ms (default `180000`) |
| `READER_MAX_UPLOAD_MB` | Upload size cap in MB; also caps URL-import downloads (default `50`) |
| `READER_AUDIO_CACHE_MB` | TTS audio cache cap in MB, used from milestone 2 (default `2048`) |
| `READER_ALLOW_PRIVATE_URLS` | Set to `1` to let URL import fetch private/loopback addresses (default: blocked — SSRF guard) |
| `READER_INGEST_ROOTS` | Colon-separated directory allowlist for `crow_reader_ingest` local paths (default: the user home directory) |

URL import blocks private/loopback/link-local addresses by default
(including addresses reached only after a redirect — every hop is
re-checked, up to 5 hops) and caps response size at
`READER_MAX_UPLOAD_MB`. `READER_ALLOW_PRIVATE_URLS=1` is for
single-user or trusted-network instances that want to archive pages
served on the LAN; it does not relax the size cap or the scheme check
(`http`/`https` only).

## Storage

Tables in `crow.db`: `reader_documents` (+ FTS5), `reader_sections`,
`reader_progress`, `reader_annotations` (+ FTS5, unused until the
annotations milestone), `reader_chunks` / `reader_chunk_embeddings`
(unused until semantic search is wired up). Original files and
archived HTML land in `$CROW_DATA_DIR/reader/originals/` and
`$CROW_DATA_DIR/reader/archives/`.

## Panel

`/dashboard/reader` — the library: an import card (file upload or
URL) and a table of imported documents linking into the Read view.
Import and Read-view HTTP endpoints (`/api/reader/*`, `/reader-app/:id`)
live in the companion routes file per the gateway's panel-mount
contract; the panel itself only renders inside the dashboard.

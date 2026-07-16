"""
E-Reader routes - read textbook chapters and research sources with TTS narration.

Data sources (read-only) on this bundle:
    KB_DB_PATH (env EREADER_KB_DB)        — kb_textbooks, kb_chapters,
                                            kb_research_documents,
                                            kb_document_sections
    RESEARCH_DB_PATH (env EREADER_RES_DB) — research_sources
    RESEARCH_CACHE   (env EREADER_CACHE)  — full-text .txt + .pdf cache

All three are mounted into the container at /data/external (read-only) and
refreshed daily by grackle's sync-kb-to-crow.sh cron (Phase 4a.5).
"""

import asyncio
import json
import os
import re
import sqlite3
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel

from src.services.ereader_tts import (
    ereader_tts,
    extract_table_blocks,
    presplit_long_lines,
    reflow_pdf_text,
    restore_table_blocks,
    split_figure_captions,
    split_into_paragraphs,
    split_long_paragraph,
    strip_chart_axis_data,
    strip_publisher_watermarks,
    strip_running_headers,
    table_to_speech_text,
)
from src.models.database import (
    ReadingProgress, NoteTag, EReaderMaterialTag, EReaderPin, get_session,
)
from src.templates_config import templates
from sqlalchemy import select, delete

router = APIRouter()

KB_DB_PATH = Path(os.environ.get("EREADER_KB_DB", "/data/external/kb.db"))
RESEARCH_DB_PATH = Path(os.environ.get("EREADER_RES_DB", "/data/external/research.db"))
RESEARCH_CACHE = Path(os.environ.get("EREADER_CACHE", "/data/external/cache"))


def get_kb_connection():
    """Get connection to knowledge base database."""
    if not KB_DB_PATH.exists():
        return None
    conn = sqlite3.connect(str(KB_DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def get_research_connection():
    """Get connection to research database."""
    if not RESEARCH_DB_PATH.exists():
        return None
    conn = sqlite3.connect(str(RESEARCH_DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def _get_textbook_by_short_title(cursor, short_title: str) -> Optional[dict]:
    """Look up textbook by short_title."""
    cursor.execute(
        "SELECT * FROM kb_textbooks WHERE short_title = ?", (short_title,)
    )
    row = cursor.fetchone()
    return dict(row) if row else None


def _get_chapters_for_textbook(cursor, textbook_id: str) -> list[dict]:
    """Get all chapters for a textbook, ordered by chapter number."""
    cursor.execute(
        """SELECT id, textbook_id, chapter_number, title, content,
                  LENGTH(content) as content_length
           FROM kb_chapters
           WHERE textbook_id = ?
           ORDER BY chapter_number""",
        (textbook_id,),
    )
    chapters = []
    for row in cursor.fetchall():
        ch = dict(row)
        # Estimate word count from content
        if ch.get("content"):
            ch["word_count"] = len(ch["content"].split())
        else:
            ch["word_count"] = 0
        chapters.append(ch)
    return chapters


def _get_research_documents(cursor) -> list[dict]:
    """Get registered research documents with section counts."""
    try:
        cursor.execute("""
            SELECT d.id, d.title, d.short_title, d.document_type,
                   d.authors, d.publication_year, d.project_id,
                   COUNT(s.id) as section_count,
                   SUM(CASE WHEN s.content IS NOT NULL AND s.content != ''
                       THEN 1 ELSE 0 END) as sections_with_content
            FROM kb_research_documents d
            LEFT JOIN kb_document_sections s ON d.id = s.document_id
            GROUP BY d.id
            ORDER BY d.title
        """)
        docs = []
        for row in cursor.fetchall():
            doc = dict(row)
            # Parse authors for display
            if doc.get("authors"):
                try:
                    authors = json.loads(doc["authors"])
                    if authors:
                        doc["authors_short"] = (
                            f"{authors[0]} et al."
                            if len(authors) > 1
                            else authors[0]
                        )
                    else:
                        doc["authors_short"] = ""
                except (json.JSONDecodeError, TypeError):
                    doc["authors_short"] = ""
            else:
                doc["authors_short"] = ""
            docs.append(doc)
        return docs
    except sqlite3.OperationalError:
        return []


def _get_document_by_short_title(cursor, short_title: str) -> Optional[dict]:
    """Look up research document by short_title."""
    cursor.execute(
        "SELECT * FROM kb_research_documents WHERE short_title = ?",
        (short_title,),
    )
    row = cursor.fetchone()
    return dict(row) if row else None


def _get_sections_for_document(cursor, document_id: str) -> list[dict]:
    """Get all sections for a research document, ordered by section number."""
    cursor.execute(
        """SELECT id, document_id, section_number, title, content,
                  LENGTH(content) as content_length
           FROM kb_document_sections
           WHERE document_id = ?
           ORDER BY section_number""",
        (document_id,),
    )
    sections = []
    for row in cursor.fetchall():
        sec = dict(row)
        if sec.get("content"):
            sec["word_count"] = len(sec["content"].split())
        else:
            sec["word_count"] = 0
        sections.append(sec)
    return sections


def _get_research_sources_with_fulltext() -> list[dict]:
    """Get research sources that have cached full text."""
    conn = get_research_connection()
    if not conn:
        return []
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT source_id, title, authors, publication_year, status,
                   full_text_path
            FROM research_sources
            ORDER BY updated_at DESC
        """)
        sources = []
        for row in cursor.fetchall():
            s = dict(row)
            # Check if full text exists
            has_text = False
            if s.get("full_text_path"):
                ft = Path(s["full_text_path"])
                if not ft.is_absolute():
                    ft = RESEARCH_CACHE / s["full_text_path"]
                has_text = ft.exists()
            if not has_text:
                cache_file = RESEARCH_CACHE / f"{s['source_id']}.txt"
                has_text = cache_file.exists()
            if has_text:
                # Parse authors for display
                try:
                    authors = json.loads(s["authors"]) if s["authors"] else []
                    if authors and isinstance(authors[0], dict):
                        first = authors[0].get("family", "")
                        s["authors_short"] = f"{first} et al." if len(authors) > 1 else first
                    else:
                        s["authors_short"] = str(authors[0]) if authors else ""
                except (json.JSONDecodeError, TypeError):
                    s["authors_short"] = ""
                sources.append(s)
        return sources
    except sqlite3.OperationalError:
        return []
    finally:
        conn.close()


def _load_source_fulltext(source_id: str) -> Optional[str]:
    """Load full text for a research source."""
    # Check cache file first
    cache_file = RESEARCH_CACHE / f"{source_id}.txt"
    if cache_file.exists():
        return cache_file.read_text(encoding="utf-8")

    # Check database for path
    conn = get_research_connection()
    if not conn:
        return None
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT full_text_path FROM research_sources WHERE source_id = ?",
            (source_id,),
        )
        row = cursor.fetchone()
        if row and row["full_text_path"]:
            ft = Path(row["full_text_path"])
            if not ft.is_absolute():
                ft = RESEARCH_CACHE / row["full_text_path"]
            if ft.exists():
                return ft.read_text(encoding="utf-8")
    finally:
        conn.close()
    return None


# ── PDF Enrichment Helpers ────────────────────────────────────────────


def _extract_table_fingerprints(
    curated_tables: list[dict],
) -> dict[str, set[str]]:
    """Extract distinctive cell values from each curated table's markdown.

    Returns {marker: set_of_lowercase_fingerprints} for per-table matching,
    plus a combined "__all__" key for quick any-table checks.
    """
    per_table: dict[str, set[str]] = {}
    all_fps: set[str] = set()
    for table in curated_tables:
        marker = table.get("marker", "")
        md = table.get("markdown", "")
        fps: set[str] = set()
        for line in md.split("\n"):
            if line.startswith("|---") or not line.strip():
                continue
            cells = [c.strip().strip("*") for c in line.split("|") if c.strip()]
            for cell in cells:
                val = cell.lower()
                if len(val) >= 4:
                    fps.add(val)
        per_table[marker] = fps
        all_fps |= fps
    per_table["__all__"] = all_fps
    return per_table


def _replace_tables_with_curated(
    paragraphs: list[str], curated_tables: list[dict]
) -> list[str]:
    """Replace garbled table text with curated markdown tables.

    Strategy:
    1. Find all garbled-data runs (short paragraphs matching curated table
       cell fingerprints).
    2. Score each run against each curated table to find the best match.
       The highest-scoring run for each table gets the curated markdown;
       lower-scoring duplicate runs are deleted (echo removal).
    3. For curated tables that had no matching run, fall back to marker-based
       placement (find "TABLE N." and replace adjacent garbled content).
    4. Remove orphaned "TABLE N." marker paragraphs.
    """
    result = list(paragraphs)
    fp_map = _extract_table_fingerprints(curated_tables)
    all_fps = fp_map.get("__all__", set())

    if not all_fps:
        return result

    # ── Step 1: detect all garbled-data runs ──
    garbled_runs: list[tuple[int, int, int]] = []  # (start, end, match_count)
    i = 0
    while i < len(result):
        p = result[i].strip()
        if p.startswith("[TABLE]") or p.startswith("[IMAGE]"):
            i += 1
            continue

        p_lower = p.lower()
        if len(p) < 100 and any(fp in p_lower for fp in all_fps):
            run_start = i
            run_end = i
            matches = 0
            for j in range(i, len(result)):
                pj = result[j].strip()
                if pj.startswith("[TABLE]") or pj.startswith("[IMAGE]"):
                    break
                if len(pj) > 120 and pj[-1] in ".!?":
                    break
                pj_lower = pj.lower()
                if any(fp in pj_lower for fp in all_fps):
                    matches += 1
                    run_end = j + 1
                elif len(pj) < 80:
                    run_end = j + 1
                else:
                    break

            run_len = run_end - run_start
            if run_len >= 5 and matches >= 3:
                garbled_runs.append((run_start, run_end, matches))
                i = run_end
                continue
        i += 1

    # ── Step 1b: split runs at table-marker boundaries ──
    # When multiple tables' garbled data is contiguous (e.g., Tables 1-3 on
    # the same page), the run detector merges them into one mega-run.  Split
    # at paragraphs that exactly match a table marker so each table's data
    # gets its own run and can be scored independently.
    marker_texts_set = {t.get("marker", "") for t in curated_tables if t.get("marker")}
    split_runs: list[tuple[int, int, int]] = []
    for start, end, _match_count in garbled_runs:
        # Find split points: indices within the run that are exact marker matches
        splits = [start]
        for j in range(start + 1, end):
            if result[j].strip() in marker_texts_set:
                splits.append(j)
        splits.append(end)

        if len(splits) == 2:
            # No internal markers — keep original run
            split_runs.append((start, end, _match_count))
        else:
            # Re-evaluate each sub-run
            for si in range(len(splits) - 1):
                sub_start, sub_end = splits[si], splits[si + 1]
                sub_len = sub_end - sub_start
                sub_matches = 0
                for j in range(sub_start, sub_end):
                    pj_lower = result[j].strip().lower()
                    if any(fp in pj_lower for fp in all_fps):
                        sub_matches += 1
                # Lower threshold for sub-runs: they're already inside a
                # confirmed garbled region, so even 1 fingerprint match suffices.
                if sub_len >= 3 and sub_matches >= 1:
                    split_runs.append((sub_start, sub_end, sub_matches))
    garbled_runs = split_runs

    # ── Step 2: assign each curated table to its best-matching run ──
    # For each table, pick the run with the highest fingerprint score.
    table_to_run: dict[str, tuple[int, int]] = {}
    claimed_runs: set[int] = set()  # indices into garbled_runs

    for table in curated_tables:
        marker = table.get("marker", "")
        fps = fp_map.get(marker, set())
        if not fps:
            continue

        best_run_idx = -1
        best_score = 0
        for ri, (start, end, _) in enumerate(garbled_runs):
            if ri in claimed_runs:
                continue
            run_text = " ".join(
                result[j].strip().lower() for j in range(start, end)
            )
            # Skip runs containing another table's marker — they belong
            # to that table's area and would be false-positive matches
            # for tables with overlapping fingerprints.
            if any(
                other.get("marker", "").lower() in run_text
                for other in curated_tables
                if other.get("marker", "") != marker
            ):
                continue
            score = sum(1 for fp in fps if fp in run_text)
            if score > best_score:
                best_score = score
                best_run_idx = ri

        # Require at least 4 fingerprint matches to avoid false positives
        # from bibliography/summary sections that share a few keywords.
        if best_run_idx >= 0 and best_score >= 4:
            table_to_run[marker] = garbled_runs[best_run_idx][:2]
            claimed_runs.add(best_run_idx)

    # ── Step 3: apply replacements (reverse order to preserve indices) ──
    placed_markers: set[str] = set()

    # Collect all operations: (start, end, replacement_or_none)
    ops: list[tuple[int, int, str | None]] = []

    # Curated table placements
    for table in curated_tables:
        marker = table.get("marker", "")
        markdown = table.get("markdown", "")
        if marker in table_to_run:
            start, end = table_to_run[marker]
            ops.append((start, end, f"[TABLE]\n{markdown}"))
            placed_markers.add(marker)

    # Unclaimed runs: delete (echo duplicates)
    for ri, (start, end, _) in enumerate(garbled_runs):
        if ri not in claimed_runs:
            ops.append((start, end, None))

    # Apply in reverse index order
    ops.sort(key=lambda x: x[0], reverse=True)
    for start, end, replacement in ops:
        if replacement:
            result[start:end] = [replacement]
        else:
            del result[start:end]

    # ── Step 4: marker-based fallback (unplaced tables only) ──
    for table in curated_tables:
        marker = table.get("marker", "")
        markdown = table.get("markdown", "")
        if not marker or not markdown:
            continue
        if marker in placed_markers:
            continue

        # Prefer table headings over prose references.  Table headings
        # start with the marker and don't end with sentence punctuation
        # (e.g., "Table 4 Comparison of..."), while prose references end
        # with a period (e.g., "Table 4 documents the differences...").
        # Priority: (1) exact match, (2) startswith + no trailing period,
        # (3) startswith, (4) substring.
        marker_idx = None
        for i, p in enumerate(result):
            if p.strip() == marker:
                marker_idx = i
                break
        if marker_idx is None:
            for i, p in enumerate(result):
                ps = p.strip()
                if ps.startswith(marker) and ps[-1:] not in ".!?":
                    marker_idx = i
                    break
        if marker_idx is None:
            for i, p in enumerate(result):
                ps = p.strip()
                if ps.startswith(marker):
                    marker_idx = i
                    break
        if marker_idx is None:
            for i, p in enumerate(result):
                if marker in p:
                    marker_idx = i
                    break
        if marker_idx is None:
            continue

        # Check if marker paragraph itself contains garbled data
        # (e.g., heading + garbled table values merged into one paragraph
        # by presplit_long_lines).  If so, replace it rather than inserting after.
        marker_para = result[marker_idx].strip()
        if marker_para.startswith(marker) and len(marker_para) > len(marker) + 150:
            garbled_start = marker_idx
            garbled_end = marker_idx + 1
        else:
            garbled_start = marker_idx + 1
            garbled_end = garbled_start

        for j in range(garbled_end, len(result)):
            p = result[j].strip()
            if any(
                t.get("marker", "") in p
                for t in curated_tables
                if t is not table
            ):
                break
            if len(p) > 80 and p[-1] in ".!?":
                break
            if p.startswith("[TABLE]") or p.startswith("[IMAGE]"):
                break
            garbled_end = j + 1

        result[garbled_start:garbled_end] = [f"[TABLE]\n{markdown}"]
        placed_markers.add(marker)

    # ── Step 5: remove orphaned "TABLE N." marker paragraphs ──
    marker_texts = {t.get("marker", "") for t in curated_tables}
    result = [
        p for p in result
        if not (p.strip() in marker_texts and not p.strip().startswith("[TABLE]"))
    ]

    return result


def _insert_image_paragraphs(
    paragraphs: list[str], images: list[dict]
) -> list[str]:
    """Insert [IMAGE] paragraphs near their figure captions.

    Matches images by page number to figure caption patterns (FIG. N, Figure N).
    Unmatched images are appended at the end.
    """
    if not images:
        return paragraphs

    result = list(paragraphs)

    # Build figure caption index: find paragraphs that ARE captions (not just
    # prose that references figures). Prefer short paragraphs starting with "FIG."
    fig_caption_pattern = re.compile(r'^FIG\.?\s*(\d+)', re.IGNORECASE)
    fig_ref_pattern = re.compile(r'\bFigure\s+(\d+)', re.IGNORECASE)
    caption_indices = {}  # fig_num -> paragraph index
    for i, p in enumerate(result):
        stripped = p.strip()
        # Strong match: paragraph starts with "FIG. N" (actual caption)
        match = fig_caption_pattern.match(stripped)
        if match:
            fig_num = int(match.group(1))
            caption_indices[fig_num] = i  # Overwrite any weaker match
            continue
        # Weak match: short paragraph (<150 chars) mentioning "Figure N"
        if len(stripped) < 150:
            match = fig_ref_pattern.search(stripped)
            if match:
                fig_num = int(match.group(1))
                if fig_num not in caption_indices:
                    caption_indices[fig_num] = i

    # Sort images by page number for stable assignment
    sorted_images = sorted(images, key=lambda x: (x["page"], x["url"]))

    # Assign figure numbers to images by page order
    inserted = 0
    used_images = set()
    for fig_num in sorted(caption_indices.keys()):
        cap_idx = caption_indices[fig_num] + inserted
        # Find the first unused image
        best = None
        for img in sorted_images:
            if id(img) in used_images:
                continue
            best = img
            break
        if best:
            used_images.add(id(best))
            meta = json.dumps({"url": best["url"], "alt": f"Figure {fig_num}"})
            result.insert(cap_idx, f"[IMAGE]{meta}")
            inserted += 1

    # Append any remaining images at the end (appendix screenshots, etc.)
    for img in sorted_images:
        if id(img) not in used_images:
            meta = json.dumps({"url": img["url"], "alt": "Figure"})
            result.append(f"[IMAGE]{meta}")

    return result


# ── HTML Routes ──────────────────────────────────────────────────────


@router.get("/ereader", response_class=HTMLResponse)
async def ereader_library(request: Request):
    """Library view - lists all materials with tags, pins, and filtering."""
    textbooks = []
    research_documents = []
    conn = get_kb_connection()
    if conn:
        try:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT t.id, t.title, t.short_title, t.course_slug, t.total_pages,
                       COUNT(c.id) as chapter_count,
                       SUM(CASE WHEN c.content IS NOT NULL AND c.content != ''
                           THEN 1 ELSE 0 END) as chapters_with_content
                FROM kb_textbooks t
                LEFT JOIN kb_chapters c ON t.id = c.textbook_id
                GROUP BY t.id
                ORDER BY t.title
            """)
            textbooks = [dict(row) for row in cursor.fetchall()]
            research_documents = _get_research_documents(cursor)
        finally:
            conn.close()

    research_sources = _get_research_sources_with_fulltext()

    # Build unified materials list
    all_materials = []
    for tb in textbooks:
        all_materials.append({
            "type": "textbook",
            "key": tb["short_title"],
            "title": tb["title"],
            "href": f"/ereader/textbook/{tb['short_title']}",
            "meta": f"{tb.get('chapter_count', 0)} chapters",
            "tags": [],
            "pinned": False,
        })
    for doc in research_documents:
        all_materials.append({
            "type": "document",
            "key": doc["short_title"],
            "title": doc["title"],
            "href": f"/ereader/document/{doc['short_title']}",
            "meta": " | ".join(filter(None, [
                doc.get("authors_short", ""),
                str(doc["publication_year"]) if doc.get("publication_year") else "",
                f"{doc.get('section_count', 0)} sections",
            ])),
            "tags": [],
            "pinned": False,
        })
    for src in research_sources:
        all_materials.append({
            "type": "source",
            "key": src["source_id"],
            "title": src["title"],
            "href": f"/ereader/source/{src['source_id']}",
            "meta": " | ".join(filter(None, [
                src.get("authors_short", ""),
                str(src["publication_year"]) if src.get("publication_year") else "",
            ])),
            "tags": [],
            "pinned": False,
        })

    # Fetch tags and pins from canvas.db (async)
    all_tags = []
    async with get_session() as session:
        # Get all ereader material tags with their tag names
        tag_result = await session.execute(
            select(
                EReaderMaterialTag.material_type,
                EReaderMaterialTag.material_key,
                NoteTag.name,
            ).join(NoteTag, EReaderMaterialTag.tag_id == NoteTag.id)
        )
        tag_rows = tag_result.all()

        # Build lookup: (type, key) -> [tag_names]
        tag_lookup = {}
        tag_counts = {}
        for mtype, mkey, tname in tag_rows:
            tag_lookup.setdefault((mtype, mkey), []).append(tname)
            tag_counts[tname] = tag_counts.get(tname, 0) + 1

        # Get all pins
        pin_result = await session.execute(select(EReaderPin))
        pins = pin_result.scalars().all()
        pin_set = {(p.material_type, p.material_key) for p in pins}

        # Build tag list for filter bar
        all_tags = [{"name": name, "count": count}
                    for name, count in sorted(tag_counts.items())]

    # Merge tags and pins into materials
    for mat in all_materials:
        mat["tags"] = tag_lookup.get((mat["type"], mat["key"]), [])
        mat["pinned"] = (mat["type"], mat["key"]) in pin_set

    return templates.TemplateResponse(
        request,
        "ereader.html",
        {
            "mode": "library",
            "all_materials": all_materials,
            "all_tags": all_tags,
            "voices": ereader_tts.get_popular_voices(),
        },
    )


@router.get("/ereader/textbook/{short_title}", response_class=HTMLResponse)
async def ereader_textbook_toc(request: Request, short_title: str):
    """Textbook table of contents with chapter list."""
    conn = get_kb_connection()
    if not conn:
        return HTMLResponse("<p>Knowledge base not available</p>", status_code=404)

    try:
        cursor = conn.cursor()
        textbook = _get_textbook_by_short_title(cursor, short_title)
        if not textbook:
            return HTMLResponse("<p>Textbook not found</p>", status_code=404)

        chapters = _get_chapters_for_textbook(cursor, textbook["id"])

        return templates.TemplateResponse(
            request,
            "ereader.html",
            {
                "mode": "toc",
                "textbook": textbook,
                "chapters": chapters,
                "voices": ereader_tts.get_popular_voices(),
            },
        )
    finally:
        conn.close()


@router.get(
    "/ereader/textbook/{short_title}/{chapter_num}",
    response_class=HTMLResponse,
)
async def ereader_chapter(request: Request, short_title: str, chapter_num: int):
    """Reader view for a textbook chapter."""
    conn = get_kb_connection()
    if not conn:
        return HTMLResponse("<p>Knowledge base not available</p>", status_code=404)

    try:
        cursor = conn.cursor()
        textbook = _get_textbook_by_short_title(cursor, short_title)
        if not textbook:
            return HTMLResponse("<p>Textbook not found</p>", status_code=404)

        # Get requested chapter
        cursor.execute(
            """SELECT id, chapter_number, title, content
               FROM kb_chapters
               WHERE textbook_id = ? AND chapter_number = ?""",
            (textbook["id"], chapter_num),
        )
        chapter_row = cursor.fetchone()
        if not chapter_row:
            return HTMLResponse("<p>Chapter not found</p>", status_code=404)
        chapter = dict(chapter_row)

        if not chapter.get("content"):
            return HTMLResponse(
                "<p>Chapter content not indexed yet</p>", status_code=404
            )

        # Get all chapters for sidebar
        all_chapters = _get_chapters_for_textbook(cursor, textbook["id"])

        # Split content into paragraphs (flatten long ones)
        raw_paras = split_into_paragraphs(chapter["content"])
        paragraphs = []
        for p in raw_paras:
            paragraphs.extend(split_long_paragraph(p))

        # Cache key for this chapter
        cache_key = ereader_tts._cache_key(
            chapter["content"], ereader_tts.default_voice, "+0%"
        )

        # Get material tags
        async with get_session() as session:
            material_tags = await _get_tags_for_material(
                session, "textbook", textbook["short_title"]
            )

        return templates.TemplateResponse(
            request,
            "ereader.html",
            {
                "mode": "reader",
                "content_type": "textbook",
                "textbook": textbook,
                "chapter": chapter,
                "chapters": all_chapters,
                "paragraphs": paragraphs,
                "cache_key": cache_key,
                "voices": ereader_tts.get_popular_voices(),
                "material_tags": material_tags,
                "material_type": "textbook",
                "material_key": textbook["short_title"],
            },
        )
    finally:
        conn.close()


@router.get("/ereader/document/{short_title}", response_class=HTMLResponse)
async def ereader_document_toc(request: Request, short_title: str):
    """Research document table of contents with section list."""
    conn = get_kb_connection()
    if not conn:
        return HTMLResponse("<p>Knowledge base not available</p>", status_code=404)

    try:
        cursor = conn.cursor()
        document = _get_document_by_short_title(cursor, short_title)
        if not document:
            return HTMLResponse("<p>Document not found</p>", status_code=404)

        sections = _get_sections_for_document(cursor, document["id"])

        return templates.TemplateResponse(
            request,
            "ereader.html",
            {
                "mode": "document_toc",
                "document": document,
                "sections": sections,
                "voices": ereader_tts.get_popular_voices(),
            },
        )
    finally:
        conn.close()


@router.get(
    "/ereader/document/{short_title}/{section_num}",
    response_class=HTMLResponse,
)
async def ereader_document_section(
    request: Request, short_title: str, section_num: int
):
    """Reader view for a research document section."""
    conn = get_kb_connection()
    if not conn:
        return HTMLResponse("<p>Knowledge base not available</p>", status_code=404)

    try:
        cursor = conn.cursor()
        document = _get_document_by_short_title(cursor, short_title)
        if not document:
            return HTMLResponse("<p>Document not found</p>", status_code=404)

        cursor.execute(
            """SELECT id, section_number, title, content
               FROM kb_document_sections
               WHERE document_id = ? AND section_number = ?""",
            (document["id"], section_num),
        )
        section_row = cursor.fetchone()
        if not section_row:
            return HTMLResponse("<p>Section not found</p>", status_code=404)
        section = dict(section_row)

        if not section.get("content"):
            return HTMLResponse(
                "<p>Section content not extracted yet</p>", status_code=404
            )

        all_sections = _get_sections_for_document(cursor, document["id"])

        content = section["content"]
        content = strip_running_headers(content)
        content = strip_publisher_watermarks(content)
        content = strip_chart_axis_data(content)
        content = split_figure_captions(content)
        content = presplit_long_lines(content)
        content, table_blocks = extract_table_blocks(content)
        content = reflow_pdf_text(content)
        raw_paras = split_into_paragraphs(content)
        paragraphs = []
        for p in raw_paras:
            paragraphs.extend(split_long_paragraph(p))
        if table_blocks:
            paragraphs = restore_table_blocks(paragraphs, table_blocks)

        cache_key = ereader_tts._cache_key(
            section["content"], ereader_tts.default_voice, "+0%"
        )

        # Get material tags
        async with get_session() as session:
            material_tags = await _get_tags_for_material(
                session, "document", document["short_title"]
            )

        return templates.TemplateResponse(
            request,
            "ereader.html",
            {
                "mode": "reader",
                "content_type": "document",
                "document": document,
                "section": section,
                "sections": all_sections,
                "paragraphs": paragraphs,
                "cache_key": cache_key,
                "voices": ereader_tts.get_popular_voices(),
                "material_tags": material_tags,
                "material_type": "document",
                "material_key": document["short_title"],
            },
        )
    finally:
        conn.close()


@router.get("/ereader/source/{source_id}", response_class=HTMLResponse)
async def ereader_source(request: Request, source_id: str):
    """Reader view for a research source's full text."""
    # Get source metadata
    conn = get_research_connection()
    if not conn:
        return HTMLResponse("<p>Research database not available</p>", status_code=404)

    try:
        cursor = conn.cursor()
        cursor.execute(
            """SELECT source_id, title, authors, publication_year, status
               FROM research_sources WHERE source_id = ?""",
            (source_id,),
        )
        row = cursor.fetchone()
        if not row:
            return HTMLResponse("<p>Source not found</p>", status_code=404)
        source = dict(row)
    finally:
        conn.close()

    # Load full text
    text = _load_source_fulltext(source_id)
    if not text:
        return HTMLResponse("<p>Full text not available for this source</p>", status_code=404)

    # Clean up PDF extraction artifacts
    text = strip_running_headers(text)
    text = strip_publisher_watermarks(text)
    text = strip_chart_axis_data(text)
    text = split_figure_captions(text)
    text = presplit_long_lines(text)

    # Extract table blocks before reflow destroys them
    text, table_blocks = extract_table_blocks(text)

    # Clean up PDF-extracted text and split into paragraphs
    text = reflow_pdf_text(text)
    raw_paras = split_into_paragraphs(text)
    paragraphs = []
    for p in raw_paras:
        paragraphs.extend(split_long_paragraph(p))
    if table_blocks:
        paragraphs = restore_table_blocks(paragraphs, table_blocks)

    # PDF enrichment: curated tables (independent of PDF) + extracted images (requires PDF)
    try:
        from src.services.ereader_pdf import extract_images, load_curated_tables

        # Curated tables — independent of PDF
        curated_tables = await asyncio.to_thread(load_curated_tables, source_id)
        if curated_tables:
            paragraphs = _replace_tables_with_curated(paragraphs, curated_tables)

        # Image extraction — requires PDF
        pdf_path = Path.home() / ".research-mcp" / "cache" / f"{source_id}.pdf"
        if pdf_path.exists():
            static_dir = str(Path(__file__).parent.parent / "static")
            images = await asyncio.to_thread(
                extract_images, str(pdf_path), source_id, static_dir
            )
            if images:
                paragraphs = _insert_image_paragraphs(paragraphs, images)
    except Exception:
        pass  # Graceful fallback to text-only

    # Compute cache key from final paragraph content (after enrichment)
    cache_key = ereader_tts._cache_key(
        "\n\n".join(paragraphs), ereader_tts.default_voice, "+0%"
    )

    # Get material tags
    async with get_session() as session:
        material_tags = await _get_tags_for_material(
            session, "source", source["source_id"]
        )

    return templates.TemplateResponse(
        request,
        "ereader.html",
        {
            "mode": "reader",
            "content_type": "source",
            "source": source,
            "paragraphs": paragraphs,
            "cache_key": cache_key,
            "voices": ereader_tts.get_popular_voices(),
            "material_tags": material_tags,
            "material_type": "source",
            "material_key": source["source_id"],
        },
    )


# ── API Routes ───────────────────────────────────────────────────────


@router.post("/api/ereader/tts")
async def generate_tts(request: Request):
    """
    Generate TTS for a range of paragraphs.

    Request body:
        paragraphs: list[str] - paragraph texts
        cache_key: str
        start: int - start paragraph index
        end: int - end paragraph index (exclusive)
        voice: str (optional)
        rate: str (optional, e.g. "+0%", "+50%")
    """
    body = await request.json()
    paragraphs = body.get("paragraphs", [])
    cache_key = body.get("cache_key", "")
    start = body.get("start", 0)
    end = body.get("end", min(start + 4, len(paragraphs)))
    voice = body.get("voice")
    rate = body.get("rate", "+0%")

    if not paragraphs or not cache_key:
        return JSONResponse({"error": "Missing paragraphs or cache_key"}, status_code=400)

    # Convert table paragraphs to speech text; skip image paragraphs
    tts_paragraphs = list(paragraphs)
    for i in range(start, min(end, len(tts_paragraphs))):
        if tts_paragraphs[i].startswith("[IMAGE]"):
            tts_paragraphs[i] = ""  # Empty string produces no audio
        elif tts_paragraphs[i].startswith("[TABLE]\n"):
            tts_paragraphs[i] = table_to_speech_text(
                tts_paragraphs[i][len("[TABLE]\n"):]
            )

    results = await ereader_tts.generate_range(
        tts_paragraphs, cache_key, start, end, voice=voice, rate=rate
    )

    return JSONResponse({"results": results})


@router.get("/api/ereader/tts/status/{cache_key}")
async def tts_status(cache_key: str, total: int = 0):
    """Check which paragraphs are already cached."""
    if total <= 0:
        return JSONResponse({"cached": []})

    cached = ereader_tts.get_cached_status(cache_key, total)
    return JSONResponse({"cached": cached})


# ── Reading Progress API ─────────────────────────────────────────────


class ProgressUpdate(BaseModel):
    """Schema for reading progress updates."""

    content_type: str  # textbook, document, source
    content_key: str  # short_title or source_id
    chapter_or_section: Optional[int] = None
    paragraph: int
    total_paragraphs: Optional[int] = None


@router.post("/api/ereader/progress")
async def update_progress(data: ProgressUpdate):
    """
    Upsert reading progress. Only increases paragraph position (never decreases).
    This ensures re-reading earlier content doesn't reset progress.
    """
    async with get_session() as session:
        # Find existing progress record
        stmt = select(ReadingProgress).where(
            ReadingProgress.content_type == data.content_type,
            ReadingProgress.content_key == data.content_key,
            ReadingProgress.chapter_or_section == data.chapter_or_section,
        )
        result = await session.execute(stmt)
        existing = result.scalar_one_or_none()

        if existing:
            # Only update if paragraph is higher (forward progress)
            if data.paragraph > existing.paragraph:
                existing.paragraph = data.paragraph
                if data.total_paragraphs:
                    existing.total_paragraphs = data.total_paragraphs
        else:
            # Create new progress record
            progress = ReadingProgress(
                content_type=data.content_type,
                content_key=data.content_key,
                chapter_or_section=data.chapter_or_section,
                paragraph=data.paragraph,
                total_paragraphs=data.total_paragraphs,
            )
            session.add(progress)

    return JSONResponse({"status": "ok"})


@router.get("/api/ereader/progress")
async def list_progress():
    """List all reading progress records."""
    async with get_session() as session:
        stmt = select(ReadingProgress).order_by(
            ReadingProgress.content_type, ReadingProgress.content_key
        )
        result = await session.execute(stmt)
        records = result.scalars().all()

        return JSONResponse({
            "progress": [
                {
                    "id": r.id,
                    "content_type": r.content_type,
                    "content_key": r.content_key,
                    "chapter_or_section": r.chapter_or_section,
                    "paragraph": r.paragraph,
                    "total_paragraphs": r.total_paragraphs,
                    "last_read_at": r.last_read_at.isoformat() if r.last_read_at else None,
                }
                for r in records
            ]
        })


# ── Tag & Pin Helpers ────────────────────────────────────────────────


async def _get_or_create_tag_async(session, name: str) -> NoteTag:
    """Get an existing tag or create a new one (async version)."""
    normalized = name.strip().lower()
    result = await session.execute(select(NoteTag).where(NoteTag.name == normalized))
    tag = result.scalar_one_or_none()
    if not tag:
        tag = NoteTag(name=normalized)
        session.add(tag)
        await session.flush()
    return tag


async def _get_tags_for_material(session, material_type: str, material_key: str) -> list[str]:
    """Get tag names for a specific material."""
    result = await session.execute(
        select(NoteTag.name)
        .join(EReaderMaterialTag, EReaderMaterialTag.tag_id == NoteTag.id)
        .where(
            EReaderMaterialTag.material_type == material_type,
            EReaderMaterialTag.material_key == material_key,
        )
    )
    return [row[0] for row in result.all()]


# ── Tag & Pin API ────────────────────────────────────────────────────


class TagRequest(BaseModel):
    name: str


@router.get("/api/ereader/tags")
async def list_ereader_tags():
    """List all tags that have e-reader material associations, with counts."""
    async with get_session() as session:
        result = await session.execute(
            select(NoteTag.name, NoteTag.id)
            .join(EReaderMaterialTag, EReaderMaterialTag.tag_id == NoteTag.id)
            .group_by(NoteTag.id)
        )
        tag_rows = result.all()

        tags = []
        for name, tag_id in tag_rows:
            count_result = await session.execute(
                select(EReaderMaterialTag.id).where(EReaderMaterialTag.tag_id == tag_id)
            )
            count = len(count_result.all())
            tags.append({"name": name, "count": count})

        return JSONResponse({"tags": tags})


@router.get("/api/ereader/{material_type}/{material_key}/tags")
async def get_material_tags(material_type: str, material_key: str):
    """Get tags for a specific material."""
    async with get_session() as session:
        tag_names = await _get_tags_for_material(session, material_type, material_key)
        return JSONResponse({"tags": tag_names})


@router.post("/api/ereader/{material_type}/{material_key}/tags")
async def add_material_tag(material_type: str, material_key: str, req: TagRequest):
    """Add a tag to a material."""
    if material_type not in ("textbook", "document", "source"):
        return JSONResponse({"error": "Invalid material_type"}, status_code=400)

    async with get_session() as session:
        tag = await _get_or_create_tag_async(session, req.name)

        # Check if association already exists
        existing = await session.execute(
            select(EReaderMaterialTag).where(
                EReaderMaterialTag.material_type == material_type,
                EReaderMaterialTag.material_key == material_key,
                EReaderMaterialTag.tag_id == tag.id,
            )
        )
        if not existing.scalar_one_or_none():
            assoc = EReaderMaterialTag(
                material_type=material_type,
                material_key=material_key,
                tag_id=tag.id,
            )
            session.add(assoc)

        await session.flush()
        tag_names = await _get_tags_for_material(session, material_type, material_key)
        return JSONResponse({"tags": tag_names})


@router.delete("/api/ereader/{material_type}/{material_key}/tags/{tag_name}")
async def remove_material_tag(material_type: str, material_key: str, tag_name: str):
    """Remove a tag from a material."""
    normalized = tag_name.strip().lower()
    async with get_session() as session:
        # Find the tag
        result = await session.execute(select(NoteTag).where(NoteTag.name == normalized))
        tag = result.scalar_one_or_none()
        if not tag:
            return JSONResponse({"tags": []})

        # Delete the association
        await session.execute(
            delete(EReaderMaterialTag).where(
                EReaderMaterialTag.material_type == material_type,
                EReaderMaterialTag.material_key == material_key,
                EReaderMaterialTag.tag_id == tag.id,
            )
        )

        tag_names = await _get_tags_for_material(session, material_type, material_key)
        return JSONResponse({"tags": tag_names})


@router.post("/api/ereader/{material_type}/{material_key}/pin")
async def pin_material(material_type: str, material_key: str):
    """Pin a material for quick access."""
    if material_type not in ("textbook", "document", "source"):
        return JSONResponse({"error": "Invalid material_type"}, status_code=400)

    async with get_session() as session:
        existing = await session.execute(
            select(EReaderPin).where(
                EReaderPin.material_type == material_type,
                EReaderPin.material_key == material_key,
            )
        )
        if not existing.scalar_one_or_none():
            pin = EReaderPin(material_type=material_type, material_key=material_key)
            session.add(pin)

    return JSONResponse({"status": "pinned"})


@router.delete("/api/ereader/{material_type}/{material_key}/pin")
async def unpin_material(material_type: str, material_key: str):
    """Unpin a material."""
    async with get_session() as session:
        await session.execute(
            delete(EReaderPin).where(
                EReaderPin.material_type == material_type,
                EReaderPin.material_key == material_key,
            )
        )

    return JSONResponse({"status": "unpinned"})

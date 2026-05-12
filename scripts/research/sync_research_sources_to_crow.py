#!/usr/bin/env python3
"""
sync_research_sources_to_crow.py
================================

Phase 4: merge ~/.research-mcp/research.db research_sources into Crow's
research_sources table, mapping against the real source schema verified
2026-04-21 (18 columns — no citation_apa, no tags, no isbn, no url, no
retrieval_date).

Contract:
  - Source DB opened mode=ro.
  - Per-row INSERT (never bulk dump) so FTS5 triggers fire.
  - citation_apa ALWAYS synthesized (source has no column). Null year → 'n.d.'.
  - source_type derived from csl_json.type via CSL_TO_SOURCE_TYPE map.
  - publisher + isbn extracted from csl_json.
  - Dedupe via capstone_sync_map keyed on (source_db='research.db', source_id=UUID).
  - Chunked transactions (~90 rows each) bound blast radius.

CLI:
    --dry-run         log every write without committing
    --limit N         only process first N source rows
    --recompute-apa   force citation_apa re-synthesis even if hash matches
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from pathlib import Path
from datetime import datetime, timezone

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))
import crow_sync_config as CFG

UNIT_SEP = "\x1f"
CHUNK_SIZE = 90


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _format_authors_from_csl(csl: dict) -> str:
    """Build human-readable authors string from CSL 'author' array."""
    if not isinstance(csl, dict):
        return ""
    authors = csl.get("author") or []
    names = []
    for a in authors:
        if not isinstance(a, dict):
            continue
        if "literal" in a:
            names.append(str(a["literal"]))
            continue
        family = a.get("family", "").strip()
        given = a.get("given", "").strip()
        if family and given:
            names.append(f"{family}, {given[0]}.")
        elif family:
            names.append(family)
        elif given:
            names.append(given)
    return ", ".join(names)


def _synthesize_citation_apa(row: sqlite3.Row, csl: dict) -> str:
    """APA fallback — compliant with 'n.d.' for null year."""
    authors_raw = row["authors"] or ""
    # Check for JSON-encoded authors (defense: canvas-companion style)
    if authors_raw.startswith("["):
        try:
            parsed = json.loads(authors_raw)
            if isinstance(parsed, list) and parsed:
                if all(isinstance(x, str) for x in parsed):
                    authors = ", ".join(parsed)
                elif all(isinstance(x, dict) for x in parsed):
                    authors = _format_authors_from_csl({"author": parsed})
                else:
                    authors = str(parsed)
            else:
                authors = authors_raw
        except ValueError:
            authors = authors_raw
    elif isinstance(csl, dict) and csl.get("author"):
        # Prefer csl structured authors if source authors looks ambiguous
        structured = _format_authors_from_csl(csl)
        authors = structured or authors_raw
    else:
        authors = authors_raw

    if not authors.strip():
        authors = "[No author]"

    year = row["publication_year"]
    year_str = str(year) if year else "n.d."

    title = row["title"] or "[No title]"

    container = ""
    if isinstance(csl, dict):
        container = csl.get("container-title") or csl.get("publisher") or ""

    parts = [f"{authors} ({year_str}). {title}"]
    if container:
        parts.append(f". {container}")
    parts.append(".")
    return "".join(parts)


def _content_hash(row: sqlite3.Row, cited_apa: str, source_type: str) -> str:
    parts = [
        row["title"] or "",
        source_type,
        row["source_url"] or "",
        row["authors"] or "",
        str(row["publication_year"] if row["publication_year"] is not None else ""),
        row["doi"] or "",
        row["abstract"] or "",
        row["ai_summary"] or "",
        cited_apa,
    ]
    return hashlib.sha256(UNIT_SEP.join(parts).encode("utf-8")).hexdigest()


def _map_get(cur, source_id: str) -> tuple[int | None, str | None]:
    cur.execute(
        "SELECT crow_id, content_hash FROM capstone_sync_map WHERE source_db = 'research.db' AND source_id = ?",
        (source_id,),
    )
    row = cur.fetchone()
    return (row["crow_id"], row["content_hash"]) if row else (None, None)


def _map_upsert(cur, source_id: str, crow_id: int, content_hash: str) -> None:
    cur.execute(
        """
        INSERT INTO capstone_sync_map (source_db, source_id, crow_id, synced_at, content_hash)
        VALUES ('research.db', ?, ?, ?, ?)
        ON CONFLICT(source_db, source_id) DO UPDATE SET
            crow_id = excluded.crow_id,
            synced_at = excluded.synced_at,
            content_hash = excluded.content_hash
        """,
        (source_id, crow_id, _now_iso(), content_hash),
    )


def transform(row: sqlite3.Row) -> dict:
    """Source row → crow.db column dict."""
    try:
        csl = json.loads(row["csl_json"]) if row["csl_json"] else {}
    except (ValueError, TypeError):
        csl = {}

    csl_type = (csl.get("type") or "").lower() if isinstance(csl, dict) else ""
    source_type = CFG.CSL_TO_SOURCE_TYPE.get(csl_type, "other")

    publisher = csl.get("publisher") if isinstance(csl, dict) else None
    isbn = csl.get("ISBN") if isinstance(csl, dict) else None

    citation_apa = _synthesize_citation_apa(row, csl)

    rel = row["relevance_score"]
    rel_int = 5 if rel is None else max(1, min(10, round(rel)))

    status = (row["status"] or "").lower()
    verified = 1 if status in CFG.STATUS_TO_VERIFIED else 0

    pub_date = str(row["publication_year"]) if row["publication_year"] else None

    tags_parts = []
    if row["notes"]:
        tags_parts.append(row["notes"].strip())
    tags_parts.append(f"[uuid:{row['source_id']}]")
    tags = " ".join(tags_parts)

    return {
        "project_id": CFG.CAPSTONE_PROJECT_ID,
        "title": row["title"],
        "source_type": source_type,
        "url": row["source_url"],
        "authors": row["authors"],
        "publication_date": pub_date,
        "publisher": publisher,
        "doi": row["doi"],
        "isbn": isbn,
        "abstract": row["abstract"],
        "content_summary": row["ai_summary"],
        "full_text": None,
        "citation_apa": citation_apa,
        "retrieval_date": None,  # keep target default date('now')
        "retrieval_method": None,
        "verified": verified,
        "verification_notes": None,
        "tags": tags,
        "relevance_score": rel_int,
        "backend_id": None,
    }


def sync(*, dry_run: bool, limit: int | None) -> dict:
    src = sqlite3.connect(f"file:{CFG.RESEARCH_DB}?mode=ro", uri=True)
    src.row_factory = sqlite3.Row
    tgt = sqlite3.connect(CFG.CROW_DB_PATH, isolation_level=None)
    tgt.row_factory = sqlite3.Row
    cur = tgt.cursor()

    stats = {"inserted": 0, "updated": 0, "skipped_nochange": 0, "errors": 0}

    q = "SELECT * FROM research_sources ORDER BY created_at"
    rows = src.execute(q).fetchall()
    if limit is not None:
        rows = rows[:limit]

    for i, chunk_start in enumerate(range(0, len(rows), CHUNK_SIZE)):
        chunk = rows[chunk_start : chunk_start + CHUNK_SIZE]
        if dry_run:
            print(f"[dry-run] chunk {i+1} of {(len(rows)+CHUNK_SIZE-1)//CHUNK_SIZE}: {len(chunk)} rows")
            for r in chunk[:2]:
                t = transform(r)
                print(f"  src={r['source_id']} → source_type={t['source_type']} apa={t['citation_apa'][:60]!r}...")
            continue

        cur.execute("BEGIN IMMEDIATE")
        try:
            for r in chunk:
                source_id = r["source_id"]
                try:
                    payload = transform(r)
                except Exception as e:
                    print(f"TRANSFORM ERROR source_id={source_id}: {e}", file=sys.stderr)
                    stats["errors"] += 1
                    continue

                h = _content_hash(r, payload["citation_apa"], payload["source_type"])
                crow_id, stored_hash = _map_get(cur, source_id)

                if crow_id is None:
                    cur.execute(
                        """
                        INSERT INTO research_sources
                          (project_id, title, source_type, url, authors, publication_date, publisher,
                           doi, isbn, abstract, content_summary, full_text, citation_apa,
                           retrieval_method, verified, verification_notes, tags, relevance_score, backend_id)
                        VALUES
                          (:project_id, :title, :source_type, :url, :authors, :publication_date, :publisher,
                           :doi, :isbn, :abstract, :content_summary, :full_text, :citation_apa,
                           :retrieval_method, :verified, :verification_notes, :tags, :relevance_score, :backend_id)
                        """,
                        payload,
                    )
                    new_id = cur.lastrowid
                    if new_id is None:
                        raise RuntimeError(f"INSERT returned no lastrowid for {source_id}")
                    crow_id = new_id
                    stats["inserted"] += 1
                elif stored_hash != h:
                    cur.execute(
                        """
                        UPDATE research_sources
                           SET title = :title,
                               source_type = :source_type,
                               url = :url,
                               authors = :authors,
                               publication_date = :publication_date,
                               publisher = :publisher,
                               doi = :doi,
                               isbn = :isbn,
                               abstract = :abstract,
                               content_summary = :content_summary,
                               citation_apa = :citation_apa,
                               verified = :verified,
                               tags = :tags,
                               relevance_score = :relevance_score
                         WHERE id = :crow_id
                        """,
                        {**payload, "crow_id": crow_id},
                    )
                    stats["updated"] += 1
                else:
                    stats["skipped_nochange"] += 1

                _map_upsert(cur, source_id, crow_id, h)

            cur.execute("COMMIT")
        except Exception:
            cur.execute("ROLLBACK")
            raise

    tgt.close()
    src.close()
    return stats


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--limit", type=int, default=None)
    args = p.parse_args()
    print(f"=== research_sources sync (dry_run={args.dry_run} limit={args.limit}) ===")
    stats = sync(dry_run=args.dry_run, limit=args.limit)
    for k, v in sorted(stats.items()):
        print(f"  {k:>20}: {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

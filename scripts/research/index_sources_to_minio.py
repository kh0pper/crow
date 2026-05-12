#!/usr/bin/env python3
"""Index ~/spring-2026/insd-5941/sources/ files into research_sources rows.

For each file in the sources tree, attempt to match a single
research_sources row (project_id=6) via three deterministic heuristics:

  1. URL-tail match  — row.url ends with the file's basename (URL-decoded)
  2. Author+year     — file matches "<Author>_<Year>" pattern AND row's
                       authors contain the author AND citation_apa contains the year
  3. Title-slug      — slugified file basename equals slugified row title

When a unique match is found, set research_sources.file_path (relative to
~/spring-2026) and research_sources.s3_key (key within capstone-research bucket).

Files with no matching row, or matched-by-multiple-rows ambiguities, are logged
and left unlinked. Files with embedded \\r or \\n in their names are skipped.

Idempotent: rows already linked are skipped unless --force is passed.
"""
from __future__ import annotations
import argparse
import os
import re
import sqlite3
import sys
import urllib.parse
from collections import defaultdict
from pathlib import Path

SPRING_ROOT = Path(os.environ.get("SPRING_ROOT", os.path.expanduser("~/spring-2026")))
SOURCES_REL = "insd-5941/sources"
BUCKET_PREFIX = "sources"  # within capstone-research/
CROW_DB = Path(os.environ.get("CROW_DB", os.path.expanduser("~/.crow/data/crow.db")))
PROJECT_ID = 6


def slugify(s: str) -> str:
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def walk_files(root: Path):
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        name = p.name
        if "\n" in name or "\r" in name:
            continue
        yield p


AUTHOR_YEAR_RE = re.compile(r"^([A-Z][a-zA-Z'-]+)_(\d{4})\b")


def match_file(stem: str, basename: str, rows: list[dict]) -> list[int]:
    """Return list of row ids matching this file (ideally length 1)."""
    matches: set[int] = set()
    bn_lower = basename.lower()
    bn_decoded = urllib.parse.unquote(basename).lower()
    # Heuristic 1: URL tail
    for r in rows:
        u = (r["url"] or "").lower()
        if not u:
            continue
        u_tail = urllib.parse.unquote(u.rsplit("/", 1)[-1])
        if u_tail and (u_tail == bn_lower or u_tail == bn_decoded):
            matches.add(r["id"])
    if matches:
        return sorted(matches)
    # Heuristic 2: Author_Year (author can appear in authors OR citation_apa)
    m = AUTHOR_YEAR_RE.match(stem)
    if m:
        author, year = m.group(1).lower(), m.group(2)
        for r in rows:
            authors = (r["authors"] or "").lower()
            cite = (r["citation_apa"] or "").lower()
            if (author in authors or author in cite) and year in cite:
                matches.add(r["id"])
        if matches:
            return sorted(matches)
    # Heuristic 3: title-slug
    stem_slug = slugify(stem)
    if len(stem_slug) >= 8:  # avoid pathological short matches
        for r in rows:
            title = r["title"] or ""
            if slugify(title) == stem_slug:
                matches.add(r["id"])
    return sorted(matches)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="overwrite rows that already have file_path/s3_key")
    ap.add_argument("--dry-run", action="store_true", help="print intended updates without writing")
    ap.add_argument("--db", default=str(CROW_DB))
    args = ap.parse_args()

    src_root = SPRING_ROOT / SOURCES_REL
    if not src_root.is_dir():
        print(f"ERROR: source root not found: {src_root}", file=sys.stderr)
        sys.exit(2)

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute(
        "SELECT id, title, url, authors, citation_apa, file_path, s3_key "
        "FROM research_sources WHERE project_id = ?", (PROJECT_ID,)
    )]
    print(f"loaded {len(rows)} research_sources rows for project {PROJECT_ID}")

    files = list(walk_files(src_root))
    print(f"scanned {len(files)} files under {src_root}")

    # Track which row IDs each file matched, and reverse map
    file_to_rows: dict[Path, list[int]] = {}
    row_to_files: dict[int, list[Path]] = defaultdict(list)
    for fp in files:
        stem = fp.stem
        basename = fp.name
        ids = match_file(stem, basename, rows)
        if ids:
            file_to_rows[fp] = ids
            for rid in ids:
                row_to_files[rid].append(fp)

    # Resolve: only update where the file→row mapping is unambiguous in BOTH directions
    updates: list[tuple[int, str, str]] = []
    ambiguous_files: list[tuple[Path, list[int]]] = []
    ambiguous_rows: list[tuple[int, list[Path]]] = []
    unmatched_files: list[Path] = []

    matched_files = set(file_to_rows.keys())
    for fp in files:
        if fp not in matched_files:
            unmatched_files.append(fp)
            continue
        ids = file_to_rows[fp]
        if len(ids) > 1:
            ambiguous_files.append((fp, ids))
            continue
        rid = ids[0]
        candidates = row_to_files[rid]
        if len(candidates) > 1:
            # Tiebreak: prefer files not under 'highlighted/' (annotated copies).
            # If exactly one candidate is non-highlighted, accept it.
            primary = [c for c in candidates if "/highlighted/" not in c.as_posix()
                       and not c.parent.name == "highlighted"]
            if len(primary) == 1:
                if fp != primary[0]:
                    continue  # leave the highlighted variant unlinked
            else:
                ambiguous_rows.append((rid, candidates))
                continue
        row = next(r for r in rows if r["id"] == rid)
        if (row["file_path"] or row["s3_key"]) and not args.force:
            continue
        rel = fp.relative_to(SPRING_ROOT).as_posix()
        s3_key = f"{BUCKET_PREFIX}/{fp.relative_to(src_root).as_posix()}"
        updates.append((rid, rel, s3_key))

    print(f"\nmatching results:")
    print(f"  files with a unique matching row: {len(updates)}")
    print(f"  files with multiple candidate rows (ambiguous): {len(ambiguous_files)}")
    print(f"  rows with multiple candidate files (ambiguous): {len(set(r for r, _ in ambiguous_rows))}")
    print(f"  files with no matching row: {len(unmatched_files)}")

    if args.dry_run:
        print("\n-- dry run: top 10 intended updates --")
        for rid, rel, s3 in updates[:10]:
            print(f"  id={rid} file_path={rel} s3_key={s3}")
        if ambiguous_files:
            print("\n-- ambiguous (file matched multiple rows), top 5 --")
            for fp, ids in ambiguous_files[:5]:
                print(f"  {fp.name} -> rows {ids}")
        return

    if not updates:
        print("nothing to update")
        return

    cur = conn.cursor()
    cur.executemany(
        "UPDATE research_sources SET file_path = ?, s3_key = ? WHERE id = ?",
        [(rel, s3, rid) for rid, rel, s3 in updates],
    )
    conn.commit()
    print(f"\nwrote {cur.rowcount} updates to {args.db}")

    # Summary report
    print("\nsummary by source_type:")
    for t, n, with_s3 in conn.execute(
        "SELECT source_type, COUNT(*), COUNT(s3_key) FROM research_sources "
        "WHERE project_id = ? GROUP BY source_type ORDER BY 2 DESC", (PROJECT_ID,)
    ):
        print(f"  {t}: {with_s3}/{n} linked to MinIO")


if __name__ == "__main__":
    main()

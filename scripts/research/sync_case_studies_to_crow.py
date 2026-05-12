#!/usr/bin/env python3
"""
sync_case_studies_to_crow.py
============================

One-way sync from canvas-companion's canvas.db case studies into Crow's
data_case_studies + data_case_study_sections tables.

Design contract (Plan A, Round 4):
  - spring-2026/canvas.db is the source of truth.
  - Re-runnable and idempotent — content_hash-gated with \x1f separator.
  - Identities stable across re-runs via capstone_sync_map.
  - Never writes blog_post_id.
  - Skips sections with config.metric='' (see Phase 6 audit).
  - Per-case-study transactions — kill mid-run leaves either pre- or
    post-study state, never partial.

CLI:
    --dry-run         log every UPSERT without writing
    --limit N         only process the first N case studies
    --prune           delete Crow rows whose canvas source has disappeared
    --sources         also sync research.db → research_sources (Phase 4)
    --pirs            also sync canvas pir_requests → pir_requests (Phase 5)
    --only-ids 12,15  only process specific canvas case_study_ids
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


# ------------------------------ helpers ------------------------------


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _open_source(db_path: Path) -> sqlite3.Connection:
    """Open source DB read-only."""
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _open_target() -> sqlite3.Connection:
    """Open crow.db read-write. Caller must COMMIT."""
    conn = sqlite3.connect(CFG.CROW_DB_PATH, isolation_level=None)
    conn.row_factory = sqlite3.Row
    return conn


def _json_normalize(v) -> str:
    """Stable JSON encoding for content_hash: sort keys, compact separators."""
    if v is None:
        return ""
    if isinstance(v, str):
        try:
            parsed = json.loads(v)
        except (ValueError, TypeError):
            return v
        return json.dumps(parsed, sort_keys=True, separators=(",", ":"))
    return json.dumps(v, sort_keys=True, separators=(",", ":"))


def _content_hash_study(row) -> str:
    """Stable hash for a canvas.case_studies row."""
    parts = [
        row["title"] or "",
        row["description"] or "",
        row["default_voice"] or "",
        str(row["display_order"] if row["display_order"] is not None else 99),
    ]
    return hashlib.sha256(UNIT_SEP.join(parts).encode("utf-8")).hexdigest()


def _content_hash_section(row) -> str:
    """Stable hash for a canvas.case_study_sections row (post-transform config)."""
    parts = [
        row["title"] or "",
        row["section_type"] or "",
        str(row["sort_order"] if row["sort_order"] is not None else 0),
        row["content"] or "",
        row["sql"] or "",
        _json_normalize(row["config"]),
    ]
    return hashlib.sha256(UNIT_SEP.join(parts).encode("utf-8")).hexdigest()


def _transform_section_config(raw_config: str | None, section_type: str) -> tuple[str | None, str | None]:
    """
    Inject backend_id into chart/map config JSON. For maps, also inject
    geojson_url. Returns (transformed_json_text, skip_reason_or_None).

    Handles canvas.db's mixed encoding — 113 sections store config as plain
    JSON object text, 36 sections store it double-encoded (JSON string of a
    JSON object), 51 store the literal 'null' string. We normalize the
    output to plain JSON object text regardless of input encoding.

    skip_reason values: 'empty_metric' when config.metric is empty/null on a
    map section — caller routes these to section_skipped.json and does not
    INSERT them into crow.db.
    """
    if section_type not in ("chart", "map") or not raw_config:
        return raw_config, None
    try:
        cfg = json.loads(raw_config)
    except (ValueError, TypeError):
        return raw_config, None  # malformed; let downstream flag it

    # Unwrap double-encoding: `"{\"k\":v}"` -> str then second parse -> dict.
    if isinstance(cfg, str):
        try:
            cfg = json.loads(cfg)
        except (ValueError, TypeError):
            return raw_config, None

    if cfg is None or not isinstance(cfg, dict):
        return raw_config, None

    if section_type == "map":
        m = cfg.get("metric")
        if m in (None, ""):
            return raw_config, "empty_metric"
        cfg["geojson_url"] = "/bundles/tea-maps/api/geojson"

    cfg["backend_id"] = CFG.TEA_BACKEND_ID

    return json.dumps(cfg, ensure_ascii=False), None


def _map_get(cur, source_db: str, source_id: str) -> tuple[int | None, str | None]:
    cur.execute(
        "SELECT crow_id, content_hash FROM capstone_sync_map WHERE source_db = ? AND source_id = ?",
        (source_db, source_id),
    )
    row = cur.fetchone()
    return (row["crow_id"], row["content_hash"]) if row else (None, None)


def _map_upsert(cur, source_db: str, source_id: str, crow_id: int, content_hash: str) -> None:
    cur.execute(
        """
        INSERT INTO capstone_sync_map (source_db, source_id, crow_id, synced_at, content_hash)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(source_db, source_id) DO UPDATE SET
            crow_id = excluded.crow_id,
            synced_at = excluded.synced_at,
            content_hash = excluded.content_hash
        """,
        (source_db, source_id, crow_id, _now_iso(), content_hash),
    )


# ------------------------------ case-study sync ------------------------------


def sync_case_studies(*, dry_run: bool, limit: int | None, prune: bool, only_ids: set[int] | None) -> dict:
    """Sync 9 case studies + 357 sections from canvas.db to crow.db."""
    src = _open_source(CFG.CANVAS_DB)
    tgt = _open_target()
    cur = tgt.cursor()

    stats = {
        "studies_inserted": 0,
        "studies_updated": 0,
        "studies_skipped_nochange": 0,
        "sections_inserted": 0,
        "sections_updated": 0,
        "sections_skipped_nochange": 0,
        "sections_skipped_empty_metric": 0,
        "studies_deleted": 0,
        "sections_deleted": 0,
    }
    skipped_sections: list[dict] = []

    q_studies = "SELECT id, title, description, default_voice, display_order, created_at, updated_at FROM case_studies ORDER BY id"
    if only_ids:
        placeholders = ",".join("?" * len(only_ids))
        q_studies = f"SELECT id, title, description, default_voice, display_order, created_at, updated_at FROM case_studies WHERE id IN ({placeholders}) ORDER BY id"
        studies = src.execute(q_studies, tuple(only_ids)).fetchall()
    else:
        studies = src.execute(q_studies).fetchall()

    if limit is not None:
        studies = studies[:limit]

    for s in studies:
        source_id = str(s["id"])
        study_hash = _content_hash_study(s)
        crow_id, stored_hash = _map_get(cur, "canvas.db", source_id)

        if dry_run:
            action = "INSERT" if crow_id is None else ("UPDATE" if stored_hash != study_hash else "SKIP-nochange")
            print(f"[dry-run] case_study {s['id']:>3} {s['title']!r:>60} → {action}")
        else:
            cur.execute("BEGIN IMMEDIATE")
            try:
                if crow_id is None:
                    cur.execute(
                        """
                        INSERT INTO data_case_studies
                          (project_id, title, description, default_voice, display_order, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            CFG.CAPSTONE_PROJECT_ID,
                            s["title"],
                            s["description"],
                            s["default_voice"],
                            s["display_order"] if s["display_order"] is not None else 99,
                            _now_iso(),
                            _now_iso(),
                        ),
                    )
                    crow_id = cur.lastrowid
                    if crow_id is None:
                        raise RuntimeError("INSERT into data_case_studies returned no lastrowid")
                    stats["studies_inserted"] += 1
                elif stored_hash != study_hash:
                    cur.execute(
                        """
                        UPDATE data_case_studies
                           SET title = ?, description = ?, default_voice = ?, display_order = ?, updated_at = ?
                         WHERE id = ?
                        """,
                        (
                            s["title"],
                            s["description"],
                            s["default_voice"],
                            s["display_order"] if s["display_order"] is not None else 99,
                            _now_iso(),
                            crow_id,
                        ),
                    )
                    stats["studies_updated"] += 1
                else:
                    stats["studies_skipped_nochange"] += 1

                _map_upsert(cur, "canvas.db", source_id, crow_id, study_hash)

                # now sync sections for THIS study within the same transaction
                sec_stats, sec_skipped = _sync_sections(
                    cur, src, canvas_study_id=s["id"], crow_study_id=crow_id
                )
                for k, v in sec_stats.items():
                    stats[k] += v
                skipped_sections.extend(sec_skipped)

                cur.execute("COMMIT")
            except Exception:
                cur.execute("ROLLBACK")
                raise

    if prune:
        deleted = _prune_orphans(cur, studies, dry_run=dry_run)
        for k, v in deleted.items():
            stats[k] += v

    # Guard invariant: nothing published.
    cur.execute("SELECT COUNT(*) FROM data_case_studies WHERE blog_post_id IS NOT NULL")
    bp_count = cur.fetchone()[0]
    if bp_count > 0:
        print(f"⚠ WARNING: {bp_count} data_case_studies have blog_post_id IS NOT NULL (should be 0 during migration).")

    # Persist skipped log
    if skipped_sections and not dry_run:
        CFG.SECTION_SKIPPED.parent.mkdir(parents=True, exist_ok=True)
        CFG.SECTION_SKIPPED.write_text(
            json.dumps(skipped_sections, indent=2, ensure_ascii=False) + "\n"
        )

    tgt.close()
    src.close()
    return stats


def _sync_sections(cur, src, *, canvas_study_id: int, crow_study_id: int) -> tuple[dict, list]:
    stats = {
        "sections_inserted": 0,
        "sections_updated": 0,
        "sections_skipped_nochange": 0,
        "sections_skipped_empty_metric": 0,
    }
    skipped: list[dict] = []
    rows = src.execute(
        """
        SELECT id, case_study_id, section_type, sort_order, title, content, sql, config, created_at, updated_at
          FROM case_study_sections
         WHERE case_study_id = ?
         ORDER BY sort_order, id
        """,
        (canvas_study_id,),
    ).fetchall()

    for r in rows:
        source_id = f"section:{r['id']}"
        transformed_config, skip_reason = _transform_section_config(
            r["config"], r["section_type"]
        )
        if skip_reason == "empty_metric":
            stats["sections_skipped_empty_metric"] += 1
            skipped.append(
                {
                    "source_section_id": r["id"],
                    "canvas_case_study_id": canvas_study_id,
                    "section_type": r["section_type"],
                    "title": r["title"],
                    "issue": "empty_metric",
                    "detail": "config.metric is empty/null — source needs fix",
                }
            )
            continue

        r_transformed = dict(r)
        r_transformed["config"] = transformed_config
        section_hash = _content_hash_section(r_transformed)
        crow_id, stored_hash = _map_get(cur, "canvas.db", source_id)

        if crow_id is None:
            cur.execute(
                """
                INSERT INTO data_case_study_sections
                  (case_study_id, section_type, sort_order, title, content, sql, config, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    crow_study_id,
                    r["section_type"],
                    r["sort_order"] if r["sort_order"] is not None else 0,
                    r["title"],
                    r["content"],
                    r["sql"],
                    transformed_config,
                    _now_iso(),
                    _now_iso(),
                ),
            )
            crow_id = cur.lastrowid
            if crow_id is None:
                raise RuntimeError("INSERT into data_case_study_sections returned no lastrowid")
            stats["sections_inserted"] += 1
        elif stored_hash != section_hash:
            cur.execute(
                """
                UPDATE data_case_study_sections
                   SET section_type = ?, sort_order = ?, title = ?, content = ?, sql = ?, config = ?, updated_at = ?
                 WHERE id = ?
                """,
                (
                    r["section_type"],
                    r["sort_order"] if r["sort_order"] is not None else 0,
                    r["title"],
                    r["content"],
                    r["sql"],
                    transformed_config,
                    _now_iso(),
                    crow_id,
                ),
            )
            stats["sections_updated"] += 1
        else:
            stats["sections_skipped_nochange"] += 1

        _map_upsert(cur, "canvas.db", source_id, crow_id, section_hash)

    return stats, skipped


def _prune_orphans(cur, canvas_studies, *, dry_run: bool) -> dict:
    """Delete Crow rows (study + sections) whose canvas source no longer exists."""
    out = {"studies_deleted": 0, "sections_deleted": 0}
    canvas_ids = {str(s["id"]) for s in canvas_studies}

    orphans = cur.execute(
        "SELECT source_id, crow_id FROM capstone_sync_map WHERE source_db = 'canvas.db' AND source_id NOT LIKE 'section:%'"
    ).fetchall()

    for row in orphans:
        sid = row["source_id"]
        if sid in canvas_ids:
            continue
        if dry_run:
            print(f"[dry-run] prune case_study source={sid} crow_id={row['crow_id']}")
            continue
        cur.execute("DELETE FROM data_case_studies WHERE id = ?", (row["crow_id"],))
        out["studies_deleted"] += 1
        cur.execute(
            "DELETE FROM capstone_sync_map WHERE source_db = 'canvas.db' AND source_id = ?",
            (sid,),
        )

    return out


# ------------------------------ main ------------------------------


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--prune", action="store_true")
    p.add_argument("--sources", action="store_true", help="also run Phase 4 research_sources merge")
    p.add_argument("--pirs", action="store_true", help="also run Phase 5 pir_requests sync")
    p.add_argument("--only-ids", type=str, default=None, help="comma-separated canvas.case_studies.id values")
    args = p.parse_args()

    # Post-2026-04-21: project 6 case studies are hand-curated from the master
    # Google Doc via scripts/rebuild_chapter.py. Running the canvas → crow sync
    # would re-create deleted rows (Spanish Cleveland id=3, Report Draft id=8)
    # and overwrite text rebuilt from master. Guard unconditionally for the
    # capstone project; the other sync scripts (sources, pirs) are not gated.
    if CFG.CAPSTONE_PROJECT_ID == 6:
        print("project 6 is hand-curated post-2026-04-21 — use rebuild_chapter.py")
        print("(this guard is in sync_case_studies_to_crow.py main(). Remove it if project 6 changes.)")
        return 0

    only_ids = None
    if args.only_ids:
        only_ids = {int(x) for x in args.only_ids.split(",") if x.strip()}

    print(f"=== case_study sync (dry_run={args.dry_run} limit={args.limit} prune={args.prune}) ===")
    stats = sync_case_studies(
        dry_run=args.dry_run, limit=args.limit, prune=args.prune, only_ids=only_ids
    )
    for k, v in sorted(stats.items()):
        print(f"  {k:>30}: {v}")

    if args.sources:
        print("\n[--sources] Phase 4 research_sources merge — not yet implemented in this script.")
    if args.pirs:
        print("\n[--pirs] Phase 5 pir_requests sync — not yet implemented in this script.")

    return 0


if __name__ == "__main__":
    sys.exit(main())

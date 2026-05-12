#!/usr/bin/env python3
"""
sync_pirs_to_crow.py
====================

Phase 5: sync 53 pir_requests rows from canvas.db to Crow's pir_requests table.

Contract:
  - Full column set (sq1-sq4, priority, recipient_email, reference_number,
    status_notes, action_needed, next_followup_date, note_id — all preserved).
  - UPSERT keyed on pir_number (UNIQUE in both schemas).
  - s3_prefix populated via recipient → slug heuristic when a matching
    directory exists in ~/spring-2026/pir-responses/; else NULL.
  - Content-hash skip on re-run.

CLI:
    --dry-run
    --limit N
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sqlite3
import sys
from pathlib import Path
from datetime import datetime, timezone

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))
import crow_sync_config as CFG

UNIT_SEP = "\x1f"
PIR_DIR = CFG.SPRING_2026_ROOT / "pir-responses"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")


def _known_prefix_dirs() -> list[str]:
    if not PIR_DIR.exists():
        return []
    return [p.name for p in PIR_DIR.iterdir() if p.is_dir()]


def _resolve_s3_prefix(recipient: str, known_dirs: list[str]) -> str | None:
    """Best-effort recipient → s3_prefix mapping. NULL when no match."""
    slug = _slug(recipient)
    if not slug:
        return None
    if slug in known_dirs:
        return f"pirs/{slug}/"
    # Partial match on slug prefix (e.g., 'aldine' matches 'aldine-isd')
    for d in known_dirs:
        if d.startswith(slug) or slug.startswith(d):
            return f"pirs/{d}/"
    return None


def _content_hash(row: sqlite3.Row, s3_prefix: str | None) -> str:
    keys = [
        "pir_number", "label", "recipient", "recipient_email", "tea_id",
        "reference_number", "sq1", "sq2", "sq3", "sq4", "priority", "status",
        "filed_date", "response_due", "received_date", "note_id", "description",
        "status_notes", "action_needed", "next_followup_date",
    ]
    parts = [str(row[k]) if row[k] is not None else "" for k in keys]
    parts.append(s3_prefix or "")
    return hashlib.sha256(UNIT_SEP.join(parts).encode("utf-8")).hexdigest()


def _map_get(cur, pir_number: str) -> tuple[int | None, str | None]:
    cur.execute(
        "SELECT crow_id, content_hash FROM capstone_sync_map WHERE source_db = 'canvas.db' AND source_id = ?",
        (f"pir:{pir_number}",),
    )
    row = cur.fetchone()
    return (row["crow_id"], row["content_hash"]) if row else (None, None)


def _map_upsert(cur, pir_number: str, crow_id: int, h: str) -> None:
    cur.execute(
        """
        INSERT INTO capstone_sync_map (source_db, source_id, crow_id, synced_at, content_hash)
        VALUES ('canvas.db', ?, ?, ?, ?)
        ON CONFLICT(source_db, source_id) DO UPDATE SET
            crow_id = excluded.crow_id,
            synced_at = excluded.synced_at,
            content_hash = excluded.content_hash
        """,
        (f"pir:{pir_number}", crow_id, _now_iso(), h),
    )


def sync(*, dry_run: bool, limit: int | None) -> dict:
    src = sqlite3.connect(f"file:{CFG.CANVAS_DB}?mode=ro", uri=True)
    src.row_factory = sqlite3.Row
    tgt = sqlite3.connect(CFG.CROW_DB_PATH, isolation_level=None)
    tgt.row_factory = sqlite3.Row
    cur = tgt.cursor()

    stats = {"inserted": 0, "updated": 0, "skipped_nochange": 0, "with_s3_prefix": 0}

    known_dirs = _known_prefix_dirs()
    rows = src.execute("SELECT * FROM pir_requests ORDER BY pir_number").fetchall()
    if limit is not None:
        rows = rows[:limit]

    cur.execute("BEGIN IMMEDIATE")
    try:
        for r in rows:
            s3_prefix = _resolve_s3_prefix(r["recipient"], known_dirs)
            if s3_prefix:
                stats["with_s3_prefix"] += 1
            h = _content_hash(r, s3_prefix)
            crow_id, stored_hash = _map_get(cur, r["pir_number"])

            payload = {
                "pir_number": r["pir_number"],
                "label": r["label"],
                "recipient": r["recipient"],
                "recipient_email": r["recipient_email"],
                "tea_id": r["tea_id"],
                "reference_number": r["reference_number"],
                "sq1": r["sq1"], "sq2": r["sq2"], "sq3": r["sq3"], "sq4": r["sq4"],
                "priority": r["priority"],
                "status": r["status"],
                "filed_date": str(r["filed_date"]) if r["filed_date"] else None,
                "response_due": str(r["response_due"]) if r["response_due"] else None,
                "received_date": str(r["received_date"]) if r["received_date"] else None,
                "note_id": r["note_id"],
                "description": r["description"],
                "status_notes": r["status_notes"],
                "action_needed": r["action_needed"],
                "next_followup_date": str(r["next_followup_date"]) if r["next_followup_date"] else None,
                "s3_prefix": s3_prefix,
            }

            if dry_run:
                action = "INSERT" if crow_id is None else ("UPDATE" if stored_hash != h else "SKIP")
                print(f"[dry-run] pir={r['pir_number']} recipient={r['recipient']!r} → {action}  s3={s3_prefix}")
                continue

            if crow_id is None:
                cur.execute(
                    """
                    INSERT INTO pir_requests
                      (pir_number, label, recipient, recipient_email, tea_id, reference_number,
                       sq1, sq2, sq3, sq4, priority, status,
                       filed_date, response_due, received_date, note_id,
                       description, status_notes, action_needed, next_followup_date, s3_prefix)
                    VALUES
                      (:pir_number, :label, :recipient, :recipient_email, :tea_id, :reference_number,
                       :sq1, :sq2, :sq3, :sq4, :priority, :status,
                       :filed_date, :response_due, :received_date, :note_id,
                       :description, :status_notes, :action_needed, :next_followup_date, :s3_prefix)
                    """,
                    payload,
                )
                new_id = cur.lastrowid
                if new_id is None:
                    raise RuntimeError(f"INSERT returned no lastrowid for pir={r['pir_number']}")
                crow_id = new_id
                stats["inserted"] += 1
            elif stored_hash != h:
                cur.execute(
                    """
                    UPDATE pir_requests
                       SET label = :label, recipient = :recipient, recipient_email = :recipient_email,
                           tea_id = :tea_id, reference_number = :reference_number,
                           sq1 = :sq1, sq2 = :sq2, sq3 = :sq3, sq4 = :sq4,
                           priority = :priority, status = :status,
                           filed_date = :filed_date, response_due = :response_due, received_date = :received_date,
                           note_id = :note_id, description = :description, status_notes = :status_notes,
                           action_needed = :action_needed, next_followup_date = :next_followup_date,
                           s3_prefix = :s3_prefix, updated_at = :updated_at
                     WHERE id = :id
                    """,
                    {**payload, "updated_at": _now_iso(), "id": crow_id},
                )
                stats["updated"] += 1
            else:
                stats["skipped_nochange"] += 1

            _map_upsert(cur, r["pir_number"], crow_id, h)

        if not dry_run:
            cur.execute("COMMIT")
        else:
            cur.execute("ROLLBACK")
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
    print(f"=== pir_requests sync (dry_run={args.dry_run} limit={args.limit}) ===")
    stats = sync(dry_run=args.dry_run, limit=args.limit)
    for k, v in sorted(stats.items()):
        print(f"  {k:>20}: {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

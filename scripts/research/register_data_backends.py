"""Register tea_data + fed_gov_data as named data_backends.

Idempotent for the tea_data row on grackle (UPDATE if present, INSERT else).
For new fed_gov_data and the crow-side mirrors: only INSERT if missing.

Designed to be safe to re-run. Run separately on grackle and crow
(set HOST_LABEL accordingly).
"""
import argparse
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path


# ---------------------------------------------------------------------------
# schema_info builders


def _table_inventory(db_path: str) -> dict:
    """Snapshot of tables + row counts. None if file missing or empty."""
    p = Path(db_path)
    if not p.exists() or p.stat().st_size == 0:
        return {"tables": [], "table_count": 0, "total_rows": 0, "note": "empty"}
    con = sqlite3.connect(db_path)
    try:
        cur = con.cursor()
        names = [
            r[0] for r in cur.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type='table' AND name NOT LIKE 'sqlite_%' "
                "ORDER BY name"
            ).fetchall()
        ]
        tables = []
        total = 0
        for n in names:
            cnt = cur.execute(f'SELECT COUNT(*) FROM "{n}"').fetchone()[0]
            tables.append({"name": n, "rows": cnt})
            total += cnt
        return {
            "tables": tables,
            "table_count": len(tables),
            "total_rows": total,
        }
    finally:
        con.close()


def _categorize_tables(names: list) -> dict:
    """Group table names into human-readable categories."""
    cats = {
        "core":     [],
        "tapr":     [],
        "arc":      [],
        "finance":  [],
        "bond":     [],
        "charter":  [],
        "district": [],
        "iltexas":  [],
        "idea":     [],
        "tia":      [],
        "other":    [],
    }
    for n in names:
        if n in ("districts", "campuses", "campus_enrollment_by_grade",
                 "report_cache"):
            cats["core"].append(n)
        elif "tapr" in n:
            cats["tapr"].append(n)
        elif "arc" in n:
            cats["arc"].append(n)
        elif "tia" in n:
            cats["tia"].append(n)
        elif "iltexas" in n:
            cats["iltexas"].append(n)
        elif "idea" in n:
            cats["idea"].append(n)
        elif "charter" in n:
            cats["charter"].append(n)
        elif "bond" in n or "ifa" in n:
            cats["bond"].append(n)
        elif "dallas" in n or "cleveland" in n or "edgewood" in n \
                or "district" in n:
            cats["district"].append(n)
        elif n in ("fsp_data",) or "fsp" in n or "csp" in n or "fca" in n \
                or "fca_cost_items" in n or "title_i" in n:
            cats["finance"].append(n)
        else:
            cats["other"].append(n)
    return {k: v for k, v in cats.items() if v}


def build_schema_info(name: str, db_path: str, host: str) -> dict:
    inv = _table_inventory(db_path)
    info = {
        "version": 1,
        "name": name,
        "host": host,
        "db_path": db_path,
        "as_of": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        **inv,
    }
    if inv["tables"]:
        info["categories"] = _categorize_tables([t["name"] for t in inv["tables"]])

    if name == "tea_data":
        info["description"] = (
            "Texas Education Agency district/campus reference + capstone "
            "research aggregates. Populated by texas-gov-data-mcp."
        )
        info["key_columns"] = {
            "districts": ["district_id", "district_name"],
            "campuses": ["campus_id", "district_id", "campus_name", "grade_range"],
            "district_arc_scores": ["district_id", "school_year", "arc_overall"],
            "fsp_data": ["district_id", "school_year",
                         "total_state_aid", "tier_one"],
            "bond_elections": ["district_id", "election_date", "amount", "passed"],
        }
    elif name == "fed_gov_data":
        info["description"] = (
            "Federal education / Census / IRS data backing fed-gov-data-mcp. "
            "Cache populates lazily on first query (CENSUS_API_KEY required)."
        )
    return info


# ---------------------------------------------------------------------------
# Registration logic


def register(
    crow_db: str,
    host_label: str,
    *,
    project_id: int,
    tea_data_path: str,
    fed_data_path: str,
    dry_run: bool = False,
) -> None:
    con = sqlite3.connect(crow_db)
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    def _upsert(name: str, backend_type: str, db_path: str,
                status: str, tags: str):
        connection_ref = json.dumps({"path": db_path})
        schema_info = json.dumps(build_schema_info(name, db_path, host_label))
        existing = cur.execute(
            "SELECT id FROM data_backends WHERE name=? AND project_id=?",
            (name, project_id),
        ).fetchone()
        now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        if existing:
            print(f"  [{host_label}] UPDATE data_backends#{existing['id']} "
                  f"({name})")
            if not dry_run:
                cur.execute(
                    "UPDATE data_backends "
                    "SET backend_type=?, connection_ref=?, schema_info=?, "
                    "    status=?, tags=?, updated_at=? "
                    "WHERE id=?",
                    (backend_type, connection_ref, schema_info, status,
                     tags, now, existing["id"]),
                )
        else:
            print(f"  [{host_label}] INSERT data_backends ({name})")
            if not dry_run:
                cur.execute(
                    "INSERT INTO data_backends "
                    "(project_id, name, backend_type, connection_ref, "
                    " schema_info, status, tags, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (project_id, name, backend_type, connection_ref,
                     schema_info, status, tags, now, now),
                )

    _upsert(
        "tea_data",
        backend_type="sqlite",
        db_path=tea_data_path,
        status="connected" if Path(tea_data_path).exists() and
               Path(tea_data_path).stat().st_size > 0 else "disconnected",
        tags="capstone,tea,texas-gov-data,school-finance",
    )
    _upsert(
        "fed_gov_data",
        backend_type="sqlite",
        db_path=fed_data_path,
        status="connected" if Path(fed_data_path).exists() and
               Path(fed_data_path).stat().st_size > 0 else "disconnected",
        tags="capstone,federal,census,fed-gov-data",
    )

    if dry_run:
        print(f"  [{host_label}] dry-run: rollback")
        con.rollback()
    else:
        con.commit()

    print(f"\n  [{host_label}] data_backends now:")
    for r in cur.execute(
        "SELECT id, project_id, name, backend_type, status FROM data_backends "
        "WHERE project_id=? ORDER BY id",
        (project_id,),
    ):
        print(f"    #{r['id']} project={r['project_id']} {r['name']} "
              f"({r['backend_type']}, {r['status']})")
    con.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True,
                        choices=["grackle", "crow"],
                        help="Which host's environment to assume")
    parser.add_argument("--db", required=True,
                        help="Path to crow.db on this host")
    parser.add_argument("--project-id", type=int, default=6,
                        help="research_projects.id to attach to (default 6)")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.host == "grackle":
        tea = "/home/kh0pp/spring-2026/texas-gov-data-mcp/data/tea_data.db"
        fed = "/home/kh0pp/spring-2026/fed-gov-data-mcp/data/fed_ed_data.db"
    else:
        tea = "/home/kh0pp/crow/bundles/texas-gov-data/data/tea_data.db"
        fed = "/home/kh0pp/crow/bundles/fed-gov-data/data/fed_ed_data.db"

    # Sanity: project_id must exist
    con = sqlite3.connect(args.db)
    cur = con.cursor()
    row = cur.execute(
        "SELECT id, name FROM research_projects WHERE id=?",
        (args.project_id,),
    ).fetchone()
    con.close()
    if not row:
        print(f"  [{args.host}] project_id={args.project_id} not found "
              f"in research_projects — bailing", file=sys.stderr)
        sys.exit(1)
    print(f"  [{args.host}] attaching to project #{row[0]}: {row[1]}")

    register(
        crow_db=args.db,
        host_label=args.host,
        project_id=args.project_id,
        tea_data_path=tea,
        fed_data_path=fed,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    main()

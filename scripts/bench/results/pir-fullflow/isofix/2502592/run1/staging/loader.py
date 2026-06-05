#!/usr/bin/env python3
"""
Loader for PIR #2502592 — TEA Pregnancy/Parenting PEIMS Data
Loads CSV files into tea_data.db as table research_pir2502592_<year_dataset>.
"""

import csv
import os
import sqlite3
import sys
import argparse

HOLDING_DIR = os.environ.get(
    "PIR_HOLDING_DIR",
    "/home/kh0pp/spring-2026/insd-5941/sources/pir-incoming/2502592"
)
TEA_DB = os.environ.get(
    "TEA_DB",
    os.path.expanduser("~/spring-2026/texas-gov-data-mcp/data/tea_data.db")
)

FILES = [
    {"file": "PRU_11507_21.csv", "year": "2020-2021", "table": "research_pir2502592_2020_2021"},
    {"file": "PRU_11507_22.csv", "year": "2021-2022", "table": "research_pir2502592_2021_2022"},
    {"file": "PRU_11507_23.csv", "year": "2022-2023", "table": "research_pir2502592_2022_2023"},
    {"file": "PRU_11507_24.csv", "year": "2023-2024", "table": "research_pir2502592_2023_2024"},
    {"file": "PRU_11507_25.csv", "year": "2024-2025", "table": "research_pir2502592_2024_2025"},
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS {table} (
    year TEXT,
    district TEXT,
    distname TEXT,
    pregnant_cte_students INTEGER,
    singlepar_cte_students INTEGER,
    elig_preg_rel_svcs_days REAL
)
"""


def convert_ferpa(value):
    """Convert -999 (FERPA masking) to None."""
    if value == "-999":
        return None
    return value


def load_csv(db_path, filepath, table, dry_run=False):
    """Load a single CSV into the database."""
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    cursor.execute(SCHEMA.format(table=table))

    # Duplicate guard
    cursor.execute(f"SELECT COUNT(*) FROM {table}")
    existing = cursor.fetchone()[0]
    if existing > 0:
        print(f"  SKIP {table}: already has {existing} rows")
        conn.close()
        return 0

    rows = 0
    with open(filepath, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            cursor.execute(
                f"INSERT OR IGNORE INTO {table} "
                f"(year, district, distname, pregnant_cte_students, "
                f"singlepar_cte_students, elig_preg_rel_svcs_days) "
                f"VALUES (?, ?, ?, ?, ?, ?)",
                (
                    convert_ferpa(row.get("YEAR")),
                    convert_ferpa(row.get("DISTRICT")),
                    convert_ferpa(row.get("DISTNAME")),
                    convert_ferpa(row.get("PREGNANT_CTE_STUDENTS")),
                    convert_ferpa(row.get("SINGLEPAR_CTE_STUDENTS")),
                    convert_ferpa(row.get("ELIG_PREG_REL_SVCS_DAYS")),
                ),
            )
            rows += 1

    if not dry_run:
        conn.commit()

    conn.close()
    print(f"  {table}: {rows} rows")
    return rows


def main():
    parser = argparse.ArgumentParser(description="Load PIR #2502592 PEIMS data")
    parser.add_argument("--dry-run", action="store_true", help="Print row counts only")
    parser.add_argument("--commit", action="store_true", help="Commit to database")
    args = parser.parse_args()

    if not os.path.exists(HOLDING_DIR):
        print(f"ERROR: Holding dir not found: {HOLDING_DIR}")
        sys.exit(1)

    print(f"TEA DB: {TEA_DB}")
    print(f"Holding dir: {HOLDING_DIR}")
    print(f"Mode: {'DRY RUN' if args.dry_run else 'COMMIT'}")
    print()

    total = 0
    for file_info in FILES:
        filepath = os.path.join(HOLDING_DIR, file_info["file"])
        if not os.path.exists(filepath):
            print(f"  MISSING: {filepath}")
            continue
        print(f"Loading {file_info['file']} ({file_info['year']})...")
        rows = load_csv(TEA_DB, filepath, file_info["table"], dry_run=not args.commit)
        total += rows

    print(f"\nTotal rows processed: {total}")
    if args.commit:
        print("COMMIT COMPLETE")
    else:
        print("DRY RUN — no changes written")


if __name__ == "__main__":
    main()

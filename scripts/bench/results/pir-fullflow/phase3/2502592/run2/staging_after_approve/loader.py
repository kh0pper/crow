#!/usr/bin/env python3
"""Loader for PIR #2502592 — TEA Pregnancy/Parenting PEIMS Data.

Reads 5 CSV files from the holding directory and writes to tea_data.db
as 5 separate tables (one per year).

Usage:
    python3 loader.py --commit    # Load to DB
    python3 loader.py --dry-run   # Preview row counts only
"""

import argparse
import csv
import os
import sqlite3
import sys
from pathlib import Path

TEA_DB = os.environ.get("TEA_DB", os.path.expanduser("~/spring-2026/texas-gov-data-mcp/data/tea_data.db"))
HOLDING_DIR = os.path.dirname(os.path.abspath(__file__)).replace("_staging", "pir-incoming").replace("/_staging/", "/")

# If running from _staging dir, find holding dir
# Try multiple strategies to locate the holding directory
_staging_path = Path(__file__).resolve().parent
_candidates = [
    _staging_path.parent.parent / "pir-incoming" / "2502592",  # _staging/2502592 -> pir-incoming/252592
    _staging_path.parent / "2502592",  # _staging/2502592 -> 2502592
    Path("/home/kh0pp/spring-2026/insd-5941/sources/pir-incoming/2502592"),
]

HOLDING_DIR = None
for c in _candidates:
    if c.exists() and any(c.glob("*.csv")):
        HOLDING_DIR = str(c)
        break

if not HOLDING_DIR:
    print("ERROR: Cannot locate holding directory with CSV files.", file=sys.stderr)
    sys.exit(1)

PIR_NUMBER = "2502592"

FILE_TO_TABLE = {
    "PRU_11507_21.csv": f"research_pir{PIR_NUMBER}_21",
    "PRU_11507_22.csv": f"research_pir{PIR_NUMBER}_22",
    "PRU_11507_23.csv": f"research_pir{PIR_NUMBER}_23",
    "PRU_11507_24.csv": f"research_pir{PIR_NUMBER}_24",
    "PRU_11507_25.csv": f"research_pir{PIR_NUMBER}_25",
}

CREATE_SQL = """
CREATE TABLE IF NOT EXISTS {table} (
    YEAR TEXT,
    DISTRICT TEXT,
    DISTNAME TEXT,
    PREGNANT_CTE_STUDENTS TEXT,
    SINGLEPAR_CTE_STUDENTS TEXT,
    ELIG_PREG_REL_SVCS_DAYS TEXT
)
"""

INSERT_SQL = """
INSERT INTO {table} (YEAR, DISTRICT, DISTNAME, PREGNANT_CTE_STUDENTS, SINGLEPAR_CTE_STUDENTS, ELIG_PREG_REL_SVCS_DAYS)
VALUES (?, ?, ?, ?, ?, ?)
"""


def convert_ferpa(value):
    """Convert -999 FERPA masking to NULL."""
    if value == "-999":
        return None
    return value


def load_file(filepath, table_name, dry_run=False):
    """Load a single CSV file into the database."""
    conn = sqlite3.connect(TEA_DB)
    cur = conn.cursor()

    # Create table if not exists (must come before SELECT)
    cur.execute(CREATE_SQL.format(table=table_name))

    # Check if table already has rows (duplicate guard)
    cur.execute(f"SELECT COUNT(*) FROM {table_name}")
    existing = cur.fetchone()[0]
    if existing > 0:
        print(f"  SKIP {table_name}: already has {existing} rows (duplicate guard)")
        conn.close()
        return 0

    new_rows = 0
    with open(filepath, newline="") as f:
        reader = csv.reader(f)
        header = next(reader)  # skip header
        for row in reader:
            if len(row) != 6:
                continue
            converted = [convert_ferpa(cell.strip()) for cell in row]
            cur.execute(INSERT_SQL.format(table=table_name), converted)
            new_rows += 1

    if not dry_run:
        conn.commit()

    conn.close()
    return new_rows


def main():
    parser = argparse.ArgumentParser(description="Load PIR #2502592 CSV files into tea_data.db")
    parser.add_argument("--commit", action="store_true", help="Actually write to DB")
    parser.add_argument("--dry-run", action="store_true", help="Print row counts only")
    args = parser.parse_args()

    if not args.commit and not args.dry_run:
        print("Usage: loader.py [--commit | --dry-run]")
        sys.exit(1)

    dry_run = args.dry_run
    mode = "DRY RUN" if dry_run else "COMMIT"
    print(f"=== PIR #{PIR_NUMBER} Loader ({mode}) ===")
    print(f"  DB: {TEA_DB}")
    print(f"  Holding: {HOLDING_DIR}")

    total_rows = 0
    for filename, table_name in sorted(FILE_TO_TABLE.items()):
        filepath = os.path.join(HOLDING_DIR, filename)
        if not os.path.exists(filepath):
            print(f"  MISSING: {filepath}")
            continue
        rows = load_file(filepath, table_name, dry_run=dry_run)
        print(f"  {filename} -> {table_name}: {rows} rows")
        total_rows += rows

    print(f"\n  Total: {total_rows} rows across {len(FILE_TO_TABLE)} tables")

    if args.commit:
        print("\n  COMMIT COMPLETE")
    else:
        print("\n  DRY RUN — no changes made")


if __name__ == "__main__":
    main()

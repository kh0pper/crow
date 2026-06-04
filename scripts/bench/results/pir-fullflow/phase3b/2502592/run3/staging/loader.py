#!/usr/bin/env python3
"""Load PIR #2502592 data (TEA Pregnancy/Parenting PEIMS) into tea_data.db.

Reads CSV files from the holding directory and writes per-year tables
named research_pir2502592_<year> into tea_data.db.

Usage:
    python3 loader.py --dry-run    # Print row counts per table
    python3 loader.py --commit     # Insert rows into tea_data.db
"""

import argparse
import csv
import os
import sqlite3
import sys

TEA_DB = os.environ.get(
    "TEA_DB",
    os.path.expanduser("~/spring-2026/texas-gov-data-mcp/data/tea_data.db"),
)

HOLDING_DIR = os.path.dirname(os.path.abspath(__file__))
# The holding dir for the downloaded attachments
ATTACHMENTS_DIR = os.environ.get(
    "ATTACHMENTS_DIR",
    os.path.join(os.path.dirname(HOLDING_DIR), "..", "pir-incoming", "2502592"),
)

CSV_FILES = {
    "2020-2021": "PRU_11507_21.csv",
    "2021-2022": "PRU_11507_22.csv",
    "2022-2023": "PRU_11507_23.csv",
    "2023-2024": "PRU_11507_24.csv",
    "2024-2025": "PRU_11507_25.csv",
}

# Convert -999 to NULL (FERPA masking)
def clean(row):
    return {k: None if v == "-999" else v for k, v in row.items()}


def make_table_name(year):
    """SQLite table name: use underscore for year to avoid hyphen issues."""
    return f"research_pir2502592_{year.replace('-', '_')}"


def main():
    parser = argparse.ArgumentParser(description="Load PIR #2502592 data")
    parser.add_argument("--dry-run", action="store_true", help="Print row counts only")
    parser.add_argument("--commit", action="store_true", help="Insert rows into DB")
    args = parser.parse_args()

    conn = sqlite3.connect(TEA_DB)
    cur = conn.cursor()

    total_rows = 0
    table_counts = {}

    for year, filename in sorted(CSV_FILES.items()):
        table = make_table_name(year)
        filepath = os.path.join(ATTACHMENTS_DIR, filename)

        if not os.path.exists(filepath):
            print(f"WARNING: {filepath} not found, skipping {year}")
            continue

        # Read CSV
        with open(filepath, newline="") as f:
            reader = csv.DictReader(f)
            rows = list(reader)

        row_count = len(rows)
        table_counts[table] = row_count

        # Create table if not exists
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS {table} (
                YEAR TEXT,
                DISTRICT TEXT,
                DISTNAME TEXT,
                PREGNANT_CTE_STUDENTS INTEGER,
                SINGLEPAR_CTE_STUDENTS INTEGER,
                ELIG_PREG_REL_SVCS_DAYS REAL
            )
        """)

        # Duplicate guard: skip if table already has rows
        cur.execute(f"SELECT COUNT(*) FROM {table}")
        existing = cur.fetchone()[0]
        if existing > 0:
            print(f"  {table}: {existing} rows already exist, skipping ({row_count} new)")
            total_rows += existing
            continue

        # Insert with -999 -> NULL conversion
        placeholders = ", ".join(["?"] * 6)
        cols = "YEAR, DISTRICT, DISTNAME, PREGNANT_CTE_STUDENTS, SINGLEPAR_CTE_STUDENTS, ELIG_PREG_REL_SVCS_DAYS"
        sql = f"INSERT INTO {table} ({cols}) VALUES ({placeholders})"

        cleaned = [list(clean(row).values()) for row in rows]
        cur.executemany(sql, cleaned)

        if args.commit:
            conn.commit()

        print(f"  {table}: {row_count} rows {'(committed)' if args.commit else '(dry-run)'}")
        total_rows += row_count

    print(f"\nTotal: {total_rows} rows across {len(table_counts)} tables")

    if args.dry_run:
        print("\nRow counts (dry-run):")
        for t, c in sorted(table_counts.items()):
            print(f"  {t}: {c}")

    conn.close()
    print(f"\nDB: {TEA_DB}")
    if args.commit:
        print("COMMIT COMPLETE")
    else:
        print("DRY-RUN (no changes to DB)")


if __name__ == "__main__":
    main()

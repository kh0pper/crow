#!/usr/bin/env python3
"""Loader for PIR #2502592 — District-Level Pregnancy Related Services Data (PEIMS)

Reads CSV files from the holding directory and loads into tea_data.db.
One table per school year: research_pir2502592_<year>

Usage:
    python3 loader.py --dry-run   # Print row counts only
    python3 loader.py --commit    # Actually load into tea_data.db
"""

import argparse
import csv
import os
import sqlite3
import sys
import glob

# Target DB location
TEA_DB = os.environ.get("TEA_DB", os.path.expanduser("~/spring-2026/texas-gov-data-mcp/data/tea_data.db"))

# Holding directory (source CSVs)
HOLDING_DIR = os.path.dirname(os.path.abspath(__file__)).replace("_staging/2502592", "pir-incoming/2502592")

# Tables: one per school year
TABLES = [
    {"name": "research_pir2502592_2020_2021", "file": "PRU_11507_21.csv", "year": "2020-2021"},
    {"name": "research_pir2502592_2021_2022", "file": "PRU_11507_22.csv", "year": "2021-2022"},
    {"name": "research_pir2502592_2022_2023", "file": "PRU_11507_23.csv", "year": "2022-2023"},
    {"name": "research_pir2502592_2023_2024", "file": "PRU_11507_24.csv", "year": "2023-2024"},
    {"name": "research_pir2502592_2024_2025", "file": "PRU_11507_25.csv", "year": "2024-2025"},
]

SCHEMA = """
YEAR TEXT,
DISTRICT TEXT,
DISTNAME TEXT,
PREGNANT_CTE_STUDENTS INTEGER,
SINGLEPAR_CTE_STUDENTS INTEGER,
ELIG_PREG_REL_SVCS_DAYS REAL
"""


def convert_value(val):
    """Convert -999 to None for FERPA masking. Keep other values."""
    if val == "-999":
        return None
    return val


def read_csv_rows(filepath):
    """Read a CSV file and return list of dicts with -999 converted to None."""
    rows = []
    with open(filepath, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            converted = {}
            for k, v in row.items():
                converted[k] = convert_value(v.strip()) if v else None
            rows.append(converted)
    return rows


def create_table(cursor, table_name):
    """Create the table if it doesn't exist."""
    cursor.execute(f"""
        CREATE TABLE IF NOT EXISTS {table_name} (
            {SCHEMA}
        )
    """)


def table_has_rows(cursor, table_name):
    """Check if table already has data (duplicate guard)."""
    cursor.execute(f"SELECT COUNT(*) FROM {table_name}")
    return cursor.fetchone()[0] > 0


def insert_rows(cursor, table_name, rows):
    """Insert rows into the table."""
    if not rows:
        return 0
    cols = ", ".join(rows[0].keys())
    placeholders = ", ".join(["?"] * len(rows[0]))
    cursor.execute(f"INSERT INTO {table_name} ({cols}) VALUES ({placeholders})", rows)
    return len(rows)


def main():
    parser = argparse.ArgumentParser(description="Load PIR #2502592 PEIMS data into tea_data.db")
    parser.add_argument("--dry-run", action="store_true", help="Print row counts without loading")
    parser.add_argument("--commit", action="store_true", help="Commit data to tea_data.db")
    args = parser.parse_args()

    if not args.dry_run and not args.commit:
        print("Error: specify --dry-run or --commit", file=sys.stderr)
        sys.exit(1)

    if args.dry_run:
        print("=== DRY RUN — PIR #2502592 ===")
        total = 0
        for tbl in TABLES:
            filepath = os.path.join(HOLDING_DIR, tbl["file"])
            if not os.path.exists(filepath):
                print(f"  {tbl['name']}: FILE NOT FOUND ({filepath})")
                continue
            rows = read_csv_rows(filepath)
            count = len(rows)
            total += count
            print(f"  {tbl['name']}: {count} rows")
        print(f"  TOTAL: {total} rows across {len(TABLES)} tables")
        return

    if args.commit:
        print("=== COMMIT — PIR #2502592 ===")
        conn = sqlite3.connect(TEA_DB)
        cursor = conn.cursor()
        total = 0
        for tbl in TABLES:
            filepath = os.path.join(HOLDING_DIR, tbl["file"])
            if not os.path.exists(filepath):
                print(f"  {tbl['name']}: FILE NOT FOUND — SKIP", file=sys.stderr)
                continue
            if table_has_rows(cursor, tbl["name"]):
                print(f"  {tbl['name']}: EXISTS — SKIP (duplicate guard)")
                continue
            rows = read_csv_rows(filepath)
            create_table(cursor, tbl["name"])
            inserted = insert_rows(cursor, tbl["name"], rows)
            total += inserted
            print(f"  {tbl['name']}: {inserted} rows inserted")
        conn.commit()
        print(f"  TOTAL: {total} rows committed across {len(TABLES)} tables")
        print("  COMMIT COMPLETE")
        conn.close()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Load PIR #2502592 TEA Pregnancy/Parenting PEIMS data into tea_data.db.

Reads CSV files from holding_dir and inserts into tables named
research_pir2502592_<year> (e.g. research_pir2502592_2020_2021).

Usage:
    python3 loader.py --dry-run   # Print row counts only
    python3 loader.py --commit    # Insert into tea_data.db

Duplicate guard: skips if target table already has rows.
FERPA masking: converts -999 to NULL.
"""

import argparse
import csv
import os
import sqlite3
import sys
import glob

HOLDING_DIR = os.environ.get(
    "PIR_HOLDING_DIR",
    "/home/kh0pp/spring-2026/insd-5941/sources/pir-incoming/2502592"
)
TEA_DB = os.environ.get(
    "TEA_DB",
    os.path.expanduser("~/spring-2026/texas-gov-data-mcp/data/tea_data.db")
)

CSV_FILES = sorted(glob.glob(os.path.join(HOLDING_DIR, "PRU_11507_*.csv")))

YEAR_MAP = {
    "PRU_11507_21": "2020_2021",
    "PRU_11507_22": "2021_2022",
    "PRU_11507_23": "2022_2023",
    "PRU_11507_24": "2023_2024",
    "PRU_11507_25": "2024_2025",
}


def to_table_name(filename):
    """Convert CSV filename to table name."""
    base = os.path.splitext(os.path.basename(filename))[0]
    year = YEAR_MAP.get(base, base)
    return f"research_pir2502592_{year}"


def convert_row(row):
    """Convert -999 values to None (NULL)."""
    result = {}
    for k, v in row.items():
        if v == "-999" or v == -999:
            result[k] = None
        else:
            result[k] = v
    return result


def load_file(conn, filepath):
    """Load a single CSV file into the database or dry-run."""
    table = to_table_name(filepath)
    with open(filepath, "r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    row_count = len(rows)
    columns = reader.fieldnames

    if columns is None:
        print(f"  SKIP {table}: no columns found in {filepath}")
        return 0

    print(f"  Table: {table}")
    print(f"  Columns: {', '.join(columns)}")
    print(f"  Rows in file: {row_count}")

    # Duplicate guard
    cur = conn.cursor()
    cur.execute(f"SELECT COUNT(*) FROM {table}")
    existing = cur.fetchone()[0]
    if existing > 0:
        print(f"  SKIP: table {table} already has {existing} rows")
        return 0

    # Create table and insert
    col_defs = ", ".join(f'"{c}" TEXT' for c in columns)
    cur.execute(f"DROP TABLE IF EXISTS {table}")
    cur.execute(f"CREATE TABLE {table} ({col_defs})")

    placeholders = ", ".join(["?"] * len(columns))
    col_names = ", ".join(f'"{c}"' for c in columns)

    inserted = 0
    for row in rows:
        converted = convert_row(row)
        values = tuple(converted.get(c) for c in columns)
        cur.execute(f"INSERT INTO {table} ({col_names}) VALUES ({placeholders})", values)
        inserted += 1

    conn.commit()
    print(f"  INSERTED: {inserted} rows")
    return inserted


def main():
    parser = argparse.ArgumentParser(description="Load PIR #2502592 data")
    parser.add_argument("--dry-run", action="store_true", help="Print row counts only")
    parser.add_argument("--commit", action="store_true", help="Insert into tea_data.db")
    args = parser.parse_args()

    if not args.dry_run and not args.commit:
        parser.error("Must specify --dry-run or --commit")

    if args.dry_run:
        print("=== DRY RUN: PIR #2502592 ===")
        total = 0
        for filepath in CSV_FILES:
            with open(filepath, "r", newline="", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                rows = list(reader)
            table = to_table_name(filepath)
            print(f"  {os.path.basename(filepath)} -> {table}: {len(rows)} rows")
            total += len(rows)
        print(f"  TOTAL: {total} rows across {len(CSV_FILES)} files")
        return

    if args.commit:
        print("=== COMMIT: PIR #2502592 ===")
        conn = sqlite3.connect(TEA_DB)
        total = 0
        for filepath in CSV_FILES:
            inserted = load_file(conn, filepath)
            total += inserted
        conn.close()
        print(f"\n  COMMIT COMPLETE: {total} new rows across {len([f for f in CSV_FILES])} tables")


if __name__ == "__main__":
    main()

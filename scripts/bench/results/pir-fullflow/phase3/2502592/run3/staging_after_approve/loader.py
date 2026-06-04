#!/usr/bin/env python3
"""Loader for PIR #2502592 — TEA Pregnancy/Parenting PEIMS Data.

Reads PRU_11507_21.csv through PRU_11507_25.csv from the holding directory
and loads them into tea_data.db as tables named research_pir2502592_21
through research_pir2502592_25.

Usage:
    python3 loader.py --dry-run    # Print row counts, no commit
    python3 loader.py --commit     # Load into tea_data.db
"""

import argparse
import csv
import os
import sqlite3
import sys

TEA_DB = os.environ.get(
    "TEA_DB",
    os.path.expanduser("~/spring-2026/texas-gov-data-mcp/data/tea_data.db")
)

HOLDING_DIR = os.path.dirname(os.path.abspath(__file__)).replace("_staging/2502592", "pir-incoming/2502592")
if not os.path.isdir(HOLDING_DIR):
    # Fallback: use the holding_dir from kickoff if available
    HOLDING_DIR = "/home/kh0pp/spring-2026/insd-5941/sources/pir-incoming/2502592"

TABLES = [
    ("PRU_11507_21.csv", "research_pir2502592_21"),
    ("PRU_11507_22.csv", "research_pir2502592_22"),
    ("PRU_11507_23.csv", "research_pir2502592_23"),
    ("PRU_11507_24.csv", "research_pir2502592_24"),
    ("PRU_11507_25.csv", "research_pir2502592_25"),
]

# Column mapping: CSV columns to SQL types
SCHEMA = {
    "YEAR": "TEXT",
    "DISTRICT": "TEXT",
    "DISTNAME": "TEXT",
    "PREGNANT_CTE_STUDENTS": "INTEGER",
    "SINGLEPAR_CTE_STUDENTS": "INTEGER",
    "ELIG_PREG_REL_SVCS_DAYS": "INTEGER",
}


def convert_row(row: dict) -> dict:
    """Convert a CSV row dict, replacing -999 with None (FERPA masking)."""
    converted = {}
    for key, value in row.items():
        if key in SCHEMA and value == "-999":
            converted[key] = None
        else:
            converted[key] = value
    return converted


def dry_run(conn: sqlite3.Connection) -> dict:
    """Dry run: report row counts without committing."""
    counts = {}
    for filename, table_name in TABLES:
        filepath = os.path.join(HOLDING_DIR, filename)
        if not os.path.exists(filepath):
            print(f"  SKIP {filename}: file not found at {filepath}")
            counts[table_name] = -1
            continue

        # Count data rows (skip header)
        with open(filepath, newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            header = next(reader)
            data_rows = sum(1 for _ in reader)

        # Check existing table
        cursor = conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
            (table_name,)
        )
        table_exists = cursor.fetchone()[0] > 0

        if table_exists:
            cursor = conn.execute(f"SELECT COUNT(*) FROM {table_name}")
            existing_rows = cursor.fetchone()[0]
        else:
            existing_rows = 0

        counts[table_name] = data_rows
        status = "WILL LOAD"
        if table_exists and existing_rows > 0:
            status = f"DUPLICATE GUARD ({existing_rows} rows already present)"

        print(f"  {table_name}: {data_rows} rows in file | {existing_rows} existing | {status}")

    return counts


def load(conn: sqlite3.Connection) -> dict:
    """Load all CSVs into tea_data.db. Returns row counts per table."""
    counts = {}
    for filename, table_name in TABLES:
        filepath = os.path.join(HOLDING_DIR, filename)
        if not os.path.exists(filepath):
            print(f"  SKIP {filename}: file not found at {filepath}")
            counts[table_name] = -1
            continue

        # Duplicate guard: skip if table already has rows
        cursor = conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
            (table_name,)
        )
        if cursor.fetchone()[0] > 0:
            cursor = conn.execute(f"SELECT COUNT(*) FROM {table_name}")
            existing = cursor.fetchone()[0]
            if existing > 0:
                print(f"  SKIP {table_name}: {existing} rows already present")
                counts[table_name] = existing
                continue
            else:
                # Table exists but is empty — recreate
                conn.execute(f"DROP TABLE IF EXISTS {table_name}")

        # Create table
        col_defs = ", ".join(f"{col} {typ}" for col, typ in SCHEMA.items())
        conn.execute(f"CREATE TABLE {table_name} ({col_defs})")

        # Read CSV and insert
        with open(filepath, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = [convert_row(row) for row in reader]

        if rows:
            placeholders = ", ".join(["?"] * len(SCHEMA))
            cols = ", ".join(SCHEMA.keys())
            conn.executemany(
                f"INSERT INTO {table_name} ({cols}) VALUES ({placeholders})",
                [[row[c] for c in SCHEMA.keys()] for row in rows]
            )

        counts[table_name] = len(rows)
        print(f"  {table_name}: loaded {len(rows)} rows")

    return counts


def main():
    parser = argparse.ArgumentParser(description="Load PIR #2502592 PEIMS data")
    parser.add_argument("--dry-run", action="store_true", help="Show row counts without committing")
    parser.add_argument("--commit", action="store_true", help="Load data into tea_data.db")
    args = parser.parse_args()

    if not args.dry_run and not args.commit:
        print("Usage: loader.py --dry-run | --commit")
        sys.exit(1)

    conn = sqlite3.connect(TEA_DB)

    if args.dry_run:
        print("=== DRY RUN ===")
        counts = dry_run(conn)
        print()
        total = sum(v for v in counts.values() if v > 0)
        print(f"Total data rows: {total}")
        conn.close()
    elif args.commit:
        print("=== LOADING ===")
        counts = load(conn)
        if any(v > 0 for v in counts.values()):
            conn.commit()
        total = sum(v for v in counts.values() if v > 0)
        print(f"\nCOMMIT COMPLETE: {total} total rows across {len([v for v in counts.values() if v > 0])} tables")
        conn.close()


if __name__ == "__main__":
    main()

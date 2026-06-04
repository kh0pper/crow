#!/usr/bin/env python3
"""
Loader for PIR #2502592 - TEA Pregnancy Related Services PEIMS Data

Loads 5 CSV files (PRU_11507_21.csv through PRU_11507_25.csv) into tea_data.db.
One table per year: research_pir2502592_2020_21, research_pir2502592_2021_22, etc.

Usage:
    python3 loader.py --dry-run    # Print row counts (default)
    python3 loader.py --commit     # Load data into tea_data.db
"""

import argparse
import csv
import os
import sqlite3
import sys
from pathlib import Path


def get_db_path():
    """Get the tea_data.db path from env or default location."""
    return os.environ.get(
        "TEA_DB",
        os.path.expanduser("~/spring-2026/texas-gov-data-mcp/data/tea_data.db")
    )


def get_holding_dir():
    """Get the holding directory from env or default."""
    env = os.environ.get("HOLDING_DIR")
    if env:
        return Path(env)
    # Default: look for pir-incoming/<pir_number>/ relative to project root
    staging_parent = Path(__file__).resolve().parent.parent
    # staging_parent is _staging/; parent.parent is sources/
    sources_root = staging_parent.parent.parent
    # Try: sources/pir-incoming/2502592/
    candidate = sources_root / "pir-incoming" / "2502592"
    if candidate.exists():
        return candidate
    # Fallback: staging parent's sibling
    candidate2 = staging_parent.parent / "pir-incoming" / "2502592"
    if candidate2.exists():
        return candidate2
    raise FileNotFoundError(f"Holding dir not found for PIR 2502592")


def load_csv_to_table(cursor, conn, csv_path, table_name, dry_run=False):
    """Load a single CSV file into the specified table."""
    with open(csv_path, "r", newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        headers = next(reader)
        rows = list(reader)

    row_count = len(rows)

    # Convert -999 to NULL (FERPA masking)
    cleaned_rows = []
    for row in rows:
        cleaned = []
        for val in row:
            if val.strip() == "-999":
                cleaned.append(None)
            else:
                cleaned.append(val.strip())
        cleaned_rows.append(cleaned)

    if dry_run:
        print(f"  {table_name}: {row_count} rows ({csv_path.name})")
        return row_count

    # Create table
    col_defs = ", ".join(f'"{h}" TEXT' for h in headers)
    cursor.execute(f"CREATE TABLE IF NOT EXISTS {table_name} ({col_defs})")

    # Duplicate guard
    cursor.execute(f"SELECT COUNT(*) FROM {table_name}")
    existing = cursor.fetchone()[0]
    if existing > 0:
        print(f"  {table_name}: SKIP (already has {existing} rows)")
        return existing

    # Insert rows
    placeholders = ", ".join(["?"] * len(headers))
    cursor.executemany(
        f"INSERT INTO {table_name} VALUES ({placeholders})",
        cleaned_rows
    )

    print(f"  {table_name}: {row_count} rows inserted ({csv_path.name})")
    return row_count


def main():
    parser = argparse.ArgumentParser(description="Loader for PIR #2502592")
    parser.add_argument("--dry-run", action="store_true", help="Print row counts only")
    parser.add_argument("--commit", action="store_true", help="Commit to database")
    args = parser.parse_args()

    holding_dir = get_holding_dir()
    db_path = get_db_path()

    csv_files = [
        ("PRU_11507_21.csv", "research_pir2502592_2020_21"),
        ("PRU_11507_22.csv", "research_pir2502592_2021_22"),
        ("PRU_11507_23.csv", "research_pir2502592_2022_23"),
        ("PRU_11507_24.csv", "research_pir2502592_2023_24"),
        ("PRU_11507_25.csv", "research_pir2502592_2024_25"),
    ]

    print(f"PIR #2502592 Loader")
    print(f"  Holding dir: {holding_dir}")
    print(f"  DB path: {db_path}")
    print(f"  Mode: {'dry-run' if args.dry_run or not args.commit else 'commit'}")
    print()

    total_rows = 0
    for csv_name, table_name in csv_files:
        csv_path = holding_dir / csv_name
        if not csv_path.exists():
            print(f"  SKIP {csv_name}: file not found")
            continue
        count = load_csv_to_table(
            sqlite3.connect(db_path).cursor(),
            sqlite3.connect(db_path),
            csv_path, table_name,
            dry_run=args.dry_run or not args.commit
        )
        total_rows += count

    print(f"\nTotal: {total_rows} rows across {len(csv_files)} tables")

    if args.commit:
        sqlite3.connect(db_path).commit()
        print("\nCOMMIT COMPLETE")
    else:
        print("\nDRY-RUN (no changes made)")


if __name__ == "__main__":
    main()

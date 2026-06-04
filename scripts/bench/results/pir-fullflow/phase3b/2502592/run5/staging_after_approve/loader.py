#!/usr/bin/env python3
"""
Loader for PIR #2502592 — PEIMS Pregnancy Related Services Data.
Reads 5 CSV files (2020-21 through 2024-25) and loads into tea_data.db.
"""

import csv
import json
import os
import sqlite3
import sys

HOLDING_DIR = os.environ.get("PIR_HOLDING_DIR", "/home/kh0pp/spring-2026/insd-5941/sources/pir-incoming/2502592")
TEA_DB = os.path.expanduser("~/spring-2026/texas-gov-data-mcp/data/tea_data.db")
PIR_NUMBER = "2502592"

# CSV files mapped to their school year
CSV_FILES = [
    ("PRU_11507_21.csv", "2020-2021"),
    ("PRU_11507_22.csv", "2021-2022"),
    ("PRU_11507_23.csv", "2022-2023"),
    ("PRU_11507_24.csv", "2023-2024"),
    ("PRU_11507_25.csv", "2024-2025"),
]

TABLE_NAME = f"research_pir{PIR_NUMBER}_pregnancy_services"
COLUMNS = ["YEAR", "DISTRICT", "DISTNAME", "PREGNANT_CTE_STUDENTS", "SINGLEPAR_CTE_STUDENTS", "ELIG_PREG_REL_SVCS_DAYS"]
COLUMN_TYPES = {
    "YEAR": "TEXT",
    "DISTRICT": "TEXT",
    "DISTNAME": "TEXT",
    "PREGNANT_CTE_STUDENTS": "INTEGER",
    "SINGLEPAR_CTE_STUDENTS": "INTEGER",
    "ELIG_PREG_REL_SVCS_DAYS": "REAL",
}


def create_table(cur):
    col_defs = ", ".join(f'"{c}" {COLUMN_TYPES[c]}' for c in COLUMNS)
    cur.execute(f"CREATE TABLE IF NOT EXISTS \"{TABLE_NAME}\" ({col_defs})")


def convert_value(val, col_type):
    """Convert CSV string to Python value, handling -999 FERPA masking."""
    if val is None or val.strip() == "":
        return None
    val = val.strip()
    if val == "-999":
        return None
    if col_type == "INTEGER":
        try:
            return int(val)
        except (ValueError, TypeError):
            return None
    elif col_type == "REAL":
        try:
            return float(val)
        except (ValueError, TypeError):
            return None
    return val


def load_csv(cur, filepath, year):
    """Load a single CSV file into the database."""
    row_count = 0
    with open(filepath, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            values = []
            for col in COLUMNS:
                raw = row.get(col, "")
                converted = convert_value(raw, COLUMN_TYPES[col])
                values.append(converted)
            placeholders = ", ".join("?" for _ in COLUMNS)
            col_names = ", ".join(f'"{c}"' for c in COLUMNS)
            cur.execute(
                f'INSERT INTO "{TABLE_NAME}" ({col_names}) VALUES ({placeholders})',
                values,
            )
            row_count += 1
    return row_count


def dry_run():
    """Print row counts per CSV without loading."""
    results = {}
    total = 0
    for filename, year in CSV_FILES:
        filepath = os.path.join(HOLDING_DIR, filename)
        if not os.path.exists(filepath):
            print(f"WARNING: {filename} not found in {HOLDING_DIR}", file=sys.stderr)
            results[filename] = 0
            continue
        count = 0
        with open(filepath, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for _ in reader:
                count += 1
        results[year] = count
        total += count
        print(f"  {filename} ({year}): {count} rows")
    print(f"  TOTAL: {total} rows")
    return results, total


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Load PIR #2502592 CSV data into tea_data.db")
    parser.add_argument("--dry-run", action="store_true", help="Print row counts without loading")
    parser.add_argument("--commit", action="store_true", help="Commit data to tea_data.db")
    args = parser.parse_args()

    if args.dry_run:
        print("DRY RUN — row counts:")
        results, total = dry_run()
        # Write row_counts.json to same directory as loader.py
        staging = os.path.join(os.path.dirname(os.path.abspath(__file__)), "row_counts.json")
        with open(staging, "w") as f:
            json.dump({"rows": results, "total": total, "pir_number": PIR_NUMBER}, f, indent=2)
        print(f"\nRow counts written to {staging}")
        return

    if not args.commit:
        print("Usage: loader.py [--dry-run | --commit]")
        sys.exit(1)

    # COMMIT mode
    print(f"Connecting to {TEA_DB}")
    conn = sqlite3.connect(TEA_DB)
    cur = conn.cursor()

    create_table(cur)

    # Check if table already exists with data (duplicate guard)
    cur.execute(f"SELECT COUNT(*) FROM \"{TABLE_NAME}\"")
    existing = cur.fetchone()[0]
    if existing > 0:
        print(f"Table {TABLE_NAME} already has {existing} rows. Skipping (duplicate guard).")
        conn.close()
        return

    total = 0
    for filename, year in CSV_FILES:
        filepath = os.path.join(HOLDING_DIR, filename)
        if not os.path.exists(filepath):
            print(f"WARNING: {filename} not found, skipping", file=sys.stderr)
            continue
        count = load_csv(cur, filepath, year)
        total += count
        print(f"  Loaded {filename} ({year}): {count} rows")

    conn.commit()
    print(f"\nCOMMIT COMPLETE: {total} rows inserted into {TABLE_NAME}")
    conn.close()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Loader for PIR #2502592 — TEA Pregnancy/Parenting PEIMS Data
Loads 5 CSV files into tea_data.db as separate year-typed tables.

Usage:
    python3 loader.py --commit    # Load data into DB
    python3 loader.py --dry-run   # Print row counts only
"""

import argparse
import csv
import os
import sqlite3
import sys

# Database path — default to real DB, env override for test harnesses
TEA_DB = os.environ.get("TEA_DB", os.path.expanduser("~/spring-2026/texas-gov-data-mcp/data/tea_data.db"))

# Holding directory (CSVs live here)
HOLDING_DIR = os.path.dirname(os.path.abspath(__file__))  # _staging/2502592/
# Go up to pir-incoming/2502592/
HOLDING_DIR = os.path.normpath(os.path.join(HOLDING_DIR, "..", "..", "pir-incoming", "2502592"))

PIR_NUMBER = "2502592"

# Table definitions: (year_suffix, csv_filename)
TABLES = [
    ("21", "PRU_11507_21.csv"),
    ("22", "PRU_11507_22.csv"),
    ("23", "PRU_11507_23.csv"),
    ("24", "PRU_11507_24.csv"),
    ("25", "PRU_11507_25.csv"),
]


def create_table(conn, table_name):
    """Create the table if it doesn't exist."""
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {table_name} (
            YEAR TEXT,
            DISTRICT TEXT,
            DISTNAME TEXT,
            PREGNANT_CTE_STUDENTS INTEGER,
            SINGLEPAR_CTE_STUDENTS INTEGER,
            ELIG_PREG_REL_SVCS_DAYS REAL
        )
    """)
    conn.commit()


def has_rows(conn, table_name):
    """Check if a table already has data (duplicate guard)."""
    try:
        row = conn.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()
        return row[0] > 0
    except sqlite3.OperationalError:
        return False


def convert_row(row):
    """Convert -999 to NULL for numeric fields (FERPA masking)."""
    result = {}
    for key, val in row.items():
        if key in ("PREGNANT_CTE_STUDENTS", "SINGLEPAR_CTE_STUDENTS"):
            if val == "-999":
                result[key] = None
            else:
                try:
                    result[key] = int(val)
                except (ValueError, TypeError):
                    result[key] = None
        elif key == "ELIG_PREG_REL_SVCS_DAYS":
            if val == "-999":
                result[key] = None
            else:
                try:
                    result[key] = float(val)
                except (ValueError, TypeError):
                    result[key] = None
        else:
            result[key] = val.strip() if val else val
    return result


def load_csv(conn, table_name, csv_filename):
    """Load a single CSV file into the given table."""
    csv_path = os.path.join(HOLDING_DIR, csv_filename)
    if not os.path.exists(csv_path):
        print(f"WARNING: {csv_path} not found, skipping.")
        return 0

    if has_rows(conn, table_name):
        print(f"SKIP: {table_name} already has rows, skipping.")
        return 0

    print(f"Loading {csv_filename} -> {table_name}...")
    count = 0
    with open(csv_path, "r", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            converted = convert_row(row)
            placeholders = ", ".join(["?"] * len(converted))
            columns = ", ".join(converted.keys())
            values = list(converted.values())
            conn.execute(
                f"INSERT INTO {table_name} ({columns}) VALUES ({placeholders})",
                values
            )
            count += 1

    conn.commit()
    print(f"  Inserted {count} rows into {table_name}.")
    return count


def main():
    parser = argparse.ArgumentParser(description="Load PIR #2502592 PEIMS data into tea_data.db")
    parser.add_argument("--commit", action="store_true", help="Actually commit to DB")
    parser.add_argument("--dry-run", action="store_true", help="Print row counts without committing")
    args = parser.parse_args()

    if not args.commit and not args.dry_run:
        print("Usage: loader.py --commit | --dry-run")
        sys.exit(1)

    conn = sqlite3.connect(TEA_DB)

    total_rows = 0

    for year_suffix, csv_filename in TABLES:
        table_name = f"research_pir{PIR_NUMBER}_{year_suffix}"
        create_table(conn, table_name)

        if args.dry_run:
            csv_path = os.path.join(HOLDING_DIR, csv_filename)
            if os.path.exists(csv_path):
                with open(csv_path, "r") as f:
                    row_count = sum(1 for _ in f) - 1  # subtract header
                print(f"DRY RUN: {table_name}: {row_count} rows (from {csv_filename})")
                total_rows += row_count
            else:
                print(f"DRY RUN: {table_name}: FILE NOT FOUND")
        else:
            n = load_csv(conn, table_name, csv_filename)
            total_rows += n

    if args.dry_run:
        print(f"\nDRY RUN TOTAL: {total_rows} rows across {len(TABLES)} tables.")
    else:
        print(f"\nCOMMIT COMPLETE: {total_rows} rows loaded across {len(TABLES)} tables.")
        for year_suffix, csv_filename in TABLES:
            table_name = f"research_pir{PIR_NUMBER}_{year_suffix}"
            count = conn.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()[0]
            print(f"  {table_name}: {count} rows verified.")

    conn.close()


if __name__ == "__main__":
    main()

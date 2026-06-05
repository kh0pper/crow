#!/usr/bin/env python3
"""
Loader for PIR #2502592 — TEA Pregnancy/Parenting PEIMS Data (2020-25)

Loads 5 year-segmented CSVs into tea_data.db, one table per file.
Tables named: research_pir2502592_PRU_11507_21 through 25

Usage:
  python3 loader.py --dry-run   # print row counts (default)
  python3 loader.py --commit    # load and commit
"""
import argparse
import csv
import os
import sqlite3
import sys

HOLDING_DIR = os.environ.get(
    "PIR_HOLDING_DIR",
    "/home/kh0pp/spring-2026/insd-5941/sources/pir-incoming/2502592"
)
TEA_DB = os.environ.get(
    "TEA_DB",
    os.path.expanduser("~/spring-2026/texas-gov-data-mcp/data/tea_data.db")
)

FILES = [
    ("PRU_11507_21.csv", "research_pir2502592_PRU_11507_21", "2020-2021"),
    ("PRU_11507_22.csv", "research_pir2502592_PRU_11507_22", "2021-2022"),
    ("PRU_11507_23.csv", "research_pir2502592_PRU_11507_23", "2022-2023"),
    ("PRU_11507_24.csv", "research_pir2502592_PRU_11507_24", "2023-2024"),
    ("PRU_11507_25.csv", "research_pir2502592_PRU_11507_25", "2024-2025"),
]

COLUMNS = [
    "YEAR",
    "DISTRICT",
    "DISTNAME",
    "PREGNANT_CTE_STUDENTS",
    "SINGLEPAR_CTE_STUDENTS",
    "ELIG_PREG_REL_SVCS_DAYS",
]


def count_rows(filepath):
    """Count data rows (excluding header)."""
    with open(filepath, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        next(reader)  # skip header
        return sum(1 for _ in reader)


def load_table(conn, filepath, table_name, dry_run=False):
    """Load a CSV into the target table, converting -999 to NULL."""
    cur = conn.cursor()

    # Duplicate guard
    cur.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", (table_name,))
    if cur.fetchone()[0]:
        cur.execute(f"SELECT COUNT(*) FROM [{table_name}]")
        existing = cur.fetchone()[0]
        if existing > 0:
            print(f"  SKIP {table_name}: already has {existing} rows")
            return existing

    # Create table
    col_defs = ", ".join(f"[{c}] TEXT" for c in COLUMNS)
    cur.execute(f"CREATE TABLE IF NOT EXISTS [{table_name}] ({col_defs})")

    if dry_run:
        rows = count_rows(filepath)
        print(f"  DRY-RUN {table_name}: {rows} rows (not loaded)")
        return rows

    # Insert data
    insert_sql = f"INSERT INTO [{table_name}] ({', '.join(f'[{c}]' for c in COLUMNS)}) VALUES ({', '.join('?' for _ in COLUMNS)})"
    with open(filepath, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        next(reader)  # skip header
        rows_inserted = 0
        for row in reader:
            converted = []
            for val in row:
                if val == "-999":
                    converted.append(None)
                else:
                    converted.append(val)
            cur.execute(insert_sql, converted)
            rows_inserted += 1

    print(f"  LOADED {table_name}: {rows_inserted} rows")
    return rows_inserted


def main():
    parser = argparse.ArgumentParser(description="Load PIR #2502592 CSVs into tea_data.db")
    parser.add_argument("--commit", action="store_true", help="Actually insert rows (default: dry-run)")
    parser.add_argument("--dry-run", action="store_true", help="Print row counts only")
    args = parser.parse_args()

    dry_run = args.commit is False and not args.dry_run

    print(f"TEA_DB: {TEA_DB}")
    print(f"HOLDING_DIR: {HOLDING_DIR}")
    print(f"Mode: {'DRY-RUN' if dry_run else 'COMMIT'}")
    print()

    conn = sqlite3.connect(TEA_DB)
    total = 0

    for filename, table_name, year in FILES:
        filepath = os.path.join(HOLDING_DIR, filename)
        if not os.path.exists(filepath):
            print(f"  MISSING {filename}")
            continue
        rows = load_table(conn, filepath, table_name, dry_run=dry_run)
        total += rows

    print(f"\nTotal rows: {total}")

    if not dry_run:
        conn.commit()
        print("\nCOMMIT COMPLETE")

    conn.close()


if __name__ == "__main__":
    main()

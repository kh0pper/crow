#!/usr/bin/env python3
"""
Loader for PIR #2502592 — TEA Pregnancy/Parenting PEIMS Data
Reads 5 CSV files (PRU_11507_21 through 25) and loads into tea_data.db.

Table naming: research_pir<pir_number>_<dataset>
  e.g., research_pir2502592_2020_21

Usage:
  python3 loader.py --dry-run   (print row counts, do not write)
  python3 loader.py --commit    (load data into DB)
"""

import argparse
import csv
import os
import sqlite3
import sys
import glob

TEA_DB = os.environ.get("TEA_DB", os.path.expanduser("~/spring-2026/texas-gov-data-mcp/data/tea_data.db"))
PIR_NUMBER = "2502592"
# CSVs live in pir-incoming/<pir_number>/, staging is under _staging/<pir_number>/
HOLDING_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "pir-incoming", PIR_NUMBER)

CSV_FILES = [
    ("PRU_11507_21.csv", "research_pir2502592_2020_21"),
    ("PRU_11507_22.csv", "research_pir2502592_2021_22"),
    ("PRU_11507_23.csv", "research_pir2502592_2022_23"),
    ("PRU_11507_24.csv", "research_pir2502592_2023_24"),
    ("PRU_11507_25.csv", "research_pir2502592_2024_25"),
]

COLUMNS = ["YEAR", "DISTRICT", "DISTNAME", "PREGNANT_CTE_STUDENTS", "SINGLEPAR_CTE_STUDENTS", "ELIG_PREG_REL_SVCS_DAYS"]
COL_TYPES = {
    "YEAR": "TEXT",
    "DISTRICT": "TEXT",
    "DISTNAME": "TEXT",
    "PREGNANT_CTE_STUDENTS": "INTEGER",
    "SINGLEPAR_CTE_STUDENTS": "INTEGER",
    "ELIG_PREG_REL_SVCS_DAYS": "REAL",
}


def build_create_table_sql(table_name):
    col_defs = ", ".join(f"{c} {COL_TYPES[c]}" for c in COLUMNS)
    return f"CREATE TABLE IF NOT EXISTS {table_name} ({col_defs})"


def convert_row(row):
    """Convert -999 to None (NULL) for FERPA masking."""
    converted = {}
    for key, val in row.items():
        if key in ("PREGNANT_CTE_STUDENTS", "SINGLEPAR_CTE_STUDENTS", "ELIG_PREG_REL_SVCS_DAYS"):
            try:
                numeric = float(val) if val else None
                if numeric is not None and numeric == -999:
                    converted[key] = None
                else:
                    converted[key] = numeric
            except (ValueError, TypeError):
                converted[key] = None
        else:
            converted[key] = val
    return converted


def read_csv_rows(filepath):
    """Read CSV file and return list of converted row dicts."""
    rows = []
    with open(filepath, "r", newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(convert_row(row))
    return rows


def check_table_exists(conn, table_name):
    """Check if table exists and has rows."""
    cur = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table_name,))
    if not cur.fetchone():
        return False
    cur = conn.execute(f"SELECT COUNT(*) FROM {table_name}")
    return cur.fetchone()[0] > 0


def load_table(conn, table_name, rows):
    """Insert rows into table, skipping -999 values as NULL."""
    placeholders = ", ".join(["?"] * len(COLUMNS))
    col_list = ", ".join(COLUMNS)
    sql = f"INSERT INTO {table_name} ({col_list}) VALUES ({placeholders})"
    vals = []
    for row in rows:
        vals.append([row.get(c) for c in COLUMNS])
    conn.executemany(sql, vals)


def main():
    parser = argparse.ArgumentParser(description="Load PIR #2502592 CSV data into tea_data.db")
    parser.add_argument("--dry-run", action="store_true", help="Print row counts without writing")
    parser.add_argument("--commit", action="store_true", help="Load data into DB")
    args = parser.parse_args()

    if not args.dry_run and not args.commit:
        print("ERROR: Specify --dry-run or --commit", file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(TEA_DB)

    total_rows = 0
    results = {}

    for csv_file, table_name in CSV_FILES:
        filepath = os.path.join(HOLDING_DIR, csv_file)
        if not os.path.exists(filepath):
            print(f"WARNING: {filepath} not found, skipping", file=sys.stderr)
            results[table_name] = {"file": csv_file, "status": "missing", "rows": 0}
            continue

        rows = read_csv_rows(filepath)

        if args.dry_run:
            print(f"  {csv_file} -> {table_name}: {len(rows)} data rows")
            results[table_name] = {"file": csv_file, "status": "dry-run", "rows": len(rows)}
            total_rows += len(rows)
        elif args.commit:
            exists = check_table_exists(conn, table_name)
            if exists:
                print(f"  {csv_file} -> {table_name}: table exists with rows, SKIP (duplicate guard)")
                results[table_name] = {"file": csv_file, "status": "skipped-duplicate", "rows": 0}
                continue
            conn.execute(build_create_table_sql(table_name))
            load_table(conn, table_name, rows)
            conn.commit()
            print(f"  {csv_file} -> {table_name}: loaded {len(rows)} rows")
            results[table_name] = {"file": csv_file, "status": "loaded", "rows": len(rows)}
            total_rows += len(rows)

    if args.dry_run:
        print(f"\nTotal data rows: {total_rows}")
        print("COMMIT complete (dry-run)")
    elif args.commit:
        print(f"\nTotal rows loaded: {total_rows}")
        print("COMMIT complete")

    conn.close()


if __name__ == "__main__":
    main()

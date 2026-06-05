#!/usr/bin/env python3
import os as _ff_os  # __FF_TEA_REDIRECT__
_ff_os.environ["TEA_DB"] = "/home/kh0pp/crow/scripts/bench/results/pir-fullflow/_sandbox/tea_2502803_scale_1.db"
"""Loader for PIR #2502803 — TEA Pregnancy/Parenting PEIMS (2016-20).

Reads CSV files from the holding directory and loads into tea_data.db.
Table name: research_pir2502803_<dataset>

Usage:
  python3 loader.py --dry-run   # print row counts
  python3 loader.py --commit    # commit to DB
"""

import argparse
import csv
import os
import sqlite3
import sys
import glob

TEA_DB = os.environ.get("TEA_DB", os.path.expanduser("~/spring-2026/texas-gov-data-mcp/data/tea_data.db"))

HOLDING_DIR = os.path.dirname(os.path.abspath(__file__))  # staging dir
# Look for CSV files in the corresponding pir-incoming directory
# staging path: .../sources/_staging/<pir_number>/
# pir-incoming path: .../sources/pir-incoming/<pir_number>/
pir_number = os.path.basename(HOLDING_DIR)
for parent in [os.path.join(HOLDING_DIR, "..", "..", "pir-incoming", pir_number)]:
    parent = os.path.normpath(parent)
    if os.path.isdir(parent):
        holding = parent
        break
else:
    holding = HOLDING_DIR

CSV_FILES = sorted(glob.glob(os.path.join(holding, "PRU_11576_*.csv")))

if not CSV_FILES:
    print("ERROR: No PRU_11576_*.csv files found in holding directory.", file=sys.stderr)
    sys.exit(1)

def parse_csv(filepath):
    """Parse a CSV file and return (header, rows)."""
    rows = []
    with open(filepath, newline='') as f:
        reader = csv.reader(f)
        header = next(reader)
        for row in reader:
            if len(row) == len(header):
                rows.append(row)
    return header, rows

def year_from_filename(filename):
    """Extract year from filename, e.g. PRU_11576_17.csv -> 2016-2017."""
    base = os.path.basename(filename)
    num = base.replace("PRU_11576_", "").replace(".csv", "")
    year_map = {"17": "2016-2017", "18": "2017-2018", "19": "2018-2019", "20": "2019-2020"}
    return year_map.get(num, num)

def convert_row(row):
    """Convert -999 to NULL for integer columns."""
    result = []
    for i, val in enumerate(row):
        if val == "-999":
            result.append(None)
        else:
            result.append(val)
    return result

def main():
    parser = argparse.ArgumentParser(description="Load PIR #2502803 data into tea_data.db")
    parser.add_argument("--dry-run", action="store_true", help="Print row counts without loading")
    parser.add_argument("--commit", action="store_true", help="Commit to DB")
    args = parser.parse_args()

    # Collect all data from all CSVs
    all_rows = []
    header = None
    table_rows = {}

    for filepath in CSV_FILES:
        fname = os.path.basename(filepath)
        year = year_from_filename(fname)
        h, rows = parse_csv(filepath)
        if header is None:
            header = h
        # Tag each row with its source year for reference
        for row in rows:
            row_with_year = [year] + row  # prepend year from filename for clarity
            table_rows.setdefault(fname, []).append(row_with_year)
            all_rows.append(row)

    # Table: research_pir2502803_pregnancy_services
    table_name = "research_pir2502803_pregnancy_services"
    db_columns = ["YEAR", "DISTRICT", "DISTNAME", "PREGNANT_CTE_STUDENTS",
                  "SINGLEPAR_CTE_STUDENTS", "ELIG_PREG_REL_SVCS_DAYS"]

    total_rows = len(all_rows)

    if args.dry_run:
        print(f"=== DRY RUN: PIR #2502803 ===")
        print(f"Table: {table_name}")
        print(f"CSV files: {len(CSV_FILES)}")
        for fname, rows in table_rows.items():
            print(f"  {fname}: {len(rows)} rows (year={year_from_filename(fname)})")
        print(f"Total data rows: {total_rows}")
        # Count masked values
        masked_p = sum(1 for r in all_rows if r[3] == "-999")
        masked_s = sum(1 for r in all_rows if r[4] == "-999")
        print(f"Masked PREGNANT_CTE_STUDENTS (-999): {masked_p}")
        print(f"Masked SINGLEPAR_CTE_STUDENTS (-999): {masked_s}")
        print(f"Columns: {', '.join(db_columns)}")
        return

    if args.commit:
        # Check if table already has rows (duplicate guard)
        conn = sqlite3.connect(TEA_DB)
        cursor = conn.cursor()

        # Check if table exists and has data
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table_name,))
        if cursor.fetchone():
            cursor.execute(f"SELECT COUNT(*) FROM {table_name}")
            existing = cursor.fetchone()[0]
            if existing > 0:
                print(f"Table {table_name} already has {existing} rows. Skipping duplicate load.")
                conn.close()
                return

        # Create table
        col_defs = ", ".join(f"{c} TEXT" for c in db_columns)
        cursor.execute(f"CREATE TABLE IF NOT EXISTS {table_name} ({col_defs})")

        # Insert rows with -999 → NULL conversion
        placeholders = ", ".join(["?"] * len(db_columns))
        insert_sql = f"INSERT INTO {table_name} VALUES ({placeholders})"
        converted = [convert_row(r) for r in all_rows]
        cursor.executemany(insert_sql, converted)
        conn.commit()

        committed = cursor.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()[0]
        print(f"COMMIT COMPLETE: {committed} rows in {table_name}")
        conn.close()
    else:
        print("No action specified. Use --dry-run or --commit.")
        sys.exit(1)

if __name__ == "__main__":
    main()

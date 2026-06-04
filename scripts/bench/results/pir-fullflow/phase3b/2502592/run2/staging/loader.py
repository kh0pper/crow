#!/usr/bin/env python3
"""Load PIR #2502592 CSV data into tea_data.db.

Targets: research_pir2502592_<dataset> tables.
Supports --dry-run and --commit modes.
Converts -999 to NULL (FERPA masking).
Skips if table already has rows (duplicate guard).
"""

import csv
import json
import os
import shutil
import sqlite3
import sys
import zipfile
from pathlib import Path

TEA_DB = os.environ.get("TEA_DB", os.path.expanduser("~/spring-2026/texas-gov-data-mcp/data/tea_data.db"))

PIR_NUMBER = "2502592"
HOLDING_DIR = os.environ.get("HOLDING_DIR", "/home/kh0pp/spring-2026/insd-5941/sources/pir-incoming/2502592")
STAGING_DIR = os.environ.get("STAGING_DIR", f"/home/kh0pp/spring-2026/insd-5941/sources/_staging/{PIR_NUMBER}")
TABLE_PREFIX = f"research_pir{PIR_NUMBER}"

def get_args():
    args = sys.argv[1:]
    dry_run = "--dry-run" in args
    commit = "--commit" in args
    return dry_run, commit

def load_csv_file(db_conn, filepath, table_name, columns):
    """Load a CSV file into the given table. Returns row count."""
    cursor = db_conn.cursor()
    
    # Duplicate guard
    existing = cursor.execute(f"SELECT COUNT(*) FROM [{table_name}]").fetchone()[0]
    if existing > 0:
        print(f"  SKIP {table_name}: already has {existing} rows")
        return existing
    
    rows = []
    with open(filepath, "r", newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader)
        for row in reader:
            converted = []
            for i, val in enumerate(row):
                if val == "-999":
                    converted.append(None)
                else:
                    converted.append(val)
            rows.append(converted)
    
    placeholders = ", ".join(["?"] * len(columns))
    col_names = ", ".join(columns)
    insert_sql = f"INSERT INTO [{table_name}] ({col_names}) VALUES ({placeholders})"
    
    cursor.executemany(insert_sql, rows)
    db_conn.commit()
    
    print(f"  Loaded {len(rows)} rows into {table_name}")
    return len(rows)

def find_csv_files():
    """Find all CSV files in the holding directory."""
    csv_files = []
    for entry in sorted(os.listdir(HOLDING_DIR)):
        fpath = os.path.join(HOLDING_DIR, entry)
        if os.path.isfile(fpath) and entry.endswith(".csv"):
            csv_files.append(fpath)
    return csv_files

def main():
    dry_run, commit = get_args()
    
    if not commit and not dry_run:
        print("Usage: loader.py [--dry-run] [--commit]")
        sys.exit(1)
    
    print(f"TEA_DB: {TEA_DB}")
    print(f"HOLDING_DIR: {HOLDING_DIR}")
    print(f"Mode: {'DRY RUN' if dry_run else 'COMMIT'}")
    
    db_path = TEA_DB
    db_conn = sqlite3.connect(db_path)
    cursor = db_conn.cursor()
    
    csv_files = find_csv_files()
    print(f"\nFound {len(csv_files)} CSV files:")
    
    total_rows = 0
    table_counts = {}
    
    for filepath in csv_files:
        filename = os.path.basename(filepath)
        print(f"\nProcessing: {filename}")
        
        # Read header to get columns
        with open(filepath, "r", newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            columns = next(reader)
        
        # Determine year from filename (PRU_11507_21.csv -> 2020-21)
        year_suffix = filename.split("_")[-1].replace(".csv", "")
        year_map = {"21": "2020-2021", "22": "2021-2022", "23": "2022-2023", "24": "2023-2024", "25": "2024-2025"}
        year = year_map.get(year_suffix, year_suffix)
        
        table_name = f"{TABLE_PREFIX}_{year.replace('-', '')}"
        
        print(f"  Target table: {table_name} (year={year})")
        print(f"  Columns: {columns}")
        
        if dry_run:
            # Count rows without loading
            with open(filepath, "r", newline="", encoding="utf-8") as f:
                reader = csv.reader(f)
                next(reader)  # skip header
                count = sum(1 for _ in reader)
            print(f"  ROWS: {count}")
            table_counts[table_name] = count
            total_rows += count
        else:
            if commit:
                row_count = load_csv_file(db_conn, filepath, table_name, columns)
                table_counts[table_name] = row_count
                total_rows += row_count
            else:
                # Check without loading (dry run with duplicate guard)
                existing = cursor.execute(f"SELECT COUNT(*) FROM [{table_name}]").fetchone()[0]
                if existing > 0:
                    print(f"  SKIP: already has {existing} rows")
                    table_counts[table_name] = existing
                    total_rows += existing
                else:
                    with open(filepath, "r", newline="", encoding="utf-8") as f:
                        reader = csv.reader(f)
                        next(reader)
                        count = sum(1 for _ in reader)
                    print(f"  Would load {count} rows")
                    table_counts[table_name] = count
                    total_rows += count
    
    # Summary
    print(f"\n{'='*60}")
    print(f"TOTAL ROWS: {total_rows}")
    print(f"TABLES: {list(table_counts.keys())}")
    
    if dry_run:
        print("\nDry run complete. No data written.")
        # Write row_counts.json to staging
        rc_path = os.path.join(STAGING_DIR, "row_counts.json")
        with open(rc_path, "w") as f:
            json.dump(table_counts, f, indent=2)
        print(f"Row counts written to {rc_path}")
    elif commit:
        print("\nCOMMIT COMPLETE")
    else:
        print("\nNo action taken. Use --commit to load data.")
    
    db_conn.close()

if __name__ == "__main__":
    main()

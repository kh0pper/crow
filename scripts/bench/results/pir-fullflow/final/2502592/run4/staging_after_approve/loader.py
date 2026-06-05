#!/usr/bin/env python3
import os as _ff_os  # __FF_TEA_REDIRECT__
_ff_os.environ["TEA_DB"] = "/home/kh0pp/crow/scripts/bench/results/pir-fullflow/_sandbox/tea_2502592_final_4.db"
"""Loader for PIR #2502592 — District-Level Pregnancy Related Services Data (PEIMS).

Reads CSV files from the holding directory and loads into tea_data.db.
Supports --dry-run (print row counts) and --commit.

Table names: research_pir2502592_<dataset> (one per CSV file).
Converts -999 to NULL (FERPA masking).
Skips if table already has rows (duplicate guard).
"""

import csv
import hashlib
import json
import os
import sqlite3
import sys
import glob
import argparse


HOLDING_DIR = os.path.join(
    os.environ.get("PIR_HOLDING_DIR", os.path.expanduser(
        "~/spring-2026/insd-5941/sources/pir-incoming/2502592"))
)
TEA_DB = os.environ.get(
    "TEA_DB",
    os.path.expanduser("~/spring-2026/texas-gov-data-mcp/data/tea_data.db")
)
PIR_NUMBER = "2502592"


def get_csv_files():
    """Find all CSV files in the holding directory."""
    pattern = os.path.join(HOLDING_DIR, "*.csv")
    files = sorted(glob.glob(pattern))
    return files


def csv_columns_and_sample(filepath):
    """Read the header and first row to determine columns."""
    with open(filepath, "r", newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader)
        sample = next(reader, None)
    return header, sample


def clean_value(val):
    """Convert -999 to None (NULL for SQLite)."""
    if val is None:
        return None
    val = val.strip()
    if val == "-999":
        return None
    # Try numeric conversion
    try:
        return int(val)
    except ValueError:
        try:
            return float(val)
        except ValueError:
            return val


def load_csv_to_table(conn, filepath, table_name, columns):
    """Load a single CSV file into a SQLite table."""
    cursor = conn.cursor()

    # Check if table exists and has rows (duplicate guard)
    cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (table_name,)
    )
    if cursor.fetchone():
        cursor.execute(f"SELECT COUNT(*) FROM {table_name}")
        count = cursor.fetchone()[0]
        if count > 0:
            print(f"  SKIP {table_name}: already has {count} rows")
            return count

    # Create table
    col_defs = ", ".join(
        f'"{col}" TEXT' for col in columns
    )
    create_sql = f'CREATE TABLE IF NOT EXISTS "{table_name}" ({col_defs})'
    cursor.execute(create_sql)

    # Insert rows
    row_count = 0
    with open(filepath, "r", newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader)  # skip header
        for row in reader:
            cleaned = [clean_value(v) for v in row]
            placeholders = ", ".join(["?"] * len(columns))
            insert_sql = (
                f'INSERT INTO "{table_name}" ({", ".join(f'"{c}"' for c in columns)}) '
                f"VALUES ({placeholders})"
            )
            cursor.execute(insert_sql, cleaned)
            row_count += 1

    conn.commit()
    return row_count


def main():
    parser = argparse.ArgumentParser(description=f"Loader for PIR #{PIR_NUMBER}")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print row counts without loading")
    parser.add_argument("--commit", action="store_true",
                        help="Actually load data into the database")
    args = parser.parse_args()

    csv_files = get_csv_files()
    if not csv_files:
        print(f"No CSV files found in {HOLDING_DIR}")
        sys.exit(1)

    print(f"Found {len(csv_files)} CSV file(s) in {HOLDING_DIR}")
    print(f"Target DB: {TEA_DB}")
    print()

    row_counts = {}
    total_rows = 0

    for filepath in csv_files:
        filename = os.path.basename(filepath)
        # Dataset name from filename, e.g., PRU_11507_21 -> pru_11507_21
        dataset_name = filename.replace(".csv", "")
        table_name = f"research_pir{PIR_NUMBER}_{dataset_name}"

        columns, sample = csv_columns_and_sample(filepath)
        print(f"  {filename}: {len(columns)} columns")
        print(f"    Columns: {', '.join(columns)}")

        if args.dry_run or not args.commit:
            # Count rows without loading
            row_count = 0
            with open(filepath, "r", newline="", encoding="utf-8") as f:
                reader = csv.reader(f)
                next(reader)  # skip header
                for _ in reader:
                    row_count += 1
            row_counts[table_name] = row_count
            total_rows += row_count
            print(f"    Rows (dry-run): {row_count}")
        else:
            conn = sqlite3.connect(TEA_DB)
            count = load_csv_to_table(conn, filepath, table_name, columns)
            row_counts[table_name] = count
            total_rows += count
            conn.close()
            print(f"    Rows loaded: {count}")

    print()
    print(f"Total rows: {total_rows}")
    print(json.dumps(row_counts, indent=2))

    # Save row_counts.json for reference
    counts_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "row_counts.json"
    )
    with open(counts_path, "w") as f:
        json.dump(row_counts, f, indent=2)
    print(f"Row counts saved to {counts_path}")

    if args.commit:
        print("COMMIT COMPLETE")
    else:
        print("DRY RUN — no data loaded. Use --commit to load.")


if __name__ == "__main__":
    main()

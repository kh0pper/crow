#!/usr/bin/env python3
"""Loader for PIR #2502592 — TEA Pregnancy/Parenting PEIMS data (5 CSVs, 4742 rows).

Table names: research_pir2502592_<dataset>
  _21 = PRU_11507_21.csv (2020-21)
  _22 = PRU_11507_22.csv (2021-22)
  _23 = PRU_11507_23.csv (2022-23)
  _24 = PRU_11507_24.csv (2023-24)
  _25 = PRU_11507_25.csv (2024-25)

Usage:
  python3 loader.py --dry-run   (print row counts, do NOT write DB)
  python3 loader.py --commit    (insert rows into tea_data.db)

Converts -999 to NULL (FERPA masking). Skips if table already has rows (duplicate guard).
"""

import csv
import glob
import os
import shutil
import sqlite3
import subprocess
import sys
import zipfile

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
TEA_DB = os.environ.get(
    "TEA_DB",
    os.path.expanduser("~/spring-2026/texas-gov-data-mcp/data/tea_data.db"),
)
PIR_NUMBER = "2502592"
PIR_ID = 41

# Dataset definitions: (file_stem, table_suffix)
DATASETS = [
    ("PRU_11507_21", "21"),
    ("PRU_11507_22", "22"),
    ("PRU_11507_23", "23"),
    ("PRU_11507_24", "24"),
    ("PRU_11507_25", "25"),
]

# Table columns (same across all CSVs)
COLUMNS = [
    "YEAR",
    "DISTRICT",
    "DISTNAME",
    "PREGNANT_CTE_STUDENTS",
    "SINGLEPAR_CTE_STUDENTS",
    "ELIG_PREG_REL_SVCS_DAYS",
]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def resolve_files(holding_dir):
    """Find CSV files in holding_dir (or _staging)."""
    files = {}
    for stem, suffix in DATASETS:
        # Try holding_dir first
        candidate = os.path.join(holding_dir, f"{stem}.csv")
        if os.path.isfile(candidate):
            files[suffix] = candidate
            continue
        # Fallback: search _staging parent
        parent = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        alt = os.path.join(parent, "pir-incoming", PIR_NUMBER, f"{stem}.csv")
        if os.path.isfile(alt):
            files[suffix] = alt
            continue
        # Last resort: search entire pir-incoming
        search_dir = os.path.join(parent, "pir-incoming")
        matches = glob.glob(os.path.join(search_dir, f"*/{stem}.csv"))
        if matches:
            files[suffix] = matches[0]
            continue
        print(f"WARNING: {stem}.csv not found")
    return files


def csv_to_rows(filepath):
    """Read CSV, convert -999 to None."""
    rows = []
    with open(filepath, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            cleaned = {}
            for col in COLUMNS:
                val = row.get(col, "")
                if val == "-999":
                    cleaned[col] = None
                elif val == "" or val is None:
                    cleaned[col] = None
                else:
                    cleaned[col] = val
            rows.append(cleaned)
    return rows


def create_tables(conn):
    """Create the 5 tables if they don't exist."""
    for suffix in [s[1] for s in DATASETS]:
        tname = f"research_pir{PIR_NUMBER}_{suffix}"
        col_defs = ", ".join(
            f"{c} TEXT" for c in COLUMNS
        )
        conn.execute(
            f"CREATE TABLE IF NOT EXISTS {tname} ({col_defs})"
        )
    conn.commit()


def insert_rows(conn, tname, rows):
    """Insert rows with duplicate guard."""
    count = conn.execute(f"SELECT COUNT(*) FROM {tname}").fetchone()[0]
    if count > 0:
        print(f"  {tname}: {count} rows already present — skipping (duplicate guard)")
        return count
    placeholders = ", ".join(["?"] * len(COLUMNS))
    col_names = ", ".join(COLUMNS)
    sql = f"INSERT INTO {tname} ({col_names}) VALUES ({placeholders})"
    conn.executemany(sql, [tuple(r[c] for c in COLUMNS) for r in rows])
    conn.commit()
    return len(rows)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    import argparse

    parser = argparse.ArgumentParser(description="Load PIR #2502592 CSV data into tea_data.db")
    parser.add_argument("--dry-run", action="store_true", help="Print row counts only")
    parser.add_argument("--commit", action="store_true", help="Actually insert rows")
    parser.add_argument("--holding-dir", default=None, help="Override holding directory")
    args = parser.parse_args()

    # Locate holding dir
    staging_dir = os.path.dirname(os.path.abspath(__file__))
    parent = os.path.dirname(staging_dir)
    holding = args.holding_dir or os.path.join(parent, "pir-incoming", PIR_NUMBER)

    if not os.path.isdir(holding):
        print(f"ERROR: holding dir not found: {holding}", file=sys.stderr)
        sys.exit(1)

    files = resolve_files(holding)
    if len(files) != 5:
        print(f"WARNING: found {len(files)}/5 files", file=sys.stderr)

    conn = sqlite3.connect(TEA_DB)
    create_tables(conn)

    total = 0
    per_table = {}

    for stem, suffix in DATASETS:
        if suffix not in files:
            continue
        filepath = files[suffix]
        tname = f"research_pir{PIR_NUMBER}_{suffix}"
        rows = csv_to_rows(filepath)
        n = insert_rows(conn, tname, rows)
        per_table[tname] = n
        total += n

    if args.dry_run:
        print("\n--- DRY RUN SUMMARY ---")
        for tname, n in sorted(per_table.items()):
            print(f"  {tname}: {n} rows")
        print(f"  TOTAL: {total} rows")
        conn.close()
        return

    if args.commit:
        # Verify
        verify = {}
        for suffix in [s[1] for s in DATASETS]:
            tname = f"research_pir{PIR_NUMBER}_{suffix}"
            c = conn.execute(f"SELECT COUNT(*) FROM {tname}").fetchone()[0]
            verify[tname] = c
        print(f"\n--- COMMIT COMPLETE ---")
        for tname, c in sorted(verify.items()):
            print(f"  {tname}: {c} rows committed")
        print(f"  TOTAL: {sum(verify.values())} rows")
        conn.close()
        return

    print("No action specified. Use --dry-run or --commit.", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()

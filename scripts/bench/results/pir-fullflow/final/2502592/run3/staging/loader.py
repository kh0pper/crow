#!/usr/bin/env python3
"""Loader for PIR #2502592 — District-Level Pregnancy Related Services PEIMS Data.

Reads CSV files from the holding directory and loads into tea_data.db.
Run with --dry-run to preview, or --commit to write.
"""

import csv
import json
import os
import shutil
import sqlite3
import sys
import zipfile
from pathlib import Path

# --- Configuration ---
TEA_DB = os.environ.get("TEA_DB", os.path.expanduser("~/spring-2026/texas-gov-data-mcp/data/tea_data.db"))
PIR_NUMBER = "2502592"
HOLDING_DIR = os.environ.get("HOLDING_DIR", os.path.expanduser("~/spring-2026/insd-5941/sources/pir-incoming/2502592"))
STAGING_DIR = os.path.expanduser(f"~/spring-2026/insd-5941/sources/_staging/{PIR_NUMBER}")

# CSV files keyed by table name (matching PRU file numbering)
CSV_FILES = {
    "research_pir2502592_PRU_11507_21": "PRU_11507_21.csv",
    "research_pir2502592_PRU_11507_22": "PRU_11507_22.csv",
    "research_pir2502592_PRU_11507_23": "PRU_11507_23.csv",
    "research_pir2502592_PRU_11507_24": "PRU_11507_24.csv",
    "research_pir2502592_PRU_11507_25": "PRU_11507_25.csv",
}

CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS {table} (
    YEAR TEXT,
    DISTRICT TEXT,
    DISTNAME TEXT,
    PREGNANT_CTE_STUDENTS INTEGER,
    SINGLEPAR_CTE_STUDENTS INTEGER,
    ELIG_PREG_REL_SVCS_DAYS REAL
)
"""

COLUMNS = ["YEAR", "DISTRICT", "DISTNAME", "PREGNANT_CTE_STUDENTS", "SINGLEPAR_CTE_STUDENTS", "ELIG_PREG_REL_SVCS_DAYS"]
INSERT_SQL = "INSERT INTO {table} ({cols}) VALUES ({placeholders})".format(
    table="{table}",
    cols=", ".join(COLUMNS),
    placeholders=", ".join(["?"] * len(COLUMNS))
)


def check_table_exists(conn, table):
    """Check if table already has rows (duplicate guard)."""
    cur = conn.execute(f"SELECT COUNT(*) FROM {table}")
    return cur.fetchone()[0] > 0


def convert_row(row):
    """Convert CSV row, replacing -999 with None for masked values."""
    result = []
    for i, val in enumerate(row):
        if i >= 3 and val == "-999":
            result.append(None)
        else:
            result.append(val)
    return result


def load_csv(conn, table, csv_path, dry_run=False):
    """Load a single CSV file into the given table."""
    if not os.path.exists(csv_path):
        print(f"  SKIP: {csv_path} not found")
        return 0

    if check_table_exists(conn, table):
        print(f"  SKIP: {table} already has rows (duplicate guard)")
        return 0

    rows = []
    with open(csv_path, newline="") as fh:
        reader = csv.DictReader(fh)
        for r in reader:
            rows.append(convert_row([r[c] for c in COLUMNS]))

    if dry_run:
        print(f"  {table}: {len(rows)} rows (dry-run, not inserting)")
        return len(rows)

    conn.executemany(INSERT_SQL.format(table=table), rows)
    print(f"  {table}: {len(rows)} rows inserted")
    return len(rows)


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Loader for PIR #2502592")
    parser.add_argument("--dry-run", action="store_true", help="Count rows without inserting")
    parser.add_argument("--commit", action="store_true", help="Commit data to DB")
    parser.add_argument("--db", default=None, help="Override tea_data.db path")
    args = parser.parse_args()

    db_path = args.db or TEA_DB
    dry_run = args.dry_run or (not args.commit)
    print(f"TEA_DB: {db_path}")
    print(f"Mode: {'dry-run' if dry_run else 'commit'}")
    print(f"PIR: {PIR_NUMBER}")
    print(f"Holding dir: {HOLDING_DIR}")
    print()

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")

    total_rows = 0
    for table, filename in CSV_FILES.items():
        csv_path = os.path.join(HOLDING_DIR, filename)
        if dry_run:
            # Create table if needed to check for duplicates
            conn.execute(CREATE_TABLE_SQL.format(table=table))
        rows = load_csv(conn, table, csv_path, dry_run)
        total_rows += rows

    if not dry_run:
        conn.commit()
        print(f"\nCOMMIT COMPLETE. Total rows committed: {total_rows}")
    else:
        print(f"\nDRY RUN COMPLETE. Total rows: {total_rows}")

    # Write row_counts.json to staging
    counts = {}
    for table, filename in CSV_FILES.items():
        cur = conn.execute(f"SELECT COUNT(*) FROM {table}")
        counts[table] = cur.fetchone()[0]
    counts["total"] = sum(counts.values())
    os.makedirs(STAGING_DIR, exist_ok=True)
    with open(os.path.join(STAGING_DIR, "row_counts.json"), "w") as f:
        json.dump(counts, f, indent=2)
    print(f"row_counts.json written to {os.path.join(STAGING_DIR, 'row_counts.json')}")

    conn.close()


if __name__ == "__main__":
    main()

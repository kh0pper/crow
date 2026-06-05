#!/usr/bin/env python3
import os as _ff_os  # __FF_TEA_REDIRECT__
_ff_os.environ["TEA_DB"] = "/home/kh0pp/crow/scripts/bench/results/pir-fullflow/_sandbox/tea_2502803_scale_2.db"
"""Loader for PIR #2502803 — TEA Pregnancy/Parenting CTE PEIMS data (2016-17 through 2019-20).

Loads 4 CSV files into tea_data.db with FERPA masking conversion (-999 → NULL).
Table naming: research_pir2502803_pregnant_cte_<year> for each year's data.

Usage:
    python3 loader.py --dry-run    # print row counts only
    python3 loader.py --commit     # write to tea_data.db
"""

import argparse
import csv
import os
import sqlite3
import sys
import glob

TEA_DB = os.environ.get("TEA_DB", os.path.expanduser("~/spring-2026/texas-gov-data-mcp/data/tea_data.db"))
HOLDING_DIR = "/home/kh0pp/spring-2026/insd-5941/sources/pir-incoming/2502803"
STAGING_DIR = "/home/kh0pp/spring-2026/insd-5941/sources/_staging/2502803"

CSV_FILES = sorted(glob.glob(os.path.join(HOLDING_DIR, "PRU_11576_*.csv")))

TABLE_BASE = "research_pir2502803_pregnant_cte"

SCHEMA = """\
CREATE TABLE IF NOT EXISTS {table} (
    YEAR TEXT,
    DISTRICT TEXT,
    DISTNAME TEXT,
    PREGNANT_CTE_STUDENTS INTEGER,
    SINGLEPAR_CTE_STUDENTS INTEGER,
    ELIG_PREG_REL_SVCS_DAYS REAL
);
"""


def parse_year(filename):
    """Extract year suffix from filename like PRU_11576_17.csv → 2016-2017."""
    base = os.path.basename(filename).replace(".csv", "")
    suffix = base.split("_")[-1]
    year_map = {
        "17": "2016-2017",
        "18": "2017-2018",
        "19": "2018-2019",
        "20": "2019-2020",
    }
    return year_map.get(suffix, f"UNKNOWN-{suffix}")


def load_csv(filepath, table):
    """Load a single CSV file, converting -999 to NULL."""
    rows = []
    with open(filepath, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader)  # skip header
        for row in reader:
            converted = []
            for i, val in enumerate(row):
                if val.strip() == "-999":
                    converted.append(None)
                else:
                    converted.append(val.strip())
            rows.append(tuple(converted))
    return rows


def check_table_exists(conn, table):
    """Check if a table already has rows (duplicate guard)."""
    try:
        cur = conn.execute(f"SELECT COUNT(*) FROM {table}")
        return cur.fetchone()[0] > 0
    except sqlite3.OperationalError:
        return False


def dry_run():
    """Print row counts per file and total."""
    total = 0
    results = {}
    for fpath in CSV_FILES:
        rows = load_csv(fpath, TABLE_BASE)
        year = parse_year(fpath)
        table = f"{TABLE_BASE}_{year.replace('-', '')}"
        results[table] = len(rows)
        total += len(rows)
        print(f"  {os.path.basename(fpath)}: {len(rows)} rows → {table}")
    print(f"\nTotal: {total} rows across {len(CSV_FILES)} files")
    return results


def commit():
    """Load all CSVs into tea_data.db."""
    conn = sqlite3.connect(TEA_DB)
    conn.execute("PRAGMA journal_mode=WAL")
    total = 0
    for fpath in CSV_FILES:
        rows = load_csv(fpath, TABLE_BASE)
        year = parse_year(fpath)
        table = f"{TABLE_BASE}_{year.replace('-', '')}"

        # Create table
        conn.execute(SCHEMA.format(table=table))

        # Duplicate guard
        if check_table_exists(conn, table):
            print(f"  SKIP {table} (already has {conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]} rows)")
            continue

        # Insert
        placeholders = ",".join(["?"] * 6)
        sql = f"INSERT INTO {table} VALUES ({placeholders})"
        conn.executemany(sql, rows)
        conn.commit()
        total += len(rows)
        print(f"  LOADED {table}: {len(rows)} rows")

    conn.close()
    print(f"\nCOMMIT COMPLETE: {total} rows across {len(CSV_FILES)} tables")
    return total


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Load PIR #2502803 CSV data into tea_data.db")
    parser.add_argument("--dry-run", action="store_true", help="Print row counts without writing")
    parser.add_argument("--commit", action="store_true", help="Write to tea_data.db")
    args = parser.parse_args()

    if args.dry_run:
        results = dry_run()
        # Save row counts to JSON
        with open(os.path.join(STAGING_DIR, "row_counts.json"), "w") as f:
            import json
            json.dump(results, f, indent=2)
        print(f"\nSaved row_counts.json to {STAGING_DIR}/row_counts.json")
    elif args.commit:
        total = commit()
    else:
        parser.print_help()
        sys.exit(1)

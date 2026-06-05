#!/usr/bin/env python3
"""
Loader for PIR #2502592 — TEA Pregnancy/Parenting PEIMS Data.

Reads CSV files from the holding directory and loads them into tea_data.db
under table names: research_pir<pir_number>_<dataset>.

Usage:
    python3 loader.py --dry-run   # Print row counts (default)
    python3 loader.py --commit    # Load data into database
"""
import csv
import glob
import hashlib
import json
import os
import shutil
import sqlite3
import sys

# --- Configuration ---
TEA_DB_PATH = os.environ.get("TEA_DB", os.path.expanduser("~/spring-2026/texas-gov-data-mcp/data/tea_data.db"))
HOLDING_DIR = os.environ.get("HOLDING_DIR", "/home/kh0pp/spring-2026/insd-5941/sources/pir-incoming/2502592")
PIR_NUMBER = "2502592"
STAGING_DIR = os.environ.get("STAGING_DIR", os.path.expanduser("~/spring-2026/insd-5941/sources/_staging/2502592"))

CSV_FILES = [
    ("PRU_11507_21.csv", "2020-2021"),
    ("PRU_11507_22.csv", "2021-2022"),
    ("PRU_11507_23.csv", "2022-2023"),
    ("PRU_11507_24.csv", "2023-2024"),
    ("PRU_11507_25.csv", "2024-2025"),
]

COLUMN_TYPES = {
    "YEAR": "TEXT",
    "DISTRICT": "TEXT",
    "DISTNAME": "TEXT",
    "PREGNANT_CTE_STUDENTS": "INTEGER",
    "SINGLEPAR_CTE_STUDENTS": "INTEGER",
    "ELIG_PREG_REL_SVCS_DAYS": "REAL",
}


def normalize_value(col_name, value):
    """Convert CSV string values to proper types. Convert -999 to NULL (FERPA masking)."""
    if value is None or value.strip() == "":
        return None
    col_type = COLUMN_TYPES.get(col_name, "TEXT")
    if col_type == "INTEGER":
        try:
            v = int(value)
            return None if v == -999 else v
        except (ValueError, TypeError):
            return None
    elif col_type == "REAL":
        try:
            v = float(value)
            return None if v == -999 else v
        except (ValueError, TypeError):
            return None
    else:
        return value.strip() if value else None


def make_table_name(base_name):
    """Create the target table name: research_pir<pir_number>_<dataset>"""
    return f"research_pir{PIR_NUMBER}_{base_name}"


def create_table(conn, table_name):
    """Create the target table if it does not exist."""
    col_defs = ", ".join(
        f'"{k}" {COLUMN_TYPES[k]}' for k in COLUMN_TYPES
    )
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS "{table_name}" (
            "{col_defs}",
            _source_file TEXT,
            _loaded_at TEXT DEFAULT (datetime('now'))
        )
    """)
    conn.commit()


def check_duplicate_guard(conn, table_name):
    """Skip loading if table already has rows."""
    try:
        row_count = conn.execute(f'SELECT COUNT(*) FROM "{table_name}"').fetchone()[0]
        if row_count > 0:
            print(f"[DUPLICATE GUARD] Table '{table_name}' already has {row_count} rows. Skipping.")
            return False
        return True
    except sqlite3.OperationalError:
        # Table doesn't exist yet — create_table will handle it
        return True


def load_csv_file(conn, filename, year_range, dry_run=False):
    """Load a single CSV file into the database."""
    csv_path = os.path.join(HOLDING_DIR, filename)
    base_name = filename.replace(".csv", "")
    table_name = make_table_name(base_name)

    if not os.path.exists(csv_path):
        print(f"[SKIP] {filename} not found at {csv_path}")
        return 0

    # Check duplicate guard
    if not dry_run:
        if not check_duplicate_guard(conn, table_name):
            return 0

    if not dry_run:
        create_table(conn, table_name)

    rows = 0
    with open(csv_path, "r", newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        for row in reader:
            if dry_run:
                rows += 1
                continue
            values = [normalize_value(col, row.get(col)) for col in fieldnames]
            values.append(filename)  # _source_file
            placeholders = ", ".join(["?"] * len(fieldnames))
            col_names = ", ".join(f'"{c}"' for c in fieldnames)
            insert_sql = f'INSERT INTO "{table_name}" ({col_names}, _source_file) VALUES ({placeholders}, ?)'
            conn.execute(insert_sql, values + [filename])
            rows += 1

    if not dry_run:
        conn.commit()

    return rows


def main():
    dry_run = "--dry-run" in sys.argv
    commit = "--commit" in sys.argv

    if dry_run and commit:
        print("[ERROR] Use --dry-run OR --commit, not both.")
        sys.exit(1)

    if not commit and not dry_run:
        dry_run = True  # Default behavior

    # Copy loader to staging dir for persistence
    staging_loader = os.path.join(STAGING_DIR, "loader.py")
    if os.path.abspath(__file__) != os.path.abspath(staging_loader):
        shutil.copy2(__file__, staging_loader)
        print(f"[COPY] Loader copied to {staging_loader}")

    # Connect to database
    db_dir = os.path.dirname(TEA_DB_PATH)
    os.makedirs(db_dir, exist_ok=True)
    conn = sqlite3.connect(TEA_DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")

    results = {}
    total_rows = 0

    print(f"\n{'='*60}")
    print(f"PIR #{PIR_NUMBER} — PEIMS Pregnancy/Parenting Data Loader")
    print(f"Database: {TEA_DB_PATH}")
    print(f"Mode: {'DRY RUN' if dry_run else 'COMMIT'}")
    print(f"{'='*60}\n")

    for filename, year_range in CSV_FILES:
        rows = load_csv_file(conn, filename, year_range, dry_run=dry_run)
        base_name = filename.replace(".csv", "")
        table_name = make_table_name(base_name)
        results[base_name] = {
            "table": table_name,
            "year": year_range,
            "rows": rows,
            "file": filename,
        }
        total_rows += rows
        print(f"  {filename} ({year_range}): {rows} rows")

    print(f"\n{'='*60}")
    print(f"TOTAL: {total_rows} rows across {len(results)} tables")
    print(f"{'='*60}\n")

    # Save row_counts.json
    rc_path = os.path.join(STAGING_DIR, "row_counts.json")
    with open(rc_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"[SAVED] row_counts.json -> {rc_path}")

    if commit and total_rows > 0:
        print(f"\nCOMMIT COMPLETE: {total_rows} rows loaded into tea_data.db")
    elif dry_run:
        print(f"\nDRY RUN: {total_rows} rows would be loaded.")
    elif total_rows == 0:
        print("\nNo rows loaded (all tables already populated or files missing).")

    conn.close()


if __name__ == "__main__":
    main()

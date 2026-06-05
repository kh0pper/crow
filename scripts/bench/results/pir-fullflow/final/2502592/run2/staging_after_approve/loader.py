#!/usr/bin/env python3
import os as _ff_os  # __FF_TEA_REDIRECT__
_ff_os.environ["TEA_DB"] = "/home/kh0pp/crow/scripts/bench/results/pir-fullflow/_sandbox/tea_2502592_final_2.db"
"""
Loader for PIR #2502592 — TEA Pregnancy/Parenting PEIMS Data (2020-25)
Loads 5 CSV files into tea_data.db as separate tables.
Usage:
  python3 loader.py --dry-run    Print row counts per table
  python3 loader.py --commit     Actually load into tea_data.db
"""

import csv
import os
import sqlite3
import sys
import argparse

HOLDING_DIR = os.environ.get(
    "PIR_HOLDING_DIR",
    "/home/kh0pp/spring-2026/insd-5941/sources/pir-incoming/2502592"
)
TEA_DB = os.environ.get(
    "TEA_DB",
    os.path.expanduser("~/spring-2026/texas-gov-data-mcp/data/tea_data.db")
)

FILES = [
    ("PRU_11507_21.csv", "research_pir2502592_PRU_11507_21"),
    ("PRU_11507_22.csv", "research_pir2502592_PRU_11507_22"),
    ("PRU_11507_23.csv", "research_pir2502592_PRU_11507_23"),
    ("PRU_11507_24.csv", "research_pir2502592_PRU_11507_24"),
    ("PRU_11507_25.csv", "research_pir2502592_PRU_11507_25"),
]


def parse_csv(path):
    """Parse a CSV file, converting -999 to None. Returns list of dicts."""
    rows = []
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        for r in reader:
            converted = {}
            for k, v in r.items():
                if v == "-999":
                    converted[k] = None
                else:
                    converted[k] = v
            rows.append(converted)
    return rows


def create_table(conn, table_name, sample_row):
    """Create table with appropriate schema, or skip if exists."""
    cur = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table_name,))
    if cur.fetchone():
        print(f"  Table {table_name} already exists — skipping")
        return False

    col_defs = []
    for col in sample_row:
        if col == "YEAR":
            col_defs.append(f"{col} TEXT")
        elif col == "DISTRICT":
            col_defs.append(f"{col} TEXT")
        elif col == "DISTNAME":
            col_defs.append(f"{col} TEXT")
        else:
            col_defs.append(f"{col} REAL")
    col_defs_str = ", ".join(col_defs)
    conn.execute(f"CREATE TABLE {table_name} ({col_defs_str})")
    return True


def load_table(conn, table_name, rows):
    """Insert rows into table using executemany for bulk inserts."""
    if not rows:
        return 0
    cols = list(rows[0].keys())
    placeholders = ", ".join(["?"] * len(cols))
    col_list = ", ".join(cols)
    conn.executemany(
        f"INSERT INTO {table_name} ({col_list}) VALUES ({placeholders})",
        [tuple(r[c] for c in cols) for r in rows]
    )
    return len(rows)


def main():
    parser = argparse.ArgumentParser(description="Load PIR #2502592 CSVs into tea_data.db")
    parser.add_argument("--dry-run", action="store_true", help="Print row counts only")
    parser.add_argument("--commit", action="store_true", help="Actually load into DB")
    args = parser.parse_args()

    row_counts = {}
    total = 0

    for fn, table_name in FILES:
        path = os.path.join(HOLDING_DIR, fn)
        if not os.path.exists(path):
            print(f"  WARNING: {fn} not found at {path}")
            continue

        rows = parse_csv(path)
        row_counts[table_name] = len(rows)
        total += len(rows)
        print(f"  {fn}: {len(rows)} rows")

    print(f"\nTotal: {total} rows across {len(row_counts)} tables")

    if args.dry_run:
        print("\nDRY-RUN complete. No changes made to database.")
        return 0

    if not args.commit:
        print("\nUse --commit to actually load data.")
        return 1

    # Connect and load
    print(f"\nConnecting to {TEA_DB}...")
    conn = sqlite3.connect(TEA_DB)
    conn.execute("PRAGMA journal_mode=WAL")

    created = 0
    loaded = 0
    for fn, table_name in FILES:
        path = os.path.join(HOLDING_DIR, fn)
        if not os.path.exists(path):
            continue
        rows = parse_csv(path)

        # Duplicate guard: check if table exists and has rows
        cur = conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
            (table_name,)
        )
        if cur.fetchone()[0]:
            cur2 = conn.execute(f"SELECT COUNT(*) FROM {table_name}")
            existing = cur2.fetchone()[0]
            if existing > 0:
                print(f"  {table_name}: {existing} rows already exist — skipping")
                continue
            # Table exists but is empty — fall through to create_table (no-op) and load

        create_table(conn, table_name, rows[0] if rows else {})
        loaded += load_table(conn, table_name, rows)
        created += 1

    conn.commit()
    print(f"\nCREATE COMPLETE: {created} tables created")
    print(f"COMMIT COMPLETE: {loaded} rows loaded")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
Load Austin ISD PIR #8 response data into the TEA research database.

Parses Title I allocations, CBOC bond financials (2022, 2017, previous),
and MGT enrollment forecast data from extracted text files.

Tables:
  - research_title_i_allocations (new)
  - research_bond_projects (existing, from load_bond_comparator_data.py)
  - research_enrollment_projections (existing, from load_bond_comparator_data.py)

Usage:
    python scripts/load_austin_isd_pir_data.py --all
    python scripts/load_austin_isd_pir_data.py --title-i
    python scripts/load_austin_isd_pir_data.py --bonds
    python scripts/load_austin_isd_pir_data.py --enrollment
    python scripts/load_austin_isd_pir_data.py --verify
"""

import argparse
import json
import os
import re
import sqlite3
import sys

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "tea-data-mcp", "data", "tea_data.db")
SOURCES_DIR = os.path.join(
    os.path.dirname(__file__), "..", "insd-5941", "sources", "austin-isd-pir"
)
DISTRICT_TEA_ID = "227901"
SOURCE_LABEL = "PIR #8 - Austin ISD"
FORECAST_SOURCE = "PIR #8 - Austin ISD (MGT Forecast)"


def create_tables(conn):
    """Create research tables if they don't exist. Idempotent."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS research_title_i_allocations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            district_tea_id TEXT NOT NULL,
            org_code TEXT NOT NULL,
            campus_name TEXT NOT NULL,
            school_year TEXT NOT NULL,
            allocation REAL,
            notes TEXT,
            UNIQUE(source, district_tea_id, org_code, school_year)
        );
        CREATE INDEX IF NOT EXISTS ix_rtia_district
            ON research_title_i_allocations(district_tea_id);
        CREATE INDEX IF NOT EXISTS ix_rtia_year
            ON research_title_i_allocations(school_year);

        CREATE TABLE IF NOT EXISTS research_bond_projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            district_tea_id TEXT NOT NULL,
            bond_year INTEGER NOT NULL,
            campus_or_project TEXT NOT NULL,
            description TEXT,
            authorized_amount REAL,
            actual_amount REAL,
            notes TEXT,
            UNIQUE(source, district_tea_id, bond_year, campus_or_project, description)
        );
        CREATE INDEX IF NOT EXISTS ix_rbp_district ON research_bond_projects(district_tea_id);
        CREATE INDEX IF NOT EXISTS ix_rbp_year ON research_bond_projects(bond_year);

        CREATE TABLE IF NOT EXISTS research_enrollment_projections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            district_tea_id TEXT NOT NULL,
            campus_name TEXT NOT NULL,
            capacity INTEGER,
            school_year TEXT NOT NULL,
            enrollment INTEGER,
            is_projected BOOLEAN DEFAULT 0,
            notes TEXT,
            UNIQUE(source, district_tea_id, campus_name, school_year)
        );
        CREATE INDEX IF NOT EXISTS ix_rep_district
            ON research_enrollment_projections(district_tea_id);
        CREATE INDEX IF NOT EXISTS ix_rep_year
            ON research_enrollment_projections(school_year);
    """)
    print("  Tables verified/created.")


def parse_dollar(s):
    """Parse a dollar amount string like '$680,240' or '56,093,606' into float."""
    s = s.strip().replace(",", "").replace("$", "")
    if s == "0" or s == "-" or s == "":
        return 0.0
    try:
        return float(s)
    except ValueError:
        return None


# ── Title I ──────────────────────────────────────────────────────────────────


def parse_title_i(text_path):
    """Parse Title I allocations text file into list of dicts.

    Format: 3 year-sections, each starting with a header containing the year.
    Data lines: org_code campus_name $amount
    """
    with open(text_path) as f:
        content = f.read()

    rows = []
    current_year = None

    # Detect year from section headers like "2025-26 Title I Allocations"
    year_re = re.compile(r"(\d{4})-(\d{2})\s+Title I Allocations")

    # Data line: org_code (3 digits), campus name, dollar amount
    # e.g. "002 Austin High School    $0"
    # or   "004 Navarro Early College High School    $680,240"
    data_re = re.compile(
        r"^\s*(\d{3})\s+(.+?)\s+\$([0-9,]+)\s*$"
    )

    for line in content.split("\n"):
        # Check for year header
        ym = year_re.search(line)
        if ym:
            y1 = int(ym.group(1))
            y2 = int(ym.group(2))
            current_year = f"{y1}-{y1 + 1}"
            continue

        if current_year is None:
            continue

        # Skip page numbers and headers
        stripped = line.strip()
        if not stripped or stripped.isdigit():
            continue
        if "Austin ISD Historical" in stripped:
            continue
        if "Title I Allocation" in stripped and "Org" not in stripped:
            continue

        # Try data line
        dm = data_re.match(line)
        if dm:
            org_code = dm.group(1)
            campus_name = dm.group(2).strip()
            amount = parse_dollar(dm.group(3))

            rows.append({
                "source": SOURCE_LABEL,
                "district_tea_id": DISTRICT_TEA_ID,
                "org_code": org_code,
                "campus_name": campus_name,
                "school_year": current_year,
                "allocation": amount,
                "notes": None,
            })

    return rows


def load_title_i(conn):
    """Load Title I allocation data."""
    text_path = os.path.join(SOURCES_DIR, "title-i-allocations.txt")
    if not os.path.exists(text_path):
        print(f"  WARNING: title-i-allocations.txt not found")
        return 0

    rows = parse_title_i(text_path)
    total = 0
    for row in rows:
        conn.execute("""
            INSERT OR REPLACE INTO research_title_i_allocations
            (source, district_tea_id, org_code, campus_name, school_year,
             allocation, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (row["source"], row["district_tea_id"], row["org_code"],
              row["campus_name"], row["school_year"],
              row["allocation"], row["notes"]))
        total += 1

    conn.commit()
    print(f"  Title I: inserted/updated {total} rows")
    return total


# ── Bond Financials ──────────────────────────────────────────────────────────


def parse_paren_amount(s):
    """Parse parenthesized amount like '( 56,093,606)' or '($ 1,044,212,091)'."""
    s = s.strip()
    # Remove parens and dollar sign
    s = s.replace("(", "").replace(")", "").replace("$", "").replace(",", "").strip()
    if s == "-" or s == "" or s == "- ":
        return 0.0
    # Handle negative amounts in parens — the CBOC report uses parens as formatting,
    # not to indicate negative. But budget amendments can be negative like (25,480)
    try:
        return abs(float(s))
    except ValueError:
        return None


def parse_2022_bond(text_path):
    """Parse 2022 bond financials text file.

    Format: numbered project lines with 6 parenthesized amounts:
    Initial, Amendments, Budget Nov, Budget Dec, Actuals, Commitments, Balance
    """
    with open(text_path) as f:
        lines = f.readlines()

    rows = []
    current_section = "Proposition A"

    # Match proposition headers
    prop_re = re.compile(r"Proposition\s+([ABC])")

    # Match project lines — numbered, with parenthesized amounts
    # e.g. "2    Allison Elementary    ( 56,093,606) ( - ) ( 58,798,343) ..."
    # Extract: line number, project name, then all parenthesized groups
    paren_re = re.compile(r"\(([^)]*)\)")

    # Subtotal lines
    subtotal_re = re.compile(r"Subtotal|Prop\.\s+[ABC]\s+Grand|Grand Total", re.IGNORECASE)

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue

        # Check for proposition header
        pm = prop_re.search(stripped)
        if pm:
            current_section = f"Proposition {pm.group(1)}"
            continue

        # Find all parenthesized amounts on this line
        amounts = paren_re.findall(stripped)
        if len(amounts) < 4:
            continue

        # Extract project name — everything before the first parenthesized group
        first_paren_idx = stripped.index("(")
        prefix = stripped[:first_paren_idx].strip()

        # Remove leading line number
        prefix = re.sub(r"^\d+\s+", "", prefix).strip()

        if not prefix:
            continue

        # Parse amounts based on position
        # For project lines: Initial, Amendments, Budget Nov, Budget Dec, Actuals, Commitments, Balance
        # For subtotal lines: same structure but fewer cols sometimes
        is_subtotal = bool(subtotal_re.search(prefix))

        if len(amounts) >= 7:
            initial = parse_paren_amount(amounts[0])
            amendments = parse_paren_amount(amounts[1])
            budget_dec = parse_paren_amount(amounts[3])  # Budget a/o December
            actuals = parse_paren_amount(amounts[4])
            commitments = parse_paren_amount(amounts[5])
            balance = parse_paren_amount(amounts[6])
        elif len(amounts) >= 4:
            # Shorter lines — use what we have
            initial = parse_paren_amount(amounts[0])
            budget_dec = parse_paren_amount(amounts[1]) if len(amounts) > 1 else None
            actuals = parse_paren_amount(amounts[2]) if len(amounts) > 2 else None
            balance = parse_paren_amount(amounts[-1])
            amendments = None
            commitments = None
        else:
            continue

        # Clean up project name
        campus_or_project = prefix
        if is_subtotal:
            campus_or_project = prefix

        notes_dict = {}
        if initial is not None:
            notes_dict["initial_budget"] = initial
        if amendments:
            notes_dict["amendments"] = amendments
        if commitments is not None:
            notes_dict["commitments"] = commitments
        if balance is not None:
            notes_dict["balance"] = balance
        notes_dict["section"] = current_section

        rows.append({
            "source": SOURCE_LABEL,
            "district_tea_id": DISTRICT_TEA_ID,
            "bond_year": 2022,
            "campus_or_project": campus_or_project,
            "description": current_section,
            "authorized_amount": budget_dec,
            "actual_amount": actuals,
            "notes": json.dumps(notes_dict),
        })

    return rows


def parse_2017_bond(text_path):
    """Parse 2017 bond financials text file.

    Format: numbered project lines with parenthesized amounts:
    TOTAL COST, Unallocated, Budget Nov, contingency cols, Budget Dec, Actuals, Commitments, Balance
    """
    with open(text_path) as f:
        lines = f.readlines()

    rows = []
    paren_re = re.compile(r"\(([^)]*)\)")
    subtotal_re = re.compile(r"Subtotal|Grand Total|Total Targeted|Total Technology", re.IGNORECASE)

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue

        amounts = paren_re.findall(stripped)
        if len(amounts) < 4:
            continue

        # Extract project name
        first_paren_idx = stripped.index("(")
        prefix = stripped[:first_paren_idx].strip()

        # Remove leading line number
        prefix = re.sub(r"^\d+\s+", "", prefix).strip()

        if not prefix:
            continue

        is_subtotal = bool(subtotal_re.search(prefix))

        # 2017 format columns:
        # TOTAL COST, Unallocated, Budget Nov, (contingency cols), Budget Dec, Actuals, Commitments, Balance
        # The last 4 amounts are always: Budget Dec, Actuals, Commitments, Balance
        if len(amounts) >= 4:
            budget_dec = parse_paren_amount(amounts[-4])
            actuals = parse_paren_amount(amounts[-3])
            commitments = parse_paren_amount(amounts[-2])
            balance = parse_paren_amount(amounts[-1])

            # First amount is usually the total cost / bond book amount
            total_cost = parse_paren_amount(amounts[0]) if len(amounts) >= 5 else None
        else:
            continue

        notes_dict = {}
        if total_cost:
            notes_dict["bond_book_total"] = total_cost
        if commitments is not None:
            notes_dict["commitments"] = commitments
        if balance is not None:
            notes_dict["balance"] = balance
        notes_dict["bond_program"] = "2017 Bond"

        rows.append({
            "source": SOURCE_LABEL,
            "district_tea_id": DISTRICT_TEA_ID,
            "bond_year": 2017,
            "campus_or_project": prefix,
            "description": "2017 Bond Program",
            "authorized_amount": budget_dec,
            "actual_amount": actuals,
            "notes": json.dumps(notes_dict),
        })

    return rows


def parse_previous_bonds(text_path):
    """Parse previous bond supplement (2008/2013) text file."""
    with open(text_path) as f:
        lines = f.readlines()

    rows = []
    paren_re = re.compile(r"\(([^)]*)\)")
    current_project = None

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue

        # Project headers: T. A. Brown, Menchaca, Bowie
        if stripped in ("T. A. Brown", "Menchaca", "Bowie"):
            current_project = stripped
            continue

        if stripped.startswith("Total Bond Amounts"):
            current_project = "DISTRICT TOTAL"
            continue

        if current_project is None:
            continue

        # Look for Current Budget line
        if "Current Budget" in stripped:
            amounts = paren_re.findall(stripped)
            if amounts:
                # Last amount is the total for project
                total = parse_paren_amount(amounts[-1])
                # Find 2008 and 2013 bond amounts
                bond_2008 = None
                bond_2013 = None
                bond_2017 = None
                if len(amounts) >= 4:
                    # amounts order: 2017 bond budget, change amount, total budget,
                    # then 2008 Bond, 2013 Bond, 2017 Bond, Total
                    if len(amounts) >= 7:
                        bond_2008 = parse_paren_amount(amounts[3])
                        bond_2013 = parse_paren_amount(amounts[4])
                        bond_2017 = parse_paren_amount(amounts[5])

                notes_dict = {"bond_program": "Previous Bonds (2008/2013)"}
                if bond_2008:
                    notes_dict["2008_bond"] = bond_2008
                if bond_2013:
                    notes_dict["2013_bond"] = bond_2013
                if bond_2017:
                    notes_dict["2017_bond"] = bond_2017

                # Store as 2008 for the older bonds
                bond_year = 2008
                if current_project == "Menchaca":
                    bond_year = 2013  # Menchaca only has 2013 bond funding

                rows.append({
                    "source": SOURCE_LABEL,
                    "district_tea_id": DISTRICT_TEA_ID,
                    "bond_year": bond_year,
                    "campus_or_project": current_project,
                    "description": "Previous Bond Supplement",
                    "authorized_amount": total,
                    "actual_amount": None,
                    "notes": json.dumps(notes_dict),
                })

        # Actuals line
        if "Actuals" in stripped and current_project:
            amounts = paren_re.findall(stripped)
            if amounts:
                total_actual = parse_paren_amount(amounts[-1])
                # Update the last row with actual amount
                if rows and rows[-1]["campus_or_project"] == current_project:
                    rows[-1]["actual_amount"] = total_actual

    return rows


def load_bonds(conn):
    """Load all bond data."""
    total = 0

    # 2022 Bond
    path = os.path.join(SOURCES_DIR, "2022-bond-financials.txt")
    if os.path.exists(path):
        rows = parse_2022_bond(path)
        for row in rows:
            conn.execute("""
                INSERT OR REPLACE INTO research_bond_projects
                (source, district_tea_id, bond_year, campus_or_project, description,
                 authorized_amount, actual_amount, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (row["source"], row["district_tea_id"], row["bond_year"],
                  row["campus_or_project"], row["description"],
                  row["authorized_amount"], row["actual_amount"], row["notes"]))
            total += 1
        print(f"  2022 Bond: {len(rows)} rows")
    else:
        print("  WARNING: 2022-bond-financials.txt not found")

    # 2017 Bond
    path = os.path.join(SOURCES_DIR, "2017-bond-financials.txt")
    if os.path.exists(path):
        rows = parse_2017_bond(path)
        for row in rows:
            conn.execute("""
                INSERT OR REPLACE INTO research_bond_projects
                (source, district_tea_id, bond_year, campus_or_project, description,
                 authorized_amount, actual_amount, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (row["source"], row["district_tea_id"], row["bond_year"],
                  row["campus_or_project"], row["description"],
                  row["authorized_amount"], row["actual_amount"], row["notes"]))
            total += 1
        print(f"  2017 Bond: {len(rows)} rows")
    else:
        print("  WARNING: 2017-bond-financials.txt not found")

    # Previous Bonds
    path = os.path.join(SOURCES_DIR, "previous-bond-supplement.txt")
    if os.path.exists(path):
        rows = parse_previous_bonds(path)
        for row in rows:
            conn.execute("""
                INSERT OR REPLACE INTO research_bond_projects
                (source, district_tea_id, bond_year, campus_or_project, description,
                 authorized_amount, actual_amount, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (row["source"], row["district_tea_id"], row["bond_year"],
                  row["campus_or_project"], row["description"],
                  row["authorized_amount"], row["actual_amount"], row["notes"]))
            total += 1
        print(f"  Previous Bonds: {len(rows)} rows")
    else:
        print("  WARNING: previous-bond-supplement.txt not found")

    conn.commit()
    print(f"  Bonds total: inserted/updated {total} rows")
    return total


# ── Enrollment Projections ───────────────────────────────────────────────────


def parse_enrollment_forecasts(text_path):
    """Parse campus enrollment forecasts from MGT report text.

    Each campus section has:
    - Campus name header (e.g. "Allison ES")
    - Grade rows with 14 values (4 historic + 10 forecasted)
    - Total row (e.g. "EE-6", "6-8", "9-12")
    - Capacity line (e.g. "534    71%    75%    ...")
    """
    with open(text_path) as f:
        content = f.read()

    rows = []
    # Year columns: 2021-2024 historic, 2025-2034 forecasted
    years = list(range(2021, 2035))
    historic_years = {2021, 2022, 2023, 2024}

    # Split into sections at "Enrollment Forecasts by Attendance Area"
    sections = content.split("Enrollment Forecasts by Attendance Area")

    for section in sections[1:]:  # Skip text before first section
        section_lines = section.strip().split("\n")

        campus_name = None
        capacity = None
        total_enrollment = {}

        for i, line in enumerate(section_lines):
            stripped = line.strip()
            if not stripped:
                continue

            # Campus name: first non-empty line with text that looks like a name
            # e.g. "Allison ES", "O Henry MS", "Crockett ECHS"
            if campus_name is None:
                # Skip header/boilerplate lines
                if "Historic" in stripped or "Grade" in stripped:
                    continue
                if "Forecasted" in stripped:
                    continue
                if re.match(r"^\d+$", stripped):  # Page numbers
                    continue
                if "PAGE" in stripped:
                    continue
                # This should be the campus name
                campus_name = stripped
                continue

            # Skip header lines after campus name
            if "Historic" in stripped or "Forecasted" in stripped:
                continue
            if stripped == "Grade":
                continue

            # Total enrollment line: matches patterns like "EE-6", "EE-5", "6-8", "9-12"
            # Some campuses have asterisk prefix like "*6-8" (Martin MS, Mendez MS)
            # Rosedale has "PK-12"
            total_re = re.match(
                r"^\*?(EE-\d+|PK-\d+|\d+-\d+)\s+([\d,.]+(?:\s+[\d,.]+)*)\s*$", stripped
            )
            if total_re:
                grade_range = total_re.group(1)
                values_str = total_re.group(2)
                values = re.findall(r"[\d,.]+", values_str)

                for j, val in enumerate(values):
                    if j < len(years):
                        try:
                            enrollment = round(float(val.replace(",", "")))
                        except ValueError:
                            continue
                        total_enrollment[years[j]] = enrollment
                continue

            # Capacity line: starts with a number (capacity), followed by percentages
            cap_re = re.match(
                r"^\s*([\d,]+)\s+\d+%", stripped
            )
            if cap_re and "Capacity" not in stripped:
                try:
                    capacity = int(cap_re.group(1).replace(",", ""))
                except ValueError:
                    pass
                continue

            # Annual Change section — stop parsing
            if "Annual" in stripped or "Change" in stripped:
                break

            # Chart data — stop parsing
            if stripped.startswith(("0", "1,", "2,", "3,", "4,", "5,")):
                # Probably chart axis label
                if re.match(r"^[\d,]+$", stripped):
                    break

        # Emit rows for this campus
        if campus_name and total_enrollment:
            for year, enrollment in total_enrollment.items():
                sy = f"{year}-{year + 1}"
                is_projected = 1 if year >= 2025 else 0

                rows.append({
                    "source": FORECAST_SOURCE,
                    "district_tea_id": DISTRICT_TEA_ID,
                    "campus_name": campus_name,
                    "capacity": capacity,
                    "school_year": sy,
                    "enrollment": enrollment,
                    "is_projected": is_projected,
                    "notes": None,
                })

    return rows


def parse_district_totals(text_path):
    """Parse district-wide enrollment totals from the forecast report.

    Table 20: columns are years 2021-2034, rows are grades, with a total row.
    """
    with open(text_path) as f:
        content = f.read()

    rows = []
    years = list(range(2021, 2035))

    # Find "Table 20" section and extract grade rows
    in_table = False
    grade_totals = {}

    for line in content.split("\n"):
        stripped = line.strip()

        if "Table 20" in stripped:
            in_table = True
            continue

        if not in_table:
            continue

        # Look for Total row — matches the last line before the capacity section
        # The grade rows have grade labels then 14 values
        # Total line: "Total" or just the sum — it's after grade 12

        # Match grade rows: "K 5,284 4,973 ..."
        grade_re = re.match(
            r"^\s*(EE|PK|K|\d{1,2})\s+([\d,.]+(?:\s+[\d,.]+)*)\s*$", stripped
        )
        if grade_re:
            values_str = grade_re.group(2)
            values = re.findall(r"[\d,.]+", values_str)
            for j, val in enumerate(values):
                if j < len(years):
                    try:
                        num = round(float(val.replace(",", "")))
                    except ValueError:
                        continue
                    if years[j] not in grade_totals:
                        grade_totals[years[j]] = 0
                    grade_totals[years[j]] += num

    # Build rows from totals
    for year, enrollment in grade_totals.items():
        sy = f"{year}-{year + 1}"
        is_projected = 1 if year >= 2025 else 0

        rows.append({
            "source": FORECAST_SOURCE,
            "district_tea_id": DISTRICT_TEA_ID,
            "campus_name": "DISTRICT TOTAL",
            "capacity": None,
            "school_year": sy,
            "enrollment": enrollment,
            "is_projected": is_projected,
            "notes": None,
        })

    return rows


def load_enrollment(conn):
    """Load enrollment projection data."""
    total = 0

    # District totals
    path = os.path.join(SOURCES_DIR, "district-totals.txt")
    if os.path.exists(path):
        rows = parse_district_totals(path)
        for row in rows:
            conn.execute("""
                INSERT OR REPLACE INTO research_enrollment_projections
                (source, district_tea_id, campus_name, capacity, school_year,
                 enrollment, is_projected, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (row["source"], row["district_tea_id"], row["campus_name"],
                  row["capacity"], row["school_year"],
                  row["enrollment"], row["is_projected"], row["notes"]))
            total += 1
        print(f"  District totals: {len(rows)} rows")
    else:
        print("  WARNING: district-totals.txt not found")

    # Campus forecasts
    path = os.path.join(SOURCES_DIR, "campus-forecasts.txt")
    if os.path.exists(path):
        rows = parse_enrollment_forecasts(path)
        campuses = set(r["campus_name"] for r in rows)
        for row in rows:
            conn.execute("""
                INSERT OR REPLACE INTO research_enrollment_projections
                (source, district_tea_id, campus_name, capacity, school_year,
                 enrollment, is_projected, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (row["source"], row["district_tea_id"], row["campus_name"],
                  row["capacity"], row["school_year"],
                  row["enrollment"], row["is_projected"], row["notes"]))
            total += 1
        print(f"  Campus forecasts: {len(rows)} rows ({len(campuses)} campuses)")
    else:
        print("  WARNING: campus-forecasts.txt not found")

    conn.commit()
    print(f"  Enrollment total: inserted/updated {total} rows")
    return total


# ── Verification ─────────────────────────────────────────────────────────────


def verify(conn):
    """Verify loaded data."""
    print("\n=== Verification ===\n")

    # Title I
    print("Title I Allocations:")
    cursor = conn.execute("""
        SELECT school_year, COUNT(*), SUM(allocation),
               SUM(CASE WHEN allocation > 0 THEN 1 ELSE 0 END) as receiving
        FROM research_title_i_allocations
        WHERE district_tea_id = ?
        GROUP BY school_year
        ORDER BY school_year
    """, (DISTRICT_TEA_ID,))
    for row in cursor:
        print(f"  {row[0]}: {row[1]} campuses, {row[3]} receiving, "
              f"total ${row[2]:,.0f}")

    # Bonds
    print("\nBond Projects:")
    cursor = conn.execute("""
        SELECT bond_year, COUNT(*),
               SUM(authorized_amount), SUM(actual_amount)
        FROM research_bond_projects
        WHERE source = ?
        GROUP BY bond_year
        ORDER BY bond_year
    """, (SOURCE_LABEL,))
    for row in cursor:
        auth = f"${row[2]:,.0f}" if row[2] else "N/A"
        act = f"${row[3]:,.0f}" if row[3] else "N/A"
        print(f"  {row[0]}: {row[1]} projects, authorized={auth}, actual={act}")

    # Enrollment
    print("\nEnrollment Projections:")
    cursor = conn.execute("""
        SELECT COUNT(DISTINCT campus_name), COUNT(*)
        FROM research_enrollment_projections
        WHERE source LIKE 'PIR #8%'
    """)
    row = cursor.fetchone()
    print(f"  {row[0]} campuses, {row[1]} total rows")

    cursor = conn.execute("""
        SELECT campus_name, school_year, enrollment, capacity, is_projected
        FROM research_enrollment_projections
        WHERE source LIKE 'PIR #8%' AND campus_name = 'DISTRICT TOTAL'
        ORDER BY school_year
    """)
    print("\n  District totals:")
    for row in cursor:
        proj = "projected" if row[4] else "historic"
        print(f"    {row[1]}: {row[2]:,} ({proj})")

    # Sample campus
    cursor = conn.execute("""
        SELECT DISTINCT campus_name FROM research_enrollment_projections
        WHERE source LIKE 'PIR #8%' AND campus_name != 'DISTRICT TOTAL'
        ORDER BY campus_name
        LIMIT 5
    """)
    sample = [r[0] for r in cursor]
    if sample:
        print(f"\n  Sample campuses: {', '.join(sample)}")
        for campus in sample[:2]:
            cursor = conn.execute("""
                SELECT school_year, enrollment, capacity, is_projected
                FROM research_enrollment_projections
                WHERE source LIKE 'PIR #8%' AND campus_name = ?
                ORDER BY school_year
            """, (campus,))
            print(f"\n  {campus}:")
            for row in cursor:
                proj = "P" if row[3] else "H"
                cap = f" (cap: {row[2]})" if row[2] else ""
                print(f"    {row[0]}: {row[1]:,}{cap} [{proj}]")


# ── Main ─────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="Load Austin ISD PIR #8 data")
    parser.add_argument("--all", action="store_true", help="Load all data types")
    parser.add_argument("--title-i", action="store_true", help="Load Title I allocations")
    parser.add_argument("--bonds", action="store_true", help="Load bond financials")
    parser.add_argument("--enrollment", action="store_true", help="Load enrollment projections")
    parser.add_argument("--verify", action="store_true", help="Verify loaded data")

    args = parser.parse_args()

    if not any([args.all, args.title_i, args.bonds, args.enrollment, args.verify]):
        parser.print_help()
        sys.exit(1)

    conn = sqlite3.connect(DB_PATH)
    print(f"Connected to: {DB_PATH}")

    try:
        create_tables(conn)

        if args.all or args.title_i:
            print("\n--- Title I Allocations ---")
            load_title_i(conn)

        if args.all or args.bonds:
            print("\n--- Bond Financials ---")
            load_bonds(conn)

        if args.all or args.enrollment:
            print("\n--- Enrollment Projections ---")
            load_enrollment(conn)

        if args.verify or args.all:
            verify(conn)

    finally:
        conn.close()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Load IDEA Public Schools PIR #2526.106 Austin campus data into the TEA research database.

Loads lottery/enrollment data (applications, offers, registrations, withdrawals, waitlist)
and financial/facilities data (campus budgets, construction costs, capital assets).

Usage:
    python scripts/load_idea_austin_pir_data.py --all
    python scripts/load_idea_austin_pir_data.py --lottery
    python scripts/load_idea_austin_pir_data.py --financial
    python scripts/load_idea_austin_pir_data.py --verify
"""

import argparse
import os
import re
import sqlite3
import sys

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "texas-gov-data-mcp", "data", "tea_data.db")
SOURCE_DIR = os.path.join(
    os.path.dirname(__file__), "..",
    "insd-5941", "sources", "idea-pir", "2526.106-austin",
)

DISTRICT_TEA_ID = "108807"
SOURCE = "PIR #2526.106 - IDEA Public Schools (Austin)"

# Austin campus TEA IDs
# IDEA has Academy (K-5) and College Prep (6-12) at each location.
# Application/withdrawal data is combined; we split by grade into correct campus.
AUSTIN_CAMPUS_MAP = {
    "Bluff Springs": {
        "academy": "108807137",
        "college_prep": "108807037",
    },
    "Health Professions": {
        "academy": "108807191",
        "college_prep": "108807091",
    },
    "Kyle": {
        "academy": "108807139",
        "college_prep": "108807039",
    },
    "Montopolis": {
        "academy": "108807135",
        "college_prep": "108807035",
    },
    "Parmer Park": {
        "academy": "108807190",
        "college_prep": "108807090",
    },
    "Pflugerville": {
        "academy": "108807138",
        "college_prep": "108807038",
    },
    "Round Rock Tech": {
        "academy": "108807300",
        "college_prep": "108807200",
    },
    "Rundberg": {
        "academy": "108807136",
        "college_prep": "108807036",
    },
    # Eastside appears in capital assets but NOT in lottery data
    "Eastside": {
        "academy": "108807124",
        "college_prep": "108807024",
    },
}

YEAR_MAP = {
    "21-22": "2021-2022",
    "22-23": "2022-2023",
    "23-24": "2023-2024",
    "24-25": "2024-2025",
}


def normalize_grade(grade_str):
    """Normalize grade labels to consistent format."""
    g = str(grade_str).strip().lower()
    grade_map = {
        "pk": "pk4", "pk3": "pk3", "pk4": "pk4",
        "k": "k", "kindergarten": "k",
    }
    if g in grade_map:
        return grade_map[g]
    # Strip ordinal suffixes
    g = re.sub(r'(st|nd|rd|th)$', '', g)
    try:
        return str(int(g))
    except (ValueError, TypeError):
        return g


def grade_to_campus(location_name, grade_str):
    """Map an IDEA grade to the correct campus (Academy vs College Prep)."""
    mapping = AUSTIN_CAMPUS_MAP.get(location_name)
    if not mapping:
        return None, None
    grade = normalize_grade(grade_str)
    if grade in ("pk3", "pk4", "pk", "k", "1", "2", "3", "4", "5"):
        tea_id = mapping["academy"]
        name = f"IDEA {location_name} Academy"
    else:
        tea_id = mapping["college_prep"]
        name = f"IDEA {location_name} College Prep"
    return tea_id, name


def create_tables(conn):
    """Ensure research tables exist. lottery table created here; financial and
    campus_summary tables already exist with their own schemas."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS research_charter_lottery (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            district_tea_id TEXT NOT NULL,
            campus_tea_id TEXT,
            campus_name TEXT NOT NULL,
            school_year TEXT NOT NULL,
            grade TEXT NOT NULL,
            metric TEXT NOT NULL,
            count INTEGER,
            notes TEXT,
            UNIQUE(source, campus_tea_id, school_year, grade, metric)
        );
    """)


def extract_pdf_text(filename):
    """Extract text from a PDF file using pdftotext."""
    import subprocess
    # Search recursively under SOURCE_DIR for the file
    for root, dirs, files in os.walk(SOURCE_DIR):
        for f in files:
            if f == filename:
                filepath = os.path.join(root, f)
                result = subprocess.run(
                    ["pdftotext", "-layout", filepath, "-"],
                    capture_output=True, text=True
                )
                return result.stdout
    print(f"  ERROR: File not found: {filename}")
    return ""


# ============================================================
# Lottery/Enrollment Data Loading
# ============================================================

def load_app_counts(conn):
    """Parse application counts PDF and insert into research_charter_lottery."""
    text = extract_pdf_text("20260305-AppCounts.pdf")
    rows = []
    current_campus = None

    for line in text.strip().split('\n'):
        line = line.strip()
        if not line or line.startswith('region_name'):
            continue

        # Parse: remove Austin prefix, split on 2+ spaces
        parts = re.split(r'\s{2,}', line)
        if parts and parts[0] == 'Austin':
            parts = parts[1:]

        if len(parts) < 5:
            continue

        # First part is campus name or continuation
        first = parts[0]

        # Check if first part is a known campus
        if first in AUSTIN_CAMPUS_MAP:
            current_campus = first
            # Second part is the grade/name, then 4 values
            if len(parts) >= 6:
                grade_label = parts[1]
                values = parts[2:6]
            else:
                continue
        elif current_campus and len(parts) >= 5:
            # Grade row: grade, then 4 values
            grade_label = parts[0]
            values = parts[1:5]
        else:
            continue

        if not current_campus:
            continue

        # Campus total row: grade_label matches campus name
        is_total = (grade_label == current_campus)

        if is_total:
            grade = "total"
            tea_id = AUSTIN_CAMPUS_MAP[current_campus]["academy"]
            campus_full_name = f"IDEA {current_campus}"
        else:
            grade = normalize_grade(grade_label)
            tea_id, campus_full_name = grade_to_campus(current_campus, grade_label)

        if not tea_id:
            continue

        for i, year_key in enumerate(["21-22", "22-23", "23-24", "24-25"]):
            if i < len(values):
                try:
                    count = int(values[i].replace(',', ''))
                except (ValueError, IndexError):
                    count = None
                rows.append((
                    SOURCE, DISTRICT_TEA_ID, tea_id, campus_full_name,
                    YEAR_MAP[year_key], grade, "applications", count, None
                ))

    inserted = 0
    for row in rows:
        try:
            conn.execute(
                """INSERT OR REPLACE INTO research_charter_lottery
                   (source, district_tea_id, campus_tea_id, campus_name,
                    school_year, grade, metric, count, notes)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                row
            )
            inserted += 1
        except sqlite3.IntegrityError as e:
            print(f"  SKIP: {e} -- {row[3]} {row[4]} {row[5]}")
    print(f"  Applications: {inserted} rows inserted")
    return inserted


def load_offers_registered(conn):
    """Parse offers/registrations PDF and insert into research_charter_lottery."""
    text = extract_pdf_text("20260305-OffertoRegistered.pdf")
    rows = []
    current_year = None

    for line in text.strip().split('\n'):
        line = line.strip()
        if not line:
            continue

        # Detect year header
        year_match = re.match(r'(\d{2}-\d{2})\s+School', line)
        if year_match:
            current_year = year_match.group(1)
            continue

        if not current_year:
            continue

        parts = re.split(r'\s{2,}', line)
        if parts and parts[0] == 'Austin':
            parts = parts[1:]

        if len(parts) < 3:
            continue

        campus_name = parts[0].strip()
        if campus_name not in AUSTIN_CAMPUS_MAP:
            continue

        try:
            offers = int(parts[1].replace(',', ''))
            registered = int(parts[2].replace(',', ''))
        except (ValueError, IndexError):
            continue

        school_year = YEAR_MAP.get(current_year)
        if not school_year:
            continue

        tea_id = AUSTIN_CAMPUS_MAP[campus_name]["academy"]
        full_name = f"IDEA {campus_name}"

        rows.append((SOURCE, DISTRICT_TEA_ID, tea_id, full_name,
                      school_year, "total", "offers", offers, "campus-level only"))
        rows.append((SOURCE, DISTRICT_TEA_ID, tea_id, full_name,
                      school_year, "total", "registered", registered, "campus-level only"))

    inserted = 0
    for row in rows:
        try:
            conn.execute(
                """INSERT OR REPLACE INTO research_charter_lottery
                   (source, district_tea_id, campus_tea_id, campus_name,
                    school_year, grade, metric, count, notes)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                row
            )
            inserted += 1
        except sqlite3.IntegrityError as e:
            print(f"  SKIP: {e}")
    print(f"  Offers/Registered: {inserted} rows inserted")
    return inserted


def load_withdrawals(conn):
    """Parse withdrawal counts PDF and insert into research_charter_lottery."""
    text = extract_pdf_text("20260305-Withdrawals.pdf")
    rows = []
    current_campus = None

    for line in text.strip().split('\n'):
        line = line.strip()
        if not line or line.startswith('School'):
            continue

        # Detect campus name
        campus_match = None
        for cname in sorted(AUSTIN_CAMPUS_MAP.keys(), key=len, reverse=True):
            if line.startswith(cname):
                campus_match = cname
                break

        if campus_match:
            remainder = line[len(campus_match):].strip()
            current_campus = campus_match
            if not remainder:
                continue
            parts = re.split(r'\s+', remainder)
        elif current_campus:
            parts = re.split(r'\s+', line)
        else:
            continue

        if len(parts) < 5:
            continue

        grade_str = parts[0]
        values = parts[1:5]

        grade = normalize_grade(grade_str)
        tea_id, campus_full_name = grade_to_campus(current_campus, grade_str)

        if not tea_id:
            continue

        for i, year_key in enumerate(["21-22", "22-23", "23-24", "24-25"]):
            if i < len(values):
                try:
                    count = int(values[i].replace(',', ''))
                except (ValueError, IndexError):
                    count = None
                rows.append((
                    SOURCE, DISTRICT_TEA_ID, tea_id, campus_full_name,
                    YEAR_MAP[year_key], grade, "withdrawn", count, None
                ))

    inserted = 0
    for row in rows:
        try:
            conn.execute(
                """INSERT OR REPLACE INTO research_charter_lottery
                   (source, district_tea_id, campus_tea_id, campus_name,
                    school_year, grade, metric, count, notes)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                row
            )
            inserted += 1
        except sqlite3.IntegrityError as e:
            print(f"  SKIP: {e}")
    print(f"  Withdrawals: {inserted} rows inserted")
    return inserted


def load_waitlist(conn):
    """Parse waitlist counts (hardcoded from PDF — complex layout)."""
    # 2021-22 and 2022-23: "No responsive records" for all campuses
    # 2023-24 and 2024-25: numeric counts by campus (Academy vs CP split)
    waitlist_data = {
        "IDEA HEALTH PROFESSIONS ACADEMY": ("108807191", 0, 0),
        "IDEA HEALTH PROFESSIONS COLLEGE PREPARATORY": ("108807091", 3, 3),
        "IDEA BLUFF SPRINGS ACADEMY": ("108807137", 2, 0),
        "IDEA BLUFF SPRINGS COLLEGE PREPARATORY": ("108807037", 4, 0),
        "IDEA EASTSIDE ACADEMY": ("108807124", 1, 0),
        "IDEA EASTSIDE COLLEGE PREPARATORY": ("108807024", 1, 0),
        "IDEA KYLE ACADEMY": ("108807139", 2, 1),
        "IDEA KYLE COLLEGE PREPARATORY": ("108807039", 7, 2),
        "IDEA MONTOPOLIS ACADEMY": ("108807135", 2, 1),
        "IDEA MONTOPOLIS COLLEGE PREPARATORY": ("108807035", 69, 6),
        "IDEA PARMER PARK ACADEMY": ("108807190", 7, 0),
        "IDEA PARMER PARK COLLEGE PREPARATORY": ("108807090", 0, 1),
        "IDEA PFLUGERVILLE ACADEMY": ("108807138", 28, 3),
        "IDEA PFLUGERVILLE COLLEGE PREPARATORY": ("108807038", 49, 2),
        "IDEA ROUND ROCK TECH ACADEMY": ("108807300", 170, 142),
        "IDEA ROUND ROCK TECH COLLEGE PREPARATORY": ("108807200", 1, 12),
        "IDEA RUNDBERG ACADEMY": ("108807136", 3, 15),
        "IDEA RUNDBERG COLLEGE PREPARATORY": ("108807036", 215, 218),
    }

    inserted = 0
    for campus_name, (tea_id, count_2324, count_2425) in waitlist_data.items():
        for year, note in [("2021-2022", "no responsive records"), ("2022-2023", "no responsive records")]:
            conn.execute(
                """INSERT OR REPLACE INTO research_charter_lottery
                   (source, district_tea_id, campus_tea_id, campus_name,
                    school_year, grade, metric, count, notes)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (SOURCE, DISTRICT_TEA_ID, tea_id, campus_name,
                 year, "total", "waitlist", None, note)
            )
            inserted += 1

        for year, count in [("2023-2024", count_2324), ("2024-2025", count_2425)]:
            conn.execute(
                """INSERT OR REPLACE INTO research_charter_lottery
                   (source, district_tea_id, campus_tea_id, campus_name,
                    school_year, grade, metric, count, notes)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (SOURCE, DISTRICT_TEA_ID, tea_id, campus_name,
                 year, "total", "waitlist", count, None)
            )
            inserted += 1

    print(f"  Waitlist: {inserted} rows inserted")
    return inserted


# ============================================================
# Financial/Facilities Data Loading
# ============================================================

def load_construction_costs(conn):
    """Load construction cost data into research_charter_campus_summary."""
    # Existing schema: source, district_tea_id, campus_name, school_year, metric, amount, per_pupil, notes, campus_tea_id
    construction_data = [
        ("Bluff Springs", "108807137", 12941805, 6208682, 19150487),
        ("Kyle", "108807139", 14452350, 6296406, 20748756.03),
        ("Montopolis", "108807135", 15561769, 0, 15561769),
        ("Parmer Park", "108807190", 15695414, 5926123, 21621537),
        ("Pflugerville", "108807138", 15943793, 6297989, 22241782),
        ("Round Rock Tech", "108807300", 16407441, 7957965, 24365406),
        ("Rundberg", "108807136", 10399838, 7029231, 17429069),
        ("Health Professions", "108807191", 14846789, 5941917.39, 20788706.39),
    ]

    inserted = 0
    for campus, tea_id, phase1, phase2, total in construction_data:
        full_name = f"IDEA {campus}"
        for metric, value in [
            ("construction_phase1", phase1),
            ("construction_phase2", phase2),
            ("construction_total", total),
        ]:
            conn.execute(
                """INSERT OR REPLACE INTO research_charter_campus_summary
                   (source, district_tea_id, campus_tea_id, campus_name,
                    school_year, metric, amount, notes)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (SOURCE, DISTRICT_TEA_ID, tea_id, full_name,
                 "N/A", metric, value, "From 03.2026_RFI Construction Costs AUS.pdf")
            )
            inserted += 1
    print(f"  Construction costs: {inserted} rows inserted")
    return inserted


def load_capital_assets(conn):
    """Load capital asset totals into research_charter_campus_summary."""
    asset_data = [
        ("Health Professions", "108807191", 27039407.58, 23550986.45),
        ("Bluff Springs", "108807137", 21052541.55, 15653588.57),
        ("Montopolis", "108807135", 19313011.03, 13313393.10),
        ("Rundberg", "108807136", 22671637.48, 16409669.58),
        ("Parmer Park", "108807190", 25774209.79, 21893597.50),
        ("Eastside", "108807124", 19173389.78, 13653299.32),
        ("Pflugerville", "108807138", 23770792.80, 18998165.13),
        ("Kyle", "108807139", 22367272.30, 17841767.92),
        ("Round Rock Tech", "108807300", 29674090.91, 26480436.94),
    ]

    inserted = 0
    for campus, tea_id, total_acq, total_book in asset_data:
        full_name = f"IDEA {campus}"
        for metric, value in [
            ("total_acquisition_cost", total_acq),
            ("total_book_value_jun2025", total_book),
        ]:
            conn.execute(
                """INSERT OR REPLACE INTO research_charter_campus_summary
                   (source, district_tea_id, campus_tea_id, campus_name,
                    school_year, metric, amount, notes)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (SOURCE, DISTRICT_TEA_ID, tea_id, full_name,
                 "FY2025", metric, value,
                 "Capital asset schedule as of Jun 30, 2025")
            )
            inserted += 1

    print(f"  Capital assets: {inserted} rows inserted")
    return inserted


def load_facilities_costs(conn):
    """Load FY24 and FY25 facilities costs into research_charter_campus_summary."""
    facilities_fy24 = {
        "Bluff Springs Academy": ("108807137", 608546.12),
        "Bluff Springs College Prep": ("108807037", 656493.55),
        "Kyle Academy": ("108807139", 677696.13),
        "Kyle College Prep": ("108807039", 654869.64),
        "Montopolis Academy": ("108807135", 655746.01),
        "Montopolis College Prep": ("108807035", 769960.93),
        "Parmer Park Academy": ("108807190", 795048.62),
        "Parmer Park College Prep": ("108807090", 629197.38),
        "Pflugerville Academy": ("108807138", 723715.27),
        "Pflugerville College Prep": ("108807038", 720801.71),
        "Round Rock Academy": ("108807300", 689723.62),
        "Round Rock College Prep": ("108807200", 504141.41),
        "Rundberg Academy": ("108807136", 519774.02),
        "Rundberg College Prep": ("108807036", 616921.24),
    }

    facilities_fy25 = {
        "Bluff Springs Academy": ("108807137", 482348.02),
        "Bluff Springs College Prep": ("108807037", 560996.44),
        "Kyle Academy": ("108807139", 489007.64),
        "Kyle College Prep": ("108807039", 587476.58),
        "Montopolis Academy": ("108807135", 608336.95),
        "Montopolis College Prep": ("108807035", 536128.02),
        "Parmer Park Academy": ("108807190", 564822.88),
        "Parmer Park College Prep": ("108807090", 582862.87),
        "Pflugerville Academy": ("108807138", 578921.61),
        "Pflugerville College Prep": ("108807038", 671100.21),
        "Round Rock Academy": ("108807300", 624392.22),
        "Round Rock College Prep": ("108807200", 630486.96),
        "Rundberg Academy": ("108807136", 496156.65),
        "Rundberg College Prep": ("108807036", 618359.79),
    }

    inserted = 0
    for fy, data in [("FY2024", facilities_fy24), ("FY2025", facilities_fy25)]:
        for campus_short, (tea_id, amount) in data.items():
            full_name = f"IDEA {campus_short}"
            conn.execute(
                """INSERT OR REPLACE INTO research_charter_campus_summary
                   (source, district_tea_id, campus_tea_id, campus_name,
                    school_year, metric, amount, notes)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (SOURCE, DISTRICT_TEA_ID, tea_id, full_name,
                 fy, "facilities_costs", amount,
                 "From 1C 1E 1F Austin.pdf")
            )
            inserted += 1

    print(f"  Facilities costs: {inserted} rows inserted")
    return inserted


def load_sped_costs(conn):
    """Load FY24 and FY25 special education expenditures into research_charter_campus_summary."""
    sped_fy24 = {
        "Bluff Springs Academy": ("108807137", 662368.89),
        "Bluff Springs College Prep": ("108807037", 970431.23),
        "Kyle Academy": ("108807139", 335615.61),
        "Kyle College Prep": ("108807039", 365450.31),
        "Montopolis Academy": ("108807135", 359115.40),
        "Montopolis College Prep": ("108807035", 242378.57),
        "Parmer Park Academy": ("108807190", 289523.45),
        "Parmer Park College Prep": ("108807090", 297095.32),
        "Pflugerville Academy": ("108807138", 749039.17),
        "Pflugerville College Prep": ("108807038", 535274.57),
        "Round Rock Academy": ("108807300", 642120.87),
        "Round Rock College Prep": ("108807200", 465087.14),
        "Rundberg Academy": ("108807136", 204501.06),
        "Rundberg College Prep": ("108807036", 820043.54),
    }

    sped_fy25 = {
        "Bluff Springs Academy": ("108807137", 661590.63),
        "Bluff Springs College Prep": ("108807037", 981170.47),
        "Kyle Academy": ("108807139", 332491.44),
        "Kyle College Prep": ("108807039", 386022.20),
        "Montopolis Academy": ("108807135", 345059.31),
        "Montopolis College Prep": ("108807035", 291265.29),
        "Parmer Park Academy": ("108807190", 280754.63),
        "Parmer Park College Prep": ("108807090", 379350.60),
        "Pflugerville Academy": ("108807138", 966332.58),
        "Pflugerville College Prep": ("108807038", 856874.87),
        "Round Rock Academy": ("108807300", 903434.48),
        "Round Rock College Prep": ("108807200", 412701.35),
        "Rundberg Academy": ("108807136", 283047.82),
        "Rundberg College Prep": ("108807036", 1008017.56),
    }

    inserted = 0
    for fy, data in [("FY2024", sped_fy24), ("FY2025", sped_fy25)]:
        for campus_short, (tea_id, amount) in data.items():
            full_name = f"IDEA {campus_short}"
            conn.execute(
                """INSERT OR REPLACE INTO research_charter_campus_summary
                   (source, district_tea_id, campus_tea_id, campus_name,
                    school_year, metric, amount, notes)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (SOURCE, DISTRICT_TEA_ID, tea_id, full_name,
                 fy, "special_education", amount,
                 "From 1C 1E 1F Austin.pdf")
            )
            inserted += 1

    print(f"  Special ed costs: {inserted} rows inserted")
    return inserted


def load_instructional_costs(conn):
    """Load FY24/25 expenditure grand totals into research_charter_campus_summary."""
    totals = [
        ("FY2024", "total_instruction_and_support", 89258041.36),
        ("FY2025", "total_instruction_and_support", 88792548.02),
        ("FY2024", "total_facilities", 9222635.65),
        ("FY2025", "total_facilities", 8031396.84),
        ("FY2024", "total_special_education", 6938045.13),
        ("FY2025", "total_special_education", 8088113.23),
    ]
    for fy, metric, amount in totals:
        conn.execute(
            """INSERT OR REPLACE INTO research_charter_campus_summary
               (source, district_tea_id, campus_tea_id, campus_name,
                school_year, metric, amount, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (SOURCE, DISTRICT_TEA_ID, "108807_AUSTIN", "IDEA Austin Region",
             fy, metric, amount, "Grand total from 1C 1E 1F Austin.pdf")
        )
    print(f"  Expenditure totals: {len(totals)} rows inserted")
    return len(totals)


# ============================================================
# Verification
# ============================================================

def verify_data(conn):
    """Verify loaded data."""
    print("\n=== Verification ===")

    cursor = conn.execute(
        "SELECT metric, COUNT(*) FROM research_charter_lottery WHERE source=? GROUP BY metric",
        (SOURCE,)
    )
    print("\nLottery data by metric:")
    for row in cursor:
        print(f"  {row[0]}: {row[1]} rows")

    cursor = conn.execute(
        "SELECT COUNT(*) FROM research_charter_lottery WHERE source=?", (SOURCE,)
    )
    total = cursor.fetchone()[0]
    print(f"  TOTAL lottery rows: {total}")

    cursor = conn.execute(
        "SELECT metric, COUNT(*), SUM(amount) FROM research_charter_campus_summary WHERE source=? GROUP BY metric",
        (SOURCE,)
    )
    print("\nCampus summary by metric:")
    for row in cursor:
        total_str = f"${row[2]:,.2f}" if row[2] else "N/A"
        print(f"  {row[0]}: {row[1]} rows, total {total_str}")

    cursor = conn.execute(
        "SELECT COUNT(*) FROM research_charter_campus_summary WHERE source=?", (SOURCE,)
    )
    total = cursor.fetchone()[0]
    print(f"  TOTAL campus summary rows: {total}")

    # Spot checks
    print("\nSpot checks:")

    cursor = conn.execute(
        """SELECT count FROM research_charter_lottery
           WHERE source=? AND campus_name='IDEA Bluff Springs'
           AND school_year='2024-2025' AND grade='total' AND metric='applications'""",
        (SOURCE,)
    )
    row = cursor.fetchone()
    val = row[0] if row else "MISSING"
    expected = 1177
    status = "OK" if val == expected else "MISMATCH"
    print(f"  Bluff Springs 2024-25 total applications: {val} (expected {expected}) [{status}]")

    cursor = conn.execute(
        """SELECT count FROM research_charter_lottery
           WHERE source=? AND campus_tea_id='108807300'
           AND school_year='2023-2024' AND metric='waitlist'""",
        (SOURCE,)
    )
    row = cursor.fetchone()
    val = row[0] if row else "MISSING"
    expected = 170
    status = "OK" if val == expected else "MISMATCH"
    print(f"  Round Rock Tech Academy 2023-24 waitlist: {val} (expected {expected}) [{status}]")

    cursor = conn.execute(
        """SELECT amount FROM research_charter_campus_summary
           WHERE source=? AND campus_tea_id='108807138'
           AND school_year='FY2025' AND metric='facilities_costs'""",
        (SOURCE,)
    )
    row = cursor.fetchone()
    val = f"${row[0]:,.2f}" if row else "MISSING"
    print(f"  Pflugerville Academy FY25 facilities: {val} (expected $578,921.61)")

    cursor = conn.execute(
        """SELECT amount FROM research_charter_campus_summary
           WHERE source=? AND campus_tea_id='108807139'
           AND metric='total_acquisition_cost'""",
        (SOURCE,)
    )
    row = cursor.fetchone()
    val = f"${row[0]:,.2f}" if row else "MISSING"
    expected = 22367272.30
    status = "OK" if row and abs(row[0] - expected) < 0.01 else "MISMATCH"
    print(f"  Kyle total acquisition cost: {val} (expected $22,367,272.30) [{status}]")


# ============================================================
# Main
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="Load IDEA Austin PIR #2526.106 data")
    parser.add_argument("--all", action="store_true", help="Load all data")
    parser.add_argument("--lottery", action="store_true", help="Load lottery/enrollment data")
    parser.add_argument("--financial", action="store_true", help="Load financial/facilities data")
    parser.add_argument("--verify", action="store_true", help="Verify loaded data")
    args = parser.parse_args()

    if not any([args.all, args.lottery, args.financial, args.verify]):
        parser.print_help()
        sys.exit(1)

    conn = sqlite3.connect(DB_PATH)
    create_tables(conn)

    if args.all or args.lottery:
        print("\n--- Loading Lottery/Enrollment Data ---")
        load_app_counts(conn)
        load_offers_registered(conn)
        load_withdrawals(conn)
        load_waitlist(conn)
        conn.commit()

    if args.all or args.financial:
        print("\n--- Loading Financial/Facilities Data ---")
        load_construction_costs(conn)
        load_capital_assets(conn)
        load_facilities_costs(conn)
        load_sped_costs(conn)
        load_instructional_costs(conn)
        conn.commit()

    if args.all or args.verify:
        verify_data(conn)

    conn.close()
    print("\nDone.")


if __name__ == "__main__":
    main()

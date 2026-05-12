#!/usr/bin/env python3
"""Batch update script for Cleveland ISD case study (case_study_id=2).

Integrates ILTexas PIR #2/#11 findings: teacher certification, per-pupil
expenditure, construction costs, visa staffing evidence, Colony Ridge
dual-system land donation, and Cleveland ISD board response.
"""

import os
import sqlite3
import json
import shutil
import sys

CAPSTONE_ROOT = os.environ.get(
    "CAPSTONE_ROOT", os.path.expanduser("~/spring-2026")
)
DB_PATH = os.environ.get(
    "CANVAS_DB",
    os.path.join(CAPSTONE_ROOT, "canvas-companion", "db", "canvas.db"),
)
TEA_DB_PATH = os.environ.get(
    "TEA_DB_PATH",
    os.path.join(CAPSTONE_ROOT, "texas-gov-data-mcp", "data", "tea_data.db"),
)


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def get_content(conn, section_id):
    c = conn.cursor()
    c.execute("SELECT content FROM case_study_sections WHERE id = ?", (section_id,))
    return c.fetchone()["content"]


def update_content(conn, section_id, new_content):
    c = conn.cursor()
    c.execute(
        "UPDATE case_study_sections SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (new_content, section_id),
    )
    return c.rowcount


def update_title(conn, section_id, new_title):
    c = conn.cursor()
    c.execute(
        "UPDATE case_study_sections SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (new_title, section_id),
    )
    return c.rowcount


def update_sql_field(conn, section_id, new_sql):
    c = conn.cursor()
    c.execute(
        "UPDATE case_study_sections SET sql = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (new_sql, section_id),
    )
    return c.rowcount


def update_config(conn, section_id, config_dict):
    c = conn.cursor()
    config_str = json.dumps(config_dict, ensure_ascii=False)
    c.execute(
        "UPDATE case_study_sections SET config = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (config_str, section_id),
    )
    return c.rowcount


def find_replace(conn, section_id, old_text, new_text, task_label):
    content = get_content(conn, section_id)
    if old_text not in content:
        print(f"  ERROR: Find text not found in section {section_id} for {task_label}")
        print(f"  Looking for: {old_text[:100]}...")
        return False
    new_content = content.replace(old_text, new_text, 1)
    update_content(conn, section_id, new_content)
    print(f"  OK: {task_label} (section {section_id})")
    return True


def verify_tea_data():
    """Run data integrity checks against tea_data.db before modifying canvas.db."""
    tea = sqlite3.connect(TEA_DB_PATH)
    c = tea.cursor()

    checks_passed = True

    # Row counts
    c.execute("SELECT COUNT(*) FROM research_iltexas_teacher_counts")
    count = c.fetchone()[0]
    if count != 151:
        print(f"  FAIL: teacher_counts rows = {count}, expected 151")
        checks_passed = False

    c.execute("SELECT COUNT(*) FROM research_iltexas_support_staff")
    count = c.fetchone()[0]
    if count != 1010:
        print(f"  FAIL: support_staff rows = {count}, expected 1010")
        checks_passed = False

    c.execute("SELECT COUNT(*) FROM research_iltexas_support_staff_raw")
    count = c.fetchone()[0]
    if count != 2090:
        print(f"  FAIL: support_staff_raw rows = {count}, expected 2090")
        checks_passed = False

    # Liberty County 2024-25 totals
    c.execute("""
        SELECT SUM(teacher_count), SUM(certified_count)
        FROM research_iltexas_teacher_counts
        WHERE school_year = '2024-2025'
          AND campus_name IN ('BG RAMIREZ ES','BG RAMIREZ MS','MSG RAMIREZ ES','MSG RAMIREZ MS','LIBERTY HS')
    """)
    total, certified = c.fetchone()
    if total != 191 or certified != 81:
        print(f"  FAIL: Liberty 2025 total={total} (exp 191), certified={certified} (exp 81)")
        checks_passed = False

    # System-wide 2024-25 totals
    c.execute("""
        SELECT SUM(teacher_count), SUM(certified_count)
        FROM research_iltexas_teacher_counts
        WHERE school_year = '2024-2025'
    """)
    total, certified = c.fetchone()
    if total != 1734 or certified != 845:
        print(f"  FAIL: System 2025 total={total} (exp 1734), certified={certified} (exp 845)")
        checks_passed = False

    tea.close()
    return checks_passed


# =========================================================================
# SECTION 54 REPLACEMENT CONTENT (Task 1)
# =========================================================================
SECTION_54_CONTENT = """ILTexas treated PIR #2 (facilities and capital costs) and PIR #11 (staffing and resource allocation) as a combined request. The response, received March 2026, included PEIMS campus financial reports, teacher certification data, support staff records, salary schedules, construction costs, and bond documents across all campuses for school years 2021-2025. The data confirms a pattern of resource allocation that directs fewer qualified teachers and fewer per-pupil dollars to the network's highest-need campuses.

## Per-Pupil Expenditure: Resources Flow Away from Need

TEA reports Per-Pupil Expenditure (PPE) only at the district level, making ILTexas's $10,844 system-wide figure appear comparable to Cleveland ISD's $10,788. The PIR response reveals what that average conceals. Campus-level PEIMS financial data shows operational spending per student varies substantially across the network:

| Campus | Enrollment | All Funds PPE | EcoDis % |
|---|---|---|---|
| MSG Ramirez Middle | 455 | $6,740 | ~95% |
| BG Ramirez Middle | 418 | $7,372 | ~93% |
| BG Ramirez El | 888 | $7,527 | 93.2% |
| MSG Ramirez El | 895 | $7,529 | 95.0% |
| College Station El | 799 | $8,139 | 42.3% |
| College Station Middle | 382 | $8,350 | ~42% |

MSG Ramirez Middle (95% economically disadvantaged) receives $1,610 less per student than College Station Middle (42% economically disadvantaged). An equitable funding system would direct more resources to higher-need campuses. ILTexas directs fewer. The $1,610 gap amounts to $732,550 annually across MSG Ramirez Middle's 455 students, enough to fund approximately 12 additional certified teaching positions at the campus's average salary.

## Teacher Certification: The Staffing Quality Gap

The PIR response included teacher certification status by campus for four school years. The data reveals a certification gap between Liberty County campuses and the network's suburban campuses that widened in the most recent year:

| Campus | 2024-25 Teachers | Certified | Cert % |
|---|---|---|---|
| MSG RAMIREZ ES | 60 | 20 | 33.3% |
| MSG RAMIREZ MS | 21 | 7 | 33.3% |
| LIBERTY HS | 29 | 10 | 34.5% |
| BG RAMIREZ ES | 60 | 32 | 53.3% |
| BG RAMIREZ MS | 21 | 12 | 57.1% |
| **Liberty Co. Total** | **191** | **81** | **42.4%** |
| Katy (all campuses) | 86 | 51 | 59.3% |
| C Station (all campuses) | 87 | 52 | 59.8% |
| Garland (all campuses) | 137 | 90 | 65.7% |
| **System-wide** | **1,734** | **845** | **48.7%** |

MSG Ramirez Elementary dropped from 36.0% certified in 2023-24 to 33.3% in 2024-25. Liberty High School declined from 36.4% to 34.5%, the only campus in the entire ILTexas system where the certification rate fell year over year. A typical Texas ISD has 90%+ certified teachers. The ILTexas system-wide average of 48.7% is already far below that threshold, and its highest-need campuses in Liberty County fall below even the system's own average.

## Staffing Quality and Academic Outcomes

The certification data combines with TAPR beginning teacher percentages and STAAR scores to form a consistent pattern: the campuses with the least qualified staff produce the weakest academic outcomes.

| Campus | Beginning Teachers | STAAR Approaches | Cert Rate |
|---|---|---|---|
| MSG Ramirez El | 57% | 37% | 33.3% |
| BG Ramirez El | 30% | 47% | 53.3% |
| Katy El | 12% | 80% | 54.1% |
| College Station El | 20% | 66% | 55.6% |

MSG Ramirez Elementary and ILTexas Katy Elementary operate within the same charter network, use the same curriculum, and answer to the same central leadership. The 43-percentage-point STAAR gap between them (37% vs. 80% approaches grade level) tracks the staffing gap: MSG Ramirez staffs 57% beginning teachers while Katy staffs 12%.

ILTexas pays Liberty County teachers more than their suburban counterparts. Average teacher salary at MSG Ramirez Elementary is $59,397 compared with $58,240 at Katy Elementary and $55,443 at College Station Elementary. The salary premium combined with extreme inexperience and low certification rates is consistent with a workforce recruited through visa programs rather than traditional teacher pipelines.

## Visa Staffing Evidence

Department of Labor LCA disclosure data shows 41 H-1B LCA filings across ILTexas's history, filed under three legal name variations: "International Leadership of Texas," "International Leadership of Texas Inc," and "International Leadership of Texas-Global." (LCA certification by the DOL is a prerequisite to filing an H-1B petition with USCIS; LCA filings indicate employer intent to sponsor but do not confirm approved visas.) Filings ramped from 1 in 2020 to 19 in 2024, spanning 11 worksites. Three filings are at Cleveland, TX campuses: an Elementary Teacher ($57,200, 2024), a Middle School Social Studies Teacher ($57,587, 2024), and a Music Teacher ($53,337, 2023). ILTexas is also its own designated J-1 visa sponsor, approved by the State Department to recruit teachers from Mexico and Spain.

The J-1/J-2 visa pipeline explains the unusual staffing profile at Liberty County campuses:

- J-1 teachers hold home-country teaching credentials that TEA classifies as uncertified. International experience does not count toward TEA experience metrics, making these teachers "beginning teachers" by TAPR standards regardless of actual classroom years.
- J-2 dependent visa holders (spouses of J-1 teachers) may hold no teaching credentials or classroom experience at all but can receive employment authorization.
- Neither J-1 nor J-2 teachers arrive with training in U.S. special education law, including IDEA, Section 504, and IEP development. This matters at campuses where 7-10% of students receive special education services.
- Average teacher experience at MSG Ramirez Middle is 2.3 years, the lowest in the network. J-1 visas are typically issued for 3-year terms, suggesting high turnover as teachers cycle through placements.

The result is a workforce that costs more per teacher (salary premium to attract candidates to a rural, high-need area) while producing worse outcomes (uncertified, inexperienced staff with no U.S. pedagogical training). The network extracts labor from international pipelines for its hardest-to-staff campuses while its suburban campuses employ more certified, more experienced teachers at lower salaries.

**Pending:** PIR ILT-12 (teacher certification status and visa category by campus, filed March 12, 2026), FOIA-ICE (SEVIS J-1/J-2 placement records, Submission ID 2793856), and FOIA-DOS (J-1 sponsor compliance reports, Ref: F-2026-13033) will provide direct confirmation of visa teacher placement patterns.

## Construction and Land Donation

The PIR response confirmed construction costs for all three Liberty County campuses:

| Campus | Construction Cost | Total Budget | Sq Ft | Cost/Sq Ft |
|---|---|---|---|---|
| BG Ramirez K-8 | $27.3M | $34M | 96,457 | $283/sf |
| MSG Ramirez K-8 | $33.1M | $36M | 96,375 | $343/sf |
| Liberty HS | $47.5M | $55M | 141,729 | $335/sf |
| **Total** | **$107.9M** | **$125M** | **334,561** | |

All three campuses were built on land donated by Colony Ridge (Terrenos Holdings LLC). ILTexas financed construction through revenue bonds that require no voter approval. In the same period (2019-2024), Cleveland ISD failed three consecutive bond elections totaling over $400M, unable to build permanent facilities for the same student population that ILTexas serves in its donated-land, state-funded campuses.

**Colony Ridge as dual-system land donor.** Colony Ridge donated land for both competing public school systems. ILTexas received parcels for all three Liberty County campuses (BG Ramirez, MSG Ramirez, and Liberty High School). Cleveland ISD received donated land for its Santa Fe Elementary and Santa Fe Middle School campuses. The same developer finances facility construction for two publicly funded school systems serving the same student population on adjacent parcels.

This arrangement makes the constitutional absurdity concrete. The state funding formula pays for duplicated infrastructure while the ISD cannot pass bonds for its own facilities. Colony Ridge profits from residential development that generates the student population, then donates land to both school systems that compete to serve those students. The developer's interests align with expansion regardless of which system builds; the state's constitutional obligation to maintain an "efficient system" has no mechanism to prevent the resulting duplication.

**Cleveland ISD board response: forced accommodation.** Cleveland ISD's board filed a formal TEA opposition to ILTexas expansion in 2021, citing enrollment impact and resource strain. By November 2023, the same board approved an interlocal agreement with ILTexas for emergency transportation services (6-0 vote, November 13, 2023). This shift from opposition to accommodation was pragmatic: the board that fought charter expansion now depends on the charter for basic district functions.

The board minutes contain no recorded discussion analyzing why three consecutive bond elections failed. No postmortem. No community engagement analysis. No demographic study of voter behavior across precincts. The silence reflects a governance structure with no mechanism to address the underlying problem: competing systems funded by the same state formula, building on land donated by the same developer, while only the ISD must win voter approval for facilities.

## Support Staff

PIR support staff records show instructional aide headcounts roughly comparable across campus types: BG Ramirez Elementary employs 16 aides for 888 students, while Katy Elementary employs 16 aides for 936 students. The earlier TA allegation (one aide per three grade levels at Cleveland campuses vs. one per grade level at suburban campuses) described the distribution structure across grade levels rather than raw aide counts.

Liberty High School (421 students) has no school nurse on staff. Katy-Westpark High School has 1 nurse.

## Cleveland ISD Comparison

Cleveland ISD campuses serving the same Colony Ridge area show a distinct staffing profile:

| Campus | Avg Salary | Experience | Student:Teacher | Beginning Teachers |
|---|---|---|---|---|
| Pine Burr EL | $56,545 | 2.3 yrs | 13.5 | ~42% |
| Santa Fe EL | $60,932 | 4.5 yrs | 14.7 | 15.8% |
| Santa Fe Middle | $63,610 | 5.1 yrs | 12.9 | ~18% |

Santa Fe Elementary achieves 4.5 years average experience with 15.8% beginning teachers, compared with ILTexas BG Ramirez Elementary's 3.5 years and 30% beginning teachers. Santa Fe Middle School has 5.1 years average experience compared with MSG Ramirez Middle's 2.3 years. The ISD's bond-funded campuses built on Colony Ridge donated land employ more experienced teachers at comparable salaries to ILTexas, without the charter's visa teacher pipeline.

## Pending Data

- **PIR ILT-12:** Teacher certification status and visa category by campus (filed March 12, 2026)
- **FOIA-ICE:** SEVIS J-1/J-2 placement records (Submission ID 2793856)
- **FOIA-DOS:** J-1 sponsor compliance reports (Ref: F-2026-13033)
- **PIR CISD-2:** Cleveland ISD teacher certification data for direct comparison"""


def main():
    # =====================================================================
    # PRE-FLIGHT: Data integrity checks
    # =====================================================================
    print("=== PRE-FLIGHT: Data integrity checks ===")
    if not verify_tea_data():
        print("ABORTING: Data integrity checks failed")
        sys.exit(1)
    print("  All checks passed")

    # =====================================================================
    # BACKUP
    # =====================================================================
    print("\n=== BACKUP ===")
    backup_path = DB_PATH + ".bak"
    shutil.copy2(DB_PATH, backup_path)
    print(f"  Backed up to {backup_path}")

    conn = connect()
    errors = []

    # =====================================================================
    # TASK 1: Replace Section 54 content and title
    # =====================================================================
    print("\n=== TASK 1: Section 54 - Replace PIR placeholder with findings ===")
    update_title(conn, 54, "ILTexas Campus-Level Data: What the PIR Response Reveals")
    update_content(conn, 54, SECTION_54_CONTENT)
    print(f"  OK: Section 54 updated ({len(SECTION_54_CONTENT)} chars)")

    # =====================================================================
    # TASK 2: Insert chart - Teacher Certification Rate by Campus (2024-25)
    # =====================================================================
    print("\n=== TASK 2: Insert chart - Teacher Certification by Campus ===")
    chart2_sql = """SELECT campus_name AS Campus,
  ROUND(certified_count * 100.0 / teacher_count, 1) AS "Cert Rate %",
  CASE WHEN campus_name IN ('BG RAMIREZ ES','BG RAMIREZ MS','MSG RAMIREZ ES','MSG RAMIREZ MS','LIBERTY HS')
    THEN 'Liberty County' ELSE 'Suburban' END AS Region
FROM research_iltexas_teacher_counts
WHERE school_year = '2024-2025'
  AND campus_name IN ('BG RAMIREZ ES','BG RAMIREZ MS','MSG RAMIREZ ES','MSG RAMIREZ MS','LIBERTY HS',
    'KATY ES','KATY MS','C STATION ES','C STATION MS','GARLAND ES','GARLAND MS','GARLAND HS')
ORDER BY "Cert Rate %" ASC"""

    chart2_config = json.dumps({
        "type": "bar",
        "xCol": "Campus",
        "yCol": "Cert Rate %",
        "groupCol": "Region",
        "yAxisLabel": "Texas-Certified Teachers (%)",
        "tooltipSuffix": "%",
        "description": (
            "Teacher certification rates at ILTexas Liberty County campuses "
            "(serving Cleveland/Colony Ridge, 93-95% economically disadvantaged) vs. "
            "suburban campuses in Katy, College Station, and Garland "
            "(42-70% economically disadvantaged). Data from ILTexas PIR #11 response, March 2026."
        ),
    }, ensure_ascii=False)

    c = conn.cursor()
    c.execute(
        "SELECT MAX(sort_order) FROM case_study_sections WHERE case_study_id = 2"
    )
    max_sort = c.fetchone()[0]

    c.execute(
        """INSERT INTO case_study_sections
           (case_study_id, section_type, sort_order, title, content, sql, config,
            created_at, updated_at)
           VALUES (2, 'chart', ?, ?, '', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)""",
        (max_sort + 1, "Teacher Certification Rate by Campus (2024-25)",
         chart2_sql, chart2_config),
    )
    chart2_id = c.lastrowid
    print(f"  OK: Created chart section id={chart2_id}")

    # =====================================================================
    # TASK 3: Insert chart - Certification Trend (Liberty County vs System)
    # =====================================================================
    print("\n=== TASK 3: Insert chart - Certification Trend ===")
    chart3_sql = """SELECT school_year AS Year, 'System-Wide' AS Scope,
  ROUND(SUM(certified_count) * 100.0 / SUM(teacher_count), 1) AS "Cert Rate %"
FROM research_iltexas_teacher_counts WHERE certified_count IS NOT NULL
GROUP BY school_year
UNION ALL
SELECT school_year, 'Liberty County',
  ROUND(SUM(certified_count) * 100.0 / SUM(teacher_count), 1)
FROM research_iltexas_teacher_counts
WHERE campus_name IN ('BG RAMIREZ ES','BG RAMIREZ MS','MSG RAMIREZ ES','MSG RAMIREZ MS','LIBERTY HS')
  AND certified_count IS NOT NULL
GROUP BY school_year
ORDER BY Year, Scope"""

    chart3_config = json.dumps({
        "type": "line",
        "xCol": "Year",
        "yCol": "Cert Rate %",
        "groupCol": "Scope",
        "yAxisLabel": "Texas-Certified Teachers (%)",
        "tooltipSuffix": "%",
        "description": (
            "ILTexas system-wide certification improved from 33.6% to 48.7% (2021-2025). "
            "Liberty County campuses remain below system-wide average at 42.4%. "
            "A typical Texas ISD has 90%+ certified teachers. "
            "Note: 2021-22 Liberty County data reflects a single campus (BG Ramirez MS) "
            "with 1 teacher pre-expansion; trend is meaningful from 2022-23 onward."
        ),
    }, ensure_ascii=False)

    c.execute(
        """INSERT INTO case_study_sections
           (case_study_id, section_type, sort_order, title, content, sql, config,
            created_at, updated_at)
           VALUES (2, 'chart', ?, ?, '', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)""",
        (max_sort + 2, "Certification Trend: Liberty County vs. System-Wide (2021-2025)",
         chart3_sql, chart3_config),
    )
    chart3_id = c.lastrowid
    print(f"  OK: Created chart section id={chart3_id}")

    # =====================================================================
    # TASK 4: Update Section 40 - TA allegation → PIR certification data
    # =====================================================================
    print("\n=== TASK 4: Section 40 - Replace TA allegation with PIR data ===")
    old_40 = (
        "The internal resource allocation within ILTexas compounds the inequity. "
        "BG Ramirez Elementary (93% economically disadvantaged, 80% ELL) receives "
        "one teaching assistant per three grade levels, while ILTexas campuses in "
        "Katy (62% economically disadvantaged, 52% ELL) and College Station "
        "(42% economically disadvantaged, 17% ELL) receive one teaching assistant "
        "per grade level. The charter network redistributes resources away from "
        "its highest-need campuses toward its lower-need suburban campuses."
    )
    new_40 = (
        "The internal resource allocation within ILTexas compounds the inequity. "
        "PIR data (March 2026) reveals that only 42.4% of teachers at Liberty County "
        "campuses hold Texas teaching certificates, compared with 59.3% at Katy, "
        "59.8% at College Station, and 65.7% at Garland. MSG Ramirez Elementary "
        "(95% economically disadvantaged, 81% ELL) saw its certification rate fall "
        "from 36.0% to 33.3% between 2023-24 and 2024-25. Liberty High School is "
        "the only ILTexas campus where the certification rate declined year over year "
        "(36.4% to 34.5%). The charter network's highest-need campuses receive the "
        "least qualified teachers, while its suburban campuses with lower-need "
        "populations employ significantly more certified staff."
    )
    if not find_replace(conn, 40, old_40, new_40, "Task 4"):
        errors.append("Task 4")

    # =====================================================================
    # TASK 5: Update Section 48 - Structural Loop reference
    # =====================================================================
    print("\n=== TASK 5: Section 48 - Update support staff reference ===")
    old_48 = (
        "Liberty County campuses receive fewer support staff than lower-need "
        "campuses in Katy and College Station (see PIR #11 placeholder above)"
    )
    new_48 = (
        "Liberty County campuses employ 42.4% Texas-certified teachers versus "
        "59-66% at lower-need suburban campuses (PIR #11 data, March 2026; "
        "see ILTexas Campus-Level Data section above)"
    )
    if not find_replace(conn, 48, old_48, new_48, "Task 5"):
        errors.append("Task 5")

    # =====================================================================
    # TASK 6: Update Section 29 - Constitutional Analysis
    # =====================================================================
    print("\n=== TASK 6: Section 29 - Add certification data to constitutional analysis ===")
    old_29 = "These highest-need campuses receive F ratings with 55-57% beginning teachers."
    new_29 = (
        "These highest-need campuses receive F ratings with 55-57% beginning "
        "teachers and only 33-42% holding Texas teaching certificates "
        "(compared with 59-66% at ILTexas suburban campuses)."
    )
    if not find_replace(conn, 29, old_29, new_29, "Task 6"):
        errors.append("Task 6")

    # =====================================================================
    # TASK 7: Update Section 28 - Research Sources (PIR #11 and PIR #2)
    # =====================================================================
    print("\n=== TASK 7: Section 28 - Update PIR source entries ===")

    # PIR #11
    old_pir11 = (
        "PIR #11: ILTexas campus-level staffing "
        "(Source: `0dac411f`, pending ~March 11)"
    )
    new_pir11 = (
        "PIR #11: ILTexas campus-level staffing and teacher certification "
        "(Source: `0dac411f`, received March 2026). Data: teacher certification "
        "by campus 4 years (research_iltexas_teacher_counts, 151 rows), support "
        "staff by position type (research_iltexas_support_staff, 1,010 rows), "
        "individual employee records (research_iltexas_support_staff_raw, 2,090 rows)."
    )
    if not find_replace(conn, 28, old_pir11, new_pir11, "Task 7a - PIR #11"):
        errors.append("Task 7a")

    # PIR #2
    old_pir2 = (
        "PIR #2: ILTexas facilities, capital costs, revenue bond use-of-proceeds "
        "(Source: combined with PIR #11, pending ~March 18)"
    )
    new_pir2 = (
        "PIR #2: ILTexas facilities, capital costs, revenue bond use-of-proceeds "
        "(Source: combined with PIR #11, received March 2026). Construction costs "
        "confirmed: BG Ramirez $27.3M, MSG Ramirez $33.1M, Liberty HS $47.5M "
        "(all land donated). Pending: campus-level operational PPE, PIR ILT-12 "
        "(visa status), FOIA-ICE (SEVIS), FOIA-DOS (J-1 sponsor)."
    )
    if not find_replace(conn, 28, old_pir2, new_pir2, "Task 7b - PIR #2"):
        errors.append("Task 7b")

    # =====================================================================
    # TASK 8: Reorder sections (insert 2 new charts after section 54)
    # =====================================================================
    print("\n=== TASK 8: Reorder sections ===")
    c = conn.cursor()
    c.execute(
        "SELECT id, sort_order FROM case_study_sections "
        "WHERE case_study_id = 2 ORDER BY sort_order"
    )
    all_sections = c.fetchall()

    # Build new order: insert chart2 and chart3 after section 54 (sort_order 26)
    new_order = []
    for row in all_sections:
        sid = row["id"]
        if sid in (chart2_id, chart3_id):
            continue  # skip new sections, insert at right place
        new_order.append(sid)
        if sid == 54:
            new_order.append(chart2_id)
            new_order.append(chart3_id)

    # Verify both were inserted
    if chart2_id not in new_order or chart3_id not in new_order:
        new_order.append(chart2_id)
        new_order.append(chart3_id)
        print("  WARNING: Could not find section 54 anchor, appended at end")

    # Update sort_order for all sections
    for idx, sid in enumerate(new_order):
        c.execute(
            "UPDATE case_study_sections SET sort_order = ? WHERE id = ?",
            (idx, sid),
        )
    print(f"  OK: {len(new_order)} sections reordered "
          f"(chart2={chart2_id} at {new_order.index(chart2_id)}, "
          f"chart3={chart3_id} at {new_order.index(chart3_id)})")

    # =====================================================================
    # COMMIT
    # =====================================================================
    conn.commit()
    conn.close()

    print("\n" + "=" * 60)
    if errors:
        print(f"COMPLETED WITH {len(errors)} ERRORS: {errors}")
        sys.exit(1)
    else:
        print("ALL TASKS COMPLETED SUCCESSFULLY")


if __name__ == "__main__":
    main()

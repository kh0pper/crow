#!/usr/bin/env python3
"""
Integrate PIR #2502721 research findings into case studies.

Steps 1-7: Cleveland case study (case_study_id=2)
Steps 8-9: Austin (case_study_id=1) and ARC (case_study_id=13)

Usage:
    python scripts/update_cleveland_pir_2502721.py --dry-run   # Preview changes
    python scripts/update_cleveland_pir_2502721.py             # Apply changes
"""

import os
import sqlite3
import sys

CAPSTONE_ROOT = os.environ.get(
    "CAPSTONE_ROOT", os.path.expanduser("~/spring-2026")
)
DB_PATH = os.environ.get(
    "CANVAS_DB",
    os.path.join(CAPSTONE_ROOT, "canvas-companion", "db", "canvas.db"),
)
DRY_RUN = "--dry-run" in sys.argv


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def get_content(conn, section_id):
    c = conn.cursor()
    c.execute("SELECT content FROM case_study_sections WHERE id = ?", (section_id,))
    row = c.fetchone()
    return row["content"] if row else None


def update_content(conn, section_id, new_content):
    if DRY_RUN:
        print(f"  [DRY RUN] Would update section {section_id} content ({len(new_content)} chars)")
        return 1
    c = conn.cursor()
    c.execute(
        "UPDATE case_study_sections SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (new_content, section_id),
    )
    return c.rowcount


def find_replace(conn, section_id, old_text, new_text, task_label):
    content = get_content(conn, section_id)
    if content is None or old_text not in content:
        print(f"  ERROR: Find text not found in section {section_id} for {task_label}")
        print(f"  Looking for: {old_text[:100]}...")
        return False
    new_content = content.replace(old_text, new_text, 1)
    update_content(conn, section_id, new_content)
    print(f"  OK: {task_label} (section {section_id})")
    return True


def append_to_section(conn, section_id, new_text, task_label):
    content = get_content(conn, section_id)
    if content is None:
        print(f"  ERROR: Section {section_id} not found for {task_label}")
        return False
    new_content = content.rstrip() + "\n\n" + new_text
    update_content(conn, section_id, new_content)
    print(f"  OK: {task_label} (section {section_id}, appended {len(new_text)} chars)")
    return True


def insert_section_sql(case_study_id, title, section_type, content, after_sort_order, conn):
    """Insert a new section via direct SQL and renumber all sections."""
    if DRY_RUN:
        print(f"  [DRY RUN] Would insert section '{title}' after sort_order {after_sort_order}")
        return -1

    c = conn.cursor()
    c.execute(
        """INSERT INTO case_study_sections
           (case_study_id, title, section_type, content, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, 99, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)""",
        (case_study_id, title, section_type, content),
    )
    new_id = c.lastrowid
    print(f"  Created section '{title}': id={new_id}")

    # Renumber: insert at correct position
    c.execute(
        "SELECT id, sort_order FROM case_study_sections WHERE case_study_id = ? ORDER BY sort_order",
        (case_study_id,),
    )
    all_sections = c.fetchall()

    new_order = []
    inserted = False
    for row in all_sections:
        sid = row["id"]
        if sid == new_id:
            continue
        new_order.append(sid)
        if row["sort_order"] == after_sort_order and not inserted:
            new_order.append(new_id)
            inserted = True

    if not inserted:
        new_order.append(new_id)
        print(f"  WARNING: Could not find sort_order {after_sort_order}, appended at end")

    for idx, sid in enumerate(new_order):
        c.execute("UPDATE case_study_sections SET sort_order = ? WHERE id = ?", (idx, sid))

    print(f"  OK: Reordered {len(new_order)} sections")
    return new_id


def main():
    conn = connect()
    errors = []

    # =========================================================================
    # STEP 1: New section "Facilities Funding: How the Mechanism Works"
    # Insert after Section 18 "The Need Gap" (sort_order 5)
    # =========================================================================
    print("=== STEP 1: New section - Facilities Funding Mechanism ===")

    step1_content = """The gap between Cleveland ISD's need and its ability to build schools traces to a specific set of funding mechanisms. Texas provides two parallel systems for facility funding, one for ISDs and one for charter schools, and neither is adequate for the Cleveland/Colony Ridge situation.

| Mechanism | ISDs | Charters |
|---|---|---|
| GO Bonds (voter-authorized, property tax backed) | Yes | No (no taxing authority) |
| Revenue Bonds (backed by operating revenue/FSP) | Secondary | Yes, via CSFC (TEC Ch. 53) or local EFCs; ~$4.93B issued statewide |
| IFA (TEC Ch. 46A, guaranteed yield $35/ADA/penny) | Yes, competitive, declining | Excluded by statute |
| EDA (TEC Ch. 46B, guaranteed yield $40/ADA/penny) | Yes, automatic | Partial: state pays full entitlement since charters have no property |
| NIFA (new campus equipping) | Yes | Excluded |
| PSF Bond Guarantee (AAA rating) | Yes (since 1983) | Yes (since 2011, capped at enrollment share) |
| Charter Facilities Allotment (TEC 12.106(d)) | N/A | $372.90/ADA under HB 2 (2025) |
| Local property tax revenue | Yes | No |

**The IFA trap:** The Instructional Facilities Allotment (IFA) is a guaranteed yield program: the state fills the gap between a district's local revenue and $35 per ADA per penny of tax effort. The program is competitive, appropriation-limited, and ranked by wealth per student so that the poorest districts are funded first. The critical detail: IFA requires a passed bond election as a prerequisite. When voters reject bonds, the district is locked out of the bonds and the state equalization mechanism simultaneously.

**Frozen yields:** The IFA guaranteed yield has been frozen at $35/ADA/penny since 1999. The EDA yield was raised from $35 to $40 in 2017 and has been frozen since. Statewide IFA appropriations fell 67% over 11 years, from $633M to $208M (Texas AFT, 2024).

**Cleveland's IFA collapse:**

| Year | WADA | Wealth/WADA | IFA Allotment | IFA/Student |
|---|---|---|---|---|
| FY20 | 7,559 | $2,164 | $3,806,171 | $503 |
| FY21 | 8,870 | $2,272 | $2,533,299 | $286 |
| FY22 | 10,851 | $2,216 | $4,217,289 | $389 |
| FY23 | 11,543 | $2,672 | $1,639,364 | $142 |
| FY24 | 11,945 | $2,236 | $1,391,686 | $117 |

IFA per student dropped 77% while enrollment grew 58%. The mechanism is contracting while the need is growing. Cleveland ISD's property wealth per WADA ($2,236) places it among the poorest districts in the state, yet the guaranteed yield formula delivers less each year because appropriations have fallen and the yield itself has been frozen for 25 years.

Source: TEA PIR #2502721 (IFA/EDA payment ledgers, FY19-25); TEA FSP Summary Finance Data; Texas AFT, "School Finance in Texas" (2024)."""

    try:
        new_id_1 = insert_section_sql(
            2,
            "Facilities Funding: How the Mechanism Works",
            "text",
            step1_content,
            5,  # after sort_order 5 (Section 18 "The Need Gap")
            conn,
        )
    except Exception as e:
        print(f"  ERROR: Step 1 - {e}")
        errors.append("Step 1")
        new_id_1 = None

    # =========================================================================
    # STEP 2: New section "Facilities Funding Side-by-Side: ISD vs. Charter"
    # Insert after Step 1's section
    # =========================================================================
    print("\n=== STEP 2: New section - Facilities Funding Side-by-Side ===")

    step2_content = """Both Cleveland ISD and ILTexas opened schools in the Colony Ridge area in 2022, serving the same high-poverty population. Both systems are underfunded for facilities. The comparison reveals how the split creates two parallel systems, each receiving less than what one entity serving all students would require.

**Facilities Funding Comparison: Cleveland ISD vs. ILTexas Liberty County (FY20-FY25)**

| Funding Mechanism | Cleveland ISD | ILTexas (Liberty County campuses) |
|---|---|---|
| GO Bonds (voter-authorized) | $198M passed (2019); $390M rejected across 3 elections (2021-23) | Not available (no taxing authority) |
| IFA (TEC Ch. 46A) | $3.8M (FY20) declining to $1.4M (FY24) | Excluded by statute ($0) |
| EDA (TEC Ch. 46B) | $2.9M-$5.6M/year (varies by year) | Partial: state pays full entitlement; ILTexas receives EDA statewide but amount attributable to Liberty County campuses is unknown |
| NIFA | Eligible | Excluded ($0) |
| Local I&S tax revenue | Yes (from property tax) | None ($0) |
| Charter Facilities Allotment (TEC 12.106(d)) | N/A | ~$73/student pre-HB 2; $372.90/ADA under HB 2 (2025) = ~$1.15M for 3,077 Liberty Co students |
| Revenue Bonds (CSFC/EFC) | Secondary mechanism | Available, backed by FSP revenue. Specific ILTexas Liberty County issuance unknown (data gap) |
| CSP Startup Grants | N/A | $0 for Liberty County campuses. ILTexas received $5.4M in CSP grants (2017-18) for Houston/College Station/Lancaster campuses only (PIR #2502721) |
| PSF Bond Guarantee | Available since 1983 | Available since 2011, capped at enrollment share |

**Per-Student Facilities Funding (FY24):**

| Metric | Cleveland ISD (11,945 WADA) | ILTexas Liberty Co (3,077 students) |
|---|---|---|
| IFA allotment | $1,391,686 ($117/student) | $0 |
| EDA allotment | $2,669,623 ($224/student) | Unknown (statewide figure only) |
| Charter Facilities Allotment | N/A | ~$73/student (pre-HB 2) |
| Total identifiable state facilities funding | ~$341/student | ~$73/student |

**Data gaps noted honestly:** ILTexas revenue bond issuance amounts for Liberty County campuses are unknown. ILTexas receives EDA as part of its statewide FSP calculation, but the portion attributable to Liberty County cannot be isolated from public data. A new PIR filed 2026-03-24 targets charter expansion amendment decisions and financial monitoring records that may clarify these gaps.

**The structural problem:** The state created two parallel systems serving the same Colony Ridge population and adequately funded neither. Cleveland ISD's IFA dropped 77% per student in five years. ILTexas Liberty County campuses received $0 in IFA, $0 in CSP grants, and a Charter Facilities Allotment that was capped at ~$73/student until HB 2 (2025) raised it to $372.90/ADA. An efficient system would allocate resources to meet the need. Instead, the system splits the need between two entities, each receiving less than what one entity serving all students would require.

Sources: TEA PIR #2502721 (IFA/EDA payment ledgers, CSP grant records); TEA FSP Summary Finance Data; HB 2 (89th Legislature, 2025)."""

    # After Step 1, the sort orders will have shifted. We need to insert after Step 1's section.
    # If Step 1 succeeded, its section is at sort_order 6 (after the renumber).
    # If Step 1 failed, fall back to sort_order 5 (after Section 18).
    step2_after = 6 if new_id_1 and new_id_1 > 0 else 5
    try:
        insert_section_sql(
            2,
            "Facilities Funding Side-by-Side: ISD vs. Charter",
            "text",
            step2_content,
            step2_after,
            conn,
        )
    except Exception as e:
        print(f"  ERROR: Step 2 - {e}")
        errors.append("Step 2")

    # =========================================================================
    # STEP 3: Update Section 34 "The State's Response"
    # =========================================================================
    print("\n=== STEP 3: Update Section 34 - Charter expansion timeline ===")

    # Add IDEA denial and timeline table after the last paragraph
    step3_insert = """

**The expansion timeline reveals a pattern:**

| Date | Event |
|---|---|
| Nov 2019 | Cleveland ISD bond passes ($198M, 53.9% for) |
| 2020 | IDEA amendment 059-20/3 to add Cleveland ISD to boundary: denied by TEA |
| May 2021 | Superintendent Trotter asks Commissioner Morath for help |
| May 2021 (same day) | Morath calls ILTexas CEO Eddie Conger |
| Aug 3, 2021 | TEA approves ILTexas amendment 207-21: 5 new Cleveland-area campuses, 15 ISDs added to boundary, enrollment cap raised to 38,600. Processed in 3 days. |
| Sep 2021 | Cleveland ISD board votes unanimously against expansion |
| Nov 2, 2021 | Superintendent Trotter forced out (4-2-1 vote), same night as bond canvass |
| Nov 2021 | Cleveland bond fails ($150M, 42.4% for) |
| Jul 2022 | ILTexas opens first Cleveland campuses |
| Nov 2022 | Cleveland bond fails ($115M, 38.7% for) |
| Nov 2023 | Cleveland bond fails ($125M, 38.8% for) |

The ILTexas expansion was approved before the first bond failure. The state cannot claim it sent charters in response to bond failures.

The IDEA denial is equally significant. IDEA holds a B accountability rating (domain scores: 78, 83, 81). ILTexas holds a C rating (domain scores: 68, 70, 74). TEA approved the lower-performing charter network and denied the higher-performing one for the same territory, in the same two-year window. After opening, ILTexas Liberty County campuses received F ratings, with only 33-42% of teachers holding standard Texas teaching certificates.

**No ISD impact analysis exists:** Under 19 TAC 100.1035 (charter expansion amendment rules), TEA evaluates only the charter's own performance. There is no statutory requirement to analyze the impact on affected ISDs. TEC 12.1101 requires notification to ISDs and legislators, with no consultation period, no comment mechanism, and no requirement that TEA consider the ISD's response. Cleveland ISD's unanimous board vote against the expansion had no legal effect."""

    anchor_34 = "Source: McNeel, Bekah."
    if not find_replace(conn, 34, anchor_34, step3_insert.rstrip() + "\n\n" + anchor_34, "Step 3"):
        errors.append("Step 3")

    # =========================================================================
    # STEP 4: Update Section 29 "Constitutional Analysis"
    # Also fix broken markdown bold markers
    # =========================================================================
    print("\n=== STEP 4: Update Section 29 - Constitutional Analysis ===")

    # Fix broken bold markers first
    find_replace(conn, 29,
        "**Micro lens:** The bond mechanism produces unequal outcomes.**",
        "**Micro lens: The bond mechanism produces unequal outcomes.**",
        "Step 4a - fix bold marker (micro)")
    find_replace(conn, 29,
        "**Charter lens:** The state's remedy creates duplication, not efficiency.**",
        "**Charter lens: The state's remedy creates duplication, not efficiency.**",
        "Step 4b - fix bold marker (charter)")
    find_replace(conn, 29,
        "**Macro lens:** Cleveland is one of 10 completely locked-out districts.**",
        "**Macro lens: Cleveland is one of 10 completely locked-out districts.**",
        "Step 4c - fix bold marker (macro)")

    # Add counterargument section before the final paragraph
    step4_insert = """**The "charters as constitutional safety valve" counterargument:** The state might argue that charter expansion fulfills the constitutional obligation when bond elections fail: if voters reject school buildings, the state approves charter schools to ensure children are served. This argument fails on six grounds:

1. **Timeline destroys causation.** ILTexas was approved in August 2021. Cleveland's first bond failure came in November 2021. The charter expansion predates the crisis it supposedly addresses.

2. **No statutory coordination mechanism exists.** 19 TAC 100.1035 evaluates only the charter's own performance. Zero requirement to analyze ISD needs, facilities gaps, or enrollment impact. TEC 12.1101 requires notification only, with no consultation or comment period.

3. **The charter does not replace the ISD obligation.** Cleveland ISD remains the constitutional guarantor for all students in its territory. The charter absorbs some students while Cleveland bears the same fixed facility costs with less FSP revenue per student.

4. **Neither entity received adequate facilities funding.** Cleveland's IFA dropped from $503 to $117 per student (77% decline, FY20-FY24). ILTexas Liberty County campuses received $0 in IFA, $0 in EDA, and $0 in CSP startup grants. The system created two underfunded parallel systems.

5. **IDEA was denied the same territory.** If charter expansion were a constitutional response to ISD need, TEA would approve any qualified charter. Denying IDEA (B-rated, 2020) and then approving ILTexas (C-rated, 2021) for the same territory on a three-day timeline contradicts the safety-valve theory.

6. **The constitutional standard is system-level efficiency.** The *Edgewood*/*Morath* framework evaluates the system as a whole. Two underfunded parallel systems serving the same population through different mechanisms, one dependent on failed bond elections and one excluded from state equalization formulas, is structural inefficiency by definition.

**Legislative reinforcement of the structural loop:** SB 605 (West, 2025) would have blocked charter expansion for networks under Chapter 39A enforcement. The bill passed the Texas Senate unanimously and died in the House Public Education Committee. SB 1750 (Paxton, 2025) proposed a higher charter facilities formula and self-dealing disclosure requirements. It passed the Senate and died in the House. HB 756 (Bernal, 2025) would have limited charter expansions to once per biennium. It died in committee. Every charter accountability bill introduced in the 89th Legislature died in the House. Charter-favorable bills passed.

**Charter oversight as practiced:** PIR #2502721 (TEA, March 2026) requested financial monitoring reports, site visit records, and compliance audits for ILTexas, Uplift, and IDEA from FY2022 through FY2025. TEA produced zero financial monitoring documents. All three charters received unconditional expedited 10-year renewals under TEC 12.1141(b): ILTexas (2018), Uplift (2021), IDEA (2025). The state grants charters the power to bypass voter approval for facilities, excludes them from IFA equalization, produces no financial monitoring records, and renews them for a decade without conditions."""

    # Insert before the final paragraph ("Article VII, Section 1")
    final_para_anchor = "Article VII, Section 1 of the Texas Constitution requires an *efficient system*, not a system"
    if not find_replace(conn, 29, final_para_anchor, step4_insert + "\n\n" + final_para_anchor, "Step 4d - insert counterargument"):
        errors.append("Step 4")

    # =========================================================================
    # STEP 5: Update Section 48 "Charter Expansion and Bond Failure"
    # =========================================================================
    print("\n=== STEP 5: Update Section 48 - Commissioner waivers + legislature ===")

    step5_insert = """**Commissioner expansion waivers:** Before Mike Morath became Commissioner in 2016, only 3 performance waivers had ever been granted for charter expansion. Under Morath (2016-2024), at least 17 waivers were granted to charter networks with too many failing campuses, and 12 of those 17 led to approved expansions (ProPublica/Texas Tribune, October 2023). KIPP Dallas received a waiver over TEA staff's recommendation to deny. Uplift received waiver #37268 (April 2017) despite failing to meet the standard accountability criteria: highest or second-highest rating for 3 of 5 years, 75% of campuses at that level, no campus at the lowest rating. Prior to 2017, expansion was prohibited if even one campus had the lowest rating; that rule was scrapped.

**Financial monitoring: absent from the record.** PIR #2502721 (TEA, March 2026) requested financial monitoring reports, site visit reports, and compliance audits for ILTexas, Uplift, and IDEA from FY2022 through FY2025. Across all 93 documents produced, zero matched the terms "monitor," "site visit," or "compliance." Either TEA does not conduct financial monitoring of these charter networks, or the records were withheld. A follow-up was filed on March 24, 2026.

**89th Legislature bill status (2025):**

| Bill | Sponsor | Purpose | Outcome |
|---|---|---|---|
| SB 605 | West (D) | Block charter expansion under Ch. 39A enforcement | Passed Senate unanimously; died in House Public Education Committee |
| SB 1750 | Paxton (R) | Higher charter facilities formula (0.15 x BA x ADA) + self-dealing disclosure | Passed Senate; died in House |
| HB 756 | Bernal (D) | Limit charter expansions to once per biennium | Died in committee |
| SB 609 | Paxton (R) | Require charter policy compliance enforcement | Passed Senate; died in House |
| HB 2 | VanDeaver (R) | Main $8.5B education bill; charter facilities at 0.07 x BA (weaker than SB 1750) | Signed into law |
| HB 4687 | various | Charter board liability immunity | Signed into law |

Every charter accountability bill died in the House. Charter-favorable bills passed. SB 605's bill analysis cited IDEA's $100M mismanagement while the network expanded under conservatorship.

**TEA data transparency gap:** Charter expansion amendment decisions after 2013 are invisible in public records. The TEA Waivers Online Report requires a TEAL login (not publicly accessible). Historical expansion amendments are missing from the public pryor.tea.state.tx.us reports. No published approval or denial statistics exist for expansion amendments. IDRA recommended posting amendments within 5 business days; this was never implemented. The In Process Action Report shows only currently pending amendments, not historical decisions. A new PIR was filed on March 24, 2026, targeting all charter expansion amendment decisions from 2013 to present."""

    # Insert before "Legislative framework enabling the loop:"
    anchor_48 = "**Legislative framework enabling the loop:**"
    if not find_replace(conn, 48, anchor_48, step5_insert + "\n\n" + anchor_48, "Step 5"):
        errors.append("Step 5")

    # =========================================================================
    # STEP 6: Update Section 40 "The Duplication Problem"
    # =========================================================================
    print("\n=== STEP 6: Update Section 40 - Facilities funding specifics ===")

    # Insert after "Cleveland stands alone." paragraph
    step6_insert = """The facilities funding data quantifies the disparity. Cleveland ISD's IFA allotment declined from $3.8M ($503/student) in FY20 to $1.4M ($117/student) in FY24, a 77% per-student decline during 58% enrollment growth. The IFA guaranteed yield has been frozen at $35/ADA/penny since 1999; the EDA yield was raised to $40 in 2017 and frozen since. ILTexas receives $0 in IFA and $0 in NIFA because charters are excluded by statute. The Charter Facilities Allotment was capped at ~$73/student until HB 2 (2025) raised it to $372.90/ADA, yielding approximately $1.15M for ILTexas's 3,077 Liberty County students. ILTexas can issue revenue bonds backed by FSP operating revenue through the Charter School Finance Corporation (TEC Ch. 53), but these carry higher interest rates than ISD general obligation bonds and are backed only by future state funding, a less stable guarantee than property tax revenue.

The state created two parallel systems and adequately funded neither. An efficient system would allocate resources to meet the need. Instead, the system splits the need between two entities, each receiving less than what one entity serving all students would require."""

    anchor_40 = "Academic performance is comparable."
    if not find_replace(conn, 40, anchor_40, step6_insert + "\n\n" + anchor_40, "Step 6"):
        errors.append("Step 6")

    # =========================================================================
    # STEP 7: Update Section 108 Glossary
    # =========================================================================
    print("\n=== STEP 7: Update Section 108 - Glossary terms ===")

    glossary_additions = """## Facilities Funding

- **IFA (Instructional Facilities Allotment)**: A state guaranteed yield program under TEC Chapter 46, Subchapter A. The state fills the gap between a district's local revenue and $35/ADA/penny of tax effort. Competitive, appropriation-limited, ranked by wealth per student. Requires a passed bond election as prerequisite. Charters are excluded. The guaranteed yield has been frozen at $35 since 1999.

- **EDA (Existing Debt Allotment)**: An automatic state equalization program under TEC Chapter 46, Subchapter B. Equalizes I&S tax returns on existing GO bond debt at a guaranteed yield of $40/ADA/penny (raised from $35 in 2017, frozen since). Charters receive partial access: the state pays the full entitlement since charters have no property tax base.

- **NIFA (New Instructional Facilities Allotment)**: State funding to help districts equip and operate newly constructed campuses. Charters are excluded.

- **Guaranteed Yield**: The dollar amount per ADA per penny of tax effort that the state guarantees a district will receive. If local property tax revenue falls short of this guarantee, the state pays the difference. The IFA guaranteed yield ($35) has been frozen since 1999. The EDA yield ($40) has been frozen since 2017.

- **CSFC (Charter School Finance Corporation)**: A nonprofit entity authorized under TEC Chapter 53 to issue revenue bonds on behalf of charter schools. CSFC bonds are backed by charter schools' FSP operating revenue, not property taxes. Approximately $4.93B in charter revenue bonds have been issued through EFCs and CSFCs as of 2020.

- **PSF Bond Guarantee**: The Permanent School Fund provides a AAA bond guarantee that reduces interest costs for bond issuers. Available to ISDs since 1983 and to charter schools since 2011. Charter access is capped at their share of total enrollment (~7.86% of PSF capacity).

- **Charter Facilities Allotment**: A per-ADA payment to charter schools for facility costs under TEC 12.106(d). Set at $372.90/ADA under HB 2 (2025). Previously eroded to approximately $73/student under a $60M statewide cap.

- **Revenue Bond**: A bond secured by anticipated revenue (such as state per-pupil funding) rather than property taxes. Charter schools use revenue bonds to finance facility construction without voter approval. Revenue bonds carry higher interest rates than GO bonds because the revenue stream is less secure than a property tax pledge.

## Charter Oversight

- **CSPF (Charter School Performance Framework)**: TEA's framework for evaluating charter school performance, required by TEC 12.1181. Used in renewal and expansion decisions.

- **19 TAC 100.1035**: The Texas Administrative Code rule governing charter expansion amendments. Evaluates only the charter's own performance. Contains no requirement to analyze impact on affected ISDs. TEC 12.1101 requires notification to ISDs and legislators but provides no consultation period, comment mechanism, or requirement that TEA consider the ISD's response.

- **Expedited Renewal (TEC 12.1141(b))**: A streamlined 10-year charter renewal process available to charter schools meeting performance criteria. All three charter networks in this case study (ILTexas, Uplift, IDEA) received expedited renewals with no conditions attached.

- **Commissioner Expansion Waiver**: A waiver granted by the TEA Commissioner allowing a charter network to expand despite failing to meet standard accountability criteria for expansion. Before Commissioner Morath (2016), only 3 waivers had been granted. Under Morath, at least 17 were granted, with 12 leading to approved expansions."""

    if not append_to_section(conn, 108, glossary_additions, "Step 7"):
        errors.append("Step 7")

    # =========================================================================
    # STEP 8: Update Austin Case Study Section 9 "Constitutional Implications"
    # =========================================================================
    print("\n=== STEP 8: Update Austin Section 9 - Waiver + oversight findings ===")

    step8_insert = """**Charter oversight context:** The expansion of KIPP, IDEA, and Harmony in the Austin area occurred within a broader pattern of commissioner-level facilitation. Under Commissioner Morath (2016-2024), at least 17 performance waivers were granted for charter expansion, compared with only 3 in all prior years combined. Twelve of those 17 waivers led to approved expansions (ProPublica/Texas Tribune, October 2023). PIR #2502721 (TEA, March 2026) produced zero financial monitoring reports, site visit records, or compliance audits for any of these three charter networks from FY2022 through FY2025. All three received unconditional expedited 10-year renewals. The expansion process itself, governed by 19 TAC 100.1035, contains no requirement to analyze the impact on affected ISDs. TEC 12.1101 requires notification to ISDs and legislators with no consultation period or comment mechanism. Austin ISD's 2025 decision to close 10 schools occurred without any corresponding reduction in charter enrollment caps."""

    # Insert before "### Conclusion"
    anchor_9 = "### Conclusion"
    if not find_replace(conn, 9, anchor_9, step8_insert + "\n\n" + anchor_9, "Step 8"):
        errors.append("Step 8")

    # =========================================================================
    # STEP 9: Update ARC Case Study - Frozen Weights Parallel
    # Target: Section 334 "The Accountable Costs Precedent: Synthesis"
    # =========================================================================
    print("\n=== STEP 9: Update ARC Section 334 - Frozen yields parallel ===")

    step9_insert = """The at-risk weight is one of three frozen numbers in the Texas school finance system. The IFA guaranteed yield has been frozen at $35/ADA/penny since 1999. The EDA guaranteed yield was raised from $35 to $40 in 2017 and has been frozen since. Statewide IFA appropriations fell 67% over 11 years, from $633M to $208M. In Cleveland ISD, IFA per student dropped 77% (from $503 to $117) between FY20 and FY24 while enrollment grew 58%. The pattern is the same in each case: the Legislature sets a number, never updates it, and lets inflation and population growth erode its value. Three frozen numbers, three decades of legislative neglect, three mechanisms that no longer serve the populations they were designed to protect."""

    # Insert after the last paragraph of section 334
    anchor_334 = "The ARC framework provides the measurement tool the next cost study requires."
    if not find_replace(conn, 334, anchor_334, anchor_334 + "\n\n" + step9_insert, "Step 9"):
        errors.append("Step 9")

    # =========================================================================
    # COMMIT
    # =========================================================================
    if DRY_RUN:
        print("\n" + "=" * 60)
        print("DRY RUN COMPLETE - no changes committed")
        conn.close()
        return

    conn.commit()
    conn.close()

    print("\n" + "=" * 60)
    if errors:
        print(f"COMPLETED WITH {len(errors)} ERRORS: {errors}")
        sys.exit(1)
    else:
        print("ALL STEPS COMPLETED SUCCESSFULLY")


if __name__ == "__main__":
    main()

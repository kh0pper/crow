#!/usr/bin/env python3
"""
populate_chapter_5_houston.py — populate Chapter 5 Houston (Book version) in
the canvas-companion data dashboard with 16 sections built from the 2026-04-25
research at insd-5941/book-research/.

Idempotent: deletes existing sections in the target case study before inserting,
so re-running this script overwrites cleanly.

Run via:
    python3 scripts/populate_chapter_5_houston.py
"""

from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = REPO_ROOT / "canvas-companion" / "db" / "canvas.db"
TARGET_TITLE = "Chapter 5: Houston — Book version"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


SECTIONS = [
    {
        "type": "text",
        "title": "The central irony",
        "content": """In the 2023-24 school year, Phillis Wheatley High School in Houston's Fifth Ward posted a B rating from the Texas Education Agency. The state's first year under its appointed Superintendent Mike Miles and the New Education System he installed produced what looked, on paper, like a turnaround.

The numbers behind the B tell a different story. Wheatley's enrollment had fallen from 741 students the prior year to 616 — a 21 percent drop in twelve months. Teacher attrition at the campus was 32.9 percent in the same year. Across HISD, 4,700 of 11,000 teachers — roughly 43 percent of the district's teaching force — left under NES Year 1.

The B was achieved on a smaller school taught by a less experienced staff. The improvement at Wheatley, viewed against the loss the rating did not measure, is the central irony this chapter examines. It is not unique to Wheatley. The same pattern recurs at Mendez Middle School in Austin ISD, also under Mike Miles's Third Future Schools network, and at every campus where the state's takeover-or-partnership playbook has run its course.

This chapter follows that playbook from its statutory origin in HB 1842 (84th Legislature, 2015), through HISD's six-year takeover litigation, into the NES regime, and out the other side at the SB 1882 partnership rollout that as of April 2026 has expanded to 9 Texas districts and 15 schools — most of them operated by the charter network Mike Miles founded in Colorado in 2016 and incorporated in Texas in 2020.""",
    },
    {
        "type": "text",
        "title": "The takeover trigger — HB 1842 and TEC §39.107",
        "content": """The popular framing of HB 1842 is that five consecutive years of failing accountability ratings automatically trigger state takeover. The actual statutory mechanism, codified at Texas Education Code §39.107(a), is layered and discretionary at every step.

Under the version of §39.107 enacted by HB 1842 (84R, 2015), the Commissioner of Education must order one of two remedies — appointment of a board of managers to govern the district under §39.112(b), or campus closure — when a campus has received an unacceptable performance rating for three consecutive school years AFTER the campus is ordered to submit a campus turnaround plan under §39.107(a). The trigger is not five consecutive ratings. It is three consecutive ratings after a turnaround plan order, which is itself a discretionary state action.

Multiple state decision points lie inside the mechanism: the Commissioner decides whether to issue the turnaround plan order; the agency evaluates the plan for adequacy; the agency evaluates each subsequent year's rating; the agency selects between board-of-managers and campus closure as the remedy. None of this is automatic. The framing of HB 1842 as an automatic trigger obscures who exercises the discretion the statute creates.

That distinction matters because the chapters that follow show the same agency exercising similar discretion in the opposite direction — approving charter expansion, authorizing SB 1882 partnerships with operators of its choosing, and extending its control over districts after triggering the statute its own decisions set in motion.""",
    },
    {
        "type": "text",
        "title": "Wheatley's accountability spiral",
        "content": """Phillis Wheatley High School first received an Improvement Required rating from the Texas Education Agency in 2014-15, the year before HB 1842 was enacted. The rating recurred in 2015-16, 2016-17, and 2017-18. By 2018, when ratings were paused under the Hurricane Harvey provision, Wheatley's underlying domain scores showed Student Achievement IR (raw score 50), School Progress Met Standard (62), and Closing the Gaps IR (raw score 0). The Harvey pause did not change Wheatley's underlying performance — it only deferred the official tally.

The deferred rating arrived in 2018-19. Wheatley posted an overall F rating with a score of 59. The TEA flagged the campus as a "comprehensive support and improvement reidentified school" — confirmation that Wheatley had not exited the federal-state intervention pipeline. All four domains — Student Achievement F (57), School Progress D (68), Closing the Gaps F (50), and Relative Performance F — registered failing scores.

In January 2019, three months after the F rating became official, the TEA opened a Special Accreditation Investigation against HISD citing Wheatley's chronic underperformance and concurrent dysfunction at the elected Board of Trustees. The takeover that the SAI initiated would litigate for four years before reaching the Texas Supreme Court.

Throughout the litigation, Wheatley's trajectory did not improve. After ratings resumed in 2021-22, Wheatley posted a C; in 2022-23, a D. By the time Mike Miles arrived as the state-appointed superintendent in June 2023, Wheatley had been failing for the better part of a decade and the school's enrollment had fallen from 785 students in 2020-21 to 643 in 2022-23.""",
    },
    {
        "type": "chart",
        "title": "Wheatley HS — accountability domain scores 2021-2024",
        "sql": """SELECT
  p.school_year AS "Year",
  'Student Achievement (D1)' AS "Domain",
  p.domain_1_score AS "Score"
FROM campus_tapr_performance p
JOIN campuses c ON p.campus_id = c.id
WHERE c.campus_id = '101912018'
  AND p.subject = 'all_subjects' AND p.student_group = 'all_students'
UNION ALL
SELECT p.school_year, 'School Progress (D2)', p.domain_2_score
FROM campus_tapr_performance p
JOIN campuses c ON p.campus_id = c.id
WHERE c.campus_id = '101912018'
  AND p.subject = 'all_subjects' AND p.student_group = 'all_students'
UNION ALL
SELECT p.school_year, 'Closing the Gaps (D3)', p.domain_3_score
FROM campus_tapr_performance p
JOIN campuses c ON p.campus_id = c.id
WHERE c.campus_id = '101912018'
  AND p.subject = 'all_subjects' AND p.student_group = 'all_students'
ORDER BY 1, 2""",
        "config": {
            "type": "line",
            "xCol": "Year",
            "yCol": "Score",
            "groupCol": "Domain",
            "description": "Wheatley HS domain scores under TEA's A-F accountability system, 2021-22 through 2023-24. The 2023-24 column is the first year under Mike Miles's NES regime; D2 (School Progress) jumped from 70 to 85 while enrollment fell 21 percent year-over-year and teacher attrition at the campus reached 32.9 percent.",
        },
    },
    {
        "type": "text",
        "title": "Enrollment loss and demographic profile",
        "content": """The "improvement" at Wheatley in 2023-24 was measured on a school that was rapidly shrinking. From 2020-21 to 2024-25, total enrollment fell from 785 students to 537 — a loss of 31.6 percent over five years. The biggest single-year drop, 13 percent, came in 2022-23, the year before Miles's NES launch; the second biggest, 4 percent, came in 2023-24, the first year under NES; and the trend continued into 2024-25, when Wheatley fell another 13 percent to 537 students.

Demographically, the school did not change. Across all five years, Wheatley remained 95 to 97 percent economically disadvantaged, 19 to 23 percent English Language Learners, and 19 to 20 percent students with disabilities. The at-risk percentage — TEA's composite indicator of academic need — sat between 67 and 82 percent across the panel. The students who left did not skew toward the lowest-performing or highest-need population. The school just got smaller while keeping the same demographic mix.

That detail matters for any defense of the rating bump on selection-effect grounds. If the B in 2023-24 had been driven by lower-performing students leaving, the demographic profile would have shifted as the more challenging students disappeared from the rolls. It did not. The rating moved on a population whose composition stayed constant; it moved because the rating's denominator shrunk.""",
    },
    {
        "type": "chart",
        "title": "Wheatley HS — enrollment and at-risk profile 2020-2025",
        "sql": """SELECT a.school_year AS "Year",
  'Total enrollment' AS "Metric",
  a.total_students AS "Value"
FROM campus_arc_factors a
JOIN campuses c ON a.campus_id = c.id
WHERE c.campus_id = '101912018'
ORDER BY 1, 2""",
        "config": {
            "type": "line",
            "xCol": "Year",
            "yCol": "Value",
            "groupCol": "Metric",
            "description": "Wheatley HS total enrollment 2020-21 through 2024-25 from TEA campus_arc_factors. Loss of 248 students (-31.6%) across the five-year panel. The 2023-24 column is the year Wheatley posted a B rating under NES Year 1.",
        },
    },
    {
        "type": "text",
        "title": "The takeover process — Morath, the injunction, the Supreme Court",
        "content": """In January 2019, three months after Wheatley's 2018-19 F rating, the Texas Education Agency under Commissioner Mike Morath opened a Special Accreditation Investigation of Houston ISD. The SAI cited Wheatley's chronic accountability failure and concurrent dysfunction at the elected HISD Board of Trustees as predicates for state intervention under TEC Chapter 39A.

HISD sued. In January 2020, a Travis County district court granted the District a temporary injunction halting Morath's planned appointment of a board of managers; the Texas Court of Appeals upheld the injunction in 2021. In 2023, citing a 2021 statutory amendment that took effect after the case had been filed, the Texas Supreme Court overturned the injunction and held that the District "failed to demonstrate that the Commissioner and his conservator's planned conduct violates the law." The Court did not reach the constitutional merits of whether the takeover comported with the Article VII §1 standard articulated in *Edgewood v. Kirby* and *Morath v. Texas Taxpayer and Student Fairness Coalition*. That question remains open for a future challenge.

On June 1, 2023, Morath appointed Mike Miles as Superintendent of Houston ISD. Miles had founded Third Future Schools — a Colorado-based charter network — in 2016, after his tenure as Superintendent of Dallas ISD ended in 2015. TFS-Texas was incorporated in 2020. By the time Miles arrived in Houston, TFS-Texas had a charter authorization in place and was poised to expand under the very Senate Bill 1882 partnership program TEA would soon use to extend its reach into other Texas districts.""",
    },
    {
        "type": "text",
        "title": "NES outcomes — the playbook timeline",
        "content": """Within twelve months of Miles's June 2023 appointment, 4,700 of HISD's roughly 11,000 teachers had left the district — an attrition rate of approximately 43 percent. The exodus was driven by the NES program's signature features: scripted instruction, mandatory daily classroom observations, removal of librarians, and a performance-pay scheme tied to standardized-test outcomes. Those who stayed often did so on hardship terms; those who left took their experience and institutional memory with them.

The teaching workforce that produced Wheatley's B rating in 2023-24 was, in significant part, not the workforce that had produced its preceding decade of F ratings. The improvement reflected, at minimum, a different staff teaching a different (smaller) student body under a different curriculum.

In November 2024, HISD voters rejected Miles's proposed $4.4 billion bond by a 58-percent margin — the largest bond rejection in HISD history and an unmistakable rebuke of NES. Houston Public Media described the vote as "an unofficial referendum of state takeover." Miles, the state-appointed Superintendent, was unaccountable to the Houston voters who rejected him.

By 2024-25 (NES Year 2), HISD had lost another 7,382 students; the district enrollment had fallen from 196,943 in 2020-21 to 176,727 — a loss of 20,216 students, or 10.3 percent, over five years. The NES era's enrollment loss accelerated, rather than stabilized, after the takeover.

The figure below charts the playbook from 2014's Dallas Home Rule petition through April 2026's HISD SB 1882 expansion.

![Houston playbook timeline](/static/img/houston_playbook_timeline.png)""",
    },
    {
        "type": "chart",
        "title": "HISD district enrollment 2020-2025",
        "sql": """SELECT a.school_year AS "Year",
  'HISD enrollment' AS "Series",
  a.total_students AS "Value"
FROM arc_factors a
JOIN districts d ON a.district_id = d.id
WHERE d.tea_id = '101912'
ORDER BY 1""",
        "config": {
            "type": "line",
            "xCol": "Year",
            "yCol": "Value",
            "groupCol": "Series",
            "description": "Houston ISD total enrollment 2020-21 through 2024-25 from TEA arc_factors. Loss of 20,216 students (-10.3%) over five years. The 2023-24 and 2024-25 columns are NES Year 1 (-5,825 students) and NES Year 2 (-7,382 students); the post-takeover decline accelerates rather than stabilizing.",
        },
    },
    {
        "type": "text",
        "title": "118 non-HISD campuses inside HISD's geographic boundary",
        "content": """The takeover narrative frames Houston ISD's failures as failures of the elected board, the prior superintendents, and the schools themselves. It does not address the regulatory environment in which those failures accrued.

In April 2026, an intersection of NCES EDGE 2024-25 public-school point geocodes with HISD's geographic boundary identifies 118 non-HISD-operated campuses physically inside the District's polygon, across 51 distinct operating LEAs. Among the operators with the largest footprints inside HISD: KIPP Texas (24 campuses), YES Prep (12), Harmony Public Schools (3), Houston Gateway Academy (3), Varnett School (3), Ripley House / Baker-Ripley (5), IDEA Hardy (2), and ILTexas Houston Orem (2). Forty-three additional operators run one or two campuses each; together they account for 69 of the 118 non-HISD campuses inside HISD's boundary.

Compared to the 273 HISD-operated campuses in the same polygon, the 118 non-HISD campuses represent approximately 30 percent of total public-school options inside HISD's geography. That share has grown across two decades of state-authorized charter expansion. Each charter campus required a state authorization; each authorization was a discretionary act by the State Board of Education or the Texas Education Agency.

The takeover's accountability case against HISD did not consider how the State's own charter-authorization policy contributed to the conditions HISD was supposed to remedy. Whether the takeover comports with *Edgewood*'s "efficient system" standard turns, in significant part, on the regulatory environment the State itself had constructed.

![118 non-HISD campuses inside HISD polygon](/static/img/houston_charters_in_hisd.png)""",
    },
    {
        "type": "text",
        "title": "SB 1882 — the partnership pipeline at HISD",
        "content": """On October 31, 2025 — twenty-eight months after Miles's appointment — HISD announced that four of its highest-rated magnet high schools would seek SB 1882 partnership operators for the 2026-27 school year. The four campuses were Kinder High School for the Performing and Visual Arts (HSPVA), Challenge Early College High School, Houston Academy for International Studies, and Energy Institute High School. A fifth partnership covered HISD's pre-K program in collaboration with the nonprofit Collaborative for Children.

On March 26, 2026, HISD's state-appointed Board of Managers approved all five partnerships unanimously. Three more high-performing campuses — Carnegie Vanguard, DeBakey for Health Professions, and Eastwood Academy — remained under evaluation.

On April 15, 2026, Miles announced a framework expanding SB 1882 eligibility to all HISD campuses rated A or B — more than 20 of the District's 270-plus schools. The pipeline that had begun with four high-performing magnets was now positioned, by Miles's own design, to absorb the District's entire top performance tier.

Two members of the elected HISD Board of Trustees pushed back on the record. Trustee Maria Benzon told Houston Public Media that "Superintendent Miles could grant autonomy today, without chartering, without someone else controlling budgets, curriculum and policy but he chooses not to." She accused Miles of using SB 1882 to "placate families at high achieving [schools]" and to "charter out the district." State-appointed Board of Managers member Angela Lemond Flowers — Miles's nominal superior — asked whether the autonomy expansion would lead to "more partnerships with charter school networks," and whether the cumulative effect would be "a monster that a board cannot manage."

The framing in HISD reporting throughout 2025-26 has been of school choice expansion. The framing from inside the elected board has been of district-level extraction. Both framings describe the same policy mechanism.""",
    },
    {
        "type": "text",
        "title": "The Mendez Middle (Austin ISD) comparator",
        "content": """The enrollment-cut and rating-bump pattern that Wheatley produced in NES Year 1 is not a Houston anomaly. The same operator — Mike Miles's Third Future Schools — produced the same pattern at Mendez Middle School in Austin ISD two years earlier.

Mendez had been rated F by TEA every year since 2013. Austin ISD entered its first SB 1882 partnership for Mendez with the T-STEM Coalition in 2018-19; AISD trustees voted unanimously to end that partnership in December 2021 after three years of continued poor ratings. On March 24, 2022, AISD approved Third Future Schools as the new SB 1882 partner. TFS's stated trajectory at Mendez committed to a D rating in 2022-23, a C in 2023-24, and a B in 2024-25 and 2025-26 — a steady upward arc.

The actual outcome diverged. In TFS Year 1 (2022-23), Mendez posted not a D but a B — overshooting the contract by two letter grades. The B was achieved on enrollment that fell from 498 students in 2021-22 to 223 in 2022-23 — a single-year drop of 55.2 percent. In TFS Year 2 (2023-24), the rating fell to C (regression rather than the contract's promised C), and enrollment declined to 203 students. By 2024-25, Mendez held 199 students — down from 573 in 2020-21, a five-year loss of 65.3 percent.

As at Wheatley, the demographic profile across the cut was largely unchanged: at-risk percentage between 86 and 89 percent, economically disadvantaged 90 to 97 percent, ELL 54 to 61 percent. The school did not become less needy as it became smaller. Its 31.8 percent teacher attrition in TFS Year 2 (2023-24) is comparable to Wheatley's 32.9 percent in NES Year 1.

The B in TFS Year 1 was a one-year peak, not a trajectory. The contract's later-year goals — sustained B in 2024-25 and 2025-26 — fell to C in 2023-24 with no evidence as of the writing of this chapter that 2024-25's rating will rise back to B. The "improvement" looks identical to Wheatley's: a rating bump achieved on a smaller school that lost half or more of its students in a single year while keeping its high-need profile.

The chapter's central irony, in other words, is reproducible. It is not specific to Wheatley, to NES, or even to HISD. It is a property of the operator and the SB 1882 program itself.""",
    },
    {
        "type": "chart",
        "title": "Mendez Middle (Austin ISD) — enrollment 2020-2025",
        "sql": """SELECT a.school_year AS "Year",
  'Mendez Middle' AS "Series",
  a.total_students AS "Value"
FROM campus_arc_factors a
JOIN campuses c ON a.campus_id = c.id
WHERE c.campus_id = '227901058'
ORDER BY 1""",
        "config": {
            "type": "line",
            "xCol": "Year",
            "yCol": "Value",
            "groupCol": "Series",
            "description": "Mendez Middle School (Austin ISD) total enrollment 2020-21 through 2024-25 from TEA campus_arc_factors. The 2022-23 drop (498 → 223) is the single-year decline coinciding with TFS taking over operation under SB 1882. Enrollment fell 65.3% across the five-year panel.",
        },
    },
    {
        "type": "text",
        "title": "The multi-district pattern — TFS expansion across Texas",
        "content": """By April 2026, Third Future Schools-Texas operated or was set to operate campuses in seven Texas school districts. According to Community Voices for Public Education's April 10, 2026 reporting, nine school districts have agreed or are agreeing to hand 15 public schools to TFS-Texas under SB 1882.

San Antonio ISD: TFS will operate three middle schools starting fall 2026 (Texas Public Radio, March 24, 2026).

Edgewood ISD (San Antonio): The Edgewood ISD Board of Trustees voted 6 to 1 on March 24, 2026 to hand Brentwood Middle School to TFS under a three-year SB 1882 partnership. The District's stated rationale, on the record: Brentwood had received failing ratings for three consecutive years and District leaders feared a fourth would prompt state intervention. The constitutional irony of this vote should not be lost. Edgewood ISD is the same plaintiff district that won *Edgewood v. Kirby* in 1989, establishing the Article VII §1 "efficient system" standard that the rest of this book applies. Thirty-seven years after that constitutional victory, Edgewood ISD is privatizing one of its schools to a charter network founded by the TEA commissioner-appointee running HISD.

Waco ISD: Texas Tribune reported on March 30, 2026 that TFS is taking over additional schools.

Austin ISD: On March 27, 2026, the AISD Board of Trustees voted unanimously to hand three more middle schools — Dobie, Webb, and Burnet — to a different SB 1882 operator, the Texas Council for International Studies. The board's stated rationale, recorded by KUT: each of the three schools had received four consecutive failing accountability ratings, and "a fifth failing rating would trigger state intervention — the education commissioner could close the school or appoint a board of managers, replacing the elected school board and diminishing local control." The vote came days before the March 31 deadline to apply to TEA's Texas Partnerships program.

Fort Worth ISD: TEA announced a takeover under TEC Chapter 39A in October 2025. According to Texas AFT's October 31, 2025 analysis, the takeover came after Fort Worth ISD had reduced its number of F-rated campuses from 31 to 11 and the District had earned a B+ overall rating; TEA retroactively altered accountability metrics in a manner that returned the District to takeover-eligibility.

Districts opting for partnership over takeover have made the calculus explicit: the partnership is preferable not because it improves outcomes, but because it preserves at least nominal local control. The mechanism in either direction — partnership or takeover — channels the same set of campuses into the same set of operators, primarily TFS-Texas. The state retains discretion at every step of the channeling.""",
    },
    {
        "type": "text",
        "title": "Constitutional analysis — *Edgewood*-extension and state-induced harm",
        "content": """The Article VII §1 obligation that *Edgewood v. Kirby* (1989) and *Morath v. Texas Taxpayer and Student Fairness Coalition* (Tex. 2016) impose runs to the State. The State must operate an "efficient system" of public free schools. *Morath* identified three substantive standards for that obligation: adequacy (output-based), financial efficiency (equal access per tax effort), and suitability (structural soundness). All three apply at the system level — they are tests of how the State has organized its school system, not of how individual districts have performed under it.

The pattern this chapter has documented does not fit cleanly into any of the three standards as articulated. It is not a question of inadequate funding (the takeover is followed by *more* state-allocated dollars, in the form of SB 1882 partnership bonuses of $1,200 to $1,400 per student). It is not a question of unequal access per tax effort (charter schools are state-funded directly, bypassing the local-property-tax mechanism). It is a question of *structural soundness* — *Morath*'s third standard — applied to the regulatory mechanisms of charter authorization, accountability sanction, and partnership procurement.

Three doctrinal lines bear on the question. First, the *Edgewood-extension* argument: the disparities the litigation series targeted were state-caused via the State's funding choices, not market-caused. The same logic, applied to the present case, treats the disparities induced by SB 1882 partnership concentration in TFS-aligned operators as state-caused via the State's authorization choices, not market-caused. The mechanism has changed; the locus of state action has not.

Second, the state-induced-harm doctrine identified in *Heckler v. Community Health Services of Crawford County* (467 U.S. 51, 1984) and its progeny: an agency cannot enforce sanctions arising from conditions the agency itself produced. Applied to the present case, the State cannot premise a takeover under TEC §39.107 on accountability outcomes the State's own charter-authorization decisions helped produce.

Third, the *fiduciary-breach* analogy (drawn from administrative-trust doctrine rather than from any binding case): the State as trustee of "an efficient system" under Article VII §1 cannot simultaneously authorize competition for trust property (charter campuses inside an ISD's geography) and foreclose on the District as failing to remedy the conditions the competition produces. To my knowledge, no prior Texas case has raised any of these three doctrinal arguments in the configuration this chapter applies them.

That is the chapter's original contribution. The pattern is documented. The doctrinal frame is novel. The litigation that follows from this analysis is for another book.""",
    },
    {
        "type": "text",
        "title": "Conclusion — the playbook in the elected board's own words",
        "content": """The strongest evidence that the manufactured-consent reading of SB 1882 is not a critic's frame is that the school boards using SB 1882 describe it that way themselves.

When the Austin ISD Board of Trustees voted on March 27, 2026 to hand Dobie, Webb, and Burnet middle schools to the Texas Council for International Studies, the publicly stated rationale was not that the partnership would improve student outcomes. It was that "all three schools have received four consecutive failing accountability ratings... A fifth failing rating would trigger state intervention — the education commissioner could close the school or appoint a board of managers, replacing the elected school board and diminishing local control." The board's own framing of the vote, recorded by KUT.

The Edgewood ISD Board of Trustees, voting on Brentwood Middle School three days earlier, gave the same rationale. So did the HISD Board of Managers when approving the four-magnet, one-pre-K partnership package on March 26, 2026. The mechanism is no longer being defended on the merits of school improvement; it is being defended on the merits of takeover avoidance, which is to say on the basis of the very statutory threat the State controls.

That is what state-induced consent looks like. It does not require coercion in the classical sense. It requires only a threat — automatic-seeming but actually discretionary, channeled through statutory triggers the agency itself activates and resolves — and a route around the threat that the agency has prepared in advance. The State sets the trigger, the State approves the partner, the State funds the partnership, and the State narrows the route until only one path remains.

What the chapter has documented is the State of Texas operating that mechanism across at least seven of its districts. What remains for legislative or judicial address is whether *Edgewood*'s "efficient system" standard tolerates the mechanism. Five chapters into this book, the answer should be apparent.""",
    },
]


def main() -> int:
    if not DB_PATH.exists():
        print(f"[error] DB not found at {DB_PATH}")
        return 1

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    # Find target case study
    target = conn.execute(
        "SELECT id FROM case_studies WHERE title = ?", (TARGET_TITLE,)
    ).fetchone()
    if target is None:
        print(f"[error] case study '{TARGET_TITLE}' not found; create the shell first")
        return 1
    cs_id = target["id"]
    print(f"[target] CS{cs_id} '{TARGET_TITLE}'")

    # Idempotent: clear existing sections
    n_existing = conn.execute(
        "SELECT COUNT(*) FROM case_study_sections WHERE case_study_id = ?", (cs_id,)
    ).fetchone()[0]
    if n_existing:
        conn.execute("DELETE FROM case_study_sections WHERE case_study_id = ?", (cs_id,))
        conn.commit()
        print(f"[clear] deleted {n_existing} existing section(s)")

    # Insert all sections
    now = now_iso()
    for i, s in enumerate(SECTIONS):
        config_json = json.dumps(s.get("config")) if s.get("config") else None
        conn.execute(
            """INSERT INTO case_study_sections
               (case_study_id, section_type, sort_order, title, content, sql, config,
                created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                cs_id,
                s["type"],
                i,  # sort_order = sequential 0-15
                s.get("title"),
                s.get("content"),
                s.get("sql"),
                config_json,
                now,
                now,
            ),
        )
    conn.commit()
    conn.execute(
        "UPDATE case_studies SET updated_at = ? WHERE id = ?", (now, cs_id)
    )
    conn.commit()
    print(f"[ok] inserted {len(SECTIONS)} sections")

    # Verify
    rows = conn.execute(
        """SELECT sort_order, section_type, title FROM case_study_sections
           WHERE case_study_id = ? ORDER BY sort_order""",
        (cs_id,),
    ).fetchall()
    print(f"\n[verify] {len(rows)} sections in CS{cs_id}:")
    for r in rows:
        print(f"  {r['sort_order']:>2}  [{r['section_type']:5}]  {r['title']}")

    conn.close()
    print(f"\n[view] http://10.0.0.39:8080/data/case-studies/{cs_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
populate_chapter_1_san_antonio.py — populate Chapter 1: San Antonio (Book version)
in the canvas-companion data dashboard with 12 sections covering the Edgewood
litigation history, the constitutional framework that flows from it, and a tease
of the modern Edgewood ISD case that sets up Chapter 5's analysis.

Source material: Cardenas (1997, IDRA) sections 1-2, 7, 8-11; modern Edgewood ISD
(TEA 015905) and Brentwood Middle (campus 015905041) panel data from
texas-gov-data-mcp/data/tea_data.db.

Idempotent: deletes existing sections in the target case study before inserting.

Run via:
    python3 scripts/populate_chapter_1_san_antonio.py
"""

from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = REPO_ROOT / "canvas-companion" / "db" / "canvas.db"
TARGET_TITLE = "Chapter 1: San Antonio — Book version"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


SECTIONS = [
    # 0
    {
        "type": "text",
        "title": "Where the constitutional standard begins",
        "content": """Every chapter that follows in this book applies a single Texas constitutional standard to a single Texas school district. The standard is the "efficient system" obligation Article VII §1 imposes on the State of Texas: "A general diffusion of knowledge being essential to the preservation of the liberties and rights of the people, it shall be the duty of the Legislature of the State to establish and make suitable provision for the support and maintenance of an efficient system of public free schools." The contemporary content of that standard — what "efficient system" requires of the State, and how courts measure compliance — was litigated in the *Edgewood* series, which ran from 1989 through 1995, was reaffirmed and partially narrowed in *Morath v. Texas Taxpayer and Student Fairness Coalition* (Tex. 2016), and is the foundation on which every constitutional argument in the rest of this book rests.

The Edgewood plaintiffs were not abstract litigants. They were a coalition of property-poor school districts led by Edgewood Independent School District in San Antonio's West Side. The district's per-pupil disparities relative to its wealthier Bexar County neighbors — the gap between the public schools available to West Side children and those available to children in Alamo Heights or Northside — were the empirical foundation of the constitutional case the Texas Supreme Court accepted in 1989.

Chapter 1 traces that case from the disparities Cardenas (1997, IDRA) documented in the decades preceding the litigation, through the four Edgewood opinions and the Senate bills they generated, to the *Morath* (2016) ruling that established the contemporary three-part standard the rest of the book applies. The chapter closes with a brief tease of where modern Edgewood ISD sits in 2026 — at the receiving end of an SB 1882 partnership that hands one of its middle schools to the same charter network operating in Houston ISD under state takeover. The full treatment of modern Edgewood is reserved for a future companion volume; this chapter introduces it as a constitutional irony the rest of the book unwinds.""",
    },
    # 1
    {
        "type": "text",
        "title": "The Texas system before Rodriguez (1950-1973)",
        "content": """José A. Cárdenas's *Texas School Finance Reform: An IDRA Perspective* (1997) documents the system Texas operated for the first century of the Republic and the early decades of the modern public school. By the early 1970s, Texas had committed itself to a school finance system whose principal feature was extreme local-property-tax dependence — a structure that produced and entrenched the disparities the Edgewood litigation eventually targeted.

The empirical baseline Cárdenas establishes for Texas in the early 1970s is striking. By 1972-73, Texas ranked 40th in the country in per-pupil expenditures at $778 per pupil, compared to 1st-ranked New York's $1,584 — a gap of more than two-to-one. By 1980-81 Texas had moved to 39th; by 1982-83, on the eve of the Edgewood litigation, it had slipped to 43rd. The interstate comparison was, on its own terms, a problem. The intrastate comparison was significantly worse.

Within Texas, Cárdenas documents the disparities through specific district pairings. In 1983-84, the year before HB 72's reforms went into effect, Alamo Heights ISD — Bexar County's wealthiest school district — had a per-pupil expenditure of $3,650. Edgewood ISD, the same county's poorest district, had a per-pupil expenditure of $2,202. After HB 72's first year of implementation, Alamo Heights rose to $4,031 per pupil; Edgewood to $3,090. In Cárdenas's analysis, "only 35 percent of the disparity had been eliminated."

The structural mechanism that produced the disparity — and that no legislative reform through HB 72 had addressed — was local enrichment. In 1985-86, Alamo Heights and Edgewood had nearly identical local property-tax rates: $0.567 per $100 valuation in Alamo Heights and $0.563 per $100 in Edgewood. That tax effort produced $1,613 per pupil in local enrichment in Alamo Heights and $92 per pupil in local enrichment in Edgewood. With state-matched enrichment of $557, Edgewood reached a total of $647 per pupil in enrichment funds — compared to Alamo Heights's $1,613. Two-and-a-half times more enrichment, on identical tax rates.

By Cárdenas's account, "After 12 years of pursuing equity in the Texas Legislature, there was no other alternative for low wealth school districts but to turn to the courts."
""",
    },
    # 2
    {
        "type": "text",
        "title": "Rodriguez v. San Antonio ISD (1973): the federal door closes",
        "content": """The first attempt to litigate the disparities was federal. Demetrio Rodriguez, the named plaintiff in *San Antonio Independent School District v. Rodriguez*, sued in federal court arguing that Texas's school finance system violated the Fourteenth Amendment's Equal Protection Clause by denying children in property-poor districts equal access to public education. A three-judge district court agreed and ruled the system unconstitutional. The State appealed to the U.S. Supreme Court.

On March 21, 1973, the Supreme Court reversed the lower court's ruling 5-4 in *San Antonio Independent School District v. Rodriguez*, 411 U.S. 1. Justice Lewis Powell, writing for the majority, held that education is not a fundamental right under the U.S. Constitution and that the Texas school finance system's disparities, however severe, did not constitute the kind of suspect classification that triggers strict-scrutiny review. The federal door, in other words, was closed.

What the *Rodriguez* opinion did not foreclose was state-court litigation under state-constitutional standards. Cárdenas describes the strategic implications of the ruling: the *Rodriguez* outcome left state courts as the only available forum for school-finance equity litigation, and the Texas state constitution's "efficient system" clause in Article VII §1 became the available vehicle. Sixteen years would pass before that vehicle was used at scale. During those sixteen years, the disparities the Edgewood plaintiffs would eventually litigate widened.""",
    },
    # 3
    {
        "type": "text",
        "title": "The pivot to state court — and Edgewood v. Bynum / Edgewood v. Kirby",
        "content": """The state-court vehicle was *Edgewood ISD v. Bynum*, filed in the early 1980s but held in abeyance during Ross Perot's School Committee on Public Education (SCOPE) and the subsequent HB 72 reforms. When HB 72 failed to close the property-wealth disparities, the Edgewood plaintiffs reactivated the litigation. By 1987 the case was *Edgewood ISD v. Kirby*, named for then-Texas Education Commissioner William Kirby, and proceeding before Judge Harley Clark in a Travis County state district court.

In April 1988, Judge Clark ruled that the State's school finance system violated Article VII §1 of the Texas Constitution. The ruling was reversed by the Texas Court of Appeals in December 1989 — the appellate panel held that "efficient system" was a political question not suitable for judicial review, finding the disparities real but not justiciable.

The Court of Appeals reversal was narrowly procedural and contained an admission worth quoting in full. The majority wrote: "The system does not provide an ideal education for all students nor a completely fair distribution of tax benefits and burdens among all of the school patrons. Nevertheless, under our system of government, efforts to achieve those ideals come from the people through constitutional amendments and legislative enactments and not through judgments of courts." The court conceded the inequities while denying their justiciability — a position the Texas Supreme Court would reject six months later when it reviewed the case.""",
    },
    # 4
    {
        "type": "text",
        "title": "Edgewood I (1989): the \"efficient system\" holding",
        "content": """In March 1989 the Texas Supreme Court agreed to hear the appeal. Oral arguments were presented on July 5, 1989. On October 2, 1989, the Court issued its opinion in what is now universally cited as *Edgewood I* — *Edgewood Independent School District v. Kirby*, 777 S.W.2d 391 (Tex. 1989) — unanimously holding that the State's school finance system violated Article VII §1.

The Court's holding established the framework on which every subsequent Texas school-finance case has been decided. Cárdenas reproduces the operative passage:

> The system, which is neither efficient nor efficient in the sense of providing for a general diffusion of knowledge statewide, ... violates Article VII, Section 1 of the Texas Constitution. There must be a direct and close correlation between a district's tax effort and the educational resources available to it. In other words, a district must have substantially equal access to similar revenues per pupil at similar levels of tax effort. Children who live in poor districts and children who live in rich districts must be afforded substantially equal opportunity to have access to educational funds. (*Edgewood I*, quoted in Cárdenas 1997, sec. 9)

Two features of the holding bear directly on the chapters that follow. First, the Court refused to specify a remedy. "Although we have ruled the school financing system to be unconstitutional, we do not now instruct the legislature as to the specifics of the legislation it should enact; nor do we order it to raise taxes. The legislature has the primary responsibility to decide how to best achieve an efficient system." The Court reserved to itself only the power to evaluate, after the fact, whether legislative responses satisfied the constitutional mandate.

Second, the Court closed with what Cárdenas characterizes as "a stern warning": "However, let there be no misunderstanding. A remedy is long overdue. The legislature must take immediate action."

The legislature did act. Whether its action constituted compliance with *Edgewood I* was the question that produced *Edgewood II*, *III*, and *IV*.""",
    },
    # 5
    {
        "type": "text",
        "title": "Edgewood II–IV (1991-1995): the legislative response",
        "content": """The four-case Edgewood series tracks the iterative back-and-forth between the Texas Supreme Court and the Texas Legislature over the meaning and implementation of the "efficient system" standard. Each opinion responded to a specific legislative attempt to comply with the previous one.

***Edgewood II*** (*Edgewood ISD v. Kirby*, 804 S.W.2d 491, Tex. 1991) reviewed Senate Bill 1, the legislature's 1990 response to *Edgewood I*. The Court held SB 1 inadequate. SB 1's reforms shifted some of the local-property-tax base toward equalization but preserved the wealth disparities the Court had targeted. *Edgewood II* tightened the standard, adding requirements that the State's funding mechanism actually produce — not just nominally pursue — substantially equal access at comparable tax effort.

***Edgewood III*** (*Carrollton-Farmers Branch ISD v. Edgewood ISD*, 826 S.W.2d 489, Tex. 1992) addressed the legislature's next attempt — Senate Bill 351, which created Education County Districts (CEDs) to consolidate property tax bases across district lines. The Court held CEDs unconstitutional under Article VII §1's prohibition on a state property tax. The legislature was forced back to the drawing board.

***Edgewood IV*** (*Edgewood ISD v. Meno*, 917 S.W.2d 717, Tex. 1995) was the constitutional resting point of the original litigation. The Court reviewed Senate Bill 7 (1993), which introduced what is sometimes called the "Robin Hood" recapture mechanism — a system requiring property-wealthy districts to share revenue with property-poor districts above a per-pupil wealth threshold. *Edgewood IV* upheld SB 7's recapture mechanism as constitutional, ending the original litigation series with a system that had been substantially restructured (though, as Cárdenas's analysis throughout sections 11-12 of his book documents, was already exhibiting the strain that would prompt later litigation).

The four-case sequence established two principles for any subsequent Texas school-finance challenge. First, the constitutional standard is genuinely justiciable — the *Edgewood I* Court rejected the appellate court's "political question" framing and declared itself willing to review legislative compliance. Second, the standard is iterative — the legislature does not get the last word on what the constitution requires. Both principles apply, with full force, to the contemporary takeover and partnership programs the rest of this book examines.""",
    },
    # 6
    {
        "type": "text",
        "title": "Morath v. TTSFC (2016): \"ossified\" but constitutional",
        "content": """Twenty-one years after *Edgewood IV*, the Texas Supreme Court returned to the constitutional standard in *Morath v. Texas Taxpayer and Student Fairness Coalition*, 490 S.W.3d 826 (Tex. 2016). The case had been brought by a coalition of school districts (including Edgewood ISD, again) and the Equity Center challenging the 83rd Legislature's funding decisions, particularly the 2011 funding cuts that reduced state aid by $5.4 billion. The trial court found the system unconstitutional under Article VII §1's adequacy and financial-efficiency standards. The State appealed.

The Texas Supreme Court reversed. The Court held the system, as configured by the 83rd Legislature, *was* constitutional — in the narrow sense that it did not, on the evidence presented, fall below the floor *Edgewood* established. But the *Morath* Court was sharply critical of the system's design, calling it "ossified" and "ill-suited for 21st-century Texas." The opinion identified three substantive standards by which Article VII §1 compliance is measured: **adequacy** (output-based — whether the system produces a "general diffusion of knowledge"), **financial efficiency** (whether districts have substantially equal access to similar revenues per pupil at similar levels of tax effort, the *Edgewood I* core), and **suitability** (structural soundness — whether the system as a whole is "well-adapted" to the State's constitutional duty).

For the chapters that follow, the *Morath* three-part framework is the operative test. *Adequacy* asks whether the State's outputs (test scores, graduation rates, postsecondary readiness) are sufficient. *Financial efficiency* asks whether the funding mechanism (state aid + recapture + local property tax) provides comparable access to comparable resources at comparable tax effort. *Suitability* asks whether the structural design of the system — including its accountability sanctions, its charter-authorization decisions, and its partnership programs — is rationally adapted to the constitutional duty.

The chapters that follow apply those three tests, in varying combinations, to Dallas (Chapter 2), Austin (Chapter 3), Cleveland (Chapter 4), and Houston (Chapter 5). The argument the chapters share is that the *suitability* prong, in particular, has not been seriously tested against the contemporary regulatory mechanisms of takeover, partnership, and charter authorization. The *Edgewood*-extension and *Morath*-suitability arguments those chapters develop are the constitutional contributions this book offers.""",
    },
    # 7
    {
        "type": "text",
        "title": "Modern Edgewood ISD — at the brink",
        "content": """Thirty-seven years after *Edgewood I* established the constitutional standard the rest of this book applies, Edgewood ISD itself is at the edge of state intervention. The next two charts and the closing sections of this chapter document the modern position of the District whose plaintiff history defines the constitutional terrain.

Edgewood ISD's contemporary enrollment is 7,849 students (2024-25), down from 9,152 in 2020-21 — a five-year loss of 14.2 percent. The District remains overwhelmingly high-need: 77 to 79 percent at-risk and 89 to 94 percent economically disadvantaged across the panel; English Language Learner percentage rising from 22.6 to 25.2 percent. The demographic profile is the same Cárdenas described in 1997 — a property-poor, high-need urban district in San Antonio's West Side. What has changed is the regulatory environment around the District, which now includes accountability sanctions, charter expansion authorizations, and SB 1882 partnership obligations that *Edgewood I* did not address because they did not yet exist.""",
    },
    # 8
    {
        "type": "chart",
        "title": "Edgewood ISD enrollment 2020-2025",
        "sql": """SELECT a.school_year AS "Year",
  'Edgewood ISD' AS "Series",
  a.total_students AS "Value"
FROM arc_factors a
JOIN districts d ON a.district_id = d.id
WHERE d.tea_id = '015905'
ORDER BY 1""",
        "config": {
            "type": "line",
            "xCol": "Year",
            "yCol": "Value",
            "groupCol": "Series",
            "description": "Edgewood ISD (Bexar County, San Antonio West Side) total enrollment 2020-21 through 2024-25. Loss of 1,303 students (-14.2%) over five years. The District remains 89-94% economically disadvantaged and 77-79% at-risk across the panel — the same demographic profile the Edgewood litigation targeted in 1989.",
        },
    },
    # 9
    {
        "type": "chart",
        "title": "Brentwood Middle (Edgewood ISD) — pre-TFS panel 2020-2025",
        "sql": """SELECT a.school_year AS "Year",
  'Brentwood Middle' AS "Series",
  a.total_students AS "Value"
FROM campus_arc_factors a
JOIN campuses c ON a.campus_id = c.id
WHERE c.campus_id = '015905041'
ORDER BY 1""",
        "config": {
            "type": "line",
            "xCol": "Year",
            "yCol": "Value",
            "groupCol": "Series",
            "description": "Brentwood Middle School (Edgewood ISD, campus 015905041) enrollment 2020-21 through 2024-25 from TEA campus_arc_factors. Pre-TFS panel: 715 → 750 → 600 → 558 → 602. Accountability ratings on file: Not Rated (2021-22), D (2022-23), F (2023-24). Three consecutive failing-or-functionally-failing years preceded the March 24, 2026 board vote handing the school to Third Future Schools-Texas under SB 1882.",
        },
    },
    # 10
    {
        "type": "text",
        "title": "March 24, 2026 — Brentwood to Third Future Schools",
        "content": """On March 24, 2026, the elected Edgewood ISD Board of Trustees voted 6 to 1 to enter a three-year SB 1882 partnership handing Brentwood Middle School to Third Future Schools-Texas, the charter network founded by Mike Miles in Colorado in 2016 and incorporated in Texas in 2020. The partnership will take effect for the 2026-27 school year. The District's stated rationale, recorded by Texas Public Radio's March 25 reporting: Brentwood had received failing ratings for three consecutive years (Not Rated 2021-22, D 2022-23, F 2023-24), and District leaders worried a fourth would prompt state intervention under TEC §39.107.

The constitutional irony of this vote is the central image of the modern Edgewood story. The district that won *Edgewood v. Kirby* in 1989 — establishing the Article VII §1 "efficient system" standard the rest of this book applies — is now privatizing one of its middle schools to a charter network whose founder is the state-appointed Superintendent of Houston ISD, a district under takeover triggered by the same TEC §39.107 mechanism Edgewood ISD voted to avoid. Thirty-seven years separate the constitutional victory from the contemporary partnership vote. The mechanism the State of Texas has constructed in those thirty-seven years now operates against the District that won the original constitutional case.

The full treatment of contemporary Edgewood ISD — including the post-2026 trajectory of the TFS partnership at Brentwood, and the operating record of TFS at Mendez Middle in Austin ISD that gives the partnership its empirical context — belongs in a future companion volume that builds out a single-district case study of San Antonio. Chapter 5 of this book uses Brentwood as a multi-district pattern data point and cross-references the constitutional analysis from this chapter. The full Brentwood-and-Edgewood story is reserved.

Chapter 1 closes here, with the District at the threshold of an SB 1882 partnership it described its way into to avoid a worse alternative. The chapters that follow apply the constitutional framework this chapter has constructed — the *Edgewood I* "efficient system" standard, the *Morath* three-part adequacy/efficiency/suitability test — to four other districts whose contemporary positions illuminate, in turn, what the State of Texas has done with the regulatory mechanisms the Edgewood Court did not address.""",
    },
    # 11
    {
        "type": "text",
        "title": "How the constitutional standard applies to the rest of this book",
        "content": """Each of the five chapters that follow applies the *Edgewood*/*Morath* framework. The first four are district case studies; the fifth is a statewide statistical analysis. The Conclusion (Chapter 7) translates the constitutional argument into legislative reform.

**Chapter 2 (Dallas)** examines the Teacher Excellence Initiative, the Teacher Incentive Allotment that scaled it statewide, and the political-action-committee-funded governance pipeline that produced both. The constitutional question is whether a state incentive-funding system that systematically rewards already-advantaged campuses (the *suitability* prong) and increases funding asymmetries between districts (the *financial efficiency* prong) comports with the *Edgewood* standard.

**Chapter 3 (Austin)** examines the duplicative charter footprint that has accumulated inside Austin ISD's geography across two decades — KIPP, IDEA, Harmony — and the SB 1882 partnership that came to Mendez Middle in 2022 and to Dobie/Webb/Burnet in 2026. The constitutional question is whether state-authorized charter expansion in a property-poor district (the *suitability* prong, again, applied to the regulatory choice the State makes when authorizing a charter inside an ISD's service area) comports with the *Edgewood* standard.

**Chapter 4 (Cleveland)** examines the bond-election mechanism by which Texas school districts must finance their own facilities, and the failure of that mechanism in Cleveland ISD across three consecutive bond elections in 2021-2023. The constitutional question is whether a State that has placed facility funding on the local-property-tax mechanism — and that authorizes charter expansion (ILTexas) inside that District at the same time — has provided "substantially equal access to similar revenues per pupil at similar levels of tax effort" (the *Edgewood I* test).

**Chapter 5 (Houston)** examines the takeover mechanism (HB 1842, TEC §39.107), the NES regime imposed under it, and the SB 1882 partnership pipeline that has expanded across at least seven Texas districts as of April 2026. The constitutional question is whether the State, in operating both the takeover mechanism and the partnership pipeline simultaneously and channeling them through a single charter operator network (TFS-Texas), is operating an "efficient system" or a public-to-private extraction conveyor.

**Chapter 6 (ARC / Statewide Analysis)** moves from district-level case studies to a statewide regression. It develops the at-risk-coefficient (ARC) framework — an empirically derived weighting structure for at-risk students grounded in contemporary PEIMS data — and quantifies the gap between the State's frozen 1984 weights and what contemporary student-need composition would require. The chapter's central finding is a $2.28 billion statewide funding gap that the State's current weighting system fails to deliver. The constitutional question is whether the *adequacy* prong of *Morath* survives a measurement system whose statutory weights were last calibrated when the at-risk percentage of Texas public-school students was less than half what it is today.

**Chapter 7 (Conclusion)** addresses the legislative reforms that flow from the constitutional analysis. The argument it builds — that Article VII §1 requires structural change to the takeover mechanism, the SB 1882 program, the charter authorization process, and the at-risk weighting structure — is the policy correlate of the doctrinal argument the case-study and statewide chapters develop together.

The thread that runs through all six chapters is the *suitability* prong of *Morath* — the constitutional standard the *Edgewood* Court articulated as Article VII §1's structural test, but which has not yet been seriously applied to the contemporary regulatory mechanisms the chapters examine. That is the book's constitutional contribution. Edgewood ISD's plaintiff status in the original case is a reminder of where the standard came from. Edgewood ISD's contemporary partnership vote is a reminder of why the standard still matters.""",
    },
]


def main() -> int:
    if not DB_PATH.exists():
        print(f"[error] DB not found at {DB_PATH}")
        return 1

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    target = conn.execute(
        "SELECT id FROM case_studies WHERE title = ?", (TARGET_TITLE,)
    ).fetchone()
    if target is None:
        print(f"[error] case study '{TARGET_TITLE}' not found")
        return 1
    cs_id = target["id"]
    print(f"[target] CS{cs_id} '{TARGET_TITLE}'")

    n_existing = conn.execute(
        "SELECT COUNT(*) FROM case_study_sections WHERE case_study_id = ?", (cs_id,)
    ).fetchone()[0]
    if n_existing:
        conn.execute("DELETE FROM case_study_sections WHERE case_study_id = ?", (cs_id,))
        conn.commit()
        print(f"[clear] deleted {n_existing} existing section(s)")

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
                i,
                s.get("title"),
                s.get("content"),
                s.get("sql"),
                config_json,
                now,
                now,
            ),
        )
    conn.commit()
    conn.execute("UPDATE case_studies SET updated_at = ? WHERE id = ?", (now, cs_id))
    conn.commit()
    print(f"[ok] inserted {len(SECTIONS)} sections")

    rows = conn.execute(
        "SELECT sort_order, section_type, title FROM case_study_sections WHERE case_study_id = ? ORDER BY sort_order",
        (cs_id,),
    ).fetchall()
    print(f"\n[verify] {len(rows)} sections in CS{cs_id}:")
    for r in rows:
        print(f"  {r['sort_order']:>2}  [{r['section_type']:5}]  {r['title']}")
    conn.close()
    print(f"\n[view] http://10.0.0.39:8080/data/present/{cs_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

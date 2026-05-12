#!/usr/bin/env python3
"""
populate_chapter_6_conclusion.py — reframe Chapter 6: Conclusion (CS21,
cloned from CS14) for the book's legislative-reform-advocacy voice.

What changes:
- §0 "Answering the Research Questions" (capstone-frame) is REPLACED by a new
  §0 synthesizing across the 5 case-study chapters.
- §1-§4 are PRESERVED verbatim (the existing CS14 content reads as advocacy):
    §1 The State Takeover as Constitutional Violation
    §2 Scientism as Ideology: The Epistemological Failure
    §3 From Frozen Weights to Student-Level Funding
    §4 Edgewood ISD Deferred Maintenance (chart)
- §5 "The 90th Legislature" is preserved but lightly extended.
- §6-§8 are NEW — legislative reform agenda, constitutional litigation path,
  Maestro Press / coalition tie-in.

Reads §1-§5 content from /tmp/cs21_sections/ which were saved by an earlier
sqlite3 export step (so this script is reproducible).

Idempotent: deletes existing CS21 sections before inserting.

Run via:
    python3 scripts/populate_chapter_6_conclusion.py
"""

from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = REPO_ROOT / "canvas-companion" / "db" / "canvas.db"
PRESERVED_DIR = Path("/tmp/cs21_sections")
TARGET_TITLE = "Chapter 7: Conclusion — Book version"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_preserved(idx: int) -> dict:
    """Load preserved section from temp files."""
    title = (PRESERVED_DIR / f"sec_{idx}_title.txt").read_text().strip()
    stype = (PRESERVED_DIR / f"sec_{idx}_type.txt").read_text().strip()
    content = (PRESERVED_DIR / f"sec_{idx}_content.txt").read_text()
    if content.endswith("\n"):
        content = content[:-1]
    out = {"type": stype, "title": title, "content": content if stype == "text" else None}
    if stype == "chart":
        sql_path = PRESERVED_DIR / f"sec_{idx}_sql.txt"
        cfg_path = PRESERVED_DIR / f"sec_{idx}_config.txt"
        out["sql"] = sql_path.read_text().strip() if sql_path.exists() else None
        out["config_raw"] = cfg_path.read_text().strip() if cfg_path.exists() else None
        out["content"] = None
    return out


# Build the full section list
SECTIONS = []

# 0 — NEW synthesis across the 5 case-study chapters
SECTIONS.append({
    "type": "text",
    "title": "What the case studies show, taken together",
    "content": """Six chapters in the body of this book — five district case studies plus a statewide statistical analysis — each applying the *Edgewood/Morath* framework to a different mechanism. The chapters can be read separately, but their argument is single. The State of Texas, in its current configuration, does not operate an "efficient system" of public free schools as Article VII §1 requires.

In **Dallas (Chapter 2)**, the Teacher Excellence Initiative — an incentive-pay structure introduced under PAC-funded local governance in 2012 — became the Teacher Incentive Allotment when HB 3 (2019) scaled it statewide. The TIA's per-pupil distribution does not track student need; it tracks already-advantaged teaching environments. The mechanism amplifies pre-existing disparities rather than equalizing them.

In **Austin (Chapter 3)**, two decades of state-authorized charter expansion have built a duplicative footprint inside Austin ISD's geography. The 2022 SB 1882 partnership at Mendez Middle and the 2026 expansion to Dobie, Webb, and Burnet middle schools document the same pattern Houston Chapter 5 documents at Wheatley HS: enrollment collapses by half in a single year, ratings bump, demographic profile stays constant, the school becomes a different operator's. Mendez's TFS contract promised a steady upward trajectory (D → C → B → B); it delivered an overshoot then a regression (Not Rated → B → C). The improvement was enrollment-driven, not instruction-driven.

In **Cleveland (Chapter 4)**, the bond-election mechanism failed three consecutive times (2021, 2022, 2023) in a district whose enrollment grew 41 percent over the same period. The State did not provide equalization aid against the bond capacity disparity. The State did, however, authorize parallel charter expansion — ILTexas — that drew enrollment without contributing to the local-tax base. The result: a 12,500-student district whose schools operate on portable buildings and split shifts while a 3,000-seat charter sits across town with 100-percent state-funded facilities.

In **Houston (Chapter 5)**, the takeover under HB 1842 (2015 → 2023 SCOTX clearance → June 2023 Miles appointment) cleared the path for the most aggressive deployment of the SB 1882 partnership pipeline yet observed. By April 2026, nine Texas districts had agreed to hand 15 public schools to Third Future Schools-Texas — the charter network founded by the State-appointed Superintendent of Houston ISD in 2016 — under partnership agreements channeled through TEA's authorization mechanism. The State, simultaneously, was operating the takeover trigger, the partnership program, the operator-approval gate, and the funding incentive. Districts opted into partnership not because the partnership was projected to improve outcomes (the Mendez record refutes that) but to avoid takeover. The Austin ISD Board of Trustees stated this rationale on the record on March 27, 2026.

In **San Antonio (Chapter 1)**, the constitutional anchor — Edgewood ISD itself, plaintiff in the *Edgewood I* case that established the standard — voted on March 24, 2026 to hand Brentwood Middle School to Third Future Schools under SB 1882. The same district that won the 1989 constitutional victory privatized one of its middle schools to a charter network whose founder is the State-appointed superintendent of HISD. Thirty-seven years separate the constitutional victory from the partnership vote.

In **the statewide ARC analysis (Chapter 6)**, the regression across all ~1,200 Texas districts quantifies what the case studies illustrate at the campus and district level. The compensatory-education weight (frozen at 0.20 in TEC §48.104 since 1984) and the bilingual weight (0.10 in §48.105 since 1984) deliver $2.28 billion less in annual funding than empirically derived weights would. The three-bucket recalibration developed in the chapter — separate weights for elementary, middle, and high school cohorts — recovers what the frozen weights miss. The same weighting failure that produces the funding gap statewide produces the local-district shortfalls that the case studies document. The pattern is not idiosyncratic to any single district; it is structural.

What the case studies and the statewide analysis show, taken together: the Texas regulatory mechanisms developed since *Edgewood IV* (1995) — accountability sanctions, charter authorization, SB 1882 partnerships, TIA, and the frozen at-risk weighting structure that underpins the entire foundation school program — operate as a coherent extraction system. The State sets the trigger; the State approves the operator; the State funds the partnership; the State weights the foundation allotment; the State narrows the alternatives until only one path remains. The system is internally consistent. Whether it is constitutionally compliant under *Edgewood/Morath* is the argument the next sections build.""",
})

# 1-5 preserved
for i in range(1, 6):
    s = load_preserved(i)
    SECTIONS.append(s)

# 6 — NEW legislative reform agenda
SECTIONS.append({
    "type": "text",
    "title": "A legislative-reform agenda for the 90th Legislature",
    "content": """The 90th Texas Legislature convenes in January 2027. The reforms below are the policy correlates of the constitutional argument the case-study chapters develop. Each is targeted at a specific mechanism the chapters identify; each can be enacted as a stand-alone bill or bundled into omnibus legislation.

**1. Recalibrate the at-risk weights.** The compensatory education weight (0.20) and bilingual education weight (0.10) have been frozen in TEC §48.104 and §48.105 since 1984. The empirical relationship between contemporary student-need composition and academic outcomes is documented across Chapter 6 (ARC / Statewide Analysis) — including the three-bucket validation, the $2.28 billion statewide funding gap, and the proposed regression-derived weights — and synthesized in this chapter's §3 (*From Frozen Weights to Student-Level Funding*). The reform: amend TEC §48.104 and §48.105 to require that the weights be recalculated from PEIMS data every five legislative sessions, with the recalculated values published to TEA by July 1 of the year preceding the relevant biennium. Use the ARC regression methodology — or its statutorily mandated equivalent — as the recalibration tool. Add the chronic absenteeism weight, the homeless weight, and the foster care weight as separate program-area weights at empirically derived rates.

**2. Restructure the SB 1882 partnership program.** The program in its current form (TEC §11.174) creates a unilateral channel for districts to hand campuses to operators TEA approves. The reform: amend §11.174 to require (a) public posting of all proposed performance contracts with no less than 60 days' public comment before approval; (b) operator-pool transparency, including TEA's complete approval rubric and a list of all operators TEA has rejected with stated reasons; (c) a sunset clause — performance contracts terminating automatically after three years unless renewed by elected board vote, not by TEA fiat; (d) a bar on partnerships at campuses where the operator's principals or their immediate family hold financial interests in the district's vendors or related entities; (e) a clawback provision recovering excess state funding from operators who underperform their contract goals.

**3. Cap charter expansion in failing-rated districts.** The State Board of Education currently authorizes charter expansion without geographic constraint. The reform: amend TEC §12.110 to prohibit expansion amendments that add charter capacity inside an ISD's geographic boundary if that ISD has any campus rated F (or its equivalent under future accountability rubrics) in the prior school year, without first conducting a public hearing in the affected ISD with mandatory written findings on the constitutional and educational implications.

**4. Restructure the takeover trigger to require judicial review.** TEC §39.107(a) currently delegates to the Commissioner of Education the discretionary judgment of whether takeover is warranted. The reform: amend §39.107(a) to require that the Commissioner's takeover order be reviewable de novo in district court within 30 days of issuance, with the burden of proof on the State to demonstrate that takeover is the least restrictive remedy available. The reform should also require the Commissioner to make written findings on the State's own contribution (through prior charter authorizations, prior accountability methodology decisions, etc.) to the conditions cited as the basis for takeover.

**5. Establish a state facility allotment.** Texas is one of a handful of states without state funding for school facility construction. The reform: enact a state Facility Equalization Allotment that provides matching aid for ISD bond-funded construction at districts with taxable property wealth below a per-pupil threshold (e.g., $300,000 per WADA). Fund the allotment from the Permanent School Fund's investment income or from the recapture pool, depending on legislative preference.

**6. Restrict TIA distribution by district need profile.** TEC §48.112 does not currently constrain TIA distribution by district student-need composition. The reform: amend §48.112 to require that no district may receive more than 1.5x its proportional share of TIA allotments, where "proportional share" is computed by district enrollment weighted by ARC student-need score. The reform addresses the existing pattern (documented in Chapter 2 Dallas) under which TIA allotments concentrate in already-advantaged districts.

These six reforms do not, individually, satisfy the *Edgewood/Morath* "efficient system" obligation. Taken together, they substantially restructure the regulatory mechanisms that this book has documented as failing the constitutional standard. Each reform can be drafted, costed, and enacted as a stand-alone bill in the 90th Legislature; each is amenable to amendment or piecemeal adoption. The argument throughout the book is that the constitutional standard requires structural change to the system. These reforms are the policy correlate of that argument.""",
})

# 7 — NEW constitutional litigation path
SECTIONS.append({
    "type": "text",
    "title": "The constitutional litigation path",
    "content": """Legislative reform is not the only available path. The *Edgewood/Morath* line of cases established that the Article VII §1 obligation is justiciable — the Texas Supreme Court rejected the appellate-court "political question" framing in 1989 and has not revisited it since. A future plaintiff coalition can bring a constitutional challenge to the regulatory mechanisms this book has documented.

The strongest available challenge would frame the mechanisms — accountability sanctions, charter authorization, SB 1882 partnerships, TIA distribution — as a single coordinated system that fails the *Morath* three-part test. The empirical record in this book provides material for each prong. The *adequacy* prong is addressed by the case-study chapters' documentation of declining outputs at takeover-and-partnership campuses (Wheatley enrollment loss; Mendez rating regression). The *financial efficiency* prong is addressed by the bond-election failure pattern (Cleveland), the EDA asymmetry (Austin), and the TIA distribution pattern (Dallas). The *suitability* prong — the structural-soundness test that this book contends has not been seriously applied to the contemporary mechanisms — is addressed across all five chapters.

The plaintiff coalition for such a challenge would, on the *Edgewood* model, need to span property-poor districts with overlapping geographic charter expansion, districts under or threatened with takeover, and districts whose TIA allocations underperform their student-need profile. The Equity Center, IDRA, MALDEF, and Texas AFT all maintain organizational capacity for this kind of litigation. The Texas State Teachers Association and the Houston Federation of Teachers are also natural coalition members.

The doctrinal contribution this book offers is the *Edgewood-extension* argument and the *state-induced-harm* argument the Houston chapter develops. Both are doctrinally novel applications of established Texas constitutional principles. Whether they prevail at the Texas Supreme Court depends on the Court's composition and the strength of the empirical record. The empirical record is strengthened by every additional case study, which is one of several reasons for the book's geographic scope.

Litigation is slow. In the *Edgewood* series, more than six years elapsed between the original *Edgewood I* ruling and the *Edgewood IV* affirmance of the recapture mechanism that produced the modern system. The 90th Legislature will have completed two regular sessions before any 2027-filed challenge reaches a Texas Supreme Court decision. Both paths — legislative reform and constitutional litigation — should be pursued simultaneously, on overlapping but distinct timelines.""",
})

# 8 — NEW Maestro Press + coalition tie-in
SECTIONS.append({
    "type": "text",
    "title": "Coalition organizing — Maestro Press and the path forward",
    "content": """The arguments in this book are not academic exercises. They are the empirical and doctrinal foundation for ongoing organizing work that is happening, as of this writing, in every metropolitan area Texas's school finance system serves.

The Equity Center has tracked Texas school finance reform from before *Edgewood I* and continues to maintain the most reliable cross-district funding analyses in the State. IDRA, founded by José Cárdenas and home to the historical record this book draws on, has maintained continuous research and advocacy on Texas school finance for fifty years. Texas AFT and the Houston Federation of Teachers have organized teachers across the takeover and SB 1882 partnership campuses and have produced the on-the-ground reporting that grounds the case-study chapters. MALDEF has carried the federal civil rights litigation that complements the state constitutional work. Community Voices for Public Education, in Houston, has documented the Board of Managers period in real time. KUT, Houston Public Media, Texas Tribune, San Antonio Report, and Texas Observer have provided the journalistic record that the case studies cite throughout.

Maestro Press exists as the publication and distribution arm for the research synthesis this book represents. The case-study chapters in this volume will be released as installments through the Maestro Press blog and as standalone briefing papers to legislators, district administrators, advocacy organizations, and journalists. The data dashboards that ground the empirical claims — including the contemporary versions of the case-study material, with PIR responses integrated as they arrive — will remain publicly accessible at Maestro Press's data dashboard for ongoing reference and for use by the coalition organizations.

The reader of this book has two natural next steps. First, identify the case study most relevant to the reader's own district or service area, and engage that case study against the reader's own observations and data. Second, engage with one or more of the coalition organizations named above as they develop the legislative-reform briefing materials and the litigation record for the 90th Legislature and any subsequent constitutional challenge.

The case studies in this book are five of many that could be written. The constitutional standard the State of Texas operates under — Article VII §1's "efficient system" obligation — has not yet been applied to the contemporary mechanisms the State has constructed. The work of applying it, in court and in the Legislature, is ahead. This book is one contribution to that work.""",
})


def main() -> int:
    if not DB_PATH.exists():
        print(f"[error] DB not found at {DB_PATH}")
        return 1
    if not PRESERVED_DIR.exists():
        print(f"[error] preserved sections dir not found at {PRESERVED_DIR}")
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
        if s["type"] == "chart":
            sql = s.get("sql")
            config = s.get("config_raw")  # already serialized JSON string
        else:
            sql = None
            config = None

        conn.execute(
            """INSERT INTO case_study_sections
               (case_study_id, section_type, sort_order, title, content, sql, config,
                created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (cs_id, s["type"], i, s.get("title"), s.get("content"),
             sql, config, now, now),
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

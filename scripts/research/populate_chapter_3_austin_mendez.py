#!/usr/bin/env python3
"""
populate_chapter_3_austin_mendez.py — append Mendez Middle / TFS partnership
sections to "Chapter 3: Austin — Book version" (CS19). The original CS1 Austin
case study (cloned to CS19 in Phase 1) was written before the SB 1882 partnership
pipeline arrived in Austin in March 2026; these new sections document the
post-2025 expansion as an addition to the existing chapter.

Idempotent: deletes any existing sections at sort_order >= 30 before re-inserting.
Sections at sort_order 0-29 (the cloned CS1 content) are untouched.

Run via:
    python3 scripts/populate_chapter_3_austin_mendez.py
"""

from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = REPO_ROOT / "canvas-companion" / "db" / "canvas.db"
TARGET_TITLE = "Chapter 3: Austin — Book version"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


SECTIONS = [
    # sort_order 30
    {
        "type": "text",
        "title": "Post-2025 update — the SB 1882 partnership pipeline arrives in Austin",
        "content": """The original draft of this chapter was written before March 2026, when the SB 1882 partnership pipeline that Chapter 5 documents at Houston ISD reached Austin ISD. The remainder of this chapter documents that arrival as a post-script: the pattern is no longer a Houston-only phenomenon, and Austin ISD has now joined the districts using SB 1882 partnerships either to bring in operators from outside the District (Mendez Middle School, 2022-Present) or to escape a state takeover threat (Dobie, Webb, Burnet middle schools, 2026-03-27 vote).

Two facts make Austin ISD's experience particularly instructive for the constitutional analysis. First, AISD has had Third Future Schools — the same Colorado-founded charter network that Mike Miles brought to Houston ISD as the appointed Superintendent — operating Mendez Middle School under SB 1882 since 2022. Mendez gives us four years of operating history, which is more than Houston has yet produced under NES; the rating-bump-while-school-shrinks pattern Chapter 5 demonstrates at Wheatley HS first appeared at Mendez two years earlier. Second, AISD's March 27, 2026 expansion to three more middle schools was approved by the elected Board of Trustees with a publicly stated rationale of avoiding state takeover under TEC §39.107. The board's framing of the partnership vote — recorded by KUT — is the strongest direct evidence that SB 1882 functions as a coercion mechanism rather than a school-improvement program.""",
    },
    # sort_order 31
    {
        "type": "text",
        "title": "Mendez Middle — TFS as Austin's first SB 1882 partner",
        "content": """Mendez Middle School in Southeast Austin (campus 227-901-058) had been rated F by the Texas Education Agency every year since 2013. Austin ISD's first attempt at an SB 1882 partnership for Mendez began in the 2018-19 school year with the T-STEM Coalition, a Texas-based STEM-curriculum nonprofit. AISD trustees voted unanimously to end the T-STEM partnership in December 2021 after three years of continued poor ratings.

On March 24, 2022, AISD approved Third Future Schools (TFS) as the new SB 1882 operator for Mendez. TFS had been founded by Mike Miles in 2016 in Colorado, after Miles's tenure as Dallas ISD Superintendent ended in 2015; TFS-Texas had been incorporated in 2020. The performance contract Miles brought to AISD committed to a specific rating trajectory: D in 2022-23, C in 2023-24, B in 2024-25, and B again in 2025-26 — a steady upward arc.

Miles arrived at Mendez fifteen months before he arrived at HISD, which makes Mendez a useful comparator for the patterns Chapter 5 documents at Wheatley HS. The two campuses share an operator, an SB 1882 partnership structure, and — as the next two sections show — the same enrollment-cut and rating-bump signature.""",
    },
    # sort_order 32
    {
        "type": "chart",
        "title": "Mendez Middle — enrollment 2020-2025",
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
            "description": "Mendez Middle enrollment 2020-21 through 2024-25 from TEA campus_arc_factors. The 2022-23 column is TFS Year 1 — the year enrollment fell from 498 to 223 (-55.2% in a single year). Five-year cumulative loss: 65.3%. The school's demographic profile (87-89% at-risk, 90-97% economically disadvantaged) stays largely constant across the cut.",
        },
    },
    # sort_order 33
    {
        "type": "text",
        "title": "TFS contract trajectory vs. actual outcome",
        "content": """The chart above shows the enrollment side of the partnership story. The accountability-rating side reveals the rest of the irony: TFS overshot its Year 1 contract goal by two full letter grades and then regressed in Year 2, on enrollment that had fallen by half.

| School year | Phase | Contract commitment | Actual rating | Domain scores (D1 / D2 / D3) | Total enrollment |
|---|---|---|---|---|---|
| 2020-21 | Pre-TFS (T-STEM) | (n/a) | (no rating) | — | 573 |
| 2021-22 | T-STEM exit | (n/a) | Not Rated | 52 / 59 / 69 | 498 |
| 2022-23 | TFS Year 1 | **D** | **B** | 60 / 89 / 89 | **223** |
| 2023-24 | TFS Year 2 | **C** | **C** | 60 / 79 / 77 | 203 |
| 2024-25 | TFS Year 3 | **B** | (TAPR not yet released) | — | 199 |

A B in TFS Year 1 is not what the contract promised. A C in TFS Year 2 is what the contract promised — but as a regression from the Year 1 peak rather than a continuation of the upward trajectory. As of 2024-25, when the contract committed to a B, enrollment has fallen another 4 students to 199, and TAPR has not yet released the rating that will resolve whether the trajectory has indeed turned back upward.

The B in 2022-23 was achieved on a school whose enrollment had fallen 55 percent from the prior year. The student demographic profile across the cut was largely unchanged: at-risk percentage 87-89 percent, economically disadvantaged 90-97 percent, English Language Learners 54-61 percent. The students who left did not skew toward the lowest-performing or highest-need population. The school just got smaller while keeping the same demographic mix — exactly the pattern Chapter 5 documents at Wheatley HS one year later.""",
    },
    # sort_order 34
    {
        "type": "text",
        "title": "March 27, 2026 — Dobie, Webb, Burnet to Texas Council for International Studies",
        "content": """On March 27, 2026, the elected AISD Board of Trustees voted unanimously to approve a three-year SB 1882 partnership for three more middle schools — Dobie, Webb, and Burnet — with the Texas Council for International Studies (TCIS), a different SB 1882 operator from TFS. The vote came four days before the March 31 TEA application deadline for the Texas Partnerships program.

The board's publicly stated rationale, recorded by KUT in its March 27 reporting, was takeover avoidance:

> All three schools have received four consecutive failing accountability ratings based largely on standardized testing scores. A fifth failing rating would trigger state intervention — the education commissioner could close the school or appoint a board of managers, replacing the elected school board and diminishing local control. (KUT, 2026-03-27)

Trustee Kathryn Whitley Chu, quoted in the same KUT report, characterized the timeline:

> I feel confident that this will be accepted. It is hard to have something at the last-minute deadline but I would rather have something thoughtful brought to the board, that is good for the community, than something rushed.

Superintendent Matias Segura, also quoted:

> After spending time with the partners and understanding their structure, having conversations with the staff at these schools, meeting with principals, I am confident this partner and this iteration will help us be successful.

What both quotes share is that the partnership is not being defended on the merits of school improvement. It is being defended on the merits of takeover avoidance — which is to say, on the basis of the very statutory threat the State of Texas controls. The State sets the trigger via §39.107; the State approves the SB 1882 operator; the State funds the partnership at $1,200-$1,400 per student above standard formula. The District, in turn, chooses the partner not from a market of equally weighted options but under a clock the State runs.

The framing — "to avoid state takeover" — is the manufactured-consent argument stated by the elected school board itself, not by critics or outside observers. Chapter 5 makes the constitutional case that flows from this admission. This chapter notes that Austin ISD has now joined the districts to which the case applies.""",
    },
    # sort_order 35
    {
        "type": "text",
        "title": "Cross-reference — the playbook reproduces in Houston",
        "content": """The same operator at the same statutory mechanism produced the same outcome at Wheatley HS in HISD's 2023-24 NES Year 1 that it produced at Mendez Middle in AISD's 2022-23 TFS Year 1. The pattern is reproducible.

For the full Houston treatment of the playbook — including the 118 non-HISD campuses inside HISD's geographic boundary, the SB 1882 expansion to four magnet high schools and a pre-K partnership in March 2026, Mike Miles's April 2026 announcement extending eligibility to all A- and B-rated HISD schools, and the constitutional analysis applying *Edgewood*'s "efficient system" standard to the multi-district pattern — see Chapter 5 of this book.

The Mendez data first surfaced as a comparator during the 2026-04-25 research session that produced Chapter 5. What Chapter 5 calls the "central irony" — a B rating on a school that had lost a third of its students in twelve months — appeared earlier and more sharply at Mendez (a B on a school that had lost more than half its students in twelve months). The Houston case study cites Mendez as evidence that the pattern is not unique to Houston. This chapter inverts the citation: the Austin case study cites Houston as evidence that the pattern, once established at Mendez, did not stay in Austin.""",
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

    # Idempotent: clear sections at sort_order >= 30 (preserves cloned CS1 content at 0-29.9)
    n_existing = conn.execute(
        "SELECT COUNT(*) FROM case_study_sections WHERE case_study_id = ? AND sort_order >= 30",
        (cs_id,),
    ).fetchone()[0]
    if n_existing:
        conn.execute(
            "DELETE FROM case_study_sections WHERE case_study_id = ? AND sort_order >= 30",
            (cs_id,),
        )
        conn.commit()
        print(f"[clear] deleted {n_existing} existing section(s) at sort_order >= 30")

    now = now_iso()
    for i, s in enumerate(SECTIONS):
        sort_order = 30 + i
        config_json = json.dumps(s.get("config")) if s.get("config") else None
        conn.execute(
            """INSERT INTO case_study_sections
               (case_study_id, section_type, sort_order, title, content, sql, config,
                created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                cs_id,
                s["type"],
                sort_order,
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
    print(f"[ok] inserted {len(SECTIONS)} new sections (sort_order 30-{30+len(SECTIONS)-1})")

    # Verify
    rows = conn.execute(
        """SELECT sort_order, section_type, title FROM case_study_sections
           WHERE case_study_id = ? AND sort_order >= 30
           ORDER BY sort_order""",
        (cs_id,),
    ).fetchall()
    print(f"\n[verify] new sections in CS{cs_id}:")
    for r in rows:
        print(f"  {r['sort_order']:>2}  [{r['section_type']:5}]  {r['title']}")

    total = conn.execute(
        "SELECT COUNT(*) FROM case_study_sections WHERE case_study_id = ?",
        (cs_id,),
    ).fetchone()[0]
    print(f"\n[total] CS{cs_id} now has {total} sections")
    conn.close()
    print(f"[view] http://10.0.0.39:8080/data/present/{cs_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
houston_build_timeline.py — render the Texas charterization-playbook timeline
figure that anchors the Houston-investigation chapter.

Two-panel matplotlib figure:
- Top panel: event swimlanes (legislative, Wheatley accountability, HISD takeover,
  NES era, SB 1882 multi-district expansion) along a 2014-2026 horizontal axis.
- Bottom panel: HISD and Wheatley enrollment trends 2020-2025 (the data behind
  the "rating improved while school shrank" central irony), pulled from the
  longitudinal panel CSV.

Output: insd-5941/book-research/figures/houston_playbook_timeline.png

Run via the texas-gov-data-mcp .venv (which has matplotlib via geopandas deps):
    ~/spring-2026/texas-gov-data-mcp/.venv/bin/python \\
        ~/crow/scripts/research/houston_build_timeline.py
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

import matplotlib.dates as mdates
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch
from datetime import date

REPO_ROOT = Path(__file__).resolve().parent.parent
PANEL_CSV = REPO_ROOT / "insd-5941" / "book-research" / "data" / "houston_longitudinal_panel.csv"
OUTPUT_PNG = REPO_ROOT / "insd-5941" / "book-research" / "figures" / "houston_playbook_timeline.png"
OUTPUT_PNG.parent.mkdir(parents=True, exist_ok=True)


# ── Event data ─────────────────────────────────────────────────────────────

# Each event: (date, label, lane, marker_color)
# Lanes (top to bottom on chart, but laid out by lane index 0..N-1):
LANES = [
    "Legislative / doctrinal",
    "Wheatley accountability",
    "State-takeover process",
    "NES era",
    "SB 1882 multi-district expansion",
]
LANE_COLORS = {
    0: "#1f4e79",  # navy — legislative
    1: "#c00000",  # red — accountability
    2: "#7030a0",  # purple — takeover
    3: "#ed7d31",  # orange — NES
    4: "#385723",  # green — SB 1882
}

EVENTS = [
    # Lane 0 — legislative / doctrinal
    (date(2015, 1, 20), "Dallas Home Rule\npetition fails", 0),
    (date(2015, 6, 19), "HB 1842 enacted\n(TEC §39.107 trigger)", 0),
    (date(2016, 5, 13), "Morath v. TTSFC:\nsystem \"ossified\"", 0),
    (date(2017, 6, 1), "SB 1882 enacted\n(partnership mechanism)", 0),

    # Lane 1 — Wheatley accountability (single events; period drawn as bar)
    (date(2018, 8, 15), "Harvey-paused\n(underlying IR)", 1),
    (date(2019, 8, 15), "F (score 59)", 1),
    (date(2024, 8, 15), "B in NES Yr 1\n(33% attrition)", 1),

    # Lane 2 — State-takeover process (HISD + FWISD)
    (date(2019, 1, 15), "TEA SAI opens\n(HISD)", 2),
    (date(2023, 1, 13), "SCOTX clears\nHISD takeover", 2),
    (date(2023, 6, 1), "Miles appointed", 2),
    (date(2025, 10, 1), "FWISD takeover\nannounced", 2),

    # Lane 3 — NES era
    (date(2024, 6, 1), "4,700 / 11,000\nteachers depart", 3),
    (date(2024, 11, 5), "HISD $4.4B bond\nfails (58% no)", 3),

    # Lane 4 — SB 1882 multi-district expansion
    (date(2026, 3, 24), "Edgewood + SAISD:\n4 schools → TFS", 4),
    (date(2026, 3, 26), "HISD BOM approves\n5 partnerships", 4),
    (date(2026, 4, 15), "Miles expands SB 1882\nto ~20 A/B campuses", 4),
]

# Horizontal range bars (period spans, drawn as background bars on each lane)
PERIOD_BARS = [
    (date(2014, 8, 1), date(2017, 8, 31), "IR 4 consecutive years", 1),  # Wheatley IR period
    (date(2023, 9, 1), date(2026, 4, 30), "NES era", 3),  # NES launch onward
]

WHEATLEY_TEA = "101912018"
HISD_TEA = "101912"


def load_panel_data() -> dict:
    """Return {entity_id: [(school_year, total_students), ...]} for HISD + Wheatley."""
    series: dict[str, list[tuple[str, int]]] = {WHEATLEY_TEA: [], HISD_TEA: []}
    with open(PANEL_CSV) as f:
        reader = csv.DictReader(f)
        for row in reader:
            cid = row["campus_id"]
            if cid in series and row["total_students"]:
                series[cid].append((row["school_year"], int(float(row["total_students"]))))
    for k in series:
        series[k].sort()
    return series


def school_year_to_date(school_year: str) -> date:
    """Convert '2023-2024' to a date in mid-school-year (Jan)."""
    start = int(school_year.split("-")[0])
    return date(start + 1, 1, 1)


def render_timeline():
    fig, (ax_events, ax_enroll) = plt.subplots(
        2, 1,
        figsize=(18, 12),
        gridspec_kw={"height_ratios": [3.2, 1.0], "hspace": 0.30},
    )

    # ── Top panel: event swimlanes ──────────────────────────────────────
    n_lanes = len(LANES)
    LANE_SPACING = 1.6  # vertical units between lanes
    for li, lane_name in enumerate(LANES):
        y = (n_lanes - li - 1) * LANE_SPACING  # invert so lane 0 is at top
        ax_events.axhline(y, color="#ddd", linewidth=0.5, zorder=1)
        ax_events.text(
            0.005, y, lane_name,
            transform=ax_events.get_yaxis_transform(),
            ha="left", va="center", fontsize=9.5, fontweight="bold",
            color=LANE_COLORS[li],
            bbox=dict(facecolor="white", edgecolor="none", pad=2),
            zorder=5,
        )

    # Period range bars (drawn beneath events)
    for d_start, d_end, label, lane in PERIOD_BARS:
        y = (n_lanes - lane - 1) * LANE_SPACING
        x_start = mdates.date2num(d_start)
        x_end = mdates.date2num(d_end)
        ax_events.barh(
            y, x_end - x_start, left=x_start,
            height=0.32, color=LANE_COLORS[lane], alpha=0.18,
            edgecolor=LANE_COLORS[lane], linewidth=1.2, zorder=2,
        )
        # Label centered in bar
        ax_events.text(
            (x_start + x_end) / 2, y, label,
            ha="center", va="center", fontsize=8, fontweight="bold",
            color=LANE_COLORS[lane], zorder=3,
        )

    # Stagger labels above and below the lane line; increase offset for stacked events
    # Use a wider time bucket (year only) to keep events in the same year far apart vertically
    above_below: dict[tuple, int] = {}
    for d, label, lane in sorted(EVENTS, key=lambda e: e[0]):
        y = (n_lanes - lane - 1) * LANE_SPACING
        bucket = (d.year, lane)
        prev = above_below.get(bucket, 0)
        sign = 1 if prev % 2 == 0 else -1
        offset = 0.50 + 0.45 * (prev // 2)
        above_below[bucket] = prev + 1
        x = mdates.date2num(d)

        ax_events.scatter(
            [x], [y], s=90, c=LANE_COLORS[lane],
            edgecolors="white", linewidths=1.5, zorder=4,
        )
        ax_events.annotate(
            label, xy=(x, y), xytext=(x, y + sign * offset),
            ha="center", va="bottom" if sign > 0 else "top",
            fontsize=7.8, color="#222",
            arrowprops=dict(arrowstyle="-", color="#999", lw=0.5),
            zorder=3,
        )

    ax_events.set_xlim(mdates.date2num(date(2014, 6, 1)), mdates.date2num(date(2026, 9, 1)))
    ax_events.set_ylim(-1.4, n_lanes * LANE_SPACING - 0.2)
    ax_events.set_yticks([])
    ax_events.xaxis.set_major_locator(mdates.YearLocator())
    ax_events.xaxis.set_major_formatter(mdates.DateFormatter("%Y"))
    for spine in ("top", "right", "left"):
        ax_events.spines[spine].set_visible(False)
    ax_events.set_title(
        "The Texas charterization playbook — legislative, accountability, takeover, and SB 1882 events",
        fontsize=13, fontweight="bold", pad=15,
    )

    # ── Bottom panel: HISD + Wheatley enrollment trend ─────────────────
    series = load_panel_data()

    if series.get(HISD_TEA):
        years_hisd = [school_year_to_date(sy) for sy, _ in series[HISD_TEA]]
        vals_hisd = [v for _, v in series[HISD_TEA]]
        ax_enroll.plot(
            years_hisd, vals_hisd, color="#1f4e79", linewidth=2.2, marker="o",
            label=f"HISD district enrollment ({vals_hisd[0]:,} → {vals_hisd[-1]:,}, {(vals_hisd[-1]/vals_hisd[0]-1)*100:+.1f}%)",
        )
        ax_enroll.set_ylabel("HISD district enrollment", color="#1f4e79", fontsize=10)
        ax_enroll.tick_params(axis="y", labelcolor="#1f4e79")

    if series.get(WHEATLEY_TEA):
        ax_w = ax_enroll.twinx()
        years_w = [school_year_to_date(sy) for sy, _ in series[WHEATLEY_TEA]]
        vals_w = [v for _, v in series[WHEATLEY_TEA]]
        ax_w.plot(
            years_w, vals_w, color="#c00000", linewidth=2.2, marker="s",
            label=f"Wheatley HS ({vals_w[0]:,} → {vals_w[-1]:,}, {(vals_w[-1]/vals_w[0]-1)*100:+.1f}%)",
        )
        ax_w.set_ylabel("Wheatley HS enrollment", color="#c00000", fontsize=10)
        ax_w.tick_params(axis="y", labelcolor="#c00000")

        # Annotate the NES year (2023-24) where Wheatley got a B
        nes_x = school_year_to_date("2023-2024")
        nes_y = next((v for sy, v in series[WHEATLEY_TEA] if sy == "2023-2024"), None)
        if nes_y:
            ax_w.annotate(
                "NES Yr 1: rating B,\n32.9% attrition,\n−4% enrollment",
                xy=(nes_x, nes_y), xytext=(nes_x, nes_y + 30),
                ha="center", fontsize=8,
                arrowprops=dict(arrowstyle="->", color="#c00000", lw=1),
            )

    # Combined legend for both axes
    lines1, labels1 = ax_enroll.get_legend_handles_labels()
    lines2 = labels2 = []
    if series.get(WHEATLEY_TEA):
        lines2, labels2 = ax_w.get_legend_handles_labels()
    ax_enroll.legend(lines1 + lines2, labels1 + labels2, loc="lower left", fontsize=9, framealpha=0.95)

    ax_enroll.set_title(
        "HISD and Wheatley HS enrollment 2020-2025 (TEA arc_factors panel)",
        fontsize=11, pad=10,
    )
    ax_enroll.xaxis.set_major_locator(mdates.YearLocator())
    ax_enroll.xaxis.set_major_formatter(mdates.DateFormatter("%Y"))
    ax_enroll.grid(axis="y", linestyle=":", alpha=0.5)
    for spine in ("top", "right"):
        ax_enroll.spines[spine].set_visible(False)

    fig.suptitle(
        "Houston ISD takeover and the Texas charterization playbook (2014-2026)",
        fontsize=15, fontweight="bold", y=0.98,
    )

    fig.text(
        0.5, 0.01,
        "Sources: HB 1842 (84R, 2015); SB 1882 (85R, 2017); Texas AFT \"A Tale of Two Districts\" (2025-10-31); "
        "Houston Public Media; Texas Tribune; Texas Observer; KSAT; TPR; Community Voices for Public Education. "
        "Enrollment from TEA arc_factors panel via tea_data.db. Generated by scripts/houston_build_timeline.py.",
        ha="center", fontsize=7.5, color="#666", style="italic",
    )

    fig.savefig(OUTPUT_PNG, dpi=200, bbox_inches="tight", facecolor="white")
    print(f"[ok] wrote {OUTPUT_PNG.relative_to(REPO_ROOT)}")
    return OUTPUT_PNG


def main() -> int:
    if not PANEL_CSV.exists():
        print(f"[error] panel CSV not found at {PANEL_CSV}; run houston_longitudinal_pull.py first")
        return 1
    render_timeline()
    return 0


if __name__ == "__main__":
    sys.exit(main())

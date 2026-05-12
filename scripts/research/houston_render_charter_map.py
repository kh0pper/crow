#!/usr/bin/env python3
"""
houston_render_charter_map.py — render the 118 non-HISD charter campuses
inside HISD's geographic boundary as a static PNG suitable for embedding in
Chapter 5 Houston of the book-version case study.

Why static: the dashboard map section_type only supports TEA district choropleth
(metric + field + year + region) — it does not render arbitrary point GeoJSON.
For the chapter's chart-of-points-inside-polygon visual we render a matplotlib
map locally and reference it from a text section.

Output: canvas-companion/src/web/static/img/houston_charters_in_hisd.png

Run via scripts/.venv (has matplotlib + geopandas):
    ~/spring-2026/scripts/.venv/bin/python \\
        ~/crow/scripts/research/houston_render_charter_map.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import geopandas as gpd
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "insd-5941" / "book-research" / "data"
HISD_GEOJSON = REPO_ROOT / "canvas-companion" / "data" / "districts.geojson"
CHARTERS_GEOJSON = DATA_DIR / "tx_charters_in_hisd_polygon.geojson"
HISD_CAMPUSES_GEOJSON = DATA_DIR / "hisd_campuses_in_polygon.geojson"
OUTPUT_PNG = REPO_ROOT / "canvas-companion" / "src" / "web" / "static" / "img" / "houston_charters_in_hisd.png"

HISD_TEA_ID = "101912"

# Top operators get distinct colors; rest get a default
OPERATOR_PALETTE = {
    "KIPP": "#c00000",         # red
    "YES": "#1f4e79",          # navy
    "HARMONY": "#385723",      # green
    "HOUSTON GATEWAY": "#ed7d31",  # orange
    "IDEA HARDY": "#7030a0",   # purple
    "ILTEXAS": "#d4a017",      # gold
    "RIPLEY": "#5b6770",       # slate
    "VARNETT": "#806000",      # brown
    "Other operators (43)": "#999",
}


def operator_label(name: str) -> str:
    """Map a school NAME to one of the palette buckets."""
    if not name:
        return "Other operators (43)"
    upper = name.upper()
    for key in OPERATOR_PALETTE:
        if key == "Other operators (43)":
            continue
        if upper.startswith(key):
            return key
    return "Other operators (43)"


def main() -> int:
    if not CHARTERS_GEOJSON.exists():
        print(f"[error] {CHARTERS_GEOJSON} not found; run scripts/houston_data_pull.py first")
        return 1

    OUTPUT_PNG.parent.mkdir(parents=True, exist_ok=True)

    # Load HISD polygon from the existing district asset
    with open(HISD_GEOJSON) as f:
        districts = json.load(f)
    hisd_feature = next((f for f in districts["features"] if str(f["properties"].get("tea_id")) == HISD_TEA_ID), None)
    if hisd_feature is None:
        print("[error] HISD polygon not in districts.geojson")
        return 1
    hisd_gdf = gpd.GeoDataFrame.from_features([hisd_feature], crs="EPSG:4326")

    charters = gpd.read_file(CHARTERS_GEOJSON)
    charters["operator"] = charters["NAME"].apply(operator_label)
    print(f"[load] {len(charters)} charter campuses")

    hisd_campuses = None
    if HISD_CAMPUSES_GEOJSON.exists():
        hisd_campuses = gpd.read_file(HISD_CAMPUSES_GEOJSON)
        print(f"[load] {len(hisd_campuses)} HISD-operated campuses")

    fig, ax = plt.subplots(figsize=(13, 12))

    # HISD polygon (background)
    hisd_gdf.plot(ax=ax, facecolor="#f5f5f5", edgecolor="#333", linewidth=1.5, alpha=0.6, zorder=1)

    # HISD-operated campuses (small grey dots, for spatial context)
    if hisd_campuses is not None:
        hisd_campuses.plot(ax=ax, color="#bbb", markersize=8, alpha=0.5, zorder=2)

    # Non-HISD campuses by operator (colored)
    for op, color in OPERATOR_PALETTE.items():
        sub = charters[charters["operator"] == op]
        if len(sub) == 0:
            continue
        sub.plot(ax=ax, color=color, markersize=60, alpha=0.85,
                 edgecolor="white", linewidth=0.8, zorder=4)

    # Custom legend
    legend_handles = []
    for op, color in OPERATOR_PALETTE.items():
        n = len(charters[charters["operator"] == op])
        if n == 0:
            continue
        legend_handles.append(Line2D([0], [0], marker="o", color="white",
                                      markerfacecolor=color, markersize=10,
                                      markeredgecolor="white", label=f"{op} ({n})"))
    legend_handles.append(Line2D([0], [0], marker="o", color="white",
                                  markerfacecolor="#bbb", markersize=8,
                                  alpha=0.5, label=f"HISD-operated campuses ({len(hisd_campuses) if hisd_campuses is not None else 0})"))

    ax.legend(handles=legend_handles, loc="upper left", fontsize=10, framealpha=0.95,
              title="Operator (campus count inside HISD polygon)", title_fontsize=11)

    ax.set_title(
        "118 non-HISD campuses physically inside Houston ISD's geographic boundary\n"
        "(Source: NCES EDGE 2024-25 public-school point geocodes; 51 distinct operating LEAs)",
        fontsize=13, fontweight="bold", pad=12,
    )
    ax.set_xlabel("Longitude", fontsize=10)
    ax.set_ylabel("Latitude", fontsize=10)
    ax.grid(True, linestyle=":", alpha=0.3)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)

    fig.text(
        0.5, 0.02,
        "Polygon: HISD geographic boundary from canvas-companion/data/districts.geojson. "
        "Charter points: 118 non-HISD campuses (LEAID != 4823640) whose lat/lon falls inside the polygon. "
        "Generated by scripts/houston_render_charter_map.py.",
        ha="center", fontsize=8, color="#666", style="italic",
    )

    fig.savefig(OUTPUT_PNG, dpi=180, bbox_inches="tight", facecolor="white")
    print(f"[ok] wrote {OUTPUT_PNG.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

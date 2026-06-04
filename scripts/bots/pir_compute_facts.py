#!/usr/bin/env python3
"""
pir_compute_facts.py — deterministic, ADVISORY fact computation for a PIR holding dir.

Emits computed_facts.json describing verifiable facts about the inbound files so the
bot never has to eyeball a count. ADVISORY ONLY: a generic PDF list-counter is a
heuristic (fails on scanned / multi-column / table PDFs). The dispatcher uses these
to VALIDATE the bot's claims.json — agreement -> PASS; disagreement or
unparseable -> ESCALATE (never override the model with a possibly-wrong number).

Usage: python3 pir_compute_facts.py <holding_dir> [--out <path>]
       (xlsx counting needs openpyxl: `uv run --with openpyxl python3 pir_compute_facts.py ...`)

Exit 0 always (best-effort); writes computed_facts.json to <holding_dir> (or --out).
"""
import csv
import json
import os
import re
import subprocess
import sys

BULLET_RE = re.compile(r"^\s*[•·▪‣◦]\s+(.+\S)\s*$")  # • · ▪ ‣ ◦
TABULAR_EXT = {".csv", ".xlsx", ".xls", ".accdb", ".mdb"}


def count_csv(path):
    try:
        with open(path, newline="", encoding="utf-8", errors="replace") as f:
            rdr = csv.reader(f)
            rows = list(rdr)
        if not rows:
            return {"rows": 0, "columns": []}
        return {"rows": max(0, len(rows) - 1), "columns": rows[0]}
    except Exception as e:
        return {"error": str(e)}


def count_xlsx(path):
    try:
        import openpyxl  # noqa
    except Exception:
        return {"needs_openpyxl": True}
    try:
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        out = {}
        for ws in wb.worksheets:
            # data rows = max_row - 1 (header); guard empty sheets
            n = ws.max_row or 0
            out[ws.title] = {"rows": max(0, n - 1)}
        return {"sheets": out}
    except Exception as e:
        return {"error": str(e)}


def classify_header(header):
    h = header.lower()
    if "major impact" in h:
        return "major_impact"
    if "significant degree" in h or "not expected to adversely" in h:
        return "no_significant_impact"
    if "support" in h:
        return "support"
    if "opposition" in h or "oppose" in h:
        return "opposition"
    return None


def parse_pdf_list(path):
    """Count bullet entities, grouped by the header block preceding each run."""
    try:
        r = subprocess.run(["pdftotext", "-layout", path, "-"],
                           capture_output=True, text=True, timeout=120)
    except Exception as e:
        return {"unparseable": True, "reason": f"pdftotext failed: {e}"}
    text = r.stdout or ""
    if not text.strip():
        return {"unparseable": True, "reason": "no text layer (likely scanned)"}
    lines = text.split("\n")
    sections = []          # [{header, label, count, items}]
    pending_header = []    # non-bullet lines accumulating since last bullet/blank-run
    cur = None             # current open bullet run
    total = 0
    for ln in lines:
        m = BULLET_RE.match(ln)
        if m:
            if cur is None:
                header = " ".join(s.strip() for s in pending_header if s.strip()).strip()
                cur = {"header": header[:300], "label": classify_header(header),
                       "count": 0, "items": []}
                sections.append(cur)
                pending_header = []
            cur["count"] += 1
            cur["items"].append(m.group(1).strip())
            total += 1
        else:
            cur = None  # bullet run ended
            if ln.strip():
                pending_header.append(ln)
    if total == 0:
        return {"unparseable": True, "reason": "no bullet entities found"}
    # collapse labeled sections into a quick lookup (only unambiguous labels)
    labels = {}
    for s in sections:
        if s["label"]:
            labels[s["label"]] = labels.get(s["label"], 0) + s["count"]
    return {"unparseable": False, "bullet_total": total,
            "sections": [{"header": s["header"], "label": s["label"], "count": s["count"]} for s in sections],
            "labeled_counts": labels}


def main():
    if len(sys.argv) < 2:
        print("usage: pir_compute_facts.py <holding_dir> [--out <path>]", file=sys.stderr)
        sys.exit(2)
    holding = sys.argv[1]
    out = holding
    if "--out" in sys.argv:
        out = sys.argv[sys.argv.index("--out") + 1]
        out = os.path.dirname(out) or "."
    out_path = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else os.path.join(holding, "computed_facts.json")

    files = []
    for name in sorted(os.listdir(holding)):
        p = os.path.join(holding, name)
        if not os.path.isfile(p):
            continue
        if name in ("computed_facts.json", "inbound.json", "email_body.txt"):
            continue
        ext = os.path.splitext(name)[1].lower()
        entry = {"filename": name, "ext": ext, "size_bytes": os.path.getsize(p)}
        if ext == ".csv":
            entry["kind"] = "csv"; entry.update(count_csv(p))
        elif ext in (".xlsx", ".xls"):
            entry["kind"] = "spreadsheet"; entry.update(count_xlsx(p))
        elif ext == ".pdf":
            entry["kind"] = "pdf"; entry["pdf_list"] = parse_pdf_list(p)
        else:
            entry["kind"] = ext.lstrip(".") or "unknown"
        files.append(entry)

    facts = {
        "holding_dir": holding,
        "files": files,
        "csv_row_total": sum(f.get("rows", 0) for f in files if f.get("kind") == "csv"),
    }
    with open(out_path, "w") as f:
        json.dump(facts, f, indent=2)
    print(out_path)


if __name__ == "__main__":
    main()

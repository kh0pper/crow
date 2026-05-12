#!/usr/bin/env python3
"""
build_chapter_plan.py
=====================

Turn a chapter's extracted markdown into a rebuild_chapter.py plan JSON.

The MCP `gdocs_read_section` call happens in the orchestrator session;
the markdown body is saved to a file by the operator. This script reads
the markdown, performs the Phase-B.2 pre-flight assertions and the
Phase-B.3 hierarchical split, and emits the plan JSON.

Usage:
  build_chapter_plan.py --md <path-to-md> --out <path-to-plan-json> \
                        --chapter-title "Chapter 1: Introduction" \
                        --display-order 1 \
                        [--case-study-id N] \
                        [--new-chapter] \
                        [--require-landmark "1.8 Significance"] \
                        [--forbid-heading "# 2. LITERATURE REVIEW" "# 3. METHODOLOGY"]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


def split_chapter(md: str) -> list[dict]:
    """Strip the chapter's own level-1 or level-2 root heading, detect the
    minimum remaining heading level, and split at that level. Returns a
    list of {"title": str, "content": str}."""
    lines = md.splitlines()

    # Strip the leading root heading (first line matching ^# { ,2} or a
    # blank line before the first ##). This is the Phase-B.3 "strip
    # chapter root" step that prevents the min-level detector from
    # picking up the chapter's own heading.
    # A chapter extracted via gdocs_read_section starts with its own
    # root heading. That root is either level-1 (for master-doc chapters
    # 1, 2, 3, 5) or level-2 (for sub-chapters 4A-4F). Both cases are
    # handled: strip the first heading line if it's the one the MCP
    # anchored to. The detection heuristic is: the first heading is
    # followed by NO heading of equal-or-shallower depth before any
    # deeper sub-heading — meaning it's the chapter root, not the first
    # subsection.
    first_heading_idx = None
    first_heading_level = None
    for i, line in enumerate(lines):
        m = re.match(r"^(#{1,6}) ", line)
        if m:
            first_heading_idx = i
            first_heading_level = len(m.group(1))
            break
    if first_heading_idx is not None and first_heading_level is not None:
        # Check whether the next heading is DEEPER (more hashes). If so,
        # the first heading is a root to strip. If another heading at
        # the same depth follows, the first heading is a peer/subsection
        # and should NOT be stripped.
        next_heading_depth = None
        for line in lines[first_heading_idx + 1:]:
            m = re.match(r"^(#{1,6}) ", line)
            if m:
                next_heading_depth = len(m.group(1))
                break
        if next_heading_depth is None or next_heading_depth > first_heading_level:
            # Root heading — strip it and any blank line immediately after.
            drop_until = first_heading_idx + 1
            while drop_until < len(lines) and not lines[drop_until].strip():
                drop_until += 1
            lines = lines[drop_until:]

    body = "\n".join(lines)

    # Detect minimum heading level in the remaining body.
    min_level = 6
    for m in re.finditer(r"^(#{1,6}) ", body, re.MULTILINE):
        lvl = len(m.group(1))
        if lvl < min_level:
            min_level = lvl
    if min_level == 6:
        # No subheadings at all — whole body is one block.
        return [{"title": None, "content": body.strip()}]

    # Split at the detected min level.
    marker = "#" * min_level + " "
    pattern = re.compile(rf"^{re.escape(marker)}", re.MULTILINE)
    matches = list(pattern.finditer(body))

    # If there's prose BEFORE the first heading match, capture it as
    # block 0 with title=None (chapter intro paragraph).
    blocks: list[dict] = []
    if matches and matches[0].start() > 0:
        prose = body[: matches[0].start()].strip()
        if prose:
            blocks.append({"title": None, "content": prose})

    indices = [m.start() for m in matches] + [len(body)]
    for i in range(len(indices) - 1):
        chunk = body[indices[i]:indices[i + 1]].strip()
        heading_line, _, rest = chunk.partition("\n")
        title = heading_line[len(marker):].strip()
        blocks.append({"title": title, "content": rest.strip()})
    return blocks


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--md", type=Path, required=True, help="extracted markdown file")
    ap.add_argument("--out", type=Path, required=True, help="plan JSON output path")
    ap.add_argument("--chapter-title", required=True)
    ap.add_argument("--display-order", type=int, required=True)
    ap.add_argument("--case-study-id", type=int, default=None)
    ap.add_argument("--new-chapter", action="store_true", help="is_new_case_study=True")
    ap.add_argument("--require-landmark", action="append", default=[],
                    help="substring that MUST appear in the markdown (can repeat)")
    ap.add_argument("--forbid-heading", action="append", default=[],
                    help="heading string that MUST NOT appear (can repeat)")
    args = ap.parse_args()

    md = args.md.read_text()

    # Pre-flight 1 (Phase B.2): no other chapter's root heading
    for needle in args.forbid_heading:
        if needle in md:
            print(f"FAIL: forbidden heading present: {needle!r}", file=sys.stderr)
            return 1

    # Pre-flight 2: chapter landmark(s)
    for needle in args.require_landmark:
        if needle not in md:
            print(f"FAIL: missing required landmark: {needle!r}", file=sys.stderr)
            return 1

    blocks = split_chapter(md)
    if not blocks:
        print("FAIL: splitter produced zero blocks", file=sys.stderr)
        return 1
    print(f"split into {len(blocks)} block(s):")
    for b in blocks:
        t = b["title"] or "(intro/no-heading)"
        print(f"  {t[:70]} ({len(b['content'])} chars)")

    plan = {
        "case_study_id": args.case_study_id if not args.new_chapter else None,
        "chapter_title": args.chapter_title,
        "display_order": args.display_order,
        "is_new_case_study": args.new_chapter,
        "text_blocks": blocks,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(plan, indent=2))
    print(f"wrote plan → {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

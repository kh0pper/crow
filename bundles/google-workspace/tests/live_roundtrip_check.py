"""
Live formatting round-trip check against the real Docs API.

Not collected by `unittest discover` (the filename does not start with "test")
because it needs credentials and writes a scratch document. Run it by hand after
touching the markdown conversion path:

    GOOGLE_CREDENTIALS_FILE=... GOOGLE_TOKEN_FILE=... \
    GDOCS_DEFAULT_FONT="Open Sans" \
    GDOCS_SCRATCH_FOLDER=<drive folder id> \
    .venv/bin/python tests/live_roundtrip_check.py

Writes a document through gdocs_replace_section, gdocs_insert_at_heading, and
gdocs_append, then reads the raw structure back and asserts that headings, bold,
italic, native tables, and the pinned font all survived. Exits non-zero on any
loss and prints the scratch doc's URL either way.
"""

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from google_workspace_mcp.auth import get_docs_service  # noqa: E402
from google_workspace_mcp.docs import (  # noqa: E402
    gdocs_append,
    gdocs_create,
    gdocs_insert_at_heading,
    gdocs_replace_section,
)

TITLE = "SCRATCH - gws formatting round-trip check"

SEED = "# Scratch\n\n## Target Section\n\nplaceholder body\n\n## Trailing Section\n\ntail\n"

PAYLOAD = """### Rebuilt subheading

Body text with a **bold run** and an *italic run* inside it.

- bullet with **bold inside**
- plain bullet

| Column A | Column B |
| --- | --- |
| **bold cell** | plain cell |
"""


def walk_runs(doc):
    """Yield (text, textStyle, namedStyleType) for every run, tables included."""

    def from_content(content, named_default="NORMAL_TEXT"):
        for el in content:
            para = el.get("paragraph")
            if para:
                named = para.get("paragraphStyle", {}).get(
                    "namedStyleType", named_default
                )
                for e in para.get("elements", []):
                    tr = e.get("textRun")
                    if tr:
                        yield tr.get("content", ""), tr.get("textStyle", {}), named
            table = el.get("table")
            if table:
                for row in table.get("tableRows", []):
                    for cell in row.get("tableCells", []):
                        yield from from_content(cell.get("content", []))

    return list(from_content(doc.get("body", {}).get("content", [])))


def has_table(doc):
    return any("table" in el for el in doc.get("body", {}).get("content", []))


def check(doc, label, expect_font):
    runs = walk_runs(doc)
    failures = []

    headings = {named for _, _, named in runs if named.startswith("HEADING_")}
    if "HEADING_3" not in headings:
        failures.append(f"no HEADING_3 survived (saw {sorted(headings)})")

    bold_texts = [t.strip() for t, s, _ in runs if s.get("bold")]
    for want in ("bold run", "bold inside", "bold cell"):
        if not any(want in b for b in bold_texts):
            failures.append(f"bold lost for {want!r} (bold runs: {bold_texts})")

    if not any(s.get("italic") for _, s, _ in runs):
        failures.append("italic lost")

    if not has_table(doc):
        failures.append("table did not render natively")

    if expect_font:
        fonts = {
            s.get("weightedFontFamily", {}).get("fontFamily")
            for t, s, _ in runs
            if t.strip()
        }
        wrong = {f for f in fonts if f != expect_font}
        if wrong:
            failures.append(f"font not pinned to {expect_font}: also saw {wrong}")

    print(f"[{'PASS' if not failures else 'FAIL'}] {label}")
    for f in failures:
        print(f"        - {f}")
    return not failures


async def main():
    folder = os.environ.get("GDOCS_SCRATCH_FOLDER", "").strip()
    if not folder:
        print("set GDOCS_SCRATCH_FOLDER to a Drive folder id", file=sys.stderr)
        return 2

    expect_font = os.environ.get("GDOCS_DEFAULT_FONT") or None
    print(f"GDOCS_DEFAULT_FONT={expect_font!r}\n")

    docs = get_docs_service()

    created = await gdocs_create(folder, TITLE, SEED, find_existing=False)
    if not created.get("success"):
        print(f"create failed: {created}", file=sys.stderr)
        return 2
    doc_id = created["data"]["doc_id"]
    url = f"https://docs.google.com/document/d/{doc_id}/edit"
    print(f"scratch doc: {url}\n")

    ok = True
    for label, call in (
        (
            "gdocs_replace_section",
            gdocs_replace_section(doc_id, "Target Section", PAYLOAD),
        ),
        (
            "gdocs_insert_at_heading",
            gdocs_insert_at_heading(doc_id, "Trailing Section", PAYLOAD),
        ),
        ("gdocs_append", gdocs_append(doc_id, PAYLOAD)),
    ):
        result = await call
        if not result.get("success"):
            print(f"[FAIL] {label}: {result}")
            ok = False
            continue
        doc = docs.documents().get(documentId=doc_id).execute()
        ok &= check(doc, label, expect_font)

    print("\nOVERALL:", "PASS" if ok else "FAIL")
    print(f"doc: {url}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

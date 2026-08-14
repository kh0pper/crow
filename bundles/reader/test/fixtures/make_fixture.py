# /// script
# requires-python = ">=3.11"
# dependencies = ["pymupdf>=1.24"]
# ///
"""Build fixture.pdf: 2 pages of known text with a hyphenated line break."""

import sys
import fitz

doc = fitz.open()
p1 = doc.new_page()
p1.insert_text((72, 100), "The Reader Fixture", fontsize=18)
p1.insert_text(
    (72, 140),
    "Design thinking starts with empathy for the people you are\n"
    "designing for. This paragraph continues across a hyphen-\n"
    "ated line break to exercise reflow.",
    fontsize=11,
)
p2 = doc.new_page()
p2.insert_text(
    (72, 100), "Second page paragraph. It stands alone and ends cleanly.", fontsize=11
)
doc.save(sys.argv[1])

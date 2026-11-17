"""
Tests for soft-wrap folding: a single newline is a wrap inside a block, not a
paragraph break. Only a blank line starts a new paragraph.

Run with:
    cd <the bundle folder> && .venv/bin/python -m unittest discover -s tests -v
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from google_workspace_mcp.docs_formatting import fold_soft_wraps, markdown_to_docs_requests  # noqa: E402


def inserted_text(markdown):
    """The plain text the converter would insert, as a list of lines."""
    requests, _ = markdown_to_docs_requests(markdown)
    if not requests:
        return []
    return requests[0]["insertText"]["text"].split("\n")


class FoldSoftWrapsTests(unittest.TestCase):
    def test_wrapped_prose_becomes_one_line(self):
        self.assertEqual(
            fold_soft_wraps(["a sentence that was", "wrapped for width"]),
            ["a sentence that was wrapped for width"],
        )

    def test_blank_line_separates_paragraphs(self):
        self.assertEqual(
            fold_soft_wraps(["first para", "still first", "", "second para"]),
            ["first para still first", "", "second para"],
        )

    def test_heading_is_never_absorbed(self):
        self.assertEqual(
            fold_soft_wraps(["## A heading", "body text"]),
            ["## A heading", "body text"],
        )

    def test_heading_does_not_absorb_following_prose(self):
        folded = fold_soft_wraps(["# Title", "intro line", "wrapped on"])
        self.assertEqual(folded, ["# Title", "intro line wrapped on"])

    def test_heading_interrupts_a_paragraph(self):
        self.assertEqual(
            fold_soft_wraps(["some prose", "## Next section"]),
            ["some prose", "## Next section"],
        )

    def test_list_item_continuation_folds_into_the_item(self):
        self.assertEqual(
            fold_soft_wraps(["- first item", "continued here", "- second item"]),
            ["- first item continued here", "- second item"],
        )

    def test_ordered_items_stay_separate(self):
        self.assertEqual(
            fold_soft_wraps(["1. one", "2. two"]),
            ["1. one", "2. two"],
        )

    def test_table_rows_are_not_folded(self):
        rows = ["| a | b |", "| --- | --- |", "| 1 | 2 |"]
        self.assertEqual(fold_soft_wraps(rows), rows)

    def test_two_space_hard_break_is_preserved(self):
        self.assertEqual(
            fold_soft_wraps(["Jordan Example  ", "Coordinator"]),
            ["Jordan Example", "Coordinator"],
        )

    def test_backslash_hard_break_is_preserved(self):
        self.assertEqual(
            fold_soft_wraps(["line one\\", "line two"]),
            ["line one", "line two"],
        )

    def test_hard_break_run_keeps_every_line(self):
        """A signature block authored with hard breaks stays one line per row."""
        block = ["Jordan Example  ", "Coordinator, Example Program  ", "Example Organization"]
        self.assertEqual(
            fold_soft_wraps(block),
            ["Jordan Example", "Coordinator, Example Program", "Example Organization"],
        )

    def test_blockquote_is_not_folded_into_prose(self):
        self.assertEqual(
            fold_soft_wraps(["prose", "> a quote"]),
            ["prose", "> a quote"],
        )


class EndToEndTests(unittest.TestCase):
    def test_wrapped_paragraph_inserts_as_one_paragraph(self):
        md = (
            "We are building the measurement plan for the campaign, and four\n"
            "things on the agency's side would let us finish it."
        )
        lines = inserted_text(md)
        self.assertEqual(
            lines[0],
            "We are building the measurement plan for the campaign, and four "
            "things on the agency's side would let us finish it.",
        )

    def test_wrapped_list_item_inserts_as_one_item(self):
        md = "- Social media analytics for the agency's channels, plus who\n  holds the data"
        lines = inserted_text(md)
        self.assertEqual(
            lines[0],
            "Social media analytics for the agency's channels, plus who holds the data",
        )

    def test_heading_and_body_stay_distinct_paragraphs(self):
        md = "## Section\n\nBody that is\nwrapped."
        requests, _ = markdown_to_docs_requests(md)
        text = requests[0]["insertText"]["text"]
        self.assertIn("Section\n", text)
        self.assertIn("Body that is wrapped.", text)
        headings = [
            r
            for r in requests
            if "updateParagraphStyle" in r
            and r["updateParagraphStyle"]["paragraphStyle"]["namedStyleType"]
            == "HEADING_2"
        ]
        self.assertEqual(len(headings), 1)

    def test_bold_spanning_a_wrap_still_resolves(self):
        """Markers split across a wrap must pair up once the lines are folded."""
        md = "A label of **bold text\nthat wrapped** and then plain."
        requests, _ = markdown_to_docs_requests(md)
        bolds = [
            r
            for r in requests
            if "updateTextStyle" in r and r["updateTextStyle"]["textStyle"].get("bold")
        ]
        self.assertEqual(len(bolds), 1)

    def test_signature_block_with_hard_breaks_stays_stacked(self):
        md = "Thank you,\n\nJordan Example  \nCoordinator, Example Program  \nExample Organization"
        lines = inserted_text(md)
        self.assertIn("Jordan Example", lines)
        self.assertIn("Coordinator, Example Program", lines)
        self.assertIn("Example Organization", lines)

    def test_table_block_unaffected_by_folding(self):
        from google_workspace_mcp.docs_formatting import split_markdown_segments

        md = "Intro that is\nwrapped\n\n| a | b |\n| --- | --- |\n| 1 | 2 |"
        segments = split_markdown_segments(md)
        self.assertEqual([k for k, _ in segments], ["md", "table"])
        self.assertEqual(segments[1][1], [["a", "b"], ["1", "2"]])


if __name__ == "__main__":
    unittest.main()
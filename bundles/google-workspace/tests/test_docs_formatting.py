"""
Tests for markdown -> Docs request conversion.

Run with:
    .venv/bin/python -m unittest discover -s tests -v

Stdlib unittest on purpose: the repo has no test dependency and these are pure
functions, so no fixtures or API mocks are needed.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from google_workspace_mcp.docs_formatting import (  # noqa: E402
    _parse_inline_formatting,
    markdown_to_docs_requests,
    split_markdown_segments,
)


def _kinds(requests):
    """The request-type key of each request, in emission order."""
    return [next(iter(r)) for r in requests]


def _first_index_of(requests, kind, predicate=None):
    for i, r in enumerate(requests):
        if kind in r and (predicate is None or predicate(r[kind])):
            return i
    return -1


class InlineFormattingTests(unittest.TestCase):
    def test_bold_span_is_parsed(self):
        spans = _parse_inline_formatting("plain **bold** tail")
        self.assertEqual([s.text for s in spans], ["plain ", "bold", " tail"])
        self.assertEqual([s.bold for s in spans], [False, True, False])

    def test_unbalanced_markers_fall_back_to_literal_text(self):
        spans = _parse_inline_formatting("a **dangling")
        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0].text, "a **dangling")
        self.assertFalse(spans[0].bold)


class BoldAndHeadingEmissionTests(unittest.TestCase):
    """The converter must emit real bold runs and heading named-styles."""

    def test_heading_emits_named_style(self):
        requests, _ = markdown_to_docs_requests("## Section title")
        style = [r for r in requests if "updateParagraphStyle" in r]
        self.assertEqual(len(style), 1)
        self.assertEqual(
            style[0]["updateParagraphStyle"]["paragraphStyle"]["namedStyleType"],
            "HEADING_2",
        )

    def test_bold_emits_update_text_style(self):
        requests, _ = markdown_to_docs_requests("Some **bold** words")
        bolds = [
            r
            for r in requests
            if "updateTextStyle" in r and r["updateTextStyle"]["textStyle"].get("bold")
        ]
        self.assertEqual(len(bolds), 1)
        rng = bolds[0]["updateTextStyle"]["range"]
        # "Some " is 5 chars from start_index 1.
        self.assertEqual(rng["startIndex"], 6)
        self.assertEqual(rng["endIndex"], 10)

    def test_bold_inside_a_heading_survives_both_styles(self):
        requests, _ = markdown_to_docs_requests("### A **strong** heading")
        self.assertTrue(
            any(
                "updateParagraphStyle" in r
                and r["updateParagraphStyle"]["paragraphStyle"]["namedStyleType"]
                == "HEADING_3"
                for r in requests
            )
        )
        self.assertTrue(
            any(
                "updateTextStyle" in r and r["updateTextStyle"]["textStyle"].get("bold")
                for r in requests
            )
        )


class NormalTextResetOrderingTests(unittest.TestCase):
    """
    Regression: the NORMAL_TEXT guardrail used to be appended AFTER the
    converter's requests, so it overwrote every heading named-style and reset
    the character formatting of the runs it covered. It must be emitted BEFORE
    any styling request.
    """

    MD = "## Heading\n\nBody with **bold** text\n\n- a bullet"

    def test_reset_is_emitted_before_heading_styles(self):
        requests, _ = markdown_to_docs_requests(self.MD, reset_normal_text=True)

        reset_at = _first_index_of(
            requests,
            "updateParagraphStyle",
            lambda p: p["paragraphStyle"]["namedStyleType"] == "NORMAL_TEXT",
        )
        heading_at = _first_index_of(
            requests,
            "updateParagraphStyle",
            lambda p: p["paragraphStyle"]["namedStyleType"].startswith("HEADING_"),
        )

        self.assertNotEqual(reset_at, -1, "no NORMAL_TEXT reset emitted")
        self.assertNotEqual(heading_at, -1, "no heading style emitted")
        self.assertLess(
            reset_at, heading_at, "NORMAL_TEXT reset must precede heading styles"
        )

    def test_reset_is_emitted_before_bold_runs(self):
        requests, _ = markdown_to_docs_requests(self.MD, reset_normal_text=True)

        reset_at = _first_index_of(
            requests,
            "updateParagraphStyle",
            lambda p: p["paragraphStyle"]["namedStyleType"] == "NORMAL_TEXT",
        )
        bold_at = _first_index_of(
            requests, "updateTextStyle", lambda s: s["textStyle"].get("bold")
        )

        self.assertNotEqual(bold_at, -1, "no bold run emitted")
        self.assertLess(reset_at, bold_at, "NORMAL_TEXT reset must precede bold runs")

    def test_reset_covers_the_whole_inserted_range(self):
        requests, end = markdown_to_docs_requests(
            self.MD, start_index=7, reset_normal_text=True
        )
        reset = [
            r
            for r in requests
            if "updateParagraphStyle" in r
            and r["updateParagraphStyle"]["paragraphStyle"]["namedStyleType"]
            == "NORMAL_TEXT"
        ][0]
        rng = reset["updateParagraphStyle"]["range"]
        self.assertEqual(rng["startIndex"], 7)
        self.assertEqual(rng["endIndex"], end)

    def test_no_reset_emitted_when_not_requested(self):
        requests, _ = markdown_to_docs_requests(self.MD)
        self.assertFalse(
            any(
                "updateParagraphStyle" in r
                and r["updateParagraphStyle"]["paragraphStyle"]["namedStyleType"]
                == "NORMAL_TEXT"
                for r in requests
            )
        )

    def test_insert_text_is_always_first(self):
        requests, _ = markdown_to_docs_requests(self.MD, reset_normal_text=True)
        self.assertEqual(_kinds(requests)[0], "insertText")


class FontFamilyTests(unittest.TestCase):
    """
    Inserted runs get an explicit font so they cannot inherit the document's
    default (the Arial-on-export class of bug).
    """

    MD = "## Heading\n\nBody with **bold** text"

    def test_font_request_covers_whole_range(self):
        requests, end = markdown_to_docs_requests(
            self.MD, start_index=1, font_family="Open Sans"
        )
        fonts = [
            r
            for r in requests
            if "updateTextStyle" in r
            and "weightedFontFamily" in r["updateTextStyle"]["textStyle"]
        ]
        self.assertEqual(len(fonts), 1)
        self.assertEqual(
            fonts[0]["updateTextStyle"]["textStyle"]["weightedFontFamily"][
                "fontFamily"
            ],
            "Open Sans",
        )
        self.assertEqual(fonts[0]["updateTextStyle"]["fields"], "weightedFontFamily")
        rng = fonts[0]["updateTextStyle"]["range"]
        self.assertEqual(rng["startIndex"], 1)
        self.assertEqual(rng["endIndex"], end)

    def test_font_is_applied_after_heading_styles(self):
        """A named style carries its own font, so the font must come after it."""
        requests, _ = markdown_to_docs_requests(self.MD, font_family="Open Sans")
        heading_at = _first_index_of(
            requests,
            "updateParagraphStyle",
            lambda p: p["paragraphStyle"]["namedStyleType"].startswith("HEADING_"),
        )
        font_at = _first_index_of(
            requests,
            "updateTextStyle",
            lambda s: "weightedFontFamily" in s["textStyle"],
        )
        self.assertNotEqual(font_at, -1)
        self.assertLess(heading_at, font_at)

    def test_font_does_not_clear_bold(self):
        """The font request must not carry a weight that competes with bold."""
        requests, _ = markdown_to_docs_requests(self.MD, font_family="Open Sans")
        font = [
            r
            for r in requests
            if "updateTextStyle" in r
            and "weightedFontFamily" in r["updateTextStyle"]["textStyle"]
        ][0]
        self.assertNotIn("bold", font["updateTextStyle"]["fields"])
        bold_at = _first_index_of(
            requests, "updateTextStyle", lambda s: s["textStyle"].get("bold")
        )
        font_at = _first_index_of(
            requests,
            "updateTextStyle",
            lambda s: "weightedFontFamily" in s["textStyle"],
        )
        self.assertLess(font_at, bold_at, "bold runs must be applied after the font")

    def test_no_font_request_when_not_requested(self):
        requests, _ = markdown_to_docs_requests(self.MD)
        self.assertFalse(
            any(
                "updateTextStyle" in r
                and "weightedFontFamily" in r["updateTextStyle"]["textStyle"]
                for r in requests
            )
        )


class CombinedOrderingTests(unittest.TestCase):
    def test_full_pipeline_order_is_stable(self):
        requests, _ = markdown_to_docs_requests(
            "## Heading\n\nBody **bold**\n\n- bullet",
            reset_normal_text=True,
            font_family="Open Sans",
        )
        order = []
        for r in requests:
            if "insertText" in r:
                order.append("insert")
            elif "updateParagraphStyle" in r:
                named = r["updateParagraphStyle"]["paragraphStyle"]["namedStyleType"]
                order.append("reset" if named == "NORMAL_TEXT" else "heading")
            elif "createParagraphBullets" in r:
                order.append("bullets")
            elif "updateTextStyle" in r:
                ts = r["updateTextStyle"]["textStyle"]
                order.append("font" if "weightedFontFamily" in ts else "runs")

        self.assertEqual(order[0], "insert")
        self.assertEqual(order[1], "reset")
        self.assertLess(order.index("heading"), order.index("font"))
        self.assertLess(order.index("font"), order.index("runs"))
        self.assertLess(order.index("bullets"), order.index("runs"))

    def test_empty_markdown_emits_nothing(self):
        requests, end = markdown_to_docs_requests(
            "   \n\n  ", start_index=5, reset_normal_text=True, font_family="Open Sans"
        )
        self.assertEqual(requests, [])
        self.assertEqual(end, 5)


class TableSegmentTests(unittest.TestCase):
    def test_table_block_is_split_out(self):
        md = "Intro\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nOutro"
        segments = split_markdown_segments(md)
        kinds = [k for k, _ in segments]
        self.assertEqual(kinds, ["md", "table", "md"])
        self.assertEqual(segments[1][1], [["a", "b"], ["1", "2"]])


if __name__ == "__main__":
    unittest.main()

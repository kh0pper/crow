"""Docs tools that depend on the document's structure: text inside native table
cells, and replacing a section whose last element is a table.

The Docs client is a mock, so nothing leaves the process.

Run with:
    python -m unittest discover -s tests -v
"""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from google_workspace_mcp import docs as docs_mod  # noqa: E402
from google_workspace_mcp.docs import _find_text_ranges  # noqa: E402


def _cell(start, text):
    return {
        "content": [
            {
                "startIndex": start,
                "endIndex": start + len(text),
                "paragraph": {
                    "elements": [
                        {"startIndex": start, "textRun": {"content": text}}
                    ]
                },
            }
        ]
    }


class FindTextRangesInTablesTests(unittest.TestCase):
    """Regression: format_text could not see text inside a native table."""

    DOC = {
        "body": {
            "content": [
                {
                    "startIndex": 1,
                    "endIndex": 7,
                    "paragraph": {
                        "elements": [
                            {"startIndex": 1, "textRun": {"content": "Intro\n"}}
                        ]
                    },
                },
                {
                    "startIndex": 10,
                    "endIndex": 30,
                    "table": {
                        "tableRows": [
                            {
                                "tableCells": [
                                    _cell(10, "docx\n"),
                                    _cell(20, "pdf\n"),
                                ]
                            }
                        ]
                    },
                },
                {
                    "startIndex": 30,
                    "endIndex": 45,
                    "paragraph": {
                        "elements": [
                            {
                                "startIndex": 30,
                                "textRun": {"content": "the .docx file\n"},
                            }
                        ]
                    },
                },
            ]
        }
    }

    def test_walks_table_cells(self):
        self.assertEqual(_find_text_ranges(self.DOC, "docx"), [(10, 14), (35, 39)])
        self.assertEqual(_find_text_ranges(self.DOC, "pdf"), [(20, 23)])

    def test_text_outside_tables_still_resolves(self):
        self.assertEqual(_find_text_ranges(self.DOC, "Intro"), [(1, 6)])

    def test_missing_text(self):
        self.assertEqual(_find_text_ranges(self.DOC, "spreadsheet"), [])
        self.assertEqual(_find_text_ranges(self.DOC, ""), [])


def _heading(text, start, end, level=1):
    return {
        "startIndex": start,
        "endIndex": end,
        "paragraph": {
            "paragraphStyle": {"namedStyleType": f"HEADING_{level}"},
            "elements": [
                {"startIndex": start, "textRun": {"content": f"{text}\n"}}
            ],
        },
    }


def _paragraph(text, start, end):
    return {
        "startIndex": start,
        "endIndex": end,
        "paragraph": {
            "elements": [
                {"startIndex": start, "textRun": {"content": f"{text}\n"}}
            ]
        },
    }


def _table(start, end):
    return {
        "startIndex": start,
        "endIndex": end,
        "table": {"tableRows": [{"tableCells": [_cell(start, "x\n")]}]},
    }


class ReplaceSectionTableEndTests(unittest.TestCase):
    """A delete range that ends inside a table is rejected by the API, so a section
    whose last element is a table is deleted through the table's end."""

    def run_replace(self, body):
        # Stub through `.return_value`, never by calling the mock: calling
        # batchUpdate() here would register a call of the fixture's own, and
        # call_args_list[0] would then be that empty setup call (no `body` kwarg)
        # instead of the tool's delete request.
        service = mock.MagicMock()
        service.documents.return_value.get.return_value.execute.return_value = {
            "body": {"content": body},
            "lists": {},
            "title": "notes",
        }
        service.documents.return_value.batchUpdate.return_value.execute.return_value = {}
        with mock.patch.object(docs_mod, "get_docs_service", return_value=service):
            result = asyncio.run(
                docs_mod.gdocs_replace_section("doc-1", "Section", "New body")
            )
        delete = service.documents().batchUpdate.call_args_list[0].kwargs["body"][
            "requests"
        ][0]["deleteContentRange"]["range"]
        return result, delete

    def test_table_ending_section_deletes_through_the_table_end(self):
        result, delete = self.run_replace(
            [_heading("Section", 1, 10), _table(10, 40), _heading("Next", 40, 50)]
        )
        self.assertTrue(result["success"])
        self.assertEqual(delete["startIndex"], 10, "the heading itself is preserved")
        self.assertEqual(delete["endIndex"], 40, "delete through the table's end")

    def test_paragraph_ending_section_keeps_the_newline_before_the_next_heading(self):
        result, delete = self.run_replace(
            [
                _heading("Section", 1, 10),
                _paragraph("Body", 10, 40),
                _heading("Next", 40, 50),
            ]
        )
        self.assertTrue(result["success"])
        self.assertEqual(delete["startIndex"], 10)
        self.assertEqual(delete["endIndex"], 39, "one index short of the next heading")


if __name__ == "__main__":
    unittest.main()
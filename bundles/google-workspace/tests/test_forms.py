"""Unit tests for the pure Forms question builder shared by forms_add_question
and forms_create (no Google API client needed).

Run with:
    python -m unittest discover -s tests -v
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from google_workspace_mcp.forms_questions import _build_question  # noqa: E402


class BuildQuestionTests(unittest.TestCase):
    def test_paragraph_and_short_text(self):
        self.assertEqual(
            _build_question("PARAGRAPH", None, False),
            {"required": False, "textQuestion": {"paragraph": True}},
        )
        self.assertEqual(
            _build_question("short_text", None, True),
            {"required": True, "textQuestion": {"paragraph": False}},
        )

    def test_choice_types_need_options(self):
        q = _build_question("RADIO", ["a", 2], False)
        self.assertEqual(
            q["choiceQuestion"], {"type": "RADIO", "options": [{"value": "a"}, {"value": "2"}]}
        )
        with self.assertRaises(ValueError):
            _build_question("CHECKBOX", [], False)

    def test_unknown_type_rejected(self):
        with self.assertRaises(ValueError):
            _build_question("SCALE", None, False)


if __name__ == "__main__":
    unittest.main()

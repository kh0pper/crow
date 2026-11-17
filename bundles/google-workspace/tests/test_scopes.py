"""Unit tests for the GWS_OAUTH_SCOPES override (no Google API client needed).

Run with:
    python -m unittest discover -s tests -v
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from google_workspace_mcp.scopes import resolve_scopes  # noqa: E402

DEFAULT = ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/calendar"]


class ResolveScopesTests(unittest.TestCase):
    def test_unset_or_blank_keeps_default(self):
        self.assertEqual(resolve_scopes(DEFAULT, {}), DEFAULT)
        self.assertEqual(resolve_scopes(DEFAULT, {"GWS_OAUTH_SCOPES": "  "}), DEFAULT)

    def test_short_names_expand(self):
        self.assertEqual(
            resolve_scopes(DEFAULT, {"GWS_OAUTH_SCOPES": "gmail.compose, calendar.events drive.file"}),
            [
                "https://www.googleapis.com/auth/gmail.compose",
                "https://www.googleapis.com/auth/calendar.events",
                "https://www.googleapis.com/auth/drive.file",
            ],
        )

    def test_full_urls_kept_and_duplicates_dropped(self):
        url = "https://www.googleapis.com/auth/documents"
        self.assertEqual(
            resolve_scopes(DEFAULT, {"GWS_OAUTH_SCOPES": f"{url},documents"}), [url]
        )

    def test_default_list_is_not_mutated(self):
        default = list(DEFAULT)
        resolve_scopes(default, {"GWS_OAUTH_SCOPES": "gmail.compose"})
        self.assertEqual(default, DEFAULT)


if __name__ == "__main__":
    unittest.main()
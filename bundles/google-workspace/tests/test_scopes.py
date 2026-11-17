"""Unit tests for the GWS_OAUTH_SCOPES override.

`resolve_scopes` itself needs no Google API client; the last test imports auth to
check that every scope in its default list is in the known set, so it needs the
bundle's installed dependencies (as test_outbound_wiring does).

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

    def test_an_unknown_scope_is_reported_and_refused(self):
        # A typo must not reach the refresh: that fails later as "not authenticated".
        bad = "gmail.compose,gmail.reedonly"
        with self.assertRaises(ValueError) as ctx:
            resolve_scopes(DEFAULT, {"GWS_OAUTH_SCOPES": bad})
        self.assertIn("gmail.reedonly", str(ctx.exception))
        self.assertIn("GWS_OAUTH_SCOPES", str(ctx.exception))

    def test_an_unknown_scope_is_also_logged(self):
        with self.assertLogs("google_workspace_mcp.scopes", level="ERROR") as logs:
            with self.assertRaises(ValueError):
                resolve_scopes(DEFAULT, {"GWS_OAUTH_SCOPES": "nonsense.scope"})
        self.assertIn("nonsense.scope", "\n".join(logs.output))

    def test_a_scope_url_on_another_host_is_unknown(self):
        with self.assertRaises(ValueError):
            resolve_scopes(
                DEFAULT,
                {"GWS_OAUTH_SCOPES": "https://example.com/auth/drive"},
            )

    def test_every_default_scope_is_known(self):
        from google_workspace_mcp.auth import SCOPES
        from google_workspace_mcp.scopes import KNOWN_SCOPES, _PREFIX

        for url in SCOPES:
            self.assertIn(url[len(_PREFIX):], KNOWN_SCOPES, url)


if __name__ == "__main__":
    unittest.main()
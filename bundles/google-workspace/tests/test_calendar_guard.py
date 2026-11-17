"""Unit tests for the GWS_CALENDAR_NO_INVITES guard (no Google API client needed).

Run with:
    python -m unittest discover -s tests -v
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from google_workspace_mcp.calendar_guard import check_create, invites_blocked  # noqa: E402

GUEST = "someone@example.com"


class InvitesBlockedTests(unittest.TestCase):
    def test_off_by_default(self):
        self.assertFalse(invites_blocked({}))
        self.assertFalse(invites_blocked({"GWS_CALENDAR_NO_INVITES": "0"}))
        self.assertFalse(invites_blocked({"GWS_CALENDAR_NO_INVITES": ""}))
        self.assertFalse(invites_blocked({"GWS_CALENDAR_NO_INVITES": "off"}))

    def test_on_values(self):
        for v in ("1", "true", "TRUE", "yes", "on"):
            self.assertTrue(invites_blocked({"GWS_CALENDAR_NO_INVITES": v}), v)


class CheckCreateTests(unittest.TestCase):
    ON = {"GWS_CALENDAR_NO_INVITES": "1"}

    def test_switch_off_passes_everything_through(self):
        self.assertEqual(check_create([GUEST], "all", {}), (None, "all"))
        self.assertEqual(check_create(None, "externalOnly", {}), (None, "externalOnly"))

    def test_switch_on_rejects_attendees(self):
        error, _ = check_create([GUEST], "none", self.ON)
        self.assertIn("attendees", error)
        self.assertIn("GWS_CALENDAR_NO_INVITES", error)

    def test_switch_on_forces_send_updates_none(self):
        self.assertEqual(check_create(None, "all", self.ON), (None, "none"))
        self.assertEqual(check_create([], "externalOnly", self.ON), (None, "none"))


if __name__ == "__main__":
    unittest.main()
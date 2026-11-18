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
        self.assertEqual(check_create("primary", [GUEST], "all", {}), (None, "all"))
        self.assertEqual(
            check_create("team@group.example.net", None, "externalOnly", {}),
            (None, "externalOnly"),
        )

    def test_switch_on_rejects_attendees(self):
        error, _ = check_create("primary", [GUEST], "none", self.ON)
        self.assertIn("attendees", error)
        self.assertIn("GWS_CALENDAR_NO_INVITES", error)

    def test_switch_on_forces_send_updates_none(self):
        self.assertEqual(check_create("primary", None, "all", self.ON), (None, "none"))
        self.assertEqual(check_create("primary", [], "externalOnly", self.ON), (None, "none"))

    def test_switch_on_refuses_any_calendar_but_primary(self):
        for calendar_id in (
            "team@group.example.net",
            "someone-else@example.com",
            "Primary",
            "primary ",
            "",
        ):
            with self.subTest(calendar_id=calendar_id):
                error, send_updates = check_create(calendar_id, None, "all", self.ON)
                self.assertIsNotNone(error)
                self.assertIn("GWS_CALENDAR_NO_INVITES", error)
                self.assertIn("primary", error)
                self.assertEqual(send_updates, "none")

    def test_the_error_does_not_claim_more_than_it_enforces(self):
        # It used to say "events can only be added to the owner's own calendar",
        # which it did not check; the message now names the exact rule.
        error, _ = check_create("primary", [GUEST], "none", self.ON)
        self.assertIn("primary calendar", error)
        self.assertNotIn("owner's own calendar", error)


if __name__ == "__main__":
    unittest.main()
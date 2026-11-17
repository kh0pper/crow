"""Unit tests for the GWS_OUTBOUND_GUARD / GWS_OUTBOUND_ALLOWLIST decision module
(no Google API client needed: env in, decision out).

Run with:
    python -m unittest discover -s tests -v
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from google_workspace_mcp.outbound_guard import (  # noqa: E402
    allowlist,
    allowed_recipient,
    check_recipients,
    guard_enabled,
)

ON = {"GWS_OUTBOUND_GUARD": "1"}
ON_LIST = {
    "GWS_OUTBOUND_GUARD": "true",
    "GWS_OUTBOUND_ALLOWLIST": "alex@example.com, example.org",
}
WHAT = "inviting attendees"


class GuardEnabledTests(unittest.TestCase):
    def test_off_by_default(self):
        # The shipping default: an upgrade changes nothing.
        self.assertFalse(guard_enabled({}))
        self.assertFalse(guard_enabled({"GWS_OUTBOUND_GUARD": ""}))
        self.assertFalse(guard_enabled({"GWS_OUTBOUND_GUARD": "0"}))
        self.assertFalse(guard_enabled({"GWS_OUTBOUND_GUARD": "off"}))

    def test_on_values(self):
        for v in ("1", "true", "TRUE", "yes", "on", " On "):
            self.assertTrue(guard_enabled({"GWS_OUTBOUND_GUARD": v}), v)

    def test_an_unrecognized_value_is_off(self):
        # Anything that is not one of the on-words leaves the guard off, as shipped.
        self.assertFalse(guard_enabled({"GWS_OUTBOUND_GUARD": "enabled"}))


class AllowlistTests(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(allowlist({}), [])
        self.assertEqual(allowlist({"GWS_OUTBOUND_ALLOWLIST": " ,   "}), [])

    def test_comma_or_space_separated_normalized_and_deduped(self):
        env = {"GWS_OUTBOUND_ALLOWLIST": "Alex@Example.com, example.org  alex@example.com"}
        self.assertEqual(allowlist(env), ["alex@example.com", "example.org"])

    def test_a_leading_at_is_a_domain_entry(self):
        self.assertEqual(allowlist({"GWS_OUTBOUND_ALLOWLIST": "@example.org"}), ["example.org"])


class AllowedRecipientTests(unittest.TestCase):
    ENTRIES = ["alex@example.com", "example.org"]

    def test_exact_address_ignores_case(self):
        self.assertTrue(allowed_recipient("ALEX@example.com", self.ENTRIES))

    def test_a_domain_entry_covers_its_addresses(self):
        self.assertTrue(allowed_recipient("second-user@example.org", self.ENTRIES))

    def test_a_domain_entry_is_exact_not_a_suffix(self):
        self.assertFalse(allowed_recipient("alex@mail.example.org", self.ENTRIES))
        self.assertFalse(allowed_recipient("alex@notexample.org", self.ENTRIES))

    def test_blank_addresses_are_not_allowed(self):
        self.assertFalse(allowed_recipient("", self.ENTRIES))
        self.assertFalse(allowed_recipient("   ", self.ENTRIES))

    def test_an_unlisted_address_is_not_allowed(self):
        self.assertFalse(allowed_recipient("someone@example.com", self.ENTRIES))


class CheckRecipientsTests(unittest.TestCase):
    def test_guard_off_allows_everything(self):
        self.assertIsNone(check_recipients(["someone@example.com"], WHAT, {}))
        self.assertIsNone(check_recipients(["someone@example.com"], WHAT, {"GWS_OUTBOUND_GUARD": "0"}))
        # Off with an empty allowlist is still off: that is the upgrade path.
        self.assertIsNone(
            check_recipients(["someone@example.com"], WHAT, {"GWS_OUTBOUND_GUARD": "", "GWS_OUTBOUND_ALLOWLIST": ""})
        )

    def test_no_recipients_is_always_allowed(self):
        self.assertIsNone(check_recipients([], WHAT, ON))
        self.assertIsNone(check_recipients([None, ""], WHAT, ON))

    def test_an_allowlisted_recipient_passes(self):
        self.assertIsNone(check_recipients(["alex@example.com"], WHAT, ON_LIST))
        self.assertIsNone(check_recipients(["second-user@example.org"], WHAT, ON_LIST))

    def test_an_unlisted_recipient_is_refused_by_name(self):
        error = check_recipients(["someone@example.com"], WHAT, ON_LIST)
        self.assertIn(WHAT, error)
        self.assertIn("someone@example.com", error)
        self.assertIn("GWS_OUTBOUND_ALLOWLIST", error)
        self.assertIn("Nothing was sent", error)

    def test_an_empty_allowlist_refuses_every_recipient(self):
        error = check_recipients(["alex@example.com"], WHAT, ON)
        self.assertIn("alex@example.com", error)
        self.assertIn("GWS_OUTBOUND_ALLOWLIST", error)

    def test_only_the_blocked_recipients_are_named(self):
        error = check_recipients(
            ["alex@example.com", "someone@example.com"], WHAT, ON_LIST
        )
        self.assertIn("someone@example.com", error)
        self.assertNotIn("alex@example.com", error)

    def test_every_blocked_recipient_is_named(self):
        error = check_recipients(
            ["one@example.com", "two@example.net"], WHAT, ON_LIST
        )
        self.assertIn("one@example.com", error)
        self.assertIn("two@example.net", error)


if __name__ == "__main__":
    unittest.main()
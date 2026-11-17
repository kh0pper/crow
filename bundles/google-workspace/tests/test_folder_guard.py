"""Unit tests for the folder decision itself (no API client: metadata in,
decision out).

The wiring — the files.get, the cache, the tools — is covered by
test_outbound_wiring.py. This file pins the decision on the metadata Drive
returns, including the shapes that must fail closed.

Run with:
    python -m unittest discover -s tests -v
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from google_workspace_mcp.folder_guard import _decide  # noqa: E402

WHAT = "uploading a file into a Drive folder"
FOLDER = "folder-1"
OWNER = "alex@example.com"
ENTRIES = [OWNER]


def metadata(owners=(OWNER,), permissions=None):
    """A files.get response for a folder, with a default all-owner permission list."""
    if permissions is None:
        permissions = [{"type": "user", "role": "owner", "emailAddress": a} for a in owners]
    return {
        "id": FOLDER,
        "owners": [{"emailAddress": address} for address in owners],
        "permissions": list(permissions),
    }


def decide(info, entries=ENTRIES, self_address=OWNER):
    return _decide(WHAT, FOLDER, info, entries, self_address)


class FolderDecisionTests(unittest.TestCase):
    def test_your_own_folder_passes(self):
        self.assertIsNone(decide(metadata()))

    def test_an_allowlisted_grantee_passes(self):
        info = metadata(
            permissions=[
                {"type": "user", "role": "owner", "emailAddress": OWNER},
                {"type": "user", "role": "reader", "emailAddress": "colleague@example.com"},
            ]
        )
        self.assertIsNone(decide(info, entries=[OWNER, "example.com"]))

    def test_a_user_outside_the_allowlist_is_refused_by_name(self):
        info = metadata(
            permissions=[
                {"type": "user", "role": "owner", "emailAddress": OWNER},
                {"type": "user", "role": "writer", "emailAddress": "stranger@example.net"},
            ]
        )
        error = decide(info)
        self.assertIsNotNone(error)
        self.assertIn("stranger@example.net", error)
        self.assertIn("GWS_OUTBOUND_ALLOWLIST", error)
        self.assertIn("Nothing was written", error)
        self.assertNotIn(OWNER, error)

    def test_a_group_grantee_is_checked_like_a_person(self):
        info = metadata(
            permissions=[
                {"type": "user", "role": "owner", "emailAddress": OWNER},
                {"type": "group", "role": "reader", "emailAddress": "team@example.net"},
            ]
        )
        self.assertIn("team@example.net", decide(info))

    def test_an_anyone_permission_is_refused_whatever_the_allowlist_says(self):
        info = metadata(
            permissions=[
                {"type": "user", "role": "owner", "emailAddress": OWNER},
                {"type": "anyone", "role": "reader"},
            ]
        )
        error = decide(info, entries=["example.com", "example.net"])
        self.assertIn("anyone with the link", error)

    def test_a_domain_permission_is_refused_and_names_the_domain(self):
        info = metadata(
            permissions=[
                {"type": "user", "role": "owner", "emailAddress": OWNER},
                {"type": "domain", "role": "reader", "domain": "example.org"},
            ]
        )
        error = decide(info, entries=["example.org"])
        self.assertIn("whole domain example.org", error)

    def test_the_accounts_own_address_always_counts(self):
        # A folder owned by you, with an empty allowlist and no other grantee.
        self.assertIsNone(decide(metadata(), entries=[]))

    def test_an_unknown_own_address_falls_back_to_the_allowlist(self):
        self.assertIsNotNone(decide(metadata(), entries=[], self_address=None))
        self.assertIsNone(decide(metadata(), entries=[OWNER], self_address=None))

    def test_an_owner_without_a_readable_address_is_refused(self):
        info = {"id": FOLDER, "owners": [{"emailAddress": ""}], "permissions": []}
        self.assertIn("no readable address", decide(info))

    def test_a_grantee_without_a_readable_address_is_refused(self):
        info = metadata(
            permissions=[
                {"type": "user", "role": "owner", "emailAddress": OWNER},
                {"type": "user", "role": "reader"},
            ]
        )
        self.assertIn("no readable address", decide(info))

    def test_a_permission_type_this_module_does_not_know_is_refused(self):
        info = metadata(
            permissions=[
                {"type": "user", "role": "owner", "emailAddress": OWNER},
                {"type": "some-future-type", "role": "reader"},
            ]
        )
        self.assertIn("some-future-type", decide(info))

    def test_unreadable_metadata_fails_closed(self):
        self.assertIsNotNone(decide({"id": FOLDER}))
        self.assertIsNotNone(decide({"owners": [], "permissions": {}}))
        self.assertIsNotNone(decide(None))

    def test_a_shared_drive_destination_is_judged_on_its_direct_permissions(self):
        # A shared-drive item carries no owner of its own; the drive's members are
        # not in its permission list. Documented limit: pass on what IS visible.
        self.assertIsNone(decide({"id": FOLDER, "owners": [], "permissions": []}))


if __name__ == "__main__":
    unittest.main()
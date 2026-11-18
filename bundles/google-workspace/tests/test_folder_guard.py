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
TARGET = f"destination folder {FOLDER}"
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


def shared_drive_metadata(permissions=(), drive_id="drive-1"):
    """What files.get returns for an item in a Shared Drive.

    Drive omits `owners` for such an item entirely — it has no owner of its own —
    and its own permission list says nothing about the drive's members.
    """
    return {"id": FOLDER, "driveId": drive_id, "permissions": list(permissions)}


def decide(info, entries=ENTRIES, self_address=OWNER, drive_members=None):
    return _decide(WHAT, TARGET, info, entries, self_address, drive_members)


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

    def test_a_folder_reporting_no_owner_is_refused(self):
        # An item in My Drive always has an owner: an empty list is unread metadata.
        error = decide(metadata(owners=(), permissions=[]))
        self.assertIsNotNone(error)
        self.assertIn("no owner", error)

    # --- Shared Drives: the drive's members are the effective sharing -------

    def test_a_shared_drive_destination_is_judged_on_the_drives_members(self):
        # A shared-drive item carries no owner of its own and its own permission
        # list does not mention the drive's members; the effective listing does.
        info = shared_drive_metadata(permissions=[])  # direct list looks empty
        members = [{"type": "user", "role": "organizer", "emailAddress": OWNER}]
        self.assertIsNone(decide(info, drive_members=members))

    def test_a_shared_drive_member_outside_the_allowlist_is_refused(self):
        info = shared_drive_metadata()
        members = [
            {"type": "user", "role": "organizer", "emailAddress": OWNER},
            {"type": "group", "role": "writer", "emailAddress": "drive-team@example.net"},
        ]
        error = decide(info, drive_members=members)
        self.assertIsNotNone(error)
        self.assertIn("drive-team@example.net", error)
        self.assertIn("GWS_OUTBOUND_ALLOWLIST", error)

    def test_a_shared_drive_is_not_judged_on_the_items_own_permission_list(self):
        # The direct list here says "only the owner", which would pass; the drive's
        # members could not be read, so the write is refused rather than assumed safe.
        info = shared_drive_metadata(
            permissions=[{"type": "user", "role": "owner", "emailAddress": OWNER}]
        )
        error = decide(info)  # no effective listing
        self.assertIsNotNone(error)
        self.assertIn("Shared Drive", error)

    def test_a_shared_drive_item_with_no_owners_field_is_still_judged(self):
        # Drive omits `owners` entirely for a shared-drive item; that absence must
        # not be read as unreadable metadata (it means "no owner of its own").
        info = {"id": FOLDER, "driveId": "drive-1", "permissions": []}
        members = [{"type": "user", "role": "organizer", "emailAddress": OWNER}]
        self.assertIsNone(decide(info, drive_members=members))
        members.append(
            {"type": "user", "role": "writer", "emailAddress": "stranger@example.net"}
        )
        self.assertIn("stranger@example.net", decide(info, drive_members=members))

    def test_a_shared_drive_with_no_readable_members_is_refused(self):
        info = shared_drive_metadata()
        for members in (None, [], {"permissions": []}):
            with self.subTest(members=members):
                error = decide(info, drive_members=members)
                self.assertIsNotNone(error)
                self.assertIn("Shared Drive", error)

    def test_an_anyone_grant_on_a_shared_drive_is_refused(self):
        info = shared_drive_metadata()
        members = [
            {"type": "user", "role": "organizer", "emailAddress": OWNER},
            {"type": "anyone", "role": "reader"},
        ]
        self.assertIn("anyone with the link", decide(info, drive_members=members))


if __name__ == "__main__":
    unittest.main()
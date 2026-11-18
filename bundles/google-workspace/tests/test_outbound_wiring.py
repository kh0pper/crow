"""The outbound guard and the calendar invite switch AS WIRED into the tools.

The point of each test: a refused call makes no API call at all, an allowlisted
(or guard-off) call goes through unchanged, and GWS_CALENDAR_NO_INVITES drops
invitations and every calendar but `primary`. The Apps Script write/run tools and
a foreign Forms shim are refused by the outbound guard, and so is a write into a
folder that guard does not cover (its owners and permissions are read first — see
folder_guard), a new version of a file that is shared outside the allowlist (that
file's own sharing is read first), a write on a calendar other than `primary`, a
local-image `gdocs_insert_image` (it would publish the upload briefly) and the
anyone/domain permission a Drive-hosted insert used to create under the guard
(an image must already be shared, and a failed revoke is a reported failure),
and a `link_url` whose scheme is not http/https/mailto. The service objects are
mocks, so nothing leaves the process.

Run with:
    python -m unittest discover -s tests -v
"""

import asyncio
import contextlib
import copy
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from google_workspace_mcp import apps_script as apps_script_mod  # noqa: E402
from google_workspace_mcp import calendar as gcal_mod  # noqa: E402
from google_workspace_mcp import docs as docs_mod, folder_guard  # noqa: E402
from google_workspace_mcp import drive, forms as forms_mod, gmail  # noqa: E402
from google_workspace_mcp import sheets as sheets_mod, slides as slides_mod  # noqa: E402

GUARD_VARS = (
    "GWS_OUTBOUND_GUARD",
    "GWS_OUTBOUND_ALLOWLIST",
    "GWS_CALENDAR_NO_INVITES",
    "GWS_FORMS_SHIM_SCRIPT_ID",
    # The local path rules' folder: pinned empty so a file a test writes is only
    # reachable when that test hands the tool the folder it lives in.
    "GWS_FILES_DIR",
)

GUEST = "someone@example.com"
OWNER = "alex@example.com"
ORGANIZER = "organizer@example.net"
# A secondary/shared calendar's id: it looks like an address, which is the point.
GROUP_CALENDAR = "team@group.example.net"


@contextlib.contextmanager
def gws_env(**values):
    """Pin the guard knobs for one test; everything else is left alone."""
    with mock.patch.dict(os.environ, {k: "" for k in GUARD_VARS}):
        os.environ.update({k: v for k, v in values.items() if v is not None})
        yield


@contextlib.contextmanager
def files_folder():
    """A temporary GWS_FILES_DIR with a local file in it: ``(folder, file)``.

    A tool that reads a local file may only read one inside the files folder
    (local_paths), and a bare TemporaryDirectory is not inside any folder — so the
    fixture file has to live in the folder handed to the tool, or the refusal under
    test would be the path rule's rather than the guard's.
    """
    with tempfile.TemporaryDirectory() as folder:
        local = os.path.join(folder, "note.txt")
        with open(local, "w", encoding="utf-8") as fh:
            fh.write("v2")
        yield folder, local


# --- Calendar -------------------------------------------------------------


def calendar_service(event=None):
    # Stub through `.return_value`, never by calling the mock: calling
    # insert()/get()/patch() here would register a call of the fixture's own and
    # make a later assert_not_called() / call_args_list[0] lie about the tool.
    service = mock.MagicMock()
    service.events.return_value.insert.return_value.execute.return_value = {
        "id": "event-1",
        "htmlLink": "https://example.com/event",
        "summary": "sync",
        "start": {"date": "2026-01-02"},
        "end": {"date": "2026-01-03"},
        "status": "confirmed",
    }
    service.events.return_value.get.return_value.execute.return_value = copy.deepcopy(
        dict(event or {})
    )
    service.events.return_value.patch.return_value.execute.return_value = {"id": "event-1"}
    return service


def run_create(service, **kwargs):
    with mock.patch.object(gcal_mod, "get_calendar_service", return_value=service):
        return asyncio.run(
            gcal_mod.gcal_create_event("sync", "2026-01-02", "2026-01-03", **kwargs)
        )


def run_respond(service, response="accepted", **kwargs):
    with mock.patch.object(gcal_mod, "get_calendar_service", return_value=service):
        return asyncio.run(gcal_mod.gcal_respond_to_event("event-1", response, **kwargs))


class CalendarCreateGuardTests(unittest.TestCase):
    def test_guard_off_is_unchanged(self):
        service = calendar_service()
        with gws_env():
            result = run_create(service, attendees=[GUEST], send_updates="all")
        self.assertTrue(result["success"])
        kwargs = service.events().insert.call_args.kwargs
        self.assertEqual(kwargs["sendUpdates"], "all")
        self.assertEqual(kwargs["body"]["attendees"], [{"email": GUEST}])

    def test_guard_on_refuses_an_unlisted_attendee_and_makes_no_call(self):
        service = calendar_service()
        with gws_env(GWS_OUTBOUND_GUARD="1"):
            result = run_create(service, attendees=[GUEST], send_updates="all")
        self.assertFalse(result["success"])
        self.assertIn(GUEST, result["error"])
        service.events().insert.assert_not_called()

    def test_guard_on_allows_an_allowlisted_attendee(self):
        service = calendar_service()
        with gws_env(GWS_OUTBOUND_GUARD="1", GWS_OUTBOUND_ALLOWLIST="example.com"):
            result = run_create(service, attendees=[GUEST], send_updates="all")
        self.assertTrue(result["success"])
        self.assertEqual(service.events().insert.call_args.kwargs["sendUpdates"], "all")

    def test_guard_on_never_refuses_an_event_with_no_attendees(self):
        # sendUpdates alone has no recipient: Google has nobody to email.
        service = calendar_service()
        with gws_env(GWS_OUTBOUND_GUARD="1"):
            result = run_create(service, send_updates="all")
        self.assertTrue(result["success"])
        self.assertEqual(service.events().insert.call_args.kwargs["sendUpdates"], "all")

    def test_guard_on_refuses_a_calendar_other_than_primary(self):
        # Writing on a shared calendar is visible to that calendar's owners, and the
        # id looks like an address, so it goes through the same allowlist.
        service = calendar_service()
        with gws_env(GWS_OUTBOUND_GUARD="1", GWS_OUTBOUND_ALLOWLIST=OWNER):
            result = run_create(service, calendar_id=GROUP_CALENDAR)
        self.assertFalse(result["success"])
        self.assertIn(GROUP_CALENDAR, result["error"])
        self.assertIn("writing to a calendar", result["error"])
        service.events().insert.assert_not_called()

    def test_guard_on_allows_an_allowlisted_calendar(self):
        service = calendar_service()
        with gws_env(GWS_OUTBOUND_GUARD="1", GWS_OUTBOUND_ALLOWLIST=GROUP_CALENDAR):
            result = run_create(service, calendar_id=GROUP_CALENDAR)
        self.assertTrue(result["success"])
        self.assertEqual(
            service.events().insert.call_args.kwargs["calendarId"], GROUP_CALENDAR
        )

    def test_guard_on_never_refuses_the_primary_calendar(self):
        service = calendar_service()
        with gws_env(GWS_OUTBOUND_GUARD="1"):  # empty allowlist
            result = run_create(service, calendar_id="primary")
        self.assertTrue(result["success"])

    def test_a_trailing_newline_on_a_recipient_never_reaches_the_api(self):
        # The guard decides on the trimmed value, so the trimmed value is sent.
        service = calendar_service()
        with gws_env(GWS_OUTBOUND_GUARD="1", GWS_OUTBOUND_ALLOWLIST="example.com"):
            result = run_create(service, attendees=[GUEST + "\n"], send_updates="all")
        self.assertTrue(result["success"])
        body = service.events().insert.call_args.kwargs["body"]
        self.assertEqual(body["attendees"], [{"email": GUEST}])


class CalendarNoInvitesTests(unittest.TestCase):
    def test_no_invites_refuses_attendees(self):
        service = calendar_service()
        with gws_env(GWS_CALENDAR_NO_INVITES="1"):
            result = run_create(service, attendees=[GUEST], send_updates="all")
        self.assertFalse(result["success"])
        self.assertIn("GWS_CALENDAR_NO_INVITES", result["error"])
        service.events().insert.assert_not_called()

    def test_no_invites_forces_send_updates_none(self):
        service = calendar_service()
        with gws_env(GWS_CALENDAR_NO_INVITES="1"):
            result = run_create(service, send_updates="all")
        self.assertTrue(result["success"])
        self.assertEqual(service.events().insert.call_args.kwargs["sendUpdates"], "none")
        self.assertNotIn("attendees", service.events().insert.call_args.kwargs["body"])

    def test_no_invites_wins_over_an_allowlisted_attendee(self):
        service = calendar_service()
        with gws_env(GWS_CALENDAR_NO_INVITES="1", GWS_OUTBOUND_GUARD="1",
                     GWS_OUTBOUND_ALLOWLIST="example.com"):
            result = run_create(service, attendees=[GUEST], send_updates="all")
        self.assertFalse(result["success"])
        service.events().insert.assert_not_called()

    def test_no_invites_refuses_a_calendar_other_than_primary(self):
        # A secondary/shared calendar has its own owner to notify, so adding an
        # event there is an outbound write even with no attendees named.
        service = calendar_service()
        with gws_env(GWS_CALENDAR_NO_INVITES="1"):
            result = run_create(service, calendar_id=GROUP_CALENDAR)
        self.assertFalse(result["success"])
        self.assertIn("primary", result["error"])
        self.assertIn(GROUP_CALENDAR, result["error"])
        service.events().insert.assert_not_called()

    def test_no_invites_is_case_sensitive_about_primary(self):
        service = calendar_service()
        with gws_env(GWS_CALENDAR_NO_INVITES="1"):
            result = run_create(service, calendar_id="Primary")
        self.assertFalse(result["success"])
        service.events().insert.assert_not_called()

    def test_the_primary_calendar_still_works_under_no_invites(self):
        service = calendar_service()
        with gws_env(GWS_CALENDAR_NO_INVITES="1"):
            result = run_create(service, calendar_id="primary", send_updates="none")
        self.assertTrue(result["success"])
        self.assertEqual(
            service.events().insert.call_args.kwargs["calendarId"], "primary"
        )


class CalendarRespondTests(unittest.TestCase):
    EVENT = {
        "id": "event-1",
        "organizer": {"email": ORGANIZER},
        "attendees": [{"email": OWNER, "self": True, "responseStatus": "needsAction"}],
    }

    def test_guard_off_is_unchanged(self):
        service = calendar_service(self.EVENT)
        with gws_env():
            result = run_respond(service)
        self.assertTrue(result["success"])
        self.assertEqual(service.events().patch.call_args.kwargs["sendUpdates"], "all")

    def test_guard_on_refuses_an_unlisted_organizer_and_makes_no_call(self):
        service = calendar_service(self.EVENT)
        with gws_env(GWS_OUTBOUND_GUARD="1", GWS_OUTBOUND_ALLOWLIST=OWNER):
            result = run_respond(service)
        self.assertFalse(result["success"])
        self.assertIn(ORGANIZER, result["error"])
        service.events().patch.assert_not_called()

    def test_guard_on_allows_an_allowlisted_organizer(self):
        service = calendar_service(self.EVENT)
        with gws_env(GWS_OUTBOUND_GUARD="1", GWS_OUTBOUND_ALLOWLIST="example.net"):
            result = run_respond(service)
        self.assertTrue(result["success"])
        service.events().patch.assert_called_once()

    def test_no_invites_refuses_responding_without_reading_the_event(self):
        service = calendar_service(self.EVENT)
        with gws_env(GWS_CALENDAR_NO_INVITES="1"):
            result = run_respond(service)
        self.assertFalse(result["success"])
        self.assertIn("GWS_CALENDAR_NO_INVITES", result["error"])
        service.events().get.assert_not_called()
        service.events().patch.assert_not_called()

    def test_guard_on_refuses_a_shared_calendar_before_reading_the_event(self):
        service = calendar_service(self.EVENT)
        with gws_env(GWS_OUTBOUND_GUARD="1", GWS_OUTBOUND_ALLOWLIST=OWNER):
            result = run_respond(service, calendar_id=GROUP_CALENDAR)
        self.assertFalse(result["success"])
        self.assertIn(GROUP_CALENDAR, result["error"])
        service.events().get.assert_not_called()
        service.events().patch.assert_not_called()

    def test_guard_on_allows_an_allowlisted_shared_calendar(self):
        service = calendar_service(self.EVENT)
        # The calendar id and the organizer (the reply's recipient) both have to
        # be on the list: this call is refused for one, then checked for the other.
        with gws_env(
            GWS_OUTBOUND_GUARD="1",
            GWS_OUTBOUND_ALLOWLIST=f"{GROUP_CALENDAR},example.net",
        ):
            result = run_respond(service, calendar_id=GROUP_CALENDAR)
        self.assertTrue(result["success"])
        self.assertEqual(
            service.events().patch.call_args.kwargs["calendarId"], GROUP_CALENDAR
        )


# --- Drive -----------------------------------------------------------------


def drive_service():
    # Named-attribute stubbing only (see calendar_service): the tool's own call to
    # permissions().create() must be the first one recorded.
    service = mock.MagicMock()
    service.permissions.return_value.create.return_value.execute.return_value = {
        "id": "perm-1",
        "role": "writer",
        "emailAddress": GUEST,
    }
    return service


class DriveShareGuardTests(unittest.TestCase):
    def run_share(self, service, **kwargs):
        with mock.patch.object(drive, "get_drive_service", return_value=service):
            return asyncio.run(drive.gdrive_share("file-1", GUEST, **kwargs))

    def test_a_silent_share_is_checked_too(self):
        # Granting access IS the outbound effect; notify only adds an email on top.
        service = drive_service()
        with gws_env(GWS_OUTBOUND_GUARD="1"):
            result = self.run_share(service)
        self.assertFalse(result["success"])
        self.assertIn(GUEST, result["error"])
        service.permissions().create.assert_not_called()

    def test_a_silent_share_to_an_allowlisted_address_goes_through_silently(self):
        service = drive_service()
        with gws_env(GWS_OUTBOUND_GUARD="1", GWS_OUTBOUND_ALLOWLIST=GUEST):
            result = self.run_share(service)
        self.assertTrue(result["success"])
        self.assertFalse(service.permissions().create.call_args.kwargs["sendNotificationEmail"])

    def test_notification_to_an_unlisted_address_is_refused(self):
        service = drive_service()
        with gws_env(GWS_OUTBOUND_GUARD="1"):
            result = self.run_share(service, notify=True)
        self.assertFalse(result["success"])
        self.assertIn(GUEST, result["error"])
        service.permissions().create.assert_not_called()

    def test_notification_to_an_allowlisted_address_goes_through(self):
        service = drive_service()
        with gws_env(GWS_OUTBOUND_GUARD="1", GWS_OUTBOUND_ALLOWLIST=GUEST):
            result = self.run_share(service, notify=True)
        self.assertTrue(result["success"])
        self.assertTrue(service.permissions().create.call_args.kwargs["sendNotificationEmail"])

    def test_a_malformed_grantee_is_refused_before_any_call(self):
        # A comma-list whose second half IS allowlisted must not slip through.
        service = drive_service()
        with gws_env(GWS_OUTBOUND_GUARD="1", GWS_OUTBOUND_ALLOWLIST="example.com"), \
                mock.patch.object(drive, "get_drive_service", return_value=service):
            result = asyncio.run(
                drive.gdrive_share("file-1", "x@example.net,y@example.com")
            )
        self.assertFalse(result["success"])
        self.assertIn("x@example.net,y@example.com", result["error"])
        service.permissions().create.assert_not_called()

    def test_a_trailing_newline_on_a_grantee_never_reaches_the_api(self):
        service = drive_service()
        with gws_env(GWS_OUTBOUND_GUARD="1", GWS_OUTBOUND_ALLOWLIST=GUEST):
            result = self.run_share_with(service, GUEST + "\n")
        self.assertTrue(result["success"])
        body = service.permissions().create.call_args.kwargs["body"]
        self.assertEqual(body["emailAddress"], GUEST)
        self.assertEqual(result["data"]["email"], GUEST)

    def run_share_with(self, service, email, **kwargs):
        with mock.patch.object(drive, "get_drive_service", return_value=service):
            return asyncio.run(drive.gdrive_share("file-1", email, **kwargs))


class DriveTransferGuardTests(unittest.TestCase):
    def run_transfer(self, service):
        with mock.patch.object(drive, "get_drive_service", return_value=service):
            return asyncio.run(drive.gdrive_transfer_ownership("file-1", GUEST))

    def test_guard_off_is_unchanged(self):
        service = drive_service()
        with gws_env():
            result = self.run_transfer(service)
        self.assertTrue(result["success"])
        service.permissions().create.assert_called_once()

    def test_unlisted_new_owner_is_refused(self):
        service = drive_service()
        with gws_env(GWS_OUTBOUND_GUARD="1"):
            result = self.run_transfer(service)
        self.assertFalse(result["success"])
        self.assertIn(GUEST, result["error"])
        service.permissions().create.assert_not_called()

    def test_allowlisted_new_owner_goes_through(self):
        service = drive_service()
        with gws_env(GWS_OUTBOUND_GUARD="1", GWS_OUTBOUND_ALLOWLIST=GUEST):
            result = self.run_transfer(service)
        self.assertTrue(result["success"])
        service.permissions().create.assert_called_once()


# --- Drive folders ---------------------------------------------------------
#
# The guard reads the DESTINATION folder before a write: a file put into a folder
# someone else can read has been shared without a single mail-like call.

FOLDER = "folder-1"
STRANGER = "someone@example.net"


def folder_metadata(owner=OWNER, shared=(), extra=()):
    """What files.get returns for a folder: its owners and its permission list."""
    permissions = [{"type": "user", "role": "owner", "emailAddress": owner}]
    permissions += [
        {"type": "user", "role": "reader", "emailAddress": address}
        for address in shared
    ]
    permissions += list(extra)
    return {
        "id": FOLDER,
        "owners": [{"emailAddress": owner}],
        "permissions": permissions,
    }


def folder_service(metadata=None, error=None, account=OWNER):
    """A Drive service whose folder read answers with `metadata`, or raises `error`.

    `account` is what Drive's `about` reports as the signed-in address; None means
    that lookup fails too. Named-attribute stubbing only (see calendar_service).
    """
    service = mock.MagicMock()
    if error is not None:
        service.files.return_value.get.return_value.execute.side_effect = error
    else:
        service.files.return_value.get.return_value.execute.return_value = metadata
    if account is None:
        service.about.return_value.get.return_value.execute.side_effect = RuntimeError(
            "about is unavailable"
        )
    else:
        service.about.return_value.get.return_value.execute.return_value = {
            "user": {"emailAddress": account}
        }
    service.files.return_value.copy.return_value.execute.return_value = {
        "id": "copy-1",
        "name": "copy",
        "parents": [FOLDER],
        "mimeType": "text/plain",
    }
    service.files.return_value.update.return_value.execute.return_value = {
        "id": "file-1",
        "name": "note.txt",
        "mimeType": "text/plain",
        "version": "2",
    }
    return service


def shared_drive_service(members=(), listing_error=None, account=OWNER):
    """A Drive service for a folder in a SHARED DRIVE.

    files.get reports a `driveId` and an empty own-permission list (that is what a
    shared-drive item looks like); the effective members come from
    permissions().list, and `listing_error` makes that listing fail.
    """
    service = mock.MagicMock()
    service.files.return_value.get.return_value.execute.return_value = {
        "id": FOLDER,
        "driveId": "drive-1",
        # Drive omits `owners` for a shared-drive item: it has none of its own.
        "permissions": [],
    }
    if listing_error is not None:
        service.permissions.return_value.list.return_value.execute.side_effect = (
            listing_error
        )
    else:
        service.permissions.return_value.list.return_value.execute.return_value = {
            "permissions": list(members)
        }
    service.about.return_value.get.return_value.execute.return_value = {
        "user": {"emailAddress": account}
    }
    service.files.return_value.copy.return_value.execute.return_value = {
        "id": "copy-1",
        "name": "copy",
        "parents": [FOLDER],
        "mimeType": "text/plain",
    }
    service.files.return_value.update.return_value.execute.return_value = {
        "id": "file-1",
        "name": "note.txt",
        "mimeType": "text/plain",
        "version": "2",
    }
    return service


class DriveFolderGuardTests(unittest.TestCase):
    def setUp(self):
        # The account's own address is cached per process.
        folder_guard.reset_cache()

    def run_copy(self, service, parent_id=FOLDER):
        with mock.patch.object(
            drive, "get_drive_service", return_value=service
        ), mock.patch.object(folder_guard, "get_drive_service", return_value=service):
            return asyncio.run(drive.gdrive_copy_file("file-1", parent_id=parent_id))

    def test_a_folder_shared_with_a_stranger_is_refused(self):
        service = folder_service(folder_metadata(shared=[STRANGER]))
        with gws_env(GWS_OUTBOUND_GUARD="1", GWS_OUTBOUND_ALLOWLIST=OWNER):
            result = self.run_copy(service)
        self.assertFalse(result["success"])
        self.assertIn(STRANGER, result["error"])
        self.assertIn("GWS_OUTBOUND_GUARD", result["error"])
        service.files().copy.assert_not_called()

    def test_an_anyone_with_the_link_folder_is_refused(self):
        service = folder_service(
            folder_metadata(extra=[{"type": "anyone", "role": "reader"}])
        )
        with gws_env(GWS_OUTBOUND_GUARD="1", GWS_OUTBOUND_ALLOWLIST=OWNER):
            result = self.run_copy(service)
        self.assertFalse(result["success"])
        self.assertIn("anyone with the link", result["error"])
        service.files().copy.assert_not_called()

    def test_a_whole_domain_permission_is_refused(self):
        service = folder_service(
            folder_metadata(
                extra=[{"type": "domain", "role": "reader", "domain": "example.org"}]
            )
        )
        with gws_env(GWS_OUTBOUND_GUARD="1", GWS_OUTBOUND_ALLOWLIST=OWNER):
            result = self.run_copy(service)
        self.assertFalse(result["success"])
        self.assertIn("example.org", result["error"])
        service.files().copy.assert_not_called()

    def test_your_own_folder_is_allowed_with_an_empty_allowlist(self):
        # The account's own address is recognised through Drive's `about`.
        service = folder_service(folder_metadata())
        with gws_env(GWS_OUTBOUND_GUARD="1"):
            result = self.run_copy(service)
        self.assertTrue(result["success"])
        service.files().copy.assert_called_once()

    def test_a_folder_shared_only_with_an_allowlisted_address_is_allowed(self):
        service = folder_service(folder_metadata(shared=[GUEST]))
        with gws_env(GWS_OUTBOUND_GUARD="1", GWS_OUTBOUND_ALLOWLIST="example.com"):
            result = self.run_copy(service)
        self.assertTrue(result["success"])
        service.files().copy.assert_called_once()

    def test_the_folder_read_asks_for_owners_and_permissions_and_all_drives(self):
        service = folder_service(folder_metadata())
        with gws_env(GWS_OUTBOUND_GUARD="1"):
            self.run_copy(service)
        kwargs = service.files().get.call_args.kwargs
        self.assertEqual(kwargs["fileId"], FOLDER)
        self.assertIn("owners", kwargs["fields"])
        self.assertIn("permissions", kwargs["fields"])
        self.assertTrue(kwargs["supportsAllDrives"])

    def test_a_folder_whose_sharing_cannot_be_read_is_refused(self):
        service = folder_service(error=RuntimeError("boom"))
        with gws_env(GWS_OUTBOUND_GUARD="1", GWS_OUTBOUND_ALLOWLIST=OWNER):
            result = self.run_copy(service)
        self.assertFalse(result["success"])
        self.assertIn("could not be read", result["error"])
        service.files().copy.assert_not_called()

    def test_an_unknown_own_address_leaves_only_the_allowlist(self):
        service = folder_service(folder_metadata(), account=None)
        with gws_env(GWS_OUTBOUND_GUARD="1"):  # empty allowlist
            result = self.run_copy(service)
        self.assertFalse(result["success"])
        self.assertIn(OWNER, result["error"])
        service.files().copy.assert_not_called()

    def test_no_folder_is_my_drive_root_and_nothing_is_looked_up(self):
        service = folder_service(folder_metadata())
        with gws_env(GWS_OUTBOUND_GUARD="1"):
            result = self.run_copy(service, parent_id=None)
        self.assertTrue(result["success"])
        service.files().get.assert_not_called()

    def test_a_folder_reporting_no_owner_is_refused(self):
        # An item in My Drive always has an owner: an empty list is unread metadata.
        service = folder_service({"id": FOLDER, "owners": [], "permissions": []})
        with gws_env(GWS_OUTBOUND_GUARD="1", GWS_OUTBOUND_ALLOWLIST=OWNER):
            result = self.run_copy(service)
        self.assertFalse(result["success"])
        self.assertIn("no owner", result["error"])
        service.files().copy.assert_not_called()

    # --- Shared Drives: judged on the drive's effective permissions ---------

    def test_a_shared_drive_member_outside_the_allowlist_is_refused(self):
        service = shared_drive_service(
            members=[
                {"type": "user", "role": "organizer", "emailAddress": OWNER},
                {"type": "user", "role": "writer", "emailAddress": STRANGER},
            ]
        )
        with gws_env(GWS_OUTBOUND_GUARD="1", GWS_OUTBOUND_ALLOWLIST=OWNER):
            result = self.run_copy(service)
        self.assertFalse(result["success"])
        self.assertIn(STRANGER, result["error"])
        service.files().copy.assert_not_called()

    def test_a_shared_drive_whose_members_are_all_allowlisted_is_allowed(self):
        service = shared_drive_service(
            members=[{"type": "user", "role": "organizer", "emailAddress": OWNER}]
        )
        with gws_env(GWS_OUTBOUND_GUARD="1"):  # the account's own address only
            result = self.run_copy(service)
        self.assertTrue(result["success"])
        service.files().copy.assert_called_once()

    def test_the_shared_drive_read_asks_for_the_drives_effective_permissions(self):
        service = shared_drive_service(
            members=[{"type": "user", "role": "organizer", "emailAddress": OWNER}]
        )
        with gws_env(GWS_OUTBOUND_GUARD="1"):
            result = self.run_copy(service)
        self.assertTrue(result["success"])
        kwargs = service.permissions().list.call_args.kwargs
        self.assertEqual(kwargs["fileId"], FOLDER)
        self.assertTrue(kwargs["supportsAllDrives"])
        self.assertIn("permissionDetails", kwargs["fields"])
        self.assertIn("emailAddress", kwargs["fields"])

    def test_a_shared_drive_member_list_that_fails_is_refused(self):
        service = shared_drive_service(listing_error=RuntimeError("boom"))
        with gws_env(GWS_OUTBOUND_GUARD="1", GWS_OUTBOUND_ALLOWLIST=OWNER):
            result = self.run_copy(service)
        self.assertFalse(result["success"])
        self.assertIn("Shared Drive", result["error"])
        service.files().copy.assert_not_called()

    def test_an_empty_shared_drive_member_list_is_refused(self):
        service = shared_drive_service(members=[])
        with gws_env(GWS_OUTBOUND_GUARD="1", GWS_OUTBOUND_ALLOWLIST=OWNER):
            result = self.run_copy(service)
        self.assertFalse(result["success"])
        self.assertIn("Shared Drive", result["error"])
        service.files().copy.assert_not_called()

    def test_a_my_drive_folder_never_reads_a_member_list(self):
        # The effective listing is only asked for when the item is in a Shared Drive.
        service = folder_service(folder_metadata())
        with gws_env(GWS_OUTBOUND_GUARD="1"):
            result = self.run_copy(service)
        self.assertTrue(result["success"])
        service.permissions.assert_not_called()

    def test_guard_off_reads_nothing_and_writes_where_it_was_told(self):
        service = folder_service(error=RuntimeError("must not be read"))
        with gws_env():
            result = self.run_copy(service)
        self.assertTrue(result["success"])
        service.files().get.assert_not_called()
        service.files().copy.assert_called_once()

    def test_every_tool_that_writes_into_a_folder_is_refused_first(self):
        # A refusal happens before the tool builds its own client, so the folder
        # guard's service is the only one that has to exist here: it proves the
        # write itself (and every read on the way to it) never runs. The local file
        # lives inside GWS_FILES_DIR, so the local path rules pass it and the
        # refusal asserted below is the folder guard's own.
        with tempfile.TemporaryDirectory() as folder:
            local = os.path.join(folder, "note.txt")
            with open(local, "w", encoding="utf-8") as fh:
                fh.write("x")
            runners = {
                "gdrive_upload_file": lambda: drive.gdrive_upload_file(local, FOLDER),
                "gdrive_copy_file": lambda: drive.gdrive_copy_file(
                    "file-1", parent_id=FOLDER
                ),
                "gdrive_move_file": lambda: drive.gdrive_move_file("file-1", FOLDER),
                "gdrive_create_folder": lambda: drive.gdrive_create_folder("new", FOLDER),
                "gdrive_create_shortcut": lambda: drive.gdrive_create_shortcut(
                    "target-1", FOLDER
                ),
                "sheets_create": lambda: sheets_mod.sheets_create("t", folder_id=FOLDER),
                "gdocs_create": lambda: docs_mod.gdocs_create(FOLDER, "t"),
                "gslides_create": lambda: slides_mod.gslides_create("t", FOLDER),
                "forms_create": lambda: forms_mod.forms_create("t", folder_id=FOLDER),
            }
            for name, runner in runners.items():
                with self.subTest(tool=name):
                    folder_guard.reset_cache()
                    service = folder_service(folder_metadata(shared=[STRANGER]))
                    with gws_env(
                        GWS_OUTBOUND_GUARD="1",
                        GWS_OUTBOUND_ALLOWLIST=OWNER,
                        GWS_FILES_DIR=folder,
                    ), mock.patch.object(
                        folder_guard, "get_drive_service", return_value=service
                    ):
                        result = asyncio.run(runner())
                    self.assertFalse(result["success"], name)
                    self.assertIn(STRANGER, result["error"], name)


# --- Drive: a new version of an existing file ------------------------------
#
# `gdrive_upload_new_version` writes IN PLACE: the file's own sharing (and, in a
# Shared Drive, the drive's members) is the question, not a parent folder's.


class DriveNewVersionGuardTests(unittest.TestCase):
    def setUp(self):
        # The account's own address is cached per process.
        folder_guard.reset_cache()

    def run_upload(self, service, local):
        with mock.patch.object(
            drive, "get_drive_service", return_value=service
        ), mock.patch.object(folder_guard, "get_drive_service", return_value=service):
            return asyncio.run(drive.gdrive_upload_new_version("file-1", local))

    def test_a_file_shared_with_a_stranger_is_refused_and_nothing_is_uploaded(self):
        service = folder_service(folder_metadata(shared=[STRANGER]))
        with files_folder() as (folder, local):
            with gws_env(
                GWS_OUTBOUND_GUARD="1",
                GWS_OUTBOUND_ALLOWLIST=OWNER,
                GWS_FILES_DIR=folder,
            ):
                result = self.run_upload(service, local)
        self.assertFalse(result["success"])
        self.assertIn(STRANGER, result["error"])
        self.assertIn("GWS_OUTBOUND_GUARD", result["error"])
        # Refused before the media upload: the content is never replaced.
        service.files().update.assert_not_called()

    def test_the_target_file_is_what_gets_checked(self):
        service = folder_service(folder_metadata(shared=[STRANGER]))
        with files_folder() as (folder, local):
            with gws_env(
                GWS_OUTBOUND_GUARD="1",
                GWS_OUTBOUND_ALLOWLIST=OWNER,
                GWS_FILES_DIR=folder,
            ):
                self.run_upload(service, local)
        kwargs = service.files().get.call_args.kwargs
        self.assertEqual(kwargs["fileId"], "file-1")
        self.assertIn("owners", kwargs["fields"])
        self.assertIn("permissions", kwargs["fields"])
        self.assertTrue(kwargs["supportsAllDrives"])

    def test_your_own_file_is_allowed(self):
        service = folder_service(folder_metadata())
        with files_folder() as (folder, local):
            # the account's own address only
            with gws_env(GWS_OUTBOUND_GUARD="1", GWS_FILES_DIR=folder):
                result = self.run_upload(service, local)
        self.assertTrue(result["success"])
        service.files().update.assert_called_once()

    def test_a_file_whose_sharing_cannot_be_read_is_refused(self):
        service = folder_service(error=RuntimeError("boom"))
        with files_folder() as (folder, local):
            with gws_env(
                GWS_OUTBOUND_GUARD="1",
                GWS_OUTBOUND_ALLOWLIST=OWNER,
                GWS_FILES_DIR=folder,
            ):
                result = self.run_upload(service, local)
        self.assertFalse(result["success"])
        self.assertIn("could not be read", result["error"])
        service.files().update.assert_not_called()

    def test_guard_off_uploads_without_reading_the_file(self):
        service = folder_service(error=RuntimeError("must not be read"))
        with files_folder() as (folder, local):
            with gws_env(GWS_FILES_DIR=folder):
                result = self.run_upload(service, local)
        self.assertTrue(result["success"])
        service.files().get.assert_not_called()
        service.files().update.assert_called_once()


# --- Docs: a local image insert, and the link scheme -----------------------


def docs_image_mocks(permissions=(), revoke_error=None, list_error=None):
    """Docs + Drive services good enough for one gdocs_insert_image call.

    `permissions` is the sharing the Drive file already carries (what
    permissions().list reports), `list_error` makes that listing fail, and
    `revoke_error` makes deleting the tool's own grant fail.
    """
    docs_svc = mock.MagicMock()
    docs_svc.documents.return_value.batchUpdate.return_value.execute.return_value = {}
    drive_svc = mock.MagicMock()
    drive_svc.files.return_value.create.return_value.execute.return_value = {
        "id": "temp-1"
    }
    drive_svc.files.return_value.update.return_value.execute.return_value = {}
    drive_svc.permissions.return_value.create.return_value.execute.return_value = {
        "id": "perm-1"
    }
    if list_error is not None:
        drive_svc.permissions.return_value.list.return_value.execute.side_effect = (
            list_error
        )
    else:
        drive_svc.permissions.return_value.list.return_value.execute.return_value = {
            "permissions": list(permissions)
        }
    if revoke_error is not None:
        drive_svc.permissions.return_value.delete.return_value.execute.side_effect = (
            revoke_error
        )
    else:
        drive_svc.permissions.return_value.delete.return_value.execute.return_value = {}
    return docs_svc, drive_svc


def png_bytes():
    """A PNG header with a readable width/height (16x9)."""
    return (
        b"\x89PNG\r\n\x1a\n"
        + (13).to_bytes(4, "big")
        + b"IHDR"
        + (16).to_bytes(4, "big")
        + (9).to_bytes(4, "big")
        + b"\x08\x02\x00\x00\x00"
    )


class DocsImageGuardTests(unittest.TestCase):
    def run_insert(self, docs_svc, drive_svc, image):
        with mock.patch.object(
            docs_mod, "get_docs_service", return_value=docs_svc
        ), mock.patch.object(docs_mod, "get_drive_service", return_value=drive_svc):
            return asyncio.run(docs_mod.gdocs_insert_image("doc-1", image, index=1))

    def test_a_local_image_is_refused_under_the_guard_and_nothing_is_uploaded(self):
        docs_svc, drive_svc = docs_image_mocks()
        with tempfile.TemporaryDirectory() as folder:
            local = os.path.join(folder, "shot.png")
            with open(local, "wb") as fh:
                fh.write(png_bytes())
            # The image is inside GWS_FILES_DIR, so the local path rules allow it:
            # the refusal asserted here is the guard's, not the path rule's.
            with gws_env(GWS_OUTBOUND_GUARD="1", GWS_FILES_DIR=folder):
                result = self.run_insert(docs_svc, drive_svc, local)
        self.assertFalse(result["success"])
        self.assertIn("LOCAL image", result["error"])
        self.assertIn("GWS_OUTBOUND_GUARD", result["error"])
        # Refused before any client is used: no upload, no public grant, no insert.
        drive_svc.files.return_value.create.assert_not_called()
        drive_svc.permissions.return_value.create.assert_not_called()
        docs_svc.documents.return_value.batchUpdate.assert_not_called()

    def test_a_local_image_still_works_with_the_guard_off(self):
        docs_svc, drive_svc = docs_image_mocks()
        with tempfile.TemporaryDirectory() as folder:
            local = os.path.join(folder, "shot.png")
            with open(local, "wb") as fh:
                fh.write(png_bytes())
            with gws_env(GWS_FILES_DIR=folder):
                result = self.run_insert(docs_svc, drive_svc, local)
        self.assertTrue(result["success"])
        drive_svc.files.return_value.create.assert_called_once()
        # The brief anyone-with-link grant is still made, and still revoked.
        body = drive_svc.permissions.return_value.create.call_args.kwargs["body"]
        self.assertEqual(body["type"], "anyone")
        drive_svc.permissions.return_value.delete.assert_called_once()

    def test_a_drive_hosted_image_is_refused_under_the_guard_when_it_is_private(self):
        docs_svc, drive_svc = docs_image_mocks(
            permissions=[{"id": "perm-owner", "type": "user", "role": "owner"}]
        )
        with gws_env(GWS_OUTBOUND_GUARD="1"):
            result = self.run_insert(docs_svc, drive_svc, "drive-file-1")
        self.assertFalse(result["success"])
        # The required wording: already-shared or nothing happens.
        self.assertIn("must already be shared for embedding", result["error"])
        self.assertIn("won't make a file public", result["error"])
        self.assertIn("GWS_OUTBOUND_GUARD", result["error"])
        # Nothing was published, and nothing was inserted.
        drive_svc.permissions.return_value.create.assert_not_called()
        drive_svc.permissions.return_value.delete.assert_not_called()
        docs_svc.documents.return_value.batchUpdate.assert_not_called()

    def test_a_whole_domain_grant_does_not_count_as_readable_under_the_guard(self):
        # A domain grant still needs a sign-in, so the Docs API cannot fetch it.
        docs_svc, drive_svc = docs_image_mocks(
            permissions=[
                {"id": "perm-d", "type": "domain", "role": "reader", "domain": "example.org"}
            ]
        )
        with gws_env(GWS_OUTBOUND_GUARD="1"):
            result = self.run_insert(docs_svc, drive_svc, "drive-file-1")
        self.assertFalse(result["success"])
        self.assertIn("must already be shared for embedding", result["error"])
        drive_svc.permissions.return_value.create.assert_not_called()
        docs_svc.documents.return_value.batchUpdate.assert_not_called()

    def test_an_already_shared_drive_image_is_inserted_with_no_new_permission(self):
        docs_svc, drive_svc = docs_image_mocks(
            permissions=[{"id": "perm-any", "type": "anyone", "role": "reader"}]
        )
        with gws_env(GWS_OUTBOUND_GUARD="1"):
            result = self.run_insert(docs_svc, drive_svc, "drive-file-1")
        self.assertTrue(result["success"])
        drive_svc.permissions.return_value.create.assert_not_called()
        drive_svc.permissions.return_value.delete.assert_not_called()
        self.assertIsNone(result["data"]["public_permission_created"])
        docs_svc.documents.return_value.batchUpdate.assert_called_once()

    def test_a_drive_image_whose_sharing_cannot_be_read_is_refused(self):
        docs_svc, drive_svc = docs_image_mocks(list_error=RuntimeError("boom"))
        with gws_env(GWS_OUTBOUND_GUARD="1"):
            result = self.run_insert(docs_svc, drive_svc, "drive-file-1")
        self.assertFalse(result["success"])
        self.assertIn("could not be read", result["error"])
        drive_svc.permissions.return_value.create.assert_not_called()
        docs_svc.documents.return_value.batchUpdate.assert_not_called()

    def test_a_drive_hosted_image_with_the_guard_off_creates_and_revokes_one_grant(self):
        docs_svc, drive_svc = docs_image_mocks()
        with gws_env():
            result = self.run_insert(docs_svc, drive_svc, "drive-file-1")
        self.assertTrue(result["success"])
        body = drive_svc.permissions.return_value.create.call_args.kwargs["body"]
        self.assertEqual(body["type"], "anyone")
        self.assertEqual(body["role"], "reader")
        drive_svc.permissions.return_value.delete.assert_called_once()
        kwargs = drive_svc.permissions.return_value.delete.call_args.kwargs
        self.assertEqual(kwargs["permissionId"], "perm-1")
        self.assertEqual(kwargs["fileId"], "drive-file-1")
        self.assertEqual(result["data"]["public_permission_created"], "perm-1")

    def test_the_revoke_targets_exactly_the_permission_the_tool_created(self):
        docs_svc, drive_svc = docs_image_mocks()
        drive_svc.permissions.return_value.create.return_value.execute.return_value = {
            "id": "perm-42"
        }
        with gws_env():
            result = self.run_insert(docs_svc, drive_svc, "drive-file-1")
        self.assertTrue(result["success"])
        kwargs = drive_svc.permissions.return_value.delete.call_args.kwargs
        self.assertEqual(kwargs["permissionId"], "perm-42")

    def test_a_failed_revoke_is_reported_as_a_failure_not_a_success(self):
        docs_svc, drive_svc = docs_image_mocks(revoke_error=RuntimeError("boom"))
        with gws_env():
            result = self.run_insert(docs_svc, drive_svc, "drive-file-1")
        self.assertFalse(result["success"])
        self.assertIn("STILL readable by anyone with the link", result["error"])
        self.assertIn("perm-1", result["error"])
        self.assertIn("drive-file-1", result["error"])
        self.assertEqual(result["data"]["permission_id"], "perm-1")
        self.assertFalse(result["data"]["permission_revoked"])
        self.assertTrue(result["data"]["inserted"])

    def test_a_failed_revoke_while_the_insert_failed_is_still_reported(self):
        docs_svc, drive_svc = docs_image_mocks(revoke_error=RuntimeError("boom"))
        docs_svc.documents.return_value.batchUpdate.return_value.execute.side_effect = (
            RuntimeError("doc")
        )
        with gws_env():
            result = self.run_insert(docs_svc, drive_svc, "drive-file-1")
        self.assertFalse(result["success"])
        self.assertIn("STILL readable by anyone with the link", result["error"])
        self.assertFalse(result["data"]["inserted"])


class DocsLinkGuardTests(unittest.TestCase):
    def test_a_non_web_link_scheme_is_refused_before_any_call(self):
        for url in (
            "javascript:alert(1)",
            "data:text/html,<b>x</b>",
            "file:///etc/passwd",
            "ftp://example.net/x",
        ):
            with self.subTest(url=url):
                with mock.patch.object(docs_mod, "get_docs_service") as docs_service:
                    result = asyncio.run(
                        docs_mod.gdocs_format_text("doc-1", "text", link_url=url)
                    )
                self.assertFalse(result["success"])
                self.assertIn("http, https or mailto", result["error"])
                self.assertIn(url, result["error"])
                docs_service.assert_not_called()

    def test_an_http_link_still_becomes_a_link(self):
        docs_svc = mock.MagicMock()
        docs_svc.documents.return_value.get.return_value.execute.return_value = {
            "body": {
                "content": [
                    {
                        "paragraph": {
                            "elements": [
                                {"startIndex": 1, "textRun": {"content": "text\n"}}
                            ]
                        }
                    }
                ]
            }
        }
        with mock.patch.object(docs_mod, "get_docs_service", return_value=docs_svc):
            result = asyncio.run(
                docs_mod.gdocs_format_text(
                    "doc-1", "text", link_url="https://example.net/x"
                )
            )
        self.assertTrue(result["success"])
        requests = docs_svc.documents.return_value.batchUpdate.call_args.kwargs["body"][
            "requests"
        ]
        self.assertEqual(requests[0]["updateTextStyle"]["textStyle"]["link"], {
            "url": "https://example.net/x"
        })


# --- Gmail -----------------------------------------------------------------


def gmail_service():
    # Named-attribute stubbing only (see calendar_service): the tool's own call to
    # filters().create() must be the first one recorded.
    service = mock.MagicMock()
    create = service.users.return_value.settings.return_value.filters.return_value.create
    create.return_value.execute.return_value = {"id": "filter-1"}
    return service


class GmailFilterForwardGuardTests(unittest.TestCase):
    def run_filter(self, service, **kwargs):
        with mock.patch.object(gmail, "get_gmail_service", return_value=service):
            return asyncio.run(gmail.gmail_create_filter(**kwargs))

    def test_guard_off_is_unchanged(self):
        service = gmail_service()
        with gws_env():
            result = self.run_filter(service, subject="invoice", forward=GUEST)
        self.assertTrue(result["success"])
        body = service.users().settings().filters().create.call_args.kwargs["body"]
        self.assertEqual(body["action"]["forward"], GUEST)

    def test_forward_to_an_unlisted_address_is_refused(self):
        service = gmail_service()
        with gws_env(GWS_OUTBOUND_GUARD="1"):
            result = self.run_filter(service, subject="invoice", forward=GUEST)
        self.assertFalse(result["success"])
        self.assertIn(GUEST, result["error"])
        service.users().settings().filters().create.assert_not_called()

    def test_forward_to_an_allowlisted_address_goes_through(self):
        service = gmail_service()
        with gws_env(GWS_OUTBOUND_GUARD="1", GWS_OUTBOUND_ALLOWLIST="example.com"):
            result = self.run_filter(service, subject="invoice", forward=GUEST)
        self.assertTrue(result["success"])
        body = service.users().settings().filters().create.call_args.kwargs["body"]
        self.assertEqual(body["action"]["forward"], GUEST)

    def test_a_filter_without_forward_is_never_refused(self):
        service = gmail_service()
        with gws_env(GWS_OUTBOUND_GUARD="1"):
            result = self.run_filter(service, subject="invoice", archive=True)
        self.assertTrue(result["success"])
        service.users().settings().filters().create.assert_called_once()


# --- Apps Script -----------------------------------------------------------


def script_service():
    # Named-attribute stubbing only (see calendar_service): a tool's own getContent /
    # updateContent / run call must be the first one recorded for it.
    service = mock.MagicMock()
    service.projects.return_value.getContent.return_value.execute.return_value = {
        "scriptId": "script-1",
        "files": [{"name": "Code", "type": "SERVER_JS", "source": "old"}],
    }
    service.projects.return_value.updateContent.return_value.execute.return_value = {
        "scriptId": "script-1",
        "files": [{"name": "Code", "type": "SERVER_JS", "source": "new"}],
    }
    service.scripts.return_value.run.return_value.execute.return_value = {
        "response": {"result": "ok"}
    }
    return service


class AppsScriptGuardTests(unittest.TestCase):
    MESSAGE = "Apps Script can send mail or share files"

    def run_update_file(self, service):
        with mock.patch.object(
            apps_script_mod, "get_script_service", return_value=service
        ):
            return asyncio.run(
                apps_script_mod.apps_script_update_file("script-1", "Code", "x = 1")
            )

    def run_update_content(self, service):
        with mock.patch.object(
            apps_script_mod, "get_script_service", return_value=service
        ):
            return asyncio.run(
                apps_script_mod.apps_script_update_content(
                    "script-1",
                    [{"name": "appsscript", "type": "JSON", "source": "{}"}],
                )
            )

    def run_script(self, service):
        with mock.patch.object(
            apps_script_mod, "get_script_service", return_value=service
        ):
            return asyncio.run(apps_script_mod.apps_script_run("script-1", "main"))

    def run_get_content(self, service):
        with mock.patch.object(
            apps_script_mod, "get_script_service", return_value=service
        ):
            return asyncio.run(apps_script_mod.apps_script_get_content("script-1"))

    def test_every_write_and_run_tool_is_refused_when_the_guard_is_on(self):
        for runner in (
            self.run_update_file,
            self.run_update_content,
            self.run_script,
        ):
            service = script_service()
            with gws_env(GWS_OUTBOUND_GUARD="1"):
                result = runner(service)
            self.assertFalse(result["success"], runner.__name__)
            self.assertIn(self.MESSAGE, result["error"], runner.__name__)
            # Refused before any API call: neither a read nor a write happened.
            service.projects.return_value.getContent.assert_not_called()
            service.projects.return_value.updateContent.assert_not_called()
            service.scripts.return_value.run.assert_not_called()

    def test_the_guard_off_leaves_every_tool_unchanged(self):
        service = script_service()
        with gws_env():
            self.assertTrue(self.run_update_file(service)["success"])
            self.assertTrue(self.run_update_content(service)["success"])
            self.assertTrue(self.run_script(service)["success"])

    def test_reading_source_stays_available_while_the_guard_is_on(self):
        service = script_service()
        with gws_env(GWS_OUTBOUND_GUARD="1"):
            result = self.run_get_content(service)
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["file_count"], 1)


# --- Forms shim ------------------------------------------------------------

CONFIGURED_SHIM = "shim-configured"


def forms_service(linked_sheet_id="sheet-1"):
    service = mock.MagicMock()
    service.forms.return_value.get.return_value.execute.return_value = {
        "formId": "form-1",
        "linkedSheetId": linked_sheet_id,
    }
    return service


class FormsShimGuardTests(unittest.TestCase):
    MARKER = "GWS_FORMS_SHIM_SCRIPT_ID"

    def run_set(self, script, forms_svc, **kwargs):
        with mock.patch.object(
            forms_mod, "get_script_service", return_value=script
        ), mock.patch.object(forms_mod, "get_forms_service", return_value=forms_svc):
            return asyncio.run(
                forms_mod.forms_set_destination("form-1", "sheet-1", **kwargs)
            )

    def test_a_foreign_shim_is_refused_when_the_guard_is_on(self):
        script = script_service()
        with gws_env(GWS_OUTBOUND_GUARD="1", GWS_FORMS_SHIM_SCRIPT_ID=CONFIGURED_SHIM):
            result = self.run_set(script, forms_service(), shim_script_id="other-shim")
        self.assertFalse(result["success"])
        self.assertIn("other-shim", result["error"])
        self.assertIn(self.MARKER, result["error"])
        script.scripts.return_value.run.assert_not_called()

    def test_a_caller_supplied_shim_is_refused_when_none_is_configured(self):
        script = script_service()
        with gws_env(GWS_OUTBOUND_GUARD="1"):
            result = self.run_set(script, forms_service(), shim_script_id="other-shim")
        self.assertFalse(result["success"])
        script.scripts.return_value.run.assert_not_called()

    def test_the_configured_shim_still_runs_when_the_guard_is_on(self):
        script = script_service()
        with gws_env(GWS_OUTBOUND_GUARD="1", GWS_FORMS_SHIM_SCRIPT_ID=CONFIGURED_SHIM):
            result = self.run_set(script, forms_service())
        self.assertTrue(result["success"])
        self.assertEqual(
            script.scripts().run.call_args.kwargs["scriptId"], CONFIGURED_SHIM
        )

    def test_naming_the_configured_shim_explicitly_is_allowed(self):
        script = script_service()
        with gws_env(GWS_OUTBOUND_GUARD="1", GWS_FORMS_SHIM_SCRIPT_ID=CONFIGURED_SHIM):
            result = self.run_set(
                script, forms_service(), shim_script_id=CONFIGURED_SHIM
            )
        self.assertTrue(result["success"])
        script.scripts().run.assert_called_once()

    def test_the_guard_off_accepts_a_caller_supplied_shim(self):
        script = script_service()
        with gws_env():
            result = self.run_set(script, forms_service(), shim_script_id="any-shim")
        self.assertTrue(result["success"])
        self.assertEqual(script.scripts().run.call_args.kwargs["scriptId"], "any-shim")


if __name__ == "__main__":
    unittest.main()
"""The outbound guard and the calendar invite switch AS WIRED into the tools.

The point of each test: a refused call makes no API call at all, an allowlisted
(or guard-off) call goes through unchanged, and GWS_CALENDAR_NO_INVITES drops
invitations entirely. The service objects are mocks, so nothing leaves the
process.

Run with:
    python -m unittest discover -s tests -v
"""

import asyncio
import contextlib
import copy
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from google_workspace_mcp import calendar as gcal_mod  # noqa: E402
from google_workspace_mcp import drive, gmail  # noqa: E402

GUARD_VARS = ("GWS_OUTBOUND_GUARD", "GWS_OUTBOUND_ALLOWLIST", "GWS_CALENDAR_NO_INVITES")

GUEST = "someone@example.com"
OWNER = "alex@example.com"
ORGANIZER = "organizer@example.net"


@contextlib.contextmanager
def gws_env(**values):
    """Pin the three guard knobs for one test; everything else is left alone."""
    with mock.patch.dict(os.environ, {k: "" for k in GUARD_VARS}):
        os.environ.update({k: v for k, v in values.items() if v is not None})
        yield


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


def run_respond(service, response="accepted"):
    with mock.patch.object(gcal_mod, "get_calendar_service", return_value=service):
        return asyncio.run(gcal_mod.gcal_respond_to_event("event-1", response))


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

    def test_silent_share_is_never_refused(self):
        service = drive_service()
        with gws_env(GWS_OUTBOUND_GUARD="1"):
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


if __name__ == "__main__":
    unittest.main()
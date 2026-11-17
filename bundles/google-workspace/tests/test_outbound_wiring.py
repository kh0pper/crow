"""The outbound guard and the calendar invite switch AS WIRED into the tools.

The point of each test: a refused call makes no API call at all, an allowlisted
(or guard-off) call goes through unchanged, and GWS_CALENDAR_NO_INVITES drops
invitations and every calendar but `primary`. The Apps Script write/run tools and
a foreign Forms shim are refused by the outbound guard. The service objects are
mocks, so nothing leaves the process.

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

from google_workspace_mcp import apps_script as apps_script_mod  # noqa: E402
from google_workspace_mcp import calendar as gcal_mod  # noqa: E402
from google_workspace_mcp import drive, forms as forms_mod, gmail  # noqa: E402

GUARD_VARS = (
    "GWS_OUTBOUND_GUARD",
    "GWS_OUTBOUND_ALLOWLIST",
    "GWS_CALENDAR_NO_INVITES",
    "GWS_FORMS_SHIM_SCRIPT_ID",
)

GUEST = "someone@example.com"
OWNER = "alex@example.com"
ORGANIZER = "organizer@example.net"


@contextlib.contextmanager
def gws_env(**values):
    """Pin the guard knobs for one test; everything else is left alone."""
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

    def test_no_invites_refuses_a_calendar_other_than_primary(self):
        # A secondary/shared calendar has its own owner to notify, so adding an
        # event there is an outbound write even with no attendees named.
        service = calendar_service()
        with gws_env(GWS_CALENDAR_NO_INVITES="1"):
            result = run_create(service, calendar_id="team@group.calendar.google.com")
        self.assertFalse(result["success"])
        self.assertIn("primary", result["error"])
        self.assertIn("team@group.calendar.google.com", result["error"])
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
                drive.gdrive_share("file-1", "x@evil.com,y@example.com")
            )
        self.assertFalse(result["success"])
        self.assertIn("x@evil.com,y@example.com", result["error"])
        service.permissions().create.assert_not_called()


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
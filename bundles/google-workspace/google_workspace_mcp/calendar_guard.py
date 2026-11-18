"""GWS_CALENDAR_NO_INVITES: keep calendar writes on the owner's own calendar.

When the switch is on, a create may not name attendees and Google is never asked
to email anyone (send_updates is forced to 'none'), the event may only go on the
`primary` calendar, and responding to an invitation is refused because that
notifies the organizer. This closes the calendar-invite exfiltration path for
assistants that also read untrusted mail.

Writing to any calendar other than `primary` is refused too, and for the same
reason: a secondary or shared calendar has its own owner and its own notification
settings, so an event added there can email a third party without naming a single
attendee. Only the exact lowercase id `primary` is accepted — a calendar id is an
arbitrary string (often an email address), so case-insensitive or fuzzy matching
would just widen the door.

Pure module so the tests run without the API client.
"""

import os
from typing import Mapping, Optional

_ON = {"1", "true", "yes", "on"}

# The only calendar a guarded create may write to. Compared case-sensitively and
# exactly: `Primary`, the account's address, or a shared calendar's id all differ.
OWNER_CALENDAR_ID = "primary"


def invites_blocked(env: Mapping[str, str] = os.environ) -> bool:
    return env.get("GWS_CALENDAR_NO_INVITES", "").strip().lower() in _ON


def check_create(
    calendar_id: str,
    attendees: Optional[list],
    send_updates: str,
    env: Mapping[str, str] = os.environ,
) -> tuple[Optional[str], str]:
    """Return (error, send_updates_to_use) for gcal_create_event."""
    if not invites_blocked(env):
        return None, send_updates
    if calendar_id != OWNER_CALENDAR_ID:
        return (
            "calendar_id must be exactly 'primary' on this server "
            f"(GWS_CALENDAR_NO_INVITES): '{calendar_id}' is refused, because writing "
            "to another calendar can notify its owner",
            "none",
        )
    if attendees:
        return (
            "attendees are disabled on this server (GWS_CALENDAR_NO_INVITES): the "
            "event is added to the primary calendar with no guests, and Google is "
            "never asked to email anyone",
            "none",
        )
    return None, "none"
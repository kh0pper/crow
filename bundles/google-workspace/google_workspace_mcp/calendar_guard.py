"""GWS_CALENDAR_NO_INVITES: keep calendar writes on the owner's own calendar.

When the switch is on, a create may not name attendees and Google is never asked
to email anyone (send_updates is forced to 'none'), and responding to an
invitation is refused because that notifies the organizer. This closes the
calendar-invite exfiltration path for assistants that also read untrusted mail.
Pure module so the tests run without the API client.
"""

import os
from typing import Mapping, Optional

_ON = {"1", "true", "yes", "on"}


def invites_blocked(env: Mapping[str, str] = os.environ) -> bool:
    return env.get("GWS_CALENDAR_NO_INVITES", "").strip().lower() in _ON


def check_create(
    attendees: Optional[list], send_updates: str, env: Mapping[str, str] = os.environ
) -> tuple[Optional[str], str]:
    """Return (error, send_updates_to_use) for gcal_create_event."""
    if not invites_blocked(env):
        return None, send_updates
    if attendees:
        return (
            "attendees are disabled on this server (GWS_CALENDAR_NO_INVITES): "
            "events can only be added to the owner's own calendar",
            "none",
        )
    return None, "none"
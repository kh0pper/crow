"""
Google Calendar tools — list calendars, read/create/respond to events.

Uses classic calendar.googleapis.com REST API via google-api-python-client.
Scopes: calendar + calendar.events.

All tools return the {"success": bool, "data"?: dict, "error"?: str}
shape.
"""

import asyncio
import logging
from typing import Optional

from .auth import get_calendar_service
from .guardrails import handle_google_errors

logger = logging.getLogger(__name__)


@handle_google_errors
async def gcal_list_calendars() -> dict:
    """List all calendars the user has access to."""
    service = get_calendar_service()
    result = await asyncio.to_thread(
        lambda: service.calendarList().list().execute()
    )
    items = result.get("items", [])
    return {
        "success": True,
        "data": {
            "count": len(items),
            "calendars": [
                {
                    "id": c["id"],
                    "summary": c.get("summary"),
                    "primary": c.get("primary", False),
                    "access_role": c.get("accessRole"),
                    "time_zone": c.get("timeZone"),
                    "selected": c.get("selected", False),
                }
                for c in items
            ],
        },
    }


@handle_google_errors
async def gcal_list_events(
    calendar_id: str = "primary",
    time_min: Optional[str] = None,
    time_max: Optional[str] = None,
    max_results: int = 20,
    query: Optional[str] = None,
    single_events: bool = True,
) -> dict:
    """
    List events in a calendar.

    calendar_id: calendar identifier; defaults to "primary" (the user's main calendar).
    time_min / time_max: RFC3339 timestamps (e.g. '2026-04-22T00:00:00Z').
    Omit both to get upcoming events from "now".
    query: free-text search over event content.
    single_events: if True, recurring series are expanded into individual instances.
    """
    service = get_calendar_service()
    kwargs = {
        "calendarId": calendar_id,
        "maxResults": max_results,
        "orderBy": "startTime" if single_events else "updated",
        "singleEvents": single_events,
    }
    if time_min:
        kwargs["timeMin"] = time_min
    if time_max:
        kwargs["timeMax"] = time_max
    if query:
        kwargs["q"] = query
    # If no time bounds given, default to "from now".
    if not time_min and not time_max:
        from datetime import datetime, timezone
        kwargs["timeMin"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    result = await asyncio.to_thread(
        lambda: service.events().list(**kwargs).execute()
    )
    events = result.get("items", [])
    return {
        "success": True,
        "data": {
            "calendar_id": calendar_id,
            "count": len(events),
            "events": [
                {
                    "id": e.get("id"),
                    "summary": e.get("summary"),
                    "description": e.get("description"),
                    "location": e.get("location"),
                    "start": e.get("start"),
                    "end": e.get("end"),
                    "status": e.get("status"),
                    "attendees": [
                        {"email": a.get("email"), "response_status": a.get("responseStatus")}
                        for a in e.get("attendees", [])
                    ],
                    "html_link": e.get("htmlLink"),
                    "creator": e.get("creator", {}).get("email"),
                    "organizer": e.get("organizer", {}).get("email"),
                }
                for e in events
            ],
        },
    }


@handle_google_errors
async def gcal_get_event(event_id: str, calendar_id: str = "primary") -> dict:
    """Fetch a specific event's full details."""
    service = get_calendar_service()
    event = await asyncio.to_thread(
        lambda: service.events().get(calendarId=calendar_id, eventId=event_id).execute()
    )
    return {"success": True, "data": event}


@handle_google_errors
async def gcal_create_event(
    summary: str,
    start: str,
    end: str,
    calendar_id: str = "primary",
    description: Optional[str] = None,
    location: Optional[str] = None,
    attendees: Optional[list[str]] = None,
    send_updates: str = "none",
) -> dict:
    """
    Create a calendar event.

    start, end: RFC3339 timestamps (e.g. '2026-04-23T15:00:00-05:00') or
    all-day date strings ('2026-04-23'). If they look like dates rather
    than timestamps, the event is all-day.
    attendees: list of email addresses to invite.
    send_updates: 'none' (default, draft-like), 'all', or 'externalOnly'.
    """
    service = get_calendar_service()

    def _time_field(value: str) -> dict:
        # crude but sufficient: bare date -> all-day; otherwise dateTime.
        if len(value) == 10 and value[4] == "-" and value[7] == "-":
            return {"date": value}
        return {"dateTime": value}

    body = {
        "summary": summary,
        "start": _time_field(start),
        "end": _time_field(end),
    }
    if description:
        body["description"] = description
    if location:
        body["location"] = location
    if attendees:
        body["attendees"] = [{"email": e} for e in attendees]

    event = await asyncio.to_thread(
        lambda: service.events().insert(
            calendarId=calendar_id, body=body, sendUpdates=send_updates
        ).execute()
    )
    return {
        "success": True,
        "data": {
            "event_id": event.get("id"),
            "html_link": event.get("htmlLink"),
            "summary": event.get("summary"),
            "start": event.get("start"),
            "end": event.get("end"),
            "status": event.get("status"),
        },
    }


@handle_google_errors
async def gcal_respond_to_event(
    event_id: str,
    response: str,
    calendar_id: str = "primary",
    comment: Optional[str] = None,
) -> dict:
    """
    Respond to a calendar invitation as the calendar owner.

    response: 'accepted', 'declined', or 'tentative'.
    """
    if response not in ("accepted", "declined", "tentative"):
        return {"success": False, "error": "response must be accepted / declined / tentative"}

    service = get_calendar_service()
    event = await asyncio.to_thread(
        lambda: service.events().get(calendarId=calendar_id, eventId=event_id).execute()
    )
    # Find the current user as an attendee and update responseStatus
    attendees = event.get("attendees", [])
    self_email = None
    for a in attendees:
        if a.get("self"):
            self_email = a.get("email")
            a["responseStatus"] = response
            if comment:
                a["comment"] = comment
            break
    if not self_email:
        return {"success": False, "error": "current user is not an attendee of this event"}

    updated = await asyncio.to_thread(
        lambda: service.events().patch(
            calendarId=calendar_id, eventId=event_id,
            body={"attendees": attendees}, sendUpdates="all",
        ).execute()
    )
    return {
        "success": True,
        "data": {
            "event_id": updated.get("id"),
            "response": response,
            "self_email": self_email,
        },
    }

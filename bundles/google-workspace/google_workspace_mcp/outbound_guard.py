"""GWS_OUTBOUND_GUARD / GWS_OUTBOUND_ALLOWLIST: one owner list in front of every
outbound mail-like side effect this server can trigger.

Three tool families make Google deliver something to an address the CALLER chose
rather than the owner:

  - Calendar — an event's attendees, and responding to an invitation (that emails
    the organizer);
  - Drive — a share's "shared with you" notification, and an ownership transfer's
    email;
  - Gmail — a filter's forward address.

An assistant that also reads untrusted mail can be talked into using one of them
as an outbound channel. With the guard on (`GWS_OUTBOUND_GUARD` = 1/true/yes/on),
an address is allowed only when `GWS_OUTBOUND_ALLOWLIST` lists it, or lists its
domain; every other recipient is refused, and no request is made to Google at all.

Off by default: an install that upgrades to the version shipping this file keeps
behaving exactly as it did. The walled deployment turns it on and names what it may
write to. `GWS_CALENDAR_NO_INVITES` (see calendar_guard) is the harder switch: it
drops invitations and invite replies outright, allowlist or not.

The allowlist holds entries separated by commas or spaces, matched case-insensitively:
`alex@example.com` and `example.com` (which allows any address whose domain is
exactly `example.com` — no wildcards, and not its subdomains).

Pure module (env in, decision out) so the tests run without the API client.
"""

import os
import re
from typing import Iterable, Mapping, Optional

_ON = {"1", "true", "yes", "on"}
_SPLIT_RE = re.compile(r"[,\s]+")


def guard_enabled(env: Mapping[str, str] = os.environ) -> bool:
    return env.get("GWS_OUTBOUND_GUARD", "").strip().lower() in _ON


def _normalize(entry: str) -> str:
    return (entry or "").strip().strip(".").lstrip("@").strip().lower()


def allowlist(env: Mapping[str, str] = os.environ) -> list[str]:
    """The configured entries, normalized and in order, without duplicates."""
    out: list[str] = []
    for entry in _SPLIT_RE.split(env.get("GWS_OUTBOUND_ALLOWLIST", "")):
        value = _normalize(entry)
        if value and value not in out:
            out.append(value)
    return out


def allowed_recipient(address: str, entries: list[str]) -> bool:
    """True when `address` is listed itself, or its domain is listed."""
    addr = _normalize(address)
    if not addr:
        return False
    if addr in entries:
        return True
    domain = addr.rpartition("@")[2] if "@" in addr else addr
    return bool(domain) and domain in entries


def check_recipients(
    addresses: Iterable[Optional[str]],
    what: str,
    env: Mapping[str, str] = os.environ,
) -> Optional[str]:
    """The refusal message for a call that would write to a blocked recipient, else None.

    `what` names the action for the caller ("inviting attendees", "sending a
    'shared with you' email", ...). Empty/None entries are skipped, so a call with
    no recipients at all is always allowed.
    """
    if not guard_enabled(env):
        return None
    entries = allowlist(env)
    blocked: list[str] = []
    for address in addresses:
        value = _normalize(address or "")
        if value and not allowed_recipient(value, entries) and value not in blocked:
            blocked.append(value)
    if not blocked:
        return None
    return (
        f"{what} is disabled on this server (GWS_OUTBOUND_GUARD): "
        f"{', '.join(blocked)} is not on GWS_OUTBOUND_ALLOWLIST. Nothing was sent; "
        f"add that address, or its domain, to GWS_OUTBOUND_ALLOWLIST to allow it."
    )
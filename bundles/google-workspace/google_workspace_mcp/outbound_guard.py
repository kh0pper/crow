"""GWS_OUTBOUND_GUARD / GWS_OUTBOUND_ALLOWLIST: one owner list in front of every
outbound mail-like side effect this server can trigger.

Three tool families make Google deliver something to an address the CALLER chose
rather than the owner:

  - Calendar — an event's attendees, and responding to an invitation (that emails
    the organizer);
  - Drive — a share (granting access IS the outbound effect; the "shared with you"
    email only makes it louder), and an ownership transfer's email;
  - Gmail — a filter's forward address.

An assistant that also reads untrusted mail can be talked into using one of them
as an outbound channel. With the guard on (`GWS_OUTBOUND_GUARD` = 1/true/yes/on),
an address is allowed only when `GWS_OUTBOUND_ALLOWLIST` lists it, or lists its
domain; every other recipient is refused, and no request is made to Google at all.

A recipient must be exactly ONE well-formed address — one "@", no whitespace, no
`, ; < > " ' ( )`, ASCII only, non-empty local part and domain. Anything else is
refused before the allowlist is even consulted: a list `x@evil.com,y@example.com`
or a display-name form `Name <x@example.com>` cannot be smuggled past the match.

Off by default: an install that upgrades to the version shipping this file keeps
behaving exactly as it did. The walled deployment turns it on and names what it may
write to. `GWS_CALENDAR_NO_INVITES` (see calendar_guard) is the harder switch: it
drops invitations and invite replies outright, allowlist or not.

The allowlist holds entries separated by commas, semicolons or spaces, matched
case-insensitively: `alex@example.com` and `example.com` (which allows any address
whose domain is exactly `example.com` — no wildcards, and not its subdomains).

Pure module (env in, decision out) so the tests run without the API client.
"""

import os
import re
from typing import Iterable, Mapping, Optional

_ON = {"1", "true", "yes", "on"}
_SPLIT_RE = re.compile(r"[,\s;]+")
# Characters that separate or wrap addresses in a header/list: an address carrying
# one of them is more than one recipient, or is a header injection attempt.
_FORBIDDEN_CHARS = frozenset(',;<>"\'()')


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


def is_single_address(value: str) -> bool:
    """True when `value` is exactly one plain email address.

    One "@", non-empty local part and domain, ASCII only, no whitespace and none of
    `, ; < > " ' ( )`. Deliberately strict: the guard decides on the string it was
    handed, so anything that could be read as several recipients, a display-name
    form, or a header fragment fails closed instead of being matched loosely.
    """
    text = (value or "").strip()
    if not text or not text.isascii():
        return False
    if any(char.isspace() for char in text):
        return False
    if any(char in _FORBIDDEN_CHARS for char in text):
        return False
    if text.count("@") != 1:
        return False
    local, _, domain = text.partition("@")
    return bool(local) and bool(domain)


def allowed_recipient(address: str, entries: list[str]) -> bool:
    """True when `address` is one well-formed address that is listed, or whose domain is.

    A malformed value is never allowed, whatever the allowlist says: the check runs
    before (and independently of) the address/domain match.
    """
    if not is_single_address(address):
        return False
    addr = _normalize(address)
    if not addr:
        return False
    if addr in entries:
        return True
    domain = addr.rpartition("@")[2]
    return bool(domain) and domain in entries


def check_recipients(
    addresses: Iterable[Optional[str]],
    what: str,
    env: Mapping[str, str] = os.environ,
) -> Optional[str]:
    """The refusal message for a call that would write to a blocked recipient, else None.

    `what` names the action for the caller ("inviting attendees", "sharing a Drive
    file", ...). Empty/None entries are skipped, so a call with no recipients at all
    is always allowed; a malformed one is refused and named as such.
    """
    if not guard_enabled(env):
        return None
    entries = allowlist(env)
    blocked: list[str] = []
    malformed: list[str] = []
    for address in addresses:
        value = (address or "").strip()
        if not value:
            continue
        if not is_single_address(value):
            if value not in malformed:
                malformed.append(value)
            continue
        normalized = _normalize(value)
        if normalized and not allowed_recipient(value, entries) and normalized not in blocked:
            blocked.append(normalized)
    if not blocked and not malformed:
        return None
    clauses: list[str] = []
    if blocked:
        clauses.append(f"{', '.join(blocked)} is not on GWS_OUTBOUND_ALLOWLIST")
    if malformed:
        clauses.append(
            f"{', '.join(repr(value) for value in malformed)} is not a single plain "
            f"email address"
        )
    return (
        f"{what} is disabled on this server (GWS_OUTBOUND_GUARD): "
        f"{' and '.join(clauses)}. Nothing was sent. A recipient must be one address "
        f"(a single '@', no commas, spaces, quotes or angle brackets) and either it or "
        f"its domain must be on GWS_OUTBOUND_ALLOWLIST."
    )
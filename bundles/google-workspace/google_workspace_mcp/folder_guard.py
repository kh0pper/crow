"""GWS_OUTBOUND_GUARD, applied to the FOLDER a write lands in.

`outbound_guard` watches the addresses Google is asked to notify. Putting a file
INTO a folder is the quieter channel beside it: nothing is emailed, but the file
becomes readable by everyone who can already read that folder, so an assistant
talked into dropping a document into someone else's Shared Drive has leaked it
without a single mail-like call.

While the guard is on, a tool that writes into a folder the caller named first
reads that folder's owners and permissions (one `files.get` with `owners,
permissions`, supportsAllDrives) and refuses unless

  - every owner address is on GWS_OUTBOUND_ALLOWLIST, and
  - every user/group grantee address is too, and
  - no permission lets the world in: type "anyone" (anyone with the link) or
    type "domain" (a whole Google Workspace domain).

The account's own address always counts as allowed — a folder you own is shared
with you. It is looked up once through Drive's `about` endpoint and then cached;
if that lookup cannot answer, there is no second way to recognise the owner, so
only the allowlist lets a folder through.

Everything here fails closed: a lookup that raises, a response this module does
not recognise, an owner or grantee without a readable address, or a permission
type it does not know all refuse the write, and the message says which.

No folder at all is not a question: a write with no destination folder lands in
My Drive root, the account's own space, with nothing shared into it.

Known limit (documented in the README): in a Shared Drive a file has no owner of
its own and the drive's members are not listed in the file's permissions, so a
shared-drive destination is judged on its direct permissions only.
"""

import asyncio
import logging
import os
from typing import Mapping, Optional

from . import outbound_guard
from .auth import get_drive_service

logger = logging.getLogger(__name__)

# `permissions` beside `owners`: the decision needs type + emailAddress/domain.
_FOLDER_FIELDS = "owners, permissions"

_ABOUT_FIELDS = "user(emailAddress)"

_self_address: Optional[str] = None
_self_checked = False


def reset_cache() -> None:
    """Forget the cached own-address (tests, and after a sign-in change)."""
    global _self_address, _self_checked
    _self_address = None
    _self_checked = False


def _address(value) -> Optional[str]:
    """The trimmed form of an emailAddress/domain field, or None if it is not a string."""
    if not isinstance(value, str):
        return None
    return value.strip() or None


async def own_address() -> Optional[str]:
    """The signed-in account's own address, or None when it cannot be determined.

    Looked up once (Drive `about`) and cached; a failed lookup is not cached, so a
    transient error does not blind the guard for the rest of the process — the
    call that hit it is refused either way.
    """
    global _self_address, _self_checked
    if _self_checked:
        return _self_address
    try:
        about = await asyncio.to_thread(
            lambda: get_drive_service()
            .about()
            .get(fields=_ABOUT_FIELDS)
            .execute()
        )
    except Exception as e:  # noqa: BLE001 - any failure means "unknown", and unknown fails closed
        logger.warning("could not read the account's own address: %s", e)
        return None
    user = about.get("user") if isinstance(about, dict) else None
    address = _address(user.get("emailAddress")) if isinstance(user, dict) else None
    if address is None:
        logger.warning("Drive reported no address for this account")
        return None
    _self_address = address
    _self_checked = True
    return _self_address


def _covered(address: str, entries: list[str], self_address: Optional[str]) -> bool:
    """True when a folder's owner/grantee is the account itself, or on the allowlist."""
    if self_address and address.strip().lower() == self_address.strip().lower():
        return True
    return outbound_guard.allowed_recipient(address, entries)


def _refusal(what: str, folder: str, problem: str) -> str:
    return (
        f"{what} is disabled on this server (GWS_OUTBOUND_GUARD): destination folder "
        f"{folder} is not somewhere the guard allows — {problem}. Nothing was written. "
        f"A folder is written to only when everyone on it (owners and everyone it is "
        f"shared with) is on GWS_OUTBOUND_ALLOWLIST — your own address always is — and "
        f"it has no anyone-with-the-link or whole-domain permission."
    )


def _decide(
    what: str,
    folder: str,
    info,
    entries: list[str],
    self_address: Optional[str],
) -> Optional[str]:
    """The refusal for a folder's metadata, or None when the folder is allowed."""
    if not isinstance(info, dict):
        return _refusal(what, folder, "its sharing could not be read")
    owners, permissions = info.get("owners"), info.get("permissions")
    if not isinstance(owners, list) or not isinstance(permissions, list):
        return _refusal(what, folder, "its owners and sharing could not be read")

    people: list[str] = []
    for owner in owners:
        address = _address(owner.get("emailAddress")) if isinstance(owner, dict) else None
        if address is None:
            return _refusal(what, folder, "it has an owner with no readable address")
        people.append(address)

    open_grants: list[str] = []
    for permission in permissions:
        if not isinstance(permission, dict):
            return _refusal(what, folder, "its sharing could not be read")
        kind = permission.get("type")
        kind = kind.strip().lower() if isinstance(kind, str) else ""
        if kind == "anyone":
            open_grants.append("anyone with the link can read it")
        elif kind == "domain":
            domain = _address(permission.get("domain"))
            open_grants.append(
                f"anyone at the whole domain {domain} can read it"
                if domain
                else "a whole domain can read it"
            )
        elif kind in ("user", "group"):
            address = _address(permission.get("emailAddress"))
            if address is None:
                return _refusal(
                    what, folder, "it is shared with a grantee with no readable address"
                )
            people.append(address)
        else:
            name = kind or "unknown"
            open_grants.append(f"it carries a '{name}' permission")

    # Deduplicate case-insensitively, keeping the first spelling for the message.
    distinct: dict[str, str] = {}
    for address in people:
        distinct.setdefault(address.lower(), address)
    blocked = [a for a in distinct.values() if not _covered(a, entries, self_address)]

    problems: list[str] = []
    if blocked:
        problems.append(
            f"it is shared with {', '.join(blocked)}, which GWS_OUTBOUND_ALLOWLIST "
            f"does not cover"
        )
    problems.extend(open_grants)
    if not problems:
        return None
    return _refusal(what, folder, " and ".join(problems))


async def check_destination(
    folder_id: Optional[str],
    what: str,
    env: Mapping[str, str] = os.environ,
) -> Optional[str]:
    """The refusal message for a write into `folder_id`, else None.

    `what` names the action for the caller ("uploading a file into a Drive
    folder", ...). Guard off, or no folder given, is always None: nothing about
    an install that upgrades changes until GWS_OUTBOUND_GUARD is turned on.
    """
    if not outbound_guard.guard_enabled(env):
        return None
    folder = (folder_id or "").strip()
    if not folder:
        return None
    try:
        info = await asyncio.to_thread(
            lambda: get_drive_service()
            .files()
            .get(fileId=folder, fields=_FOLDER_FIELDS, supportsAllDrives=True)
            .execute()
        )
    except Exception as e:  # noqa: BLE001 - an unreadable folder is a refused folder
        return _refusal(what, folder, f"its sharing could not be read ({e})")
    return _decide(what, folder, info, outbound_guard.allowlist(env), await own_address())
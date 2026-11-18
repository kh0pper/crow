"""GWS_OUTBOUND_GUARD, applied to the FOLDER a write lands in.

`outbound_guard` watches the addresses Google is asked to notify. Putting a file
INTO a folder is the quieter channel beside it: nothing is emailed, but the file
becomes readable by everyone who can already read that folder, so an assistant
talked into dropping a document into someone else's Shared Drive has leaked it
without a single mail-like call.

While the guard is on, a tool that writes into a folder the caller named first
reads that folder's owners, permissions and driveId (one `files.get` with
`owners, permissions, driveId`, supportsAllDrives) and refuses unless

  - every owner address is on GWS_OUTBOUND_ALLOWLIST, and
  - every user/group grantee address is too, and
  - no permission lets the world in: type "anyone" (anyone with the link) or
    type "domain" (a whole Google Workspace domain).

A folder that reports no owner at all is refused: an item in My Drive always has
one, so an empty owners list means the metadata could not be read.

A Shared Drive asks a different question. An item there has no owner of its own,
and the drive's members do not appear in the item's permission list even though
they inherit access to everything in the drive — so judging the item on the list
it reports would pass a folder every member of the drive can read. A destination
whose metadata carries a `driveId` is therefore judged on the folder's EFFECTIVE
permissions, read with `permissions().list(fileId, supportsAllDrives)` (which
does include the inherited drive members), under the same rule: every user/group
on that list must be on the allowlist and no anyone-with-the-link or whole-domain
grant may exist. A listing that fails, or that comes back with nothing usable,
refuses the write — the narrower direct list is never used as a fallback.

The same decision is asked of a file whose CONTENT is replaced in place
(`gdrive_upload_new_version`): the new bytes are readable by everyone who can
already read that file, so the file's own owners, sharing and driveId decide,
not a parent folder.

The account's own address always counts as allowed — a folder you own is shared
with you. It is looked up once through Drive's `about` endpoint and then cached
for the life of the process; if that lookup cannot answer, there is no second way
to recognise the owner, so only the allowlist lets a folder through. The cache
means a change of signed-in account is only noticed after a server restart.

Everything here fails closed: a lookup that raises, a response this module does
not recognise, an owner or grantee without a readable address, or a permission
type it does not know all refuse the write, and the message says which.

No folder at all is not a question: a write with no destination folder lands in
My Drive root, the account's own space, with nothing shared into it.
"""

import asyncio
import logging
import os
from typing import Mapping, Optional

from . import outbound_guard
from .auth import get_drive_service

logger = logging.getLogger(__name__)

# `permissions` beside `owners`: the decision needs type + emailAddress/domain.
# `driveId` says whether the item lives in a Shared Drive, where the item's own
# permission list is not the whole story (see _decide).
_FIELDS = "owners, permissions, driveId"

# A Shared Drive folder's effective permissions: the inherited drive members are
# only visible through permissions().list.
_PERMISSION_FIELDS = "permissions(type,role,emailAddress,domain,permissionDetails)"

_ABOUT_FIELDS = "user(emailAddress)"

_self_address: Optional[str] = None
_self_checked = False


def reset_cache() -> None:
    """Forget the cached own-address (tests; a sign-in change needs a restart)."""
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

    Looked up once (Drive `about`) and cached for the life of the process; a
    failed lookup is not cached, so a transient error does not blind the guard for
    the rest of the process — the call that hit it is refused either way. Because
    the answer is cached, switching the signed-in account is only noticed after the
    server is restarted.
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


def _drive_id(info) -> Optional[str]:
    """The Shared Drive a files.get response places the item in, or None."""
    if not isinstance(info, dict):
        return None
    value = info.get("driveId")
    if not isinstance(value, str):
        return None
    return value.strip() or None


def _refusal(what: str, target: str, problem: str) -> str:
    """The message for a refused write; `target` names what was checked."""
    return (
        f"{what} is disabled on this server (GWS_OUTBOUND_GUARD): {target} is not "
        f"somewhere the guard allows — {problem}. Nothing was written. A Drive item "
        f"is written to only when everyone who can reach it — its owners, everyone it "
        f"is shared with, and in a Shared Drive the drive's members — is on "
        f"GWS_OUTBOUND_ALLOWLIST (your own address always is), and it has no "
        f"anyone-with-the-link or whole-domain permission."
    )


def _decide(
    what: str,
    target: str,
    info,
    entries: list[str],
    self_address: Optional[str],
    drive_members=None,
) -> Optional[str]:
    """The refusal for an item's metadata, or None when the write may go ahead.

    `target` names what was checked for the message ("destination folder <id>",
    "file <id>"). `drive_members` is the item's effective permission list read
    with permissions().list; it is consulted only when the metadata carries a
    `driveId`, because that is the case the item's own permission list
    under-reports (inherited drive members are not in it).
    """
    if not isinstance(info, dict):
        return _refusal(what, target, "its sharing could not be read")
    permissions = info.get("permissions")
    if not isinstance(permissions, list):
        return _refusal(what, target, "its sharing could not be read")

    people: list[str] = []
    if _drive_id(info) is not None:
        # A Shared Drive item has no owner of its own (Drive omits `owners` for it
        # entirely); who can reach it is the drive's membership, which only the
        # effective listing shows.
        if not isinstance(drive_members, list) or not drive_members:
            return _refusal(
                what,
                target,
                "the members of the Shared Drive it is in could not be read",
            )
        grants = drive_members
    else:
        owners = info.get("owners")
        if not isinstance(owners, list):
            return _refusal(what, target, "its owners could not be read")
        if not owners:
            return _refusal(
                what, target, "it has no owner, which an item in My Drive always has"
            )
        grants = permissions
        for owner in owners:
            address = (
                _address(owner.get("emailAddress")) if isinstance(owner, dict) else None
            )
            if address is None:
                return _refusal(what, target, "it has an owner with no readable address")
            people.append(address)

    open_grants: list[str] = []
    for permission in grants:
        if not isinstance(permission, dict):
            return _refusal(what, target, "its sharing could not be read")
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
                    what, target, "it is shared with a grantee with no readable address"
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
    return _refusal(what, target, " and ".join(problems))


async def _read_drive_members(service, item_id: str):
    """An item's effective Shared Drive permissions, or None when unusable.

    On a Shared Drive item, `permissions().list` includes the members inherited
    from the drive itself, which the item's own `permissions` from files.get do
    not. A listing that raises, or that comes back empty/without a permission
    list, is None: there is then no way to know who can read the item, and the
    guard does not fall back to the narrower list it already knows is incomplete.
    """
    try:
        listing = await asyncio.to_thread(
            lambda: service.permissions()
            .list(
                fileId=item_id,
                supportsAllDrives=True,
                fields=_PERMISSION_FIELDS,
            )
            .execute()
        )
    except Exception as e:  # noqa: BLE001 - unreadable members refuse the write
        logger.warning("could not read the Shared Drive members of %s: %s", item_id, e)
        return None
    members = listing.get("permissions") if isinstance(listing, dict) else None
    if not isinstance(members, list) or not members:
        return None
    return members


async def _check_item(
    item_id: Optional[str],
    what: str,
    target_kind: str,
    env: Mapping[str, str],
) -> Optional[str]:
    """The shared body of check_destination/check_file_sharing."""
    if not outbound_guard.guard_enabled(env):
        return None
    item = (item_id or "").strip()
    if not item:
        return None
    target = f"{target_kind} {item}"
    try:
        service = get_drive_service()
        info = await asyncio.to_thread(
            lambda: service.files()
            .get(fileId=item, fields=_FIELDS, supportsAllDrives=True)
            .execute()
        )
    except Exception as e:  # noqa: BLE001 - an unreadable item is a refused item
        return _refusal(what, target, f"its sharing could not be read ({e})")
    drive_members = None
    if _drive_id(info) is not None:
        drive_members = await _read_drive_members(service, item)
    return _decide(
        what,
        target,
        info,
        outbound_guard.allowlist(env),
        await own_address(),
        drive_members,
    )


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
    return await _check_item(folder_id, what, "destination folder", env)


async def check_file_sharing(
    file_id: Optional[str],
    what: str,
    env: Mapping[str, str] = os.environ,
) -> Optional[str]:
    """The refusal message for a write that REPLACES an existing file's content.

    `gdrive_upload_new_version` changes what a file contains without changing
    where it lives, so the folder question does not apply; the same sharing
    decision is asked of the file itself (its owners, its permissions, and in a
    Shared Drive the drive's members) because the new bytes become readable by
    exactly those people. Guard off, or no file given, is always None.
    """
    return await _check_item(file_id, what, "file", env)
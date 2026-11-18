"""GWS_OAUTH_SCOPES: narrow the OAuth scopes this server requests and refreshes.

Unset keeps the full default list. Set it (comma/space separated, short names
like 'gmail.compose' or full URLs) to authorize an account with only what its
assistant needs. The same list is used for authorize() and for loading the token,
because google-auth sends the scope list on refresh and a scope the token was
never granted fails the refresh.

Every name is checked against KNOWN_SCOPES. An unknown name is not passed through:
google-auth would carry it into the refresh, and the only symptom would be a
confusing "not authenticated" later. Instead the bad entry is logged and raised
here, at import time, so the server fails to start with the name in the message.

The narrowing applies at the NEXT refresh (and at the authorize step): the refresh
token already on disk keeps the full grant it was issued with. Revoke the app's
access in the Google account to take permissions away from it.

Pure module so the tests run without the API client.
"""

import logging
import os
import re
from typing import Mapping

logger = logging.getLogger(__name__)

_PREFIX = "https://www.googleapis.com/auth/"

# The scope suffixes this server's tools use, plus the read-only/file narrower
# forms of the same APIs (the point of narrowing), plus the full `forms` scope the
# forms_set_destination shim needs (see forms._SHIM_SETUP). Bare suffixes only: the
# https prefix is added (and stripped back off) by resolve_scopes.
KNOWN_SCOPES = frozenset(
    {
        # auth.SCOPES — the full default set
        "drive",
        "documents",
        "spreadsheets",
        "gmail.readonly",
        "gmail.compose",
        "gmail.modify",
        "gmail.settings.basic",
        "calendar",
        "calendar.events",
        "script.projects",
        "forms.body",
        "bigquery",
        "datastudio.readonly",
        # narrower variants of the same APIs
        "drive.file",
        "drive.readonly",
        "drive.metadata.readonly",
        "documents.readonly",
        "spreadsheets.readonly",
        "calendar.readonly",
        # forms_set_destination's shim needs the full Forms scope
        "forms",
    }
)


def _suffix(name: str) -> str | None:
    """The bare scope suffix for `name`, or None when it is not a Google scope URL."""
    if name.startswith(_PREFIX):
        return name[len(_PREFIX):]
    if name.startswith("https://") or name.startswith("http://"):
        # Some other host: never a scope this server knows.
        return None
    if "/" in name:
        return None
    return name


def resolve_scopes(default: list[str], env: Mapping[str, str] = os.environ) -> list[str]:
    """The scopes to request. Raises ValueError naming any entry it does not know."""
    raw = env.get("GWS_OAUTH_SCOPES", "").strip()
    if not raw:
        return default
    out: list[str] = []
    unknown: list[str] = []
    for name in re.split(r"[,\s]+", raw):
        if not name:
            continue
        suffix = _suffix(name)
        if suffix is None or suffix not in KNOWN_SCOPES:
            if name not in unknown:
                unknown.append(name)
            continue
        url = _PREFIX + suffix
        if url not in out:
            out.append(url)
    if unknown:
        message = (
            f"GWS_OAUTH_SCOPES names unknown scope(s): {', '.join(unknown)}. "
            f"Use a short name or a {_PREFIX}<name> URL from this server's list "
            f"(e.g. gmail.compose, calendar.events, drive.file), or unset "
            f"GWS_OAUTH_SCOPES to request the default set. An unknown scope is "
            f"refused here because it would fail the token refresh later with a "
            f"confusing 'not authenticated'."
        )
        logger.error(message)
        raise ValueError(message)
    if not out:
        # Only separators: treat it as unset rather than authorizing with no scopes.
        return default
    return out
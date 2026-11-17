"""GWS_OAUTH_SCOPES: narrow the OAuth scopes this server requests and refreshes.

Unset keeps the full default list. Set it (comma/space separated, short names
like 'gmail.compose' or full URLs) to authorize an account with only what its
assistant needs. The same list is used for authorize() and for loading the token,
because google-auth sends the scope list on refresh and a scope the token was
never granted fails the refresh. Pure module so the tests run without the API client.
"""

import os
import re
from typing import Mapping

_PREFIX = "https://www.googleapis.com/auth/"


def resolve_scopes(default: list[str], env: Mapping[str, str] = os.environ) -> list[str]:
    raw = env.get("GWS_OAUTH_SCOPES", "").strip()
    if not raw:
        return default
    out: list[str] = []
    for name in re.split(r"[,\s]+", raw):
        if not name:
            continue
        url = name if name.startswith("https://") else _PREFIX + name
        if url not in out:
            out.append(url)
    return out
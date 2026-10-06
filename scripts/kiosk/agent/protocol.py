"""Local socket protocol between the kiosk page and crow-kiosk-agent.

The page (served from the Crow origin) connects to ws://127.0.0.1:8770.
Agent -> page: agent (status on connect), wake, touch_while_dark,
               bt_state {configured, connected, name, reconnecting, result?}.
Page -> agent: display {on}, speaking {on}, media {on, level}, bt_reconnect {}.
Everything else is refused. Frames are small JSON objects.
"""

import json
from urllib.parse import urlsplit

PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 1024


class ProtocolError(ValueError):
    pass


def _bool(msg, key):
    v = msg.get(key)
    if not isinstance(v, bool):
        raise ProtocolError(f"{msg.get('type')}: '{key}' must be a boolean")
    return v


def parse_page_message(raw):
    """Validate one frame from the page. Returns a normalised dict or raises ProtocolError."""
    if isinstance(raw, (bytes, bytearray)):
        raise ProtocolError("binary frames are not accepted")
    if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_FRAME_BYTES:
        raise ProtocolError("frame too large")
    try:
        msg = json.loads(raw)
    except ValueError as e:
        raise ProtocolError("not JSON") from e
    if not isinstance(msg, dict):
        raise ProtocolError("not an object")
    t = msg.get("type")
    if t in ("display", "speaking"):
        return {"type": t, "on": _bool(msg, "on")}
    if t == "media":
        on = _bool(msg, "on")
        level = msg.get("level", 0)
        if (
            isinstance(level, bool)
            or not isinstance(level, (int, float))
            or not 0 <= level <= 100
        ):
            raise ProtocolError("media: 'level' must be a number 0..100")
        return {"type": "media", "on": on, "level": float(level)}
    if t == "bt_reconnect":
        if set(msg) - {"type", "req"}:
            raise ProtocolError("bt_reconnect takes no arguments (the MAC is fixed in agent.json)")
        req = msg.get("req")
        if req is not None and not (isinstance(req, str) and len(req) <= 40):
            raise ProtocolError("bt_reconnect: 'req' must be a short string")
        return {"type": "bt_reconnect", "req": req}
    raise ProtocolError(f"unknown message type: {t!r}")


def normalise_origin(url):
    """https://host[:port] with no path, lower-cased host; the page's Origin header must equal this."""
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        raise ValueError(f"crow origin must be an https URL: {url!r}")
    if (
        parts.path not in ("", "/")
        or parts.query
        or parts.fragment
        or parts.username
        or parts.password
    ):
        raise ValueError(
            f"crow origin must not carry a path, query or credentials: {url!r}"
        )
    host = parts.hostname.lower()
    port = parts.port
    return f"https://{host}" + (f":{port}" if port and port != 443 else "")


def origin_allowed(origin_header, allowed_origin):
    if not origin_header:
        return False
    try:
        return normalise_origin(origin_header) == allowed_origin
    except ValueError:
        return False


def dumps(msg):
    return json.dumps(msg, separators=(",", ":"))


def agent_status(wake_model, wake_ready, bt_state):
    return dumps({"type": "agent", "v": PROTOCOL_VERSION, "wake": bool(wake_ready),
                  "wake_model": wake_model, "bt": bt_state})


def wake_msg(score):
    return dumps({"type": "wake", "score": round(float(score), 3)})


def touch_while_dark_msg():
    return dumps({"type": "touch_while_dark"})



def bt_state_msg(state, req=None):
    allowed = {"type", "configured", "connected", "link", "hw_fault", "name", "reconnecting", "result"}
    out = {k: v for k, v in state.items() if k in allowed}
    out["type"] = "bt_state"
    if req is not None:
        out["req"] = req
    return dumps(out)

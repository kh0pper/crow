"""Spoken-stream markup filter (spec §3.7.5). Nothing tag-shaped may reach the line.

Recovers the tool calls a model wrote as TEXT (measured failure modes of the
Qwen family, pi-lab 2026-09-30) so the call can continue without speaking markup.
"""

import json
import re
from dataclasses import dataclass, field

KNOWN_TOOLS = {
    "press_digits": "digits",
    "record_booking": None,
    "needs_owner": "reason",
    "end_call": None,
    "mark_do_not_call": None,
}


@dataclass
class ToolCall:
    name: str
    args: dict = field(default_factory=dict)


@dataclass
class Sanitized:
    clean: str
    had_markup: bool
    calls: list


_BLOCK = re.compile(r"<tool_call>(.*?)</tool_call>", re.S)
_FUNC = re.compile(r"<function=([a-z_]+)>(.*?)(?:</function>|$)", re.S)
_PARAM = re.compile(r"<parameter=([a-z_]+)>(.*?)</parameter>", re.S)
_ATTR_TAG = re.compile(r"<\s*(" + "|".join(KNOWN_TOOLS) + r")\b([^>]*)>", re.S)
_ATTR = re.compile(r'([a-z_]+)\s*=\s*"([^"]*)"')
_ANY_TAG = re.compile(
    r"<\s*/?\s*(?:tool_call|function|parameter|"
    + "|".join(KNOWN_TOOLS)
    + r")\b[^>]*>|<[^<>]*=[^<>]*>",
    re.S,
)


def _from_function(name: str, body: str):
    if name not in KNOWN_TOOLS:
        return None
    params = {k: v.strip() for k, v in _PARAM.findall(body)}
    if not params:
        bare = re.sub(r"<[^>]*>", "", body).strip()
        single = KNOWN_TOOLS[name]
        if bare and single:
            params = {single: bare}
    return ToolCall(name, params)


def sanitize(text: str) -> Sanitized:
    calls = []
    had = False
    for block in _BLOCK.findall(text):
        had = True
        body = block.strip()
        if body.startswith("{"):
            try:
                obj = json.loads(body)
                if obj.get("name") in KNOWN_TOOLS:
                    calls.append(
                        ToolCall(obj["name"], dict(obj.get("arguments") or {}))
                    )
                continue
            except json.JSONDecodeError:
                pass
        for name, fbody in _FUNC.findall(body):
            c = _from_function(name, fbody)
            if c:
                calls.append(c)
    if not calls:
        for name, fbody in _FUNC.findall(text):
            had = True
            c = _from_function(name, fbody)
            if c:
                calls.append(c)
    for name, attrs in _ATTR_TAG.findall(text):
        had = True
        calls.append(ToolCall(name, dict(_ATTR.findall(attrs))))
    stripped = _BLOCK.sub(" ", text)
    stripped = _FUNC.sub(" ", stripped)
    if _ANY_TAG.search(stripped):
        had = True
    stripped = _ANY_TAG.sub(" ", stripped)
    clean = re.sub(r"\s+", " ", stripped).strip()
    if "<" in clean or ">" in clean:
        had = True
        clean = re.sub(r"[<>]", "", clean).strip()
    return Sanitized(clean=clean, had_markup=had, calls=calls)

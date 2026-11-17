"""Who is acting, for labelling the comments a bot writes on Drive files.

Sources, in order: the process env (CROW_ACTOR_KIND / CROW_ACTOR_BOT_ID /
CROW_ACTOR_BOT_NAME), then the MCP request meta key "crow/actor"
({kind, id, name}; kind "bot" only). Never the tool arguments. No bot actor
means the text is left alone, so the owner's own comments stay unlabelled.
"""

import unicodedata
from collections.abc import Mapping
from typing import Optional

MAX_NAME = 40
META_KEY = "crow/actor"


def sanitize_actor_name(name, fallback_id) -> str:
    """Drop control (Cc) and format (Cf: bidi overrides, zero-width) characters,
    trim, cap at 40 code points; fall back to the bot id when empty."""
    raw = "" if name is None else str(name)
    clean = "".join(
        ch for ch in raw if unicodedata.category(ch) not in ("Cc", "Cf")
    ).strip()
    capped = clean[:MAX_NAME].strip()
    return capped or ("" if fallback_id is None else str(fallback_id))


def _bot(bot_id, name) -> Optional[dict]:
    clean = sanitize_actor_name(name, bot_id)
    if not clean:
        return None
    return {"kind": "bot", "id": "" if bot_id is None else str(bot_id), "name": clean}


def _meta_actor(meta) -> object:
    """Read "crow/actor" from a pydantic Meta model (extras) or a plain mapping."""
    if meta is None:
        return None
    if isinstance(meta, Mapping):
        return meta.get(META_KEY)
    extra = getattr(meta, "model_extra", None)
    if isinstance(extra, Mapping) and META_KEY in extra:
        return extra[META_KEY]
    dump = getattr(meta, "model_dump", None)
    if callable(dump):
        return dump().get(META_KEY)
    return None


def resolve_actor(env: Mapping, meta=None) -> Optional[dict]:
    """-> {"kind": "bot", "id", "name"} or None."""
    kind = (env or {}).get("CROW_ACTOR_KIND")
    if kind == "bot":
        return _bot(env.get("CROW_ACTOR_BOT_ID"), env.get("CROW_ACTOR_BOT_NAME"))
    if kind == "owner":  # an env that names a kind decides alone
        return None
    m = _meta_actor(meta)
    if isinstance(m, Mapping) and m.get("kind") == "bot":
        return _bot(m.get("id"), m.get("name"))
    return None


def label_text(text: str, actor: Optional[dict]) -> str:
    """Prefix text with the bot label; unchanged without a bot actor; never doubled."""
    if not actor or actor.get("kind") != "bot" or not text:
        return text
    prefix = f"\U0001F916 {actor.get('name', '')} (bot): "
    return text if text.startswith(prefix) else prefix + text


def actor_from_context(ctx) -> Optional[dict]:
    """Resolve the actor for a FastMCP tool call from the process env and ctx meta."""
    import os

    meta = None
    try:
        meta = ctx.request_context.meta if ctx is not None else None
    except Exception:  # no active request (e.g. called outside a request)
        meta = None
    return resolve_actor(os.environ, meta)

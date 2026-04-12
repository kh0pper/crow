#!/usr/bin/env python3
"""
Idempotently patch Open-LLM-VTuber's websocket_handler.py to add a
`tutor-event` message type that Maker Lab's Blockly kiosk fires to
request a scaffolded hint spoken via the companion's TTS.

Contract (matches bundles/companion/patches/backend/0001-tutor-event-handler.patch):

  { type: "tutor-event",
    event: "hint_request",
    session_token: str,
    surface: str,
    question: str,
    level: int,
    lesson_id: str | None,
    canned_hints: [str] | None }

The handler NEVER treats the payload as user text — only the filtered
return from maker-lab's /maker-lab/api/hint-internal endpoint reaches TTS.

Safe to re-run. Detects the marker string and exits early if already patched.
"""

import re
import sys
from pathlib import Path

TARGET = Path("/app/src/open_llm_vtuber/websocket_handler.py")
MARKER = "# [maker-lab] tutor-event handler"

REGISTRATION = '            "heartbeat": self._handle_heartbeat,'
REGISTRATION_PATCHED = (
    '            "heartbeat": self._handle_heartbeat,\n'
    '            "tutor-event": self._handle_tutor_event,  # [maker-lab]'
)

HANDLER_METHOD = '''

    async def _handle_tutor_event(
        self, websocket, client_uid: str, data: dict
    ):
        """Maker Lab tutor-event handler. See bundles/companion/patches/backend/0001.

        Validates session_token against maker-lab's loopback-only hint endpoint.
        Plays the filtered response via the per-client TTS engine. Never echoes
        the raw payload.
        """
        # [maker-lab] tutor-event handler
        import aiohttp
        from loguru import logger as _ll_logger

        event = str(data.get("event") or "")
        token = str(data.get("session_token") or "")
        if not token or event != "hint_request":
            return

        url = "http://127.0.0.1:3004/maker-lab/api/hint-internal"
        payload = {
            "session_token": token,
            "surface": str(data.get("surface") or "companion"),
            "question": str(data.get("question") or ""),
            "level": int(data.get("level") or 1),
            "lesson_id": data.get("lesson_id"),
            "canned_hints": data.get("canned_hints"),
        }

        try:
            timeout = aiohttp.ClientTimeout(total=20)
            async with aiohttp.ClientSession(timeout=timeout) as s:
                async with s.post(url, json=payload) as resp:
                    if resp.status != 200:
                        _ll_logger.warning(
                            f"maker-lab hint endpoint returned {resp.status}"
                        )
                        reply = {"text": "Your tutor is taking a nap. Try the lesson hints on your own!"}
                    else:
                        reply = await resp.json()
        except Exception as err:
            _ll_logger.warning(f"maker-lab hint call failed: {err}")
            reply = {"text": "Your tutor is taking a nap. Try the lesson hints on your own!"}

        text = str(reply.get("text") or "").strip()
        if not text:
            return

        context = self.client_contexts.get(client_uid)
        if not context:
            return

        # Send only a text frame to the kiosk. The companion's frontend
        # (or the kiosk's own speechSynthesis) handles TTS rendering. We
        # deliberately DO NOT call the per-client TTS engine directly —
        # different adapters return different types (sync str vs async
        # audio bytes) and the filtered text bypasses the LLM path, so
        # no agent-level audio generation is triggered.
        try:
            import json
            await websocket.send_text(json.dumps({
                "type": "full-text",
                "text": text,
            }))
        except Exception as err:
            _ll_logger.warning(f"tutor-event send failed: {err}")
'''


def main() -> int:
    if not TARGET.exists():
        print(f"[maker-lab patch] {TARGET} not found; skipping", file=sys.stderr)
        return 0
    src = TARGET.read_text()
    if MARKER in src:
        print("[maker-lab patch] tutor-event handler already present; skipping")
        return 0

    if REGISTRATION not in src:
        print(
            "[maker-lab patch] anchor line not found — refusing to patch. "
            "Upstream websocket_handler.py may have moved. Inspect manually.",
            file=sys.stderr,
        )
        return 1

    patched = src.replace(REGISTRATION, REGISTRATION_PATCHED, 1)

    # Append the handler method just before the final class-level closing
    # (whichever class ends the file). We append to end of file and rely on
    # Python indentation — the HANDLER_METHOD is indented to class level.
    # Locate the WebSocketHandler class; append the method before the next
    # top-level def/class or EOF.
    # Simpler: append the method inside the class definition by locating
    # the last method of WebSocketHandler. We do it by regex match on the
    # closing of the last known method `_handle_config_switch` and insert
    # the new method after it.
    anchor_re = re.compile(
        r"(async def _handle_config_switch.*?await context\.handle_config_switch\(websocket, config_file_name\))",
        re.DOTALL,
    )
    m = anchor_re.search(patched)
    if not m:
        print(
            "[maker-lab patch] _handle_config_switch anchor not found — refusing to patch.",
            file=sys.stderr,
        )
        return 1
    insertion_point = m.end()
    patched = patched[:insertion_point] + HANDLER_METHOD + patched[insertion_point:]

    TARGET.write_text(patched)
    print("[maker-lab patch] tutor-event handler installed")
    return 0


if __name__ == "__main__":
    sys.exit(main())

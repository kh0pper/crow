#!/usr/bin/env python3
"""
Crow Notification Bridge for Open-LLM-VTuber.

Reads unread notifications directly from Crow's SQLite database and sends
them to the companion via a persistent websocket connection, causing the
avatar to speak them aloud.

Maintains a single long-lived WebSocket to the companion server, injecting
notifications into the existing session rather than creating new connections.
"""

import asyncio
import json
import logging
import os
import sqlite3

import aiohttp

logger = logging.getLogger("notify-bridge")
logging.basicConfig(
    level=logging.INFO, format="%(name)s | %(levelname)s | %(message)s"
)

COMPANION_PORT = os.environ.get("COMPANION_PORT", "12393")
COMPANION_HOST = os.environ.get("COMPANION_BIND_HOST", "127.0.0.1")
CROW_DB_PATH = os.environ.get("CROW_DB_PATH", "/crow-data/crow.db")
POLL_INTERVAL = int(os.environ.get("NOTIFY_POLL_INTERVAL", "30"))

COMPANION_WS_URL = f"ws://{COMPANION_HOST}:{COMPANION_PORT}/client-ws?role=bridge"

# Track which notifications we've already spoken
seen_ids: set[int] = set()


def get_unread_notifications(limit=5):
    """Read unread notifications from Crow's database."""
    try:
        conn = sqlite3.connect(f"file:{CROW_DB_PATH}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        cursor = conn.execute(
            """SELECT id, title, body, type, priority, source, created_at
               FROM notifications
               WHERE is_read = 0 AND is_dismissed = 0
               ORDER BY created_at DESC
               LIMIT ?""",
            (limit,),
        )
        rows = [dict(r) for r in cursor.fetchall()]
        conn.close()
        return rows
    except Exception as e:
        logger.debug(f"Could not read notifications: {e}")
        return []


async def run_bridge():
    """Main loop: maintain a persistent WebSocket and poll for notifications."""
    logger.info(
        f"Notification bridge started "
        f"(polling every {POLL_INTERVAL}s, db: {CROW_DB_PATH})"
    )

    # Wait for companion server to be ready
    await asyncio.sleep(15)

    # Seed seen_ids with existing unread notifications
    existing = get_unread_notifications(limit=50)
    for n in existing:
        seen_ids.add(n["id"])
    logger.info(f"Seeded {len(seen_ids)} existing notification(s)")

    while True:
        try:
            async with aiohttp.ClientSession() as session:
                async with session.ws_connect(
                    COMPANION_WS_URL,
                    heartbeat=30,
                    timeout=aiohttp.ClientWSTimeout(ws_close=10),
                ) as ws:
                    logger.info("Connected to companion WebSocket (persistent)")

                    while True:
                        try:
                            notifications = get_unread_notifications()
                            for notif in notifications:
                                if notif["id"] not in seen_ids:
                                    seen_ids.add(notif["id"])
                                    await send_notification(ws, notif)
                        except Exception as e:
                            logger.debug(f"Poll cycle error: {e}")

                        # Drain any incoming messages (keep connection alive)
                        try:
                            msg = await asyncio.wait_for(
                                ws.receive(), timeout=POLL_INTERVAL
                            )
                            if msg.type in (
                                aiohttp.WSMsgType.CLOSED,
                                aiohttp.WSMsgType.ERROR,
                            ):
                                logger.warning("WebSocket closed, reconnecting...")
                                break
                        except asyncio.TimeoutError:
                            # Normal — poll interval elapsed, loop back to check
                            pass

        except Exception as e:
            logger.warning(f"WebSocket connection failed: {e}, retrying in 30s...")
            await asyncio.sleep(30)


async def send_notification(ws, notif):
    """Send a notification through the persistent WebSocket."""
    title = notif["title"]
    body = notif.get("body", "")
    priority = notif.get("priority", "normal")
    source = notif.get("source", "")

    text = title
    if body:
        text = f"{title}: {body}"

    urgent = " This seems important." if priority == "high" else ""

    # Social notifications get a friendlier prompt
    if source == "sharing:room_invite":
        prompt = (
            f"[Social] {text}.{urgent} "
            "Let the user know they have a room invite. Be brief and enthusiastic."
        )
    elif source == "sharing:room_closed":
        prompt = (
            f"[Social] {text}. Let the user know the room was closed."
        )
    elif source == "sharing:voice_memo":
        prompt = (
            f"[Voice Memo] {title}. They said: '{body}'. "
            "Read their message naturally, as if relaying what someone told you."
        )
    elif source == "sharing:reaction":
        prompt = (
            f"[Reaction] {text}. Briefly and cheerfully mention it."
        )
    elif source == "sharing:bot_relay_result":
        prompt = (
            f"[Bot Relay Result] {title}. Result: '{body}'. "
            "Relay this response from the remote instance naturally and briefly."
        )
    elif source == "sharing:bot_relay_timeout":
        prompt = (
            f"[Bot Relay] {text}. Let the user know the relay timed out."
        )
    elif source == "sharing:bot_relay_manual":
        prompt = (
            f"[Bot Relay] A task was relayed to you: '{body}'. "
            "Let the user know someone asked them to do this."
        )
    else:
        prompt = (
            f"[Notification] You just received a notification: {text}.{urgent} "
            "Briefly acknowledge it to the user."
        )

    try:
        await ws.send_json({"type": "text-input", "text": prompt})
        logger.info(f"Sent notification #{notif['id']}: {title}")
    except Exception as e:
        logger.warning(f"Failed to send notification: {e}")


def main():
    if os.environ.get("DISABLE_NOTIFICATIONS") == "1":
        logger.info("Notification bridge disabled via DISABLE_NOTIFICATIONS=1")
        return

    try:
        asyncio.run(run_bridge())
    except KeyboardInterrupt:
        logger.info("Notification bridge stopped")


if __name__ == "__main__":
    main()

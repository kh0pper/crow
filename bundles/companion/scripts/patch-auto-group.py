#!/usr/bin/env python3
"""
Patch Open-LLM-VTuber to auto-group all clients in household mode.

When COMPANION_PROFILE_1_NAME is set (household profiles active), all
connecting clients are automatically added to a single household group.
No manual UUID copying needed — just open the companion on two devices
and they're in the same room.
"""

import os
import sys

HANDLER_FILE = "/app/src/open_llm_vtuber/websocket_handler.py"


def patch_auto_group():
    """Add auto-grouping to _store_client_data in websocket_handler.py."""
    # Only activate in household mode
    if not os.environ.get("COMPANION_PROFILE_1_NAME"):
        print("patch-auto-group: no household profiles, skipping")
        return

    with open(HANDLER_FILE, "r") as f:
        content = f.read()

    if "# [crow-patch] auto-group household" in content:
        print("patch-auto-group: already patched")
        return

    # Find the _store_client_data method and add auto-group logic after it sets
    # the client_group_map entry. The original code:
    #
    #     self.chat_group_manager.client_group_map[client_uid] = ""
    #     await self.send_group_update(websocket, client_uid)
    #
    # We replace it with auto-join logic.

    old = (
        '        self.chat_group_manager.client_group_map[client_uid] = ""\n'
        '        await self.send_group_update(websocket, client_uid)'
    )

    new = (
        '        self.chat_group_manager.client_group_map[client_uid] = ""\n'
        '        # [crow-patch] auto-group household\n'
        '        # Skip bridge clients (notification bridge, etc.)\n'
        '        _is_bridge = getattr(websocket, "query_params", {}).get("role") == "bridge"\n'
        '        if _is_bridge:\n'
        '            logger.info(f"Skipping auto-group for bridge client {client_uid}")\n'
        '            await self.send_group_update(websocket, client_uid)\n'
        '            return\n'
        '        # Find any existing client to group with\n'
        '        existing_uid = None\n'
        '        for uid, gid in self.chat_group_manager.client_group_map.items():\n'
        '            if uid != client_uid:\n'
        '                existing_uid = uid\n'
        '                break\n'
        '        if existing_uid:\n'
        '            # If existing client has a group, add us to it\n'
        '            existing_gid = self.chat_group_manager.client_group_map.get(existing_uid, "")\n'
        '            if existing_gid and existing_gid in self.chat_group_manager.groups:\n'
        '                group = self.chat_group_manager.groups[existing_gid]\n'
        '                group.members.add(client_uid)\n'
        '                self.chat_group_manager.client_group_map[client_uid] = existing_gid\n'
        '                logger.info(f"Auto-grouped {client_uid} into existing group {existing_gid}")\n'
        '            else:\n'
        '                # Create a new group with both clients\n'
        '                success, msg = self.chat_group_manager.add_client_to_group(existing_uid, client_uid)\n'
        '                if success:\n'
        '                    logger.info(f"Auto-grouped {client_uid} with {existing_uid}: {msg}")\n'
        '                else:\n'
        '                    logger.warning(f"Auto-group failed: {msg}")\n'
        '            # Send group update to all members\n'
        '            group_members = self.chat_group_manager.get_group_members(client_uid)\n'
        '            for member_uid in group_members:\n'
        '                if member_uid in self.client_connections:\n'
        '                    await self.send_group_update(self.client_connections[member_uid], member_uid)\n'
        '        else:\n'
        '            await self.send_group_update(websocket, client_uid)'
    )

    if old not in content:
        print("patch-auto-group: WARNING - could not find patch target, skipping",
              file=sys.stderr)
        return

    content = content.replace(old, new)

    with open(HANDLER_FILE, "w") as f:
        f.write(content)

    print("patch-auto-group: household auto-grouping enabled")


def patch_wm_snapshot_broadcast():
    """Add handler for crow-wm-snapshot messages: broadcast to group members.

    When a client sends a crow-wm-snapshot message (containing the current
    window manager state), the server broadcasts it to all other group members.
    This enables late joiners to see the existing window layout.
    """
    with open(HANDLER_FILE, "r") as f:
        content = f.read()

    if "# [crow-patch] wm-snapshot broadcast" in content:
        print("patch-auto-group: wm-snapshot broadcast already patched")
        return

    # Add a handler method for crow-wm-snapshot and register it in the message handlers.
    # We patch _route_message to intercept crow-wm-snapshot before the "Unknown" warning.

    old = (
        '        if handler:\n'
        '            await handler(websocket, client_uid, data)\n'
        '        else:\n'
        '            if msg_type != "frontend-playback-complete":\n'
        '                logger.warning(f"Unknown message type: {msg_type}")'
    )

    new = (
        '        if handler:\n'
        '            await handler(websocket, client_uid, data)\n'
        '        # [crow-patch] wm-snapshot broadcast\n'
        '        elif msg_type == "crow-wm-snapshot":\n'
        '            group_members = self.chat_group_manager.get_group_members(client_uid)\n'
        '            if len(group_members) > 1:\n'
        '                await self.broadcast_to_group(group_members, data, exclude_uid=client_uid)\n'
        '        else:\n'
        '            if msg_type != "frontend-playback-complete":\n'
        '                logger.warning(f"Unknown message type: {msg_type}")'
    )

    if old not in content:
        print("patch-auto-group: WARNING - could not find wm-snapshot patch target",
              file=sys.stderr)
        return

    content = content.replace(old, new)

    with open(HANDLER_FILE, "w") as f:
        f.write(content)

    print("patch-auto-group: wm-snapshot broadcast enabled")


def patch_group_single_responder():
    """Patch group conversation to only use ONE AI responder per human input.

    The default group conversation cycles all members through a turn queue,
    creating AI-to-AI chat that overwhelms the 4B model and prevents tool
    calling. In household mode (same LLM for all), we only need the initiator's
    AI to respond — the other members receive the broadcast.

    We patch handle_group_member_turn to skip the re-append to group_queue,
    so only the first member (initiator) gets a turn per human input.
    """
    group_file = "/app/src/open_llm_vtuber/conversations/group_conversation.py"

    with open(group_file, "r") as f:
        content = f.read()

    if "# [crow-patch] single-responder" in content:
        print("patch-auto-group: single-responder already patched")
        return

    # The re-append line that causes infinite cycling:
    #     state.group_queue.append(current_member_uid)
    # We comment it out so each human input gets exactly one AI response.

    old = "    state.group_queue.append(current_member_uid)"
    new = (
        "    # [crow-patch] single-responder — don't re-queue members\n"
        "    # In household mode, one AI response per human input is enough.\n"
        "    # state.group_queue.append(current_member_uid)"
    )

    if old not in content:
        print("patch-auto-group: WARNING - could not find single-responder patch target",
              file=sys.stderr)
        return

    content = content.replace(old, new, 1)

    with open(group_file, "w") as f:
        f.write(content)

    print("patch-auto-group: single-responder mode enabled")


def patch_group_prompt():
    """Strengthen tool-calling in the group conversation prompt."""
    prompt_file = "/app/prompts/utils/group_conversation_prompt.txt"

    try:
        with open(prompt_file, "r") as f:
            content = f.read()
    except FileNotFoundError:
        print("patch-auto-group: group prompt not found, skipping")
        return

    if "IMPORTANT: Tool calls" in content:
        print("patch-auto-group: group prompt already patched")
        return

    content += (
        "\n\nIMPORTANT: Tool calls still apply in group conversations. "
        "When any participant asks to open, play, watch, search, close, pause, "
        "resume, mute, or unmute something, you MUST call the crow_wm tool. "
        "Do NOT just talk about it — call the tool.\n"
    )

    with open(prompt_file, "w") as f:
        f.write(content)

    print("patch-auto-group: group prompt patched with tool-calling reminder")


def patch_group_uid():
    """Patch send_group_update to include the recipient's own UID in the payload.

    WebRTC signaling requires each client to know its own UUID so it can
    construct directed offer/answer messages. The upstream group-update
    message includes the member list but not the recipient's own UID.
    This patch adds "your_uid": client_uid to both branches.
    """
    with open(HANDLER_FILE, "r") as f:
        content = f.read()

    if "# [crow-patch] group-uid" in content:
        print("patch-auto-group: group-uid already patched")
        return

    # Patch the "has group" branch
    old_with_group = (
        '                    {\n'
        '                        "type": "group-update",\n'
        '                        "members": current_members,\n'
        '                        "is_owner": group.owner_uid == client_uid,\n'
        '                    }'
    )

    new_with_group = (
        '                    {\n'
        '                        "type": "group-update",\n'
        '                        "members": current_members,\n'
        '                        "is_owner": group.owner_uid == client_uid,\n'
        '                        "your_uid": client_uid,  # [crow-patch] group-uid\n'
        '                    }'
    )

    if old_with_group not in content:
        print("patch-auto-group: WARNING - could not find group-uid patch target (with group)",
              file=sys.stderr)
        return

    content = content.replace(old_with_group, new_with_group)

    # Patch the "no group" branch
    old_no_group = (
        '                    {\n'
        '                        "type": "group-update",\n'
        '                        "members": [],\n'
        '                        "is_owner": False,\n'
        '                    }'
    )

    new_no_group = (
        '                    {\n'
        '                        "type": "group-update",\n'
        '                        "members": [],\n'
        '                        "is_owner": False,\n'
        '                        "your_uid": client_uid,  # [crow-patch] group-uid\n'
        '                    }'
    )

    if old_no_group not in content:
        print("patch-auto-group: WARNING - could not find group-uid patch target (no group)",
              file=sys.stderr)
        return

    content = content.replace(old_no_group, new_no_group)

    with open(HANDLER_FILE, "w") as f:
        f.write(content)

    print("patch-auto-group: group-uid enabled (your_uid in group-update)")


def patch_webrtc_relay():
    """Patch _route_message to relay WebRTC signaling between group members.

    Handles two message types:
    - webrtc-signal: directed relay to target_uid (offer/answer/ice)
    - webrtc-mute: broadcast to group

    Server overwrites from_uid with the actual sender's client_uid to
    prevent spoofing, and validates target_uid is in the same group.
    """
    with open(HANDLER_FILE, "r") as f:
        content = f.read()

    if "# [crow-patch] webrtc-relay" in content:
        print("patch-auto-group: webrtc-relay already patched")
        return

    # Match the post-wm-snapshot code (this patch runs AFTER patch_wm_snapshot_broadcast)
    old = (
        '        # [crow-patch] wm-snapshot broadcast\n'
        '        elif msg_type == "crow-wm-snapshot":\n'
        '            group_members = self.chat_group_manager.get_group_members(client_uid)\n'
        '            if len(group_members) > 1:\n'
        '                await self.broadcast_to_group(group_members, data, exclude_uid=client_uid)\n'
        '        else:\n'
        '            if msg_type != "frontend-playback-complete":\n'
        '                logger.warning(f"Unknown message type: {msg_type}")'
    )

    new = (
        '        # [crow-patch] wm-snapshot broadcast\n'
        '        elif msg_type == "crow-wm-snapshot":\n'
        '            group_members = self.chat_group_manager.get_group_members(client_uid)\n'
        '            if len(group_members) > 1:\n'
        '                await self.broadcast_to_group(group_members, data, exclude_uid=client_uid)\n'
        '        # [crow-patch] webrtc-relay\n'
        '        elif msg_type == "webrtc-signal":\n'
        '            target_uid = data.get("target_uid")\n'
        '            if target_uid:\n'
        '                group_members = self.chat_group_manager.get_group_members(client_uid)\n'
        '                if target_uid in group_members and target_uid in self.client_connections:\n'
        '                    data["from_uid"] = client_uid\n'
        '                    await self.client_connections[target_uid].send_text(json.dumps(data))\n'
        '                else:\n'
        '                    logger.warning(f"WebRTC signal target {target_uid} not in group or not connected")\n'
        '        elif msg_type in ("webrtc-mute", "peer-profile", "crow-wm-action"):\n'
        '            group_members = self.chat_group_manager.get_group_members(client_uid)\n'
        '            if len(group_members) > 1:\n'
        '                data["from_uid"] = client_uid\n'
        '                await self.broadcast_to_group(group_members, data, exclude_uid=client_uid)\n'
        '        else:\n'
        '            if msg_type != "frontend-playback-complete":\n'
        '                logger.warning(f"Unknown message type: {msg_type}")'
    )

    if old not in content:
        print("patch-auto-group: WARNING - could not find webrtc-relay patch target",
              file=sys.stderr)
        return

    content = content.replace(old, new)

    with open(HANDLER_FILE, "w") as f:
        f.write(content)

    print("patch-auto-group: webrtc-relay enabled (signal + mute + peer-profile)")


def patch_room_token_validation():
    """Patch WebSocket endpoint to validate room tokens for remote access.

    When CROW_GATEWAY_URL is set, incoming WebSocket connections with ?room=X&token=Y
    query params are validated against the Crow gateway's room token API.
    Connections without tokens are allowed (household mode, local access).
    Connections with invalid tokens are rejected.
    """
    routes_file = "/app/src/open_llm_vtuber/routes.py"

    with open(routes_file, "r") as f:
        content = f.read()

    if "# [crow-patch] room-token-validation" in content:
        print("patch-auto-group: room token validation already patched")
        return

    # Patch the websocket_endpoint function to check for room tokens
    old = (
        '    @router.websocket("/client-ws")\n'
        '    async def websocket_endpoint(websocket: WebSocket):\n'
        '        """WebSocket endpoint for client connections"""\n'
        '        await websocket.accept()\n'
        '        client_uid = str(uuid4())'
    )

    # Use local gateway for token validation (no auth needed on this endpoint)
    validate_url = "http://localhost:3002/api/room/validate"

    new = (
        '    # [crow-patch] room-token-validation\n'
        '    @router.websocket("/client-ws")\n'
        '    async def websocket_endpoint(websocket: WebSocket):\n'
        '        """WebSocket endpoint for client connections"""\n'
        '        # Validate room token if provided\n'
        '        room_code = websocket.query_params.get("room", "")\n'
        '        room_token = websocket.query_params.get("token", "")\n'
        '        if room_code and room_token:\n'
        '            import httpx\n'
        '            try:\n'
        f'                async with httpx.AsyncClient() as http:\n'
        f'                    resp = await http.get("{validate_url}", params={{"room": room_code, "token": room_token}}, timeout=5)\n'
        '                    if resp.status_code != 200 or not resp.json().get("valid"):\n'
        '                        await websocket.close(code=4001, reason="Invalid room token")\n'
        '                        return\n'
        '                    logger.info(f"Room token validated for room {{room_code}}")\n'
        '            except Exception as e:\n'
        '                logger.warning(f"Room token validation failed: {{e}}, allowing connection")\n'
        '        await websocket.accept()\n'
        '        client_uid = str(uuid4())'
    )

    if old not in content:
        print("patch-auto-group: WARNING - could not find room token patch target",
              file=sys.stderr)
        return

    content = content.replace(old, new)

    with open(routes_file, "w") as f:
        f.write(content)

    print("patch-auto-group: room token validation enabled")


if __name__ == "__main__":
    patch_auto_group()
    patch_wm_snapshot_broadcast()
    patch_group_single_responder()
    patch_group_prompt()
    patch_room_token_validation()
    patch_group_uid()
    patch_webrtc_relay()  # Must run after patch_wm_snapshot_broadcast

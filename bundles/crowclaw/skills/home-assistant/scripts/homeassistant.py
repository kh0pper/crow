#!/usr/bin/env python3
"""
Home Assistant API wrapper script.
Provides common operations for controlling devices and querying states.
"""

import os
import sys
import json
import argparse
from typing import Optional, Any, List

try:
    import requests
except ImportError:
    print("Error: requests library not found. Install with: pip install requests")
    sys.exit(1)


class HomeAssistant:
    """Simple Home Assistant API client."""

    def __init__(self, url: str, token: str):
        self.url = url.rstrip('/')
        self.token = token
        self.headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }

    def _api_call(self, method: str, path: str, data: Optional[dict] = None):
        """Make an API call to Home Assistant."""
        url = f"{self.url}{path}"
        try:
            if method.upper() == "GET":
                response = requests.get(url, headers=self.headers, timeout=10)
            elif method.upper() == "POST":
                response = requests.post(url, headers=self.headers, json=data, timeout=10)
            else:
                raise ValueError(f"Unsupported method: {method}")
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            return {"error": str(e)}

    def get_state(self, entity_id: str) -> dict:
        return self._api_call("GET", f"/api/states/{entity_id}")

    def get_states(self) -> List[dict]:
        return self._api_call("GET", "/api/states")

    def call_service(self, domain: str, service: str, service_data: dict) -> dict:
        return self._api_call("POST", f"/api/services/{domain}/{service}", service_data)

    def turn_on(self, entity_id: str, **kwargs) -> dict:
        domain = entity_id.split('.')[0]
        service_data = {"entity_id": entity_id}
        service_data.update(kwargs)
        return self.call_service(domain, "turn_on", service_data)

    def turn_off(self, entity_id: str) -> dict:
        domain = entity_id.split('.')[0]
        return self.call_service(domain, "turn_off", {"entity_id": entity_id})

    def toggle(self, entity_id: str) -> dict:
        domain = entity_id.split('.')[0]
        return self.call_service(domain, "toggle", {"entity_id": entity_id})

    def play_media(self, entity_id: str, media_url: str, media_type: str = "music") -> dict:
        # Turn on the device first (needed for Google Cast devices)
        state = self.get_state(entity_id)
        if isinstance(state, dict) and state.get("state") in ("off", "unavailable"):
            self.turn_on(entity_id)
            import time
            time.sleep(3)
        return self.call_service("media_player", "play_media", {
            "entity_id": entity_id,
            "media_content_id": media_url,
            "media_content_type": media_type,
        })

    def media_pause(self, entity_id: str) -> dict:
        return self.call_service("media_player", "media_pause", {"entity_id": entity_id})

    def media_stop(self, entity_id: str) -> dict:
        return self.call_service("media_player", "media_stop", {"entity_id": entity_id})

    def media_play(self, entity_id: str) -> dict:
        return self.call_service("media_player", "media_play", {"entity_id": entity_id})

    def set_volume(self, entity_id: str, level: float) -> dict:
        return self.call_service("media_player", "volume_set", {
            "entity_id": entity_id,
            "volume_level": level,
        })

    def vacuum_start(self, entity_id: str = "vacuum.robotina") -> dict:
        return self.call_service("vacuum", "start", {"entity_id": entity_id})

    def vacuum_stop(self, entity_id: str = "vacuum.robotina") -> dict:
        return self.call_service("vacuum", "stop", {"entity_id": entity_id})

    def vacuum_dock(self, entity_id: str = "vacuum.robotina") -> dict:
        return self.call_service("vacuum", "return_to_base", {"entity_id": entity_id})

    def set_value(self, entity_id: str, value: Any) -> dict:
        domain = entity_id.split('.')[0]
        return self.call_service(domain, "set_value", {"entity_id": entity_id, "value": value})

    def play_youtube(self, entity_id: str, query: str) -> dict:
        """Resolve a YouTube URL/query via yt-dlp and cast to a device."""
        import subprocess

        # Auto-turn-on the device
        state = self.get_state(entity_id)
        if isinstance(state, dict) and state.get("state") in ("off", "unavailable"):
            self.turn_on(entity_id)
            import time
            time.sleep(3)

        # Resolve video ID via yt-dlp
        try:
            result = subprocess.run(
                ["yt-dlp", "--flat-playlist", "--print", "id", "--no-warnings", "--playlist-items", "1", query],
                capture_output=True, text=True, timeout=30
            )
            video_id = result.stdout.strip().split('\n')[0]
            if not video_id:
                return {"error": f"yt-dlp could not resolve video ID. stderr: {result.stderr.strip()}"}
        except FileNotFoundError:
            return {"error": "yt-dlp not found. Install with: pip install yt-dlp"}
        except subprocess.TimeoutExpired:
            return {"error": "yt-dlp timed out resolving video ID"}

        print(f"Resolved video ID: {video_id}")

        # Cast via YouTube receiver
        media_content_id = json.dumps({"app_name": "youtube", "media_id": video_id})
        return self.call_service("media_player", "play_media", {
            "entity_id": entity_id,
            "media_content_type": "cast",
            "media_content_id": media_content_id,
        })


def main():
    parser = argparse.ArgumentParser(description="Home Assistant CLI")
    parser.add_argument("--url", default=os.getenv("HOMEASSISTANT_URL"), help="Home Assistant URL")
    parser.add_argument("--token", default=os.getenv("HOMEASSISTANT_TOKEN"), help="Home Assistant API token")

    subparsers = parser.add_subparsers(dest="command", help="Commands")

    # State commands
    subparsers.add_parser("list", help="List all entities")
    state_parser = subparsers.add_parser("state", help="Get entity state")
    state_parser.add_argument("entity_id", help="Entity ID")

    # On/off/toggle
    on_parser = subparsers.add_parser("on", help="Turn on entity")
    on_parser.add_argument("entity_id", help="Entity ID")
    on_parser.add_argument("--brightness", type=int, help="Brightness (0-255)")
    on_parser.add_argument("--color", help="RGB color (e.g., '255,0,0')")

    off_parser = subparsers.add_parser("off", help="Turn off entity")
    off_parser.add_argument("entity_id", help="Entity ID")

    toggle_parser = subparsers.add_parser("toggle", help="Toggle entity")
    toggle_parser.add_argument("entity_id", help="Entity ID")

    # Media commands
    play_parser = subparsers.add_parser("play", help="Play media on a media_player")
    play_parser.add_argument("entity_id", help="Media player entity ID")
    play_parser.add_argument("media_url", help="Media URL to play")
    play_parser.add_argument("--type", default="music", help="Media type (music, video, url, etc.)")

    pause_parser = subparsers.add_parser("pause", help="Pause media player")
    pause_parser.add_argument("entity_id", help="Media player entity ID")

    stop_parser = subparsers.add_parser("stop", help="Stop media player")
    stop_parser.add_argument("entity_id", help="Media player entity ID")

    resume_parser = subparsers.add_parser("resume", help="Resume media player")
    resume_parser.add_argument("entity_id", help="Media player entity ID")

    vol_parser = subparsers.add_parser("volume", help="Set volume (0.0 - 1.0)")
    vol_parser.add_argument("entity_id", help="Media player entity ID")
    vol_parser.add_argument("level", type=float, help="Volume level 0.0 to 1.0")

    # Vacuum commands
    subparsers.add_parser("vacuum-start", help="Start Roomba")
    subparsers.add_parser("vacuum-stop", help="Stop Roomba")
    subparsers.add_parser("vacuum-dock", help="Send Roomba to dock")
    subparsers.add_parser("vacuum-status", help="Get Roomba status")

    # YouTube command
    yt_parser = subparsers.add_parser("youtube", help="Play YouTube video via yt-dlp + Cast")
    yt_parser.add_argument("entity_id", help="Media player entity ID")
    yt_parser.add_argument("query", help="YouTube URL, channel/live URL, or ytsearch: query")

    # Generic service call
    svc_parser = subparsers.add_parser("service", help="Call any HA service")
    svc_parser.add_argument("domain", help="Service domain (e.g., light)")
    svc_parser.add_argument("svc_name", help="Service name (e.g., turn_on)")
    svc_parser.add_argument("data", help="JSON service data")

    # Set value
    set_parser = subparsers.add_parser("set", help="Set input value")
    set_parser.add_argument("entity_id", help="Entity ID")
    set_parser.add_argument("value", help="Value to set")

    args = parser.parse_args()

    if not args.url or not args.token:
        print("Error: HOMEASSISTANT_URL and HOMEASSISTANT_TOKEN env vars required")
        sys.exit(1)

    ha = HomeAssistant(args.url, args.token)

    if args.command == "list":
        states = ha.get_states()
        for state in sorted(states, key=lambda x: x['entity_id']):
            name = state.get('attributes', {}).get('friendly_name', '')
            print(f"{state['entity_id']}: {state['state']}  ({name})")

    elif args.command == "state":
        print(json.dumps(ha.get_state(args.entity_id), indent=2))

    elif args.command == "on":
        kwargs = {}
        if hasattr(args, 'brightness') and args.brightness:
            kwargs["brightness"] = args.brightness
        if hasattr(args, 'color') and args.color:
            kwargs["rgb_color"] = [int(x) for x in args.color.split(',')]
        result = ha.turn_on(args.entity_id, **kwargs)
        print(json.dumps(result, indent=2))

    elif args.command == "off":
        print(json.dumps(ha.turn_off(args.entity_id), indent=2))

    elif args.command == "toggle":
        print(json.dumps(ha.toggle(args.entity_id), indent=2))

    elif args.command == "play":
        result = ha.play_media(args.entity_id, args.media_url, args.type)
        print(json.dumps(result, indent=2))

    elif args.command == "pause":
        print(json.dumps(ha.media_pause(args.entity_id), indent=2))

    elif args.command == "stop":
        print(json.dumps(ha.media_stop(args.entity_id), indent=2))

    elif args.command == "resume":
        print(json.dumps(ha.media_play(args.entity_id), indent=2))

    elif args.command == "volume":
        print(json.dumps(ha.set_volume(args.entity_id, args.level), indent=2))

    elif args.command == "vacuum-start":
        print(json.dumps(ha.vacuum_start(), indent=2))

    elif args.command == "vacuum-stop":
        print(json.dumps(ha.vacuum_stop(), indent=2))

    elif args.command == "vacuum-dock":
        print(json.dumps(ha.vacuum_dock(), indent=2))

    elif args.command == "vacuum-status":
        state = ha.get_state("vacuum.robotina")
        battery = ha.get_state("sensor.robotina_battery")
        bin_full = ha.get_state("binary_sensor.robotina_bin_full")
        print(f"Status: {state.get('state', 'unknown')}")
        print(f"Battery: {battery.get('state', 'unknown')}%")
        print(f"Bin Full: {'Yes' if bin_full.get('state') == 'on' else 'No'}")
        attrs = state.get('attributes', {})
        if attrs:
            print(f"Fan Speed: {attrs.get('fan_speed', 'unknown')}")

    elif args.command == "youtube":
        result = ha.play_youtube(args.entity_id, args.query)
        print(json.dumps(result, indent=2))

    elif args.command == "service":
        data = json.loads(args.data)
        print(json.dumps(ha.call_service(args.domain, args.svc_name, data), indent=2))

    elif args.command == "set":
        print(json.dumps(ha.set_value(args.entity_id, args.value), indent=2))

    else:
        parser.print_help()


if __name__ == "__main__":
    main()

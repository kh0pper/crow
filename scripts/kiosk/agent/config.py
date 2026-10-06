"""Agent configuration: /etc/crow-kiosk/agent.json, written by pi-setup.sh."""

import ipaddress
import os
import re
import json

from protocol import normalise_origin
from hw import valid_mac

DEFAULTS = {
    "listen_host": "127.0.0.1",
    "listen_port": 8770,
    "wake_model": "/var/lib/crow-kiosk/wake/hey_jarvis_v0.1.onnx",
    "mel_model": "/var/lib/crow-kiosk/wake/melspectrogram.onnx",
    "embedding_model": "/var/lib/crow-kiosk/wake/embedding_model.onnx",
    "wake_threshold": 0.5,
    "media_threshold": 0.7,
    "speaking_tail_ms": 800,
    "refractory_ms": 2000,
    "wake_threads": 2,      # onnxruntime intra-op threads (the Pi 3 has 4 cores; Chromium needs the rest)
    "wake_step": 1,         # chunks per inference pass: 2 halves the call overhead, adds <= 80 ms delay
    "backlight": None,  # None = first /sys/class/backlight/* entry
    "touch_name": "ft5x06",
    "bt_sink_mac": None,  # optional; the agent keeps it connected
    "page_seen_marker": os.path.expanduser("~/.local/state/crow-kiosk/page-seen"),
    "mic_target": None,   # PipeWire node.name of the mic; pinned so a Bluetooth headset can never become the input
    "mic_cmd": [
        "pw-record",
        "--raw",
        "--rate",
        "16000",
        "--channels",
        "1",
        "--format",
        "s16",
        "--latency",
        "80ms",
        "--media-role",
        "Communication",
        "-",
    ],
}


def load_config(path=None, overrides=None):
    cfg = dict(DEFAULTS)
    if path:
        with open(path) as f:
            data = json.load(f)
        unknown = set(data) - set(DEFAULTS) - {"crow_origin"}
        if unknown:
            raise ValueError(f"unknown config keys: {sorted(unknown)}")
        cfg.update(data)
    cfg.update(overrides or {})
    if "crow_origin" not in cfg:
        raise ValueError("crow_origin is required")
    cfg["crow_origin"] = normalise_origin(cfg["crow_origin"])
    if not ipaddress.ip_address(cfg["listen_host"]).is_loopback:
        raise ValueError(
            "listen_host must be a loopback address (spec: no other services listen)"
        )
    if (
        not isinstance(cfg["listen_port"], int)
        or not 1024 <= cfg["listen_port"] <= 65535
    ):
        raise ValueError("listen_port must be 1024..65535")
    if cfg["bt_sink_mac"] is not None and not valid_mac(cfg["bt_sink_mac"]):
        raise ValueError("bt_sink_mac must look like AA:BB:CC:DD:EE:FF")
    if not isinstance(cfg["mic_cmd"], list) or not all(
        isinstance(a, str) for a in cfg["mic_cmd"]
    ):
        raise ValueError("mic_cmd must be a list of strings")
    if cfg["wake_threads"] not in (1, 2, 3, 4):
        raise ValueError("wake_threads must be 1..4")
    if cfg["wake_step"] not in (1, 2, 3):
        raise ValueError("wake_step must be 1, 2 or 3")
    t = cfg["mic_target"]
    if t is not None and not (isinstance(t, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,200}", t)):
        raise ValueError("mic_target must be a PipeWire node name")
    return cfg


def mic_command(cfg):
    cmd = list(cfg["mic_cmd"])
    if cfg.get("mic_target"):
        cmd[-1:-1] = ["--target", cfg["mic_target"]]
    return cmd

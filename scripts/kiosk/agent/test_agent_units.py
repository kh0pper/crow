"""Unit tests for the kiosk agent's pure parts. stdlib unittest + numpy; run with
python3 -m unittest discover -s scripts/kiosk/agent -p 'test_*.py'"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _testenv  # noqa: E402,F401  (must come before config is imported)

import protocol  # noqa: E402
from config import load_config  # noqa: E402
from hw import (
    Backlight,
    ReconnectBackoff,
    find_input_device,
    is_touch_down,
    parse_bt_info,  # noqa: E402
    valid_mac,
    EV_KEY,
    EV_ABS,
    BTN_TOUCH,
    ABS_MT_TRACKING_ID,
)
from wakegate import WakeGate  # noqa: E402


def _read(path):
    with open(path) as f:
        return f.read()


ORIGIN = "https://crow.example.ts.net:8444"


class ProtocolTests(unittest.TestCase):
    def test_accepts_the_three_page_messages(self):
        self.assertEqual(
            protocol.parse_page_message('{"type":"display","on":false}'),
            {"type": "display", "on": False},
        )
        self.assertEqual(
            protocol.parse_page_message('{"type":"speaking","on":true}'),
            {"type": "speaking", "on": True},
        )
        self.assertEqual(
            protocol.parse_page_message('{"type":"media","on":true,"level":50}'),
            {"type": "media", "on": True, "level": 50.0},
        )

    def test_refuses_everything_else(self):
        bad = [
            '{"type":"exec","cmd":"ls"}',
            '{"type":"bt_reconnect","mac":"00:11:22:33:44:55"}',
            '{"type":"bt_pair","mac":"00:11:22:33:44:55"}',
            '{"type":"bt_reconnect","req":123}',
            '{"type":"display","on":"yes"}',
            '{"type":"display"}',
            "[1,2]",
            "not json",
            '{"type":"media","on":true,"level":101}',
            '{"type":"media","on":true,"level":true}',
            b'{"type":"display","on":true}',
            json.dumps({"type": "display", "on": True, "pad": "x" * 2000}),
        ]
        for raw in bad:
            with self.assertRaises(protocol.ProtocolError, msg=repr(raw)[:60]):
                protocol.parse_page_message(raw)

    def test_origin_must_match_exactly(self):
        allowed = protocol.normalise_origin(ORIGIN + "/")
        self.assertEqual(allowed, ORIGIN)
        self.assertTrue(protocol.origin_allowed(ORIGIN, allowed))
        self.assertTrue(
            protocol.origin_allowed("https://CROW.example.ts.net:8444", allowed)
        )
        for o in (
            None,
            "",
            "null",
            "http://crow.example.ts.net:8444",
            "https://crow.example.ts.net",
            "https://evil.example",
            "https://crow.example.ts.net:8444.evil.example",
            "https://www.youtube-nocookie.com",
        ):
            self.assertFalse(protocol.origin_allowed(o, allowed), o)

    def test_normalise_origin_rejects_paths_and_http(self):
        for u in (
            "http://crow.example.ts.net",
            "https://crow.example.ts.net/display",
            "https://u:p@h.example",
            "ftp://h.example",
            "https://h.example/?q=1",
        ):
            with self.assertRaises(ValueError, msg=u):
                protocol.normalise_origin(u)
        self.assertEqual(
            protocol.normalise_origin("https://h.example:443"), "https://h.example"
        )

    def test_bt_reconnect_takes_no_mac_and_bt_state_never_carries_one(self):
        self.assertEqual(protocol.parse_page_message('{"type":"bt_reconnect"}'), {"type": "bt_reconnect", "req": None})
        self.assertEqual(protocol.parse_page_message('{"type":"bt_reconnect","req":"r1"}')["req"], "r1")
        out = json.loads(protocol.bt_state_msg({"type": "bt_state", "connected": True, "name": "Office", "mac": "00:11:22:33:44:55", "x": 1}, "r1"))
        self.assertEqual(set(out), {"type", "connected", "name", "req"})

    def test_agent_frames_are_small_json(self):
        for s in (
            protocol.agent_status("hey_jarvis_v0.1.onnx", True, {"type": "bt_state", "connected": True}),
            protocol.wake_msg(0.91234),
            protocol.touch_while_dark_msg(),
            protocol.bt_state_msg({"type": "bt_state", "connected": False, "name": "Office", "mac": "00:11:22:33:44:55"}),
        ):
            self.assertLess(len(s), 200)
            self.assertIn("type", json.loads(s))
        self.assertEqual(json.loads(protocol.wake_msg(0.91234))["score"], 0.912)


class WakeGateTests(unittest.TestCase):
    def test_threshold_and_refractory(self):
        g = WakeGate(threshold=0.5, refractory_ms=2000)
        self.assertFalse(g.offer(0.49, 0))
        self.assertTrue(g.offer(0.8, 100))
        self.assertFalse(g.offer(0.9, 180), "same utterance, next 80 ms frame")
        self.assertFalse(g.offer(0.9, 2099))
        self.assertTrue(g.offer(0.9, 2100))

    def test_speaking_suppresses_with_a_tail_for_bluetooth_latency(self):
        g = WakeGate(speaking_tail_ms=800)
        g.set_speaking(True, 0)
        self.assertFalse(g.offer(0.99, 500))
        g.set_speaking(False, 1000)
        self.assertFalse(
            g.offer(0.99, 1799),
            "speaker still sounding after the page's playback ended",
        )
        self.assertTrue(g.offer(0.99, 1800))

    def test_media_raises_the_threshold_but_stays_live(self):
        g = WakeGate(threshold=0.5, media_threshold=0.7)
        g.set_media(True)
        self.assertFalse(g.offer(0.6, 0))
        self.assertTrue(g.offer(0.75, 10))
        g.set_media(False)
        self.assertTrue(g.offer(0.6, 5000))

    def test_stale_speaking_flag_expires(self):
        g = WakeGate(speaking_tail_ms=0, max_speaking_ms=120000)
        g.set_speaking(True, 0)
        self.assertFalse(g.offer(0.99, 119999))
        self.assertTrue(g.offer(0.99, 120000))

    def test_rejects_silly_thresholds(self):
        with self.assertRaises(ValueError):
            WakeGate(threshold=0)
        with self.assertRaises(ValueError):
            WakeGate(media_threshold=1.5)


DEVICES = """I: Bus=0019 Vendor=0001 Product=0001 Version=0100
N: Name="vc4-hdmi"
H: Handlers=kbd event0

I: Bus=0018 Vendor=0000 Product=0000 Version=0000
N: Name="generic ft5x06 (00)"
H: Handlers=mouse0 event1
"""


class HardwareTests(unittest.TestCase):
    def test_finds_the_touch_device(self):
        self.assertEqual(find_input_device("ft5x06", DEVICES), "/dev/input/event1")
        self.assertIsNone(find_input_device("goodix", DEVICES))

    def test_touch_down_detection(self):
        self.assertTrue(is_touch_down(EV_KEY, BTN_TOUCH, 1))
        self.assertFalse(is_touch_down(EV_KEY, BTN_TOUCH, 0))
        self.assertTrue(is_touch_down(EV_ABS, ABS_MT_TRACKING_ID, 7))
        self.assertFalse(is_touch_down(EV_ABS, ABS_MT_TRACKING_ID, -1))

    def test_backlight_bl_power_and_brightness_fallback(self):
        with tempfile.TemporaryDirectory() as d:
            for n, v in (
                ("bl_power", "0"),
                ("brightness", "255"),
                ("max_brightness", "255"),
            ):
                with open(os.path.join(d, n), "w") as f:
                    f.write(v)
            b = Backlight(d)
            self.assertTrue(b.set(False))
            self.assertEqual(_read(os.path.join(d, "bl_power")), "4")
            self.assertTrue(b.set(True))
            self.assertEqual(_read(os.path.join(d, "bl_power")), "0")
            os.remove(os.path.join(d, "bl_power"))
            os.mkdir(
                os.path.join(d, "bl_power")
            )  # unwritable as a file -> OSError -> brightness fallback
            b.set(False)
            self.assertEqual(_read(os.path.join(d, "brightness")), "0")
            b.set(True)
            self.assertEqual(_read(os.path.join(d, "brightness")), "255")
        self.assertFalse(Backlight("/nonexistent/backlight").set(False))

    def test_bluetooth_info_parsing_and_mac(self):
        text = "Device 00:11:22:33:44:55 (public)\n\tName: Office\n\tPaired: yes\n\tTrusted: yes\n\tConnected: no\n"
        self.assertEqual(
            parse_bt_info(text), {"paired": True, "trusted": True, "connected": False}
        )
        self.assertEqual(
            parse_bt_info(""), {"paired": False, "trusted": False, "connected": False}
        )
        self.assertTrue(valid_mac("00:11:22:aa:BB:cc"))
        for m in (
            "",
            None,
            "00:11:22:33:44",
            "00-11-22-33-44-55",
            "00:11:22:33:44:55; reboot",
        ):
            self.assertFalse(valid_mac(m), m)

    def test_reconnect_backoff(self):
        b = ReconnectBackoff(30, 300)
        self.assertEqual([b.failed() for _ in range(6)], [30, 60, 120, 240, 300, 300])
        self.assertEqual(b.connected(), 30)
        self.assertEqual(b.failed(), 30)


class ConfigTests(unittest.TestCase):
    def write(self, data):
        f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(data, f)
        f.close()
        self.addCleanup(os.unlink, f.name)
        return f.name

    def test_defaults_and_origin(self):
        cfg = load_config(self.write({"crow_origin": ORIGIN + "/"}))
        self.assertEqual(cfg["crow_origin"], ORIGIN)
        self.assertEqual((cfg["listen_host"], cfg["listen_port"]), ("127.0.0.1", 8770))

    def test_refuses_non_loopback_and_bad_values(self):
        for bad in (
            {"crow_origin": ORIGIN, "listen_host": "0.0.0.0"},
            {"crow_origin": ORIGIN, "listen_host": "100.64.20.5"},
            {"crow_origin": "http://crow.example.ts.net"},
            {"crow_origin": ORIGIN, "bt_sink_mac": "nope"},
            {"crow_origin": ORIGIN, "listen_port": 80},
            {"crow_origin": ORIGIN, "surprise": 1},
            {"listen_port": 8770},
        ):
            with self.assertRaises(ValueError, msg=str(bad)):
                load_config(self.write(bad))


if __name__ == "__main__":
    unittest.main()


class BenchLatencyTests(unittest.TestCase):
    def test_onset_finds_a_click_after_a_known_delay(self):
        import numpy as np
        from bench_latency import onset, RATE
        rng = np.random.default_rng(1)
        x = (rng.normal(0, 30, RATE * 3)).astype("<i2")
        start, delay = RATE, int(0.240 * RATE)   # click 240 ms after the play start
        x[start + delay:start + delay + 480] += (8000 * np.sin(np.arange(480) / 3)).astype("<i2")
        o = onset(x, start)
        self.assertIsNotNone(o)
        self.assertLess(abs(o - delay), RATE * 0.006)

    def test_onset_none_when_silent(self):
        import numpy as np
        from bench_latency import onset, RATE
        x = np.random.default_rng(2).normal(0, 30, RATE * 2).astype("<i2")
        self.assertIsNone(onset(x, RATE))

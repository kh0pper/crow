"""End-to-end tests of the agent's local WebSocket: origin gate, status frame, page messages driving the
backlight and the wake gate, wake/touch events reaching the page, one page at a time, bad frames closing.
Uses the `websockets` package (Debian python3-websockets); skipped if it is missing."""

import asyncio
import json
import os
import socket
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _testenv  # noqa: E402,F401  (must come before config is imported)

try:
    import websockets
except ImportError:  # pragma: no cover
    websockets = None

from config import load_config  # noqa: E402
from crow_kiosk_agent import Agent  # noqa: E402
from hw import Backlight  # noqa: E402


def _read(path):
    with open(path) as f:
        return f.read()


ORIGIN = "https://crow.example.ts.net:8444"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


@unittest.skipIf(websockets is None, "python websockets package not installed")
class WsProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.dir = tempfile.TemporaryDirectory()
        for n, v in (
            ("bl_power", "0"),
            ("brightness", "255"),
            ("max_brightness", "255"),
        ):
            with open(os.path.join(self.dir.name, n), "w") as f:
                f.write(v)
        self.port = free_port()
        self.cfg = load_config(
            overrides={"crow_origin": ORIGIN, "listen_port": self.port}
        )
        self.clock = Clock()
        self.agent = Agent(
            self.cfg,
            detector=object(),
            backlight=Backlight(self.dir.name),
            clock=self.clock,
        )
        self.agent.loop = asyncio.get_running_loop()
        self.server = await websockets.serve(
            self.agent.handler, "127.0.0.1", self.port, origins=[ORIGIN], max_size=1024
        )
        self.uri = f"ws://127.0.0.1:{self.port}"

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()
        self.dir.cleanup()

    def bl(self):
        return _read(os.path.join(self.dir.name, "bl_power"))

    async def connect(self, origin=ORIGIN):
        ws = await websockets.connect(self.uri, origin=origin)
        status = json.loads(await asyncio.wait_for(ws.recv(), 2))
        return ws, status

    async def settle(self):
        for _ in range(20):
            await asyncio.sleep(0.01)

    async def test_wrong_or_missing_origin_is_refused_at_the_handshake(self):
        for origin in (
            "https://www.youtube-nocookie.com",
            "http://crow.example.ts.net:8444",
            None,
        ):
            with self.assertRaises(Exception, msg=str(origin)):
                kw = {"origin": origin} if origin else {}
                ws = await websockets.connect(self.uri, **kw)
                await asyncio.wait_for(ws.recv(), 2)

    async def test_status_frame_on_connect(self):
        ws, status = await self.connect()
        self.assertEqual(status["type"], "agent")
        self.assertEqual(status["v"], 1)
        self.assertTrue(status["wake"])
        await ws.close()

    async def test_display_messages_drive_the_backlight(self):
        ws, _ = await self.connect()
        await ws.send('{"type":"display","on":false}')
        await self.settle()
        self.assertEqual(self.bl(), "4")
        await ws.send('{"type":"display","on":true}')
        await self.settle()
        self.assertEqual(self.bl(), "0")
        await ws.close()

    async def test_wake_reaches_the_page_and_speaking_suppresses_it(self):
        ws, _ = await self.connect()
        await ws.send('{"type":"speaking","on":true}')
        await self.settle()
        self.clock.t = 1000
        await self.agent.on_score(0.95)
        await ws.send('{"type":"speaking","on":false}')
        await self.settle()
        self.clock.t = 5000
        await self.agent.on_score(0.95)
        msg = json.loads(await asyncio.wait_for(ws.recv(), 2))
        self.assertEqual(msg["type"], "wake")
        self.assertEqual(msg["score"], 0.95)
        await ws.close()

    async def test_wake_while_dark_lights_the_screen(self):
        ws, _ = await self.connect()
        await ws.send('{"type":"display","on":false}')
        await self.settle()
        self.clock.t = 10000
        await self.agent.on_score(0.9)
        self.assertEqual(self.bl(), "0")
        self.assertEqual(
            json.loads(await asyncio.wait_for(ws.recv(), 2))["type"], "wake"
        )
        await ws.close()

    async def test_touch_while_dark_is_reported_once_the_screen_is_off(self):
        ws, _ = await self.connect()
        await self.agent.on_touch_down()  # screen on: nothing to report
        await ws.send('{"type":"display","on":false}')
        await self.settle()
        await self.agent.on_touch_down()
        self.assertEqual(
            json.loads(await asyncio.wait_for(ws.recv(), 2))["type"], "touch_while_dark"
        )
        self.assertEqual(self.bl(), "0")
        await ws.close()

    async def test_media_threshold_applies(self):
        ws, _ = await self.connect()
        await ws.send('{"type":"media","on":true,"level":50}')
        await self.settle()
        self.clock.t = 20000
        await self.agent.on_score(0.6)  # below media threshold 0.7
        await self.agent.on_score(0.8)
        self.assertEqual(json.loads(await asyncio.wait_for(ws.recv(), 2))["score"], 0.8)
        await ws.close()

    async def test_a_bad_frame_closes_the_socket(self):
        ws, _ = await self.connect()
        await ws.send('{"type":"exec","cmd":"reboot"}')
        with self.assertRaises(websockets.exceptions.ConnectionClosed):
            await asyncio.wait_for(ws.recv(), 2)
        self.assertEqual(ws.close_code, 4400)

    async def test_oversized_frame_is_refused(self):
        ws, _ = await self.connect()
        await ws.send(json.dumps({"type": "display", "on": True, "pad": "x" * 4096}))
        with self.assertRaises(websockets.exceptions.ConnectionClosed):
            await asyncio.wait_for(ws.recv(), 2)

    async def test_a_newer_page_replaces_the_old_one(self):
        old, _ = await self.connect()
        new, _ = await self.connect()
        with self.assertRaises(websockets.exceptions.ConnectionClosed):
            await asyncio.wait_for(old.recv(), 2)
        self.assertEqual(old.close_code, 4000)
        self.clock.t = 30000
        await self.agent.on_score(0.9)
        self.assertEqual(
            json.loads(await asyncio.wait_for(new.recv(), 2))["type"], "wake"
        )
        await new.close()

    async def test_page_leaving_mid_reply_does_not_leave_the_wake_word_deaf(self):
        ws, _ = await self.connect()
        await ws.send('{"type":"speaking","on":true}')
        await ws.send('{"type":"media","on":true,"level":80}')
        await self.settle()
        await ws.close()
        await self.settle()
        self.assertFalse(self.agent.gate.speaking)
        self.assertFalse(self.agent.gate.media_on)


if __name__ == "__main__":
    unittest.main()


class MicLoopTests(unittest.IsolatedAsyncioTestCase):
    async def test_mic_chunks_flow_to_the_detector_and_the_reader_restarts(self):
        script = "import sys; sys.stdout.buffer.write(b'\\x01\\x00' * 1280 * 3)"
        cfg = load_config(overrides={"crow_origin": ORIGIN, "mic_cmd": [sys.executable, "-c", script]})

        class Det:
            def __init__(self):
                self.chunks = []

            def process(self, c):
                assert c.dtype.str == "<i2" and c.shape == (1280,)
                self.chunks.append(int(c[0]))
                return 0.0

        det = Det()
        agent = Agent(cfg, detector=det, backlight=Backlight("/nonexistent"))
        agent.loop = asyncio.get_running_loop()
        task = asyncio.create_task(agent.mic_loop())
        for _ in range(300):
            await asyncio.sleep(0.01)
            if len(det.chunks) >= 6:
                break
        agent.stopping = True
        task.cancel()
        self.assertGreaterEqual(len(det.chunks), 6, "3 chunks per run, and the reader was restarted")
        self.assertTrue(all(v == 1 for v in det.chunks))


@unittest.skipIf(websockets is None, "python websockets package not installed")
class WsBluetoothTests(unittest.IsolatedAsyncioTestCase):
    async def test_reconnect_button_round_trip_and_rate_limit(self):
        from test_bt import FakeCtl, MAC
        ctl = FakeCtl(connect_works=False)
        port = free_port()
        cfg = load_config(overrides={"crow_origin": ORIGIN, "listen_port": port, "bt_sink_mac": MAC})
        agent = Agent(cfg, detector=None, backlight=Backlight("/nonexistent"), bt_run=ctl)
        agent.loop = asyncio.get_running_loop()
        server = await websockets.serve(agent.handler, "127.0.0.1", port, origins=[ORIGIN], max_size=1024)
        try:
            ws = await websockets.connect(f"ws://127.0.0.1:{port}", origin=ORIGIN)
            status = json.loads(await asyncio.wait_for(ws.recv(), 2))
            self.assertEqual(status["bt"]["configured"], True)
            self.assertNotIn(MAC, json.dumps(status))
            await ws.send('{"type":"bt_reconnect","req":"a"}')
            r = json.loads(await asyncio.wait_for(ws.recv(), 3))
            self.assertEqual((r["type"], r["result"], r["req"]), ("bt_state", "failed", "a"))
            await ws.send('{"type":"bt_reconnect","req":"b"}')
            r = json.loads(await asyncio.wait_for(ws.recv(), 3))
            self.assertEqual((r["result"], r["req"]), ("rate_limited", "b"))
            await ws.send('{"type":"bt_reconnect","mac":"AA:AA:AA:AA:AA:AA"}')
            with self.assertRaises(websockets.exceptions.ConnectionClosed):
                await asyncio.wait_for(ws.recv(), 2)
            self.assertEqual(ws.close_code, 4400)
            self.assertTrue(all(c[1] == MAC for c in ctl.calls))
        finally:
            server.close()
            await server.wait_closed()

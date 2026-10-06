"""Page-link watchdog, helper supervision and audio back-pressure, backlight,
mic pinning (M3)."""
import asyncio
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _testenv  # noqa: E402,F401  (must come before config is imported)
from config import load_config, mic_command  # noqa: E402
from crow_kiosk_agent import Agent  # noqa: E402
from hw import Backlight  # noqa: E402
from watchdog import PageWatchdog  # noqa: E402

ORIGIN = "https://crow.example.ts.net:8444"


def _read(path):
    with open(path) as f:
        return f.read()


class WatchdogTests(unittest.TestCase):
    def test_no_page_after_start_restarts_with_backoff(self):
        w = PageWatchdog(0)
        self.assertEqual(w.check(119), set())
        self.assertEqual(w.check(120), {"restart"})
        self.assertEqual(w.check(120 + 239), set(), "next wait doubled to 240 s")
        self.assertEqual(w.check(120 + 240), {"restart"})
        for _ in range(10):
            w.check(w.since + w.wait_s)
        self.assertEqual(w.wait_s, 1800, "capped at 30 min")

    def test_page_gone_lights_after_10_s_and_restarts_after_60_s(self):
        w = PageWatchdog(0)
        w.page_connected(5)
        self.assertEqual(w.check(500), set())
        w.page_left(1000)
        self.assertEqual(w.check(1009), set())
        self.assertEqual(w.check(1010), {"light"})
        self.assertEqual(w.check(1059), set())
        self.assertEqual(w.check(1060), {"restart"})
        self.assertEqual(w.wait_s, 120, "a page that died is not a reason to back off")

    def test_page_back_in_time_cancels_and_healthy_resets_backoff(self):
        w = PageWatchdog(0)
        w.check(120)
        w.check(360)                         # two restarts: wait is now 480
        self.assertEqual(w.wait_s, 480)
        w.page_connected(400)
        w.page_left(400 + 600)               # stayed 10 min: healthy
        self.assertEqual(w.wait_s, 120)
        w.page_connected(1010)               # back within 60 s
        self.assertEqual(w.check(5000), set())


class ArmingTests(unittest.TestCase):
    def test_no_page_ever_and_no_marker_means_no_restart(self):
        w = PageWatchdog(0, armed=False)
        for t in range(0, 24 * 3600, 60):
            self.assertNotIn("restart", w.check(t), f"restart at {t}s before any page connected")
        self.assertEqual(w.restarts, 0)

    def test_first_connection_arms_it(self):
        w = PageWatchdog(0, armed=False)
        w.page_connected(10)
        w.page_left(20)
        self.assertEqual(w.check(80), {"light", "restart"})
        self.assertEqual(w.check(80 + 120), {"restart"}, "armed now: a page that never returns is restarted")


class FakeBacklightDir:
    def __init__(self, bl_power="0", brightness="200"):
        self.d = tempfile.TemporaryDirectory()
        for n, v in (("bl_power", bl_power), ("brightness", brightness), ("max_brightness", "255")):
            with open(os.path.join(self.d.name, n), "w") as f:
                f.write(v)

    def path(self, n):
        return os.path.join(self.d.name, n)


class BacklightTests(unittest.TestCase):
    def test_read_takes_the_real_state(self):
        fb = FakeBacklightDir(bl_power="4")
        b = Backlight(fb.d.name)
        self.assertFalse(b.read())
        fb.d.cleanup()

    def test_brightness_fallback_restores_the_previous_value(self):
        fb = FakeBacklightDir(brightness="120")
        os.remove(fb.path("bl_power"))
        os.mkdir(fb.path("bl_power"))
        b = Backlight(fb.d.name)
        b.set(False)
        self.assertEqual(_read(fb.path("brightness")), "0")
        b.set(True)
        self.assertEqual(_read(fb.path("brightness")), "120")
        fb.d.cleanup()


class MicTargetTests(unittest.TestCase):
    def test_target_is_inserted_before_the_output_dash(self):
        cfg = load_config(overrides={"crow_origin": ORIGIN, "mic_target": "alsa_input.usb-046d_0825-02.mono-fallback"})
        cmd = mic_command(cfg)
        self.assertEqual(cmd[-3:], ["--target", "alsa_input.usb-046d_0825-02.mono-fallback", "-"])
        self.assertNotIn("--target", mic_command(load_config(overrides={"crow_origin": ORIGIN})))
        for bad in ("x; rm -rf /", "", "a b"):
            with self.assertRaises(ValueError):
                load_config(overrides={"crow_origin": ORIGIN, "mic_target": bad})


class AgentRobustnessTests(unittest.IsolatedAsyncioTestCase):
    def agent(self, **kw):
        cfg = load_config(overrides={"crow_origin": ORIGIN, **kw.pop("cfg", {})})
        a = Agent(cfg, backlight=kw.pop("backlight", Backlight("/nonexistent")), **kw)
        a.loop = asyncio.get_running_loop()
        return a

    async def test_one_failing_helper_does_not_stop_the_others(self):
        a = self.agent()
        runs = {"bad": 0, "good": 0}

        async def bad():
            runs["bad"] += 1
            raise PermissionError("evdev")

        async def good():
            while True:
                runs["good"] += 1
                await asyncio.sleep(0.01)
        t1 = asyncio.create_task(a.supervise("bad", bad, max_backoff_s=0.01))
        t2 = asyncio.create_task(a.supervise("good", good))
        with self.assertLogs("crow-kiosk-agent", level="ERROR"):
            await asyncio.sleep(1.2)
        a.stopping = True
        t1.cancel()
        t2.cancel()
        self.assertGreaterEqual(runs["bad"], 2, "the failing helper restarted")
        self.assertGreater(runs["good"], 20, "the healthy helper kept running")

    async def test_watchdog_tick_restarts_the_browser_and_lights_the_screen(self):
        fb = FakeBacklightDir(bl_power="4")
        calls = []

        async def restart():
            calls.append("restart")
        clock = {"t": 0}
        a = self.agent(backlight=Backlight(fb.d.name), clock=lambda: clock["t"] * 1000, restart_browser=restart)
        a.backlight.read()
        a.watchdog.page_connected(0)
        a.watchdog.page_left(100)
        clock["t"] = 110
        await a.watchdog_tick()
        self.assertEqual(_read(fb.path("bl_power")), "0", "fail bright")
        clock["t"] = 160
        await a.watchdog_tick()
        self.assertEqual(calls, ["restart"])
        fb.d.cleanup()

    async def test_agent_writes_the_marker_on_first_page_and_starts_unarmed_without_it(self):
        marker = os.path.join(os.environ["HOME"], ".local/state/crow-kiosk/page-seen")
        if os.path.exists(marker):
            os.remove(marker)
        a = self.agent()
        self.assertFalse(a.watchdog.armed)
        a.mark_page_seen()
        self.assertTrue(os.path.exists(marker))
        self.assertTrue(self.agent().watchdog.armed, "a later agent start is armed")
        os.remove(marker)

    async def test_a_dead_mic_reader_surfaces_to_the_supervisor(self):
        a = self.agent(cfg={"mic_cmd": ["/nonexistent/pw-record", "-"]})
        a.detector = object()
        with self.assertRaises(FileNotFoundError):
            await asyncio.wait_for(a.mic_loop(), 2)

    async def test_browser_restart_is_scoped_to_our_own_uid(self):
        import crow_kiosk_agent as m
        calls = []

        async def fake_exec(*args, **kw):
            calls.append(args)

            class P:
                returncode = 1

                async def wait(self):
                    return 1
            return P()
        orig = m.asyncio.create_subprocess_exec
        m.asyncio.create_subprocess_exec = fake_exec
        try:
            await m.end_chromium()
        finally:
            m.asyncio.create_subprocess_exec = orig
        self.assertEqual(calls[0], ("pkill", "-TERM", "-U", str(os.getuid()), "-x", "chromium"))

    async def test_lagging_inference_drops_old_audio_instead_of_falling_behind(self):
        script = "import sys; sys.stdout.buffer.write(b'\\x01\\x00' * 1280 * 40)"
        a = self.agent(cfg={"mic_cmd": [sys.executable, "-c", script]})

        class SlowDet:
            n = 0

            def process(self, c):
                import time
                time.sleep(0.02)
                SlowDet.n += 1
                return 0.0
        a.detector = SlowDet()
        task = asyncio.create_task(a.mic_loop())
        await asyncio.sleep(0.6)
        a.stopping = True
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        self.assertGreater(a.stats["dropped"], 0)
        self.assertLess(SlowDet.n, 40)


if __name__ == "__main__":
    unittest.main()

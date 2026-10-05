"""BtSpeaker with a fake bluetoothctl and a fake PipeWire sink check."""

import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _testenv  # noqa: E402,F401  (must come before config is imported)
import bt  # noqa: E402
from bt import BtSpeaker, parse_bt_name, sink_listed  # noqa: E402

MAC = "00:11:22:AA:BB:CC"


def info(paired=True, connected=False, name="Kitchen speaker"):
    return (
        f"Device {MAC} (public)\n\tName: {name}\n\tAlias: {name}\n\tPaired: {'yes' if paired else 'no'}\n"
        f"\tTrusted: yes\n\tConnected: {'yes' if connected else 'no'}\n"
    )


class FakeCtl:
    """Simulates bluetoothctl; fails the test on any other command, MAC or an unbounded call."""

    def __init__(
        self,
        paired=True,
        connected=False,
        connect_works=True,
        info_delay=0.0,
        connect_delay=0.0,
    ):
        self.paired, self.connected, self.connect_works = (
            paired,
            connected,
            connect_works,
        )
        self.info_delay, self.connect_delay = info_delay, connect_delay
        self.calls = []
        self.active_connects = 0
        self.max_active_connects = 0

    async def __call__(self, *args, timeout=5):
        self.calls.append(args)
        assert args[0] in ("info", "connect"), (
            f"only info/connect are allowed, got {args}"
        )
        assert args[1] == MAC, "only the configured MAC is ever used"
        assert timeout <= 15, "every call is bounded"
        if args[0] == "connect":
            self.active_connects += 1
            self.max_active_connects = max(
                self.max_active_connects, self.active_connects
            )
            try:
                await asyncio.sleep(self.connect_delay)
            finally:
                self.active_connects -= 1
            if self.connect_works and self.paired:
                self.connected = True
            return "Attempting to connect\n"
        await asyncio.sleep(self.info_delay)
        if self.hang_info:
            return None              # what run_bluetoothctl returns on a timeout
        return info(self.paired, self.connected)

    hang_info = False

    def connects(self):
        return sum(1 for c in self.calls if c[0] == "connect")


class Sink:
    def __init__(self, ctl, works=True):
        self.ctl, self.works = ctl, works

    async def __call__(self, mac):
        assert mac == MAC
        return self.works and self.ctl.connected


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


class BtTests(unittest.IsolatedAsyncioTestCase):
    def mk(self, ctl, sink_works=True, **kw):
        self.pushed = []

        async def on_state(s):
            self.pushed.append(dict(s))

        self.clock = Clock()
        return BtSpeaker(
            MAC,
            run=ctl,
            sink_present=Sink(ctl, sink_works),
            clock=self.clock,
            on_state=on_state,
            **kw,
        )

    async def test_button_connects_and_reports_once_without_the_mac(self):
        ctl = FakeCtl()
        sp = self.mk(ctl)
        r = await sp.reconnect_now()
        self.assertEqual(
            (r["result"], r["connected"], r["name"]), ("ok", True, "Kitchen speaker")
        )
        self.assertEqual([c[0] for c in ctl.calls], ["info", "connect", "info"])
        self.assertEqual(len(self.pushed), 1)
        self.assertNotIn(MAC, repr(self.pushed) + repr(r))

    async def test_link_without_a_pipewire_sink_counts_as_disconnected(self):
        ctl = FakeCtl(connected=True)
        sp = self.mk(ctl, sink_works=False)
        r = await sp.reconnect_now()
        self.assertEqual(
            (r["result"], r["connected"], r["link"]), ("failed", False, True)
        )
        self.assertEqual(
            ctl.connects(),
            0,
            "the link is up; connecting again would not create a sink",
        )

    async def test_unpaired_speaker_is_never_connected_or_paired(self):
        ctl = FakeCtl(paired=False)
        sp = self.mk(ctl)
        self.assertEqual((await sp.reconnect_now())["result"], "not_paired")
        self.assertEqual(ctl.connects(), 0)

    async def test_manual_results_and_rate_limit(self):
        ctl = FakeCtl(connect_works=False)
        sp = self.mk(ctl, manual_min_interval_s=15)
        self.assertEqual((await sp.reconnect_now())["result"], "failed")
        self.clock.t = 10
        n = len(ctl.calls)
        self.assertEqual((await sp.reconnect_now())["result"], "rate_limited")
        self.assertEqual(n, len(ctl.calls), "a rate-limited request runs no command")
        ctl.connect_works = True
        self.clock.t = 16
        self.assertEqual((await sp.reconnect_now())["result"], "ok")

    async def test_not_configured(self):
        sp = BtSpeaker(None, run=FakeCtl())
        self.assertEqual((await sp.reconnect_now())["result"], "not_configured")
        await sp.loop()

    async def test_manual_press_during_a_background_info_never_overlaps(
        self,
    ):
        # info 1 s, connect 3 s (scaled 1:20); a manual press 0.2 s into a background attempt.
        ctl = FakeCtl(connect_works=False, info_delay=0.05, connect_delay=0.15)
        sp = self.mk(ctl, manual_min_interval_s=0)
        sp.open_retry_window(0)
        bg = asyncio.create_task(sp.tick())
        await asyncio.sleep(0.01)  # background is inside its first `info`
        r = await sp.reconnect_now()
        self.assertEqual(r["result"], "busy")
        self.assertTrue(r["reconnecting"])
        await bg
        self.assertEqual(ctl.max_active_connects, 1)
        self.assertEqual(ctl.connects(), 1)
        self.assertFalse(sp.state()["reconnecting"])

    async def test_attempt_is_cut_off_at_the_deadline(self):
        ctl = FakeCtl(connect_works=False, connect_delay=1.0)
        sp = self.mk(ctl, deadline_s=0.05)
        r = await asyncio.wait_for(sp.reconnect_now(), 0.5)
        self.assertEqual(r["result"], "failed")
        self.assertFalse(sp.lock.locked())

    async def test_deadlines_nest(self):
        self.assertLessEqual(
            bt.INFO_TIMEOUT_S
            + bt.CONNECT_TIMEOUT_S
            + bt.REINFO_TIMEOUT_S
            + bt.SINK_TIMEOUT_S,
            bt.ATTEMPT_DEADLINE_S,
        )
        self.assertLess(
            bt.ATTEMPT_DEADLINE_S,
            30,
            "page btReconnect timeout is 30 s (agent-link.js)",
        )

    async def test_retry_window_after_boot_then_stop(self):
        ctl = FakeCtl(connect_works=False)
        sp = self.mk(ctl)
        sp.open_retry_window(0)
        times = []
        for t in range(0, 1200, 30):  # 40 ticks over 20 minutes
            self.clock.t = t
            before = ctl.connects()
            await sp.tick()
            if ctl.connects() > before:
                times.append(t)
        self.assertEqual(
            times,
            [0, 30, 90, 210, 450],
            "0, then gaps of 30/60/120/240 s, all inside 10 min",
        )

    async def test_watching_never_connects_outside_a_window_and_a_drop_opens_one(self):
        ctl = FakeCtl(connected=True)
        sp = self.mk(ctl)
        sp.open_retry_window(0)
        self.clock.t = 0
        await sp.tick()
        self.assertTrue(sp.connected)
        self.clock.t = 2000  # boot window long gone
        await sp.tick()
        ctl.connected = False  # the speaker drops (or a phone takes it)
        ctl.connect_works = False
        self.clock.t = 2030
        await sp.tick()  # observes the drop -> opens a window (no connect yet)
        self.assertFalse(sp.connected)
        self.assertEqual(self.pushed[-1]["connected"], False)
        connects = []
        for t in range(2060, 3500, 30):
            self.clock.t = t
            before = ctl.connects()
            await sp.tick()
            if ctl.connects() > before:
                connects.append(t)
        self.assertEqual(connects, [2060, 2090, 2150, 2270, 2510])
        self.assertTrue(all(t < 2030 + 600 for t in connects))

    async def test_speaker_coming_back_on_its_own_is_noticed_by_watching(self):
        ctl = FakeCtl(connect_works=False)
        sp = self.mk(ctl)
        self.clock.t = 5000  # no window open
        await sp.tick()
        self.assertEqual(ctl.connects(), 0)
        ctl.connected = True  # its own auto-connect
        self.clock.t = 5030
        await sp.tick()
        self.assertTrue(sp.connected)
        self.assertEqual(ctl.connects(), 0)

    async def test_a_hung_info_is_failed_not_not_paired_and_keeps_the_window(self):
        ctl = FakeCtl(connect_works=False)
        ctl.hang_info = True
        sp = self.mk(ctl)
        r = await sp.reconnect_now()
        self.assertEqual(r["result"], "failed", "a timeout must never tell the household the speaker is unpaired")
        sp.open_retry_window(0)
        for t in (0, 30, 60):
            self.clock.t = t
            await sp.tick()
        self.assertTrue(sp.in_retry_window(60), "slow bluetoothctl does not cancel the 10-minute window")
        self.assertEqual(sp.retry_step, 0, "an unanswered check is not a spent attempt")
        ctl.hang_info = False
        ctl.connect_works = True
        self.clock.t = 90
        await sp.tick()
        self.assertTrue(sp.connected, "the window still reconnects once bluetoothctl answers")

    async def test_real_not_available_is_not_paired(self):
        async def ctl(*args, timeout=5):
            return f"Device {MAC} not available\n"
        sp = BtSpeaker(MAC, run=ctl, sink_present=lambda m: asyncio.sleep(0, False), clock=lambda: 0)
        self.assertEqual((await sp.reconnect_now())["result"], "not_paired")

    async def test_run_bluetoothctl_timeout_returns_none(self):
        self.assertIsNone(await bt._run([sys.executable, "-c", "import time; time.sleep(5)"], 0.2))
        self.assertEqual(await bt._run([sys.executable, "-c", "print('hi')"], 5), "hi\n")

    async def test_the_window_opens_when_the_helper_starts_and_the_first_state_is_reported(self):
        ctl = FakeCtl(connect_works=False)
        sp = self.mk(ctl, check_s=0.01)
        self.clock.t = 50000                  # long after "boot"
        stop = []
        task = asyncio.create_task(sp.loop(lambda: bool(stop)))
        await asyncio.sleep(0.05)
        stop.append(1)
        await asyncio.wait_for(task, 1)
        self.assertGreaterEqual(ctl.connects(), 1, "the window is fresh when the helper starts")
        first = self.pushed[0]
        self.assertEqual((first["connected"], first["retry_window"]), (False, True))

    def test_sink_parsing_and_name(self):
        out = (
            "47\talsa_output.platform-3f00b840.mailbox.stereo-fallback\tPipeWire\ts16le 2ch 48000Hz\tSUSPENDED\n"
            "85\tbluez_output.00_11_22_AA_BB_CC.1\tPipeWire\ts16le 2ch 48000Hz\tRUNNING\n"
        )
        self.assertTrue(sink_listed(out, MAC))
        self.assertFalse(sink_listed(out, "00:11:22:AA:BB:CD"))
        self.assertFalse(sink_listed("", MAC))
        with self.assertRaises(ValueError):
            BtSpeaker("00:11:22:33:44:55; reboot")
        self.assertEqual(
            parse_bt_name("\tName: A\n\tAlias: Kitchen speaker\n"), "Kitchen speaker"
        )


if __name__ == "__main__":
    unittest.main()

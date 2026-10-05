"""Keeps the configured, already-paired Bluetooth speaker usable, without fighting the household's phones.

"Connected" means BOTH: bluetoothctl reports the link up AND PipeWire has the speaker's sink
(`bluez_output.<MAC_with_underscores>…`). A link without a sink is silence, so it counts as disconnected
(the page then holds captions).

- Watching: every `check_s` (30 s) one `info` + one sink check. Watching never connects.
- Background retry: only inside a window of `retry_window_s` (10 min) that opens at agent start and when
  the agent sees the speaker drop (connected -> not connected). Inside it, connect attempts at 0 s, then
  after gaps of 30, 60, 120 and 240 s; then it stops. After that, the speaker's own auto-connect (it
  reconnects to a remembered device when its Bluetooth comes on) and the Reconnect button cover the rest.
  A phone that took the speaker is therefore interrupted at most 5 times, all within 10 minutes of a drop.
- Manual reconnect (page button, or the Kiosk panel through the page): one attempt now, at most one per
  `manual_min_interval_s` (15 s), refused with `busy` while any attempt or check runs.
- One asyncio.Lock covers every attempt and check, so background and manual work never overlap.
- Every attempt (info <= 5 s, connect <= 15 s, info <= 3 s, sink check <= 2 s) is also cut off as a whole
  at ATTEMPT_DEADLINE_S = 25 s. The page waits 30 s for an answer and the server 35 s, so an answer always
  arrives before either gives up (a test checks this ordering).
- Only `bluetoothctl info|connect <the MAC from agent.json>`; nothing scans, pairs, trusts or removes. The
  MAC never leaves the Pi: bt_state carries the speaker's name only.
`run(*args, timeout)`, `sink_present(mac)` and `clock()` are injected so the logic is tested without
bluetoothctl or PipeWire.
"""

import asyncio
import re

from hw import parse_bt_info, valid_mac

INFO_TIMEOUT_S = 5
CONNECT_TIMEOUT_S = 15
REINFO_TIMEOUT_S = 3
SINK_TIMEOUT_S = 2
ATTEMPT_DEADLINE_S = (
    25  # < the page's btReconnect timeout (30 s) < the server relay (35 s)
)
RESULTS = ("ok", "failed", "busy", "rate_limited", "not_paired", "not_configured")


def parse_bt_name(text):
    for field in ("Alias", "Name"):
        m = re.search(rf"^\s*{field}:\s*(.+?)\s*$", text, re.M)
        if m:
            return m.group(1)[:64]
    return None


async def _run(cmd, timeout):
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return None            # timed out: the answer is unknown (never read as "not paired")
    return out.decode("utf-8", "replace")


async def run_bluetoothctl(*args, timeout=INFO_TIMEOUT_S):
    return await _run(["bluetoothctl", *args], timeout)


def sink_name_prefix(mac):
    return "bluez_output." + mac.upper().replace(":", "_")


def sink_listed(pactl_short_sinks, mac):
    prefix = sink_name_prefix(mac)
    return any(
        len(cols) > 1 and cols[1].startswith(prefix)
        for cols in (line.split("\t") for line in pactl_short_sinks.splitlines())
    )


async def pipewire_sink_present(mac):
    return sink_listed(
        await _run(["pactl", "list", "short", "sinks"], SINK_TIMEOUT_S), mac
    )


class BtSpeaker:
    def __init__(
        self,
        mac,
        run=run_bluetoothctl,
        sink_present=pipewire_sink_present,
        clock=None,
        on_state=None,
        manual_min_interval_s=15,
        check_s=30,
        retry_window_s=600,
        retry_gaps_s=(30, 60, 120, 240),
        deadline_s=ATTEMPT_DEADLINE_S,
    ):
        if mac is not None and not valid_mac(mac):
            raise ValueError("bad MAC")
        self.mac = mac.upper() if mac else None
        self.run = run
        self.sink_present = sink_present
        self.clock = clock or (lambda: asyncio.get_running_loop().time())
        self.on_state = on_state
        self.manual_min_interval_s = manual_min_interval_s
        self.check_s = check_s
        self.retry_window_s = retry_window_s
        self.retry_gaps_s = tuple(retry_gaps_s)
        self.deadline_s = deadline_s
        self.lock = asyncio.Lock()
        self.connected = False
        self.link = False
        self.name = None
        self.last_manual = None
        self.retry_until = None
        self.retry_step = 0
        self.next_connect_at = None
        self.connect_calls = 0

    # ---- state -----------------------------------------------------------------------------------
    def state(self, result=None):
        s = {
            "type": "bt_state",
            "configured": self.mac is not None,
            "connected": self.connected,
            "link": self.link,
            "name": self.name,
            "reconnecting": self.lock.locked(),
        }
        if result:
            s["result"] = result
        return s

    async def _publish(self, result=None):
        if self.on_state:
            await self.on_state(self.state(result))

    def open_retry_window(self, now):
        self.retry_until = now + self.retry_window_s
        self.retry_step = 0
        self.next_connect_at = now

    def in_retry_window(self, now):
        return (
            self.retry_until is not None
            and now < self.retry_until
            and self.next_connect_at is not None
        )

    # ---- one observation / attempt (callers hold the lock) ---------------------------------------
    async def _observe(self, timeout=INFO_TIMEOUT_S):
        """(info, sink), or (None, False) when bluetoothctl did not answer (timeout / no output)."""
        text = await self.run("info", self.mac, timeout=timeout)
        if not text:
            return None, False
        info = parse_bt_info(text)
        self.name = parse_bt_name(text) or self.name
        sink = bool(info["connected"]) and await self.sink_present(self.mac)
        return info, sink

    async def _apply(self, info, sink):
        was = self.connected
        self.link = bool(info["connected"])
        self.connected = self.link and sink
        if was and not self.connected:
            self.open_retry_window(
                self.clock()
            )  # a drop: retry for the next 10 minutes
        if was != self.connected:
            await self._publish()

    async def _attempt(self, connect=True):
        info, sink = await self._observe()
        if info is None:
            return None                       # unknown: change nothing
        if not info["connected"] and info["paired"] and connect:
            self.connect_calls += 1
            await self.run("connect", self.mac, timeout=CONNECT_TIMEOUT_S)
            info, sink = await self._observe(REINFO_TIMEOUT_S)
            if info is None:
                return None
        await self._apply(info, sink)
        return info

    async def _bounded(self, connect):
        try:
            return await asyncio.wait_for(self._attempt(connect), self.deadline_s)
        except asyncio.TimeoutError:
            return None

    # ---- the button --------------------------------------------------------------------------------
    async def reconnect_now(self):
        """Returns the bt_state dict with a result (the caller sends it to the page)."""
        if self.mac is None:
            return self.state("not_configured")
        if self.lock.locked():
            return self.state("busy")
        now = self.clock()
        if (
            self.last_manual is not None
            and now - self.last_manual < self.manual_min_interval_s
        ):
            return self.state("rate_limited")
        self.last_manual = now
        async with self.lock:
            info = await self._bounded(connect=True)
        if self.connected:
            return self.state("ok")
        if info is not None and not info["paired"]:
            return self.state("not_paired")
        return self.state("failed")

    # ---- background --------------------------------------------------------------------------------
    async def tick(self):
        """One watch step: observe, and connect only if the retry window says so. Skipped while busy."""
        if self.mac is None or self.lock.locked():
            return
        now = self.clock()
        want = (
            (not self.connected)
            and self.in_retry_window(now)
            and now >= self.next_connect_at
        )
        async with self.lock:
            info = await self._bounded(connect=want)
        if info is None:
            return          # bluetoothctl did not answer: keep the schedule; the next tick tries again
        if want and not self.connected:
            if self.retry_step < len(self.retry_gaps_s):
                self.next_connect_at = self.clock() + self.retry_gaps_s[self.retry_step]
                self.retry_step += 1
            else:
                self.next_connect_at = (
                    None  # window spent: wait for the speaker or the button
                )
        if not info["paired"]:
            self.next_connect_at = None       # a real "Paired: no" / "not available"

    async def loop(self, stopping=lambda: False):
        if self.mac is None:
            return
        # The window opens when this helper starts (not at boot), so an agent that crash-looped earlier
        # still gets its full 10 minutes once it runs.
        self.open_retry_window(self.clock())
        first = True
        while not stopping():
            await self.tick()
            if first:
                first = False
                if self.on_state:      # always report the starting state once (a log line on the Pi)
                    st = self.state()
                    st["retry_window"] = self.in_retry_window(self.clock())
                    await self.on_state(st)
            await asyncio.sleep(self.check_s)

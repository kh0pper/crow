#!/usr/bin/env python3
"""crow-kiosk-agent: the Pi-side helper of the Crow kiosk (wake word, backlight, touch-while-dark,
Bluetooth speaker, page-link watchdog) with a local WebSocket on 127.0.0.1:8770 for the kiosk page.

Runs as a systemd *user* service of the `kiosk` user, inside the same session as PipeWire, so it can
read the microphone through PipeWire (pw-record) while Chromium also captures it.
Dependencies are Debian packages only: python3-numpy, python3-onnxruntime, python3-websockets.

Fault isolation: each helper (mic, touch, Bluetooth, watchdog) runs under its own supervisor; an
exception in one is logged and that helper alone restarts with backoff. The socket keeps serving.
Security note: any local process can open the socket with a forged Origin (browsers cannot). On the Pi
only root, the admin user and kiosk run processes, so that adds no access; it is accepted.
"""

import argparse
import asyncio
import logging
import os
import signal
import sys
import time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import protocol  # noqa: E402
from bt import BtSpeaker, pipewire_sink_present, run_bluetoothctl  # noqa: E402
from config import load_config, mic_command  # noqa: E402
from hw import Backlight, find_input_device, read_touch_downs  # noqa: E402
from wakegate import WakeGate  # noqa: E402
from watchdog import PageWatchdog  # noqa: E402

log = logging.getLogger("crow-kiosk-agent")
CHUNK_BYTES = 1280 * 2
MAX_QUEUED_CHUNKS = (
    3  # > 240 ms behind real time: drop the oldest audio rather than lag further
)


def now_ms():
    return time.monotonic() * 1000


def _origin_of(ws):
    req = getattr(ws, "request", None)  # websockets >= 13 (new asyncio implementation)
    if req is not None and getattr(req, "headers", None) is not None:
        return req.headers.get("Origin")
    return ws.request_headers.get("Origin")  # websockets legacy implementation (10.x)


async def end_chromium():
    """Ends the kiosk browser (own user's processes only). cage exits with it and systemd restarts cage."""
    for sig, wait in (("TERM", 10), ("KILL", 0)):
        p = await asyncio.create_subprocess_exec("pkill", f"-{sig}", "-U", str(os.getuid()), "-x", "chromium")
        await p.wait()
        if p.returncode != 0:  # nothing left to signal
            return
        await asyncio.sleep(wait)


class Agent:
    def __init__(
        self,
        cfg,
        detector=None,
        backlight=None,
        clock=now_ms,
        bt_run=run_bluetoothctl,
        bt_sink_present=pipewire_sink_present,
        restart_browser=end_chromium,
    ):
        self.cfg = cfg
        self.detector = detector
        self.backlight = (
            backlight if backlight is not None else Backlight(cfg["backlight"])
        )
        self.clock = clock
        self.gate = WakeGate(
            cfg["wake_threshold"],
            cfg["media_threshold"],
            cfg["speaking_tail_ms"],
            cfg["refractory_ms"],
        )
        self.client = None
        self.loop = None
        self.stopping = False
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="wake")
        self.bt = BtSpeaker(
            cfg["bt_sink_mac"],
            run=bt_run,
            sink_present=bt_sink_present,
            on_state=self._push_bt_state,
        )
        self.page_marker = cfg["page_seen_marker"]
        self.watchdog = PageWatchdog(self.clock() / 1000, armed=os.path.exists(self.page_marker))
        self.restart_browser = restart_browser
        self.tasks = set()  # strong refs to fire-and-forget tasks
        self.stats = {"chunks": 0, "dropped": 0, "infer_ms": 0.0}

    def spawn(self, coro):
        t = asyncio.ensure_future(coro)
        self.tasks.add(t)
        t.add_done_callback(self.tasks.discard)
        return t

    # ---- page socket -------------------------------------------------------------------------
    async def send(self, text):
        ws = self.client
        if ws is None:
            return False
        try:
            await ws.send(text)
            return True
        except Exception:  # noqa: BLE001 - a closed socket is normal here
            return False

    async def handler(self, ws, _path=None):
        if not protocol.origin_allowed(_origin_of(ws), self.cfg["crow_origin"]):
            await ws.close(4403, "origin")  # normally refused earlier, at the handshake
            return
        old, self.client = self.client, ws
        if old is not None:
            await old.close(4000, "replaced by a newer page")
        self.watchdog.page_connected(self.clock() / 1000)
        self.mark_page_seen()
        await ws.send(
            protocol.agent_status(
                os.path.basename(self.cfg["wake_model"]),
                self.detector is not None,
                self.bt.state(),
            )
        )
        try:
            async for raw in ws:
                try:
                    msg = protocol.parse_page_message(raw)
                except protocol.ProtocolError as e:
                    log.warning("refused page frame: %s", e)
                    await ws.close(4400, "protocol")
                    return
                if msg["type"] == "bt_reconnect":
                    self.spawn(
                        self.bt_reconnect(msg.get("req"))
                    )  # answered when the attempt ends
                else:
                    self.apply(msg)
        except Exception as e:  # noqa: BLE001
            if not type(e).__name__.startswith(
                "ConnectionClosed"
            ):  # a page going away is normal
                raise
        finally:
            if self.client is ws:
                self.client = None
                self.watchdog.page_left(self.clock() / 1000)
                # A page that went away cannot leave the wake word deaf or the media threshold up.
                self.gate.set_speaking(False, self.clock())
                self.gate.set_media(False)

    def mark_page_seen(self):
        if os.path.exists(self.page_marker):
            return
        try:
            os.makedirs(os.path.dirname(self.page_marker), exist_ok=True)
            with open(self.page_marker, "w") as f:
                f.write("a kiosk page has connected to this agent; the page watchdog is armed\n")
        except OSError as e:
            log.warning("cannot write %s: %s", self.page_marker, e)

    def apply(self, msg):
        t = msg["type"]
        if t == "display":
            self.backlight.set(msg["on"])
        elif t == "speaking":
            self.gate.set_speaking(msg["on"], self.clock())
        elif t == "media":
            self.gate.set_media(msg["on"])

    async def _push_bt_state(self, state):
        log.info(
            "speaker: %s",
            "connected"
            if state["connected"]
            else ("link up, no audio sink" if state.get("link") else "away"),
        )
        await self.send(protocol.bt_state_msg(state))

    async def bt_reconnect(self, req=None):
        state = await self.bt.reconnect_now()
        log.info("manual speaker reconnect: %s", state.get("result"))
        await self.send(protocol.bt_state_msg(state, req))

    # ---- events from the hardware ------------------------------------------------------------
    async def on_score(self, score):
        if not self.gate.offer(score, self.clock()):
            return
        log.info("wake (score %.3f)", score)
        if not self.backlight.on:
            self.backlight.set(
                True
            )  # light the screen at once; the page catches up with display {on}
        await self.send(protocol.wake_msg(score))

    async def on_touch_down(self):
        if self.backlight.on:
            return
        self.backlight.set(True)
        await self.send(
            protocol.touch_while_dark_msg()
        )  # informational: the page swallows the tap itself

    # ---- helpers -----------------------------------------------------------------------------
    async def supervise(self, name, fn, max_backoff_s=60):
        """Run fn() until stopping; an exception restarts only this helper, with backoff."""
        delay = 1
        while not self.stopping:
            started = time.monotonic()
            try:
                await fn()
                return  # a helper that returns normally is finished (e.g. no touch device)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.exception("%s helper failed; restarting in %ss", name, delay)
            if time.monotonic() - started > 300:
                delay = 1
            await asyncio.sleep(delay)
            delay = min(max_backoff_s, delay * 2)

    async def mic_reader(self, queue):
        """pw-record -> 80 ms chunks -> bounded queue (oldest dropped when inference falls behind)."""
        import numpy as np

        delay = 1
        while not self.stopping:
            proc = await asyncio.create_subprocess_exec(
                *mic_command(self.cfg),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            started = time.monotonic()
            try:
                while True:
                    buf = await proc.stdout.readexactly(CHUNK_BYTES)
                    if queue.full():
                        queue.get_nowait()
                        self.stats["dropped"] += 1
                    queue.put_nowait(np.frombuffer(buf, dtype="<i2"))
            except asyncio.IncompleteReadError:
                pass
            finally:
                if proc.returncode is None:
                    proc.kill()
                await proc.wait()
            if self.stopping:
                return
            delay = 1 if time.monotonic() - started > 60 else min(30, delay * 2)
            log.warning(
                "microphone reader exited (rc=%s); restarting in %ss",
                proc.returncode,
                delay,
            )
            await asyncio.sleep(delay)

    async def mic_loop(self):
        queue = asyncio.Queue(maxsize=MAX_QUEUED_CHUNKS)
        reader = self.spawn(self.mic_reader(queue))
        try:
            while not self.stopping:
                getter = asyncio.ensure_future(queue.get())
                done, _ = await asyncio.wait({reader, getter}, return_when=asyncio.FIRST_COMPLETED)
                if reader in done:
                    getter.cancel()
                    reader.result()          # re-raises the reader's error -> supervise() restarts "wake"
                    return
                chunk = getter.result()
                t0 = time.monotonic()
                score = await self.loop.run_in_executor(
                    self.pool, self.detector.process, chunk
                )
                self.stats["chunks"] += 1
                self.stats["infer_ms"] += (time.monotonic() - t0) * 1000
                await self.on_score(score)
        finally:
            reader.cancel()

    async def stats_loop(self, every_s=300):
        while not self.stopping:
            await asyncio.sleep(every_s)
            n = self.stats["chunks"]
            log.info(
                "wake: %d chunks, %d dropped, %.1f ms/chunk",
                n,
                self.stats["dropped"],
                self.stats["infer_ms"] / n if n else 0.0,
            )
            self.stats = {"chunks": 0, "dropped": 0, "infer_ms": 0.0}

    async def touch_loop(self):
        path = find_input_device(self.cfg["touch_name"])
        if not path:
            log.warning(
                "no touch device matching %r; touch-while-dark disabled",
                self.cfg["touch_name"],
            )
            return

        def down():
            self.loop.call_soon_threadsafe(lambda: self.spawn(self.on_touch_down()))

        await asyncio.to_thread(read_touch_downs, path, down, lambda: self.stopping)

    async def watchdog_tick(self):
        actions = self.watchdog.check(self.clock() / 1000)
        if "light" in actions and not self.backlight.on:
            log.warning("page gone; backlight on")
            self.backlight.set(True)
        if "restart" in actions:
            log.warning(
                "page not connected (restart #%d); restarting the browser",
                self.watchdog.restarts,
            )
            await self.restart_browser()

    async def watchdog_loop(self, every_s=5):
        while not self.stopping:
            await self.watchdog_tick()
            await asyncio.sleep(every_s)

    def fail_bright(self, *_):
        self.backlight.set(True)

    async def run(self):
        import websockets

        self.loop = asyncio.get_running_loop()
        self.backlight.read()
        for sig in (signal.SIGTERM, signal.SIGINT):
            self.loop.add_signal_handler(
                sig, lambda: (self.fail_bright(), self.loop.stop())
            )
        helpers = [
            ("touch", self.touch_loop),
            ("bluetooth", lambda: self.bt.loop(lambda: self.stopping)),
            ("watchdog", self.watchdog_loop),
        ]
        if self.detector is not None:
            helpers += [("wake", self.mic_loop), ("stats", self.stats_loop)]
        for name, fn in helpers:
            self.spawn(self.supervise(name, fn))
        async with websockets.serve(
            self.handler,
            self.cfg["listen_host"],
            self.cfg["listen_port"],
            origins=[self.cfg["crow_origin"]],
            max_size=protocol.MAX_FRAME_BYTES,
        ):
            log.info(
                "listening on ws://%s:%s for %s",
                self.cfg["listen_host"],
                self.cfg["listen_port"],
                self.cfg["crow_origin"],
            )
            await asyncio.Future()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--config", default="/etc/crow-kiosk/agent.json")
    ap.add_argument(
        "--no-wake", action="store_true", help="run without the wake word (tap only)"
    )
    args = ap.parse_args(argv)
    try:  # so the memory sampler (and ps) can tell the agent from other python3 processes
        with open("/proc/self/comm", "w") as f:
            f.write("crow-kiosk-agent"[:15])
    except OSError:
        pass
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    cfg = load_config(args.config)
    detector = None
    if not args.no_wake:
        try:
            from oww_lite import load_detector

            detector = load_detector(
                cfg["mel_model"], cfg["embedding_model"], cfg["wake_model"]
            )
        except Exception as e:  # noqa: BLE001 - tap keeps working without a wake model
            log.error("wake word unavailable (%s); running tap-only", e)
    agent = Agent(cfg, detector)
    try:
        asyncio.run(agent.run())
    except RuntimeError:
        pass  # loop stopped by SIGTERM
    finally:
        agent.fail_bright()


if __name__ == "__main__":
    main()

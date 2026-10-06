#!/usr/bin/env python3
"""Bench: acoustic output latency of the current PipeWire sink (e.g. a Bluetooth speaker), as heard by the mic.

Run as the kiosk user on the Pi, with the speaker where it will live:
  sudo -u kiosk XDG_RUNTIME_DIR=/run/user/$(id -u kiosk) python3 bench_latency.py [--clicks 5]

It starts pw-record on the default source, then plays clicks on the default sink with pw-play, and
reports the delay from each pw-play start to the click's arrival at the mic. The median sets the
agent's speaking_tail_ms (median + 300 ms margin) and is recorded with the bench results.
Process start-up of pw-play adds a few ms; the number is an upper bound, which is the safe side here.
"""

import argparse
import os
import subprocess
import sys
import tempfile
import time
import wave

import numpy as np

RATE = 16000


def click_wav(path, ms=30):
    n = int(RATE * ms / 1000)
    t = np.arange(n) / RATE
    tone = (0.8 * 32767 * np.sin(2 * np.pi * 2000 * t) * np.hanning(n)).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(tone.tobytes())


def onset(samples, start, rate=RATE, factor=8.0, window_ms=5):
    """Index (from `start`) of the first window whose RMS exceeds `factor` x the noise floor before it."""
    x = samples.astype(np.float64)
    w = max(1, int(rate * window_ms / 1000))
    floor_seg = x[max(0, start - rate // 2) : start]
    floor = np.sqrt(np.mean(floor_seg**2)) if floor_seg.size else 1.0
    floor = max(floor, 20.0)
    for i in range(start, len(x) - w, w):
        if np.sqrt(np.mean(x[i : i + w] ** 2)) > factor * floor:
            return i - start
    return None


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--clicks", type=int, default=5)
    ap.add_argument("--gap", type=float, default=1.5)
    a = ap.parse_args(argv)
    with tempfile.TemporaryDirectory() as d:
        click, rec = os.path.join(d, "click.wav"), os.path.join(d, "rec.raw")
        click_wav(click)
        recorder = subprocess.Popen(
            [
                "pw-record",
                "--raw",
                "--rate",
                str(RATE),
                "--channels",
                "1",
                "--format",
                "s16",
                rec,
            ]
        )
        time.sleep(1.0)
        t0 = time.monotonic()
        starts = []
        for _ in range(a.clicks):
            starts.append(time.monotonic() - t0)
            subprocess.run(["pw-play", click], check=True)
            time.sleep(a.gap)
        recorder.terminate()
        recorder.wait()
        data = np.fromfile(rec, dtype="<i2")
    # The recorder ran ~1.0 s before t0; align by that lead (an approximation of a few ms).
    lead = int(RATE * 1.0)
    delays = []
    for s in starts:
        idx = lead + int(s * RATE)
        o = onset(data, idx)
        delays.append(None if o is None else 1000.0 * o / RATE)
    found = [x for x in delays if x is not None]
    print("delays_ms:", ["-" if x is None else round(x) for x in delays])
    if not found:
        print("no click heard: check the sink and the mic", file=sys.stderr)
        return 1
    med = float(np.median(found))
    print(f"median_ms: {med:.0f}   suggested speaking_tail_ms: {int(med + 300)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

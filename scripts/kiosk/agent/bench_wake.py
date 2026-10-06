#!/usr/bin/env python3
"""Bench: wake-word compute per 80 ms chunk on this machine, for each threads x step setting.

Run on the Pi with the agent's interpreter (stop the agent first so it does not compete for the CPU):
  /opt/crow-kiosk/venv/bin/python bench_wake.py [--seconds 30] [--models /var/lib/crow-kiosk/wake]

Real time is 80 ms per chunk. A setting passes when its mean is <= 70 ms/chunk (headroom for Chromium);
put the cheapest passing one in agent.json as wake_threads / wake_step (pi-setup --wake-threads/--wake-step).
"""

import argparse
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oww_lite import CHUNK, load_detector  # noqa: E402

BUDGET_MS = 70.0


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=30)
    ap.add_argument("--models", default="/var/lib/crow-kiosk/wake")
    ap.add_argument("--wake-model", default="hey_jarvis_v0.1.onnx")
    a = ap.parse_args(argv)
    m = lambda n: os.path.join(a.models, n)
    n_chunks = int(a.seconds * 1000 / 80)
    audio = np.random.default_rng(0).normal(0, 800, n_chunks * CHUNK).astype(np.int16)
    chunks = [audio[i * CHUNK : (i + 1) * CHUNK] for i in range(n_chunks)]
    best = None
    print(f"{'threads':>7} {'step':>4} {'ms/chunk':>9}  verdict")
    for threads in (1, 2, 3, 4):
        for step in (1, 2, 3):
            det = load_detector(
                m("melspectrogram.onnx"),
                m("embedding_model.onnx"),
                m(a.wake_model),
                threads=threads,
            )
            for c in chunks[:30]:  # warm-up, as the agent would be after start
                det.process(c)
            t0 = time.perf_counter()
            for i in range(30, n_chunks - step + 1, step):
                det.process_many(chunks[i : i + step])
            done = (n_chunks - 30) // step * step
            ms = (time.perf_counter() - t0) * 1000 / max(done, 1)
            ok = ms <= BUDGET_MS
            print(f"{threads:>7} {step:>4} {ms:>9.1f}  {'ok' if ok else 'too slow'}")
            if ok and (best is None or (step, threads) < (best[1], best[0])):
                best = (threads, step, ms)
    if best:
        print(
            f"suggested: wake_threads={best[0]} wake_step={best[1]} ({best[2]:.1f} ms/chunk)"
        )
        return 0
    print(
        "no setting fits the budget: see the plan's optimisation path (smaller/cheaper model)",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())

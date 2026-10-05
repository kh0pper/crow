"""Window logic of oww_lite with fake ONNX sessions (no onnxruntime needed)."""

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _testenv  # noqa: E402,F401  (must come before config is imported)
from oww_lite import CHUNK, MEL_CONTEXT, MEL_WINDOW, WakeDetector  # noqa: E402


class _In:
    def __init__(self, name, shape):
        self.name, self.shape = name, shape


class FakeMel:
    """Mimics melspectrogram.onnx: (1, n) float32 -> (1, 1, ceil(n/160 - 3), 32)."""

    def __init__(self):
        self.calls = []

    def get_inputs(self):
        return [_In("input", [1, "samples"])]

    def run(self, _out, feeds):
        x = feeds["input"]
        assert x.dtype == np.float32 and x.ndim == 2
        self.calls.append(x.shape[1])
        frames = int(np.ceil(x.shape[1] / 160 - 3))
        return [np.full((1, 1, frames, 32), float(x[0, -1]) * 10, dtype=np.float32)]


class FakeEmb:
    def __init__(self):
        self.shapes = []

    def get_inputs(self):
        return [_In("input_1", ["batch", 76, 32, 1])]

    def run(self, _out, feeds):
        x = feeds["input_1"]
        self.shapes.append(x.shape)
        return [np.full((1, 1, 1, 96), x[0, -1, 0, 0], dtype=np.float32)]


class FakeWake:
    def __init__(self, n=16):
        self.n = n
        self.inputs = []

    def get_inputs(self):
        return [_In("x.1", [1, self.n, 96])]

    def run(self, _out, feeds):
        x = feeds["x.1"]
        self.inputs.append(x.copy())
        return [np.array([[min(1.0, float(x[0, -1, 0]) / 100)]], dtype=np.float32)]


def chunk(value):
    return np.full(CHUNK, value, dtype=np.int16)


class OwwLiteTests(unittest.TestCase):
    def setUp(self):
        self.mel, self.emb, self.wake = FakeMel(), FakeEmb(), FakeWake()
        self.det = WakeDetector(self.mel, self.emb, self.wake)

    def test_mel_sees_1280_plus_480_samples_and_yields_8_frames(self):
        self.det.process(chunk(1))
        self.assertEqual(self.mel.calls, [], "first chunk: not enough context yet")
        self.det.process(chunk(2))
        self.assertEqual(self.mel.calls, [CHUNK + MEL_CONTEXT])
        self.assertEqual(self.det.mel_buf.shape, (MEL_WINDOW + 8, 32))

    def test_mel_transform_is_spec_over_10_plus_2(self):
        self.det.process(chunk(3))
        self.det.process(chunk(3))
        # FakeMel returns last_sample*10 = 30 -> 30/10 + 2 = 5
        self.assertTrue(np.allclose(self.det.mel_buf[-8:], 5.0))

    def test_embedding_takes_the_last_76_mel_frames(self):
        for v in range(1, 4):
            self.det.process(chunk(v))
        self.assertTrue(all(s == (1, 76, 32, 1) for s in self.emb.shapes))

    def test_scores_zero_until_16_features_then_runs_the_wake_model(self):
        scores = [self.det.process(chunk(5)) for _ in range(17)]
        self.assertEqual(scores[:16], [0.0] * 16)  # 1 context chunk + 15 features
        self.assertEqual(len(self.wake.inputs), 1)
        self.assertEqual(self.wake.inputs[0].shape, (1, 16, 96))
        self.assertGreater(scores[16], 0)

    def test_wake_window_length_follows_the_model(self):
        det = WakeDetector(FakeMel(), FakeEmb(), FakeWake(n=8))
        scores = [det.process(chunk(5)) for _ in range(9)]
        self.assertEqual(scores[:8], [0.0] * 8)
        self.assertGreater(scores[8], 0)

    def test_buffers_are_bounded(self):
        for _ in range(400):
            self.det.process(chunk(1))
        self.assertLessEqual(self.det.mel_buf.shape[0], 970)
        self.assertLessEqual(self.det.features.shape[0], 120)
        self.assertEqual(self.det.raw.shape[0], CHUNK + MEL_CONTEXT)

    def test_rejects_wrong_chunks(self):
        with self.assertRaises(ValueError):
            self.det.process(np.zeros(CHUNK, dtype=np.float32))
        with self.assertRaises(ValueError):
            self.det.process(np.zeros(640, dtype=np.int16))


if __name__ == "__main__":
    unittest.main()

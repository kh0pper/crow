"""Parity of oww_lite with the upstream openwakeword package on real models.

Skipped unless onnxruntime and openwakeword are importable and the three ONNX files are in
$OWW_MODELS_DIR (melspectrogram.onnx, embedding_model.onnx, hey_jarvis_v0.1.onnx) together with a
16 kHz mono WAV of someone saying "hey jarvis" at $OWW_TEST_WAV. This is a bring-up check
on the Pi, not part of CI: the models are not redistributable from this public repo.
"""

import os
import sys
import unittest
import wave

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _testenv  # noqa: E402,F401  (must come before config is imported)

MODELS = os.environ.get("OWW_MODELS_DIR", "")
WAV = os.environ.get("OWW_TEST_WAV", "")


def _available():
    try:
        import onnxruntime  # noqa: F401
        import openwakeword  # noqa: F401
    except Exception:  # noqa: BLE001
        return False
    need = ["melspectrogram.onnx", "embedding_model.onnx", "hey_jarvis_v0.1.onnx"]
    return (
        MODELS
        and all(os.path.exists(os.path.join(MODELS, n)) for n in need)
        and os.path.exists(WAV)
    )


@unittest.skipUnless(
    _available(), "needs onnxruntime + openwakeword + models + test wav"
)
class ParityTests(unittest.TestCase):
    def test_peak_scores_agree(self):
        from openwakeword.model import Model
        from oww_lite import CHUNK, load_detector

        with wave.open(WAV) as w:
            assert (
                w.getframerate() == 16000
                and w.getnchannels() == 1
                and w.getsampwidth() == 2
            )
            audio = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
        audio = np.concatenate(
            (
                np.zeros(16000 * 4, dtype=np.int16),
                audio,
                np.zeros(16000, dtype=np.int16),
            )
        )
        p = lambda n: os.path.join(MODELS, n)
        up = Model(
            wakeword_models=[p("hey_jarvis_v0.1.onnx")],
            inference_framework="onnx",
            melspec_model_path=p("melspectrogram.onnx"),
            embedding_model_path=p("embedding_model.onnx"),
        )
        lite = load_detector(
            p("melspectrogram.onnx"),
            p("embedding_model.onnx"),
            p("hey_jarvis_v0.1.onnx"),
        )
        ups, lites = [], []
        for i in range(0, len(audio) - CHUNK + 1, CHUNK):
            c = audio[i : i + CHUNK]
            ups.append(list(up.predict(c).values())[0])
            lites.append(lite.process(c))
        warm = 40  # ~3.2 s: both pipelines past their start-up buffers
        a, b = np.array(ups[warm:]), np.array(lites[warm:])
        self.assertGreater(a.max(), 0.5, "the test clip must wake the upstream model")
        self.assertGreater(b.max(), 0.5)
        self.assertLess(abs(int(a.argmax()) - int(b.argmax())), 3)
        self.assertLess(float(np.abs(a - b).max()), 0.1)


if __name__ == "__main__":
    unittest.main()

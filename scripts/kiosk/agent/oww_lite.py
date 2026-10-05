"""A small streaming openWakeWord runner: onnxruntime + numpy only.

Why not the openwakeword package: on Python 3.13 (Debian trixie) its pip install fails, because it
requires tflite-runtime on Linux and tflite-runtime has no cp313 wheel; and `import openwakeword`
pulls in scipy and scikit-learn at import time (its custom-verifier module), which is memory the Pi 3
does not have to spare. This module re-implements openWakeWord 0.6.0's streaming feature path
(openwakeword/utils.py AudioFeatures._streaming_features, model.py Model.predict) for the ONNX
models, for fixed 80 ms (1280-sample) chunks:

  raw int16 @16 kHz -> melspectrogram.onnx on the last 1280+480 samples -> spec/10 + 2
  -> mel buffer -> embedding_model.onnx on the last 76 mel frames -> one 96-d feature per chunk
  -> wake model on the last N features (N from the model's input shape, 16 for openWakeWord models)

The ONNX sessions are injected (anything with .run(None, feeds) and .get_inputs()), so the window
logic is unit-tested without onnxruntime. Parity with the upstream package is checked by
test_oww_parity.py where onnxruntime and openwakeword are both importable.
"""

import numpy as np

CHUNK = 1280  # 80 ms at 16 kHz
MEL_CONTEXT = 480  # 3 extra hops of 160 samples, as upstream
MEL_WINDOW = 76  # mel frames per embedding
MEL_MAX = 970  # upstream keeps 10 s of mel frames
FEATURE_MAX = 120  # upstream keeps ~10 s of features


class WakeDetector:
    def __init__(self, mel_session, embedding_session, wake_session):
        self.mel = mel_session
        self.emb = embedding_session
        self.wake = wake_session
        self.mel_input = mel_session.get_inputs()[0].name
        self.emb_input = embedding_session.get_inputs()[0].name
        self.wake_input = wake_session.get_inputs()[0].name
        n = wake_session.get_inputs()[0].shape[1]
        self.n_features = int(n) if isinstance(n, (int, np.integer)) else 16
        self.reset()

    def reset(self):
        self.raw = np.zeros(0, dtype=np.int16)
        self.mel_buf = np.ones(
            (MEL_WINDOW, 32), dtype=np.float32
        )  # upstream starts with ones
        self.features = np.zeros((0, 96), dtype=np.float32)

    def process(self, chunk):
        """Feed exactly one 1280-sample int16 chunk; returns the wake score (0.0 until warmed up)."""
        chunk = np.asarray(chunk)
        if chunk.dtype != np.int16 or chunk.shape != (CHUNK,):
            raise ValueError("process() takes one int16 chunk of 1280 samples")
        self.raw = np.concatenate((self.raw, chunk))[-(CHUNK + MEL_CONTEXT) :]
        if self.raw.shape[0] < CHUNK + MEL_CONTEXT:
            # Upstream pads with its 10 s raw buffer of history; until we hold 1760 samples, wait.
            return 0.0
        spec = self.mel.run(
            None, {self.mel_input: self.raw.astype(np.float32)[None, :]}
        )[0]
        spec = np.squeeze(spec) / 10 + 2
        self.mel_buf = np.vstack((self.mel_buf, spec.astype(np.float32)))[-MEL_MAX:]
        window = self.mel_buf[-MEL_WINDOW:].astype(np.float32)[None, :, :, None]
        emb = np.squeeze(self.emb.run(None, {self.emb_input: window})[0]).astype(
            np.float32
        )
        self.features = np.vstack((self.features, emb[None, :]))[-FEATURE_MAX:]
        if self.features.shape[0] < self.n_features:
            return 0.0
        x = self.features[-self.n_features :][None, :, :].astype(np.float32)
        out = self.wake.run(None, {self.wake_input: x})[0]
        return float(np.asarray(out).reshape(-1)[0])


def load_detector(mel_path, embedding_path, wake_path, threads=1):
    import onnxruntime as ort  # Debian: python3-onnxruntime

    opts = ort.SessionOptions()
    opts.inter_op_num_threads = threads
    opts.intra_op_num_threads = threads
    mk = lambda p: ort.InferenceSession(
        p, sess_options=opts, providers=["CPUExecutionProvider"]
    )
    return WakeDetector(mk(mel_path), mk(embedding_path), mk(wake_path))

"""pi-setup check: onnxruntime must import AND run in the agent's interpreter (a CPU without an
instruction the build assumes dies with SIGILL, which only shows up when a session runs)."""
import os
import sys

import numpy as np
import onnxruntime as ort
import websockets  # noqa: F401 - the agent needs it too

if not os.path.realpath(ort.__file__).startswith(os.path.realpath(sys.prefix) + os.sep):
    sys.exit(f"onnxruntime comes from {ort.__file__}, not from the agent venv {sys.prefix} "
             "(a Debian python3-onnxruntime would shadow nothing, but this one is not the pinned wheel)")
mel = sys.argv[1] if len(sys.argv) > 1 else ""
if mel and os.path.exists(mel):
    s = ort.InferenceSession(mel, providers=["CPUExecutionProvider"])
    out = s.run(None, {s.get_inputs()[0].name: np.zeros((1, 1760), dtype=np.float32)})[0]
    print(f"onnxruntime {ort.__version__}: ran melspectrogram, output {tuple(out.shape)}")
else:
    print(f"onnxruntime {ort.__version__}: imported (no model yet to run)")

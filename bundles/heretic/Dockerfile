# Heretic (https://github.com/p-e-w/heretic, AGPL-3.0-or-later) in its own container,
# on a ROCm PyTorch base.
#
# Heretic publishes no image and no Dockerfile: it is a pip package (`heretic-llm`)
# that expects "PyTorch installed as appropriate for your hardware" (torch is not one
# of its declared dependencies). So this image:
#   - starts FROM Unsloth's ROCm training image, pinned by tag and digest. It carries
#     PyTorch built for ROCm 7.2 and Unsloth's GPU pre-flight entrypoint, and shares
#     its layers with the Unsloth Studio extension (no second 8 GB PyTorch download).
#     The Unsloth image is Apache-2.0 (its one AGPL file is a smoke-test script);
#   - installs the UNMODIFIED Heretic release from PyPI into its own venv. Nothing of
#     Heretic is copied into or vendored in Crow's repository, and nothing of it is
#     linked into Crow: Crow only builds and starts this container;
#   - lets that venv see the base's ROCm PyTorch through a .pth file placed after the
#     venv's own site-packages, so Heretic's pinned transformers/accelerate shadow the
#     base's copies without touching the Unsloth venv, and pins torch to the base's
#     exact ROCm build (a +rocm local version no index has), so pip can never swap in
#     a CUDA wheel;
#   - fails the build unless torch still reports a HIP version afterwards.
#
# Not yet built on real hardware: the bundle stays `draft` until one build and a
# `heretic --help` smoke run in a scheduled window prove it.

FROM unsloth/unsloth-rocm:v0.1.903-beta@sha256:2d0cbb91212b33acfcb18e2f7db42e23968a718a2ae466684308b23f85792432

ARG HERETIC_VERSION=1.4.0

RUN set -eux; \
    BASE_SITE="$(/opt/unsloth-venv/bin/python -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"; \
    python3.12 -m venv /opt/heretic; \
    HERETIC_SITE="$(/opt/heretic/bin/python -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"; \
    echo "$BASE_SITE" > "$HERETIC_SITE/zz-unsloth-rocm-base.pth"; \
    /opt/heretic/bin/python -c "from importlib.metadata import version as v; open('/tmp/rocm-pins.txt','w').write(''.join(f'{p}=={v(p)}\n' for p in ('torch','torchvision','torchaudio')))"; \
    cat /tmp/rocm-pins.txt; \
    grep -q '^torch==.*+rocm' /tmp/rocm-pins.txt; \
    /opt/heretic/bin/pip install --no-cache-dir -c /tmp/rocm-pins.txt "heretic-llm==${HERETIC_VERSION}"; \
    /opt/heretic/bin/python -c "import torch, heretic; assert torch.version.hip, 'torch lost its ROCm build: ' + torch.__version__; print('heretic on torch', torch.__version__, 'hip', torch.version.hip)"; \
    test -x /opt/heretic/bin/heretic; \
    rm -f /tmp/rocm-pins.txt

ENV PATH=/opt/heretic/bin:${PATH}
WORKDIR /models

# Heretic is an interactive command-line tool, not a server: the container idles and
# the owner runs it in a terminal with `docker exec -it crow-heretic heretic <model>`.
# The base ENTRYPOINT (GPU pre-flight) runs first, then this command.
CMD ["sleep", "infinity"]

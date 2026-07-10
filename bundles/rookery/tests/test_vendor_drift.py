"""Guard: vendored rookery_manifest modules must stay byte-identical to the
hashes recorded at vendor time (see VENDORED.md). A failure here means someone
patched the vendored copy — change upstream instead, re-copy, re-pin."""

import hashlib
import pathlib

SRC = pathlib.Path(__file__).resolve().parent.parent / "src" / "rookery_manifest"

# sha256 of each vendored file at vendor time — regenerate with:
#   sha256sum src/rookery_manifest/*.py
PINNED = {
    "__init__.py": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "manifest.py": "32d74bc48867756aae03a5e78728ccd6e92c222dc82470de790909639fff3cfd",
    "assemble.py": "3a14ceb9b4b43e4c0ebfb15ff4b5a03c39f53933b86c3467cf8a9fb8e859c3c8",
    "cli.py": "9e7de4e7b0259bedda5da1eac01e1bc2a803cadde7de6ced93b3041a485c4b23",
}


def test_vendored_files_unmodified():
    for name, want in PINNED.items():
        got = hashlib.sha256((SRC / name).read_bytes()).hexdigest()
        assert got == want, f"{name} drifted from vendored pin — see VENDORED.md"

"""Imported first by every test module: points HOME at a throwaway directory, so nothing a test does
(e.g. the agent's page-seen marker under ~/.local/state) can touch the real home of whoever runs the suite."""
import atexit
import os
import shutil
import tempfile

_home = tempfile.mkdtemp(prefix="crow-kiosk-agent-test-home-")
os.environ["HOME"] = _home
atexit.register(shutil.rmtree, _home, True)

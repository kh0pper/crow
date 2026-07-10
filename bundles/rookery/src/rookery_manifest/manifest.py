"""Build and write OpenScience `_script_manifest.jsonl` entries.

Format matches OpenScience's `output_guard.log_to_manifest` exactly: one JSON
object per line with keys timestamp/script/args/output, `output` relative to
the workspace dir. Unlike OpenScience (which stamps wall-clock time at write),
we derive the timestamp from the evidence file's mtime — deterministic, and a
reasonable default for when the artifact was produced. Caveat: mtime survives
`shutil.copy2` but NOT `git checkout` or rsync without `-t`; treat it as
best-effort provenance, not proof.
"""

import json
import os
import time
from typing import Any


def build_manifest_entry(
    script: str, args: dict[str, Any], src_path: str, output_rel: str
) -> dict[str, Any]:
    mtime = os.stat(src_path).st_mtime
    return {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(mtime)),
        "script": script,
        "args": args,
        "output": output_rel,
    }


def write_manifest(entries: list[dict[str, Any]], workspace_dir: str) -> str:
    path = os.path.join(workspace_dir, "_script_manifest.jsonl")
    with open(path, "w") as f:
        for e in entries:
            f.write(json.dumps(e) + "\n")
    return path

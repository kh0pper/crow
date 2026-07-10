"""Assemble an OpenScience reviewer workspace from a report + its evidence.

Copies (never moves) the report and each evidence artifact into a fresh
workspace dir and writes `_script_manifest.jsonl` registering every evidence
file as a logged script output. The report is the artifact UNDER REVIEW, so it
is copied in but never listed in the manifest.
"""

import os
import shutil
from dataclasses import dataclass, field
from typing import Any

from .manifest import build_manifest_entry, write_manifest


@dataclass
class Evidence:
    src: str
    script: str
    args: dict[str, Any] = field(default_factory=dict)


def assemble_workspace(
    report_path: str, evidence: list[Evidence], workspace_dir: str
) -> str:
    if os.path.isdir(workspace_dir) and os.listdir(workspace_dir):
        raise FileExistsError(
            f"workspace dir not empty: {workspace_dir} "
            "(stale files from a previous assembly would leak into the review)"
        )
    names = [os.path.basename(report_path)] + [
        os.path.basename(e.src) for e in evidence
    ]
    dupes = sorted({n for n in names if names.count(n) > 1})
    if dupes:
        raise ValueError(f"basename collision in workspace: {dupes}")

    os.makedirs(workspace_dir, exist_ok=True)
    shutil.copy2(
        report_path, os.path.join(workspace_dir, os.path.basename(report_path))
    )

    entries = []
    for ev in evidence:
        out_name = os.path.basename(ev.src)
        shutil.copy2(ev.src, os.path.join(workspace_dir, out_name))
        entries.append(build_manifest_entry(ev.script, ev.args, ev.src, out_name))

    write_manifest(entries, workspace_dir)
    return workspace_dir

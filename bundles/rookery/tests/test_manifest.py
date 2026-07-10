import json
import os

from rookery_manifest.manifest import build_manifest_entry, write_manifest


def test_entry_has_exact_keys_and_mtime_timestamp(tmp_path):
    src = tmp_path / "value.txt"
    src.write_text("answer=42\n")
    os.utime(src, (1_700_000_000, 1_700_000_000))  # fixed mtime

    entry = build_manifest_entry(
        script="zoo-score.py",
        args={"--phase": "exp-j1.1b"},
        src_path=str(src),
        output_rel="SCORE-exp-j1.1b.md",
    )

    assert set(entry) == {"timestamp", "script", "args", "output"}
    assert entry["script"] == "zoo-score.py"
    assert entry["args"] == {"--phase": "exp-j1.1b"}
    assert entry["output"] == "SCORE-exp-j1.1b.md"
    # 1_700_000_000 == 2023-11-14T22:13:20Z
    assert entry["timestamp"] == "2023-11-14T22:13:20Z"


def test_write_manifest_is_one_json_object_per_line(tmp_path):
    e1 = {
        "timestamp": "2026-07-09T00:00:00Z",
        "script": "a.py",
        "args": {},
        "output": "a.txt",
    }
    e2 = {
        "timestamp": "2026-07-09T00:00:01Z",
        "script": "b.py",
        "args": {"k": 1},
        "output": "b.txt",
    }

    path = write_manifest([e1, e2], str(tmp_path))

    assert path == str(tmp_path / "_script_manifest.jsonl")
    lines = (tmp_path / "_script_manifest.jsonl").read_text().splitlines()
    assert len(lines) == 2
    assert json.loads(lines[0]) == e1
    assert json.loads(lines[1]) == e2

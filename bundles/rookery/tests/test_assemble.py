import json
import os

import pytest

from rookery_manifest.assemble import Evidence, assemble_workspace


def _fixture(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    report = src / "REPORT-exp-j1.1b.md"
    report.write_text("# Report\nrecall 1/3 -> 3/3\n")
    rounds = src / "rounds.jsonl"
    rounds.write_text('{"case": "Z3", "recall": true}\n')
    score = src / "SCORE-exp-j1.1b.md"
    score.write_text("recall 3/4\n")
    return report, rounds, score


def test_assemble_copies_report_and_evidence_and_writes_manifest(tmp_path):
    report, rounds, score = _fixture(tmp_path)
    ws = tmp_path / "ws"

    out = assemble_workspace(
        report_path=str(report),
        evidence=[
            Evidence(
                src=str(rounds), script="zoo-round.sh", args={"phase": "exp-j1.1b"}
            ),
            Evidence(
                src=str(score), script="zoo-score.py", args={"--phase": "exp-j1.1b"}
            ),
        ],
        workspace_dir=str(ws),
    )

    assert out == str(ws)
    # report + both evidence files copied in
    assert (ws / "REPORT-exp-j1.1b.md").read_text() == "# Report\nrecall 1/3 -> 3/3\n"
    assert (ws / "rounds.jsonl").exists()
    assert (ws / "SCORE-exp-j1.1b.md").exists()

    lines = (ws / "_script_manifest.jsonl").read_text().splitlines()
    outputs = [json.loads(x)["output"] for x in lines]
    # evidence is registered; the report under review is NOT a manifest node
    assert outputs == ["rounds.jsonl", "SCORE-exp-j1.1b.md"]
    assert "REPORT-exp-j1.1b.md" not in outputs


def test_assemble_does_not_mutate_originals(tmp_path):
    report, rounds, score = _fixture(tmp_path)
    ws = tmp_path / "ws"
    assemble_workspace(
        str(report), [Evidence(str(rounds), "zoo-round.sh", {})], str(ws)
    )
    # original still in place, unchanged
    assert rounds.read_text() == '{"case": "Z3", "recall": true}\n'
    assert os.path.exists(str(rounds))


def test_assemble_refuses_nonempty_workspace(tmp_path):
    report, rounds, score = _fixture(tmp_path)
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "stale.md").write_text("left over from a previous assembly\n")
    with pytest.raises(FileExistsError):
        assemble_workspace(
            str(report), [Evidence(str(rounds), "zoo-round.sh", {})], str(ws)
        )


def test_assemble_raises_on_basename_collision(tmp_path):
    report, rounds, score = _fixture(tmp_path)
    other = tmp_path / "sub"
    other.mkdir()
    dup = other / "rounds.jsonl"  # same basename as `rounds`, different file
    dup.write_text("{}\n")
    ws = tmp_path / "ws"
    with pytest.raises(ValueError, match="basename collision"):
        assemble_workspace(
            str(report),
            [Evidence(str(rounds), "a.sh", {}), Evidence(str(dup), "b.sh", {})],
            str(ws),
        )

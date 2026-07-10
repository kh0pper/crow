from rookery_manifest.cli import main


def _pilab_layout(tmp_path):
    data = tmp_path / "j1-zoo"
    data.mkdir()
    (data / "rounds.jsonl").write_text('{"case": "Z3", "recall": true}\n')
    (data / "SCORE-exp-j1.1b.md").write_text("recall 3/4\n")
    (data / "SCORE-exp-j1.1.md").write_text("recall 1/3\n")
    report = tmp_path / "REPORT-exp-j1.1b.md"
    report.write_text("# Report\n")
    return data, report


def test_exp_assembles_workspace_from_convention(tmp_path, capsys):
    data, report = _pilab_layout(tmp_path)
    ws = tmp_path / "ws"

    rc = main(
        [
            "exp",
            "--report",
            str(report),
            "--data-dir",
            str(data),
            "--phase",
            "exp-j1.1b",
            "--workspace",
            str(ws),
        ]
    )

    assert rc == 0
    assert (ws / "REPORT-exp-j1.1b.md").exists()
    assert (ws / "rounds.jsonl").exists()
    assert (ws / "SCORE-exp-j1.1b.md").exists()
    assert (ws / "_script_manifest.jsonl").exists()
    assert str(ws) in capsys.readouterr().out


def test_exp_multiple_phases_includes_each_score(tmp_path, capsys):
    data, report = _pilab_layout(tmp_path)
    ws = tmp_path / "ws"

    rc = main(
        [
            "exp",
            "--report",
            str(report),
            "--data-dir",
            str(data),
            "--phase",
            "exp-j1.1b",
            "--phase",
            "exp-j1.1",
            "--workspace",
            str(ws),
        ]
    )

    assert rc == 0
    assert (ws / "SCORE-exp-j1.1b.md").exists()
    assert (ws / "SCORE-exp-j1.1.md").exists()
    import json

    lines = (ws / "_script_manifest.jsonl").read_text().splitlines()
    assert len(lines) == 3  # rounds.jsonl + one SCORE per phase
    rounds_entry = next(
        json.loads(x) for x in lines if json.loads(x)["output"] == "rounds.jsonl"
    )
    # the manifest must not claim a single phase for the all-phases rounds file
    assert "phases" in rounds_entry["args"]
    assert rounds_entry["args"]["phases"] == ["exp-j1.1b", "exp-j1.1"]


def test_exp_missing_score_exits_2(tmp_path, capsys):
    data, report = _pilab_layout(tmp_path)
    (data / "SCORE-exp-j1.1b.md").unlink()
    ws = tmp_path / "ws"

    rc = main(
        [
            "exp",
            "--report",
            str(report),
            "--data-dir",
            str(data),
            "--phase",
            "exp-j1.1b",
            "--workspace",
            str(ws),
        ]
    )

    assert rc == 2
    assert "missing input" in capsys.readouterr().err.lower()

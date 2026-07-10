import json

import pytest

from rookery_mcp.server import assemble_exp


def _pilab_layout(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    (data / "rounds.jsonl").write_text('{"case": "Z1", "recall": true}\n')
    (data / "SCORE-p1.md").write_text("recall 1/1\n")
    report = tmp_path / "REPORT-p1.md"
    report.write_text("# Report\n")
    return data, report


def test_assemble_exp_builds_workspace_and_returns_paths(tmp_path):
    data, report = _pilab_layout(tmp_path)
    ws_root = tmp_path / "workspaces"

    out = assemble_exp(
        report_path=str(report),
        data_dir=str(data),
        phases=["p1"],
        workspace_name="audit-p1",
        workspaces_dir=str(ws_root),
    )

    ws = ws_root / "audit-p1"
    assert out["workspace"] == str(ws)
    assert out["container_path"] == "/workspaces/audit-p1"
    assert out["reviewer_url"] == "/proxy/rookery/"
    assert (ws / "REPORT-p1.md").exists()
    assert (ws / "rounds.jsonl").exists()
    assert (ws / "SCORE-p1.md").exists()
    lines = (ws / "_script_manifest.jsonl").read_text().splitlines()
    assert len(lines) == 2  # rounds + one SCORE
    assert json.loads(lines[0])["output"] == "rounds.jsonl"


def test_assemble_exp_rejects_bad_workspace_name(tmp_path):
    data, report = _pilab_layout(tmp_path)
    with pytest.raises(ValueError, match="workspace_name"):
        assemble_exp(str(report), str(data), ["p1"], "../escape", str(tmp_path / "w"))


def test_assemble_exp_missing_input_is_valueerror(tmp_path):
    data, report = _pilab_layout(tmp_path)
    with pytest.raises(ValueError, match="missing input"):
        assemble_exp(str(report), str(data), ["nope"], "a", str(tmp_path / "w"))


def test_assemble_exp_nonempty_workspace_is_valueerror(tmp_path):
    data, report = _pilab_layout(tmp_path)
    ws_root = tmp_path / "workspaces"
    assemble_exp(str(report), str(data), ["p1"], "a", str(ws_root))
    with pytest.raises(ValueError, match="not empty"):
        assemble_exp(str(report), str(data), ["p1"], "a", str(ws_root))


def test_assemble_exp_oserror_surfaces_as_valueerror(tmp_path):
    # Contract: errors leave assemble_exp as ValueError with a human message,
    # never a raw OSError traceback. Point the workspaces root INTO a file so
    # os.makedirs raises NotADirectoryError (an OSError subclass).
    data, report = _pilab_layout(tmp_path)
    blocker = tmp_path / "blocker"
    blocker.write_text("not a directory\n")
    with pytest.raises(ValueError, match="could not assemble"):
        assemble_exp(str(report), str(data), ["p1"], "a", str(blocker / "ws"))


def test_assemble_exp_expands_tilde_in_env_workspaces_dir(tmp_path, monkeypatch):
    # Regression: the manifest default is "~/.crow/..." and bundles.js bakes
    # env_vars defaults VERBATIM into the spawned env — an unexpanded "~" must
    # not become a literal ./~/ directory.
    data, report = _pilab_layout(tmp_path)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ROOKERY_WORKSPACES_DIR", "~/ws")
    out = assemble_exp(str(report), str(data), ["p1"], "audit-p1")
    assert out["workspace"] == str(tmp_path / "ws" / "audit-p1")
    assert (tmp_path / "ws" / "audit-p1" / "REPORT-p1.md").exists()

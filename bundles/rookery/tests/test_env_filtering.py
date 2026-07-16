"""Tests for wrapper-exec.sh (allowlist env interposer, Phase-2 blocker a)
and scrub-env.sh (entrypoint defense-in-depth denylist).

Plan Task 3 acceptance: a probe that dumps its env proves (i) no
thk_/provider/crow keys reach a wrapped child, (ii) allowlisted vars do,
(iii) the stderr env log fires.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

BUNDLE = Path(__file__).resolve().parent.parent
WRAPPER = BUNDLE / "wrapper-exec.sh"
SCRUB = BUNDLE / "scrub-env.sh"

POLLUTED = {
    "THK_WALLET_KEY": "leak-1",
    "CROW_API_TOKEN": "leak-2",
    "OPENAI_API_KEY": "leak-3",
    "ANTHROPIC_API_KEY": "leak-4",
    "MODEL_API_KEY": "leak-5",
    "NTFY_TOKEN": "leak-6",
    "RANDOM_APP_SETTING": "leak-7",  # not credential-shaped, still not allowlisted
}

PROBE = [sys.executable, "-c", "import json,os;print(json.dumps(dict(os.environ)))"]


def run_wrapped(*wrapper_args, extra_env=None):
    env = {
        "PATH": os.environ["PATH"],
        "HOME": os.environ.get("HOME", "/tmp"),
        "WORKSPACES_DIR": "/workspaces",
        **POLLUTED,
        **(extra_env or {}),
    }
    proc = subprocess.run(
        [str(WRAPPER), *wrapper_args, "--", *PROBE],
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout), proc.stderr


def test_wrapper_is_executable():
    assert os.access(WRAPPER, os.X_OK)


def test_no_polluted_var_reaches_wrapped_child():
    child_env, _ = run_wrapped()
    leaked = set(POLLUTED) & set(child_env)
    assert not leaked, f"polluted vars leaked through the wrapper: {leaked}"
    # clean slate: nothing beyond the base allowlist (+ whatever env -i adds,
    # which is nothing) may appear
    assert set(child_env) <= {"PATH", "HOME", "WORKSPACES_DIR", "LC_CTYPE", "PWD"}


def test_base_allowlist_passes_through():
    child_env, _ = run_wrapped()
    assert child_env["PATH"] == os.environ["PATH"]
    assert child_env["WORKSPACES_DIR"] == "/workspaces"
    assert "HOME" in child_env


def test_declared_per_server_vars_pass_and_others_still_do_not():
    child_env, _ = run_wrapped(
        "--allow",
        "RESEARCH_MCP_API_KEY,EXTRA_FLAG",
        extra_env={"RESEARCH_MCP_API_KEY": "s3cret", "EXTRA_FLAG": "on"},
    )
    assert child_env["RESEARCH_MCP_API_KEY"] == "s3cret"
    assert child_env["EXTRA_FLAG"] == "on"
    assert "CROW_API_TOKEN" not in child_env


def test_allow_of_unset_var_is_harmless():
    child_env, _ = run_wrapped("--allow", "NOT_SET_ANYWHERE")
    assert "NOT_SET_ANYWHERE" not in child_env


def test_stderr_env_log_fires_and_redacts_credentials():
    _, stderr = run_wrapped(
        "--allow", "RESEARCH_MCP_API_KEY", extra_env={"RESEARCH_MCP_API_KEY": "s3cret"}
    )
    assert "[wrapper-exec]" in stderr
    assert "WORKSPACES_DIR=/workspaces" in stderr  # exact env logged
    assert "RESEARCH_MCP_API_KEY=<redacted>" in stderr
    assert "s3cret" not in stderr  # value never lands in container logs


def test_wrapper_fails_loudly_without_a_command():
    proc = subprocess.run(
        [str(WRAPPER), "--"],
        capture_output=True,
        text=True,
        timeout=30,
        env={"PATH": os.environ["PATH"]},
    )
    assert proc.returncode == 2
    assert "no command" in proc.stderr


# ---------------------------------------------------------------- scrub-env


def run_scrubbed_env():
    env = {
        "PATH": os.environ["PATH"],
        "HOME": os.environ.get("HOME", "/tmp"),
        "ROOKERY_CORS_ORIGINS": "https://example",
        **POLLUTED,
    }
    proc = subprocess.run(
        ["/bin/sh", "-c", f". {SCRUB}; env"],
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    return dict(line.split("=", 1) for line in proc.stdout.splitlines() if "=" in line)


def test_scrub_drops_credential_shaped_vars():
    env_after = run_scrubbed_env()
    for name in (
        "THK_WALLET_KEY",
        "CROW_API_TOKEN",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "MODEL_API_KEY",
        "NTFY_TOKEN",
    ):
        assert name not in env_after, f"{name} survived the scrub"


def test_scrub_keeps_required_and_benign_vars():
    env_after = run_scrubbed_env()
    assert "PATH" in env_after and "HOME" in env_after
    # denylist means non-credential-shaped app vars survive — documented
    # limitation; the wrapper is the real boundary
    assert env_after.get("RANDOM_APP_SETTING") == "leak-7"
    assert env_after.get("ROOKERY_CORS_ORIGINS") == "https://example"

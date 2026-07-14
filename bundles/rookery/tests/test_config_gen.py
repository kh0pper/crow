"""Tests for config-gen.mjs — openscience.json generation, including the
crow-bridge remote MCP registration (Phase 2 Task 4, design D2/D4)."""

import json
import os
import subprocess
from pathlib import Path

BUNDLE = Path(__file__).resolve().parent.parent
SCRIPT = BUNDLE / "config-gen.mjs"

BASE_ENV = {
    "PATH": os.environ["PATH"],
    "MODEL_BASE_URL": "http://100.118.41.122:8010/v1",
    "MODEL_ID": "qwen3.6-27b",
}


def run_gen(extra_env=None):
    env = {**BASE_ENV, **(extra_env or {})}
    return subprocess.run(
        ["node", str(SCRIPT)], capture_output=True, text=True, env=env, timeout=30
    )


def gen(extra_env=None):
    proc = run_gen(extra_env)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout), proc.stderr


def test_baseline_matches_previous_heredoc_shape():
    cfg, _ = gen()
    assert cfg == {
        "model": "crow-local/qwen3.6-27b",
        "provider": {
            "crow-local": {
                "npm": "@ai-sdk/openai-compatible",
                "name": "Crow Local",
                "options": {
                    "baseURL": "http://100.118.41.122:8010/v1",
                    "apiKey": "local",
                },
                "models": {"qwen3.6-27b": {"name": "qwen3.6-27b"}},
            }
        },
    }
    assert "mcp" not in cfg


def test_model_id_defaults():
    env = {k: v for k, v in BASE_ENV.items() if k != "MODEL_ID"}
    proc = subprocess.run(
        ["node", str(SCRIPT)], capture_output=True, text=True, env=env, timeout=30
    )
    cfg = json.loads(proc.stdout)
    assert cfg["model"] == "crow-local/local-model"


def test_missing_model_base_url_dies():
    proc = run_gen({"MODEL_BASE_URL": ""})
    assert proc.returncode == 1
    assert "MODEL_BASE_URL is required" in proc.stderr


def test_crow_bridge_registers_per_verified_schema():
    cfg, _ = gen(
        {
            "MCP_CROW_URL": "http://100.118.41.122:3006/router/mcp",
            "MCP_CROW_TOKEN": "tok123",
        }
    )
    assert cfg["mcp"] == {
        "crow": {
            "type": "remote",
            "url": "http://100.118.41.122:3006/router/mcp",
            "enabled": True,
            "headers": {"Authorization": "Bearer tok123"},
        }
    }


def test_url_without_token_skips_loudly():
    cfg, stderr = gen({"MCP_CROW_URL": "http://100.118.41.122:3006/router/mcp"})
    assert "mcp" not in cfg
    assert "MCP_CROW_TOKEN missing" in stderr


def test_non_http_url_dies():
    proc = run_gen(
        {"MCP_CROW_URL": "file:///etc/passwd", "MCP_CROW_TOKEN": "t"}
    )
    assert proc.returncode == 1
    assert "must be http(s)" in proc.stderr


def test_invalid_url_dies():
    proc = run_gen({"MCP_CROW_URL": "not a url", "MCP_CROW_TOKEN": "t"})
    assert proc.returncode == 1


def test_json_injection_safe_token():
    hostile = 'a"b\\c\n{"x":1}'
    cfg, _ = gen({"MCP_CROW_URL": "http://h:1/mcp", "MCP_CROW_TOKEN": hostile})
    assert cfg["mcp"]["crow"]["headers"]["Authorization"] == f"Bearer {hostile}"
    # provider block untouched by MCP config
    assert cfg["provider"]["crow-local"]["options"]["apiKey"] == "local"


def test_token_never_leaks_outside_headers():
    cfg, stderr = gen(
        {"MCP_CROW_URL": "http://h:1/mcp", "MCP_CROW_TOKEN": "supersecret"}
    )
    dumped = json.dumps(cfg)
    assert dumped.count("supersecret") == 1  # exactly once: the header
    assert "supersecret" not in stderr

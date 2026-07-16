"""Tests for scripts/rookery-egress-lock.sh (dry-run rule generation).

Hermetic: derivation overrides (ROOKERY_BRIDGE / ROOKERY_SUBNET / MODEL_DST)
bypass docker entirely, so these run anywhere. A final smoke test exercises
live docker derivation and skips when the rookery network is absent.
"""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "rookery-egress-lock.sh"

ENV = {
    "ROOKERY_BRIDGE": "br-testbridge00",
    "ROOKERY_SUBNET": "192.168.80.0/20",
    "MODEL_DST": "192.168.64.2:8000",
}


def run_dry(extra_env=None, args=("--dry-run",)):
    env = {**os.environ, **ENV, **(extra_env or {})}
    proc = subprocess.run(
        [str(SCRIPT), *args], capture_output=True, text=True, env=env, timeout=30
    )
    lines = [l[2:] for l in proc.stdout.splitlines() if l.startswith("+ ")]
    return proc, lines


def test_script_is_executable():
    assert os.access(SCRIPT, os.X_OK), "lock script must be executable"


def test_dry_run_exits_zero_and_emits_rules():
    proc, lines = run_dry()
    assert proc.returncode == 0, proc.stderr
    assert lines, "dry-run must emit '+ ' command lines"
    # dry-run must never execute anything: every emitted line is ip(6)tables
    assert all(l.startswith(("iptables -w", "ip6tables -w")) for l in lines)


def test_model_allow_is_pinned_to_dnat_target_and_precedes_drop():
    _, lines = run_dry()
    v4 = [l for l in lines if l.startswith("iptables ")]
    allow = next(
        i
        for i, l in enumerate(v4)
        if "-A ROOKERY-EGRESS -d 192.168.64.2/32 -p tcp --dport 8000 -j ACCEPT" in l
    )
    drop = next(i for i, l in enumerate(v4) if l.endswith("-A ROOKERY-EGRESS -j DROP"))
    assert allow < drop, "model ACCEPT must precede the chain's terminal DROP"


def test_established_accept_heads_every_chain():
    _, lines = run_dry()
    for chain in ("ROOKERY-EGRESS", "ROOKERY-INGRESS", "ROOKERY-HOSTIN"):
        first_append = next(l for l in lines if f"-A {chain} " in l)
        assert "--ctstate ESTABLISHED,RELATED -j ACCEPT" in first_append, (
            f"{chain} must open with the conntrack accept (docker-proxy return "
            f"path / return traffic), got: {first_append}"
        )


def test_jumps_are_position_pinned_and_tagged():
    _, lines = run_dry()
    for fam in ("iptables", "ip6tables"):
        assert (
            f"{fam} -w -I DOCKER-USER 1 -m comment --comment rookery-lock "
            "-i br-testbridge00 -j ROOKERY-EGRESS" in lines
        )
        assert (
            f"{fam} -w -I DOCKER-USER 2 -m comment --comment rookery-lock "
            "-o br-testbridge00 -j ROOKERY-INGRESS" in lines
        )
        assert (
            f"{fam} -w -I INPUT 1 -m comment --comment rookery-lock "
            "-i br-testbridge00 -j ROOKERY-HOSTIN" in lines
        )


def test_subnet_tripwire_is_v4_only_and_appended():
    _, lines = run_dry()
    trip = [l for l in lines if "-s 192.168.80.0/20" in l and "-j DROP" in l]
    assert len(trip) == 1, "exactly one subnet tripwire"
    assert trip[0].startswith("iptables "), "tripwire is v4-only (network has no v6)"
    assert "-A DOCKER-USER" in trip[0], "tripwire is appended, never inserted"
    assert "--comment rookery-lock" in trip[0]


def test_ipv6_twins_have_no_v4_model_allow():
    _, lines = run_dry()
    v6 = [l for l in lines if l.startswith("ip6tables ")]
    assert any("-A ROOKERY-EGRESS -j DROP" in l for l in v6)
    assert not any("192.168.64.2" in l for l in v6)


def test_parametric_host_port_allowlist():
    _, lines = run_dry(extra_env={"ALLOW_HOST_TCP_PORTS": "3001, 3006"})
    v4 = [l for l in lines if l.startswith("iptables ")]
    for port in ("3001", "3006"):
        allow = next(
            i
            for i, l in enumerate(v4)
            if f"-A ROOKERY-HOSTIN -p tcp --dport {port} -j ACCEPT" in l
        )
        drop = next(
            i for i, l in enumerate(v4) if l.endswith("-A ROOKERY-HOSTIN -j DROP")
        )
        assert allow < drop
    # allowlist ports never leak into the egress chain
    assert not any("ROOKERY-EGRESS" in l and "3001" in l for l in v4)


def test_no_allowlist_means_hostin_is_estab_log_drop_only():
    _, lines = run_dry()
    hostin_v4 = [
        l for l in lines if l.startswith("iptables ") and "-A ROOKERY-HOSTIN" in l
    ]
    assert len(hostin_v4) == 3  # ESTAB accept, LOG, DROP
    assert not any("--dport" in l for l in hostin_v4)


def test_systemd_unit_prints_reexec_persistence():
    proc = subprocess.run(
        [str(SCRIPT), "--print-systemd-unit"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert proc.returncode == 0
    assert "ExecStart=" in proc.stdout and "--wait" in proc.stdout
    assert "After=docker.service" in proc.stdout


def test_fails_cleanly_without_docker_and_without_overrides():
    """No overrides + no docker on PATH → clean fatal, no rules emitted."""
    env = {k: v for k, v in os.environ.items() if k not in ENV}
    env["PATH"] = "/usr/bin/nonexistent"
    proc = subprocess.run(
        ["/bin/bash", str(SCRIPT), "--dry-run"],
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )
    assert proc.returncode != 0
    assert "cannot derive network" in proc.stderr
    assert "+ " not in proc.stdout


@pytest.mark.skipif(
    shutil.which("docker") is None
    or subprocess.run(
        ["docker", "network", "inspect", "rookery_default"],
        capture_output=True,
        timeout=30,
    ).returncode
    != 0,
    reason="live rookery_default network not available",
)
def test_live_derivation_matches_docker():
    """Against the real host: derived bridge/subnet must match docker's view."""
    proc = subprocess.run(
        [str(SCRIPT), "--dry-run"],
        capture_output=True,
        text=True,
        env={**os.environ},
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    net_id = subprocess.run(
        ["docker", "network", "inspect", "rookery_default", "--format", "{{.Id}}"],
        capture_output=True,
        text=True,
        timeout=30,
    ).stdout.strip()
    assert f"br-{net_id[:12]}" in proc.stdout


BAKEABLE = ("MODEL_PUBLISH", "ALLOW_PUBLISHED_TCP_PORTS", "ALLOW_HOST_TCP_PORTS", "ROOKERY_NETWORK")


def run_unit(extra_env=None):
    env = {k: v for k, v in os.environ.items() if k not in BAKEABLE}
    env.update(extra_env or {})
    return subprocess.run(
        [str(SCRIPT), "--print-systemd-unit"],
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )


def test_unit_bakes_allow_host_tcp_ports():
    """The 2026-07-16 live gap: the deployed lock ran with
    ALLOW_HOST_TCP_PORTS=3006 (MCP bridge), but the printed unit re-ran the
    script bare at boot — silently killing the bridge after every reboot.
    The printed unit must reproduce the posture it was printed under."""
    proc = run_unit({"ALLOW_HOST_TCP_PORTS": "3006"})
    assert proc.returncode == 0, proc.stderr
    assert 'Environment="ALLOW_HOST_TCP_PORTS=3006"' in proc.stdout
    svc = proc.stdout.split("[Service]", 1)[1]
    assert svc.index('Environment="ALLOW_HOST_TCP_PORTS=3006"') < svc.index("ExecStart=")


def test_unit_bakes_every_set_config_var():
    proc = run_unit({
        "MODEL_PUBLISH": "10.0.0.5:9000",
        "ALLOW_PUBLISHED_TCP_PORTS": "8011",
        "ALLOW_HOST_TCP_PORTS": "3006,3007",
        "ROOKERY_NETWORK": "other_net",
    })
    assert proc.returncode == 0, proc.stderr
    assert 'Environment="MODEL_PUBLISH=10.0.0.5:9000"' in proc.stdout
    assert 'Environment="ALLOW_PUBLISHED_TCP_PORTS=8011"' in proc.stdout
    assert 'Environment="ALLOW_HOST_TCP_PORTS=3006,3007"' in proc.stdout
    assert 'Environment="ROOKERY_NETWORK=other_net"' in proc.stdout


def test_unit_without_config_env_bakes_nothing():
    proc = run_unit()
    assert proc.returncode == 0, proc.stderr
    assert "Environment=" not in proc.stdout


def test_unit_environment_lines_are_whole_lines():
    """Regression: the $(...) emitting Environment= lines swallowed its
    trailing newline, gluing the last Environment= line to the '# --wait'
    comment — systemd misparses 'Environment="..."# comment'. Every
    Environment= line must be a whole line of its own."""
    proc = run_unit({"ALLOW_HOST_TCP_PORTS": "3006"})
    lines = proc.stdout.splitlines()
    assert 'Environment="ALLOW_HOST_TCP_PORTS=3006"' in lines
    assert not any("Environment=" in l and "#" in l for l in lines)

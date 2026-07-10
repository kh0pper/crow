"""Rookery bundle MCP server — one tool: rookery_assemble_exp.

Wraps the vendored rookery_manifest adapter (do NOT add logic there; see
VENDORED.md). The tool assembles a report + its evidence into a reviewer
workspace under WORKSPACES_DIR and returns host path, container path, and the
gateway reviewer URL. Errors are raised as ValueError with human messages —
the MCP layer surfaces them as tool errors, never tracebacks.
"""

import os
import re

from rookery_manifest.assemble import Evidence, assemble_workspace

_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def _default_workspaces_dir() -> str:
    return os.environ.get(
        "ROOKERY_WORKSPACES_DIR",
        os.path.join("~", ".crow", "data", "rookery", "workspaces"),
    )


def assemble_exp(
    report_path: str,
    data_dir: str,
    phases: list[str],
    workspace_name: str,
    workspaces_dir: str | None = None,
) -> dict:
    if not _NAME_RE.match(workspace_name):
        raise ValueError(
            "workspace_name must be a plain directory name "
            "(letters, digits, dot, dash, underscore; no path separators)"
        )
    if not phases:
        raise ValueError("at least one phase is required")

    # expanduser on the ROOT too: the manifest default arrives as a literal
    # "~/..." via the env block bundles.js writes (no shell expands it).
    root = os.path.expanduser(workspaces_dir or _default_workspaces_dir())
    report = os.path.expanduser(report_path)
    data = os.path.expanduser(data_dir)
    rounds = os.path.join(data, "rounds.jsonl")
    scores = [(p, os.path.join(data, f"SCORE-{p}.md")) for p in phases]

    for p in [report, rounds] + [path for _, path in scores]:
        if not os.path.exists(p):
            raise ValueError(f"missing input: {p}")

    evidence = [
        Evidence(
            src=rounds,
            script="zoo-round.sh",
            args={
                "phases": phases,
                "note": "append-only ground-truth round rows; the file spans all phases",
            },
        ),
    ] + [
        Evidence(src=path, script="zoo-score.py", args={"--phase": phase})
        for phase, path in scores
    ]

    os.makedirs(root, exist_ok=True)
    target = os.path.join(root, workspace_name)
    try:
        ws = assemble_workspace(report, evidence, target)
    except FileExistsError as e:
        raise ValueError(
            f"workspace not empty: {target} — remove it first (it contains only copies)"
        ) from e

    return {
        "workspace": ws,
        "container_path": f"/workspaces/{workspace_name}",
        "reviewer_url": "/proxy/rookery/",
    }


def main() -> None:
    from mcp.server.fastmcp import FastMCP

    mcp = FastMCP("rookery")

    @mcp.tool()
    def rookery_assemble_exp(
        report_path: str, data_dir: str, phases: list[str], workspace_name: str
    ) -> dict:
        """Assemble an experiment report + its evidence (rounds.jsonl +
        SCORE-<phase>.md per phase) into an OpenScience reviewer workspace.
        Returns the workspace path, its path inside the reviewer container,
        and the dashboard reviewer URL."""
        return assemble_exp(report_path, data_dir, phases, workspace_name)

    mcp.run()


if __name__ == "__main__":  # pragma: no cover
    main()

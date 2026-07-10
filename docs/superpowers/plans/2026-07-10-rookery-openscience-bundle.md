# Rookery / OpenScience Crow Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A one-click Crow extension (`bundles/rookery/`) that ships a Dockerized OpenScience reviewer on `127.0.0.1:3061` (root-origin serving — see deviation 4), a `rookery_assemble_exp` MCP tool, and a dashboard panel — install from the Extensions store, assemble an experiment-audit workspace, open the blind reviewer on it.

**Architecture:** Standard Crow `type:"bundle"`: a `node:22-slim` container running OpenScience behind a vendored in-container header shim (OpenScience hardcodes its listener to `127.0.0.1` — verified in the binary's `listen()` args — so a shim bound to `0.0.0.0:3061` inside the container is structurally required for Docker port mapping, not merely a header fallback); a host-process Python MCP server (fed-gov-data `uv` pattern) exposing `rookery_assemble_exp`; a panel tile + routes (linkding pattern). The rookery-manifest adapter is vendored byte-identical from the private rookery repo with a hash drift-guard. The reviewer UI is exposed by ROOT-ORIGIN serving of `127.0.0.1:3061` (operator's choice: Tailscale Serve HTTPS port / reverse proxy / SSH tunnel), advertised via the optional `ROOKERY_REVIEWER_URL` env — NOT via the gateway's `/proxy/<id>/` subpath (deviation 4).

**Tech Stack:** Docker/compose (crow install engine), Node 22 (in-container), `@synsci/openscience@1.3.2`, Python 3.12 + `uv` + `mcp` (host MCP server), Express router panels.

**Spec:** `docs/superpowers/specs/2026-07-10-rookery-openscience-bundle-design.md`. Recorded deviations:
1. Committed workspaces default is `${HOME}/.crow/data/rookery/workspaces` (crow data convention + compose-scan precedent), not `~/rookery/workspaces`; lab installs override in the form.
2. Host-side env vars are namespaced `ROOKERY_*` (`ROOKERY_MODEL_BASE_URL`, `ROOKERY_MODEL_ID`, `ROOKERY_MODEL_API_KEY`, `ROOKERY_WORKSPACES_DIR`, `ROOKERY_CORS_ORIGINS`). Rationale: `propagateEnvToGateway` (`bundles.js:707-726`) writes every install-form value into the SHARED gateway `.env`, overwriting same-key lines — generic names like `MODEL_BASE_URL` would collide with the next bundle that uses them. Compose maps the prefixed host env onto the container-internal names (`MODEL_BASE_URL` etc.), so the entrypoint/app contract is unchanged.
3. The spec's "model config form pre-filled from Crow's AI env" does NOT exist in the store: `getAiProviderConfig` (`bundles.js:785-797`) only knows `ollama`/`localai` and writes AI config after install; nothing pre-fills install forms from `AI_BASE_URL`. Deviation: the `ROOKERY_MODEL_BASE_URL` field description tells the user where to find their endpoint instead. No form-prefill feature is added (scope).
4. **Root-origin serving replaces `/proxy/rookery/`** (empirical gate result, Kevin decision 2026-07-10). Task 3's subpath gate found 8 root-absolute asset refs in the HTML shell and **775 unique `/assets/...` strings baked into the OpenScience binary** (lazy chunks, fonts); `openscience web` has no base-path flag; the gateway proxy has no SPA rewrite. The app must be served at the root of its own origin. Consequences: NO `webUI` block in the manifest (no `/proxy/<id>/` route is created); panel + MCP tool advertise `ROOKERY_REVIEWER_URL` (optional env; default `http://127.0.0.1:3061/`); README documents the serving options (Tailscale Serve HTTPS port → `127.0.0.1:3061`, reverse proxy at a root origin, or `ssh -L 3061:127.0.0.1:3061`). Auth posture: whatever gates the chosen origin (e.g. tailnet membership) — the dashboard session no longer gates the reviewer UI; the shim's Host/Origin handling is unchanged.

## Global Constraints

- **PUBLIC repo.** No secrets, no lab IPs, no tenant paths in ANY committed file. The copilot endpoint / lab dirs are install-form values only. Never commit a real `.env`.
- **Self-hosted only.** No Atlas login, no cloud-provider config, no share-links. The generated `openscience.json` contains exactly one OpenAI-compatible provider.
- **Port 3061** (host, `127.0.0.1` only) is this bundle's ONLY port; it must be added to `docs/developers/port-allocation.md` in the same PR (CI-enforced).
- **Compose security scan** (`servers/gateway/routes/bundles.js:532` `validateComposeFile`) must pass with zero consent friction: no `privileged`, no `network_mode: host`, no added caps, no docker.sock, bind mounts only `${HOME}/.crow/data/rookery...` style (capstone-tracker precedent).
- **Vendored adapter stays byte-identical** to upstream `~/rookery/adapters/manifest/src/rookery_manifest/` (drift-guard test); new logic lives in `rookery_mcp`, never in the vendored modules.
- Work on branch `feat/rookery-openscience-bundle`; ship as a PR to `origin` (github); never push to `main` directly. Before merging, check check-runs (`/commits/<sha>/check-runs`), not commit-status.
- All work happens in `/home/kh0pp/crow` unless a path says otherwise. `~/rookery` is read-only source material.

## Task ordering

Tasks 1→2 (python), 3 (container), 4 (manifest/registry), 5 (panel) are sequential but independent of any live service. Task 6 (integration + PR + Kevin's one-click acceptance) requires all prior tasks.

---

### Task 1: Vendored adapter + drift guard

Deliverable: `bundles/rookery/` python package scaffold with the rookery-manifest adapter vendored byte-identical, its 9-test suite green, and a drift-guard test pinning the vendored bytes.

**Files:**
- Create: `bundles/rookery/pyproject.toml`
- Create: `bundles/rookery/src/rookery_manifest/` (4 files, copied)
- Create: `bundles/rookery/tests/` (3 test files, copied)
- Create: `bundles/rookery/VENDORED.md`
- Test: `bundles/rookery/tests/test_vendor_drift.py`

**Interfaces:**
- Produces: `rookery_manifest.assemble.Evidence(src, script, args)` dataclass and `assemble_workspace(report_path: str, evidence: list[Evidence], workspace_dir: str) -> str` (raises `FileExistsError` on non-empty workspace, `ValueError` on basename collision); `rookery_manifest.cli.main(argv) -> int` (`exp` subcommand, repeatable `--phase`). Task 2 and Task 5 consume these.

- [ ] **Step 1: Scaffold the package**

Create `bundles/rookery/pyproject.toml`:
```toml
[project]
name = "rookery-bundle"
version = "0.1.0"
description = "Rookery experiment-audit adapter + MCP server for the Crow rookery bundle"
requires-python = ">=3.12"
dependencies = ["mcp>=1.25.0"]

[project.scripts]
rookery-manifest = "rookery_manifest.cli:main"
rookery-mcp = "rookery_mcp.server:main"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/rookery_manifest", "src/rookery_mcp"]
```
Create empty placeholder `bundles/rookery/src/rookery_mcp/__init__.py` (Task 2 fills the module; the pyproject references it now so `uv` resolves once).

Also append two lines to the repo-root `.gitignore` (right after the existing `bundles/*/.env` line at `.gitignore:58`):
```
bundles/*/.venv/
bundles/*/uv.lock
```
(`uv run` creates both inside the bundle dir; they must never be committed, and later git-status checks assume they're ignored.) Include `.gitignore` in this task's commit.

- [ ] **Step 2: Vendor the adapter byte-identical**

```bash
cd ~/crow/bundles/rookery
mkdir -p src/rookery_manifest tests
cp ~/rookery/adapters/manifest/src/rookery_manifest/__init__.py \
   ~/rookery/adapters/manifest/src/rookery_manifest/manifest.py \
   ~/rookery/adapters/manifest/src/rookery_manifest/assemble.py \
   ~/rookery/adapters/manifest/src/rookery_manifest/cli.py \
   src/rookery_manifest/
cp ~/rookery/adapters/manifest/tests/test_manifest.py \
   ~/rookery/adapters/manifest/tests/test_assemble.py \
   ~/rookery/adapters/manifest/tests/test_cli.py \
   tests/
```

- [ ] **Step 3: Record provenance + write the drift-guard test**

Create `bundles/rookery/VENDORED.md`:
```markdown
# Vendored code provenance

`src/rookery_manifest/` + `tests/test_{manifest,assemble,cli}.py` are vendored
BYTE-IDENTICAL from the private rookery repo (`adapters/manifest/`, upstream of
record). Do not patch them here — change upstream, re-copy, and update the
hashes in `tests/test_vendor_drift.py`. New bundle logic belongs in
`src/rookery_mcp/`.
Upstream commit at vendor time: <fill with `git -C ~/rookery rev-parse --short HEAD`>
```
Fill the placeholder on the same edit (run the command, paste the sha).

Create `bundles/rookery/tests/test_vendor_drift.py`:
```python
"""Guard: vendored rookery_manifest modules must stay byte-identical to the
hashes recorded at vendor time (see VENDORED.md). A failure here means someone
patched the vendored copy — change upstream instead, re-copy, re-pin."""
import hashlib
import pathlib

SRC = pathlib.Path(__file__).resolve().parent.parent / "src" / "rookery_manifest"

# sha256 of each vendored file at vendor time — regenerate with:
#   sha256sum src/rookery_manifest/*.py
PINNED = {
    "__init__.py": "<sha256>",
    "manifest.py": "<sha256>",
    "assemble.py": "<sha256>",
    "cli.py": "<sha256>",
}


def test_vendored_files_unmodified():
    for name, want in PINNED.items():
        got = hashlib.sha256((SRC / name).read_bytes()).hexdigest()
        assert got == want, f"{name} drifted from vendored pin — see VENDORED.md"
```
Fill `PINNED` with real hashes: `cd ~/crow/bundles/rookery && sha256sum src/rookery_manifest/*.py`.

- [ ] **Step 4: Run the suite**

Run: `cd ~/crow/bundles/rookery && uv run --with pytest pytest -q`
Expected: **10 passed** (9 vendored + drift guard). If the vendored CLI test count differs from 3, report the actual number rather than forcing it.

- [ ] **Step 5: Commit**

```bash
cd ~/crow
git add .gitignore bundles/rookery/pyproject.toml bundles/rookery/src bundles/rookery/tests bundles/rookery/VENDORED.md
git commit -m "feat(rookery): vendor rookery-manifest adapter with drift guard"
```

---

### Task 2: MCP server (`rookery_mcp`) + run.sh

Deliverable: a host-process MCP server exposing `rookery_assemble_exp`, TDD'd through its pure core function; spawnable via the fed-gov-data `run.sh` convention.

**Files:**
- Create: `bundles/rookery/src/rookery_mcp/server.py`
- Create: `bundles/rookery/run.sh`
- Test: `bundles/rookery/tests/test_mcp_core.py`

**Interfaces:**
- Consumes: `Evidence`, `assemble_workspace` from Task 1 (signatures above).
- Produces: `assemble_exp(report_path, data_dir, phases, workspace_name, workspaces_dir) -> dict` (pure core, returns `{"workspace","container_path","reviewer_url"}` or raises `ValueError` with a human message; `reviewer_url` = `ROOKERY_REVIEWER_URL` env else `http://127.0.0.1:3061/` — deviation 4); MCP tool `rookery_assemble_exp` wrapping it; `main()` entry point (`rookery-mcp` script). The manifest's `server{}` block (Task 4) and panel routes (Task 5) rely on `run.sh` and the workspace layout.

- [ ] **Step 1: Write the failing test**

Create `bundles/rookery/tests/test_mcp_core.py`:
```python
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
        report_path=str(report), data_dir=str(data), phases=["p1"],
        workspace_name="audit-p1", workspaces_dir=str(ws_root),
    )

    ws = ws_root / "audit-p1"
    assert out["workspace"] == str(ws)
    assert out["container_path"] == "/workspaces/audit-p1"
    assert out["reviewer_url"] == "http://127.0.0.1:3061/"  # ROOKERY_REVIEWER_URL overrides (deviation 4)
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/crow/bundles/rookery && uv run --with pytest pytest tests/test_mcp_core.py -q`
Expected: FAIL — `ImportError`/`ModuleNotFoundError` on `rookery_mcp.server`.

- [ ] **Step 3: Implement**

Create `bundles/rookery/src/rookery_mcp/server.py`:
```python
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
        Evidence(src=rounds, script="zoo-round.sh",
                 args={"phases": phases,
                       "note": "append-only ground-truth round rows; the file spans all phases"}),
    ] + [
        Evidence(src=path, script="zoo-score.py", args={"--phase": phase})
        for phase, path in scores
    ]

    os.makedirs(root, exist_ok=True)
    target = os.path.join(root, workspace_name)
    try:
        ws = assemble_workspace(report, evidence, target)
    except FileExistsError as e:
        raise ValueError(f"workspace not empty: {target} — remove it first (it contains only copies)") from e

    return {
        "workspace": ws,
        "container_path": f"/workspaces/{workspace_name}",
        # Root-origin serving (deviation 4): the operator's own URL when set,
        # else the local bind the README's serving/tunnel options point at.
        "reviewer_url": os.environ.get("ROOKERY_REVIEWER_URL") or "http://127.0.0.1:3061/",
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
```

Create `bundles/rookery/run.sh` (fed-gov-data pattern):
```bash
#!/bin/bash
set -a
# Optional secret-override hook: NOTHING creates this file — a user may
# hand-provision it to override env without touching the gateway .env.
[ -f "$HOME/.crow/env/rookery.env" ] && source "$HOME/.crow/env/rookery.env"
set +a
cd "$(dirname "$0")"
exec "$HOME/.local/bin/uv" run --quiet rookery-mcp
```
Then: `chmod +x bundles/rookery/run.sh`

- [ ] **Step 4: Run the full suite**

Run: `cd ~/crow/bundles/rookery && uv run --with pytest pytest -q`
Expected: **15 passed** (10 from Task 1 + 5 new). Also smoke the entry point resolves: `uv run python -c "from rookery_mcp.server import main; print('ok')"` → `ok`.

- [ ] **Step 5: Commit**

```bash
cd ~/crow
git add bundles/rookery/src/rookery_mcp bundles/rookery/tests/test_mcp_core.py bundles/rookery/run.sh
git commit -m "feat(rookery): rookery_assemble_exp MCP server (host uv process)"
```

---

### Task 3: Container — Dockerfile, shim, entrypoint, compose

Deliverable: `docker compose build && up` yields a reachable reviewer on `127.0.0.1:3061` with the correct header behavior, config generated from env.

**Files:**
- Create: `bundles/rookery/Dockerfile`
- Create: `bundles/rookery/host-shim.mjs`
- Create: `bundles/rookery/entrypoint.sh`
- Create: `bundles/rookery/docker-compose.yml`
- Create: `bundles/rookery/.env.example`

**Interfaces:**
- Consumes: nothing from earlier tasks (independent of the python package).
- Produces: host port `127.0.0.1:3061`; container mounts `/workspaces` (Task 2's `container_path` contract) and `/data` (HOME). Env contract — HOST side (install form / `.env`): `ROOKERY_MODEL_BASE_URL` (required), `ROOKERY_MODEL_ID`, `ROOKERY_MODEL_API_KEY`, `ROOKERY_CORS_ORIGINS`, `ROOKERY_WORKSPACES_DIR`; compose maps these onto the CONTAINER-internal names `MODEL_BASE_URL`/`MODEL_ID`/`MODEL_API_KEY`/`ROOKERY_CORS_ORIGINS` that the entrypoint reads. Task 4's manifest and Task 6's verification rely on the host names verbatim.

- [ ] **Step 1: Vendor + adapt the header shim**

```bash
cp ~/rookery/scripts/openscience-host-proxy.mjs ~/crow/bundles/rookery/host-shim.mjs
```
Then edit `host-shim.mjs` — three changes (keep the rest byte-identical; it is tested code):

(a) Replace the LISTEN/BACKEND constants block with:
```js
const LISTEN = { host: process.env.SHIM_LISTEN_HOST || "127.0.0.1", port: Number(process.argv[2] ?? 4097) };
const BACKEND = { host: "127.0.0.1", port: Number(process.argv[3] ?? 4096) };
const BACKEND_HOST_HEADER = `${BACKEND.host}:${BACKEND.port}`;
// When no CORS origins are configured for the app (ROOKERY_CORS_ORIGINS empty),
// strip Origin too: the Crow gateway session-gates every request, so the app's
// own origin whitelist adds friction without adding a boundary. When origins
// ARE configured, pass Origin through and let the app enforce them.
const STRIP_ORIGIN = !(process.env.ROOKERY_CORS_ORIGINS || "").trim();
```
(b) In the plain-HTTP handler, after `delete headers["sec-fetch-site"];` add:
```js
  if (STRIP_ORIGIN) delete headers["origin"];
```
(c) In the upgrade handler's rawHeaders loop, extend the skip condition:
```js
      if (key === "sec-fetch-site" || (STRIP_ORIGIN && key === "origin")) continue;
```
Update the header comment block to describe the container role (listens on `SHIM_LISTEN_HOST` for Docker port mapping; OpenScience pins its own listener to 127.0.0.1 in-container, which is why this shim exists — structurally required, not a fallback) and note the provenance (vendored from rookery `scripts/openscience-host-proxy.mjs`, adapted). Also document the origin-strip security posture in that comment, in DEVIATION-4 terms (the crow dashboard session does NOT gate this endpoint): the upstream shim warns stripping Origin "would disable its CSRF protection"; with `ROOKERY_CORS_ORIGINS` empty the strip is acceptable for LOCALHOST/TUNNEL use because the port binds `127.0.0.1` only and the operator's serving layer is the access boundary. When serving at a shared origin (Tailscale Serve HTTPS port, reverse proxy), operators SHOULD set `ROOKERY_CORS_ORIGINS` to that origin — then Origin passes through and the app's own CSRF whitelist is enforced against drive-by cross-site requests from other pages in a browser that can reach that origin. Residual exposure: any local process can hit `127.0.0.1:3061` unauthenticated (consistent with other crow bundles).
Verify: `node --check ~/crow/bundles/rookery/host-shim.mjs` → no output.

- [ ] **Step 2: Entrypoint**

Create `bundles/rookery/entrypoint.sh`:
```sh
#!/bin/sh
# Generate openscience.json from env, start OpenScience (loopback-only inside
# the container, by its own hardcoded listener), front it with the header shim
# bound to 0.0.0.0:3061 so Docker port mapping works. Self-hosted only: the
# generated config contains exactly one OpenAI-compatible provider; no Atlas.
set -eu

: "${MODEL_BASE_URL:?MODEL_BASE_URL is required (OpenAI-compatible endpoint)}"
MODEL_ID="${MODEL_ID:-local-model}"

# First-boot resilience: the Docker engine creates missing bind-mount sources
# as root:root, so $HOME (/data) can arrive unwritable by uid 1000 on a fresh
# one-click install. Nothing HAS to persist — the config is regenerated from
# env every boot — so fall back to an ephemeral HOME instead of crash-looping.
if [ ! -w "$HOME" ]; then
  echo "WARN: $HOME not writable (root-owned bind mount) — using ephemeral HOME=/tmp/openscience-home; chown the host data dir to uid 1000 for persistent sessions" >&2
  HOME=/tmp/openscience-home
  export HOME
fi
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/openscience"
mkdir -p "$CONFIG_DIR"
mkdir -p /workspaces 2>/dev/null || true  # read path; content arrives via the mount

cat > "$CONFIG_DIR/openscience.json" <<EOF
{
  "model": "crow-local/${MODEL_ID}",
  "provider": {
    "crow-local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Crow Local",
      "options": { "baseURL": "${MODEL_BASE_URL}", "apiKey": "${MODEL_API_KEY:-local}" },
      "models": { "${MODEL_ID}": { "name": "${MODEL_ID}" } }
    }
  }
}
EOF

cd /workspaces
# Build the argv list so EACH space-separated origin gets its own --cors flag
# (${VAR:+--cors ${VAR}} would word-split into one --cors + stray positionals).
set -- --port 4096
for o in ${ROOKERY_CORS_ORIGINS:-}; do set -- "$@" --cors "$o"; done
openscience "$@" &
SHIM_LISTEN_HOST=0.0.0.0 exec node /app/host-shim.mjs 3061 4096
```
Note: no TERM/INT trap — `exec` replaces the shell so a trap would be dead code; compose's `init: true` (tini) handles signal forwarding and reaping for both processes.

- [ ] **Step 3: Dockerfile**

Create `bundles/rookery/Dockerfile`:
```dockerfile
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @synsci/openscience@1.3.2
COPY host-shim.mjs /app/host-shim.mjs
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh \
    && mkdir -p /data /workspaces \
    && chown -R 1000:1000 /data /workspaces /app
ENV HOME=/data
EXPOSE 3061
USER 1000:1000
ENTRYPOINT ["/app/entrypoint.sh"]
```

- [ ] **Step 4: Compose + env example**

Create `bundles/rookery/docker-compose.yml` (capstone-tracker shape; must pass `validateComposeFile` with zero consent friction):
```yaml
services:
  rookery:
    build: .
    container_name: crow-rookery
    environment:
      # host env is namespaced ROOKERY_* (shared gateway .env — see plan
      # deviations); container-internal names stay generic for the entrypoint
      MODEL_BASE_URL: ${ROOKERY_MODEL_BASE_URL:?ROOKERY_MODEL_BASE_URL is required}
      MODEL_ID: ${ROOKERY_MODEL_ID:-local-model}
      MODEL_API_KEY: ${ROOKERY_MODEL_API_KEY:-local}
      ROOKERY_CORS_ORIGINS: ${ROOKERY_CORS_ORIGINS:-}
    volumes:
      - ${HOME}/.crow/data/rookery:/data
      - ${ROOKERY_WORKSPACES_DIR:-${HOME}/.crow/data/rookery/workspaces}:/workspaces
    ports:
      - "127.0.0.1:3061:3061"
    extra_hosts:
      - "host.docker.internal:host-gateway"   # so a host-local model endpoint is reachable on Linux
    init: true
    mem_limit: 1g
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://localhost:3061/ || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 45s
```

Create `bundles/rookery/.env.example` (generic placeholders ONLY — public repo):
```
# OpenAI-compatible endpoint the reviewer uses (REQUIRED). For a model server
# running on the Docker host, host.docker.internal works (mapped via
# extra_hosts) when the server listens on a non-loopback interface.
ROOKERY_MODEL_BASE_URL=http://host.docker.internal:8000/v1
# Model id as reported by the endpoint's /v1/models
ROOKERY_MODEL_ID=local-model
# Most local servers ignore this; SDK requires non-empty
ROOKERY_MODEL_API_KEY=local
# Optional: space-separated browser origins to allow via the app's own CORS
# whitelist (e.g. your serving origin). Empty = shim strips Origin (the
# serving layer you put in front of 127.0.0.1:3061 is the boundary).
ROOKERY_CORS_ORIGINS=
# Host dir where audit workspaces are assembled (shared with the MCP tool)
ROOKERY_WORKSPACES_DIR=~/.crow/data/rookery/workspaces
# Where the reviewer UI is reachable on YOUR deployment (root-origin serving:
# a Tailscale Serve HTTPS port, a reverse proxy, or an ssh -L tunnel to
# 127.0.0.1:3061). Shown by the panel and the MCP tool. Empty = local default.
ROOKERY_REVIEWER_URL=
```

- [ ] **Step 5: Build and boot**

```bash
cd ~/crow/bundles/rookery
mkdir -p ~/.crow/data/rookery/workspaces
printf 'ROOKERY_MODEL_BASE_URL=http://127.0.0.1:9/v1\n' > .env   # unreachable model is fine for boot
docker compose build 2>&1 | tail -3
docker compose up -d && sleep 12 && docker compose ps
```
Expected: image builds; container `crow-rookery` running (healthy after start_period; the model endpoint being unreachable must NOT prevent the web UI from serving).

- [ ] **Step 6: Header/origin verification matrix (the spec's empirical gate)**

```bash
curl -sm5 -o /dev/null -w 'plain: %{http_code}\n'                 http://127.0.0.1:3061/
curl -sm5 -o /dev/null -w 'gw-host: %{http_code}\n' -H 'Host: crow.example.ts.net:8444'  http://127.0.0.1:3061/
curl -sm5 -o /dev/null -w 'cross-nav: %{http_code}\n' -H 'Sec-Fetch-Site: cross-site'    http://127.0.0.1:3061/
curl -sm5 -o /dev/null -w 'dash-origin: %{http_code}\n' -H 'Origin: https://crow.example.ts.net:8444' http://127.0.0.1:3061/
```
Expected: **all four MATCH and are non-4xx** — 200, or a consistent 30x if the UI redirects `/`; what matters is that the header variants behave identically to plain (shim rewrites Host, strips Sec-Fetch-Site, and — with `ROOKERY_CORS_ORIGINS` empty — strips Origin). Record the matrix output in the Task-6 verification notes.

**Subpath-proxy gate — RESOLVED (2026-07-10):** the gate FIRED on first run (8 root-absolute asset refs in the HTML shell; controller follow-up found 775 unique `/assets/...` strings baked in the binary). Kevin decision: **root-origin serving** (deviation 4). No re-run needed — do not re-litigate. Clean up:
```bash
docker compose down && rm .env
```
(`.env` is never committed — `.gitignore:58` covers `bundles/*/.env`; Step 7's plain `docker run` doesn't read it.)

- [ ] **Step 7: First-install resilience check (root-owned bind mounts)**

A store one-click install on a fresh host hits bind-mount sources that don't exist yet — the Docker engine creates them **root:root**, and the container runs `USER 1000`. Prove the ephemeral-HOME fallback works by running the built image against fresh, nonexistent host dirs:
```bash
cd ~/crow/bundles/rookery
SCRATCH=/tmp/rk-fresh-$(date +%s)
mkdir "$SCRATCH"   # user-owned parent; docker creates data/ ws/ inside it as root
docker run -d --name rk-fresh-test --init \
  -v $SCRATCH/data:/data -v $SCRATCH/ws:/workspaces \
  -e MODEL_BASE_URL=http://127.0.0.1:9/v1 \
  -p 127.0.0.1:3061:3061 rookery-rookery
sleep 8
curl -sm5 -o /dev/null -w 'fresh-install: %{http_code}\n' http://127.0.0.1:3061/
docker logs rk-fresh-test 2>&1 | grep -i 'not writable'   # the WARN fallback fired
docker rm -f rk-fresh-test
# scratch dirs are root-owned; remove them via the image (no sudo)
docker run --rm --user 0 -v $SCRATCH:/s --entrypoint rm rookery-rookery -rf /s/data /s/ws
rmdir $SCRATCH
```
Expected: `fresh-install: 200` (or the same non-4xx code as Step 6's matrix) and the WARN line in the logs. If the container crash-loops instead, the entrypoint fallback is broken — fix it before committing. Confirm `git status` shows the five new bundle files and nothing else unexpected — in particular no `.env`, `.venv/`, or `uv.lock` (all gitignored since Task 1).

- [ ] **Step 8: Commit**

```bash
cd ~/crow
git add bundles/rookery/Dockerfile bundles/rookery/host-shim.mjs bundles/rookery/entrypoint.sh bundles/rookery/docker-compose.yml bundles/rookery/.env.example
git commit -m "feat(rookery): dockerized OpenScience reviewer (node22 + header shim on 3061)"
```

---

### Task 4: Manifest, port reservation, in-repo registry

Deliverable: the bundle is a valid, discoverable Crow add-on: `manifest.json` (schema-valid), port 3061 reserved, `registry/add-ons.json` entry.

**Files:**
- Create: `bundles/rookery/manifest.json`
- Modify: `docs/developers/port-allocation.md` (one row, numeric order)
- Modify: `registry/add-ons.json` (one entry appended to `add-ons`)

**Interfaces:**
- Consumes: env names + port from Task 3, `run.sh` from Task 2, panel paths from Task 5 (declared here; Task 5 creates the files — install tolerates the order because everything ships in one PR).

- [ ] **Step 1: Write the manifest**

Create `bundles/rookery/manifest.json`:
```json
{
  "id": "rookery",
  "name": "Rookery Reviewer",
  "version": "0.1.0",
  "description": "Self-hosted OpenScience reviewer + experiment-audit workspace assembler — audit a report's numeric claims against its registered evidence, on your own local model",
  "type": "bundle",
  "author": "kh0pper",
  "category": "ai",
  "tags": ["research", "audit", "provenance", "openscience", "self-hosted"],
  "icon": "search",
  "docker": { "composefile": "docker-compose.yml" },
  "server": {
    "command": "./run.sh",
    "args": [],
    "envKeys": ["ROOKERY_WORKSPACES_DIR", "ROOKERY_REVIEWER_URL", "UV_NO_CACHE"]
  },
  "panel": "panel/rookery.js",
  "panelRoutes": "panel/routes.js",
  "requires": { "env": ["ROOKERY_MODEL_BASE_URL"], "min_ram_mb": 512, "min_disk_mb": 900 },
  "env_vars": [
    { "name": "ROOKERY_MODEL_BASE_URL", "description": "OpenAI-compatible endpoint for the reviewer model (e.g. a local llama.cpp/vLLM server; find your configured endpoint in Crow's AI settings). For a server on the Docker host use http://host.docker.internal:<port>/v1", "required": true },
    { "name": "ROOKERY_MODEL_ID", "description": "Model id as reported by the endpoint's /v1/models", "default": "local-model", "required": true },
    { "name": "ROOKERY_MODEL_API_KEY", "description": "API key if the endpoint needs one (local servers usually ignore it)", "default": "local", "required": false, "secret": true },
    { "name": "ROOKERY_WORKSPACES_DIR", "description": "Host directory where audit workspaces are assembled (shared by the reviewer and the assemble tool)", "default": "~/.crow/data/rookery/workspaces", "required": false },
    { "name": "ROOKERY_CORS_ORIGINS", "description": "Space-separated browser origins for the app's own CORS/CSRF whitelist. RECOMMENDED: set to your serving origin when the reviewer is served beyond localhost. Empty = shim strips Origin (fine for tunnel/localhost use; disables the app's origin check)", "required": false },
    { "name": "ROOKERY_REVIEWER_URL", "description": "Where the reviewer UI is reachable on your deployment (serve 127.0.0.1:3061 at a ROOT origin: Tailscale Serve HTTPS port, reverse proxy, or ssh -L tunnel). Shown by the panel and the assemble tool", "required": false },
    { "name": "UV_NO_CACHE", "description": "Disable uv's download cache for the host MCP process (prevents multi-GB cache growth)", "default": "1", "required": false }
  ],
  "ports": [3061],
  "notes": "Self-hosted only — never configure the vendor's Atlas/cloud layer. The reviewer runs entirely on the endpoint you provide. Assembled workspaces contain COPIES of your report + evidence; originals are never modified. NO webUI block on purpose: the app cannot live behind the gateway's /proxy/<id>/ subpath (root-absolute asset paths baked in its binary) — serve 127.0.0.1:3061 at a root origin and set ROOKERY_REVIEWER_URL (see README).",
  "official": false
}
```
Note on `env_vars` defaults: `bundles.js`'s defaults loop bakes EVERY `env_vars` default (not just `envKeys`) into the world-readable `mcp-addons.json` — fine for these non-secret defaults, but never add an env_var whose DEFAULT is a secret.

Note on `server.command`: `"./run.sh"` is deliberate — `bundles.js:1150-1156` registers the command VERBATIM into `mcp-addons.json`, and `proxy.js:144` spawns addons with `cwd: ~/.crow/bundles/rookery` (the installed copy). A slash-containing relative command resolves against that spawn cwd (POSIX exec after chdir), so it works for any user with zero tenant paths in the public repo. Never use an absolute home path here.

- [ ] **Step 2: Verify the relative-command spawn actually resolves**

```bash
cd /tmp && node -e "
const { spawn } = require('child_process');
const p = spawn('./run.sh', [], { cwd: process.env.HOME + '/crow/bundles/rookery', stdio: 'ignore' });
p.on('spawn', () => { console.log('spawn ok'); p.kill('SIGTERM'); });
p.on('error', (e) => { console.error('spawn FAILED:', e.message); process.exit(1); });
"
```
Expected: `spawn ok` (run from `/tmp` on purpose — proves resolution uses the `cwd` option, not the caller's directory).

- [ ] **Step 3: Validate against the schema**

```bash
cd ~/crow && node -e "
const Ajv = require('ajv');
const fs = require('fs');
const ajv = new Ajv({allowUnionTypes: true, strict: false});
const schema = JSON.parse(fs.readFileSync('registry/manifest.schema.json','utf8'));
const m = JSON.parse(fs.readFileSync('bundles/rookery/manifest.json','utf8'));
const ok = ajv.validate(schema, m);
console.log(ok ? 'VALID' : JSON.stringify(ajv.errors, null, 1));
"
```
Expected: `VALID`. (If `ajv` isn't in the gateway's node_modules, run from `servers/gateway/` where it is, or `npm ls ajv` to locate it.)

- [ ] **Step 4: Ground `min_disk_mb` in the real image**

The spec left `min_disk_mb` an open item; don't ship a guess. Task 3 built the image:
```bash
docker image ls rookery-rookery --format '{{.Size}}'
```
Set `min_disk_mb` to image size + ~200 MB headroom (round up to a clean number). If that differs from 900, update `manifest.json` before the registry copy in Step 6 inherits it.

- [ ] **Step 5: Reserve the port**

In `docs/developers/port-allocation.md`, insert in numeric order in the allocation table:
```
| 3061 | 127.0.0.1 | rookery (OpenScience reviewer) | feat/rookery-openscience-bundle |
```

- [ ] **Step 6: Registry entry**

Append the CURRENT contents of `bundles/rookery/manifest.json` (i.e. including any Step-4 `min_disk_mb` correction — do not re-type Step 1's JSON) to the `add-ons` array in `registry/add-ons.json`, keeping the file's existing formatting. Validate the file still parses: `node -e "JSON.parse(require('fs').readFileSync('registry/add-ons.json','utf8')); console.log('parses')"`.

- [ ] **Step 7: Commit**

```bash
cd ~/crow
git add bundles/rookery/manifest.json docs/developers/port-allocation.md registry/add-ons.json
git commit -m "feat(rookery): manifest + port 3061 reservation + registry entry"
```

---

### Task 5: Panel tile + routes

Deliverable: a dashboard tile listing assembled workspaces with an assemble form and "Open reviewer" links; backend routes that reuse the same adapter (via `uv run rookery-manifest exp`).

**Files:**
- Create: `bundles/rookery/panel/rookery.js`
- Create: `bundles/rookery/panel/routes.js`

**Interfaces:**
- Consumes: `rookery-manifest exp` CLI (Task 1; flags `--report --data-dir --phase(repeatable) --workspace`, exit 0/2, `FileExistsError` traceback on non-empty target), `ROOKERY_WORKSPACES_DIR` + `ROOKERY_REVIEWER_URL` env (Task 3 host names; deviation 4).
- Produces: `GET /api/rookery/workspaces`, `POST /api/rookery/assemble` (JSON `{report, dataDir, phases[], name}`); panel registered as `id:"rookery"`, route `/dashboard/rookery`.

- [ ] **Step 1: Backend routes**

Create `bundles/rookery/panel/routes.js`:
```js
import { Router, json } from "express";
import { execFile } from "node:child_process";
import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const WORKSPACES = () =>
  (process.env.ROOKERY_WORKSPACES_DIR || join(os.homedir(), ".crow/data/rookery/workspaces"))
    .replace(/^~(?=\/)/, os.homedir());
// Root-origin serving (plan deviation 4): the reviewer is NOT behind /proxy/<id>/.
// Scheme allowlist: the value lands in anchor hrefs in the tile — a non-http(s)
// value (e.g. javascript:) must never reach the DOM, so fall back to the default.
const REVIEWER_URL = () => {
  const u = process.env.ROOKERY_REVIEWER_URL || "";
  return /^https?:\/\//i.test(u) ? u : "http://127.0.0.1:3061/";
};
const BUNDLE_DIR = () => join(os.homedir(), ".crow/bundles/rookery");
const UV = () => join(os.homedir(), ".local/bin/uv");
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export default function rookeryRouter(authMiddleware) {
  const router = Router();
  router.use("/api/rookery", json());

  router.get("/api/rookery/workspaces", authMiddleware, (req, res) => {
    const root = WORKSPACES();
    if (!existsSync(root)) return res.json({ workspaces: [], reviewerUrl: REVIEWER_URL() });
    const workspaces = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const p = join(root, d.name);
        return {
          name: d.name,
          mtime: statSync(p).mtimeMs,
          hasManifest: existsSync(join(p, "_script_manifest.jsonl")),
          containerPath: `/workspaces/${d.name}`,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ workspaces, reviewerUrl: REVIEWER_URL() });
  });

  router.post("/api/rookery/assemble", authMiddleware, (req, res) => {
    const { report, dataDir, phases, name } = req.body || {};
    if (typeof report !== "string" || typeof dataDir !== "string" || !report || !dataDir)
      return res.status(400).json({ error: "report and dataDir are required" });
    if (!Array.isArray(phases) || phases.length === 0 || !phases.every((p) => typeof p === "string" && p))
      return res.status(400).json({ error: "phases must be a non-empty string array" });
    if (typeof name !== "string" || !NAME_RE.test(name))
      return res.status(400).json({ error: "name must be a plain directory name" });

    const workspace = join(WORKSPACES(), name);
    const args = ["run", "--quiet", "rookery-manifest", "exp",
      "--report", report, "--data-dir", dataDir,
      ...phases.flatMap((p) => ["--phase", p]),
      "--workspace", workspace];
    execFile(UV(), args, { cwd: BUNDLE_DIR(), timeout: 60_000 }, (err, stdout, stderr) => {
      if (err)
        return res.status(400).json({ error: (stderr || err.message).trim().slice(0, 500) });
      res.json({ workspace, containerPath: `/workspaces/${name}`, reviewerUrl: REVIEWER_URL() });
    });
  });

  return router;
}
```

- [ ] **Step 2: Tile**

Create `bundles/rookery/panel/rookery.js` (linkding pattern: config object, dynamic imports, client JS talks to the Task-5 routes):
```js
export default {
  id: "rookery",
  name: "Rookery Reviewer",
  icon: "search",
  route: "/dashboard/rookery",
  navOrder: 62,
  category: "ai",
  async handler(req, res, { layout }) {
    const content = `
<div class="panel-page">
  <h2>Rookery Reviewer</h2>
  <p>Assemble an experiment report + its evidence into an audit workspace, then
     open the blind reviewer on it.
     <a id="rk-reviewer-link" href="http://127.0.0.1:3061/" target="_blank" rel="noopener">Open reviewer ↗</a>
     <small>(served at your ROOKERY_REVIEWER_URL — see the bundle README for
     root-origin serving options)</small></p>
  <h3>Assemble a workspace</h3>
  <form id="rk-form">
    <label>Report path <input name="report" required placeholder="/path/to/REPORT.md"></label>
    <label>Data dir <input name="dataDir" required placeholder="/path/to/data-dir"></label>
    <label>Phases (space-separated) <input name="phases" required placeholder="exp-1 exp-1-baseline"></label>
    <label>Workspace name <input name="name" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}"></label>
    <button type="submit">Assemble</button>
  </form>
  <pre id="rk-result"></pre>
  <h3>Workspaces</h3>
  <ul id="rk-list"><li>Loading…</li></ul>
</div>
<script>
(function () {
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  function refresh() {
    fetch("/api/rookery/workspaces").then(function (r) { return r.json(); }).then(function (d) {
      var url = d.reviewerUrl || "http://127.0.0.1:3061/";
      document.getElementById("rk-reviewer-link").href = url;
      var el = document.getElementById("rk-list");
      if (!d.workspaces.length) { el.innerHTML = "<li>None yet.</li>"; return; }
      el.innerHTML = d.workspaces.map(function (w) {
        return "<li><code>" + esc(w.name) + "</code>" +
          (w.hasManifest ? "" : " (no manifest!)") +
          " — open <a href='" + esc(url) + "' target='_blank' rel='noopener'>reviewer</a>" +
          " and pick <code>" + esc(w.containerPath) + "</code></li>";
      }).join("");
    });
  }
  document.getElementById("rk-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var f = new FormData(e.target);
    fetch("/api/rookery/assemble", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        report: f.get("report"), dataDir: f.get("dataDir"),
        phases: String(f.get("phases")).trim().split(/\\s+/), name: f.get("name"),
      }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      document.getElementById("rk-result").textContent = JSON.stringify(d, null, 2);
      refresh();
    });
  });
  refresh();
})();
</script>`;
    res.send(layout({ title: "Rookery Reviewer", content }));
  },
};
```

- [ ] **Step 3: Syntax + route-shape check**

```bash
node --check ~/crow/bundles/rookery/panel/routes.js && node --check ~/crow/bundles/rookery/panel/rookery.js && echo OK
cd ~/crow/servers/gateway && node -e "
import('../../bundles/rookery/panel/routes.js').then(async (m) => {
  const router = m.default((req, res, next) => next());
  console.log('router ok:', typeof router === 'function');
});
"
```
Expected: `OK` then `router ok: true`. (Node resolves `express` from the IMPORTING FILE's path upward — there is no `servers/gateway/node_modules`; it lands on the repo-root `node_modules`, the same modules the gateway itself uses. The `cd` is cosmetic.)

- [ ] **Step 4: Commit**

```bash
cd ~/crow
git add bundles/rookery/panel
git commit -m "feat(rookery): dashboard panel (assemble form + workspace list + reviewer links)"
```

---

### Task 6: Integration verification, remote registry, PR, Kevin acceptance

Deliverable: the whole bundle verified working together locally; the remote `crow-addons` registry entry staged; a PR opened; a one-click acceptance checklist handed to Kevin.

**Files:**
- Create: `bundles/rookery/README.md`
- Modify: `~/crow-addons/registry.json` (separate repo — clone if absent)

**Interfaces:** consumes everything above.

- [ ] **Step 1: Full local integration pass**

```bash
cd ~/crow/bundles/rookery
uv run --with pytest pytest -q                       # expect 17 passed (15 planned + 2 review-fix regression tests)
printf 'ROOKERY_MODEL_BASE_URL=http://127.0.0.1:9/v1\n' > .env
docker compose up -d --build && sleep 12
# assemble a real workspace with the MCP core via a scratch fixture:
python3 - <<'EOF'
import os, tempfile, subprocess, sys, json, pathlib
root = tempfile.mkdtemp()
data = pathlib.Path(root, "d"); data.mkdir()
(data/"rounds.jsonl").write_text('{"case":"S1"}\n'); (data/"SCORE-s.md").write_text("1/1\n")
rep = pathlib.Path(root, "R.md"); rep.write_text("# r\n")
out = subprocess.run([os.path.expanduser("~/.local/bin/uv"), "run", "--quiet", "rookery-manifest", "exp",
  "--report", str(rep), "--data-dir", str(data), "--phase", "s",
  "--workspace", os.path.expanduser("~/.crow/data/rookery/workspaces/smoke-it")],
  capture_output=True, text=True)
print(out.returncode, out.stdout.strip(), out.stderr.strip())
EOF
docker compose exec rookery ls /workspaces/smoke-it   # the container sees it
curl -sm5 -o /dev/null -w 'ui: %{http_code}\n' http://127.0.0.1:3061/
docker compose down && rm .env
rm -rf ~/.crow/data/rookery/workspaces/smoke-it
```
Expected: 17 passed; assembly exit 0; `docker compose exec` lists the report + manifest inside the container; `ui: 200`.

- [ ] **Step 2: Bundle README**

Create `bundles/rookery/README.md` covering: what it is (one paragraph), the three parts, install (store one-click; the `ROOKERY_*` env form fields and what to enter for a local llama.cpp/vLLM endpoint, including the `host.docker.internal` note for host-local servers), **root-origin serving (deviation 4)** — WHY there is no `/proxy/rookery/` (root-absolute asset paths baked in the app's binary; 775 refs) and the three serving options (Tailscale Serve HTTPS port → `127.0.0.1:3061`; reverse proxy at a root origin; `ssh -L 3061:127.0.0.1:3061` tunnel), each setting `ROOKERY_REVIEWER_URL` so the panel/tool links work — the workspaces-volume model (copies only), the self-hosted-only note (never Atlas), the security posture of the shim (why Origin is stripped when `ROOKERY_CORS_ORIGINS` is empty; the port binds 127.0.0.1 so YOUR serving layer is the auth boundary — the crow dashboard session does NOT gate the reviewer UI; SET `ROOKERY_CORS_ORIGINS` to your serving origin whenever the reviewer is served beyond localhost, restoring the app's own CSRF origin whitelist; any local process can reach `127.0.0.1:3061` unauthenticated, worth stating for an app that runs an LLM agent over mounted files; the panel's assemble form accepts arbitrary host paths for report/data-dir BY DESIGN — it copies operator-named files into workspaces; it runs behind the dashboard session and is single-operator software), and troubleshooting (model endpoint unreachable → UI still loads, pick-model errors surface in-session; non-empty workspace → remove and re-assemble; root-owned data dir → ephemeral-HOME WARN in logs, chown to uid 1000 for persistence). Write real prose, ~40-60 lines, no placeholders.

- [ ] **Step 3: Stage the crow-addons entry (discovery-only; NEVER push)**

Reality check first: the remote registry is a LISTING feed only. `fetchCommunityStore`/`fetchRegistryData` (`servers/gateway/dashboard/panels/extensions/data-queries.js`) fetch `registry.json` raw from GitHub to populate store tiles, but `POST /bundles/api/install` requires the bundle directory to exist in the deployment's OWN crow checkout (`bundles.js:897-900`, `sourceDir = join(APP_BUNDLES, id)`) — there is no fetch-on-install. So this step makes the tile *visible* on other deployments; installing there still requires the merged crow PR pulled into that deployment's checkout.

```bash
[ -d ~/crow-addons ] || git clone https://github.com/kh0pper/crow-addons ~/crow-addons
cd ~/crow-addons && git checkout main && git pull && git checkout -b add-rookery
# convention: every registry entry ships its full bundle directory in this repo
rsync -a --exclude '.env' --exclude '.venv' --exclude '__pycache__' --exclude 'uv.lock' \
  ~/crow/bundles/rookery/ ~/crow-addons/rookery/
```
Append the same manifest object from Task 4 (with the Step-4-corrected `min_disk_mb`) to `registry.json`'s `add-ons` array (the file is `{"version": 2, "add-ons": [...]}` — verified). Validate parse (`node -e "JSON.parse(...)"`) , commit BOTH the `rookery/` directory and the registry entry on branch `add-rookery`, and **DO NOT push** (Kevin pushes/PRs it).

- [ ] **Step 4: Commit README + open the crow PR**

```bash
cd ~/crow
git add bundles/rookery/README.md
git commit -m "docs(rookery): bundle README"
git push origin feat/rookery-openscience-bundle
gh pr create --repo kh0pper/crow --base main --head feat/rookery-openscience-bundle \
  --title "feat: rookery — OpenScience reviewer + audit-workspace bundle (one-click)" \
  --body "$(cat <<'EOF'
One-click extension: Dockerized OpenScience reviewer (node22 + header shim, 127.0.0.1:3061, root-origin serving via ROOKERY_REVIEWER_URL — the app's binary bakes root-absolute asset paths, so no /proxy subpath; see plan deviation 4), rookery_assemble_exp MCP tool (host uv process), dashboard panel. Port 3061 reserved in port-allocation.md; registry entry included; compose passes the security scan with zero consent friction. Spec: docs/superpowers/specs/2026-07-10-rookery-openscience-bundle-design.md (deviations recorded in the plan).
EOF
)"
```
Then verify CI via check-runs (NOT commit-status): `gh api repos/kh0pper/crow/commits/$(git rev-parse HEAD)/check-runs --jq '.check_runs[] | .name + ": " + .conclusion'` — the port CI's check-run is named `check-ports` (the job id, not the workflow name); wait for it (and any others) to be `success` before telling Kevin it's mergeable. Do not attribute Claude as co-author anywhere.

- [ ] **Step 5: Hand Kevin the acceptance checklist (STOP — human step)**

Give Kevin:
1. Merge the PR (after check-runs green), `git pull` on the crow deployment, restart the gateway at a quiet moment.
2. Dashboard → Extensions → **Rookery Reviewer** → Install. In the form: `ROOKERY_MODEL_BASE_URL` = your local copilot endpoint (reachable FROM the container — a host-published port works via `http://host.docker.internal:<port>/v1`), `ROOKERY_MODEL_ID` = its /v1/models id, `ROOKERY_WORKSPACES_DIR` = wherever you want workspaces (the default is fine), `ROOKERY_REVIEWER_URL` = the HTTPS URL you'll serve the reviewer at (step 3).
3. Serve the reviewer at a ROOT origin (deviation 4 — no /proxy path): pick a free HTTPS port in `tailscale serve status`, then `sudo tailscale serve --bg --https=<port> http://127.0.0.1:3061` (or use an ssh -L tunnel for a first look). Open the **Rookery** tile → assemble a workspace for a real report → Open reviewer → select the model → run the reviewer on the report, confirm a verdict comes back.
4. Push `~/crow-addons` branch `add-rookery` (or merge it). Note: that makes the tile VISIBLE in remote stores; Install on grackle only works once grackle's crow checkout contains this merged PR (`git pull` there) — the store has no fetch-on-install.
Record his results in the runbook of the PRIVATE rookery repo (`docs/runbooks/`), not in crow.

---

## Self-Review

**Spec coverage:** Docker reviewer at 127.0.0.1:3061, root-origin serving per deviation 4 (T3/T4) ✓; MCP tool (T2) ✓; panel tile (T5) ✓; both registries (T4 in-repo, T6 remote — remote is discovery-only, see T6 Step 3) ✓; model config form (T4 env_vars; NO pre-fill — recorded spec deviation 3, the store has no such mechanism) ✓; workspaces volume (T3) ✓; header risk verified empirically (T3 Step 6 matrix + subpath gate) with the shim structurally required (documented) ✓; vendoring + drift guard (T1) ✓; port + CI (T4) ✓; public-repo hygiene (constraints + `.env` never committed, checked T3 Step 7; no tenant paths — `server.command` is cwd-relative) ✓.
**Placeholder scan:** VENDORED.md upstream-sha and drift-test hashes are fill-on-the-spot steps with the exact commands; no TBDs remain.
**Type consistency:** `assemble_exp(report_path, data_dir, phases, workspace_name, workspaces_dir)` (T2) matches its tests; panel routes call the CLI (T1 flags) not the python API; HOST env names (`ROOKERY_MODEL_BASE_URL`, `ROOKERY_MODEL_ID`, `ROOKERY_MODEL_API_KEY`, `ROOKERY_CORS_ORIGINS`, `ROOKERY_WORKSPACES_DIR`, `UV_NO_CACHE`) are identical across compose/.env.example/manifest, and the compose→container mapping onto `MODEL_*` matches what the entrypoint reads; `ROOKERY_WORKSPACES_DIR` is what run.sh/server.py (T2) and panel routes (T5) read; container path `/workspaces/<name>` consistent between T2 and T5; port 3061 consistent everywhere.

## Review

**Round 1 (2026-07-10, adversarial subagent review): REVISE → all criticals addressed.**
1. *Tenant-absolute `server.command`* → now `"./run.sh"` (resolves against proxy.js's spawn cwd = installed copy), hedge paragraph deleted, spawn verified from a foreign cwd (T4 Step 2). The claimed fed-gov-data "precedent" was invalid — that bundle is untracked, its tenant paths were never committed.
2. *`~` in `WORKSPACES_DIR` default never expanded on the Python path* → `os.path.expanduser` on the workspaces root + regression test with `HOME`/`ROOKERY_WORKSPACES_DIR` monkeypatched (T2); suite now 15.
3. *Remote registry entry oversold* — the community store fetch is listing-only; install requires the bundle in the deployment's own crow checkout (`bundles.js:897-900`). T6 Step 3 now stages the FULL bundle directory (crow-addons convention) + registry entry and states the discovery-only reality; Kevin checklist item 4 corrected.
4. *First-install crash on root-owned bind mounts* (engine creates missing sources as root; `USER 1000` + `set -eu` → crash loop) → entrypoint falls back to ephemeral HOME with a WARN; new T3 Step 7 proves it against fresh root-created mounts.
5. *`--cors` word-splitting bug* (`${VAR:+--cors ${VAR}}` yields one flag + stray positionals) → argv built in a loop; wrong explanatory note deleted.

Adopted suggestions: host env vars namespaced `ROOKERY_*` (shared gateway `.env` clobber risk — deviation 2); subpath-asset gate added to T3 Step 6 with an explicit STOP (answers the reviewer's open question empirically before Kevin's browser step); `UV_NO_CACHE` env_var added (default "1", 7GB-cache lesson); `min_disk_mb` grounded in the measured image (T4 Step 4); `run.sh` env-file line documented as an optional hand-provisioned hook; express-resolution comment corrected (T5 Step 3); dead TERM/INT trap removed (tini reaps); origin-strip mitigations documented in shim + README (SameSite=Lax cookie + loopback bind, residual local-process exposure stated); `extra_hosts: host-gateway` added so `host.docker.internal` examples work on Linux.
Resolved questions: Q1 (subpath survival) → empirical gate in T3; Q2 (crow-addons consumption) → verified listing-only, fixed as above; Q3 (form pre-fill) → verified nonexistent in store code, recorded as spec deviation 3.

**Gate outcome (2026-07-10, during execution): Task 3's subpath gate FIRED — root-origin serving adopted (deviation 4, Kevin decision).** 8 root-absolute asset refs in the HTML shell; 775 unique `/assets/...` strings baked in the binary; no base-path flag; no gateway SPA rewrite. Plan amended: no `webUI` block, `ROOKERY_REVIEWER_URL` env threads through server.py/manifest/panel/README/checklist. Task 2's already-committed `reviewer_url` constant is updated to the env-driven form as part of resumed Task 3 work (small follow-up commit + test update).

**Round 2 (2026-07-10, fresh adversarial subagent): APPROVE.** All five round-1 fixes verified consistent end-to-end against the actual gateway code (including an empirical docker-compose interpolation check of the `~`-via-env path and the SDK's `cwd` forwarding for the relative spawn). No criticals. Folded-in suggestions: `.gitignore` gets `bundles/*/.venv/` + `bundles/*/uv.lock` in Task 1 (git-status expectations now hold for a literal-minded executor); T4 Step 6 references the CURRENT manifest file, not Step 1's JSON; the subpath-gate STOP path tears the container down and removes `.env` before stopping; check-run name corrected to `check-ports`; header-matrix expectation relaxed to "all four match, non-4xx"; `author: "kh0pper"`; noted that env_vars DEFAULTS are baked world-readable into mcp-addons.json (never make a default a secret); `.env` lifecycle clarified (Step 7's plain docker run doesn't read it).

# Rookery / OpenScience — one-click Crow bundle (design)

**Date:** 2026-07-10
**Status:** Approved (brainstorm), pending spec review → implementation plan.
**Repo hygiene:** `~/crow` has a PUBLIC GitHub origin (`kh0pper/crow`). This
bundle and every file it ships MUST be generic: no secrets, no lab IPs, no
tenant-specific paths committed. Lab-specific values (the copilot endpoint,
real workspace dir) are entered in the install form at install time and
documented in the PRIVATE rookery runbook, never in the committed bundle.

## Purpose

Make Rookery's experiment-report audit loop a one-click Crow extension:
install from the Extensions store, and you get a self-hosted OpenScience
reviewer (behind dashboard auth at `/proxy/rookery/`) plus a
`rookery_assemble_exp` tool and a dashboard tile that turn "assemble a
workspace → audit a report" into a point-and-click (or AI-driven) flow. The
Dockerized reviewer runs Node 22 in-container, eliminating the host Node-20
workaround that Rookery Phase 1 needed.

Upstream of record stays the PRIVATE rookery repo (adapter source, runbooks,
experiment data). This bundle vendors the small adapter and wraps the vendor
app; it is a distribution surface, not a fork.

## Architecture

Standard Crow `type:"bundle"` at `bundles/rookery/`, three cooperating parts.

### 1. Docker service — the reviewer

- `Dockerfile` on `node:22-slim`; `npm install -g @synsci/openscience` at
  build. (No official image exists for v1.3.2; we build.)
- `entrypoint.sh`: generate `openscience.json` from env (§Config), then launch
  OpenScience bound to the container's internal port.
- `docker-compose.yml`: binds **`127.0.0.1:3061`** on the host (reserved in
  `docs/developers/port-allocation.md`, CI-enforced), mounts the workspaces
  volume (§Data), passes model env.
- Reached at **`/proxy/rookery/`** via the gateway's `extension-proxy.js`,
  behind `authMiddleware` + `isAllowedNetwork` + `verifySession` — the bundle
  itself does no auth; it inherits the dashboard's. No tailnet Serve / host
  shim in the Crow path (the gateway IS the front door).

### 2. MCP server — the adapter

- `rookery_assemble_exp(report_path, data_dir, phases[], workspace_name)` →
  assembles a reviewer workspace (report + `rounds.jsonl` +
  `SCORE-<phase>.md` per phase, `_script_manifest.jsonl`) into the shared
  volume, returns the workspace path and the `/proxy/rookery/` deep link.
  Returns a structured error (never a traceback) on missing input or a
  non-empty target workspace, matching the adapter's exit-2/FileExistsError
  contract.
- Implemented by **vendoring** the rookery-manifest adapter (`manifest.py`,
  `assemble.py`, `cli.py`; pure stdlib, ~160 lines, carries its own
  provenance header pointing at the private upstream) into
  `bundles/rookery/adapter/` and a thin Python MCP wrapper.
- Runs as a **host process** via Crow's MCP-child convention (`uv`/`run.sh`
  in `~/.crow/mcp-addons.json`), NOT a fourth container. Writes into the SAME
  `WORKSPACES_DIR` the container mounts, so host adapter and container reviewer
  share one workspace tree.

### 3. Panel tile — the dashboard surface

- `panel/rookery.js` (tile) + `panel/routes.js` (backend): a form (report
  path, data dir, phases), a list of assembled workspaces under
  `WORKSPACES_DIR`, and "Open reviewer" buttons that deep-link into
  `/proxy/rookery/` on the chosen workspace. `panel/routes.js` calls the same
  adapter code the MCP tool uses (shared module, one assembly path).

## Configuration & data flow

- **Model endpoint (both, form-overrides):** install form collects
  `MODEL_BASE_URL` + `MODEL_ID` (OpenAI-compatible), **pre-filled from Crow's
  AI env** (`AI_BASE_URL`/provider) when the deployment has it, form value
  wins. `entrypoint.sh` writes them into `openscience.json`'s provider block.
  Committed defaults are GENERIC placeholders (e.g.
  `http://host.docker.internal:8000/v1`), never the lab copilot IP.
  Re-configurable via the store's env editor + bundle restart. Atlas/cloud
  provider paths are never configured (self-hosted-only guardrail).
- **Workspaces (configurable volume):** env `WORKSPACES_DIR` (committed
  default `~/rookery/workspaces`) mounted **read-write** into the container.
  The adapter COPIES report + evidence into a fresh workspace here; pi-lab /
  source originals are never mounted and never mutated (the adapter's
  copy-not-move contract + non-empty-workspace guard hold). The container only
  ever sees assembled workspaces under this one dir.

## The header/cross-origin risk (and its fallback)

OpenScience hard-allowlists the `Host` header to `localhost/127.0.0.1/[::1]`
and applies an Origin / `Sec-Fetch-Site` cross-origin check (the thing that
forced Rookery Phase 1's tailnet host-proxy). Under Crow's gateway proxy this
is EXPECTED to dissolve: `extension-proxy` sets `changeOrigin` (rewrites Host
to `127.0.0.1:3061`, which is allowlisted) and dashboard→`/proxy/rookery/` is
same-origin (no `cross-site` rejection). **The implementation plan MUST verify
this empirically** (curl through the gateway, then a real browser load).

Fallback if a residual gap is found: bake the already-built, already-tested
`openscience-host-proxy.mjs` shim (Host-rewrite + `Sec-Fetch-Site` strip,
Origin preserved so `--cors` still enforces) into the container as a sidecar
in front of OpenScience, and point `webUI.port` at the shim. Either path
yields the same result; the plan picks the one the evidence supports.

## Manifest (shape)

`bundles/rookery/manifest.json`: `type:"bundle"`, `category:"ai"` (reviewer
runs on a local model), `docker.composefile`, `webUI{port:3061,path:"/",
label:"Rookery Reviewer"}`, `ports:[3061]`, `server{command,args,envKeys}`
(the MCP adapter), `panel`/`panelRoutes`, `requires{min_ram_mb, min_disk_mb}`,
`env_vars[]` for `MODEL_BASE_URL`, `MODEL_ID`, `WORKSPACES_DIR` (with generic
defaults; none `secret` unless the endpoint needs a key). `official:false`.

## Publishing (both registries)

- In-repo: `bundles/rookery/` + an entry in `registry/add-ons.json` +
  the port line in `docs/developers/port-allocation.md` (same PR, CI-enforced).
- Remote: an entry in the `kh0pper/crow-addons` `registry.json` so existing
  crow/grackle deployments see it in the store WITHOUT pulling a new crow
  release.

## Scope boundary (YAGNI — explicitly NOT in this bundle)

- The audit runbook workflow (stays docs in the private rookery repo).
- The tailnet Serve / host-proxy stack (superseded by the gateway proxy for
  Crow users; the shim survives only as the in-container fallback above).
- Any Atlas / share-link / cloud-model path (self-hosted-only guardrail).
- The pi-lab experiment machinery (rookery only reads assembled copies).

## Testing

- Adapter: the vendored copy keeps its existing pytest suite (9 tests); CI runs
  it. A copy-drift check asserts the vendored files match the upstream hash
  recorded in the provenance header (or documents the intended divergence).
- Bundle install: the Crow install job (`bundles.js`) exercised end-to-end on
  a test deployment — install → `docker compose up` → `/proxy/rookery/`
  reachable behind auth → `rookery_assemble_exp` builds a workspace → reviewer
  opens it. The header/cross-origin behavior is the explicit gate (§risk).
- Compose security scan (`validateComposeFile`) and port-allocation CI must
  pass. Manifest validated against `registry/manifest.schema.json`.

## Open items for the plan

- Confirm the internal container port and whether OpenScience needs a
  writable HOME/config dir inside the container (it wrote `~/.config/
  openscience/` on the host install) — mount or set `XDG_CONFIG_HOME`.
- Decide the MCP wrapper runtime (`uv` Python vs a Node shim shelling to the
  adapter CLI) against what `~/.crow/mcp-addons.json` spawns most cleanly.
- Verify `node:22-slim` + global npm install size against
  `requires.min_disk_mb`.

# Rookery Reviewer

A self-hosted, one-click extension that turns a Crow deployment into an
experiment-audit workbench: a Dockerized [OpenScience](https://github.com/synsci/openscience)
reviewer that runs a blind review of a report's numeric claims against its
registered evidence, driven entirely by a model endpoint you control. Nothing
leaves your machine — the reviewer talks to whatever OpenAI-compatible server
you point it at, and never touches the vendor's Atlas/cloud layer.

**Three parts:** the reviewer container (`docker-compose.yml`, `Dockerfile`,
`entrypoint.sh`, `host-shim.mjs` — OpenScience on node22, listening on
`127.0.0.1:3061`, fronted by a small Host-rewriting proxy so Docker's port
mapping works despite OpenScience's own DNS-rebinding guard); the
`rookery_assemble_exp` MCP tool (`src/rookery_mcp/`, a host `uv` process that
copies a report plus its registered evidence into a workspace directory the
container can see); and the dashboard panel (`panel/`, an assemble form plus
a workspace list linking out to the reviewer).

## Install

Install from the Extensions store (one-click). The form asks for
`ROOKERY_MODEL_BASE_URL` (required — your OpenAI-compatible endpoint, e.g. a
local llama.cpp/vLLM server; if it runs on the Docker **host** rather than in
a container, use `http://host.docker.internal:<port>/v1` — compose adds
`extra_hosts: host.docker.internal:host-gateway` so this resolves on Linux),
`ROOKERY_MODEL_ID` (as reported by the endpoint's `/v1/models`),
`ROOKERY_MODEL_API_KEY` (only if your endpoint checks it; default `local`),
`ROOKERY_WORKSPACES_DIR` (default `~/.crow/data/rookery/workspaces` is
usually fine), and `ROOKERY_CORS_ORIGINS`/`ROOKERY_REVIEWER_URL` — see below.
Host prerequisite: the `rookery_assemble_exp` MCP tool and the panel's
assemble form both run via `uv` at `~/.local/bin/uv` (rookery is the first
bundle in this repo to need it) — on a host without it, install "succeeds"
but the tool/panel fail on spawn; install with
`curl -LsSf https://astral.sh/uv/install.sh | sh`.

## Root-origin serving (no `/proxy/rookery/`)

Every other Crow bundle's UI lives behind the gateway's `/proxy/<id>/`
subpath. Rookery can't: OpenScience's compiled frontend bakes root-absolute
asset paths into its JS bundle (775 distinct `/assets/...` refs, no
base-path flag), so serving it under a subpath breaks asset loading. Instead,
put `127.0.0.1:3061` behind a root origin yourself — a Tailscale Serve HTTPS
port (`sudo tailscale serve --bg --https=<port> http://127.0.0.1:3061`), a
reverse proxy with no path rewriting, or an `ssh -L 3061:127.0.0.1:3061`
tunnel for a quick look — and set `ROOKERY_REVIEWER_URL` to that address so
the panel's and the assemble tool's "Open reviewer" links point somewhere
real instead of a bare loopback address.

## Workspaces are copies; self-hosted only

Assembling a workspace copies the named report and its evidence into
`ROOKERY_WORKSPACES_DIR/<name>`; originals are never touched. The generated
OpenScience config always contains exactly one provider, pointed at
`ROOKERY_MODEL_BASE_URL` — never point this bundle at OpenScience's own
Atlas/cloud layer, that defeats the point of a local-model reviewer.

## Security posture of the shim

Read this before serving beyond your own machine. The port binds
`127.0.0.1:3061` on the Docker host — **your serving layer is the auth
boundary, not the Crow dashboard session**; opening the reviewer UI does not
require a dashboard login. With `ROOKERY_CORS_ORIGINS` empty, the shim strips
the `Origin` header before forwarding, which disables OpenScience's own
CSRF/origin whitelist — fine for pure localhost/tunnel use, but set
`ROOKERY_CORS_ORIGINS` to your serving origin once you serve beyond
localhost, so `Origin` passes through and OpenScience enforces its own
whitelist against drive-by cross-site requests. Worth stating plainly: any
local process on the Docker host can reach `127.0.0.1:3061`
unauthenticated — this bundle runs an LLM agent over mounted files. The
panel's assemble form takes arbitrary host paths for report/data-dir BY
DESIGN (it copies operator-named files into a workspace); it runs behind the
dashboard session and is single-operator software.

## Troubleshooting

- **Model endpoint unreachable at start** — the UI still loads; OpenScience
  only calls the model when you pick one and run a review, so endpoint errors
  surface in-session, not as a container crash.
- **Assemble fails on an existing workspace name** — remove the workspace
  directory under `ROOKERY_WORKSPACES_DIR` and re-assemble; it refuses to
  overwrite one that already exists.
- **`WARN: $HOME not writable (root-owned bind mount)`** — Docker creates
  missing bind-mount sources as `root:root`, so a fresh install can start
  with a data dir uid 1000 can't write to. The entrypoint falls back to an
  ephemeral in-container `HOME` so it starts anyway (config regenerates from
  env every boot), but nothing persists across restarts that way. For
  persistence, `chown -R 1000:1000` the host directory mounted at `/data`
  (default `~/.crow/data/rookery`).

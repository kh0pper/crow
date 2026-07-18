# Open Science Reviewer (Rookery)

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
local llama.cpp/vLLM server. If the host service binds a **specific IP**
(e.g. a Tailscale address — check with `ss -tlnp`), use that IP directly:
`http://<host-ip>:<port>/v1`. `http://host.docker.internal:<port>/v1` works
ONLY when the service listens on 0.0.0.0 or the Docker bridge — against an
IP-bound service it resolves (compose adds `extra_hosts:
host.docker.internal:host-gateway`) but the connection times out; verified
on a live install 2026-07-14),
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

## MCP env filtering (Phase 2)

Upstream OpenScience spawns local (stdio) MCP servers with the **full
unfiltered `process.env`** — provider keys included. Two layers ship here:

- **`/app/wrapper-exec.sh` (the mechanism, allowlist)**: prefix every local
  MCP's `command` with it —
  `["/app/wrapper-exec.sh", "--allow", "VAR1,VAR2", "--", "server", ...]`.
  It re-execs the server via `env -i` passing only `PATH`, `HOME`,
  `WORKSPACES_DIR` plus the `--allow` list, and logs the exact env it passed
  to stderr (credential-shaped values redacted). An MCP needing an
  undocumented var fails until you add it to its `--allow` list — by design.
- **`/app/scrub-env.sh` (belt-and-suspenders, denylist)**: sourced by the
  entrypoint before OpenScience starts; drops credential-shaped vars
  (`*_KEY`, `*_TOKEN`, `CROW_*`, `THK_*`, …) from the app process itself.
  `MODEL_BASE_URL`/`MODEL_API_KEY` are dropped too — they've already landed
  in the generated config by then.

Both are baked into the image — changes require an image rebuild
(`docker compose build`), not just a container restart.

## Bridge MCPs (Phase 2): crow projects + research tools

Two remote MCPs can be registered into the reviewer app via env (both authed
by the same crow local MCP token, `ROOKERY_MCP_CROW_TOKEN`):

- **crow** (`ROOKERY_MCP_CROW_URL`) → the gateway's `/projects/mcp` mount:
  sources, notes, bibliographies. **Least privilege matters here**: point it
  at `/projects/mcp`, never `/router/mcp` — the router's `crow_tools`
  category exposes every integration connected to the gateway (mail, drive,
  web search), which both hands an untrusted-document-reading agent your
  accounts and re-opens internet egress by proxy through the host.
- **research** (`ROOKERY_MCP_RESEARCH_URL`) → the gateway's filtered
  `/tools-rookery/mcp` mount: only this bundle's host tools —
  `rookery_assemble_exp` and `rookery_search_openalex` (OpenAlex works
  search, crow_add_source-ready results; optional
  `ROOKERY_OPENALEX_MAILTO` joins the polite pool). The filtered mount
  requires a one-time `clients.json` entry in the gateway home
  (`{"rookery": {"allowSources": ["rookery"]}}`) and a gateway restart.

The search runs in the HOST `uv` process (the gateway addon), so the
container's egress lock is unaffected — the container reaches OpenAlex
results only through the authed bridge, never the internet.

## Egress lock (Phase 2, optional but recommended)

The upstream OpenScience binary makes an outbound vendor connection at
launch (Cloudflare-fronted, observed over IPv6 pre-dockerization).
`scripts/rookery-egress-lock.sh` installs a host-kernel allowlist so the
container reaches **only the local model endpoint** — internet, tailnet
peers, other containers, and host services are all dropped.

```sh
sudo ./scripts/rookery-egress-lock.sh          # install / refresh
./scripts/rookery-egress-verify.sh             # behavioral verification
sudo ./scripts/rookery-egress-lock.sh --remove # roll back
./scripts/rookery-egress-lock.sh --dry-run     # inspect before installing
```

How it works (verified on crow 2026-07-14): the model endpoint is itself a
docker-**published** port, so container→model traffic is DNAT'd in
`nat/PREROUTING` to `<model-container-ip>:<container-port>` and traverses
`FORWARD → DOCKER-USER` — not host `INPUT`. The script derives the bridge
name, subnet, and DNAT target fresh from docker on every run and installs
tagged (`-m comment rookery-lock`) chains: `ROOKERY-EGRESS` (model-only
allow, then drop) and `ROOKERY-INGRESS` off `DOCKER-USER`, `ROOKERY-HOSTIN`
off `INPUT`, plus ip6tables twins (the compose network is IPv4-only; the
twins are insurance) and a subnet tripwire. Dropped packets log rate-limited
with prefix `[ROOKERY-DROP-…]`.

Operational notes:

- **Re-run after**: reboot, `docker compose down/up` of the rookery *or the
  model* stack (bridge names / subnets / the model container IP all change),
  or a model-container recreate. `rookery-egress-verify.sh` run as root
  detects stale rules (drift check).
- **Reboot persistence**: `--print-systemd-unit` emits a oneshot unit that
  re-runs the script after docker starts (a boot-time re-run is the correct
  persistence — a saved rules file would go stale). Print it with the SAME
  env the lock is deployed with (e.g. `ALLOW_HOST_TCP_PORTS=3006
  ./rookery-egress-lock.sh --print-systemd-unit`): every config var set at
  print time is baked into the unit as an `Environment=` line, so the boot
  re-run reproduces the deployed posture instead of silently dropping the
  MCP-bridge allowance. If the model container isn't up in time, the lock
  installs **drop-only** (fail-closed) and the unit shows failed.
- **ufw coexistence**: the script never touches `ufw-*` chains or policies;
  `ufw reload`/`enable` rewrite only ufw's own chains, and docker preserves
  `DOCKER-USER` across daemon restarts.
- **DNS**: in-container resolution (127.0.0.11) is answered by dockerd,
  whose upstream lookups run as a host process — names still resolve, but
  every connection dies in `DOCKER-USER`. Accepted; no DNS allowance ships.
- **Adding reachable ports later** (e.g. the crow API for the bridge MCP):
  `ALLOW_HOST_TCP_PORTS="3006"` for host-local services (INPUT path),
  `ALLOW_PUBLISHED_TCP_PORTS` for docker-published ones (DNAT path), then
  re-run the script.
- **Vendor-connection check**: the verify script's ESTAB inspection is most
  meaningful right after `docker restart crow-rookery` — the vendor
  check-in happens at launch and its socket closes soon after.

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

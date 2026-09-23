# Node 24 as the Crow standard — design (2026-09-23)

Kevin, 2026-09-23: "fix the node version to 24". Crow's prod gateways have run
Node v24.21.0 since 2026-09-11 (via `node24.conf` systemd drop-ins on crow), and
`~/crow/node_modules` is built for ABI 137. The repo still claims 22 in CI, the
installer and docs. This change makes 24 the one declared version.

Decisions below are mine (autonomous cycle, see memory
`feedback-autonomous-superpowers-cycles`), not Kevin's, unless marked.

## Scope (repo)

1. **CI** — `.github/workflows/test.yml` `node-version: 24` (suite,
   static-checks, audit); `deploy-docs.yml` likewise. Job keys unchanged
   (branch-protection contexts).
2. **`package.json` engines** → `>=24`. *Decision:* a floor, not a range —
   CI now only proves 24, so claiming 22 would be untested.
3. **Installer / launcher** — `scripts/crow-install.sh` `NODE_MAJOR=24` and its
   "already installed" threshold raised from 18 to `NODE_MAJOR` (so a re-run on
   an old host upgrades it); `start.sh` hint + minimum check to 24.
4. **Root `Dockerfile`** → `node:24-slim`.
5. **Docs** (en + es) — getting-started install snippets `setup_24.x`,
   "Node.js 24" in prerequisite lists and `architecture/crow-os.md`;
   CLAUDE.md Tests line names Node 24.
6. **Hardcoded nvm node paths in live code** —
   `servers/gateway/routes/bot-board-api.js` (`/session/send` spawned the
   bridge under `~/.nvm/.../v20.20.2`) and `scripts/bots/router_dispatch.mjs`
   (`exec-node`) → `process.execPath`. The v20 spawn loads the v24-built
   better-sqlite3 and fails with ERR_DLOPEN_FAILED; it is also a path that
   exists on one machine only.
7. **Guard test** `tests/node-standard.test.js` — every CI `node-version`,
   the installer's `NODE_MAJOR`, the Dockerfile base and the engines floor
   agree on one major; no `.nvm/versions/node/v` literal under `servers/`
   or in `scripts/bots/router_dispatch.mjs`.

## Out of scope (deliberately)

- `bundles/bot-engine` `min_node: 22.19.0` — pi's own floor; the gate is
  honest as is.
- Bundle container images (`bundles/browser`, `rookery`, `scratch-offline`)
  and `pet-mode-appimage.yml` (Electron toolchain) — own runtimes; a bump
  there needs a bundle version bump + image rebuild. Follow-up.
- MPA-era pi-bots probe scripts (`scripts/pi-bots/s*_setup.sh`,
  `mcp.json.s0`) — fixtures for a retired instance.
- The `// node 22 build` ABI comments in bundle `db.js` files — generic.

## Host (crow, sudo, no restart)

Fold `node24.conf` into the base units `crow-gateway.service` and
`crow-r4-gateway.service` (PATH + ExecStart → v24.21.0, drop-in's PATH value
verbatim), keep `.bak-node22` copies, delete the drop-ins, `daemon-reload`.
Verification: `systemctl show -p ExecStart -p Environment` is byte-identical
before and after — the effective config does not change, so no restart.

## black-swan

Runs `/usr/bin/node` v22.23.2 from the NodeSource 22.x apt source
(`crow-gateway` from `~/.crow/app`). Moving it to 24 is a package install →
needs Kevin's go (global rule). Until then it runs below the engines floor
(npm warns, does not refuse).

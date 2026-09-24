# Raven as a paired Crow instance, with a host-level "no model orchestration" switch

**Date:** 2026-09-24 · **Queue:** Crow improvement queue item 4 (Strix Halo track 1b) · **Session:** crow-67

**Status:** decided autonomously under Kevin's standing grant of 2026-09-22 (memory `feedback-autonomous-superpowers-cycles`). Every decision below marked **(mine)** is the session's, not Kevin's. The **pairing** step (identity import plus the enrollment token exchange) writes credentials, so it waits for Kevin's explicit go (§5).

## 1. Goal

Raven (the second Strix Halo box, 10.0.0.126, tailnet `raven.dachshund-chromatic.ts.net`) joins the fleet as a Crow instance on crow's identity, as grackle and black-swan are. Three constraints from Kevin and pi-lab:

1. Raven's gateway **never starts, stops or evicts a model**. halogen (`flash-next.service`, :8030) is production and belongs to raven's systemd and to pi-lab's windows.
2. The gateway port is registered in `docs/developers/port-allocation.md`, and exposure is limited to the tailnet.
3. Anything on raven that can start a model is listed in `~/CROW-SCHEDULE.md`'s standing automations table.

## 2. Why this needs code: there is no master switch today

Recon on 2026-09-24 (`gpu-orchestrator.js` at e83448ff) found that `initOrchestrator()` always runs. A gateway starts models through:

- the alwaysResident boot loop (`ensureResident`);
- the deferred-resident retry and idle-revert timer (`startIdleRevertTimer`, which runs `retryDeferredResidents` and `checkIdleRevert`);
- every on-demand acquire (`maybeAcquireLocalProvider` → `acquireProvider`), reached from chat, the LLM router, `/llm/acquire`, the Models panel and the meta-glasses bundle.

What keeps a host from starting a model today is only a set of **per-row** checks: locality (a base_url on one of the host's own addresses), the owner gate, the foreign-instance veto, "has a bundle or native runtime", and the external-engine marker.

On raven those checks are not enough. Any synced row whose base_url is `10.0.0.126:<port>` counts as **local on raven**. It would be orchestrated there the moment it carries a `bundleId` or a native runtime. `raven-flash-next` is protected only by its external-engine marker, and `raven-halogen-smoke` only by having no bundle. A single mis-edited row on crow would replicate into raven and could start or evict a model next to production. Kevin's constraint is a property of the **host**, so it belongs in a host setting.

## 3. Design

### D1 (mine): the switch is `CROW_DISABLE_MODEL_ORCHESTRATION=1`

It follows the existing `CROW_DISABLE_*` family (NOSTR, INSTANCE_SYNC, BOT_RUNTIME, ROUTER, …). One reader, `isModelOrchestrationDisabled()` in a new `servers/shared/model-orchestration.js`, reads the env **on every call**, so tests can toggle it. Only `"1"` and `"true"` enable it (case-insensitive after trim). Any other value, including `"0"`, empty or unset, leaves orchestration on, which is today's behaviour, so every existing host is unchanged.

### D2 (mine): what the switch does

| path | with the switch on |
|---|---|
| `initOrchestrator` | Still arms the **read-only** monitors: the residency poll and the external-engine poll. Still runs `initNativeModels`, which only resumes interrupted downloads and never starts a model. **Skips** the alwaysResident ensure loop, does not populate `_deferredResidents`, and **does not arm** the idle-revert/deferred-retry timer. Logs one line: `[gpu-orchestrator] model orchestration DISABLED on this host (CROW_DISABLE_MODEL_ORCHESTRATION) — no model will be started, stopped or evicted`. |
| `maybeAcquireLocalProvider` | Returns `null` before any lookup, like a cloud or external row: "not mine to manage". Callers already handle `null` by dialing `base_url` directly (chat, llm-router, `/llm/acquire` warm, meta-glasses), so none of them change. |
| `acquireProvider` | **Defence in depth:** throws the typed `OrchestrationDisabledError` (`code: "model_orchestration_disabled"`) as its first statement after the unknown-provider check. That puts it before any probe, lock, sibling stop or start, so a future caller that bypasses `maybeAcquireLocalProvider` still cannot start anything. |
| `ensureResident`, `retryDeferredResidents` | Return `false` / `[]` immediately (after one log line per process), for callers other than `initOrchestrator`. |
| `warmProviderByName` | Covered, because it goes through `maybeAcquireLocalProvider`. |
| `checkIdleRevert` | Unreachable, because the timer is never armed. It also returns early under the switch (defence in depth: it stops and starts containers). |

### D3 (mine): the Models panel says why

`POST /api/models/:id/start` returns **409 `{ code: "MODEL_ORCHESTRATION_DISABLED" }`**, with a message naming the env var. It checks the switch before calling `maybeAcquireLocalProvider`, whose `null` would otherwise surface as the misleading `NOT_NATIVE`.

`GET /api/models/runtime` gains `orchestrationDisabled: true|false`, and the Models panel's runtime strip shows one line when it is true: "Model orchestration is disabled on this host. Models here are started outside Crow." (It has i18n keys in `en` and `es`; the global i18n parity gate applies.)

`POST /api/models/:id/stop` is unchanged. It only stops a handle this process started, and under the switch there are none.

### D4 (mine): out of scope

- **Model downloads** (`/api/models/download`, `hf-download`) stay allowed. They fill the disk but never start anything, and an operator may stage weights for a host-managed engine.
- **Extension bundle installs** (`routes/bundles.js`, `docker compose up` for any bundle) are not model orchestration. Model bundles were retired to the catalog in the models arc. Not gated here.
- **Deliberately no dashboard toggle.** This is a host property set by whoever owns the box, in the unit file, not something a dashboard user flips.

### D5 (mine): the raven install is manual, not `crow-install.sh`

`crow-install.sh` assumes a fresh box: it installs system Node, Docker, Caddy, avahi and fail2ban, runs `apt upgrade`, opens 443 in ufw, writes a system unit on :3001, and repoints `tailscale serve`. Every one of those collides with raven's production role. The install is instead:

1. **Node:** Node 24 via nvm, user-level (`v24.21.0`, the fleet pin).
2. **Code:** `git clone https://github.com/kh0pper/crow.git ~/crow` on `main`, so the auto-updater's on-main pull works, then `npm run setup` with `CROW_DATA_DIR=~/.crow/data`.
3. **User unit** `~/.config/systemd/user/crow-gateway.service`, with `loginctl enable-linger kh0pp` so it survives logout and reboot. The auto-updater restarts by exiting non-zero, so `Restart=always` gives it the same behaviour as crow's system unit. Environment:
   - `PORT=3009`, `CROW_GATEWAY_PORT=3009`, `CROW_GATEWAY_BIND=127.0.0.1`
   - `CROW_DISABLE_MODEL_ORCHESTRATION=1`
   - `CROW_DISABLE_BOT_RUNTIME=1`: no pi bot runtime on raven. Bots belong to crow, and they would pull models.
   - `CROW_MODELS_JSON=`: empty, so it ignores any `~/.pi/agent/models.json` a pi-lab session leaves on raven.
   - `CROW_HOME=~/.crow`, `CROW_DATA_DIR=~/.crow/data`, and an explicit `CROW_DB_PATH=~/.crow/data/crow.db` (the r4 lesson: dotenv fallbacks leak).
   - `CROW_GATEWAY_URL=https://raven.dachshund-chromatic.ts.net:8444`
4. **Exposure:** Tailscale Serve `:8444` → `http://127.0.0.1:3009`, the fleet's `:8444` convention. The gateway binds loopback only, so **ufw needs no new rule**, and the port is reachable only through tailscaled over the tailnet. **No Funnel**, ever (the network-exposure invariant).
5. **Ports:** a "Second host: raven" section in `port-allocation.md`, using the `raven:<port>` convention from the unmerged two-host spec branch: `raven:3009` for the gateway, `raven:8030` for halogen production, `raven:13305` and `raven:9000` for Lemonade (loopback, installed but disabled since the 2026-09-24 spike), and `raven:8031`–`8033` reserved for the two-box masters. `check-port-allocation.js` treats `raven:`-prefixed rows as unparseable, which is correct here. A host-aware checker stays follow-up work.
6. **Schedule:** CROW-SCHEDULE's standing automations gets a row for "crow-gateway (raven, user unit)" saying it **cannot** start models (`CROW_DISABLE_MODEL_ORCHESTRATION=1`, verified at deploy by the boot log line), and that its only raven traffic is a read-only 60 s `GET :8030/v1/models`.

### D6 (mine): identity and pairing

Raven carries **crow's identity** (`crow:kdq7zskhat`), because instance sync verifies signatures against the instance's own identity and only same-identity instances sync. This is consistent with Kevin's 2026-08-08 decision, which retired a second same-identity node **on the same host** (MPA) and kept same-identity peers on other hosts (grackle, black-swan).

The steps:

1. `npm run identity:export` on crow, then `identity:import` on raven;
2. set `CROW_ENROLL_ENABLED=1` on crow for the enrollment window only, with a one-time code;
3. on raven, `node scripts/cli/instance-pair.js --peer-url https://crow.dachshund-chromatic.ts.net:8444`;
4. remove the enroll flag on crow and restart it.

Both 1 and 3 write credentials: the identity seed, the bearer hashes and `peer-tokens.json`. **They wait for Kevin's explicit go.** Crow must restart twice, once to open enrollment and once to close it; each restart is a registered deploy slot.

- **is_home:** unchanged. That belongs to the grackle decommission.
- **Embeddings:** raven uses the fleet default (`grackle-embed`) until the decommission replaces it.

## 4. Testing

- **Unit (`tests/model-orchestration-switch.test.js`, run through `npm test --`):**
  - the reader's truth table;
  - `maybeAcquireLocalProvider` returns `null` for a native row and a bundle row that would otherwise be orchestrated (a row whose base_url is loopback), with the start seam never called;
  - `acquireProvider` throws `OrchestrationDisabledError` before `bundleUpFn`/`probeReadyFn`;
  - `ensureResident` returns `false` without calling `bundleUpFn`;
  - `retryDeferredResidents` returns `[]`;
  - with the switch OFF, the same fixtures still orchestrate, proving the gate is the switch.
- **Route:**
  - `POST /api/models/:id/start` returns 409 `MODEL_ORCHESTRATION_DISABLED` without calling the acquire seam;
  - `GET /api/models/runtime` carries the flag.
- **initOrchestrator:** a seam-level test that under the switch the ensure loop and the idle-revert timer are not armed, while the residency and external-engine monitors are.
- **Full suite:** `npm test`, plus CI green before merging.
- **Live acceptance on raven:**
  - the boot log shows the DISABLED line;
  - `/health` returns 200 through Serve;
  - `POST /api/models/<any>/start` returns 409;
  - halogen stays at 200 throughout;
  - after pairing: a provider-row change on crow arrives on raven, and raven's `crow_instances` lists crow, grackle and black-swan.

## 5. Order and gates

1. **PR:** the switch, the Models panel copy, `port-allocation.md` and the architecture docs (`docs/architecture/models.md`, plus `docs/developers/configuration.md` for the env var). Merge on green CI, then deploy crow and r4 in a free slot. On existing hosts this is a no-op because the env is unset.
2. **Raven install (D5):** in a registered slot outside pi-lab's reservations (NOT 22:00–06:00 tonight). No pairing yet.
3. **Pairing (D6):** needs **Kevin's go** (credential writes). Then verify sync both ways.

## 6. Risks

- **A backlog flood when raven first pairs.** Raven pulls crow's history. That is bounded (grackle and black-swan did the same) and it is CPU and disk only.
- **Serve on raven** is a new tailnet surface. It is `:8444` only, tailnet-only and never Funnel.
- **Memory:** a gateway is about 150–300 MB RSS next to halogen, where about 11 GiB is available. The unit carries `MemoryMax=1G` so it can never press production.

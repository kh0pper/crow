# Phone Migration (de-Google) Product Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a user moving a Pixel to GrapheneOS with sandboxed Google Play gets the Crow side of the move:
- Crow can host Immich, with import tooling for a large Google Photos library;
- the Crow app updates itself from the gateway;
- a Phone migration checklist in Settings shows each gate.

**Architecture:** The existing `immich` connector bundle gains a hosting half, at version 2.0.0:
- a pinned compose project `crow-immich` (loopback 2283, Serve 8458);
- a Python bootstrap that creates the admin and mints the connector key;
- a gpg nightly DB backup.

Two small generic installer features make that possible: `generate: "alnum"` and `docker.skip_when`.

The gateway serves a signed-APK feed (`/api/android/*`). The Android app checks it and installs updates through `PackageInstaller` after verifying the sha256 and the signer.

A new Settings section shows live migration status plus manual ticks. The only operator task kept here is the storage spike (A0); deployment and the phone switch belong to the operator's own runbook.

**Tech Stack:**
- Node 24 (gateway, node:test), Python 3 stdlib (bootstrap), bash (ops scripts), docker compose v5.
- Immich v3.2.4, immich-go v0.32.0.
- Android Java (minSdk 34) with JUnit 4.
- GrapheneOS CLI install (fastboot 37.0.0 from `~/Android/Sdk/platform-tools`).

**Spec:** `docs/superpowers/specs/2026-10-04-phone-migration-product-design.md`

## Global Constraints

- **Repo rules:**
  - Commit with a positional path (`git commit <paths> -m "…"`), then run `git show --stat HEAD`.
  - Run `git pull --rebase` before every push.
  - CI red blocks merges. Check `https://api.github.com/repos/<owner>/crow/commits/<sha>/check-runs`: every run must be `completed`/`success`.
  - No Claude co-author or attribution in commits or PRs.
  - `gh` is not installed on crow. Use the github MCP server for PRs.
- **Bundle code changes need a `manifest.json` version bump:** immich `1.0.0 → 2.0.0`, workspace `0.1.2 → 0.1.3`. A node-server bundle declares its bare imports in its own `package.json`.
- **Tests:** run `npm test` (scratch env), or `npm test -- tests/<file>.test.js` for one file. **Never raw `node --test`** against a live `~/.crow`.
- **New host ports must be in `docs/developers/port-allocation.md`:** 2283 (immich, verify), Serve 8458 (Immich), Serve 8459 (Vaultwarden), scratch 12283, subnets 10.89.74.0/24 (prod) and 10.89.75.0/24 (spike). Re-verify across the three registries (doc, every compose under `bundles/` and `~/crow-addons`, live `ss -ltn` + `tailscale serve status`) right before claiming them.
- **Immich images, exact:**
  - `ghcr.io/immich-app/immich-server:v3.2.4`
  - `ghcr.io/immich-app/immich-machine-learning:v3.2.4`
  - `ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0@sha256:bcf63357191b76a916ae5eb93464d65c07511da41e3bf7a8416db519b40b1c23`
  - `docker.io/valkey/valkey:9@sha256:70739f85ad2ee01a726a965584a0f94895f01b0c60b3cc8b0aeef11eaa6888cf`
- **Exposure and GPU:**
  - Immich, Workspace and Vaultwarden are **tailnet-only via Serve; never Funnel**.
  - No GPU device (`/dev/kfd`, `/dev/dri`, `-rocm` tags) in the Immich compose.
  - The Immich DB is never on NTFS.
- **Secrets** never appear in argv (except the documented short-lived immich-go import key, spec §3.2 step 5), logs, page HTML or the gateway `.env` (`propagate: false` on every immich var).
- **Release cert SHA-256 (hex), the CURRENT key** (`crow-release.jks`, 2026-09-06; the June `dcc2…` key is retired): `6d5aeff16cd983e9b5f96147da5c88240b274ca9eed80bae771f555ac5a24352`. App package `press.maestro.crow`. New app version **1.6.0 / versionCode 20**.
- **Package installs need the operator's explicit OK first.** This covers `libarchive-tools` and the immich-go binary download. Anything else that turns out missing: stop and ask.
- **Shared-host windows:** every scratch window (spike A0) is registered in the host's maintenance schedule before it starts and cleared after. Any window that degrades prod or holds resources carries an out-of-process deadman (`systemd-run --user --on-active=<cap>`) that restores prod.
- **Branches and worktrees.** This spec/plan lives on `docs/phone-migration-product-spec`. Implementation uses three PRs, each in its own worktree created from `origin/main` **after** the spec/plan branch is merged (`git -C ~/crow fetch -q origin && git -C ~/crow worktree add <WT> -b <branch> origin/main`). Each task's commands use `$WT`:
  - **PR A** (Tasks A0–A7 + B1): `export WT=~/crow-wt-immich`, branch `feat/immich-hosting`.
  - **PR C** (C1–C5): `export WT=~/crow-wt-android-feed`, branch `feat/android-update-feed`.
  - **PR D** (D1–D3): `export WT=~/crow-wt-phone-migration`, branch `feat/phone-migration`.

  PRs C and D are independent of A and of each other. Never `git checkout <branch>` in `~/crow`: that parks the gateway checkout off `main` and silently stops auto-update.

## Review Focus

1. **The USB drive is unmounted or unplugged while Immich is (re)started.** Immich must refuse to start; it must never write originals onto the NVMe root fs. Pinned by the `create_host_path: false` compose assertion (Task A2) and live-tested in spike A0 step 6.
2. **Bootstrap re-run after the admin password was scrubbed and the connector key was revoked in the Immich UI.** It must stop with a clear Configure instruction and exit 1, not create a second admin or crash. Test in Task A3 ("stale key, no password").
3. **A malicious or corrupt APK in the feed dir:** wrong signer, wrong size, versionCode not newer, path traversal in `file`. The gateway must not offer it, and the app must not install it. Tests in Tasks C1 (feed validation), C2 (publish refuses a foreign signer) and C3 (`shouldOffer`).
4. **A slow or broken probe** (tailscale missing, Immich down, ntfy unset). The Settings page must still render, showing "couldn't check". Test in Task D1 (timeouts and throwing probes).
5. **Installer-encoded `.env` values** (quotes, spaces, `$`) in the admin password are read by the Python bootstrap exactly as the installer wrote them. Test in Task A3, using `formatEnvLines` to write the fixture.

## Phase A: Immich hosting (bundle 2.0.0)

### Task A0 [OPERATOR, scratch window]: NTFS spike

**Files:**
- Create: `scripts/immich-ntfs-spike/docker-compose.yml`
- Create: `scripts/immich-ntfs-spike/run-spike.sh`
- Create: `scripts/immich-ntfs-spike/README.md`

**Interfaces:**
- Produces: a PASS/FAIL report at `docs/superpowers/research/immich-ntfs-spike.md` (no host names or personal paths in it), and the go/no-go for NTFS originals (spec §3.1).

- [ ] **Step 1: Register the window** in the host's maintenance schedule: a 2-hour hard cap, attended, with the transient unit `immich-spike-deadman` tearing down at the cap. Scratch compose `crow-immich-spike` on 127.0.0.1:12283, subnet 10.89.75.0/24, originals at `<drive-mount>/crow-immich-spike`, thumbs/DB under `~/.crow-immich-spike`. No Serve, no GPU, no models, about 6 GB RAM.

- [ ] **Step 2: Write the scratch compose.**

```yaml
## Immich NTFS spike (degoogle plan Task A0). Scratch only: never Serve, never prod ports.
name: crow-immich-spike

services:
  immich-server:
    image: ghcr.io/immich-app/immich-server:v3.2.4
    mem_limit: 4g
    cpus: 12
    ports:
      - "127.0.0.1:12283:2283"
    environment:
      DB_HOSTNAME: database
      DB_USERNAME: postgres
      DB_PASSWORD: ${SPIKE_DB_PASSWORD:?set by run-spike.sh}
      DB_DATABASE_NAME: immich
      REDIS_HOSTNAME: redis
    volumes:
      - type: bind
        source: ${SPIKE_LIBRARY:?set by run-spike.sh}
        target: /data
        bind:
          create_host_path: false
      - ${SPIKE_HOME:?set by run-spike.sh}/thumbs:/data/thumbs
      - ${SPIKE_HOME:?set by run-spike.sh}/encoded-video:/data/encoded-video
      - ${SPIKE_HOME:?set by run-spike.sh}/db-dumps:/data/backups
      - /etc/localtime:/etc/localtime:ro
    depends_on:
      database:
        condition: service_healthy
      redis:
        condition: service_healthy

  database:
    image: ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0@sha256:bcf63357191b76a916ae5eb93464d65c07511da41e3bf7a8416db519b40b1c23
    mem_limit: 2g
    shm_size: 128mb
    environment:
      POSTGRES_PASSWORD: ${SPIKE_DB_PASSWORD:?set by run-spike.sh}
      POSTGRES_USER: postgres
      POSTGRES_DB: immich
      POSTGRES_INITDB_ARGS: "--data-checksums"
    volumes:
      - ${SPIKE_HOME:?set by run-spike.sh}/postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d immich"]
      interval: 10s
      timeout: 5s
      retries: 10

  redis:
    image: docker.io/valkey/valkey:9@sha256:70739f85ad2ee01a726a965584a0f94895f01b0c60b3cc8b0aeef11eaa6888cf
    mem_limit: 512m
    healthcheck:
      test: ["CMD", "valkey-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 10

networks:
  default:
    ipam:
      config:
        - subnet: 10.89.75.0/24
```

ML is deliberately absent; it is not storage-relevant.

- [ ] **Step 3: Write `run-spike.sh`.** It needs sub-commands `up`, `checks`, `missing-drive`, `down`, and a deadman.

```bash
#!/usr/bin/env bash
# Immich NTFS spike (degoogle plan Task A0). Usage:
#   bash scripts/immich-ntfs-spike/run-spike.sh up|checks|missing-drive|down
# up arms a detached deadman (systemd-run --user, 2 h) that runs `down` at the cap.
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SPIKE_HOME="${SPIKE_HOME:-$HOME/.crow-immich-spike}"
SPIKE_DRIVE="${SPIKE_DRIVE:?set SPIKE_DRIVE to the drive mountpoint under test}"
export SPIKE_LIBRARY="${SPIKE_LIBRARY:-$SPIKE_DRIVE/crow-immich-spike}"
CAP_S="${SPIKE_CAP_S:-7200}"
DC=(docker compose -f "$HERE/docker-compose.yml" -p crow-immich-spike)
log() { printf '[spike] %s\n' "$*"; }

case "${1:-}" in
  up)
    mountpoint -q "$SPIKE_DRIVE" || { log "$SPIKE_DRIVE is not mounted"; exit 1; }
    mkdir -p "$SPIKE_HOME"/{thumbs,encoded-video,db-dumps,postgres} "$SPIKE_LIBRARY"
    if [ ! -f "$SPIKE_HOME/db-password" ]; then raw="$(head -c 512 /dev/urandom | base64 -w0)"; raw="${raw//[^A-Za-z0-9]/}"; printf '%s' "${raw:0:40}" > "$SPIKE_HOME/db-password"; fi
    systemctl --user stop immich-spike-deadman.timer 2>/dev/null || true; systemctl --user reset-failed immich-spike-deadman.service 2>/dev/null || true
    systemd-run --user --unit=immich-spike-deadman --on-active="${CAP_S}s" --collect --setenv=SPIKE_DRIVE="$SPIKE_DRIVE" --setenv=SPIKE_HOME="$SPIKE_HOME" --setenv=SPIKE_LIBRARY="$SPIKE_LIBRARY" \
      /bin/bash "$HERE/run-spike.sh" down
    SPIKE_DB_PASSWORD="$(cat "$SPIKE_HOME/db-password")" "${DC[@]}" up -d
    log "up; deadman armed for ${CAP_S}s; web UI only via ssh -L 12283:127.0.0.1:12283"
    ;;
  checks)
    log "ntfs-3g mount options:"; findmnt -no FSTYPE,OPTIONS "$SPIKE_DRIVE"
    log "markers:"; ls -la "$SPIKE_LIBRARY" "$SPIKE_LIBRARY"/* 2>/dev/null | grep -E '\.immich|^/' || true
    log "ownership as seen on the host:"; { find "$SPIKE_LIBRARY" -maxdepth 3 -printf '%u:%g %m %p\n' 2>/dev/null | head -20; } || true
    log "server log errors (EPERM/EACCES/EXDEV/chmod/chown/ENOSPC):"
    SPIKE_DB_PASSWORD="$(cat "$SPIKE_HOME/db-password")" "${DC[@]}" logs immich-server 2>&1 \
      | grep -E 'EPERM|EACCES|EXDEV|chmod|chown|ENOSPC|integrity' || log "(none)"
    log "sizes:"; du -sh "$SPIKE_LIBRARY" "$SPIKE_HOME"/thumbs "$SPIKE_HOME"/encoded-video "$SPIKE_HOME"/postgres
    ;;
  missing-drive)
    # The bind source must exist; point it at a path that does not and expect a refusal.
    SPIKE_DB_PASSWORD="$(cat "$SPIKE_HOME/db-password")" "${DC[@]}" stop immich-server
    if SPIKE_LIBRARY="$SPIKE_DRIVE"/crow-immich-spike-DOES-NOT-EXIST SPIKE_DB_PASSWORD="$(cat "$SPIKE_HOME/db-password")" \
         "${DC[@]}" up -d immich-server 2>"$SPIKE_HOME/missing-drive.err"; then
      log "FAIL: compose started immich-server with a missing library dir"; exit 1
    fi
    [ ! -e "$SPIKE_DRIVE"/crow-immich-spike-DOES-NOT-EXIST ] || { log "FAIL: compose created the missing dir"; exit 1; }
    log "PASS: refused ($(tail -1 "$SPIKE_HOME/missing-drive.err"))"
    SPIKE_DB_PASSWORD="$(cat "$SPIKE_HOME/db-password")" "${DC[@]}" up -d immich-server
    ;;
  down)
    SPIKE_DB_PASSWORD="$(cat "$SPIKE_HOME/db-password" 2>/dev/null || echo x)" "${DC[@]}" down -v --remove-orphans || true
    systemctl --user stop immich-spike-deadman.timer 2>/dev/null || true
    log "down. Data kept in $SPIKE_HOME and $SPIKE_LIBRARY. Remove both with the operator's OK: rm -rf $SPIKE_HOME $SPIKE_LIBRARY"
    ;;
  *) echo "usage: run-spike.sh up|checks|missing-drive|down" >&2; exit 2 ;;
esac
```

- [ ] **Step 4: Validate the compose without starting it.**

  Run: `SPIKE_HOME=/tmp/x SPIKE_LIBRARY=/tmp/y SPIKE_DB_PASSWORD=x docker compose -f scripts/immich-ntfs-spike/docker-compose.yml config >/dev/null && echo OK`

  Expected: `OK`. If compose rejects `bind.create_host_path`, stop. Record it, and switch the A2 compose design to a pre-start check (`ops/storage-check.sh --require-library`) called from an `ExecStartPre`-like `entrypoint` wrapper. Ask the operator before redesigning.

- [ ] **Step 5: Run the spike.** Run `bash scripts/immich-ntfs-spike/run-spike.sh up`. Then, through `ssh -L 12283:127.0.0.1:12283 crow` from a laptop (or the crow-browser noVNC at `http://127.0.0.1:12283`):
  1. Create an admin.
  2. Upload ~5 GB: copy a folder of existing photos from `/mnt/data` with the web uploader, or with immich-go if Task B2's binary is already approved.
  3. Administration › Settings › Storage Template: enable it, then run the "Storage Template Migration" job.
  4. Trash 10 assets, restore 5, permanently delete 5.
  5. Administration › Maintenance: run a database backup.

  The web upload only proves the code paths. Its speed measures the tunnel and the laptop, not ntfs-3g.
  - **Throughput:** time a local copy, `time cp -r <a ~5 GB photo folder on another disk> <drive-mount>/crow-immich-spike/throughput-test/` (delete it afterwards), and watch `top -p $(pgrep -d, ntfs-3g)` for CPU.
  - **API record for A3:** capture the exact request/response (`curl -s -i` against `127.0.0.1:12283`, tokens redacted in the report) of:
    - `GET /api/server/ping`
    - `POST /api/auth/admin-sign-up` (first and second call)
    - `POST /api/auth/login`
    - `POST /api/api-keys` with A3's permission list
    - `GET /api/users/me` with the key
    - `GET /api/sessions`

    Any difference from A3's assumptions changes A3 before it is written.

- [ ] **Step 6: Checks.** Run `bash …/run-spike.sh checks`, then `bash …/run-spike.sh missing-drive`, then `docker compose … restart` (the markers survive).

  **PASS when all of:**
  - no lines in the error grep;
  - `.immich` present in `upload/ library/ thumbs/ encoded-video/ profile/ backups/`;
  - the template migration moved files (they are under `library/`);
  - deletes removed the files;
  - `missing-drive` printed PASS;
  - throughput ≥ 30 MB/s.

- [ ] **Step 6b: Reboot-ordering check (late drive mount) [OPERATOR, sudo, inside the registered window].** This simulates the drive mounting after Docker restarts an existing container.
  1. With the spike up, move the library away: `mv <drive-mount>/crow-immich-spike <drive-mount>/crow-immich-spike.away`.
  2. `sudo systemctl restart docker`. This briefly restarts every container on crow; confirm the window allows it, then check prod afterwards (gateway `:3001`, Workspace, models).
  3. Move the library back: `mv <drive-mount>/crow-immich-spike.away <drive-mount>/crow-immich-spike`.
  4. Wait 2 minutes and run `docker ps`. Is `crow-immich-spike-immich-server-1` running? Record yes/no.

  "No" means a reboot with a late drive leaves Immich down until `docker compose up -d`. The operator decides spec P3, and A6's Photos page documents the recovery command. If the operator prefers not to restart Docker, record "assumed no".

- [ ] **Step 7:** Run `bash …/run-spike.sh down`. Write the report (numbers + PASS/FAIL per check) to `docs/superpowers/research/immich-ntfs-spike.md`. Clear the schedule entry. **If FAIL:** stop and ask the operator to pick F1/F2/F3 (spec §3.1) before Task A2. The only A2 change for F1/F2 is crow's `IMMICH_LIBRARY_DIR` value (e.g. `/mnt/photos/crow-immich/library`).

- [ ] **Step 8: Commit.**

```bash
git -C "$WT" add scripts/immich-ntfs-spike
git -C "$WT" commit scripts/immich-ntfs-spike -m "chore(immich): NTFS spike harness (scratch compose + deadman), degoogle plan A0"
git -C "$WT" show --stat HEAD
```

### Task A1: Installer: `generate: "alnum"` and `docker.skip_when`

**Files:**
- Modify: `servers/gateway/bundle-env-secrets.js` (`GENERATE_KINDS`, new `newAlnumValue`, `newSecretValue(kind)`)
- Modify: `servers/gateway/bundle-lifecycle.js` (new `composeSkipped`)
- Modify: `servers/gateway/routes/bundles.js` (install step 2.9)
- Modify: `scripts/lib/bundle-contract.mjs`:
  - validate `docker.skip_when`;
  - add `"alnum"` to the hard-coded `KINDS` array (~line 195: `["secret","laravel_key","vapid_private_key","vapid_public_key","alnum"]`).
- Modify: `registry/manifest.schema.json`:
  - ~line 79: append `"alnum"` to the existing `generate` enum (`["secret", "laravel_key", "vapid_private_key", "vapid_public_key", "alnum"]`).
  - If the `docker` object has `additionalProperties: false`, add `"skip_when": { "type": "object", "required": ["env", "equals"], "properties": { "env": { "type": "string" }, "equals": { "type": "string" } } }` to its properties.
- Modify: `servers/gateway/routes/bundles.js` `validateInstall` (connector-only installs skip the Docker and hardware gates)
- Test: `tests/bundle-env-secrets.test.js` (append)
- Test: `tests/bundles-skip-when.test.js` (new)

**Interfaces:**
- Produces:
  - `newAlnumValue(len = 40): string` (only `[A-Za-z0-9]`).
  - `composeSkipped(manifest, env): boolean`, where `env` is `.env` text **or** a `{KEY: value}` object (the install request).
  - Manifest field `docker.skip_when: { env: string, equals: string }`.
  - Manifest `env_vars[].generate: "alnum"`.

- [ ] **Step 1: Write the failing tests.** Append to `tests/bundle-env-secrets.test.js`:

```js
import { newAlnumValue, planGeneratedEnv } from "../servers/gateway/bundle-env-secrets.js";

test("generate: alnum mints 40 alphanumerics (Immich DB_PASSWORD rule: A-Za-z0-9 only)", () => {
  for (let i = 0; i < 200; i++) assert.match(newAlnumValue(), /^[A-Za-z0-9]{40}$/);
  assert.match(newAlnumValue(12), /^[A-Za-z0-9]{12}$/);
  const home = mkdtempSync(join(tmpdir(), "alnum-"));
  const dest = join(home, "bundles", "x"); mkdirSync(dest, { recursive: true });
  const plan = planGeneratedEnv("x", { env_vars: [{ name: "X_DB", generate: "alnum" }] }, { destDir: dest, crowHome: home });
  assert.match(plan.env.X_DB, /^[A-Za-z0-9]{40}$/);
});
```

(If the file lacks `mkdtempSync`/`mkdirSync`/`join`/`tmpdir` imports, add them to its import lines.)

Create `tests/bundles-skip-when.test.js`:

```js
/** docker.skip_when: an install whose .env matches runs no containers (spec §3.1). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeSkipped } from "../servers/gateway/bundle-lifecycle.js";
import { validateManifest } from "../scripts/lib/bundle-contract.mjs";

const M = { docker: { skip_when: { env: "IMMICH_MODE", equals: "external" } }, env_vars: [{ name: "IMMICH_MODE", default: "local" }] };

test("matches the written .env value", () => {
  assert.equal(composeSkipped(M, "IMMICH_MODE=external\n"), true);
  assert.equal(composeSkipped(M, "IMMICH_MODE='external'\n"), true, "installer-quoted value decodes");
  assert.equal(composeSkipped(M, "IMMICH_MODE=local\n"), false);
});

test("absent key falls back to the manifest default; absent rule never skips", () => {
  assert.equal(composeSkipped(M, "OTHER=1\n"), false);
  assert.equal(composeSkipped({ ...M, env_vars: [{ name: "IMMICH_MODE", default: "external" }] }, ""), true);
  assert.equal(composeSkipped({ docker: {} }, "IMMICH_MODE=external\n"), false);
  assert.equal(composeSkipped(null, "IMMICH_MODE=external\n"), false);
});

test("request-env objects work too (validateInstall passes the install request)", () => {
  assert.equal(composeSkipped(M, { IMMICH_MODE: "external" }), true);
  assert.equal(composeSkipped(M, {}), false);
});

test("contract: skip_when must name a declared env var and a string value", () => {
  // Shape-valid fixture (schema requires category + docker.composefile) in a dir named like
  // its id with a real compose file, so only the skip_when rule can fail.
  const root = mkdtempSync(join(tmpdir(), "sw-")); const dir = join(root, "t"); mkdirSync(dir);
  writeFileSync(join(dir, "docker-compose.yml"), "services:\n  a:\n    image: alpine:3.20\n");
  const base = { id: "t", name: "T", version: "1.0.0", description: "d", type: "bundle", category: "media" };
  const dk = (sw) => ({ composefile: "docker-compose.yml", skip_when: sw });
  const ok = validateManifest({ ...base, docker: dk({ env: "A", equals: "x" }), env_vars: [{ name: "A", description: "a" }] }, dir, { bundleExists: () => true });
  assert.ok(!ok.errors.some((e) => /skip_when/.test(e)), ok.errors.join("; "));
  const bad1 = validateManifest({ ...base, docker: dk({ env: "NOPE", equals: "x" }), env_vars: [] }, dir, { bundleExists: () => true });
  assert.ok(bad1.errors.some((e) => /skip_when/.test(e)), bad1.errors.join("; "));
  const bad2 = validateManifest({ ...base, docker: dk({ env: "A", equals: 3 }), env_vars: [{ name: "A", description: "a" }] }, dir, { bundleExists: () => true });
  assert.ok(bad2.errors.some((e) => /skip_when/.test(e)), bad2.errors.join("; "));
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**

  Run: `npm test -- tests/bundles-skip-when.test.js tests/bundle-env-secrets.test.js`

  Expected: FAIL (`composeSkipped`/`newAlnumValue` not exported).

- [ ] **Step 3: Implement.** (Re-based on #417, which added the kinds `laravel_key`/`vapid_*` and made `newSecretValue(kind)` kind-aware; `planGeneratedEnv` already calls `newSecretValue(spec.generate)`.) In `servers/gateway/bundle-env-secrets.js`, add `"alnum"` to the existing set:

```js
const GENERATE_KINDS = new Set(["secret", "laravel_key", "vapid_private_key", "vapid_public_key", "alnum"]);
```

In `newSecretValue(kind)`, add as its first line `if (kind === "alnum") return newAlnumValue();`. Also add `"alnum"` to the schema enum in `registry/manifest.schema.json` (line ~79), keeping the other kinds. The new immich manifest must also pass #417's `tests/bundle-form-friction.test.js`: generated secrets are consumed by compose, required human fields have descriptions, and optional fields with defaults fold under Advanced. Run it in A2 Step 6.

Below `newSecretValue()` add:

```js
/** `generate: "alnum"`: [A-Za-z0-9] only, for services that reject punctuation (Immich DB_PASSWORD). */
export function newAlnumValue(len = 40) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b < 248 && out.length < len) out += A[b % 62]; // 248 = 4*62: no modulo bias
    }
  }
  return out;
}
```

No change is needed in `planGeneratedEnv`: it already routes through `newSecretValue(spec.generate)`. Add `env_vars[].generate: "alnum" → 40 chars [A-Za-z0-9]` to the header comment.

In `servers/gateway/bundle-lifecycle.js` add (import `parseEnvText` from `./bundle-env-codec.js` if it is not already imported):

```js
/**
 * docker.skip_when { env, equals }: when the bundle's written .env (else the manifest
 * default) has env === equals, the install runs NO containers. The installer deletes
 * the installed copy's docker-compose.yml, so every later path (start/stop/status/
 * uninstall/refresh) sees a compose-less bundle. Spec 2026-10-04 §3.1.
 */
export function composeSkipped(manifest, envInput) {
  const rule = manifest?.docker?.skip_when;
  if (!rule || typeof rule.env !== "string" || typeof rule.equals !== "string") return false;
  const env = typeof envInput === "string" ? parseEnvText(envInput)
    : envInput && typeof envInput === "object" ? envInput : {};
  const fallback = (manifest.env_vars || []).find((v) => v && v.name === rule.env)?.default;
  const value = Object.hasOwn(env, rule.env) && env[rule.env] !== "" ? env[rule.env] : fallback;
  return value === rule.equals;
}
```

In `servers/gateway/routes/bundles.js`, add `composeSkipped` to the existing `../bundle-lifecycle.js` import. Then, immediately **before** the line `// 3. Type-specific install steps`, insert:

```js
    // 2.9 docker.skip_when (spec 2026-10-04 §3.1): e.g. immich IMMICH_MODE=external —
    // connector only. Drop the compose file from the INSTALLED copy so no container
    // path ever runs; the post-install hook is skipped with it (runHook is only set
    // inside the compose branch below).
    try {
      const envNow = existsSync(join(destDir, ".env")) ? readFileSync(join(destDir, ".env"), "utf8") : "";
      if (composeSkipped(manifest, envNow)) {
        rmSync(join(destDir, "docker-compose.yml"), { force: true });
        appendLog(job, `${manifest.docker.skip_when.env}=${manifest.docker.skip_when.equals}: no containers to run; installing the connector only`);
      }
    } catch (err) {
      appendLog(job, `Warning: could not evaluate docker.skip_when: ${err.message}`);
    }
```

**Step 3b: Connector-only installs skip the Docker and hardware gates.** In `validateInstall` (`servers/gateway/routes/bundles.js`), after `manifest` is loaded and before the hardware gate, add:

```js
  // docker.skip_when (spec §3.1): a connector-only install (e.g. immich IMMICH_MODE=external)
  // runs no containers, so neither the Docker-reachable gate nor the RAM gate applies.
  const connectorOnly = composeSkipped(manifest, envVars);
```

Then make two changes in the same function:
- Hardware gate: change `if (!forceInstall) {` to `if (!forceInstall && !connectorOnly) {`.
- Docker gate: change `existsSync(composePath) && !(await dockerAvailable())` to `existsSync(composePath) && !connectorOnly && !(await dockerAvailable())`.

The test for this gate lives in Task A2 Step 1, because it needs the immich compose file.

In `scripts/lib/bundle-contract.mjs`, next to the `docker.precreate` loop, add:

```js
  const sw = manifest && manifest.docker && manifest.docker.skip_when;
  if (sw !== undefined) {
    const names = new Set(((manifest && manifest.env_vars) || []).map((v) => v && v.name));
    if (!sw || typeof sw !== "object" || typeof sw.env !== "string" || typeof sw.equals !== "string") {
      errors.push(`docker.skip_when must be { env: <string>, equals: <string> }`);
    } else if (!names.has(sw.env)) {
      errors.push(`docker.skip_when.env "${sw.env}" is not a declared env_var`);
    }
  }
```

Search `bundle-contract.mjs` for any whitelist of `generate` values (`grep -n "generate" scripts/lib/bundle-contract.mjs`). Where it compares `v.generate !== "secret"` for **keychain/store_as**, leave that alone: alnum values never use them. If there is a generic allowed-values check, add `"alnum"`.

- [ ] **Step 4: Run the tests and confirm they pass.**

  Run: `npm test -- tests/bundles-skip-when.test.js tests/bundle-env-secrets.test.js tests/bundles-install-job.test.js tests/bundle-contract.test.js`

  Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
cd "$WT"
git add tests/bundles-skip-when.test.js
git commit servers/gateway/bundle-env-secrets.js servers/gateway/bundle-lifecycle.js servers/gateway/routes/bundles.js scripts/lib/bundle-contract.mjs registry/manifest.schema.json tests/bundle-env-secrets.test.js tests/bundles-skip-when.test.js -m "feat(bundles): generate:alnum secrets and docker.skip_when (connector-only installs)"
git show --stat HEAD
```

### Task A2: immich bundle 2.0.0: manifest + compose

**Files:**
- Modify: `bundles/immich/manifest.json`
- Create: `bundles/immich/docker-compose.yml`
- Modify: `bundles/immich/package.json` (version `2.0.0`)
- Test: `tests/immich-bundle.test.js`

**Interfaces:**
- Consumes: A1 (`generate: "alnum"`, `docker.skip_when`).
- Produces:
  - env var names used by later tasks: `IMMICH_MODE`, `IMMICH_URL`, `IMMICH_API_KEY`, `IMMICH_LIBRARY_DIR`, `IMMICH_DB_PASSWORD`, `IMMICH_ADMIN_EMAIL`, `IMMICH_ADMIN_PASSWORD`, `IMMICH_SERVE_PORT`, `IMMICH_PUBLIC_HOST`, `IMMICH_BOOTSTRAP_DONE` (written by bootstrap).
  - compose project `crow-immich`, service names `immich-server`, `immich-machine-learning`, `database`, `redis`.

- [ ] **Step 1: Write the failing test** `tests/immich-bundle.test.js`:

```js
/** Static checks of the immich bundle's hosting half (degoogle plan A2). Text-level: no YAML parser in the repo. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { validateManifest } from "../scripts/lib/bundle-contract.mjs";

const ROOT = join(import.meta.dirname, "..");
const DIR = join(ROOT, "bundles", "immich");
const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8"));
const compose = readFileSync(join(DIR, "docker-compose.yml"), "utf8");
const envVar = (n) => manifest.env_vars.find((v) => v.name === n);
function serviceBlocks() {
  const body = compose.split(/^services:\s*$/m)[1].split(/^networks:\s*$/m)[0];
  const names = [...body.matchAll(/^  ([a-z][a-z0-9-]*):\s*$/gm)].map((m) => m[1]);
  return names.map((name, i) => {
    const start = body.indexOf(`\n  ${name}:`);
    const end = i + 1 < names.length ? body.indexOf(`\n  ${names[i + 1]}:`) : body.length;
    return { name, text: body.slice(start, end) };
  });
}

test("manifest passes the bundle contract; id/tools/skill kept; major version bump", () => {
  const r = validateManifest(manifest, DIR, { bundleExists: (id) => existsSync(join(ROOT, "bundles", id, "manifest.json")) });
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.equal(manifest.id, "immich");
  assert.equal(manifest.version, "2.0.0");
  assert.deepEqual(manifest.server.args, ["server/index.js"]);
  assert.deepEqual(manifest.skills, ["skills/immich.md"]);
  assert.equal(JSON.parse(readFileSync(join(DIR, "package.json"), "utf8")).version, "2.0.0");
});

test("external mode skips containers; no webUI sub-path proxy (Immich cannot live under a sub-path)", () => {
  assert.deepEqual(manifest.docker.skip_when, { env: "IMMICH_MODE", equals: "external" });
  assert.equal(envVar("IMMICH_MODE").default, "local");
  assert.equal(envVar("IMMICH_MODE").pattern, "^(local|external)$");
  assert.equal(manifest.webUI, undefined);
  assert.equal(manifest.panel, "panel/immich.js");
});

test("four services, restart + mem_limit everywhere; cpus caps on server and ML", () => {
  const svcs = serviceBlocks();
  assert.deepEqual(svcs.map((s) => s.name).sort(), ["database", "immich-machine-learning", "immich-server", "redis"]);
  for (const s of svcs) {
    assert.match(s.text, /^    restart: unless-stopped$/m, s.name);
    assert.match(s.text, /^    mem_limit: \d+[mg]$/m, s.name);
  }
  assert.match(svcs.find((s) => s.name === "immich-server").text, /^    cpus: 12$/m);
  assert.match(svcs.find((s) => s.name === "immich-machine-learning").text, /^    cpus: 8$/m);
  for (const n of ["database", "redis"]) assert.match(svcs.find((s) => s.name === n).text, /oom_score_adj: -500/);
});

test("images pinned exactly and mirrored in manifest.images", () => {
  const images = [...new Set([...compose.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map((m) => m[1]))].sort();
  assert.deepEqual(images, [
    "docker.io/valkey/valkey:9@sha256:70739f85ad2ee01a726a965584a0f94895f01b0c60b3cc8b0aeef11eaa6888cf",
    "ghcr.io/immich-app/immich-machine-learning:v3.2.4",
    "ghcr.io/immich-app/immich-server:v3.2.4",
    "ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0@sha256:bcf63357191b76a916ae5eb93464d65c07511da41e3bf7a8416db519b40b1c23",
  ]);
  assert.deepEqual([...manifest.images].sort(), images);
});

test("loopback 2283 only; fixed project; pinned subnet; no GPU", () => {
  const maps = [...compose.matchAll(/^\s*-\s*"([^"]*:\d+:\d+)"\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(maps, ["127.0.0.1:2283:2283"]);
  assert.match(compose, /^name: crow-immich$/m);
  assert.match(compose, /^networks:\n  default:\n    ipam:\n      config:\n        - subnet: 10\.89\.74\.0\/24$/m);
  assert.doesNotMatch(compose, /\/dev\/(kfd|dri)|-rocm|-cuda|-openvino|devices:/);
});

test("library bind never creates a missing host dir (unplugged drive must refuse to start)", () => {
  assert.match(compose, /- type: bind\n        source: \$\{IMMICH_LIBRARY_DIR:-\$\{CROW_HOME:\?[^}]*\}\/immich\/library\}\n        target: \/data\n        bind:\n          create_host_path: false/);
  for (const sub of ["thumbs", "encoded-video", "db-dumps"]) {
    assert.match(compose, new RegExp(`\\$\\{CROW_HOME:\\?[^}]*\\}/immich/${sub}:/data/${sub === "db-dumps" ? "backups" : sub}`));
  }
  assert.match(compose, /\$\{CROW_HOME:\?[^}]*\}\/immich\/postgres:\/var\/lib\/postgresql\/data/);
});

test("every compose var is declared; secrets hard-fail; DB password alphanumeric-generated", () => {
  const used = [...compose.matchAll(/\$\{([A-Z_][A-Z0-9_]*)([^}]*)\}/g)];
  for (const n of new Set(used.map((m) => m[1]))) if (n !== "CROW_HOME") assert.ok(envVar(n), `${n} not declared`);
  assert.equal(envVar("IMMICH_DB_PASSWORD").generate, "alnum");
  for (const m of used.filter((u) => u[1] === "IMMICH_DB_PASSWORD")) assert.match(m[2], /^:\?/);
  assert.doesNotMatch(compose, /IMMICH_ADMIN_PASSWORD|IMMICH_API_KEY/);
});

test("human admin password: generatable, keychain-saved, scrubbed after setup, never propagated", () => {
  const v = envVar("IMMICH_ADMIN_PASSWORD");
  assert.equal(v.secret, true);
  assert.equal(v.generatable, true);
  assert.equal(v.keychain_configure, false);
  assert.equal(v.propagate, false);
  assert.notEqual(v.required, true);
  for (const e of manifest.env_vars) assert.equal(e.propagate, false, `${e.name} must not reach the gateway .env`);
});
```

Also append to `tests/docker-point-of-use.test.js` . It uses that file's `stubDocker`, `restorePath` and `_resetDockerProbeForTest` helpers:

```js
test("immich IMMICH_MODE=external installs without Docker or the RAM/disk gate; local mode still needs Docker", async () => {
  try {
    stubDocker(1);
    _resetDockerProbeForTest();
    const ext = await validateInstall("immich", { envVars: { IMMICH_MODE: "external", IMMICH_URL: "https://x", IMMICH_API_KEY: "k" } });
    assert.equal(ext.ok, true, JSON.stringify(ext));
    _resetDockerProbeForTest();
    const local = await validateInstall("immich", { forceInstall: true, envVars: { IMMICH_MODE: "local" } });
    assert.equal(local.code, "docker_unavailable");
  } finally { restorePath(); }
});
```

- [ ] **Step 2: Run the test and confirm it fails.**

  Run: `npm test -- tests/immich-bundle.test.js`

  Expected: FAIL (no compose; version 1.0.0).

- [ ] **Step 3: Write `bundles/immich/docker-compose.yml`.**

```yaml
## Crow Immich (local mode): Immich server + machine learning (CPU) + Postgres (VectorChord) + Valkey.
##
## Installed by Crow when IMMICH_MODE=local (the default). With IMMICH_MODE=external the
## installer drops this file (manifest docker.skip_when) and the bundle is a connector only.
## Loopback only; the household reaches it through Tailscale Serve (see Photos in Crow).
## NEVER Funnel. Images are pinned: upgrade by hand after reading Immich's release notes,
## using that release's own docker-compose.yml as the reference (docs/guide/photos.md).
## Originals live at IMMICH_LIBRARY_DIR (may be a USB drive). The bind never creates a
## missing directory, so an unplugged drive stops Immich instead of filling the system disk.
## No GPU: machine learning runs on CPU (the GPU is for Crow's models).

name: crow-immich

services:
  immich-server:
    image: ghcr.io/immich-app/immich-server:v3.2.4
    restart: unless-stopped
    mem_limit: 4g
    cpus: 12
    ports:
      - "127.0.0.1:2283:2283"
    environment:
      DB_HOSTNAME: database
      DB_USERNAME: postgres
      DB_PASSWORD: ${IMMICH_DB_PASSWORD:?generated at install}
      DB_DATABASE_NAME: immich
      REDIS_HOSTNAME: redis
    volumes:
      - type: bind
        source: ${IMMICH_LIBRARY_DIR:-${CROW_HOME:?CROW_HOME is required}/immich/library}
        target: /data
        bind:
          create_host_path: false
      - ${CROW_HOME:?CROW_HOME is required}/immich/thumbs:/data/thumbs
      - ${CROW_HOME:?CROW_HOME is required}/immich/encoded-video:/data/encoded-video
      - ${CROW_HOME:?CROW_HOME is required}/immich/db-dumps:/data/backups
      - /etc/localtime:/etc/localtime:ro
    depends_on:
      database:
        condition: service_healthy
      redis:
        condition: service_healthy

  immich-machine-learning:
    image: ghcr.io/immich-app/immich-machine-learning:v3.2.4
    restart: unless-stopped
    mem_limit: 4g
    cpus: 8
    environment:
      MACHINE_LEARNING_WORKERS: "1"
      MACHINE_LEARNING_MODEL_TTL: "300"
    volumes:
      - ${CROW_HOME:?CROW_HOME is required}/immich/model-cache:/cache

  database:
    image: ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0@sha256:bcf63357191b76a916ae5eb93464d65c07511da41e3bf7a8416db519b40b1c23
    restart: unless-stopped
    mem_limit: 2g
    oom_score_adj: -500
    shm_size: 128mb
    environment:
      POSTGRES_PASSWORD: ${IMMICH_DB_PASSWORD:?generated at install}
      POSTGRES_USER: postgres
      POSTGRES_DB: immich
      POSTGRES_INITDB_ARGS: "--data-checksums"
    volumes:
      - ${CROW_HOME:?CROW_HOME is required}/immich/postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d immich"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 30s

  redis:
    image: docker.io/valkey/valkey:9@sha256:70739f85ad2ee01a726a965584a0f94895f01b0c60b3cc8b0aeef11eaa6888cf
    restart: unless-stopped
    mem_limit: 512m
    oom_score_adj: -500
    healthcheck:
      test: ["CMD", "valkey-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 10

networks:
  default:
    ipam:
      config:
        - subnet: 10.89.74.0/24
```

- [ ] **Step 4: Rewrite `bundles/immich/manifest.json`.**

```json
{
  "id": "immich",
  "name": "Immich Photos",
  "version": "2.0.0",
  "description": "Your own private photo library: phone backup, albums, search by what is in the picture, faces. Crow can run Immich for you (tailnet only, never public) or connect to an Immich you already run.",
  "type": "bundle",
  "author": "Crow",
  "category": "media",
  "tags": ["photos", "albums", "self-hosted", "backup", "search", "google photos"],
  "icon": "image",
  "docker": {
    "composefile": "docker-compose.yml",
    "precreate": ["immich", "immich/thumbs", "immich/encoded-video", "immich/db-dumps", "immich/postgres", "immich/model-cache", "immich/backups-staging", "immich/library", "immich/tools"],
    "pull_timeout_s": 1800,
    "skip_when": { "env": "IMMICH_MODE", "equals": "external" }
  },
  "postInstall": { "script": "ops/bootstrap.sh", "timeout_s": 1500 },
  "server": { "command": "node", "args": ["server/index.js"], "envKeys": ["IMMICH_URL", "IMMICH_API_KEY"] },
  "panel": "panel/immich.js",
  "skills": ["skills/immich.md"],
  "images": [
    "docker.io/valkey/valkey:9@sha256:70739f85ad2ee01a726a965584a0f94895f01b0c60b3cc8b0aeef11eaa6888cf",
    "ghcr.io/immich-app/immich-machine-learning:v3.2.4",
    "ghcr.io/immich-app/immich-server:v3.2.4",
    "ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0@sha256:bcf63357191b76a916ae5eb93464d65c07511da41e3bf7a8416db519b40b1c23"
  ],
  "requires": { "min_ram_mb": 6144, "recommended_ram_mb": 10240, "min_disk_mb": 20480 },
  "env_vars": [
    { "name": "IMMICH_MODE", "advanced": false, "description": "local = Crow runs Immich for you (recommended). external = connect to an Immich you already run elsewhere (then fill in its address and an API key).", "default": "local", "required": false, "propagate": false, "pattern": "^(local|external)$", "pattern_hint": "local or external" },
    { "name": "IMMICH_URL", "description": "Immich address Crow's tools use. Local mode: leave the default. External mode: your Immich's address, e.g. https://photos.example.ts.net", "default": "http://127.0.0.1:2283", "required": true, "propagate": false },
    { "name": "IMMICH_API_KEY", "description": "Local mode: filled in automatically by setup. External mode: an API key from your Immich (Account settings → API keys).", "required": true, "secret": true, "propagate": false },
    { "name": "IMMICH_LIBRARY_DIR", "description": "Local mode: folder for your original photos and videos (can be a large external drive; it must already exist). Leave blank for ~/.crow/immich/library.", "default": "", "required": false, "propagate": false, "pattern": "^(/[A-Za-z0-9._@+-]+)*/?$", "pattern_hint": "an absolute folder path without spaces" },
    { "name": "IMMICH_DB_PASSWORD", "description": "Immich database password (generated).", "required": true, "secret": true, "generate": "alnum", "propagate": false },
    { "name": "IMMICH_ADMIN_EMAIL", "description": "Local mode: the email you sign in to Immich with (it is only a login name; nothing is sent to it).", "default": "", "required": false, "propagate": false, "pattern": "^([^@\\s]+@[^@\\s]+)?$", "pattern_hint": "an email address" },
    { "name": "IMMICH_ADMIN_PASSWORD", "description": "Local mode: password for that Immich administrator account. Use Generate or type your own (12-128 characters). Keep 'Save to Crow keychain' ticked to find it later in Settings → Passwords. Setup uses it once, then removes it from this machine's config.", "required": false, "secret": true, "propagate": false, "generatable": true, "keychain_configure": false, "pattern": "^([^\\x00-\\x1f\\x7f]{12,128})?$", "pattern_hint": "12-128 characters, without tabs or line breaks", "keychain_label": "Immich admin password", "keychain_username": "${IMMICH_ADMIN_EMAIL}" },
    { "name": "IMMICH_SERVE_PORT", "description": "Tailscale Serve HTTPS port for Immich.", "default": "8458", "required": false, "propagate": false, "pattern": "^[0-9]{2,5}$", "pattern_hint": "a port number" },
    { "name": "IMMICH_PUBLIC_HOST", "description": "This machine's tailnet name. Leave blank and setup detects it.", "default": "", "required": false, "propagate": false, "pattern": "^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*)?$", "pattern_hint": "a hostname" }
  ],
  "ports": [],
  "notes": "Local mode runs Immich (about 4-10 GB RAM while importing, less when idle; machine learning on CPU, never the GPU). Setup creates your admin account and the key Crow's tools use. Then open Photos in Crow to publish it on your tailnet and set up phones. Uninstalling keeps your photos (IMMICH_LIBRARY_DIR), the database in ~/.crow/immich, the generated secrets, the backup timer and the tailnet address. External mode runs nothing and only connects Crow's tools."
}
```

Set `"version": "2.0.0"` in `bundles/immich/package.json`.

**Note:** `IMMICH_ADMIN_EMAIL`/`PASSWORD` are not `install_required`. That is deliberate: external mode doesn't need them, and `install_required` blocks regardless of mode. Bootstrap (A3) stops with a Configure instruction when they are missing in local mode.

- [ ] **Step 5: Validate the compose without starting it.**

  Run: `cd bundles/immich && CROW_HOME=/tmp/ch IMMICH_DB_PASSWORD=x docker compose config >/dev/null && echo OK1; CROW_HOME=/tmp/ch IMMICH_DB_PASSWORD=x IMMICH_LIBRARY_DIR=<drive-mount>/x docker compose config | grep -A2 'target: /data$'`

  Expected:
  - `OK1`.
  - The first `config` shows `source: /tmp/ch/immich/library`; this proves nested interpolation works.
  - The second shows `<drive-mount>/x`.
  - If nested `${A:-${B}}` is rejected, **stop and ask** before changing the design. The fallback is to make `IMMICH_LIBRARY_DIR` required (`${IMMICH_LIBRARY_DIR:?…}`, `install_required: true`, no default). The installer then always writes an explicit path; the Step 1 regex and the A3 test fixtures change with it.

- [ ] **Step 6: Run the tests and confirm they pass.**

  Run: `npm test -- tests/immich-bundle.test.js tests/bundle-contract.test.js tests/bundle-form-friction.test.js tests/docker-point-of-use.test.js`

  Expected: PASS. (The contract test may need `panel/immich.js` and `ops/bootstrap.sh` to exist. If so, create empty placeholders that A3/A6 fill in, and commit them in this task as `// panel: Task A6` / `#!/usr/bin/env bash\nexit 0`. They are overwritten in A3/A6 before the PR.)

- [ ] **Step 7: Commit.**

```bash
cd "$WT"
git add bundles/immich/docker-compose.yml tests/immich-bundle.test.js bundles/immich/panel bundles/immich/ops
git commit bundles/immich/manifest.json bundles/immich/docker-compose.yml bundles/immich/package.json bundles/immich/panel/immich.js bundles/immich/ops/bootstrap.sh tests/immich-bundle.test.js tests/docker-point-of-use.test.js -m "feat(immich): 2.0.0 hosting half — pinned compose (CPU ML, loopback 2283, unplugged-drive guard), local/external modes"
git show --stat HEAD
```

### Task A3: Bootstrap (admin, connector key, scrub) + ops lib

**Files:**
- Create: `bundles/immich/ops/lib.sh`
- Create: `bundles/immich/ops/envfile.py`
- Create: `bundles/immich/ops/bootstrap.sh`
- Create: `bundles/immich/ops/bootstrap.py`
- Test: `tests/immich-bootstrap.test.js`

**Interfaces:**
- Consumes: A2 env names.
- Produces:
  - `.env` keys `IMMICH_API_KEY`, `IMMICH_URL`, `IMMICH_PUBLIC_HOST`, `IMMICH_BOOTSTRAP_DONE=1`; `IMMICH_ADMIN_PASSWORD` removed.
  - `envfile.py get <file> <KEY>` and `envfile.set_keys(path, updates, remove)`.
  - bash `lib.sh` functions `log die env_get dc step random_pw`, and vars `BUNDLE_DIR CROW_HOME DC OPS_DIR`.

- [ ] **Step 1: Write the failing test** `tests/immich-bootstrap.test.js`:

```js
/**
 * ops/bootstrap.py against a FAKE Immich API (in-process HTTP server). The child runs
 * async (execFile), never spawnSync: the fake server lives on this event loop.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, statSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatEnvLines, parseEnvText } from "../servers/gateway/bundle-env-codec.js";

const OPS = join(import.meta.dirname, "..", "bundles", "immich", "ops");
const PW = `Adm "in" pass $word 'x' #1`;      // installer-quoted on disk
const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function fakeImmich(state) {
  const calls = [];
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(obj === undefined ? "" : JSON.stringify(obj)); };
      const p = req.url;
      if (p === "/api/server/ping") return state.pings-- > 0 ? send(503, {}) : send(200, { res: "pong" });
      if (p === "/api/users/me") return state.validKeys.has(req.headers["x-api-key"]) ? send(200, { id: "u1" }) : send(401, { message: "Invalid API key" });
      if (p === "/api/auth/admin-sign-up" && req.method === "POST") {
        if (state.admin) return send(400, { message: "The server already has an admin" });
        state.admin = { email: body.email, password: body.password }; return send(201, { id: "u1" });
      }
      if (p === "/api/auth/login") return state.admin && body.email === state.admin.email && body.password === state.admin.password ? send(201, { accessToken: "BEARER-1" }) : send(401, { message: "Incorrect email or password" });
      if (p === "/api/auth/logout") return send(200, { successful: true });
      if (req.headers.authorization !== "Bearer BEARER-1") return send(401, {});
      if (p === "/api/api-keys" && req.method === "GET") return send(200, state.keys.map(({ id, name }) => ({ id, name })));
      if (p.startsWith("/api/api-keys/") && req.method === "DELETE") {
        const id = p.split("/").pop(); const k = state.keys.find((x) => x.id === id);
        state.keys = state.keys.filter((x) => x.id !== id); if (k) state.validKeys.delete(k.secret); return send(204);
      }
      if (p === "/api/api-keys" && req.method === "POST") {
        if (state.rejectPermissions) return send(400, { message: "permissions.0 must be one of the following values: all, ..." });
        const n = state.keys.length + 1; const secret = `key${n}`.padEnd(43, "Z");
        const id = `00000000-0000-0000-0000-00000000000${n}`;
        state.keys.push({ id, name: body.name, secret, permissions: body.permissions }); state.validKeys.add(secret);
        return send(201, { secret, apiKey: { id, name: body.name } });
      }
      send(404, { message: "not found" });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, calls, port: srv.address().port })));
}

function setup(envVars) {
  const root = mkdtempSync(join(tmpdir(), "im-boot-")); roots.push(root);
  const home = join(root, "home"); const bundle = join(home, "bundles", "immich"); const bin = join(root, "bin");
  for (const d of [bundle, bin, join(home, "immich", "library")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bundle, ".env"), formatEnvLines(envVars), { mode: 0o600 });
  writeFileSync(join(bin, "tailscale"), `#!/usr/bin/env bash\necho '{"Self":{"DNSName":"box.tailnet-example.ts.net."}}'\n`); chmodSync(join(bin, "tailscale"), 0o755);
  return { root, home, bundle, bin };
}

function run(ctx, port) {
  return new Promise((resolve) => {
    execFile("bash", [join(OPS, "bootstrap.sh")], {
      env: { PATH: process.env.PATH, HOME: ctx.root, CROW_HOME: ctx.home, CROW_BUNDLE_DIR: ctx.bundle,
        IMMICH_BOOTSTRAP_API: `http://127.0.0.1:${port}/api`, IMMICH_TS: join(ctx.bin, "tailscale"),
        IMMICH_WAIT_S: "10", IMMICH_SLEEP_S: "0.05" },
      timeout: 30000,
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}
const envOf = (ctx) => parseEnvText(readFileSync(join(ctx.bundle, ".env"), "utf8"));
const BASE = { IMMICH_MODE: "local", IMMICH_DB_PASSWORD: "abcDEF123", IMMICH_ADMIN_EMAIL: "admin@example.lan", IMMICH_ADMIN_PASSWORD: PW };

test("fresh install: admin created, key minted, password scrubbed, never printed", async () => {
  const state = { pings: 2, admin: null, keys: [], validKeys: new Set() };
  const { srv, calls, port } = await fakeImmich(state);
  try {
    const ctx = setup(BASE);
    const r = await run(ctx, port);
    assert.equal(r.code, 0, r.stderr);
    const env = envOf(ctx);
    assert.equal(state.admin.password, PW, "the installer-quoted password reached Immich verbatim");
    assert.equal(env.IMMICH_API_KEY, state.keys[0].secret);
    assert.equal(env.IMMICH_ADMIN_PASSWORD, undefined);
    assert.equal(env.IMMICH_URL, "http://127.0.0.1:2283");
    assert.equal(env.IMMICH_PUBLIC_HOST, "box.tailnet-example.ts.net");
    assert.equal(env.IMMICH_BOOTSTRAP_DONE, "1");
    assert.equal(env.IMMICH_DB_PASSWORD, "abcDEF123", "other lines kept");
    assert.equal(statSync(join(ctx.bundle, ".env")).mode & 0o777, 0o600);
    assert.deepEqual(state.keys[0].permissions.sort(), ["album.create", "album.read", "albumAsset.create", "asset.read", "asset.statistics", "asset.view", "session.read", "user.read"]);
    for (const out of [r.stdout, r.stderr]) { assert.ok(!out.includes(PW)); assert.ok(!out.includes(state.keys[0].secret)); }
    assert.ok(calls.some((c) => c.url === "/api/auth/logout"));
    assert.ok(existsSync(join(ctx.home, "immich", "library", "README-CROW.txt")));
  } finally { srv.close(); }
});

test("re-run with a working key: no login, no new key", async () => {
  const state = { pings: 0, admin: { email: "admin@example.lan", password: PW }, keys: [{ id: "00000000-0000-0000-0000-000000000001", name: "crow-connector", secret: "K".repeat(43) }], validKeys: new Set(["K".repeat(43)]) };
  const { srv, calls, port } = await fakeImmich(state);
  try {
    const ctx = setup({ IMMICH_MODE: "local", IMMICH_DB_PASSWORD: "abc", IMMICH_ADMIN_EMAIL: "admin@example.lan", IMMICH_API_KEY: "K".repeat(43) });
    const r = await run(ctx, port);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!calls.some((c) => c.url.startsWith("/api/auth/")));
    assert.equal(state.keys.length, 1);
  } finally { srv.close(); }
});

test("stale key and no password: clear Configure instruction, exit 1, nothing created", async () => {
  const state = { pings: 0, admin: { email: "admin@example.lan", password: PW }, keys: [], validKeys: new Set() };
  const { srv, port } = await fakeImmich(state);
  try {
    const ctx = setup({ IMMICH_MODE: "local", IMMICH_DB_PASSWORD: "abc", IMMICH_ADMIN_EMAIL: "admin@example.lan", IMMICH_API_KEY: "S".repeat(43) });
    const r = await run(ctx, port);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Configure/);
    assert.equal(state.keys.length, 0);
  } finally { srv.close(); }
});

test("stale key with password: old crow-connector key deleted, new one minted", async () => {
  const old = { id: "00000000-0000-0000-0000-000000000009", name: "crow-connector", secret: "O".repeat(43) };
  const state = { pings: 0, admin: { email: "admin@example.lan", password: PW }, keys: [old], validKeys: new Set() };
  const { srv, port } = await fakeImmich(state);
  try {
    const ctx = setup({ ...BASE, IMMICH_API_KEY: "S".repeat(43) });
    const r = await run(ctx, port);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(state.keys.length, 1);
    assert.notEqual(state.keys[0].id, old.id);
    assert.equal(envOf(ctx).IMMICH_API_KEY, state.keys[0].secret);
  } finally { srv.close(); }
});

test("permission rejected: names the HTTP status and Immich's message, keeps the password", async () => {
  const state = { pings: 0, admin: null, keys: [], validKeys: new Set(), rejectPermissions: true };
  const { srv, port } = await fakeImmich(state);
  try {
    const ctx = setup(BASE);
    const r = await run(ctx, port);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /HTTP 400.*must be one of/);
    assert.equal(envOf(ctx).IMMICH_ADMIN_PASSWORD, PW);
  } finally { srv.close(); }
});

test("login rejected: exit 1, password kept for a fixed re-run", async () => {
  const state = { pings: 0, admin: { email: "admin@example.lan", password: "a-different-one" }, keys: [], validKeys: new Set() };
  const { srv, port } = await fakeImmich(state);
  try {
    const ctx = setup(BASE);
    const r = await run(ctx, port);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /rejected the admin login/);
    assert.equal(envOf(ctx).IMMICH_ADMIN_PASSWORD, PW);
  } finally { srv.close(); }
});

test("external mode: no HTTP at all, exit 0", async () => {
  const state = { pings: 0, admin: null, keys: [], validKeys: new Set() };
  const { srv, calls, port } = await fakeImmich(state);
  try {
    const ctx = setup({ IMMICH_MODE: "external", IMMICH_URL: "https://x", IMMICH_API_KEY: "k" });
    const r = await run(ctx, port);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(calls.length, 0);
  } finally { srv.close(); }
});
```

- [ ] **Step 2: Run the test and confirm it fails.**

  Run: `npm test -- tests/immich-bootstrap.test.js`

  Expected: FAIL (`bootstrap.sh` is a placeholder / `bootstrap.py` is missing).

- [ ] **Step 3: Write `bundles/immich/ops/envfile.py`.** It is the Workspace reader plus an atomic writer.

```python
#!/usr/bin/env python3
"""Read/write a Crow bundle .env without any shell evaluation.

get(): decodes exactly what Crow's installer writes (servers/gateway/bundle-env-codec.js):
bare values, 'single-quoted' (backslash-quote -> quote) and "double-quoted" (escapes for
backslash, double quote, $, n, t, r), an optional `export ` prefix and a trailing ` #comment`
on bare values. Last occurrence wins.
set_keys(): rewrites atomically at mode 600, dropping every line for the changed/removed keys
and appending the new values BARE. It refuses values with characters a bare value cannot
hold, so it never has to quote (the values it writes are API keys, URLs, hostnames, "1").
Usage: envfile.py get <file> <KEY>   -> prints the value (no newline); exit 0 if absent.
"""
import os
import re
import sys
import tempfile

LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$")
DQ = {"\\": "\\", '"': '"', "$": "$", "n": "\n", "t": "\t", "r": "\r"}
SAFE_VALUE = re.compile(r"^[A-Za-z0-9._:/@+-]*$")
KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def decode(raw):
    s = raw.lstrip()
    if s.startswith("'"):
        out, i = [], 1
        while i < len(s):
            c = s[i]
            if c == "\\" and i + 1 < len(s) and s[i + 1] == "'":
                out.append("'")
                i += 2
                continue
            if c == "'":
                return "".join(out)
            out.append(c)
            i += 1
        return s
    if s.startswith('"'):
        out, i = [], 1
        while i < len(s):
            c = s[i]
            if c == "\\" and i + 1 < len(s):
                n = s[i + 1]
                if n in DQ:
                    out.append(DQ[n])
                    i += 2
                    continue
                out.append(c)
                i += 1
                continue
            if c == '"':
                return "".join(out)
            out.append(c)
            i += 1
        return s
    return re.split(r"\s+#", s, maxsplit=1)[0].strip()


def get(path, key):
    val = ""
    with open(path, encoding="utf-8") as f:
        for line in f.read().split("\n"):
            m = LINE.match(line.rstrip("\r"))
            if m and m.group(1) == key:
                val = decode(m.group(2))
    return val


def set_keys(path, updates=None, remove=()):
    updates = dict(updates or {})
    for k, v in updates.items():
        if not KEY.match(k) or not isinstance(v, str) or not SAFE_VALUE.match(v):
            raise ValueError(f"refusing to write {k}: its value has characters this writer does not quote")
    drop = set(updates) | set(remove)
    with open(path, encoding="utf-8") as f:
        lines = f.read().split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    kept = []
    for line in lines:
        m = LINE.match(line.rstrip("\r"))
        if m and m.group(1) in drop:
            continue
        kept.append(line)
    kept += [f"{k}={v}" for k, v in updates.items()]
    fd, tmp = tempfile.mkstemp(prefix=".env.", dir=os.path.dirname(os.path.abspath(path)))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write("\n".join(kept) + "\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] != "get":
        sys.stderr.write("usage: envfile.py get <file> <KEY>\n")
        sys.exit(2)
    sys.stdout.write(get(sys.argv[2], sys.argv[3]))
```

- [ ] **Step 4: Write `bundles/immich/ops/lib.sh`.**

```bash
#!/usr/bin/env bash
# Shared helpers for the Immich ops scripts. Source it; do not execute it:
#   . "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# Honors CROW_HOME / CROW_BUNDLE_DIR (the postInstall hook sets both); falls back to this
# file's location / ~/.crow only when they are unset. Secrets never go in argv.
BUNDLE_DIR="${CROW_BUNDLE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export CROW_HOME="${CROW_HOME:-$HOME/.crow}"
DC="${IMMICH_DC:-docker compose}"
OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# env_get KEY: the value compose would see, decoded by ops/envfile.py (no eval, no sed).
env_get() {
  local f="${ENV_FILE:-$BUNDLE_DIR/.env}"
  [ -f "$f" ] || return 0
  command -v python3 >/dev/null 2>&1 || die "python3 is required (ops/envfile.py); install it and re-run"
  python3 "$OPS_DIR/envfile.py" get "$f" "$1"
}

log() { printf '[immich] %s\n' "$*"; }
die() { printf '[immich] ERROR: %s\n' "$*" >&2; exit 1; }
dc() { (cd "$BUNDLE_DIR" && $DC "$@"); }

set -E
STEP="starting"
step() { STEP="$*"; }
trap '_rc=$?; [ "$BASH_SUBSHELL" = 0 ] && printf "[immich] ERROR: %s failed (rc %s)\n" "$STEP" "$_rc" >&2' ERR

# random_pw N: N alphanumerics (no pipeline: safe under pipefail).
random_pw() {
  local raw
  raw="$(head -c 512 /dev/urandom | base64 -w0)"
  raw="${raw//[^A-Za-z0-9]/}"
  [ "${#raw}" -ge "$1" ] || die "could not gather randomness"
  printf '%s' "${raw:0:$1}"
}
```

- [ ] **Step 5: Write `bundles/immich/ops/bootstrap.sh`.**

```bash
#!/usr/bin/env bash
# Crow Immich post-install setup (manifest postInstall). Idempotent; safe to re-run:
#   bash ~/.crow/bundles/immich/ops/bootstrap.sh
set -euo pipefail
umask 077
command -v python3 >/dev/null 2>&1 || { echo "[immich] ERROR: python3 is required for setup" >&2; exit 1; }
exec python3 "$(dirname "${BASH_SOURCE[0]}")/bootstrap.py"
```

- [ ] **Step 6: Write `bundles/immich/ops/bootstrap.py`.**

```python
#!/usr/bin/env python3
"""Crow Immich post-install setup (local mode). Idempotent; safe to re-run:
    bash ~/.crow/bundles/immich/ops/bootstrap.sh
Creates the admin (first run), mints the `crow-connector` API key Crow's tools use, writes
it to the bundle .env (mode 600), removes the admin password from .env, and records the
tailnet name. Never prints a secret and never puts one in argv: secrets travel only in
HTTP bodies/headers to the loopback Immich API and in the mode-600 .env."""
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

OPS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, OPS)
import envfile  # noqa: E402

BUNDLE_DIR = os.environ.get("CROW_BUNDLE_DIR") or os.path.dirname(OPS)
CROW_HOME = os.environ.get("CROW_HOME") or os.path.join(os.path.expanduser("~"), ".crow")
ENV_FILE = os.path.join(BUNDLE_DIR, ".env")
API = os.environ.get("IMMICH_BOOTSTRAP_API", "http://127.0.0.1:2283/api").rstrip("/")
LOCAL_URL = "http://127.0.0.1:2283"
WAIT_S = float(os.environ.get("IMMICH_WAIT_S", "600"))
SLEEP_S = float(os.environ.get("IMMICH_SLEEP_S", "5"))
TS = os.environ.get("IMMICH_TS", "tailscale")
KEY_NAME = "crow-connector"
# Least privilege for bundles/immich/server (search/albums/assets) + the Settings checklist
# (sessions, statistics). Names follow Immich's Permission enum; an unknown name makes
# POST /api-keys answer 400 naming it, and setup stops with that message.
PERMISSIONS = [
    "asset.read", "asset.view", "asset.statistics",
    "album.read", "album.create", "albumAsset.create",
    "session.read", "user.read",
]
HOST_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+$")
KEY_RE = re.compile(r"^[A-Za-z0-9_-]{16,256}$")
ID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")
RERUN = f"bash {os.path.join(BUNDLE_DIR, 'ops', 'bootstrap.sh')}"


def log(msg):
    print(f"[immich] {msg}", flush=True)


def die(msg):
    print(f"[immich] ERROR: {msg}", file=sys.stderr, flush=True)
    sys.exit(1)


def get(key):
    return envfile.get(ENV_FILE, key)


def call(method, path, body=None, bearer=None, api_key=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if bearer:
        req.add_header("Authorization", "Bearer " + bearer)
    if api_key:
        req.add_header("x-api-key", api_key)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            status, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    except (urllib.error.URLError, OSError):
        return 0, None
    try:
        return status, (json.loads(raw) if raw else None)
    except ValueError:
        return status, None


def wait_ready():
    deadline = time.monotonic() + WAIT_S
    while True:
        status, body = call("GET", "/server/ping")
        if status == 200 and isinstance(body, dict) and body.get("res") == "pong":
            log("Immich is up")
            return
        if time.monotonic() >= deadline:
            die(f"Immich did not answer within {int(WAIT_S)}s (docker compose -p crow-immich ps; then re-run: {RERUN})")
        time.sleep(SLEEP_S)


def key_works(key):
    status, _ = call("GET", "/users/me", api_key=key)
    return status == 200


def mint_key():
    email = get("IMMICH_ADMIN_EMAIL")
    pw = get("IMMICH_ADMIN_PASSWORD")
    if not EMAIL_RE.match(email or ""):
        die(f"IMMICH_ADMIN_EMAIL is not set. Open Extensions → Immich Photos → Configure, set it, then re-run: {RERUN}")
    if not pw:
        die("the connector API key is missing or no longer works, and the admin password is not in this "
            "machine's config (setup removes it after first use). Open Extensions → Immich Photos → Configure, "
            f"enter your Immich admin password (Settings → Passwords has it), then re-run: {RERUN}")
    status, _ = call("POST", "/auth/admin-sign-up", {"email": email, "password": pw, "name": "Admin"})
    if status in (200, 201):
        log("admin account created")
    elif status == 400:
        log("admin account already exists")
    else:
        die(f"admin sign-up answered HTTP {status}; re-run: {RERUN}")
    status, body = call("POST", "/auth/login", {"email": email, "password": pw})
    if status not in (200, 201) or not isinstance(body, dict) or not body.get("accessToken"):
        die(f"Immich rejected the admin login (HTTP {status}). Check IMMICH_ADMIN_EMAIL/PASSWORD in Configure "
            f"(they must match the existing Immich admin), then re-run: {RERUN}")
    bearer = body["accessToken"]
    try:
        status, keys = call("GET", "/api-keys", bearer=bearer)
        if status == 200 and isinstance(keys, list):
            for k in keys:
                if isinstance(k, dict) and k.get("name") == KEY_NAME and ID_RE.match(str(k.get("id", ""))):
                    call("DELETE", f"/api-keys/{k['id']}", bearer=bearer)
                    log("removed a stale crow-connector key")
        status, body = call("POST", "/api-keys", {"name": KEY_NAME, "permissions": PERMISSIONS}, bearer=bearer)
        if status not in (200, 201) or not isinstance(body, dict):
            msg = body.get("message") if isinstance(body, dict) else None
            die(f"Immich refused to create the connector API key (HTTP {status}{': ' + str(msg) if msg else ''}). "
                "If it names a permission, this Immich version renamed it: fix PERMISSIONS in ops/bootstrap.py")
        secret = body.get("secret")
        if not isinstance(secret, str) or not KEY_RE.match(secret):
            die("Immich returned an API key in an unexpected format")
        return secret
    finally:
        call("POST", "/auth/logout", bearer=bearer)


def public_host():
    host = get("IMMICH_PUBLIC_HOST")
    if not host:
        try:
            out = subprocess.run([TS, "status", "--json"], capture_output=True, text=True, timeout=15).stdout
            host = json.loads(out)["Self"]["DNSName"].rstrip(".")
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            host = ""
    if not host or not HOST_RE.match(host):
        die(f"cannot work out this machine's tailnet name. Set IMMICH_PUBLIC_HOST in Configure, then re-run: {RERUN}")
    return host


def write_library_readme():
    lib = get("IMMICH_LIBRARY_DIR") or os.path.join(CROW_HOME, "immich", "library")
    path = os.path.join(lib, "README-CROW.txt")
    if os.path.isdir(lib) and not os.path.exists(path):
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write("This folder is Immich's photo library, managed by Crow.\n"
                        "Do not add, rename or delete files here by hand (also not over the network share):\n"
                        "Immich's database would no longer match. Use Immich (Photos in Crow) instead.\n")
        except OSError as e:
            log(f"note: could not write {path}: {e.strerror}")


def main():
    if not os.path.isfile(ENV_FILE):
        die(f".env missing at {ENV_FILE} (reinstall Immich Photos from the Extensions page)")
    mode = get("IMMICH_MODE") or "local"
    if mode != "local":
        log(f"IMMICH_MODE={mode}: Crow does not run Immich in this mode; nothing to set up")
        return
    if not get("IMMICH_DB_PASSWORD"):
        die(f"IMMICH_DB_PASSWORD is empty in {ENV_FILE}. Restore the line from "
            f"{os.path.join(CROW_HOME, 'secrets', 'bundle-env', 'immich.env')} (keep the file mode 600), then re-run: {RERUN}")
    wait_ready()
    key = get("IMMICH_API_KEY")
    if key and key_works(key):
        log("connector API key: present and working")
    else:
        key = mint_key()
        envfile.set_keys(ENV_FILE, {"IMMICH_API_KEY": key})
        log("connector API key: minted and stored in .env (mode 600)")
    if get("IMMICH_ADMIN_PASSWORD"):
        envfile.set_keys(ENV_FILE, remove=["IMMICH_ADMIN_PASSWORD"])
        log("admin password used once; removed from .env (it is in Settings → Passwords if you saved it)")
    host = public_host()
    updates = {"IMMICH_PUBLIC_HOST": host, "IMMICH_BOOTSTRAP_DONE": "1"}
    if not get("IMMICH_URL"):
        updates["IMMICH_URL"] = LOCAL_URL
    write_library_readme()
    envfile.set_keys(ENV_FILE, updates)
    port = get("IMMICH_SERVE_PORT") or "8458"
    log(f"done. Immich: https://{host}:{port} (publish it on your tailnet from Photos in Crow)")


if __name__ == "__main__":
    main()
```

Make both executable: `chmod 755 bundles/immich/ops/bootstrap.sh`.

- [ ] **Step 7: Run the test and confirm it passes.**

  Run: `npm test -- tests/immich-bootstrap.test.js`

  Expected: PASS (7 tests).

- [ ] **Step 8: Commit.**

```bash
cd "$WT"
git add bundles/immich/ops tests/immich-bootstrap.test.js
git commit bundles/immich/ops/lib.sh bundles/immich/ops/envfile.py bundles/immich/ops/bootstrap.sh bundles/immich/ops/bootstrap.py tests/immich-bootstrap.test.js -m "feat(immich): post-install setup — admin, least-privilege connector key, password scrub, tailnet name"
git show --stat HEAD
```

### Task A4: Backups, restore-check, storage-check

**Files:**
- Create: `bundles/immich/ops/backup.sh`
- Create: `bundles/immich/ops/install-backup-timer.sh`
- Create: `bundles/immich/ops/restore-check.sh`
- Create: `bundles/immich/ops/storage-check.sh`
- Test: `tests/immich-backup.test.js`

**Interfaces:**
- Consumes: `lib.sh` (A3).
- Produces:
  - `ops/storage-check.sh [--min-free-gb N]` (exit 3 when there is not enough room).
  - `ops/restore-check.sh <archive> <passfile>`.
  - Timer unit names `crow-immich-backup.{service,timer}`.

- [ ] **Step 1: Write the failing test** `tests/immich-backup.test.js`:

```js
/** Immich backup/restore-check/storage-check against a FAKE docker compose; real gpg in a scratch GNUPGHOME. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, chmodSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OPS = join(import.meta.dirname, "..", "bundles", "immich", "ops");
const SKIP = spawnSync("gpg", ["--version"]).status !== 0 && "gpg not installed";
const ctxs = [];
after(() => { for (const c of ctxs) { spawnSync("gpgconf", ["--homedir", c.gnupg, "--kill", "gpg-agent"]); rmSync(c.root, { recursive: true, force: true }); } });

const FAKE_DC = String.raw`#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_STATE/calls.log"
case "$*" in
  *"pg_dump"*)
    if [ -f "$FAKE_STATE/fail-dump" ]; then echo "dump exploded" >&2; exit 2; fi
    printf -- '-- FAKE SQL immich-db-row\n-- PostgreSQL database dump complete\n' ;;
  *) : ;;
esac
exit 0
`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "im-bak-"));
  const c = { root, home: join(root, "home"), bundle: join(root, "bundle"), dest: join(root, "external"), st: join(root, "state"), bin: join(root, "bin"), gnupg: join(root, "gnupg") };
  for (const d of [c.bundle, join(c.home, "immich"), c.dest, c.st, c.bin, c.gnupg]) mkdirSync(d, { recursive: true });
  chmodSync(c.gnupg, 0o700);
  writeFileSync(join(c.bin, "dc"), FAKE_DC); chmodSync(join(c.bin, "dc"), 0o755);
  writeFileSync(join(c.bin, "alerts.sh"), 'send_alert() { printf "%s|%s\\n" "$1" "$2" >> "$FAKE_STATE/alerts.log"; }\n');
  writeFileSync(join(c.bundle, ".env"), "IMMICH_DB_PASSWORD=dbSECRET123\nIMMICH_MODE=local\n", { mode: 0o600 });
  writeFileSync(join(c.home, "immich", "backup-passphrase"), "test-passphrase-123\n", { mode: 0o600 });
  ctxs.push(c);
  return c;
}
const envFor = (c, extra = {}) => ({ PATH: process.env.PATH, HOME: c.root, GNUPGHOME: c.gnupg, CROW_HOME: c.home, CROW_BUNDLE_DIR: c.bundle,
  IMMICH_DC: join(c.bin, "dc"), FAKE_STATE: c.st, IMMICH_BACKUP_DEST: c.dest, IMMICH_BACKUP_ALERT_LIB: join(c.bin, "alerts.sh"), ...extra });

test("backup → one 600 tar of two gpg members; no plaintext; restore-check passes", { skip: SKIP }, () => {
  const c = setup();
  const r = spawnSync("bash", [join(OPS, "backup.sh")], { env: envFor(c), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const tars = readdirSync(c.dest).filter((f) => /^crow-immich-\d{8}-\d{6}\.tar$/.test(f));
  assert.equal(tars.length, 1);
  const tar = join(c.dest, tars[0]);
  assert.equal(statSync(tar).mode & 0o777, 0o600);
  const list = spawnSync("tar", ["-tf", tar], { encoding: "utf8" }).stdout.trim().split("\n").sort();
  assert.deepEqual(list, ["bundle.env.gpg", "db.sql.gz.gpg"]);
  const raw = spawnSync("tar", ["-xOf", tar], { encoding: "latin1" }).stdout;
  assert.ok(!raw.includes("dbSECRET123") && !raw.includes("immich-db-row"), "no plaintext in the archive");
  const chk = spawnSync("bash", [join(OPS, "restore-check.sh"), tar, join(c.home, "immich", "backup-passphrase")], { env: envFor(c), encoding: "utf8" });
  assert.equal(chk.status, 0, chk.stderr);
  assert.match(chk.stdout, /restore-check OK/);
});

test("dump failure: no archive, loud alert, staging cleaned", { skip: SKIP }, () => {
  const c = setup();
  writeFileSync(join(c.st, "fail-dump"), "");
  const r = spawnSync("bash", [join(OPS, "backup.sh")], { env: envFor(c), encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.equal(readdirSync(c.dest).length, 0);
  assert.match(spawnSync("cat", [join(c.st, "alerts.log")], { encoding: "utf8" }).stdout, /Immich backup FAILED/);
  assert.deepEqual(readdirSync(join(c.home, "immich", "backups-staging")).filter((f) => f.startsWith("run-")), []);
});

test("preflight refusals happen before any dump: unset dest, bad passphrase mode", { skip: SKIP }, () => {
  const c = setup();
  let r = spawnSync("bash", [join(OPS, "backup.sh")], { env: envFor(c, { IMMICH_BACKUP_DEST: "" }), encoding: "utf8" });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /IMMICH_BACKUP_DEST is not set/);
  chmodSync(join(c.home, "immich", "backup-passphrase"), 0o644);
  r = spawnSync("bash", [join(OPS, "backup.sh")], { env: envFor(c), encoding: "utf8" });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /mode 600/);
  assert.equal(spawnSync("bash", ["-c", `test -f ${join(c.st, "calls.log")}`]).status, 1, "never reached docker");
});

test("restore-check refuses a wrong passphrase", { skip: SKIP }, () => {
  const c = setup();
  assert.equal(spawnSync("bash", [join(OPS, "backup.sh")], { env: envFor(c) }).status, 0);
  const tar = join(c.dest, readdirSync(c.dest)[0]);
  writeFileSync(join(c.root, "wrong"), "nope\n", { mode: 0o600 });
  const chk = spawnSync("bash", [join(OPS, "restore-check.sh"), tar, join(c.root, "wrong")], { env: envFor(c), encoding: "utf8" });
  assert.notEqual(chk.status, 0);
});

test("storage-check --min-free-gb: exit 3 when the disk is too full", () => {
  const c = setup();
  const r = spawnSync("bash", [join(OPS, "storage-check.sh"), "--min-free-gb", "999999999"], { env: envFor(c), encoding: "utf8" });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  const ok = spawnSync("bash", [join(OPS, "storage-check.sh"), "--min-free-gb", "0"], { env: envFor(c), encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /thumbs/);
});
```

- [ ] **Step 2: Run the test and confirm it fails.**

  Run: `npm test -- tests/immich-backup.test.js`

  Expected: FAIL (the scripts are missing).

- [ ] **Step 3: Write `bundles/immich/ops/backup.sh`.**

```bash
#!/usr/bin/env bash
# Nightly Crow Immich backup (crow-immich-backup.timer, 04:15): the Immich DATABASE + the
# bundle .env, each gpg-encrypted (AES256, passphrase file), as one tar: latest in NVMe
# staging, 14 days on the backup drive. pg_dump is consistent on its own, so Immich keeps
# running. Originals (the photo files) are NOT copied here: spec §3.1.
set -euo pipefail
umask 077

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step "backup"
IM="${IMMICH_DATA_ROOT:-$CROW_HOME/immich}"
STAGING="$IM/backups-staging"
DEST="${IMMICH_BACKUP_DEST:-}"
MOUNT="${IMMICH_BACKUP_MOUNT:-}"
PASSFILE="${IMMICH_BACKUP_PASSFILE:-$IM/backup-passphrase}"
KEEP_DAYS="${IMMICH_BACKUP_KEEP_DAYS:-14}"
DUMP_S="${IMMICH_BACKUP_DUMP_S:-1800}"
GPG="${IMMICH_GPG:-gpg}"
TS="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="crow-immich-$TS.tar"

alert() {  # loud by design: a silent backup failure is the same as no backup
  local lib="${IMMICH_BACKUP_ALERT_LIB:-}"
  if [ -n "$lib" ] && [ -r "$lib" ]; then
    ( set +eu; source "$lib"; send_alert "$1" "$2" high ) >/dev/null 2>&1 || true
  fi
  printf '[immich-backup] ALERT: %s: %s\n' "$1" "$2" >&2
}
abort() { alert "Immich backup ABORTED" "$1"; exit 1; }
enc() { "$GPG" --batch --yes --pinentry-mode loopback --passphrase-file "$PASSFILE" --no-symkey-cache --symmetric --cipher-algo AES256 --compress-algo none -o "$1"; }

[ -n "$DEST" ] || abort "IMMICH_BACKUP_DEST is not set (re-run ops/install-backup-timer.sh --dest <dir>)"
[ -f "$PASSFILE" ] || abort "no backup passphrase at $PASSFILE (run ops/install-backup-timer.sh first)"
[ "$(stat -c %a "$PASSFILE")" = "600" ] || abort "$PASSFILE must be mode 600"
[ -f "$BUNDLE_DIR/.env" ] || abort "no .env at $BUNDLE_DIR"
if [ -n "$MOUNT" ]; then mountpoint -q "$MOUNT" || abort "$MOUNT is not a mounted filesystem (drive unplugged?)"; fi
mkdir -p "$DEST" 2>/dev/null || true
{ [ -d "$DEST" ] && [ -w "$DEST" ]; } || abort "$DEST not writable"
mkdir -p "$STAGING"
rm -rf "$STAGING"/run-*
WORK="$(mktemp -d "$STAGING/run-$TS.XXXXXX")"

cleanup() {
  local rc=$?
  rm -rf "$WORK" "$STAGING/$ARCHIVE.part" "$DEST/$ARCHIVE.part" 2>/dev/null || true
  [ "$rc" = 0 ] || alert "Immich backup FAILED" "exit $rc at $(date +%T); see journalctl --user -u crow-immich-backup"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 143' INT TERM

step "dumping the database"
(cd "$BUNDLE_DIR" && timeout --kill-after=10 "$DUMP_S" $DC exec -T database sh -c 'exec pg_dump --clean --if-exists --dbname=immich --username=postgres') \
  | gzip -c | enc "$WORK/db.sql.gz.gpg"
step "encrypting the config"
enc "$WORK/bundle.env.gpg" < "$BUNDLE_DIR/.env"
step "writing the archive"
tar -C "$WORK" -cf "$STAGING/$ARCHIVE.part" db.sql.gz.gpg bundle.env.gpg
mv "$STAGING/$ARCHIVE.part" "$STAGING/$ARCHIVE"
chmod 600 "$STAGING/$ARCHIVE"
cp "$STAGING/$ARCHIVE" "$DEST/$ARCHIVE.part"
mv "$DEST/$ARCHIVE.part" "$DEST/$ARCHIVE"

find "$STAGING" -maxdepth 1 -name 'crow-immich-*.tar' ! -name "$ARCHIVE" -delete
find "$DEST" -maxdepth 1 -name 'crow-immich-*.tar' -mtime +"$((KEEP_DAYS - 1))" -delete
log "backup ok: $DEST/$ARCHIVE ($(du -h "$DEST/$ARCHIVE" | cut -f1))"
```

- [ ] **Step 4: Write `bundles/immich/ops/restore-check.sh`.**

```bash
#!/usr/bin/env bash
# Verify a Crow Immich backup opens: both members decrypt and the dump is complete.
#   bash ops/restore-check.sh <crow-immich-YYYYMMDD-HHMMSS.tar> <passphrase-file>
# A full restore follows Immich's documented procedure (docs/guide/photos.md).
set -euo pipefail
umask 077
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step "restore-check"
ARCHIVE="${1:?usage: restore-check.sh <archive.tar> <passphrase-file>}"
PASSFILE="${2:?usage: restore-check.sh <archive.tar> <passphrase-file>}"
GPG="${IMMICH_GPG:-gpg}"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
tar -C "$T" -xf "$ARCHIVE" db.sql.gz.gpg bundle.env.gpg
dec() { "$GPG" --batch --quiet --pinentry-mode loopback --passphrase-file "$PASSFILE" --no-symkey-cache --decrypt "$1"; }
tail_txt="$(dec "$T/db.sql.gz.gpg" | gzip -dc | tail -c 4096)" || die "the database dump does not decrypt or decompress"
[[ "$tail_txt" == *"-- PostgreSQL database dump complete"* ]] || die "the database dump is incomplete"
env_txt="$(dec "$T/bundle.env.gpg")" || die "the .env copy does not decrypt"
[[ "$env_txt" == *"IMMICH_DB_PASSWORD="* ]] || die "the .env copy lacks IMMICH_DB_PASSWORD"
unset env_txt
log "restore-check OK: $ARCHIVE"
```

- [ ] **Step 5: Write `bundles/immich/ops/storage-check.sh`.**

```bash
#!/usr/bin/env bash
# Where Immich's data lives and how much room is left. Read-only.
#   bash ops/storage-check.sh [--min-free-gb N]   (exit 3 if the disk holding ~/.crow/immich has < N GB free)
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step "storage-check"
MIN=""
if [ "${1:-}" = "--min-free-gb" ]; then
  MIN="${2:?--min-free-gb needs a number}"
  mkdir -p "$CROW_HOME/immich"
  free_gb="$(df -BG --output=avail "$CROW_HOME/immich" | tail -1 | tr -dc 0-9)"
  [ "$free_gb" -ge "$MIN" ] || { log "only ${free_gb} GB free on the disk holding $CROW_HOME/immich (need $MIN)"; exit 3; }
  exit 0   # free-space check only: never du the (large) library here
fi
IM="$CROW_HOME/immich"
LIB="$(env_get IMMICH_LIBRARY_DIR)"; LIB="${LIB:-$IM/library}"
row() {
  if [ -e "$1" ]; then
    printf '%-14s %8s used  %8s free  %s\n' "$2" "$(du -sh "$1" 2>/dev/null | cut -f1)" "$(df -h --output=avail "$1" | tail -1 | tr -d ' ')" "$1"
  else
    printf '%-14s %8s  %s\n' "$2" "missing" "$1"
  fi
}
row "$LIB" originals
row "$IM/thumbs" thumbs
row "$IM/encoded-video" encoded-video
row "$IM/postgres" "database (container-owned: true size needs sudo du)"
row "$IM/db-dumps" db-dumps
row "$IM/model-cache" ml-models
if [ -n "$MIN" ]; then
  mkdir -p "$IM"
  free_gb="$(df -BG --output=avail "$IM" | tail -1 | tr -dc 0-9)"
  [ "$free_gb" -ge "$MIN" ] || { log "only ${free_gb} GB free on the disk holding $IM (need $MIN)"; exit 3; }
fi
```

- [ ] **Step 6: Write `bundles/immich/ops/install-backup-timer.sh`.**

```bash
#!/usr/bin/env bash
# Turn on nightly Immich DB backups: a USER systemd timer (no sudo) + the backup
# passphrase (generated once, SHOWN ONCE: write it down and keep it offline).
#   bash ops/install-backup-timer.sh --dest <dir> [--mount <mountpoint>] [--alert-lib <alerts.sh>]
# Example: --dest <drive-mount>/crow-immich-backups --mount <drive-mount>
#          --alert-lib <alerts.sh>
set -euo pipefail
umask 077
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
IM="${IMMICH_DATA_ROOT:-$CROW_HOME/immich}"
PASSFILE="$IM/backup-passphrase"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ONCAL="${IMMICH_BACKUP_ONCALENDAR:-*-*-* 04:15:00}"
SYSTEMCTL="${IMMICH_SYSTEMCTL:-systemctl}"
DEST=""; MOUNT=""; ALERT_LIB=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="${2:?}"; shift 2 ;;
    --mount) MOUNT="${2:?}"; shift 2 ;;
    --alert-lib) ALERT_LIB="${2:?}"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ -n "$DEST" ] || { echo "usage: install-backup-timer.sh --dest <dir> [--mount <mountpoint>] [--alert-lib <alerts.sh>]" >&2; exit 2; }
[ -f "$BUNDLE_DIR/.env" ] || { echo "ERROR: no .env in $BUNDLE_DIR: run it from the installed copy: bash ~/.crow/bundles/immich/ops/install-backup-timer.sh ..." >&2; exit 1; }
echo "Using bundle dir: $BUNDLE_DIR"
mkdir -p "$IM" "$UNIT_DIR"
if [ ! -f "$PASSFILE" ]; then
  random_pw 48 > "$PASSFILE"
  chmod 600 "$PASSFILE"
  echo "=== Immich backup passphrase (shown ONCE: write it down, keep it offline) ==="
  cat "$PASSFILE"; echo
  echo "=== Without it, the backups cannot be opened. ==="
else
  echo "Backup passphrase already exists at $PASSFILE (not shown again)."
fi
{
  echo "[Unit]"
  echo "Description=Nightly Crow Immich backup (database + config, gpg-encrypted)"
  echo
  echo "[Service]"
  echo "Type=oneshot"
  echo "Environment=CROW_HOME=$CROW_HOME"
  echo "Environment=IMMICH_BACKUP_DEST=$DEST"
  [ -n "$MOUNT" ] && echo "Environment=IMMICH_BACKUP_MOUNT=$MOUNT"
  [ -n "$ALERT_LIB" ] && echo "Environment=IMMICH_BACKUP_ALERT_LIB=$ALERT_LIB"
  echo "ExecStart=/bin/bash $BUNDLE_DIR/ops/backup.sh"
  echo "TimeoutStartSec=1h"
} > "$UNIT_DIR/crow-immich-backup.service"
cat > "$UNIT_DIR/crow-immich-backup.timer" <<EOF
[Unit]
Description=Nightly Crow Immich backup

[Timer]
OnCalendar=$ONCAL
Persistent=true

[Install]
WantedBy=timers.target
EOF
$SYSTEMCTL --user daemon-reload
$SYSTEMCTL --user enable --now crow-immich-backup.timer
if command -v loginctl >/dev/null 2>&1 && [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo yes)" != "yes" ]; then
  echo "WARNING: lingering is off for $(id -un); the timer only runs while you are logged in. Fix: sudo loginctl enable-linger $(id -un)"
fi
echo "Nightly backup enabled ($ONCAL) → $DEST. Run one now: systemctl --user start crow-immich-backup.service"
```

Make the scripts executable: `chmod 755 bundles/immich/ops/*.sh`.

- [ ] **Step 7: Run the test and confirm it passes.**

  Run: `npm test -- tests/immich-backup.test.js`

  Expected: PASS (5 tests, or skipped where gpg is absent).

- [ ] **Step 8: Commit.**

```bash
cd "$WT"
git add bundles/immich/ops tests/immich-backup.test.js
git commit bundles/immich/ops/backup.sh bundles/immich/ops/install-backup-timer.sh bundles/immich/ops/restore-check.sh bundles/immich/ops/storage-check.sh tests/immich-backup.test.js -m "feat(immich): nightly gpg DB backup + timer installer, restore-check, storage-check"
git show --stat HEAD
```

### Task A5: MCP server reads the bundle `.env`; skill note

**Files:**
- Create: `bundles/immich/server/config.js`
- Modify: `bundles/immich/server/server.js` (lines 14-32 and the five `if (!IMMICH_API_KEY)` guards)
- Modify: `bundles/immich/skills/immich.md`
- Test: `tests/immich-mcp-env-fallback.test.js`

**Interfaces:**
- Produces: `immichConfig({ env, envFile }) → { url: string, apiKey: string }`.

- [ ] **Step 1: Write the failing test** `tests/immich-mcp-env-fallback.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { immichConfig } from "../bundles/immich/server/config.js";

const file = (text) => { const d = mkdtempSync(join(tmpdir(), "im-cfg-")); const p = join(d, ".env"); writeFileSync(p, text); return p; };

test("bundle .env wins (bootstrap mints the key after the MCP child started)", () => {
  const p = file("IMMICH_URL=http://127.0.0.1:2283\nIMMICH_API_KEY='minted-key'\n");
  assert.deepEqual(immichConfig({ env: { IMMICH_URL: "http://old", IMMICH_API_KEY: "" }, envFile: p }), { url: "http://127.0.0.1:2283", apiKey: "minted-key" });
});

test("falls back to the spawn env, then the default; re-read on every call", () => {
  const p = file("");
  assert.deepEqual(immichConfig({ env: { IMMICH_URL: "https://ext", IMMICH_API_KEY: "k" }, envFile: p }), { url: "https://ext", apiKey: "k" });
  assert.deepEqual(immichConfig({ env: {}, envFile: join(tmpdir(), "nope", ".env") }), { url: "http://localhost:2283", apiKey: "" });
  writeFileSync(p, "IMMICH_API_KEY=later\n");
  assert.equal(immichConfig({ env: {}, envFile: p }).apiKey, "later");
});

test("trailing slashes trimmed from the URL", () => {
  assert.equal(immichConfig({ env: { IMMICH_URL: "https://x/" }, envFile: file("") }).url, "https://x");
});
```

- [ ] **Step 2: Run the test and confirm it fails.**

  Run: `npm test -- tests/immich-mcp-env-fallback.test.js`

  Expected: FAIL (`config.js` is missing).

- [ ] **Step 3: Write `bundles/immich/server/config.js`.**

```js
/**
 * Where the Immich tools find their server and key. Re-read on EVERY call:
 *   1. this bundle's own .env (local mode: bootstrap writes IMMICH_API_KEY there AFTER the
 *      gateway already spawned this MCP child, and mcp-addons.json never sees it);
 *   2. the spawn env (mcp-addons.json / gateway env; external-mode installs);
 *   3. the default http://localhost:2283.
 * A tiny reader for the installer's .env encoding (bare, 'single', "double" quoted),
 * kept here so the installed bundle imports nothing from the gateway.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DQ = { "\\": "\\", '"': '"', $: "$", n: "\n", t: "\t", r: "\r" };
function decode(raw) {
  const s = raw.trimStart();
  if (s.startsWith("'")) {
    let out = "";
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "\\" && s[i + 1] === "'") { out += "'"; i++; continue; }
      if (s[i] === "'") return out;
      out += s[i];
    }
    return s;
  }
  if (s.startsWith('"')) {
    let out = "";
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "\\" && i + 1 < s.length && DQ[s[i + 1]] !== undefined) { out += DQ[s[i + 1]]; i++; continue; }
      if (s[i] === '"') return out;
      out += s[i];
    }
    return s;
  }
  return s.split(/\s+#/)[0].trim();
}
export function readEnvFile(path) {
  const out = {};
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line.replace(/\r$/, ""));
    if (m) out[m[1]] = decode(m[2]);
  }
  return out;
}
const defaultEnvFile = () => process.env.IMMICH_ENV_FILE || join(dirname(fileURLToPath(import.meta.url)), "..", ".env");

export function immichConfig({ env = process.env, envFile = defaultEnvFile() } = {}) {
  const f = readEnvFile(envFile);
  const url = (f.IMMICH_URL || env.IMMICH_URL || "http://localhost:2283").replace(/\/+$/, "");
  const apiKey = f.IMMICH_API_KEY || env.IMMICH_API_KEY || "";
  return { url, apiKey };
}
```

- [ ] **Step 4: Rewire `server.js`.** Replace lines 14-32, i.e. the two `const IMMICH_…` lines plus `immichFetch`, with:

```js
import { immichConfig } from "./config.js";

async function immichFetch(path, options = {}) {
  const { url: base, apiKey } = immichConfig();
  const url = `${base}/api${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Immich API error ${res.status}: ${text}`);
  }
  return res.json();
}
```

Then replace every `if (!IMMICH_API_KEY) {` with `if (!immichConfig().apiKey) {` (5 places). Run `grep -n "IMMICH_API_KEY\|IMMICH_URL" bundles/immich/server/server.js`: the only remaining hits must be inside the user-facing "Immich not configured…" strings. Bump `new McpServer({ name: "crow-immich", version: "1.0.0" })` to `"2.0.0"`.

- [ ] **Step 5: Edit the skill.** In `bundles/immich/skills/immich.md`, add after the title:

```markdown
## Where Immich lives

- If Crow runs Immich (local mode), open **Photos** in Crow for its address and phone setup.
- Text search (`immich_search_photos` with a `query`) uses Immich's smart search, which needs Immich's
  machine learning. If the admin turned machine learning off, say so and fall back to a date/place search
  (call `immich_search_photos` without `query`).
```

- [ ] **Step 6: Run the tests and confirm they pass.**

  Run: `npm test -- tests/immich-mcp-env-fallback.test.js tests/bundle-server-deps.test.js`

  Expected: PASS. `config.js` uses only `node:` built-ins, so no new bare imports.

- [ ] **Step 7: Commit.**

```bash
cd "$WT"
git add bundles/immich/server/config.js tests/immich-mcp-env-fallback.test.js
git commit bundles/immich/server/config.js bundles/immich/server/server.js bundles/immich/skills/immich.md tests/immich-mcp-env-fallback.test.js -m "fix(immich): tools read the bundle .env per call (key minted after spawn); skill notes Photos + ML"
git show --stat HEAD
```

### Task A6: Photos page + Office card

**Files:**
- Create: `bundles/immich/panel/immich.js` (replaces the A2 placeholder)
- Modify: `bundles/workspace/panel/workspace.js` (Photos card)
- Modify: `bundles/workspace/manifest.json` (version `0.1.3`)
- Test: `tests/immich-panel.test.js` (new)
- Test: `tests/workspace-panel.test.js` (append)

**Interfaces:**
- Produces:
  - `readPublicSettings(crowHome)`, `immichUrls(s)`, `renderImmichPage(settings, lang, crowHome)` from `panel/immich.js`.
  - `photosReady(crowHome): boolean` from `workspace.js`.

- [ ] **Step 1: Write the failing tests.** Create `tests/immich-panel.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPublicSettings, immichUrls, renderImmichPage } from "../bundles/immich/panel/immich.js";

function home(envText) {
  const h = mkdtempSync(join(tmpdir(), "im-panel-"));
  mkdirSync(join(h, "bundles", "immich"), { recursive: true });
  if (envText !== null) writeFileSync(join(h, "bundles", "immich", ".env"), envText);
  return h;
}

test("reads only public keys (never the API key or DB password)", () => {
  const h = home("IMMICH_API_KEY=SECRETKEY\nIMMICH_DB_PASSWORD=SECRETDB\nIMMICH_BOOTSTRAP_DONE=1\nIMMICH_PUBLIC_HOST=box.ts.net\nIMMICH_SERVE_PORT=8458\n");
  const s = readPublicSettings(h);
  assert.equal(s.IMMICH_API_KEY, undefined);
  assert.equal(s.IMMICH_DB_PASSWORD, undefined);
  const html = renderImmichPage(s, "en", h);
  assert.ok(!html.includes("SECRETKEY") && !html.includes("SECRETDB"));
  assert.match(html, /https:\/\/box\.ts\.net:8458/);
  assert.match(html, /sudo tailscale serve --bg --https=8458 http:\/\/127\.0\.0\.1:2283/);
  assert.doesNotMatch(html, /tailscale funnel --bg|funnel --https/);
});

test("not ready: shows the bootstrap command; external mode: shows the external address, no Serve block", () => {
  const h = home("IMMICH_MODE=local\n");
  assert.match(renderImmichPage(readPublicSettings(h), "en", h), /ops\/bootstrap\.sh/);
  const h2 = home("IMMICH_MODE=external\nIMMICH_URL=https://photos.example.ts.net\n");
  const html = renderImmichPage(readPublicSettings(h2), "es", h2);
  assert.match(html, /https:\/\/photos\.example\.ts\.net/);
  assert.doesNotMatch(html, /tailscale serve/);
});

test("hostile values are not rendered (shell/HTML-safe patterns)", () => {
  const u = immichUrls({ IMMICH_PUBLIC_HOST: "x;rm -rf /", IMMICH_SERVE_PORT: "84$58" });
  assert.equal(u.host, "");
  assert.equal(u.port, "8458");
  const h = home("IMMICH_MODE=external\nIMMICH_URL=javascript:alert(1)\n");
  assert.doesNotMatch(renderImmichPage(readPublicSettings(h), "en", h), /javascript:/);
});
```

Append to `tests/workspace-panel.test.js` (add the imports it lacks):

```js
import { photosReady } from "../bundles/workspace/panel/workspace.js";

test("Office shows the Photos card only when Immich setup finished", () => {
  const h = mkdtempSync(join(tmpdir(), "ws-photos-"));
  mkdirSync(join(h, "bundles", "immich"), { recursive: true });
  assert.equal(photosReady(h), false);
  writeFileSync(join(h, "bundles", "immich", ".env"), "IMMICH_BOOTSTRAP_DONE=1\n");
  assert.equal(photosReady(h), true);
  const html = renderWorkspacePage({ WORKSPACE_BOOTSTRAP_DONE: "1", WORKSPACE_PUBLIC_HOST: "box.ts.net" }, "en", h);
  assert.match(html, /href="\/dashboard\/immich"/);
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**

  Run: `npm test -- tests/immich-panel.test.js tests/workspace-panel.test.js`

  Expected: FAIL.

- [ ] **Step 3: Write `bundles/immich/panel/immich.js`.**

```js
/**
 * Crow's Nest Panel — "Photos": Immich setup page (degoogle spec §3.1).
 * Server-rendered, no client script. Reads ONLY allow-listed non-secret keys from the
 * installed bundle .env and renders a value only if it passes a shell/HTML-safe pattern
 * (admin blocks are pasted into a terminal). Copied alone to $CROW_HOME/panels/immich.js,
 * so it imports nothing from the bundle.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const __imAppRoot = (() => {
  const ok = (p) => !!p && existsSync(join(p, "servers", "db.js"));
  const guess = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  return ok(process.env.CROW_APP_ROOT) ? process.env.CROW_APP_ROOT : guess;
})();
const { parseEnvText } = await import(pathToFileURL(join(__imAppRoot, "servers", "gateway", "bundle-env-codec.js")).href);

const T = {
  en: {
    title: "Photos",
    subtitle: "Your private photo library (Immich): phone backup, albums, search, faces.",
    notReady: "Photos is not fully set up yet. Finish the setup by running this command in a terminal on the machine that hosts Crow, then reopen this page:",
    tailnetNote: "Photos only works while your device is on your tailnet (Tailscale on). It is never reachable from the public internet.",
    addressH: "Your Photos address",
    addressP: "Open it in a browser on any device on your tailnet. Sign in with your Immich account (not your Crow password).",
    phoneH: "On your phone",
    phoneP1: "Install the Immich app (Play Store, or F-Droid: pick one and keep it; they cannot update each other). Server address:",
    phoneP2: "Sign in, then Backup → choose the albums to back up (Camera at least). You can limit backup to wireless or charging.",
    googleH: "Moving from Google Photos",
    googleP: "Export your library with Google Takeout, then import it with the steps in the Photos guide (docs/guide/photos.md). Keep your Google Photos library until the import is checked.",
    externalH: "Connected Immich",
    externalP: "Crow's photo tools use this Immich (Crow does not run it):",
    adminH: "For the admin",
    serveP: "Run once on this machine to publish Photos on your tailnet. Never use “tailscale funnel” for this:",
    backupP: "Turn on nightly encrypted database backups (shows the backup passphrase once; keep it offline):",
    storageP: "See where photos, thumbnails and the database live, and how much room is left:",
    mlP: "Search by content and face grouping run on the CPU. To turn them off: Immich → Administration → Settings → Machine Learning.",
    uninstallP: "Uninstalling keeps your photos (the library folder), the database in ~/.crow/immich, the generated secrets, the backup timer and the tailnet address. Before uninstalling, disable the timer and remove the Serve mapping:",
  },
  es: {
    title: "Fotos",
    subtitle: "Tu biblioteca privada de fotos (Immich): copia del teléfono, álbumes, búsqueda, caras.",
    notReady: "Fotos todavía no está completamente configurado. Termina la configuración ejecutando este comando en una terminal de la máquina que aloja Crow y vuelve a abrir esta página:",
    tailnetNote: "Fotos solo funciona mientras tu dispositivo está en tu tailnet (Tailscale activado). Nunca es accesible desde internet público.",
    addressH: "La dirección de Fotos",
    addressP: "Ábrela en el navegador de cualquier dispositivo de tu tailnet. Entra con tu cuenta de Immich (no con tu contraseña de Crow).",
    phoneH: "En tu teléfono",
    phoneP1: "Instala la app Immich (Play Store o F-Droid: elige una y quédate con ella; no se pueden actualizar entre sí). Dirección del servidor:",
    phoneP2: "Entra y luego Copia de seguridad → elige los álbumes (al menos Cámara). Puedes limitarla a wireless o a cuando esté cargando.",
    googleH: "Desde Google Fotos",
    googleP: "Exporta tu biblioteca con Google Takeout y luego impórtala con los pasos de la guía de Fotos (docs/guide/photos.md). Conserva tu biblioteca de Google Fotos hasta comprobar la importación.",
    externalH: "Immich conectado",
    externalP: "Las herramientas de fotos de Crow usan este Immich (Crow no lo ejecuta):",
    adminH: "Para el administrador",
    serveP: "Ejecuta una vez en esta máquina para publicar Fotos en tu tailnet. Nunca uses “tailscale funnel” para esto:",
    backupP: "Activa las copias cifradas de la base de datos cada noche (muestra la frase de cifrado una sola vez; guárdala fuera de línea):",
    storageP: "Mira dónde están las fotos, las miniaturas y la base de datos, y cuánto espacio queda:",
    mlP: "La búsqueda por contenido y la agrupación de caras usan la CPU. Para desactivarlas: Immich → Administración → Ajustes → Aprendizaje automático.",
    uninstallP: "Desinstalar conserva tus fotos (la carpeta de la biblioteca), la base de datos en ~/.crow/immich, los secretos generados, el temporizador de copias y la dirección de la tailnet. Antes de desinstalar, desactiva el temporizador y quita la asignación de Serve:",
  },
};
export { T as IMMICH_STRINGS };

const PUBLIC_KEYS = ["IMMICH_MODE", "IMMICH_URL", "IMMICH_BOOTSTRAP_DONE", "IMMICH_PUBLIC_HOST", "IMMICH_SERVE_PORT"];
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const PORT_RE = /^[0-9]{2,5}$/;
const HTTP_URL_RE = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{2,5})?(\/[A-Za-z0-9._~\/-]*)?$/;
const shq = (s) => (/^[A-Za-z0-9_\/.@+:-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
const IMMICH_HOST_PORT = 2283;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function readPublicSettings(crowHome) {
  const p = join(crowHome, "bundles", "immich", ".env");
  if (!existsSync(p)) return null;
  const all = parseEnvText(readFileSync(p, "utf8"));
  const out = {};
  for (const k of PUBLIC_KEYS) if (Object.hasOwn(all, k)) out[k] = all[k];
  return out;
}

export function immichUrls(s) {
  const rawHost = (s && s.IMMICH_PUBLIC_HOST) || "";
  const host = HOST_RE.test(rawHost) ? rawHost : "";
  const port = PORT_RE.test((s && s.IMMICH_SERVE_PORT) || "") ? s.IMMICH_SERVE_PORT : "8458";
  const ext = HTTP_URL_RE.test((s && s.IMMICH_URL) || "") ? s.IMMICH_URL : "";
  return { host, port, web: `https://${host}:${port}`, external: ext };
}

export function renderImmichPage(settings, lang, crowHome = join(homedir(), ".crow")) {
  const opsDir = shq(join(crowHome, "bundles", "immich", "ops"));
  const t = T[lang === "es" ? "es" : "en"];
  const style = `<style>
    .im-panel h1 { margin: 0 0 .25rem; font-size: 1.5rem; }
    .im-sub { color: var(--crow-text-muted); margin: 0 0 1rem; }
    .im-card { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border); border-radius: 10px; padding: .9rem 1rem; margin-bottom: 1rem; }
    .im-card h2 { font-size: 1.05rem; margin: 0 0 .5rem; }
    .im-card code, .im-card pre { background: var(--crow-bg-surface, var(--crow-bg)); border-radius: 4px; padding: .1rem .4rem; overflow-wrap: anywhere; }
    .im-card pre { padding: .5rem .6rem; white-space: pre-wrap; }
    .im-note { border-left: 3px solid var(--crow-accent); }
  </style>`;
  const head = `<h1>${esc(t.title)}</h1><p class="im-sub">${esc(t.subtitle)}</p>`;
  const card = (h, body, cls = "") => `<div class="im-card ${cls}">${h ? `<h2>${esc(h)}</h2>` : ""}${body}</div>`;
  const u = immichUrls(settings);
  if (settings && settings.IMMICH_MODE === "external") {
    return `${style}<div class="im-panel">${head}${card(t.externalH, `<p>${esc(t.externalP)} <code>${esc(u.external)}</code></p>`)}</div>`;
  }
  if (!settings || !u.host || settings.IMMICH_BOOTSTRAP_DONE !== "1") {
    return `${style}<div class="im-panel">${head}${card("", `<p>${esc(t.notReady)}</p><pre>bash ${esc(opsDir)}/bootstrap.sh</pre>`, "im-note")}</div>`;
  }
  return `${style}<div class="im-panel">${head}
    ${card("", `<p>${esc(t.tailnetNote)}</p>`, "im-note")}
    ${card(t.addressH, `<p><a href="${esc(u.web)}" target="_blank" rel="noopener">${esc(u.web)}</a></p><p>${esc(t.addressP)}</p>`)}
    ${card(t.phoneH, `<p>${esc(t.phoneP1)} <code>${esc(u.web)}</code></p><p>${esc(t.phoneP2)}</p>`)}
    ${card(t.googleH, `<p>${esc(t.googleP)}</p>`)}
    ${card(t.adminH, `<p>${esc(t.serveP)}</p><pre>sudo tailscale serve --bg --https=${u.port} http://127.0.0.1:${IMMICH_HOST_PORT}</pre>
      <p>${esc(t.backupP)}</p><pre>bash ${esc(opsDir)}/install-backup-timer.sh --dest &lt;backup folder&gt; --mount &lt;drive mountpoint&gt;</pre>
      <p>${esc(t.storageP)}</p><pre>bash ${esc(opsDir)}/storage-check.sh</pre>
      <p>${esc(t.mlP)}</p>
      <p>${esc(t.uninstallP)}</p><pre>systemctl --user disable --now crow-immich-backup.timer
sudo tailscale serve --https=${u.port} off</pre>`)}
  </div>`;
}

export default {
  id: "immich",
  name: "Photos",
  icon: "image",
  route: "/dashboard/immich",
  navOrder: 59,
  category: "media",
  async handler(req, res, { layout, lang }) {
    const crowHome = process.env.CROW_HOME || join(homedir(), ".crow");
    const t = T[lang === "es" ? "es" : "en"];
    res.send(layout({ title: t.title, content: renderImmichPage(readPublicSettings(crowHome), lang, crowHome) }));
  },
};
```

- [ ] **Step 4: Add the Office card.**

  In `bundles/workspace/panel/workspace.js`, add `photosH`, `photosP` and `photosLink` to both string tables:
  - en: `photosH: "Photos"`, `photosP: "Phone photos and your Google Photos library live in Photos (Immich), next to Office."`, `photosLink: "Open Photos"`.
  - es: `photosH: "Fotos"`, `photosP: "Las fotos del teléfono y tu biblioteca de Google Fotos están en Fotos (Immich), junto a Office."`, `photosLink: "Abrir Fotos"`.

  Add after `readPublicSettings`:

```js
/** True when the immich bundle finished local setup (its own .env says so). */
export function photosReady(crowHome) {
  const p = join(crowHome, "bundles", "immich", ".env");
  if (!existsSync(p)) return false;
  try { return parseEnvText(readFileSync(p, "utf8")).IMMICH_BOOTSTRAP_DONE === "1"; } catch { return false; }
}
```

  In `renderWorkspacePage`, after the `${card(t.laptopH, …)}` line, insert:

```js
    ${photosReady(crowHome) ? card(t.photosH, `<p>${esc(t.photosP)}</p><p><a href="/dashboard/immich">${esc(t.photosLink)}</a></p>`) : ""}
```

  Bump `bundles/workspace/manifest.json` `"version": "0.1.3"`.

- [ ] **Step 5: Run the tests and confirm they pass.**

  Run: `npm test -- tests/immich-panel.test.js tests/workspace-panel.test.js tests/workspace-bundle.test.js`

  Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
cd "$WT"
git add bundles/immich/panel/immich.js tests/immich-panel.test.js
git commit bundles/immich/panel/immich.js bundles/workspace/panel/workspace.js bundles/workspace/manifest.json tests/immich-panel.test.js tests/workspace-panel.test.js -m "feat(immich): Photos page (address, phone, Takeout, admin); Office links to Photos (workspace 0.1.3)"
git show --stat HEAD
```

### Task B1: Takeout mover + import wrapper (code; ships in PR A)

**Files:**
- Create: `bundles/immich/ops/takeout-mover.sh`
- Create: `bundles/immich/ops/import-takeout.sh`
- Test: `tests/immich-import.test.js`

**Interfaces:**
- Consumes: `lib.sh`, `storage-check.sh`.
- Produces:
  - `takeout-mover.sh --dest DIR [--from DIR] [--watch]`.
  - `import-takeout.sh --dry-run|--run --key-file F --takeout-dir D [--include-partner]`.

- [ ] **Step 1: Write the failing test** `tests/immich-import.test.js`:

```js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OPS = join(import.meta.dirname, "..", "bundles", "immich", "ops");
const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const HAS_ZIP = spawnSync("zip", ["-v"]).status === 0;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "im-imp-")); roots.push(root);
  const c = { root, home: join(root, "home"), bundle: join(root, "bundle"), dl: join(root, "dl"), stage: join(root, "stage"), bin: join(root, "bin") };
  for (const d of [c.bundle, join(c.home, "immich"), c.dl, c.stage, c.bin]) mkdirSync(d, { recursive: true });
  writeFileSync(join(c.bundle, ".env"), "IMMICH_URL=http://127.0.0.1:2283\n", { mode: 0o600 });
  writeFileSync(join(c.bin, "immich-go"), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "$FAKE_ARGS"\necho "fake import done"\n`);
  chmodSync(join(c.bin, "immich-go"), 0o755);
  writeFileSync(join(c.root, "key"), "IMPORTKEY123\n", { mode: 0o600 });
  return c;
}
const env = (c, x = {}) => ({ PATH: process.env.PATH, HOME: c.root, CROW_HOME: c.home, CROW_BUNDLE_DIR: c.bundle, IMMICH_GO: join(c.bin, "immich-go"), FAKE_ARGS: join(c.root, "args"), ...x });

test("dry-run passes ALL zips in one immich-go call with the safe defaults", () => {
  const c = setup();
  for (const n of ["takeout-001.zip", "takeout-002.zip"]) writeFileSync(join(c.stage, n), "x");
  const r = spawnSync("bash", [join(OPS, "import-takeout.sh"), "--dry-run", "--key-file", join(c.root, "key"), "--takeout-dir", c.stage], { env: env(c), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const args = readFileSync(join(c.root, "args"), "utf8").trim().split("\n");
  assert.deepEqual(args.slice(0, 2), ["upload", "from-google-photos"]);
  for (const a of ["--dry-run", "--sync-albums=true", "--include-partner=false", "--include-trashed=false", "--include-unmatched=false", "--server=http://127.0.0.1:2283", "--api-key=IMPORTKEY123"]) assert.ok(args.includes(a), a);
  assert.deepEqual(args.filter((a) => a.endsWith(".zip")).map((a) => a.split("/").pop()), ["takeout-001.zip", "takeout-002.zip"]);
  const logs = readdirSync(join(c.home, "immich")).filter((f) => /^import-.*-dry-run\.log$/.test(f));
  assert.equal(logs.length, 1);
  assert.ok(!readFileSync(join(c.home, "immich", logs[0]), "utf8").includes("IMPORTKEY123"));
});

test("refuses: key file not 600, empty dir, both modes", () => {
  const c = setup();
  chmodSync(join(c.root, "key"), 0o644);
  writeFileSync(join(c.stage, "takeout-001.zip"), "x");
  let r = spawnSync("bash", [join(OPS, "import-takeout.sh"), "--dry-run", "--key-file", join(c.root, "key"), "--takeout-dir", c.stage], { env: env(c), encoding: "utf8" });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /mode 600/);
  chmodSync(join(c.root, "key"), 0o600);
  r = spawnSync("bash", [join(OPS, "import-takeout.sh"), "--dry-run", "--key-file", join(c.root, "key"), "--takeout-dir", c.dl], { env: env(c), encoding: "utf8" });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /no takeout-\*\.zip/);
  assert.ok(!existsSync(join(c.root, "args")));
});

test("mover: moves a finished, valid zip; leaves a broken one and an in-progress one", { skip: !HAS_ZIP && "zip not installed" }, () => {
  const c = setup();
  writeFileSync(join(c.root, "p.jpg"), "photo");
  spawnSync("zip", ["-q", "-j", join(c.dl, "takeout-001.zip"), join(c.root, "p.jpg")]);
  writeFileSync(join(c.dl, "takeout-002.zip"), "not a zip");
  writeFileSync(join(c.dl, "takeout-003.zip"), "partial"); writeFileSync(join(c.dl, "takeout-003.zip.crdownload"), "");
  const r = spawnSync("bash", [join(OPS, "takeout-mover.sh"), "--from", c.dl, "--dest", c.stage], { env: env(c), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(c.stage).sort(), ["takeout-001.zip"]);
  assert.ok(existsSync(join(c.dl, "takeout-002.zip")) && existsSync(join(c.dl, "takeout-003.zip")));
  assert.match(r.stdout, /takeout-002\.zip failed the zip test/);
});
```

- [ ] **Step 2: Run the test and confirm it fails.**

  Run: `npm test -- tests/immich-import.test.js`

  Expected: FAIL.

- [ ] **Step 3: Write `takeout-mover.sh`.**

```bash
#!/usr/bin/env bash
# Move finished Google Takeout zips out of the browser's download folder into the staging
# folder, one at a time (the NVMe never holds more than the archive being downloaded).
#   bash ops/takeout-mover.sh --dest <drive-mount>/takeout-photos [--from DIR] [--watch]
set -euo pipefail
umask 022
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step "takeout-mover"
FROM="$CROW_HOME/browser-downloads"; DEST=""; WATCH=0
SLEEP_S="${IMMICH_MOVER_SLEEP_S:-30}"
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="${2:?}"; shift 2 ;;
    --dest) DEST="${2:?}"; shift 2 ;;
    --watch) WATCH=1; shift ;;
    *) die "unknown option $1" ;;
  esac
done
[ -n "$DEST" ] || die "usage: takeout-mover.sh --dest <staging dir> [--from <downloads dir>] [--watch]"
{ [ -d "$DEST" ] && [ -w "$DEST" ]; } || die "$DEST is not a writable folder"
[ -d "$FROM" ] || die "$FROM does not exist"
command -v unzip >/dev/null 2>&1 || die "unzip is required"

move_ready() {
  local f name size free
  shopt -s nullglob
  for f in "$FROM"/takeout-*.zip; do
    name="$(basename "$f")"
    [ -e "$f.crdownload" ] && continue                 # Chrome is still writing it
    [ -e "$DEST/$name" ] && { log "$name already in staging; leaving the download in place"; continue; }
    size="$(stat -c %s "$f")"
    free="$(df -B1 --output=avail "$DEST" | tail -1 | tr -dc 0-9)"
    [ "$free" -gt $(( size + 10 * 1024 * 1024 * 1024 )) ] || die "not enough room in $DEST for $name"
    if ! unzip -tq "$f" >/dev/null 2>&1; then log "$name failed the zip test; left in place (download it again)"; continue; fi
    cp -- "$f" "$DEST/$name.part"
    mv -- "$DEST/$name.part" "$DEST/$name"
    rm -- "$f"
    log "moved $name ($(( size / 1024 / 1024 )) MB)"
  done
}
move_ready
if [ "$WATCH" = 1 ]; then
  log "watching $FROM every ${SLEEP_S}s (Ctrl-C to stop)"
  while sleep "$SLEEP_S"; do move_ready; done
fi
```

- [ ] **Step 4: Write `import-takeout.sh`.**

```bash
#!/usr/bin/env bash
# Import a Google Photos Takeout into this Immich with immich-go: ALL zips in ONE run
# (Takeout scatters metadata and albums across zips).
#   bash ops/import-takeout.sh --dry-run|--run --key-file <600 file> --takeout-dir <dir> [--include-partner]
# The import key is created by you in Immich (Account settings → API keys) and revoked after.
# immich-go takes it on argv for the length of this run (single-user host; see the guide).
set -euo pipefail
umask 077
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step "import-takeout"
IG="${IMMICH_GO:-$CROW_HOME/immich/tools/immich-go}"
MODE=""; KEYFILE=""; DIR=""; PARTNER=false
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE=dry-run; shift ;;
    --run) MODE=run; shift ;;
    --key-file) KEYFILE="${2:?}"; shift 2 ;;
    --takeout-dir) DIR="${2:?}"; shift 2 ;;
    --include-partner) PARTNER=true; shift ;;
    *) die "unknown option $1" ;;
  esac
done
[ -n "$MODE" ] && [ -n "$KEYFILE" ] && [ -n "$DIR" ] || die "usage: import-takeout.sh --dry-run|--run --key-file <file> --takeout-dir <dir> [--include-partner]"
[ -x "$IG" ] || die "immich-go not found at $IG (plan Task B2 installs it)"
{ [ -f "$KEYFILE" ] && [ "$(stat -c %a "$KEYFILE")" = "600" ]; } || die "the key file must exist and be mode 600: $KEYFILE"
shopt -s nullglob
zips=("$DIR"/takeout-*.zip)
[ "${#zips[@]}" -gt 0 ] || die "no takeout-*.zip in $DIR"
URL="$(env_get IMMICH_URL)"; URL="${URL:-http://127.0.0.1:2283}"
if [ "$MODE" = run ]; then
  bash "$OPS_DIR/storage-check.sh" --min-free-gb "${IMMICH_IMPORT_MIN_FREE_GB:-120}" >/dev/null \
    || die "not enough free space on the disk holding ~/.crow/immich for thumbnails (need ${IMMICH_IMPORT_MIN_FREE_GB:-120} GB)"
fi
KEY="$(head -n 1 "$KEYFILE" | tr -d '\r\n ')"
[[ "$KEY" =~ ^[A-Za-z0-9_-]{16,256}$ ]] || die "the key file must hold one Immich API key (letters, digits, - or _)"
LOG="$CROW_HOME/immich/import-$(date +%Y%m%d-%H%M%S)-$MODE.log"
args=(upload from-google-photos "--server=$URL" --sync-albums=true --include-archived=true
      --include-trashed=false --include-unmatched=false "--include-partner=$PARTNER"
      --pause-immich-jobs=true --on-errors=continue)
[ "$MODE" = dry-run ] && args+=(--dry-run)
log "$MODE: ${#zips[@]} archive(s) from $DIR → $URL; log $LOG"
export IMPORT_KEY="$KEY"
"$IG" "${args[@]}" "--api-key=$KEY" "${zips[@]}" 2>&1 \
  | awk 'BEGIN { k = ENVIRON["IMPORT_KEY"] } { while ((i = index($0, k)) > 0) $0 = substr($0, 1, i - 1) "[key]" substr($0, i + length(k)); print; fflush() }' \
  | tee "$LOG"
unset IMPORT_KEY
unset KEY
```

Make both executable (`chmod 755`).

- [ ] **Step 5: Run the test and confirm it passes.**

  Run: `npm test -- tests/immich-import.test.js`

  Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
cd "$WT"
git add bundles/immich/ops/takeout-mover.sh bundles/immich/ops/import-takeout.sh tests/immich-import.test.js
git commit bundles/immich/ops/takeout-mover.sh bundles/immich/ops/import-takeout.sh tests/immich-import.test.js -m "feat(immich): Takeout mover (one archive at a time) + immich-go import wrapper (dry-run first, all zips in one run)"
git show --stat HEAD
```

### Task A7: Docs, port registry, registry rebuild, PR A

**Files:**
- Modify: `docs/developers/port-allocation.md`
- Modify: `docs/es/developers/port-allocation.md` (mirror rows)
- Create: `docs/guide/photos.md`
- Create: `docs/es/guide/photos.md`
- Modify: `docs/.vitepress/config.ts` (sidebar: en + es "Photos")
- Modify: `registry/add-ons.json` (via `npm run build-registry`)

- [ ] **Step 1: Port rows.** Re-verify the numbers first:
  - `ss -ltn | grep -E ':(2283|12283|8458|8459)\b'` must be empty;
  - `tailscale serve status | grep -E ':(8458|8459)\b'` must be empty;
  - `grep -rnE '2283|12283|8458|8459|10\.89\.7[45]' bundles/*/docker-compose.yml ~/crow-addons/*/docker-compose.yml scripts/immich-ntfs-spike` may only hit our files.

  Then edit the table:
  - change the 2283 row to `| 2283 | 127.0.0.1 | immich (Crow-hosted Immich, local mode; tailnet via Serve :8458) | degoogle 2026-10 |`;
  - add `| 8458 | tailnet (Serve) | Tailscale Serve HTTPS → 127.0.0.1:2283 (Immich; never Funnel) | degoogle 2026-10 |`;
  - add `| 8459 | tailnet (Serve) | Tailscale Serve HTTPS → 127.0.0.1:8097 (Vaultwarden, for the Bitwarden app; never Funnel) | degoogle 2026-10 |`;
  - add `| 12283 | 127.0.0.1 | scratch: Immich NTFS spike (scripts/immich-ntfs-spike) | scratch |`;
  - append to the Docker-subnets bullet: `crow-immich pins 10.89.74.0/24 (scratch spike: 10.89.75.0/24).`

  Mirror the same rows in the es file.

- [ ] **Step 2: Write `docs/guide/photos.md`.**

  Sections, all prose and commands taken from spec §3.1–5.2:
  1. What Photos is.
  2. Local vs external mode, and how to switch (uninstall + reinstall; data kept).
  3. Install (Extensions → Immich Photos; `IMMICH_LIBRARY_DIR` must exist; generate the admin password).
  4. Publish on the tailnet (`sudo tailscale serve --bg --https=8458 http://127.0.0.1:2283`; never Funnel; Immich cannot run under a sub-path).
  5. Phone app (Play vs F-Droid, don't mix).
  6. Moving from Google Photos: Takeout settings (Photos only, .zip, 50 GB, email link; 7-day expiry, 5 downloads); the three ways to get archives onto the server (browser container + `takeout-mover.sh --watch`, laptop + network share, Drive + rclone); creating the import key with the exact permission list from spec §2 (immich-go); `import-takeout.sh --dry-run` then `--run`; verify; revoke the key; keep Google Photos.
  7. Backups (`install-backup-timer.sh`, passphrase offline, `restore-check.sh`, full restore per https://docs.immich.app/administration/backup-and-restore). **The originals are not copied by Crow:** keep a second copy.
  8. Storage on an NTFS/USB drive (what was tested, the unplugged-drive behaviour, `ntfsfix` if the volume is dirty, don't edit files over the share).
  9. Machine learning on CPU, and how to turn it off.
  10. Upgrading (one release at a time, read the notes, compare with the release's compose, bump the pinned tags in a bundle release).

  `docs/es/guide/photos.md` is the Spanish translation of the same page: same headings and order, commands verbatim.

  Add sidebar entries next to "Kiosk Mode": `{ text: 'Photos (Immich)', link: '/guide/photos' }` and `{ text: 'Fotos (Immich)', link: '/es/guide/photos' }`.

- [ ] **Step 3: Rebuild the registry.**

  Run: `npm run build-registry && node scripts/build-registry.mjs --check && node scripts/check-port-allocation.js`

  Expected: the registry is updated (immich 2.0.0, workspace 0.1.3) and both checks print OK.

- [ ] **Step 4: Run the full suite.**

  Run: `npm test`

  Expected: 0 failures.

- [ ] **Step 5: Commit, push, open the PR.**

```bash
cd "$WT"
git add docs/guide/photos.md docs/es/guide/photos.md
git commit docs/developers/port-allocation.md docs/es/developers/port-allocation.md docs/guide/photos.md docs/es/guide/photos.md docs/.vitepress/config.ts registry/add-ons.json -m "docs(immich): Photos guide (en/es), ports 2283/8458/8459/12283 + subnets, registry rebuild"
git show --stat HEAD
git pull --rebase origin main && git push -u origin feat/immich-hosting
```

  Open the PR with the github MCP server (`create_pull_request`, base `main`, head `feat/immich-hosting`).
  - Body: the summary, a link to the spec, the spike report numbers, and the test list.
  - No Claude attribution.
  - Wait for check-runs `suite`, `static-checks` and `audit` to be `completed/success`.
  - Merge (standing grant for improvement-plan items; the operator's call if he has said otherwise).

## Phase B: Google Photos → Immich

## Phase C: Crow app self-update feed

### Task C1: Gateway feed + routes

**Files:**
- Create: `servers/gateway/android-updates.js`
- Create: `servers/gateway/routes/android-updates.js`
- Modify: `servers/gateway/boot/feature-mounts.js` (mount after the push router)
- Test: `tests/android-updates.test.js`

**Interfaces:**
- Produces:
  - `ANDROID_PACKAGE`, `RELEASE_CERT_SHA256`, `updatesDir(crowHome)`, `readFeed(crowHome)`, `validateFeed(feed, dir)`, `publicFeed(f)`.
  - Routes `GET /api/android/update` → `{package, versionCode, versionName, sha256, size, certSha256, url, publishedAt}` and `GET /api/android/apk/:versionCode`.

- [ ] **Step 1: Write the failing test** `tests/android-updates.test.js`:

```js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import express from "express";
import { readFeed, RELEASE_CERT_SHA256 } from "../servers/gateway/android-updates.js";
import androidUpdatesRouter from "../servers/gateway/routes/android-updates.js";

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
function home(feedPatch = {}, apkBytes = Buffer.from("APK-BYTES")) {
  const h = mkdtempSync(join(tmpdir(), "and-upd-")); roots.push(h);
  const d = join(h, "android-updates"); mkdirSync(d);
  writeFileSync(join(d, "crow-20.apk"), apkBytes);
  const feed = { package: "press.maestro.crow", versionCode: 20, versionName: "1.6.0", sha256: createHash("sha256").update(apkBytes).digest("hex"), size: apkBytes.length, certSha256: RELEASE_CERT_SHA256, file: "crow-20.apk", publishedAt: "2026-10-05T00:00:00Z", ...feedPatch };
  writeFileSync(join(d, "latest.json"), JSON.stringify(feed));
  return h;
}

test("valid feed is read; every tampering is rejected", () => {
  assert.equal(readFeed(home()).versionCode, 20);
  for (const patch of [
    { package: "com.evil" }, { versionCode: 0 }, { versionName: "1.6" }, { sha256: "ABC" },
    { certSha256: "00".repeat(32) }, { file: "../crow-20.apk" }, { file: "crow-21.apk" }, { size: 1 },
  ]) assert.equal(readFeed(home(patch)), null, JSON.stringify(patch));
  const h = mkdtempSync(join(tmpdir(), "and-none-")); roots.push(h);
  assert.equal(readFeed(h), null);
});

async function serve(h, allow = true) {
  const app = express();
  const auth = (req, res, next) => (allow ? next() : res.status(401).json({ error: "auth" }));
  app.use(androidUpdatesRouter(auth, { crowHome: h }));
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  return { srv, base: `http://127.0.0.1:${srv.address().port}` };
}

test("routes: auth-gated; JSON hides the disk path; APK streams with the right type", async () => {
  const h = home();
  const { srv, base } = await serve(h);
  try {
    const j = await (await fetch(`${base}/api/android/update`)).json();
    assert.equal(j.url, "/api/android/apk/20");
    assert.equal(j.path, undefined); assert.equal(j.file, undefined);
    const apk = await fetch(`${base}/api/android/apk/20`);
    assert.equal(apk.status, 200);
    assert.equal(apk.headers.get("content-type"), "application/vnd.android.package-archive");
    assert.equal(Buffer.from(await apk.arrayBuffer()).toString(), "APK-BYTES");
    assert.equal((await fetch(`${base}/api/android/apk/19`)).status, 404);
  } finally { srv.close(); }
  const denied = await serve(h, false);
  try { assert.equal((await fetch(`${denied.base}/api/android/update`)).status, 401); } finally { denied.srv.close(); }
});

test("no feed → 404 no_update_feed", async () => {
  const h = mkdtempSync(join(tmpdir(), "and-404-")); roots.push(h);
  const { srv, base } = await serve(h);
  try { const r = await fetch(`${base}/api/android/update`); assert.equal(r.status, 404); assert.equal((await r.json()).error, "no_update_feed"); } finally { srv.close(); }
});
```

- [ ] **Step 2: Run the test and confirm it fails.**

  Run: `npm test -- tests/android-updates.test.js`

  Expected: FAIL (module not found).

- [ ] **Step 3: Write `servers/gateway/android-updates.js`.**

```js
/**
 * Crow Android app update feed (degoogle spec §3.3). The operator publishes a release-
 * signed APK with scripts/android/publish-apk.mjs into $CROW_HOME/android-updates/; this
 * module reads and VALIDATES latest.json against the file next to it. Anything off
 * (package, cert, size, name, traversal) → no feed. The app re-checks sha256 + signer.
 */
import { readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

export const ANDROID_PACKAGE = "press.maestro.crow";
export const RELEASE_CERT_SHA256 = "6d5aeff16cd983e9b5f96147da5c88240b274ca9eed80bae771f555ac5a24352";
const FILE_RE = /^crow-(\d{1,9})\.apk$/;

export const updatesDir = (crowHome) => join(crowHome, "android-updates");

export function validateFeed(feed, dir) {
  if (!feed || typeof feed !== "object") return null;
  const { package: pkg, versionCode, versionName, sha256, size, certSha256, file, publishedAt } = feed;
  if (pkg !== ANDROID_PACKAGE) return null;
  if (!Number.isInteger(versionCode) || versionCode < 1) return null;
  if (typeof versionName !== "string" || !/^\d+\.\d+\.\d+$/.test(versionName)) return null;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (certSha256 !== RELEASE_CERT_SHA256) return null;
  if (typeof file !== "string" || basename(file) !== file) return null;
  const m = FILE_RE.exec(file);
  if (!m || Number(m[1]) !== versionCode) return null;
  const path = join(dir, file);
  let st;
  try { st = statSync(path); } catch { return null; }
  if (!st.isFile() || !Number.isInteger(size) || st.size !== size) return null;
  return { package: pkg, versionCode, versionName, sha256, size, certSha256, file, path, publishedAt: typeof publishedAt === "string" ? publishedAt : null };
}

export function readFeed(crowHome) {
  const dir = updatesDir(crowHome);
  let feed;
  try { feed = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")); } catch { return null; }
  return validateFeed(feed, dir);
}

/** What the app sees: no disk paths. */
export function publicFeed(f) {
  if (!f) return null;
  return { package: f.package, versionCode: f.versionCode, versionName: f.versionName, sha256: f.sha256, size: f.size, certSha256: f.certSha256, url: `/api/android/apk/${f.versionCode}`, publishedAt: f.publishedAt };
}
```

- [ ] **Step 4: Write `servers/gateway/routes/android-updates.js`.**

```js
/**
 * /api/android/* — the Crow app's update feed (degoogle spec §3.3). Dashboard-auth'd:
 * the app sends the WebView session cookie, as NtfyListenerService already does.
 */
import { Router } from "express";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFeed, publicFeed } from "../android-updates.js";

export default function androidUpdatesRouter(authMiddleware, { crowHome = process.env.CROW_HOME || join(homedir(), ".crow") } = {}) {
  const router = Router();
  router.use("/api/android", authMiddleware);

  router.get("/api/android/update", (req, res) => {
    res.set("Cache-Control", "no-store");
    const f = readFeed(crowHome);
    if (!f) return res.status(404).json({ error: "no_update_feed" });
    res.json(publicFeed(f));
  });

  router.get("/api/android/apk/:versionCode", (req, res) => {
    const f = readFeed(crowHome);
    if (!f || String(f.versionCode) !== req.params.versionCode) return res.status(404).json({ error: "not_found" });
    res.set({
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Length": String(f.size),
      "Content-Disposition": `attachment; filename="crow-${f.versionName}.apk"`,
      "Cache-Control": "no-store",
    });
    createReadStream(f.path).on("error", () => res.destroy()).pipe(res);
  });

  return router;
}
```

- [ ] **Step 5: Mount it.** In `servers/gateway/boot/feature-mounts.js`, after the Push API `try { … }` block, add:

```js
  // --- Mount Android app update feed (degoogle spec §3.3) ---
  try {
    const { default: androidUpdatesRouter } = await import("../routes/android-updates.js");
    app.use(androidUpdatesRouter(dashboardAuth));
    console.log("Android update feed mounted at /api/android");
  } catch (err) {
    console.warn("[android-updates] Failed to mount:", err.message);
  }
```

- [ ] **Step 6: Run the tests and confirm they pass.**

  Run: `npm test -- tests/android-updates.test.js tests/auth-network.test.js`

  Expected: PASS. `/api/android` is not in `PUBLIC_FUNNEL_PREFIXES`, so a Funnel request stays rejected.

- [ ] **Step 7: Commit.**

```bash
cd "$WT"
git add servers/gateway/android-updates.js servers/gateway/routes/android-updates.js tests/android-updates.test.js
git commit servers/gateway/android-updates.js servers/gateway/routes/android-updates.js servers/gateway/boot/feature-mounts.js tests/android-updates.test.js -m "feat(android): gateway update feed — validated latest.json + auth'd APK download"
git show --stat HEAD
```

### Task C2: Publish script

**Files:**
- Create: `scripts/android/publish-apk.mjs`
- Test: `tests/android-publish-apk.test.js`

**Interfaces:**
- Consumes: `RELEASE_CERT_SHA256`, `ANDROID_PACKAGE`, `updatesDir`, `readFeed` (C1).
- Produces: `parseSignerDigests(text): string[]`, `parseBadging(text): {package, versionCode, versionName}|null`, `publishApk({ apk, crowHome, run, now }): object` (throws `Error` with a reason).

- [ ] **Step 1: Write the failing test** `tests/android-publish-apk.test.js`:

```js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSignerDigests, parseBadging, publishApk } from "../scripts/android/publish-apk.mjs";
import { RELEASE_CERT_SHA256, readFeed } from "../servers/gateway/android-updates.js";

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const signer = (hex) => `Signer #1 certificate DN: CN=Crow\nSigner #1 certificate SHA-256 digest: ${hex}\nSigner #1 certificate SHA-1 digest: aa\n`;
const badging = (code, name, pkg = "press.maestro.crow") => `package: name='${pkg}' versionCode='${code}' versionName='${name}' platformBuildVersionName='14'\n`;
function ctx(code, name, { cert = RELEASE_CERT_SHA256, pkg } = {}) {
  const h = mkdtempSync(join(tmpdir(), "pub-")); roots.push(h);
  const apk = join(h, "app-release.apk"); writeFileSync(apk, `APK ${code}`);
  const run = (cmd, args) => (cmd.endsWith("apksigner") ? signer(cert) : badging(code, name, pkg));
  return { h, apk, run };
}

test("parsers", () => {
  assert.deepEqual(parseSignerDigests(signer("ab".repeat(32)) + signer("cd".repeat(32)).replace("#1", "#2")), ["ab".repeat(32), "cd".repeat(32)]);
  assert.deepEqual(parseBadging(badging(20, "1.6.0")), { package: "press.maestro.crow", versionCode: 20, versionName: "1.6.0" });
  assert.equal(parseBadging("garbage"), null);
});

test("publishes a release-signed, newer APK; feed validates; keeps the last 3", () => {
  const c = ctx(20, "1.6.0");
  for (const [code, name] of [[20, "1.6.0"], [21, "1.6.1"], [22, "1.6.2"], [23, "1.6.3"]]) {
    writeFileSync(c.apk, `APK ${code}`);
    const run = (cmd) => (cmd.endsWith("apksigner") ? signer(RELEASE_CERT_SHA256) : badging(code, name));
    publishApk({ apk: c.apk, crowHome: c.h, run, now: new Date("2026-10-05T00:00:00Z") });
  }
  const f = readFeed(c.h);
  assert.equal(f.versionCode, 23);
  assert.deepEqual(readdirSync(join(c.h, "android-updates")).filter((n) => n.endsWith(".apk")).sort(), ["crow-21.apk", "crow-22.apk", "crow-23.apk"]);
});

test("refuses: foreign signer, two signers, wrong package, not newer", () => {
  assert.throws(() => publishApk({ ...ctx(20, "1.6.0", { cert: "00".repeat(32) }), crowHome: undefined, ...{} }), /crowHome|signer/);
  const a = ctx(20, "1.6.0", { cert: "00".repeat(32) });
  assert.throws(() => publishApk({ apk: a.apk, crowHome: a.h, run: a.run }), /not signed with the Crow release key/);
  const b = ctx(20, "1.6.0");
  assert.throws(() => publishApk({ apk: b.apk, crowHome: b.h, run: (cmd) => (cmd.endsWith("apksigner") ? signer(RELEASE_CERT_SHA256) + signer(RELEASE_CERT_SHA256).replace("#1", "#2") : badging(20, "1.6.0")) }), /exactly one signer/);
  const p = ctx(20, "1.6.0", { pkg: "com.other" });
  assert.throws(() => publishApk({ apk: p.apk, crowHome: p.h, run: p.run }), /package/);
  const d = ctx(20, "1.6.0");
  publishApk({ apk: d.apk, crowHome: d.h, run: d.run });
  assert.throws(() => publishApk({ apk: d.apk, crowHome: d.h, run: d.run }), /not newer/);
});
```

- [ ] **Step 2: Run the test and confirm it fails.**

  Run: `npm test -- tests/android-publish-apk.test.js`

  Expected: FAIL.

- [ ] **Step 3: Write `scripts/android/publish-apk.mjs`.**

```js
#!/usr/bin/env node
/**
 * Publish a release-signed Crow APK to this machine's update feed (degoogle spec §3.3).
 *   node scripts/android/publish-apk.mjs --apk android/app/build/outputs/apk/release/app-release.apk
 *        [--crow-home ~/.crow] [--build-tools ~/Android/Sdk/build-tools/34.0.0]
 * Refuses unless: exactly one signer == the Crow release cert; package press.maestro.crow;
 * versionCode newer than the current feed. Writes crow-<versionCode>.apk + latest.json
 * (atomic), keeps the newest 3 APKs, and prints the GitHub release checklist.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ANDROID_PACKAGE, RELEASE_CERT_SHA256, readFeed, updatesDir } from "../../servers/gateway/android-updates.js";

export function parseSignerDigests(text) {
  return [...String(text).matchAll(/^Signer #\d+ certificate SHA-256 digest: ([0-9a-f]{64})$/gm)].map((m) => m[1]);
}

export function parseBadging(text) {
  const m = /^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m.exec(String(text));
  return m ? { package: m[1], versionCode: Number(m[2]), versionName: m[3] } : null;
}

export function publishApk({ apk, crowHome, buildTools = join(homedir(), "Android", "Sdk", "build-tools", "34.0.0"), run, now = new Date() }) {
  if (!crowHome) throw new Error("crowHome is required");
  const exec = run || ((cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
  const digests = parseSignerDigests(exec(join(buildTools, "apksigner"), ["verify", "--print-certs", apk]));
  if (digests.length !== 1) throw new Error(`the APK must have exactly one signer (found ${digests.length})`);
  if (digests[0] !== RELEASE_CERT_SHA256) throw new Error(`the APK is not signed with the Crow release key (got ${digests[0]})`);
  const b = parseBadging(exec(join(buildTools, "aapt2"), ["dump", "badging", apk]));
  if (!b) throw new Error("could not read the APK's package/version (aapt2 dump badging)");
  if (b.package !== ANDROID_PACKAGE) throw new Error(`wrong package ${b.package}`);
  if (!/^\d+\.\d+\.\d+$/.test(b.versionName)) throw new Error(`versionName ${b.versionName} is not X.Y.Z`);
  const current = readFeed(crowHome);
  if (current && b.versionCode <= current.versionCode) throw new Error(`versionCode ${b.versionCode} is not newer than the published ${current.versionCode}`);
  const dir = updatesDir(crowHome);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const file = `crow-${b.versionCode}.apk`;
  copyFileSync(apk, join(dir, `${file}.part`));
  renameSync(join(dir, `${file}.part`), join(dir, file));
  const bytes = readFileSync(join(dir, file));
  const feed = { package: b.package, versionCode: b.versionCode, versionName: b.versionName, sha256: createHash("sha256").update(bytes).digest("hex"), size: statSync(join(dir, file)).size, certSha256: digests[0], file, publishedAt: now.toISOString() };
  writeFileSync(join(dir, "latest.json.part"), JSON.stringify(feed, null, 2) + "\n");
  renameSync(join(dir, "latest.json.part"), join(dir, "latest.json"));
  const apks = readdirSync(dir).map((n) => /^crow-(\d+)\.apk$/.exec(n)).filter(Boolean).sort((x, y) => Number(y[1]) - Number(x[1]));
  for (const m of apks.slice(3)) rmSync(join(dir, m[0]), { force: true });
  return feed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
  const apk = arg("--apk");
  if (!apk) { console.error("usage: publish-apk.mjs --apk <app-release.apk> [--crow-home DIR] [--build-tools DIR]"); process.exit(2); }
  try {
    const f = publishApk({ apk, crowHome: arg("--crow-home", process.env.CROW_HOME || join(homedir(), ".crow")), buildTools: arg("--build-tools") || undefined });
    console.log(`Published ${f.versionName} (${f.versionCode}) sha256 ${f.sha256}`);
    console.log(`GitHub record (manual; gh is not installed): create release android-v${f.versionName} in the Crow GitHub repository and upload the APK as app-release.apk.`);
  } catch (err) {
    console.error(`publish refused: ${err.message}`);
    process.exit(1);
  }
}
```

Note: the first assertion in the "refuses" test passes `crowHome: undefined` and expects the `crowHome is required` error. That is intended.

- [ ] **Step 4: Run the test and confirm it passes.**

  Run: `npm test -- tests/android-publish-apk.test.js`

  Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
cd "$WT"
git add scripts/android/publish-apk.mjs tests/android-publish-apk.test.js
git commit scripts/android/publish-apk.mjs tests/android-publish-apk.test.js -m "feat(android): publish-apk — release-cert + package + newer-version gates, atomic feed, keep 3"
git show --stat HEAD
```

### Task C3: App: `UpdateDecision` (pure) + JUnit

**Files:**
- Create: `android/app/src/main/java/press/maestro/crow/UpdateDecision.java`
- Create: `android/app/src/test/java/press/maestro/crow/UpdateDecisionTest.java`
- Modify: `android/app/build.gradle` (add `testImplementation 'junit:junit:4.13.2'`; a Maven dependency fetched by Gradle, not a system package)

**Interfaces:**
- Produces: `UpdateDecision.shouldOffer(String pkg, int offeredCode, String offeredName, String sha256, String url, long size, int installedCode): boolean`, `dueForCheck(long lastCheckMs, long nowMs, boolean forced): boolean`, `toHex(byte[]): String`, `PACKAGE`, `CHECK_INTERVAL_MS`.

- [ ] **Step 0: Build prerequisites (fresh worktree).**
  - Run `cp ~/crow/android/local.properties "$WT/android/"`, or write `sdk.dir=$HOME/Android/Sdk` into it.
  - `export ANDROID_HOME=$HOME/Android/Sdk`.
  - The Meta Wearables SDK needs `GITHUB_TOKEN` (read:packages) and `GITHUB_USERNAME`. Stop and ask the operator if they are not exported.
  - Call `aapt2`/`apksigner` by full path under `~/Android/Sdk/build-tools/34.0.0/`.

- [ ] **Step 1: Write the failing test.**

```java
package press.maestro.crow;

import static org.junit.Assert.*;
import org.junit.Test;

public class UpdateDecisionTest {
    private static final String SHA = "ab".repeat(32);

    @Test public void offersOnlyNewerWellFormedBuildsOfThisApp() {
        assertTrue(UpdateDecision.shouldOffer("press.maestro.crow", 20, "1.6.0", SHA, "/api/android/apk/20", 1000, 19));
        assertFalse(UpdateDecision.shouldOffer("press.maestro.crow", 19, "1.5.2", SHA, "/api/android/apk/19", 1000, 19));
        assertFalse(UpdateDecision.shouldOffer("com.evil", 20, "1.6.0", SHA, "/api/android/apk/20", 1000, 19));
        assertFalse(UpdateDecision.shouldOffer("press.maestro.crow", 20, "1.6", SHA, "/api/android/apk/20", 1000, 19));
        assertFalse(UpdateDecision.shouldOffer("press.maestro.crow", 20, "1.6.0", "XYZ", "/api/android/apk/20", 1000, 19));
        assertFalse(UpdateDecision.shouldOffer("press.maestro.crow", 20, "1.6.0", SHA, "https://evil/apk/20", 1000, 19));
        assertFalse(UpdateDecision.shouldOffer("press.maestro.crow", 20, "1.6.0", SHA, "/api/android/apk/21", 1000, 19));
        assertFalse(UpdateDecision.shouldOffer("press.maestro.crow", 20, "1.6.0", SHA, "/api/android/apk/20", 0, 19));
        assertFalse(UpdateDecision.shouldOffer("press.maestro.crow", 20, "1.6.0", SHA, "/api/android/apk/20", 600L * 1024 * 1024, 19));
    }

    @Test public void checksAtMostDailyUnlessForced() {
        long day = UpdateDecision.CHECK_INTERVAL_MS;
        assertTrue(UpdateDecision.dueForCheck(0, 5, false));
        assertFalse(UpdateDecision.dueForCheck(1000, 1000 + day - 1, false));
        assertTrue(UpdateDecision.dueForCheck(1000, 1000 + day, false));
        assertTrue(UpdateDecision.dueForCheck(1000, 1001, true));
        assertTrue("clock went backwards", UpdateDecision.dueForCheck(5000, 1000, false));
    }

    @Test public void hexIsLowercaseAndPadded() {
        assertEquals("000fff", UpdateDecision.toHex(new byte[] {0, 15, (byte) 255}));
    }
}
```

- [ ] **Step 2: Run the test and confirm it fails.**

  Run: `cd "$WT/android" && ./gradlew :app:testReleaseUnitTest --tests press.maestro.crow.UpdateDecisionTest`

  Expected: compile FAIL (the class is missing).
  - The build needs `GITHUB_TOKEN`/`GITHUB_USERNAME` for the Meta SDK repo (top-level `build.gradle`) and the keystore env from `~/.crow/android-keystore/crow-release.env`. Run `set -a; . ~/.crow/android-keystore/crow-release.env; set +a` first.
  - If `GITHUB_TOKEN` is not available in this session, stop and ask the operator.

- [ ] **Step 3: Implement `UpdateDecision.java`.**

```java
package press.maestro.crow;

import java.util.regex.Pattern;

/** Pure update-feed rules (no Android imports): unit-tested in src/test. Spec §3.3. */
public final class UpdateDecision {
    public static final String PACKAGE = "press.maestro.crow";
    public static final long CHECK_INTERVAL_MS = 24L * 60 * 60 * 1000;
    private static final long MAX_APK_BYTES = 512L * 1024 * 1024;
    private static final Pattern HEX64 = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern VERSION = Pattern.compile("^\\d+\\.\\d+\\.\\d+$");
    private static final Pattern APK_PATH = Pattern.compile("^/api/android/apk/(\\d{1,9})$");

    private UpdateDecision() {}

    public static boolean shouldOffer(String pkg, int offeredCode, String offeredName, String sha256,
                                      String url, long size, int installedCode) {
        if (!PACKAGE.equals(pkg)) return false;
        if (offeredCode <= installedCode) return false;
        if (offeredName == null || !VERSION.matcher(offeredName).matches()) return false;
        if (sha256 == null || !HEX64.matcher(sha256).matches()) return false;
        if (url == null) return false;
        java.util.regex.Matcher m = APK_PATH.matcher(url);
        if (!m.matches() || Integer.parseInt(m.group(1)) != offeredCode) return false;
        return size > 0 && size <= MAX_APK_BYTES;
    }

    public static boolean dueForCheck(long lastCheckMs, long nowMs, boolean forced) {
        return forced || lastCheckMs <= 0 || nowMs < lastCheckMs || nowMs - lastCheckMs >= CHECK_INTERVAL_MS;
    }

    public static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format("%02x", b & 0xff));
        return sb.toString();
    }
}
```

Add to `android/app/build.gradle` `dependencies { … }`: `testImplementation 'junit:junit:4.13.2'`.

- [ ] **Step 4: Run the test and confirm it passes.**

  Run: same command as Step 2.

  Expected: `BUILD SUCCESSFUL`, 3 tests passed.

- [ ] **Step 5: Commit.**

```bash
cd "$WT"
git add android/app/src/main/java/press/maestro/crow/UpdateDecision.java android/app/src/test
git commit android/app/src/main/java/press/maestro/crow/UpdateDecision.java android/app/src/test android/app/build.gradle -m "feat(android): UpdateDecision — pure update-offer rules + JUnit"
git show --stat HEAD
```

### Task C4: App: checker, installer receiver, shortcut, 1.6.0

**Files:**
- Create: `android/app/src/main/java/press/maestro/crow/UpdateChecker.java`
- Create: `android/app/src/main/java/press/maestro/crow/UpdateInstallReceiver.java`
- Modify: `android/app/src/main/AndroidManifest.xml` (permission + receiver)
- Modify: `android/app/src/main/java/press/maestro/crow/MainActivity.java` (`onResume`, `onCreate`/`onNewIntent` extra)
- Modify: `android/app/src/main/res/xml/shortcuts.xml`
- Modify: `android/app/src/main/res/values/strings.xml`
- Modify: `android/app/build.gradle` (`versionCode 20`, `versionName "1.6.0"`)

**Interfaces:**
- Consumes: `UpdateDecision` (C3); gateway routes (C1).
- Produces: `UpdateChecker.maybeCheck(Activity, String gatewayUrl, boolean forced)`; `MainActivity.EXTRA_CHECK_UPDATES = "check_updates"`.

- [ ] **Step 1: Write `UpdateChecker.java`.**

```java
package press.maestro.crow;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.provider.Settings;
import android.util.Log;
import android.webkit.CookieManager;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * In-app updates from the gateway feed (/api/android/update; degoogle spec §3.3).
 * Checks at most daily (or on the "Check for updates" shortcut), asks the user, downloads,
 * verifies sha256 AND that the APK's signer equals this app's own, then hands it to
 * PackageInstaller (Android shows its own confirmation).
 */
public final class UpdateChecker {
    private static final String TAG = "CrowUpdate";
    private static final String PREFS = "crow_updates";
    private static final String KEY_LAST_CHECK = "last_check_ms";
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();

    private UpdateChecker() {}

    public static void maybeCheck(Activity activity, String gatewayUrl, boolean forced) {
        if (gatewayUrl == null || gatewayUrl.isEmpty()) return;
        SharedPreferences prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        if (!UpdateDecision.dueForCheck(prefs.getLong(KEY_LAST_CHECK, 0), now, forced)) return;
        prefs.edit().putLong(KEY_LAST_CHECK, now).apply();
        final String base = gatewayUrl.replaceAll("/+$", "");
        final Context app = activity.getApplicationContext();
        IO.execute(() -> {
            JSONObject feed = fetchFeed(base);
            if (feed == null) { if (forced) toast(activity, R.string.update_check_failed); return; }
            final String name = feed.optString("versionName");
            final String sha = feed.optString("sha256");
            final String path = feed.optString("url");
            final long size = feed.optLong("size", -1);
            if (!UpdateDecision.shouldOffer(feed.optString("package"), feed.optInt("versionCode", -1), name, sha, path, size,
                    BuildConfig.VERSION_CODE)) {
                if (forced) toast(activity, R.string.update_none);
                return;
            }
            activity.runOnUiThread(() -> {
                if (activity.isFinishing() || activity.isDestroyed()) return;
                new AlertDialog.Builder(activity)
                        .setTitle(R.string.update_title)
                        .setMessage(activity.getString(R.string.update_message, name))
                        .setPositiveButton(R.string.update_install,
                                (d, w) -> IO.execute(() -> downloadAndInstall(activity, app, base + path, sha, size)))
                        .setNegativeButton(R.string.update_later, null)
                        .show();
            });
        });
    }

    private static HttpURLConnection open(String url) throws IOException {
        String cookie;
        try { cookie = CookieManager.getInstance().getCookie(url); } catch (Exception e) { cookie = null; }
        if (cookie == null || cookie.isEmpty()) return null;
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(60000);
        conn.setInstanceFollowRedirects(false);
        conn.setRequestProperty("Cookie", cookie);
        return conn;
    }

    private static JSONObject fetchFeed(String base) {
        HttpURLConnection conn = null;
        try {
            conn = open(base + "/api/android/update");
            if (conn == null || conn.getResponseCode() != 200) return null;
            try (InputStream in = conn.getInputStream()) {
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                byte[] b = new byte[8192];
                int n;
                while ((n = in.read(b)) > 0) {
                    buf.write(b, 0, n);
                    if (buf.size() > 64 * 1024) return null;
                }
                return new JSONObject(new String(buf.toByteArray(), StandardCharsets.UTF_8));
            }
        } catch (Exception e) {
            Log.w(TAG, "update check failed: " + e.getMessage());
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static void downloadAndInstall(Activity activity, Context app, String url, String sha, long size) {
        File apk = new File(app.getCacheDir(), "crow-update.apk");
        HttpURLConnection conn = null;
        try {
            conn = open(url);
            if (conn == null || conn.getResponseCode() != 200) { fail(activity); return; }
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            long total = 0;
            try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(apk)) {
                byte[] b = new byte[65536];
                int n;
                while ((n = in.read(b)) > 0) {
                    total += n;
                    if (total > size) throw new IOException("larger than advertised");
                    md.update(b, 0, n);
                    out.write(b, 0, n);
                }
            }
            if (total != size || !UpdateDecision.toHex(md.digest()).equals(sha)) {
                Log.w(TAG, "sha256/size mismatch; not installing");
                apk.delete(); fail(activity); return;
            }
            if (!sameSigner(app, apk)) {
                Log.w(TAG, "signer differs from the installed app; not installing");
                apk.delete(); fail(activity); return;
            }
            if (!app.getPackageManager().canRequestPackageInstalls()) {
                activity.runOnUiThread(() -> {
                    Toast.makeText(activity, R.string.update_allow_installs, Toast.LENGTH_LONG).show();
                    activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:" + app.getPackageName())));
                });
                return;
            }
            install(app, apk);
        } catch (Exception e) {
            Log.w(TAG, "update failed: " + e.getMessage());
            apk.delete();
            fail(activity);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    static boolean sameSigner(Context app, File apk) throws Exception {
        PackageManager pm = app.getPackageManager();
        PackageManager.PackageInfoFlags flags = PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES);
        PackageInfo mine = pm.getPackageInfo(app.getPackageName(), flags);
        PackageInfo theirs = pm.getPackageArchiveInfo(apk.getPath(), flags);
        if (theirs == null || !app.getPackageName().equals(theirs.packageName)) return false;
        String a = signerDigest(mine);
        String b = signerDigest(theirs);
        return a != null && a.equals(b);
    }

    private static String signerDigest(PackageInfo pi) throws Exception {
        if (pi == null || pi.signingInfo == null || pi.signingInfo.hasMultipleSigners()) return null;
        Signature[] s = pi.signingInfo.getApkContentsSigners();
        if (s == null || s.length != 1) return null;
        return UpdateDecision.toHex(MessageDigest.getInstance("SHA-256").digest(s[0].toByteArray()));
    }

    private static void install(Context app, File apk) throws IOException {
        PackageInstaller installer = app.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(app.getPackageName());
        int id = installer.createSession(params);
        PackageInstaller.Session session = installer.openSession(id);
        try {
            try (InputStream in = new FileInputStream(apk); OutputStream out = session.openWrite("crow.apk", 0, apk.length())) {
                byte[] b = new byte[65536];
                int n;
                while ((n = in.read(b)) > 0) out.write(b, 0, n);
                session.fsync(out);
            }
            Intent cb = new Intent(app, UpdateInstallReceiver.class);
            PendingIntent pi = PendingIntent.getBroadcast(app, id, cb, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
            session.commit(pi.getIntentSender());
        } catch (IOException | RuntimeException e) {
            session.abandon();
            throw e;
        } finally {
            session.close();
        }
    }

    private static void fail(Activity activity) { toast(activity, R.string.update_failed); }

    private static void toast(Activity activity, int res) {
        activity.runOnUiThread(() -> Toast.makeText(activity, res, Toast.LENGTH_LONG).show());
    }
}
```

- [ ] **Step 2: Write `UpdateInstallReceiver.java`.**

```java
package press.maestro.crow;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.util.Log;
import android.widget.Toast;

/** PackageInstaller session callback: show Android's confirmation, or report a failure. */
public class UpdateInstallReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class);
            if (confirm == null) return;
            confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (CrowForeground.isForeground()) {
                context.startActivity(confirm);
            } else {
                // Android 14 background-activity-start rules: the user left during the download.
                // Post a notification instead; tapping it opens Android's install confirmation.
                android.app.PendingIntent tap = android.app.PendingIntent.getActivity(context, 7, confirm,
                        android.app.PendingIntent.FLAG_IMMUTABLE | android.app.PendingIntent.FLAG_UPDATE_CURRENT);
                android.app.NotificationManager nm = context.getSystemService(android.app.NotificationManager.class);
                nm.createNotificationChannel(new android.app.NotificationChannel("crow_updates",
                        context.getString(R.string.update_title), android.app.NotificationManager.IMPORTANCE_HIGH));
                nm.notify(7101, new android.app.Notification.Builder(context, "crow_updates")
                        .setSmallIcon(android.R.drawable.stat_sys_download_done)
                        .setContentTitle(context.getString(R.string.update_title))
                        .setContentText(context.getString(R.string.update_ready_tap))
                        .setContentIntent(tap).setAutoCancel(true).build());
            }
        } else if (status != PackageInstaller.STATUS_SUCCESS) {
            Log.w("CrowUpdate", "install status " + status + ": " + intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
            Toast.makeText(context, R.string.update_failed, Toast.LENGTH_LONG).show();
        }
    }
}
```

- [ ] **Step 2b: Foreground tracker + cleanup.** Create `android/app/src/main/java/press/maestro/crow/CrowForeground.java`:

```java
package press.maestro.crow;

/** Set by MainActivity onResume/onPause: lets UpdateInstallReceiver respect background-start rules. */
public final class CrowForeground {
    private static volatile boolean foreground;
    private CrowForeground() {}
    static void set(boolean v) { foreground = v; }
    public static boolean isForeground() { return foreground; }
}
```

Then:
- `MainActivity.onResume`: `CrowForeground.set(true);`. `onPause`: `CrowForeground.set(false);`.
- Add the string `<string name="update_ready_tap">Tap to finish updating Crow.</string>`.
- `UpdateChecker.downloadAndInstall`: wrap `install(app, apk);` as `try { install(app, apk); } finally { apk.delete(); }`. The session has already copied the bytes.
- `MainActivity`: after handling `EXTRA_CHECK_UPDATES`, call `getIntent().removeExtra(EXTRA_CHECK_UPDATES)` so a recreated activity does not re-fire it.

- [ ] **Step 3: Wire the manifest, strings, shortcut and activity.**

  - `AndroidManifest.xml`: after the last `<uses-permission …BLUETOOTH_SCAN… />` add `<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />`. Inside `<application>` add `<receiver android:name=".UpdateInstallReceiver" android:exported="false" />`.
  - `strings.xml`: add

```xml
    <!-- In-app updates (degoogle spec §3.3) -->
    <string name="update_title">Update Crow</string>
    <string name="update_message">Crow %1$s is ready. Install it now?</string>
    <string name="update_install">Update</string>
    <string name="update_later">Later</string>
    <string name="update_none">Crow is up to date.</string>
    <string name="update_check_failed">Could not check for updates. Open Crow once (to sign in), then try again.</string>
    <string name="update_failed">The update could not be installed. Nothing was changed.</string>
    <string name="update_allow_installs">Allow Crow to install updates, then choose \"Check for updates\" again.</string>
    <string name="updates_shortcut_short">Check for updates</string>
    <string name="updates_shortcut_long">Check your Crow server for a newer app</string>
```

  - `shortcuts.xml`: add a third shortcut:

```xml
    <shortcut
        android:shortcutId="check_updates"
        android:enabled="true"
        android:icon="@android:drawable/stat_sys_download"
        android:shortcutShortLabel="@string/updates_shortcut_short"
        android:shortcutLongLabel="@string/updates_shortcut_long">
        <intent
            android:action="android.intent.action.MAIN"
            android:targetPackage="press.maestro.crow"
            android:targetClass="press.maestro.crow.MainActivity">
            <extra android:name="check_updates" android:value="true" />
        </intent>
    </shortcut>
```

  - `MainActivity.java`:
    1. Next to `EXTRA_OPEN_SETTINGS` add `static final String EXTRA_CHECK_UPDATES = "check_updates";`.
    2. In `onCreate`, in the `else` branch after `handleIntent(getIntent(), gatewayUrl);`, add `if (getIntent().getBooleanExtra(EXTRA_CHECK_UPDATES, false)) UpdateChecker.maybeCheck(this, gatewayUrl, true);`.
    3. In `onNewIntent`, after `handleIntent(intent, gatewayUrl);`, add `if (intent.getBooleanExtra(EXTRA_CHECK_UPDATES, false)) UpdateChecker.maybeCheck(this, gatewayUrl, true);`.
    4. In `onResume`, after `startNtfyService();`, add `UpdateChecker.maybeCheck(this, getGatewayUrl(), false);`.
  - `build.gradle`: `versionCode 20`, `versionName "1.6.0"`.

- [ ] **Step 4: Build.**

  Run: `cd "$WT/android" && set -a && . ~/.crow/android-keystore/crow-release.env && set +a && ./gradlew :app:testReleaseUnitTest :app:assembleRelease`

  Expected: `BUILD SUCCESSFUL`. Then:
  - `~/Android/Sdk/build-tools/34.0.0/apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk | grep SHA-256` shows `6d5aeff1…4352`.
  - `aapt2 dump badging … | head -1` shows `versionCode='20' versionName='1.6.0'`.

- [ ] **Step 5: Commit.**

```bash
cd "$WT"
git add android/app/src/main/java/press/maestro/crow/UpdateChecker.java android/app/src/main/java/press/maestro/crow/UpdateInstallReceiver.java
git add android/app/src/main/java/press/maestro/crow/CrowForeground.java
git commit android/app/src/main/java/press/maestro/crow/UpdateChecker.java android/app/src/main/java/press/maestro/crow/UpdateInstallReceiver.java android/app/src/main/java/press/maestro/crow/CrowForeground.java android/app/src/main/java/press/maestro/crow/MainActivity.java android/app/src/main/AndroidManifest.xml android/app/src/main/res/xml/shortcuts.xml android/app/src/main/res/values/strings.xml android/app/build.gradle -m "feat(android): 1.6.0 in-app updates — daily check, sha256 + same-signer verify, PackageInstaller; 'Check for updates' shortcut"
git show --stat HEAD
```

### Task C5: Docs + PR C

**Files:**
- Modify: `docs/platforms/android.md`
- Modify: `docs/es/platforms/android.md`

- [ ] **Step 1: Update the docs.**
  - Replace the download link with v1.6.0 (`android-v1.6.0`).
  - Add a section **"Updates"**:
    - From 1.6.0 the app checks your Crow server once a day and asks before updating. Allow "Install unknown apps" for Crow the first time.
    - Long-press the app icon → "Check for updates" to check now.
    - The operator publishes with `node scripts/android/publish-apk.mjs --apk …`.
    - Alternative: Obtainium tracking the Crow GitHub repository's releases, with a release-tag filter `^android-v` and the expected certificate SHA-256 `6d5aeff16cd983e9b5f96147da5c88240b274ca9eed80bae771f555ac5a24352`. Option names as Obtainium labels them; they were not verified on a device.
    - GrapheneOS: the app works with the Vanadium WebView. Push is Crow's own connection (no Google services).
  - Make the same changes in the es file (translation, commands verbatim).
- [ ] **Step 2:** Run the full suite (`npm test`), then commit:

```bash
git commit docs/platforms/android.md docs/es/platforms/android.md -m "docs(android): in-app updates (1.6.0), Obtainium alternative, GrapheneOS note"
```

  Run `git pull --rebase origin main && git push -u origin feat/android-update-feed`. Open the PR via the github MCP server, wait for green check-runs, then merge.

## Phase D: Phone migration checklist + guides

### Task D1: Checks module

**Files:**
- Create: `servers/gateway/dashboard/settings/phone-migration/checks.js`
- Test: `tests/phone-migration-checks.test.js`

**Interfaces:**
- Produces:
  - `MANUAL_ITEMS: {id, phase}[]`, `AUTO_ITEMS: string[]`.
  - `ticksPath(crowHome)`, `readTicks(crowHome): Record<id, isoString>`, `setTick(crowHome, id, on, now?): boolean`.
  - `readBundleEnv(crowHome, id): object|null`.
  - `collectAutoChecks({ crowHome, env, now, probes, timeoutMs }): Promise<Record<id, "done"|"todo"|"unknown">>`.

- [ ] **Step 1: Write the failing test** `tests/phone-migration-checks.test.js`:

```js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectAutoChecks, readTicks, setTick, MANUAL_ITEMS, AUTO_ITEMS, ticksPath } from "../servers/gateway/dashboard/settings/phone-migration/checks.js";
import { recordNtfyStatus, writeStoredNtfyConfig } from "../servers/gateway/push/ntfy-config.js";

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
function home() {
  const h = mkdtempSync(join(tmpdir(), "pm-")); roots.push(h);
  mkdirSync(join(h, "data")); for (const b of ["workspace", "immich", "vaultwarden"]) mkdirSync(join(h, "bundles", b), { recursive: true });
  return { h, env: { CROW_DATA_DIR: join(h, "data") } };
}
const NOW = Date.parse("2026-10-10T12:00:00Z");

test("everything ready → done (probes injected)", async () => {
  const { h, env } = home();
  writeStoredNtfyConfig({ topic: "crow-x", publisherToken: "p", subscriberToken: "s", externalUrl: "https://h.ts.net:8445" }, env);
  recordNtfyStatus({ appFetchedAt: "2026-10-09T12:00:00Z", appFetchedBy: "android", lastPushOk: true }, env);
  writeFileSync(join(h, "bundles", "workspace", ".env"), "WORKSPACE_BOOTSTRAP_DONE=1\n");
  writeFileSync(join(h, "bundles", "immich", ".env"), "IMMICH_BOOTSTRAP_DONE=1\nIMMICH_API_KEY=k\n");
  writeFileSync(join(h, "bundles", "vaultwarden", ".env"), "VAULTWARDEN_DOMAIN=https://h.ts.net:8459\n");
  const r = await collectAutoChecks({ crowHome: h, env, now: NOW, probes: {
    immichSessions: async () => [{ deviceOS: "Android", deviceType: "Mobile" }],
    tailscaleStatus: async () => ({ Peer: { a: { OS: "android", Online: true } } }),
  } });
  for (const id of AUTO_ITEMS) assert.equal(r[id], "done", id);
});

test("nothing set up → todo; broken/slow probes → unknown, never throw", async () => {
  const { h, env } = home();
  writeFileSync(join(h, "bundles", "immich", ".env"), "IMMICH_BOOTSTRAP_DONE=1\nIMMICH_API_KEY=k\n");
  const r = await collectAutoChecks({ crowHome: h, env, now: NOW, timeoutMs: 50, probes: {
    immichSessions: () => new Promise(() => {}),
    tailscaleStatus: () => { throw new Error("ENOENT tailscale"); },
  } });
  assert.equal(r.crow_app_push, "todo");
  assert.equal(r.workspace_ready, "todo");
  assert.equal(r.immich_phone_app, "unknown");
  assert.equal(r.tailscale_android, "unknown");
  assert.equal(r.vaultwarden_https, "todo");
  const r2 = await collectAutoChecks({ crowHome: h, env, now: NOW, probes: { immichSessions: async () => ({ weird: true }), tailscaleStatus: async () => ({}) } });
  assert.equal(r2.immich_phone_app, "unknown");
  assert.equal(r2.tailscale_android, "todo");
});

test("stale app fetch (8 days) is todo; http Vaultwarden is todo", async () => {
  const { h, env } = home();
  writeStoredNtfyConfig({ topic: "crow-x", publisherToken: "p", subscriberToken: "s", externalUrl: "https://h" }, env);
  recordNtfyStatus({ appFetchedAt: "2026-10-02T11:00:00Z", appFetchedBy: "android", lastPushOk: true }, env);
  writeFileSync(join(h, "bundles", "vaultwarden", ".env"), "VAULTWARDEN_DOMAIN=http://localhost:8097\n");
  const r = await collectAutoChecks({ crowHome: h, env, now: NOW, probes: { tailscaleStatus: async () => ({}) } });
  assert.equal(r.crow_app_push, "todo");
  assert.equal(r.vaultwarden_https, "todo");
});

test("ticks: only known ids, file mode 600, untick removes", () => {
  const { h } = home();
  assert.equal(setTick(h, "nope", true), false);
  assert.equal(setTick(h, MANUAL_ITEMS[0].id, true, new Date(NOW)), true);
  assert.equal(statSync(ticksPath(h)).mode & 0o777, 0o600);
  assert.equal(readTicks(h)[MANUAL_ITEMS[0].id], "2026-10-10T12:00:00.000Z");
  setTick(h, MANUAL_ITEMS[0].id, false);
  assert.deepEqual(readTicks(h), {});
  writeFileSync(ticksPath(h), "{not json");
  assert.deepEqual(readTicks(h), {});
});
```

- [ ] **Step 2: Run the test and confirm it fails.**

  Run: `npm test -- tests/phone-migration-checks.test.js`

  Expected: FAIL.

- [ ] **Step 3: Write `checks.js`.**

```js
/**
 * Settings › Phone migration — status (degoogle spec §3.4). Automatic probes + the manual
 * ticks file ($CROW_HOME/phone-migration.json, mode 600, per instance, never synced).
 * Every probe is injectable and time-boxed; a failing probe reads "unknown", never throws.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { parseEnvText } from "../../../bundle-env-codec.js";
import { resolveNtfyConfig, readNtfyStatus } from "../../../push/ntfy-config.js";

export const MANUAL_ITEMS = [
  { id: "oem_unlock", phase: "before" },
  { id: "takeout_imported", phase: "before" },
  { id: "contacts_imported", phase: "before" },
  { id: "w3_imported", phase: "before" },
  { id: "passwords_moved", phase: "before" },
  { id: "authenticator_moved", phase: "before" },
  { id: "sms_decided", phase: "before" },
  { id: "banking_ok", phase: "before" },
  { id: "fi_plan", phase: "before" },
  { id: "backups_green", phase: "before" },
  { id: "seedvault_target", phase: "before" },
  { id: "app_paired", phase: "after" },
  { id: "davx5_syncing", phase: "after" },
  { id: "immich_backing_up", phase: "after" },
  { id: "bitwarden_in", phase: "after" },
  { id: "aegis_verified", phase: "after" },
  { id: "ha_app", phase: "after" },
  { id: "seedvault_done", phase: "after" },
  { id: "crow_pages_ok", phase: "after" },
];
export const AUTO_ITEMS = ["crow_app_push", "workspace_ready", "immich_ready", "immich_phone_app", "vaultwarden_https", "tailscale_android"];
const MANUAL_IDS = new Set(MANUAL_ITEMS.map((i) => i.id));
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export const ticksPath = (crowHome) => join(crowHome, "phone-migration.json");

export function readTicks(crowHome) {
  try {
    const j = JSON.parse(readFileSync(ticksPath(crowHome), "utf8"));
    const out = {};
    for (const [k, v] of Object.entries((j && j.ticks) || {})) if (MANUAL_IDS.has(k) && typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export function setTick(crowHome, id, on, now = new Date()) {
  if (!MANUAL_IDS.has(id)) return false;
  const ticks = readTicks(crowHome);
  if (on) ticks[id] = now.toISOString();
  else delete ticks[id];
  const p = ticksPath(crowHome);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify({ ticks }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, p);
  return true;
}

export function readBundleEnv(crowHome, id) {
  try { return parseEnvText(readFileSync(join(crowHome, "bundles", id, ".env"), "utf8")); } catch { return null; }
}

function withTimeout(fn, ms) {
  let timer;
  return Promise.race([
    Promise.resolve().then(fn).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); }),
  ]);
}

export const defaultProbes = {
  tailscaleStatus: () => new Promise((resolve, reject) => {
    execFile("tailscale", ["status", "--json"], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  }),
  immichSessions: async (url, key) => {
    const r = await fetch(`${String(url).replace(/\/+$/, "")}/api/sessions`, { headers: { "x-api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  },
};

export async function collectAutoChecks({ crowHome, env = process.env, now = Date.now(), probes = {}, timeoutMs = 3000 } = {}) {
  const p = { ...defaultProbes, ...probes };
  const out = {};

  let cfg = null;
  try { cfg = resolveNtfyConfig(env); } catch { cfg = null; }
  const st = readNtfyStatus(env) || {};
  const fresh = st.appFetchedBy === "android" && Date.parse(st.appFetchedAt || "") > now - WEEK_MS;
  out.crow_app_push = cfg && fresh && st.lastPushOk === true ? "done" : "todo";

  out.workspace_ready = readBundleEnv(crowHome, "workspace")?.WORKSPACE_BOOTSTRAP_DONE === "1" ? "done" : "todo";

  const im = readBundleEnv(crowHome, "immich");
  const imReady = !!im && (im.IMMICH_BOOTSTRAP_DONE === "1" || (im.IMMICH_MODE === "external" && !!im.IMMICH_API_KEY));
  out.immich_ready = imReady ? "done" : "todo";
  if (imReady && im.IMMICH_API_KEY) {
    try {
      const sessions = await withTimeout(() => p.immichSessions(im.IMMICH_URL || "http://127.0.0.1:2283", im.IMMICH_API_KEY), timeoutMs);
      out.immich_phone_app = !Array.isArray(sessions) ? "unknown"
        : sessions.some((s) => /android/i.test(String((s && s.deviceOS) || ""))) ? "done" : "todo";
    } catch {
      out.immich_phone_app = "unknown";
    }
  } else {
    out.immich_phone_app = "todo";
  }

  out.vaultwarden_https = /^https:\/\//.test(readBundleEnv(crowHome, "vaultwarden")?.VAULTWARDEN_DOMAIN || "") ? "done" : "todo";

  try {
    const ts = await withTimeout(() => p.tailscaleStatus(), timeoutMs);
    const peers = Object.values((ts && ts.Peer) || {});
    out.tailscale_android = peers.some((x) => String((x && x.OS) || "").toLowerCase() === "android" && x.Online === true) ? "done" : "todo";
  } catch {
    out.tailscale_android = "unknown";
  }
  return out;
}
```

- [ ] **Step 4: Run the test and confirm it passes.**

  Run: `npm test -- tests/phone-migration-checks.test.js`

  Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
cd "$WT"
git add servers/gateway/dashboard/settings/phone-migration tests/phone-migration-checks.test.js
git commit servers/gateway/dashboard/settings/phone-migration tests/phone-migration-checks.test.js -m "feat(settings): phone-migration status probes (time-boxed) + manual ticks file"
git show --stat HEAD
```

### Task D2: Settings section

**Files:**
- Create: `servers/gateway/dashboard/settings/sections/phone-migration.js`
- Modify: `servers/gateway/dashboard/panels/settings.js` (import + `registerSettingsSection`)
- Modify: `servers/gateway/dashboard/shared/i18n.js` (`settings.section.phoneMigration` en/es)
- Test: `tests/phone-migration-section.test.js`

**Interfaces:**
- Consumes: D1.
- Produces: the section module (id `phone-migration`, group `general`, navOrder 40), action `phone_migration_tick` (body `item`, `on` = "1"|"0").

- [ ] **Step 1: Write the failing test** `tests/phone-migration-section.test.js`:

```js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import section, { _setPhoneMigrationDepsForTest } from "../servers/gateway/dashboard/settings/sections/phone-migration.js";
import { readTicks } from "../servers/gateway/dashboard/settings/phone-migration/checks.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
function ctx() {
  const h = mkdtempSync(join(tmpdir(), "pm-sec-")); roots.push(h); mkdirSync(join(h, "data"));
  _setPhoneMigrationDepsForTest({ crowHome: h, env: { CROW_DATA_DIR: join(h, "data") }, probes: { tailscaleStatus: async () => ({}), immichSessions: async () => [] } });
  return h;
}

test("renders status, before/after lists, Seedvault card; en and es; CSRF on every form", async () => {
  ctx();
  for (const lang of ["en", "es"]) {
    const html = await section.render({ req: { csrfToken: "C1", query: {} }, lang });
    assert.match(html, /name="_csrf" value="C1"/);
    assert.match(html, /value="phone_migration_tick"/);
    assert.match(html, /Seedvault/);
    assert.match(html, /remote\.php\/dav\/files\//);
  }
  assert.notEqual(t("settings.section.phoneMigration", "en"), "settings.section.phoneMigration");
  assert.notEqual(t("settings.section.phoneMigration", "es"), "settings.section.phoneMigration");
});

test("tick action: known item stored, unknown ignored, redirects back", async () => {
  const h = ctx();
  const res = { to: null, redirectAfterPost(u) { this.to = u; } };
  assert.equal(await section.handleAction({ req: { body: { item: "oem_unlock", on: "1" } }, res, action: "phone_migration_tick" }), true);
  assert.ok(readTicks(h).oem_unlock);
  assert.match(res.to, /section=phone-migration/);
  await section.handleAction({ req: { body: { item: "<script>", on: "1" } }, res, action: "phone_migration_tick" });
  assert.deepEqual(Object.keys(readTicks(h)), ["oem_unlock"]);
  assert.equal(await section.handleAction({ req: { body: {} }, res, action: "something_else" }), false);
});
```

- [ ] **Step 2: Run the test and confirm it fails.**

  Run: `npm test -- tests/phone-migration-section.test.js`

  Expected: FAIL.

- [ ] **Step 3: Write the section** `sections/phone-migration.js`:

```js
/**
 * Settings Section: Phone migration (degoogle spec §3.4). Server-rendered form posts,
 * no client JS. Live checks + manual ticks + the Seedvault how-to. Body strings live here
 * (en/es, the Office-panel pattern); the menu label is in i18n.js.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { escapeHtml } from "../../shared/components.js";
import { MANUAL_ITEMS, readTicks, setTick, collectAutoChecks, readBundleEnv } from "../phone-migration/checks.js";

let _deps = null;
export function _setPhoneMigrationDepsForTest(d) { _deps = d; }
const deps = () => _deps || { crowHome: process.env.CROW_HOME || join(homedir(), ".crow"), env: process.env, probes: {} };
const BACK = "/dashboard/settings?section=phone-migration";

const S = {
  en: {
    intro: "Moving your phone off Google services (GrapheneOS with sandboxed Google Play). Green items are checked live; tick the others as you finish them.",
    statusH: "Live status", beforeH: "Before switch day", dayH: "Switch day", afterH: "After the switch", seedH: "Device backup with Seedvault",
    done: "done", todo: "not yet", unknown: "couldn't check", tick: "Mark done", untick: "Undo",
    dayP: "Follow your switch-day runbook. Do not start until every item above is done and the live status is green.",
    auto: {
      crow_app_push: "Crow app on a phone, push working (seen in the last 7 days)",
      workspace_ready: "Workspace ready (files, calendars, contacts)",
      immich_ready: "Photos (Immich) ready",
      immich_phone_app: "Immich app signed in on an Android phone",
      vaultwarden_https: "Vaultwarden reachable over https (needed by the Bitwarden app)",
      tailscale_android: "An Android phone is on your tailnet",
    },
    manual: {
      oem_unlock: "OEM unlocking can be turned on (Developer options, phone online)",
      takeout_imported: "Google Photos exported with Takeout and imported into Photos",
      contacts_imported: "Contacts exported (contacts.google.com → Export → vCard) and imported in Workspace Contacts",
      w3_imported: "Drive folders and calendars imported into Workspace",
      passwords_moved: "Google passwords exported and imported into Vaultwarden; the export file deleted",
      authenticator_moved: "Authenticator codes moved to Aegis or Bitwarden (each tested once); Google Authenticator kept until then",
      sms_decided: "Text message history: exported, or decided to start fresh",
      banking_ok: "Banking app checked against the GrapheneOS compatibility list; a ~30-day hold on some transfers is OK",
      fi_plan: "Carrier/eSIM plan ready (re-download path known; physical SIM in hand if chosen)",
      backups_green: "Workspace and Photos backups ran and restore-check passed",
      seedvault_target: "Seedvault target ready (Workspace app password + Seedvault folder)",
      app_paired: "Crow app 1.6+ installed, signed in, test notification received",
      davx5_syncing: "DAVx⁵ syncing calendars and contacts",
      immich_backing_up: "Immich app backing up the camera",
      bitwarden_in: "Bitwarden app signed in to your Vaultwarden",
      aegis_verified: "Every Aegis code tested",
      ha_app: "Home Assistant app signed in",
      seedvault_done: "First Seedvault backup finished",
      crow_pages_ok: "Ramble map, Perch, voice and file upload work in the Crow app",
    },
    seed: [
      "In Workspace: your avatar → Settings → Security → create an app password named “Seedvault”, and create a folder named Seedvault.",
      "On the phone: Settings → System → Backup → Seedvault → choose WebDAV, then enter this address (your login in place of LOGIN), your login and the app password:",
      "Write the 12-word recovery code on paper and keep it offline. Without it the backup cannot be read.",
      "Turn on app backup. Leave photo/files backup off: Photos (Immich) already keeps them.",
      "Tap Backup now and check that the Seedvault folder fills in Workspace. Tailscale must be on (set it to always-on).",
      "Seedvault restores onto GrapheneOS only. It cannot bring data over from the old (stock) phone.",
    ],
  },
  es: {
    intro: "Pasar tu teléfono fuera de los servicios de Google (GrapheneOS con Google Play en sandbox). Lo verde se comprueba en vivo; marca lo demás al terminarlo.",
    statusH: "Estado en vivo", beforeH: "Antes del día del cambio", dayH: "Día del cambio", afterH: "Después del cambio", seedH: "Copia del dispositivo con Seedvault",
    done: "listo", todo: "pendiente", unknown: "no se pudo comprobar", tick: "Marcar listo", untick: "Deshacer",
    dayP: "Sigue tu guía del día del cambio. No empieces hasta que todo lo anterior esté listo y el estado en vivo esté en verde.",
    auto: {
      crow_app_push: "App de Crow en un teléfono, avisos funcionando (visto en los últimos 7 días)",
      workspace_ready: "Workspace listo (archivos, calendarios, contactos)",
      immich_ready: "Fotos (Immich) listo",
      immich_phone_app: "App Immich con sesión en un teléfono Android",
      vaultwarden_https: "Vaultwarden accesible por https (lo necesita la app Bitwarden)",
      tailscale_android: "Hay un teléfono Android en tu tailnet",
    },
    manual: {
      oem_unlock: "Se puede activar el desbloqueo OEM (Opciones de desarrollador, teléfono en línea)",
      takeout_imported: "Google Fotos exportado con Takeout e importado en Fotos",
      contacts_imported: "Contactos exportados (contacts.google.com → Exportar → vCard) e importados en Contactos de Workspace",
      w3_imported: "Carpetas de Drive y calendarios importados en Workspace",
      passwords_moved: "Contraseñas de Google exportadas e importadas en Vaultwarden; archivo exportado borrado",
      authenticator_moved: "Códigos del autenticador pasados a Aegis o Bitwarden (cada uno probado); Google Authenticator conservado hasta entonces",
      sms_decided: "Historial de mensajes: exportado, o decidido empezar de cero",
      banking_ok: "App del banco revisada en la lista de compatibilidad de GrapheneOS; una espera de ~30 días en algunas transferencias es aceptable",
      fi_plan: "Plan de operador/eSIM listo (forma de volver a descargarla conocida; SIM física a mano si se eligió)",
      backups_green: "Copias de Workspace y Fotos ejecutadas y restore-check correcto",
      seedvault_target: "Destino de Seedvault listo (contraseña de aplicación de Workspace + carpeta Seedvault)",
      app_paired: "App de Crow 1.6+ instalada, con sesión, aviso de prueba recibido",
      davx5_syncing: "DAVx⁵ sincronizando calendarios y contactos",
      immich_backing_up: "App Immich copiando la cámara",
      bitwarden_in: "App Bitwarden con sesión en tu Vaultwarden",
      aegis_verified: "Cada código de Aegis probado",
      ha_app: "App de Home Assistant con sesión",
      seedvault_done: "Primera copia de Seedvault terminada",
      crow_pages_ok: "Mapa de Ramble, Perch, voz y subida de archivos funcionan en la app de Crow",
    },
    seed: [
      "En Workspace: tu avatar → Configuración → Seguridad → crea una contraseña de aplicación llamada “Seedvault” y crea una carpeta llamada Seedvault.",
      "En el teléfono: Ajustes → Sistema → Copia de seguridad → Seedvault → elige WebDAV y escribe esta dirección (tu usuario en lugar de LOGIN), tu usuario y la contraseña de aplicación:",
      "Escribe en papel el código de recuperación de 12 palabras y guárdalo fuera de línea. Sin él la copia no se puede leer.",
      "Activa la copia de apps. Deja desactivada la copia de fotos/archivos: Fotos (Immich) ya las guarda.",
      "Toca Hacer copia ahora y comprueba que la carpeta Seedvault se llena en Workspace. Tailscale debe estar activado (siempre activo).",
      "Seedvault solo restaura sobre GrapheneOS. No puede traer datos del teléfono anterior (sistema original).",
    ],
  },
};

const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export default {
  id: "phone-migration",
  group: "general",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg>`,
  labelKey: "settings.section.phoneMigration",
  navOrder: 40,

  async getPreview() { return ""; },

  async render({ req, lang }) {
    const s = S[lang === "es" ? "es" : "en"];
    const { crowHome, env, probes } = deps();
    const status = await collectAutoChecks({ crowHome, env, probes });
    const ticks = readTicks(crowHome);
    const csrf = escapeHtml(req?.csrfToken || "");
    const badge = (st) => {
      const color = st === "done" ? "var(--crow-accent)" : st === "unknown" ? "var(--crow-text-muted)" : "#e0533d";
      return `<span style="font-size:0.8rem;color:${color};min-width:7rem;display:inline-block">${escapeHtml(s[st])}</span>`;
    };
    const row = (label, right) => `<li style="display:flex;gap:0.75rem;align-items:center;justify-content:space-between;padding:0.4rem 0;border-bottom:1px solid var(--crow-border)"><span>${escapeHtml(label)}</span>${right}</li>`;
    const tickForm = (id) => {
      const on = !!ticks[id];
      return `<form method="POST" action="/dashboard/settings" style="display:flex;gap:0.5rem;align-items:center">
        ${badge(on ? "done" : "todo")}
        <input type="hidden" name="_csrf" value="${csrf}" />
        <input type="hidden" name="action" value="phone_migration_tick" />
        <input type="hidden" name="item" value="${escapeHtml(id)}" />
        <input type="hidden" name="on" value="${on ? "0" : "1"}" />
        <button type="submit" class="btn">${escapeHtml(on ? s.untick : s.tick)}</button>
      </form>`;
    };
    const ws = readBundleEnv(crowHome, "workspace") || {};
    const host = HOST_RE.test(ws.WORKSPACE_PUBLIC_HOST || "") ? ws.WORKSPACE_PUBLIC_HOST : "YOUR-HOST";
    const port = /^[0-9]{2,5}$/.test(ws.WORKSPACE_NC_SERVE_PORT || "") ? ws.WORKSPACE_NC_SERVE_PORT : "8456";
    const dav = `https://${host}:${port}/remote.php/dav/files/LOGIN/Seedvault/`;
    const list = (items) => `<ul style="list-style:none;padding:0;margin:0 0 1rem">${items}</ul>`;
    return `<p style="color:var(--crow-text-secondary)">${escapeHtml(s.intro)}</p>
      <h3>${escapeHtml(s.statusH)}</h3>
      ${list(Object.entries(s.auto).map(([id, label]) => row(label, badge(status[id] || "unknown"))).join(""))}
      <h3>${escapeHtml(s.beforeH)}</h3>
      ${list(MANUAL_ITEMS.filter((i) => i.phase === "before").map((i) => row(s.manual[i.id], tickForm(i.id))).join(""))}
      <h3>${escapeHtml(s.dayH)}</h3><p>${escapeHtml(s.dayP)}</p>
      <h3>${escapeHtml(s.afterH)}</h3>
      ${list(MANUAL_ITEMS.filter((i) => i.phase === "after").map((i) => row(s.manual[i.id], tickForm(i.id))).join(""))}
      <h3 id="seedvault">${escapeHtml(s.seedH)}</h3>
      <ol>${s.seed.map((p, i) => `<li>${escapeHtml(p)}${i === 1 ? ` <code style="overflow-wrap:anywhere">${escapeHtml(dav)}</code>` : ""}</li>`).join("")}</ol>`;
  },

  async handleAction({ req, res, action }) {
    if (action !== "phone_migration_tick") return false;
    const { crowHome } = deps();
    const item = String(req?.body?.item || "");
    setTick(crowHome, item, String(req?.body?.on || "") === "1");
    res.redirectAfterPost(BACK);
    return true;
  },
};
```

- [ ] **Step 4: Register the section and its label.**
  - In `servers/gateway/dashboard/panels/settings.js`: add `import phoneMigrationSection from "../settings/sections/phone-migration.js";` with the other imports, and `registerSettingsSection(phoneMigrationSection);` after `registerSettingsSection(notificationsSection);`.
  - In `servers/gateway/dashboard/shared/i18n.js`, next to `"settings.section.textSize"`: `"settings.section.phoneMigration": { en: "Phone migration", es: "Cambio de teléfono" },`.

- [ ] **Step 5: Run the tests and confirm they pass.**

  Run: `npm test -- tests/phone-migration-section.test.js tests/phone-migration-checks.test.js` and then `npm test` (the i18n parity gate plus the settings tests).

  Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
cd "$WT"
git add servers/gateway/dashboard/settings/sections/phone-migration.js tests/phone-migration-section.test.js
git commit servers/gateway/dashboard/settings/sections/phone-migration.js servers/gateway/dashboard/panels/settings.js servers/gateway/dashboard/shared/i18n.js tests/phone-migration-section.test.js -m "feat(settings): Phone migration — live status, before/after ticks, Seedvault how-to (en/es)"
git show --stat HEAD
```

### Task D3: Guides (public generic + the operator's personal runbook) + PR D

**Files:**
- Create: `docs/guide/phone-migration.md`
- Create: `docs/es/guide/phone-migration.md`
- Modify: `docs/.vitepress/config.ts` (sidebar entries en/es)

- [ ] **Step 1: Write `docs/guide/phone-migration.md`.** It is generic (no names, hostnames or carrier) and covers:
  - what Crow replaces (spec §1 table);
  - the order (Photos import → Workspace import → passwords/2FA → backups → switch);
  - the Settings › Phone migration page;
  - GrapheneOS with sandboxed Play: what works, the eSIM toggle, network location, RCS notes. Cite the grapheneos.org URLs from spec §3.
  - Seedvault (spec §3.4 text);
  - Crow app updates on GrapheneOS;
  - a rollback overview.

  Write the Spanish translation at `docs/es/guide/phone-migration.md` and add sidebar entries.

- [ ] **Step 3:** Run `npm test`. Commit:

```bash
cd "$WT"
git add docs/guide/phone-migration.md docs/es/guide/phone-migration.md
git commit docs/guide/phone-migration.md docs/es/guide/phone-migration.md docs/.vitepress/config.ts -m "docs: phone migration guide (en/es)"
```

  Push branch `feat/phone-migration` (D1–D3), open the PR, wait for green, merge, deploy (pull + **[OPERATOR]** `sudo systemctl restart crow-gateway`).

---

---

## Operator phases (not in this repo)

Deployment on a specific host, the Takeout download and import, the on-device update test, pre-switch moves, the flash, and soak are operator work. They are kept in the operator's private runbook. This plan covers only the product code and docs above.
